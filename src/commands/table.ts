/** Table Design / Table Layout contextual commands. */
import { def } from './registry';
import { trackPositions, type App } from '../app';
import { TextSelection, type EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import {
  addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, deleteRow, deleteColumn, deleteTable, mergeCells, splitCell,
  toggleHeaderRow, toggleHeaderColumn, toggleHeaderCell, setCellAttr, selectedRect, CellSelection, TableMap, isInTable,
} from 'prosemirror-tables';
import { schema } from '../editor/schema';
import { topLevelRange, selectedText } from '../editor/ops';
import { evalFormula, formatNumberPicture } from '../editor/fields';
import { openDialog, toast, colorMenu } from '../ui/dialog';
import { createTable } from './insert';
import { borderPrefs } from './format';

const N = schema.nodes;
const v = (app: App) => app.view;
const inTable = (app: App) => isInTable(app.state);
const pm = (cmd: (s: EditorState, d?: any) => boolean) => (app: App) => cmd(app.state, app.view.dispatch);

export function tableInfo(state: EditorState): { node: PMNode; pos: number } | null {
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--) if ($f.node(d).type === N.table) return { node: $f.node(d), pos: $f.before(d) };
  return null;
}

function setTableAttrs(app: App, patch: Record<string, any>) {
  const t = tableInfo(app.state);
  if (!t) return;
  v(app).dispatch(app.state.tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, ...patch }));
}

function forEachSelectedCell(state: EditorState, fn: (cell: PMNode, pos: number, row: number, col: number, rect: { top: number; bottom: number; left: number; right: number }) => void) {
  const rect = selectedRect(state);
  const seen = new Set<number>();
  for (let r = rect.top; r < rect.bottom; r++) for (let c = rect.left; c < rect.right; c++) {
    const rel = rect.map.map[r * rect.map.width + c];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const pos = rect.tableStart + rel;
    fn(state.doc.nodeAt(pos)!, pos, r, c, rect);
  }
}

function setCells(app: App, attrsFn: (cell: PMNode, r: number, c: number, rect: any) => Record<string, any>) {
  const st = app.state;
  const tr = st.tr;
  forEachSelectedCell(st, (cell, pos, r, c, rect) => tr.setNodeMarkup(pos, undefined, { ...cell.attrs, ...attrsFn(cell, r, c, rect) }));
  v(app).dispatch(tr);
}

const ok = { isEnabled: (app: App) => inTable(app) };

def([
  { id: 'table.insertRowAbove', label: 'Insert Row Above', icon: 'add_row_above', tab: 'Table', group: 'Rows & Columns', edits: true, run: pm(addRowBefore), ...ok },
  { id: 'table.insertRowBelow', label: 'Insert Row Below', icon: 'add_row_below', tab: 'Table', group: 'Rows & Columns', edits: true, popular: true, run: pm(addRowAfter), ...ok },
  { id: 'table.insertColLeft', label: 'Insert Column Left', icon: 'add_column_left', tab: 'Table', group: 'Rows & Columns', edits: true, run: pm(addColumnBefore), ...ok },
  { id: 'table.insertColRight', label: 'Insert Column Right', icon: 'add_column_right', tab: 'Table', group: 'Rows & Columns', edits: true, run: pm(addColumnAfter), ...ok },
  { id: 'table.deleteRow', label: 'Delete Rows', icon: 'delete', tab: 'Table', group: 'Rows & Columns', edits: true, run: pm(deleteRow), ...ok },
  { id: 'table.deleteCol', label: 'Delete Columns', icon: 'delete', tab: 'Table', group: 'Rows & Columns', edits: true, run: pm(deleteColumn), ...ok },
  { id: 'table.delete', label: 'Delete Table', icon: 'delete_forever', tab: 'Table', group: 'Rows & Columns', edits: true, run: pm(deleteTable), ...ok },
  {
    id: 'table.deleteMenu', label: 'Delete', icon: 'delete', tab: 'Table', group: 'Rows & Columns', kind: 'menu', edits: true, ...ok,
    run: (app, arg) => app.exec(arg || 'table.deleteRow'),
    menu: () => [{ id: 'table.deleteMenu', arg: 'table.deleteCell', label: 'Delete Cells (clear)' }, { id: 'table.deleteMenu', arg: 'table.deleteCol', label: 'Delete Columns' }, { id: 'table.deleteMenu', arg: 'table.deleteRow', label: 'Delete Rows' }, { id: 'table.deleteMenu', arg: 'table.delete', label: 'Delete Table' }],
  },
  {
    id: 'table.deleteCell', label: 'Clear Cell Contents', icon: 'backspace', tab: 'Table', group: 'Rows & Columns', edits: true, ...ok,
    run: (app) => { const st = app.state; const tr = st.tr; const cells: { pos: number; node: PMNode }[] = []; forEachSelectedCell(st, (cell, pos) => cells.push({ pos, node: cell })); for (const c of cells.reverse()) tr.replaceWith(c.pos + 1, c.pos + c.node.nodeSize - 1, N.paragraph.create()); v(app).dispatch(tr); },
  },
  { id: 'table.merge', label: 'Merge Cells', icon: 'cell_merge', tab: 'Table', group: 'Merge', edits: true, popular: true, run: pm(mergeCells), ...ok },
  {
    id: 'table.split', label: 'Split Cells…', icon: 'splitscreen_right', tab: 'Table', group: 'Merge', edits: true, ...ok,
    run: async (app) => {
      if (splitCell(app.state, app.view.dispatch)) return;
      const r = await openDialog({ title: 'Split Cells', fields: [{ key: 'cols', label: 'Number of columns', type: 'number', value: 2, min: 1, half: true }, { key: 'rows', label: 'Number of rows', type: 'number', value: 1, min: 1, half: true }] });
      if (!r) return;
      for (let i = 1; i < r.cols; i++) addColumnAfter(app.state, app.view.dispatch);
      for (let i = 1; i < r.rows; i++) addRowAfter(app.state, app.view.dispatch);
    },
  },
  {
    id: 'table.splitTable', label: 'Split Table', icon: 'vertical_split', tab: 'Table', group: 'Merge', edits: true, ...ok,
    run: (app) => {
      const t = tableInfo(app.state)!;
      const rect = selectedRect(app.state);
      if (rect.top === 0) { toast('Place the cursor in the row that should start the new table.'); return; }
      const rows: PMNode[] = []; t.node.forEach((r) => rows.push(r));
      const a = N.table.create(t.node.attrs, rows.slice(0, rect.top)), b = N.table.create({ ...t.node.attrs, headerRows: 0 }, rows.slice(rect.top));
      v(app).dispatch(app.state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, [a, N.paragraph.create(), b]));
    },
  },
  { id: 'table.toggleHeaderRow', label: 'Header Row', icon: 'table_rows', tab: 'Table', group: 'Table Style Options', kind: 'toggle', edits: true, ...ok, run: (app) => { toggleHeaderRow(app.state, app.view.dispatch); const t = tableInfo(app.state); if (t) setTableAttrs(app, { headerRows: t.node.firstChild?.firstChild?.type === N.table_header ? 1 : 0 }); }, isActive: (app) => !!tableInfo(app.state)?.node.firstChild?.firstChild && tableInfo(app.state)!.node.firstChild!.firstChild!.type === N.table_header },
  { id: 'table.toggleHeaderCol', label: 'First Column', icon: 'view_column', tab: 'Table', group: 'Table Style Options', kind: 'toggle', edits: true, ...ok, run: (app) => { toggleHeaderColumn(app.state, app.view.dispatch); setTableAttrs(app, { firstCol: !tableInfo(app.state)?.node.attrs.firstCol }); }, isActive: (app) => !!tableInfo(app.state)?.node.attrs.firstCol },
  { id: 'table.toggleHeaderCell', label: 'Toggle Header Cell', icon: 'crop_square', tab: 'Table', group: 'Table Style Options', edits: true, ...ok, run: pm(toggleHeaderCell) },
  { id: 'table.bandedRows', label: 'Banded Rows', icon: 'view_stream', tab: 'Table', group: 'Table Style Options', kind: 'toggle', edits: true, ...ok, run: (app) => setTableAttrs(app, { banded: !tableInfo(app.state)?.node.attrs.banded }), isActive: (app) => !!tableInfo(app.state)?.node.attrs.banded },
  { id: 'table.bandedCols', label: 'Banded Columns', icon: 'view_week', tab: 'Table', group: 'Table Style Options', kind: 'toggle', edits: true, ...ok, run: (app) => setTableAttrs(app, { bandedCols: !tableInfo(app.state)?.node.attrs.bandedCols }), isActive: (app) => !!tableInfo(app.state)?.node.attrs.bandedCols },
  { id: 'table.totalRow', label: 'Total Row', icon: 'functions', tab: 'Table', group: 'Table Style Options', kind: 'toggle', edits: true, ...ok, run: (app) => setTableAttrs(app, { lastRow: !tableInfo(app.state)?.node.attrs.lastRow }), isActive: (app) => !!tableInfo(app.state)?.node.attrs.lastRow },
  { id: 'table.lastCol', label: 'Last Column', icon: 'view_column', tab: 'Table', group: 'Table Style Options', kind: 'toggle', edits: true, ...ok, run: (app) => setTableAttrs(app, { lastCol: !tableInfo(app.state)?.node.attrs.lastCol }), isActive: (app) => !!tableInfo(app.state)?.node.attrs.lastCol },
  {
    id: 'table.style', label: 'Table Styles', icon: 'table_chart', tab: 'Table', group: 'Table Styles', kind: 'gallery', edits: true, popular: true, ...ok,
    run: (app, arg) => setTableAttrs(app, { style: arg || 'Table Grid', headerRows: arg && /Accent|Banded|Ledger|List/.test(arg) ? 1 : tableInfo(app.state)?.node.attrs.headerRows }),
    menu: (app) => ['Table Grid', 'Plain Table', 'Plain Table Lines', 'Grid Table Light', 'Grid Table Accent', 'List Table', 'List Table Accent', 'Banded Rows', 'Ledger', 'Financial'].map((s) => ({ id: 'table.style', arg: s, label: s, checked: tableInfo(app.state)?.node.attrs.style === s })),
  },
  {
    id: 'table.shading', label: 'Cell Shading', icon: 'format_color_fill', tab: 'Table', group: 'Table Styles', kind: 'color', edits: true, ...ok,
    run: async (app, arg) => {
      const c = typeof arg === 'string' && arg !== 'menu' ? arg : await colorMenu(app.ui.anchorFor('table.shading'), { none: 'No Color' });
      if (c === undefined) return;
      setCellAttr('background', c)(app.state, app.view.dispatch);
    },
  },
  {
    id: 'table.borders', label: 'Cell Borders', icon: 'border_all', tab: 'Table', group: 'Borders', kind: 'split', edits: true, ...ok,
    run: (app, arg) => {
      const kind = arg || 'all';
      const line = `${borderPrefs.width}pt ${borderPrefs.style} ${borderPrefs.color}`;
      setCells(app, (cell, r, c, rect) => {
        let b: Record<string, string> = {};
        try { b = cell.attrs.borders ? JSON.parse(cell.attrs.borders) : {}; } catch { /* */ }
        const top = r === rect.top, bottom = r === rect.bottom - 1, left = c === rect.left, right = c === rect.right - 1;
        const none = '0 none transparent';
        switch (kind) {
          case 'none': b = { top: none, right: none, bottom: none, left: none }; break;
          case 'all': b = { top: line, right: line, bottom: line, left: line }; break;
          case 'outside': if (top) b.top = line; if (bottom) b.bottom = line; if (left) b.left = line; if (right) b.right = line; break;
          case 'inside': if (!top) b.top = line; if (!left) b.left = line; break;
          case 'insideH': if (!top) b.top = line; break;
          case 'insideV': if (!left) b.left = line; break;
          case 'top': if (top) b.top = line; break;
          case 'bottom': if (bottom) b.bottom = line; break;
          case 'left': if (left) b.left = line; break;
          case 'right': if (right) b.right = line; break;
          case 'diagDown': b.diag = 'down'; break;
          case 'clear': b = {}; break;
        }
        return { borders: Object.keys(b).length ? JSON.stringify(b) : null };
      });
    },
    menu: () => [['all', 'All Borders', 'border_all'], ['outside', 'Outside Borders', 'border_outer'], ['inside', 'Inside Borders', 'border_inner'], ['insideH', 'Inside Horizontal', 'border_horizontal'], ['insideV', 'Inside Vertical', 'border_vertical'], ['top', 'Top Border', 'border_top'], ['bottom', 'Bottom Border', 'border_bottom'], ['left', 'Left Border', 'border_left'], ['right', 'Right Border', 'border_right'], ['none', 'No Border', 'border_clear'], ['clear', 'Reset to Table Style', 'restart_alt']].map(([a, l, ic]) => ({ id: 'table.borders', arg: a, label: l, icon: ic })).concat([{ id: 'para.borderStyle', arg: undefined as any, label: 'Border Style…', icon: 'line_style' }]),
  },
  {
    id: 'table.align', label: 'Cell Alignment', icon: 'vertical_align_center', tab: 'Table', group: 'Alignment', kind: 'menu', edits: true, ...ok,
    run: (app, arg: string) => {
      const [va, ha] = (arg || 'top-left').split('-');
      setCellAttr('valign', va === 'middle' ? 'middle' : va)(app.state, app.view.dispatch);
      const st = app.state; const tr = st.tr;
      forEachSelectedCell(st, (cell, pos) => cell.descendants((n, p) => { if (n.type === N.paragraph) tr.setNodeMarkup(pos + 1 + p, undefined, { ...n.attrs, align: ha === 'left' ? null : ha }); return false; }));
      v(app).dispatch(tr);
    },
    menu: () => ['top', 'middle', 'bottom'].flatMap((va) => ['left', 'center', 'right'].map((ha) => ({ id: 'table.align', arg: `${va}-${ha}`, label: `${va[0].toUpperCase() + va.slice(1)} ${ha[0].toUpperCase() + ha.slice(1)}` }))),
  },
  { id: 'table.valignTop', label: 'Align Top', icon: 'vertical_align_top', tab: 'Table', group: 'Alignment', edits: true, ...ok, run: (app) => setCellAttr('valign', 'top')(app.state, app.view.dispatch) },
  { id: 'table.valignMiddle', label: 'Align Center Vertically', icon: 'vertical_align_center', tab: 'Table', group: 'Alignment', edits: true, ...ok, run: (app) => setCellAttr('valign', 'middle')(app.state, app.view.dispatch) },
  { id: 'table.valignBottom', label: 'Align Bottom', icon: 'vertical_align_bottom', tab: 'Table', group: 'Alignment', edits: true, ...ok, run: (app) => setCellAttr('valign', 'bottom')(app.state, app.view.dispatch) },
  { id: 'table.textDirection', label: 'Text Direction', icon: 'text_rotate_vertical', tab: 'Table', group: 'Alignment', edits: true, ...ok, run: (app) => setCells(app, (c) => ({ textDir: c.attrs.textDir === 'vertical-rl' ? null : c.attrs.textDir === 'vertical-lr' ? 'vertical-rl' : 'vertical-lr' })) },
  {
    id: 'table.cellMargins', label: 'Cell Margins…', icon: 'padding', tab: 'Table', group: 'Alignment', edits: true, ...ok,
    run: async (app) => { const r = await openDialog({ title: 'Cell Margins', fields: [{ key: 'p', label: 'Padding (pt)', type: 'number', value: tableInfo(app.state)?.node.attrs.cellPadding ?? 5 }] }); if (r) setTableAttrs(app, { cellPadding: r.p }); },
  },
  { id: 'table.distributeCols', label: 'Distribute Columns', icon: 'view_week', tab: 'Table', group: 'Cell Size', edits: true, ...ok, run: (app) => { const t = tableInfo(app.state)!; const tr = app.state.tr; t.node.descendants((n, p) => { if (n.type === N.table_cell || n.type === N.table_header) tr.setNodeMarkup(t.pos + 1 + p, undefined, { ...n.attrs, colwidth: null }); return n.type === N.table_row || n.type === N.table; }); tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, layout: 'fixed', width: '100%' }); v(app).dispatch(tr); } },
  { id: 'table.distributeRows', label: 'Distribute Rows', icon: 'view_agenda', tab: 'Table', group: 'Cell Size', edits: true, ...ok, run: (app) => { app.tab.styleEl.textContent += ''; toast('Rows sized to content; set equal heights with Table Properties.'); } },
  {
    id: 'table.autofit', label: 'AutoFit', icon: 'fit_width', tab: 'Table', group: 'Cell Size', kind: 'menu', edits: true, ...ok,
    run: (app, arg) => {
      const t = tableInfo(app.state)!;
      const tr = app.state.tr;
      if (arg === 'contents' || arg === 'window') t.node.descendants((n, p) => { if (n.type === N.table_cell || n.type === N.table_header) tr.setNodeMarkup(t.pos + 1 + p, undefined, { ...n.attrs, colwidth: null }); return n.type !== N.paragraph; });
      tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, width: arg === 'window' ? '100%' : arg === 'contents' ? null : t.node.attrs.width, layout: arg === 'fixed' ? 'fixed' : 'auto' });
      v(app).dispatch(tr);
    },
    menu: () => [{ id: 'table.autofit', arg: 'contents', label: 'AutoFit Contents' }, { id: 'table.autofit', arg: 'window', label: 'AutoFit Window' }, { id: 'table.autofit', arg: 'fixed', label: 'Fixed Column Width' }],
  },
  { id: 'table.repeatHeader', label: 'Repeat Header Rows', icon: 'table_rows', tab: 'Table', group: 'Data', kind: 'toggle', edits: true, ...ok, run: (app) => setTableAttrs(app, { headerRows: tableInfo(app.state)?.node.attrs.headerRows ? 0 : 1 }), isActive: (app) => !!tableInfo(app.state)?.node.attrs.headerRows },
  {
    id: 'table.sort', label: 'Sort Table…', icon: 'sort', tab: 'Table', group: 'Data', edits: true, ...ok,
    run: async (app) => {
      const t = tableInfo(app.state)!;
      const rows: PMNode[] = []; t.node.forEach((r) => rows.push(r));
      const headerCount = rows[0]?.firstChild?.type === N.table_header ? 1 : 0;
      const cols = rows[0].childCount;
      const headers = headerCount ? (() => { const h0: string[] = []; rows[0].forEach((c) => h0.push(c.textContent)); return h0; })() : Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
      const r = await openDialog({ title: 'Sort', fields: [
        { key: 'col', label: 'Sort by', type: 'select', options: headers.map((h0, i) => ({ value: String(i), label: h0 || `Column ${i + 1}` })), value: '0', half: true },
        { key: 'type', label: 'Type', type: 'select', options: ['Text', 'Number', 'Date'], value: 'Text', half: true },
        { key: 'dir', label: 'Order', type: 'radio', options: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], value: 'asc' },
        { key: 'col2', label: 'Then by', type: 'select', options: [{ value: '', label: '(none)' }, ...headers.map((h0, i) => ({ value: String(i), label: h0 || `Column ${i + 1}` }))], value: '' },
        { key: 'header', label: 'My table has a header row', type: 'checkbox', value: !!headerCount },
      ] });
      if (!r) return;
      const keep = r.header ? rows.slice(0, 1) : [];
      const body = r.header ? rows.slice(1) : rows.slice();
      const val = (row: PMNode, c: number) => (c < row.childCount ? row.child(c).textContent.trim() : '');
      const cmp = (a: string, b: string) => r.type === 'Number' ? (parseFloat(a.replace(/[^\d.-]/g, '')) || 0) - (parseFloat(b.replace(/[^\d.-]/g, '')) || 0) : r.type === 'Date' ? Date.parse(a) - Date.parse(b) : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      body.sort((a, b) => {
        let d = cmp(val(a, +r.col), val(b, +r.col));
        if (!d && r.col2 !== '') d = cmp(val(a, +r.col2), val(b, +r.col2));
        return r.dir === 'desc' ? -d : d;
      });
      v(app).dispatch(app.state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, N.table.create(t.node.attrs, [...keep, ...body])));
    },
  },
  {
    id: 'table.formula', label: 'Formula…', icon: 'functions', tab: 'Table', group: 'Data', edits: true, ...ok,
    run: async (app) => {
      const st = app.state;
      const rect = selectedRect(st);
      const t = tableInfo(st)!;
      const map = TableMap.get(t.node);
      const cellText = (r: number, c: number) => { if (r < 0 || c < 0 || r >= map.height || c >= map.width) return ''; return t.node.nodeAt(map.map[r * map.width + c])!.textContent; };
      const nums = (list: string[]) => list.map((x) => parseFloat(x.replace(/[^\d.-]/g, ''))).filter((x) => Number.isFinite(x));
      const r0 = rect.top, c0 = rect.left;
      const above = nums(Array.from({ length: r0 }, (_, r) => cellText(r, c0)));
      const left = nums(Array.from({ length: c0 }, (_, c) => cellText(r0, c)));
      const at = { from: st.selection.from, to: st.selection.to };
      const pt = trackPositions(app);
      const res = await openDialog({ title: 'Formula', help: 'Use ABOVE, LEFT, BELOW, RIGHT, or cell refs like A1, B2 (column letter + row number). Functions: SUM, AVERAGE, MIN, MAX, PRODUCT, COUNT, ROUND, ABS.', fields: [
        { key: 'f', label: 'Formula', type: 'text', value: above.length ? '=SUM(ABOVE)' : '=SUM(LEFT)' },
        { key: 'fmt', label: 'Number format', type: 'combo', options: ['0', '0.00', '#,##0', '#,##0.00', '$#,##0.00', '0%'], value: '#,##0.00' },
      ] });
      pt.done();
      if (!res) return;
      if (pt.lost) { toast('The document was replaced while the dialog was open.'); return; }
      const below = nums(Array.from({ length: map.height - r0 - 1 }, (_, i) => cellText(r0 + 1 + i, c0)));
      const right = nums(Array.from({ length: map.width - c0 - 1 }, (_, i) => cellText(r0, c0 + 1 + i)));
      let expr = String(res.f).replace(/^=/, '');
      expr = expr.replace(/\b(ABOVE|LEFT|BELOW|RIGHT)\b/g, (m) => (({ ABOVE: above, LEFT: left, BELOW: below, RIGHT: right } as any)[m] as number[]).join(',') || '0');
      expr = expr.replace(/\b([A-Z])(\d+)\b/g, (_m, col: string, row: string) => String(parseFloat(cellText(+row - 1, col.charCodeAt(0) - 65).replace(/[^\d.-]/g, '')) || 0));
      try {
        const value = formatNumberPicture(evalFormula(expr), res.fmt);
        // Where the selection was when the dialog opened, through any edits made meanwhile.
        const from = pt.map(at.from, -1), to = Math.max(from, pt.map(at.to, 1));
        v(app).dispatch(app.state.tr.replaceWith(from, to, N.field.create({ type: '=', arg: expr, format: res.fmt, value, locked: true })));
      } catch (e: any) { toast('Formula error: ' + e.message); }
    },
  },
  {
    id: 'table.toText', label: 'Convert Table to Text…', icon: 'notes', tab: 'Table', group: 'Data', edits: true, ...ok,
    run: async (app) => {
      const r = await openDialog({ title: 'Convert Table to Text', fields: [{ key: 'sep', label: 'Separate text with', type: 'radio', options: [{ value: '\t', label: 'Tabs' }, { value: ',', label: 'Commas' }, { value: ';', label: 'Semicolons' }, { value: 'para', label: 'Paragraph marks' }], value: '\t' }] });
      if (!r) return;
      const t = tableInfo(app.state)!;
      const paras: PMNode[] = [];
      t.node.forEach((row) => {
        const cells: string[] = []; row.forEach((c) => cells.push(c.textContent));
        if (r.sep === 'para') cells.forEach((c) => paras.push(N.paragraph.create(null, c ? schema.text(c) : null)));
        else { const s = cells.join(r.sep); paras.push(N.paragraph.create(null, s ? schema.text(s) : null)); }
      });
      v(app).dispatch(app.state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, paras));
    },
  },
  {
    id: 'table.fromText', label: 'Convert Text to Table…', icon: 'table_view', tab: 'Insert', group: 'Tables', edits: true,
    run: async (app) => {
      const st = app.state;
      let { from, to } = topLevelRange(st);
      const linesIn = (d: PMNode) => d.textBetween(from, to, '\n', '').split('\n').filter((l) => l.length);
      let lines = linesIn(st.doc);
      if (!lines.length) { toast('Select the paragraphs to convert.'); return; }
      const guess = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : lines[0].includes(';') ? ';' : ' ';
      const pt = trackPositions(app);
      const r = await openDialog({ title: 'Convert Text to Table', fields: [
        { key: 'sep', label: 'Separate text at', type: 'radio', options: [{ value: '\t', label: 'Tabs' }, { value: ',', label: 'Commas' }, { value: ';', label: 'Semicolons' }, { value: ' ', label: 'Spaces (2 or more)' }, { value: '|', label: 'Pipes |' }], value: guess },
        { key: 'header', label: 'First row is a header', type: 'checkbox', value: true },
      ] });
      pt.done();
      if (!r) return;
      if (pt.lost) return;
      // The same paragraphs, through any edits made while the dialog was open.
      if (pt.changed) { from = pt.map(from, 1); to = Math.max(from, pt.map(to, -1)); lines = linesIn(app.state.doc); }
      if (!lines.length) return;
      const split = (l: string) => (r.sep === ' ' ? l.split(/\s{2,}/) : l.split(r.sep)).map((x) => x.trim()).filter((x, i, arr) => !(r.sep === '|' && (i === 0 || i === arr.length - 1) && x === ''));
      const data = lines.filter((l) => !(r.sep === '|' && /^\|?\s*:?-+/.test(l))).map(split);
      const cols = Math.max(...data.map((d) => d.length));
      v(app).dispatch(app.state.tr.replaceWith(from, to, createTable(data.length, cols, { header: r.header, data })));
    },
  },
  { id: 'table.selectTable', label: 'Select Table', icon: 'select_all', tab: 'Table', group: 'Table', ...ok, run: (app) => { const t = tableInfo(app.state)!; const map = TableMap.get(t.node); const start = t.pos + 1; v(app).dispatch(app.state.tr.setSelection(CellSelection.create(app.state.doc, start + map.map[0], start + map.map[map.map.length - 1]))); } },
  { id: 'table.selectRow', label: 'Select Row', icon: 'table_rows', tab: 'Table', group: 'Table', ...ok, run: (app) => { const rect = selectedRect(app.state); const start = rect.tableStart; const m = rect.map; v(app).dispatch(app.state.tr.setSelection(CellSelection.create(app.state.doc, start + m.map[rect.top * m.width], start + m.map[rect.top * m.width + m.width - 1]))); } },
  { id: 'table.selectCol', label: 'Select Column', icon: 'view_column', tab: 'Table', group: 'Table', ...ok, run: (app) => { const rect = selectedRect(app.state); const start = rect.tableStart; const m = rect.map; v(app).dispatch(app.state.tr.setSelection(CellSelection.create(app.state.doc, start + m.map[rect.left], start + m.map[(m.height - 1) * m.width + rect.left]))); } },
  { id: 'table.selectCell', label: 'Select Cell', icon: 'crop_square', tab: 'Table', group: 'Table', ...ok, run: (app) => { const rect = selectedRect(app.state); const p = rect.tableStart + rect.map.map[rect.top * rect.map.width + rect.left]; v(app).dispatch(app.state.tr.setSelection(CellSelection.create(app.state.doc, p))); } },
  { id: 'table.gridlines', label: 'View Gridlines', icon: 'grid_4x4', tab: 'Table', group: 'Table', kind: 'toggle', run: (app) => { app.tab.el.classList.toggle('qf-gridlines'); app.refresh(); }, isActive: (app) => app.tab.el.classList.contains('qf-gridlines') },
  {
    id: 'table.properties', label: 'Table Properties…', icon: 'tune', tab: 'Table', group: 'Table', edits: true, ...ok,
    run: async (app) => {
      const t = tableInfo(app.state)!;
      const a = t.node.attrs;
      const r = await openDialog({ title: 'Table Properties', fields: [
        { key: 'width', label: 'Preferred width (e.g. 100% or 400pt; blank = auto)', type: 'text', value: a.width ? String(a.width) : '' },
        { key: 'align', label: 'Alignment', type: 'select', options: [{ value: '', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }], value: a.align || '', half: true },
        { key: 'indent', label: 'Indent from left (pt)', type: 'number', value: a.indent || 0, half: true },
        { key: 'layout', label: 'Layout', type: 'select', options: ['auto', 'fixed'], value: a.layout, half: true },
        { key: 'pad', label: 'Cell padding (pt)', type: 'number', value: a.cellPadding ?? 5, half: true },
        { key: 'caption', label: 'Alt text / title', type: 'text', value: a.caption || '' },
      ] });
      if (r) setTableAttrs(app, { width: r.width || null, align: r.align || null, indent: r.indent || null, layout: r.layout, cellPadding: r.pad, caption: r.caption || null });
    },
  },
  {
    id: 'table.addRowEnd', label: 'Add Row at End', icon: 'add', tab: 'Table', group: 'Rows & Columns', edits: true, internal: true, ...ok,
    run: (app) => {
      const t = tableInfo(app.state)!;
      const last = t.node.lastChild!;
      const cells: PMNode[] = []; last.forEach((c) => cells.push(c.type.create({ ...c.attrs, rowspan: 1 }, N.paragraph.create())));
      const pos = t.pos + t.node.nodeSize - 1;
      const tr = app.state.tr.insert(pos, N.table_row.create(null, cells));
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3)));
      v(app).dispatch(tr);
    },
  },
]);
void selectedText;
