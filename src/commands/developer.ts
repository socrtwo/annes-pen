/** Developer tab: macros (recorded and scripted), content controls, form protection. */
import { def, getCommand, allCommands } from './registry';
import { trackPositions, type App } from '../app';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { insertInline, selectedText, docText } from '../editor/ops';
import { openDialog, toast, promptDialog, confirmDialog, showMenu } from '../ui/dialog';
import { pickFile, readFileAsDataURL } from '../ui/dom';
import { replaceAll } from './edit';
import { verifyPassword } from '../util/crypto';
import type { Macro } from '../prefs';

const N = schema.nodes;
const v = (app: App) => app.view;

/** API object exposed to script macros (the Anne's Pen equivalent of an object model). */
export function macroApi(app: App) {
  return {
    exec: (id: string, arg?: any) => app.exec(id, arg),
    commands: () => allCommands().map((c) => c.id),
    text: () => docText(app.state.doc),
    selection: () => selectedText(app.state),
    insert: (text: string) => app.view.dispatch(app.state.tr.insertText(String(text)).scrollIntoView()),
    replaceAll: (find: string, replace: string, opts: Record<string, any> = {}) => replaceAll(app, { find, replace, ...opts }),
    paragraphs: () => { const out: { index: number; style: string; text: string }[] = []; app.state.doc.forEach((n, _p, i) => out.push({ index: i, style: n.attrs.style || n.type.name, text: n.textContent })); return out; },
    setStyle: (index: number, style: string) => { let pos = -1; app.state.doc.forEach((n, p, i) => { if (i === index) pos = p; }); if (pos < 0) return; const n = app.state.doc.nodeAt(pos); if (n && n.type === N.paragraph) app.view.dispatch(app.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, style })); },
    select: (from: number, to: number) => app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, from, to))),
    docJSON: () => app.state.doc.toJSON(),
    settings: () => JSON.parse(JSON.stringify(app.settings)),
    updateSettings: (fn: (s: any) => void) => app.updateSettings(fn),
    alert: (m: string) => import('../ui/dialog').then(({ alertDialog }) => alertDialog('Macro', String(m))),
    prompt: (label: string, value = '') => promptDialog('Macro', label, value),
    toast: (m: string) => toast(String(m)),
  };
}

/** Keeps only well-formed macros (string name, array of steps with string ids) from imported JSON. */
export function validMacros(data: unknown): Macro[] {
  if (!Array.isArray(data)) throw new Error('not a list');
  return data.filter((m): m is Macro => !!m && typeof m === 'object' && typeof m.name === 'string' && !!m.name && Array.isArray(m.steps)
    && m.steps.every((s: any) => !!s && typeof s === 'object' && typeof s.id === 'string'))
    .map((m) => ({ ...m, description: typeof m.description === 'string' ? m.description : undefined, created: typeof m.created === 'number' ? m.created : Date.now() }));
}

/** CSV cell text that a spreadsheet will not run as a formula (= + - @, and tab or CR first). */
export function csvSafe(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** An imported script macro asks once before it first runs; after that it is trusted. */
async function trustScript(app: App, m: Macro): Promise<boolean> {
  if (!m.untrusted || !m.steps.some((s) => s.id === '__script')) return true;
  const ok = await confirmDialog('Run Imported Script?', `The macro “${m.name}” was imported and runs JavaScript code that can change your documents and settings. Run it only if you trust where it came from. Run it now?`, 'Run', 'Cancel');
  if (!ok) return false;
  for (const x of app.prefs.macros) if (x.name === m.name && x.untrusted) delete x.untrusted;
  delete m.untrusted;
  app.savePrefs();
  return true;
}

export async function runMacro(app: App, m: Macro, times = 1) {
  if (!(await trustScript(app, m))) return;
  for (let t = 0; t < times; t++) {
    for (const step of m.steps) {
      if (step.id === '__script') {
        const fn = new Function('qf', `"use strict"; return (async () => { ${step.arg} \n})();`);
        await fn(macroApi(app));
        continue;
      }
      if (!getCommand(step.id)) { toast(`Macro step skipped: unknown command ${step.id}`); continue; }
      const r = app.exec(step.id, step.arg);
      if (r instanceof Promise) await r;
    }
  }
}

async function editScript(app: App, existing?: Macro) {
  const code = existing?.steps.find((s) => s.id === '__script')?.arg ?? `// Anne\'s Pen macro. The "qf" object gives access to the document.\n// Examples:\n//   qf.replaceAll('  ', ' ');\n//   qf.exec('fmt.bold');\n//   for (const p of qf.paragraphs()) if (p.text.startsWith('Chapter')) qf.setStyle(p.index, 'Heading 1');\nconst words = qf.text().split(/\\s+/).filter(Boolean).length;\nqf.toast('Words: ' + words);`;
  const r = await openDialog({ title: existing ? `Edit Macro: ${existing.name}` : 'New Script Macro', wide: true, help: 'Script macros run JavaScript with the qf API: exec(id,arg), text(), selection(), insert(t), replaceAll(f,r,{regex,caseSensitive,wholeWord}), paragraphs(), setStyle(i,style), select(a,b), settings(), updateSettings(fn), alert(m), prompt(label), toast(m), commands(). Only run scripts you trust.', fields: [
    { key: 'name', label: 'Macro name', type: 'text', value: existing?.name || 'Macro1' },
    { key: 'desc', label: 'Description', type: 'text', value: existing?.description || '' },
    { key: 'code', label: 'Script', type: 'textarea', rows: 14, value: code },
  ] });
  if (!r?.name) return;
  const m: Macro = { name: r.name, description: r.desc, steps: [{ id: '__script', arg: r.code }], created: existing?.created || Date.now() };
  app.prefs.macros = [...app.prefs.macros.filter((x) => x.name !== (existing?.name || r.name)), m];
  app.savePrefs();
  app.ui.rebuild();
}

def([
  {
    id: 'dev.macros', label: 'Macros…', icon: 'smart_button', tab: 'Developer', group: 'Code', keys: ['Alt-F8'], popular: true, noRecord: true,
    run: async (app) => {
      const list = app.prefs.macros;
      const r = await openDialog({ title: 'Macros', wide: true, ok: 'Run', fields: [
        { key: 'name', label: 'Macro name', type: 'list', rows: 8, options: list.map((m) => ({ value: m.name, label: `${m.name}${m.description ? ' — ' + m.description : ''} (${m.steps[0]?.id === '__script' ? 'script' : m.steps.length + ' steps'})` })), value: list[0]?.name },
        { key: 'times', label: 'Repeat', type: 'number', value: 1, min: 1, max: 1000 },
      ], buttons: [
        { label: 'Record…', onClick: (_x, ctl) => ctl.close({ act: 'record' }) },
        { label: 'New Script…', onClick: (_x, ctl) => ctl.close({ act: 'script' }) },
        { label: 'Edit', onClick: (x, ctl) => ctl.close({ act: 'edit', name: x.name }) },
        { label: 'Delete', onClick: (x, ctl) => ctl.close({ act: 'delete', name: x.name }) },
        { label: 'Add to Quick Access', onClick: (x, ctl) => ctl.close({ act: 'qat', name: x.name }) },
      ] });
      if (!r) return;
      const m = list.find((x) => x.name === r.name);
      if (r.act === 'record') return app.exec('dev.recordMacro');
      if (r.act === 'script') return editScript(app);
      if (r.act === 'delete' && m) { if (await confirmDialog('Delete Macro', `Delete "${m.name}"?`)) { app.prefs.macros = list.filter((x) => x !== m); app.savePrefs(); app.ui.rebuild(); } return; }
      if (r.act === 'qat' && m) { app.prefs.qat.push(`macro:${m.name}`); app.savePrefs(); app.ui.rebuild(); toast('Added to the Quick Access Bar'); return; }
      if (r.act === 'edit' && m) {
        if (m.steps[0]?.id === '__script') return editScript(app, m);
        const rr = await openDialog({ title: `Edit Macro: ${m.name}`, wide: true, help: 'Recorded steps as JSON: [{"id":"command.id","arg":…}]', fields: [{ key: 'json', label: 'Steps', type: 'textarea', rows: 14, value: JSON.stringify(m.steps, null, 1) }, { key: 'desc', label: 'Description', type: 'text', value: m.description || '' }] });
        if (rr) { try { const steps = JSON.parse(rr.json); if (!validMacros([{ name: m.name, steps }]).length) throw new Error('bad steps'); m.steps = steps; m.description = rr.desc; app.savePrefs(); } catch { toast('Invalid JSON.'); } }
        return;
      }
      if (m) await runMacro(app, m, Math.max(1, r.times || 1));
    },
  },
  {
    id: 'dev.recordMacro', label: 'Record Macro', icon: 'fiber_manual_record', tab: 'Developer', group: 'Code', kind: 'toggle', noRecord: true,
    run: async (app) => {
      if (app.recording) return app.exec('dev.stopRecording');
      const r = await openDialog({ title: 'Record Macro', fields: [{ key: 'name', label: 'Macro name', type: 'text', value: `Macro${app.prefs.macros.length + 1}` }, { key: 'desc', label: 'Description', type: 'text', value: '' }, { key: 'key', label: 'Shortcut key (optional, e.g. Mod-Alt-1)', type: 'text', value: '' }, { key: 'qat', label: 'Add to Quick Access Bar', type: 'checkbox', value: true }] });
      if (!r?.name) return;
      app.recording = { name: r.name, steps: [] };
      (app.recording as any).meta = r;
      app.ui.status('● Recording macro… typing, editing keys (Enter, Backspace, Delete, Tab) and commands are recorded');
      toast('Recording. Use Stop Recording (status bar) when done.');
    },
    isActive: (app) => !!app.recording,
  },
  {
    id: 'dev.stopRecording', label: 'Stop Recording', icon: 'stop_circle', tab: 'Developer', group: 'Code', noRecord: true,
    run: (app) => {
      const rec = app.recording;
      if (!rec) { toast('Not recording.'); return; }
      app.recording = null;
      const meta = (rec as any).meta || {};
      const m: Macro = { name: rec.name, steps: rec.steps, description: meta.desc, key: meta.key || undefined, created: Date.now() };
      app.prefs.macros = [...app.prefs.macros.filter((x) => x.name !== m.name), m];
      if (meta.key) app.prefs.keymap[meta.key] = `macro:${m.name}`;
      if (meta.qat) app.prefs.qat.push(`macro:${m.name}`);
      app.savePrefs();
      app.ui.rebuild();
      app.ui.status('');
      toast(`Macro "${m.name}" saved (${m.steps.length} steps)`);
    },
    isEnabled: (app) => !!app.recording,
  },
  { id: 'dev.pauseRecording', label: 'Pause Recording', icon: 'pause_circle', tab: 'Developer', group: 'Code', noRecord: true, kind: 'toggle', run: (app) => { if (!app.recording) return; app.recordingPaused = !app.recordingPaused; toast(app.recordingPaused ? 'Recording paused' : 'Recording resumed'); }, isActive: (app) => app.recordingPaused },
  { id: 'dev.newScript', label: 'Script Editor (New Macro)', icon: 'terminal', tab: 'Developer', group: 'Code', noRecord: true, run: (app) => editScript(app) },
  {
    id: 'dev.runScript', label: 'Run Script Once…', icon: 'play_arrow', tab: 'Developer', group: 'Code', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Immediate Script', wide: true, fields: [{ key: 'code', label: 'JavaScript (qf API)', type: 'textarea', rows: 10, value: "qf.toast(qf.selection() || 'Nothing selected')" }], ok: 'Run' });
      if (r) await runMacro(app, { name: 'immediate', steps: [{ id: '__script', arg: r.code }], created: Date.now() });
    },
  },
  { id: 'dev.runMacro', label: 'Run Macro', icon: 'play_circle', tab: 'Developer', group: 'Code', internal: true, noRecord: true, run: (app, name: string) => { const m = app.prefs.macros.find((x) => x.name === name); if (m) return runMacro(app, m); toast(`Macro ${name} not found.`); } },
  {
    id: 'dev.exportMacros', label: 'Export Macros', icon: 'file_export', tab: 'Developer', group: 'Code', noRecord: true,
    run: async (app) => { const { saveAs } = await import('../platform/native'); await saveAs(new Blob([JSON.stringify(app.prefs.macros, null, 1)], { type: 'application/json' }), 'Annes-Pen-macros.json'); },
  },
  {
    id: 'dev.importMacros', label: 'Import Macros', icon: 'file_open', tab: 'Developer', group: 'Code', noRecord: true,
    run: async (app) => {
      const f = await pickFile('.json,application/json'); if (!f.length) return;
      let list: Macro[];
      try { list = validMacros(JSON.parse(await f[0].text())); } catch { toast('Not a macro file.'); return; }
      if (!list.length) { toast('No valid macros in this file.'); return; }
      const { confirmImportedScripts } = await import('./file');
      const s = { macros: list };
      if (!(await confirmImportedScripts(app, s))) return;
      list = s.macros;
      if (!list.length) { toast('No macros imported.'); return; }
      app.prefs.macros = [...app.prefs.macros.filter((m) => !list.some((x) => x.name === m.name)), ...list]; app.savePrefs(); app.ui.rebuild(); toast(`${list.length} macro(s) imported`);
    },
  },
]);

// Content controls -------------------------------------------------------------------------------
const CONTROLS: [string, string, string][] = [['text', 'Plain Text Content Control', 'text_fields'], ['rich', 'Rich Text Content Control', 'format_color_text'], ['checkbox', 'Check Box Content Control', 'check_box'], ['dropdown', 'Drop-Down List Content Control', 'arrow_drop_down_circle'], ['combo', 'Combo Box Content Control', 'list'], ['date', 'Date Picker Content Control', 'calendar_month'], ['picture', 'Picture Content Control', 'image']];
for (const [kind, label, icon] of CONTROLS) {
  def({
    id: `dev.control.${kind}`, label, icon, tab: 'Developer', group: 'Controls', edits: true,
    run: (app) => insertInline(v(app), N.control.create({ kind: kind === 'rich' ? 'text' : kind, value: kind === 'checkbox' ? 'false' : '', options: kind === 'dropdown' || kind === 'combo' ? 'Choose an item|Option 1|Option 2' : '', label: '' })),
  });
}
def([
  {
    id: 'dev.controlProperties', label: 'Control Properties…', icon: 'tune', tab: 'Developer', group: 'Controls', edits: true,
    run: async (app, arg) => {
      const sel = app.state.selection;
      const pos = arg?.pos ?? (sel instanceof NodeSelection ? sel.from : -1);
      const node = pos >= 0 ? app.state.doc.nodeAt(pos) : app.state.doc.nodeAt(sel.from);
      const p = pos >= 0 ? pos : sel.from;
      if (!node || node.type !== N.control) { toast('Select a content control.'); return; }
      const pt = trackPositions(app);
      // The control where it is now (the document may change while the dialog is open), or null if it is gone.
      const here = () => { const q = pt.map(p, 1); const n = !pt.lost && !pt.deleted(p, 1) ? app.state.doc.nodeAt(q) : null; return n && n.type === N.control ? { q, n } : null; };
      const r = await openDialog({ title: 'Content Control Properties', fields: [
        { key: 'label', label: 'Title / placeholder', type: 'text', value: node.attrs.label },
        { key: 'tag', label: 'Tag', type: 'text', value: node.attrs.tag },
        { key: 'options', label: 'List items (one per line)', type: 'textarea', rows: 5, value: String(node.attrs.options).split('|').join('\n'), visibleIf: () => node.attrs.kind === 'dropdown' || node.attrs.kind === 'combo' },
        { key: 'locked', label: 'Content cannot be edited', type: 'checkbox', value: node.attrs.locked },
      ], buttons: [{ label: 'Remove Control (keep value)', onClick: (_x, ctl) => { const c = here(); if (c) { const a = c.n.attrs; v(app).dispatch(app.state.tr.replaceWith(c.q, c.q + 1, a.value && a.kind !== 'checkbox' ? schema.text(a.value) : schema.text(a.kind === 'checkbox' ? (a.value === 'true' ? '☒' : '☐') : ' '))); } ctl.close(); } }] });
      const c = here();
      pt.done();
      if (r && c) v(app).dispatch(app.state.tr.setNodeMarkup(c.q, undefined, { ...c.n.attrs, label: r.label, tag: r.tag, options: String(r.options || '').split('\n').map((s: string) => s.trim()).filter(Boolean).join('|'), locked: r.locked }).setMeta('form', true));
    },
  },
  {
    id: 'dev.designMode', label: 'Design Mode', icon: 'design_services', tab: 'Developer', group: 'Controls', kind: 'toggle',
    run: (app) => { app.tab.el.classList.toggle('qf-design-mode'); app.refresh(); }, isActive: (app) => app.tab.el.classList.contains('qf-design-mode'),
  },
  { id: 'dev.restrictEditing', label: 'Restrict Editing', icon: 'shield_lock', tab: 'Developer', group: 'Protect', run: (app) => app.exec('review.restrictEditing') },
  {
    id: 'dev.fillForms', label: 'Protect for Form Filling', icon: 'edit_document', tab: 'Developer', group: 'Protect', kind: 'toggle',
    run: async (app) => {
      const p = app.settings.protection;
      const on = p.mode !== 'forms';
      if (p.hash && p.mode !== 'none') {
        const pw = await promptDialog('Unprotect Document', 'Password:', '', { type: 'password' });
        if (pw == null || !(await verifyPassword(pw, p.hash))) { toast('Incorrect password.'); return; }
      }
      app.view.dispatch(app.state.tr.setDocAttribute('settings', { ...JSON.parse(JSON.stringify(app.settings)), protection: { mode: on ? 'forms' : 'none', hash: on ? p.hash : undefined } }).setMeta('allowProtected', true).setMeta('trackSkip', true));
      app.view.setProps({});
    },
    isActive: (app) => app.settings.protection.mode === 'forms',
  },
  {
    id: 'dev.exportFormData', label: 'Export Form Data (CSV)', icon: 'table_view', tab: 'Developer', group: 'Protect', noRecord: true,
    run: async (app) => {
      const rows: string[][] = [['Tag', 'Title', 'Type', 'Value']];
      app.state.doc.descendants((n) => { if (n.type === N.control) rows.push([n.attrs.tag, n.attrs.label, n.attrs.kind, n.attrs.kind === 'picture' ? '(image)' : n.attrs.value]); return true; });
      const csv = rows.map((r) => r.map((c) => `"${csvSafe(String(c ?? '')).replace(/"/g, '""')}"`).join(',')).join('\n');
      const { saveAs } = await import('../platform/native');
      await saveAs(new Blob([csv], { type: 'text/csv' }), `${app.tab.title}-form-data.csv`);
    },
  },
  { id: 'dev.documentTemplate', label: 'Document Template (Attach Styles)…', icon: 'description', tab: 'Developer', group: 'Templates', run: (app) => app.exec('style.importFrom') },
  { id: 'dev.documentPanel', label: 'Document Panel (Properties)', icon: 'info', tab: 'Developer', group: 'Templates', run: (app) => app.exec('file.properties') },
  { id: 'dev.commandIds', label: 'Copy Command ID List', icon: 'content_copy', tab: 'Developer', group: 'Code', noRecord: true, run: async () => { await navigator.clipboard?.writeText(allCommands().map((c) => `${c.id}\t${c.label}\t${c.tab}`).join('\n')); toast('Command list copied (for macros and settings files).'); } },
]);

/** Click handler for content controls (checkbox toggle, list pick, date pick, picture). */
export async function controlClick(app: App, pos: number, node: PMNode, el: HTMLElement) {
  const view = app.view;
  if (node.attrs.locked && !app.tab.el.classList.contains('qf-design-mode')) return;
  if (app.tab.el.classList.contains('qf-design-mode')) { app.exec('dev.controlProperties', { pos }); return; }
  // Pickers and prompts wait for the user: the value goes to this control where it is by then
  // (unchanged nodes stay the same objects when other parts of the document are edited).
  const set = (value: string) => {
    const d = view.state.doc;
    let q = pos < d.content.size && d.nodeAt(pos) === node ? pos : -1;
    if (q < 0) d.descendants((n, p) => { if (q < 0 && n === node) q = p; return q < 0; });
    if (q >= 0) view.dispatch(view.state.tr.setNodeMarkup(q, undefined, { ...node.attrs, value }).setMeta('form', true));
  };
  switch (node.attrs.kind) {
    case 'checkbox': set(node.attrs.value === 'true' ? 'false' : 'true'); return;
    case 'dropdown': case 'combo': {
      const opts = String(node.attrs.options).split('|').filter(Boolean);
      showMenu([...opts.map((o) => ({ id: 'x', arg: o, label: o, checked: o === node.attrs.value })), ...(node.attrs.kind === 'combo' ? [{ separator: true } as const, { id: 'x', arg: '__other', label: 'Other…' }] : [])], {
        anchor: el, onPick: async (e) => { if (e.arg === '__other') { const t = await promptDialog('Value', 'Enter a value:', node.attrs.value); if (t != null) set(t); } else set(e.arg); },
      });
      return;
    }
    case 'date': { const d = await promptDialog('Pick a Date', 'Date:', node.attrs.value || new Date().toISOString().slice(0, 10), { type: 'date' }); if (d != null) set(d); return; }
    case 'picture': { const f = await pickFile('image/*'); if (f.length) set(await readFileAsDataURL(f[0])); return; }
    default: { const t = await promptDialog(node.attrs.label || 'Text', 'Value:', node.attrs.value); if (t != null) set(t); }
  }
}
