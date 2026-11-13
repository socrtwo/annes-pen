/**
 * FictionBook 2 import (.fb2 XML and .fbz / .fb2.zip archives).
 *
 * Mapped: title-info (book title, authors, annotation, language) → document properties and a
 * Title paragraph; nested sections → Heading 1–6 by depth; p, subtitle, empty-line, epigraph
 * and cite (→ Quote paragraphs, text-author right-aligned), poem/stanza/v (verse lines with line
 * breaks), tables (tr/th/td with spans and alignment), images (binary sections → embedded
 * pictures, cover image first), inline strong / emphasis / strikethrough / sub / sup / code /
 * named styles, links; note links (type="note" or pointing into the notes body) → footnotes.
 * Not mapped: document-info/publish-info (kept only where they map to properties), custom-info.
 */
import { loadZip } from './zip';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { attr, kid, kids, kidsNamed, decodeXml, parseXml, textOf } from './xml-read';
import { InlineBuf, headingStyle, makeTable, type CellSpec } from './runs';
import { base64ToBytes, finishDoc, newSettings, para, sniffImageMime, toDataUrl } from './serialize';

const S = schema.nodes;
const MK = schema.marks;

const href = (el: Element | null): string => {
  if (!el) return '';
  for (let i = 0; i < el.attributes.length; i++) if (el.attributes[i].localName === 'href') return el.attributes[i].value;
  return '';
};

class Fb2Reader {
  settings = newSettings();
  images = new Map<string, string>();
  notes = new Map<string, string>();
  noteBodies = new Set<Element>();

  constructor(private root: Element) {}

  read(): PMNode {
    for (const b of kidsNamed(this.root, 'binary')) {
      const id = attr(b, 'id');
      if (!id) continue;
      const bytes = base64ToBytes((b.textContent || '').replace(/\s+/g, ''));
      const mime = sniffImageMime(bytes) || attr(b, 'content-type') || 'image/jpeg';
      this.images.set(id, toDataUrl(bytes, mime));
    }
    const bodies = kidsNamed(this.root, 'body');
    for (const b of bodies) {
      if (bodies.indexOf(b) === 0 && !attr(b, 'name')) continue;
      this.noteBodies.add(b);
      for (const s of kids(b)) this.collectNotes(s);
    }
    const out: PMNode[] = [];
    this.description(kid(this.root, 'description'), out);
    for (const b of bodies) if (!this.noteBodies.has(b)) this.container(b, out, 0);
    return finishDoc(out, this.settings);
  }

  private collectNotes(s: Element): void {
    if (s.localName !== 'section') return;
    const id = attr(s, 'id');
    if (id) {
      const text = kids(s).filter((k) => k.localName !== 'title' && k.localName !== 'section').map((k) => textOf(k)).filter(Boolean).join('\n');
      this.notes.set(id, text);
    }
    for (const k of kidsNamed(s, 'section')) this.collectNotes(k);
  }

  private description(d: Element | null, out: PMNode[]): void {
    const ti = kid(d, 'title-info');
    if (!ti) return;
    const p = this.settings.properties;
    const title = textOf(kid(ti, 'book-title'));
    const authors = kidsNamed(ti, 'author').map((a) => [textOf(kid(a, 'first-name')), textOf(kid(a, 'middle-name')), textOf(kid(a, 'last-name'))].filter(Boolean).join(' ') || textOf(kid(a, 'nickname'))).filter(Boolean);
    p.title = title;
    p.author = authors.join('; ');
    p.keywords = textOf(kid(ti, 'keywords'));
    p.category = kidsNamed(ti, 'genre').map((g) => textOf(g)).join(', ');
    const ann = kid(ti, 'annotation');
    if (ann) p.comments = textOf(ann);
    const lang = textOf(kid(ti, 'lang'));
    if (lang) this.settings.language = lang;
    const cover = kid(kid(ti, 'coverpage'), 'image');
    const src = cover ? this.images.get(href(cover).replace(/^#/, '')) : null;
    if (src) out.push(para([S.image.create({ src, alt: 'Cover', width: 300 })], { align: 'center' }));
  }

  /** Body or section content; depth = section nesting level. */
  private container(el: Element, out: PMNode[], depth: number): void {
    for (const c of kids(el)) {
      switch (c.localName) {
        case 'title': {
          const style = depth === 0 ? 'Title' : headingStyle(Math.min(depth, 6));
          const lines = kidsNamed(c, 'p');
          const inl: PMNode[] = [];
          lines.forEach((p, i) => { if (i) inl.push(S.hard_break.create()); inl.push(...this.inline(p)); });
          if (inl.length) out.push(para(inl, { style }));
          break;
        }
        case 'section': this.container(c, out, depth + 1); break;
        case 'p': out.push(para(this.inline(c), attr(c, 'style') ? { style: 'Normal' } : null)); break;
        case 'subtitle': out.push(para(this.inline(c), { style: 'Subtitle', align: 'center' })); break;
        case 'empty-line': out.push(para()); break;
        case 'epigraph': case 'cite': case 'annotation': {
          for (const k of kids(c)) {
            if (k.localName === 'text-author') out.push(para(this.inline(k), { style: 'Quote', align: 'right' }));
            else if (k.localName === 'poem') this.poem(k, out, 'Quote');
            else if (k.localName === 'empty-line') out.push(para([], { style: 'Quote' }));
            else out.push(para(this.inline(k), { style: 'Quote' }));
          }
          break;
        }
        case 'poem': this.poem(c, out, 'Normal'); break;
        case 'image': {
          const src = this.images.get(href(c).replace(/^#/, ''));
          if (src) out.push(para([S.image.create({ src, alt: attr(c, 'alt') || attr(c, 'title') || '' })], { align: 'center' }));
          break;
        }
        case 'table': { const t = this.table(c); if (t) out.push(t); break; }
        default: break;
      }
    }
  }

  private poem(el: Element, out: PMNode[], style: string): void {
    for (const k of kids(el)) {
      if (k.localName === 'title') out.push(para(kidsNamed(k, 'p').flatMap((p) => this.inline(p)), { style: 'Heading 4' }));
      else if (k.localName === 'epigraph') for (const q of kids(k)) out.push(para(this.inline(q), { style: 'Quote', align: q.localName === 'text-author' ? 'right' : null }));
      else if (k.localName === 'stanza') {
        const inl: PMNode[] = [];
        kidsNamed(k, 'v').forEach((v, i) => { if (i) inl.push(S.hard_break.create()); inl.push(...this.inline(v)); });
        out.push(para(inl, { style, indentLeft: 36 }));
      } else if (k.localName === 'text-author') out.push(para(this.inline(k), { style, align: 'right' }));
    }
  }

  private table(t: Element): PMNode | null {
    const rows: CellSpec[][] = kidsNamed(t, 'tr').map((tr) => kids(tr).filter((c) => c.localName === 'td' || c.localName === 'th').map((c) => ({
      blocks: [para(this.inline(c), attr(c, 'align') ? { align: attr(c, 'align') } : null)], colspan: parseInt(attr(c, 'colspan') || '1', 10) || 1,
      rowspan: parseInt(attr(c, 'rowspan') || '1', 10) || 1, header: c.localName === 'th', valign: attr(c, 'valign'),
    })));
    return makeTable(rows, { headerRows: rows.length > 1 && rows[0].every((c) => c.header) ? 1 : 0 });
  }

  inline(el: Element, marks: readonly Mark[] = []): PMNode[] {
    const buf = new InlineBuf();
    const walk = (node: Element, m: readonly Mark[]) => {
      for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === 3 || c.nodeType === 4) { const v = c.nodeValue || ''; buf.text(m.some((x) => x.type === MK.code) ? v.replace(/\r?\n/g, ' ') : v.replace(/\s+/g, ' '), m); continue; }
        if (c.nodeType !== 1) continue;
        const e = c as Element;
        const add = (mk: Mark) => walk(e, mk.addToSet(m));
        switch (e.localName) {
          case 'strong': add(MK.bold.create()); break;
          case 'emphasis': add(MK.italic.create()); break;
          case 'strikethrough': add(MK.strike.create()); break;
          case 'sub': add(MK.sub.create()); break;
          case 'sup': add(MK.sup.create()); break;
          case 'code': add(MK.code.create()); break;
          case 'style': walk(e, m); break;
          case 'a': {
            const h = href(e);
            const id = h.startsWith('#') ? h.slice(1) : '';
            if (attr(e, 'type') === 'note' || (id && this.notes.has(id))) {
              buf.node(S.footnote.create({ text: this.notes.get(id) || textOf(e), mark: null }));
              break;
            }
            if (h && !/^\s*(javascript|vbscript):/i.test(h)) add(MK.link.create({ href: h })); else walk(e, m);
            break;
          }
          case 'image': {
            const src = this.images.get(href(e).replace(/^#/, ''));
            if (src) buf.node(S.image.create({ src, alt: attr(e, 'alt') || '' }));
            break;
          }
          default: walk(e, m);
        }
      }
    };
    walk(el, marks);
    const items = buf.take();
    // Trim leading/trailing whitespace of the paragraph.
    const isCode = (n: PMNode) => n.marks.some((x) => x.type === MK.code);
    if (items[0]?.isText && !isCode(items[0])) { const t = items[0].text!.replace(/^\s+/, ''); if (t) items[0] = schema.text(t, items[0].marks); else items.shift(); }
    const last = items[items.length - 1];
    if (last?.isText && !isCode(last)) { const t = last.text!.replace(/\s+$/, ''); if (t) items[items.length - 1] = schema.text(t, last.marks); else items.pop(); }
    return items;
  }
}


export function fb2ToDoc(xml: string): PMNode {
  const d = parseXml(xml);
  const root = d?.documentElement;
  if (!root || root.localName !== 'FictionBook') throw new Error('Not a FictionBook document (FictionBook root element missing)');
  return new Fb2Reader(root).read();
}

export async function importFb2(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const u8 = new Uint8Array(data);
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const zip = await loadZip(data);
    const entry = Object.values(zip.files).find((f) => !f.dir && /\.fb2$/i.test(f.name)) || Object.values(zip.files).find((f) => !f.dir);
    if (!entry) throw new Error('The archive contains no .fb2 file');
    return fb2ToDoc(decodeXml(await entry.async('uint8array')));
  }
  return fb2ToDoc(decodeXml(u8));
}
