/** Layout and Design tabs: page setup, columns, breaks, line numbers, hyphenation, themes, page background. */
import { def } from './registry';
import type { App } from '../app';
import { schema } from '../editor/schema';
import { PAGE_SIZES, pageDims } from '../editor/settings';
import { STYLE_SETS, THEMES, designLabel } from '../editor/styles';
import { setParaAttrs, paraAttr, topLevelRange } from '../editor/ops';
import { openDialog, toast, colorMenu } from '../ui/dialog';
import { toUnit, fromUnit } from '../prefs';
import { ALL_FONTS } from './format';

const N = schema.nodes;
const v = (app: App) => app.view;

const MARGIN_PRESETS: [string, string, [number, number, number, number]][] = [
  ['normal', 'Normal (1")', [72, 72, 72, 72]], ['narrow', 'Narrow (0.5")', [36, 36, 36, 36]], ['moderate', 'Moderate (1" / 0.75")', [72, 54, 72, 54]],
  ['wide', 'Wide (1" / 2")', [72, 144, 72, 144]], ['mirrored', 'Mirrored (inside 1.25")', [72, 72, 72, 90]], ['office2003', 'Classic (1" / 1.25")', [72, 90, 72, 90]],
  ['manuscript', 'Manuscript (1" all, 12pt)', [72, 72, 72, 72]], ['book6x9', 'Book 6×9 (0.75" / 0.625")', [54, 45, 54, 54]], ['thesis', 'Thesis (1.5" left)', [72, 72, 72, 108]],
];

def([
  {
    id: 'layout.margins', label: 'Margins', icon: 'margin', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => {
      if (!arg) return app.exec('layout.pageSetup');
      const p = MARGIN_PRESETS.find((m) => m[0] === arg);
      if (!p) return;
      const [t, r, b, l] = p[2];
      app.updateSettings((s) => { s.page.margin = { top: t, right: r, bottom: b, left: l }; s.page.mirror = arg === 'mirrored'; });
    },
    menu: () => [...MARGIN_PRESETS.map(([k, l]) => ({ id: 'layout.margins', arg: k, label: l })), { separator: true }, { id: 'layout.pageSetup', label: 'Custom Margins…' }],
  },
  {
    id: 'layout.orientation', label: 'Orientation', icon: 'screen_rotation', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => app.updateSettings((s) => { s.page.orientation = arg || (s.page.orientation === 'portrait' ? 'landscape' : 'portrait'); }),
    menu: (app) => [{ id: 'layout.orientation', arg: 'portrait', label: 'Portrait', checked: app.settings.page.orientation === 'portrait' }, { id: 'layout.orientation', arg: 'landscape', label: 'Landscape', checked: app.settings.page.orientation === 'landscape' }],
  },
  { id: 'layout.portrait', label: 'Portrait', icon: 'crop_portrait', tab: 'Layout', group: 'Page Setup', edits: true, run: (app) => app.exec('layout.orientation', 'portrait') },
  { id: 'layout.landscape', label: 'Landscape', icon: 'crop_landscape', tab: 'Layout', group: 'Page Setup', edits: true, run: (app) => app.exec('layout.orientation', 'landscape') },
  {
    id: 'layout.size', label: 'Size', icon: 'description', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => {
      if (!arg) return app.exec('layout.pageSetup');
      const d = PAGE_SIZES[arg];
      if (d) app.updateSettings((s) => { s.page.sizeName = arg; s.page.width = d[0]; s.page.height = d[1]; });
    },
    menu: (app) => [...Object.entries(PAGE_SIZES).map(([k, [w, h]]) => ({ id: 'layout.size', arg: k, label: `${k}  ${toUnit(w, app.prefs.units)} × ${toUnit(h, app.prefs.units)} ${app.prefs.units}`, checked: app.settings.page.sizeName === k })), { separator: true }, { id: 'layout.pageSetup', label: 'More Paper Sizes…' }],
  },
  {
    id: 'layout.pageSetup', label: 'Page Setup…', icon: 'settings_applications', tab: 'Layout', group: 'Page Setup', edits: true, popular: true,
    run: async (app) => {
      const s = app.settings;
      const u = app.prefs.units;
      const r = await openDialog({
        title: 'Page Setup', wide: true,
        fields: [
          { key: 'h1', type: 'heading', label: `Margins (${u})` },
          { key: 'top', label: 'Top', type: 'number', value: toUnit(s.page.margin.top, u), step: 0.05, half: true },
          { key: 'bottom', label: 'Bottom', type: 'number', value: toUnit(s.page.margin.bottom, u), step: 0.05, half: true },
          { key: 'left', label: s.page.mirror ? 'Inside' : 'Left', type: 'number', value: toUnit(s.page.margin.left, u), step: 0.05, half: true },
          { key: 'right', label: s.page.mirror ? 'Outside' : 'Right', type: 'number', value: toUnit(s.page.margin.right, u), step: 0.05, half: true },
          { key: 'gutter', label: 'Gutter', type: 'number', value: toUnit(s.page.gutter, u), step: 0.05, half: true },
          { key: 'mirror', label: 'Mirror margins (facing pages)', type: 'checkbox', value: s.page.mirror, half: true },
          { key: 'orientation', label: 'Orientation', type: 'radio', options: [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }], value: s.page.orientation },
          { key: 'h2', type: 'heading', label: 'Paper' },
          { key: 'size', label: 'Paper size', type: 'select', options: [...Object.keys(PAGE_SIZES), 'Custom'], value: PAGE_SIZES[s.page.sizeName] ? s.page.sizeName : 'Custom' },
          { key: 'width', label: `Width (${u})`, type: 'number', value: toUnit(Math.min(s.page.width, s.page.height), u), step: 0.01, half: true },
          { key: 'height', label: `Height (${u})`, type: 'number', value: toUnit(Math.max(s.page.width, s.page.height), u), step: 0.01, half: true },
          { key: 'h3', type: 'heading', label: 'Layout' },
          { key: 'headerDist', label: `Header from edge (${u})`, type: 'number', value: toUnit(s.page.headerDist, u), step: 0.05, half: true },
          { key: 'footerDist', label: `Footer from edge (${u})`, type: 'number', value: toUnit(s.page.footerDist, u), step: 0.05, half: true },
          { key: 'vAlign', label: 'Vertical alignment', type: 'select', options: ['top', 'center', 'justify', 'bottom'], value: s.page.vAlign, half: true },
          { key: 'differentFirst', label: 'Different first page', type: 'checkbox', value: s.differentFirst, half: true },
          { key: 'differentOddEven', label: 'Different odd and even', type: 'checkbox', value: s.differentOddEven, half: true },
        ],
        onChange: (x, ctl, key) => {
          if (key === 'size' && PAGE_SIZES[x.size]) { ctl.set('width', toUnit(PAGE_SIZES[x.size][0], u)); ctl.set('height', toUnit(PAGE_SIZES[x.size][1], u)); }
        },
      });
      if (!r) return;
      app.updateSettings((st) => {
        st.page.margin = { top: fromUnit(r.top, u), bottom: fromUnit(r.bottom, u), left: fromUnit(r.left, u), right: fromUnit(r.right, u) };
        st.page.gutter = fromUnit(r.gutter || 0, u);
        st.page.mirror = r.mirror;
        st.page.orientation = r.orientation;
        st.page.sizeName = r.size;
        st.page.width = fromUnit(r.width, u); st.page.height = fromUnit(r.height, u);
        st.page.headerDist = fromUnit(r.headerDist, u); st.page.footerDist = fromUnit(r.footerDist, u);
        st.page.vAlign = r.vAlign;
        st.differentFirst = r.differentFirst; st.differentOddEven = r.differentOddEven;
      });
    },
  },
  {
    id: 'layout.columns', label: 'Columns', icon: 'view_column', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => {
      if (arg == null) return app.exec('layout.columnsDialog');
      setColumns(app, arg === 'left' || arg === 'right' ? 2 : arg, 36, false, arg === 'left' ? '1fr 2fr' : arg === 'right' ? '2fr 1fr' : null);
    },
    menu: () => [{ id: 'layout.columns', arg: 1, label: 'One' }, { id: 'layout.columns', arg: 2, label: 'Two' }, { id: 'layout.columns', arg: 3, label: 'Three' }, { id: 'layout.columns', arg: 4, label: 'Four' }, { id: 'layout.columns', arg: 'left', label: 'Left (narrow first)' }, { id: 'layout.columns', arg: 'right', label: 'Right (narrow last)' }, { separator: true }, { id: 'layout.columnsDialog', label: 'More Columns…' }],
  },
  {
    id: 'layout.columnsDialog', label: 'Columns…', icon: 'view_week', tab: 'Layout', group: 'Page Setup', edits: true,
    run: async (app) => {
      const cur = columnAncestor(app);
      const r = await openDialog({ title: 'Columns', help: 'Columns apply to the selected paragraphs (or the section around the cursor).', fields: [
        { key: 'count', label: 'Number of columns', type: 'number', min: 1, max: 12, value: cur?.node.attrs.count || 2 },
        { key: 'gap', label: 'Spacing (pt)', type: 'number', value: cur?.node.attrs.gap ?? 36 },
        { key: 'rule', label: 'Line between', type: 'checkbox', value: !!cur?.node.attrs.rule },
        { key: 'whole', label: 'Apply to whole document', type: 'checkbox', value: false },
      ] });
      if (!r) return;
      if (r.whole) {
        const st = app.state;
        const content: any[] = [];
        st.doc.forEach((n) => { if (n.type === N.column_section) n.forEach((c) => content.push(c)); else content.push(n); });
        const tr = st.tr.replaceWith(0, st.doc.content.size, r.count > 1 ? [N.column_section.create({ count: r.count, gap: r.gap, rule: r.rule }, content)] : content);
        v(app).dispatch(tr);
        return;
      }
      setColumns(app, r.count, r.gap, r.rule, null);
    },
  },
]);

function columnAncestor(app: App) {
  const $f = app.state.selection.$from;
  for (let d = $f.depth; d > 0; d--) if ($f.node(d).type === N.column_section) return { node: $f.node(d), pos: $f.before(d) };
  return null;
}

function setColumns(app: App, count: number, gap: number, rule: boolean, widths: string | null) {
  const st = app.state;
  const anc = columnAncestor(app);
  if (anc) {
    if (count <= 1) v(app).dispatch(st.tr.replaceWith(anc.pos, anc.pos + anc.node.nodeSize, anc.node.content));
    else v(app).dispatch(st.tr.setNodeMarkup(anc.pos, undefined, { ...anc.node.attrs, count, gap, rule, widths }));
    return;
  }
  if (count <= 1) return;
  const { from, to } = topLevelRange(st);
  const slice = st.doc.slice(from, to);
  v(app).dispatch(st.tr.replaceWith(from, to, N.column_section.create({ count, gap, rule, widths }, slice.content)));
}

def([
  {
    id: 'layout.breaks', label: 'Breaks', icon: 'insert_page_break', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true,
    run: (app, arg) => app.exec(arg || 'insert.pageBreak'),
    menu: () => [
      { heading: 'Page Breaks' }, { id: 'layout.breaks', arg: 'insert.pageBreak', label: 'Page' }, { id: 'layout.breaks', arg: 'insert.columnBreak', label: 'Column' }, { id: 'layout.breaks', arg: 'edit.lineBreak', label: 'Text Wrapping' },
      { heading: 'Section Breaks' }, { id: 'insert.sectionBreak', arg: 'nextPage', label: 'Next Page' }, { id: 'insert.sectionBreak', arg: 'continuous', label: 'Continuous' }, { id: 'insert.sectionBreak', arg: 'evenPage', label: 'Even Page' }, { id: 'insert.sectionBreak', arg: 'oddPage', label: 'Odd Page' },
    ],
  },
  {
    id: 'layout.lineNumbers', label: 'Line Numbers', icon: 'format_list_numbered', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true,
    run: (app, arg) => {
      if (arg === 'suppress') return app.exec('para.suppressLineNumbers');
      if (arg === 'options') return app.exec('layout.lineNumberOptions');
      app.updateSettings((s) => { s.lineNumbers.enabled = arg !== 'none'; if (arg === 'page' || arg === 'continuous') s.lineNumbers.restart = arg; });
      if (app.tab.viewMode !== 'print') toast('Line numbers show in Print Layout.', { action: 'Switch', onAction: () => app.setViewMode('print') });
    },
    menu: (app) => [
      { id: 'layout.lineNumbers', arg: 'none', label: 'None', checked: !app.settings.lineNumbers.enabled }, { id: 'layout.lineNumbers', arg: 'continuous', label: 'Continuous' },
      { id: 'layout.lineNumbers', arg: 'page', label: 'Restart Each Page' }, { id: 'layout.lineNumbers', arg: 'suppress', label: 'Suppress for Current Paragraph' },
      { separator: true }, { id: 'layout.lineNumbers', arg: 'options', label: 'Line Numbering Options…' },
    ],
  },
  {
    id: 'layout.lineNumberOptions', label: 'Line Numbering Options…', icon: 'tune', tab: 'Layout', group: 'Page Setup', edits: true,
    run: async (app) => {
      const s = app.settings.lineNumbers;
      const r = await openDialog({ title: 'Line Numbers', fields: [
        { key: 'enabled', label: 'Add line numbering', type: 'checkbox', value: s.enabled },
        { key: 'countBy', label: 'Count by', type: 'number', value: s.countBy, min: 1 },
        { key: 'restart', label: 'Numbering', type: 'radio', options: [{ value: 'page', label: 'Restart each page' }, { value: 'continuous', label: 'Continuous' }], value: s.restart },
      ] });
      if (r) app.updateSettings((st) => { st.lineNumbers = { enabled: r.enabled, countBy: Math.max(1, r.countBy || 1), restart: r.restart }; });
    },
  },
  {
    id: 'layout.hyphenation', label: 'Hyphenation', icon: 'horizontal_rule', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true,
    run: (app, arg) => app.updateSettings((s) => { s.hyphenation = arg === undefined ? !s.hyphenation : arg === 'auto'; }),
    menu: (app) => [{ id: 'layout.hyphenation', arg: 'none', label: 'None', checked: !app.settings.hyphenation }, { id: 'layout.hyphenation', arg: 'auto', label: 'Automatic', checked: app.settings.hyphenation }, { id: 'insert.optionalHyphen', label: 'Insert Optional Hyphen (Manual)' }],
    isActive: (app) => app.settings.hyphenation,
  },
  {
    id: 'layout.indentLeft', label: 'Indent Left', icon: 'format_indent_increase', tab: 'Layout', group: 'Paragraph', kind: 'size', edits: true,
    run: async (app, arg) => {
      const u = app.prefs.units;
      const val = arg ?? (await (await import('../ui/dialog')).promptDialog('Left Indent', `Left indent (${u}):`, String(toUnit(paraAttr(app.state, 'indentLeft') || 0, u)), { type: 'number' }));
      if (val == null) return;
      setParaAttrs(v(app), { indentLeft: fromUnit(parseFloat(val) || 0, u) || null });
    },
  },
  {
    id: 'layout.indentRight', label: 'Indent Right', icon: 'format_indent_decrease', tab: 'Layout', group: 'Paragraph', kind: 'size', edits: true,
    run: async (app, arg) => {
      const u = app.prefs.units;
      const val = arg ?? (await (await import('../ui/dialog')).promptDialog('Right Indent', `Right indent (${u}):`, String(toUnit(paraAttr(app.state, 'indentRight') || 0, u)), { type: 'number' }));
      if (val == null) return;
      setParaAttrs(v(app), { indentRight: fromUnit(parseFloat(val) || 0, u) || null });
    },
  },
  {
    id: 'layout.spaceBefore', label: 'Spacing Before', icon: 'vertical_align_top', tab: 'Layout', group: 'Paragraph', kind: 'size', edits: true,
    run: async (app, arg) => { const val = arg ?? (await (await import('../ui/dialog')).promptDialog('Spacing Before', 'Points:', String(paraAttr(app.state, 'spaceBefore') ?? 0), { type: 'number' })); if (val != null) setParaAttrs(v(app), { spaceBefore: parseFloat(val) || 0 }); },
  },
  {
    id: 'layout.spaceAfter', label: 'Spacing After', icon: 'vertical_align_bottom', tab: 'Layout', group: 'Paragraph', kind: 'size', edits: true,
    run: async (app, arg) => { const val = arg ?? (await (await import('../ui/dialog')).promptDialog('Spacing After', 'Points:', String(paraAttr(app.state, 'spaceAfter') ?? 8), { type: 'number' })); if (val != null) setParaAttrs(v(app), { spaceAfter: parseFloat(val) || 0 }); },
  },
  {
    id: 'layout.textDirection', label: 'Text Direction', icon: 'text_rotation_none', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true,
    run: (app, arg) => app.exec(arg === 'rtl' ? 'para.rtl' : 'para.ltr'),
    menu: () => [{ id: 'layout.textDirection', arg: 'ltr', label: 'Left to right' }, { id: 'layout.textDirection', arg: 'rtl', label: 'Right to left' }],
  },
  {
    id: 'layout.wrapText', label: 'Wrap Text', icon: 'wrap_text', tab: 'Layout', group: 'Arrange', kind: 'menu', edits: true,
    run: (app, arg) => app.exec('picture.wrap', arg),
    menu: () => [['inline', 'In Line with Text'], ['left', 'Square (left)'], ['right', 'Square (right)'], ['center', 'Top and Bottom (centered)'], ['behind', 'Behind Text'], ['front', 'In Front of Text']].map(([a, l]) => ({ id: 'picture.wrap', arg: a, label: l })),
  },
  { id: 'layout.position', label: 'Position', icon: 'picture_in_picture', tab: 'Layout', group: 'Arrange', edits: true, run: (app) => app.exec('picture.formatDialog') },
  { id: 'layout.bringForward', label: 'Bring Forward', icon: 'flip_to_front', tab: 'Layout', group: 'Arrange', edits: true, run: (app) => app.exec('picture.wrap', 'front') },
  { id: 'layout.sendBackward', label: 'Send Backward', icon: 'flip_to_back', tab: 'Layout', group: 'Arrange', edits: true, run: (app) => app.exec('picture.wrap', 'behind') },
  { id: 'layout.selectionPane', label: 'Selection Pane', icon: 'layers', tab: 'Layout', group: 'Arrange', run: (app) => app.ui.togglePane('selection') },
  { id: 'layout.align', label: 'Align Object', icon: 'align_horizontal_center', tab: 'Layout', group: 'Arrange', kind: 'menu', edits: true, run: (app, arg) => app.exec('picture.wrap', arg || 'center'), menu: () => [{ id: 'picture.wrap', arg: 'left', label: 'Align Left' }, { id: 'picture.wrap', arg: 'center', label: 'Align Center' }, { id: 'picture.wrap', arg: 'right', label: 'Align Right' }] },
  { id: 'layout.rotate', label: 'Rotate Object', icon: 'rotate_right', tab: 'Layout', group: 'Arrange', kind: 'menu', edits: true, run: (app, arg) => app.exec('picture.rotate', arg ?? 90), menu: () => [{ id: 'picture.rotate', arg: 90, label: 'Rotate Right 90°' }, { id: 'picture.rotate', arg: -90, label: 'Rotate Left 90°' }, { id: 'picture.flipV', label: 'Flip Vertical' }, { id: 'picture.flipH', label: 'Flip Horizontal' }] },
]);

// Design tab -------------------------------------------------------------------------------
def([
  {
    id: 'design.themes', label: 'Themes', icon: 'palette', tab: 'Design', group: 'Document Formatting', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => { const t = THEMES[arg]; if (t) app.updateSettings((s) => { s.theme = { name: designLabel(arg), ...t }; }); },
    menu: (app) => Object.keys(THEMES).map((k) => ({ id: 'design.themes', arg: k, label: `${designLabel(k)} — ${THEMES[k].headingFont}/${THEMES[k].bodyFont}`, checked: designLabel(app.settings.theme.name) === designLabel(k), swatch: THEMES[k].accent[0] })),
  },
  {
    id: 'design.styleSet', label: 'Style Set', icon: 'style', tab: 'Design', group: 'Document Formatting', kind: 'gallery', edits: true, popular: true,
    run: (app, arg) => { if (arg && STYLE_SETS[arg]) app.updateSettings((s) => { s.styleSet = arg; }); },
    menu: (app) => Object.keys(STYLE_SETS).map((k) => ({ id: 'design.styleSet', arg: k, label: designLabel(k), checked: app.settings.styleSet === k, preview: `font-family:"${STYLE_SETS[k]._fonts?.[0] || 'Carlito'}"` })),
  },
  {
    id: 'design.colors', label: 'Theme Colors', icon: 'format_color_fill', tab: 'Design', group: 'Document Formatting', kind: 'menu', edits: true,
    run: async (app, arg) => {
      if (arg === 'custom') {
        const acc = app.settings.theme.accent;
        const r = await openDialog({ title: 'Theme Colors', fields: acc.map((c, i) => ({ key: 'a' + i, label: `Accent ${i + 1}`, type: 'color' as const, value: c, half: true })) });
        if (r) app.updateSettings((s) => { s.theme.accent = acc.map((_, i) => r['a' + i]); s.theme.name = 'Custom'; });
        return;
      }
      const t = THEMES[arg];
      if (t) app.updateSettings((s) => { s.theme.accent = [...t.accent]; });
    },
    menu: () => [...Object.keys(THEMES).map((k) => ({ id: 'design.colors', arg: k, label: designLabel(k), swatch: THEMES[k].accent[0] })), { separator: true }, { id: 'design.colors', arg: 'custom', label: 'Customize Colors…' }],
  },
  {
    id: 'design.fonts', label: 'Theme Fonts', icon: 'font_download', tab: 'Design', group: 'Document Formatting', kind: 'menu', edits: true,
    run: async (app, arg) => {
      if (arg === 'custom') {
        const r = await openDialog({ title: 'Theme Fonts', fields: [
          { key: 'h', label: 'Heading font', type: 'combo', options: ALL_FONTS, value: app.settings.theme.headingFont },
          { key: 'b', label: 'Body font', type: 'combo', options: ALL_FONTS, value: app.settings.theme.bodyFont },
        ] });
        if (r) app.updateSettings((s) => { s.theme.headingFont = r.h; s.theme.bodyFont = r.b; s.styleSet = 'QuillPen'; }); // rename:keep — stored key
        return;
      }
      const t = THEMES[arg];
      if (t) app.updateSettings((s) => { s.theme.headingFont = t.headingFont; s.theme.bodyFont = t.bodyFont; s.styleSet = 'QuillPen'; }); // rename:keep — stored key
    },
    menu: () => [...Object.keys(THEMES).map((k) => ({ id: 'design.fonts', arg: k, label: `${THEMES[k].headingFont} / ${THEMES[k].bodyFont}`, preview: `font-family:"${THEMES[k].headingFont}"` })), { separator: true }, { id: 'design.fonts', arg: 'custom', label: 'Customize Fonts…' }],
  },
  {
    id: 'design.paragraphSpacing', label: 'Paragraph Spacing', icon: 'format_line_spacing', tab: 'Design', group: 'Document Formatting', kind: 'menu', edits: true,
    run: (app, arg) => {
      const presets: Record<string, [number, number, string]> = { none: [0, 0, '1'], compact: [0, 4, '1'], tight: [0, 6, '1.15'], open: [0, 10, '1.15'], relaxed: [0, 6, '1.5'], double: [0, 8, '2'] };
      const p = presets[arg] || presets.open;
      app.updateSettings((s) => { s.styles.Normal = { ...(s.styles.Normal || { name: 'Normal', type: 'paragraph' }), spaceBefore: p[0], spaceAfter: p[1], lineHeight: p[2] }; });
    },
    menu: () => [['none', 'No Paragraph Space'], ['compact', 'Compact'], ['tight', 'Tight'], ['open', 'Open'], ['relaxed', 'Relaxed'], ['double', 'Double']].map(([k, l]) => ({ id: 'design.paragraphSpacing', arg: k, label: l })),
  },
  {
    id: 'design.effects', label: 'Theme Effects', icon: 'auto_awesome', tab: 'Design', group: 'Document Formatting', edits: true,
    run: () => toast('Theme effects apply to shapes: edit a shape to set fill, outline, and shadow.'),
  },
  { id: 'design.setDefault', label: 'Set as Default', icon: 'check', tab: 'Design', group: 'Document Formatting', run: (app) => { const s = app.settings; localStorage.setItem('quillpen.defaultDesign', JSON.stringify({ styleSet: s.styleSet, theme: s.theme, styles: s.styles })); toast('Saved as the default design for new documents'); } },
  {
    id: 'design.watermark', label: 'Watermark', icon: 'water_drop', tab: 'Design', group: 'Page Background', kind: 'menu', edits: true, popular: true,
    run: async (app, arg) => {
      if (arg === 'remove') return app.updateSettings((s) => { s.watermark = null; });
      if (arg && arg !== 'custom') return app.updateSettings((s) => { s.watermark = { text: arg, color: '#c0c0c0', opacity: 0.35, diagonal: true }; });
      const w = app.settings.watermark;
      const r = await openDialog({ title: 'Watermark', fields: [
        { key: 'text', label: 'Text', type: 'combo', options: ['CONFIDENTIAL', 'DRAFT', 'SAMPLE', 'DO NOT COPY', 'ASAP', 'URGENT', 'PERSONAL', 'COPY', 'ORIGINAL', 'TOP SECRET'], value: w?.text || 'DRAFT' },
        { key: 'color', label: 'Color', type: 'color', value: w?.color || '#c0c0c0', half: true },
        { key: 'opacity', label: 'Transparency (%)', type: 'range', min: 0, max: 95, value: Math.round((1 - (w?.opacity ?? 0.35)) * 100), suffix: '%', half: true },
        { key: 'diagonal', label: 'Diagonal layout', type: 'checkbox', value: w?.diagonal ?? true },
      ] });
      if (r) app.updateSettings((s) => { s.watermark = { text: r.text, color: r.color, opacity: 1 - r.opacity / 100, diagonal: r.diagonal }; });
    },
    menu: () => [...['CONFIDENTIAL', 'DRAFT', 'SAMPLE', 'DO NOT COPY', 'URGENT'].map((t) => ({ id: 'design.watermark', arg: t, label: t })), { separator: true }, { id: 'design.watermark', arg: 'custom', label: 'Custom Watermark…' }, { id: 'design.watermark', arg: 'remove', label: 'Remove Watermark' }],
  },
  {
    id: 'design.pageColor', label: 'Page Color', icon: 'format_color_fill', tab: 'Design', group: 'Page Background', kind: 'color', edits: true,
    run: async (app, arg) => {
      const c = typeof arg === 'string' && arg !== 'menu' ? arg : await colorMenu(app.ui.anchorFor('design.pageColor'), { none: 'No Color' });
      if (c === undefined) return;
      app.updateSettings((s) => { s.pageColor = c; });
    },
  },
  {
    id: 'design.pageBorders', label: 'Page Borders', icon: 'border_outer', tab: 'Design', group: 'Page Background', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Page Borders', fields: [
        { key: 'style', label: 'Style', type: 'select', options: ['none', 'solid', 'double', 'dotted', 'dashed', 'groove', 'ridge', 'inset', 'outset'], value: (app.settings.pageBorder || 'none').split(' ')[1] || 'none' },
        { key: 'width', label: 'Width (pt)', type: 'select', options: ['0.5', '1', '1.5', '2.25', '3', '4.5', '6'], value: '1.5', half: true },
        { key: 'color', label: 'Color', type: 'color', value: '#000000', half: true },
        { key: 'inset', label: 'Distance from page edge (pt)', type: 'number', value: 24 },
      ] });
      if (!r) return;
      app.updateSettings((s) => { s.pageBorder = r.style === 'none' ? null : `${r.width}pt ${r.style} ${r.color}`; (s as any).pageBorderInset = r.inset; });
      if (app.tab.viewMode !== 'print') toast('Page borders show in Print Layout.');
    },
  },
]);
void pageDims;
