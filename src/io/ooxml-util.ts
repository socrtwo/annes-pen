/**
 * Shared helpers for the DOCX (Office Open XML WordprocessingML) importer and exporter:
 * XML escaping, unit conversion, colors, borders, images, field instructions, style
 * names and the LaTeX <-> OMML symbol tables.
 */
import { BUILTIN_STYLES } from '../editor/styles';

// ------------------------------------------------------------------------------------------
// Namespaces

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  w10: 'urn:schemas-microsoft-com:office:word',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  wp14: 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  pkgRel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  commentsExtended: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  customProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties',
  fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
};

// ------------------------------------------------------------------------------------------
// XML text

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove characters that are not allowed in XML 1.0 documents. */
export function stripInvalidXml(s: string): string {
  return s.replace(INVALID_XML, '');
}

/**
 * Escape text for XML content or attribute values, stripping characters XML 1.0 forbids (control
 * characters, lone surrogates, U+FFFE/F). The one implementation for every XML/HTML writer;
 * `apos` lets HTML use &#39; (HTML 4 has no &apos;).
 */
export function escapeXmlText(s: string, apos = '&apos;'): string {
  return stripInvalidXml(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, apos);
}

/** Escape text for use in XML content or attribute values (also strips invalid characters). */
export function esc(s: unknown): string {
  return escapeXmlText(String(s ?? ''));
}

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ------------------------------------------------------------------------------------------
// Units

export const EMU_PER_PT = 12700;
export const ptToTwip = (pt: number): number => Math.round(pt * 20);
export const twipToPt = (tw: number): number => Math.round((tw / 20) * 100) / 100;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Parse an OOXML measurement into twips. Accepts plain numbers (twips) and Strict OOXML
 * universal measures such as "1in", "2.54cm", "12pt", "6pc", "10mm".
 */
export function parseTwips(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const m = /^\s*(-?[\d.]+)\s*(mm|cm|in|pt|pc|pi)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] || '').toLowerCase()) {
    case 'mm': return (n / 25.4) * 1440;
    case 'cm': return (n / 2.54) * 1440;
    case 'in': return n * 1440;
    case 'pt': return n * 20;
    case 'pc': case 'pi': return n * 240;
    default: return n;
  }
}

/** Parse an OOXML ST_OnOff value. `null` (attribute absent on a present element) means true. */
export function onOff(v: string | null | undefined): boolean {
  if (v == null) return true;
  const s = v.toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'none');
}

// ------------------------------------------------------------------------------------------
// Colors

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: 'ffff00', green: '00ff00', cyan: '00ffff', magenta: 'ff00ff', blue: '0000ff', red: 'ff0000',
  darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000',
  darkYellow: '808000', darkGray: '808080', lightGray: 'c0c0c0', black: '000000', white: 'ffffff',
};

/** Word highlight name for a hex color, if it matches one of the 16 named colors. */
export function highlightName(hex: string): string | null {
  const h = hex.toLowerCase().replace(/^#/, '');
  for (const [name, v] of Object.entries(HIGHLIGHT_COLORS)) if (v === h) return name;
  return null;
}

const CSS_NAMED: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', lime: '00ff00', blue: '0000ff', yellow: 'ffff00',
  cyan: '00ffff', aqua: '00ffff', magenta: 'ff00ff', fuchsia: 'ff00ff', gray: '808080', grey: '808080', /* both CSS keywords */ silver: 'c0c0c0',
  maroon: '800000', olive: '808000', purple: '800080', teal: '008080', navy: '000080', orange: 'ffa500',
  pink: 'ffc0cb', brown: 'a52a2a', gold: 'ffd700', indigo: '4b0082', violet: 'ee82ee', lightgray: 'd3d3d3',
  lightgrey: 'd3d3d3', darkgray: 'a9a9a9', darkgrey: 'a9a9a9', darkred: '8b0000', darkblue: '00008b', darkgreen: '006400',
  lightblue: 'add8e6', lightgreen: '90ee90', lightyellow: 'ffffe0', beige: 'f5f5dc', coral: 'ff7f50', crimson: 'dc143c',
  khaki: 'f0e68c', lavender: 'e6e6fa', salmon: 'fa8072', tan: 'd2b48c', tomato: 'ff6347', turquoise: '40e0d0',
  whitesmoke: 'f5f5f5', gainsboro: 'dcdcdc', currentcolor: '000000',
};

/** Lighten (amt > 0) or darken (amt < 0) a 6-digit hex color. Mirrors styles.ts. */
export function shadeHex(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  r = f(r); g = f(g); b = f(b);
  return ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/**
 * Convert a CSS color (hex, rgb(), named, or the editor's `var(--qf-accentN[-dark|-darker|-light|-pale])`
 * theme variables) to an uppercase 6-digit hex string without '#'. Returns null for
 * transparent / unknown values.
 */
export function cssColorToHex(css: string | null | undefined, accent: string[] = ['#2b579a']): string | null {
  if (!css) return null;
  let s = String(css).trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'none' || s === 'auto' || s === 'initial') return null;
  const v = /^var\(\s*--qf-accent(\d)(?:-(dark|darker|light|pale))?\s*(?:,[^)]*)?\)$/.exec(s);
  if (v) {
    const base = accent[parseInt(v[1], 10) - 1] || accent[0] || '#2b579a';
    const hex = cssColorToHex(base) || '2B579A';
    const amt = v[2] === 'dark' ? -0.25 : v[2] === 'darker' ? -0.5 : v[2] === 'light' ? 0.45 : v[2] === 'pale' ? 0.85 : 0;
    return (amt ? shadeHex(hex, amt) : hex).toUpperCase();
  }
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) return s.split('').map((c) => c + c).join('').toUpperCase();
  if (/^[0-9a-f]{6}$/.test(s)) return s.toUpperCase();
  if (/^[0-9a-f]{8}$/.test(s)) return s.slice(0, 6).toUpperCase();
  const rgb = /^rgba?\(\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (rgb) {
    if (rgb[4] != null && parseFloat(rgb[4]) === 0) return null;
    return [rgb[1], rgb[2], rgb[3]].map((c) => Math.max(0, Math.min(255, Math.round(parseFloat(c)))).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  if (CSS_NAMED[s]) return CSS_NAMED[s].toUpperCase();
  return null;
}

/** OOXML color value ("FF0000", "auto") to a CSS color ("#ff0000"), or null. */
export function ooxmlColorToCss(v: string | null | undefined): string | null {
  if (!v || v.toLowerCase() === 'auto') return null;
  if (/^[0-9a-f]{6}$/i.test(v)) return '#' + v.toLowerCase();
  if (HIGHLIGHT_COLORS[v]) return '#' + HIGHLIGHT_COLORS[v];
  return null;
}

// ------------------------------------------------------------------------------------------
// Borders

export interface OoxmlBorder { val: string; sz: number; color: string; space?: number }

const CSS_TO_OOXML_BORDER: Record<string, string> = {
  solid: 'single', double: 'double', dotted: 'dotted', dashed: 'dashed', groove: 'threeDEngrave', ridge: 'threeDEmboss',
  inset: 'inset', outset: 'outset',
};

/** Parse a CSS border shorthand ("1px solid #000", "2pt double red"). */
export function parseCssBorder(css: string | null | undefined): { style: string; widthPt: number; color: string | null } | null {
  if (!css) return null;
  const s = String(css).trim();
  if (!s || /^(none|0|hidden)\b/i.test(s)) return null;
  let style = 'solid';
  let widthPt = 0.75;
  let color: string | null = null;
  // Split on whitespace outside parentheses.
  const parts = s.match(/(?:[^\s(]+\([^)]*\)|[^\s]+)/g) || [];
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (/^(none|hidden)$/.test(lp)) return null;
    if (/^(solid|double|dotted|dashed|groove|ridge|inset|outset)$/.test(lp)) { style = lp; continue; }
    const len = /^(-?[\d.]+)(px|pt|em|mm|cm|in)?$/.exec(lp);
    if (len) {
      const n = parseFloat(len[1]);
      const u = len[2] || 'px';
      widthPt = u === 'pt' ? n : u === 'px' ? n * 0.75 : u === 'em' ? n * 12 : u === 'mm' ? (n / 25.4) * 72 : u === 'cm' ? (n / 2.54) * 72 : n * 72;
      continue;
    }
    if (lp === 'thin') { widthPt = 0.5; continue; }
    if (lp === 'medium') { widthPt = 1.5; continue; }
    if (lp === 'thick') { widthPt = 3; continue; }
    color = p;
  }
  if (widthPt <= 0) return null;
  return { style, widthPt, color };
}

export function cssBorderToOoxml(css: string | null | undefined, accent?: string[]): OoxmlBorder | null {
  const b = parseCssBorder(css);
  if (!b) return null;
  return {
    val: CSS_TO_OOXML_BORDER[b.style] || 'single',
    sz: Math.max(2, Math.min(96, Math.round(b.widthPt * 8))),
    color: cssColorToHex(b.color, accent) || 'auto',
  };
}

/** OOXML border to a CSS border shorthand. */
export function ooxmlBorderToCss(val: string | null, sz: string | null, color: string | null): string | null {
  if (!val || val === 'nil' || val === 'none') return null;
  const width = sz ? Math.max(0.25, parseInt(sz, 10) / 8) : 0.5;
  const style = val === 'double' || val.startsWith('thinThick') || val.startsWith('thickThin') || val === 'triple' ? 'double'
    : val === 'dotted' || val === 'dotDash' || val === 'dotDotDash' ? 'dotted'
      : val.startsWith('dash') ? 'dashed'
        : val === 'threeDEngrave' ? 'groove' : val === 'threeDEmboss' ? 'ridge'
          : val === 'inset' ? 'inset' : val === 'outset' ? 'outset' : 'solid';
  const c = ooxmlColorToCss(color) || '#000000';
  return `${round2(width)}pt ${style} ${c}`;
}

// ------------------------------------------------------------------------------------------
// Binary helpers / images

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const B = (globalThis as any).Buffer;
  return new Uint8Array(B.from(clean, 'base64'));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(s);
  }
  return (globalThis as any).Buffer.from(bytes).toString('base64');
}

/** Decode a data: URL. */
export function parseDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(src || '');
  if (!m) return null;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  const isB64 = /;base64/i.test(m[2]);
  try {
    if (isB64) return { mime, bytes: base64ToBytes(m[3]) };
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
  } catch {
    return null;
  }
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  dib: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', webp: 'image/webp',
  emf: 'image/x-emf', wmf: 'image/x-wmf', ico: 'image/x-icon', jfif: 'image/jpeg',
};

export function mimeForExt(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] || 'application/octet-stream';
}

export function extForMime(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/jpeg': case 'image/jpg': case 'image/pjpeg': return 'jpeg';
    case 'image/gif': return 'gif';
    case 'image/bmp': case 'image/x-ms-bmp': return 'bmp';
    case 'image/tiff': return 'tiff';
    case 'image/svg+xml': return 'svg';
    case 'image/x-emf': case 'image/emf': return 'emf';
    case 'image/x-wmf': case 'image/wmf': return 'wmf';
    default: return null;
  }
}

/** Sniff the mime type of image bytes from their signature. */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

/** Natural pixel size of PNG / JPEG / GIF / BMP image bytes, or null. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  try {
    const mime = sniffImageMime(b);
    if (mime === 'image/png' && b.length >= 24) {
      const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
      const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (mime === 'image/gif' && b.length >= 10) {
      return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
    }
    if (mime === 'image/bmp' && b.length >= 26) {
      const w = b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24);
      const h = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
      return { w: Math.abs(w), h: Math.abs(h) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = (b[i + 2] << 8) | b[i + 3];
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          const h = (b[i + 5] << 8) | b[i + 6];
          const w = (b[i + 7] << 8) | b[i + 8];
          return w > 0 && h > 0 ? { w, h } : null;
        }
        i += 2 + len;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Width/height of an SVG document from its width/height or viewBox attributes (px). */
export function svgSize(text: string): { w: number; h: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(text);
  if (!tag) return null;
  const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag[0])?.[1];
  const toPx = (v?: string) => {
    if (!v) return null;
    const m = /^([\d.]+)\s*(px|pt|in|cm|mm)?$/.exec(v.trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    switch (m[2]) { case 'pt': return n / 0.75; case 'in': return n * 96; case 'cm': return (n / 2.54) * 96; case 'mm': return (n / 25.4) * 96; default: return n; }
  };
  let w = toPx(attr('width')), h = toPx(attr('height'));
  const vb = attr('viewBox')?.split(/[\s,]+/).map(parseFloat);
  if ((!w || !h) && vb && vb.length === 4) {
    if (!w && !h) { w = vb[2]; h = vb[3]; } else if (!w) w = (h! * vb[2]) / vb[3]; else h = (w * vb[3]) / vb[2];
  }
  return w && h ? { w, h } : null;
}

// ------------------------------------------------------------------------------------------
// Fonts

/** Open fonts bundled with Anne's Pen and the proprietary families they are metric-compatible with. */
export const FONT_ALIASES: Record<string, string> = {
  Carlito: 'Calibri', Caladea: 'Cambria', Tinos: 'Times New Roman', Arimo: 'Arial', Cousine: 'Courier New',
};

/** Family name written to DOCX for an editor font family. */
export function exportFontName(fam: string): string {
  const clean = fam.split(',')[0].replace(/["']/g, '').trim();
  return FONT_ALIASES[clean] || clean;
}

/** Whether two family names render the same (taking metric-compatible aliases into account). */
export function fontsEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return exportFontName(a).toLowerCase() === exportFontName(b).toLowerCase();
}

// ------------------------------------------------------------------------------------------
// Style names

/** Word's canonical (often lower-case) names for built-in styles that differ from ours. */
const WORD_NAMES: Record<string, string> = {
  Caption: 'caption', Header: 'header', Footer: 'footer', 'Footnote Text': 'footnote text', 'Endnote Text': 'endnote text',
  'Index 1': 'index 1', 'Index 2': 'index 2', 'Index Heading': 'index heading', 'Table of Figures': 'table of figures',
  'Envelope Address': 'envelope address', 'Envelope Return': 'envelope return', 'Line Number': 'line number',
  'Page Number': 'page number', 'TOC 1': 'toc 1', 'TOC 2': 'toc 2', 'TOC 3': 'toc 3', 'Followed Hyperlink': 'FollowedHyperlink',
  'Keyboard': 'HTML Keyboard', 'Footnote Reference': 'footnote reference', 'Endnote Reference': 'endnote reference',
  'Comment Text': 'annotation text', 'Comment Reference': 'annotation reference',
};
for (let i = 1; i <= 9; i++) WORD_NAMES[`Heading ${i}`] = `heading ${i}`;

/** Fixed style ids Word uses for some built-ins. */
const STYLE_IDS: Record<string, string> = {
  'Followed Hyperlink': 'FollowedHyperlink', 'Comment Text': 'CommentText', 'Comment Reference': 'CommentReference',
  'Default Paragraph Font': 'DefaultParagraphFont', Keyboard: 'HTMLKeyboard',
};

export function wordStyleName(name: string): string {
  return WORD_NAMES[name] || name;
}

/** Deterministic style id for a style name (alphanumeric, e.g. "Heading 1" -> "Heading1"). */
export function styleIdFor(name: string): string {
  if (STYLE_IDS[name]) return STYLE_IDS[name];
  const id = name.replace(/[^A-Za-z0-9]/g, '');
  return id || 'Style' + Math.abs(hashString(name));
}

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

const BUILTIN_BY_KEY = new Map<string, string>();
for (const s of BUILTIN_STYLES) BUILTIN_BY_KEY.set(s.name.toLowerCase().replace(/\s+/g, ''), s.name);
for (const [ours, word] of Object.entries(WORD_NAMES)) BUILTIN_BY_KEY.set(word.toLowerCase().replace(/\s+/g, ''), ours);
BUILTIN_BY_KEY.set('annotationtext', 'Comment Text');

/** Map a Word style name (w:name) to the editor's built-in name when it is one; otherwise keep it. */
export function canonicalStyleName(wordName: string): string {
  const key = wordName.toLowerCase().replace(/\s+/g, '');
  return BUILTIN_BY_KEY.get(key) || wordName;
}

export function isBuiltinStyleName(name: string): boolean {
  return BUILTIN_STYLES.some((s) => s.name === name);
}

/** Map a Word table style name to the closest built-in table style. */
export function tableStyleFor(wordName: string | null | undefined): string {
  if (!wordName) return 'Table Grid';
  const tables = BUILTIN_STYLES.filter((s) => s.type === 'table').map((s) => s.name);
  const exact = tables.find((t) => t.toLowerCase() === wordName.toLowerCase());
  if (exact) return exact;
  const n = wordName.toLowerCase();
  if (/^grid table/.test(n)) return /accent/.test(n) ? 'Grid Table Accent' : 'Grid Table Light';
  if (/^list table/.test(n)) return /accent/.test(n) ? 'List Table Accent' : 'List Table';
  if (/^plain table/.test(n)) return 'Plain Table';
  if (/^(light|medium) shading/.test(n)) return 'Banded Rows';
  if (/^light list/.test(n)) return 'List Table';
  if (/^light grid/.test(n)) return 'Grid Table Light';
  if (n === 'normal table' || n === 'table normal') return 'Plain Table';
  return 'Table Grid';
}

// ------------------------------------------------------------------------------------------
// Fields

/** Field types that map to `field` nodes (everything else keeps its result text). */
export const KNOWN_FIELDS = new Set([
  'PAGE', 'NUMPAGES', 'SECTIONPAGES', 'DATE', 'TIME', 'CREATEDATE', 'SAVEDATE', 'PRINTDATE', 'AUTHOR', 'TITLE', 'SUBJECT', 'KEYWORDS',
  'COMMENTS', 'FILENAME', 'SEQ', 'REF', 'PAGEREF', 'STYLEREF', 'MERGEFIELD', 'MERGEREC', 'DOCPROPERTY', 'DOCVARIABLE',
  'NUMWORDS', 'NUMCHARS', 'USERNAME', 'USERINITIALS', 'FILLIN', 'QUOTE', 'SECTION', '=',
]);

export const DATE_FIELDS = new Set(['DATE', 'TIME', 'CREATEDATE', 'SAVEDATE', 'PRINTDATE']);

export interface FieldInstr {
  type: string;
  args: string[];
  switches: { name: string; value: string | null }[];
  arg: string | null;
  format: string | null;
}

const VALUE_SWITCHES = new Set(['@', '#', '*']);
const OPTIONAL_VALUE_SWITCHES = new Set(['o', 'l', 'c', 't', 'f', 's', 'n', 'p', 'a', 'e', 'g', 'r', 'd', 'k', 'm', 'b', 'i']);
const FLAG_SWITCHES = new Set(['h', 'z', 'u', 'w', 'x', 'b', 'i', 'y', 'v', 'j', 'q', 'n']);

/** Parse a field instruction such as `DATE \@ "MMMM d, yyyy" \* MERGEFORMAT`. */
export function parseFieldInstr(instr: string): FieldInstr {
  const s = instr.replace(/\u00a0/g, ' ').trim();
  if (s.startsWith('=')) {
    const body = s.slice(1);
    const sw = body.search(/\\[#*@]/);
    const expr = (sw >= 0 ? body.slice(0, sw) : body).trim();
    const rest = sw >= 0 ? parseFieldInstr('X ' + body.slice(sw)) : null;
    return { type: '=', args: [expr], switches: rest?.switches || [], arg: expr || null, format: rest?.format ?? null };
  }
  const tokens: { text: string; quoted: boolean }[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|“([^”]*)”|(\\[^\s"\\]+|\\\\)|([^\s"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1] != null) tokens.push({ text: m[1].replace(/\\(["\\])/g, '$1'), quoted: true });
    else if (m[2] != null) tokens.push({ text: m[2], quoted: true });
    else tokens.push({ text: m[3] ?? m[4], quoted: false });
  }
  const type = (tokens.shift()?.text || '').toUpperCase();
  const args: string[] = [];
  const switches: { name: string; value: string | null }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.quoted && t.text.startsWith('\\') && t.text.length > 1) {
      const name = t.text.slice(1);
      const key = name.toLowerCase();
      const next = tokens[i + 1];
      const nextIsValue = next && !(!next.quoted && next.text.startsWith('\\'));
      let value: string | null = null;
      if (nextIsValue && (VALUE_SWITCHES.has(name) || next.quoted || (OPTIONAL_VALUE_SWITCHES.has(key) && !FLAG_SWITCHES.has(key)))) {
        value = next.text;
        i++;
      }
      switches.push({ name, value });
    } else {
      args.push(t.text);
    }
  }
  let format: string | null = null;
  const at = switches.find((x) => x.name === '@' && x.value);
  const hash = switches.find((x) => x.name === '#' && x.value);
  const star = switches.find((x) => x.name === '*' && x.value && !/^(MERGEFORMAT|CHARFORMAT|MERGEFORMATINET)$/i.test(x.value));
  if (at) format = at.value;
  else if (hash) format = hash.value;
  else if (star) format = star.value;
  return { type, args, switches, arg: args.length ? args.join(' ') : null, format };
}

function quoteArg(a: string): string {
  return /[\s"\\]/.test(a) || a === '' ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a;
}

/** Build a field instruction from a field node's attrs. */
export function buildFieldInstr(type: string, arg: string | null | undefined, format: string | null | undefined): string {
  const t = (type || 'DATE').toUpperCase();
  if (t === '=') return `= ${arg || '0'}${format ? ` \\# "${format}"` : ''}`;
  let s = t;
  if (arg) s += ' ' + quoteArg(arg);
  if (t === 'REF' || t === 'PAGEREF') s += ' \\h';
  if (format) {
    if (DATE_FIELDS.has(t)) s += ` \\@ "${format}"`;
    else if (/^[#0.,$%\s]+$/.test(format)) s += ` \\# "${format}"`;
    else s += ` \\* ${quoteArg(format)}`;
  }
  return s + ' \\* MERGEFORMAT';
}

// ------------------------------------------------------------------------------------------
// Math symbol tables (LaTeX command <-> Unicode)

export const LATEX_SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅',
  varnothing: '∅', to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
  prime: '′', circ: '∘', bullet: '∙', star: '⋆', ast: '∗', oplus: '⊕', otimes: '⊗', wedge: '∧', land: '∧', vee: '∨', lor: '∨',
  neg: '¬', lnot: '¬', angle: '∠', perp: '⊥', parallel: '∥', mid: '∣', ll: '≪', gg: '≫', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
  aleph: 'ℵ', degree: '°', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', therefore: '∴',
  because: '∵', iff: '⟺', implies: '⟹', quad: '\u2003', qquad: '\u2003\u2003', ',': '\u2009', ';': '\u2005', ':': '\u2005',
  '!': '', ' ': ' ', '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#', '_': '_', '|': '‖', lbrace: '{', rbrace: '}',
  vert: '|', Vert: '‖', backslash: '\\', setminus: '∖', top: '⊤', bot: '⊥', models: '⊨', vdash: '⊢',
};

/** Unicode -> LaTeX command (first command wins). */
export const UNICODE_TO_LATEX: Record<string, string> = {};
for (const [cmd, ch] of Object.entries(LATEX_SYMBOLS)) {
  if (!/^[A-Za-z]+$/.test(cmd) || !ch || ch === ' ' || /^[{}%$&#_\\]$/.test(ch)) continue;
  if (!(ch in UNICODE_TO_LATEX)) UNICODE_TO_LATEX[ch] = cmd;
}
UNICODE_TO_LATEX['·'] = 'cdot';
UNICODE_TO_LATEX['−'] = '';

export const NARY_CHARS: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀',
  bigoplus: '⨁', bigotimes: '⨂',
};

export const ACCENT_CHARS: Record<string, string> = {
  hat: '\u0302', widehat: '\u0302', bar: '\u0305', overline: '\u0305', vec: '\u20D7', dot: '\u0307', ddot: '\u0308', tilde: '\u0303',
  widetilde: '\u0303', check: '\u030C', breve: '\u0306', acute: '\u0301', grave: '\u0300',
};

export const FUNCTION_NAMES = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'Pr', 'hom', 'liminf', 'limsup']);
