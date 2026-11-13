/**
 * KWord (KOffice 1.x) import: .kwd documents and .kwt templates.
 *
 * KOffice 1.3+ stores maindoc.xml in a ZIP; KOffice 1.0–1.2 used a gzipped tar; very old
 * files are bare XML. Calligra Words (KOffice 2+) saves ODT, which opens with the ODT importer.
 *
 * KWord's model is frame based: FRAMESETS hold text framesets (body, headers, footers,
 * footnotes, table cells) and picture framesets. Text is a <TEXT> string per PARAGRAPH plus
 * <FORMATS> ranges (pos/len) for character formatting and anchored objects, and a <LAYOUT>
 * (style name, alignment, indents, spacing, counters/numbering, default character format).
 * Mapped: paper size/orientation/margins, named styles, paragraph layout, character formats
 * (font, size, weight, italic, underline, strike, sub/superscript, colours), counters → lists
 * (chapter numbering stays on headings), tables (cell framesets grouped by grpMgr, with spans),
 * anchored and floating pictures, footnotes/endnotes, links, page-number variables, headers
 * and footers. Not mapped: absolute frame positions, frame text flow between frames.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { loadZip } from './zip';
import { schema } from '../editor/schema';
import { PAGE_SIZES, type StyleDef } from '../editor/settings';
import { gunzip, untar } from './archive';
import { attr, kid, kidsNamed, numAttr, parseXml, decodeXml } from './xml-read';
import { InlineBuf, charMarks, hfFromBlocks, makeTable, paraAttrs, type CellSpec, type CharProps } from './runs';
import { buildNestedLists, canonicalStyleName, finishDoc, normalizeImportedFormatting, mimeForName, newSettings, para, sniffImageMime, toDataUrl, type FlatListItem } from './serialize';

const S = schema.nodes;
const MK = schema.marks;

const rgb = (el: Element | null): string | null => {
  if (!el) return null;
  const r = numAttr(el, 'red'), g = numAttr(el, 'green'), b = numAttr(el, 'blue');
  if (r == null || g == null || b == null || r < 0) return null;
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
};

function formatProps(f: Element | null): CharProps {
  const p: CharProps = {};
  if (!f) return p;
  const v = (n: string) => attr(kid(f, n), 'value');
  const w = v('WEIGHT');
  if (w != null) p.bold = parseInt(w, 10) >= 63;
  if (v('ITALIC') != null) p.italic = v('ITALIC') === '1';
  const u = v('UNDERLINE');
  if (u != null && u !== '0' && u !== 'none') p.underline = u === 'double' ? 'double' : u === 'wave' ? 'wavy' : true;
  const st = v('STRIKEOUT');
  if (st != null && st !== '0' && st !== 'none') p.strike = true;
  const va = v('VERTALIGN');
  if (va === '2') p.sup = true; else if (va === '1') p.sub = true;
  const font = attr(kid(f, 'FONT'), 'name');
  if (font) p.font = font;
  const size = v('SIZE');
  if (size) p.size = parseFloat(size);
  p.color = rgb(kid(f, 'COLOR'));
  p.highlight = rgb(kid(f, 'TEXTBACKGROUNDCOLOR'));
  const caps = attr(kid(f, 'FONTATTRIBUTE'), 'value');
  if (caps === 'smallcaps') p.smallcaps = true; else if (caps === 'uppercase') p.allcaps = true;
  return p;
}

/** Merge character props: later values win where defined. */
function mergeProps(a: CharProps, b: CharProps): CharProps {
  const out: CharProps = { ...a };
  for (const [k, v] of Object.entries(b)) if (v != null) (out as any)[k] = v;
  return out;
}

function layoutAttrs(layout: Element | null): Record<string, any> {
  if (!layout) return {};
  const ind = kid(layout, 'INDENTS'), off = kid(layout, 'OFFSETS'), ls = kid(layout, 'LINESPACING'), pb = kid(layout, 'PAGEBREAKING');
  let lineHeight: string | null = null;
  const t = attr(ls, 'type') || attr(ls, 'value');
  const sv = numAttr(ls, 'spacingvalue');
  if (t === 'oneandhalf') lineHeight = '1.5';
  else if (t === 'double') lineHeight = '2';
  else if (t === 'multiple' && sv) lineHeight = String(sv);
  else if (t === 'atleast' && sv) lineHeight = `atleast:${sv}`;
  else if (t === 'exactly' && sv) lineHeight = `${sv}pt`;
  const align = attr(kid(layout, 'FLOW'), 'align');
  return paraAttrs({
    align: align === 'auto' ? null : align, indentLeft: numAttr(ind, 'left'), indentRight: numAttr(ind, 'right'), indentFirst: numAttr(ind, 'first'),
    spaceBefore: numAttr(off, 'before'), spaceAfter: numAttr(off, 'after'), lineHeight,
    keepNext: attr(pb, 'keepWithNext') === 'true', keepLines: attr(pb, 'linesTogether') === 'true', pageBreakBefore: attr(pb, 'hardFrameBreak') === 'true',
    dir: attr(kid(layout, 'FLOW'), 'dir') === 'R' ? 'rtl' : null,
  });
}

const COUNTER: Record<string, { ordered: boolean; format: string }> = {
  1: { ordered: true, format: 'decimal' }, 2: { ordered: true, format: 'lower-alpha' }, 3: { ordered: true, format: 'upper-alpha' },
  4: { ordered: true, format: 'lower-roman' }, 5: { ordered: true, format: 'upper-roman' }, 6: { ordered: false, format: 'disc' },
  7: { ordered: true, format: 'decimal' }, 8: { ordered: false, format: 'circle' }, 9: { ordered: false, format: 'square' },
  10: { ordered: false, format: 'disc' }, 11: { ordered: false, format: '☐' },
};

interface Frameset { el: Element; info: string; name: string; type: string }

class KwdReader {
  settings = newSettings();
  styles = new Map<string, { layout: Element; format: CharProps }>();
  framesets: Frameset[] = [];
  tables = new Map<string, Element[]>();
  pictures = new Map<string, string>();
  notes = new Map<string, string>();
  usedTables = new Set<string>();

  constructor(private root: Element, private files: Map<string, Uint8Array>) {}

  read(): PMNode {
    const r = this.root;
    this.paper(kid(r, 'PAPER'));
    for (const st of kidsNamed(kid(r, 'STYLES'), 'STYLE')) {
      const name = attr(kid(st, 'NAME'), 'value') || '';
      this.styles.set(name, { layout: st, format: formatProps(kid(st, 'FORMAT')) });
    }
    this.importStyles();
    for (const [path, bytes] of this.files) {
      const mime = sniffImageMime(bytes) || mimeForName(path);
      if (mime.startsWith('image/')) this.pictures.set(path, toDataUrl(bytes, mime));
    }
    for (const fs of kidsNamed(kid(r, 'FRAMESETS'), 'FRAMESET')) {
      const f: Frameset = { el: fs, info: attr(fs, 'frameInfo') || '0', name: attr(fs, 'name') || '', type: attr(fs, 'frameType') || '1' };
      const grp = attr(fs, 'grpMgr');
      if (grp) { const list = this.tables.get(grp) || []; list.push(fs); this.tables.set(grp, list); continue; }
      this.framesets.push(f);
    }
    // Footnote framesets first, so references can carry their text.
    for (const f of this.framesets) {
      if (f.info === '7' || /^(Footnote|Endnote)/i.test(f.name) && f.info !== '0') {
        const blocks = this.textFrameset(f.el);
        this.notes.set(f.name, blocks.map((b) => b.textContent).join('\n').trim());
      }
    }
    const hf: Record<string, string[]> = { 1: ['firstHeader'], 2: ['evenHeader'], 3: ['header'], 4: ['firstFooter'], 5: ['evenFooter'], 6: ['footer'] };
    for (const f of this.framesets) {
      const target = hf[f.info];
      if (!target || f.type !== '1') continue;
      const h = hfFromBlocks(this.textFrameset(f.el));
      if (h) (this.settings as any)[target[0]] = h;
      if (f.info === '1' || f.info === '4') this.settings.differentFirst = true;
      if (f.info === '2' || f.info === '5') this.settings.differentOddEven = true;
    }
    const blocks: PMNode[] = [];
    const main = this.framesets.find((f) => f.type === '1' && f.info === '0');
    if (main) blocks.push(...this.textFrameset(main.el));
    // Floating pictures and text frames that are not anchored in the text follow the body.
    for (const f of this.framesets) {
      if (f === main || f.info !== '0') continue;
      if (f.type === '2' || f.type === '5') { const img = this.picture(f.el); if (img) blocks.push(para([img])); }
      else if (f.type === '1' && attr(f.el, 'visible') !== '0' && !/^(Footnote|Endnote)/i.test(f.name)) {
        const inner = this.textFrameset(f.el);
        if (inner.some((b) => b.textContent.trim())) blocks.push(S.text_box.create({ float: 'right' }, inner));
      }
    }
    for (const [name, cells] of this.tables) if (!this.usedTables.has(name)) { const t = this.table(cells); if (t) blocks.push(t); }
    // Every paragraph repeats its full character format: keep only what differs from the style.
    return finishDoc(normalizeImportedFormatting(blocks, this.settings, this.settings.styles.Normal?.font || null), this.settings);
  }

  private paper(p: Element | null): void {
    if (!p) return;
    const pg = this.settings.page;
    const w = numAttr(p, 'width'), h = numAttr(p, 'height');
    if (w && h) {
      pg.width = Math.min(w, h); pg.height = Math.max(w, h);
      pg.sizeName = 'Custom';
      for (const [n, [pw, ph]] of Object.entries(PAGE_SIZES)) if (Math.abs(pw - pg.width) < 3 && Math.abs(ph - pg.height) < 3) { pg.sizeName = n; break; }
    }
    pg.orientation = attr(p, 'orientation') === '1' ? 'landscape' : 'portrait';
    const b = kid(p, 'PAPERBORDERS');
    if (b) pg.margin = { top: numAttr(b, 'top') ?? 72, bottom: numAttr(b, 'bottom') ?? 72, left: numAttr(b, 'left') ?? 72, right: numAttr(b, 'right') ?? 72 };
  }

  private styleName(n: string): string {
    if (n === 'Standard') return 'Normal';
    const m = /^Head(?:ing|line)? ?(\d)$/i.exec(n);
    if (m) return `Heading ${m[1]}`;
    return canonicalStyleName(n) || n;
  }

  private importStyles(): void {
    const out: Record<string, StyleDef> = {};
    for (const [name, st] of this.styles) {
      const n = this.styleName(name);
      const f = st.format;
      const def: StyleDef = { name: n, type: 'paragraph' };
      if (f.font) def.font = f.font;
      if (f.size) def.size = f.size;
      if (f.bold) def.bold = true;
      if (f.italic) def.italic = true;
      if (f.color && f.color !== '#000000') def.color = f.color;
      const la = layoutAttrs(st.layout);
      for (const k of ['align', 'spaceBefore', 'spaceAfter', 'indentLeft', 'indentRight', 'indentFirst', 'lineHeight', 'keepNext'] as const) if (la[k] != null) (def as any)[k] = la[k];
      const follow = attr(kid(st.layout, 'FOLLOWING'), 'name');
      if (follow) def.next = this.styleName(follow);
      out[n] = def;
    }
    const normal = out.Normal;
    if (normal?.font) this.settings.theme = { ...this.settings.theme, bodyFont: normal.font, headingFont: out['Heading 1']?.font || normal.font };
    this.settings.styles = out;
  }

  textFrameset(fs: Element): PMNode[] {
    const out: PMNode[] = [];
    let listRun: FlatListItem[] = [];
    const flush = () => { if (listRun.length) { out.push(...buildNestedLists(listRun)); listRun = []; } };
    for (const p of kidsNamed(fs, 'PARAGRAPH')) {
      const { node, extra, counter } = this.paragraph(p);
      if (!node) { flush(); out.push(...extra); continue; }
      if (counter) listRun.push({ level: counter.depth, ordered: counter.ordered, format: counter.format, start: counter.start, blocks: [node] });
      else { flush(); out.push(node); }
      if (extra.length) { flush(); out.push(...extra); }
    }
    flush();
    return out;
  }

  private paragraph(p: Element): { node: PMNode | null; extra: PMNode[]; counter: { depth: number; ordered: boolean; format: string; start: number } | null } {
    const layout = kid(p, 'LAYOUT');
    const styleName = attr(kid(layout, 'NAME'), 'value') || 'Standard';
    const st = this.styles.get(styleName);
    const attrs = { ...layoutAttrs(layout), style: this.styles.has(styleName) ? this.styleName(styleName) : 'Normal' };
    const base = mergeProps(st?.format || {}, formatProps(kid(layout, 'FORMAT')));
    const text = (kid(p, 'TEXT')?.textContent || '').replace(/\r/g, '');
    // Character formats by position; later FORMAT elements override earlier ones.
    const chars: (CharProps | null)[] = Array.from({ length: text.length }, () => null);
    const objects = new Map<number, Element>();
    for (const f of kidsNamed(kid(p, 'FORMATS'), 'FORMAT')) {
      const id = attr(f, 'id') || '1';
      const pos = parseInt(attr(f, 'pos') || '0', 10) || 0;
      const n = parseInt(attr(f, 'len') || '1', 10) || 1;
      if (id === '1') { const fp = formatProps(f); for (let i = pos; i < pos + n && i < text.length; i++) chars[i] = mergeProps(chars[i] || {}, fp); }
      else objects.set(pos, f);
    }
    const buf = new InlineBuf();
    const extra: PMNode[] = [];
    let i = 0;
    while (i < text.length) {
      const obj = objects.get(i);
      const props = mergeProps(base, chars[i] || {});
      if (obj) {
        this.object(obj, charMarks(props), buf, extra);
        i += obj.getAttribute('id') === '4' ? Math.max(1, parseInt(attr(obj, 'len') || '1', 10)) : 1;
        continue;
      }
      let j = i + 1;
      while (j < text.length && !objects.has(j) && chars[j] === chars[i]) j++;
      const seg = text.slice(i, j).replace(/[\u0001-\u0008]/g, '');
      const marks = charMarks(props);
      const lines = seg.split('\n');
      lines.forEach((l, k) => { if (k) buf.node(S.hard_break.create()); buf.text(l, marks); });
      i = j;
    }
    const content = buf.take();
    // A paragraph that only anchors a table or frame disappears behind it.
    if (!content.length && extra.length && objects.size && text.replace(/[#\s]/g, '') === '') return { node: null, extra, counter: null };
    const node = S.paragraph.create(attrs, content);
    const ctr = kid(layout, 'COUNTER');
    let counter = null;
    const type = attr(ctr, 'type') || '0';
    if (ctr && type !== '0' && attr(ctr, 'numberingtype') !== '1' && attr(ctr, 'numberingtype') !== '2') {
      const k = COUNTER[type] || COUNTER[10];
      const bullet = attr(ctr, 'bullet');
      const fmt = type === '6' && bullet ? String.fromCharCode(parseInt(bullet, 10) === 183 ? 0x2022 : parseInt(bullet, 10) || 0x2022) : k.format;
      counter = { depth: parseInt(attr(ctr, 'depth') || '0', 10) || 0, ordered: k.ordered, format: fmt === '•' ? 'disc' : fmt, start: parseInt(attr(ctr, 'start') || '1', 10) || 1 };
    }
    return { node, extra, counter };
  }

  private object(f: Element, marks: Mark[], buf: InlineBuf, extra: PMNode[]): void {
    const id = attr(f, 'id');
    if (id === '6') {
      const anchor = kid(f, 'ANCHOR');
      const inst = attr(anchor, 'instance') || '';
      const cells = this.tables.get(inst);
      if (cells) { this.usedTables.add(inst); const t = this.table(cells); if (t) extra.push(t); return; }
      const fs = this.framesets.find((x) => x.name === inst);
      if (fs && (fs.type === '2' || fs.type === '5')) { const img = this.picture(fs.el); if (img) buf.node(img); fs.info = 'used'; }
      else if (fs && fs.type === '1') { fs.info = 'used'; extra.push(S.text_box.create({ float: 'none' }, this.textFrameset(fs.el))); }
      return;
    }
    if (id === '2') {
      const fn = attr(kid(kid(f, 'PICTURE'), 'KEY'), 'filename') || attr(kid(f, 'FILENAME'), 'value') || '';
      const src = this.pictureSrc(fn);
      if (src) buf.node(S.image.create({ src }));
      return;
    }
    if (id === '4') {
      const v = kid(f, 'VARIABLE');
      const t = kid(v, 'TYPE');
      const key = attr(t, 'key') || '';
      const shown = attr(t, 'text') || '';
      const fn = kid(v, 'FOOTNOTE');
      if (fn) {
        const fsName = attr(fn, 'frameset') || '';
        buf.node(S.footnote.create({ text: this.notes.get(fsName) || '', kind: attr(fn, 'notetype') === 'endnote' ? 'end' : 'foot' }));
        return;
      }
      const link = kid(v, 'LINK');
      if (link) { buf.text(attr(link, 'linkName') || shown, [...marks, MK.link.create({ href: attr(link, 'hrefName') || '' })]); return; }
      if (kid(v, 'PGNUM')) {
        const sub = attr(kid(v, 'PGNUM'), 'subtype');
        buf.node(S.field.create({ type: sub === '1' ? 'NUMPAGES' : 'PAGE', value: shown }, null, marks));
        return;
      }
      if (kid(v, 'DATE') || /^DATE/.test(key)) { buf.node(S.field.create({ type: 'DATE', value: shown }, null, marks)); return; }
      if (kid(v, 'TIME') || /^TIME/.test(key)) { buf.node(S.field.create({ type: 'TIME', value: shown }, null, marks)); return; }
      if (shown) buf.text(shown, marks);
    }
  }

  private pictureSrc(filename: string): string | null {
    if (!filename) return null;
    const direct = this.pictures.get(filename);
    if (direct) return direct;
    // KEY elements reference the original file name; the stored copy lives under pictures/.
    const keys = kidsNamed(kid(this.root, 'PICTURES'), 'KEY').concat(kidsNamed(kid(this.root, 'PIXMAPS'), 'KEY'));
    const key = keys.find((k) => attr(k, 'filename') === filename);
    const stored = attr(key, 'name');
    if (stored && this.pictures.get(stored)) return this.pictures.get(stored)!;
    const base = filename.split('/').pop()!;
    for (const [p, src] of this.pictures) if (p.endsWith('/' + base)) return src;
    return null;
  }

  private picture(fs: Element): PMNode | null {
    const pic = kid(fs, 'PICTURE') || kid(fs, 'IMAGE') || kid(fs, 'CLIPART');
    const fn = attr(kid(pic, 'KEY'), 'filename') || '';
    const src = this.pictureSrc(fn);
    if (!src) return null;
    const fr = kid(fs, 'FRAME');
    const w = fr ? (numAttr(fr, 'right') ?? 0) - (numAttr(fr, 'left') ?? 0) : 0;
    const h = fr ? (numAttr(fr, 'bottom') ?? 0) - (numAttr(fr, 'top') ?? 0) : 0;
    return S.image.create({ src, width: w > 0 ? Math.round(w * 100) / 100 : null, height: h > 0 ? Math.round(h * 100) / 100 : null });
  }

  private table(cells: Element[]): PMNode | null {
    const items = cells.map((c) => ({
      row: parseInt(attr(c, 'row') || '0', 10) || 0, col: parseInt(attr(c, 'col') || '0', 10) || 0,
      rows: parseInt(attr(c, 'rows') || '1', 10) || 1, cols: parseInt(attr(c, 'cols') || '1', 10) || 1, el: c,
    })).sort((a, b) => a.row - b.row || a.col - b.col);
    if (!items.length) return null;
    const n = Math.max(...items.map((x) => x.row)) + 1;
    const rows: CellSpec[][] = Array.from({ length: n }, () => []);
    for (const it of items) {
      const fr = kid(it.el, 'FRAME');
      const bgColor = fr && attr(fr, 'bkRed') != null ? '#' + ['bkRed', 'bkGreen', 'bkBlue'].map((k) => (parseInt(attr(fr, k) || '255', 10) || 0).toString(16).padStart(2, '0')).join('') : null;
      const w = fr ? (numAttr(fr, 'right') ?? 0) - (numAttr(fr, 'left') ?? 0) : 0;
      rows[it.row].push({ blocks: this.textFrameset(it.el), colspan: it.cols, rowspan: it.rows, background: bgColor && bgColor !== '#ffffff' ? bgColor : null, width: w > 0 ? w : null });
    }
    return makeTable(rows);
  }
}

/** Parse KWord's maindoc.xml (exported for tests). */
export function kwordToDoc(xml: string, files = new Map<string, Uint8Array>()): PMNode {
  const d = parseXml(xml.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, ''));
  const root = d?.documentElement;
  if (!root || root.localName !== 'DOC') throw new Error('Not a KWord document (DOC root element missing)');
  return new KwdReader(root, files).read();
}

export async function importKword(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const u8 = new Uint8Array(data);
  const files = new Map<string, Uint8Array>();
  let main: Uint8Array | null = null;
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const zip = await loadZip(data);
    const tasks: Promise<void>[] = [];
    zip.forEach((p, f) => { if (!f.dir) tasks.push(f.async('uint8array').then((b) => { files.set(p, b); })); });
    await Promise.all(tasks);
    main = files.get('maindoc.xml') || null;
  } else if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const inner = gunzip(u8);
    if (inner[0] === 0x3c || (inner[0] === 0xef && inner[3] === 0x3c)) main = inner;
    else for (const e of untar(inner)) { files.set(e.name, e.data); if (/(^|\/)maindoc\.xml$/.test(e.name)) main = e.data; }
  } else main = u8;
  if (!main) throw new Error('maindoc.xml is missing: not a KWord document');
  const doc = kwordToDoc(decodeXml(main), files);
  const info = files.get('documentinfo.xml');
  if (info) {
    const d = parseXml(decodeXml(info));
    const t = (n: string) => (d?.getElementsByTagName(n)[0]?.textContent || '').trim();
    const p = doc.attrs.settings.properties;
    p.title = t('title') || p.title; p.author = t('full-name') || p.author; p.comments = t('abstract') || p.comments; p.company = t('company') || p.company;
    p.keywords = t('keyword') || p.keywords; p.subject = t('subject') || p.subject;
  }
  return doc;
}

