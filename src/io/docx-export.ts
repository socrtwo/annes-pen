/**
 * DOCX (Office Open XML WordprocessingML) export.
 *
 * Builds a package with JSZip: [Content_Types].xml, _rels/.rels, word/document.xml,
 * styles.xml, numbering.xml, settings.xml, footnotes/endnotes, comments (+ commentsExtended),
 * headers/footers, media and docProps. Element order inside property containers follows the
 * ECMA-376 schema sequences, because Word rejects out-of-order children.
 *
 * Round-trip helpers understood by docx-import.ts:
 * - text boxes are written as a block content control tagged "qf:textbox:{json}" whose
 *   paragraphs carry a box border;
 * - task lists use a numbering level with numFmt "none" and a checkbox content control at the
 *   start of each item;
 * - code blocks are paragraphs styled "Code"; the `code` mark uses the "HTML Code" style.
 */
import JSZip from 'jszip';
import { TableMap } from 'prosemirror-tables';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { normalizeSettings, pageDims, type CommentData, type DocSettings, type HF, type PageSetup, type StyleDef } from '../editor/settings';
import { BUILTIN_STYLES, fontStack, resolveStyles } from '../editor/styles';
import type { ExportOptions } from './index';
import {
  ACCENT_CHARS, FUNCTION_NAMES, LATEX_SYMBOLS, NARY_CHARS, NS, REL, XML_HEADER, buildFieldInstr,
  cssBorderToOoxml, cssColorToHex, esc, exportFontName, extForMime, highlightName, imageSize, parseDataUrl, ptToTwip,
  sniffImageMime, styleIdFor, svgSize, wordStyleName, type OoxmlBorder,
} from './ooxml-util';
import { listStart } from './serialize';

const N = schema.nodes;
const M = schema.marks;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CT = {
  main: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  endnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
  comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  commentsExtended: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  fontTable: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  custom: 'application/vnd.openxmlformats-officedocument.custom-properties+xml',
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
};

const ROOT_NS = [
  `xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"`,
  `xmlns:mc="${NS.mc}"`, `xmlns:o="${NS.o}"`, `xmlns:r="${NS.r}"`, `xmlns:m="${NS.m}"`, `xmlns:v="${NS.v}"`,
  `xmlns:wp14="${NS.wp14}"`, `xmlns:wp="${NS.wp}"`, `xmlns:w10="${NS.w10}"`, `xmlns:w="${NS.w}"`,
  `xmlns:w14="${NS.w14}"`, `xmlns:w15="${NS.w15}"`, `xmlns:wps="${NS.wps}"`, `xmlns:a="${NS.a}"`, `xmlns:pic="${NS.pic}"`,
  `mc:Ignorable="w14 w15 wp14"`,
].join(' ');

const PAGE_FMT_OUT: Record<string, string> = {
  decimal: 'decimal', 'lower-roman': 'lowerRoman', 'upper-roman': 'upperRoman', 'lower-alpha': 'lowerLetter', 'upper-alpha': 'upperLetter',
  roman: 'lowerRoman', ROMAN: 'upperRoman', alphabetic: 'lowerLetter', ALPHABETIC: 'upperLetter', symbols: 'chicago', 'decimal-zero': 'decimalZero',
};
const LIST_FMT_OUT: Record<string, string> = {
  decimal: 'decimal', 'lower-alpha': 'lowerLetter', 'upper-alpha': 'upperLetter', 'lower-roman': 'lowerRoman', 'upper-roman': 'upperRoman',
  'decimal-zero': 'decimalZero', 'lower-latin': 'lowerLetter', 'upper-latin': 'upperLetter',
};
const UNDERLINE_OUT: Record<string, string> = {
  single: 'single', double: 'double', dotted: 'dotted', dashed: 'dash', wavy: 'wave', thick: 'thick', words: 'words',
  dotDash: 'dotDash', dotDotDash: 'dotDotDash',
};
const BULLETS: Record<string, { text: string; font: string | null }> = {
  disc: { text: '', font: 'Symbol' },
  circle: { text: 'o', font: 'Courier New' },
  square: { text: '', font: 'Wingdings' },
};

// ------------------------------------------------------------------------------------------
// Property models (written in schema order)

interface ParaProps {
  styleId?: string; keepNext?: boolean; keepLines?: boolean; pageBreakBefore?: boolean; framePr?: string;
  widowControl?: boolean; numPr?: { numId: number; ilvl: number }; suppressLineNumbers?: boolean;
  borders?: Partial<Record<'top' | 'left' | 'bottom' | 'right', OoxmlBorder>>; bg?: string | null; tabs?: string;
  bidi?: boolean; spaceBefore?: number | null; spaceAfter?: number | null; line?: { line: number; rule: string } | null;
  indentLeft?: number | null; indentRight?: number | null; indentFirst?: number | null; contextualSpacing?: boolean;
  align?: string | null; textAlignment?: string; outlineLevel?: number | null; vanish?: boolean; sectPr?: string;
}

interface RunProps {
  styleId?: string; font?: string; bold?: boolean; italic?: boolean; caps?: boolean; smallCaps?: boolean; strike?: boolean;
  dstrike?: boolean; outline?: boolean; shadow?: boolean; emboss?: boolean; imprint?: boolean; noProof?: boolean;
  vanish?: boolean; color?: string; spacing?: number; scale?: number; position?: number; size?: number; highlight?: string;
  underline?: { style: string; color?: string | null } | false; border?: OoxmlBorder; shading?: string;
  vertAlign?: 'superscript' | 'subscript'; rtl?: boolean; lang?: string;
}

const onOffEl = (name: string, v: boolean | undefined) => (v === undefined ? '' : v ? `<w:${name}/>` : `<w:${name} w:val="0"/>`);

function borderEl(name: string, b: OoxmlBorder, space = 1): string {
  return `<w:${name} w:val="${esc(b.val)}" w:sz="${b.sz}" w:space="${b.space ?? space}" w:color="${esc(b.color)}"/>`;
}

function pPrXml(p: ParaProps): string {
  let x = '';
  if (p.styleId) x += `<w:pStyle w:val="${esc(p.styleId)}"/>`;
  if (p.keepNext) x += '<w:keepNext/>';
  if (p.keepLines) x += '<w:keepLines/>';
  if (p.pageBreakBefore) x += '<w:pageBreakBefore/>';
  if (p.framePr) x += p.framePr;
  if (p.widowControl !== undefined) x += onOffEl('widowControl', p.widowControl);
  if (p.numPr) x += `<w:numPr><w:ilvl w:val="${p.numPr.ilvl}"/><w:numId w:val="${p.numPr.numId}"/></w:numPr>`;
  if (p.suppressLineNumbers) x += '<w:suppressLineNumbers/>';
  if (p.borders && Object.keys(p.borders).length) {
    x += '<w:pBdr>';
    for (const side of ['top', 'left', 'bottom', 'right'] as const) if (p.borders[side]) x += borderEl(side, p.borders[side]!, side === 'top' || side === 'bottom' ? 1 : 4);
    x += '</w:pBdr>';
  }
  if (p.bg) x += `<w:shd w:val="clear" w:color="auto" w:fill="${esc(p.bg)}"/>`;
  if (p.tabs) x += p.tabs;
  if (p.bidi) x += '<w:bidi/>';
  if (p.spaceBefore != null || p.spaceAfter != null || p.line) {
    x += '<w:spacing';
    if (p.spaceBefore != null) x += ` w:before="${ptToTwip(p.spaceBefore)}"`;
    if (p.spaceAfter != null) x += ` w:after="${ptToTwip(p.spaceAfter)}"`;
    if (p.line) x += ` w:line="${p.line.line}" w:lineRule="${p.line.rule}"`;
    x += '/>';
  }
  if (p.indentLeft != null || p.indentRight != null || p.indentFirst != null) {
    x += '<w:ind';
    if (p.indentLeft != null) x += ` w:left="${ptToTwip(p.indentLeft)}"`;
    if (p.indentRight != null) x += ` w:right="${ptToTwip(p.indentRight)}"`;
    if (p.indentFirst != null) x += p.indentFirst < 0 ? ` w:hanging="${ptToTwip(-p.indentFirst)}"` : ` w:firstLine="${ptToTwip(p.indentFirst)}"`;
    x += '/>';
  }
  if (p.contextualSpacing) x += '<w:contextualSpacing/>';
  if (p.align) x += `<w:jc w:val="${p.align}"/>`;
  if (p.textAlignment) x += `<w:textAlignment w:val="${p.textAlignment}"/>`;
  if (p.outlineLevel != null) x += `<w:outlineLvl w:val="${p.outlineLevel}"/>`;
  if (p.vanish) x += '<w:rPr><w:vanish/></w:rPr>';
  if (p.sectPr) x += p.sectPr;
  return x ? `<w:pPr>${x}</w:pPr>` : '';
}

function rPrXml(r: RunProps): string {
  let x = '';
  if (r.styleId) x += `<w:rStyle w:val="${esc(r.styleId)}"/>`;
  if (r.font) { const f = esc(r.font); x += `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`; }
  if (r.bold !== undefined) x += onOffEl('b', r.bold) + onOffEl('bCs', r.bold);
  if (r.italic !== undefined) x += onOffEl('i', r.italic) + onOffEl('iCs', r.italic);
  if (r.caps !== undefined) x += onOffEl('caps', r.caps);
  if (r.smallCaps !== undefined) x += onOffEl('smallCaps', r.smallCaps);
  if (r.strike) x += '<w:strike/>';
  if (r.dstrike) x += '<w:dstrike/>';
  if (r.outline) x += '<w:outline/>';
  if (r.shadow) x += '<w:shadow/>';
  if (r.emboss) x += '<w:emboss/>';
  if (r.imprint) x += '<w:imprint/>';
  if (r.noProof) x += '<w:noProof/>';
  if (r.vanish) x += '<w:vanish/>';
  if (r.color) x += `<w:color w:val="${esc(r.color)}"/>`;
  if (r.spacing) x += `<w:spacing w:val="${ptToTwip(r.spacing)}"/>`;
  if (r.scale && r.scale !== 100) x += `<w:w w:val="${Math.round(Math.max(1, Math.min(600, r.scale)))}"/>`;
  if (r.position) x += `<w:position w:val="${Math.round(r.position * 2)}"/>`;
  if (r.size) { const hp = Math.max(2, Math.round(r.size * 2)); x += `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`; }
  if (r.highlight) x += `<w:highlight w:val="${r.highlight}"/>`;
  if (r.underline) x += `<w:u w:val="${UNDERLINE_OUT[r.underline.style] || 'single'}"${r.underline.color ? ` w:color="${esc(r.underline.color)}"` : ''}/>`;
  else if (r.underline === false) x += '<w:u w:val="none"/>';
  if (r.border) x += borderEl('bdr', r.border, 0);
  if (r.shading) x += `<w:shd w:val="clear" w:color="auto" w:fill="${esc(r.shading)}"/>`;
  if (r.vertAlign) x += `<w:vertAlign w:val="${r.vertAlign}"/>`;
  if (r.rtl) x += '<w:rtl/>';
  if (r.lang) x += `<w:lang w:val="${esc(r.lang)}"/>`;
  return x ? `<w:rPr>${x}</w:rPr>` : '';
}

/** "1.15" / "14pt" / "atleast:14" / "150%" -> w:spacing line + rule. */
function lineSpacing(v: string | null | undefined): { line: number; rule: string } | null {
  if (!v) return null;
  const s = String(v).trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:\.\d+)?)$/.exec(s))) return { line: Math.round(parseFloat(m[1]) * 240), rule: 'auto' };
  if ((m = /^atleast:\s*([\d.]+)/i.exec(s))) return { line: ptToTwip(parseFloat(m[1])), rule: 'atLeast' };
  if ((m = /^([\d.]+)\s*pt$/i.exec(s))) return { line: ptToTwip(parseFloat(m[1])), rule: 'exact' };
  if ((m = /^([\d.]+)\s*px$/i.exec(s))) return { line: ptToTwip(parseFloat(m[1]) * 0.75), rule: 'exact' };
  if ((m = /^([\d.]+)\s*%$/.exec(s))) return { line: Math.round((parseFloat(m[1]) / 100) * 240), rule: 'auto' };
  if ((m = /^([\d.]+)\s*em$/i.exec(s))) return { line: Math.round(parseFloat(m[1]) * 240), rule: 'auto' };
  return null;
}

function alignOut(a: string | null | undefined): string | null {
  switch (a) {
    case 'left': case 'start': return 'left';
    case 'center': return 'center';
    case 'right': case 'end': return 'right';
    case 'justify': return 'both';
    case 'distribute': return 'distribute';
    default: return null;
  }
}

function tabsXml(json: string | null | undefined): string {
  if (!json) return '';
  try {
    const t = JSON.parse(json);
    if (!Array.isArray(t) || !t.length) return '';
    const items = t.filter((x: any) => x && Number.isFinite(+x.pos)).map((x: any) => {
      const val = ['left', 'center', 'right', 'decimal', 'bar'].includes(x.align) ? x.align : 'left';
      const leader = ['dot', 'hyphen', 'underscore', 'heavy', 'middleDot'].includes(x.leader) ? ` w:leader="${x.leader}"` : '';
      return `<w:tab w:val="${val}"${leader} w:pos="${ptToTwip(+x.pos)}"/>`;
    });
    return items.length ? `<w:tabs>${items.join('')}</w:tabs>` : '';
  } catch {
    return '';
  }
}

function isoDate(ms: number | null | undefined): string {
  const d = ms ? new Date(ms) : new Date();
  return (Number.isFinite(d.getTime()) ? d : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function textRun(text: string, rPr: string, deleted = false): string {
  let inner = '';
  const tag = deleted ? 'delText' : 't';
  for (const part of text.replace(/\r\n?/g, '\n').split(/(\t|\n|­|‑)/)) {
    if (!part) continue;
    if (part === '\t') inner += '<w:tab/>';
    else if (part === '\n') inner += '<w:br/>';
    else if (part === '­') inner += '<w:softHyphen/>';
    else if (part === '‑') inner += '<w:noBreakHyphen/>';
    else inner += `<w:${tag} xml:space="preserve">${esc(part)}</w:${tag}>`;
  }
  return inner ? `<w:r>${rPr}${inner}</w:r>` : '';
}

/**
 * Word bookmark names (letters, digits and _, at most 40 characters) for the document's own names.
 * Letters of every script are kept, and each name gets a result of its own, so bookmarks whose
 * names differ only in characters Word does not allow stay distinct and links still find them.
 */
class BookmarkNames {
  private byName = new Map<string, string>();
  private used = new Set<string>();
  get(name: string): string {
    const key = String(name || 'bookmark');
    const known = this.byName.get(key);
    if (known) return known;
    const cut = (s: string, n: number) => s.slice(0, n).replace(/[\uD800-\uDBFF]$/, '');
    let base = key.replace(/[^\p{L}\p{N}_]/gu, '_');
    if (!/^[\p{L}_]/u.test(base)) base = 'bm_' + base;
    base = cut(base, 40);
    let n = base;
    for (let k = 2; this.used.has(n); k++) n = cut(base, 40 - String(k).length - 1) + '_' + k;
    this.used.add(n);
    this.byName.set(key, n);
    return n;
  }
}

/** Lines of text from a gen_block's cached HTML, with a best-effort outline level. */
function htmlLines(html: string): { text: string; level: number }[] {
  if (!html) return [];
  const out: { text: string; level: number }[] = [];
  const chunks = html.replace(/<br\s*\/?>/gi, '\n').split(/<\/(?:p|div|li|h[1-6]|tr|dt|dd)>/i);
  for (const chunk of chunks) {
    const open = /<(?:p|div|li|h[1-6]|tr|a|span)\b([^>]*)>/i.exec(chunk);
    let level = 1;
    const lm = open && (/(?:data-level|level|lvl|toc)[-_=\s"']*(\d)/i.exec(open[1]) || /\bl(\d)\b/.exec(open[1]));
    if (lm) level = Math.max(1, Math.min(9, parseInt(lm[1], 10)));
    else if (open) {
      const ml = /(?:margin|padding)-left\s*:\s*([\d.]+)(pt|px|em)?/i.exec(open[1]);
      if (ml) level = 1 + Math.min(8, Math.round(parseFloat(ml[1]) / (ml[2] === 'em' ? 1.5 : ml[2] === 'px' ? 20 : 11)));
    }
    const text = chunk.replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
    for (const line of text.split('\n')) {
      const t = line.replace(/\s+$/, '').replace(/^\s+/, '');
      if (t) out.push({ text: t, level });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Relationships

class Rels {
  private list: { id: string; type: string; target: string; external: boolean }[] = [];
  private n = 0;
  add(type: string, target: string, external = false): string {
    const ex = this.list.find((r) => r.type === type && r.target === target && r.external === external);
    if (ex) return ex.id;
    const id = 'rId' + ++this.n;
    this.list.push({ id, type, target, external });
    return id;
  }
  get size(): number { return this.list.length; }
  xml(): string {
    return XML_HEADER + `<Relationships xmlns="${NS.pkgRel}">` +
      this.list.map((r) => `<Relationship Id="${r.id}" Type="${esc(r.type)}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
      '</Relationships>';
  }
}

// ------------------------------------------------------------------------------------------
// Media

interface Media { name: string; mime: string; bytes: Uint8Array; w: number; h: number; svg?: { name: string; bytes: Uint8Array } }

async function rasterizeSvg(src: string, w: number, h: number): Promise<Uint8Array | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const scale = 2;
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) { clearTimeout(timer); resolve(null); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL('image/png');
          clearTimeout(timer);
          resolve(parseDataUrl(url)?.bytes || null);
        } catch { clearTimeout(timer); resolve(null); }
      };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    } catch { clearTimeout(timer); resolve(null); }
  });
}

// ------------------------------------------------------------------------------------------
// LaTeX -> OMML

type MNode =
  | { t: 'run'; text: string; plain?: boolean }
  | { t: 'grp'; e: MNode[] }
  | { t: 'frac'; num: MNode[]; den: MNode[]; noBar?: boolean }
  | { t: 'script'; base: MNode[]; sub: MNode[] | null; sup: MNode[] | null }
  | { t: 'rad'; deg: MNode[] | null; e: MNode[] }
  | { t: 'nary'; chr: string; sub: MNode[] | null; sup: MNode[] | null; e: MNode[]; limLoc: string }
  | { t: 'delim'; open: string; close: string; e: MNode[][] }
  | { t: 'acc'; chr: string; e: MNode[] }
  | { t: 'bar'; pos: 'top' | 'bot'; e: MNode[] }
  | { t: 'func'; name: string; lim: MNode[] | null; e: MNode[] }
  | { t: 'matrix'; rows: MNode[][][] };

type Tok = { k: 'cmd'; v: string } | { k: 'ch'; v: string };

class LatexParser {
  private toks: Tok[] = [];
  private i = 0;
  constructor(src: string) {
    const s = src;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const m = /^[A-Za-z]+/.exec(s.slice(i + 1));
        if (m) { this.toks.push({ k: 'cmd', v: m[0] }); i += 1 + m[0].length; } else { this.toks.push({ k: 'cmd', v: s[i + 1] ?? '' }); i += 2; }
        continue;
      }
      if (/\s/.test(c)) { i++; continue; }
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      this.toks.push({ k: 'ch', v: ch });
      i += ch.length;
    }
  }
  private peek(): Tok | undefined { return this.toks[this.i]; }
  private next(): Tok | undefined { return this.toks[this.i++]; }
  private isCh(t: Tok | undefined, v: string) { return !!t && t.k === 'ch' && t.v === v; }
  private isCmd(t: Tok | undefined, v: string) { return !!t && t.k === 'cmd' && t.v === v; }

  parse(): MNode[] { return this.expr(() => false); }

  private expr(stop: (t: Tok) => boolean): MNode[] {
    const out: MNode[] = [];
    while (this.i < this.toks.length) {
      const t = this.peek()!;
      if (stop(t)) break;
      if (this.isCh(t, '}')) { this.i++; continue; }
      const n = this.scripted(stop);
      if (n) out.push(n);
    }
    return out;
  }

  private arg(): MNode[] {
    const t = this.peek();
    if (!t) return [];
    if (this.isCh(t, '{')) {
      this.i++;
      const e = this.expr((x) => this.isCh(x, '}'));
      if (this.isCh(this.peek(), '}')) this.i++;
      return e;
    }
    const a = this.atom(() => false);
    return a ? [a] : [];
  }

  private rawArg(): string {
    if (!this.isCh(this.peek(), '{')) { const t = this.next(); return t ? t.v : ''; }
    this.i++;
    let depth = 1;
    let s = '';
    while (this.i < this.toks.length) {
      const t = this.next()!;
      if (this.isCh(t, '{')) depth++;
      if (this.isCh(t, '}') && --depth === 0) break;
      s += t.k === 'cmd' ? (LATEX_SYMBOLS[t.v] ?? t.v) : t.v;
    }
    return s;
  }

  private scripted(stop: (t: Tok) => boolean): MNode | null {
    const base = this.atom(stop);
    if (!base) return null;
    let sub: MNode[] | null = null;
    let sup: MNode[] | null = null;
    for (;;) {
      const t = this.peek();
      if (this.isCh(t, '^')) { this.i++; sup = this.arg(); } else if (this.isCh(t, '_')) { this.i++; sub = this.arg(); } else if (this.isCh(t, "'")) { this.i++; sup = [...(sup || []), { t: 'run', text: '′' }]; } else break;
    }
    if (base.t === 'nary') {
      base.sub = sub; base.sup = sup;
      const t = this.peek();
      if (t && !stop(t) && !this.isCh(t, '}')) { const e = this.scripted(stop); base.e = e ? [e] : []; }
      return base;
    }
    if (base.t === 'func') {
      if (sub && /^(lim|max|min|sup|inf|limsup|liminf)$/.test(base.name)) base.lim = sub;
      else if (sub || sup) return { t: 'script', base: [base], sub, sup };
      const t = this.peek();
      if (t && !stop(t) && !this.isCh(t, '}')) { const e = this.scripted(stop); base.e = e ? [e] : []; }
      return base;
    }
    if (sub || sup) return { t: 'script', base: [base], sub, sup };
    return base;
  }

  private delimChar(): string {
    const t = this.next();
    if (!t) return '';
    if (t.k === 'ch') return t.v === '.' ? '' : t.v;
    const map: Record<string, string> = { '{': '{', '}': '}', langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|', vert: '|', '|': '‖', Vert: '‖', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', lbrace: '{', rbrace: '}' };
    return map[t.v] ?? '';
  }

  private atom(stop: (t: Tok) => boolean): MNode | null {
    const t = this.next();
    if (!t) return null;
    if (t.k === 'ch') {
      if (t.v === '{') {
        const e = this.expr((x) => this.isCh(x, '}'));
        if (this.isCh(this.peek(), '}')) this.i++;
        return { t: 'grp', e };
      }
      if (t.v === '^' || t.v === '_') return { t: 'script', base: [], sub: t.v === '_' ? this.arg() : null, sup: t.v === '^' ? this.arg() : null };
      if (t.v === '~') return { t: 'run', text: ' ' };
      if (t.v === '-') return { t: 'run', text: '−' };
      return { t: 'run', text: t.v };
    }
    const c = t.v;
    if (c === 'frac' || c === 'dfrac' || c === 'tfrac' || c === 'cfrac') return { t: 'frac', num: this.arg(), den: this.arg() };
    if (c === 'binom' || c === 'dbinom' || c === 'tbinom') return { t: 'delim', open: '(', close: ')', e: [[{ t: 'frac', num: this.arg(), den: this.arg(), noBar: true }]] };
    if (c === 'sqrt') {
      let deg: MNode[] | null = null;
      if (this.isCh(this.peek(), '[')) {
        this.i++;
        deg = this.expr((x) => this.isCh(x, ']'));
        if (this.isCh(this.peek(), ']')) this.i++;
      }
      return { t: 'rad', deg, e: this.arg() };
    }
    if (NARY_CHARS[c]) return { t: 'nary', chr: NARY_CHARS[c], sub: null, sup: null, e: [], limLoc: /int/.test(c) ? 'subSup' : 'undOvr' };
    if (c === 'left') {
      const open = this.delimChar();
      const parts: MNode[][] = [];
      let cur: MNode[] = [];
      for (;;) {
        cur = cur.concat(this.expr((x) => this.isCmd(x, 'right') || this.isCmd(x, 'mid')));
        const n = this.peek();
        if (this.isCmd(n, 'mid')) { this.i++; this.delimChar(); parts.push(cur); cur = []; continue; }
        break;
      }
      parts.push(cur);
      let close = '';
      if (this.isCmd(this.peek(), 'right')) { this.i++; close = this.delimChar(); }
      return { t: 'delim', open, close, e: parts };
    }
    if (c === 'right' || c === 'big' || c === 'Big' || c === 'bigg' || c === 'Bigg' || c === 'displaystyle' || c === 'textstyle' || c === 'limits' || c === 'nolimits') return null;
    if (/^(text|textrm|mathrm|operatorname|mathit|mathbf|textbf|textit|mathsf|mathtt|mbox|mathbb|mathcal|mathfrak)$/.test(c)) {
      const raw = this.rawArg();
      if (c === 'operatorname') return { t: 'func', name: raw, lim: null, e: [] };
      return { t: 'run', text: raw, plain: /^(text|textrm|mathrm|mbox|textbf|mathbf|operatorname)$/.test(c) };
    }
    if (c === 'overline') return { t: 'bar', pos: 'top', e: this.arg() };
    if (c === 'underline') return { t: 'bar', pos: 'bot', e: this.arg() };
    if (ACCENT_CHARS[c]) return { t: 'acc', chr: ACCENT_CHARS[c], e: this.arg() };
    if (FUNCTION_NAMES.has(c)) return { t: 'func', name: c, lim: null, e: [] };
    if (c === 'begin') {
      const env = this.rawArg();
      if (env === 'array') this.rawArg();
      const rows: MNode[][][] = [];
      let row: MNode[][] = [];
      for (;;) {
        const cell = this.expr((x) => this.isCh(x, '&') || this.isCmd(x, '\\') || this.isCmd(x, 'end'));
        row.push(cell);
        const n = this.next();
        if (!n) break;
        if (this.isCh(n, '&')) continue;
        if (this.isCmd(n, '\\')) { rows.push(row); row = []; continue; }
        if (this.isCmd(n, 'end')) { this.rawArg(); break; }
      }
      if (row.length && !(row.length === 1 && !row[0].length)) rows.push(row);
      const m: MNode = { t: 'matrix', rows };
      const delims: Record<string, [string, string]> = { pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''] };
      const d = delims[env];
      return d ? { t: 'delim', open: d[0], close: d[1], e: [[m]] } : m;
    }
    if (c === '\\' || c === 'newline') return null;
    if (c in LATEX_SYMBOLS) return LATEX_SYMBOLS[c] ? { t: 'run', text: LATEX_SYMBOLS[c] } : null;
    void stop;
    return { t: 'run', text: c, plain: true };
  }
}

function mrun(text: string, plain = false): string {
  return `<m:r>${plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : ''}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t xml:space="preserve">${esc(text)}</m:t></m:r>`;
}

function ommlNodes(nodes: MNode[]): string {
  let out = '';
  let buf = '';
  let bufPlain = false;
  const flush = () => { if (buf) out += mrun(buf, bufPlain); buf = ''; };
  const e = (n: MNode[] | null) => `<m:e>${ommlNodes(n || [])}</m:e>`;
  for (const n of nodes) {
    if (n.t === 'run') {
      if (buf && bufPlain !== !!n.plain) flush();
      bufPlain = !!n.plain;
      buf += n.text;
      continue;
    }
    flush();
    switch (n.t) {
      case 'grp': out += ommlNodes(n.e); break;
      case 'frac': out += `<m:f>${n.noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''}<m:num>${ommlNodes(n.num)}</m:num><m:den>${ommlNodes(n.den)}</m:den></m:f>`; break;
      case 'script':
        if (n.sub && n.sup) out += `<m:sSubSup>${e(n.base)}<m:sub>${ommlNodes(n.sub)}</m:sub><m:sup>${ommlNodes(n.sup)}</m:sup></m:sSubSup>`;
        else if (n.sup) out += `<m:sSup>${e(n.base)}<m:sup>${ommlNodes(n.sup)}</m:sup></m:sSup>`;
        else if (n.sub) out += `<m:sSub>${e(n.base)}<m:sub>${ommlNodes(n.sub)}</m:sub></m:sSub>`;
        else out += ommlNodes(n.base);
        break;
      case 'rad':
        out += n.deg && n.deg.length ? `<m:rad><m:deg>${ommlNodes(n.deg)}</m:deg>${e(n.e)}</m:rad>` : `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>${e(n.e)}</m:rad>`;
        break;
      case 'nary':
        out += `<m:nary><m:naryPr><m:chr m:val="${esc(n.chr)}"/><m:limLoc m:val="${n.limLoc}"/>${n.sub ? '' : '<m:subHide m:val="1"/>'}${n.sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>` +
          `<m:sub>${ommlNodes(n.sub || [])}</m:sub><m:sup>${ommlNodes(n.sup || [])}</m:sup>${e(n.e)}</m:nary>`;
        break;
      case 'delim':
        out += `<m:d><m:dPr><m:begChr m:val="${esc(n.open)}"/><m:endChr m:val="${esc(n.close)}"/></m:dPr>${n.e.map((x) => e(x)).join('')}</m:d>`;
        break;
      case 'acc': out += `<m:acc><m:accPr><m:chr m:val="${esc(n.chr)}"/></m:accPr>${e(n.e)}</m:acc>`; break;
      case 'bar': out += `<m:bar><m:barPr><m:pos m:val="${n.pos}"/></m:barPr>${e(n.e)}</m:bar>`; break;
      case 'func': {
        const name = n.lim ? `<m:limLow><m:e>${mrun(n.name, true)}</m:e><m:lim>${ommlNodes(n.lim)}</m:lim></m:limLow>` : mrun(n.name, true);
        out += `<m:func><m:fName>${name}</m:fName>${e(n.e)}</m:func>`;
        break;
      }
      case 'matrix': {
        const cols = Math.max(1, ...n.rows.map((r) => r.length));
        out += `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>` +
          n.rows.map((r) => `<m:mr>${Array.from({ length: cols }, (_v, i) => e(r[i] || [])).join('')}</m:mr>`).join('') + '</m:m>';
        break;
      }
    }
  }
  flush();
  return out;
}

/** Best-effort LaTeX -> OMML (inner content of m:oMath). */
export function latexToOmml(latex: string): string {
  try {
    const nodes = new LatexParser(latex || '').parse();
    const x = ommlNodes(nodes);
    return x || mrun(latex || ' ');
  } catch {
    return mrun(latex || ' ');
  }
}

// ------------------------------------------------------------------------------------------
// Numbering

interface LevelSpec { kind: 'bullet' | 'ordered' | 'task'; bullet: string; format: string; suffix: string; outline: boolean; start: number }

const BULLET_CYCLE = ['disc', 'circle', 'square'];
const ORDER_CYCLE = ['decimal', 'lower-alpha', 'lower-roman'];

function levelOf(list: PMNode): LevelSpec {
  if (list.type === N.task_list) return { kind: 'task', bullet: 'none', format: 'decimal', suffix: '', outline: false, start: 1 };
  if (list.type === N.ordered_list) return { kind: 'ordered', bullet: 'disc', format: list.attrs.format || 'decimal', suffix: list.attrs.suffix ?? '.', outline: !!list.attrs.outline, start: listStart(list.attrs.order) };
  return { kind: 'bullet', bullet: list.attrs.bullet || 'disc', format: 'decimal', suffix: '', outline: false, start: 1 };
}

/** Hidden empty paragraph written between adjacent tables (dropped again on import). */
const TABLE_SEPARATOR = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:vanish/><w:sz w:val="2"/></w:rPr></w:pPr></w:p>';

const isList = (n: PMNode) => n.type === N.bullet_list || n.type === N.ordered_list || n.type === N.task_list;

class Numbering {
  abstracts: string[] = [];
  nums: string[] = [];
  private bySig = new Map<string, number>();

  forList(list: PMNode): number {
    const levels: (LevelSpec | null)[] = new Array(9).fill(null);
    const walk = (l: PMNode, depth: number) => {
      if (depth > 8) return;
      if (!levels[depth]) levels[depth] = levelOf(l);
      l.forEach((item) => item.forEach((child) => { if (isList(child)) walk(child, depth + 1); }));
    };
    walk(list, 0);
    for (let i = 1; i < 9; i++) {
      if (levels[i]) continue;
      const prev = levels[i - 1]!;
      if (prev.kind === 'bullet') levels[i] = { ...prev, bullet: BULLET_CYCLE[i % 3], start: 1 };
      else if (prev.kind === 'ordered') levels[i] = { ...prev, format: prev.outline ? prev.format : ORDER_CYCLE[i % 3], start: 1 };
      else levels[i] = { ...prev };
    }
    const lv = levels as LevelSpec[];
    const sig = JSON.stringify(lv.map((l) => [l.kind, l.bullet, l.format, l.suffix, l.outline]));
    let absId = this.bySig.get(sig);
    if (absId == null) {
      absId = this.abstracts.length;
      this.bySig.set(sig, absId);
      this.abstracts.push(this.abstractXml(absId, lv));
    }
    const numId = this.nums.length + 1;
    let overrides = '';
    lv.forEach((l, i) => { if (l.kind === 'ordered') overrides += `<w:lvlOverride w:ilvl="${i}"><w:startOverride w:val="${Math.max(0, l.start)}"/></w:lvlOverride>`; });
    this.nums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${absId}"/>${overrides}</w:num>`);
    return numId;
  }

  private abstractXml(id: number, levels: LevelSpec[]): string {
    let x = `<w:abstractNum w:abstractNumId="${id}"><w:nsid w:val="${(0x1a2b0000 + id * 7919).toString(16).toUpperCase().padStart(8, '0').slice(-8)}"/><w:multiLevelType w:val="hybridMultilevel"/>`;
    levels.forEach((l, i) => {
      const ind = `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>`;
      x += `<w:lvl w:ilvl="${i}"${l.kind === 'ordered' ? '' : ' w:tplc="04090001"'}>`;
      if (l.kind === 'ordered') {
        const text = l.outline ? Array.from({ length: i + 1 }, (_v, k) => `%${k + 1}`).join('.') + l.suffix : `%${i + 1}${l.suffix}`;
        x += `<w:start w:val="1"/><w:numFmt w:val="${LIST_FMT_OUT[l.format] || 'decimal'}"/><w:lvlText w:val="${esc(text)}"/><w:lvlJc w:val="left"/>${ind}`;
      } else if (l.kind === 'task' || l.bullet === 'none') {
        x += `<w:start w:val="1"/><w:numFmt w:val="none"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/>${ind}`;
      } else {
        const b = BULLETS[l.bullet] || { text: l.bullet, font: null };
        x += `<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${esc(b.text)}"/><w:lvlJc w:val="left"/>${ind}`;
        if (b.font) x += `<w:rPr><w:rFonts w:ascii="${b.font}" w:hAnsi="${b.font}" w:hint="default"/></w:rPr>`;
      }
      x += '</w:lvl>';
    });
    return x + '</w:abstractNum>';
  }

  xml(): string {
    return XML_HEADER + `<w:numbering ${ROOT_NS}>${this.abstracts.join('')}${this.nums.join('')}</w:numbering>`;
  }
}

// ------------------------------------------------------------------------------------------
// The writer

interface BCtx {
  list?: { numId: number; ilvl: number };
  listCont?: { ilvl: number };
  box?: { borders: Partial<Record<'top' | 'left' | 'bottom' | 'right', OoxmlBorder>>; bg: string | null };
  inTable?: boolean;
  top?: boolean;
}

class DocxWriter {
  settings: DocSettings;
  styleMap: Record<string, StyleDef>;
  accent: string[];
  rels = new Rels();
  zip = new JSZip();
  numbering = new Numbering();
  media = new Map<string, Media | null>();
  mediaCount = 0;
  usedStyles = new Set<string>();
  styleIds = new Map<string, string>();
  footnotes: string[] = [];
  endnotes: string[] = [];
  noteId = { foot: 0, end: 0 };
  commentNums = new Map<string, number>();
  replyNums = new Map<string, number[]>();
  commentFirst = new Map<string, number>();
  commentLast = new Map<string, number>();
  openComments = new Set<string>();
  inlineIdx = 0;
  annot = 1;
  docPrId = 1;
  hasRevisions = false;
  hasHyperlinkStyle = false;
  secType = 'nextPage';
  secCols = { count: 1, gap: 36, rule: false };
  topWritten = 0;
  hfRefs = '';
  textWidthTw: number;
  hasTOC = false;
  contentTypes = new Map<string, string>();
  bookmarks = new BookmarkNames();

  constructor(private doc: PMNode, private opts: ExportOptions) {
    this.settings = normalizeSettings(doc.attrs.settings);
    this.styleMap = resolveStyles(this.settings);
    this.accent = this.settings.theme.accent;
    const dims = pageDims(this.settings.page);
    const m = this.settings.page.margin;
    this.textWidthTw = Math.max(1440, ptToTwip(dims.w - m.left - m.right - (this.settings.page.gutter || 0)));
    // Reserve the first zip entry for the content types part (some consumers expect it first).
    this.zip.file('[Content_Types].xml', '');
    this.prepass();
  }

  // ---------------------------------------------------------------------------------------
  private prepass(): void {
    let idx = 0;
    const commentIds: string[] = [];
    this.doc.descendants((node, _pos, parent) => {
      if (parent && parent.type === N.paragraph) {
        for (const m of node.marks) {
          if (m.type === M.comment) {
            const id = String(m.attrs.id);
            if (!this.commentFirst.has(id)) { this.commentFirst.set(id, idx); commentIds.push(id); }
            this.commentLast.set(id, idx);
          }
          if (m.type === M.insertion || m.type === M.deletion) this.hasRevisions = true;
        }
        idx++;
      }
      return true;
    });
    let n = 0;
    for (const id of commentIds) {
      this.commentNums.set(id, n++);
      const data = this.settings.comments[id];
      const replies: number[] = [];
      for (let i = 0; i < (data?.replies?.length || 0); i++) replies.push(n++);
      this.replyNums.set(id, replies);
    }
    this.annot = n + 1;
  }

  async prepareMedia(): Promise<void> {
    const srcs = new Set<string>();
    this.doc.descendants((n) => { if (n.type === N.image && n.attrs.src) srcs.add(n.attrs.src); return true; });
    for (const src of srcs) {
      try { this.media.set(src, await this.loadImage(src)); } catch { this.media.set(src, null); }
    }
  }

  private async loadImage(src: string): Promise<Media | null> {
    const d = parseDataUrl(src);
    if (!d) return null;
    let mime = sniffImageMime(d.bytes) || d.mime;
    let bytes = d.bytes;
    let svg: Media['svg'];
    let size = imageSize(bytes);
    if (mime === 'image/svg+xml' || (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(mime))) {
      const isSvg = mime === 'image/svg+xml';
      const ss = isSvg ? svgSize(new TextDecoder().decode(bytes)) : null;
      const w = ss?.w || 300, h = ss?.h || 200;
      const png = await rasterizeSvg(src, w, h);
      if (!png) return null;
      if (isSvg) svg = { name: `image${++this.mediaCount}.svg`, bytes };
      mime = 'image/png';
      bytes = png;
      size = { w, h };
    }
    const ext = extForMime(mime) || 'png';
    const name = `image${++this.mediaCount}.${ext}`;
    return { name, mime, bytes, w: size?.w || 400, h: size?.h || 267, svg };
  }

  // ---------------------------------------------------------------------------------------
  // Styles

  sid(name: string): string {
    let id = this.styleIds.get(name);
    if (id) return id;
    const base = styleIdFor(name);
    id = base;
    let k = 2;
    const taken = new Set(this.styleIds.values());
    while (taken.has(id)) id = base + k++;
    this.styleIds.set(name, id);
    return id;
  }

  useStyle(name: string): string {
    this.usedStyles.add(name);
    return this.sid(name);
  }

  private fontName(f: string | undefined): string | undefined {
    if (!f) return undefined;
    const stack = fontStack(f, this.settings);
    const fam = (stack.split(',')[0] || f).replace(/["']/g, '').trim();
    return exportFontName(fam || f);
  }

  private color(c: string | null | undefined): string | undefined {
    return cssColorToHex(c, this.accent) || undefined;
  }

  // ---------------------------------------------------------------------------------------
  // Paragraphs

  private paraProps(a: Record<string, any>, ctx: BCtx): ParaProps {
    const p: ParaProps = {};
    let style = a.style || 'Normal';
    if ((ctx.list || ctx.listCont) && style === 'Normal') style = 'List Paragraph';
    if (style !== 'Normal') p.styleId = this.useStyle(style);
    if (a.keepNext) p.keepNext = true;
    if (a.keepLines) p.keepLines = true;
    if (a.pageBreakBefore) p.pageBreakBefore = true;
    if (a.widowControl === false) p.widowControl = false;
    if (ctx.list) p.numPr = ctx.list;
    if (a.suppressLineNumbers) p.suppressLineNumbers = true;
    const borders: ParaProps['borders'] = { ...(ctx.box?.borders || {}) };
    if (a.border) {
      try {
        const b = JSON.parse(a.border);
        for (const side of ['top', 'left', 'bottom', 'right'] as const) {
          const ob = cssBorderToOoxml(b[side], this.accent);
          if (ob) borders[side] = ob;
        }
      } catch {
        const ob = cssBorderToOoxml(a.border, this.accent);
        if (ob) Object.assign(borders, { top: ob, left: ob, bottom: ob, right: ob });
      }
    }
    if (Object.keys(borders).length) p.borders = borders;
    const bg = this.color(a.bg) || ctx.box?.bg;
    if (bg) p.bg = bg;
    const tabs = tabsXml(a.tabs);
    if (tabs) p.tabs = tabs;
    if (a.dir === 'rtl') p.bidi = true;
    if (a.spaceBefore != null) p.spaceBefore = a.spaceBefore;
    if (a.spaceAfter != null) p.spaceAfter = a.spaceAfter;
    p.line = lineSpacing(a.lineHeight);
    if (ctx.listCont) p.indentLeft = 36 * (ctx.listCont.ilvl + 1);
    if (a.indentLeft != null && !ctx.list) p.indentLeft = a.indentLeft;
    if (a.indentRight != null) p.indentRight = a.indentRight;
    if (a.indentFirst != null && !ctx.list) p.indentFirst = a.indentFirst;
    p.align = alignOut(a.align);
    // In a w:bidi paragraph jc left/right mean leading/trailing: the model's right margin is "left".
    if (p.bidi && (p.align === 'left' || p.align === 'right')) p.align = p.align === 'left' ? 'right' : 'left';
    if (a.outlineLevel != null && a.outlineLevel >= 1 && a.outlineLevel <= 9) p.outlineLevel = a.outlineLevel - 1;
    if (a.hidden) p.vanish = true;
    return p;
  }

  private paragraph(node: PMNode, ctx: BCtx, prefix = ''): string {
    const a = node.attrs;
    let pre = '';
    let skipFirst = false;
    if (a.dropCap > 0) {
      const first = node.firstChild;
      if (first && first.isText && first.text) {
        const ch = String.fromCodePoint(first.text.codePointAt(0)!);
        const lines = Math.max(2, Math.min(10, a.dropCap));
        const base = this.styleSize(a.style) || 11;
        const runProps = this.marksToRun(first.marks);
        runProps.size = Math.round(base * lines * 1.53 * 2) / 2;
        runProps.position = -Math.round(lines * 2.3) / 2;
        const framePr = `<w:framePr w:dropCap="drop" w:lines="${lines}" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>`;
        pre = `<w:p>${pPrXml({ styleId: a.style && a.style !== 'Normal' ? this.useStyle(a.style) : undefined, keepNext: true, framePr, spaceAfter: 0, line: { line: Math.round(base * lines * 1.25 * 20), rule: 'exact' }, textAlignment: 'baseline' })}${textRun(ch, rPrXml(runProps))}</w:p>`;
        skipFirst = true;
      }
    }
    const pPr = pPrXml(this.paraProps(a, ctx));
    const runs = this.inlines(node, skipFirst, !!a.hidden);
    return `${pre}<w:p>${pPr}${prefix}${runs}</w:p>`;
  }

  private styleSize(name: string): number | undefined {
    let s: StyleDef | undefined = this.styleMap[name || 'Normal'];
    for (let i = 0; s && i < 12; i++) {
      if (s.size) return s.size;
      s = s.basedOn ? this.styleMap[s.basedOn] : undefined;
    }
    return this.styleMap.Normal?.size;
  }

  private marksToRun(marks: readonly Mark[], hidden = false): RunProps {
    const r: RunProps = {};
    let link = false;
    for (const m of marks) {
      const a = m.attrs;
      switch (m.type.name) {
        case 'bold': r.bold = true; break;
        case 'italic': r.italic = true; break;
        case 'underline': r.underline = { style: a.style || 'single', color: this.color(a.color) }; break;
        case 'strike': r.strike = true; break;
        case 'dstrike': r.dstrike = true; break;
        case 'sup': r.vertAlign = 'superscript'; break;
        case 'sub': r.vertAlign = 'subscript'; break;
        case 'smallcaps': r.smallCaps = true; break;
        case 'allcaps': r.caps = true; break;
        case 'hidden': r.vanish = true; break;
        case 'code': r.styleId = r.styleId || this.useStyle('HTML Code'); if (!r.font) r.font = 'Courier New'; break;
        case 'font': if (a.family) r.font = this.fontName(String(a.family)); break;
        case 'size': if (+a.pt > 0) r.size = +a.pt; break;
        case 'color': { const c = this.color(a.color); if (c) r.color = c; break; }
        case 'highlight': {
          const c = this.color(a.color);
          if (c) { const name = highlightName(c); if (name) r.highlight = name; else r.shading = c; }
          break;
        }
        case 'shading': { const c = this.color(a.color); if (c) r.shading = c; break; }
        case 'charBorder': { const b = cssBorderToOoxml(a.border, this.accent); if (b) r.border = b; break; }
        case 'spacing': if (+a.pt) r.spacing = +a.pt; break;
        case 'scale': if (+a.pct && +a.pct !== 100) r.scale = +a.pct; break;
        case 'position': if (+a.pt) r.position = +a.pt; break;
        case 'charStyle': if (a.name) r.styleId = this.useStyle(String(a.name)); break;
        case 'lang': if (a.lang) r.lang = String(a.lang); if (a.noProof) r.noProof = true; break;
        case 'dir': if (a.dir === 'rtl') r.rtl = true; break;
        case 'effect':
          if (a.kind === 'outline') r.outline = true;
          else if (a.kind === 'shadow') r.shadow = true;
          else if (a.kind === 'emboss') r.emboss = true;
          else if (a.kind === 'engrave') r.imprint = true;
          break;
        case 'link': link = true; break;
        default: break;
      }
    }
    if (link && !r.styleId) { r.styleId = this.useStyle('Hyperlink'); }
    if (hidden) r.vanish = true;
    return r;
  }

  private rPr(marks: readonly Mark[], hidden = false): string {
    return rPrXml(this.marksToRun(marks, hidden));
  }

  /** Paragraph inline content with hyperlink / revision wrappers and comment ranges. */
  private inlines(para: PMNode, skipFirstChar: boolean, hidden: boolean): string {
    let out = '';
    let curLink: string | null = null;
    let curRev: string | null = null;
    const closeRev = () => { if (curRev) out += curRev.startsWith('ins') ? '</w:ins>' : '</w:del>'; curRev = null; };
    const closeLink = () => { closeRev(); if (curLink) out += '</w:hyperlink>'; curLink = null; };
    let first = true;
    para.forEach((child) => {
      const idx = this.inlineIdx++;
      let node: PMNode | null = child;
      if (first && skipFirstChar && child.isText && child.text) {
        const cut = String.fromCodePoint(child.text.codePointAt(0)!).length;
        node = child.text.length > cut ? schema.text(child.text.slice(cut), child.marks) : null;
      }
      first = false;
      // Comment range starts
      for (const m of child.marks) {
        if (m.type !== M.comment) continue;
        const id = String(m.attrs.id);
        if (this.commentFirst.get(id) === idx && !this.openComments.has(id)) {
          closeLink();
          out += this.commentMarkers(id, 'start');
          this.openComments.add(id);
        }
      }
      if (node) {
        const link = child.marks.find((m) => m.type === M.link);
        const linkKey = link ? `${link.attrs.href}\u0000${link.attrs.title || ''}` : null;
        if (linkKey !== curLink) {
          closeLink();
          if (link && link.attrs.href) {
            const href = String(link.attrs.href);
            const tip = link.attrs.title ? ` w:tooltip="${esc(link.attrs.title)}"` : '';
            if (href.startsWith('#')) out += `<w:hyperlink w:anchor="${esc(this.bookmarks.get(href.slice(1)))}"${tip} w:history="1">`;
            else out += `<w:hyperlink r:id="${this.rels.add(REL.hyperlink, href, true)}"${tip} w:history="1">`;
            curLink = linkKey;
          }
        }
        const rev = child.marks.find((m) => m.type === M.insertion || m.type === M.deletion);
        const revKey = rev ? `${rev.type === M.insertion ? 'ins' : 'del'}\u0000${rev.attrs.author}\u0000${rev.attrs.date}\u0000${rev.attrs.id}` : null;
        if (revKey !== curRev) {
          closeRev();
          if (rev) {
            const tag = rev.type === M.insertion ? 'ins' : 'del';
            out += `<w:${tag} w:id="${this.annot++}" w:author="${esc(rev.attrs.author || 'Unknown')}"${rev.attrs.date ? ` w:date="${isoDate(rev.attrs.date)}"` : ''}>`;
            curRev = revKey;
          }
        }
        out += this.inlineNode(node, !!rev && rev.type === M.deletion, hidden);
      }
      // Comment range ends
      for (const m of child.marks) {
        if (m.type !== M.comment) continue;
        const id = String(m.attrs.id);
        if (this.commentLast.get(id) === idx && this.openComments.has(id)) {
          closeLink();
          out += this.commentMarkers(id, 'end');
          this.openComments.delete(id);
        }
      }
    });
    closeLink();
    return out;
  }

  private commentMarkers(id: string, which: 'start' | 'end'): string {
    const nums = [this.commentNums.get(id)!, ...(this.replyNums.get(id) || [])];
    if (which === 'start') return nums.map((n) => `<w:commentRangeStart w:id="${n}"/>`).join('');
    return nums.map((n) => `<w:commentRangeEnd w:id="${n}"/><w:r><w:rPr><w:rStyle w:val="${this.useStyle('Comment Reference')}"/></w:rPr><w:commentReference w:id="${n}"/></w:r>`).join('');
  }

  private fieldRuns(instr: string, value: string | null, rPr: string, opts: { locked?: boolean; deleted?: boolean } = {}): string {
    const it = opts.deleted ? 'delInstrText' : 'instrText';
    let x = `<w:r>${rPr}<w:fldChar w:fldCharType="begin"${opts.locked ? ' w:fldLock="1"' : ''}/></w:r>`;
    x += `<w:r>${rPr}<w:${it} xml:space="preserve"> ${esc(instr)} </w:${it}></w:r>`;
    if (value != null) {
      x += `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>`;
      x += textRun(value, rPr, opts.deleted);
    }
    x += `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;
    return x;
  }

  private inlineNode(node: PMNode, deleted: boolean, hidden: boolean): string {
    const a = node.attrs;
    const rPr = () => this.rPr(node.marks, hidden);
    if (node.isText) return textRun(node.text || '', rPr(), deleted);
    switch (node.type.name) {
      case 'hard_break': return `<w:r>${rPr()}<w:br${a.kind === 'textWrapping' ? ' w:type="textWrapping"' : ''}/></w:r>`;
      case 'image': return this.image(node, rPr());
      case 'footnote': return this.footnote(node, hidden);
      case 'field': {
        const instr = buildFieldInstr(a.type, a.arg, a.format);
        return this.fieldRuns(instr, a.value || '', rPr(), { locked: a.locked, deleted });
      }
      case 'math_inline': return `<m:oMath>${latexToOmml(a.latex)}</m:oMath>`;
      case 'citation': return textRun(a.cache || '(citation)', rPr(), deleted);
      case 'bookmark': {
        const id = this.annot++;
        return `<w:bookmarkStart w:id="${id}" w:name="${esc(this.bookmarks.get(a.name))}"/><w:bookmarkEnd w:id="${id}"/>`;
      }
      case 'index_entry': {
        let instr = `XE "${String(a.term || '').replace(/"/g, '')}${a.sub ? ':' + String(a.sub).replace(/"/g, '') : ''}"`;
        if (a.see) instr += ` \\t "${String(a.see).replace(/"/g, '')}"`;
        if (a.bold) instr += ' \\b';
        if (a.italic) instr += ' \\i';
        return this.fieldRuns(instr, null, rPr(), { deleted });
      }
      case 'control': return this.control(node, rPr());
      case 'chip': return textRun(a.label || a.value || '', rPr(), deleted);
      case 'symbol':
        if (a.kind === 'optionalHyphen') return `<w:r>${rPr()}<w:softHyphen/></w:r>`;
        if (a.kind === 'nonBreakingHyphen') return `<w:r>${rPr()}<w:noBreakHyphen/></w:r>`;
        return '';
      default:
        return node.textContent ? textRun(node.textContent, rPr(), deleted) : '';
    }
  }

  private control(node: PMNode, rPr: string): string {
    const a = node.attrs;
    let pr = '';
    if (a.label) pr += `<w:alias w:val="${esc(a.label)}"/>`;
    if (a.tag) pr += `<w:tag w:val="${esc(a.tag)}"/>`;
    pr += `<w:id w:val="${100000 + this.annot++}"/>`;
    if (a.locked) pr += '<w:lock w:val="sdtContentLocked"/>';
    let content = '';
    const kind = a.kind;
    if (kind === 'checkbox') {
      const checked = a.value === 'true' || a.value === true;
      pr += `<w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox>`;
      content = `<w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:eastAsia="MS Gothic" w:hAnsi="MS Gothic" w:hint="eastAsia"/></w:rPr><w:t>${checked ? '☒' : '☐'}</w:t></w:r>`;
    } else if (kind === 'dropdown' || kind === 'combo') {
      const opts = String(a.options || '').split('|').map((s) => s.trim()).filter(Boolean);
      const tag = kind === 'combo' ? 'comboBox' : 'dropDownList';
      if (!a.value) pr += '<w:showingPlcHdr/>';
      pr += `<w:${tag}>${opts.map((o) => `<w:listItem w:displayText="${esc(o)}" w:value="${esc(o)}"/>`).join('')}</w:${tag}>`;
      content = textRun(a.value || 'Choose an item.', rPr);
    } else if (kind === 'date') {
      const fmt = a.options || 'M/d/yyyy';
      if (!a.value) pr += '<w:showingPlcHdr/>';
      const d = a.value ? Date.parse(a.value) : NaN;
      pr += `<w:date${Number.isFinite(d) ? ` w:fullDate="${isoDate(d)}"` : ''}><w:dateFormat w:val="${esc(fmt)}"/><w:lid w:val="${esc(this.settings.language || 'en-US')}"/><w:storeMappedDataAs w:val="dateTime"/><w:calendar w:val="gregorian"/></w:date>`;
      content = textRun(a.value || 'Click or tap to enter a date.', rPr);
    } else {
      if (!a.value) pr += '<w:showingPlcHdr/>';
      pr += '<w:text/>';
      content = textRun(a.value || a.label || 'Click or tap here to enter text.', rPr);
    }
    return `<w:sdt><w:sdtPr>${pr}</w:sdtPr><w:sdtContent>${content || '<w:r><w:t></w:t></w:r>'}</w:sdtContent></w:sdt>`;
  }

  private footnote(node: PMNode, hidden: boolean): string {
    const a = node.attrs;
    const end = a.kind === 'end';
    const id = end ? ++this.noteId.end : ++this.noteId.foot;
    const refStyle = this.useStyle(end ? 'Endnote Reference' : 'Footnote Reference');
    const textStyle = this.useStyle(end ? 'Endnote Text' : 'Footnote Text');
    const tag = end ? 'endnote' : 'footnote';
    const custom = a.mark ? String(a.mark) : null;
    const lines = String(a.text || '').split('\n');
    const paras = lines.map((line, i) => {
      const ref = i === 0
        ? (custom ? `<w:r><w:rPr><w:rStyle w:val="${refStyle}"/></w:rPr><w:t xml:space="preserve">${esc(custom)}</w:t></w:r>` : `<w:r><w:rPr><w:rStyle w:val="${refStyle}"/></w:rPr><w:${tag}Ref/></w:r>`) + textRun(' ', '')
        : '';
      return `<w:p><w:pPr><w:pStyle w:val="${textStyle}"/></w:pPr>${ref}${textRun(line, '')}</w:p>`;
    }).join('');
    (end ? this.endnotes : this.footnotes).push(`<w:${tag} w:id="${id}">${paras}</w:${tag}>`);
    const base = this.marksToRun(node.marks, hidden);
    base.styleId = refStyle;
    delete base.vertAlign;
    const rPr = rPrXml(base);
    return custom
      ? `<w:r>${rPr}<w:${tag}Reference w:customMarkFollows="1" w:id="${id}"/><w:t xml:space="preserve">${esc(custom)}</w:t></w:r>`
      : `<w:r>${rPr}<w:${tag}Reference w:id="${id}"/></w:r>`;
  }

  // ---------------------------------------------------------------------------------------
  // Images

  private image(node: PMNode, rPr: string): string {
    const a = node.attrs;
    const media = this.media.get(a.src);
    if (!media) return textRun(`[${a.alt || a.title || 'image'}]`, rPr);
    const zipPath = `word/media/${media.name}`;
    if (!this.zip.file(zipPath)) this.zip.file(zipPath, media.bytes);
    const rid = this.rels.add(REL.image, `media/${media.name}`);
    let svgRid: string | null = null;
    if (media.svg) {
      const sp = `word/media/${media.svg.name}`;
      if (!this.zip.file(sp)) this.zip.file(sp, media.svg.bytes);
      svgRid = this.rels.add(REL.image, `media/${media.svg.name}`);
    }
    const natW = media.w * 0.75, natH = media.h * 0.75;
    let w = +a.width || 0, h = +a.height || 0;
    if (!w && !h) { w = natW || 300; h = natH || 200; } else if (!w) w = natH ? (h * natW) / natH : h * 1.5;
    else if (!h) h = natW ? (w * natH) / natW : w / 1.5;
    const maxW = this.textWidthTw / 20;
    if (w > maxW && a.wrap === 'inline') { h = (h * maxW) / w; w = maxW; }
    const cx = Math.max(1, Math.round(w * 12700)), cy = Math.max(1, Math.round(h * 12700));
    const id = this.docPrId++;
    const name = `Picture ${id}`;
    const alt = esc(a.alt || '');
    const title = a.title ? ` title="${esc(a.title)}"` : '';
    const hlink = a.link ? `<a:hlinkClick xmlns:a="${NS.a}" r:id="${this.rels.add(REL.hyperlink, String(a.link), true)}"/>` : '';
    const docPr = `<wp:docPr id="${id}" name="${name}" descr="${alt}"${title}>${hlink}</wp:docPr>`;
    let rot = Math.round((+a.rotate || 0) * 60000) % 21600000;
    if (rot < 0) rot += 21600000;
    const xfrmAttrs = `${rot ? ` rot="${rot}"` : ''}${a.flipH ? ' flipH="1"' : ''}${a.flipV ? ' flipV="1"' : ''}`;
    const blipExt = svgRid ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="${NS.asvg}" r:embed="${svgRid}"/></a:ext></a:extLst>` : '';
    const graphic = `<a:graphic xmlns:a="${NS.a}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="${NS.pic}">` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(media.name)}" descr="${alt}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}">${blipExt}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr bwMode="auto"><a:xfrm${xfrmAttrs}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic>';
    const frame = `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`;
    const wrap = a.wrap || 'inline';
    let drawing: string;
    if (wrap === 'inline') {
      drawing = `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${docPr}${frame}${graphic}</wp:inline>`;
    } else {
      const align = wrap === 'right' ? 'right' : wrap === 'center' ? 'center' : 'left';
      const wrapEl = wrap === 'left' || wrap === 'right' ? '<wp:wrapSquare wrapText="bothSides"/>' : wrap === 'center' || wrap === 'topBottom' ? '<wp:wrapTopAndBottom/>' : '<wp:wrapNone/>';
      const behind = wrap === 'behind' ? 1 : 0;
      drawing = `<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="${behind}" locked="0" layoutInCell="1" allowOverlap="1">` +
        `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:align>${align}</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrapEl}${docPr}${frame}${graphic}</wp:anchor>`;
    }
    return `<w:r>${rPr}<w:drawing>${drawing}</w:drawing></w:r>`;
  }

  // ---------------------------------------------------------------------------------------
  // Blocks

  private blocks(nodes: PMNode, ctx: BCtx): string {
    let out = '';
    let prev: PMNode | null = null;
    nodes.forEach((n) => {
      // Adjacent tables merge into one in Word/LibreOffice: keep them apart with a hidden empty paragraph.
      if (prev && prev.type === N.table && n.type === N.table) out += TABLE_SEPARATOR;
      out += this.block(n, ctx);
      if (ctx.top) this.topWritten++;
      prev = n;
    });
    return out;
  }

  private block(node: PMNode, ctx: BCtx): string {
    const a = node.attrs;
    const inner: BCtx = { ...ctx, top: false };
    switch (node.type.name) {
      case 'paragraph': return this.paragraph(node, inner);
      case 'code_block': {
        const id = this.useStyle('Code');
        return node.textContent.split('\n').map((line) => `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr>${textRun(line, '')}</w:p>`).join('');
      }
      case 'horizontal_rule': {
        const val = a.style === 'double' ? 'double' : a.style === 'dotted' ? 'dotted' : a.style === 'dashed' ? 'dashed' : 'single';
        const b: OoxmlBorder = { val, sz: Math.max(2, Math.round((+a.weight || 1) * 8)), color: this.color(a.color) || 'auto' };
        return `<w:p>${pPrXml({ borders: { bottom: b }, spaceBefore: 0, spaceAfter: 0 })}</w:p>`;
      }
      case 'page_break': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      case 'column_break': return '<w:p><w:r><w:br w:type="column"/></w:r></w:p>';
      case 'section_break': {
        const x = `<w:p>${pPrXml({ sectPr: this.sectPr(this.secType, this.secCols, a.page) })}</w:p>`;
        this.secType = a.kind || 'nextPage';
        return x;
      }
      case 'bullet_list': case 'ordered_list': case 'task_list':
        return this.list(node, inner, 0, null);
      case 'table': return this.table(node, inner);
      case 'column_section': {
        let x = '';
        if (!(ctx.top && this.topWritten === 0)) x += `<w:p>${pPrXml({ sectPr: this.sectPr(this.secType, this.secCols, null) })}</w:p>`;
        this.secType = 'continuous';
        this.secCols = { count: Math.max(1, +a.count || 2), gap: a.gap ?? 36, rule: !!a.rule };
        x += this.blocks(node, inner);
        const isLast = ctx.top && this.doc.lastChild === node;
        if (!isLast) {
          x += `<w:p>${pPrXml({ sectPr: this.sectPr(this.secType, this.secCols, null) })}</w:p>`;
          this.secType = 'continuous';
          this.secCols = { count: 1, gap: 36, rule: false };
        }
        return x;
      }
      case 'text_box': {
        const ob = cssBorderToOoxml(a.border, this.accent);
        const box: BCtx['box'] = { borders: ob ? { top: { ...ob, space: 4 }, left: { ...ob, space: 4 }, bottom: { ...ob, space: 4 }, right: { ...ob, space: 4 } } : {}, bg: this.color(a.bg) || null };
        const opts: Record<string, unknown> = {};
        for (const k of ['float', 'width', 'border', 'bg', 'padding', 'kind', 'rotate', 'radius', 'shadow'] as const) {
          const v = a[k];
          const def = (N.text_box.spec.attrs as any)[k]?.default;
          if (v !== def && v != null) opts[k] = v;
        }
        let body = this.blocks(node, { ...inner, box });
        if (!/<w:p[ >]/.test(body)) body += '<w:p/>';
        const tag = 'qf:textbox' + (Object.keys(opts).length ? ':' + JSON.stringify(opts) : '');
        return `<w:sdt><w:sdtPr><w:alias w:val="Text Box"/><w:tag w:val="${esc(tag)}"/><w:id w:val="${100000 + this.annot++}"/></w:sdtPr><w:sdtContent>${body}</w:sdtContent></w:sdt>`;
      }
      case 'gen_block': return this.genBlock(node);
      case 'math_block': return `<w:p>${pPrXml({ align: 'center' })}<m:oMathPara><m:oMath>${latexToOmml(a.latex)}</m:oMath></m:oMathPara></w:p>`;
      default:
        if (node.isTextblock) return this.paragraph(schema.nodes.paragraph.create(null, node.content), inner);
        if (node.isLeaf) return node.textContent ? `<w:p>${textRun(node.textContent, '')}</w:p>` : '';
        return this.blocks(node, inner);
    }
  }

  private list(list: PMNode, ctx: BCtx, level: number, numId: number | null): string {
    const id = numId ?? this.numbering.forList(list);
    const ilvl = Math.min(8, level);
    this.useStyle('List Paragraph');
    let out = '';
    list.forEach((item) => {
      let first = true;
      item.forEach((child) => {
        if (first && child.type === N.paragraph) {
          if (list.type === N.task_list) {
            const ctl = N.control.create({ kind: 'checkbox', value: item.attrs.checked ? 'true' : 'false' });
            out += this.paragraph(child, { ...ctx, list: { numId: id, ilvl } }, this.control(ctl, '') + textRun(' ', ''));
          } else out += this.paragraph(child, { ...ctx, list: { numId: id, ilvl } });
        } else if (isList(child)) out += this.list(child, ctx, level + 1, id);
        else if (child.type === N.paragraph) out += this.paragraph(child, { ...ctx, listCont: { ilvl } });
        else if (child.type === N.code_block) {
          // Indented like the item's text, so that the importer keeps it in the item.
          const id = this.useStyle('Code');
          out += child.textContent.split('\n').map((line) => `<w:p><w:pPr><w:pStyle w:val="${id}"/><w:ind w:left="${ptToTwip(36 * (ilvl + 1))}"/></w:pPr>${textRun(line, '')}</w:p>`).join('');
        } else out += this.block(child, ctx);
        first = false;
      });
    });
    return out;
  }

  private table(node: PMNode, ctx: BCtx): string {
    const a = node.attrs;
    let map: TableMap | null = null;
    try { map = TableMap.get(node); } catch { map = null; }
    const width = map ? map.width : Math.max(1, ...childrenOf(node).map((r) => childrenOf(r).reduce((s, c) => s + (c.attrs.colspan || 1), 0)));
    const height = node.childCount;
    // Column widths in twips.
    const colPx: (number | null)[] = new Array(width).fill(null);
    if (map) {
      for (let i = 0; i < map.map.length; i++) {
        const pos = map.map[i];
        const cell = node.nodeAt(pos);
        if (!cell) continue;
        const rect = map.findCell(pos);
        const col = i % width;
        const cw = cell.attrs.colwidth as number[] | null;
        if (cw && cw[col - rect.left] && colPx[col] == null) colPx[col] = cw[col - rect.left];
      }
    }
    const known = colPx.filter((x): x is number => x != null);
    const avail = Math.round(this.textWidthTw);
    const fallback = known.length ? Math.max(300, Math.round((avail - known.reduce((s, x) => s + x * 15, 0)) / Math.max(1, width - known.length))) : Math.round(avail / width);
    const colTw = colPx.map((px) => (px != null ? Math.round(px * 15) : Math.max(300, fallback)));
    const styleName = BUILTIN_STYLES.some((s) => s.name === a.style && s.type === 'table') || this.styleMap[a.style]?.type === 'table' ? a.style : 'Table Grid';
    const look = (a.headerRows > 0 ? 0x20 : 0) | (a.lastRow ? 0x40 : 0) | (a.firstCol ? 0x80 : 0) | (a.lastCol ? 0x100 : 0) | (a.banded ? 0 : 0x200) | (a.bandedCols ? 0 : 0x400);
    let tblW = '<w:tblW w:w="0" w:type="auto"/>';
    if (typeof a.width === 'string' && /%$/.test(a.width)) tblW = `<w:tblW w:w="${Math.round(parseFloat(a.width) * 50)}" w:type="pct"/>`;
    else if (a.width && Number.isFinite(+a.width)) tblW = `<w:tblW w:w="${ptToTwip(+a.width)}" w:type="dxa"/>`;
    const jc = a.align === 'center' ? '<w:jc w:val="center"/>' : a.align === 'right' ? '<w:jc w:val="right"/>' : '';
    const ind = a.indent ? `<w:tblInd w:w="${ptToTwip(+a.indent)}" w:type="dxa"/>` : '';
    const layout = a.layout === 'fixed' ? '<w:tblLayout w:type="fixed"/>' : '';
    const tblLook = `<w:tblLook w:val="${look.toString(16).toUpperCase().padStart(4, '0')}" w:firstRow="${a.headerRows > 0 ? 1 : 0}" w:lastRow="${a.lastRow ? 1 : 0}" w:firstColumn="${a.firstCol ? 1 : 0}" w:lastColumn="${a.lastCol ? 1 : 0}" w:noHBand="${a.banded ? 0 : 1}" w:noVBand="${a.bandedCols ? 0 : 1}"/>`;
    let x = `<w:tbl><w:tblPr><w:tblStyle w:val="${this.useStyle(styleName)}"/>${tblW}${jc}${ind}${layout}${tblLook}</w:tblPr>`;
    x += `<w:tblGrid>${colTw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    const cellCtx: BCtx = { inTable: true };
    const cellBody = (cell: PMNode) => {
      let body = this.blocks(cell, cellCtx);
      if (!body || /<\/w:tbl>$/.test(body) || !/<w:p[ >/]/.test(body)) body += '<w:p/>';
      return body;
    };
    const tcPr = (cell: PMNode | null, left: number, span: number, vMerge: string) => {
      const w = colTw.slice(left, left + span).reduce((s, v) => s + v, 0);
      let p = `<w:tcW w:w="${w}" w:type="dxa"/>`;
      if (span > 1) p += `<w:gridSpan w:val="${span}"/>`;
      p += vMerge;
      if (cell) {
        const ca = cell.attrs;
        if (ca.borders) {
          try {
            const b = JSON.parse(ca.borders);
            let bx = '';
            for (const side of ['top', 'left', 'bottom', 'right'] as const) { const ob = cssBorderToOoxml(b[side], this.accent); if (ob) bx += borderEl(side, ob, 0); }
            if (bx) p += `<w:tcBorders>${bx}</w:tcBorders>`;
          } catch { /* ignore */ }
        }
        const bg = this.color(ca.background);
        if (bg) p += `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>`;
        if (ca.textDir && /^(btLr|tbRl|lrTb|tbLrV|tbRlV|lrTbV)$/.test(ca.textDir)) p += `<w:textDirection w:val="${ca.textDir}"/>`;
        const va = ca.valign === 'middle' || ca.valign === 'center' ? 'center' : ca.valign === 'bottom' ? 'bottom' : ca.valign === 'top' ? 'top' : null;
        if (va) p += `<w:vAlign w:val="${va}"/>`;
      }
      return `<w:tcPr>${p}</w:tcPr>`;
    };
    let headerRun: boolean = true;
    for (let r = 0; r < height; r++) {
      const row = node.child(r);
      const allHeader = row.childCount > 0 && childrenOf(row).every((c) => c.type === N.table_header);
      const isHeader: boolean = headerRun && (r < (a.headerRows || 0) || allHeader);
      headerRun = isHeader;
      x += `<w:tr>${isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
      if (map) {
        let c = 0;
        while (c < width) {
          const pos = map.map[r * width + c];
          const rect = map.findCell(pos);
          const cell = node.nodeAt(pos)!;
          const span = rect.right - rect.left;
          if (rect.left !== c) { c++; continue; }
          if (rect.top === r) x += `<w:tc>${tcPr(cell, c, span, rect.bottom - rect.top > 1 ? '<w:vMerge w:val="restart"/>' : '')}${cellBody(cell)}</w:tc>`;
          else x += `<w:tc>${tcPr(cell, c, span, '<w:vMerge/>')}<w:p/></w:tc>`;
          c = rect.right;
        }
      } else {
        let c = 0;
        row.forEach((cell) => {
          const span = cell.attrs.colspan || 1;
          x += `<w:tc>${tcPr(cell, c, span, '')}${cellBody(cell)}</w:tc>`;
          c += span;
        });
      }
      x += '</w:tr>';
    }
    return x + '</w:tbl>';
  }

  private genBlock(node: PMNode): string {
    const a = node.attrs;
    const opts = (a.options || {}) as Record<string, any>;
    const lines = htmlLines(a.cache || '');
    let instr: string;
    let style: (lvl: number) => string;
    switch (a.kind) {
      case 'toc': {
        const levels = Math.max(1, Math.min(9, parseInt(opts.levels ?? opts.maxLevel ?? opts.depth ?? 3, 10) || 3));
        instr = `TOC \\o "1-${levels}" \\h \\z \\u`;
        style = (l) => this.useStyle(`TOC ${Math.min(3, Math.max(1, l))}`);
        this.hasTOC = true;
        break;
      }
      case 'tof': instr = `TOC \\h \\z \\c "${String(opts.label || opts.caption || 'Figure').replace(/"/g, '')}"`; style = () => this.useStyle('Table of Figures'); break;
      case 'index': instr = 'INDEX \\c "2"'; style = (l) => this.useStyle(l > 1 ? 'Index 2' : 'Index 1'); break;
      case 'bibliography': instr = 'BIBLIOGRAPHY'; style = () => this.useStyle('Bibliography'); break;
      case 'toa': instr = 'TOA \\h \\c "1" \\p'; style = () => this.useStyle('Normal'); break;
      case 'endnotes': return '';
      default:
        return lines.map((l) => `<w:p>${textRun(l.text, '')}</w:p>`).join('');
    }
    const entries = lines.length ? lines : [{ text: '', level: 1 }];
    const begin = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${esc(instr)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
    const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const tabs = a.kind === 'toc' || a.kind === 'tof' ? `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${Math.round(this.textWidthTw)}"/></w:tabs>` : '';
    return entries.map((l, i) => {
      const sid = style(l.level);
      const pPr = `<w:pPr>${sid && sid !== 'Normal' ? `<w:pStyle w:val="${sid}"/>` : ''}${tabs}</w:pPr>`;
      return `<w:p>${pPr}${i === 0 ? begin : ''}${textRun(l.text, '')}${i === entries.length - 1 ? end : ''}</w:p>`;
    }).join('');
  }

  // ---------------------------------------------------------------------------------------
  // Sections, headers and footers

  private sectPr(type: string, cols: { count: number; gap: number; rule: boolean }, override: Partial<PageSetup> | null): string {
    const s = this.settings;
    const page: PageSetup = { ...s.page, ...(override || {}), margin: { ...s.page.margin, ...((override && override.margin) || {}) } };
    const dims = pageDims(page);
    let x = this.hfRefs;
    if (s.footnoteFormat.foot && s.footnoteFormat.foot !== 'decimal') x += `<w:footnotePr><w:numFmt w:val="${PAGE_FMT_OUT[s.footnoteFormat.foot] || 'decimal'}"/></w:footnotePr>`;
    if (s.footnoteFormat.end) x += `<w:endnotePr><w:numFmt w:val="${PAGE_FMT_OUT[s.footnoteFormat.end] || 'lowerRoman'}"/></w:endnotePr>`;
    if (type && type !== 'nextPage' && ['continuous', 'evenPage', 'oddPage', 'nextColumn'].includes(type)) x += `<w:type w:val="${type}"/>`;
    x += `<w:pgSz w:w="${ptToTwip(dims.w)}" w:h="${ptToTwip(dims.h)}"${page.orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>`;
    x += `<w:pgMar w:top="${ptToTwip(page.margin.top)}" w:right="${ptToTwip(page.margin.right)}" w:bottom="${ptToTwip(page.margin.bottom)}" w:left="${ptToTwip(page.margin.left)}" w:header="${ptToTwip(page.headerDist ?? 36)}" w:footer="${ptToTwip(page.footerDist ?? 36)}" w:gutter="${ptToTwip(page.gutter || 0)}"/>`;
    const pb = cssBorderToOoxml(s.pageBorder, this.accent);
    if (pb) x += `<w:pgBorders w:offsetFrom="page">${borderEl('top', pb, 24)}${borderEl('left', pb, 24)}${borderEl('bottom', pb, 24)}${borderEl('right', pb, 24)}</w:pgBorders>`;
    if (s.lineNumbers?.enabled) x += `<w:lnNumType w:countBy="${Math.max(1, s.lineNumbers.countBy || 1)}" w:restart="${s.lineNumbers.restart === 'page' ? 'newPage' : 'continuous'}"/>`;
    const fmt = PAGE_FMT_OUT[s.pageNumber.format];
    if ((fmt && fmt !== 'decimal') || (s.pageNumber.start && s.pageNumber.start !== 1)) {
      x += `<w:pgNumType${fmt && fmt !== 'decimal' ? ` w:fmt="${fmt}"` : ''}${s.pageNumber.start && s.pageNumber.start !== 1 ? ` w:start="${s.pageNumber.start}"` : ''}/>`;
    }
    x += `<w:cols w:space="${ptToTwip(cols.gap ?? 36)}"${cols.count > 1 ? ` w:num="${cols.count}"` : ''}${cols.rule ? ' w:sep="1"' : ''}/>`;
    if (page.vAlign && page.vAlign !== 'top') x += `<w:vAlign w:val="${page.vAlign === 'justify' ? 'both' : page.vAlign}"/>`;
    if (s.differentFirst) x += '<w:titlePg/>';
    x += '<w:docGrid w:linePitch="360"/>';
    return `<w:sectPr>${x}</w:sectPr>`;
  }

  private hfIsEmpty(hf: HF): boolean {
    return !(hf.left || '').trim() && !(hf.center || '').trim() && !(hf.right || '').trim();
  }

  private tokenRuns(text: string, rPr: string): string {
    let out = '';
    const re = /\{([A-Z=]+)(?::([^}]*))?\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    const s = this.settings;
    while ((m = re.exec(text))) {
      out += textRun(text.slice(last, m.index), rPr);
      last = m.index + m[0].length;
      const [, t, arg] = m;
      let instr: string | null = null;
      let value = '';
      switch (t) {
        case 'PAGE': instr = `PAGE${arg ? ` \\* ${arg}` : ''} \\* MERGEFORMAT`; value = '1'; break;
        case 'NUMPAGES': instr = `NUMPAGES${arg ? ` \\* ${arg}` : ''} \\* MERGEFORMAT`; value = '1'; break;
        case 'DATE': instr = `DATE \\@ "${(arg || 'M/d/yyyy').replace(/"/g, '')}"`; value = new Date().toLocaleDateString('en-US'); break;
        case 'TIME': instr = `TIME \\@ "${(arg || 'h:mm am/pm').replace(/"/g, '')}"`; value = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); break;
        case 'TITLE': instr = 'TITLE \\* MERGEFORMAT'; value = s.properties.title || this.opts.title || this.opts.fileName.replace(/\.[^.]+$/, ''); break;
        case 'AUTHOR': instr = 'AUTHOR \\* MERGEFORMAT'; value = s.properties.author || this.opts.author || ''; break;
        case 'FILENAME': instr = 'FILENAME \\* MERGEFORMAT'; value = this.opts.fileName || ''; break;
        case 'SUBJECT': instr = 'SUBJECT \\* MERGEFORMAT'; value = s.properties.subject || ''; break;
        case 'SECTION': instr = 'SECTION'; value = '1'; break;
        case 'COMPANY': instr = 'DOCPROPERTY Company \\* MERGEFORMAT'; value = s.properties.company || ''; break;
        default: out += textRun(m[0], rPr); break;
      }
      if (instr) out += this.fieldRuns(instr, value, rPr);
    }
    out += textRun(text.slice(last), rPr);
    return out;
  }

  private hfPart(hf: HF, tag: 'hdr' | 'ftr'): string {
    const style = this.useStyle(tag === 'hdr' ? 'Header' : 'Footer');
    const font = this.settings.headerFooterFont ? this.fontName(this.settings.headerFooterFont) : undefined;
    const rPr = font ? rPrXml({ font }) : '';
    const L = (hf.left || '').split('\n'), C = (hf.center || '').split('\n'), R = (hf.right || '').split('\n');
    const n = Math.max(L.length, C.length, R.length);
    const tw = Math.round(this.textWidthTw);
    const tabs = `<w:tabs><w:tab w:val="center" w:pos="${Math.round(tw / 2)}"/><w:tab w:val="right" w:pos="${tw}"/></w:tabs>`;
    let body = '';
    for (let i = 0; i < n; i++) {
      const l = L[i] || '', c = C[i] || '', r = R[i] || '';
      let runs = this.tokenRuns(l, rPr);
      if (c || r) runs += `<w:r>${rPr}<w:tab/></w:r>` + this.tokenRuns(c, rPr);
      if (r) runs += `<w:r>${rPr}<w:tab/></w:r>` + this.tokenRuns(r, rPr);
      body += `<w:p><w:pPr><w:pStyle w:val="${style}"/>${tabs}</w:pPr>${runs}</w:p>`;
    }
    return XML_HEADER + `<w:${tag} ${ROOT_NS}>${body || `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr></w:p>`}</w:${tag}>`;
  }

  private buildHeadersFooters(): void {
    const s = this.settings;
    let n = 0;
    const add = (hf: HF, tag: 'hdr' | 'ftr', type: string, force: boolean) => {
      if (!force && this.hfIsEmpty(hf)) return;
      n++;
      const kind = tag === 'hdr' ? 'header' : 'footer';
      const file = `${kind}${n}.xml`;
      this.zip.file(`word/${file}`, this.hfPart(hf, tag));
      this.contentTypes.set(`/word/${file}`, tag === 'hdr' ? CT.header : CT.footer);
      const rid = this.rels.add(tag === 'hdr' ? REL.header : REL.footer, file);
      this.hfRefs += `<w:${kind}Reference w:type="${type}" r:id="${rid}"/>`;
    };
    // Schema order: all headerReference/footerReference elements come first (any order among them).
    add(s.header, 'hdr', 'default', false);
    if (s.differentOddEven) add(s.evenHeader, 'hdr', 'even', true);
    if (s.differentFirst) add(s.firstHeader, 'hdr', 'first', true);
    add(s.footer, 'ftr', 'default', false);
    if (s.differentOddEven) add(s.evenFooter, 'ftr', 'even', true);
    if (s.differentFirst) add(s.firstFooter, 'ftr', 'first', true);
  }

  // ---------------------------------------------------------------------------------------
  // Parts

  private stylesXml(): string {
    const map = this.styleMap;
    const need = new Set<string>(['Normal', 'Default Paragraph Font', ...this.usedStyles]);
    for (const s of BUILTIN_STYLES) if (s.quick && s.type !== 'table') need.add(s.name);
    for (const name of Object.keys(this.settings.styles || {})) need.add(name);
    for (let i = 1; i <= 3; i++) need.add(`Heading ${i}`);
    // Close over basedOn.
    for (const name of [...need]) {
      let cur = map[name];
      for (let i = 0; cur && cur.basedOn && i < 12; i++) { need.add(cur.basedOn); cur = map[cur.basedOn]; }
    }
    const normal = map.Normal || { name: 'Normal', type: 'paragraph' };
    const nFont = this.fontName(normal.font) || 'Calibri';
    const lang = esc(this.settings.language || 'en-US');
    let x = XML_HEADER + `<w:styles ${ROOT_NS}>`;
    x += `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${esc(nFont)}" w:eastAsia="${esc(nFont)}" w:hAnsi="${esc(nFont)}" w:cs="${esc(nFont)}"/><w:sz w:val="${Math.round((normal.size || 11) * 2)}"/><w:szCs w:val="${Math.round((normal.size || 11) * 2)}"/><w:lang w:val="${lang}" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`;
    x += '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>';
    x += '<w:latentStyles w:defLockedState="0" w:defUIPriority="99" w:defSemiHidden="0" w:defUnhideWhenUsed="0" w:defQFormat="0" w:count="376"/>';
    const written = new Set<string>();
    const order = ['Normal', ...[...need].filter((n) => n !== 'Normal')];
    for (const name of order) {
      if (written.has(name)) continue;
      written.add(name);
      if (name === 'Default Paragraph Font') {
        x += `<w:style w:type="character" w:default="1" w:styleId="${this.sid(name)}"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`;
        continue;
      }
      const def = map[name];
      if (def) { x += this.styleXml(def); continue; }
      x += this.extraStyleXml(name);
    }
    x += '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>';
    x += '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>';
    return x + '</w:styles>';
  }

  /** Styles we need that are not in the editor's style map. */
  private extraStyleXml(name: string): string {
    const id = this.sid(name);
    const head = (type: string) => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${esc(wordStyleName(name))}"/>`;
    switch (name) {
      case 'Footnote Reference': case 'Endnote Reference':
        return head('character') + `<w:basedOn w:val="${this.sid('Default Paragraph Font')}"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>`;
      case 'Comment Reference':
        return head('character') + `<w:basedOn w:val="${this.sid('Default Paragraph Font')}"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>`;
      case 'Comment Text':
        return head('paragraph') + `<w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>`;
      default:
        return head('paragraph') + '<w:basedOn w:val="Normal"/><w:qFormat/></w:style>';
    }
  }

  private styleXml(def: StyleDef): string {
    const name = def.name;
    const id = this.sid(name);
    const type = def.type === 'linked' ? 'paragraph' : def.type;
    if (type === 'table') return this.tableStyleXml(def, id);
    let x = `<w:style w:type="${type}"${name === 'Normal' ? ' w:default="1"' : ''} w:styleId="${id}"><w:name w:val="${esc(wordStyleName(name))}"/>`;
    if (def.basedOn && this.styleMap[def.basedOn] && def.basedOn !== name) x += `<w:basedOn w:val="${this.sid(def.basedOn)}"/>`;
    else if (type === 'character' && name !== 'Default Paragraph Font') x += `<w:basedOn w:val="${this.sid('Default Paragraph Font')}"/>`;
    if (def.next && this.styleMap[def.next] && type === 'paragraph') x += `<w:next w:val="${this.sid(def.next)}"/>`;
    if (/^Heading \d$/.test(name)) x += `<w:uiPriority w:val="9"/>`;
    if (def.hidden) x += '<w:semiHidden/>';
    if (def.quick || name === 'Normal' || /^Heading \d$/.test(name)) x += '<w:qFormat/>';
    if (type === 'paragraph') {
      const p: ParaProps = {};
      if (def.keepNext) p.keepNext = true;
      if (def.keepLines) p.keepLines = true;
      if (def.pageBreakBefore) p.pageBreakBefore = true;
      if (name === 'Normal') p.widowControl = true;
      const borders: ParaProps['borders'] = {};
      const bt = cssBorderToOoxml(def.borderTop, this.accent); if (bt) borders.top = bt;
      const bb = cssBorderToOoxml(def.borderBottom, this.accent); if (bb) borders.bottom = bb;
      const bl = cssBorderToOoxml(def.borderLeft, this.accent); if (bl) borders.left = { ...bl, space: 4 };
      if (Object.keys(borders).length) p.borders = borders;
      const bg = this.color(def.bg); if (bg) p.bg = bg;
      if (def.spaceBefore != null) p.spaceBefore = def.spaceBefore;
      if (def.spaceAfter != null) p.spaceAfter = def.spaceAfter;
      p.line = lineSpacing(def.lineHeight);
      if (def.indentLeft != null) p.indentLeft = def.indentLeft;
      if (def.indentRight != null) p.indentRight = def.indentRight;
      if (def.indentFirst != null) p.indentFirst = def.indentFirst;
      if (name === 'List Paragraph') p.contextualSpacing = true;
      p.align = alignOut(def.align);
      if (def.outlineLevel != null && def.outlineLevel >= 1 && def.outlineLevel <= 9) p.outlineLevel = def.outlineLevel - 1;
      x += pPrXml(p);
    }
    const r: RunProps = {};
    if (def.font) r.font = this.fontName(def.font);
    if (def.size) r.size = def.size;
    if (def.bold !== undefined) r.bold = def.bold;
    if (def.italic !== undefined) r.italic = def.italic;
    if (def.caps !== undefined) r.caps = def.caps;
    if (def.smallCaps !== undefined) r.smallCaps = def.smallCaps;
    const c = this.color(def.color); if (c) r.color = c;
    if (def.spacing) r.spacing = def.spacing;
    if (def.underline) r.underline = { style: 'single' };
    if (def.highlight) { const h = this.color(def.highlight); if (h) { const hn = highlightName(h); if (hn) r.highlight = hn; else r.shading = h; } }
    if (type === 'character' && (def as any).bg) { const b = this.color((def as any).bg); if (b) r.shading = b; }
    x += rPrXml(r);
    return x + '</w:style>';
  }

  private tableStyleXml(def: StyleDef, id: string): string {
    const color = this.color(def.borderColor) || '000000';
    const kind = def.borders || 'all';
    const on = (n: string) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="${color}"/>`;
    const off = (n: string) => `<w:${n} w:val="nil"/>`;
    const sides: Record<string, boolean> = {
      top: kind !== 'none', left: kind === 'all' || kind === 'outer', bottom: kind !== 'none', right: kind === 'all' || kind === 'outer',
      insideH: kind === 'all' || kind === 'horizontal', insideV: kind === 'all',
    };
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => (sides[s] ? on(s) : off(s))).join('');
    let x = `<w:style w:type="table" w:styleId="${id}"><w:name w:val="${esc(def.name)}"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>`;
    x += '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>';
    x += `<w:tblPr><w:tblStyleRowBandSize w:val="1"/><w:tblStyleColBandSize w:val="1"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>`;
    const hb = this.color(def.headerBg), hc = this.color(def.headerColor);
    if (def.headerBg) {
      x += `<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/>${hc ? `<w:color w:val="${hc}"/>` : ''}</w:rPr>${hb ? `<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${hb}"/></w:tcPr>` : ''}</w:tblStylePr>`;
    }
    const band = this.color(def.bandBg);
    if (band) x += `<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${band}"/></w:tcPr></w:tblStylePr>`;
    return x + '</w:style>';
  }

  private settingsXml(): string {
    const s = this.settings;
    let x = XML_HEADER + `<w:settings ${ROOT_NS}><w:zoom w:percent="100"/>`;
    if (s.pageColor) x += '<w:displayBackgroundShape/>';
    if (s.page.mirror) x += '<w:mirrorMargins/>';
    if (this.hasRevisions || s.protection?.mode === 'tracked') x += '<w:trackRevisions/>';
    const prot: Record<string, string> = { readonly: 'readOnly', comments: 'comments', tracked: 'trackedChanges', forms: 'forms' };
    if (s.protection && prot[s.protection.mode]) x += `<w:documentProtection w:edit="${prot[s.protection.mode]}" w:enforcement="1"/>`;
    x += `<w:defaultTabStop w:val="${ptToTwip(s.defaultTab || 36)}"/>`;
    if (s.hyphenation) x += '<w:autoHyphenation/>';
    if (s.differentOddEven) x += '<w:evenAndOddHeaders/>';
    x += '<w:characterSpacingControl w:val="doNotCompress"/>';
    if (this.footnotes.length) x += '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>';
    if (this.endnotes.length) x += '<w:endnotePr><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>';
    x += '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/><w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat>';
    const vars = Object.entries(s.variables || {});
    if (vars.length) x += `<w:docVars>${vars.map(([k, v]) => `<w:docVar w:name="${esc(k)}" w:val="${esc(v)}"/>`).join('')}</w:docVars>`;
    x += `<w:themeFontLang w:val="${esc(s.language || 'en-US')}"/>`;
    return x + '</w:settings>';
  }

  private notesXml(tag: 'footnote' | 'endnote', items: string[]): string {
    const root = tag === 'footnote' ? 'footnotes' : 'endnotes';
    return XML_HEADER + `<w:${root} ${ROOT_NS}>` +
      `<w:${tag} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${tag}>` +
      `<w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>` +
      items.join('') + `</w:${root}>`;
  }

  private commentsXml(): { comments: string; ext: string } {
    let c = '';
    let e = '';
    const textStyle = this.useStyle('Comment Text');
    const refStyle = this.useStyle('Comment Reference');
    let paraSeed = 0x10000000;
    const one = (num: number, cm: { author: string; date: number; text: string }, parentPara: string | null, done: boolean) => {
      const paraId = (paraSeed += 0x101).toString(16).toUpperCase().padStart(8, '0');
      const author = cm.author || 'Unknown';
      const initials = author.split(/\s+/).map((p) => p[0] || '').join('').slice(0, 3).toUpperCase();
      const lines = String(cm.text || '').split('\n');
      const paras = lines.map((line, i) => {
        const last = i === lines.length - 1;
        return `<w:p${last ? ` w14:paraId="${paraId}" w14:textId="77777777"` : ''}><w:pPr><w:pStyle w:val="${textStyle}"/></w:pPr>${i === 0 ? `<w:r><w:rPr><w:rStyle w:val="${refStyle}"/></w:rPr><w:annotationRef/></w:r>` : ''}${textRun(line, '')}</w:p>`;
      }).join('');
      c += `<w:comment w:id="${num}" w:author="${esc(author)}" w:date="${isoDate(cm.date)}" w:initials="${esc(initials)}">${paras}</w:comment>`;
      e += `<w15:commentEx w15:paraId="${paraId}"${parentPara ? ` w15:paraIdParent="${parentPara}"` : ''} w15:done="${done ? 1 : 0}"/>`;
      return paraId;
    };
    for (const [id, num] of this.commentNums) {
      const data: CommentData = this.settings.comments[id] || { id, author: this.opts.author || 'Unknown', date: Date.now(), text: '', resolved: false, replies: [] };
      const pid = one(num, data, null, !!data.resolved);
      const replies = this.replyNums.get(id) || [];
      (data.replies || []).forEach((rep, i) => { if (replies[i] != null) one(replies[i], rep, pid, !!data.resolved); });
    }
    return {
      comments: XML_HEADER + `<w:comments ${ROOT_NS}>${c}</w:comments>`,
      ext: XML_HEADER + `<w15:commentsEx ${ROOT_NS}>${e}</w15:commentsEx>`,
    };
  }

  private propsXml(): { core: string; app: string; custom: string | null } {
    const p = this.settings.properties || ({} as Record<string, string>);
    const now = isoDate(Date.now());
    const el = (tag: string, v: string | undefined) => (v ? `<${tag}>${esc(v)}</${tag}>` : '');
    const title = p.title || this.opts.title || '';
    const author = p.author || this.opts.author || '';
    const core = XML_HEADER + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      el('dc:title', title) + el('dc:subject', p.subject) + el('dc:creator', author) + el('cp:keywords', p.keywords) + el('dc:description', p.comments) +
      el('cp:lastModifiedBy', this.opts.author || author) + '<cp:revision>1</cp:revision>' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      el('cp:category', p.category) + el('cp:contentStatus', p.status) + '</cp:coreProperties>';
    const app = XML_HEADER + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Template>Normal.dotm</Template><TotalTime>0</TotalTime><Application>Anne\'s Pen</Application><DocSecurity>0</DocSecurity>' +
      el('Manager', p.manager) + el('Company', p.company) + '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>';
    const customEntries = Object.entries(this.settings.customProps || {});
    const custom = customEntries.length
      ? XML_HEADER + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        customEntries.map(([k, v], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${esc(k)}"><vt:lpwstr>${esc(v)}</vt:lpwstr></property>`).join('') + '</Properties>'
      : null;
    return { core, app, custom };
  }

  // ---------------------------------------------------------------------------------------

  build(): JSZip {
    this.buildHeadersFooters();
    let body = this.blocks(this.doc, { top: true });
    if (this.openComments.size) {
      // Ranges that never closed (should not happen): close them at the end.
      body += `<w:p>${[...this.openComments].map((id) => this.commentMarkers(id, 'end')).join('')}</w:p>`;
      this.openComments.clear();
    }
    if (!body || /<\/w:tbl>$/.test(body) || /<\/w:sdt>$/.test(body)) body += '<w:p/>';
    body += this.sectPr(this.secType, this.secCols, null);
    const bg = this.color(this.settings.pageColor);
    const documentXml = XML_HEADER + `<w:document ${ROOT_NS}>${bg ? `<w:background w:color="${bg}"/>` : ''}<w:body>${body}</w:body></w:document>`;

    const z = this.zip;
    const ct = this.contentTypes;
    ct.set('/word/document.xml', CT.main);
    z.file('word/document.xml', documentXml);

    if (this.numbering.nums.length) {
      z.file('word/numbering.xml', this.numbering.xml());
      ct.set('/word/numbering.xml', CT.numbering);
      this.rels.add(REL.numbering, 'numbering.xml');
    }
    if (this.footnotes.length) {
      z.file('word/footnotes.xml', this.notesXml('footnote', this.footnotes));
      ct.set('/word/footnotes.xml', CT.footnotes);
      this.rels.add(REL.footnotes, 'footnotes.xml');
    }
    if (this.endnotes.length) {
      z.file('word/endnotes.xml', this.notesXml('endnote', this.endnotes));
      ct.set('/word/endnotes.xml', CT.endnotes);
      this.rels.add(REL.endnotes, 'endnotes.xml');
    }
    if (this.commentNums.size) {
      const { comments, ext } = this.commentsXml();
      z.file('word/comments.xml', comments);
      z.file('word/commentsExtended.xml', ext);
      ct.set('/word/comments.xml', CT.comments);
      ct.set('/word/commentsExtended.xml', CT.commentsExtended);
      this.rels.add(REL.comments, 'comments.xml');
      this.rels.add(REL.commentsExtended, 'commentsExtended.xml');
    }
    // Styles last: every part above may have registered styles it uses.
    z.file('word/styles.xml', this.stylesXml());
    ct.set('/word/styles.xml', CT.styles);
    this.rels.add(REL.styles, 'styles.xml');
    z.file('word/settings.xml', this.settingsXml());
    ct.set('/word/settings.xml', CT.settings);
    this.rels.add(REL.settings, 'settings.xml');
    z.file('word/_rels/document.xml.rels', this.rels.xml());

    const props = this.propsXml();
    z.file('docProps/core.xml', props.core);
    z.file('docProps/app.xml', props.app);
    ct.set('/docProps/core.xml', CT.core);
    ct.set('/docProps/app.xml', CT.app);
    const root = new Rels();
    root.add(REL.officeDocument, 'word/document.xml');
    root.add(REL.coreProps, 'docProps/core.xml');
    root.add(REL.extProps, 'docProps/app.xml');
    if (props.custom) {
      z.file('docProps/custom.xml', props.custom);
      ct.set('/docProps/custom.xml', CT.custom);
      root.add(REL.customProps, 'docProps/custom.xml');
    }
    z.file('_rels/.rels', root.xml());

    const defaults: Record<string, string> = { rels: CT.rels, xml: 'application/xml' };
    z.forEach((path) => {
      const m = /^word\/media\/.+\.([a-z0-9]+)$/i.exec(path);
      if (m) {
        const ext = m[1].toLowerCase();
        defaults[ext] = ext === 'svg' ? 'image/svg+xml' : ext === 'jpeg' || ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      }
    });
    const types = XML_HEADER + `<Types xmlns="${NS.ct}">` +
      Object.entries(defaults).map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('') +
      [...ct.entries()].map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('') + '</Types>';
    z.file('[Content_Types].xml', types);
    return z;
  }
}

function childrenOf(n: PMNode): PMNode[] {
  const out: PMNode[] = [];
  n.forEach((c) => out.push(c));
  return out;
}

/** Export an Anne's Pen document as a .docx Blob. */
export async function exportDocx(doc: PMNode, opts: ExportOptions): Promise<Blob> {
  const w = new DocxWriter(doc, opts);
  await w.prepareMedia();
  const zip = w.build();
  const buf = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: DOCX_MIME });
  return new Blob([buf], { type: DOCX_MIME });
}
