/**
 * Anne's Pen document schema.
 *
 * Design notes
 * - One `paragraph` node carries a `style` attribute (Normal, Heading 1..9, Title, Quote...).
 *   Outline level, numbering and appearance derive from the style, which keeps the
 *   style system, DOCX mapping and navigation pane uniform.
 * - Paragraph spacing is rendered with padding (not margin) so that space-before and
 *   space-after add up the way desktop word processors do, and so block heights can be
 *   summed exactly by the pagination plugin.
 * - All lengths are in points (1/72 in) unless noted.
 * - Document-level settings (page setup, headers/footers, comments, sources, styles,
 *   properties...) live in the `settings` attribute of the top `doc` node so that they
 *   participate in undo/redo and serialize with the document.
 */
import { Schema, type NodeSpec, type MarkSpec, type Node as PMNode, type Mark, type DOMOutputSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { sanitizeGeneratedHtml, isScriptUrl, safeColor, safeCssValue } from '../util/sanitize';
import { cssString } from './styles';

type Attrs = Record<string, any>;

const num = (v: string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Render-time guards. Attrs reach toDOM straight from documents (.qpd JSON never goes through
// parseDOM), so every value put into a style attribute must be a single plain declaration value.
/** A CSS value with no ; : quotes, url() or comments, or ''. */
export const cssv = (v: unknown): string => safeCssValue(v) ?? '';
/** A colour (hex, rgb/hsl, named, or a var(--name) theme colour), or ''. */
export const cssColor = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return safeColor(s, '') || (/^var\(--[\w-]+\)$/.test(s) ? s : '');
};
/** A finite number, or null. */
export const cssNum = (v: unknown): number | null => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
/** A CSS keyword such as solid or lower-roman, or ''. */
const cssKw = (v: unknown): string => (/^[a-z][\w-]{0,40}$/i.test(String(v ?? '')) ? String(v) : '');
/** Space-separated keywords (font-variant-numeric etc.), or ''. */
const cssKws = (v: unknown): string => (/^[a-z][\w\s-]{0,80}$/i.test(String(v ?? '')) ? String(v).trim() : '');
const FILTER_FN = /^(blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia|drop-shadow)$/i;
/** A CSS filter list built only from filter functions with plain arguments, or ''. */
export function cssFilter(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > 300 || !/^[\w\s.,%()#+-]+$/.test(s)) return '';
  for (const m of s.matchAll(/([\w-]*)\s*\(/g)) if (!FILTER_FN.test(m[1]) && !/^(rgba?|hsla?)$/i.test(m[1])) return '';
  return s;
}
const FEATURE = /^\s*(normal|"[a-z0-9]{4}"(\s+(\d{1,3}|on|off))?(\s*,\s*"[a-z0-9]{4}"(\s+(\d{1,3}|on|off))?)*)\s*$/i;

/** Link target from a document: script and file schemes become '#'. */
export function safeHref(href: unknown): string {
  const h = String(href ?? '').trim();
  if (isScriptUrl(h)) return '#';
  const scheme = /^([a-z][\w+.-]*):/i.exec(h.replace(/[\u0000- \u007f-\u009f]+/g, ''));
  return !scheme || /^(https?|mailto|tel|ftp|sms|geo)$/i.test(scheme[1]) ? h : '#';
}

/** Image source from a document: http(s), blob, data:image/* or relative; anything else is ''. */
export function safeImageSrc(src: unknown): string {
  const u = String(src ?? '').trim();
  const scheme = /^([a-z][\w+.-]*):/i.exec(u.replace(/[\u0000- \u007f-\u009f]+/g, ''));
  if (!scheme) return u;
  const sc = scheme[1].toLowerCase();
  if (sc === 'http' || sc === 'https' || sc === 'blob' || sc === 'cid') return u;
  return sc === 'data' && /^data:image\/[\w.+-]+[;,]/i.test(u) ? u : '';
}

/** Convert a CSS length to points. Supports pt, px, in, cm, mm, em (assumes 12pt em). */
export function cssToPt(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(-?[\d.]+)\s*(pt|px|in|cm|mm|em|rem|pc)?$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2] || 'px') {
    case 'pt': return n;
    case 'px': return n * 0.75;
    case 'in': return n * 72;
    case 'cm': return (n / 2.54) * 72;
    case 'mm': return (n / 25.4) * 72;
    case 'pc': return n * 12;
    case 'em': case 'rem': return n * 12;
  }
  return null;
}

export const PARA_DEFAULTS = {
  style: 'Normal',
  align: null as string | null,
  indentLeft: null as number | null,
  indentRight: null as number | null,
  indentFirst: null as number | null,
  spaceBefore: null as number | null,
  spaceAfter: null as number | null,
  lineHeight: null as string | null, // "1.15" multiple, "14pt" exact, "atleast:14" minimum
  keepNext: false,
  keepLines: false,
  pageBreakBefore: false,
  widowControl: true,
  dir: null as string | null,
  bg: null as string | null,
  border: null as string | null, // JSON: {top,right,bottom,left} each "style width color" or css shorthand
  dropCap: 0,
  suppressLineNumbers: false,
  outlineLevel: null as number | null,
  tabs: null as string | null, // JSON array of {pos, align, leader}
  id: null as string | null,
  hidden: false,
};

export const HEADING_STYLES = ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Heading 7', 'Heading 8', 'Heading 9'];

/** Outline level 1..9 of a paragraph style, 0 for body text. */
export function styleLevel(style: string | null | undefined, outlineLevel?: number | null): number {
  if (outlineLevel) return outlineLevel;
  if (!style) return 0;
  const m = /^Heading (\d)$/.exec(style);
  if (m) return parseInt(m[1], 10);
  if (style === 'Title') return 0;
  return 0;
}

function lineHeightCss(v: string): string {
  const s = String(v);
  if (s.startsWith('atleast:')) { const n = parseFloat(s.slice(8)); return Number.isFinite(n) ? `line-height:max(${n}pt, 1.15em)` : ''; }
  const c = cssv(s);
  return c ? `line-height:${c}` : '';
}

function borderCss(v: string): string {
  try {
    const b = JSON.parse(v);
    const out: string[] = [];
    if (!b || typeof b !== 'object') throw new Error('not an object');
    for (const side of ['top', 'right', 'bottom', 'left']) if (b[side] && cssv(b[side])) out.push(`border-${side}:${cssv(b[side])}`);
    if (cssNum(b.padding) != null) out.push(`--qf-bpad:${cssNum(b.padding)}pt`);
    return out.join(';');
  } catch {
    return cssv(v) ? `border:${cssv(v)}` : '';
  }
}

export function paragraphStyleString(a: Attrs): string {
  const s: string[] = [];
  if (cssKw(a.align)) s.push(`text-align:${a.align === 'distribute' ? 'justify;text-align-last:justify' : a.align}`);
  if (cssNum(a.indentLeft) != null) s.push(`margin-left:${cssNum(a.indentLeft)}pt`);
  if (cssNum(a.indentRight) != null) s.push(`margin-right:${cssNum(a.indentRight)}pt`);
  if (cssNum(a.indentFirst) != null) s.push(`text-indent:${cssNum(a.indentFirst)}pt`);
  if (cssNum(a.spaceBefore) != null) s.push(`padding-top:${cssNum(a.spaceBefore)}pt`);
  if (cssNum(a.spaceAfter) != null) s.push(`padding-bottom:${cssNum(a.spaceAfter)}pt`);
  if (a.lineHeight) s.push(lineHeightCss(a.lineHeight));
  if (cssColor(a.bg)) s.push(`background-color:${cssColor(a.bg)}`);
  if (a.border) s.push(borderCss(String(a.border)));
  if (a.tabs) {
    try {
      const t = JSON.parse(a.tabs);
      if (Array.isArray(t) && t.length && cssNum(t[0]?.pos)) s.push(`tab-size:${cssNum(t[0].pos)}pt`);
    } catch { /* ignore */ }
  }
  return s.filter(Boolean).join(';');
}

function paraDomAttrs(node: PMNode): Attrs {
  const a = node.attrs;
  const out: Attrs = {};
  const style = paragraphStyleString(a);
  if (style) out.style = style;
  if (a.style && a.style !== 'Normal') out['data-style'] = a.style;
  if (a.dir) out.dir = a.dir;
  if (a.keepNext) out['data-keep-next'] = '1';
  if (a.keepLines) out['data-keep-lines'] = '1';
  if (a.pageBreakBefore) out['data-page-break-before'] = '1';
  if (!a.widowControl) out['data-no-widow'] = '1';
  if (a.dropCap) out['data-drop-cap'] = String(a.dropCap);
  if (a.suppressLineNumbers) out['data-no-ln'] = '1';
  if (a.outlineLevel) out['data-outline'] = String(a.outlineLevel);
  if (a.tabs) out['data-tabs'] = a.tabs;
  if (a.id) out.id = a.id;
  if (a.hidden) out['data-hidden'] = '1';
  // Tracked insertion/deletion of the paragraph mark (Compare); CSS shows a coloured pilcrow.
  if (a.change?.kind === 'insertion' || a.change?.kind === 'deletion') {
    out['data-change'] = JSON.stringify(a.change);
    out.class = a.change.kind === 'deletion' ? 'qf-pmark-del' : 'qf-pmark-ins';
  }
  return out;
}

function parseParaAttrs(dom: HTMLElement, styleFromTag?: string): Attrs {
  const st = dom.style;
  const attrs: Attrs = {};
  attrs.style = dom.getAttribute('data-style') || styleFromTag || 'Normal';
  const ta = st.textAlign;
  if (ta && ta !== 'start') attrs.align = ta === 'start' ? 'left' : ta === 'end' ? 'right' : ta;
  if (st.textAlignLast === 'justify') attrs.align = 'distribute';
  attrs.indentLeft = cssToPt(st.marginLeft) ?? cssToPt(st.paddingLeft && dom.tagName === 'P' ? null : null);
  attrs.indentRight = cssToPt(st.marginRight);
  attrs.indentFirst = cssToPt(st.textIndent);
  attrs.spaceBefore = cssToPt(st.paddingTop) ?? cssToPt(st.marginTop);
  attrs.spaceAfter = cssToPt(st.paddingBottom) ?? cssToPt(st.marginBottom);
  if (st.lineHeight && st.lineHeight !== 'normal') attrs.lineHeight = st.lineHeight;
  if (st.backgroundColor || dom.getAttribute('data-bg')) attrs.bg = st.backgroundColor || dom.getAttribute('data-bg');
  attrs.dir = dom.getAttribute('dir');
  attrs.keepNext = dom.hasAttribute('data-keep-next');
  attrs.keepLines = dom.hasAttribute('data-keep-lines');
  attrs.pageBreakBefore = dom.hasAttribute('data-page-break-before') || st.breakBefore === 'page' || st.pageBreakBefore === 'always';
  attrs.widowControl = !dom.hasAttribute('data-no-widow');
  attrs.dropCap = num(dom.getAttribute('data-drop-cap')) || 0;
  attrs.suppressLineNumbers = dom.hasAttribute('data-no-ln');
  attrs.outlineLevel = num(dom.getAttribute('data-outline'));
  attrs.tabs = dom.getAttribute('data-tabs');
  attrs.id = dom.getAttribute('id');
  attrs.hidden = dom.hasAttribute('data-hidden');
  attrs.change = blockChangeFromDom(dom);
  const bt = st.borderTop, bb = st.borderBottom, bl = st.borderLeft, br = st.borderRight;
  if (bt || bb || bl || br) {
    const b: Attrs = {};
    if (bt && !bt.startsWith('0') && !bt.includes('none')) b.top = bt;
    if (br && !br.startsWith('0') && !br.includes('none')) b.right = br;
    if (bb && !bb.startsWith('0') && !bb.includes('none')) b.bottom = bb;
    if (bl && !bl.startsWith('0') && !bl.includes('none')) b.left = bl;
    if (Object.keys(b).length) attrs.border = JSON.stringify(b);
  }
  return attrs;
}

const paraAttrSpec: Attrs = {};
for (const [k, v] of Object.entries(PARA_DEFAULTS)) paraAttrSpec[k] = { default: v };

const headingTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

const tbl = tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {
    background: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.backgroundColor || (dom as HTMLElement).getAttribute('data-bg') || null,
      setDOMAttr: (value, attrs) => { if (cssColor(value)) attrs.style = (attrs.style || '') + `background-color:${cssColor(value)};`; },
    },
    valign: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.verticalAlign || null,
      setDOMAttr: (value, attrs) => { if (cssKw(value)) attrs.style = (attrs.style || '') + `vertical-align:${value};`; },
    },
    borders: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).getAttribute('data-borders'),
      setDOMAttr: (value, attrs) => {
        if (value) {
          attrs['data-borders'] = value;
          attrs.style = (attrs.style || '') + borderCss(String(value)) + ';';
        }
      },
    },
    textDir: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).getAttribute('data-text-dir'),
      setDOMAttr: (value, attrs) => { if (value) attrs['data-text-dir'] = value; },
    },
  },
});

// Extend the table node with table-level attributes.
const tableSpec: NodeSpec = {
  ...tbl.table,
  attrs: {
    style: { default: 'Table Grid' },
    width: { default: null }, // "100%" or pt number
    align: { default: null }, // left | center | right
    indent: { default: null },
    headerRows: { default: 0 },
    banded: { default: true },
    firstCol: { default: false },
    lastRow: { default: false },
    lastCol: { default: false },
    bandedCols: { default: false },
    caption: { default: null },
    layout: { default: 'auto' }, // auto | fixed
    cellPadding: { default: null },
    borderStyle: { default: null },
  },
  parseDOM: [{
    tag: 'table',
    getAttrs: (dom) => {
      const d = dom as HTMLElement;
      return {
        style: d.getAttribute('data-style') || 'Table Grid',
        width: d.getAttribute('data-width') || (d.style.width || null),
        align: d.getAttribute('data-align'),
        headerRows: num(d.getAttribute('data-header-rows')) || 0,
        banded: d.getAttribute('data-banded') !== '0',
        firstCol: d.getAttribute('data-first-col') === '1',
        lastRow: d.getAttribute('data-last-row') === '1',
        lastCol: d.getAttribute('data-last-col') === '1',
        bandedCols: d.getAttribute('data-banded-cols') === '1',
        layout: d.style.tableLayout === 'fixed' ? 'fixed' : 'auto',
        borderStyle: d.getAttribute('data-border-style'),
      };
    },
  }],
  toDOM(node) {
    const a = node.attrs;
    const style: string[] = [];
    const w = typeof a.width === 'number' ? (cssNum(a.width) != null ? a.width + 'pt' : '') : cssv(a.width);
    if (w) style.push(`width:${w}`);
    if (a.layout === 'fixed') style.push('table-layout:fixed');
    if (a.align === 'center') style.push('margin-left:auto;margin-right:auto');
    else if (a.align === 'right') style.push('margin-left:auto;margin-right:0');
    if (cssNum(a.indent)) style.push(`margin-left:${cssNum(a.indent)}pt`);
    const attrs: Attrs = {
      'data-style': a.style,
      'data-banded': a.banded ? '1' : '0',
      class: 'qf-table',
    };
    if (a.width) attrs['data-width'] = String(a.width);
    if (a.align) attrs['data-align'] = a.align;
    if (a.headerRows) attrs['data-header-rows'] = String(a.headerRows);
    if (a.firstCol) attrs['data-first-col'] = '1';
    if (a.lastRow) attrs['data-last-row'] = '1';
    if (a.lastCol) attrs['data-last-col'] = '1';
    if (a.bandedCols) attrs['data-banded-cols'] = '1';
    if (a.borderStyle) attrs['data-border-style'] = a.borderStyle;
    if (style.length) attrs.style = style.join(';');
    return ['table', attrs, ['tbody', 0]];
  },
};

function atomAttrsFromDataset(dom: HTMLElement, keys: string[]): Attrs {
  const out: Attrs = {};
  for (const k of keys) {
    const v = dom.getAttribute('data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
    if (v != null) {
      if (v === 'true' || v === 'false') out[k] = v === 'true';
      else out[k] = v;
    }
  }
  return out;
}
function atomDataset(attrs: Attrs): Attrs {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    out['data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

// Tracked insertion or deletion of a block-level object, which cannot carry marks:
// { kind: 'insertion' | 'deletion', author, date, id } or null. Compare sets it; listChanges()
// and resolveChanges() in plugins/trackChanges.ts treat it like a revision mark.
const changeAttr = { change: { default: null } };

export function blockChangeFromDom(el: HTMLElement): Attrs | null {
  try {
    const c = JSON.parse(el.getAttribute('data-change') || 'null');
    return c && (c.kind === 'insertion' || c.kind === 'deletion') ? { kind: c.kind, author: String(c.author ?? ''), date: Number(c.date) || 0, id: String(c.id ?? '') } : null;
  } catch {
    return null;
  }
}

/** DOM attributes that show a block-level change (outlined, deletions faded). */
export function blockChangeDom(change: Attrs | null | undefined, attrs: Attrs = {}): Attrs {
  if (!change) return attrs;
  const del = change.kind === 'deletion';
  return {
    ...attrs,
    'data-change': JSON.stringify(change),
    class: [attrs.class, del ? 'qf-chg-del' : 'qf-chg-ins'].filter(Boolean).join(' '),
    title: `${del ? 'Deleted' : 'Inserted'} by ${change.author}`,
    style: [attrs.style, `outline:2px ${del ? 'dashed #c62828' : 'solid #2e7d32'};outline-offset:2px${del ? ';opacity:.5' : ''}`].filter(Boolean).join(';'),
  };
}

/** Style declarations for an image node (shared by toDOM and the image node view). */
export function imageStyle(a: Attrs, crop = false): string[] {
  const s: string[] = [];
  if (cssNum(a.width)) s.push(`width:${cssNum(a.width)}pt`);
  if (cssNum(a.height)) s.push(`height:${cssNum(a.height)}pt`);
  const tr: string[] = [];
  if (cssNum(a.rotate)) tr.push(`rotate(${cssNum(a.rotate)}deg)`);
  if (a.flipH) tr.push('scaleX(-1)');
  if (a.flipV) tr.push('scaleY(-1)');
  if (tr.length) s.push(`transform:${tr.join(' ')}`);
  if (cssv(a.border)) s.push(`border:${cssv(a.border)}`);
  if (cssFilter(a.filter)) s.push(`filter:${cssFilter(a.filter)}`);
  if (cssNum(a.opacity) != null) s.push(`opacity:${cssNum(a.opacity)}`);
  if (a.shadow) s.push('box-shadow:4px 4px 8px rgba(0,0,0,.4)');
  if (crop && a.crop) {
    try {
      const c = JSON.parse(a.crop);
      const n = (v: unknown) => cssNum(v) ?? 0;
      s.push(`clip-path:inset(${n(c.t)}% ${n(c.r)}% ${n(c.b)}% ${n(c.l)}%)`);
    } catch { /* */ }
  }
  return s;
}

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: 'block+',
    attrs: { settings: { default: {} } },
  },

  paragraph: {
    content: 'inline*',
    group: 'block',
    // `change` is kept out of PARA_DEFAULTS: it is a revision, not formatting.
    attrs: { ...paraAttrSpec, ...changeAttr },
    parseDOM: [
      { tag: 'p', getAttrs: (dom) => parseParaAttrs(dom as HTMLElement) },
      ...headingTags.map((t, i) => ({ tag: t, getAttrs: (dom: HTMLElement) => parseParaAttrs(dom, `Heading ${i + 1}`) })),
      { tag: 'blockquote', getAttrs: (dom) => parseParaAttrs(dom as HTMLElement, 'Quote') },
      { tag: 'div.qf-p', getAttrs: (dom) => parseParaAttrs(dom as HTMLElement) },
    ],
    toDOM(node): DOMOutputSpec {
      const lvl = styleLevel(node.attrs.style);
      const tag = lvl >= 1 && lvl <= 6 ? `h${lvl}` : node.attrs.style === 'Title' ? 'p' : 'p';
      return [tag, paraDomAttrs(node), 0];
    },
  },

  code_block: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    attrs: { language: { default: null }, wrap: { default: true } },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full', getAttrs: (d) => ({ language: (d as HTMLElement).getAttribute('data-language') }) }],
    toDOM: (node) => ['pre', { 'data-language': node.attrs.language, class: 'qf-code' }, ['code', 0]],
  },

  horizontal_rule: {
    group: 'block',
    attrs: { style: { default: 'solid' }, color: { default: null }, weight: { default: 1 }, ...changeAttr },
    parseDOM: [{ tag: 'hr', getAttrs: (d) => ({ style: (d as HTMLElement).getAttribute('data-hr-style') || 'solid', change: blockChangeFromDom(d as HTMLElement) }) }],
    toDOM: (node) => ['hr', blockChangeDom(node.attrs.change, { 'data-hr-style': node.attrs.style, style: `border-top-style:${cssKw(node.attrs.style) || 'solid'};border-top-width:${cssNum(node.attrs.weight) ?? 1}pt;${cssColor(node.attrs.color) ? 'border-color:' + cssColor(node.attrs.color) : ''}` })],
  },

  page_break: {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: changeAttr,
    parseDOM: [{ tag: 'div.qf-page-break', getAttrs: (d) => ({ change: blockChangeFromDom(d as HTMLElement) }) }],
    toDOM: (node) => ['div', blockChangeDom(node.attrs.change, { class: 'qf-page-break', contenteditable: 'false' }), ['span', 'Page Break']],
  },

  column_break: {
    group: 'block',
    atom: true,
    attrs: changeAttr,
    parseDOM: [{ tag: 'div.qf-column-break', getAttrs: (d) => ({ change: blockChangeFromDom(d as HTMLElement) }) }],
    toDOM: (node) => ['div', blockChangeDom(node.attrs.change, { class: 'qf-column-break', contenteditable: 'false' }), ['span', 'Column Break']],
  },

  section_break: {
    group: 'block',
    atom: true,
    attrs: { kind: { default: 'nextPage' }, page: { default: null }, ...changeAttr },
    parseDOM: [{ tag: 'div.qf-section-break', getAttrs: (d) => {
      const el = d as HTMLElement;
      let page = null;
      try { page = JSON.parse(el.getAttribute('data-page') || 'null'); } catch { /* */ }
      return { kind: el.getAttribute('data-kind') || 'nextPage', page, change: blockChangeFromDom(el) };
    } }],
    toDOM: (node) => ['div', blockChangeDom(node.attrs.change, { class: 'qf-section-break', 'data-kind': node.attrs.kind, 'data-page': node.attrs.page ? JSON.stringify(node.attrs.page) : null, contenteditable: 'false' }),
      ['span', `Section Break (${({ nextPage: 'Next Page', continuous: 'Continuous', evenPage: 'Even Page', oddPage: 'Odd Page' } as Attrs)[node.attrs.kind] || node.attrs.kind})`]],
  },

  bullet_list: {
    content: 'list_item+',
    group: 'block',
    attrs: { bullet: { default: 'disc' }, indent: { default: null } },
    parseDOM: [{ tag: 'ul:not([data-type=task])', getAttrs: (d) => ({ bullet: (d as HTMLElement).getAttribute('data-bullet') || (d as HTMLElement).style.listStyleType || 'disc' }) }],
    toDOM: (node) => {
      const b = String(node.attrs.bullet ?? 'disc');
      const known = ['disc', 'circle', 'square', 'none'];
      const style = known.includes(b) ? `list-style-type:${b}` : `list-style-type:"${cssString(b)} "`;
      return ['ul', { 'data-bullet': b, style }, 0];
    },
  },

  ordered_list: {
    content: 'list_item+',
    group: 'block',
    attrs: { order: { default: 1 }, format: { default: 'decimal' }, outline: { default: false }, suffix: { default: '.' } },
    parseDOM: [{
      tag: 'ol',
      getAttrs: (d) => {
        const el = d as HTMLElement;
        const t = el.getAttribute('type');
        const typeMap: Attrs = { a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', 1: 'decimal' };
        const start = parseInt(el.getAttribute('start') || '', 10);
        return {
          order: Number.isFinite(start) ? start : 1,
          format: el.getAttribute('data-format') || (t ? typeMap[t] : null) || el.style.listStyleType || 'decimal',
          outline: el.getAttribute('data-outline') === '1',
        };
      },
    }],
    toDOM: (node) => {
      const a = node.attrs;
      const attrs: Attrs = { 'data-format': a.format, style: `list-style-type:${a.outline ? 'none' : cssKw(a.format) || 'decimal'}` };
      const order = Number.isFinite(Number(a.order)) ? Math.trunc(Number(a.order)) : 1;
      if (order !== 1) attrs.start = order;
      if (a.outline) attrs['data-outline'] = '1';
      return ['ol', attrs, 0];
    },
  },

  list_item: {
    content: 'paragraph block*',
    defining: true,
    attrs: { checked: { default: null } },
    parseDOM: [{ tag: 'li', getAttrs: (d) => {
      const c = (d as HTMLElement).getAttribute('data-checked');
      return { checked: c == null ? null : c === 'true' };
    } }],
    toDOM: (node) => ['li', node.attrs.checked == null ? {} : { 'data-checked': String(node.attrs.checked) }, 0],
  },

  task_list: {
    content: 'task_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul[data-type=task]', priority: 60 }],
    toDOM: () => ['ul', { 'data-type': 'task', class: 'qf-tasks' }, 0],
  },

  task_item: {
    content: 'paragraph block*',
    defining: true,
    attrs: { checked: { default: false } },
    parseDOM: [{ tag: 'ul[data-type=task] > li', priority: 60, getAttrs: (d) => ({ checked: (d as HTMLElement).getAttribute('data-checked') === 'true' }) }],
    toDOM: (node) => ['li', { 'data-checked': String(node.attrs.checked), class: 'qf-task' }, 0],
  },

  // Containers -------------------------------------------------------------
  column_section: {
    content: 'block+',
    group: 'block',
    defining: true,
    attrs: { count: { default: 2 }, gap: { default: 36 }, rule: { default: false }, widths: { default: null } },
    parseDOM: [{ tag: 'div.qf-columns', getAttrs: (d) => {
      const el = d as HTMLElement;
      return { count: num(el.getAttribute('data-count')) || 2, gap: num(el.getAttribute('data-gap')) ?? 36, rule: el.getAttribute('data-rule') === '1' };
    } }],
    toDOM: (node) => ['div', {
      class: 'qf-columns',
      'data-count': node.attrs.count,
      'data-gap': node.attrs.gap,
      'data-rule': node.attrs.rule ? '1' : '0',
      style: `column-count:${cssNum(node.attrs.count) ?? 2};column-gap:${cssNum(node.attrs.gap) ?? 36}pt;${node.attrs.rule ? 'column-rule:1px solid currentColor' : ''}`,
    }, 0],
  },

  text_box: {
    content: 'block+',
    group: 'block',
    defining: true,
    attrs: {
      float: { default: 'none' }, width: { default: null }, border: { default: '1px solid #444' },
      bg: { default: null }, padding: { default: 6 }, kind: { default: 'textbox' }, rotate: { default: 0 },
      radius: { default: 0 }, shadow: { default: false },
    },
    parseDOM: [{ tag: 'aside.qf-textbox', getAttrs: (d) => {
      const el = d as HTMLElement;
      return {
        float: el.getAttribute('data-float') || 'none',
        width: el.getAttribute('data-width'),
        border: el.style.border || null,
        bg: el.style.backgroundColor || null,
        kind: el.getAttribute('data-kind') || 'textbox',
      };
    } }],
    toDOM: (node) => {
      const a = node.attrs;
      const s: string[] = [];
      if (cssv(a.border)) s.push(`border:${cssv(a.border)}`);
      if (cssColor(a.bg)) s.push(`background-color:${cssColor(a.bg)}`);
      const w = /^\d+(\.\d+)?$/.test(String(a.width)) ? a.width + 'pt' : cssv(a.width);
      if (a.width && w) s.push(`width:${w}`);
      s.push(`padding:${cssNum(a.padding) ?? 6}pt`);
      if (cssNum(a.radius)) s.push(`border-radius:${cssNum(a.radius)}pt`);
      if (a.shadow) s.push('box-shadow:3px 3px 6px rgba(0,0,0,.35)');
      if (cssNum(a.rotate)) s.push(`transform:rotate(${cssNum(a.rotate)}deg)`);
      return ['aside', { class: 'qf-textbox', 'data-float': a.float, 'data-kind': a.kind, 'data-width': a.width, style: s.join(';') }, 0];
    },
  },

  // Generated blocks (TOC, bibliography, index, table of figures, table of authorities)
  gen_block: {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: { kind: { default: 'toc' }, options: { default: {} }, cache: { default: '' }, ...changeAttr },
    parseDOM: [{ tag: 'div.qf-gen', getAttrs: (d) => {
      const el = d as HTMLElement;
      let options = {};
      try { options = JSON.parse(el.getAttribute('data-options') || '{}'); } catch { /* */ }
      const kind = el.getAttribute('data-kind') || 'toc';
      return { kind: /^[a-z]{2,16}$/.test(kind) ? kind : 'toc', options, cache: sanitizeGeneratedHtml(el.innerHTML), change: blockChangeFromDom(el) };
    } }],
    toDOM: (node) => {
      const div = document.createElement('div');
      for (const [k, v] of Object.entries(blockChangeDom(node.attrs.change, { class: 'qf-gen' }))) div.setAttribute(k, String(v));
      div.setAttribute('data-kind', node.attrs.kind);
      div.setAttribute('data-options', JSON.stringify(node.attrs.options || {}));
      div.contentEditable = 'false';
      if (node.attrs.cache) div.innerHTML = sanitizeGeneratedHtml(node.attrs.cache);
      else { const p = document.createElement('p'); p.className = 'qf-gen-empty'; p.textContent = `[${String(node.attrs.kind).toUpperCase()} — use Update to generate]`; div.appendChild(p); }
      return div;
    },
  },

  math_block: {
    group: 'block',
    atom: true,
    attrs: { latex: { default: '' }, numbered: { default: false }, ...changeAttr },
    parseDOM: [{ tag: 'div.qf-math', getAttrs: (d) => ({ latex: (d as HTMLElement).getAttribute('data-latex') || '', change: blockChangeFromDom(d as HTMLElement) }) }],
    toDOM: (node) => ['div', blockChangeDom(node.attrs.change, { class: 'qf-math', 'data-latex': node.attrs.latex, contenteditable: 'false' }), node.attrs.latex],
  },

  // Inline nodes ---------------------------------------------------------
  text: { group: 'inline' },

  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    attrs: { kind: { default: 'line' } }, // line | textWrapping
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  image: {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: {
      src: { default: '' }, alt: { default: '' }, title: { default: null },
      width: { default: null }, height: { default: null },
      wrap: { default: 'inline' }, // inline | left | right | center | behind | front | topBottom
      rotate: { default: 0 }, flipH: { default: false }, flipV: { default: false },
      border: { default: null }, filter: { default: null }, crop: { default: null },
      editKind: { default: null }, editData: { default: null }, // chart | diagram | ink | shape | signature | qr
      link: { default: null }, opacity: { default: null }, shadow: { default: false },
    },
    parseDOM: [{
      tag: 'img[src]',
      getAttrs: (d) => {
        const el = d as HTMLImageElement;
        return {
          src: el.getAttribute('src'), alt: el.getAttribute('alt') || '', title: el.getAttribute('title'),
          width: num(el.getAttribute('data-w')) ?? cssToPt(el.style.width) ?? (el.getAttribute('width') ? num(el.getAttribute('width'))! * 0.75 : null),
          height: num(el.getAttribute('data-h')) ?? cssToPt(el.style.height) ?? (el.getAttribute('height') ? num(el.getAttribute('height'))! * 0.75 : null),
          wrap: el.getAttribute('data-wrap') || (el.style.cssFloat === 'left' ? 'left' : el.style.cssFloat === 'right' ? 'right' : 'inline'),
          rotate: num(el.getAttribute('data-rotate')) || 0,
          editKind: el.getAttribute('data-edit-kind'),
          editData: el.getAttribute('data-edit-data'),
          filter: el.getAttribute('data-filter'),
          border: el.getAttribute('data-border'),
        };
      },
    }],
    toDOM: (node) => {
      const a = node.attrs;
      const s = imageStyle(a);
      if (!cssNum(a.height)) s.splice(cssNum(a.width) ? 1 : 0, 0, 'height:auto');
      const attrs: Attrs = { src: safeImageSrc(a.src), alt: a.alt, style: s.join(';'), 'data-wrap': a.wrap, class: 'qf-img' };
      if (a.title) attrs.title = a.title;
      if (a.width) attrs['data-w'] = a.width;
      if (a.height) attrs['data-h'] = a.height;
      if (a.rotate) attrs['data-rotate'] = a.rotate;
      if (a.editKind) attrs['data-edit-kind'] = a.editKind;
      if (a.editData) attrs['data-edit-data'] = a.editData;
      if (a.filter) attrs['data-filter'] = a.filter;
      if (a.border) attrs['data-border'] = a.border;
      return ['img', attrs];
    },
  },

  footnote: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { text: { default: '' }, kind: { default: 'foot' }, id: { default: '' }, mark: { default: null } },
    parseDOM: [{ tag: 'sup.qf-fn', getAttrs: (d) => ({
      text: (d as HTMLElement).getAttribute('data-text') || '',
      kind: (d as HTMLElement).getAttribute('data-kind') || 'foot',
      id: (d as HTMLElement).getAttribute('data-id') || '',
      mark: (d as HTMLElement).getAttribute('data-mark'),
    }) }],
    toDOM: (node) => ['sup', { class: 'qf-fn', 'data-text': node.attrs.text, 'data-kind': node.attrs.kind, 'data-id': node.attrs.id, 'data-mark': node.attrs.mark, contenteditable: 'false' }, node.attrs.mark || '*'],
  },

  field: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { type: { default: 'DATE' }, format: { default: null }, arg: { default: null }, value: { default: '' }, locked: { default: false } },
    parseDOM: [{ tag: 'span.qf-field', getAttrs: (d) => ({ ...atomAttrsFromDataset(d as HTMLElement, ['type', 'format', 'arg']), value: (d as HTMLElement).textContent || '' }) }],
    toDOM: (node) => ['span', { class: 'qf-field', ...atomDataset({ type: node.attrs.type, format: node.attrs.format, arg: node.attrs.arg }), contenteditable: 'false' }, node.attrs.value || `{${node.attrs.type}}`],
  },

  math_inline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { latex: { default: '' } },
    parseDOM: [{ tag: 'span.qf-math-inline', getAttrs: (d) => ({ latex: (d as HTMLElement).getAttribute('data-latex') || '' }) }],
    toDOM: (node) => ['span', { class: 'qf-math-inline', 'data-latex': node.attrs.latex, contenteditable: 'false' }, node.attrs.latex],
  },

  citation: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { sources: { default: '' }, page: { default: null }, cache: { default: '' } },
    parseDOM: [{ tag: 'span.qf-cite', getAttrs: (d) => ({ sources: (d as HTMLElement).getAttribute('data-sources') || '', page: (d as HTMLElement).getAttribute('data-page'), cache: (d as HTMLElement).textContent || '' }) }],
    toDOM: (node) => ['span', { class: 'qf-cite', 'data-sources': node.attrs.sources, 'data-page': node.attrs.page, contenteditable: 'false' }, node.attrs.cache || '(citation)'],
  },

  bookmark: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { name: { default: '' } },
    parseDOM: [{ tag: 'a.qf-bookmark', getAttrs: (d) => ({ name: (d as HTMLElement).getAttribute('data-name') || (d as HTMLElement).id }) }],
    toDOM: (node) => ['a', { class: 'qf-bookmark', id: 'bm-' + node.attrs.name, 'data-name': node.attrs.name, contenteditable: 'false' }],
  },

  index_entry: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { term: { default: '' }, sub: { default: null }, see: { default: null }, bold: { default: false }, italic: { default: false }, kind: { default: 'index' } },
    parseDOM: [{ tag: 'span.qf-xe', getAttrs: (d) => atomAttrsFromDataset(d as HTMLElement, ['term', 'sub', 'see', 'kind']) }],
    toDOM: (node) => ['span', { class: 'qf-xe', ...atomDataset({ term: node.attrs.term, sub: node.attrs.sub, see: node.attrs.see, kind: node.attrs.kind }), contenteditable: 'false' }, `{XE "${node.attrs.term}${node.attrs.sub ? ':' + node.attrs.sub : ''}"}`],
  },

  control: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { kind: { default: 'checkbox' }, value: { default: '' }, options: { default: '' }, label: { default: '' }, tag: { default: '' }, locked: { default: false } },
    parseDOM: [{ tag: 'span.qf-control', getAttrs: (d) => atomAttrsFromDataset(d as HTMLElement, ['kind', 'value', 'options', 'label', 'tag']) }],
    toDOM: (node) => {
      const a = node.attrs;
      let text = a.value || a.label || 'Click to enter text';
      if (a.kind === 'checkbox') text = a.value === 'true' ? '☒' : '☐';
      if (a.kind === 'dropdown' || a.kind === 'combo') text = (a.value || a.label || 'Choose an item') + ' ▾';
      if (a.kind === 'date') text = a.value || 'Pick a date';
      return ['span', { class: 'qf-control', ...atomDataset({ kind: a.kind, value: a.value, options: a.options, label: a.label, tag: a.tag }), contenteditable: 'false' }, text];
    },
  },

  chip: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { kind: { default: 'person' }, label: { default: '' }, value: { default: '' } },
    parseDOM: [{ tag: 'span.qf-chip', getAttrs: (d) => atomAttrsFromDataset(d as HTMLElement, ['kind', 'label', 'value']) }],
    toDOM: (node) => ['span', { class: 'qf-chip', ...atomDataset(node.attrs), contenteditable: 'false' }, node.attrs.label],
  },

  symbol: {
    // Special characters that must survive round-trips as distinct objects (e.g. optional hyphen).
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { kind: { default: 'optionalHyphen' } },
    parseDOM: [{ tag: 'span.qf-sym', getAttrs: (d) => ({ kind: (d as HTMLElement).getAttribute('data-kind') || 'optionalHyphen' }) }],
    toDOM: (node) => ['span', { class: 'qf-sym', 'data-kind': node.attrs.kind, contenteditable: 'false' }, node.attrs.kind === 'optionalHyphen' ? '­' : ''],
  },
};

nodes.table = tableSpec;
nodes.table_row = tbl.table_row;
nodes.table_cell = tbl.table_cell;
nodes.table_header = tbl.table_header;

// Marks -----------------------------------------------------------------
function simpleMark(tag: string, extra: Partial<MarkSpec> = {}, parse: MarkSpec['parseDOM'] = [{ tag }]): MarkSpec {
  return { parseDOM: parse, toDOM: () => [tag, 0], ...extra };
}

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: { default: '' }, title: { default: null }, target: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (d) => {
      const href = (d as HTMLElement).getAttribute('href') || '';
      return isScriptUrl(href) ? false : { href, title: (d as HTMLElement).getAttribute('title') };
    } }],
    toDOM: (m) => ['a', { href: safeHref(m.attrs.href), title: m.attrs.title, rel: 'noopener noreferrer' }, 0],
  },
  bold: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (n) => (n as HTMLElement).style.fontWeight !== 'normal' && null },
      { style: 'font-weight=400', clearMark: (m) => m.type.name === 'bold' },
      { style: 'font-weight', getAttrs: (v) => /^(bold(er)?|[6-9]\d{2,})$/.test(v as string) && null },
    ],
    toDOM: () => ['strong', 0],
  },
  italic: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }, { style: 'font-style=normal', clearMark: (m) => m.type.name === 'italic' }],
    toDOM: () => ['em', 0],
  },
  underline: {
    attrs: { style: { default: 'single' }, color: { default: null } },
    parseDOM: [
      { tag: 'u', getAttrs: (d) => ({ style: (d as HTMLElement).getAttribute('data-u') || 'single' }) },
      { style: 'text-decoration-line', getAttrs: (v) => ((v as string).includes('underline') ? {} : false) },
      { style: 'text-decoration', getAttrs: (v) => ((v as string).includes('underline') ? {} : false) },
    ],
    toDOM: (m) => {
      const map: Attrs = { single: 'solid', double: 'double', dotted: 'dotted', dashed: 'dashed', wavy: 'wavy', thick: 'solid', words: 'solid', dotDash: 'dashed', dotDotDash: 'dotted' };
      const s = [`text-decoration-style:${map[m.attrs.style] || 'solid'}`];
      if (m.attrs.style === 'thick') s.push('text-decoration-thickness:2.5px');
      if (m.attrs.style === 'words') s.push('text-decoration-skip-ink:auto');
      if (cssColor(m.attrs.color)) s.push(`text-decoration-color:${cssColor(m.attrs.color)}`);
      return ['u', { 'data-u': m.attrs.style, style: s.join(';') }, 0];
    },
  },
  strike: simpleMark('s', {}, [{ tag: 's' }, { tag: 'del:not(.qf-del)' }, { tag: 'strike' }, { style: 'text-decoration-line', getAttrs: (v) => ((v as string).includes('line-through') ? {} : false) }]),
  dstrike: {
    parseDOM: [{ tag: 'span.qf-dstrike' }],
    toDOM: () => ['span', { class: 'qf-dstrike' }, 0],
  },
  sup: { excludes: 'sub', parseDOM: [{ tag: 'sup:not(.qf-fn)' }, { style: 'vertical-align=super' }], toDOM: () => ['sup', 0] },
  sub: { excludes: 'sup', parseDOM: [{ tag: 'sub' }, { style: 'vertical-align=sub' }], toDOM: () => ['sub', 0] },
  smallcaps: { parseDOM: [{ style: 'font-variant=small-caps' }, { style: 'font-variant-caps=small-caps' }], toDOM: () => ['span', { style: 'font-variant-caps:small-caps' }, 0] },
  allcaps: { parseDOM: [{ style: 'text-transform=uppercase' }], toDOM: () => ['span', { style: 'text-transform:uppercase' }, 0] },
  hidden: { parseDOM: [{ tag: 'span.qf-hidden' }], toDOM: () => ['span', { class: 'qf-hidden' }, 0] },
  code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  font: {
    attrs: { family: {} },
    parseDOM: [{ style: 'font-family', getAttrs: (v) => ({ family: (v as string).split(',')[0].replace(/["']/g, '').trim() }) }],
    toDOM: (m) => ['span', { style: `font-family:"${cssString(m.attrs.family)}"` }, 0],
  },
  size: {
    attrs: { pt: {} },
    parseDOM: [{ style: 'font-size', getAttrs: (v) => { const p = cssToPt(v as string); return p ? { pt: Math.round(p * 2) / 2 } : false; } }],
    toDOM: (m) => ['span', { style: cssNum(m.attrs.pt) ? `font-size:${cssNum(m.attrs.pt)}pt` : null }, 0],
  },
  color: {
    attrs: { color: {} },
    parseDOM: [{ style: 'color', getAttrs: (v) => ({ color: v }) }],
    toDOM: (m) => ['span', { style: cssColor(m.attrs.color) ? `color:${cssColor(m.attrs.color)}` : null }, 0],
  },
  highlight: {
    attrs: { color: { default: '#ffff00' } },
    parseDOM: [{ tag: 'mark', getAttrs: (d) => ({ color: (d as HTMLElement).style.backgroundColor || '#ffff00' }) }, { style: 'background-color', getAttrs: (v) => (v && v !== 'transparent' && v !== 'inherit' ? { color: v } : false) }],
    toDOM: (m) => ['mark', { style: `background-color:${cssColor(m.attrs.color) || '#ffff00'}` }, 0],
  },
  shading: {
    attrs: { color: {} },
    parseDOM: [{ tag: 'span.qf-shade', getAttrs: (d) => ({ color: (d as HTMLElement).style.backgroundColor }) }],
    toDOM: (m) => ['span', { class: 'qf-shade', style: cssColor(m.attrs.color) ? `background-color:${cssColor(m.attrs.color)}` : null }, 0],
  },
  charBorder: {
    attrs: { border: { default: '1px solid currentColor' } },
    parseDOM: [{ tag: 'span.qf-cborder', getAttrs: (d) => ({ border: (d as HTMLElement).style.border }) }],
    toDOM: (m) => ['span', { class: 'qf-cborder', style: `border:${cssv(m.attrs.border) || '1px solid currentColor'};padding:0 1px` }, 0],
  },
  spacing: {
    attrs: { pt: {} },
    parseDOM: [{ style: 'letter-spacing', getAttrs: (v) => { const p = cssToPt(v as string); return p != null ? { pt: p } : false; } }],
    toDOM: (m) => ['span', { style: cssNum(m.attrs.pt) != null ? `letter-spacing:${cssNum(m.attrs.pt)}pt` : null }, 0],
  },
  scale: {
    attrs: { pct: { default: 100 } },
    parseDOM: [{ tag: 'span.qf-scale', getAttrs: (d) => ({ pct: num((d as HTMLElement).getAttribute('data-pct')) || 100 }) }],
    toDOM: (m) => ['span', { class: 'qf-scale', 'data-pct': m.attrs.pct, style: `display:inline-block;transform:scaleX(${(cssNum(m.attrs.pct) ?? 100) / 100});transform-origin:left` }, 0],
  },
  position: {
    attrs: { pt: {} },
    parseDOM: [{ tag: 'span.qf-pos', getAttrs: (d) => ({ pt: num((d as HTMLElement).getAttribute('data-pt')) || 0 }) }],
    toDOM: (m) => ['span', { class: 'qf-pos', 'data-pt': m.attrs.pt, style: `position:relative;top:${-(cssNum(m.attrs.pt) ?? 0)}pt` }, 0],
  },
  typo: {
    // OpenType / typographic features: ligatures, numerals, kerning, stylistic sets.
    attrs: { features: { default: '' }, kerning: { default: null }, numerals: { default: null }, ligatures: { default: null } },
    parseDOM: [{ tag: 'span.qf-typo', getAttrs: (d) => ({
      features: (d as HTMLElement).getAttribute('data-features') || '',
      kerning: (d as HTMLElement).getAttribute('data-kerning'),
      numerals: (d as HTMLElement).getAttribute('data-numerals'),
      ligatures: (d as HTMLElement).getAttribute('data-ligatures'),
    }) }],
    toDOM: (m) => {
      const a = m.attrs;
      const s: string[] = [];
      if (a.features && FEATURE.test(String(a.features))) s.push(`font-feature-settings:${String(a.features).trim()}`);
      if (cssKw(a.kerning)) s.push(`font-kerning:${a.kerning}`);
      if (cssKws(a.numerals)) s.push(`font-variant-numeric:${cssKws(a.numerals)}`);
      if (cssKws(a.ligatures)) s.push(`font-variant-ligatures:${cssKws(a.ligatures)}`);
      return ['span', { class: 'qf-typo', 'data-features': a.features, 'data-kerning': a.kerning, 'data-numerals': a.numerals, 'data-ligatures': a.ligatures, style: s.join(';') }, 0];
    },
  },
  effect: {
    // Text effects: outline, shadow, emboss, engrave, glow, reflection, gradient fill.
    attrs: { kind: { default: 'shadow' }, color: { default: null } },
    parseDOM: [{ tag: 'span.qf-fx', getAttrs: (d) => ({ kind: (d as HTMLElement).getAttribute('data-kind') || 'shadow', color: (d as HTMLElement).getAttribute('data-color') }) }],
    toDOM: (m) => ['span', { class: `qf-fx qf-fx-${cssKw(m.attrs.kind) || 'shadow'}`, 'data-kind': m.attrs.kind, 'data-color': m.attrs.color, style: cssColor(m.attrs.color) ? `--fx:${cssColor(m.attrs.color)}` : null }, 0],
  },
  charStyle: {
    attrs: { name: {} },
    parseDOM: [{ tag: 'span[data-cstyle]', getAttrs: (d) => ({ name: (d as HTMLElement).getAttribute('data-cstyle') }) }],
    toDOM: (m) => ['span', { 'data-cstyle': m.attrs.name }, 0],
  },
  lang: {
    attrs: { lang: {}, noProof: { default: false } },
    parseDOM: [{ tag: 'span[lang]', getAttrs: (d) => ({ lang: (d as HTMLElement).getAttribute('lang'), noProof: (d as HTMLElement).getAttribute('spellcheck') === 'false' }) }],
    toDOM: (m) => ['span', { lang: m.attrs.lang, spellcheck: m.attrs.noProof ? 'false' : null }, 0],
  },
  dir: {
    attrs: { dir: { default: 'rtl' } },
    parseDOM: [{ tag: 'bdo', getAttrs: (d) => ({ dir: (d as HTMLElement).getAttribute('dir') || 'rtl' }) }],
    toDOM: (m) => ['bdo', { dir: m.attrs.dir }, 0],
  },
  ruby: {
    attrs: { text: { default: '' } },
    parseDOM: [{ tag: 'span.qf-ruby', getAttrs: (d) => ({ text: (d as HTMLElement).getAttribute('data-ruby') || '' }) }],
    toDOM: (m) => ['span', { class: 'qf-ruby', 'data-ruby': m.attrs.text }, 0],
  },
  comment: {
    attrs: { id: {} },
    inclusive: false,
    excludes: '',
    parseDOM: [{ tag: 'span.qf-comment', getAttrs: (d) => ({ id: (d as HTMLElement).getAttribute('data-id') }) }],
    toDOM: (m) => ['span', { class: 'qf-comment', 'data-id': m.attrs.id }, 0],
  },
  insertion: {
    attrs: { author: { default: '' }, date: { default: 0 }, id: { default: '' } },
    // Not inclusive: text typed after a tracked insertion is not part of it (tracked typing gets
    // its own mark from trackTransaction; untracked typing must stay untracked).
    inclusive: false,
    excludes: 'deletion insertion',
    parseDOM: [{ tag: 'ins', getAttrs: (d) => ({ author: (d as HTMLElement).getAttribute('data-author') || '', date: num((d as HTMLElement).getAttribute('data-date')) || 0, id: (d as HTMLElement).getAttribute('data-id') || '' }) }],
    toDOM: (m) => ['ins', { class: 'qf-ins', 'data-author': m.attrs.author, 'data-date': m.attrs.date, 'data-id': m.attrs.id, title: `Inserted by ${m.attrs.author}` }, 0],
  },
  deletion: {
    attrs: { author: { default: '' }, date: { default: 0 }, id: { default: '' } },
    inclusive: false,
    excludes: 'deletion insertion',
    parseDOM: [{ tag: 'del.qf-del', getAttrs: (d) => ({ author: (d as HTMLElement).getAttribute('data-author') || '', date: num((d as HTMLElement).getAttribute('data-date')) || 0, id: (d as HTMLElement).getAttribute('data-id') || '' }) }],
    toDOM: (m) => ['del', { class: 'qf-del', 'data-author': m.attrs.author, 'data-date': m.attrs.date, 'data-id': m.attrs.id, title: `Deleted by ${m.attrs.author}` }, 0],
  },
  formatChange: {
    attrs: { author: { default: '' }, date: { default: 0 }, id: { default: '' }, before: { default: '' } },
    inclusive: false,
    excludes: '',
    parseDOM: [{ tag: 'span.qf-fmtchg', getAttrs: (d) => ({ author: (d as HTMLElement).getAttribute('data-author') || '', id: (d as HTMLElement).getAttribute('data-id') || '' }) }],
    toDOM: (m) => ['span', { class: 'qf-fmtchg', 'data-author': m.attrs.author, 'data-id': m.attrs.id }, 0],
  },
  mergeHighlight: {
    // Transient mark for find-results etc. Never serialized in exports.
    parseDOM: [],
    toDOM: () => ['span', { class: 'qf-hl' }, 0],
  },
};

export const schema = new Schema({ nodes, marks });

export type QSchema = typeof schema;
export const N = schema.nodes;
export const M = schema.marks;

export function markIsActive(mark: Mark | undefined): boolean { return !!mark; }

/** Empty document with default settings. */
export function emptyDoc(settings: Record<string, any> = {}) {
  return schema.node('doc', { settings }, [schema.node('paragraph')]);
}
