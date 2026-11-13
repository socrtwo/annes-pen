/**
 * @vitest-environment-options { "url": "https://annespen.test/" }
 */
// Regression tests for fix worker D2: drafts, storage, encryption, settings import, links, dialogs,
// stale transactions, AI preview and SSE, CSV, protection passwords.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';

const dlg = vi.hoisted(() => ({ open: null as null | ((o: any) => any), choice: null as null | ((...a: any[]) => any), confirm: null as null | ((...a: any[]) => any) }));
vi.mock('../../src/ui/dialog', async (importOriginal) => {
  const o = await importOriginal<typeof import('../../src/ui/dialog')>();
  return {
    ...o,
    openDialog: (x: any) => (dlg.open ? dlg.open(x) : o.openDialog(x)),
    choiceDialog: (...a: any[]) => (dlg.choice ? dlg.choice(...a) : (o.choiceDialog as any)(...a)),
    confirmDialog: (...a: any[]) => (dlg.confirm ? dlg.confirm(...a) : (o.confirmDialog as any)(...a)),
  };
});
const saved = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));
vi.mock('../../src/platform/native', async (importOriginal) => {
  const o = await importOriginal<typeof import('../../src/platform/native')>();
  return { ...o, saveAs: vi.fn(async (blob: Blob, name: string) => { saved.blobs.push({ blob, name }); return { uri: null, name }; }), writeBack: vi.fn(async () => false) };
});

import '../../src/commands';
import { schema } from '../../src/editor/schema';
import { App, type DocTab } from '../../src/app';
import { openDialog, focusables } from '../../src/ui/dialog';
import { kvSet, kvGet, kvDel, kvLastError, _setDbForTest, sessionAlive, orphanedDrafts, SESSION_ID, SESSION_STALE_MS } from '../../src/util/store';
import { parseCsv, toCsv } from '../../src/commands/mailings';
import { csvSafe, runMacro } from '../../src/commands/developer';
import { openBuffer, saveTab } from '../../src/commands/file';
import { mergePrefs, defaultPrefs } from '../../src/prefs';
import { encryptJson, decryptJson, hashPassword, verifyPassword, legacyPasswordHash, isEncryptedDoc } from '../../src/util/crypto';
import { sha } from '../../src/commands/review';
import { chatHistory, showAiPreview } from '../../src/ui/aiPane';
import { chat } from '../../src/ai/client';
import { reloadAiSettings, setApiKey } from '../../src/ai/store';

const S = schema;
const P = (...c: (string | PMNode)[]) => S.nodes.paragraph.create(null, c.map((x) => (typeof x === 'string' ? S.text(x) : x)));
const doc = (...blocks: PMNode[]) => S.node('doc', null, blocks);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeApp(): App {
  const app = new App(document.createElement('div'));
  const noop = () => {};
  app.ui = new Proxy({
    mountTab(tab: DocTab) {
      tab.el = document.createElement('div');
      tab.page = document.createElement('div');
      tab.mount = document.createElement('div');
      tab.page.appendChild(tab.mount);
      tab.el.appendChild(tab.page);
      document.body.appendChild(tab.el);
    },
  } as any, { get: (t, k) => (k in t ? t[k] : noop) });
  app.prefs.spellcheck = false;
  app.prefs.grammar = false;
  return app;
}

beforeEach(() => { dlg.open = dlg.choice = dlg.confirm = null; saved.blobs = []; });
afterEach(() => { vi.unstubAllGlobals(); document.querySelectorAll('.qf-overlay').forEach((o) => o.remove()); });

describe('1. drafts belong to their window', () => {
  it('a draft of a live window is not orphaned; a stale or ownerless one is', async () => {
    localStorage.clear();
    const other = 'sOTHER';
    localStorage.setItem('annespen.session.' + other, String(Date.now()));
    await kvSet('draft:a', { owner: other, json: {} });
    await kvSet('draft:b', { json: {} }); // from before sessions
    await kvSet('draft:c', { owner: SESSION_ID, json: {} });
    await kvSet('draft:d', { owner: 'sGONE', json: {} });
    localStorage.setItem('annespen.session.sGONE', String(Date.now() - SESSION_STALE_MS - 1000));
    expect((await orphanedDrafts()).sort()).toEqual(['draft:b', 'draft:d']);
    expect(await sessionAlive(other, Date.now() + SESSION_STALE_MS + 1)).toBe(false);
  });
  it('uses Web Locks where they exist', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: { query: async () => ({ held: [{ name: 'annespen-session-sLOCK' }], pending: [] }) } });
    expect(await sessionAlive('sLOCK')).toBe(true);
    expect(await sessionAlive('sNOLOCK')).toBe(false);
  });
  it('saveDrafts tags drafts with this window', async () => {
    localStorage.clear();
    const app = makeApp();
    const tab = app.createTab(doc(P('hello')));
    tab.view.dispatch(tab.view.state.tr.insertText('x', 1));
    await app.saveDrafts();
    expect((await kvGet('draft:' + tab.id)).owner).toBe(SESSION_ID);
  });
  it('preferences from another window are merged, not overwritten', () => {
    const local = { ...defaultPrefs(), dictionary: ['alpha'], recent: [{ key: 'k1', name: 'One', when: 1 }], macros: [{ name: 'm1', steps: [], created: 1 }], theme: 'light' as const };
    const remote = { ...defaultPrefs(), dictionary: ['beta'], recent: [{ key: 'k2', name: 'Two', when: 2 }], macros: [{ name: 'm2', steps: [], created: 2 }], theme: 'dark' };
    const m = mergePrefs(local, remote);
    expect(m.dictionary.sort()).toEqual(['alpha', 'beta']);
    expect(m.recent.map((r) => r.key)).toEqual(['k2', 'k1']);
    expect(m.macros.map((x) => x.name).sort()).toEqual(['m1', 'm2']);
    expect(m.theme).toBe('dark');
  });
});

describe('2. key-value store settles and reports failures', () => {
  afterEach(() => _setDbForTest(null));
  it('an aborted transaction (quota) resolves false', async () => {
    const tx: any = { objectStore: () => ({ put() { setTimeout(() => { tx.error = { name: 'QuotaExceededError' }; tx.onabort?.(); }, 0); }, delete() { setTimeout(() => tx.oncomplete?.(), 0); } }) };
    _setDbForTest({ transaction: () => tx } as any);
    expect(await kvSet('x', { a: 1 })).toBe(false);
    expect(kvLastError()).toBe('QuotaExceededError');
    expect(await kvDel('x')).toBe(true);
    _setDbForTest({ transaction: () => { throw new DOMException('closing', 'InvalidStateError'); } } as any);
    expect(await kvSet('x', 1)).toBe(false);
  });
  it('the localStorage fallback keeps binary data and reports quota errors', async () => {
    _setDbForTest(null);
    const data = new Uint8Array([1, 2, 3, 250]).buffer;
    expect(await kvSet('file:t', { name: 'a', data })).toBe(true);
    const back = await kvGet('file:t');
    expect(back.data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(back.data)]).toEqual([1, 2, 3, 250]);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(await kvSet('x', 1)).toBe(false);
    expect(kvLastError()).toBe('QuotaExceededError');
    set.mockRestore();
  });
  it('"Draft saved" reflects the outcome', async () => {
    const app = makeApp();
    const status = vi.fn();
    (app.ui as any).status = status;
    const tab = app.createTab(doc(P('hello')));
    tab.view.dispatch(tab.view.state.tr.insertText('x', 1));
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await app.saveDrafts();
    set.mockRestore();
    expect(status).toHaveBeenLastCalledWith('Draft could not be saved: storage full');
    await app.saveDrafts();
    expect(status).toHaveBeenLastCalledWith('Draft saved');
  });
});

describe('3. recovering a draft keeps a draft until it is saved again', () => {
  it('writes the recovered tab\'s draft before removing the old one', async () => {
    localStorage.clear();
    await kvSet('draft:old', { id: 'old', json: doc(P('recovered text')).toJSON(), title: 'R', fileName: 'r.docx', format: 'docx', uri: null, time: 1 });
    const app = makeApp();
    app.createTab();
    dlg.open = async (o: any) => ({ k: o.fields[0].value });
    await app.exec('file.recover');
    const tab = app.docs.find((d) => d.view.state.doc.textContent === 'recovered text')!;
    expect(tab).toBeTruthy();
    expect(await kvGet('draft:old')).toBeUndefined();
    expect((await kvGet('draft:' + tab.id)).json).toBeTruthy();
  });
});

describe('4. encrypted documents stay encrypted', () => {
  it('opens a .qfde, saves it again as an encrypted .qpde, and never stores plain drafts', async () => {
    localStorage.clear();
    const app = makeApp();
    const data = await encryptJson(doc(P('secret words')).toJSON(), 'pw');
    dlg.open = async () => ({ p: 'pw' });
    const tab = (await openBuffer(app, data.buffer as ArrayBuffer, 'Old.qfde', null))!;
    expect(tab.encryption).toBeTruthy();
    expect(tab.fileName).toBe('Old.qpde');
    tab.view.dispatch(tab.view.state.tr.insertText('more ', 1));
    await app.saveDrafts();
    const draft = await kvGet('draft:' + tab.id);
    expect(draft.json).toBeUndefined();
    expect(JSON.stringify(localStorage)).not.toContain('secret');
    expect(await saveTab(app, tab)).toBe(true);
    const out = saved.blobs.at(-1)!;
    expect(out.name).toBe('Old.qpde');
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    expect(isEncryptedDoc(bytes)).toBe(true);
    expect(S.nodeFromJSON(await decryptJson(bytes, 'pw')).textContent).toBe('more secret words');
    expect(tab.dirty).toBe(false);
  });
});

describe('5. imported script macros ask first', () => {
  const json = JSON.stringify({ macros: [{ name: 'x', steps: [{ id: '__script', arg: 'globalThis.__ran = 1' }] }, { name: 'plain', steps: [{ id: 'fmt.bold' }] }], keymap: { 'Mod-b': 'macro:x', 'Mod-j': 'macro:plain' }, qat: ['file.save', 'macro:x'] });
  it('declining leaves the scripts and what runs them out', async () => {
    const app = makeApp();
    app.createTab();
    dlg.open = async () => ({ json });
    dlg.choice = vi.fn(async () => 1);
    await app.exec('file.exportSettings');
    expect(dlg.choice).toHaveBeenCalledOnce();
    expect(String((dlg.choice as any).mock.calls[0][1])).toMatch(/1 script macro\(s\) that can run code: “x”/);
    expect(app.prefs.macros.map((m) => m.name)).toEqual(['plain']);
    expect(app.prefs.keymap).toEqual({ 'Mod-j': 'macro:plain' });
    expect(app.prefs.qat).toEqual(['file.save']);
  });
  it('accepted scripts are untrusted until confirmed on first run', async () => {
    const app = makeApp();
    app.createTab();
    dlg.open = async () => ({ json });
    dlg.choice = async () => 0;
    await app.exec('file.exportSettings');
    const m = app.prefs.macros.find((x) => x.name === 'x')!;
    expect(m.untrusted).toBe(true);
    (globalThis as any).__ran = 0;
    dlg.confirm = vi.fn(async () => false);
    await runMacro(app, m);
    expect((globalThis as any).__ran).toBe(0);
    dlg.confirm = vi.fn(async () => true);
    await runMacro(app, m);
    expect((globalThis as any).__ran).toBe(1);
    expect(app.prefs.macros.find((x) => x.name === 'x')!.untrusted).toBeUndefined();
    dlg.confirm = vi.fn(async () => false);
    await runMacro(app, app.prefs.macros.find((x) => x.name === 'x')!);
    expect(dlg.confirm).not.toHaveBeenCalled();
  });
});

describe('6. links never navigate the app', () => {
  it('cancels the click on a link in the document', () => {
    const app = makeApp();
    const tab = app.createTab(doc(P(S.text('site', [S.marks.link.create({ href: 'other.html' })]))));
    const a = tab.view.dom.querySelector('a')!;
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('7. dialogs trap focus and make the page inert', () => {
  it('wraps Tab and Shift+Tab, sets inert on the app, and returns focus', async () => {
    const root = document.createElement('div');
    root.id = 'app';
    const before = document.createElement('button');
    root.appendChild(before);
    document.body.appendChild(root);
    before.focus();
    const p = openDialog({ title: 'T', fields: [{ key: 'a', type: 'text', label: 'A' }] });
    const box = document.querySelector<HTMLElement>('.qf-dialog')!;
    expect(root.inert || root.hasAttribute('inert')).toBe(true);
    const list = focusables(box);
    expect(list.length).toBeGreaterThan(2);
    list[list.length - 1].focus();
    const tab = (shiftKey: boolean) => { const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }); document.activeElement!.dispatchEvent(e); return e; };
    expect(tab(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[0]);
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[list.length - 1]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await p).toBeNull();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(before);
    root.remove();
  });
});

describe('8. commands waiting on a dialog apply to the document as it is', () => {
  it('Select Similar Formatting after typing in the document', async () => {
    const app = makeApp();
    const tab = app.createTab(doc(P('one'), P('two')));
    tab.view.dispatch(tab.view.state.tr.setSelection(TextSelection.create(tab.view.state.doc, 2)));
    let release!: (v: any) => void;
    dlg.open = () => new Promise((r) => { release = r; });
    const run = app.exec('edit.selectSimilar') as Promise<void>;
    await tick();
    tab.view.dispatch(tab.view.state.tr.insertText('typed ', 1));
    release({ act: 'highlight' });
    await run;
    let marked = '';
    tab.view.state.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type === S.marks.highlight)) marked += n.text + '|'; return true; });
    expect(marked).toBe('typed one|two|');
  });
  it('a transaction built before a change is refused, not thrown', () => {
    const app = makeApp();
    const tab = app.createTab(doc(P('abc')));
    const stale = tab.view.state.tr.insertText('X', 1);
    tab.view.dispatch(tab.view.state.tr.insertText('Y', 1));
    expect(() => tab.view.dispatch(stale)).not.toThrow();
    expect(tab.view.state.doc.textContent).toBe('Yabc');
  });
  it('trackPositions maps positions through later edits', () => {
    const app = makeApp();
    const tab = app.createTab(doc(P('abc')));
    const pt = app.trackPositions(tab);
    tab.view.dispatch(tab.view.state.tr.insertText('12', 1));
    expect(pt.map(2)).toBe(4);
    pt.done();
    expect(tab.posTrackers.size).toBe(0);
  });
  it('Convert Text to Table uses the text as it is after the dialog', async () => {
    const app = makeApp();
    const tab = app.createTab(doc(P('a,b'), P('c,d')));
    tab.view.dispatch(tab.view.state.tr.setSelection(TextSelection.create(tab.view.state.doc, 1, 9)));
    let release!: (v: any) => void;
    dlg.open = () => new Promise((r) => { release = r; });
    const run = app.exec('table.fromText') as Promise<void>;
    await tick();
    tab.view.dispatch(tab.view.state.tr.insertText('z', 1));
    release({ sep: ',', header: false });
    await run;
    expect(tab.view.state.doc.firstChild!.type.name).toBe('table');
    expect(tab.view.state.doc.firstChild!.textContent).toBe('zabcd');
  });
  it('edit positions are kept per document', () => {
    const app = makeApp();
    const a = app.createTab(doc(P('aaa')));
    a.view.dispatch(a.view.state.tr.insertText('x', 2));
    const b = app.createTab(doc(P('bbb')));
    expect(app.editPositions).toEqual([]);
    app.activate(a);
    expect(app.editPositions.length).toBe(1);
  });
});

describe('9. AI preview, history and streaming', () => {
  it('shows the error instead of "(empty response)"', async () => {
    const app = makeApp();
    app.createTab();
    const p = showAiPreview(app, { title: 'Rewrite', primary: 'insert', generate: async () => { throw new Error('Invalid API key'); } });
    await tick(10);
    const out = document.querySelector('.qf-ai-out')!;
    expect(out.textContent).toContain('Invalid API key');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await p;
  });
  it('leaves failed and empty answers out of the history', () => {
    const msgs = chatHistory([
      { role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2' }, { role: 'assistant', text: '⚠ boom', failed: true },
      { role: 'user', text: 'q3' }, { role: 'assistant', text: '' },
    ] as any);
    expect(msgs).toEqual([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  });
  it('keeps a final SSE event that has no blank line after it', async () => {
    localStorage.setItem('quillpen.ai.v1', JSON.stringify({ active: 'groq', providers: { groq: { id: 'groq', model: 'openai/gpt-oss-120b' } } }));
    reloadAiSettings();
    await setApiKey('groq', 'gsk_test');
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}')); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const r = await chat({ messages: [{ role: 'user', content: 'x' }], onToken: () => {} });
    expect(r.text).toBe('Hello');
  });
});

describe('10-11. CSV', () => {
  it('allows blanks around quoted fields and round-trips any delimiter', () => {
    expect(parseCsv('Name,Note\nBob, "quoted, x"\n')).toEqual([['Name', 'Note'], ['Bob', 'quoted, x']]);
    expect(parseCsv('A,B\n"x" ,y\n')).toEqual([['A', 'B'], ['x', 'y']]);
    expect(parseCsv(toCsv(['A;B', 'C;D'], [['1;2', '3\t4']]))).toEqual([['A;B', 'C;D'], ['1;2', '3\t4']]);
    expect(parseCsv(toCsv(['A', 'B'], [[' padded ', 'x']]))).toEqual([['A', 'B'], [' padded ', 'x']]);
  });
  it('form data export cannot carry spreadsheet formulas', () => {
    expect(csvSafe('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    for (const s of ['+1', '-1', '@x', '\tx', '\rx']) expect(csvSafe(s).startsWith('\'')).toBe(true);
    expect(csvSafe('plain')).toBe('plain');
  });
});

describe('15. protection passwords', () => {
  it('are salted PBKDF2, and old unsalted hashes still verify', async () => {
    const a = await hashPassword('pw'), b = await hashPassword('pw');
    expect(a).not.toBe(b);
    expect(a.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('pw', a)).toBe(true);
    expect(await verifyPassword('nope', a)).toBe(false);
    expect(await legacyPasswordHash('pw')).toBe(await sha('pw'));
    expect(await verifyPassword('pw', await sha('pw'))).toBe(true);
  });
});
