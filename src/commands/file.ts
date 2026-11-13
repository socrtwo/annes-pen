/** File (backstage) commands: new, open, save, export, print, share, info, versions, options. */
import { def } from './registry';
import type { App, DocTab } from '../app';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { normalizeSettings } from '../editor/settings';
import { FORMATS, formatById, formatForName, importFile, exportFile, sniff } from '../io';
import { openDocument, saveAs, writeBack, printDocument, shareFile, readUri, openExternal, OPEN_ACCEPT, OPEN_MIMES } from '../platform/native';
import { openDialog, toast, confirmDialog, choiceDialog, alertDialog } from '../ui/dialog';
import { kvGet, kvSet, kvDel, orphanedDrafts } from '../util/store';
import { TEMPLATES } from '../templates';
import { countWords, docText } from '../editor/ops';
import { listChanges, resolveChanges } from '../editor/plugins/trackChanges';
import { DEFAULT_AUTOFORMAT, DEFAULT_REPLACEMENTS } from '../editor/autoformat';
import { commandCount } from './registry';
import { h } from '../ui/dom';
import { showRecoveryReport, showManualRecovery, recoverySummary } from '../ui/recovery';
import { SPELL_DIALECTS } from '../proof/proofing';
import { refuseIfProtected } from './review';
import { sanitizePrefs, type Prefs } from '../prefs';
import { trackPositions } from '../app';
import { isNative } from '../platform/native';

const N = schema.nodes;

/** Key for a document's cached copy, Recent entry, snapshots and AI notes. Native URIs are unique and lasting;
 *  other files (the web build, whose File System Access handles last one session) keep the key they opened with. */
export function docKey(tab: DocTab): string {
  return (tab.uri && !tab.uri.startsWith('fsa:') ? tab.uri : '') || tab.key || `doc:${tab.id}`;
}

/** Key for a file opened without a URI: its name plus a fingerprint of its bytes (same-named files differ). */
export function localKey(name: string, data: ArrayBuffer): string {
  const b = new Uint8Array(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return `doc:${name}:${b.length.toString(36)}.${(h >>> 0).toString(36)}`;
}

/** The key of a Recent file last opened or saved here with exactly these bytes, so a file saved and opened
 *  again keeps its versions and notes. */
async function knownKey(app: App, name: string, data: ArrayBuffer): Promise<string | null> {
  const b = new Uint8Array(data);
  for (const r of app.prefs.recent) {
    if (r.name !== name || !r.key.startsWith('doc:')) continue;
    const c = await kvGet('file:' + r.key);
    const d = c?.data instanceof ArrayBuffer ? new Uint8Array(c.data) : null;
    if (d && d.length === b.length && d.every((x, i) => x === b[i])) return r.key;
  }
  return null;
}

function isPristine(tab: DocTab): boolean {
  const d = tab.view.state.doc;
  return !tab.dirty && !tab.uri && d.childCount === 1 && d.firstChild!.content.size === 0;
}

async function openRecoveredText(app: App, text: string, name: string): Promise<void> {
  const { textToDoc } = await import('../io/recover');
  const base = name.replace(/\.[^.]+$/, '');
  const tab = app.createTab(textToDoc(text, base), { title: `${base} (Recovered text)`, fileName: `${base} (Recovered text).docx`, format: 'docx', uri: null });
  tab.dirty = true;
  app.activate(tab);
}

export async function openBuffer(app: App, data: ArrayBuffer, name: string, uri: string | null, opts: { repair?: boolean; textOnly?: boolean; key?: string } = {}): Promise<DocTab | null> {
  try {
    const { isEncryptedDoc } = await import('../util/crypto');
    if (!opts.repair && !opts.textOnly && isEncryptedDoc(data)) return await openEncrypted(app, { name, data, uri });
    if (opts.repair || opts.textOnly) toast(opts.textOnly ? `Recovering text from ${name}…` : `Repairing ${name}…`);
    // Identify the file by its content; the extension only breaks ties.
    const sniffed = sniff(data, name);
    if (!opts.repair && !opts.textOnly) {
      if (sniffed.category === 'spreadsheet' || sniffed.category === 'presentation' || sniffed.category === 'email') {
        const { chooseCrossOpen } = await import('../ui/crossOpen');
        const c = await chooseCrossOpen(sniffed, { name, data, uri }, !!formatById(sniffed.format)?.canImport);
        if (c !== 'import') return null;
      } else if (sniffed.category === 'unknown' && sniffed.format !== 'unknown') {
        const why = sniffed.format === 'ooxml-encrypted' ? ' It is password-protected: open it with the password in the program that made it, remove the password and save it again.' : '';
        const c = await choiceDialog('Not a Document', `${name} is ${/^[aeiou]/i.test(sniffed.label) ? 'an' : 'a'} ${sniffed.label}, not a document.${why}`, ['Recover any text it holds']);
        if (c !== 0) return null;
        opts = { ...opts, textOnly: true };
      }
    }
    const { doc, format, recovery, note } = await importFile(data, name, { repair: opts.repair, textOnly: opts.textOnly, sniffed });
    if (recovery && recovery.mode === 'text' && recovery.bestKey === 'strings' && !opts.textOnly) {
      const go = await confirmDialog('Only Text Fragments Recovered', `${name} is too badly damaged to open normally. Only loose text fragments (${recovery.bestText.length.toLocaleString()} characters) could be recovered. Open them in a new document?`, 'Open fragments', 'Cancel');
      if (!go) { void showRecoveryReport(recovery); return null; }
    }
    const cur = app.tab;
    const base = name.replace(/\.[^.]+$/, '');
    // A recovered document never writes back over the damaged original: Save asks for a new name.
    const meta = recovery
      ? { title: `${base} (Recovered)`, fileName: `${base} (Recovered).${format.ext[0] === 'doc' ? 'docx' : format.ext[0]}`, format: format.canExport ? format.id : 'docx', uri: null, key: '' }
      : { title: base, fileName: name, format: format.id, uri, key: uri && !uri.startsWith('fsa:') ? '' : opts.key || (await knownKey(app, name, data)) || localKey(name, data) };
    let tab: DocTab;
    if (cur && isPristine(cur)) {
      Object.assign(cur, meta);
      app.replaceDoc(cur, doc);
      cur.dirty = false;
      tab = cur;
      app.ui.tabsChanged();
    } else tab = app.createTab(doc, meta);
    tab.recovery = recovery || null;
    if (recovery) tab.dirty = true;
    else {
      addRecent(app, tab);
      // The cached copy (Recent, Revert) must not hold up opening; a failure to store it is ignored.
      void kvSet('file:' + docKey(tab), { name, data, uri, when: Date.now() });
    }
    app.activate(tab);
    if (recovery) {
      toast(`${name} was damaged. ${recoverySummary(recovery)}`, { action: 'Details', onAction: () => app.exec('file.recoveryReport'), ms: 9000 });
    } else if (note) toast(`${note} ${format.canExport ? '' : 'Saving makes a new copy in a current format.'}`.trim(), { ms: 7000 });
    else if (!format.canExport) toast(`Opened ${name} (${sniffed.label}). Saving makes a new copy in a current format.`, { ms: 6000 });
    else toast(`Opened ${name}`);
    return tab;
  } catch (e: any) {
    console.error(e);
    toast(`Could not open ${name}: ${e?.message || e}`);
    return null;
  }
}

function addRecent(app: App, tab: DocTab) {
  const key = docKey(tab);
  const list = app.prefs.recent.filter((r) => r.key !== key);
  const old = app.prefs.recent.find((r) => r.key === key);
  list.unshift({ key, name: tab.displayName, when: Date.now(), uri: tab.uri || undefined, format: tab.format, pinned: old?.pinned });
  app.prefs.recent = [...list.filter((r) => r.pinned), ...list.filter((r) => !r.pinned)].slice(0, 40);
  app.savePrefs();
}

async function snapshot(app: App, tab: DocTab, label: string, doc = tab.view.state.doc) {
  if (tab.encryption) return; // snapshots are stored unencrypted
  await kvSet(`snap:${docKey(tab)}:${Date.now()}`, { label, json: doc.toJSON(), words: countWords(docText(doc)), when: Date.now(), name: tab.displayName });
}

/** Encrypted name for a document: .qpde (also for files with the former name's .qfde). */
const encryptedName = (name: string) => `${(name || 'Document').replace(/\.(qpde|qfde|qpd|qfd)$/i, '').replace(/\.[^.]+$/, '')}.qpde`;

/** Opens an encrypted document: asks for its password and keeps the key on the tab so Save encrypts again. */
export async function openEncrypted(app: App, f: { name: string; data: ArrayBuffer; uri: string | null }): Promise<DocTab | null> {
  const r = await openDialog({ title: 'Password', fields: [{ key: 'p', label: `Password for ${f.name}`, type: 'password', autofocus: true }] });
  if (!r) return null;
  let opened: { json: any; key: import('../util/crypto').DocKey };
  try {
    const { decryptJsonWithKey } = await import('../util/crypto');
    opened = await decryptJsonWithKey(f.data, r.p);
  } catch { toast('Wrong password or damaged file.'); return null; }
  const fileName = encryptedName(f.name);
  // A .qfde keeps its URI only for reading: saving writes a .qpde.
  const tab = app.createTab(schema.nodeFromJSON(opened.json), { title: fileName.replace(/\.qpde$/, ''), fileName, format: 'qpd', uri: /\.qpde$/i.test(f.name) ? f.uri : null, encryption: opened.key });
  addRecent(app, tab);
  void kvSet('file:' + docKey(tab), { name: f.name, data: f.data, uri: f.uri, when: Date.now() }); // encrypted bytes
  app.activate(tab);
  toast(`Opened ${f.name} (encrypted)`);
  return tab;
}

/** Save for an encrypted document: encrypted again with its key, as .qpde. */
async function saveEncrypted(app: App, tab: DocTab, as: boolean): Promise<boolean> {
  const { encryptWithKey } = await import('../util/crypto');
  const doc = tab.view.state.doc;
  const blob = new Blob([(await encryptWithKey(doc.toJSON(), tab.encryption!)) as BlobPart], { type: 'application/octet-stream' });
  const name = encryptedName(tab.fileName || tab.title);
  if (!as && tab.uri && /\.qpde$/i.test(tab.fileName)) {
    try {
      if (await writeBack(tab.uri, blob)) { markSaved(app, tab, doc); toast(`Saved ${tab.displayName} (encrypted)`); return true; }
    } catch (e) { console.warn(e); }
  }
  const r = await saveAs(blob, name);
  if (!r) return false;
  tab.fileName = r.name; tab.title = r.name.replace(/\.[^.]+$/, ''); tab.format = 'qpd'; tab.uri = r.uri;
  markSaved(app, tab, doc);
  addRecent(app, tab);
  void kvSet('file:' + docKey(tab), { name: r.name, data: await blob.arrayBuffer(), uri: r.uri, when: Date.now() });
  toast(`Saved ${r.name} (encrypted)`);
  return true;
}

export async function saveTab(app: App, tab: DocTab, opts: { as?: boolean; format?: string; copy?: boolean } = {}): Promise<boolean> {
  if (tab.encryption && !opts.copy && (!opts.format || opts.format === 'qpde' || (opts.format === 'qpd' && !opts.as))) return saveEncrypted(app, tab, !!opts.as);
  let format = opts.format || (formatById(tab.format)?.canExport && tab.format !== 'pdf' ? tab.format : app.prefs.defaultSaveFormat);
  const fmt = formatById(format);
  if (!fmt?.export) { toast('Choose another format.'); return false; }
  // Warn when saving rich content to a lossy format.
  if (!opts.as && !opts.copy && ['txt', 'md'].includes(format) && hasRichContent(tab.view.state.doc)) {
    const c = await choiceDialog('Keep Current Format?', `Some formatting will be lost if you save as ${fmt.label}.`, ['Use Word Document (.docx)', `Keep ${fmt.label}`]);
    if (c < 0) return false;
    if (c === 0) { format = 'docx'; opts = { ...opts, as: true }; }
  }
  const s = normalizeSettings(tab.view.state.doc.attrs.settings);
  const base = (tab.fileName || tab.title || 'Document').replace(/\.[^.]+$/, '');
  const name = `${base}.${formatById(format)!.ext[0]}`;
  app.updateFields(tab);
  const doc = tab.view.state.doc; // the version written; edits made while saving stay unsaved
  const blob = await exportFile(doc, format, { fileName: name, author: s.properties.author || app.prefs.author, title: s.properties.title || base });
  if (!opts.as && !opts.copy && tab.uri && format === tab.format) {
    try {
      if (await writeBack(tab.uri, blob)) { markSaved(app, tab, doc); toast(`Saved ${tab.displayName}`); await snapshot(app, tab, 'Saved', doc); return true; }
    } catch (e) { console.warn(e); }
  }
  const r = await saveAs(blob, name);
  if (!r) return false;
  if (!opts.copy) {
    tab.encryption = null; // saved as an ordinary file by choice (Save As another format)
    tab.fileName = r.name; tab.title = r.name.replace(/\.[^.]+$/, ''); tab.format = formatForName(r.name)?.id || format; tab.uri = r.uri;
    markSaved(app, tab, doc);
    addRecent(app, tab);
    await kvSet('file:' + docKey(tab), { name: r.name, data: await blob.arrayBuffer(), uri: r.uri, when: Date.now() });
    await snapshot(app, tab, 'Saved', doc);
  }
  toast(`Saved ${r.name}`);
  return true;
}

function markSaved(app: App, tab: DocTab, doc: PMNode) {
  tab.saved = Date.now();
  // Edits made while the file was being written are not in it: the tab stays unsaved and keeps its draft.
  if (tab.view.state.doc.eq(doc)) { tab.dirty = false; kvDel('draft:' + tab.id); } else app.scheduleAutosave();
  app.ui.tabsChanged();
  document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – Anne\'s Pen`;
}

function hasRichContent(doc: PMNode): boolean {
  let rich = false;
  doc.descendants((n) => {
    if (rich) return false;
    if (n.type === N.table || n.type === N.image || n.type === N.footnote || n.type === N.field || (n.isText && n.marks.some((m) => !['bold', 'italic', 'code', 'link', 'strike'].includes(m.type.name)))) rich = true;
    return true;
  });
  return rich;
}

/** Browsers keep Ctrl+N, Ctrl+W, Ctrl+T and their Shift forms for themselves: the web build lists an
 *  alternative first (shown in tooltips and menus) and keeps the usual keys for installed windows. */
export function webKeys(keys: string[], alt: string): string[] {
  return isNative() ? keys : [alt, ...keys];
}

def([
  {
    id: 'file.new', label: 'New Document', icon: 'note_add', tab: 'Backstage', group: 'New', keys: webKeys(['Mod-n'], 'Alt-n'), popular: true, noRecord: true,
    run: (app, arg) => {
      const t = TEMPLATES.find((x) => x.id === arg);
      const prev = app.tab && isPristine(app.tab) ? app.tab : null;
      if (t && t.id !== 'blank') {
        const tab = app.createTab(t.build(app.prefs.author), { title: t.name });
        app.updateFields(tab);
        app.exec('refs.updateGenerated');
        if (prev) app.closeTab(prev);
        app.activate(tab);
        app.ui.hideBackstage();
        return;
      }
      if (prev) { app.ui.hideBackstage(); app.focus(); return; }
      const tab = app.createTab();
      try { const d = JSON.parse(localStorage.getItem('quillpen.defaultDesign') || 'null'); if (d) app.updateSettings((s) => { s.styleSet = d.styleSet; s.theme = d.theme; s.styles = d.styles; }, tab); } catch { /* */ }
      app.ui.hideBackstage();
    },
  },
  { id: 'file.newFromTemplate', label: 'New from Template…', icon: 'library_books', tab: 'Backstage', group: 'New', noRecord: true, run: (app) => app.ui.showBackstage('new') },
  {
    id: 'file.open', label: 'Open…', icon: 'folder_open', tab: 'Backstage', group: 'Open', keys: ['Mod-o', 'Mod-F12'], popular: true, noRecord: true,
    run: async (app) => {
      const f = await openDocument(OPEN_ACCEPT, OPEN_MIMES);
      if (!f) return;
      await openBuffer(app, f.data, f.name, f.uri);
      app.ui.hideBackstage();
    },
  },
  {
    id: 'file.openRepair', label: 'Open and Repair…', icon: 'healing', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Open a damaged document: rebuild its package from raw bytes, repair its XML, and show what was recovered',
    keywords: 'corrupt damaged recover fix broken',
    run: async (app) => {
      const f = await openDocument('*/*', ['*/*']);
      if (!f) return;
      const tab = await openBuffer(app, f.data, f.name, f.uri, { repair: true });
      app.ui.hideBackstage();
      if (tab?.recovery) await showRecoveryReport(tab.recovery, { openText: (t) => openRecoveredText(app, t, f.name) });
    },
  },
  {
    id: 'file.recoverText', label: 'Recover Text from Any File…', icon: 'text_snippet', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Extract readable text from any file: damaged documents, .doc/.wbk/.asd/.tmp files, or unknown data',
    keywords: 'corrupt salvage strings extract',
    run: async (app) => {
      const f = await openDocument('*/*', ['*/*']);
      if (!f) return;
      const tab = await openBuffer(app, f.data, f.name, null, { textOnly: true });
      app.ui.hideBackstage();
      if (tab?.recovery) toast(recoverySummary(tab.recovery), { action: 'Details', onAction: () => app.exec('file.recoveryReport') });
    },
  },
  {
    id: 'file.recoveryReport', label: 'Recovery Report', icon: 'fact_check', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Show how the current document was recovered',
    isEnabled: (app) => !!app.tab?.recovery,
    run: async (app) => {
      const r = app.tab?.recovery;
      if (!r) { toast('This document was not recovered from a damaged file.'); return; }
      await showRecoveryReport(r, { openText: (t) => openRecoveredText(app, t, r.fileName) });
    },
  },
  { id: 'file.recoveryHelp', label: 'Manual Recovery Options', icon: 'support', tab: 'Backstage', group: 'Open', noRecord: true, tip: 'AutoRecover locations, version history, and other ways to get a lost document back', run: () => showManualRecovery() },
  {
    id: 'file.openRecent', label: 'Open Recent', icon: 'history', tab: 'Backstage', group: 'Open', kind: 'menu', noRecord: true,
    run: async (app, key) => {
      if (!key) return app.ui.showBackstage('open');
      const rec = app.prefs.recent.find((r) => r.key === key);
      if (!rec) return;
      const existing = app.docs.find((d) => docKey(d) === key);
      if (existing) { app.activate(existing); app.ui.hideBackstage(); return; }
      let f = rec.uri ? await readUri(rec.uri) : null;
      if (!f) { const cached = await kvGet('file:' + key); if (cached) f = { name: cached.name, data: cached.data, uri: cached.uri }; }
      if (!f) { toast('That file is no longer available. Use Open to locate it.'); return; }
      // Keep the entry's key (its snapshots and notes); old name-only keys collided, so those get a new one.
      const legacy = key.startsWith('local:');
      const tab = await openBuffer(app, f.data, f.name, f.uri, { key: legacy ? undefined : key });
      if (tab && legacy && docKey(tab) !== key) { app.prefs.recent = app.prefs.recent.filter((r) => r.key !== key); app.savePrefs(); }
      app.ui.hideBackstage();
    },
    menu: (app) => app.prefs.recent.slice(0, 12).map((r) => ({ id: 'file.openRecent', arg: r.key, label: (r.pinned ? '📌 ' : '') + r.name })),
  },
  { id: 'file.clearRecent', label: 'Clear Unpinned Recent Documents', icon: 'delete_sweep', tab: 'Backstage', group: 'Open', noRecord: true, run: (app) => { app.prefs.recent = app.prefs.recent.filter((r) => r.pinned); app.savePrefs(); app.ui.showBackstage('open'); } },
  { id: 'file.save', label: 'Save', icon: 'save', tab: 'Backstage', group: 'Save', keys: ['Mod-s', 'Shift-F12'], popular: true, noRecord: true, run: (app) => saveTab(app, app.tab) },
  { id: 'file.saveAs', label: 'Save As…', icon: 'save_as', tab: 'Backstage', group: 'Save', keys: ['F12'], popular: true, noRecord: true, run: (app) => app.ui.showBackstage('saveas') },
  { id: 'file.saveAll', label: 'Save All', icon: 'library_add_check', tab: 'Backstage', group: 'Save', noRecord: true, run: async (app) => { for (const d of app.docs) if (d.dirty) await saveTab(app, d); } },
  {
    id: 'file.saveAsFormat', label: 'Save As Format', icon: 'save_as', tab: 'Backstage', group: 'Save', internal: true, noRecord: true,
    run: async (app, format: string) => {
      if (format === 'pdf') return app.exec('file.exportPdf');
      if (format === 'qpde') return app.exec('file.encrypt');
      await saveTab(app, app.tab, { as: true, format });
      app.ui.hideBackstage();
    },
  },
  {
    id: 'file.saveTemplate', label: 'Save as Template', icon: 'bookmark_add', tab: 'Backstage', group: 'Save', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Save as Template', fields: [{ key: 'name', label: 'Template name', type: 'text', value: app.tab.title }, { key: 'cat', label: 'Category', type: 'text', value: 'My Templates' }] });
      if (!r?.name) return;
      await kvSet(`tpl:${r.name}`, { name: r.name, category: r.cat, json: app.state.doc.toJSON(), when: Date.now() });
      toast(`Template "${r.name}" saved`);
    },
  },
  { id: 'file.autosave', label: 'AutoSave', icon: 'autorenew', tab: 'Backstage', group: 'Save', kind: 'toggle', noRecord: true, run: (app) => { app.prefs.autosave = !app.prefs.autosave; app.savePrefs(); toast(app.prefs.autosave ? 'AutoSave on (drafts saved automatically)' : 'AutoSave off'); }, isActive: (app) => app.prefs.autosave },
]);

for (const f of FORMATS.filter((x) => x.canExport && x.id !== 'pdf')) {
  def({ id: `file.export.${f.id}`, label: `Export as ${f.label}`, icon: 'ios_share', tab: 'Backstage', group: 'Export', noRecord: true, run: (app) => saveTab(app, app.tab, { copy: true, format: f.id }) });
}

def([
  {
    id: 'file.print', label: 'Print…', icon: 'print', tab: 'Backstage', group: 'Print', keys: ['Mod-p'], popular: true, noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const prev = tab.viewMode;
      if (prev !== 'print') app.setViewMode('print');
      app.ui.hideBackstage();
      app.updateFields(tab);
      await new Promise((r) => setTimeout(r, prev !== 'print' ? 700 : 150));
      app.ui.updatePrintCss(tab);
      await printDocument(tab.displayName);
      if (prev !== 'print') setTimeout(() => app.setViewMode(prev), 500);
    },
  },
  { id: 'file.quickPrint', label: 'Quick Print', icon: 'print', tab: 'Backstage', group: 'Print', noRecord: true, run: (app) => app.exec('file.print') },
  { id: 'file.printPreview', label: 'Print Preview', icon: 'preview', tab: 'Backstage', group: 'Print', keys: ['Mod-Alt-i'], noRecord: true, run: (app) => { app.setViewMode('print'); app.setZoom(1, 'onePage'); app.ui.hideBackstage(); toast('Print preview: whole page view. Use View ▸ Print Layout to edit.'); } },
  { id: 'file.exportPdf', label: 'Export as PDF', icon: 'picture_as_pdf', tab: 'Backstage', group: 'Export', popular: true, noRecord: true, run: (app) => { toast('In the print dialog choose "Save as PDF".'); app.exec('file.print'); } },
  {
    id: 'file.share', label: 'Share…', icon: 'share', tab: 'Backstage', group: 'Share', popular: true, noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Share', fields: [{ key: 'fmt', label: 'Send as', type: 'radio', options: [...FORMATS.filter((f) => f.canExport && f.id !== 'pdf').map((f) => ({ value: f.id, label: f.label })), { value: 'pdf', label: 'PDF (via print service)' }], value: 'docx' }] });
      if (!r) return;
      if (r.fmt === 'pdf') return app.exec('file.exportPdf');
      const fmt = formatById(r.fmt)!;
      const name = `${(app.tab.fileName || app.tab.title).replace(/\.[^.]+$/, '')}.${fmt.ext[0]}`;
      const blob = await exportFile(app.state.doc, r.fmt, { fileName: name, author: app.prefs.author, title: app.tab.title });
      await shareFile(blob, name, app.tab.title);
    },
  },
  { id: 'file.email', label: 'Email as Attachment', icon: 'attach_email', tab: 'Backstage', group: 'Share', noRecord: true, run: (app) => app.exec('file.share') },
  {
    id: 'file.close', label: 'Close Document', icon: 'close', tab: 'Backstage', group: 'Close', keys: webKeys(['Mod-w', 'Mod-F4'], 'Alt-w'), popular: true, noRecord: true,
    run: async (app, arg) => {
      const tab = app.docs.find((d) => d.id === arg) || app.tab;
      if (tab.dirty && app.prefs.confirmClose) {
        const c = await choiceDialog('Save Changes?', `Save changes to "${tab.displayName}" before closing?`, ['Save', "Don't Save"]);
        if (c < 0) return;
        if (c === 0 && !(await saveTab(app, tab))) return;
      }
      app.closeTab(tab);
      app.ui.hideBackstage();
    },
  },
  { id: 'file.closeAll', label: 'Close All Documents', icon: 'tab_close', tab: 'Backstage', group: 'Close', noRecord: true, run: async (app) => { for (const d of [...app.docs]) { app.activate(d); await app.exec('file.close', d.id); } } },
  {
    id: 'file.revert', label: 'Revert to Saved', icon: 'settings_backup_restore', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const cached = await kvGet('file:' + docKey(tab));
      if (!cached) { toast('No saved version to revert to.'); return; }
      if (tab.encryption) { toast('Close an encrypted document and open it again to revert it.'); return; }
      if (!(await confirmDialog('Revert', 'Discard all changes since the last save?'))) return;
      const { doc } = await importFile(cached.data, cached.name);
      app.replaceDoc(tab, doc); tab.dirty = false; app.ui.tabsChanged();
    },
  },
  { id: 'file.exit', label: 'Exit', icon: 'logout', tab: 'Backstage', group: 'Close', noRecord: true, run: async (app) => { for (const d of app.docs) if (d.dirty) { await app.saveDrafts(); break; } const { App: CapApp } = await import('@capacitor/app'); try { await CapApp.exitApp(); } catch { window.close(); } } },
]);

// Info ---------------------------------------------------------------------------------------
def([
  {
    id: 'file.properties', label: 'Properties…', icon: 'info', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      const p = app.settings.properties;
      const st = app.state;
      const words = countWords(docText(st.doc));
      const r = await openDialog({ title: 'Document Properties', wide: true, fields: [
        { key: 'title', label: 'Title', type: 'text', value: p.title }, { key: 'subject', label: 'Subject', type: 'text', value: p.subject },
        { key: 'author', label: 'Author', type: 'text', value: p.author || app.prefs.author, half: true }, { key: 'manager', label: 'Manager', type: 'text', value: p.manager, half: true },
        { key: 'company', label: 'Company', type: 'text', value: p.company, half: true }, { key: 'category', label: 'Category', type: 'text', value: p.category, half: true },
        { key: 'keywords', label: 'Tags / keywords', type: 'text', value: p.keywords }, { key: 'status', label: 'Status', type: 'text', value: p.status },
        { key: 'comments', label: 'Comments', type: 'textarea', rows: 3, value: p.comments },
        { key: 'custom', label: 'Custom properties (name=value per line)', type: 'textarea', rows: 3, value: Object.entries(app.settings.customProps).map(([k, x]) => `${k}=${x}`).join('\n') },
        { key: 'stats', type: 'info', html: `<p class="qf-help">Words: ${words} · Created: ${new Date(app.tab.created).toLocaleString()} · Saved: ${app.tab.saved ? new Date(app.tab.saved).toLocaleString() : '—'} · Editing time: ${Math.round((Date.now() - app.tab.editStart) / 60000)} min</p>` },
      ] });
      if (!r) return;
      app.updateSettings((s) => {
        Object.assign(s.properties, { title: r.title, subject: r.subject, author: r.author, manager: r.manager, company: r.company, category: r.category, keywords: r.keywords, status: r.status, comments: r.comments });
        s.customProps = Object.fromEntries(String(r.custom).split('\n').map((l) => l.split('=')).filter((x) => x[0]?.trim()).map(([k, ...rest]) => [k.trim(), rest.join('=').trim()]));
      });
      app.updateFields();
    },
  },
  {
    id: 'file.inspect', label: 'Inspect Document…', icon: 'policy', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      if (refuseIfProtected(app)) return;
      const st = app.state;
      const s = app.settings;
      let hidden = 0, ink = 0;
      st.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type === schema.marks.hidden)) hidden++; if (n.type === N.paragraph && n.attrs.hidden) hidden++; if (n.type === N.image && n.attrs.editKind === 'ink') ink++; return true; });
      const changes = listChanges(st.doc).length;
      const comments = Object.keys(s.comments).length;
      const r = await openDialog({ title: 'Document Inspector', help: 'Select the content to remove before sharing.', fields: [
        { key: 'comments', label: `Comments (${comments})`, type: 'checkbox', value: comments > 0 },
        { key: 'changes', label: `Tracked changes (${changes}) — accepted`, type: 'checkbox', value: false },
        { key: 'props', label: 'Document properties and personal information', type: 'checkbox', value: true },
        { key: 'hidden', label: `Hidden text (${hidden})`, type: 'checkbox', value: hidden > 0 },
        { key: 'ink', label: `Ink drawings (${ink})`, type: 'checkbox', value: false },
        { key: 'hf', label: 'Headers, footers and watermarks', type: 'checkbox', value: false },
        { key: 'merge', label: 'Mail merge data', type: 'checkbox', value: !!s.mergeData },
      ], ok: 'Remove' });
      if (!r) return;
      // Built from the document as it is now: it may have changed while the dialog was open.
      const now = app.state;
      let tr = now.tr.setMeta('trackSkip', true);
      if (r.changes) { tr = resolveChanges(now, listChanges(now.doc), true); }
      const ns = JSON.parse(JSON.stringify(app.settings));
      if (r.comments) { ns.comments = {}; tr.doc.descendants((n, pos) => { if (n.isInline) for (const m of n.marks) if (m.type === schema.marks.comment) tr.removeMark(pos, pos + n.nodeSize, m); return true; }); }
      if (r.props) { for (const k of Object.keys(ns.properties)) ns.properties[k] = k === 'title' ? ns.properties.title : ''; ns.customProps = {}; }
      if (r.hf) { for (const k of ['header', 'footer', 'firstHeader', 'firstFooter', 'evenHeader', 'evenFooter']) ns[k] = { left: '', center: '', right: '' }; ns.watermark = null; }
      if (r.merge) { ns.mergeData = null; ns.mergePreview = null; }
      if (r.hidden || r.ink) {
        const del: [number, number][] = [];
        tr.doc.descendants((n, pos) => {
          if (r.hidden && n.isText && n.marks.some((m) => m.type === schema.marks.hidden)) del.push([pos, pos + n.nodeSize]);
          if (r.hidden && n.type === N.paragraph && n.attrs.hidden) { del.push([pos, pos + n.nodeSize]); return false; }
          if (r.ink && n.type === N.image && n.attrs.editKind === 'ink') del.push([pos, pos + 1]);
          return true;
        });
        for (const [a, b] of del.reverse()) tr.delete(a, b);
      }
      tr.setDocAttribute('settings', ns);
      if (tr.doc.childCount === 0) tr.insert(0, N.paragraph.create());
      app.view.dispatch(tr);
      toast('Document inspected and cleaned');
    },
  },
  {
    id: 'file.encrypt', label: 'Encrypt with Password…', icon: 'enhanced_encryption', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Encrypt Document', help: 'Saves an AES-256-GCM encrypted Anne\'s Pen file (.qpde). If you lose the password, the file cannot be recovered.', fields: [{ key: 'p1', label: 'Password', type: 'password' }, { key: 'p2', label: 'Confirm', type: 'password' }], validate: (x) => (!x.p1 ? 'Enter a password.' : x.p1 !== x.p2 ? 'Passwords do not match.' : null) });
      if (!r) return;
      const { newDocKey } = await import('../util/crypto');
      const tab = app.tab;
      const prev = { encryption: tab.encryption, fileName: tab.fileName };
      tab.encryption = await newDocKey(r.p1);
      tab.fileName = encryptedName(tab.fileName || tab.title);
      // From now on the document stays encrypted: Save writes the .qpde again and drafts are encrypted.
      if (!(await saveEncrypted(app, tab, true))) Object.assign(tab, prev);
      else app.ui.tabsChanged();
    },
  },
  {
    id: 'file.openEncrypted', label: 'Open Encrypted Document…', icon: 'lock_open', tab: 'Backstage', group: 'Open', noRecord: true,
    run: async (app) => {
      const f = await openDocument('.qpde,.qfde', ['application/octet-stream', '*/*']);
      if (!f) return;
      await openEncrypted(app, f);
    },
  },
  { id: 'file.versions', label: 'Version History', icon: 'history', tab: 'Backstage', group: 'Info', popular: true, noRecord: true, origin: 'Snapshots (Scrivener) / version history (online editors)', run: (app) => { app.ui.hideBackstage(); app.ui.openPane('versions'); } },
  { id: 'file.snapshot', label: 'Take Snapshot', icon: 'add_a_photo', tab: 'Backstage', group: 'Info', keys: ['Mod-Alt-5'], noRecord: true, run: async (app) => { if (app.tab.encryption) { toast('Snapshots are not kept for encrypted documents.'); return; } const r = await openDialog({ title: 'Take Snapshot', fields: [{ key: 'label', label: 'Snapshot name', type: 'text', value: `Snapshot ${new Date().toLocaleString()}` }] }); if (r) { await snapshot(app, app.tab, r.label); toast('Snapshot saved'); } } },
  {
    id: 'file.recover', label: 'Recover Unsaved Documents', icon: 'restore_page', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      // Only drafts whose window has closed: another open window's drafts are still in use.
      const keys = await orphanedDrafts((k) => app.docs.some((d) => 'draft:' + d.id === k));
      if (!keys.length) { toast('No unsaved drafts found.'); return; }
      const drafts = await Promise.all(keys.map(async (k) => ({ k, d: await kvGet(k) })));
      const r = await openDialog({ title: 'Document Recovery', fields: [{ key: 'k', label: 'Available drafts', type: 'list', multiple: true, rows: 8, options: drafts.map(({ k, d }) => ({ value: k, label: `${d.fileName || d.title} — ${new Date(d.time).toLocaleString()}` })), value: keys }], buttons: [{ label: 'Discard All', onClick: async (_v, ctl) => { for (const k of keys) await kvDel(k); ctl.close(); toast('Drafts discarded'); } }], ok: 'Recover' });
      if (!r?.k?.length) return;
      for (const { k, d } of drafts.filter((x) => r.k.includes(x.k))) {
        let json = d.json, encryption = null;
        if (d.enc) {
          const p = await openDialog({ title: 'Password', fields: [{ key: 'p', label: `Password for ${d.fileName || d.title}`, type: 'password', autofocus: true }] });
          if (!p) continue;
          try { ({ json, key: encryption } = await (await import('../util/crypto')).decryptJsonWithKey(d.enc, p.p)); } catch { toast('Wrong password or damaged draft.'); continue; }
        }
        const tab = app.createTab(schema.nodeFromJSON(json), { title: d.title, fileName: d.fileName, format: d.format, uri: d.uri, key: d.key || '', encryption } as any);
        tab.dirty = true;
        app.ui.tabsChanged();
        // The old draft goes only once the recovered document has a draft of its own.
        if ((await kvSet('draft:' + tab.id, { ...d, ...(encryption ? { enc: d.enc } : { json }), id: tab.id, owner: (await import('../util/store')).SESSION_ID, time: Date.now() })) !== false) await kvDel(k);
      }
    },
  },
]);

// Options ------------------------------------------------------------------------------------
def([
  {
    id: 'file.options', label: 'Options…', icon: 'settings', tab: 'Backstage', group: 'Options', popular: true, noRecord: true,
    run: async (app) => {
      const p = app.prefs;
      const r = await openDialog({ title: 'Anne\'s Pen Options', wide: true, fields: [
        { key: 'h1', type: 'heading', label: 'General' },
        { key: 'author', label: 'User name', type: 'text', value: p.author, half: true },
        { key: 'initials', label: 'Initials', type: 'text', value: p.initials, half: true },
        { key: 'theme', label: 'App theme', type: 'select', options: ['system', 'light', 'dark'], value: p.theme, half: true },
        { key: 'units', label: 'Measurement units', type: 'select', options: [{ value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' }, { value: 'mm', label: 'Millimeters' }, { value: 'pt', label: 'Points' }], value: p.units, half: true },
        { key: 'defaultView', label: 'Open documents in', type: 'select', options: [{ value: 'auto', label: 'Automatic (mobile view on phones)' }, { value: 'print', label: 'Print Layout' }, { value: 'mobile', label: 'Mobile View' }, { value: 'web', label: 'Web Layout' }], value: p.defaultView, half: true },
        { key: 'uiScale', label: 'Toolbar size', type: 'select', options: [{ value: '0.85', label: 'Compact' }, { value: '1', label: 'Normal' }, { value: '1.15', label: 'Large (touch)' }], value: String(p.uiScale), half: true },
        { key: 'miniToolbar', label: 'Show mini toolbar on selection', type: 'checkbox', value: p.miniToolbar, half: true },
        { key: 'qatBottom', label: 'Quick Access Bar at the bottom (near keyboard)', type: 'checkbox', value: p.qatPosition === 'bottom', half: true },
        { key: 'qatLabels', label: 'Show labels on Quick Access Bar', type: 'checkbox', value: p.qatLabels, half: true },
        { key: 'h2', type: 'heading', label: 'Save' },
        { key: 'autosave', label: 'AutoSave drafts', type: 'checkbox', value: p.autosave, half: true },
        { key: 'autosaveSeconds', label: 'Every (seconds)', type: 'number', value: p.autosaveSeconds, half: true },
        { key: 'defaultSaveFormat', label: 'Default save format', type: 'select', options: FORMATS.filter((f) => f.canExport && f.id !== 'pdf').map((f) => ({ value: f.id, label: f.label })), value: p.defaultSaveFormat, half: true },
        { key: 'confirmClose', label: 'Ask to save when closing', type: 'checkbox', value: p.confirmClose, half: true },
        { key: 'h3', type: 'heading', label: 'Proofing & Editing' },
        { key: 'spellcheck', label: 'Check spelling as you type', type: 'checkbox', value: p.spellcheck, half: true },
        { key: 'grammar', label: 'Mark grammar errors', type: 'checkbox', value: p.grammar, half: true },
        { key: 'spellDialect', label: 'English spelling', type: 'select', options: SPELL_DIALECTS, value: p.spellDialect || 'any' },
        { key: 'nativeSpellcheck', label: 'Also use the keyboard’s spell checker', type: 'checkbox', value: p.nativeSpellcheck, half: true },
        { key: 'wordCompletion', label: 'Word completion', type: 'checkbox', value: p.wordCompletion, half: true },
        { key: 'slashMenu', label: 'Type “/” for the command menu', type: 'checkbox', value: p.slashMenu, half: true },
        { key: 'pasteDefault', label: 'Default paste', type: 'select', options: [{ value: 'keep', label: 'Keep source formatting' }, { value: 'merge', label: 'Merge formatting' }, { value: 'text', label: 'Text only' }], value: p.pasteDefault, half: true },
        { key: 'clipboardHistory', label: 'Clipboard history items', type: 'number', value: p.clipboardHistory, half: true },
        { key: 'h4', type: 'heading', label: 'Customize' },
        { key: 'bq', type: 'button', label: 'Customize Quick Access Bar…', onClick: () => app.exec('file.customizeQat') },
        { key: 'br', type: 'button', label: 'Customize Tabs (Ribbon)…', onClick: () => app.exec('file.customizeRibbon') },
        { key: 'bk', type: 'button', label: 'Customize Keyboard…', onClick: () => app.exec('file.customizeKeyboard') },
        { key: 'ba', type: 'button', label: 'AutoCorrect Options…', onClick: () => app.exec('file.autocorrectOptions') },
        { key: 'bd', type: 'button', label: 'Custom Dictionary…', onClick: () => app.exec('file.customDictionary') },
        { key: 'bx', type: 'button', label: 'Export / Import All Settings…', onClick: () => app.exec('file.exportSettings') },
      ] });
      if (!r) return;
      Object.assign(p, {
        author: r.author || 'Author', initials: r.initials || (r.author || 'A')[0], theme: r.theme, units: r.units, defaultView: r.defaultView, uiScale: parseFloat(r.uiScale),
        miniToolbar: r.miniToolbar, qatPosition: r.qatBottom ? 'bottom' : 'top', qatLabels: r.qatLabels, autosave: r.autosave, autosaveSeconds: Math.max(3, r.autosaveSeconds || 10),
        defaultSaveFormat: r.defaultSaveFormat, confirmClose: r.confirmClose, spellcheck: r.spellcheck, grammar: r.grammar, nativeSpellcheck: r.nativeSpellcheck, spellDialect: r.spellDialect || 'any',
        wordCompletion: r.wordCompletion, slashMenu: r.slashMenu, pasteDefault: r.pasteDefault, clipboardHistory: r.clipboardHistory || 24,
      });
      app.savePrefs();
      app.ui.applyPrefs();
      app.proofer.schedule(app.tab, 0);
      for (const d of app.docs) d.view.setProps({});
    },
  },
  { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune', tab: 'Backstage', group: 'Options', popular: true, noRecord: true, run: (app) => app.ui.customizeQat() },
  { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt', tab: 'Backstage', group: 'Options', noRecord: true, run: (app) => app.ui.customizeRibbon() },
  { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard', tab: 'Backstage', group: 'Options', noRecord: true, run: (app) => app.ui.customizeKeyboard() },
  {
    id: 'file.autocorrectOptions', label: 'AutoCorrect Options…', icon: 'auto_fix_normal', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const a = app.prefs.autoformat;
      const labels: [keyof typeof a, string][] = [['replaceList', 'Replace text as you type (list below)'], ['capitalizeSentences', 'Capitalize first letter of sentences'], ['twoInitialCaps', 'Correct TWo INitial CApitals'], ['capitalizeDays', 'Capitalize names of days'], ['capsLock', 'Correct accidental use of cAPS LOCK'], ['smartQuotes', '"Straight quotes" with “smart quotes”'], ['dashes', 'Hyphens (--) with dashes (—)'], ['fractions', 'Fractions (1/2) with ½'], ['ordinals', 'Ordinals (1st) with superscript'], ['symbols', 'Symbols: (c) © (tm) ™ -> → ... …'], ['autoLinks', 'Internet and network paths with hyperlinks'], ['markdownBlocks', 'Automatic lists and headings (- , 1. , # , > )'], ['markdownInline', 'Markdown emphasis (**bold**, *italic*, `code`, ~~strike~~)'], ['borderLines', 'Border lines (--- *** === then Enter)']];
      const r = await openDialog({ title: 'AutoCorrect', wide: true, fields: [
        ...labels.map(([k, l]) => ({ key: String(k), label: l, type: 'checkbox' as const, value: !!a[k], half: true })),
        { key: 'quoteStyle', label: 'Quote style', type: 'select', options: [{ value: 'curly', label: '“English”' }, { value: 'german', label: '„German“' }, { value: 'guillemets', label: '«French»' }, { value: 'straight', label: '"Straight"' }], value: a.quoteStyle },
        { key: 'list', label: 'Replacements (one per line: typo => correction)', type: 'textarea', rows: 10, value: Object.entries(app.prefs.replacements).map(([k, x]) => `${k} => ${x}`).join('\n') },
      ], buttons: [{ label: 'Reset to Defaults', onClick: (_v, ctl) => { ctl.set('list', Object.entries(DEFAULT_REPLACEMENTS).map(([k, x]) => `${k} => ${x}`).join('\n')); for (const [k] of labels) ctl.set(String(k), (DEFAULT_AUTOFORMAT as any)[k]); } }] });
      if (!r) return;
      for (const [k] of labels) (a as any)[k] = r[String(k)];
      a.quoteStyle = r.quoteStyle;
      app.prefs.replacements = Object.fromEntries(String(r.list).split('\n').map((l) => l.split('=>')).filter((x) => x.length === 2 && x[0].trim()).map(([k, x]) => [k.trim(), x.trim()]));
      app.savePrefs();
    },
  },
  {
    id: 'file.customDictionary', label: 'Custom Dictionary…', icon: 'book', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Custom Dictionary', fields: [{ key: 'words', label: 'Words (one per line)', type: 'textarea', rows: 12, value: app.prefs.dictionary.join('\n') }, { key: 'ign', label: 'Ignored words (one per line)', type: 'textarea', rows: 4, value: app.prefs.ignoredWords.join('\n') }] });
      if (!r) return;
      app.prefs.dictionary = String(r.words).split('\n').map((w) => w.trim()).filter(Boolean);
      app.prefs.ignoredWords = String(r.ign).split('\n').map((w) => w.trim()).filter(Boolean);
      app.savePrefs();
      app.proofer.schedule(app.tab, 0);
    },
  },
  {
    id: 'file.exportSettings', label: 'Export / Import Settings…', icon: 'import_export', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Settings Transfer', help: 'Copy this text to back up your Quick Access Bar, custom tabs, shortcuts, macros, building blocks, AutoCorrect and preferences. Paste settings text here and choose Import to restore.', fields: [{ key: 'json', label: 'Settings (JSON)', type: 'textarea', rows: 12, value: JSON.stringify({ ...app.prefs, recent: [] }, null, 1) }], ok: 'Import', buttons: [{ label: 'Copy', onClick: (x) => { navigator.clipboard?.writeText(x.json); toast('Copied'); } }] });
      if (!r) return;
      let p: unknown;
      try { p = JSON.parse(r.json); } catch { /* reported below */ }
      if (!p || typeof p !== 'object' || Array.isArray(p)) { toast('That is not valid settings JSON.'); return; }
      // Only well-formed values are taken, and nothing is stored until the interface has rebuilt with them.
      const before = JSON.parse(JSON.stringify(app.prefs));
      const s = sanitizePrefs(p);
      if (!(await confirmImportedScripts(app, s))) return;
      Object.assign(app.prefs, s, { autoformat: { ...app.prefs.autoformat, ...(s.autoformat || {}) }, recent: app.prefs.recent });
      try { app.ui.applyPrefs(); app.ui.rebuild(); } catch (e: any) {
        Object.assign(app.prefs, before); app.ui.applyPrefs(); app.ui.rebuild();
        toast(`These settings could not be applied: ${e?.message || e}`);
        return;
      }
      app.savePrefs();
      toast('Settings imported');
    },
  },
  { id: 'file.resetCustomizations', label: 'Reset All Customizations', icon: 'restart_alt', tab: 'Backstage', group: 'Options', noRecord: true, run: async (app) => { if (!(await confirmDialog('Reset', 'Reset the Quick Access Bar, custom tabs and keyboard shortcuts to defaults?'))) return; const { DEFAULT_QAT } = await import('../prefs'); app.prefs.qat = [...DEFAULT_QAT]; app.prefs.customTabs = []; app.prefs.hiddenTabs = []; app.prefs.keymap = {}; app.savePrefs(); app.ui.rebuild(); } },
]);

/**
 * Script macros run JavaScript, so settings or macro files that bring them in ask first. Declined
 * scripts are dropped with the shortcuts, Quick Access buttons and tab items that run them; accepted
 * ones are marked untrusted and ask once more before they first run. Scripts identical to ones already
 * here stay as they are. Returns false if the import was cancelled.
 */
export async function confirmImportedScripts(app: App, s: Partial<Prefs>): Promise<boolean> {
  const isScript = (m: { steps: { id: string }[] }) => m.steps.some((st) => st.id === '__script');
  const same = (m: Prefs['macros'][number]) => app.prefs.macros.some((x) => x.name === m.name && !x.untrusted && JSON.stringify(x.steps) === JSON.stringify(m.steps));
  const scripts = (s.macros || []).filter((m) => isScript(m) && !same(m));
  if (!scripts.length) return true;
  const names = scripts.map((m) => `“${m.name}”`).join(', ');
  const c = await choiceDialog('Import Script Macros?', `This import contains ${scripts.length} script macro(s) that can run code: ${names}. Only import scripts from someone you trust. Import the scripts?`, ['Import scripts', 'Leave scripts out']);
  if (c < 0) return false;
  if (c === 0) { for (const m of scripts) m.untrusted = true; return true; }
  const dropped = new Set(scripts.map((m) => `macro:${m.name}`));
  s.macros = s.macros!.filter((m) => !scripts.includes(m));
  if (s.keymap) s.keymap = Object.fromEntries(Object.entries(s.keymap).filter(([, id]) => !dropped.has(id)));
  if (s.qat) s.qat = s.qat.filter((id) => !dropped.has(id));
  if (s.pinnedCommands) s.pinnedCommands = s.pinnedCommands.filter((id) => !dropped.has(id));
  if (s.customTabs) s.customTabs = s.customTabs.map((t) => ({ ...t, groups: t.groups.map((g) => ({ ...g, items: g.items.filter((id) => !dropped.has(id)) })) }));
  return true;
}

// Help -------------------------------------------------------------------------------------------
def([
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', tab: 'Help', group: 'Help', keys: ['Mod-/'], noRecord: true, run: (app) => app.ui.showShortcuts() },
  { id: 'help.commands', label: 'Command Reference', icon: 'menu_book', tab: 'Help', group: 'Help', noRecord: true, run: (app) => app.ui.showCommandReference() },
  { id: 'help.tour', label: 'Show the Quick Tour', icon: 'tour', tab: 'Help', group: 'Help', noRecord: true, run: (app) => app.ui.tour() },
  {
    id: 'help.about', label: 'About Anne\'s Pen', icon: 'info', tab: 'Help', group: 'Help', noRecord: true,
    run: () => alertDialog('About Anne\'s Pen', h('div', { class: 'qf-msg' },
      h('p', null, h('b', null, `Anne\'s Pen ${__APP_VERSION__}`), ' — an original, open-source word processor (MIT License).'),
      h('p', null, `${commandCount()} commands, every one available to the Quick Access Bar, custom tabs, keyboard shortcuts, macros and command search.`),
      h('p', null, 'Anne\'s Pen is not affiliated with, endorsed by, or sponsored by Microsoft, Google, Apple, Corel, The Document Foundation, or any other vendor. Product names are used only to describe file-format compatibility.'),
      h('p', null, 'Open-source components: ProseMirror (MIT), prosemirror-tables (MIT), JSZip (MIT/GPLv3 dual), KaTeX (MIT), nspell (MIT) with the SCOWL American, British, Canadian and Australian English Hunspell dictionaries (MIT and BSD-style), Material Symbols (Apache 2.0), Capacitor (MIT), fonts Carlito, Caladea, Gelasio, EB Garamond, Courier Prime, Libre Baskerville, Lato, Merriweather, Open Sans (SIL OFL 1.1) and Tinos, Arimo, Cousine (Apache 2.0). Their licenses are in Help ▸ Third-Party Notices.'),
    )),
  },
  {
    id: 'help.notices', label: 'Third-Party Notices', icon: 'license', tab: 'Help', group: 'Help', noRecord: true,
    run: async () => {
      let text = '';
      try { const r = await fetch('./third-party-notices.txt'); if (r.ok) text = await r.text(); } catch { /* offline web build without the file */ }
      await alertDialog('Third-Party Notices', h('pre', { class: 'qf-notices' }, text || 'The notices file is missing from this build. The licenses are listed at https://github.com/socrtwo/annes-pen/blob/main/docs/LEGAL.md.'));
    },
  },
  { id: 'help.feedback', label: 'Report an Issue', icon: 'bug_report', tab: 'Help', group: 'Help', noRecord: true, run: () => openExternal('https://github.com/socrtwo/annes-pen/issues') },
  { id: 'help.whatsNew', label: 'What’s New', icon: 'new_releases', tab: 'Help', group: 'Help', noRecord: true, run: () => alertDialog(`What’s New in ${__APP_VERSION__.split('.').slice(0, 2).join('.')}`, 'QuillPen is now Anne\'s Pen. Settings, drafts, AI keys, recent files and .qpd/.qpde documents carry over, and files from the earlier QuillForge name (.qfd/.qfde) still open. The sister apps are now Anne\'s Grid, Anne\'s Post and Anne\'s Stage.\nVersion 0.4 opened documents from every major word processor, current and historical, identified by their content: Word 1–95 and Word for DOS and Mac, WordPerfect, Works, Write, Ami Pro, MacWrite, WordStar, XyWrite, HWP and HWPX, Word 2003 XML, OpenOffice 1.x, AbiWord, KWord, Pages, FictionBook, DocBook, LaTeX and more. Spreadsheets, presentations and email can be imported or handed to the sister apps.\nVersion 0.3: Anne\'s Pen runs on Windows, macOS, Linux, Raspberry Pi OS, ChromeOS, iOS and the web as well as Android (see the Releases page). Review ▸ Spelling Dictionaries downloads free dictionaries for 90+ languages, verified and kept offline, checked with Hunspell. Desktop apps save straight back to your files and keep API keys in the system keychain; the web app works offline and can be installed.\nVersion 0.2.1: spelling accepts every variety of English, AI keeps the author’s variety, recovery fixes, and Help ▸ Third-Party Notices.\nVersion 0.2 added recovery of damaged documents (Word Recovery engine), the AI tab with 67 commands, a free on-device model and a setup wizard for AI providers, and Word 97–2003 .doc files. Version 0.1 introduced the full command library, customizable Quick Access Bar and tabs, Print Layout, DOCX/ODT/RTF/HTML/Markdown/EPUB/TXT, track changes, comments, references, mail merge and macros.') }, // rename:keep — names the former names on purpose
]);
