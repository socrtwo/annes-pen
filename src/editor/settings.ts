/** Document-level settings stored in doc.attrs.settings. */

export interface Margins { top: number; right: number; bottom: number; left: number }
export interface PageSetup {
  sizeName: string;
  width: number;   // pt (portrait width)
  height: number;  // pt
  orientation: 'portrait' | 'landscape';
  margin: Margins;
  gutter: number;
  headerDist: number;
  footerDist: number;
  mirror: boolean;
  vAlign: 'top' | 'center' | 'justify' | 'bottom';
}
export interface HF { left: string; center: string; right: string }
export interface CommentReply { id: string; author: string; date: number; text: string }
export interface CommentData {
  id: string; author: string; date: number; text: string;
  resolved: boolean; replies: CommentReply[]; reactions?: Record<string, number>;
}
export interface Source {
  id: string; type: string; author: string; title: string; year: string;
  publisher?: string; city?: string; journal?: string; volume?: string; issue?: string;
  pages?: string; url?: string; accessed?: string; edition?: string; editor?: string; doi?: string;
}
export interface StyleDef {
  name: string;
  type: 'paragraph' | 'character' | 'table' | 'linked';
  basedOn?: string;
  next?: string;
  builtin?: boolean;
  quick?: boolean;     // shown in the style gallery
  hidden?: boolean;
  // character properties
  font?: string; size?: number; bold?: boolean; italic?: boolean; underline?: boolean;
  color?: string; caps?: boolean; smallCaps?: boolean; spacing?: number; highlight?: string;
  // paragraph properties
  align?: string; spaceBefore?: number; spaceAfter?: number; lineHeight?: string;
  indentLeft?: number; indentRight?: number; indentFirst?: number;
  keepNext?: boolean; keepLines?: boolean; pageBreakBefore?: boolean; outlineLevel?: number;
  borderBottom?: string; borderTop?: string; borderLeft?: string; bg?: string;
  // table style hints
  headerBg?: string; headerColor?: string; bandBg?: string; borderColor?: string; borders?: 'all' | 'horizontal' | 'none' | 'outer';
}
export interface Watermark { text: string; color: string; opacity: number; diagonal: boolean; font?: string; image?: string }

export interface DocSettings {
  page: PageSetup;
  header: HF; footer: HF;
  firstHeader: HF; firstFooter: HF;
  evenHeader: HF; evenFooter: HF;
  differentFirst: boolean; differentOddEven: boolean;
  headerFooterFont?: string;
  pageNumber: { format: string; start: number };
  comments: Record<string, CommentData>;
  sources: Source[];
  citationStyle: string;
  styles: Record<string, StyleDef>;
  styleSet: string;
  theme: { name: string; headingFont: string; bodyFont: string; accent: string[] };
  pageColor: string | null;
  watermark: Watermark | null;
  pageBorder: string | null;
  lineNumbers: { enabled: boolean; countBy: number; restart: 'page' | 'continuous' };
  hyphenation: boolean;
  properties: Record<string, string>;
  customProps: Record<string, string>;
  mergeData: { fields: string[]; rows: string[][] } | null;
  mergePreview: number | null;
  footnoteFormat: { foot: string; end: string; placement: 'page' | 'end' };
  protection: { mode: 'none' | 'readonly' | 'comments' | 'tracked' | 'forms'; hash?: string };
  markedFinal: boolean;
  language: string;
  defaultTab: number;
  variables: Record<string, string>;
  snapshots?: never; // snapshots live in app storage, not the document
  gridlines?: boolean;
}

export const PAGE_SIZES: Record<string, [number, number]> = {
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
  Executive: [522, 756],
  Statement: [396, 612],
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  A6: [297.64, 419.53],
  B4: [708.66, 1000.63],
  B5: [498.9, 708.66],
  'Envelope #10': [297, 684],
  'Envelope DL': [311.81, 623.62],
  'Envelope C5': [459.21, 649.13],
  'Postcard': [288, 432],
  'Index Card 3x5': [216, 360],
  'Index Card 4x6': [288, 432],
  'Trade 5.5x8.5': [396, 612],
  'Trade 6x9': [432, 648],
  'Digest 5.5x8.25': [396, 594],
  'Pocket 4.25x6.87': [306, 494.64],
  'Royal 6.14x9.21': [442.08, 663.12],
  'Crown Quarto 7.44x9.69': [535.68, 697.68],
};

const blankHF = (): HF => ({ left: '', center: '', right: '' });

export function defaultSettings(): DocSettings {
  return {
    page: {
      sizeName: 'Letter', width: 612, height: 792, orientation: 'portrait',
      margin: { top: 72, right: 72, bottom: 72, left: 72 },
      gutter: 0, headerDist: 36, footerDist: 36, mirror: false, vAlign: 'top',
    },
    header: blankHF(), footer: blankHF(),
    firstHeader: blankHF(), firstFooter: blankHF(),
    evenHeader: blankHF(), evenFooter: blankHF(),
    differentFirst: false, differentOddEven: false,
    pageNumber: { format: 'decimal', start: 1 },
    comments: {},
    sources: [],
    citationStyle: 'APA',
    styles: {},
    styleSet: 'QuillPen', // rename:keep — stored key of the default style set
    theme: { name: 'Anne\'s Pen', headingFont: 'Carlito', bodyFont: 'Carlito', accent: ['#2b579a', '#c0504d', '#9bbb59', '#8064a2', '#4bacc6', '#f79646'] },
    pageColor: null,
    watermark: null,
    pageBorder: null,
    lineNumbers: { enabled: false, countBy: 1, restart: 'continuous' },
    hyphenation: false,
    properties: { title: '', subject: '', author: '', keywords: '', comments: '', category: '', company: '', manager: '', status: '' },
    customProps: {},
    mergeData: null,
    mergePreview: null,
    footnoteFormat: { foot: 'decimal', end: 'lower-roman', placement: 'page' },
    protection: { mode: 'none' },
    markedFinal: false,
    language: 'en-US',
    defaultTab: 36,
    variables: {},
  };
}

/** Deep-merge stored settings over defaults so older documents gain new keys. */
export function normalizeSettings(s: Partial<DocSettings> | null | undefined): DocSettings {
  const d = defaultSettings();
  if (!s) return d;
  const out: any = { ...d, ...s };
  for (const k of ['page', 'pageNumber', 'theme', 'lineNumbers', 'properties', 'footnoteFormat', 'protection'] as const) {
    out[k] = { ...(d as any)[k], ...((s as any)[k] || {}) };
  }
  out.page.margin = { ...d.page.margin, ...((s.page && s.page.margin) || {}) };
  for (const k of ['header', 'footer', 'firstHeader', 'firstFooter', 'evenHeader', 'evenFooter'] as const) {
    out[k] = { ...blankHF(), ...((s as any)[k] || {}) };
  }
  out.comments = { ...(s.comments || {}) };
  out.sources = [...(s.sources || [])];
  out.styles = { ...(s.styles || {}) };
  return out as DocSettings;
}

export function pageDims(p: PageSetup): { w: number; h: number } {
  return p.orientation === 'landscape' ? { w: Math.max(p.width, p.height), h: Math.min(p.width, p.height) } : { w: Math.min(p.width, p.height), h: Math.max(p.width, p.height) };
}
