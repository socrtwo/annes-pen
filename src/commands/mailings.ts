/** Mailings tab: mail merge (letters, envelopes, labels, directories), recipients, preview, finish. */
import { def } from './registry';
import type { App } from '../app';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { insertInline, insertBlock } from '../editor/ops';
import { openDialog, toast, promptDialog } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { createTable } from './insert';
import { normalizeSettings } from '../editor/settings';
import { formatDate } from '../editor/fields';

const N = schema.nodes;
const v = (app: App) => app.view;

export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM (Excel)
  // Detect the delimiter from the header line, ignoring quoted text.
  const head = text.split('\n')[0].replace(/"(?:[^"]|"")*"/g, '');
  const count = (re: RegExp) => (head.match(re) || []).length;
  const delim = count(/\t/g) > count(/,/g) ? '\t' : count(/;/g) > count(/,/g) ? ';' : ',';
  const rows: string[][] = [];
  // after: just past a closing quote, where blanks before the next delimiter are dropped.
  let row: string[] = [], cell = '', q = false, after = false;
  const blank = (c: string) => c === ' ' || (c === '\t' && delim !== '\t');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { q = false; after = true; }
      else cell += c;
    } else if (c === '"' && !after && !cell.trim()) { q = true; cell = ''; } // blanks before an opening quote are not text
    else if (c === delim) { row.push(cell); cell = ''; after = false; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; after = false; }
    else if (after && blank(c)) continue;
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function toCsv(fields: string[], rows: string[][]): string {
  // Quoted when it holds any delimiter parseCsv might choose, a line break, or blanks at either end.
  const q = (s: string) => (/[",;\t\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [fields.map(q).join(','), ...rows.map((r) => r.map((x) => q(x ?? '')).join(','))].join('\n');
}

function data(app: App) { return app.settings.mergeData; }
function setData(app: App, fields: string[], rows: string[][]) {
  app.updateSettings((s) => { s.mergeData = { fields, rows }; if (s.mergePreview != null && s.mergePreview >= rows.length) s.mergePreview = rows.length ? 0 : null; });
}

function record(app: App, i: number): Record<string, string> {
  const d = data(app);
  if (!d) return {};
  return Object.fromEntries(d.fields.map((f, k) => [f, d.rows[i]?.[k] ?? '']));
}

/** Replace merge fields with record values; drops empty lines produced by blank address fields. */
export function mergeInto(doc: PMNode, rec: Record<string, string>, index: number): Fragment {
  const mapNode = (node: PMNode): PMNode[] => {
    if (node.type === N.field) {
      if (node.attrs.type === 'MERGEFIELD' && String(node.attrs.arg).startsWith('IF:')) return [node];
      if (node.attrs.type === 'MERGEFIELD') {
        // Multi-line values (e.g. a quoted CSV address) become manual line breaks.
        const val = String(rec[node.attrs.arg] ?? '');
        return val.split(/\r\n|\r|\n/).flatMap((line, i) => [...(i ? [N.hard_break.create(null, null, node.marks)] : []), ...(line ? [schema.text(line, node.marks)] : [])]);
      }
      if (node.attrs.type === 'MERGEREC') return [schema.text(String(index + 1), node.marks)];
      if (node.attrs.type === 'DATE') return [schema.text(formatDate(new Date(), node.attrs.format || 'M/d/yyyy'), node.marks)];
      return [node];
    }
    if (node.isLeaf) return [node];
    const kids: PMNode[] = [];
    node.forEach((c) => { kids.push(...mapNode(c)); });
    if (node.type === N.paragraph && node.content.size && !kids.length) return []; // suppress blank lines
    // collapse double spaces left by empty fields
    const merged: PMNode[] = [];
    for (const k of kids) {
      const last = merged[merged.length - 1];
      if (last && last.isText && k.isText && last.sameMarkup(k)) merged[merged.length - 1] = schema.text((last.text! + k.text!).replace(/ {2,}/g, ' '), k.marks);
      else merged.push(k);
    }
    // createAndFill keeps containers valid when all their paragraphs were dropped (cell, list item).
    try { return [node.type.createAndFill(node.attrs, merged, node.marks) ?? node]; } catch { return [node]; }
  };
  const out: PMNode[] = [];
  doc.forEach((n) => { out.push(...mapNode(n)); });
  if (!out.length) out.push(N.paragraph.create());
  return Fragment.fromArray(out);
}

async function editRecipients(app: App) {
  const d = data(app) || { fields: ['Title', 'FirstName', 'LastName', 'Company', 'Address1', 'Address2', 'City', 'State', 'PostalCode', 'Country', 'Email'], rows: [] };
  const r = await openDialog({
    title: 'Mail Merge Recipients', wide: true,
    help: 'Edit as CSV: first line is the field names, then one recipient per line. You can paste from a spreadsheet (tab-separated).',
    fields: [
      { key: 'csv', label: `Recipients (${d.rows.length})`, type: 'textarea', rows: 12, value: toCsv(d.fields, d.rows) },
      { key: 'sortBy', label: 'Sort by field (optional)', type: 'select', options: ['', ...d.fields], value: '', half: true },
      { key: 'filter', label: 'Filter: field=value (optional)', type: 'text', value: '', half: true },
      { key: 'dedupe', label: 'Remove duplicate rows', type: 'checkbox', value: false },
    ],
  });
  if (!r) return;
  const rows = parseCsv(r.csv);
  if (!rows.length) { app.updateSettings((s) => { s.mergeData = null; s.mergePreview = null; }); return; }
  const fields = rows[0].map((f) => f.trim().replace(/\s+/g, ''));
  let body = rows.slice(1);
  if (r.filter && r.filter.includes('=')) { const [f, val] = r.filter.split('='); const i = fields.indexOf(f.trim()); if (i >= 0) body = body.filter((x) => (x[i] || '').toLowerCase().includes(val.trim().toLowerCase())); }
  if (r.sortBy) { const i = fields.indexOf(r.sortBy); body.sort((a, b) => (a[i] || '').localeCompare(b[i] || '', undefined, { numeric: true })); }
  if (r.dedupe) { const seen = new Set<string>(); body = body.filter((x) => { const k = x.join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; }); }
  setData(app, fields, body);
  toast(`${body.length} recipient(s)`);
}

def([
  {
    id: 'mail.start', label: 'Start Mail Merge', icon: 'forward_to_inbox', tab: 'Mailings', group: 'Start Mail Merge', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => {
      switch (arg) {
        case 'envelopes': return app.exec('mail.envelopes');
        case 'labels': return app.exec('mail.labels');
        case 'directory': toast('Directory: the document repeats for each record without page breaks when finished.'); app.updateSettings((s) => { (s as any).mergeKind = 'directory'; }); return;
        case 'normal': app.updateSettings((s) => { s.mergeData = null; s.mergePreview = null; (s as any).mergeKind = undefined; }); return;
        case 'wizard': return app.ui.openPane('mailmerge');
        default: app.updateSettings((s) => { (s as any).mergeKind = arg || 'letters'; }); toast('Next: Select Recipients, then insert merge fields.');
      }
    },
    menu: () => [{ id: 'mail.start', arg: 'letters', label: 'Letters' }, { id: 'mail.start', arg: 'email', label: 'Email Messages' }, { id: 'mail.start', arg: 'envelopes', label: 'Envelopes…' }, { id: 'mail.start', arg: 'labels', label: 'Labels…' }, { id: 'mail.start', arg: 'directory', label: 'Directory' }, { id: 'mail.start', arg: 'normal', label: 'Normal Document' }, { separator: true }, { id: 'mail.start', arg: 'wizard', label: 'Step-by-Step Mail Merge Wizard' }],
  },
  {
    id: 'mail.selectRecipients', label: 'Select Recipients', icon: 'group_add', tab: 'Mailings', group: 'Start Mail Merge', kind: 'menu', edits: true, popular: true,
    run: async (app, arg) => {
      if (arg === 'new') return editRecipients(app);
      if (arg === 'table') {
        // Use the first table in the document as the data source
        let tbl: PMNode | null = null;
        app.state.doc.descendants((n) => { if (!tbl && n.type === N.table) tbl = n; return !tbl; });
        if (!tbl) { toast('No table found in this document.'); return; }
        const rows: string[][] = [];
        (tbl as PMNode).forEach((row) => { const r: string[] = []; row.forEach((c) => r.push(c.textContent)); rows.push(r); });
        setData(app, rows[0].map((f) => f.replace(/\s+/g, '')), rows.slice(1));
        toast(`${rows.length - 1} recipient(s) from table`);
        return;
      }
      const files = await pickFile('.csv,.tsv,.txt,text/csv,text/plain');
      if (!files.length) return;
      const rows = parseCsv(await files[0].text());
      if (rows.length < 1) { toast('The file has no rows.'); return; }
      setData(app, rows[0].map((f) => f.trim().replace(/\s+/g, '')), rows.slice(1));
      toast(`${rows.length - 1} recipient(s) loaded from ${files[0].name}`);
    },
    menu: () => [{ id: 'mail.selectRecipients', arg: 'new', label: 'Type a New List…' }, { id: 'mail.selectRecipients', arg: 'file', label: 'Use an Existing List (CSV/TSV)…' }, { id: 'mail.selectRecipients', arg: 'table', label: 'Use First Table in This Document' }],
  },
  { id: 'mail.editRecipients', label: 'Edit Recipient List', icon: 'edit_note', tab: 'Mailings', group: 'Start Mail Merge', edits: true, run: (app) => editRecipients(app) },
  {
    id: 'mail.insertField', label: 'Insert Merge Field', icon: 'data_object', tab: 'Mailings', group: 'Write & Insert Fields', kind: 'menu', edits: true, popular: true,
    run: async (app, arg) => {
      const name = arg || (await promptDialog('Insert Merge Field', 'Field name:', data(app)?.fields[0] || 'FirstName'));
      if (!name) return;
      insertInline(v(app), N.field.create({ type: 'MERGEFIELD', arg: name, value: `«${name}»` }));
      app.updateFields();
    },
    menu: (app) => [...(data(app)?.fields || ['FirstName', 'LastName', 'Address1', 'City', 'State', 'PostalCode']).map((f) => ({ id: 'mail.insertField', arg: f, label: f })), { separator: true }, { id: 'mail.insertField', label: 'Other Field…' }],
  },
  {
    id: 'mail.addressBlock', label: 'Address Block', icon: 'contact_mail', tab: 'Mailings', group: 'Write & Insert Fields', edits: true,
    run: (app) => {
      const fs = data(app)?.fields || [];
      const pick = (...names: string[]) => names.find((n) => fs.some((f) => f.toLowerCase() === n.toLowerCase())) || names[0];
      const F = (name: string) => N.field.create({ type: 'MERGEFIELD', arg: fs.find((f) => f.toLowerCase() === name.toLowerCase()) || name });
      const sp = () => schema.text(' ');
      const lines: PMNode[][] = [
        [F(pick('Title')), sp(), F(pick('FirstName', 'First')), sp(), F(pick('LastName', 'Last'))],
        [F(pick('Company', 'Organization'))],
        [F(pick('Address1', 'Address', 'Street'))],
        [F(pick('Address2'))],
        [F(pick('City')), schema.text(', '), F(pick('State', 'Province', 'Region')), sp(), F(pick('PostalCode', 'Zip', 'ZIP'))],
        [F(pick('Country'))],
      ];
      insertBlock(v(app), lines.map((l) => N.paragraph.create({ spaceAfter: 0 }, l)));
      app.updateFields();
    },
  },
  {
    id: 'mail.greetingLine', label: 'Greeting Line', icon: 'waving_hand', tab: 'Mailings', group: 'Write & Insert Fields', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Greeting Line', fields: [
        { key: 'sal', label: 'Salutation', type: 'combo', options: ['Dear', 'To', 'Hello', 'Hi', 'Greetings'], value: 'Dear', half: true },
        { key: 'name', label: 'Name format', type: 'select', options: [{ value: 'first', label: 'Joshua' }, { value: 'titleLast', label: 'Mr. Randall' }, { value: 'full', label: 'Joshua Randall' }], value: 'titleLast', half: true },
        { key: 'punct', label: 'Punctuation', type: 'select', options: [',', ':', '!', ''], value: ',' },
      ] });
      if (!r) return;
      const F = (n: string) => N.field.create({ type: 'MERGEFIELD', arg: n });
      const parts: PMNode[] = [schema.text(r.sal + ' ')];
      if (r.name === 'first') parts.push(F('FirstName'));
      if (r.name === 'titleLast') parts.push(F('Title'), schema.text(' '), F('LastName'));
      if (r.name === 'full') parts.push(F('FirstName'), schema.text(' '), F('LastName'));
      if (r.punct) parts.push(schema.text(r.punct));
      insertBlock(v(app), N.paragraph.create({ style: 'Salutation' }, parts));
      app.updateFields();
    },
  },
  {
    id: 'mail.rules', label: 'Rules', icon: 'rule', tab: 'Mailings', group: 'Write & Insert Fields', kind: 'menu', edits: true,
    run: async (app, arg) => {
      if (arg === 'fillin') { const p = await promptDialog('Fill-in', 'Prompt:', 'Enter text'); if (p) insertInline(v(app), N.field.create({ type: 'FILLIN', arg: p, value: '' })); return; }
      if (arg === 'mergerec') { insertInline(v(app), N.field.create({ type: 'MERGEREC' })); app.updateFields(); return; }
      if (arg === 'nextRecord') { insertInline(v(app), N.field.create({ type: 'QUOTE', arg: '', value: '«Next Record»' })); return; }
      if (arg === 'if') {
        const r = await openDialog({ title: 'If…Then…Else', fields: [
          { key: 'field', label: 'Field name', type: 'select', options: data(app)?.fields || ['FirstName'], value: data(app)?.fields[0] },
          { key: 'op', label: 'Comparison', type: 'select', options: ['=', '<>', 'is blank', 'is not blank'], value: '=' },
          { key: 'val', label: 'Compare to', type: 'text', value: '' },
          { key: 'then', label: 'Insert this text', type: 'text', value: '' },
          { key: 'else', label: 'Otherwise insert this text', type: 'text', value: '' },
        ] });
        if (!r) return;
        // IF is represented as a formula-free QUOTE with stored rule; evaluated during merge.
        insertInline(v(app), N.field.create({ type: 'MERGEFIELD', arg: `IF:${JSON.stringify(r)}`, value: `«IF ${r.field}»` }));
      }
    },
    menu: () => [{ id: 'mail.rules', arg: 'if', label: 'If…Then…Else…' }, { id: 'mail.rules', arg: 'fillin', label: 'Fill-in…' }, { id: 'mail.rules', arg: 'mergerec', label: 'Merge Record #' }, { id: 'mail.rules', arg: 'nextRecord', label: 'Next Record' }],
  },
  {
    id: 'mail.highlightFields', label: 'Highlight Merge Fields', icon: 'highlight', tab: 'Mailings', group: 'Write & Insert Fields', kind: 'toggle',
    run: (app) => { app.tab.el.classList.toggle('qf-highlight-merge'); app.refresh(); }, isActive: (app) => app.tab.el.classList.contains('qf-highlight-merge'),
  },
  {
    id: 'mail.preview', label: 'Preview Results', icon: 'preview', tab: 'Mailings', group: 'Preview Results', kind: 'toggle', popular: true,
    run: (app) => {
      const d = data(app);
      if (!d || !d.rows.length) { toast('Select recipients first.'); return; }
      app.updateSettings((s) => { s.mergePreview = s.mergePreview == null ? 0 : null; });
      app.updateFields();
    },
    isActive: (app) => app.settings.mergePreview != null,
  },
  { id: 'mail.first', label: 'First Record', icon: 'first_page', tab: 'Mailings', group: 'Preview Results', noRecord: true, run: (app) => gotoRec(app, () => 0) },
  { id: 'mail.prev', label: 'Previous Record', icon: 'navigate_before', tab: 'Mailings', group: 'Preview Results', noRecord: true, run: (app) => gotoRec(app, (i) => i - 1) },
  { id: 'mail.next', label: 'Next Record', icon: 'navigate_next', tab: 'Mailings', group: 'Preview Results', noRecord: true, run: (app) => gotoRec(app, (i) => i + 1) },
  { id: 'mail.last', label: 'Last Record', icon: 'last_page', tab: 'Mailings', group: 'Preview Results', noRecord: true, run: (app) => gotoRec(app, (_i, n) => n - 1) },
  {
    id: 'mail.findRecipient', label: 'Find Recipient', icon: 'person_search', tab: 'Mailings', group: 'Preview Results',
    run: async (app) => {
      const q = await promptDialog('Find Entry', 'Find:', '');
      if (!q) return;
      const d = data(app);
      const i = d?.rows.findIndex((r) => r.some((c) => c.toLowerCase().includes(q.toLowerCase()))) ?? -1;
      if (i < 0) toast('Not found.'); else gotoRec(app, () => i);
    },
  },
  {
    id: 'mail.checkErrors', label: 'Check for Errors', icon: 'fact_check', tab: 'Mailings', group: 'Preview Results',
    run: (app) => {
      const d = data(app);
      const used = new Set<string>();
      app.state.doc.descendants((n) => { if (n.type === N.field && n.attrs.type === 'MERGEFIELD' && !String(n.attrs.arg).startsWith('IF:')) used.add(n.attrs.arg); return true; });
      if (!d) { toast('No data source.'); return; }
      const missing = [...used].filter((f) => !d.fields.includes(f));
      const empty = d.rows.map((r, i) => ({ i, blanks: [...used].filter((f) => !(r[d.fields.indexOf(f)] || '').trim()) })).filter((x) => x.blanks.length);
      import('../ui/dialog').then(({ alertDialog }) => alertDialog('Check for Errors', [
        missing.length ? `Fields not in the data source: ${missing.join(', ')}` : 'All merge fields exist in the data source.',
        empty.length ? `${empty.length} record(s) have blank values for used fields (e.g. record ${empty[0].i + 1}: ${empty[0].blanks.join(', ')}).` : 'No blank values in used fields.',
      ].join('\n')));
    },
  },
  {
    id: 'mail.finish', label: 'Finish & Merge', icon: 'done_all', tab: 'Mailings', group: 'Finish', kind: 'menu', popular: true,
    run: async (app, arg) => {
      const d = data(app);
      if (!d || !d.rows.length) { toast('Select recipients first.'); return; }
      const r = await openDialog({ title: 'Merge Records', fields: [{ key: 'range', label: 'Merge records', type: 'radio', options: [{ value: 'all', label: 'All' }, { value: 'current', label: 'Current record' }, { value: 'range', label: 'From…To' }], value: 'all' }, { key: 'from', label: 'From', type: 'number', value: 1, half: true, visibleIf: (x) => x.range === 'range' }, { key: 'to', label: 'To', type: 'number', value: d.rows.length, half: true, visibleIf: (x) => x.range === 'range' }] });
      if (!r) return;
      let idx = d.rows.map((_, i) => i);
      if (r.range === 'current') idx = [app.settings.mergePreview ?? 0];
      if (r.range === 'range') idx = idx.slice(Math.max(0, r.from - 1), Math.min(d.rows.length, r.to));
      const doc = app.state.doc;
      const kind = (app.settings as any).mergeKind;
      const blocks: PMNode[] = [];
      idx.forEach((i, k) => {
        const rec = record(app, i);
        const frag = evalIfs(mergeInto(doc, rec, i), rec);
        frag.forEach((n) => blocks.push(n));
        if (k < idx.length - 1 && kind !== 'directory' && kind !== 'labels') blocks.push(N.page_break.create());
      });
      const settings = normalizeSettings(JSON.parse(JSON.stringify(doc.attrs.settings)));
      settings.mergeData = null; settings.mergePreview = null;
      const out = schema.node('doc', { settings }, blocks);
      if (arg === 'print') { const t = app.createTab(out, { title: 'Merged', fileName: 'Merged Letters.docx' }); app.setViewMode('print', t); setTimeout(() => app.exec('file.print'), 800); return; }
      if (arg === 'email') {
        const ef = d.fields.find((f) => /e-?mail/i.test(f));
        if (!ef) { toast('No Email field in the data source.'); return; }
        const first = record(app, idx[0]);
        const text = mergeInto(doc, first, idx[0]);
        const body = schema.node('doc', null, text).textBetween(0, schema.node('doc', null, text).content.size, '\n');
        (await import('../platform/native')).openExternal(`mailto:${encodeURIComponent(first[ef])}?subject=${encodeURIComponent(app.settings.properties.subject || app.tab.title)}&body=${encodeURIComponent(body)}`);
        toast('Opened the first message in your email app. Mobile mail apps send one message at a time.');
        return;
      }
      app.createTab(out, { title: 'Merged Documents', fileName: 'Merged Documents.docx' });
    },
    menu: () => [{ id: 'mail.finish', arg: 'edit', label: 'Edit Individual Documents…' }, { id: 'mail.finish', arg: 'print', label: 'Print Documents…' }, { id: 'mail.finish', arg: 'email', label: 'Send Email Messages…' }],
  },
  {
    id: 'mail.envelopes', label: 'Envelopes', icon: 'mail', tab: 'Mailings', group: 'Create', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Envelopes', wide: true, fields: [
        { key: 'to', label: 'Delivery address', type: 'textarea', rows: 4, value: '' },
        { key: 'from', label: 'Return address', type: 'textarea', rows: 3, value: app.prefs.author },
        { key: 'omit', label: 'Omit return address', type: 'checkbox', value: false },
        { key: 'size', label: 'Envelope size', type: 'select', options: ['Envelope #10', 'Envelope DL', 'Envelope C5', 'Postcard'], value: 'Envelope #10' },
        { key: 'merge', label: 'Use merge fields for the delivery address', type: 'checkbox', value: !!data(app) },
      ] });
      if (!r) return;
      const { PAGE_SIZES } = await import('../editor/settings');
      const [w, h0] = PAGE_SIZES[r.size];
      const settings = normalizeSettings({});
      settings.page = { ...settings.page, sizeName: r.size, width: w, height: h0, orientation: 'landscape', margin: { top: 27, left: 27, right: 27, bottom: 27 } };
      settings.mergeData = app.settings.mergeData;
      const blocks: PMNode[] = [];
      if (!r.omit) for (const l of String(r.from).split('\n')) blocks.push(N.paragraph.create({ style: 'Envelope Return' }, l ? schema.text(l) : null));
      for (let i = 0; i < 5; i++) blocks.push(N.paragraph.create({ style: 'Envelope Address' }));
      if (r.merge) {
        const F = (n: string) => N.field.create({ type: 'MERGEFIELD', arg: n });
        blocks.push(N.paragraph.create({ style: 'Envelope Address' }, [F('FirstName'), schema.text(' '), F('LastName')]));
        blocks.push(N.paragraph.create({ style: 'Envelope Address' }, [F('Address1')]));
        blocks.push(N.paragraph.create({ style: 'Envelope Address' }, [F('City'), schema.text(', '), F('State'), schema.text(' '), F('PostalCode')]));
      } else for (const l of String(r.to).split('\n')) blocks.push(N.paragraph.create({ style: 'Envelope Address' }, l ? schema.text(l) : null));
      const t = app.createTab(schema.node('doc', { settings }, blocks), { title: 'Envelope', fileName: 'Envelope.docx' });
      app.setViewMode('print', t);
    },
  },
  {
    id: 'mail.labels', label: 'Labels', icon: 'label', tab: 'Mailings', group: 'Create', edits: true,
    run: async (app) => {
      const LABELS: Record<string, { cols: number; rows: number; w: number; h: number; top: number; side: number; hgap: number }> = {
        'Address 1" × 2⅝" (30 per sheet)': { cols: 3, rows: 10, w: 189, h: 72, top: 36, side: 13.5, hgap: 9 },
        'Address 1⅓" × 4" (14 per sheet)': { cols: 2, rows: 7, w: 288, h: 96, top: 60, side: 11, hgap: 14 },
        'Shipping 2" × 4" (10 per sheet)': { cols: 2, rows: 5, w: 288, h: 144, top: 36, side: 11, hgap: 14 },
        'Return ½" × 1¾" (80 per sheet)': { cols: 4, rows: 20, w: 126, h: 36, top: 36, side: 22, hgap: 22 },
        'Name badge 2⅓" × 3⅜" (8 per sheet)': { cols: 2, rows: 4, w: 243, h: 168, top: 60, side: 47, hgap: 18 },
        'A4 21 labels 63.5 × 38.1 mm': { cols: 3, rows: 7, w: 180, h: 108, top: 43, side: 21, hgap: 7 },
      };
      const r = await openDialog({ title: 'Labels', fields: [
        { key: 'type', label: 'Label product', type: 'select', options: Object.keys(LABELS), value: Object.keys(LABELS)[0] },
        { key: 'text', label: 'Label text (same on every label)', type: 'textarea', rows: 3, value: '', visibleIf: (x) => !x.merge },
        { key: 'merge', label: 'Different label per recipient (mail merge)', type: 'checkbox', value: !!data(app) },
      ] });
      if (!r) return;
      const L = LABELS[r.type];
      const isA4 = r.type.startsWith('A4');
      const settings = normalizeSettings({});
      settings.page = { ...settings.page, sizeName: isA4 ? 'A4' : 'Letter', width: isA4 ? 595.28 : 612, height: isA4 ? 841.89 : 792, margin: { top: L.top, bottom: 0, left: L.side, right: 0 } };
      settings.mergeData = app.settings.mergeData;
      const d = data(app);
      const cellBlocks = (i: number): PMNode[] => {
        if (r.merge && d) {
          const rec = record(app, i);
          const lines = [[rec.FirstName, rec.LastName].filter(Boolean).join(' '), rec.Company, rec.Address1, rec.Address2, [rec.City, rec.State].filter(Boolean).join(', ') + (rec.PostalCode ? ' ' + rec.PostalCode : '')].filter((x) => x && x.trim());
          return lines.length ? lines.map((l) => N.paragraph.create({ spaceAfter: 0 }, schema.text(l))) : [N.paragraph.create()];
        }
        return String(r.text || '').split('\n').map((l) => N.paragraph.create({ spaceAfter: 0 }, l ? schema.text(l) : null));
      };
      const total = r.merge && d ? d.rows.length : L.cols * L.rows;
      const rowsNodes: PMNode[] = [];
      for (let i = 0; i < Math.ceil(total / L.cols); i++) {
        const cells: PMNode[] = [];
        for (let c = 0; c < L.cols; c++) {
          const k = i * L.cols + c;
          cells.push(N.table_cell.create({ colwidth: [Math.round(L.w * 4 / 3)], valign: 'middle' }, k < total ? cellBlocks(k) : [N.paragraph.create()]));
        }
        rowsNodes.push(N.table_row.create(null, cells));
      }
      const table = N.table.create({ style: 'Plain Table', layout: 'fixed' }, rowsNodes);
      const t = app.createTab(schema.node('doc', { settings }, [table, N.paragraph.create()]), { title: 'Labels', fileName: 'Labels.docx' });
      t.styleEl.textContent += `\n.qf-doc .ProseMirror table td{height:${L.h}pt;padding:0 6pt;vertical-align:middle;overflow:hidden}`;
      app.setViewMode('print', t);
    },
  },
]);
void createTable;

function gotoRec(app: App, fn: (i: number, n: number) => number) {
  const d = data(app);
  if (!d || !d.rows.length) { toast('Select recipients first.'); return; }
  const cur = app.settings.mergePreview ?? 0;
  const next = Math.max(0, Math.min(d.rows.length - 1, fn(cur, d.rows.length)));
  app.updateSettings((s) => { s.mergePreview = next; });
  app.updateFields();
  app.ui.status(`Record ${next + 1} of ${d.rows.length}`);
}

function evalIfs(frag: Fragment, rec: Record<string, string>): Fragment {
  const mapNode = (node: PMNode): PMNode | null => {
    if (node.type === N.field && node.attrs.type === 'MERGEFIELD' && String(node.attrs.arg).startsWith('IF:')) {
      try {
        const r = JSON.parse(String(node.attrs.arg).slice(3));
        const val = rec[r.field] ?? '';
        const ok = r.op === '=' ? val === r.val : r.op === '<>' ? val !== r.val : r.op === 'is blank' ? !val.trim() : !!val.trim();
        const t = ok ? r.then : r.else;
        return t ? schema.text(t, node.marks) : null;
      } catch { return null; }
    }
    if (node.isLeaf) return node;
    const kids: PMNode[] = [];
    node.forEach((c) => { const m = mapNode(c); if (m) kids.push(m); });
    try { return node.copy(Fragment.fromArray(kids)); } catch { return node; }
  };
  const out: PMNode[] = [];
  frag.forEach((n) => { const m = mapNode(n); if (m) out.push(m); });
  return Fragment.fromArray(out);
}
