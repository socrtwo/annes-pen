/** Insert tab: pages, tables, illustrations, links, header/footer, text, symbols. */
import { def } from './registry';
import { pinNode, findPinned, type App, type PinnedNode } from '../app';
import { TextSelection, NodeSelection, type EditorState } from 'prosemirror-state';
import { Fragment, Slice, type Mark, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { insertBlock, insertInline, markAttr, selectedText, setMark } from '../editor/ops';
import { openDialog, toast, promptDialog, showMenu, confirmDialog } from '../ui/dialog';
import { pickFile, readFileAsDataURL, h } from '../ui/dom';
import { SHAPES, shapeSvg, svgToDataUrl, rasterize, DIAGRAMS, diagramSvg, CHARTS, chartSvg, parseChartCsv, chartToCsv, PALETTE, type ShapeData, type DiagramData, type ChartData } from '../editor/graphics';
import { renderLatex } from '../editor/nodeviews';
import { FIELD_TYPES } from '../editor/fields';

const N = schema.nodes;
const M = schema.marks;
const v = (app: App) => app.view;
const P = (text = '', attrs: Record<string, any> = {}, marks?: any[]) => N.paragraph.create(attrs, text ? schema.text(text, marks) : null);

// Pages ----------------------------------------------------------------------------------------
def([
  { id: 'insert.pageBreak', label: 'Page Break', icon: 'insert_page_break', tab: 'Insert', group: 'Pages', edits: true, popular: true, run: (app) => insertBlock(v(app), [N.page_break.create()]) },
  { id: 'insert.columnBreak', label: 'Column Break', icon: 'view_column', tab: 'Layout', group: 'Page Setup', keys: ['Mod-Shift-Enter'], edits: true, run: (app) => insertBlock(v(app), [N.column_break.create()]) },
  {
    id: 'insert.sectionBreak', label: 'Section Break', icon: 'splitscreen', tab: 'Layout', group: 'Page Setup', kind: 'menu', edits: true,
    run: (app, arg) => insertBlock(v(app), [N.section_break.create({ kind: arg || 'nextPage' })]),
    menu: () => [
      { id: 'insert.sectionBreak', arg: 'nextPage', label: 'Section Break (Next Page)' }, { id: 'insert.sectionBreak', arg: 'continuous', label: 'Section Break (Continuous)' },
      { id: 'insert.sectionBreak', arg: 'evenPage', label: 'Section Break (Even Page)' }, { id: 'insert.sectionBreak', arg: 'oddPage', label: 'Section Break (Odd Page)' },
      { separator: true }, { id: 'insert.pageBreak', label: 'Page Break' }, { id: 'insert.columnBreak', label: 'Column Break' }, { id: 'edit.lineBreak', label: 'Text Wrapping Break' },
    ],
  },
  { id: 'insert.blankPage', label: 'Blank Page', icon: 'note_add', tab: 'Insert', group: 'Pages', edits: true, run: (app) => insertBlock(v(app), [N.page_break.create(), P(), N.page_break.create()]) },
  {
    id: 'insert.coverPage', label: 'Cover Page', icon: 'auto_stories', tab: 'Insert', group: 'Pages', kind: 'menu', edits: true,
    run: (app, arg) => insertCover(app, arg || 'classic'),
    menu: () => [
      { id: 'insert.coverPage', arg: 'classic', label: 'Classic (centered title)' }, { id: 'insert.coverPage', arg: 'report', label: 'Report (title, subtitle, author, date)' },
      { id: 'insert.coverPage', arg: 'banded', label: 'Banded (accent band)' }, { id: 'insert.coverPage', arg: 'manuscript', label: 'Manuscript (agent submission)' },
      { id: 'insert.coverPage', arg: 'academic', label: 'Academic Title Page' }, { id: 'insert.coverPage', arg: 'screenplay', label: 'Screenplay Title Page' },
      { separator: true }, { id: 'insert.removeCover', label: 'Remove Current Cover Page' },
    ],
  },
  {
    id: 'insert.removeCover', label: 'Remove Cover Page', icon: 'delete', tab: 'Insert', group: 'Pages', edits: true,
    run: async (app) => {
      const doc = app.state.doc;
      let end = -1, blocks = 0;
      doc.forEach((n, pos, i) => { if (end < 0 && n.type === N.page_break) { end = pos + n.nodeSize; blocks = i; } });
      if (end < 0) { toast('No cover page.'); return; }
      // Covers made by Insert ▸ Cover Page start with a marked paragraph; anything else needs confirmation.
      if (doc.firstChild?.attrs.id !== COVER_ID && !(await confirmDialog('Remove Cover Page', `The document does not start with a cover page inserted by Anne\'s Pen. Remove the ${blocks} paragraph(s) before the first page break?`))) return;
      if (app.state.doc !== doc) return;
      v(app).dispatch(app.state.tr.delete(0, end));
    },
  },
]);

/** Paragraph id marking the first block of a cover page inserted by insert.coverPage. */
const COVER_ID = 'qf-cover';

function insertCover(app: App, kind: string) {
  const s = app.settings;
  const title = s.properties.title || 'Document Title';
  const author = s.properties.author || app.prefs.author;
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const center = { align: 'center' };
  let blocks: PMNode[] = [];
  const spacer = (n: number) => Array.from({ length: n }, () => P('', center));
  switch (kind) {
    case 'report': blocks = [...spacer(6), P(title, { style: 'Title', ...center }), P(s.properties.subject || 'Subtitle', { style: 'Subtitle', ...center }), ...spacer(10), P(author, center), P(s.properties.company || '', center), P(date, center)]; break;
    case 'banded': blocks = [...spacer(4), P(title.toUpperCase(), { style: 'Title', align: 'left', bg: s.theme.accent[0], spaceBefore: 24, spaceAfter: 24, indentLeft: 0 }, [M.color.create({ color: '#ffffff' })]), P(s.properties.subject || 'Subtitle', { style: 'Subtitle' }), ...spacer(12), P(author), P(date)]; break;
    case 'manuscript': blocks = [P(author), P('Address line'), P('City, State ZIP'), P('Phone · Email'), P(`About ${'00,000'} words`, { align: 'right' }), ...spacer(10), P(title.toUpperCase(), center), P(`by ${author}`, center)]; break;
    case 'academic': blocks = [...spacer(5), P(title, { ...center }, [M.bold.create()]), ...spacer(1), P(author, center), P(s.properties.company || 'Institution', center), P('Course Number: Course Name', center), P('Instructor Name', center), P(date, center)]; break;
    case 'screenplay': blocks = [...spacer(14), P(title.toUpperCase(), { ...center }), P('', center), P('Written by', center), P('', center), P(author, center), ...spacer(16), P('Contact information', { align: 'left' })]; break;
    default: blocks = [...spacer(10), P(title, { style: 'Title', ...center }), P(s.properties.subject || '', { style: 'Subtitle', ...center }), ...spacer(4), P(author, center), P(date, center)];
  }
  blocks[0] = blocks[0].type.create({ ...blocks[0].attrs, id: COVER_ID }, blocks[0].content, blocks[0].marks);
  blocks.push(N.page_break.create());
  v(app).dispatch(app.state.tr.insert(0, blocks).scrollIntoView());
  app.selectPos(1);
}

// Tables ---------------------------------------------------------------------------------------
export function createTable(rows: number, cols: number, opts: { header?: boolean; style?: string; widths?: number[]; data?: string[][] } = {}): PMNode {
  const rowsArr: PMNode[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: PMNode[] = [];
    for (let c = 0; c < cols; c++) {
      const type = opts.header && r === 0 ? N.table_header : N.table_cell;
      const text = opts.data?.[r]?.[c] ?? '';
      cells.push(type.create({ colwidth: opts.widths ? [opts.widths[c]] : null }, P(text)));
    }
    rowsArr.push(N.table_row.create(null, cells));
  }
  return N.table.create({ style: opts.style || 'Table Grid', headerRows: opts.header ? 1 : 0 }, rowsArr);
}

def([
  {
    id: 'insert.table', label: 'Table', icon: 'table', tab: 'Insert', group: 'Tables', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => {
      if (arg && arg.rows) { insertBlock(v(app), createTable(arg.rows, arg.cols, { header: arg.header })); return; }
      return app.exec('insert.tableDialog');
    },
    menu: () => [
      { heading: 'Insert Table' },
      ...[[2, 2], [3, 3], [4, 3], [5, 4], [6, 5], [8, 4]].map(([r, c]) => ({ id: 'insert.table', arg: { rows: r, cols: c }, label: `${c} × ${r} table`, icon: 'grid_on' })),
      { id: 'insert.table', arg: { rows: 4, cols: 3, header: true }, label: '3 × 4 with header row', icon: 'table_rows' },
      { separator: true },
      { id: 'insert.tableDialog', label: 'Insert Table…', icon: 'table' },
      { id: 'table.fromText', label: 'Convert Text to Table…', icon: 'table_view' },
      { id: 'insert.quickTable', label: 'Quick Tables', icon: 'table_chart', submenu: [
        { id: 'insert.quickTable', arg: 'calendar', label: 'Calendar (current month)' }, { id: 'insert.quickTable', arg: 'matrix', label: 'Matrix' },
        { id: 'insert.quickTable', arg: 'tabular', label: 'Tabular List' }, { id: 'insert.quickTable', arg: 'invoice', label: 'Invoice' },
        { id: 'insert.quickTable', arg: 'schedule', label: 'Weekly Schedule' }, { id: 'insert.quickTable', arg: 'comparison', label: 'Comparison' },
        { id: 'insert.quickTable', arg: 'genealogy', label: 'Family Group Sheet' },
      ] },
    ],
  },
  {
    id: 'insert.tableDialog', label: 'Insert Table…', icon: 'table', tab: 'Insert', group: 'Tables', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Insert Table', fields: [
        { key: 'cols', label: 'Number of columns', type: 'number', value: 3, min: 1, max: 63, half: true },
        { key: 'rows', label: 'Number of rows', type: 'number', value: 3, min: 1, max: 500, half: true },
        { key: 'header', label: 'Header row', type: 'checkbox', value: true, half: true },
        { key: 'fixed', label: 'Fixed column width', type: 'checkbox', value: false, half: true },
        { key: 'width', label: 'Column width (pt, when fixed)', type: 'number', value: 120, visibleIf: (x) => x.fixed },
        { key: 'style', label: 'Table style', type: 'select', options: ['Table Grid', 'Plain Table', 'Plain Table Lines', 'Grid Table Light', 'Grid Table Accent', 'List Table', 'List Table Accent', 'Banded Rows', 'Ledger', 'Financial'], value: 'Table Grid' },
      ] });
      if (!r) return;
      const t = createTable(Math.max(1, r.rows | 0), Math.max(1, r.cols | 0), { header: r.header, style: r.style, widths: r.fixed ? Array(r.cols).fill(Math.round(r.width * 4 / 3)) : undefined });
      insertBlock(v(app), r.fixed ? N.table.create({ ...t.attrs, layout: 'fixed' }, t.content) : t);
    },
  },
  {
    id: 'insert.quickTable', label: 'Quick Table', icon: 'table_chart', tab: 'Insert', group: 'Tables', edits: true,
    run: (app, arg) => {
      let data: string[][] = [];
      let header = true;
      switch (arg) {
        case 'calendar': {
          const d = new Date(); const y = d.getFullYear(), m = d.getMonth();
          const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
          data = [['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']];
          let row: string[] = Array(first).fill('');
          for (let i = 1; i <= days; i++) { row.push(String(i)); if (row.length === 7) { data.push(row); row = []; } }
          if (row.length) data.push([...row, ...Array(7 - row.length).fill('')]);
          insertBlock(v(app), [P(d.toLocaleString(undefined, { month: 'long', year: 'numeric' }), { style: 'Heading 2', align: 'center' }), createTable(data.length, 7, { header, data, style: 'Grid Table Accent' })]);
          return;
        }
        case 'matrix': data = [['', 'Point A', 'Point B', 'Point C'], ['Point A', '—', '', ''], ['Point B', '', '—', ''], ['Point C', '', '', '—']]; break;
        case 'tabular': data = [['Item', 'Needed'], ['Books', '1'], ['Magazines', '3'], ['Notebooks', '1'], ['Paper pads', '1'], ['Pens', '3']]; break;
        case 'invoice': data = [['Description', 'Qty', 'Unit Price', 'Amount'], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', 'Subtotal', ''], ['', '', 'Tax', ''], ['', '', 'Total', '']]; break;
        case 'schedule': data = [['Time', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'], ...['8:00', '9:00', '10:00', '11:00', '12:00', '1:00', '2:00', '3:00', '4:00'].map((t) => [t, '', '', '', '', ''])]; break;
        case 'comparison': data = [['Feature', 'Option A', 'Option B', 'Option C'], ['Cost', '', '', ''], ['Quality', '', '', ''], ['Support', '', '', ''], ['Verdict', '', '', '']]; break;
        case 'genealogy': data = [['', 'Husband', 'Wife'], ['Full name', '', ''], ['Born (date, place)', '', ''], ['Christened', '', ''], ['Married (date, place)', '', ''], ['Died (date, place)', '', ''], ['Buried', '', ''], ['Father', '', ''], ['Mother', '', ''], ['Sources', '', '']]; break;
        default: data = [['', ''], ['', '']];
      }
      insertBlock(v(app), createTable(data.length, data[0].length, { header, data, style: 'Grid Table Light' }));
    },
  },
]);

// Pictures and illustrations ------------------------------------------------------------------
async function imageNaturalSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth || 300, h: img.naturalHeight || 200 });
    img.onerror = () => res({ w: 300, h: 200 });
    img.src = src;
  });
}

export async function insertImageSrc(app: App, src: string, extra: Record<string, any> = {}) {
  const { w, h: ht } = await imageNaturalSize(src);
  const s = app.settings;
  const maxW = (s.page.orientation === 'landscape' ? s.page.height : s.page.width) - s.page.margin.left - s.page.margin.right;
  let wpt = w * 0.75, hpt = ht * 0.75;
  if (wpt > maxW) { hpt = (hpt * maxW) / wpt; wpt = maxW; }
  insertInline(v(app), N.image.create({ src, width: Math.round(wpt), height: Math.round(hpt), ...extra }));
}

async function insertGenerated(app: App, svg: string, w: number, h: number, editKind: string, data: any, pin?: PinnedNode) {
  const png = await rasterize(svgToDataUrl(svg), w, h, 2);
  const attrs = { src: png, width: Math.round(w * 0.75), height: Math.round(h * 0.75), editKind, editData: JSON.stringify(data), alt: data.alt || data.title || editKind };
  const view = v(app);
  // The picture being edited, where it is after the dialog and the drawing.
  const pos = pin ? findPinned(view.state.doc, pin) : -1;
  if (pos >= 0) {
    const node = view.state.doc.nodeAt(pos);
    if (node && node.type === N.image) { view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })); return; }
  }
  insertInline(view, N.image.create(attrs));
}

def([
  {
    id: 'insert.picture', label: 'Pictures', icon: 'image', tab: 'Insert', group: 'Illustrations', kind: 'split', edits: true, popular: true,
    run: async (app, arg) => {
      if (arg === 'url') return app.exec('insert.pictureUrl');
      const files = await pickFile(arg === 'camera' ? 'image/*;capture=camera' : 'image/*', true);
      for (const f of files) await insertImageSrc(app, await readFileAsDataURL(f), { alt: f.name.replace(/\.[^.]+$/, '') });
    },
    menu: () => [
      { id: 'insert.picture', label: 'This Device…', icon: 'smartphone' },
      { id: 'insert.picture', arg: 'camera', label: 'Camera…', icon: 'photo_camera' },
      { id: 'insert.pictureUrl', label: 'From Web Address (URL)…', icon: 'link' },
    ],
  },
  { id: 'insert.pictureCamera', label: 'Picture from Camera', icon: 'photo_camera', tab: 'Insert', group: 'Illustrations', edits: true, run: (app) => app.exec('insert.picture', 'camera') },
  {
    id: 'insert.pictureUrl', label: 'Online Picture (URL)…', icon: 'link', tab: 'Insert', group: 'Illustrations', edits: true,
    run: async (app) => {
      const u = await promptDialog('Insert Picture from URL', 'Image address:', 'https://');
      if (!u || u === 'https://') return;
      try {
        const res = await fetch(u);
        const blob = await res.blob();
        await insertImageSrc(app, await readFileAsDataURL(blob));
      } catch {
        await insertImageSrc(app, u);
        toast('Linked to the image (it could not be embedded).');
      }
    },
  },
  { id: 'insert.imageFromSrc', label: 'Insert Image Data', icon: 'image', tab: 'Insert', group: 'Illustrations', internal: true, edits: true, run: (app, src: string) => insertImageSrc(app, src) },
  {
    id: 'insert.shapes', label: 'Shapes', icon: 'interests', tab: 'Insert', group: 'Illustrations', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => editShape(app, { kind: arg || 'rect', fill: PALETTE[0], stroke: '#2f528f', strokeWidth: 2, text: '', textColor: '#ffffff', w: 200, h: 130 }),
    menu: () => SHAPES.map((s) => ({ id: 'insert.shapes', arg: s.kind, label: s.label })),
  },
  {
    id: 'insert.diagram', label: 'Diagram', icon: 'account_tree', tab: 'Insert', group: 'Illustrations', kind: 'menu', edits: true, origin: 'Smart graphics in desktop suites',
    run: (app, arg) => editDiagram(app, { kind: arg || 'process', items: ['Plan', 'Draft', 'Revise', 'Publish'], colors: [...PALETTE], w: 520, h: 220 }),
    menu: () => DIAGRAMS.map((d) => ({ id: 'insert.diagram', arg: d.kind, label: d.label })),
  },
  {
    id: 'insert.chart', label: 'Chart', icon: 'bar_chart', tab: 'Insert', group: 'Illustrations', kind: 'menu', edits: true,
    run: (app, arg) => editChart(app, { kind: arg || 'column', title: 'Chart Title', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Series 1', values: [4.3, 2.5, 3.5, 4.5] }, { name: 'Series 2', values: [2.4, 4.4, 1.8, 2.8] }], w: 520, h: 300, legend: true, labels: false }),
    menu: () => CHARTS.map((c) => ({ id: 'insert.chart', arg: c.kind, label: c.label })),
  },
  {
    id: 'insert.icons', label: 'Icons', icon: 'emoji_symbols', tab: 'Insert', group: 'Illustrations', edits: true,
    run: async (app) => {
      const names = ['home', 'star', 'favorite', 'check_circle', 'warning', 'info', 'help', 'lightbulb', 'event', 'schedule', 'mail', 'call', 'person', 'group', 'location_on', 'flag', 'bookmark', 'shopping_cart', 'payments', 'savings', 'trending_up', 'bar_chart', 'pie_chart', 'school', 'work', 'flight', 'directions_car', 'restaurant', 'local_cafe', 'pets', 'park', 'sunny', 'cloud', 'water_drop', 'bolt', 'eco', 'recycling', 'build', 'settings', 'security', 'lock', 'key', 'cake', 'celebration', 'music_note', 'photo_camera', 'menu_book', 'auto_stories', 'church', 'family_restroom', 'history_edu', 'gavel', 'balance', 'science', 'biotech', 'computer', 'smartphone', 'wifi', 'public', 'language', 'thumb_up', 'sentiment_satisfied', 'handshake', 'rocket_launch', 'emoji_events', 'military_tech', 'diamond', 'local_hospital', 'medication', 'fitness_center', 'sports_soccer', 'hiking', 'beach_access', 'forest', 'agriculture', 'construction', 'engineering'];
      const r = await openDialog({ title: 'Insert Icon', fields: [
        { key: 'name', label: 'Icon', type: 'combo', options: names, value: 'star', help: 'Any Material Symbols name works (e.g. "rocket_launch").' },
        { key: 'color', label: 'Color', type: 'color', value: '#2b579a', half: true },
        { key: 'size', label: 'Size (pt)', type: 'number', value: 48, half: true },
      ] });
      if (!r?.name) return;
      const px = Math.round(r.size * 4 / 3) * 2;
      const c = document.createElement('canvas');
      c.width = c.height = px;
      const ctx = c.getContext('2d')!;
      await (document as any).fonts?.load?.(`${px}px "Material Symbols Outlined"`);
      ctx.font = `${px}px "Material Symbols Outlined"`;
      ctx.fillStyle = r.color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(r.name, px / 2, px / 2);
      insertInline(v(app), N.image.create({ src: c.toDataURL('image/png'), width: r.size, height: r.size, alt: r.name.replace(/_/g, ' ') }));
    },
  },
  { id: 'insert.editGraphic', label: 'Edit Shape / Diagram / Chart', icon: 'edit', tab: 'Insert', group: 'Illustrations', edits: true, run: (app, arg) => editGraphicAt(app, arg?.pos) },
]);

export function editGraphicAt(app: App, pos?: number) {
  const sel = app.state.selection;
  const p = pos ?? (sel instanceof NodeSelection ? sel.from : -1);
  const node = p >= 0 ? app.state.doc.nodeAt(p) : null;
  if (!node || node.type !== N.image || !node.attrs.editKind) { toast('Select a shape, diagram, or chart first.'); return; }
  let data: any = {};
  try { data = JSON.parse(node.attrs.editData || '{}'); } catch { /* */ }
  if (node.attrs.editKind === 'shape') return editShape(app, data, p);
  if (node.attrs.editKind === 'diagram') return editDiagram(app, data, p);
  if (node.attrs.editKind === 'chart') return editChart(app, data, p);
  if (node.attrs.editKind === 'ink') return app.exec('draw.canvas', { pos: p, data });
  if (node.attrs.editKind === 'text') return app.exec('insert.decorativeText', { pos: p, data });
  toast('This picture is not editable.');
}

async function editShape(app: App, d: ShapeData, pos?: number) {
  const pin = pos != null ? pinNode(app.state.doc, pos) : undefined;
  const r = await openDialog({
    title: pos != null ? 'Edit Shape' : 'Insert Shape', wide: true, preview: true,
    fields: [
      { key: 'kind', label: 'Shape', type: 'select', options: SHAPES.map((s) => ({ value: s.kind, label: s.label })), value: d.kind },
      { key: 'fill', label: 'Fill', type: 'color', value: d.fill, half: true },
      { key: 'stroke', label: 'Outline', type: 'color', value: d.stroke, half: true },
      { key: 'strokeWidth', label: 'Outline weight (px)', type: 'number', value: d.strokeWidth, half: true },
      { key: 'textColor', label: 'Text color', type: 'color', value: d.textColor, half: true },
      { key: 'w', label: 'Width (px)', type: 'number', value: d.w, half: true },
      { key: 'h', label: 'Height (px)', type: 'number', value: d.h, half: true },
      { key: 'text', label: 'Text in shape', type: 'textarea', rows: 2, value: d.text },
      { key: 'fontSize', label: 'Text size (px)', type: 'number', value: d.fontSize || 14, half: true },
    ],
    onChange: (x, ctl) => ctl.setPreview(shapeSvg({ ...d, ...x })),
  });
  if (!r) return;
  const data = { ...d, ...r };
  await insertGenerated(app, shapeSvg(data), data.w, data.h, 'shape', data, pin);
}

async function editDiagram(app: App, d: DiagramData, pos?: number) {
  const pin = pos != null ? pinNode(app.state.doc, pos) : undefined;
  const r = await openDialog({
    title: pos != null ? 'Edit Diagram' : 'Insert Diagram', wide: true, preview: true,
    fields: [
      { key: 'kind', label: 'Layout', type: 'select', options: DIAGRAMS.map((x) => ({ value: x.kind, label: x.label })), value: d.kind },
      { key: 'items', label: 'Text (one item per line; hierarchy: prefix "-" per level)', type: 'textarea', rows: 6, value: d.items.join('\n') },
      { key: 'c1', label: 'Color 1', type: 'color', value: d.colors[0], half: true },
      { key: 'c2', label: 'Color 2', type: 'color', value: d.colors[1], half: true },
      { key: 'mono', label: 'Single color', type: 'checkbox', value: d.colors.every((c) => c === d.colors[0]), half: true },
      { key: 'textColor', label: 'Text color', type: 'color', value: d.textColor || '#ffffff', half: true },
      { key: 'w', label: 'Width (px)', type: 'number', value: d.w, half: true },
      { key: 'h', label: 'Height (px)', type: 'number', value: d.h, half: true },
    ],
    onChange: (x, ctl) => ctl.setPreview(diagramSvg(toDiagram(x, d))),
  });
  if (!r) return;
  const data = toDiagram(r, d);
  await insertGenerated(app, diagramSvg(data), data.w, data.h, 'diagram', data, pin);
}
function toDiagram(x: any, d: DiagramData): DiagramData {
  const colors = x.mono ? Array(10).fill(x.c1) : [x.c1, x.c2, ...PALETTE.slice(2)];
  return { kind: x.kind, items: String(x.items).split('\n'), colors, w: x.w || d.w, h: x.h || d.h, textColor: x.textColor };
}

async function editChart(app: App, d: ChartData, pos?: number) {
  const pin = pos != null ? pinNode(app.state.doc, pos) : undefined;
  const r = await openDialog({
    title: pos != null ? 'Edit Chart' : 'Insert Chart', wide: true, preview: true,
    fields: [
      { key: 'kind', label: 'Chart type', type: 'select', options: CHARTS.map((c) => ({ value: c.kind, label: c.label })), value: d.kind, half: true },
      { key: 'title', label: 'Title', type: 'text', value: d.title, half: true },
      { key: 'csv', label: 'Data (CSV or tab-separated; first row = series names, first column = categories)', type: 'textarea', rows: 7, value: chartToCsv(d) },
      { key: 'legend', label: 'Legend', type: 'checkbox', value: d.legend, half: true },
      { key: 'labels', label: 'Data labels', type: 'checkbox', value: d.labels, half: true },
      { key: 'w', label: 'Width (px)', type: 'number', value: d.w, half: true },
      { key: 'h', label: 'Height (px)', type: 'number', value: d.h, half: true },
    ],
    onChange: (x, ctl) => ctl.setPreview(chartSvg({ ...d, ...x, ...parseChartCsv(x.csv) })),
  });
  if (!r) return;
  const data: ChartData = { ...d, kind: r.kind, title: r.title, legend: r.legend, labels: r.labels, w: r.w, h: r.h, ...parseChartCsv(r.csv) };
  await insertGenerated(app, chartSvg(data), data.w, data.h, 'chart', data, pin);
}

// Links ----------------------------------------------------------------------------------------
def([
  {
    id: 'insert.link', label: 'Link', icon: 'link', tab: 'Insert', group: 'Links', keys: ['Mod-k'], edits: true, popular: true,
    run: async (app, arg) => {
      const st = app.state;
      // A collapsed cursor inside a link edits that whole link (its text and address).
      const at = !arg?.href && st.selection.empty ? linkAtCursor(st) : null;
      const cur = at?.mark.attrs.href || markAttr(st, M.link, 'href') || '';
      let href = arg?.href, text = arg?.text;
      if (!href) {
        const bookmarks: string[] = [];
        st.doc.descendants((n) => { if (n.type === N.bookmark) bookmarks.push('#' + n.attrs.name); return true; });
        const r = await openDialog({ title: cur ? 'Edit Link' : 'Insert Link', fields: [
          { key: 'text', label: 'Text to display', type: 'text', value: at ? st.doc.textBetween(at.from, at.to) : selectedText(st) },
          { key: 'href', label: 'Address (web page, mailto:, tel:, or #bookmark)', type: 'combo', options: bookmarks, value: cur || '', autofocus: true },
          { key: 'title', label: 'ScreenTip', type: 'text', value: (at ? at.mark.attrs.title : markAttr(st, M.link, 'title')) || '' },
        ], buttons: cur ? [{ label: 'Remove Link', onClick: (_v, ctl) => { app.exec('insert.removeLink'); ctl.close(); } }] : [] });
        if (!r || !r.href) return;
        href = r.href.trim(); text = r.text;
        if (!/^(https?:|mailto:|tel:|#|ftp:|file:)/i.test(href)) href = /@/.test(href) && !/\//.test(href) ? 'mailto:' + href : 'https://' + href;
        arg = { title: r.title };
      }
      const view = v(app);
      const mark = M.link.create({ href, title: arg?.title || null });
      const link = at && view.state.selection.empty ? linkAtCursor(view.state) : null;
      if (link) {
        const tr = view.state.tr;
        if (text && text !== view.state.doc.textBetween(link.from, link.to)) tr.replaceWith(link.from, link.to, schema.text(text, mark.addToSet(link.mark.removeFromSet(view.state.doc.resolve(link.from + 1).marks()))));
        else tr.removeMark(link.from, link.to, M.link).addMark(link.from, link.to, mark);
        view.dispatch(tr.scrollIntoView());
        return;
      }
      const { from, to, empty } = view.state.selection;
      if (empty || (text && text !== selectedText(view.state))) {
        const t = text || href;
        const tr = view.state.tr.replaceSelectionWith(schema.text(t, [mark]), false);
        view.dispatch(tr.scrollIntoView());
      } else {
        view.dispatch(view.state.tr.removeMark(from, to, M.link).addMark(from, to, mark));
      }
    },
  },
  {
    id: 'insert.removeLink', label: 'Remove Link', icon: 'link_off', tab: 'Insert', group: 'Links', edits: true,
    run: (app) => {
      const st = app.state;
      let { from, to } = st.selection;
      if (from === to) {
        const link = linkAtCursor(st);
        if (!link) return;
        ({ from, to } = link);
      }
      v(app).dispatch(st.tr.removeMark(from, to, M.link));
    },
  },
  { id: 'insert.openLink', label: 'Open Link', icon: 'open_in_new', tab: 'Insert', group: 'Links', run: (app) => { const h0 = markAttr(app.state, M.link, 'href'); if (h0) app.followLink(h0); else toast('No link at the cursor.'); } },
  { id: 'insert.copyLink', label: 'Copy Link Address', icon: 'content_copy', tab: 'Insert', group: 'Links', run: async (app) => { const h0 = markAttr(app.state, M.link, 'href'); if (h0) { await navigator.clipboard?.writeText(h0); toast('Link copied'); } } },
  {
    id: 'insert.bookmark', label: 'Bookmark…', icon: 'bookmark_add', tab: 'Insert', group: 'Links', keys: ['Mod-Shift-F5'], edits: true,
    run: async (app) => {
      const names: string[] = [];
      app.state.doc.descendants((n) => { if (n.type === N.bookmark) names.push(n.attrs.name); return true; });
      const r = await openDialog({ title: 'Bookmark', fields: [
        { key: 'name', label: 'Bookmark name', type: 'combo', options: names, value: '', autofocus: true },
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'add', label: 'Add' }, { value: 'goto', label: 'Go To' }, { value: 'delete', label: 'Delete' }], value: 'add' },
      ] });
      if (!r?.name) return;
      const name = String(r.name).replace(/\s+/g, '_');
      if (r.act === 'goto') return app.exec('nav.gotoAnchor', name);
      if (r.act === 'delete') {
        let p = -1;
        app.state.doc.descendants((n, pos) => { if (n.type === N.bookmark && n.attrs.name === name) p = pos; return true; });
        if (p >= 0) v(app).dispatch(app.state.tr.delete(p, p + 1));
        return;
      }
      if (names.includes(name)) { toast('A bookmark with that name exists.'); return; }
      const pos = app.state.selection.from;
      v(app).dispatch(app.state.tr.insert(pos, N.bookmark.create({ name })));
      toast(`Bookmark "${name}" added`);
    },
  },
]);

/** The whole link run around a collapsed cursor. Links are non-inclusive, so $pos.marks() is unreliable at
 *  their edges: look at the inline children around the cursor and take the run carrying the same link mark. */
function linkAtCursor(st: EditorState): { from: number; to: number; mark: Mark } | null {
  const $p = st.selection.$from;
  const parent = $p.parent;
  let i = $p.index();
  const linkOf = (k: number) => (k >= 0 && k < parent.childCount ? M.link.isInSet(parent.child(k).marks) : null);
  let m = $p.textOffset ? linkOf(i) : null;
  if (!m && !$p.textOffset) { m = linkOf(i - 1); if (m) i--; else m = linkOf(i); }
  if (!m) return null;
  let a = i, b = i;
  while (a > 0 && m.isInSet(parent.child(a - 1).marks)) a--;
  while (b < parent.childCount - 1 && m.isInSet(parent.child(b + 1).marks)) b++;
  let from = $p.start(), to = from;
  for (let k = 0; k <= b; k++) { const size = parent.child(k).nodeSize; if (k < a) from += size; to += size; }
  return { from, to, mark: m };
}

// Header & footer ------------------------------------------------------------------------------
const HF_PRESETS: Record<string, { left: string; center: string; right: string }> = {
  blank: { left: '', center: '', right: '' },
  title: { left: '', center: '{TITLE}', right: '' },
  titleDate: { left: '{TITLE}', center: '', right: '{DATE:MMMM d, yyyy}' },
  author: { left: '{AUTHOR}', center: '', right: '{TITLE}' },
  page: { left: '', center: 'Page {PAGE}', right: '' },
  pageOf: { left: '', center: 'Page {PAGE} of {NUMPAGES}', right: '' },
  pageRight: { left: '', center: '', right: '{PAGE}' },
  pageLeft: { left: '{PAGE}', center: '', right: '' },
  confidential: { left: 'CONFIDENTIAL', center: '', right: '{DATE}' },
  manuscript: { left: '', center: '', right: '{AUTHOR} / {TITLE} / {PAGE}' },
  file: { left: '{FILENAME}', center: '', right: 'Page {PAGE}' },
};
async function editHF(app: App, which: 'header' | 'footer') {
  const s = app.settings;
  const r = await openDialog({
    title: which === 'header' ? 'Header' : 'Footer', wide: true,
    help: 'Codes: {PAGE} {NUMPAGES} {DATE} {DATE:MMMM d, yyyy} {TIME} {TITLE} {AUTHOR} {FILENAME} {SECTION}. Use separate boxes for left, center, and right parts.',
    fields: [
      { key: 'preset', label: 'Built-in', type: 'select', options: [{ value: '', label: '(custom)' }, ...Object.keys(HF_PRESETS).map((k) => ({ value: k, label: k }))], value: '' },
      { key: 'left', label: 'Left', type: 'text', value: s[which].left },
      { key: 'center', label: 'Center', type: 'text', value: s[which].center },
      { key: 'right', label: 'Right', type: 'text', value: s[which].right },
      { key: 'differentFirst', label: 'Different first page', type: 'checkbox', value: s.differentFirst, half: true },
      { key: 'differentOddEven', label: 'Different odd & even pages', type: 'checkbox', value: s.differentOddEven, half: true },
      { key: 'fLeft', label: 'First page: left', type: 'text', value: s[which === 'header' ? 'firstHeader' : 'firstFooter'].left, visibleIf: (x) => x.differentFirst },
      { key: 'fCenter', label: 'First page: center', type: 'text', value: s[which === 'header' ? 'firstHeader' : 'firstFooter'].center, visibleIf: (x) => x.differentFirst },
      { key: 'fRight', label: 'First page: right', type: 'text', value: s[which === 'header' ? 'firstHeader' : 'firstFooter'].right, visibleIf: (x) => x.differentFirst },
      { key: 'eLeft', label: 'Even pages: left', type: 'text', value: s[which === 'header' ? 'evenHeader' : 'evenFooter'].left, visibleIf: (x) => x.differentOddEven },
      { key: 'eCenter', label: 'Even pages: center', type: 'text', value: s[which === 'header' ? 'evenHeader' : 'evenFooter'].center, visibleIf: (x) => x.differentOddEven },
      { key: 'eRight', label: 'Even pages: right', type: 'text', value: s[which === 'header' ? 'evenHeader' : 'evenFooter'].right, visibleIf: (x) => x.differentOddEven },
      { key: 'dist', label: `${which === 'header' ? 'Header from top' : 'Footer from bottom'} (pt)`, type: 'number', value: which === 'header' ? s.page.headerDist : s.page.footerDist },
    ],
    onChange: (x, ctl, key) => { if (key === 'preset' && x.preset) { const p = HF_PRESETS[x.preset]; ctl.set('left', p.left); ctl.set('center', p.center); ctl.set('right', p.right); } },
  });
  if (!r) return;
  app.updateSettings((st) => {
    st[which] = { left: r.left, center: r.center, right: r.right };
    st.differentFirst = r.differentFirst; st.differentOddEven = r.differentOddEven;
    if (r.differentFirst) st[which === 'header' ? 'firstHeader' : 'firstFooter'] = { left: r.fLeft || '', center: r.fCenter || '', right: r.fRight || '' };
    if (r.differentOddEven) st[which === 'header' ? 'evenHeader' : 'evenFooter'] = { left: r.eLeft || '', center: r.eCenter || '', right: r.eRight || '' };
    if (which === 'header') st.page.headerDist = r.dist; else st.page.footerDist = r.dist;
  });
  if (app.tab.viewMode !== 'print') toast('Headers and footers show in Print Layout and when printing.', { action: 'Print Layout', onAction: () => app.setViewMode('print') });
}
def([
  {
    id: 'insert.header', label: 'Header', icon: 'vertical_align_top', tab: 'Insert', group: 'Header & Footer', kind: 'split', edits: true, popular: true,
    run: (app, arg) => { if (arg && HF_PRESETS[arg]) app.updateSettings((s) => { s.header = { ...HF_PRESETS[arg] }; }); else editHF(app, 'header'); },
    menu: () => [...Object.keys(HF_PRESETS).map((k) => ({ id: 'insert.header', arg: k, label: `${k}: ${Object.values(HF_PRESETS[k]).filter(Boolean).join(' · ') || '(blank)'}` })), { separator: true }, { id: 'insert.header', label: 'Edit Header…' }, { id: 'insert.removeHeader', label: 'Remove Header' }],
  },
  {
    id: 'insert.footer', label: 'Footer', icon: 'vertical_align_bottom', tab: 'Insert', group: 'Header & Footer', kind: 'split', edits: true, popular: true,
    run: (app, arg) => { if (arg && HF_PRESETS[arg]) app.updateSettings((s) => { s.footer = { ...HF_PRESETS[arg] }; }); else editHF(app, 'footer'); },
    menu: () => [...Object.keys(HF_PRESETS).map((k) => ({ id: 'insert.footer', arg: k, label: `${k}: ${Object.values(HF_PRESETS[k]).filter(Boolean).join(' · ') || '(blank)'}` })), { separator: true }, { id: 'insert.footer', label: 'Edit Footer…' }, { id: 'insert.removeFooter', label: 'Remove Footer' }],
  },
  { id: 'insert.removeHeader', label: 'Remove Header', icon: 'delete', tab: 'Insert', group: 'Header & Footer', edits: true, run: (app) => app.updateSettings((s) => { s.header = { left: '', center: '', right: '' }; s.firstHeader = { ...s.header }; s.evenHeader = { ...s.header }; }) },
  { id: 'insert.removeFooter', label: 'Remove Footer', icon: 'delete', tab: 'Insert', group: 'Header & Footer', edits: true, run: (app) => app.updateSettings((s) => { s.footer = { left: '', center: '', right: '' }; s.firstFooter = { ...s.footer }; s.evenFooter = { ...s.footer }; }) },
  {
    id: 'insert.pageNumber', label: 'Page Number', icon: 'tag', tab: 'Insert', group: 'Header & Footer', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => {
      switch (arg) {
        case 'topRight': return app.updateSettings((s) => { s.header.right = '{PAGE}'; });
        case 'topCenter': return app.updateSettings((s) => { s.header.center = '{PAGE}'; });
        case 'bottomCenter': return app.updateSettings((s) => { s.footer.center = '{PAGE}'; });
        case 'bottomRight': return app.updateSettings((s) => { s.footer.right = '{PAGE}'; });
        case 'bottomOf': return app.updateSettings((s) => { s.footer.center = 'Page {PAGE} of {NUMPAGES}'; });
        case 'current': return insertInline(v(app), N.field.create({ type: 'PAGE', value: '1' }));
        case 'format': return app.exec('insert.pageNumberFormat');
        case 'remove': return app.updateSettings((s) => { for (const k of ['header', 'footer', 'firstHeader', 'firstFooter', 'evenHeader', 'evenFooter'] as const) for (const side of ['left', 'center', 'right'] as const) s[k][side] = s[k][side].replace(/(Page\s*)?\{PAGE\}(\s*of\s*\{NUMPAGES\})?/g, '').trim(); });
        default: return app.updateSettings((s) => { s.footer.center = '{PAGE}'; });
      }
    },
    menu: () => [
      { id: 'insert.pageNumber', arg: 'topRight', label: 'Top of Page, Right' }, { id: 'insert.pageNumber', arg: 'topCenter', label: 'Top of Page, Center' },
      { id: 'insert.pageNumber', arg: 'bottomCenter', label: 'Bottom of Page, Center' }, { id: 'insert.pageNumber', arg: 'bottomRight', label: 'Bottom of Page, Right' },
      { id: 'insert.pageNumber', arg: 'bottomOf', label: 'Bottom: Page X of Y' }, { id: 'insert.pageNumber', arg: 'current', label: 'Current Position (field)' },
      { separator: true }, { id: 'insert.pageNumber', arg: 'format', label: 'Format Page Numbers…' }, { id: 'insert.pageNumber', arg: 'remove', label: 'Remove Page Numbers' },
    ],
  },
  {
    id: 'insert.pageNumberFormat', label: 'Format Page Numbers…', icon: 'format_list_numbered', tab: 'Insert', group: 'Header & Footer', edits: true,
    run: async (app) => {
      const s = app.settings;
      const r = await openDialog({ title: 'Page Number Format', fields: [
        { key: 'format', label: 'Number format', type: 'select', options: [{ value: 'decimal', label: '1, 2, 3' }, { value: 'lower-roman', label: 'i, ii, iii' }, { value: 'upper-roman', label: 'I, II, III' }, { value: 'lower-alpha', label: 'a, b, c' }, { value: 'upper-alpha', label: 'A, B, C' }], value: s.pageNumber.format },
        { key: 'start', label: 'Start at', type: 'number', value: s.pageNumber.start, min: 0 },
      ] });
      if (r) app.updateSettings((st) => { st.pageNumber = { format: r.format, start: r.start ?? 1 }; });
    },
  },
]);

// Text group -----------------------------------------------------------------------------------
def([
  {
    id: 'insert.textBox', label: 'Text Box', icon: 'text_fields', tab: 'Insert', group: 'Text', kind: 'menu', edits: true,
    run: (app, arg) => {
      const presets: Record<string, Record<string, any>> = {
        simple: { border: '1px solid #444' },
        sidebarRight: { float: 'right', width: '35%', border: 'none', bg: 'var(--qf-accent1-pale)', kind: 'sidebar' },
        sidebarLeft: { float: 'left', width: '35%', border: 'none', bg: '#f2f2f2', kind: 'sidebar' },
        pullQuote: { float: 'right', width: '40%', border: 'none', kind: 'pullquote' },
        callout: { border: '2px solid var(--qf-accent1)', radius: 8, bg: '#fff', shadow: true, kind: 'callout' },
        note: { border: 'none', bg: '#fff8c5', kind: 'note' },
        warning: { border: '1px solid #e0a800', bg: '#fff3cd', kind: 'warning' },
      };
      const p = presets[arg || 'simple'] || presets.simple;
      const text = selectedText(app.state);
      const inner = arg === 'pullQuote' ? P(text || '“Pull quote text”', { style: 'Intense Quote' }) : P(text || '');
      const box = N.text_box.create(p, [inner]);
      if (!app.state.selection.empty) {
        const { from, to } = app.state.selection;
        const tr = app.state.tr.delete(from, to);
        v(app).dispatch(tr);
      }
      insertBlock(v(app), box);
    },
    menu: () => [
      { id: 'insert.textBox', arg: 'simple', label: 'Simple Text Box' }, { id: 'insert.textBox', arg: 'sidebarRight', label: 'Sidebar (right)' },
      { id: 'insert.textBox', arg: 'sidebarLeft', label: 'Sidebar (left)' }, { id: 'insert.textBox', arg: 'pullQuote', label: 'Pull Quote' },
      { id: 'insert.textBox', arg: 'callout', label: 'Callout Box' }, { id: 'insert.textBox', arg: 'note', label: 'Note (yellow)' }, { id: 'insert.textBox', arg: 'warning', label: 'Warning' },
    ],
  },
  {
    id: 'insert.textBoxFormat', label: 'Format Text Box…', icon: 'tune', tab: 'Insert', group: 'Text', edits: true,
    run: async (app) => {
      const $f = app.state.selection.$from;
      let d = -1;
      for (let i = $f.depth; i > 0; i--) if ($f.node(i).type === N.text_box) { d = i; break; }
      if (d < 0) { toast('Place the cursor inside a text box.'); return; }
      const node = $f.node(d), pos = $f.before(d);
      const pin = pinNode(app.state.doc, pos);
      const a = node.attrs;
      const r = await openDialog({ title: 'Format Text Box', fields: [
        { key: 'float', label: 'Position', type: 'select', options: ['none', 'left', 'right'], value: a.float, half: true },
        { key: 'width', label: 'Width (e.g. 40% or 200pt)', type: 'text', value: a.width || '', half: true },
        { key: 'border', label: 'Border (CSS)', type: 'text', value: a.border || '', half: true },
        { key: 'bg', label: 'Fill', type: 'color', value: /^#/.test(a.bg || '') ? a.bg : '#ffffff', half: true },
        { key: 'noFill', label: 'No fill', type: 'checkbox', value: !a.bg, half: true },
        { key: 'padding', label: 'Internal margin (pt)', type: 'number', value: a.padding, half: true },
        { key: 'radius', label: 'Corner radius (pt)', type: 'number', value: a.radius, half: true },
        { key: 'rotate', label: 'Rotation (°)', type: 'number', value: a.rotate, half: true },
        { key: 'shadow', label: 'Shadow', type: 'checkbox', value: a.shadow, half: true },
      ], buttons: [{ label: 'Remove Box (keep text)', onClick: (_v, ctl) => { const p = findPinned(app.state.doc, pin); if (p >= 0) v(app).dispatch(app.state.tr.replaceWith(p, p + node.nodeSize, node.content)); ctl.close(); } }] });
      if (!r) return;
      // The box may have moved, or been edited, while the dialog was open.
      const p = findPinned(app.state.doc, pin);
      if (p < 0) { toast('The text box changed while the dialog was open. Try again.'); return; }
      v(app).dispatch(app.state.tr.setNodeMarkup(p, undefined, { ...a, float: r.float, width: r.width || null, border: r.border || null, bg: r.noFill ? null : r.bg, padding: r.padding, radius: r.radius, rotate: r.rotate, shadow: r.shadow }));
    },
  },
  {
    id: 'insert.decorativeText', label: 'Decorative Text', icon: 'format_shapes', tab: 'Insert', group: 'Text', kind: 'menu', edits: true,
    run: (app, arg) => {
      const styles: Record<string, [string, number, string | null, string]> = {
        bold: ['shadow', 36, '#2b579a', 'Lato'], outline: ['outline', 40, '#c00000', 'Merriweather'], glow: ['glow', 36, '#7030a0', 'Open Sans'],
        neon: ['neon', 40, '#00b0f0', 'Lato'], emboss: ['emboss', 36, '#808080', 'Tinos'], gradient: ['gradient', 40, '#ed7d31', 'Lato'],
        retro: ['3d', 40, '#ffc000', 'Courier Prime'], elegant: ['reflection', 36, '#3b2f2f', 'EB Garamond'],
      };
      const [kind, size, color, font] = styles[arg || 'bold'] || styles.bold;
      const text = selectedText(app.state) || 'Your text here';
      const marks = [M.effect.create({ kind, color }), M.size.create({ pt: size }), M.font.create({ family: font }), ...(color ? [M.color.create({ color })] : []), M.bold.create()];
      const view = v(app);
      view.dispatch(view.state.tr.replaceSelectionWith(schema.text(text, marks), false));
    },
    menu: () => ['bold', 'outline', 'glow', 'neon', 'emboss', 'gradient', 'retro', 'elegant'].map((k) => ({ id: 'insert.decorativeText', arg: k, label: k[0].toUpperCase() + k.slice(1) })),
  },
  {
    id: 'insert.signatureLine', label: 'Signature Line', icon: 'signature', tab: 'Insert', group: 'Text', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Signature Setup', fields: [
        { key: 'name', label: 'Suggested signer', type: 'text', value: app.prefs.author },
        { key: 'title', label: 'Signer title', type: 'text', value: '' },
        { key: 'date', label: 'Show date line', type: 'checkbox', value: true },
        { key: 'sign', label: 'Draw signature now', type: 'checkbox', value: false },
      ] });
      if (!r) return;
      const blocks = [P(''), P('X\t', { border: JSON.stringify({ bottom: '1px solid #000' }), indentRight: 216 }), P(r.name, { spaceAfter: 0 }), ...(r.title ? [P(r.title, { spaceAfter: 0 })] : []), ...(r.date ? [P('Date: ____________________')] : [])];
      insertBlock(v(app), blocks);
      if (r.sign) app.exec('draw.signature');
    },
  },
  {
    id: 'insert.dateTime', label: 'Date & Time…', icon: 'calendar_today', tab: 'Insert', group: 'Text', keys: ['Alt-Shift-d'], edits: true,
    run: async (app) => {
      const { formatDate } = await import('../editor/fields');
      const fmts = ['M/d/yyyy', 'dddd, MMMM d, yyyy', 'MMMM d, yyyy', 'M/d/yy', 'yyyy-MM-dd', 'd-MMM-yy', 'M.d.yyyy', 'MMM. d, yy', 'd MMMM yyyy', 'MMMM yy', 'MMM-yy', 'M/d/yyyy h:mm am/pm', 'M/d/yyyy h:mm:ss am/pm', 'h:mm am/pm', 'h:mm:ss am/pm', 'HH:mm', 'HH:mm:ss'];
      const now = new Date();
      const r = await openDialog({ title: 'Date and Time', fields: [
        { key: 'fmt', label: 'Available formats', type: 'list', rows: 10, options: fmts.map((f) => ({ value: f, label: formatDate(now, f) })), value: fmts[0] },
        { key: 'auto', label: 'Update automatically (insert as field)', type: 'checkbox', value: false },
      ] });
      if (!r) return;
      const isTime = /^h|^H/.test(r.fmt);
      if (r.auto) insertInline(v(app), N.field.create({ type: isTime ? 'TIME' : 'DATE', format: r.fmt, value: formatDate(now, r.fmt) }));
      else v(app).dispatch(app.state.tr.insertText(formatDate(now, r.fmt)));
    },
  },
  { id: 'insert.date', label: 'Insert Date Field', icon: 'today', tab: 'Insert', group: 'Text', edits: true, run: async (app) => { const { formatDate } = await import('../editor/fields'); insertInline(v(app), N.field.create({ type: 'DATE', format: 'M/d/yyyy', value: formatDate(new Date(), 'M/d/yyyy') })); } },
  { id: 'insert.time', label: 'Insert Time Field', icon: 'schedule', tab: 'Insert', group: 'Text', keys: ['Alt-Shift-t'], edits: true, run: async (app) => { const { formatDate } = await import('../editor/fields'); insertInline(v(app), N.field.create({ type: 'TIME', format: 'h:mm am/pm', value: formatDate(new Date(), 'h:mm am/pm') })); } },
  {
    id: 'insert.field', label: 'Field…', icon: 'data_object', tab: 'Insert', group: 'Text', keys: ['Mod-F9'], edits: true, popular: true,
    run: async (app) => {
      const groups = [...new Set(FIELD_TYPES.map((f) => f.group))];
      const r = await openDialog({ title: 'Field', wide: true, fields: [
        { key: 'type', label: 'Field name', type: 'list', rows: 12, options: groups.flatMap((g) => FIELD_TYPES.filter((f) => f.group === g).map((f) => ({ value: f.type, label: `${f.type} — ${f.label}` }))), value: 'DATE' },
        { key: 'arg', label: 'Argument (bookmark, property, identifier, expression…)', type: 'text', value: '' },
        { key: 'format', label: 'Format (date picture, number picture, or Arabic/roman/ROMAN/alphabetic)', type: 'text', value: '' },
        { key: 'locked', label: 'Lock field (prevent updates)', type: 'checkbox', value: false },
      ] });
      if (!r?.type) return;
      insertInline(v(app), N.field.create({ type: r.type, arg: r.arg || null, format: r.format || null, locked: r.locked }));
      app.updateFields();
    },
  },
  {
    id: 'insert.editField', label: 'Edit Field…', icon: 'edit', tab: 'Insert', group: 'Text', edits: true,
    run: async (app, arg) => {
      const pos = arg?.pos ?? (app.state.selection instanceof NodeSelection ? app.state.selection.from : -1);
      const node = pos >= 0 ? app.state.doc.nodeAt(pos) : null;
      if (!node || node.type !== N.field) { toast('Select a field first.'); return; }
      const pin = pinNode(app.state.doc, pos);
      const r = await openDialog({ title: `Edit Field (${node.attrs.type})`, fields: [
        { key: 'type', label: 'Field', type: 'select', options: FIELD_TYPES.map((f) => f.type), value: node.attrs.type },
        { key: 'arg', label: 'Argument', type: 'text', value: node.attrs.arg || '' },
        { key: 'format', label: 'Format', type: 'text', value: node.attrs.format || '' },
        { key: 'value', label: 'Result text (for FILLIN)', type: 'text', value: node.attrs.value || '' },
        { key: 'locked', label: 'Locked', type: 'checkbox', value: node.attrs.locked },
      ], buttons: [{ label: 'Unlink (convert to text)', onClick: (_v, ctl) => { const p = findPinned(app.state.doc, pin); if (p >= 0) v(app).dispatch(app.state.tr.replaceWith(p, p + 1, schema.text(node.attrs.value || ' '))); ctl.close(); } }] });
      if (!r) return;
      const p = findPinned(app.state.doc, pin);
      if (p < 0) { toast('The field changed while the dialog was open. Try again.'); return; }
      v(app).dispatch(app.state.tr.setNodeMarkup(p, undefined, { ...node.attrs, type: r.type, arg: r.arg || null, format: r.format || null, value: r.value, locked: r.locked }));
      app.updateFields();
    },
  },
  { id: 'insert.updateFields', label: 'Update Fields', icon: 'refresh', tab: 'Insert', group: 'Text', keys: ['F9'], edits: true, run: (app) => { app.updateFields(undefined, app.state.selection.empty ? undefined : { from: app.state.selection.from, to: app.state.selection.to }); toast('Fields updated'); } },
  { id: 'insert.toggleFieldCodes', label: 'Toggle Field Codes', icon: 'code', tab: 'Insert', group: 'Text', keys: ['Alt-F9'], run: (app) => { app.prefs.showFieldCodes = !app.prefs.showFieldCodes; app.savePrefs(); app.ui.applyPrefs(); }, isActive: (app) => app.prefs.showFieldCodes },
  {
    id: 'insert.unlinkFields', label: 'Unlink Fields (Convert to Text)', icon: 'link_off', tab: 'Insert', group: 'Text', keys: ['Mod-Shift-F9'], edits: true,
    run: (app) => {
      const st = app.state; const { from, to, empty } = st.selection;
      const tr = st.tr;
      const list: { pos: number; node: PMNode }[] = [];
      st.doc.nodesBetween(empty ? 0 : from, empty ? st.doc.content.size : to, (n, pos) => { if (n.type === N.field) list.push({ pos, node: n }); return true; });
      for (const f of list.reverse()) tr.replaceWith(f.pos, f.pos + 1, f.node.attrs.value ? schema.text(f.node.attrs.value, f.node.marks) : Fragment.empty);
      v(app).dispatch(tr);
      toast(`${list.length} field(s) converted to text`);
    },
  },
  { id: 'insert.lockFields', label: 'Lock Fields', icon: 'lock', tab: 'Insert', group: 'Text', keys: ['Mod-F11'], edits: true, run: (app) => setFieldLock(app, true) },
  { id: 'insert.unlockFields', label: 'Unlock Fields', icon: 'lock_open', tab: 'Insert', group: 'Text', keys: ['Mod-Shift-F11'], edits: true, run: (app) => setFieldLock(app, false) },
  {
    id: 'insert.docProperty', label: 'Document Property', icon: 'description', tab: 'Insert', group: 'Text', kind: 'menu', edits: true,
    run: (app, arg) => { insertInline(v(app), N.field.create({ type: arg || 'TITLE' })); app.updateFields(); },
    menu: () => ['TITLE', 'AUTHOR', 'SUBJECT', 'KEYWORDS', 'COMMENTS', 'FILENAME', 'NUMPAGES', 'NUMWORDS', 'CREATEDATE', 'SAVEDATE'].map((t) => ({ id: 'insert.docProperty', arg: t, label: t[0] + t.slice(1).toLowerCase() })),
  },
  {
    id: 'insert.textFromFile', label: 'Text from File…', icon: 'file_open', tab: 'Insert', group: 'Text', edits: true,
    run: async (app) => {
      const { openDocument, OPEN_ACCEPT, OPEN_MIMES } = await import('../platform/native');
      const { importFile } = await import('../io');
      const f = await openDocument(OPEN_ACCEPT, OPEN_MIMES);
      if (!f) return;
      const { doc } = await importFile(f.data, f.name);
      v(app).dispatch(app.state.tr.replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView());
    },
  },
  {
    id: 'insert.lorem', label: 'Placeholder Text (Lorem Ipsum)', icon: 'notes', tab: 'Insert', group: 'Text', edits: true, origin: '=lorem() / =rand()',
    run: async (app) => {
      const r = await openDialog({ title: 'Placeholder Text', fields: [
        { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'lorem', label: 'Lorem ipsum' }, { value: 'pangram', label: 'Pangrams' }, { value: 'english', label: 'Readable English' }], value: 'lorem', half: true },
        { key: 'paras', label: 'Paragraphs', type: 'number', value: 3, half: true },
        { key: 'sent', label: 'Sentences per paragraph', type: 'number', value: 5, half: true },
      ] });
      if (!r) return;
      insertBlock(v(app), Array.from({ length: Math.max(1, r.paras) }, (_, i) => P(placeholder(r.kind, r.sent, i))));
    },
  },
]);

function setFieldLock(app: App, locked: boolean) {
  const st = app.state; const tr = st.tr; const { from, to, empty } = st.selection;
  st.doc.nodesBetween(empty ? 0 : from, empty ? st.doc.content.size : to, (n, pos) => { if (n.type === N.field) tr.setNodeMarkup(pos, undefined, { ...n.attrs, locked }); return true; });
  v(app).dispatch(tr);
}

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris. Integer in mauris eu nibh euismod gravida. Duis ac tellus et risus vulputate vehicula. Donec lobortis risus a elit. Etiam tempor.'.split(/(?<=\.)\s+/);
const PANGRAMS = ['The quick brown fox jumps over the lazy dog.', 'Pack my box with five dozen liquor jugs.', 'How vexingly quick daft zebras jump!', 'Sphinx of black quartz, judge my vow.', 'The five boxing wizards jump quickly.', 'Jackdaws love my big sphinx of quartz.', 'Bright vixens jump; dozy fowl quack.'];
const ENGLISH = ['A good document begins with a clear purpose.', 'Each paragraph should develop a single idea.', 'Headings help readers find their way through long material.', 'Short sentences are easier to follow than long ones.', 'Revise for clarity first, then for style.', 'Consistent formatting makes a page easier to scan.', 'Read your work aloud to catch awkward phrasing.', 'Cut every word that does not earn its place.'];
function placeholder(kind: string, n: number, seed: number): string {
  const src = kind === 'pangram' ? PANGRAMS : kind === 'english' ? ENGLISH : LOREM;
  return Array.from({ length: Math.max(1, n) }, (_, i) => src[(seed * n + i) % src.length]).join(' ');
}

// Symbols & special characters -----------------------------------------------------------------
export const SPECIAL_CHARS: [string, string, string?][] = [
  ['—', 'Em Dash', 'Mod-Alt--'], ['–', 'En Dash'], ['‑', 'Nonbreaking Hyphen', 'Mod-Shift--'], [' ', 'Nonbreaking Space', 'Mod-Shift-Space'],
  [' ', 'En Space'], [' ', 'Em Space'], [' ', 'Thin Space'], [' ', 'Narrow No-Break Space'], ['​', 'Zero-Width Space (optional break)'],
  ['‌', 'Zero-Width Non-Joiner'], ['‍', 'Zero-Width Joiner'], ['©', 'Copyright', 'Mod-Alt-c'], ['®', 'Registered', 'Mod-Alt-r'], ['™', 'Trademark', 'Mod-Alt-t'],
  ['§', 'Section'], ['¶', 'Paragraph Mark'], ['…', 'Ellipsis', 'Mod-Alt-.'], ['‘', 'Single Opening Quote'], ['’', 'Single Closing Quote (Apostrophe)'],
  ['“', 'Double Opening Quote'], ['”', 'Double Closing Quote'], ['«', 'Left Guillemet'], ['»', 'Right Guillemet'], ['†', 'Dagger'], ['‡', 'Double Dagger'],
  ['•', 'Bullet'], ['°', 'Degree'], ['±', 'Plus-Minus'], ['×', 'Multiplication Sign'], ['÷', 'Division Sign'], ['≠', 'Not Equal'], ['≈', 'Approximately'],
  ['≤', 'Less or Equal'], ['≥', 'Greater or Equal'], ['∞', 'Infinity'], ['√', 'Square Root'], ['π', 'Pi'], ['µ', 'Micro'], ['€', 'Euro'], ['£', 'Pound'], ['¥', 'Yen'], ['¢', 'Cent'],
  ['½', 'One Half'], ['¼', 'One Quarter'], ['¾', 'Three Quarters'], ['⅓', 'One Third'], ['→', 'Right Arrow'], ['←', 'Left Arrow'], ['↑', 'Up Arrow'], ['↓', 'Down Arrow'],
  ['✓', 'Check Mark'], ['✗', 'Ballot X'], ['☐', 'Ballot Box'], ['☒', 'Ballot Box with X'], ['★', 'Black Star'], ['☆', 'White Star'], ['♥', 'Heart'], ['☺', 'Smiley'],
  ['℠', 'Service Mark'], ['℗', 'Sound Recording Copyright'], ['‰', 'Per Mille'], ['′', 'Prime (feet/minutes)'], ['″', 'Double Prime (inches/seconds)'], ['⁂', 'Asterism'], ['※', 'Reference Mark'],
  ['☧', 'Chi Rho'], ['✝', 'Latin Cross'], ['✡', 'Star of David'], ['☦', 'Orthodox Cross'], ['℞', 'Prescription'], ['№', 'Numero'], ['℅', 'Care Of'], ['⁄', 'Fraction Slash'],
];
for (const [ch, name, key] of SPECIAL_CHARS) {
  def({ id: `insert.char.${name.replace(/[^A-Za-z]/g, '')}`, label: `Insert ${name}`, icon: 'special_character', tab: 'Insert', group: 'Symbols', keys: key ? [key] : undefined, edits: true, run: (app) => v(app).dispatch(app.state.tr.insertText(ch).scrollIntoView()), keywords: `symbol character ${ch}` });
}
def({ id: 'insert.optionalHyphen', label: 'Insert Optional Hyphen', icon: 'horizontal_rule', tab: 'Insert', group: 'Symbols', keys: ['Mod--'], edits: true, run: (app) => v(app).dispatch(app.state.tr.insertText('­')) });

const SYMBOL_BLOCKS: [string, number, number][] = [
  ['Latin-1 Supplement', 0x00a1, 0x00ff], ['Latin Extended-A', 0x0100, 0x017f], ['Latin Extended-B', 0x0180, 0x024f], ['IPA Extensions', 0x0250, 0x02af],
  ['Greek and Coptic', 0x0370, 0x03ff], ['Cyrillic', 0x0400, 0x04ff], ['Hebrew', 0x05d0, 0x05ea], ['Arabic', 0x0621, 0x064a],
  ['General Punctuation', 0x2010, 0x205e], ['Superscripts and Subscripts', 0x2070, 0x209c], ['Currency Symbols', 0x20a0, 0x20c0], ['Letterlike Symbols', 0x2100, 0x214f],
  ['Number Forms', 0x2150, 0x218b], ['Arrows', 0x2190, 0x21ff], ['Mathematical Operators', 0x2200, 0x22ff], ['Miscellaneous Technical', 0x2300, 0x23ff],
  ['Box Drawing', 0x2500, 0x257f], ['Block Elements', 0x2580, 0x259f], ['Geometric Shapes', 0x25a0, 0x25ff], ['Miscellaneous Symbols', 0x2600, 0x26ff],
  ['Dingbats', 0x2700, 0x27bf], ['Musical Symbols (basic)', 0x2669, 0x266f], ['Alchemical/Astrological (basic)', 0x263f, 0x2653], ['Braille', 0x2800, 0x28ff],
];
const recentSymbols: string[] = [];
def({
  id: 'insert.symbol', label: 'Symbol', icon: 'special_character', tab: 'Insert', group: 'Symbols', kind: 'split', edits: true, popular: true,
  run: async (app, arg) => {
    if (typeof arg === 'string') { v(app).dispatch(app.state.tr.insertText(arg)); if (!recentSymbols.includes(arg)) { recentSymbols.unshift(arg); recentSymbols.splice(20); } return; }
    const grid = h('div', { class: 'qf-symbol-grid' });
    const code = h('div', { class: 'qf-help' });
    let chosen = '';
    const fill = (from: number, to: number) => {
      grid.innerHTML = '';
      for (let c = from; c <= to; c++) {
        const ch = String.fromCodePoint(c);
        const b = h('button', { class: 'qf-sym-btn', type: 'button', title: `U+${c.toString(16).toUpperCase().padStart(4, '0')}` }, ch);
        b.addEventListener('click', () => { chosen = ch; code.textContent = `U+${c.toString(16).toUpperCase().padStart(4, '0')}  ${ch}`; grid.querySelectorAll('.qf-sel').forEach((x) => x.classList.remove('qf-sel')); b.classList.add('qf-sel'); });
        b.addEventListener('dblclick', () => { chosen = ch; (grid.closest('.qf-dialog')?.querySelector('.qf-primary') as HTMLElement)?.click(); });
        grid.appendChild(b);
      }
    };
    const content = h('div', null, grid, code);
    fill(SYMBOL_BLOCKS[0][1], SYMBOL_BLOCKS[0][2]);
    const r = await openDialog({ title: 'Symbol', wide: true, ok: 'Insert', content, fields: [
      { key: 'block', label: 'Subset', type: 'select', options: SYMBOL_BLOCKS.map((b, i) => ({ value: String(i), label: b[0] })), value: '0' },
      { key: 'hex', label: 'Character code (hex), or paste a character', type: 'text', value: '' },
      { key: 'font', label: 'Font (optional)', type: 'text', value: '' },
    ], onChange: (x, _c, key) => { if (key === 'block') { const b = SYMBOL_BLOCKS[+x.block]; fill(b[1], b[2]); } } });
    if (!r) return;
    let ch = chosen;
    if (r.hex) ch = /^[0-9a-f]{2,6}$/i.test(r.hex) ? String.fromCodePoint(parseInt(r.hex, 16)) : r.hex;
    if (!ch) return;
    const view = v(app);
    view.dispatch(view.state.tr.replaceSelectionWith(schema.text(ch, r.font ? [M.font.create({ family: r.font })] : view.state.selection.$from.marks()), false));
    if (!recentSymbols.includes(ch)) { recentSymbols.unshift(ch); recentSymbols.splice(20); }
  },
  menu: () => [
    ...(recentSymbols.length ? recentSymbols : ['€', '£', '¥', '©', '®', '™', '±', '≠', '≤', '≥', '÷', '×', '∞', 'µ', 'α', 'β', 'π', 'Ω', '∑', '°']).map((c) => ({ id: 'insert.symbol', arg: c, label: c })),
    { separator: true }, { id: 'insert.symbol', label: 'More Symbols…' }, { id: 'insert.specialCharacters', label: 'Special Characters…' }, { id: 'insert.emoji', label: 'Emoji…' },
  ],
});
def({
  id: 'insert.specialCharacters', label: 'Special Characters…', icon: 'keyboard', tab: 'Insert', group: 'Symbols', edits: true,
  run: async (app) => {
    const r = await openDialog({ title: 'Special Characters', fields: [{ key: 'c', label: 'Character', type: 'list', rows: 14, options: SPECIAL_CHARS.map(([ch, n, k]) => ({ value: ch, label: `${/\s|[​-‍]/.test(ch) ? '␣' : ch}   ${n}${k ? '   (' + k.replace('Mod', 'Ctrl') + ')' : ''}` })), value: '—' }], ok: 'Insert' });
    if (r?.c) v(app).dispatch(app.state.tr.insertText(r.c));
  },
});
const EMOJI = '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬👍👎👏🙌👐🤲🤝🙏✍️💪👀👋✋🤚🖐️🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝✨⭐🌟💫🔥💯✅❌⚠️❓❗💡📌📎📝📚📖🔖🏷️📅📆⏰⌛📈📉📊💼🗂️📁📂🗃️🖊️🖋️✒️🖌️🖍️🎉🎊🎁🎈🏆🥇🥈🥉⚽🏀🏈⚾🎾🎵🎶🎤🎧🎬📷📸💻🖥️📱☎️📞📧✉️📨🏠🏢🏫🏥⛪🕌🕍🌍🌎🌏🌱🌲🌳🌴🌵🌷🌹🌻🌼🍀🍁🍂🍃☀️🌤️⛅🌧️⛈️🌩️❄️☃️🌈☔🍎🍊🍋🍌🍉🍇🍓🍒🍑🥭🍍🥥🥝🍅🥑🥦🥕🌽🍞🧀🍕🍔🍟🌭🍿☕🍵🍷🍺🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🦅🦉🐴🦄🐝🦋🐢🐍🐙🐠🐬🐳🚗🚕🚌🚑🚒🚓✈️🚀🚢⚓🛠️⚙️🔧🔨🔑🔒🔓🛡️⚖️🧪🔬🔭💊🩺';
def({
  id: 'insert.emoji', label: 'Emoji', icon: 'mood', tab: 'Insert', group: 'Symbols', edits: true, keys: ['Mod-.'],
  run: (app) => {
    const list = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(EMOJI)].map((s) => s.segment);
    showMenu(list.map((e) => ({ id: 'insert.symbol', arg: e, label: e })), { onPick: (e) => app.exec('insert.symbol', e.arg), anchor: app.ui.anchorFor('insert.symbol'), grid: true, className: 'qf-emoji-menu' });
  },
});

// Equations ------------------------------------------------------------------------------------
const EQUATIONS: [string, string][] = [
  ['Quadratic formula', 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}'], ['Pythagorean theorem', 'a^2+b^2=c^2'], ['Binomial theorem', '(x+a)^n=\\sum_{k=0}^{n}\\binom{n}{k}x^k a^{n-k}'],
  ['Area of circle', 'A=\\pi r^2'], ['Fourier series', 'f(x)=a_0+\\sum_{n=1}^{\\infty}\\left(a_n\\cos\\frac{n\\pi x}{L}+b_n\\sin\\frac{n\\pi x}{L}\\right)'],
  ['Taylor expansion', 'e^x=1+\\frac{x}{1!}+\\frac{x^2}{2!}+\\frac{x^3}{3!}+\\cdots'], ['Euler identity', 'e^{i\\pi}+1=0'], ['Integral', '\\int_a^b f(x)\\,dx=F(b)-F(a)'],
  ['Matrix', '\\begin{pmatrix}a & b\\\\ c & d\\end{pmatrix}'], ['Compound interest', 'A=P\\left(1+\\frac{r}{n}\\right)^{nt}'], ['Standard deviation', '\\sigma=\\sqrt{\\frac{1}{N}\\sum_{i=1}^{N}(x_i-\\mu)^2}'],
];
async function equationDialog(app: App, latex: string, display: boolean, editPos?: number) {
  const pin = editPos != null ? pinNode(app.state.doc, editPos) : undefined;
  const pos = editPos;
  const r = await openDialog({
    title: pos != null ? 'Edit Equation' : 'Insert Equation', wide: true, preview: true, ok: pos != null ? 'Update' : 'Insert',
    fields: [
      { key: 'tpl', label: 'Built-in equations', type: 'select', options: [{ value: '', label: '(choose to insert)' }, ...EQUATIONS.map(([n, l]) => ({ value: l, label: n }))], value: '' },
      { key: 'latex', label: 'Equation (LaTeX syntax: \\frac{a}{b}, x^2, \\sqrt{x}, \\sum, \\alpha…)', type: 'textarea', rows: 4, value: latex },
      { key: 'display', label: 'Display (own line, centered)', type: 'checkbox', value: display },
    ],
    onChange: (x, ctl, key) => { if (key === 'tpl' && x.tpl) ctl.set('latex', x.tpl); ctl.setPreview(renderLatex(ctl.get('latex'), ctl.get('display'))); },
  });
  if (!r || !r.latex) return;
  const view = v(app);
  // The equation being edited, where it is now; if it is gone, a new one is inserted.
  const at = pin ? findPinned(view.state.doc, pin) : -1;
  if (at >= 0) {
    const pos = at, node = view.state.doc.nodeAt(pos);
    if (node && (node.type === N.math_inline || node.type === N.math_block)) {
      if ((node.type === N.math_block) === !!r.display) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: r.latex }));
      else view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, r.display ? N.math_block.create({ latex: r.latex }) : N.math_inline.create({ latex: r.latex })));
      return;
    }
  }
  if (r.display) insertBlock(view, N.math_block.create({ latex: r.latex }));
  else insertInline(view, N.math_inline.create({ latex: r.latex }));
}
def([
  {
    id: 'insert.equation', label: 'Equation', icon: 'function', tab: 'Insert', group: 'Symbols', kind: 'split', keys: ['Alt-='], edits: true, popular: true,
    run: (app, arg) => (typeof arg === 'string' ? insertBlock(v(app), N.math_block.create({ latex: arg })) : equationDialog(app, selectedText(app.state), true)),
    menu: () => [...EQUATIONS.map(([n, l]) => ({ id: 'insert.equation', arg: l, label: n })), { separator: true }, { id: 'insert.equation', label: 'Insert New Equation…' }, { id: 'insert.equationInline', label: 'Inline Equation…' }],
  },
  { id: 'insert.equationInline', label: 'Inline Equation', icon: 'functions', tab: 'Insert', group: 'Symbols', edits: true, run: (app) => equationDialog(app, selectedText(app.state), false) },
  {
    id: 'insert.equationEdit', label: 'Edit Equation', icon: 'edit', tab: 'Insert', group: 'Symbols', internal: true, edits: true,
    run: (app, arg) => {
      const pos = arg?.pos ?? app.state.selection.from;
      const node = app.state.doc.nodeAt(pos);
      if (!node) return;
      equationDialog(app, node.attrs.latex, node.type === N.math_block, pos);
    },
  },
]);

// Misc blocks -----------------------------------------------------------------------------------
def([
  {
    id: 'insert.hr', label: 'Horizontal Line', icon: 'horizontal_rule', tab: 'Insert', group: 'Text', kind: 'split', edits: true,
    run: (app, arg) => insertBlock(v(app), N.horizontal_rule.create(arg ? { style: arg, weight: arg === 'double' ? 3 : 1 } : {})),
    menu: () => ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge'].map((s) => ({ id: 'insert.hr', arg: s, label: s[0].toUpperCase() + s.slice(1) })),
  },
  { id: 'insert.codeBlock', label: 'Code Block', icon: 'code_blocks', tab: 'Insert', group: 'Text', edits: true, origin: 'Developer documentation tools', run: (app) => { const t = selectedText(app.state); insertBlock(v(app), N.code_block.create(null, t ? schema.text(t) : null)); } },
  {
    id: 'insert.checkbox', label: 'Check Box', icon: 'check_box', tab: 'Insert', group: 'Text', edits: true,
    run: (app) => insertInline(v(app), N.control.create({ kind: 'checkbox', value: 'false' })),
  },
  {
    id: 'insert.chip', label: 'Smart Chip', icon: 'alternate_email', tab: 'Insert', group: 'Text', kind: 'menu', edits: true, origin: 'Online document editors',
    run: async (app, arg) => {
      const kind = arg || 'person';
      const label = await promptDialog('Smart Chip', kind === 'person' ? 'Person name or email:' : kind === 'date' ? 'Date (YYYY-MM-DD):' : kind === 'place' ? 'Place:' : kind === 'file' ? 'File name or link:' : 'Label:', kind === 'date' ? new Date().toISOString().slice(0, 10) : '', kind === 'date' ? { type: 'date' } : {});
      if (!label) return;
      insertInline(v(app), N.chip.create({ kind, label: kind === 'person' ? '@' + label : label, value: label }));
    },
    menu: () => [{ id: 'insert.chip', arg: 'person', label: 'People' }, { id: 'insert.chip', arg: 'date', label: 'Date' }, { id: 'insert.chip', arg: 'place', label: 'Place' }, { id: 'insert.chip', arg: 'file', label: 'File' }, { id: 'insert.chip', arg: 'status', label: 'Status' }],
  },
  {
    id: 'insert.snippets', label: 'Building Blocks (Snippets)', icon: 'widgets', tab: 'Insert', group: 'Text', kind: 'menu', edits: true, origin: 'Quick parts / AutoText / QuickWords',
    run: (app, arg) => {
      if (arg == null) return app.ui.togglePane('snippets');
      const sn = app.prefs.snippets.find((s) => s.name === arg);
      if (!sn) return;
      const slice = Slice.fromJSON(schema, sn.json);
      v(app).dispatch(app.state.tr.replaceSelection(slice).scrollIntoView());
    },
    menu: (app) => [
      ...app.prefs.snippets.map((s) => ({ id: 'insert.snippets', arg: s.name, label: `${s.name}  (${s.gallery})` })),
      ...(app.prefs.snippets.length ? [{ separator: true } as const] : []),
      { id: 'insert.saveSnippet', label: 'Save Selection to Gallery…' }, { id: 'insert.snippets', label: 'Building Blocks Organizer…' },
    ],
  },
  {
    id: 'insert.saveSnippet', label: 'Save Selection as Building Block…', icon: 'library_add', tab: 'Insert', group: 'Text',
    run: async (app) => {
      const st = app.state;
      if (st.selection.empty) { toast('Select the content to save first.'); return; }
      const r = await openDialog({ title: 'Create New Building Block', fields: [
        { key: 'name', label: 'Name (type it then press F3 to insert)', type: 'text', value: selectedText(st).slice(0, 24), autofocus: true },
        { key: 'gallery', label: 'Gallery', type: 'select', options: ['Quick Parts', 'AutoText', 'Cover Pages', 'Headers', 'Footers', 'Tables', 'Text Boxes', 'Equations', 'Signatures', 'Boilerplate'], value: 'Quick Parts' },
      ] });
      if (!r?.name) return;
      app.prefs.snippets = [...app.prefs.snippets.filter((s) => s.name !== r.name), { name: r.name, gallery: r.gallery, json: st.selection.content().toJSON(), created: Date.now() }];
      app.savePrefs();
      toast(`Saved "${r.name}"`);
    },
  },
  {
    id: 'insert.expandSnippet', label: 'Expand Building Block (Name → Content)', icon: 'unfold_more', tab: 'Insert', group: 'Text', keys: ['F3'], edits: true,
    run: (app) => {
      const st = app.state; const $h = st.selection.$head;
      const before = $h.parent.textBetween(0, $h.parentOffset, '￼', '￼');
      const sn = [...app.prefs.snippets].sort((a, b) => b.name.length - a.name.length).find((s) => before.toLowerCase().endsWith(s.name.toLowerCase()));
      if (!sn) { app.exec('edit.findNext'); return; }
      const tr = st.tr.delete($h.pos - sn.name.length, $h.pos);
      tr.replaceSelection(Slice.fromJSON(schema, sn.json));
      v(app).dispatch(tr.scrollIntoView());
    },
  },
  {
    id: 'insert.comment', label: 'New Comment', icon: 'add_comment', tab: 'Review', group: 'Comments', internal: true,
    run: (app) => app.exec('review.newComment'),
  },
  {
    id: 'insert.object', label: 'Object (Embed File)…', icon: 'attach_file', tab: 'Insert', group: 'Text', edits: true,
    run: async (app) => {
      const files = await pickFile('*/*');
      if (!files.length) return;
      const f = files[0];
      if (f.type.startsWith('image/')) return insertImageSrc(app, await readFileAsDataURL(f));
      const url = await readFileAsDataURL(f);
      const view = v(app);
      view.dispatch(view.state.tr.replaceSelectionWith(schema.text(`📎 ${f.name}`, [M.link.create({ href: url, title: `Embedded file (${Math.round(f.size / 1024)} KB)` })]), false));
    },
  },
]);
void TextSelection;
void setMark;
