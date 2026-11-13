/**
 * Apple Pages import.
 *
 * Pages '09 (and Pages 1–4): a ZIP (or bundle) with index.xml / index.xml.gz in the "SL"
 * (Slingshot) XML vocabulary. Read fully: page size and margins, metadata, named and anonymous
 * paragraph/character styles with parent chains (font, size, bold, italic, underline,
 * strikethrough, baseline, capitals, colour, alignment, spacing, indents, line spacing, keep
 * with next, page break before, fill), list styles (bullets, numbering by level), headers and
 * footers (with page-number fields), footnotes, comments (annotation fields), links, tabs,
 * line/page/section/column breaks, tables (grid with text and number cells) and pictures.
 *
 * Pages 5 and later (2013+): the IWA format (Snappy-compressed Protocol Buffers, see iwa.ts).
 * Read: the body text storage split into paragraphs, paragraph styles (name, font, size, bold,
 * italic, underline, strikethrough, colour, alignment, spacing, keep with next), character
 * style runs, tables (row/column counts with text and number cells from the table tiles) and
 * pictures referenced by the package metadata. Headers/footers, footnotes, comments and page
 * setup of IWA documents are not mapped. Password-protected packages cannot be decrypted; the
 * importer then shows the package's preview image and says so.
 */
import { loadZip } from './zip';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { PAGE_SIZES, type StyleDef } from '../editor/settings';
import { gunzip } from './archive';
import { iwaDecompress, iwaObjects, type IwaObject, type Pb } from './iwa';
import { attr, kids, kid, decodeXml, parseXml, desc, firstDesc, numAttr } from './xml-read';
import { InlineBuf, charMarks, headingStyle, hfFromBlocks, makeTable, paraAttrs, type CellSpec, type CharProps } from './runs';
import { buildNestedLists, finishDoc, mimeForName, newSettings, normalizeImportedFormatting, para, sniffImageMime, toDataUrl, type FlatListItem } from './serialize';

const S = schema.nodes;
const MK = schema.marks;
type Files = Map<string, Uint8Array>;

/** "Helvetica-Bold", "TimesNewRomanPSMT", "LucidaGrande" → family name. */
export function familyFromPostScript(ps: string | null | undefined): string | null {
  if (!ps) return null;
  let n = ps.replace(/-(Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Light|Medium|Book|Semibold|Black|Heavy|Condensed|LightItalic|MediumItalic)$/i, '');
  n = n.replace(/(PSMT|PS|MT)$/, '');
  if (/\s/.test(n)) return n;
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim() || ps;
}

function styleNameMap(name: string | null): string | null {
  if (!name) return null;
  if (/^(Body|Free Form|Normal|Default)$/i.test(name)) return 'Normal';
  const m = /^Heading\s*(\d)$/i.exec(name);
  if (m) return headingStyle(parseInt(m[1], 10));
  if (/^Title$/i.test(name)) return 'Title';
  if (/^Subtitle$/i.test(name)) return 'Subtitle';
  if (/^Caption$/i.test(name)) return 'Caption';
  if (/^Footnote Text$/i.test(name)) return 'Footnote Text';
  if (/^Header & Footer$/i.test(name)) return 'Header';
  return name;
}

const ALIGN = ['left', 'right', 'center', 'justify', 'left'];
const LABEL_FORMATS: Record<string, string> = { decimal: 'decimal', 'upper-roman': 'upper-roman', 'lower-roman': 'lower-roman', 'upper-alpha': 'upper-alpha', 'lower-alpha': 'lower-alpha' };

// =============================================================================================
// Pages '09 (XML)

type PropVal = { v: unknown } | null | undefined; // undefined: not set here; null: explicitly none

class Pages09Reader {
  settings = newSettings();
  byId = new Map<string, Element>();
  byIdent = new Map<string, Element>();
  images = new Map<string, string>();
  footnotes: string[] = [];
  comments = new Map<string, string>();

  constructor(private root: Element, private files: Files) {
    // Styles from the document stylesheet win over identically named prototype copies.
    const main = kids(root).find((k) => k.localName === 'stylesheet');
    const index = (el: Element) => {
      const id = attr(el, 'ID');
      if (id && !this.byId.has(id)) this.byId.set(id, el);
      const ident = attr(el, 'ident');
      if (ident && /style$/.test(el.localName) && !this.byIdent.has(ident)) this.byIdent.set(ident, el);
    };
    if (main) for (const el of Array.from(main.getElementsByTagName('*'))) index(el);
    for (const el of Array.from(root.getElementsByTagName('*'))) index(el);
  }

  private style(ref: string | null): Element | null {
    if (!ref) return null;
    return this.byId.get(ref) || this.byIdent.get(ref) || null;
  }

  /** Property value from a style and its parents. */
  prop(style: Element | null, name: string, depth = 0): unknown {
    if (!style || depth > 20) return undefined;
    const pm = kid(style, 'property-map');
    const p = kid(pm, name);
    if (p) {
      const v = this.value(p);
      if (v !== undefined) return v ? v.v : null;
    }
    return this.prop(this.style(attr(style, 'parent-ident')), name, depth + 1);
  }

  private value(p: Element): PropVal {
    const c = p.firstElementChild;
    if (!c) return undefined;
    switch (c.localName) {
      case 'null': return null;
      case 'number': return { v: parseFloat(attr(c, 'number') || '0') };
      case 'string': return { v: attr(c, 'string') || '' };
      case 'color': {
        const w = attr(c, 'w');
        const ch = (k: string) => Math.round(Math.max(0, Math.min(1, parseFloat(attr(c, k) || (w ?? '0')))) * 255).toString(16).padStart(2, '0');
        return { v: w != null && attr(c, 'r') == null ? '#' + ch('w') + ch('w') + ch('w') : '#' + ch('r') + ch('g') + ch('b') };
      }
      case 'linespacing': return { v: { mode: attr(c, 'mode'), amt: parseFloat(attr(c, 'amt') || '1') } };
      default: {
        const ref = attr(c, 'IDREF');
        return ref ? { v: ref } : { v: c };
      }
    }
  }

  private name(style: Element | null): string | null {
    for (let s = style, d = 0; s && d < 20; s = this.style(attr(s, 'parent-ident')), d++) {
      const n = attr(s, 'name');
      if (n) return n;
    }
    return null;
  }

  charProps(style: Element | null): CharProps {
    const g = (n: string) => this.prop(style, n);
    const num = (n: string) => { const v = g(n); return typeof v === 'number' ? v : null; };
    const sup = num('superscript');
    const caps = num('capitalization');
    return {
      font: familyFromPostScript(typeof g('fontName') === 'string' ? (g('fontName') as string) : null), size: num('fontSize'),
      bold: num('bold') === 1 || /-(Bold|Black|Heavy)/.test(String(g('fontName') || '')), italic: num('italic') === 1 || /(Italic|Oblique)$/.test(String(g('fontName') || '')),
      underline: (num('underline') || 0) > 0 ? (num('underline') === 2 ? 'double' : true) : false, strike: (num('strikethru') || 0) > 0,
      sup: sup === 1, sub: sup === 2, allcaps: caps === 1, smallcaps: caps === 2,
      color: typeof g('fontColor') === 'string' ? (g('fontColor') as string) : null,
      highlight: typeof g('textBackground') === 'string' ? (g('textBackground') as string) : null,
    };
  }

  /** Explicit character properties of a span style (not inherited from the default). */
  spanProps(style: Element | null): CharProps {
    if (!style) return {};
    const full = this.charProps(style);
    const out: CharProps = {};
    const own = (n: string) => { for (let s: Element | null = style, d = 0; s && d < 20 && attr(s, 'ident') !== 'character-style-null'; s = this.style(attr(s, 'parent-ident')), d++) { const p = kid(kid(s, 'property-map'), n); if (p && p.firstElementChild) return true; } return false; };
    if (own('fontName')) out.font = full.font;
    if (own('fontSize')) out.size = full.size;
    if (own('bold') || own('fontName')) out.bold = full.bold;
    if (own('italic') || own('fontName')) out.italic = full.italic;
    if (own('underline')) out.underline = full.underline;
    if (own('strikethru')) out.strike = full.strike;
    if (own('superscript')) { out.sup = full.sup; out.sub = full.sub; }
    if (own('capitalization')) { out.allcaps = full.allcaps; out.smallcaps = full.smallcaps; }
    if (own('fontColor')) out.color = full.color;
    if (own('textBackground')) out.highlight = full.highlight;
    return out;
  }

  paraProps(style: Element | null): Record<string, any> {
    const g = (n: string) => this.prop(style, n);
    const num = (n: string) => { const v = g(n); return typeof v === 'number' ? v : null; };
    const ls = g('lineSpacing') as { mode: string | null; amt: number } | null | undefined;
    let lineHeight: string | null = null;
    if (ls && typeof ls === 'object' && 'amt' in ls) {
      if (ls.mode === 'relative' || !ls.mode) lineHeight = Math.abs(ls.amt - 1) > 0.01 ? String(Math.round(ls.amt * 100) / 100) : null;
      else if (ls.mode === 'min') lineHeight = `atleast:${ls.amt}`;
      else if (ls.mode === 'exact') lineHeight = `${ls.amt}pt`;
    }
    const al = num('alignment');
    return paraAttrs({
      align: al != null ? ALIGN[al] : null, spaceBefore: num('spaceBefore'), spaceAfter: num('spaceAfter'), indentLeft: num('leftIndent'),
      indentRight: num('rightIndent'), indentFirst: num('firstLineIndent'), lineHeight, keepNext: num('keepWithNext') === 1,
      keepLines: num('keepLinesTogether') === 1, pageBreakBefore: num('pageBreakBefore') === 1,
      bg: typeof g('paragraphFill') === 'string' ? (g('paragraphFill') as string) : null,
    });
  }

  listInfo(style: Element | null, level: number): { ordered: boolean; format: string; start: number } | null {
    const ref = this.prop(style, 'listStyle');
    const ls = typeof ref === 'string' ? this.style(ref) : null;
    if (!ls) return null;
    const types = desc(kid(kid(ls, 'property-map'), 'listLabelTypes'), 'list-label-typeinfo');
    const t = types[Math.min(level, types.length - 1)];
    if (!t || attr(t, 'type') === 'none') return null;
    if (attr(t, 'type') === 'image') return { ordered: false, format: 'disc', start: 1 };
    const lab = kid(t, 'text-label');
    const lt = attr(lab, 'type') || 'bullet';
    if (lt === 'bullet') { const f = attr(lab, 'format') || '•'; return { ordered: false, format: f === '•' ? 'disc' : f === '◦' ? 'circle' : f === '▪' ? 'square' : f, start: 1 }; }
    return { ordered: true, format: LABEL_FORMATS[lt] || 'decimal', start: parseInt(attr(lab, 'first') || '1', 10) || 1 };
  }

  read(): PMNode {
    const r = this.root;
    this.meta();
    this.page();
    for (const [p, b] of this.files) {
      const mime = sniffImageMime(b) || mimeForName(p);
      if (mime.startsWith('image/') && !/QuickLook|preview/i.test(p)) this.images.set(p.replace(/^[^/]+\.pages\//, ''), toDataUrl(b, mime));
    }
    for (const a of desc(kid(r, 'annotations'), 'annotation')) {
      const target = attr(a, 'target');
      if (target) this.comments.set(target, (a.textContent || '').trim());
    }
    const body = kids(r).find((k) => k.localName === 'text-storage');
    if (!body) throw new Error("No body text found in this Pages '09 document");
    const fnStore = firstDesc(kid(body, 'footnotes'), 'text-storage');
    if (fnStore) this.collectFootnotes(fnStore);
    for (const [key, target] of [['headers', ['header', 'evenHeader', 'firstHeader']], ['footers', ['footer', 'evenFooter', 'firstFooter']]] as const) {
      for (const h of kids(kid(r, key))) {
        const name = attr(h, 'name') || '';
        const idx = /Even/.test(name) ? 1 : /First/.test(name) ? 2 : 0;
        const ts = kid(h, 'text-storage');
        if (!ts) continue;
        const hf = hfFromBlocks(this.storage(ts));
        if (hf) (this.settings as any)[target[idx]] = hf;
      }
    }
    const blocks = this.storage(body);
    for (const [id, text] of this.comments) {
      const cid = 'pages-' + id;
      if (!this.settings.comments[cid]) this.settings.comments[cid] = { id: cid, author: 'Unknown', date: 0, text, resolved: false, replies: [] };
    }
    return finishDoc(normalizeImportedFormatting(blocks, this.settings, this.settings.styles.Normal?.font || null), this.settings);
  }

  private meta(): void {
    const md = kid(this.root, 'metadata');
    if (!md) return;
    const strs = (n: string) => desc(kid(md, n), 'string').map((s) => attr(s, 'string') || '').filter(Boolean);
    const p = this.settings.properties;
    p.title = strs('title').join(' ');
    p.author = strs('authors').join('; ');
    p.keywords = strs('keywords').join(', ');
    p.comments = strs('comment').join(' ');
    p.subject = strs('projects').join(', ');
  }

  private page(): void {
    const pi = kids(this.root).find((k) => k.localName === 'slprint-info');
    if (!pi) return;
    const w = numAttr(pi, 'page-width'), h = numAttr(pi, 'page-height');
    const pg = this.settings.page;
    if (w && h) {
      pg.width = Math.min(w, h); pg.height = Math.max(w, h); pg.orientation = w > h ? 'landscape' : 'portrait';
      pg.sizeName = 'Custom';
      for (const [n, [pw, ph]] of Object.entries(PAGE_SIZES)) if (Math.abs(pw - pg.width) < 2 && Math.abs(ph - pg.height) < 2) { pg.sizeName = n; break; }
    }
    const m = kid(pi, 'page-margins');
    if (m) {
      const v = (k: string) => Math.round((numAttr(m, k) ?? 72) * 100) / 100;
      pg.margin = { top: v('top'), bottom: v('bottom'), left: v('left'), right: v('right') };
      pg.headerDist = numAttr(m, 'header') ?? pg.headerDist;
      pg.footerDist = numAttr(m, 'footer') ?? pg.footerDist;
    }
  }

  private collectFootnotes(ts: Element): void {
    let cur = '';
    for (const p of desc(ts, 'p')) {
      for (const n of Array.from(p.childNodes)) {
        if (n.nodeType === 1 && (n as Element).localName === 'footnotebr') { this.footnotes.push(cur.trim()); cur = ''; continue; }
        const walk = (x: Node) => {
          if (x.nodeType === 3) cur += x.nodeValue || '';
          else if (x.nodeType === 1) {
            const e = x as Element;
            if (e.localName === 'footnotebr') { this.footnotes.push(cur.trim()); cur = ''; return; }
            if (e.localName === 'footnote-mark') return;
            for (const c of Array.from(e.childNodes)) walk(c);
          }
        };
        walk(n);
      }
      cur += ' ';
    }
    if (cur.trim()) this.footnotes.push(cur.trim());
  }

  /** Paragraphs of a text storage (body, header, footer, text box, cell). */
  storage(ts: Element): PMNode[] {
    const out: PMNode[] = [];
    const body = kid(ts, 'text-body') || ts;
    let run: FlatListItem[] = [];
    const flush = () => { if (run.length) { out.push(...buildNestedLists(run)); run = []; } };
    const usedStyles = new Set<string>();
    for (const p of desc(body, 'p')) {
      if (p.parentElement && p.parentElement.closest && p.parentElement.closest('footnotes')) continue;
      const style = this.style(attr(p, 'style'));
      const name = styleNameMap(this.name(style));
      if (name && name !== 'Normal') usedStyles.add(attr(p, 'style') || '');
      const attrs: Record<string, any> = { ...this.paraProps(style), style: name || 'Normal' };
      const base = this.charProps(style);
      const { nodes, after } = this.paragraph(p, attrs, base);
      const level = parseInt(attr(p, 'list-level') || String(this.prop(style, 'listLevel') ?? 0), 10) || 0;
      const li = this.listInfo(style, level);
      for (const n of nodes) {
        if (li) run.push({ level, ...li, blocks: [S.paragraph.create({ ...n.attrs, indentLeft: null, indentFirst: null }, n.content)] });
        else { flush(); out.push(n); }
      }
      if (after.length) { flush(); out.push(...after); }
    }
    flush();
    this.defineStyles(usedStyles);
    return out;
  }

  private defineStyles(refs: Set<string>): void {
    for (const ref of refs) {
      const st = this.style(ref);
      let named = st;
      for (let d = 0; named && !attr(named, 'name'); d++) named = d < 20 ? this.style(attr(named, 'parent-ident')) : null;
      const n = styleNameMap(this.name(st));
      if (!named || !n || this.settings.styles[n]) continue;
      const c = this.charProps(named);
      const pa = this.paraProps(named);
      const def: StyleDef = { name: n, type: 'paragraph' };
      if (c.font) def.font = c.font;
      if (c.size) def.size = c.size;
      if (c.bold) def.bold = true;
      if (c.italic) def.italic = true;
      if (c.color && c.color !== '#000000') def.color = c.color;
      for (const k of ['align', 'spaceBefore', 'spaceAfter', 'indentLeft', 'indentRight', 'indentFirst', 'lineHeight', 'keepNext'] as const) if (pa[k] != null) (def as any)[k] = pa[k];
      this.settings.styles = { ...this.settings.styles, [n]: def };
    }
    // The default ("Body") style supplies the Normal font and size.
    if (!this.settings.styles.Normal) {
      const body = this.byIdent.get('paragraph-style-32') || this.byIdent.get('paragraph-style-default');
      if (body) {
        const c = this.charProps(body);
        if (c.font) this.settings.theme = { ...this.settings.theme, bodyFont: c.font, headingFont: c.font };
        if (c.size) this.settings.styles = { ...this.settings.styles, Normal: { name: 'Normal', type: 'paragraph', size: c.size } };
      }
    }
  }

  private paragraph(p: Element, attrs: Record<string, any>, base: CharProps): { nodes: PMNode[]; after: PMNode[] } {
    const nodes: PMNode[] = [];
    const after: PMNode[] = [];
    const buf = new InlineBuf();
    const flushPara = (force = false) => { if (!buf.empty || force) nodes.push(S.paragraph.create(attrs, buf.take())); };
    const walk = (el: Element, props: CharProps, extra: Mark[]) => {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3 || n.nodeType === 4) { buf.text(n.nodeValue || '', charMarks(props, extra)); continue; }
        if (n.nodeType !== 1) continue;
        const e = n as Element;
        switch (e.localName) {
          case 'span': walk(e, { ...props, ...this.spanProps(this.style(attr(e, 'style'))) }, extra); break;
          case 'link': {
            const href = attr(e, 'href') || '';
            walk(e, props, href && !/^\s*(javascript|vbscript):/i.test(href) ? [...extra, MK.link.create({ href })] : extra);
            break;
          }
          case 'annotation-field': walk(e, props, [...extra, MK.comment.create({ id: 'pages-' + (attr(e, 'ID') || '') })]); break;
          case 'tab': buf.text('\t', charMarks(props, extra)); break;
          case 'lnbr': case 'crbr': buf.node(S.hard_break.create()); break;
          case 'pgbr': flushPara(); after.push(S.page_break.create()); break;
          case 'sectbr': case 'layoutbr': flushPara(); after.push(S.section_break.create({ kind: 'nextPage' })); break;
          case 'contbr': flushPara(); after.push(S.column_break.create()); break;
          case 'footnote': {
            const idx = parseInt(attr(e, 'index') || '-1', 10);
            buf.node(S.footnote.create({ text: this.footnotes[idx] ?? '' }));
            break;
          }
          case 'page-number': buf.node(S.field.create({ type: 'PAGE', value: attr(e, 'value') || '1' }, null, charMarks(props, extra))); if (attr(e, 'format') && attr(e, 'format') !== 'decimal') this.settings.pageNumber.format = attr(e, 'format')!; break;
          case 'page-count': buf.node(S.field.create({ type: 'NUMPAGES', value: attr(e, 'value') || '' }, null, charMarks(props, extra))); break;
          case 'date-time': buf.node(S.field.create({ type: 'DATE', value: (e.textContent || '').trim() }, null, charMarks(props, extra))); break;
          case 'attachment-ref': {
            const a = this.byId.get(attr(e, 'IDREF') || '');
            if (a) this.attachment(a, buf, after, flushPara);
            break;
          }
          case 's': buf.text(' '.repeat(parseInt(attr(e, 'c') || '1', 10) || 1), charMarks(props, extra)); break;
          case 'br': case 'footnotebr': case 'ghost-text': case 'insertion-point': case 'selection-start': case 'selection-end': case 'container-hint': case 'page-start': break;
          default: walk(e, props, extra);
        }
      }
    };
    walk(p, base, []);
    flushPara(nodes.length === 0 && after.length === 0);
    return { nodes, after };
  }

  private attachment(a: Element, buf: InlineBuf, after: PMNode[], flushPara: () => void): void {
    const tab = firstDesc(a, 'tabular-model');
    if (tab) { flushPara(); const t = this.table(tab); if (t) after.push(t); return; }
    const data = firstDesc(a, 'data');
    const path = attr(data, 'path');
    if (path) {
      const src = this.images.get(path) || [...this.images.entries()].find(([k]) => k.endsWith('/' + path) || k === path.split('/').pop())?.[1];
      if (src) {
        const size = firstDesc(a, 'size') || firstDesc(a, 'naturalSize');
        buf.node(S.image.create({ src, width: numAttr(size, 'w'), height: numAttr(size, 'h') }));
        return;
      }
    }
    const ts = firstDesc(a, 'text-storage');
    if (ts) { flushPara(); const inner = this.storage(ts); if (inner.length) after.push(S.text_box.create({ float: 'none' }, inner)); }
  }

  private table(model: Element): PMNode | null {
    const grid = kid(model, 'grid');
    const cols = numAttr(grid, 'numcols') || 1;
    const nrows = numAttr(grid, 'numrows') || 1;
    const ds = kid(grid, 'datasource');
    const rows: CellSpec[][] = [];
    let row: CellSpec[] = [];
    let used = 0;
    for (const c of kids(ds)) {
      let blocks: PMNode[] = [];
      const kind = c.localName;
      if (kind === 'o') { used++; if (used % cols === 0) { rows.push(row); row = []; } continue; } // covered by a merged cell
      if (kind === 't') {
        const ct = kid(c, 'ct');
        const so = firstDesc(c, 'text-storage');
        blocks = so ? this.storage(so) : [para(attr(ct, 's') ? [schema.text(attr(ct, 's')!)] : [])];
      } else if (kind === 'n' || kind === 'du' || kind === 'b' || kind === 'd') {
        const v = attr(c, 'v') ?? attr(c, 'cell-date') ?? (c.textContent || '').trim();
        blocks = [para(v ? [schema.text(v)] : [], { align: kind === 'n' ? 'right' : null })];
      } else blocks = [para()];
      const cs = parseInt(attr(c, 'col-span') || '1', 10) || 1;
      const rs = parseInt(attr(c, 'row-span') || '1', 10) || 1;
      row.push({ blocks, colspan: cs, rowspan: rs });
      used += cs;
      if (used % cols === 0 || used % cols < cs - 1) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);
    void nrows;
    const hr = parseInt(attr(model, 'num-header-rows') || '0', 10) || 0;
    return makeTable(rows, { headerRows: hr });
  }
}

// =============================================================================================
// Pages 5+ (IWA)

const T_STORAGE = 2001, T_CHAR_STYLE = 2021, T_PARA_STYLE = 2022, T_LIST_STYLE = 2023, T_DRAWABLE_ATTACHMENT = 2003;
const T_TABLE_INFO = 6000, T_TABLE_MODEL = 6001, T_TILE = 6002, T_DATALIST = 6005, T_IMAGE = 3005;

class IwaReader {
  settings = newSettings();
  objects = new Map<number, IwaObject>();
  dataFiles = new Map<number, string>();

  constructor(objs: IwaObject[], private files: Files) {
    for (const o of objs) if (!this.objects.has(o.id)) this.objects.set(o.id, o);
    // Package metadata maps data identifiers to files under Data/.
    for (const o of objs) {
      for (const d of o.msg.msgs(3)) {
        const id = d.int(1), name = d.str(3) || d.str(2);
        if (id != null && name && /\.\w{2,5}$/.test(name)) this.dataFiles.set(id, name);
      }
    }
  }

  private obj(id: number | null, type?: number): IwaObject | null {
    if (id == null) return null;
    const o = this.objects.get(id);
    return o && (type == null || o.type === type) ? o : null;
  }

  private styleChain(id: number | null): Pb[] {
    const out: Pb[] = [];
    for (let o = this.obj(id), d = 0; o && d < 20; d++) {
      out.push(o.msg);
      o = this.obj(o.msg.msg(1)?.ref(3) ?? null);
    }
    return out;
  }

  private charProps(chain: Pb[]): CharProps {
    const get = <T>(f: (p: Pb) => T | null): T | null => { for (const s of chain) { const cp = s.msg(11); if (cp) { const v = f(cp); if (v != null) return v; } } return null; };
    const color = get((cp) => { const c = cp.msg(7); if (!c) return null; const ch = (n: number) => Math.round(Math.max(0, Math.min(1, c.float(n) ?? 0)) * 255).toString(16).padStart(2, '0'); return '#' + ch(3) + ch(4) + ch(5); });
    const sup = get((cp) => cp.int(10));
    const caps = get((cp) => cp.int(13));
    const fontName = get((cp) => cp.str(5));
    return {
      bold: !!get((cp) => cp.bool(1)) || /-(Bold|Black|Heavy)/.test(fontName || ''), italic: !!get((cp) => cp.bool(2)) || /(Italic|Oblique)$/.test(fontName || ''),
      size: get((cp) => cp.float(3)), font: familyFromPostScript(fontName), color,
      underline: (get((cp) => cp.int(11)) || 0) > 0, strike: (get((cp) => cp.int(12)) || 0) > 0,
      sup: sup === 1, sub: sup === 2, allcaps: caps === 1, smallcaps: caps === 2,
    };
  }

  private paraStyle(id: number | null): { name: string; attrs: Record<string, any>; char: CharProps; listStyle: number | null } {
    const chain = this.styleChain(id);
    const name = styleNameMap(chain.map((s) => s.msg(1)?.str(1)).find(Boolean) || null) || 'Normal';
    const pget = <T>(f: (p: Pb) => T | null): T | null => { for (const s of chain) { const pp = s.msg(12); if (pp) { const v = f(pp); if (v != null) return v; } } return null; };
    const al = pget((pp) => pp.int(1));
    return {
      name,
      attrs: paraAttrs({ align: al != null ? ALIGN[al] : null, spaceBefore: pget((pp) => pp.float(19)), spaceAfter: pget((pp) => pp.float(20)), keepNext: pget((pp) => pp.bool(10)) === true }),
      char: this.charProps(chain),
      listStyle: pget((pp) => pp.ref(40)),
    };
  }

  private listKind(listStyleId: number | null, level: number): { ordered: boolean; format: string } | null {
    const ls = this.obj(listStyleId, T_LIST_STYLE);
    if (!ls) return null;
    const types = ls.msg.ints(11);
    const t = types[Math.min(level, types.length - 1)] ?? 0;
    if (!t) return null;
    if (t === 3) return { ordered: true, format: 'decimal' };
    const bullets = ls.msg.strs(15);
    const b = bullets[Math.min(level, bullets.length - 1)] || '•';
    return { ordered: false, format: b === '•' ? 'disc' : b };
  }

  private table(attachmentId: number | null): PMNode | null {
    const att = this.obj(attachmentId, T_DRAWABLE_ATTACHMENT);
    const info = this.obj(att?.msg.ref(1) ?? null);
    if (!info) return null;
    if (info.type === T_IMAGE) return null;
    if (info.type !== T_TABLE_INFO) return null;
    const model = this.obj(info.msg.ref(2), T_TABLE_MODEL);
    if (!model) return null;
    const nrows = model.msg.int(6) || 0, ncols = model.msg.int(7) || 0;
    if (!nrows || !ncols || nrows * ncols > 100000) return null;
    const store = model.msg.msg(4);
    const strings = new Map<number, string>();
    const sl = this.obj(store?.ref(4) ?? null, T_DATALIST);
    for (const e of sl?.msg.msgs(3) || []) { const k = e.int(1); const s = e.str(3); if (k != null && s != null) strings.set(k, s); }
    const grid: string[][] = Array.from({ length: nrows }, () => Array.from({ length: ncols }, () => ''));
    for (const t of store?.msg(3)?.msgs(1) || []) {
      const tile = this.obj(t.ref(2), T_TILE);
      const base = t.int(1) || 0;
      for (const r of tile?.msg.msgs(5) || []) {
        const row = base + (r.int(1) || 0);
        const buf = r.fields.find((f) => f.n === 3 && f.wire === 2)?.v as Uint8Array | undefined;
        const offs = r.fields.find((f) => f.n === 4 && f.wire === 2)?.v as Uint8Array | undefined;
        if (!buf || !offs || row >= nrows) continue;
        for (let c = 0; c < ncols && c * 2 + 1 < offs.length; c++) {
          const off = offs[c * 2] | (offs[c * 2 + 1] << 8);
          if (off === 0xffff || off + 12 > buf.length) continue;
          grid[row][c] = cellText(buf, off, strings);
        }
      }
    }
    const rows: CellSpec[][] = grid.map((r) => r.map((v) => ({ blocks: [para(v ? [schema.text(v)] : [])] })));
    return makeTable(rows, { headerRows: model.msg.int(9) ?? 0 });
  }

  private image(attachmentId: number | null): PMNode | null {
    const att = this.obj(attachmentId, T_DRAWABLE_ATTACHMENT);
    const img = this.obj(att?.msg.ref(1) ?? null, T_IMAGE);
    if (!img) return null;
    for (const f of [11, 13, 15, 12]) {
      const dataId = img.msg.msg(f)?.int(1);
      const name = dataId != null ? this.dataFiles.get(dataId) : null;
      if (!name) continue;
      const path = [...this.files.keys()].find((p) => p.endsWith('Data/' + name) || p.endsWith('/' + name));
      const bytes = path ? this.files.get(path) : null;
      if (!bytes) continue;
      const geo = img.msg.msg(1)?.msg(1);
      const size = geo?.msg(2);
      return S.image.create({ src: toDataUrl(bytes, sniffImageMime(bytes) || mimeForName(name)), width: size?.float(1) ?? null, height: size?.float(2) ?? null });
    }
    return null;
  }

  read(): PMNode {
    const storages = [...this.objects.values()].filter((o) => o.type === T_STORAGE);
    const body = storages.filter((s) => (s.msg.int(1) ?? 3) === 0).sort((a, b) => b.msg.strs(3).join('').length - a.msg.strs(3).join('').length)[0];
    if (!body) throw new Error('No body text found in this Pages document');
    const text = body.msg.strs(3).join('');
    const table = (n: number) => (body.msg.msg(n)?.msgs(1) || []).map((e) => ({ at: e.int(1) ?? 0, ref: e.msg(2)?.int(1) ?? null, a: e.int(2), b: e.int(3) })).sort((x, y) => x.at - y.at);
    const paraStyles = table(5), paraData = table(6), charStyles = table(8), attachments = table(9);
    const at = <T extends { at: number }>(list: T[], pos: number): T | null => { let r: T | null = null; for (const e of list) { if (e.at <= pos) r = e; else break; } return r; };
    const styleAt = (pos: number) => { let r: number | null = null; for (const e of paraStyles) { if (e.at > pos) break; if (e.ref != null) r = e.ref; } return r; };
    const used = new Map<string, { attrs: Record<string, any>; char: CharProps }>();
    const blocks: PMNode[] = [];
    let run: FlatListItem[] = [];
    const flushList = () => { if (run.length) { blocks.push(...buildNestedLists(run)); run = []; } };
    let start = 0;
    const paras = text.split(/(\n|\u2029)/);
    for (let k = 0; k < paras.length; k += 2) {
      const seg = paras[k];
      const ps = this.paraStyle(styleAt(start));
      used.set(ps.name, ps);
      const buf = new InlineBuf();
      const after: PMNode[] = [];
      let i = 0;
      while (i < seg.length) {
        const pos = start + i;
        const cs = at(charStyles, pos);
        const span = cs?.ref != null ? this.charProps(this.styleChain(cs.ref)) : {};
        const props: CharProps = { ...ps.char };
        for (const [kk, v] of Object.entries(span)) if (v) (props as any)[kk] = v;
        // Run until the next character-style change or special character.
        let j = i;
        const nextChange = charStyles.find((e) => e.at > pos)?.at ?? Infinity;
        while (j < seg.length && start + j < nextChange && !/[\ufffc\u2028\u000b\u000c\u0004\u0005]/.test(seg[j])) j++;
        if (j > i) { buf.text(seg.slice(i, j), charMarks(props)); i = j; continue; }
        const ch = seg[i];
        if (ch === '\u2028' || ch === '\u000b') buf.node(S.hard_break.create());
        else if (ch === '\u000c') after.push(S.page_break.create());
        else if (ch === '\u0004') after.push(S.section_break.create({ kind: 'nextPage' }));
        else if (ch === '\u0005') after.push(S.column_break.create());
        else if (ch === '\ufffc') {
          const a = attachments.find((e) => e.at === pos);
          const img = a ? this.image(a.ref) : null;
          if (img) buf.node(img);
          else { const t = a ? this.table(a.ref) : null; if (t) after.push(t); }
        }
        i++;
      }
      const pd = at(paraData, start);
      const level = pd?.a ?? 0;
      const lk = this.listKind(ps.listStyle, level);
      const node = S.paragraph.create({ ...ps.attrs, style: ps.name }, buf.take());
      if (lk) run.push({ level, ...lk, blocks: [node] });
      else { flushList(); blocks.push(node); }
      if (after.length) { flushList(); blocks.push(...after); }
      start += seg.length + 1;
    }
    flushList();
    // Trailing empty paragraph from the final separator.
    while (blocks.length > 1 && blocks[blocks.length - 1].type === S.paragraph && !blocks[blocks.length - 1].content.size) blocks.pop();
    for (const [name, st] of used) {
      if (this.settings.styles[name]) continue;
      const def: StyleDef = { name, type: 'paragraph' };
      if (st.char.font) def.font = st.char.font;
      if (st.char.size) def.size = st.char.size;
      if (st.char.bold) def.bold = true;
      if (st.char.italic) def.italic = true;
      if (st.char.color && st.char.color !== '#000000') def.color = st.char.color;
      for (const k of ['align', 'spaceBefore', 'spaceAfter', 'keepNext'] as const) if (st.attrs[k] != null) (def as any)[k] = st.attrs[k];
      this.settings.styles = { ...this.settings.styles, [name]: def };
    }
    const normal = this.settings.styles.Normal;
    if (normal?.font) this.settings.theme = { ...this.settings.theme, bodyFont: normal.font, headingFont: normal.font };
    return finishDoc(normalizeImportedFormatting(blocks, this.settings, normal?.font || null), this.settings);
  }
}

/** Text of a table cell in the tile storage (cell record format version 4). */
function cellText(buf: Uint8Array, off: number, strings: Map<number, string>): string {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = buf[off + 1];
  const flags = dv.getUint32(off + 4, true);
  let p = off + 12;
  let num: number | null = null, sid: number | null = null;
  const take = (bit: number, size: number, fn?: () => void) => { if (flags & bit) { if (fn) fn(); p += size; } };
  take(0x02, 4); take(0x04, 4); take(0x08, 4);
  take(0x10, 4, () => { sid = dv.getUint32(p, true); });
  take(0x20, 8, () => { num = dv.getFloat64(p, true); });
  if (sid != null && strings.has(sid)) return strings.get(sid)!;
  if (type === 2 && num != null) return String(Math.round((num as number) * 1e10) / 1e10);
  if (type === 6 && num != null) return num ? 'TRUE' : 'FALSE';
  return '';
}

// =============================================================================================
// Entry point

function previewDoc(files: Files, why: string): PMNode {
  const settings = newSettings();
  const blocks: PMNode[] = [para([schema.text(why)], { style: 'Quote' })];
  const prev = [...files.keys()].find((p) => /(^|\/)preview\.jpg$/i.test(p)) || [...files.keys()].find((p) => /QuickLook\/Thumbnail\.jpg$/i.test(p)) || [...files.keys()].find((p) => /preview-web\.jpg$/i.test(p));
  if (prev) {
    const b = files.get(prev)!;
    blocks.push(para([S.image.create({ src: toDataUrl(b, sniffImageMime(b) || 'image/jpeg'), alt: 'Document preview', width: 450 })], { align: 'center' }));
  }
  return finishDoc(blocks, settings);
}

export async function importPages(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const u8 = new Uint8Array(data);
  const files: Files = new Map();
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const zip = await loadZip(data);
    const tasks: Promise<void>[] = [];
    zip.forEach((p, f) => { if (!f.dir) tasks.push(f.async('uint8array').then((b) => { files.set(p.replace(/^[^/]+\.pages\//, ''), b); })); });
    await Promise.all(tasks);
    // Pages 5.0–5.2 kept the IWA files in a nested Index.zip.
    const nested = files.get('Index.zip');
    if (nested) {
      const inner = await loadZip(nested);
      const t2: Promise<void>[] = [];
      inner.forEach((p, f) => { if (!f.dir) t2.push(f.async('uint8array').then((b) => { files.set(p.startsWith('Index/') ? p : 'Index/' + p, b); })); });
      await Promise.all(t2);
    }
  } else if (u8[0] === 0x1f && u8[1] === 0x8b) files.set('index.xml', gunzip(u8));
  else files.set('index.xml', u8);

  const xml = files.get('index.xml') || (files.get('index.xml.gz') ? gunzip(files.get('index.xml.gz')!) : null);
  if (xml) {
    const d = parseXml(decodeXml(xml));
    const root = d?.documentElement;
    if (root && root.localName === 'document') return new Pages09Reader(root, files).read();
    return previewDoc(files, "This Pages document's text could not be read. The preview image saved in the document is shown instead.");
  }
  const iwaFiles = [...files.keys()].filter((p) => /\.iwa$/i.test(p));
  if (!iwaFiles.length) return previewDoc(files, 'This Pages document has no readable text. The preview image saved in the document is shown instead.');
  const objs: IwaObject[] = [];
  let failed = 0;
  for (const p of iwaFiles) {
    try { objs.push(...iwaObjects(iwaDecompress(files.get(p)!), p)); } catch { failed++; }
  }
  if (files.has('.iwph') || (failed && failed === iwaFiles.length)) {
    return previewDoc(files, 'This Pages document is password-protected, so its text cannot be read here. The preview image saved in the document is shown instead; open it in Pages to remove the password.');
  }
  try {
    return new IwaReader(objs, files).read();
  } catch (e) {
    return previewDoc(files, `The text of this Pages document could not be read (${e instanceof Error ? e.message : String(e)}). The preview image saved in the document is shown instead.`);
  }
}
