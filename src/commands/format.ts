/** Character, paragraph, list and style commands (Home tab). */
import { escHtml, safeColor, safeNum } from '../util/sanitize';
import { def, type MenuEntry } from './registry';
import type { App } from '../app';
import { schema, PARA_DEFAULTS } from '../editor/schema';
import {
  markActive, markAttr, toggleMark, setMark, removeMarks, clearCharFormatting, clearAllFormatting,
  setParaAttrs, paraAttr, effectiveParaProp, setParagraphStyle, toggleList, listIndent, findListAncestor,
  mapSelectedText, transformCase, type CaseMode, currentParagraph, selectedParagraphs, wordAt,
} from '../editor/ops';
import { resolveStyles, effectiveStyle, quickStyles, allStyles } from '../editor/styles';
import { openDialog, colorMenu, toast, promptDialog } from '../ui/dialog';
import { toUnit, fromUnit } from '../prefs';
import { isNative } from '../platform/native';
import type { Mark } from 'prosemirror-model';

const M = schema.marks;
/** Browsers keep Ctrl+T, Ctrl+Shift+N/T/W for themselves: the web build lists an alternative first (see file.ts). */
const webKeys = (keys: string[], alt: string): string[] => (isNative() ? keys : [alt, ...keys]);
const N = schema.nodes;

export const BUNDLED_FONTS = ['Carlito', 'Caladea', 'Tinos', 'Arimo', 'Cousine', 'Gelasio', 'EB Garamond', 'Courier Prime', 'Libre Baskerville', 'Lato', 'Merriweather', 'Open Sans'];
export const ALIAS_FONTS = ['Calibri', 'Cambria', 'Times New Roman', 'Arial', 'Helvetica', 'Courier New', 'Georgia', 'Garamond'];
export const SYSTEM_FONTS = ['Roboto', 'Noto Sans', 'Noto Serif', 'Droid Sans Mono', 'sans-serif', 'serif', 'monospace', 'cursive', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Palatino Linotype', 'Book Antiqua', 'Century Gothic', 'Consolas', 'Comic Sans MS', 'Impact'];
export const ALL_FONTS = [...new Set([...BUNDLED_FONTS, ...ALIAS_FONTS, ...SYSTEM_FONTS])].sort((a, b) => a.localeCompare(b));
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

export const recentFonts: string[] = [];

export const lastColors = { font: '#c00000', highlight: '#ffff00', shading: '#d9e2f3', underline: '#c00000' };

/** A font family name safe inside a single-quoted CSS string in a style attribute. */
const cssStr = (v: unknown) => String(v ?? '').replace(/[^\p{L}\p{N} _.,-]/gu, '');

function v(app: App) { return app.view; }

/** Effective font size at the cursor (mark or style). */
export function currentFontSize(app: App): number | null {
  const s = markAttr(app.state, M.size, 'pt');
  if (s) return s;
  const p = currentParagraph(app.state);
  const map = resolveStyles(app.settings);
  const st = effectiveStyle(map, p?.attrs.style || 'Normal');
  return st.size || 11;
}

export function currentFontFamily(app: App): string {
  const f = markAttr(app.state, M.font, 'family');
  if (f) return f;
  const p = currentParagraph(app.state);
  const map = resolveStyles(app.settings);
  const st = effectiveStyle(map, p?.attrs.style || 'Normal');
  const fam = st.font || '+body';
  if (fam === '+body') return app.settings.theme.bodyFont + ' (Body)';
  if (fam === '+heading') return app.settings.theme.headingFont + ' (Headings)';
  return fam;
}

export function applyFont(app: App, family: string) {
  family = family.replace(/ \((Body|Headings)\)$/, '');
  if (!recentFonts.includes(family)) { recentFonts.unshift(family); recentFonts.splice(6); }
  setMark(v(app), M.font, family ? { family } : null);
}

export function applySize(app: App, pt: number) {
  if (!pt || pt < 1 || pt > 1638) { toast('Size must be between 1 and 1638 points.'); return; }
  setMark(v(app), M.size, { pt: Math.round(pt * 2) / 2 });
}

/** Grow/shrink each text run's size individually. */
function stepSize(app: App, dir: 1 | -1, fine = false) {
  const view = v(app);
  const { state } = view;
  const map = resolveStyles(app.settings);
  const next = (s: number) => {
    if (fine) return Math.max(1, s + dir);
    if (dir > 0) return FONT_SIZES.find((x) => x > s) ?? Math.min(1638, Math.ceil((s + 10) / 10) * 10);
    return [...FONT_SIZES].reverse().find((x) => x < s) ?? Math.max(1, s - 1);
  };
  if (state.selection.empty) { applySize(app, next(currentFontSize(app) || 11)); return; }
  const tr = state.tr;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos, parent) => {
    if (!node.isText) return;
    const from = Math.max(pos, state.selection.from), to = Math.min(pos + node.nodeSize, state.selection.to);
    const m = M.size.isInSet(node.marks);
    const base = m ? m.attrs.pt : effectiveStyle(map, parent?.attrs.style || 'Normal').size || 11;
    tr.removeMark(from, to, M.size).addMark(from, to, M.size.create({ pt: next(base) }));
  });
  view.dispatch(tr);
}

const fontMenu = (app: App): MenuEntry[] => {
  const cur = currentFontFamily(app).replace(/ \((Body|Headings)\)$/, '');
  const s = app.settings;
  const entry = (f: string, label = f): MenuEntry => ({ id: 'fmt.font', arg: f, label, preview: `font-family:"${f}"`, checked: f === cur });
  return [
    { heading: 'Theme Fonts' },
    entry(s.theme.headingFont, `${s.theme.headingFont} (Headings)`),
    entry(s.theme.bodyFont, `${s.theme.bodyFont} (Body)`),
    ...(recentFonts.length ? [{ heading: 'Recently Used' } as MenuEntry, ...recentFonts.map((f) => entry(f))] : []),
    { heading: 'All Fonts' },
    ...ALL_FONTS.map((f) => entry(f)),
    { separator: true },
    { id: 'fmt.fontOther', label: 'Other font…', icon: 'edit' },
  ];
};

function markToggle(id: string, label: string, icon: string, mark: () => any, keys?: string[], extra: Partial<Parameters<typeof def>[0]> = {}) {
  def({
    id, label, icon, tab: 'Home', group: 'Font', keys, kind: 'toggle', edits: true,
    run: (app) => toggleMark(v(app), mark()),
    isActive: (app) => markActive(app.state, mark()),
    ...(extra as any),
  });
}

// ------------------------------------------------------------------------------------------
// Font group

markToggle('fmt.bold', 'Bold', 'format_bold', () => M.bold, ['Mod-b', 'Mod-Shift-b'], { popular: true });
markToggle('fmt.italic', 'Italic', 'format_italic', () => M.italic, ['Mod-i', 'Mod-Shift-i'], { popular: true });
def({
  id: 'fmt.underline', label: 'Underline', icon: 'format_underlined', tab: 'Home', group: 'Font', keys: ['Mod-u'], kind: 'split', edits: true, popular: true,
  run: (app, arg) => {
    if (arg) setMark(v(app), M.underline, typeof arg === 'string' ? { style: arg } : arg);
    else toggleMark(v(app), M.underline);
  },
  isActive: (app) => markActive(app.state, M.underline),
  menu: () => [
    ...['single', 'double', 'thick', 'dotted', 'dashed', 'dotDash', 'wavy', 'words'].map((s) => ({ id: 'fmt.underline', arg: s, label: ({ single: 'Single', double: 'Double', thick: 'Thick', dotted: 'Dotted', dashed: 'Dashed', dotDash: 'Dot-dash', wavy: 'Wave', words: 'Words only' } as any)[s], preview: `text-decoration:underline ${s === 'dotDash' ? 'dashed' : s === 'thick' || s === 'words' ? 'solid' : s === 'single' ? 'solid' : s}` })),
    { separator: true },
    { id: 'fmt.underlineColor', label: 'Underline Color…', icon: 'format_color_text' },
    { id: 'fmt.underlineNone', label: 'Remove Underline', icon: 'format_clear' },
  ],
});
def([
  { id: 'fmt.underlineDouble', label: 'Double Underline', icon: 'format_underlined', tab: 'Home', group: 'Font', keys: ['Mod-Shift-d'], edits: true, run: (app) => setMark(v(app), M.underline, { style: 'double' }), isActive: (app) => markAttr(app.state, M.underline, 'style') === 'double' },
  { id: 'fmt.underlineWords', label: 'Word Underline', icon: 'format_underlined', tab: 'Home', group: 'Font', keys: webKeys(['Mod-Shift-w'], 'Alt-Shift-w'), edits: true, run: (app) => setMark(v(app), M.underline, { style: 'words' }) },
  { id: 'fmt.underlineDotted', label: 'Dotted Underline', icon: 'format_underlined', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.underline, { style: 'dotted' }) },
  { id: 'fmt.underlineWavy', label: 'Wavy Underline', icon: 'format_underlined', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.underline, { style: 'wavy' }) },
  { id: 'fmt.underlineNone', label: 'Remove Underline', icon: 'format_underlined', tab: 'Home', group: 'Font', edits: true, run: (app) => removeMarks(v(app), [M.underline]) },
  {
    id: 'fmt.underlineColor', label: 'Underline Color', icon: 'border_color', tab: 'Home', group: 'Font', edits: true,
    run: async (app) => {
      const c = await colorMenu(app.ui.anchorFor('fmt.underline'), { auto: 'Automatic' });
      if (c === undefined) return;
      const style = markAttr(app.state, M.underline, 'style') || 'single';
      setMark(v(app), M.underline, { style, color: c });
    },
  },
]);
markToggle('fmt.strike', 'Strikethrough', 'strikethrough_s', () => M.strike, ['Mod-Alt-s']);
markToggle('fmt.dstrike', 'Double Strikethrough', 'format_strikethrough', () => M.dstrike);
markToggle('fmt.sub', 'Subscript', 'subscript', () => M.sub, ['Mod-=']);
markToggle('fmt.sup', 'Superscript', 'superscript', () => M.sup, ['Mod-Shift-=']);
markToggle('fmt.smallcaps', 'Small Caps', 'text_fields', () => M.smallcaps, ['Mod-Shift-k']);
markToggle('fmt.allcaps', 'All Caps', 'match_case', () => M.allcaps, ['Mod-Shift-a']);
markToggle('fmt.hidden', 'Hidden Text', 'visibility_off', () => M.hidden, ['Mod-Shift-h']);
markToggle('fmt.code', 'Inline Code', 'code', () => M.code, ['Mod-`'], { origin: 'Markdown editors' });

def({
  id: 'fmt.font', label: 'Font', icon: 'font_download', tab: 'Home', group: 'Font', kind: 'font', edits: true, popular: true, keys: ['Mod-Shift-f'],
  run: (app, arg) => { if (typeof arg === 'string') applyFont(app, arg); else app.exec('fmt.fontDialog'); },
  menu: fontMenu,
});
def({
  id: 'fmt.fontOther', label: 'Other Font…', icon: 'font_download', tab: 'Home', group: 'Font', edits: true,
  run: async (app) => { const f = await promptDialog('Font', 'Font name (any installed font):', currentFontFamily(app)); if (f) applyFont(app, f); },
});
def({
  id: 'fmt.size', label: 'Font Size', icon: 'format_size', tab: 'Home', group: 'Font', kind: 'size', edits: true, popular: true, keys: ['Mod-Shift-p'],
  run: (app, arg) => { if (arg) applySize(app, Number(arg)); else app.exec('fmt.fontDialog'); },
  menu: (app) => FONT_SIZES.map((s) => ({ id: 'fmt.size', arg: s, label: String(s), checked: currentFontSize(app) === s })),
});
def([
  { id: 'fmt.grow', label: 'Increase Font Size', icon: 'text_increase', tab: 'Home', group: 'Font', keys: ['Mod-Shift-.', 'Mod-]'], edits: true, popular: true, run: (app) => stepSize(app, 1) },
  { id: 'fmt.shrink', label: 'Decrease Font Size', icon: 'text_decrease', tab: 'Home', group: 'Font', keys: ['Mod-Shift-,', 'Mod-['], edits: true, popular: true, run: (app) => stepSize(app, -1) },
  { id: 'fmt.grow1', label: 'Grow Font 1 Point', icon: 'text_increase', tab: 'Home', group: 'Font', edits: true, run: (app) => stepSize(app, 1, true) },
  { id: 'fmt.shrink1', label: 'Shrink Font 1 Point', icon: 'text_decrease', tab: 'Home', group: 'Font', edits: true, run: (app) => stepSize(app, -1, true) },
]);
for (const s of FONT_SIZES) def({ id: `fmt.size${String(s).replace('.', '_')}`, label: `Font Size ${s}`, icon: 'format_size', tab: 'Home', group: 'Font', edits: true, run: (app) => applySize(app, s), keywords: 'points pt' });

def({
  id: 'fmt.color', label: 'Font Color', icon: 'format_color_text', tab: 'Home', group: 'Font', kind: 'color', edits: true, popular: true,
  run: async (app, arg) => {
    if (arg === 'menu') {
      const c = await colorMenu(app.ui.anchorFor('fmt.color'), { auto: 'Automatic' });
      if (c === undefined) return;
      if (c) lastColors.font = c;
      setMark(v(app), M.color, c ? { color: c } : null);
      return;
    }
    const c = typeof arg === 'string' ? arg : lastColors.font;
    setMark(v(app), M.color, { color: c });
  },
});
def({
  id: 'fmt.highlight', label: 'Text Highlight Color', icon: 'ink_highlighter', tab: 'Home', group: 'Font', kind: 'color', edits: true, popular: true, keys: ['Mod-Alt-h'],
  run: async (app, arg) => {
    if (arg === 'menu') {
      const c = await colorMenu(app.ui.anchorFor('fmt.highlight'), { highlight: true, none: 'No Color' });
      if (c === undefined) return;
      if (c) lastColors.highlight = c;
      setMark(v(app), M.highlight, c ? { color: c } : null);
      return;
    }
    if (markActive(app.state, M.highlight) && arg == null) { removeMarks(v(app), [M.highlight]); return; }
    setMark(v(app), M.highlight, { color: typeof arg === 'string' ? arg : lastColors.highlight });
  },
  isActive: (app) => markActive(app.state, M.highlight),
});
def({ id: 'fmt.highlightNone', label: 'Remove Highlight', icon: 'format_color_reset', tab: 'Home', group: 'Font', edits: true, run: (app) => removeMarks(v(app), [M.highlight]) });
def({
  id: 'fmt.shading', label: 'Character Shading', icon: 'format_paint', tab: 'Home', group: 'Font', edits: true,
  run: (app) => (markActive(app.state, M.shading) ? removeMarks(v(app), [M.shading]) : setMark(v(app), M.shading, { color: '#d9d9d9' })),
  isActive: (app) => markActive(app.state, M.shading),
});
def({
  id: 'fmt.charBorder', label: 'Character Border', icon: 'crop_square', tab: 'Home', group: 'Font', edits: true,
  run: (app) => (markActive(app.state, M.charBorder) ? removeMarks(v(app), [M.charBorder]) : setMark(v(app), M.charBorder, { border: '1px solid currentColor' })),
  isActive: (app) => markActive(app.state, M.charBorder),
});
def([
  { id: 'fmt.clear', label: 'Clear All Formatting', icon: 'format_clear', tab: 'Home', group: 'Font', keys: ['Mod-Space'], edits: true, popular: true, run: (app) => clearAllFormatting(v(app)) },
  { id: 'fmt.clearChar', label: 'Clear Character Formatting', icon: 'format_clear', tab: 'Home', group: 'Font', edits: true, run: (app) => clearCharFormatting(v(app)) },
  { id: 'fmt.clearPara', label: 'Clear Paragraph Formatting', icon: 'format_clear', tab: 'Home', group: 'Paragraph', keys: ['Mod-q'], edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ ...PARA_DEFAULTS, style: a.style })) },
]);

// Change case
const CASES: [CaseMode, string, string][] = [
  ['sentence', 'Sentence case.', 'Sentence case'], ['lower', 'lowercase', 'lowercase'], ['upper', 'UPPERCASE', 'UPPERCASE'],
  ['capitalize', 'Capitalize Each Word', 'Capitalize Each Word'], ['title', 'Title Case (Smart)', 'Title Case'], ['toggle', 'tOGGLE cASE', 'tOGGLE cASE'], ['alternating', 'aLtErNaTiNg', 'aLtErNaTiNg cAsE'],
];
def({
  id: 'fmt.changeCase', label: 'Change Case', icon: 'match_case', tab: 'Home', group: 'Font', kind: 'menu', edits: true, keys: ['Shift-F3'],
  run: (app, arg) => {
    if (arg) { mapSelectedText(v(app), (t) => transformCase(t, arg), arg === 'sentence' || arg === 'title' || arg === 'capitalize' || arg === 'toggle'); return; }
    // Cycle: lower → upper → capitalize (Shift+F3 behavior); a collapsed cursor cycles the word it is in.
    const sel = app.state.selection;
    const t = sel.empty ? wordAt(sel.$from)?.text || '' : app.state.doc.textBetween(sel.from, sel.to);
    const mode: CaseMode = t === t.toUpperCase() ? 'lower' : t === t.toLowerCase() ? 'capitalize' : 'upper';
    mapSelectedText(v(app), (s) => transformCase(s, mode), true);
  },
  menu: () => CASES.map(([m, l]) => ({ id: 'fmt.changeCase', arg: m, label: l })),
});
for (const [m, , l] of CASES) def({ id: `fmt.case.${m}`, label: l, icon: 'match_case', tab: 'Home', group: 'Font', edits: true, run: (app) => mapSelectedText(v(app), (t) => transformCase(t, m), m === 'sentence' || m === 'title') });

// Text effects
const EFFECTS: [string, string][] = [['shadow', 'Shadow'], ['outline', 'Outline'], ['emboss', 'Emboss'], ['engrave', 'Engrave'], ['glow', 'Glow'], ['reflection', 'Reflection'], ['gradient', 'Gradient Fill'], ['neon', 'Neon'], ['3d', '3-D Extrude']];
def({
  id: 'fmt.effects', label: 'Text Effects and Typography', icon: 'auto_awesome', tab: 'Home', group: 'Font', kind: 'menu', edits: true,
  run: (app, arg) => {
    if (!arg) return app.exec('fmt.fontDialog', { tab: 'advanced' });
    if (arg === 'none') return removeMarks(v(app), [M.effect]);
    const cur = markAttr(app.state, M.effect, 'kind');
    if (cur === arg) removeMarks(v(app), [M.effect]); else setMark(v(app), M.effect, { kind: arg });
  },
  menu: (app) => [
    ...EFFECTS.map(([k, l]) => ({ id: 'fmt.effects', arg: k, label: l, checked: markAttr(app.state, M.effect, 'kind') === k })),
    { id: 'fmt.effects', arg: 'none', label: 'No Effect' },
    { separator: true },
    { id: 'fmt.ligatures', label: 'Ligatures', submenu: [
      { id: 'fmt.ligatures', arg: 'common-ligatures', label: 'Standard Only' },
      { id: 'fmt.ligatures', arg: 'common-ligatures discretionary-ligatures', label: 'Standard and Discretionary' },
      { id: 'fmt.ligatures', arg: 'historical-ligatures', label: 'Historical' },
      { id: 'fmt.ligatures', arg: 'none', label: 'None' },
    ] },
    { id: 'fmt.numerals', label: 'Number Styles', submenu: [
      { id: 'fmt.numerals', arg: 'oldstyle-nums', label: 'Old-style' },
      { id: 'fmt.numerals', arg: 'lining-nums', label: 'Lining' },
      { id: 'fmt.numerals', arg: 'tabular-nums', label: 'Tabular' },
      { id: 'fmt.numerals', arg: 'proportional-nums', label: 'Proportional' },
      { id: 'fmt.numerals', arg: 'diagonal-fractions', label: 'Fractions' },
      { id: 'fmt.numerals', arg: 'slashed-zero', label: 'Slashed Zero' },
      { id: 'fmt.numerals', arg: 'normal', label: 'Default' },
    ] },
    { id: 'fmt.stylisticSet', label: 'Stylistic Sets…' },
    { id: 'fmt.kerning', label: 'Kerning', checked: markAttr(app.state, M.typo, 'kerning') === 'normal' },
  ],
});
for (const [k, l] of EFFECTS) def({ id: `fmt.effect.${k}`, label: `Text Effect: ${l}`, icon: 'auto_awesome', tab: 'Home', group: 'Font', edits: true, run: (app) => app.exec('fmt.effects', k) });

function setTypo(app: App, patch: Record<string, any>) {
  const cur = { features: markAttr(app.state, M.typo, 'features') || '', kerning: markAttr(app.state, M.typo, 'kerning'), numerals: markAttr(app.state, M.typo, 'numerals'), ligatures: markAttr(app.state, M.typo, 'ligatures') };
  const next = { ...cur, ...patch };
  const empty = !next.features && !next.kerning && !next.numerals && !next.ligatures;
  setMark(v(app), M.typo, empty ? null : next);
}
def([
  { id: 'fmt.ligatures', label: 'Ligatures', icon: 'text_format', tab: 'Home', group: 'Font', edits: true, origin: 'Desktop typography (OpenType)', run: (app, arg) => setTypo(app, { ligatures: arg && arg !== 'normal' ? arg : arg === 'none' ? 'none' : null }) },
  { id: 'fmt.numerals', label: 'Number Forms', icon: 'pin', tab: 'Home', group: 'Font', edits: true, run: (app, arg) => setTypo(app, { numerals: arg && arg !== 'normal' ? arg : null }) },
  { id: 'fmt.kerning', label: 'Kerning for Fonts', icon: 'format_letter_spacing', tab: 'Home', group: 'Font', edits: true, run: (app) => setTypo(app, { kerning: markAttr(app.state, M.typo, 'kerning') === 'normal' ? 'none' : 'normal' }) },
  {
    id: 'fmt.stylisticSet', label: 'Stylistic Set', icon: 'style', tab: 'Home', group: 'Font', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'OpenType Features', help: 'Enter OpenType feature tags. Examples: "ss01" 1, "swsh" 1, "salt" 1, "c2sc" 1, "smcp" 1.', fields: [{ key: 'f', label: 'font-feature-settings', type: 'text', value: markAttr(app.state, M.typo, 'features') || '"ss01" 1' }] });
      if (r) setTypo(app, { features: r.f });
    },
  },
]);

def({
  id: 'fmt.charSpacing', label: 'Character Spacing', icon: 'format_letter_spacing', tab: 'Home', group: 'Font', kind: 'menu', edits: true,
  run: (app, arg) => {
    if (arg === undefined) return app.exec('fmt.fontDialog', { tab: 'advanced' });
    setMark(v(app), M.spacing, arg ? { pt: arg } : null);
  },
  menu: () => [
    { id: 'fmt.charSpacing', arg: -1, label: 'Very Tight (−1 pt)' }, { id: 'fmt.charSpacing', arg: -0.5, label: 'Tight (−0.5 pt)' },
    { id: 'fmt.charSpacing', arg: 0, label: 'Normal' }, { id: 'fmt.charSpacing', arg: 1, label: 'Loose (+1 pt)' },
    { id: 'fmt.charSpacing', arg: 2, label: 'Very Loose (+2 pt)' }, { id: 'fmt.charSpacing', arg: 4, label: 'Spaced (+4 pt)' },
  ],
});
def([
  { id: 'fmt.expand', label: 'Expand Character Spacing', icon: 'format_letter_spacing_wide', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.spacing, { pt: (markAttr(app.state, M.spacing, 'pt') || 0) + 0.5 }) },
  { id: 'fmt.condense', label: 'Condense Character Spacing', icon: 'format_letter_spacing_standard', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.spacing, { pt: (markAttr(app.state, M.spacing, 'pt') || 0) - 0.5 }) },
  { id: 'fmt.raise', label: 'Raise Text Position', icon: 'arrow_upward', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.position, { pt: (markAttr(app.state, M.position, 'pt') || 0) + 1 }) },
  { id: 'fmt.lower', label: 'Lower Text Position', icon: 'arrow_downward', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.position, { pt: (markAttr(app.state, M.position, 'pt') || 0) - 1 }) },
  { id: 'fmt.scaleWide', label: 'Widen Characters (Scale)', icon: 'expand', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.scale, { pct: Math.min(600, (markAttr(app.state, M.scale, 'pct') || 100) + 10) }) },
  { id: 'fmt.scaleNarrow', label: 'Narrow Characters (Scale)', icon: 'compress', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.scale, { pct: Math.max(10, (markAttr(app.state, M.scale, 'pct') || 100) - 10) }) },
  {
    id: 'fmt.phonetic', label: 'Phonetic Guide (Ruby)', icon: 'translate', tab: 'Home', group: 'Font', edits: true, origin: 'East Asian typography',
    run: async (app) => {
      const t = await promptDialog('Phonetic Guide', 'Ruby text shown above the selection:', markAttr(app.state, M.ruby, 'text') || '');
      if (t === null) return;
      setMark(v(app), M.ruby, t ? { text: t } : null);
    },
  },
  {
    id: 'fmt.ltrRun', label: 'Left-to-Right Text Run', icon: 'format_textdirection_l_to_r', tab: 'Home', group: 'Font', edits: true,
    run: (app) => setMark(v(app), M.dir, { dir: 'ltr' }),
  },
  { id: 'fmt.rtlRun', label: 'Right-to-Left Text Run', icon: 'format_textdirection_r_to_l', tab: 'Home', group: 'Font', edits: true, run: (app) => setMark(v(app), M.dir, { dir: 'rtl' }) },
  {
    id: 'fmt.language', label: 'Set Proofing Language', icon: 'language', tab: 'Review', group: 'Language', edits: true,
    run: async (app) => {
      const langs = ['en', 'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IE', 'en-IN', 'en-NZ', 'en-ZA', 'en-SG', 'en-PH', 'en-HK', 'en-MY', 'en-NG', 'en-KE', 'en-JM', 'en-TT', 'en-BZ', 'en-ZW', 'es-ES', 'es-MX', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'pl-PL', 'cs-CZ', 'ru-RU', 'uk-UA', 'el-GR', 'tr-TR', 'he-IL', 'ar-SA', 'hi-IN', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'la', 'grc'];
      // Every language with a downloadable dictionary (Review ▸ Spelling Dictionaries).
      for (const d of (await import('../proof/dictionaries')).CATALOG) if (!langs.some((l) => l.toLowerCase() === d.tag.toLowerCase())) langs.push(d.tag);
      const r = await openDialog({
        title: 'Language', fields: [
          { key: 'lang', label: 'Mark selected text as', type: 'list', options: langs, value: markAttr(app.state, M.lang, 'lang') || app.settings.language, rows: 10 },
          { key: 'noProof', label: 'Do not check spelling or grammar', type: 'checkbox', value: !!markAttr(app.state, M.lang, 'noProof') },
          { key: 'def', label: 'Set as document default', type: 'checkbox', value: false },
        ],
      });
      if (!r) return;
      if (r.def) app.updateSettings((s) => { s.language = r.lang; });
      else setMark(v(app), M.lang, { lang: r.lang, noProof: r.noProof });
    },
  },
  { id: 'fmt.noProof', label: 'Do Not Check Spelling', icon: 'spellcheck', tab: 'Review', group: 'Language', edits: true, run: (app) => setMark(v(app), M.lang, { lang: app.settings.language, noProof: true }) },
]);

// Format painter: click = once, double-click (arg 'sticky') = repeated
export const painter: { marks: readonly Mark[] | null; para: Record<string, any> | null; sticky: boolean } = { marks: null, para: null, sticky: false };
let stopPainter: (() => void) | null = null;
const PAINT_EVENTS = ['pointerdown', 'pointerup', 'pointercancel', 'keydown', 'keyup'];
def({
  id: 'fmt.painter', label: 'Format Painter', icon: 'format_paint', tab: 'Home', group: 'Clipboard', kind: 'toggle', keys: ['Mod-Shift-c'], popular: true,
  tip: 'Copy formatting from the selection, then select text to apply it. Long-press to keep it on.',
  run: (app, arg) => {
    if (stopPainter) { stopPainter(); return; }
    const st = app.state;
    painter.marks = st.selection.empty ? (st.storedMarks || st.selection.$from.marks()) : (st.doc.nodeAt(st.selection.from)?.marks || st.selection.$from.marks());
    const p = currentParagraph(st);
    painter.para = p ? { ...p.attrs, id: null } : null;
    painter.sticky = arg === 'sticky';
    app.ui.status('Format Painter: select the text to format' + (painter.sticky ? ' (Esc to stop)' : ''));
    // Paint the next selection the user makes, never the source (still selected when this runs), and only
    // once the mouse button or Shift is released, so a drag or Shift+arrows paints the whole range.
    let skip: { from: number; to: number } | null = st.selection.empty ? null : { from: st.selection.from, to: st.selection.to };
    let held = false;
    const onInput = (e: Event) => {
      const key = (e as KeyboardEvent).key;
      if (e.type === 'keydown' && key === 'Escape') { stop(); return; }
      if (e.type.startsWith('key') && key !== 'Shift') return;
      held = e.type === 'pointerdown' || e.type === 'keydown';
      if (!held) app.refresh();
    };
    const off = app.onRefresh(() => {
      const sel = app.state.selection;
      if (!painter.marks) { stop(); return; }
      if (held) return;
      if (sel.empty) { skip = null; return; }
      if (skip && sel.from === skip.from && sel.to === skip.to) return;
      applyPaintedFormat(app);
      skip = { from: app.state.selection.from, to: app.state.selection.to };
      if (!painter.sticky) stop();
    });
    const stop = () => {
      off();
      for (const t of PAINT_EVENTS) document.removeEventListener(t, onInput, true);
      painter.marks = null; painter.para = null; stopPainter = null;
      app.ui.status('');
      app.refresh();
    };
    for (const t of PAINT_EVENTS) document.addEventListener(t, onInput, true);
    stopPainter = stop;
  },
  isActive: () => !!stopPainter,
});
function applyPaintedFormat(app: App) {
  const view = v(app);
  const { state } = view;
  const { from, to } = state.selection;
  const tr = state.tr;
  for (const t of Object.values(M)) if (!['link', 'comment', 'insertion', 'deletion'].includes(t.name)) tr.removeMark(from, to, t);
  for (const m of painter.marks || []) if (!['link', 'comment', 'insertion', 'deletion'].includes(m.type.name)) tr.addMark(from, to, m);
  const whole = selectedParagraphs(state).length > 1 || (state.selection.$from.parentOffset === 0 && state.selection.$to.parentOffset === state.selection.$to.parent.content.size);
  if (painter.para && whole) for (const { node, pos } of selectedParagraphs(state)) tr.setNodeMarkup(pos, undefined, { ...painter.para, id: node.attrs.id });
  view.dispatch(tr);
}
def([
  {
    id: 'fmt.copyFormat', label: 'Copy Formatting', icon: 'content_copy', tab: 'Home', group: 'Clipboard',
    run: (app) => { const st = app.state; painter.marks = st.selection.$from.marks(); const p = currentParagraph(st); painter.para = p ? { ...p.attrs } : null; toast('Formatting copied'); },
  },
  {
    id: 'fmt.pasteFormat', label: 'Paste Formatting', icon: 'content_paste', tab: 'Home', group: 'Clipboard', edits: true,
    run: (app) => { if (!painter.marks) { toast('Copy formatting first.'); return; } applyPaintedFormat(app); },
  },
]);

// ------------------------------------------------------------------------------------------
// Paragraph group

const ALIGNS: [string, string, string, string[]][] = [
  ['left', 'Align Left', 'format_align_left', ['Mod-l']], ['center', 'Center', 'format_align_center', ['Mod-e']],
  ['right', 'Align Right', 'format_align_right', ['Mod-r']], ['justify', 'Justify', 'format_align_justify', ['Mod-j']],
  ['distribute', 'Distributed', 'format_align_justify', ['Mod-Shift-j']],
];
for (const [a, label, ic, keys] of ALIGNS) {
  def({
    id: `para.align.${a}`, label, icon: ic, tab: 'Home', group: 'Paragraph', kind: 'toggle', keys, edits: true, popular: a !== 'distribute',
    run: (app) => setParaAttrs(v(app), { align: a === 'left' ? null : a }),
    isActive: (app) => (effectiveParaProp(app.state, 'align') || 'left') === a,
  });
}

const LINE_SPACINGS = ['1.0', '1.15', '1.5', '2.0', '2.5', '3.0'];
def({
  id: 'para.lineSpacing', label: 'Line and Paragraph Spacing', icon: 'format_line_spacing', tab: 'Home', group: 'Paragraph', kind: 'menu', edits: true, popular: true,
  run: (app, arg) => { if (arg) setParaAttrs(v(app), { lineHeight: String(arg) }); else app.exec('para.dialog'); },
  menu: (app) => [
    ...LINE_SPACINGS.map((s) => ({ id: 'para.lineSpacing', arg: s, label: s, checked: String(effectiveParaProp(app.state, 'lineHeight') ?? '') === s || parseFloat(effectiveParaProp(app.state, 'lineHeight')) === parseFloat(s) })),
    { separator: true },
    { id: 'para.dialog', label: 'Line Spacing Options…' },
    { separator: true },
    { id: 'para.spaceBeforeToggle', label: (paraAttr(app.state, 'spaceBefore') ?? 0) > 0 ? 'Remove Space Before Paragraph' : 'Add Space Before Paragraph' },
    { id: 'para.spaceAfterToggle', label: (paraAttr(app.state, 'spaceAfter') ?? 1) === 0 ? 'Add Space After Paragraph' : 'Remove Space After Paragraph' },
  ],
});
def([
  { id: 'para.single', label: 'Single Spacing', icon: 'format_line_spacing', tab: 'Home', group: 'Paragraph', keys: ['Mod-1'], edits: true, run: (app) => setParaAttrs(v(app), { lineHeight: '1.0' }) },
  { id: 'para.onehalf', label: '1.5 Line Spacing', icon: 'format_line_spacing', tab: 'Home', group: 'Paragraph', keys: ['Mod-5'], edits: true, run: (app) => setParaAttrs(v(app), { lineHeight: '1.5' }) },
  { id: 'para.double', label: 'Double Spacing', icon: 'format_line_spacing', tab: 'Home', group: 'Paragraph', keys: ['Mod-2'], edits: true, run: (app) => setParaAttrs(v(app), { lineHeight: '2.0' }) },
  { id: 'para.spaceBeforeToggle', label: 'Add/Remove Space Before', icon: 'vertical_align_top', tab: 'Home', group: 'Paragraph', keys: ['Mod-0'], edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ spaceBefore: (a.spaceBefore ?? 0) > 0 ? 0 : 12 })) },
  { id: 'para.spaceAfterToggle', label: 'Add/Remove Space After', icon: 'vertical_align_bottom', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ spaceAfter: a.spaceAfter === 0 ? 8 : 0 })) },
  { id: 'para.indent', label: 'Increase Indent', icon: 'format_indent_increase', tab: 'Home', group: 'Paragraph', keys: ['Mod-m'], edits: true, popular: true, run: (app) => listIndent(v(app), 1) },
  { id: 'para.outdent', label: 'Decrease Indent', icon: 'format_indent_decrease', tab: 'Home', group: 'Paragraph', keys: ['Mod-Shift-m'], edits: true, popular: true, run: (app) => listIndent(v(app), -1) },
  { id: 'para.hanging', label: 'Hanging Indent', icon: 'format_indent_increase', tab: 'Home', group: 'Paragraph', keys: webKeys(['Mod-t'], 'Alt-Shift-h'), edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ indentLeft: (a.indentLeft || 0) + 36, indentFirst: -36 })) },
  { id: 'para.unhang', label: 'Remove Hanging Indent', icon: 'format_indent_decrease', tab: 'Home', group: 'Paragraph', keys: webKeys(['Mod-Shift-t'], 'Alt-Shift-g'), edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ indentLeft: Math.max(0, (a.indentLeft || 0) - 36) || null, indentFirst: null })) },
  { id: 'para.firstLine', label: 'First-Line Indent', icon: 'format_indent_increase', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ indentFirst: a.indentFirst > 0 ? null : 36 })), isActive: (app) => (paraAttr(app.state, 'indentFirst') || 0) > 0 },
  { id: 'para.ltr', label: 'Left-to-Right Text Direction', icon: 'format_textdirection_l_to_r', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => setParaAttrs(v(app), { dir: 'ltr' }), isActive: (app) => paraAttr(app.state, 'dir') === 'ltr' },
  { id: 'para.rtl', label: 'Right-to-Left Text Direction', icon: 'format_textdirection_r_to_l', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => setParaAttrs(v(app), { dir: 'rtl' }), isActive: (app) => paraAttr(app.state, 'dir') === 'rtl' },
  { id: 'para.keepNext', label: 'Keep with Next', icon: 'link', tab: 'Layout', group: 'Paragraph', kind: 'toggle', edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ keepNext: !a.keepNext })), isActive: (app) => !!paraAttr(app.state, 'keepNext') },
  { id: 'para.keepLines', label: 'Keep Lines Together', icon: 'view_agenda', tab: 'Layout', group: 'Paragraph', kind: 'toggle', edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ keepLines: !a.keepLines })), isActive: (app) => !!paraAttr(app.state, 'keepLines') },
  { id: 'para.pageBreakBefore', label: 'Page Break Before', icon: 'insert_page_break', tab: 'Layout', group: 'Paragraph', kind: 'toggle', edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ pageBreakBefore: !a.pageBreakBefore })), isActive: (app) => !!paraAttr(app.state, 'pageBreakBefore') },
  { id: 'para.widow', label: 'Widow/Orphan Control', icon: 'vertical_split', tab: 'Layout', group: 'Paragraph', kind: 'toggle', edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ widowControl: !a.widowControl })), isActive: (app) => paraAttr(app.state, 'widowControl') !== false },
  { id: 'para.suppressLineNumbers', label: 'Suppress Line Numbers', icon: 'format_list_numbered', tab: 'Layout', group: 'Paragraph', kind: 'toggle', edits: true, run: (app) => setParaAttrs(v(app), (a) => ({ suppressLineNumbers: !a.suppressLineNumbers })), isActive: (app) => !!paraAttr(app.state, 'suppressLineNumbers') },
  { id: 'para.hiddenPara', label: 'Hidden Paragraph', icon: 'visibility_off', tab: 'Home', group: 'Paragraph', kind: 'toggle', edits: true, origin: 'LibreOffice Writer hidden paragraphs', run: (app) => setParaAttrs(v(app), (a) => ({ hidden: !a.hidden })), isActive: (app) => !!paraAttr(app.state, 'hidden') },
]);

def({
  id: 'para.shading', label: 'Paragraph Shading', icon: 'format_color_fill', tab: 'Home', group: 'Paragraph', kind: 'color', edits: true,
  run: async (app, arg) => {
    if (arg === 'menu') {
      const c = await colorMenu(app.ui.anchorFor('para.shading'), { none: 'No Color' });
      if (c === undefined) return;
      if (c) lastColors.shading = c;
      setParaAttrs(v(app), { bg: c });
      return;
    }
    setParaAttrs(v(app), { bg: typeof arg === 'string' ? arg : lastColors.shading });
  },
});

const BORDER_KINDS: [string, string, string][] = [
  ['bottom', 'Bottom Border', 'border_bottom'], ['top', 'Top Border', 'border_top'], ['left', 'Left Border', 'border_left'], ['right', 'Right Border', 'border_right'],
  ['none', 'No Border', 'border_clear'], ['all', 'All Borders', 'border_all'], ['outside', 'Outside Borders', 'border_outer'], ['inside', 'Inside Borders', 'border_inner'],
  ['insideH', 'Inside Horizontal Border', 'border_horizontal'], ['box', 'Box (Double)', 'check_box_outline_blank'], ['shadow', 'Shadow Box', 'select_all'],
];
export const borderPrefs = { style: 'solid', width: 0.75, color: '#000000' };
function applyParaBorder(app: App, kind: string) {
  const line = `${borderPrefs.width}pt ${borderPrefs.style} ${borderPrefs.color}`;
  if (app.ui.inTable()) { app.exec('table.borders', kind); return; }
  setParaAttrs(v(app), (a) => {
    let b: Record<string, string> = {};
    try { b = a.border ? JSON.parse(a.border) : {}; } catch { b = {}; }
    switch (kind) {
      case 'none': return { border: null };
      case 'all': case 'outside': b = { top: line, right: line, bottom: line, left: line, padding: '4' } as any; break;
      case 'box': b = { top: `3pt double ${borderPrefs.color}`, right: `3pt double ${borderPrefs.color}`, bottom: `3pt double ${borderPrefs.color}`, left: `3pt double ${borderPrefs.color}` }; break;
      case 'shadow': b = { top: line, left: line, right: `3pt solid ${borderPrefs.color}`, bottom: `3pt solid ${borderPrefs.color}` }; break;
      case 'inside': case 'insideH': b.bottom = line; break;
      default: if (b[kind]) delete b[kind]; else b[kind] = line;
    }
    return { border: Object.keys(b).length ? JSON.stringify(b) : null };
  });
}
def({
  id: 'para.borders', label: 'Borders', icon: 'border_bottom', tab: 'Home', group: 'Paragraph', kind: 'split', edits: true, popular: true,
  run: (app, arg) => applyParaBorder(app, arg || 'bottom'),
  menu: () => [
    ...BORDER_KINDS.map(([k, l, ic]) => ({ id: 'para.borders', arg: k, label: l, icon: ic })),
    { separator: true },
    { id: 'insert.hr', label: 'Horizontal Line', icon: 'horizontal_rule' },
    { id: 'para.borderStyle', label: 'Border Style, Width and Color…', icon: 'line_style' },
    { id: 'design.pageBorders', label: 'Page Borders…', icon: 'border_outer' },
  ],
});
for (const [k, l, ic] of BORDER_KINDS) def({ id: `para.border.${k}`, label: l, icon: ic, tab: 'Home', group: 'Paragraph', edits: true, run: (app) => applyParaBorder(app, k) });
def({
  id: 'para.borderStyle', label: 'Borders and Shading…', icon: 'line_style', tab: 'Home', group: 'Paragraph',
  run: async (app) => {
    const r = await openDialog({
      title: 'Borders and Shading', preview: '<p style="margin:0">Sample paragraph</p>', fields: [
        { key: 'style', label: 'Style', type: 'select', options: ['solid', 'dotted', 'dashed', 'double', 'groove', 'ridge', 'inset', 'outset'], value: borderPrefs.style, half: true },
        { key: 'width', label: 'Width (pt)', type: 'select', options: ['0.25', '0.5', '0.75', '1', '1.5', '2.25', '3', '4.5', '6'], value: String(borderPrefs.width), half: true },
        { key: 'color', label: 'Color', type: 'color', value: borderPrefs.color, half: true },
        { key: 'apply', label: 'Apply to', type: 'select', options: ['bottom', 'top', 'left', 'right', 'outside', 'none'], value: 'outside', half: true },
        { key: 'shade', label: 'Shading', type: 'color', value: (paraAttr(app.state, 'bg') as string) || '#ffffff', half: true },
        { key: 'useShade', label: 'Apply shading', type: 'checkbox', value: !!paraAttr(app.state, 'bg'), half: true },
      ],
      onChange: (vals, ctl) => ctl.setPreview(`<p style="margin:0;padding:4px;border:${vals.width}pt ${vals.style} ${vals.color};${vals.useShade ? 'background:' + vals.shade : ''}">Sample paragraph</p>`),
    });
    if (!r) return;
    Object.assign(borderPrefs, { style: r.style, width: parseFloat(r.width), color: r.color });
    applyParaBorder(app, r.apply);
    setParaAttrs(v(app), { bg: r.useShade ? r.shade : null });
  },
});

def({
  id: 'para.dialog', label: 'Paragraph Settings…', icon: 'tune', tab: 'Home', group: 'Paragraph', popular: true,
  run: async (app) => {
    const p = currentParagraph(app.state);
    if (!p) return;
    const a = p.attrs;
    const u = app.prefs.units;
    const lh = String(effectiveParaProp(app.state, 'lineHeight') || '1.08');
    const lhKind = lh.endsWith('pt') ? 'exact' : lh.startsWith('atleast:') ? 'atleast' : 'multiple';
    const lhVal = lhKind === 'multiple' ? parseFloat(lh) : parseFloat(lh.replace('atleast:', ''));
    const r = await openDialog({
      title: 'Paragraph', wide: true, preview: true,
      fields: [
        { key: 'h1', type: 'heading', label: 'General' },
        { key: 'align', label: 'Alignment', type: 'select', options: [{ value: '', label: 'Left' }, { value: 'center', label: 'Centered' }, { value: 'right', label: 'Right' }, { value: 'justify', label: 'Justified' }, { value: 'distribute', label: 'Distributed' }], value: a.align || '', half: true },
        { key: 'outline', label: 'Outline level', type: 'select', options: [{ value: '', label: 'Body Text' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: String(n), label: `Level ${n}` }))], value: a.outlineLevel ? String(a.outlineLevel) : '', half: true },
        { key: 'dir', label: 'Direction', type: 'select', options: [{ value: '', label: 'Default' }, { value: 'ltr', label: 'Left-to-right' }, { value: 'rtl', label: 'Right-to-left' }], value: a.dir || '', half: true },
        { key: 'h2', type: 'heading', label: `Indentation (${u})` },
        { key: 'left', label: 'Left', type: 'number', value: toUnit(a.indentLeft || 0, u), step: 0.1, half: true },
        { key: 'right', label: 'Right', type: 'number', value: toUnit(a.indentRight || 0, u), step: 0.1, half: true },
        { key: 'special', label: 'Special', type: 'select', options: [{ value: 'none', label: '(none)' }, { value: 'first', label: 'First line' }, { value: 'hanging', label: 'Hanging' }], value: a.indentFirst > 0 ? 'first' : a.indentFirst < 0 ? 'hanging' : 'none', half: true },
        { key: 'by', label: 'By', type: 'number', value: toUnit(Math.abs(a.indentFirst || 0) || 36, u), step: 0.1, half: true },
        { key: 'h3', type: 'heading', label: 'Spacing (pt)' },
        { key: 'before', label: 'Before', type: 'number', value: a.spaceBefore ?? effectiveParaProp(app.state, 'spaceBefore') ?? 0, step: 1, half: true },
        { key: 'after', label: 'After', type: 'number', value: a.spaceAfter ?? effectiveParaProp(app.state, 'spaceAfter') ?? 0, step: 1, half: true },
        { key: 'lhKind', label: 'Line spacing', type: 'select', options: [{ value: 'multiple', label: 'Multiple' }, { value: 'atleast', label: 'At least (pt)' }, { value: 'exact', label: 'Exactly (pt)' }], value: lhKind, half: true },
        { key: 'lhVal', label: 'At', type: 'number', value: lhVal, step: 0.05, half: true },
        { key: 'h4', type: 'heading', label: 'Line and Page Breaks' },
        { key: 'widow', label: 'Widow/Orphan control', type: 'checkbox', value: a.widowControl !== false, half: true },
        { key: 'keepNext', label: 'Keep with next', type: 'checkbox', value: !!a.keepNext, half: true },
        { key: 'keepLines', label: 'Keep lines together', type: 'checkbox', value: !!a.keepLines, half: true },
        { key: 'pbb', label: 'Page break before', type: 'checkbox', value: !!a.pageBreakBefore, half: true },
        { key: 'noLn', label: 'Suppress line numbers', type: 'checkbox', value: !!a.suppressLineNumbers, half: true },
        { key: 'hidden', label: 'Hidden paragraph', type: 'checkbox', value: !!a.hidden, half: true },
        { key: 'tab', label: 'Default tab stop (pt)', type: 'number', value: app.settings.defaultTab, half: true },
      ],
      onChange: (vals, ctl) => {
        const ind = fromUnit(vals.left || 0, u);
        const first = vals.special === 'first' ? fromUnit(vals.by || 0, u) : vals.special === 'hanging' ? -fromUnit(vals.by || 0, u) : 0;
        const lineH = vals.lhKind === 'multiple' ? vals.lhVal : `${vals.lhVal}pt`;
        ctl.setPreview(`<div style="font-size:9px;color:#999">Previous paragraph previous paragraph previous paragraph.</div><div style="margin:${vals.before}px ${fromUnit(vals.right || 0, u) / 3}px ${vals.after}px ${ind / 3}px;text-indent:${first / 3}px;line-height:${lineH};text-align:${vals.align || 'left'};font-size:10px">Sample text of the paragraph being formatted. Sample text of the paragraph being formatted. Sample text of the paragraph being formatted.</div><div style="font-size:9px;color:#999">Following paragraph following paragraph.</div>`);
      },
    });
    if (!r) return;
    const first = r.special === 'first' ? fromUnit(r.by || 0, u) : r.special === 'hanging' ? -fromUnit(r.by || 0, u) : null;
    const lineHeight = r.lhKind === 'multiple' ? String(r.lhVal) : r.lhKind === 'exact' ? `${r.lhVal}pt` : `atleast:${r.lhVal}`;
    setParaAttrs(v(app), {
      align: r.align || null, outlineLevel: r.outline ? parseInt(r.outline, 10) : null, dir: r.dir || null,
      indentLeft: r.left ? fromUnit(r.left, u) : null, indentRight: r.right ? fromUnit(r.right, u) : null, indentFirst: first,
      spaceBefore: r.before, spaceAfter: r.after, lineHeight,
      widowControl: r.widow, keepNext: r.keepNext, keepLines: r.keepLines, pageBreakBefore: r.pbb, suppressLineNumbers: r.noLn, hidden: r.hidden,
    });
    if (r.tab && r.tab !== app.settings.defaultTab) app.updateSettings((s) => { s.defaultTab = r.tab; });
  },
});

def({
  id: 'para.tabs', label: 'Tabs…', icon: 'keyboard_tab', tab: 'Home', group: 'Paragraph',
  run: async (app) => {
    const cur = paraAttr(app.state, 'tabs');
    let stops: { pos: number; align: string; leader: string }[] = [];
    try { stops = cur ? JSON.parse(cur) : []; } catch { /* */ }
    const r = await openDialog({
      title: 'Tabs', help: 'Tab stops for the selected paragraphs, one per line: position(pt) alignment leader. Example: "216 right dot". Alignments: left, center, right, decimal, bar. Leaders: none, dot, dash, underline.',
      fields: [
        { key: 'stops', label: 'Tab stops', type: 'textarea', rows: 6, value: stops.map((s) => `${s.pos} ${s.align} ${s.leader}`).join('\n') },
        { key: 'def', label: 'Default tab stops (pt)', type: 'number', value: app.settings.defaultTab },
      ],
    });
    if (!r) return;
    const list = String(r.stops).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p[0] && !isNaN(+p[0])).map((p) => ({ pos: +p[0], align: p[1] || 'left', leader: p[2] || 'none' }));
    setParaAttrs(v(app), { tabs: list.length ? JSON.stringify(list.sort((a, b) => a.pos - b.pos)) : null });
    if (r.def !== app.settings.defaultTab) app.updateSettings((s) => { s.defaultTab = r.def || 36; });
  },
});

// Drop cap
def({
  id: 'para.dropCap', label: 'Drop Cap', icon: 'format_size', tab: 'Insert', group: 'Text', kind: 'menu', edits: true,
  run: (app, arg) => setParaAttrs(v(app), { dropCap: arg === undefined ? (paraAttr(app.state, 'dropCap') ? 0 : 3) : arg }),
  menu: () => [{ id: 'para.dropCap', arg: 0, label: 'None' }, { id: 'para.dropCap', arg: 2, label: 'Dropped (2 lines)' }, { id: 'para.dropCap', arg: 3, label: 'Dropped (3 lines)' }, { id: 'para.dropCap', arg: 4, label: 'Dropped (4 lines)' }, { id: 'para.dropCap', arg: -3, label: 'In Margin' }],
  isActive: (app) => !!paraAttr(app.state, 'dropCap'),
});

// ------------------------------------------------------------------------------------------
// Lists

const BULLETS: [string, string][] = [['disc', '● Filled circle'], ['circle', '○ Hollow circle'], ['square', '■ Square'], ['➢', '➢ Arrow'], ['✓', '✓ Check mark'], ['◆', '◆ Diamond'], ['–', '– Dash'], ['★', '★ Star'], ['☞', '☞ Hand'], ['▸', '▸ Triangle'], ['❖', '❖ Ornament']];
def({
  id: 'list.bullets', label: 'Bullets', icon: 'format_list_bulleted', tab: 'Home', group: 'Paragraph', kind: 'split', edits: true, popular: true, keys: ['Mod-Shift-l'],
  run: (app, arg) => toggleList(v(app), N.bullet_list, arg ? { bullet: arg } : {}),
  isActive: (app) => findListAncestor(app.state)?.node.type === N.bullet_list,
  menu: () => [...BULLETS.map(([b, l]) => ({ id: 'list.bullets', arg: b, label: l })), { separator: true }, { id: 'list.defineBullet', label: 'Define New Bullet…' }],
});
const NUMFMTS: [string, string][] = [['decimal', '1. 2. 3.'], ['decimal-leading-zero', '01. 02. 03.'], ['lower-alpha', 'a. b. c.'], ['upper-alpha', 'A. B. C.'], ['lower-roman', 'i. ii. iii.'], ['upper-roman', 'I. II. III.'], ['lower-greek', 'α. β. γ.'], ['cjk-ideographic', '一. 二. 三.'], ['hebrew', 'א. ב. ג.']];
def({
  id: 'list.numbering', label: 'Numbering', icon: 'format_list_numbered', tab: 'Home', group: 'Paragraph', kind: 'split', edits: true, popular: true, keys: ['Mod-Shift-7'],
  run: (app, arg) => toggleList(v(app), N.ordered_list, arg ? { format: arg } : {}),
  isActive: (app) => findListAncestor(app.state)?.node.type === N.ordered_list,
  menu: () => [...NUMFMTS.map(([f, l]) => ({ id: 'list.numbering', arg: f, label: l })), { separator: true }, { id: 'list.setValue', label: 'Set Numbering Value…' }, { id: 'list.restart', label: 'Restart at 1' }, { id: 'list.continue', label: 'Continue Numbering' }],
});
def({
  id: 'list.multilevel', label: 'Multilevel List', icon: 'format_list_numbered_rtl', tab: 'Home', group: 'Paragraph', kind: 'menu', edits: true,
  run: (app, arg) => {
    const v0 = v(app);
    if (arg === 'outline') { toggleList(v0, N.ordered_list, { format: 'decimal', outline: true }); return; }
    if (arg === 'legal') { toggleList(v0, N.ordered_list, { format: 'decimal', outline: true }); return; }
    if (arg === 'headings') { app.exec('list.numberHeadings'); return; }
    toggleList(v0, N.ordered_list, { format: arg || 'decimal' });
  },
  menu: () => [
    { id: 'list.multilevel', arg: 'outline', label: '1. / 1.1. / 1.1.1. (Outline)' },
    { id: 'list.multilevel', arg: 'upper-roman', label: 'I. / A. / 1. (Traditional outline)' },
    { id: 'list.multilevel', arg: 'decimal', label: '1) / a) / i)' },
    { id: 'list.multilevel', arg: 'headings', label: 'Number all headings (1, 1.1, 1.1.1)' },
  ],
});
def({ id: 'list.checklist', label: 'Checklist', icon: 'checklist', tab: 'Home', group: 'Paragraph', kind: 'toggle', edits: true, origin: 'Note-taking apps', keys: ['Mod-Shift-9'], run: (app) => toggleList(v(app), N.task_list), isActive: (app) => findListAncestor(app.state)?.node.type === N.task_list });
def([
  { id: 'list.increaseLevel', label: 'Increase List Level', icon: 'format_indent_increase', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => listIndent(v(app), 1) },
  { id: 'list.decreaseLevel', label: 'Decrease List Level', icon: 'format_indent_decrease', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => listIndent(v(app), -1) },
  {
    id: 'list.setValue', label: 'Set Numbering Value…', icon: 'pin', tab: 'Home', group: 'Paragraph', edits: true,
    run: async (app) => {
      const anc = findListAncestor(app.state);
      if (!anc || anc.node.type !== N.ordered_list) { toast('Place the cursor in a numbered list.'); return; }
      const val = await promptDialog('Set Numbering Value', 'Start new list at:', String(anc.node.attrs.order), { type: 'number' });
      if (val == null) return;
      v(app).dispatch(app.state.tr.setNodeMarkup(anc.pos, undefined, { ...anc.node.attrs, order: Math.max(0, parseInt(val, 10) || 1) }));
    },
  },
  {
    id: 'list.restart', label: 'Restart Numbering', icon: 'restart_alt', tab: 'Home', group: 'Paragraph', edits: true,
    run: (app) => { const anc = findListAncestor(app.state); if (anc && anc.node.type === N.ordered_list) v(app).dispatch(app.state.tr.setNodeMarkup(anc.pos, undefined, { ...anc.node.attrs, order: 1 })); },
  },
  {
    id: 'list.continue', label: 'Continue Numbering', icon: 'east', tab: 'Home', group: 'Paragraph', edits: true,
    run: (app) => {
      const st = app.state;
      const anc = findListAncestor(st);
      if (!anc || anc.node.type !== N.ordered_list) return;
      // Only a preceding numbered list at the same level (same parent), not a nested sublist inside it.
      const $a = st.doc.resolve(anc.pos);
      let prev: { node: any } | null = null;
      for (let i = $a.index() - 1; i >= 0 && !prev; i--) { const n = $a.parent.child(i); if (n.type === N.ordered_list) prev = { node: n }; }
      if (!prev) { toast('No previous list to continue.'); return; }
      const p = prev as { node: any };
      v(app).dispatch(st.tr.setNodeMarkup(anc.pos, undefined, { ...anc.node.attrs, order: p.node.attrs.order + p.node.childCount, format: p.node.attrs.format }));
    },
  },
  {
    id: 'list.defineBullet', label: 'Define New Bullet…', icon: 'format_list_bulleted_add', tab: 'Home', group: 'Paragraph', edits: true,
    run: async (app) => { const b = await promptDialog('Define New Bullet', 'Bullet character (any symbol or emoji):', '➤'); if (b) toggleList(v(app), N.bullet_list, { bullet: b.trim() }); },
  },
  {
    id: 'list.numberHeadings', label: 'Heading Numbering (Chapter Numbering)', icon: 'format_list_numbered', tab: 'Home', group: 'Paragraph', edits: true, origin: 'LibreOffice chapter numbering',
    run: (app) => {
      const on = !(app.settings as any).headingNumbers;
      app.updateSettings((s) => { (s as any).headingNumbers = on; });
      toast(on ? 'Headings are numbered 1, 1.1, 1.1.1…' : 'Heading numbering off');
    },
    isActive: (app) => !!(app.settings as any).headingNumbers,
  },
  {
    id: 'list.convertToText', label: 'Convert List to Text', icon: 'notes', tab: 'Home', group: 'Paragraph', edits: true,
    run: (app) => {
      const st = app.state;
      const anc = findListAncestor(st);
      if (!anc) return;
      const paras: any[] = [];
      let n = anc.node.attrs.order || 1;
      anc.node.forEach((item: any) => {
        item.forEach((child: any, _o: number, idx: number) => {
          if (child.type === N.paragraph && idx === 0) {
            const prefix = anc.node.type === N.ordered_list ? `${n++}.\t` : anc.node.type === N.task_list ? (item.attrs.checked ? '☒ ' : '☐ ') : '•\t';
            const kids: any[] = [schema.text(prefix)];
            child.content.forEach((c: any) => kids.push(c));
            paras.push(N.paragraph.create(child.attrs, kids));
          } else paras.push(child);
        });
      });
      v(app).dispatch(st.tr.replaceWith(anc.pos, anc.pos + anc.node.nodeSize, paras));
    },
  },
]);

// ------------------------------------------------------------------------------------------
// Styles

def({
  id: 'style.apply', label: 'Styles', icon: 'style', tab: 'Home', group: 'Styles', kind: 'gallery', edits: true, popular: true, keys: ['Mod-Shift-s'],
  run: (app, arg) => { if (arg) setParagraphStyle(v(app), arg); else app.exec('style.applyDialog'); },
  menu: (app) => quickStyles(app.settings).map((s) => ({ id: 'style.apply', arg: s.name, label: s.name })),
  isActive: () => false,
});
def({
  id: 'style.applyDialog', label: 'Apply Styles…', icon: 'style', tab: 'Home', group: 'Styles', edits: true,
  run: async (app) => {
    const names = allStyles(app.settings).filter((s) => s.type !== 'table').map((s) => s.name).sort();
    const cur = currentParagraph(app.state)?.attrs.style || 'Normal';
    const r = await openDialog({ title: 'Apply Styles', fields: [{ key: 's', label: 'Style name', type: 'combo', options: names, value: cur, autofocus: true }] });
    if (r?.s) {
      if (!names.includes(r.s)) {
        app.updateSettings((s) => { s.styles[r.s] = { name: r.s, type: 'paragraph', basedOn: 'Normal', quick: true }; });
      }
      setParagraphStyle(v(app), r.s);
    }
  },
});
const styleKeys: Record<string, string[]> = { Normal: webKeys(['Mod-Shift-n'], 'Alt-Shift-n'), 'Heading 1': ['Mod-Alt-1'], 'Heading 2': ['Mod-Alt-2'], 'Heading 3': ['Mod-Alt-3'], 'List Bullet': [] };
const BUILTIN_PARA_STYLES = ['Normal', 'No Spacing', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Heading 7', 'Heading 8', 'Heading 9', 'Quote', 'Intense Quote', 'List Paragraph', 'Caption', 'Block Text', 'Body Text', 'Body Text First Indent', 'Plain Text', 'Code', 'Bibliography', 'Envelope Address', 'Salutation', 'Closing', 'Signature', 'Screenplay Scene', 'Screenplay Action', 'Screenplay Character', 'Screenplay Dialogue', 'Screenplay Parenthetical', 'Screenplay Transition', 'Verse', 'Epigraph', 'Hanging Indent'];
for (const name of BUILTIN_PARA_STYLES) {
  def({
    id: `style.p.${name.replace(/\s+/g, '')}`, label: `Style: ${name}`, icon: /Heading/.test(name) ? 'title' : 'format_paragraph', tab: 'Home', group: 'Styles', kind: 'toggle', keys: styleKeys[name], edits: true,
    run: (app) => setParagraphStyle(v(app), name),
    isActive: (app) => (currentParagraph(app.state)?.attrs.style || 'Normal') === name,
    keywords: name.startsWith('Screenplay') ? 'script film screenwriting' : '',
  });
}
for (const name of ['Emphasis', 'Strong', 'Subtle Emphasis', 'Intense Emphasis', 'Subtle Reference', 'Intense Reference', 'Book Title', 'Keyboard']) {
  def({ id: `style.c.${name.replace(/\s+/g, '')}`, label: `Character Style: ${name}`, icon: 'text_format', tab: 'Home', group: 'Styles', edits: true, run: (app) => setParagraphStyle(v(app), name), isActive: (app) => markAttr(app.state, M.charStyle, 'name') === name });
}
def([
  { id: 'style.clearChar', label: 'Clear Character Style', icon: 'format_clear', tab: 'Home', group: 'Styles', edits: true, run: (app) => removeMarks(v(app), [M.charStyle]) },
  { id: 'style.pane', label: 'Styles Pane', icon: 'view_sidebar', tab: 'Home', group: 'Styles', keys: ['Mod-Alt-Shift-s'], popular: true, run: (app) => app.ui.togglePane('styles') },
  { id: 'style.inspector', label: 'Style Inspector', icon: 'frame_inspect', tab: 'Home', group: 'Styles', origin: 'LibreOffice Style Inspector', run: (app) => app.ui.togglePane('inspector') },
  {
    id: 'style.create', label: 'Create a Style from Selection…', icon: 'add_circle', tab: 'Home', group: 'Styles', edits: true,
    run: async (app) => {
      const st = app.state;
      const p = currentParagraph(st);
      const marks = st.selection.$from.marks();
      const r = await openDialog({ title: 'Create New Style from Formatting', fields: [
        { key: 'name', label: 'Name', type: 'text', value: 'Style1', autofocus: true },
        { key: 'type', label: 'Style type', type: 'select', options: ['paragraph', 'character', 'linked'], value: 'paragraph' },
        { key: 'quick', label: 'Add to the Styles gallery', type: 'checkbox', value: true },
      ] });
      if (!r || !r.name) return;
      const def0: any = { name: r.name, type: r.type, basedOn: r.type === 'character' ? undefined : p?.attrs.style || 'Normal', quick: r.quick };
      for (const m of marks) {
        if (m.type === M.bold) def0.bold = true;
        if (m.type === M.italic) def0.italic = true;
        if (m.type === M.underline) def0.underline = true;
        if (m.type === M.font) def0.font = m.attrs.family;
        if (m.type === M.size) def0.size = m.attrs.pt;
        if (m.type === M.color) def0.color = m.attrs.color;
        if (m.type === M.smallcaps) def0.smallCaps = true;
        if (m.type === M.allcaps) def0.caps = true;
        if (m.type === M.spacing) def0.spacing = m.attrs.pt;
      }
      if (p && r.type !== 'character') {
        const a = p.attrs;
        if (a.align) def0.align = a.align;
        if (a.spaceBefore != null) def0.spaceBefore = a.spaceBefore;
        if (a.spaceAfter != null) def0.spaceAfter = a.spaceAfter;
        if (a.lineHeight) def0.lineHeight = a.lineHeight;
        if (a.indentLeft != null) def0.indentLeft = a.indentLeft;
        if (a.indentFirst != null) def0.indentFirst = a.indentFirst;
        if (a.keepNext) def0.keepNext = true;
      }
      app.updateSettings((s) => { s.styles[r.name] = def0; });
      if (r.type !== 'character') setParagraphStyle(v(app), r.name); else setMark(v(app), M.charStyle, { name: r.name });
      toast(`Style "${r.name}" created`);
    },
  },
  { id: 'style.modify', label: 'Modify Style…', icon: 'edit', tab: 'Home', group: 'Styles', edits: true, run: (app, arg) => modifyStyle(app, arg || currentParagraph(app.state)?.attrs.style || 'Normal') },
  {
    id: 'style.updateToMatch', label: 'Update Style to Match Selection', icon: 'sync', tab: 'Home', group: 'Styles', edits: true,
    run: (app) => {
      const st = app.state;
      const p = currentParagraph(st);
      if (!p) return;
      const name = p.attrs.style || 'Normal';
      const marks = st.selection.$from.marks();
      app.updateSettings((s) => {
        const d: any = { ...(s.styles[name] || {}), name, type: 'paragraph' };
        for (const m of marks) {
          if (m.type === M.bold) d.bold = true;
          if (m.type === M.italic) d.italic = true;
          if (m.type === M.font) d.font = m.attrs.family;
          if (m.type === M.size) d.size = m.attrs.pt;
          if (m.type === M.color) d.color = m.attrs.color;
        }
        const a = p.attrs;
        if (a.align) d.align = a.align;
        if (a.spaceBefore != null) d.spaceBefore = a.spaceBefore;
        if (a.spaceAfter != null) d.spaceAfter = a.spaceAfter;
        if (a.lineHeight) d.lineHeight = a.lineHeight;
        if (a.indentLeft != null) d.indentLeft = a.indentLeft;
        if (a.indentFirst != null) d.indentFirst = a.indentFirst;
        s.styles[name] = d;
      });
      toast(`Updated "${name}" to match selection`);
    },
  },
  {
    id: 'style.selectAllInstances', label: 'Select All Instances of Style', icon: 'select_all', tab: 'Home', group: 'Styles',
    run: (app) => {
      const name = currentParagraph(app.state)?.attrs.style || 'Normal';
      app.exec('edit.selectSimilar', { style: name });
    },
  },
  {
    id: 'style.manage', label: 'Manage Styles…', icon: 'settings', tab: 'Home', group: 'Styles',
    run: async (app) => {
      const names = allStyles(app.settings).map((s) => s.name).sort();
      const r = await openDialog({ title: 'Manage Styles', fields: [
        { key: 'name', label: 'Style', type: 'list', options: names, rows: 12, value: currentParagraph(app.state)?.attrs.style || 'Normal' },
        { key: 'action', label: 'Action', type: 'radio', options: [{ value: 'modify', label: 'Modify' }, { value: 'delete', label: 'Delete / revert to built-in' }, { value: 'gallery', label: 'Toggle in Styles gallery' }, { value: 'hide', label: 'Hide / unhide' }], value: 'modify' },
      ] });
      if (!r?.name) return;
      if (r.action === 'modify') return modifyStyle(app, r.name);
      app.updateSettings((s) => {
        const cur = resolveStyles(s)[r.name];
        if (r.action === 'delete') delete s.styles[r.name];
        if (r.action === 'gallery') s.styles[r.name] = { ...(s.styles[r.name] || { name: r.name, type: cur?.type || 'paragraph' }), quick: !cur?.quick };
        if (r.action === 'hide') s.styles[r.name] = { ...(s.styles[r.name] || { name: r.name, type: cur?.type || 'paragraph' }), hidden: !cur?.hidden };
      });
    },
  },
  {
    id: 'style.importFrom', label: 'Import Styles from Document…', icon: 'file_download', tab: 'Home', group: 'Styles', edits: true, origin: 'Organizer / Load Styles',
    run: async (app) => {
      const { openDocument, OPEN_ACCEPT, OPEN_MIMES } = await import('../platform/native');
      const { importFile } = await import('../io');
      const f = await openDocument(OPEN_ACCEPT, OPEN_MIMES);
      if (!f) return;
      const { doc } = await importFile(f.data, f.name);
      const src = (doc.attrs.settings || {}) as any;
      app.updateSettings((s) => { Object.assign(s.styles, src.styles || {}); if (src.styleSet) s.styleSet = src.styleSet; if (src.theme) s.theme = src.theme; });
      toast(`Imported ${Object.keys(src.styles || {}).length} styles`);
    },
  },
]);

export async function modifyStyle(app: App, name: string) {
  const map = resolveStyles(app.settings);
  const s = map[name] || { name, type: 'paragraph' };
  const e = effectiveStyle(map, name);
  const names = Object.keys(map).filter((n) => map[n].type !== 'table' && n !== name).sort();
  const r = await openDialog({
    title: `Modify Style: ${name}`, wide: true, preview: true,
    fields: [
      { key: 'basedOn', label: 'Based on', type: 'select', options: [{ value: '', label: '(no style)' }, ...names.map((n) => ({ value: n, label: n }))], value: s.basedOn || '', half: true },
      { key: 'next', label: 'Style for following paragraph', type: 'select', options: [{ value: '', label: '(same style)' }, ...names.map((n) => ({ value: n, label: n }))], value: s.next || '', half: true },
      { key: 'font', label: 'Font', type: 'combo', options: ['+body', '+heading', ...ALL_FONTS], value: e.font || '', half: true },
      { key: 'size', label: 'Size (pt)', type: 'number', value: e.size || 11, half: true },
      { key: 'bold', label: 'Bold', type: 'checkbox', value: !!e.bold, half: true },
      { key: 'italic', label: 'Italic', type: 'checkbox', value: !!e.italic, half: true },
      { key: 'underline', label: 'Underline', type: 'checkbox', value: !!e.underline, half: true },
      { key: 'smallCaps', label: 'Small caps', type: 'checkbox', value: !!e.smallCaps, half: true },
      { key: 'color', label: 'Color', type: 'color', value: /^#/.test(e.color || '') ? e.color : '#000000', half: true },
      { key: 'useColor', label: 'Set color', type: 'checkbox', value: !!e.color, half: true },
      { key: 'align', label: 'Alignment', type: 'select', options: [{ value: '', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }, { value: 'justify', label: 'Justify' }], value: e.align || '', half: true, visibleIf: () => s.type !== 'character' },
      { key: 'lineHeight', label: 'Line spacing (multiple)', type: 'number', value: parseFloat(e.lineHeight || '1.08'), step: 0.05, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'spaceBefore', label: 'Space before (pt)', type: 'number', value: e.spaceBefore ?? 0, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'spaceAfter', label: 'Space after (pt)', type: 'number', value: e.spaceAfter ?? 0, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'indentLeft', label: 'Left indent (pt)', type: 'number', value: e.indentLeft ?? 0, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'indentFirst', label: 'First line (pt, negative = hanging)', type: 'number', value: e.indentFirst ?? 0, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'keepNext', label: 'Keep with next', type: 'checkbox', value: !!e.keepNext, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'pageBreakBefore', label: 'Page break before', type: 'checkbox', value: !!e.pageBreakBefore, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'outlineLevel', label: 'Outline level (0 = body)', type: 'number', min: 0, max: 9, value: e.outlineLevel || 0, half: true, visibleIf: () => s.type !== 'character' },
      { key: 'quick', label: 'Add to the Styles gallery', type: 'checkbox', value: !!s.quick, half: true },
    ],
    onChange: (vv, ctl) => ctl.setPreview(`<div style="font-family:'${cssStr(vv.font?.startsWith('+') ? app.settings.theme.bodyFont : vv.font)}';font-size:${safeNum(vv.size, 11, 1, 1638)}pt;font-weight:${vv.bold ? 700 : 400};font-style:${vv.italic ? 'italic' : 'normal'};${vv.underline ? 'text-decoration:underline;' : ''}${vv.smallCaps ? 'font-variant:small-caps;' : ''}color:${vv.useColor ? safeColor(vv.color) : 'inherit'};text-align:${/^(left|right|center|justify)$/.test(vv.align) ? vv.align : 'left'};line-height:${safeNum(vv.lineHeight, 1, 0.1, 20)}">${escHtml(name)} — The quick brown fox jumps over the lazy dog.</div>`),
  });
  if (!r) return;
  app.updateSettings((st) => {
    const d: any = { ...(st.styles[name] || {}), name, type: s.type, basedOn: r.basedOn || undefined, next: r.next || undefined, font: r.font || undefined, size: r.size || undefined, bold: r.bold, italic: r.italic, underline: r.underline, smallCaps: r.smallCaps, quick: r.quick };
    d.color = r.useColor ? r.color : undefined;
    if (s.type !== 'character') Object.assign(d, { align: r.align || undefined, lineHeight: String(r.lineHeight || 1), spaceBefore: r.spaceBefore, spaceAfter: r.spaceAfter, indentLeft: r.indentLeft || undefined, indentFirst: r.indentFirst || undefined, keepNext: r.keepNext, pageBreakBefore: r.pageBreakBefore, outlineLevel: r.outlineLevel || undefined });
    st.styles[name] = d;
  });
}

// ------------------------------------------------------------------------------------------
// Font dialog

def({
  id: 'fmt.fontDialog', label: 'Font Settings…', icon: 'text_format', tab: 'Home', group: 'Font', keys: ['Mod-d'], popular: true,
  run: async (app) => {
    const st = app.state;
    const fam = currentFontFamily(app).replace(/ \((Body|Headings)\)$/, '');
    const size = currentFontSize(app) || 11;
    const ul = markAttr(st, M.underline, 'style');
    const r = await openDialog({
      title: 'Font', wide: true, preview: true,
      fields: [
        { key: 'font', label: 'Font', type: 'combo', options: ALL_FONTS, value: fam, half: true },
        { key: 'size', label: 'Size', type: 'combo', options: FONT_SIZES.map(String), value: String(size), half: true },
        { key: 'bold', label: 'Bold', type: 'checkbox', value: markActive(st, M.bold), half: true },
        { key: 'italic', label: 'Italic', type: 'checkbox', value: markActive(st, M.italic), half: true },
        { key: 'color', label: 'Font color', type: 'color', value: markAttr(st, M.color, 'color') || '#000000', half: true },
        { key: 'underline', label: 'Underline style', type: 'select', options: [{ value: '', label: '(none)' }, { value: 'single', label: 'Single' }, { value: 'double', label: 'Double' }, { value: 'thick', label: 'Thick' }, { value: 'dotted', label: 'Dotted' }, { value: 'dashed', label: 'Dashed' }, { value: 'wavy', label: 'Wave' }, { value: 'words', label: 'Words only' }], value: ul || '', half: true },
        { key: 'h', type: 'heading', label: 'Effects' },
        { key: 'strike', label: 'Strikethrough', type: 'checkbox', value: markActive(st, M.strike), half: true },
        { key: 'dstrike', label: 'Double strikethrough', type: 'checkbox', value: markActive(st, M.dstrike), half: true },
        { key: 'sup', label: 'Superscript', type: 'checkbox', value: markActive(st, M.sup), half: true },
        { key: 'sub', label: 'Subscript', type: 'checkbox', value: markActive(st, M.sub), half: true },
        { key: 'smallcaps', label: 'Small caps', type: 'checkbox', value: markActive(st, M.smallcaps), half: true },
        { key: 'allcaps', label: 'All caps', type: 'checkbox', value: markActive(st, M.allcaps), half: true },
        { key: 'hidden', label: 'Hidden', type: 'checkbox', value: markActive(st, M.hidden), half: true },
        { key: 'h2', type: 'heading', label: 'Advanced (character spacing & typography)' },
        { key: 'spacing', label: 'Spacing (pt, + expanded / − condensed)', type: 'number', value: markAttr(st, M.spacing, 'pt') || 0, step: 0.1, half: true },
        { key: 'scale', label: 'Scale (%)', type: 'number', value: markAttr(st, M.scale, 'pct') || 100, half: true },
        { key: 'position', label: 'Position (pt, + raised / − lowered)', type: 'number', value: markAttr(st, M.position, 'pt') || 0, step: 0.5, half: true },
        { key: 'kerning', label: 'Kerning', type: 'checkbox', value: markAttr(st, M.typo, 'kerning') === 'normal', half: true },
        { key: 'ligatures', label: 'Ligatures', type: 'select', options: [{ value: '', label: 'Default' }, { value: 'none', label: 'None' }, { value: 'common-ligatures', label: 'Standard' }, { value: 'common-ligatures discretionary-ligatures', label: 'Standard + Discretionary' }, { value: 'historical-ligatures', label: 'Historical' }], value: markAttr(st, M.typo, 'ligatures') || '', half: true },
        { key: 'numerals', label: 'Number forms', type: 'select', options: [{ value: '', label: 'Default' }, { value: 'lining-nums', label: 'Lining' }, { value: 'oldstyle-nums', label: 'Old-style' }, { value: 'tabular-nums', label: 'Tabular' }, { value: 'proportional-nums', label: 'Proportional' }], value: markAttr(st, M.typo, 'numerals') || '', half: true },
      ],
      onChange: (vv, ctl) => ctl.setPreview(`<span style="font-family:'${cssStr(vv.font)}';font-size:${safeNum(vv.size, 11, 1, 1638)}pt;font-weight:${vv.bold ? 700 : 400};font-style:${vv.italic ? 'italic' : 'normal'};color:${safeColor(vv.color)};text-decoration:${[vv.underline ? 'underline' : '', vv.strike || vv.dstrike ? 'line-through' : ''].join(' ') || 'none'};${vv.dstrike ? 'text-decoration-style:double;' : ''}${vv.smallcaps ? 'font-variant:small-caps;' : ''}${vv.allcaps ? 'text-transform:uppercase;' : ''}letter-spacing:${safeNum(vv.spacing, 0, -100, 100)}pt;font-kerning:${vv.kerning ? 'normal' : 'none'};font-variant-ligatures:${vv.ligatures || 'normal'};font-variant-numeric:${vv.numerals || 'normal'};vertical-align:${vv.sup ? 'super' : vv.sub ? 'sub' : 'baseline'}">${escHtml(fam || 'Font')} AaBbYyZz 0123456789 fi fl</span>`),
    });
    if (!r) return;
    const view = v(app);
    const set = (type: any, on: boolean, attrs?: any) => setMark(view, type, on ? attrs || {} : null);
    if (r.font) applyFont(app, r.font);
    if (r.size) applySize(app, parseFloat(r.size));
    set(M.bold, r.bold); set(M.italic, r.italic);
    setMark(view, M.color, r.color && r.color !== '#000000' ? { color: r.color } : null);
    setMark(view, M.underline, r.underline ? { style: r.underline } : null);
    set(M.strike, r.strike); set(M.dstrike, r.dstrike);
    set(M.sup, r.sup && !r.sub); set(M.sub, r.sub && !r.sup);
    set(M.smallcaps, r.smallcaps); set(M.allcaps, r.allcaps); set(M.hidden, r.hidden);
    setMark(view, M.spacing, r.spacing ? { pt: r.spacing } : null);
    setMark(view, M.scale, r.scale && r.scale !== 100 ? { pct: r.scale } : null);
    setMark(view, M.position, r.position ? { pt: r.position } : null);
    setTypo(app, { kerning: r.kerning ? 'normal' : null, ligatures: r.ligatures || null, numerals: r.numerals || null });
  },
});

def({
  id: 'fmt.defaultFont', label: 'Set as Default Font…', icon: 'font_download', tab: 'Home', group: 'Font',
  run: async (app) => {
    const r = await openDialog({ title: 'Default Font', help: 'Changes the Normal style. Choose whether to apply to this document only or all new documents.', fields: [
      { key: 'font', label: 'Font', type: 'combo', options: ALL_FONTS, value: currentFontFamily(app).replace(/ \((Body|Headings)\)$/, '') },
      { key: 'size', label: 'Size', type: 'number', value: currentFontSize(app) || 11 },
      { key: 'all', label: 'All new documents', type: 'checkbox', value: false },
    ] });
    if (!r) return;
    app.updateSettings((s) => { s.styles.Normal = { ...(s.styles.Normal || { name: 'Normal', type: 'paragraph' }), font: r.font, size: r.size }; });
    if (r.all) { app.prefs.defaultFont = r.font; app.prefs.defaultSize = r.size; app.savePrefs(); }
  },
});
