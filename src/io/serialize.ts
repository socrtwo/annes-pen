/**
 * Shared helpers for the file-format converters (HTML, Markdown, text, RTF, ODT, EPUB).
 *
 * - byte / base64 / data-URL / Blob utilities that work in browsers and in jsdom
 * - settings, color and font resolution
 * - footnote numbering and inline-atom text
 * - export preparation (drop tracked deletions, strip review marks, heading ids)
 * - a DOMSerializer-based "clean HTML" renderer used by HTML and EPUB export
 * - schema repair: turn loosely-built node trees into a valid `doc`
 * - nested-list builder used by importers that only know "paragraph at level n"
 */
import { escapeXmlText, stripInvalidXml } from './ooxml-util';
import { decodeAuto } from './encoding';
import { sanitizeGeneratedHtml } from '../util/sanitize';
import { DOMSerializer, Fragment, Mark, type Node as PMNode, type NodeType, type DOMOutputSpec } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { fixTables } from 'prosemirror-tables';
import { schema, styleLevel } from '../editor/schema';
import { defaultSettings, normalizeSettings, type DocSettings } from '../editor/settings';
import { formatNumber } from '../editor/plugins/decorations';
import { BUILTIN_STYLES, STYLE_SETS, resolveStyles, effectiveStyle } from '../editor/styles';

export const S = schema;
type Attrs = Record<string, any>;

// ---------------------------------------------------------------------------------------------
// Bytes, base64, data URLs, blobs

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(u8: Uint8Array | ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
}

/** Decode text: BOMs, BOM-less UTF-16, UTF-8, then the most plausible legacy encoding (see encoding.ts). */
export function decodeTextBytes(data: ArrayBuffer | Uint8Array): string {
  return decodeAuto(data);
}

export function bytesToBase64(u8: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  try {
    const clean = b64.replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = clean.length % 4 ? clean + '='.repeat(4 - (clean.length % 4)) : clean;
    const bin = atob(pad.replace(/=+$/, (m) => m.slice(0, 2)));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(u8: Uint8Array, lineLen = 128): string {
  const hex = '0123456789abcdef';
  const parts: string[] = [];
  let line = '';
  for (let i = 0; i < u8.length; i++) {
    line += hex[u8[i] >> 4] + hex[u8[i] & 15];
    if (line.length >= lineLen) { parts.push(line); line = ''; }
  }
  if (line) parts.push(line);
  return parts.join('\n');
}

export interface DataUrl { mime: string; bytes: Uint8Array }

export function parseDataUrl(url: string | null | undefined): DataUrl | null {
  if (!url || !/^data:/i.test(url)) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const parts = meta.split(';');
  const mime = (parts[0] || 'text/plain').toLowerCase();
  if (parts.some((p) => p.toLowerCase() === 'base64')) return { mime, bytes: base64ToBytes(data) };
  try {
    return { mime, bytes: utf8Encode(decodeURIComponent(data)) };
  } catch {
    return { mime, bytes: utf8Encode(data) };
  }
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/x-emf': 'emf', 'image/x-wmf': 'wmf',
  'image/avif': 'avif', 'image/x-icon': 'ico',
};

export function extForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] || 'bin';
}

export function mimeForName(name: string): string {
  const ext = name.toLowerCase().replace(/[?#].*$/, '').split('.').pop() || '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
    webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf',
    avif: 'image/avif', ico: 'image/x-icon',
    xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'application/xml',
    ncx: 'application/x-dtbncx+xml', otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
  };
  return map[ext] || 'application/octet-stream';
}

/** Sniff an image type from its magic bytes. */
export function sniffImageMime(u8: Uint8Array): string | null {
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
  if (u8.length >= 2 && u8[0] === 0x42 && u8[1] === 0x4d) return 'image/bmp';
  if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45) return 'image/webp';
  if (u8.length >= 5) {
    const head = String.fromCharCode(...Array.from(u8.subarray(0, Math.min(200, u8.length)))).trimStart();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  }
  return null;
}

/** Intrinsic pixel size of PNG / JPEG / GIF / BMP data. */
export function imagePixelSize(u8: Uint8Array): { w: number; h: number } | null {
  try {
    const mime = sniffImageMime(u8);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (mime === 'image/png' && u8.length >= 24) return { w: dv.getUint32(16), h: dv.getUint32(20) };
    if (mime === 'image/gif' && u8.length >= 10) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    if (mime === 'image/bmp' && u8.length >= 26) return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < u8.length) {
        if (u8[i] !== 0xff) { i++; continue; }
        const marker = u8[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = dv.getUint16(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function makeBlob(data: string | Uint8Array, type: string): Blob {
  return new Blob([data as BlobPart], { type });
}

/** Read a Blob as bytes; works with browser Blobs and jsdom Blobs. */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const b = blob as any;
  if (typeof b.arrayBuffer === 'function') {
    try { return new Uint8Array(await b.arrayBuffer()); } catch { /* fall through */ }
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(blob);
    });
  }
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

export async function blobToText(blob: Blob): Promise<string> {
  return utf8Decode(await blobToBytes(blob));
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export function baseName(name: string): string {
  const n = (name || '').split(/[\\/]/).pop() || '';
  return n.replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------------------------------
// Escaping

/** Escape text for XML/HTML text and attribute content (also removes characters illegal in XML 1.0). */
export function escapeXml(s: string | null | undefined): string {
  if (s == null) return '';
  return escapeXmlText(String(s), '&#39;');
}
export const escapeHtml = escapeXml;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', bull: '•', middot: '·',
  deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  laquo: '«', raquo: '»', shy: '­', iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾', micro: 'µ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '‍',
  zwnj: '‌', dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', mu: 'μ', lambda: 'λ', theta: 'θ',
  check: '✓', hearts: '♥', star: '☆', minus: '−', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', acirc: 'â', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', Eacute: 'É', aring: 'å', Aring: 'Å', aelig: 'æ', oslash: 'ø', Oslash: 'Ø',
};

/** Decode a single HTML entity reference (without & and ;). Returns null if unknown. */
export function decodeEntity(name: string): string | null {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
    try { return String.fromCodePoint(code === 0 ? 0xfffd : code); } catch { return null; }
  }
  if (ENTITIES[name] != null) return ENTITIES[name];
  if (typeof document !== 'undefined' && /^[A-Za-z][A-Za-z0-9]{1,31}$/.test(name)) {
    try {
      const ta = document.createElement('textarea');
      ta.innerHTML = `&${name};`;
      if (ta.value !== `&${name};`) return ta.value;
    } catch { /* ignore */ }
  }
  return null;
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, n) => decodeEntity(n) ?? m);
}

// ---------------------------------------------------------------------------------------------
// Settings, colors, fonts

export function docSettings(doc: PMNode): DocSettings {
  return normalizeSettings(doc.attrs.settings);
}

export function newSettings(): DocSettings {
  return defaultSettings();
}

export function docTitle(doc: PMNode, opts: { fileName?: string; title?: string }): string {
  const s = docSettings(doc);
  return (opts.title || s.properties.title || baseName(opts.fileName || '') || 'Untitled').trim();
}

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', // both CSS keywords are valid and occur in documents
  silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00', teal: '#008080', navy: '#000080',
  purple: '#800080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', darkblue: '#00008b', darkred: '#8b0000',
  darkgreen: '#006400', darkcyan: '#008b8b', darkmagenta: '#8b008b', darkyellow: '#808000', lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', gold: '#ffd700', violet: '#ee82ee', indigo: '#4b0082',
  lightblue: '#add8e6', lightgreen: '#90ee90', lightyellow: '#ffffe0', orangered: '#ff4500', crimson: '#dc143c',
  tomato: '#ff6347', coral: '#ff7f50', salmon: '#fa8072', khaki: '#f0e68c', beige: '#f5f5dc', tan: '#d2b48c',
  turquoise: '#40e0d0', skyblue: '#87ceeb', steelblue: '#4682b4', royalblue: '#4169e1', slategray: '#708090',
};

export function shadeHex(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** Normalize any CSS color we are likely to meet into #rrggbb (lower case), or null. */
export function toHexColor(c: string | null | undefined, settings?: DocSettings): string | null {
  if (!c) return null;
  const v = String(c).trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'inherit' || v === 'initial' || v === 'none' || v === 'auto' || v === 'currentcolor') return null;
  let m = /^#?([0-9a-f]{6})$/.exec(v);
  if (m) return '#' + m[1];
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  m = /^#([0-9a-f]{6})[0-9a-f]{2}$/.exec(v);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] != null && parseFloat(m[4]) === 0) return null;
    const ch = (x: string) => Math.max(0, Math.min(255, Math.round(x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x))));
    return '#' + ((1 << 24) | (ch(m[1]) << 16) | (ch(m[2]) << 8) | ch(m[3])).toString(16).slice(1);
  }
  m = /^var\(\s*--qf-accent(\d)(-dark|-darker|-light|-pale)?\s*(?:,[^)]*)?\)$/.exec(v);
  if (m) {
    const acc = (settings || defaultSettings()).theme.accent;
    const base = acc[parseInt(m[1], 10) - 1] || acc[0];
    const amt: Record<string, number> = { '-dark': -0.25, '-darker': -0.5, '-light': 0.45, '-pale': 0.85 };
    return toHexColor(m[2] ? shadeHex(base, amt[m[2]]) : base);
  }
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  return null;
}

/** Resolve "+body"/"+heading" theme font references into a family name. */
export function resolveFontName(name: string | undefined | null, settings: DocSettings): string | null {
  if (!name) return null;
  if (name !== '+heading' && name !== '+body') return name;
  const set = STYLE_SETS[settings.styleSet] || STYLE_SETS.QuillPen;
  const fonts = set._fonts || [settings.theme.headingFont, settings.theme.bodyFont];
  if (name === '+heading') return settings.styleSet === 'QuillPen' ? settings.theme.headingFont : fonts[0];
  return settings.styleSet === 'QuillPen' ? settings.theme.bodyFont : fonts[1];
}

export function isMonospaceFont(f: string | null | undefined): boolean {
  return !!f && /mono|courier|cousine|consol|menlo|code/i.test(f);
}

// ---------------------------------------------------------------------------------------------
// Styles

const BUILTIN_NAMES = new Map<string, string>(BUILTIN_STYLES.map((s) => [s.name.toLowerCase(), s.name]));

const STYLE_ALIASES: Record<string, string> = {
  'standard': 'Normal', 'default': 'Normal', 'default style': 'Normal', 'default paragraph style': 'Normal', 'normal (web)': 'Normal',
  'normalweb': 'Normal', 'msonormal': 'Normal', 'text body': 'Body Text', 'textbody': 'Body Text', 'body text': 'Body Text',
  'first line indent': 'Body Text First Indent', 'hanging indent': 'Hanging Indent',
  'quotations': 'Quote', 'quotation': 'Quote', 'block quotation': 'Quote', 'msoquote': 'Quote', 'msointensequote': 'Intense Quote',
  'preformatted text': 'Plain Text', 'html preformatted': 'Plain Text', 'source text': 'Code', 'code': 'Code',
  'footnote': 'Footnote Text', 'footnote text': 'Footnote Text', 'endnote': 'Endnote Text', 'endnote text': 'Endnote Text',
  'contents heading': 'TOC Heading', 'toc heading': 'TOC Heading', 'msotitle': 'Title', 'msosubtitle': 'Subtitle',
  'msonospacing': 'No Spacing', 'no spacing': 'No Spacing', 'illustration': 'Caption', 'figure': 'Caption', 'drawing': 'Caption',
  'list paragraph': 'List Paragraph', 'mso list paragraph': 'List Paragraph', 'msolistparagraph': 'List Paragraph',
  'header': 'Header', 'footer': 'Footer', 'heading': 'Heading 1', 'subtitle': 'Subtitle', 'title': 'Title',
  'signature': 'Signature', 'salutation': 'Salutation', 'bibliography': 'Bibliography', 'index heading': 'Index Heading',
  'contents 1': 'TOC 1', 'contents 2': 'TOC 2', 'contents 3': 'TOC 3', 'toc 1': 'TOC 1', 'toc 2': 'TOC 2', 'toc 3': 'TOC 3',
};

/** Map a style name from another application onto an Anne's Pen built-in style name, or null. */
export function canonicalStyleName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.replace(/_20_/g, ' ').replace(/_5f_/g, '_').replace(/\s+/g, ' ').trim();
  const low = n.toLowerCase();
  let m = /^(?:heading|überschrift|titre|titolo|título|kop|rubrik)\s*(\d)$/.exec(low);
  if (m && +m[1] >= 1) return `Heading ${m[1]}`;
  m = /^msoheading(\d)$/.exec(low.replace(/\s/g, ''));
  if (m) return `Heading ${m[1]}`;
  if (STYLE_ALIASES[low]) return STYLE_ALIASES[low];
  if (BUILTIN_NAMES.has(low)) return BUILTIN_NAMES.get(low)!;
  return null;
}

export interface StyleCharDefaults { font: string | null; size: number | null; color: string | null; bold: boolean; italic: boolean }

/** Character formatting a paragraph style supplies by itself (used to drop redundant direct formatting on import). */
export function styleCharDefaults(styleName: string, settings: DocSettings): StyleCharDefaults {
  const map = resolveStyles(settings);
  const e = effectiveStyle(map, map[styleName] ? styleName : 'Normal');
  return {
    font: (resolveFontName(e.font, settings) || '').toLowerCase() || null,
    size: e.size ?? null,
    color: toHexColor(e.color, settings),
    bold: !!e.bold,
    italic: !!e.italic,
  };
}

/** Drop marks that merely restate what the paragraph style already provides. */
export function stripRedundantMarks(marks: readonly Mark[], d: StyleCharDefaults, defaultFont?: string | null): Mark[] {
  return marks.filter((m) => {
    switch (m.type.name) {
      case 'font': {
        const f = String(m.attrs.family || '').toLowerCase();
        return !(f === d.font || (defaultFont && f === defaultFont.toLowerCase() && !d.font));
      }
      case 'size': return !(d.size != null && Math.abs(m.attrs.pt - d.size) < 0.01);
      case 'color': return !(d.color && toHexColor(m.attrs.color) === d.color);
      case 'bold': return !d.bold;
      case 'italic': return !d.italic;
      default: return true;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Footnotes and inline atoms

export interface NoteInfo { pos: number; node: PMNode; label: string; kind: 'foot' | 'end'; text: string; index: number }

/** All footnotes/endnotes in document order with display labels (same numbering as the editor). */
export function collectFootnotes(doc: PMNode): NoteInfo[] {
  const settings = docSettings(doc);
  const out: NoteInfo[] = [];
  let f = 0, e = 0;
  doc.descendants((node, pos) => {
    if (node.type === S.nodes.footnote) {
      const kind = node.attrs.kind === 'end' ? 'end' : 'foot';
      const n = kind === 'end' ? ++e : ++f;
      const label = node.attrs.mark || formatNumber(n, kind === 'end' ? settings.footnoteFormat.end : settings.footnoteFormat.foot);
      out.push({ pos, node, label, kind, text: String(node.attrs.text || ''), index: out.length + 1 });
    }
    return true;
  });
  return out;
}

/** Plain-text rendition of an inline atom node (fields → value, citations → cached text...). */
export function inlineAtomText(node: PMNode): string {
  const a = node.attrs;
  switch (node.type.name) {
    case 'field': return String(a.value || '');
    case 'citation': return String(a.cache || '');
    case 'chip': return String(a.label || a.value || '');
    case 'control':
      if (a.kind === 'checkbox') return a.value === 'true' ? '☒' : '☐';
      return String(a.value || '');
    case 'symbol': return a.kind === 'optionalHyphen' ? '­' : '';
    case 'math_inline': return String(a.latex || '');
    case 'hard_break': return '\n';
    default: return '';
  }
}

/** Visible plain text of a block's inline content, with atoms rendered. */
export function inlineText(node: PMNode, opts: { footnote?: (n: PMNode) => string } = {}): string {
  let s = '';
  node.forEach((c) => {
    if (c.isText) s += c.text;
    else if (c.type === S.nodes.footnote) s += opts.footnote ? opts.footnote(c) : '';
    else if (c.isInline) s += inlineAtomText(c);
    else s += (s ? '\n' : '') + inlineText(c, opts);
  });
  return s;
}

/** Flatten generated-block cache HTML (TOC, bibliography...) into text lines. */
export function htmlToTextLines(html: string): string[] {
  if (!html) return [];
  try {
    const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const lines: string[] = [];
    const BLOCK = /^(P|LI|H[1-6]|DIV|TR|PRE|BLOCKQUOTE|DT|DD|SECTION|ARTICLE|TABLE|UL|OL)$/;
    const walk = (el: Element) => {
      if (el.tagName === 'TR') { lines.push([...el.children].map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()).join('\t')); return; }
      const hasBlockKids = [...el.children].some((c) => BLOCK.test(c.tagName));
      if (hasBlockKids) { [...el.children].forEach(walk); return; }
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    };
    walk(d.body);
    return lines;
  } catch {
    return [html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()];
  }
}

// ---------------------------------------------------------------------------------------------
// Export preparation

export interface PrepareOptions {
  /** Keep comment marks (ODT annotations). */
  keepComments?: boolean;
  /** Keep insertion/deletion marks instead of accepting insertions and dropping deletions. */
  keepRevisions?: boolean;
  /** Give every heading paragraph an id attribute (for TOCs / navigation). */
  headingIds?: boolean;
}

const REVIEW_MARKS = new Set(['insertion', 'deletion', 'formatChange', 'mergeHighlight']);

/** Return a copy of the document suitable for export (tracked deletions dropped, review marks stripped). */
export function prepareDoc(doc: PMNode, opts: PrepareOptions = {}): PMNode {
  let hid = 0;
  const used = new Set<string>();
  doc.descendants((n) => { if (n.attrs && typeof n.attrs.id === 'string' && n.attrs.id) used.add(n.attrs.id); return true; });
  const keepMark = (m: Mark): boolean => {
    const n = m.type.name;
    if (n === 'comment') return !!opts.keepComments;
    if (n === 'insertion' || n === 'deletion') return !!opts.keepRevisions;
    return !REVIEW_MARKS.has(n);
  };
  const map = (node: PMNode): PMNode | null => {
    if (node.isText) {
      if (!opts.keepRevisions && node.marks.some((m) => m.type.name === 'deletion')) return null;
      const marks = node.marks.filter(keepMark);
      return marks.length === node.marks.length ? node : node.mark(marks);
    }
    if (node.isInline && !opts.keepRevisions && node.marks.some((m) => m.type.name === 'deletion')) return null;
    let attrs = node.attrs;
    if (opts.headingIds && node.type === S.nodes.paragraph && styleLevel(node.attrs.style, node.attrs.outlineLevel) > 0 && !node.attrs.id) {
      let id: string;
      do id = `h-${++hid}`; while (used.has(id));
      used.add(id);
      attrs = { ...attrs, id };
    }
    if (node.isLeaf) {
      const marks = node.marks.filter(keepMark);
      return attrs === node.attrs && marks.length === node.marks.length ? node : node.type.create(attrs, null, marks);
    }
    const kids: PMNode[] = [];
    node.forEach((c) => { const r = map(c); if (r) kids.push(r); });
    return node.type.create(attrs, Fragment.fromArray(kids), node.marks);
  };
  return map(doc) || doc;
}

// ---------------------------------------------------------------------------------------------
// Clean HTML rendering (HTML + EPUB export)

export interface RenderedHtml {
  /** Container element holding the rendered content (in the given document). */
  container: HTMLElement;
  notes: NoteInfo[];
}

const EDITOR_CLASSES = new Set(['qf-img', 'qf-table', 'qf-code', 'qf-task', 'qf-comment', 'qf-ins', 'qf-del', 'qf-fmtchg', 'qf-hl',
  'qf-field', 'qf-cite', 'qf-chip', 'qf-control', 'qf-sym', 'qf-xe', 'ProseMirror-selectednode', 'selectedCell']);

export interface RenderOptions {
  /** Target document to create nodes in (defaults to a fresh HTML document). */
  document?: Document;
  /** href for a footnote target, given its 1-based index. */
  noteHref?: (n: NoteInfo) => string;
  /** id for a footnote reference, given its 1-based index. */
  noteRefId?: (n: NoteInfo) => string;
  /** Rewrite image sources (EPUB: extract data URLs into files). */
  imageSrc?: (src: string) => string;
  /** Mark noterefs with data-epub-noteref so EPUB can turn them into epub:type="noteref". */
  epub?: boolean;
}

/** Render a (prepared) document fragment into clean semantic HTML using the schema's DOMSerializer. */
export function renderHtml(content: Fragment, notes: NoteInfo[], opts: RenderOptions = {}): RenderedHtml {
  const tdoc = opts.document || document.implementation.createHTMLDocument('');
  const base = DOMSerializer.fromSchema(S);
  const used: NoteInfo[] = [];
  let noteIdx = 0;
  const href = opts.noteHref || ((n: NoteInfo) => `#fn-${n.index}`);
  const refId = opts.noteRefId || ((n: NoteInfo) => `fnref-${n.index}`);
  const nodes: Record<string, (node: PMNode) => DOMOutputSpec> = { ...base.nodes };
  // Plain-text renditions are emitted as marker spans and unwrapped afterwards (specs must be elements).
  const textSpec = (t: string): DOMOutputSpec => ['span', { 'data-qf-unwrap': '1' }, t];
  nodes.field = (n) => textSpec(String(n.attrs.value || ''));
  nodes.citation = (n) => ['span', { class: 'citation', 'data-sources': n.attrs.sources || null }, String(n.attrs.cache || '')];
  nodes.chip = (n) => ['span', { class: 'chip' }, String(n.attrs.label || n.attrs.value || '')];
  nodes.control = (n) => textSpec(inlineAtomText(n));
  nodes.symbol = (n) => textSpec(inlineAtomText(n));
  nodes.index_entry = () => textSpec('');
  nodes.bookmark = (n) => ['a', { id: 'bm-' + n.attrs.name, class: 'bookmark', 'data-name': n.attrs.name }];
  nodes.math_inline = (n) => ['span', { class: 'math', 'data-latex': n.attrs.latex }, `\\(${n.attrs.latex}\\)`];
  nodes.math_block = (n) => ['div', { class: 'math math-display', 'data-latex': n.attrs.latex }, `\\[${n.attrs.latex}\\]`];
  nodes.page_break = () => ['div', { class: 'page-break', style: 'break-after:page;page-break-after:always' }];
  nodes.column_break = () => ['div', { class: 'column-break', style: 'break-after:column' }];
  nodes.section_break = (n) => ['div', { class: 'section-break', 'data-kind': n.attrs.kind, style: n.attrs.kind === 'continuous' ? null : 'break-after:page;page-break-after:always' }];
  nodes.gen_block = (n) => {
    const div = tdoc.createElement('div');
    div.className = 'generated';
    div.setAttribute('data-kind', n.attrs.kind);
    // The cache comes from the document (a .qpd can hold anything): same allow-list as the editor.
    div.innerHTML = sanitizeGeneratedHtml(n.attrs.cache || '');
    return div;
  };
  nodes.footnote = (n) => {
    const info = notes.find((x) => x.node === n) || notes[noteIdx] || { pos: 0, node: n, label: String(noteIdx + 1), kind: 'foot', text: n.attrs.text, index: noteIdx + 1 } as NoteInfo;
    noteIdx++;
    used.push(info);
    const a: Attrs = { href: href(info), role: 'doc-noteref', class: 'footnote-ref' };
    if (opts.epub) a['data-epub-noteref'] = '1';
    return ['sup', { class: 'footnote', id: refId(info), 'data-kind': info.kind === 'end' ? 'end' : null }, ['a', a, info.label]];
  };
  const marks = { ...base.marks } as Record<string, any>;
  for (const k of ['comment', 'insertion', 'deletion', 'formatChange', 'mergeHighlight']) delete marks[k];
  const ser = new DOMSerializer(nodes as any, marks);
  const container = tdoc.createElement('div');
  container.className = 'ProseMirror';
  ser.serializeFragment(content, { document: tdoc }, container);
  // Post-process: unwrap text placeholders, strip editor-only attributes and classes.
  container.querySelectorAll('[data-qf-unwrap]').forEach((el) => {
    const parent = el.parentNode!;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  container.normalize();
  // An empty paragraph has no height in HTML: a line break gives it its line (the importer drops it again).
  container.querySelectorAll('p, h1, h2, h3, h4, h5, h6').forEach((el) => { if (!el.firstChild) el.appendChild(tdoc.createElement('br')); });
  container.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('contenteditable');
    el.removeAttribute('draggable');
    if (el.hasAttribute('class')) {
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && !EDITOR_CLASSES.has(c));
      if (cls.length) el.setAttribute('class', cls.join(' ')); else el.removeAttribute('class');
    }
    if (el.getAttribute('style') === '') el.removeAttribute('style');
    if (el.tagName === 'A' && el.getAttribute('title') === null && el.hasAttribute('title')) el.removeAttribute('title');
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || '';
      if (opts.imageSrc) el.setAttribute('src', opts.imageSrc(src));
      if (!el.hasAttribute('alt')) el.setAttribute('alt', '');
    }
    if (el.tagName === 'PRE') {
      const lang = el.getAttribute('data-language');
      const code = el.firstElementChild;
      if (lang && code && code.tagName === 'CODE') code.setAttribute('class', `language-${lang.replace(/\s+/g, '-')}`);
    }
    if (el.tagName === 'OL' && el.hasAttribute('start') && !/^-?\d+$/.test(el.getAttribute('start') || '')) el.removeAttribute('start');
    if (el.tagName === 'UL' && el.getAttribute('data-type') === 'task') el.setAttribute('class', 'task-list');
    if (el.tagName === 'LI' && el.hasAttribute('data-checked') && el.parentElement?.getAttribute('data-type') === 'task') {
      const box = tdoc.createElement('input');
      box.setAttribute('type', 'checkbox');
      box.setAttribute('disabled', 'disabled');
      if (el.getAttribute('data-checked') === 'true') box.setAttribute('checked', 'checked');
      const first = el.firstElementChild;
      if (first && first.tagName === 'P') first.insertBefore(box, first.firstChild); else el.insertBefore(box, el.firstChild);
      el.setAttribute('class', 'task-list-item');
    }
  });
  return { container, notes: used };
}

/** Serialize element children as XHTML (well-formed XML). */
export function toXhtml(el: Element): string {
  const ser = new XMLSerializer();
  let out = '';
  el.childNodes.forEach((c) => {
    const s = ser.serializeToString(c);
    // Each top-level element declares the XHTML namespace, which the page's <html> already does.
    // Only that start tag is touched: the same characters in text are content.
    out += c.nodeType === 1 ? s.replace(/^(<[^\s/>]+) xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/, '$1') : s;
  });
  // XHTML must be well-formed XML: drop characters XML 1.0 forbids (control chars, lone surrogates, U+FFFE/F).
  return stripInvalidXml(out);
}

/** Base CSS shared by HTML and EPUB exports (layout, tables, lists, notes). */
export function baseCss(settings: DocSettings, forEpub = false): string {
  const p = settings.page;
  const w = p.orientation === 'landscape' ? Math.max(p.width, p.height) : Math.min(p.width, p.height);
  const content = Math.max(144, w - p.margin.left - p.margin.right);
  const lines = [
    forEpub
      ? 'body{margin:0;padding:0 2%;}'
      : `html{background:#f3f3f3}body{margin:0;padding:24px 12px;color:#000;}
.qf-doc{box-sizing:border-box;max-width:${w}pt;margin:0 auto;padding:${p.margin.top}pt ${p.margin.right}pt ${p.margin.bottom}pt ${p.margin.left}pt;background:${settings.pageColor || '#fff'};box-shadow:0 1px 4px rgba(0,0,0,.2)}
.qf-doc .ProseMirror{max-width:${content}pt}
@media (max-width:${Math.round(w * 1.333)}px){.qf-doc{padding:24px 16px}}
@media print{html{background:none}body{padding:0}.qf-doc{box-shadow:none;padding:0;max-width:none}}`,
    '.qf-doc .ProseMirror{overflow-wrap:break-word;white-space:normal}',
    // Text keeps its tabs, runs of spaces and leading spaces, as in the editor.
    '.qf-doc p,.qf-doc h1,.qf-doc h2,.qf-doc h3,.qf-doc h4,.qf-doc h5,.qf-doc h6{margin:0;white-space:pre-wrap}',
    '.qf-doc img{max-width:100%;height:auto;vertical-align:baseline}',
    '.qf-doc img[data-wrap=left]{float:left;margin:0 12pt 6pt 0}.qf-doc img[data-wrap=right]{float:right;margin:0 0 6pt 12pt}.qf-doc img[data-wrap=center]{display:block;margin:6pt auto}',
    '.qf-doc table{border-collapse:collapse;margin:6pt 0;max-width:100%}.qf-doc td,.qf-doc th{padding:2pt 5.4pt;vertical-align:top;border:1px solid #000}.qf-doc td>p,.qf-doc th>p{padding:0}',
    '.qf-doc ul,.qf-doc ol{margin:0;padding-left:24pt}.qf-doc li>p{padding-bottom:0}',
    '.qf-doc ul.task-list{list-style:none;padding-left:6pt}.qf-doc ul.task-list input{margin:0 6pt 0 0}',
    '.qf-doc pre{font-family:Cousine,"Courier New",monospace;font-size:10pt;background:#f6f8fa;padding:6pt 8pt;white-space:pre-wrap;margin:6pt 0}',
    '.qf-doc code{font-family:Cousine,"Courier New",monospace;font-size:.92em}',
    '.qf-doc hr{border:0;border-top:1px solid #888;margin:6pt 0}',
    '.qf-doc .page-break,.qf-doc .section-break{break-after:page;page-break-after:always;height:0}',
    '.qf-doc .math{font-family:"Latin Modern Math","Cambria Math",serif}.qf-doc .math-display{display:block;text-align:center;margin:6pt 0}',
    '.qf-doc .qf-dstrike{text-decoration:line-through double}.qf-doc .qf-hidden{display:none}',
    '.qf-doc .qf-columns{margin:6pt 0}.qf-doc .qf-textbox{display:block;margin:6pt 0}',
    '.qf-doc .qf-textbox[data-float=left]{float:left;margin-right:12pt}.qf-doc .qf-textbox[data-float=right]{float:right;margin-left:12pt}',
    '.qf-doc sup.footnote a{text-decoration:none}',
    '.footnotes{margin-top:24pt;font-size:.9em}.footnotes hr{border:0;border-top:1px solid #888;width:33%;margin:0 0 6pt}.footnotes ol{padding-left:24pt;margin:0}.footnotes li p{margin:0 0 3pt}',
    '.footnotes a.footnote-back{text-decoration:none}',
    'aside.footnote p{margin:0;font-size:.9em}',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Node construction and repair

export function textNode(text: string, marks: readonly Mark[] = []): PMNode | null {
  if (!text) return null;
  return S.text(text, marks as Mark[]);
}

export function para(inlines: (PMNode | null | undefined)[] = [], attrs: Attrs | null = null): PMNode {
  return S.nodes.paragraph.create(attrs, Fragment.fromArray(inlines.filter(Boolean) as PMNode[]));
}

/** Sort/dedupe an array of marks into a valid mark set. */
export function markSet(marks: readonly (Mark | null | undefined)[]): Mark[] {
  let set: readonly Mark[] = Mark.none;
  for (const m of marks) if (m) set = m.addToSet(set);
  return set as Mark[];
}

/** Collect inline content of an arbitrary node (used when flattening blocks into a paragraph). */
function inlineContentOf(node: PMNode, out: PMNode[]): void {
  if (node.isInline) { out.push(node); return; }
  if (node.isTextblock) {
    if (out.length) out.push(S.nodes.hard_break.create());
    if (node.type === S.nodes.code_block) {
      const t = node.textContent;
      if (t) {
        const lines = t.split('\n');
        lines.forEach((l, i) => { if (i) out.push(S.nodes.hard_break.create()); if (l) out.push(S.text(l)); });
      }
    } else node.forEach((c) => out.push(c));
    return;
  }
  node.forEach((c) => inlineContentOf(c, out));
}

function repairTextblock(type: NodeType, attrs: Attrs, kids: PMNode[]): PMNode {
  if (type.spec.code) {
    let t = '';
    for (const k of kids) {
      if (k.isText) t += k.text;
      else if (k.type === S.nodes.hard_break) t += '\n';
      else if (k.isInline) t += inlineAtomText(k);
      else t += (t ? '\n' : '') + k.textContent;
    }
    return type.create(attrs, t ? S.text(t) : null);
  }
  const flat: PMNode[] = [];
  for (const k of kids) {
    if (k.isInline) flat.push(k);
    else inlineContentOf(k, flat);
  }
  const ok: PMNode[] = [];
  for (const k of flat) {
    if (!type.contentMatch.matchType(k.type) && !(k.isText && type.contentMatch.matchType(S.nodes.text))) continue;
    const marks = k.marks.filter((m) => type.allowsMarkType(m.type));
    ok.push(marks.length === k.marks.length ? k : k.mark(marks));
  }
  return type.create(attrs, Fragment.fromArray(ok));
}

function fitContainer(type: NodeType, kids: PMNode[]): PMNode[] {
  // Group stray inline content into paragraphs first.
  const grouped: PMNode[] = [];
  let buf: PMNode[] = [];
  const flush = () => { if (buf.length) { grouped.push(repairTextblock(S.nodes.paragraph, {}, buf)); buf = []; } };
  for (const k of kids) { if (k.isInline) buf.push(k); else { flush(); grouped.push(k); } }
  flush();

  const result: PMNode[] = [];
  let match = type.contentMatch;
  // Walk the children in order; nodes put back for another try (unwrapped children, degraded
  // paragraphs) go on a stack in front of the rest. Every retry is strictly smaller than the node
  // it replaces, so the loop ends without a cap.
  const back: PMNode[] = [];
  let next = 0;
  while (back.length || next < grouped.length) {
    const c = back.length ? back.pop()! : grouped[next++];
    const m = match.matchType(c.type);
    if (m) { result.push(c); match = m; continue; }
    const fill = match.fillBefore(Fragment.from(c));
    if (fill) {
      const after = match.matchFragment(fill);
      const m2 = after && after.matchType(c.type);
      if (m2) { fill.forEach((f) => result.push(f)); result.push(c); match = m2; continue; }
    }
    const wrap = match.findWrapping(c.type);
    if (wrap && wrap.length) {
      let w: PMNode | null = c;
      for (let i = wrap.length - 1; i >= 0 && w; i--) w = wrap[i].createAndFill(null, w);
      const m3 = w && match.matchType(w.type);
      if (w && m3) { result.push(w); match = m3; continue; }
    }
    // Unwrap containers into this context, or degrade to a paragraph.
    if (!c.isLeaf && !c.isTextblock) {
      for (let i = c.childCount - 1; i >= 0; i--) back.push(c.child(i));
      continue;
    }
    if (c.isTextblock && c.type !== S.nodes.paragraph && match.matchType(S.nodes.paragraph)) {
      back.push(repairTextblock(S.nodes.paragraph, {}, [c]));
      continue;
    }
    if (c.isLeaf && c.isBlock) {
      const t = c.type === S.nodes.math_block ? c.attrs.latex : '';
      if (t && match.matchType(S.nodes.paragraph)) back.push(para([S.text(t)]));
      continue;
    }
    // drop
  }
  const end = match.fillBefore(Fragment.empty, true);
  if (end) end.forEach((f) => result.push(f));
  return result;
}

/** Recursively repair a node so that it satisfies the schema. Returns null for nodes that cannot survive. */
export function repairNode(node: PMNode): PMNode | null {
  if (node.isText) return node.text ? node : null;
  if (node.isLeaf) return node;
  const kids: PMNode[] = [];
  node.forEach((c) => { const r = repairNode(c); if (r) kids.push(r); });
  if (node.isTextblock) return repairTextblock(node.type, node.attrs, kids);
  const fitted = fitContainer(node.type, kids);
  const frag = Fragment.fromArray(fitted);
  if (node.type.validContent(frag)) return node.type.create(node.attrs, frag, node.marks);
  const filled = node.type.createAndFill(node.attrs, frag, node.marks);
  if (filled) return filled;
  return node.type.createAndFill(node.attrs) || null;
}

/** Build a schema-valid doc from loosely constructed blocks. Never throws. */
export function finishDoc(blocks: (PMNode | null | undefined)[], settings: Partial<DocSettings> | DocSettings): PMNode {
  const raw = (blocks.filter(Boolean) as PMNode[]);
  let doc: PMNode;
  try {
    const repaired = raw.map((b) => repairNode(b)).filter(Boolean) as PMNode[];
    const content = fitContainer(S.nodes.doc, repaired);
    doc = S.node('doc', { settings }, content.length ? content : [para()]);
    try {
      const state = EditorState.create({ doc });
      const tr = fixTables(state);
      if (tr) doc = tr.doc;
    } catch { /* ignore */ }
    doc.check();
    return doc;
  } catch {
    // Last resort: keep the text.
    const paras: PMNode[] = [];
    for (const b of raw) {
      try {
        b.descendants((n) => { if (n.isTextblock) { const t = n.textContent; paras.push(para(t ? [S.text(t)] : [])); return false; } return true; });
        if (b.isTextblock) { const t = b.textContent; paras.push(para(t ? [S.text(t)] : [])); }
      } catch { /* ignore */ }
    }
    return S.node('doc', { settings }, paras.length ? paras : [para()]);
  }
}

// ---------------------------------------------------------------------------------------------
// Nested lists from flat "paragraph at level n" sequences

export interface FlatListItem {
  level: number;
  ordered: boolean;
  format?: string;
  start?: number;
  checked?: boolean | null;
  task?: boolean;
  /** Text after an ordered list number ("." when absent). */
  suffix?: string;
  /** Source list identity (RTF \ls, DOCX numId): a change starts a new list. */
  ls?: number;
  /** Continuation: more blocks of the last item at this level rather than a new item. */
  cont?: boolean;
  blocks: PMNode[];
}

interface ListBuild { ordered: boolean; task: boolean; format: string; start: number; level: number; suffix?: string; ls?: number; items: { content: (PMNode | ListBuild)[]; checked: boolean | null }[] }

function listToNode(l: ListBuild): PMNode {
  const items = l.items.map((it) => {
    const content: PMNode[] = it.content.map((c) => ((c as any).type ? (c as PMNode) : listToNode(c as ListBuild)));
    if (!content.length || content[0].type !== S.nodes.paragraph) content.unshift(para());
    if (l.task) return S.nodes.task_item.create({ checked: !!it.checked }, content);
    return S.nodes.list_item.create({ checked: it.checked ?? null }, content);
  });
  if (l.task) return S.nodes.task_list.create(null, items);
  if (l.ordered) return S.nodes.ordered_list.create({ order: l.start || 1, format: l.format || 'decimal', ...(l.suffix ? { suffix: l.suffix } : {}) }, items);
  return S.nodes.bullet_list.create({ bullet: l.format || 'disc' }, items);
}

/** Turn a run of flat list paragraphs into nested list nodes. */
export function buildNestedLists(entries: FlatListItem[]): PMNode[] {
  const roots: ListBuild[] = [];
  const stack: ListBuild[] = [];
  const minLevel = Math.min(...entries.map((e) => e.level));
  for (const e of entries) {
    const level = Math.max(0, e.level - minLevel);
    const task = !!e.task;
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (e.cont && top && top.level === level && top.items.length) {
      top.items[top.items.length - 1].content.push(...e.blocks);
      continue;
    }
    const newList = (): ListBuild => ({ ordered: e.ordered, task, format: e.format || (e.ordered ? 'decimal' : 'disc'), start: e.start || 1, level, items: [], suffix: e.suffix, ls: e.ls });
    if (top && top.level === level && (top.ordered !== e.ordered || top.task !== task || (e.ls != null && top.ls != null && e.ls !== top.ls))) {
      stack.pop();
      top = stack[stack.length - 1];
      const nl = newList();
      if (top) top.items[top.items.length - 1]?.content.push(nl); else roots.push(nl);
      stack.push(nl);
      top = nl;
    } else if (!top || top.level < level) {
      const nl = newList();
      if (top) {
        if (!top.items.length) top.items.push({ content: [], checked: null });
        top.items[top.items.length - 1].content.push(nl);
      } else roots.push(nl);
      stack.push(nl);
      top = nl;
    }
    top.items.push({ content: [...e.blocks], checked: e.checked ?? (task ? false : null) });
  }
  return roots.map(listToNode);
}

/** Guess an ordered-list format from a marker such as "1.", "a)", "iv.". */
export function markerFormat(marker: string): { ordered: boolean; format: string; start: number } {
  const t = marker.trim().replace(/^\(/, '').replace(/[.):]$/, '');
  if (/^\d+$/.test(t)) return { ordered: true, format: 'decimal', start: parseInt(t, 10) };
  if (/^[ivxlcdm]+$/.test(t) && (t.length > 1 || t === 'i')) return { ordered: true, format: 'lower-roman', start: romanValue(t) };
  if (/^[IVXLCDM]+$/.test(t) && (t.length > 1 || t === 'I')) return { ordered: true, format: 'upper-roman', start: romanValue(t) };
  if (/^[a-z]$/.test(t)) return { ordered: true, format: 'lower-alpha', start: t.charCodeAt(0) - 96 };
  if (/^[A-Z]$/.test(t)) return { ordered: true, format: 'upper-alpha', start: t.charCodeAt(0) - 64 };
  return { ordered: false, format: 'disc', start: 1 };
}

export function romanValue(s: string): number {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let n = 0;
  const l = s.toLowerCase();
  for (let i = 0; i < l.length; i++) {
    const a = v[l[i]] || 0, b = v[l[i + 1]] || 0;
    n += a < b ? -a : a;
  }
  return n || 1;
}

/** An ordered list's start number from document data (imports can carry NaN or text): an integer, else 1. */
export function listStart(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? Math.round(n) : 1;
}

/** Points ↔ other units. */
export const ptToTwip = (pt: number) => Math.round(pt * 20);
export const twipToPt = (tw: number) => tw / 20;

/** Parse an ODF/CSS length ("2.54cm", "0.5in", "12pt", "10px") into points. */
export function lengthToPt(v: string | null | undefined): number | null {
  if (v == null) return null;
  const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*(pt|px|in|cm|mm|pc|em|rem|twip)?\s*$/i.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] || 'pt').toLowerCase()) {
    case 'pt': return n;
    case 'px': return n * 0.75;
    case 'in': return n * 72;
    case 'cm': return (n / 2.54) * 72;
    case 'mm': return (n / 25.4) * 72;
    case 'pc': return n * 12;
    case 'em': case 'rem': return n * 12;
    case 'twip': return n / 20;
  }
  return null;
}

/** Round to 2 decimals for tidy output. */
export const r2 = (n: number) => Math.round(n * 100) / 100;

/** ISO date without milliseconds (EPUB/ODF metadata). */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function uuid(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// Imported formatting clean-up

/**
 * After importing from a format that writes formatting explicitly on every run (RTF, ODT, Word
 * HTML), promote the dominant body font/size to the document's Normal style / theme fonts and
 * drop direct formatting that merely restates the paragraph style. Keeps documents editable.
 */
export function normalizeImportedFormatting(blocks: PMNode[], settings: DocSettings, defaultFont: string | null): PMNode[] {
  const sizeCount = new Map<number, number>();
  const fontCount = new Map<string, number>();
  const headFont = new Map<string, number>();
  let total = 0, headTotal = 0;
  const bump = <K>(m: Map<K, number>, k: K, n: number) => m.set(k, (m.get(k) || 0) + n);
  const visit = (n: PMNode) => {
    if (n.type === S.nodes.paragraph) {
      const style = n.attrs.style as string;
      const isHead = styleLevel(style) > 0 || style === 'Title';
      n.forEach((c) => {
        if (!c.isText) return;
        const len = (c.text || '').trim().length;
        if (!len) return;
        const size = c.marks.find((m) => m.type.name === 'size')?.attrs.pt ?? -1;
        const font = c.marks.find((m) => m.type.name === 'font')?.attrs.family ?? defaultFont ?? '';
        if (isHead) { headTotal += len; bump(headFont, font, len); }
        else if (style === 'Normal') { total += len; bump(sizeCount, size, len); bump(fontCount, font, len); }
      });
      return;
    }
    n.forEach(visit);
  };
  blocks.forEach(visit);
  const dominant = <K>(m: Map<K, number>, tot: number): K | null => {
    let best: K | null = null, bc = 0;
    for (const [k, v] of m) if (v > bc) { best = k; bc = v; }
    return tot > 0 && bc >= tot * 0.5 ? best : null;
  };
  const domSize = dominant(sizeCount, total);
  if (domSize != null && domSize > 0) settings.styles = { ...settings.styles, Normal: { ...(settings.styles.Normal || {}), name: 'Normal', type: 'paragraph', size: domSize } as any };
  if (settings.styleSet === 'QuillPen') {
    const domFont = dominant(fontCount, total);
    const domHead = dominant(headFont, headTotal);
    const body = domFont || defaultFont;
    if (body) settings.theme = { ...settings.theme, bodyFont: body, headingFont: domHead || (headTotal ? settings.theme.headingFont : body) };
    else if (domHead) settings.theme = { ...settings.theme, headingFont: domHead };
  }
  const map = resolveStyles(settings);
  const cache = new Map<string, StyleCharDefaults>();
  const near = (x: number | null | undefined, y: number | null | undefined) => x != null && y != null && Math.abs(x - y) < 0.6;
  const rebuild = (n: PMNode): PMNode => {
    if (n.type === S.nodes.paragraph) {
      const style = (n.attrs.style as string) || 'Normal';
      let d = cache.get(style);
      if (!d) { d = styleCharDefaults(style, settings); cache.set(style, d); }
      const kids: PMNode[] = [];
      n.forEach((c) => {
        const marks = stripRedundantMarks(c.marks, d!, defaultFont);
        kids.push(marks.length === c.marks.length ? c : c.mark(marks));
      });
      const e = effectiveStyle(map, map[style] ? style : 'Normal');
      const a: Attrs = { ...n.attrs };
      if (near(a.spaceAfter, e.spaceAfter ?? 0)) a.spaceAfter = null;
      if (near(a.spaceBefore, e.spaceBefore ?? 0)) a.spaceBefore = null;
      if (near(a.indentLeft, e.indentLeft ?? 0)) a.indentLeft = null;
      if (near(a.indentRight, e.indentRight ?? 0)) a.indentRight = null;
      if (near(a.indentFirst, e.indentFirst ?? 0)) a.indentFirst = null;
      if (a.lineHeight && /^\d+(\.\d+)?$/.test(a.lineHeight) && Math.abs(parseFloat(a.lineHeight) - parseFloat(e.lineHeight || '1')) < 0.03) a.lineHeight = null;
      if (a.align && a.align === (e.align || 'left')) a.align = null;
      if (a.keepNext && e.keepNext) a.keepNext = false;
      if (a.keepLines && e.keepLines) a.keepLines = false;
      if (a.pageBreakBefore && e.pageBreakBefore) a.pageBreakBefore = false;
      return n.type.create(a, Fragment.fromArray(kids), n.marks);
    }
    if (n.isLeaf || n.isTextblock) return n;
    const kids: PMNode[] = [];
    n.forEach((c) => kids.push(rebuild(c)));
    return n.type.create(n.attrs, Fragment.fromArray(kids), n.marks);
  };
  return blocks.map(rebuild);
}
