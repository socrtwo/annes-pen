/** Built-in styles, style sets, and CSS generation for the document surface. */
import type { DocSettings, StyleDef } from './settings';

const P = (name: string, d: Partial<StyleDef>): StyleDef => ({ name, type: 'paragraph', builtin: true, ...d });
const C = (name: string, d: Partial<StyleDef>): StyleDef => ({ name, type: 'character', builtin: true, ...d });
const T = (name: string, d: Partial<StyleDef>): StyleDef => ({ name, type: 'table', builtin: true, ...d });

export const BUILTIN_STYLES: StyleDef[] = [
  P('Normal', { font: '+body', size: 11, spaceAfter: 8, lineHeight: '1.08', quick: true }),
  P('No Spacing', { basedOn: 'Normal', spaceAfter: 0, lineHeight: '1', quick: true }),
  P('Title', { basedOn: 'Normal', font: '+heading', size: 28, spaceAfter: 4, lineHeight: '1', spacing: -0.5, quick: true, next: 'Normal' }),
  P('Subtitle', { basedOn: 'Normal', size: 13, color: '#5a5a5a', spacing: 0.75, quick: true, next: 'Normal' }),
  P('Heading 1', { basedOn: 'Normal', next: 'Normal', font: '+heading', size: 16, color: 'var(--qf-accent1-dark)', spaceBefore: 12, spaceAfter: 2, keepNext: true, keepLines: true, outlineLevel: 1, quick: true }),
  P('Heading 2', { basedOn: 'Heading 1', size: 13, spaceBefore: 6, outlineLevel: 2, quick: true }),
  P('Heading 3', { basedOn: 'Heading 1', size: 12, spaceBefore: 4, color: 'var(--qf-accent1-darker)', outlineLevel: 3, quick: true }),
  P('Heading 4', { basedOn: 'Heading 1', size: 11, italic: true, spaceBefore: 4, outlineLevel: 4 }),
  P('Heading 5', { basedOn: 'Heading 1', size: 11, spaceBefore: 4, outlineLevel: 5 }),
  P('Heading 6', { basedOn: 'Heading 1', size: 11, color: 'var(--qf-accent1-darker)', spaceBefore: 4, outlineLevel: 6 }),
  P('Heading 7', { basedOn: 'Heading 1', size: 11, italic: true, color: 'var(--qf-accent1-darker)', spaceBefore: 4, outlineLevel: 7 }),
  P('Heading 8', { basedOn: 'Heading 1', size: 10.5, color: '#272727', spaceBefore: 4, outlineLevel: 8 }),
  P('Heading 9', { basedOn: 'Heading 1', size: 10.5, italic: true, color: '#272727', spaceBefore: 4, outlineLevel: 9 }),
  P('Quote', { basedOn: 'Normal', italic: true, color: '#404040', align: 'center', indentLeft: 43, indentRight: 43, spaceBefore: 10, quick: true }),
  P('Intense Quote', { basedOn: 'Normal', italic: true, color: 'var(--qf-accent1)', align: 'center', indentLeft: 43, indentRight: 43, spaceBefore: 18, spaceAfter: 18, borderTop: '1px solid var(--qf-accent1)', borderBottom: '1px solid var(--qf-accent1)', quick: true }),
  P('List Paragraph', { basedOn: 'Normal', indentLeft: 36, quick: true }),
  P('Caption', { basedOn: 'Normal', size: 9, italic: true, color: 'var(--qf-accent1-dark)', spaceAfter: 10 }),
  P('Block Text', { basedOn: 'Normal', italic: true, color: 'var(--qf-accent1)', indentLeft: 58, indentRight: 58, borderLeft: '2px solid var(--qf-accent1)' }),
  P('Body Text', { basedOn: 'Normal', spaceAfter: 6 }),
  P('Body Text First Indent', { basedOn: 'Body Text', indentFirst: 18 }),
  P('Body Text Indent', { basedOn: 'Body Text', indentLeft: 18 }),
  P('Plain Text', { basedOn: 'Normal', font: 'Cousine', size: 10.5, spaceAfter: 0 }),
  P('Code', { basedOn: 'Normal', font: 'Cousine', size: 10, spaceAfter: 0, bg: '#f3f3f3', lineHeight: '1.2' }),
  P('Footnote Text', { basedOn: 'Normal', size: 10, spaceAfter: 0, lineHeight: '1' }),
  P('Endnote Text', { basedOn: 'Normal', size: 10, spaceAfter: 0, lineHeight: '1' }),
  P('Header', { basedOn: 'Normal', spaceAfter: 0, lineHeight: '1' }),
  P('Footer', { basedOn: 'Normal', spaceAfter: 0, lineHeight: '1' }),
  P('TOC Heading', { basedOn: 'Heading 1', outlineLevel: 0 }),
  P('TOC 1', { basedOn: 'Normal', spaceAfter: 5 }),
  P('TOC 2', { basedOn: 'Normal', spaceAfter: 5, indentLeft: 11 }),
  P('TOC 3', { basedOn: 'Normal', spaceAfter: 5, indentLeft: 22 }),
  P('Bibliography', { basedOn: 'Normal', indentLeft: 36, indentFirst: -36 }),
  P('Index 1', { basedOn: 'Normal', spaceAfter: 0, indentLeft: 11, indentFirst: -11 }),
  P('Index 2', { basedOn: 'Normal', spaceAfter: 0, indentLeft: 22, indentFirst: -11 }),
  P('Index Heading', { basedOn: 'Normal', bold: true }),
  P('Table of Figures', { basedOn: 'Normal', spaceAfter: 0 }),
  P('Envelope Address', { basedOn: 'Normal', size: 12, indentLeft: 216, spaceAfter: 0 }),
  P('Envelope Return', { basedOn: 'Normal', size: 10, spaceAfter: 0 }),
  P('Salutation', { basedOn: 'Normal' }),
  P('Closing', { basedOn: 'Normal', indentLeft: 216 }),
  P('Signature', { basedOn: 'Normal', indentLeft: 216 }),
  P('Date', { basedOn: 'Normal' }),
  P('Note Heading', { basedOn: 'Normal', align: 'center' }),
  P('Message Header', { basedOn: 'Normal', font: '+heading', bg: '#e8e8e8', indentLeft: 54, indentFirst: -54 }),
  P('Screenplay Scene', { basedOn: 'Normal', font: 'Courier Prime', size: 12, caps: true, spaceBefore: 12, spaceAfter: 12, keepNext: true }),
  P('Screenplay Action', { basedOn: 'Normal', font: 'Courier Prime', size: 12, spaceAfter: 12 }),
  P('Screenplay Character', { basedOn: 'Normal', font: 'Courier Prime', size: 12, caps: true, indentLeft: 158, spaceAfter: 0, keepNext: true }),
  P('Screenplay Dialogue', { basedOn: 'Normal', font: 'Courier Prime', size: 12, indentLeft: 72, indentRight: 108, spaceAfter: 12 }),
  P('Screenplay Parenthetical', { basedOn: 'Normal', font: 'Courier Prime', size: 12, indentLeft: 115, indentRight: 144, spaceAfter: 0 }),
  P('Screenplay Transition', { basedOn: 'Normal', font: 'Courier Prime', size: 12, caps: true, align: 'right', spaceAfter: 12 }),
  P('Verse', { basedOn: 'Normal', indentLeft: 36, spaceAfter: 0, italic: false }),
  P('Epigraph', { basedOn: 'Normal', italic: true, indentLeft: 108, size: 10 }),
  P('Hanging Indent', { basedOn: 'Normal', indentLeft: 36, indentFirst: -36 }),

  C('Default Paragraph Font', {}),
  C('Emphasis', { italic: true, quick: true }),
  C('Strong', { bold: true, quick: true }),
  C('Subtle Emphasis', { italic: true, color: '#404040', quick: true }),
  C('Intense Emphasis', { italic: true, color: 'var(--qf-accent1)', quick: true }),
  C('Subtle Reference', { smallCaps: true, color: '#5a5a5a', quick: true }),
  C('Intense Reference', { smallCaps: true, bold: true, color: 'var(--qf-accent1)', spacing: 0.25, quick: true }),
  C('Book Title', { bold: true, italic: true, spacing: 0.25, quick: true }),
  C('Hyperlink', { color: '#0563c1', underline: true }),
  C('Followed Hyperlink', { color: '#954f72', underline: true }),
  C('HTML Code', { font: 'Cousine', size: 10 }),
  C('Keyboard', { font: 'Cousine', size: 10, bg: '#eee' } as any),
  C('Placeholder Text', { color: '#808080' }),
  C('Line Number', {}),
  C('Page Number', {}),

  T('Table Grid', { borders: 'all', borderColor: '#000' }),
  T('Plain Table', { borders: 'none' }),
  T('Plain Table Lines', { borders: 'horizontal', borderColor: '#bfbfbf' }),
  T('Grid Table Light', { borders: 'all', borderColor: '#bfbfbf' }),
  T('Grid Table Accent', { borders: 'all', borderColor: 'var(--qf-accent1-light)', headerBg: 'var(--qf-accent1)', headerColor: '#fff', bandBg: 'var(--qf-accent1-pale)' }),
  T('List Table', { borders: 'horizontal', borderColor: 'var(--qf-accent1)', headerBg: 'transparent', bandBg: '#f2f2f2' }),
  T('List Table Accent', { borders: 'outer', borderColor: 'var(--qf-accent1)', headerBg: 'var(--qf-accent1)', headerColor: '#fff', bandBg: 'var(--qf-accent1-pale)' }),
  T('Banded Rows', { borders: 'none', headerBg: '#404040', headerColor: '#fff', bandBg: '#efefef' }),
  T('Ledger', { borders: 'horizontal', borderColor: '#9bbb59', headerBg: '#e2efd9', bandBg: '#f4f9f1' }),
  T('Financial', { borders: 'horizontal', borderColor: '#000', headerBg: 'transparent' }),
];

/** Style sets reshape the built-in styles (Design ▸ Style Set). */
export const STYLE_SETS: Record<string, Record<string, any> & { _fonts?: [string, string] }> = {
  QuillPen: { _fonts: ['Carlito', 'Carlito'] }, // rename:keep — stored key of the default set; shown via designLabel()
  Classic: {
    _fonts: ['Tinos', 'Tinos'],
    Normal: { size: 12, spaceAfter: 0, lineHeight: '1.15' },
    'Heading 1': { color: '#000', size: 16, bold: true, align: 'center' },
    'Heading 2': { color: '#000', size: 14, bold: true },
    'Heading 3': { color: '#000', size: 12, bold: true, italic: true },
    Title: { align: 'center', size: 24, bold: true },
  },
  Modern: {
    _fonts: ['Lato', 'Open Sans'],
    Normal: { size: 10.5, spaceAfter: 10, lineHeight: '1.3' },
    'Heading 1': { size: 20, color: 'var(--qf-accent1)', spaceBefore: 24, borderBottom: '2px solid var(--qf-accent1)' },
    'Heading 2': { size: 14, color: '#333', caps: true, spacing: 1 },
    Title: { size: 34, color: 'var(--qf-accent1)' },
  },
  Elegant: {
    _fonts: ['EB Garamond', 'EB Garamond'],
    Normal: { size: 12, spaceAfter: 6, lineHeight: '1.25', align: 'justify' },
    'Heading 1': { size: 18, color: '#3b2f2f', smallCaps: true, spacing: 1, align: 'center' },
    'Heading 2': { size: 14, color: '#3b2f2f', italic: true },
    Title: { size: 32, smallCaps: true, align: 'center', color: '#3b2f2f' },
  },
  Book: {
    _fonts: ['EB Garamond', 'EB Garamond'],
    Normal: { size: 11.5, spaceAfter: 0, lineHeight: '1.3', align: 'justify', indentFirst: 18 },
    'Heading 1': { size: 18, align: 'center', color: '#000', spaceBefore: 72, spaceAfter: 36, pageBreakBefore: true },
    'Heading 2': { size: 13, align: 'center', color: '#000', smallCaps: true },
    Title: { size: 30, align: 'center', color: '#000' },
  },
  Manuscript: {
    _fonts: ['Tinos', 'Tinos'],
    Normal: { size: 12, spaceAfter: 0, lineHeight: '2', indentFirst: 36 },
    'Heading 1': { size: 12, align: 'center', color: '#000', bold: false, caps: true, spaceBefore: 0, spaceAfter: 0 },
    'Heading 2': { size: 12, align: 'center', color: '#000', bold: false, spaceBefore: 0 },
    Title: { size: 12, align: 'center', caps: true },
  },
  Academic: {
    _fonts: ['Tinos', 'Tinos'],
    Normal: { size: 12, spaceAfter: 0, lineHeight: '2', indentFirst: 36 },
    'Heading 1': { size: 12, bold: true, align: 'center', color: '#000', spaceBefore: 0, spaceAfter: 0 },
    'Heading 2': { size: 12, bold: true, align: 'left', color: '#000', spaceBefore: 0 },
    'Heading 3': { size: 12, bold: true, italic: true, color: '#000', spaceBefore: 0 },
    Title: { size: 12, bold: true, align: 'center' },
    Bibliography: { lineHeight: '2' },
  },
  Technical: {
    _fonts: ['Arimo', 'Arimo'],
    Normal: { size: 10, spaceAfter: 6, lineHeight: '1.2' },
    'Heading 1': { size: 15, bold: true, color: '#1f3864' },
    'Heading 2': { size: 12, bold: true, color: '#1f3864' },
    'Heading 3': { size: 10.5, bold: true, color: '#1f3864' },
  },
  Newsletter: {
    _fonts: ['Merriweather', 'Open Sans'],
    Normal: { size: 10, spaceAfter: 8, lineHeight: '1.35' },
    'Heading 1': { size: 22, color: '#c0504d', bold: true },
    Title: { size: 40, bold: true, color: '#c0504d', align: 'center' },
  },
  Typewriter: {
    _fonts: ['Courier Prime', 'Courier Prime'],
    Normal: { size: 12, spaceAfter: 12, lineHeight: '1' },
    'Heading 1': { size: 12, caps: true, color: '#000', bold: false, underline: true },
  },
};

/** What the Design tab shows for a style set or theme key (the default's key is the old "QuillPen"). */
export function designLabel(key: string): string {
  return key === 'QuillPen' ? 'Anne\'s Pen' : key; // rename:keep
}

// rename:keep — the default theme's key stays "QuillPen" for documents that store it.
export const THEMES: Record<string, { headingFont: string; bodyFont: string; accent: string[] }> = {
  QuillPen: { headingFont: 'Carlito', bodyFont: 'Carlito', accent: ['#2b579a', '#c0504d', '#9bbb59', '#8064a2', '#4bacc6', '#f79646'] },
  Slate: { headingFont: 'Arimo', bodyFont: 'Arimo', accent: ['#3f4f5f', '#6f8fa8', '#b7c9d8', '#9c6644', '#c58f6a', '#e0b590'] },
  Ink: { headingFont: 'Tinos', bodyFont: 'Tinos', accent: ['#1b1b1b', '#5c5c5c', '#8a8a8a', '#a33', '#336', '#363'] },
  Forest: { headingFont: 'Gelasio', bodyFont: 'Lato', accent: ['#2e6b30', '#7a9e3b', '#c7b24b', '#8a5a2b', '#3b6e8a', '#9a3d3d'] },
  Ocean: { headingFont: 'Open Sans', bodyFont: 'Open Sans', accent: ['#0e6ba8', '#0a9396', '#94d2bd', '#ee9b00', '#ca6702', '#ae2012'] },
  Plum: { headingFont: 'Libre Baskerville', bodyFont: 'Lato', accent: ['#6b2d5c', '#a64d79', '#d5a6bd', '#3d5a80', '#98c1d9', '#ee6c4d'] },
  Sunrise: { headingFont: 'Merriweather', bodyFont: 'Open Sans', accent: ['#d1495b', '#edae49', '#00798c', '#30638e', '#003d5b', '#66a182'] },
  Parchment: { headingFont: 'EB Garamond', bodyFont: 'EB Garamond', accent: ['#7a4e2d', '#a67c52', '#c9a66b', '#4a5d23', '#6b4226', '#8b0000'] },
  Mono: { headingFont: 'Courier Prime', bodyFont: 'Courier Prime', accent: ['#000000', '#333333', '#666666', '#999999', '#bbbbbb', '#dddddd'] },
};

/** Resolve the effective style map (built-in + style set + document overrides). */
export function resolveStyles(settings: DocSettings): Record<string, StyleDef> {
  const map: Record<string, StyleDef> = {};
  for (const s of BUILTIN_STYLES) map[s.name] = { ...s };
  const set = STYLE_SETS[settings.styleSet] || STYLE_SETS.QuillPen;
  for (const [name, over] of Object.entries(set)) {
    if (name === '_fonts' || !over) continue;
    map[name] = { ...(map[name] || { name, type: 'paragraph' }), ...(over as Partial<StyleDef>) } as StyleDef;
  }
  for (const [name, def] of Object.entries(settings.styles || {})) {
    map[name] = { ...(map[name] || {}), ...def, name } as StyleDef;
  }
  return map;
}

/** Flatten basedOn chains. */
export function effectiveStyle(map: Record<string, StyleDef>, name: string, depth = 0): StyleDef {
  const s = map[name];
  if (!s) return { name, type: 'paragraph' };
  if (!s.basedOn || depth > 12 || !map[s.basedOn]) return s;
  const base = effectiveStyle(map, s.basedOn, depth + 1);
  const merged: any = { ...base };
  for (const [k, v] of Object.entries(s)) if (v !== undefined) merged[k] = v;
  merged.name = s.name; merged.type = s.type; merged.quick = s.quick; merged.builtin = s.builtin;
  if (!('outlineLevel' in s)) merged.outlineLevel = s.type === 'paragraph' && /^Heading \d$/.test(s.name) ? base.outlineLevel : (s.name.startsWith('Heading') ? base.outlineLevel : undefined);
  return merged;
}

// Style values come from documents (.docx styles, .qpd files): nothing may end a string, a
// declaration or a rule, or load a resource, in the stylesheet built from them.

/** Text for inside a double-quoted CSS string. */
export function cssString(v: unknown): string {
  return String(v ?? '').replace(/["\\]/g, '\\$&').replace(/[\u0000-\u001f\u007f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}

/** A declaration value from document data, or '' when it is not a plain value. */
export function cssValue(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^[-\w\s#%.,()+*/]*$/.test(s) && !/url\s*\(|expression\s*\(|image(-set)?\s*\(|element\s*\(|\/\*/i.test(s) ? s : '';
}

const cssNum = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function fontStack(name: string | undefined, settings: DocSettings): string {
  if (!name) return '';
  const set = STYLE_SETS[settings.styleSet] || STYLE_SETS.QuillPen;
  const fonts = set._fonts || [settings.theme.headingFont, settings.theme.bodyFont];
  let fam = name;
  if (name === '+heading') fam = settings.styleSet === 'QuillPen' ? settings.theme.headingFont : fonts[0];
  if (name === '+body') fam = settings.styleSet === 'QuillPen' ? settings.theme.bodyFont : fonts[1];
  return `"${cssString(fam)}", ${genericFor(String(fam))}`;
}

export function genericFor(fam: string): string {
  const f = fam.toLowerCase();
  if (/mono|courier|cousine|consol|code|typewriter/.test(f)) return 'monospace';
  if (/serif|times|tinos|garamond|georgia|gelasio|cambria|caladea|baskerville|merriweather|book|palatino|roman/.test(f) && !/sans/.test(f)) return 'serif';
  return 'sans-serif';
}

function styleProps(s: StyleDef, settings: DocSettings, para: boolean): string {
  const out: string[] = [];
  const put = (prop: string, v: string, extra = '') => { if (v) out.push(`${prop}:${v}${extra}`); };
  const pt = (prop: string, v: unknown) => { const n = cssNum(v); if (n != null) out.push(`${prop}:${n}pt`); };
  if (s.font) out.push(`font-family:${fontStack(s.font, settings)}`);
  if (cssNum(s.size)) pt('font-size', s.size);
  if (s.bold !== undefined) out.push(`font-weight:${s.bold ? 700 : 400}`);
  if (s.italic !== undefined) out.push(`font-style:${s.italic ? 'italic' : 'normal'}`);
  if (s.underline) out.push('text-decoration:underline');
  put('color', cssValue(s.color));
  if (s.caps) out.push('text-transform:uppercase');
  if (s.smallCaps) out.push('font-variant-caps:small-caps');
  if (cssNum(s.spacing)) pt('letter-spacing', s.spacing);
  if (!para) put('background', cssValue((s as any).bg));
  if (para) {
    if (/^(left|right|center|justify|start|end)$/.test(String(s.align))) out.push(`text-align:${s.align}`);
    out.push(`padding-top:${cssNum(s.spaceBefore) ?? 0}pt`);
    out.push(`padding-bottom:${cssNum(s.spaceAfter) ?? 0}pt`);
    put('line-height', cssValue(s.lineHeight));
    pt('margin-left', s.indentLeft);
    pt('margin-right', s.indentRight);
    pt('text-indent', s.indentFirst);
    put('border-bottom', cssValue(s.borderBottom));
    put('border-top', cssValue(s.borderTop));
    put('border-left', cssValue(s.borderLeft), ';padding-left:6pt');
    put('background', cssValue(s.bg));
    if (s.pageBreakBefore) out.push('break-before:page');
  }
  return out.join(';');
}

const cssEscape = cssString;

function shade(hex: string, amt: number): string {
  // amt in -1..1; negative darkens, positive lightens
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  r = f(r); g = f(g); b = f(b);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** Produce the stylesheet that renders document styles. Scoped under `.qf-doc`. */
export function stylesCss(settings: DocSettings): string {
  const map = resolveStyles(settings);
  const acc = (Array.isArray(settings.theme.accent) ? settings.theme.accent : []).map((c) => cssValue(c) || '#2b579a');
  if (!acc.length) acc.push('#2b579a');
  const lines: string[] = [];
  lines.push(`.qf-doc{--qf-accent1:${acc[0]};--qf-accent1-dark:${shade(acc[0], -0.25)};--qf-accent1-darker:${shade(acc[0], -0.5)};--qf-accent1-light:${shade(acc[0], 0.45)};--qf-accent1-pale:${shade(acc[0], 0.85)};` +
    acc.map((c, i) => `--qf-accent${i + 1}:${c}`).join(';') + '}');
  const normal = effectiveStyle(map, 'Normal');
  lines.push(`.qf-doc .ProseMirror{${styleProps(normal, settings, false)}}`);
  lines.push(`.qf-doc .ProseMirror p:not([data-style]), .qf-doc .ProseMirror li > p:not([data-style]){${styleProps(normal, settings, true)}}`);
  for (const s of Object.values(map)) {
    if (s.name === 'Normal' || s.hidden) continue;
    const e = effectiveStyle(map, s.name);
    if (s.type === 'paragraph' || s.type === 'linked') {
      lines.push(`.qf-doc .ProseMirror [data-style="${cssEscape(s.name)}"]{${styleProps(e, settings, true)}}`);
    } else if (s.type === 'character') {
      lines.push(`.qf-doc .ProseMirror [data-cstyle="${cssEscape(s.name)}"]{${styleProps(e, settings, false)}}`);
    } else if (s.type === 'table') {
      const sel = `.qf-doc .ProseMirror table[data-style="${cssEscape(s.name)}"]`;
      const bc = cssValue(s.borderColor) || '#000';
      if (s.borders === 'all') lines.push(`${sel} td, ${sel} th{border:1px solid ${bc}}`);
      else if (s.borders === 'horizontal') lines.push(`${sel} td, ${sel} th{border:0;border-bottom:1px solid ${bc}}${sel}{border-top:1px solid ${bc}}`);
      else if (s.borders === 'outer') lines.push(`${sel}{border:1px solid ${bc}} ${sel} td, ${sel} th{border:0}`);
      else lines.push(`${sel} td, ${sel} th{border:0}`);
      if (cssValue(s.headerBg)) lines.push(`${sel}[data-header-rows] tr:first-child > *{background:${cssValue(s.headerBg)};color:${cssValue(s.headerColor) || 'inherit'};font-weight:700}`);
      if (cssValue(s.bandBg)) lines.push(`${sel}[data-banded="1"] tr:nth-child(even) > *{background:${cssValue(s.bandBg)}}`);
    }
  }
  if (settings.hyphenation) lines.push('.qf-doc .ProseMirror{hyphens:auto;-webkit-hyphens:auto}');
  return lines.join('\n');
}

export function quickStyles(settings: DocSettings): StyleDef[] {
  const map = resolveStyles(settings);
  return Object.values(map).filter((s) => s.quick && !s.hidden);
}

export function allStyles(settings: DocSettings, type?: StyleDef['type']): StyleDef[] {
  const map = resolveStyles(settings);
  return Object.values(map).filter((s) => !type || s.type === type || (type === 'paragraph' && s.type === 'linked'));
}
