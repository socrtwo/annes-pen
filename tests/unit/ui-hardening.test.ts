import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import type { Node as PMNode } from 'prosemirror-model';

vi.mock('../../src/ui/dialog', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ui/dialog')>();
  return { ...orig, toast: vi.fn(), promptDialog: vi.fn(), confirmDialog: vi.fn(), openDialog: vi.fn() };
});
vi.mock('../../src/platform/native', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/platform/native')>();
  return { ...orig, saveAs: vi.fn(), writeBack: vi.fn(async () => false), openDocument: vi.fn() };
});

import '../../src/commands';
import { getCommand } from '../../src/commands/registry';
import { schema } from '../../src/editor/schema';
import { normalizeSettings } from '../../src/editor/settings';
import { keyName } from '../../src/editor/setup';
import { replaceAll } from '../../src/commands/edit';
import { saveTab, docKey, localKey } from '../../src/commands/file';
import { combineTr, sha } from '../../src/commands/review';
import { verifyPassword } from '../../src/util/crypto';
import { sanitizePrefs, loadPrefs, defaultPrefs } from '../../src/prefs';
import * as dialog from '../../src/ui/dialog';
import * as native from '../../src/platform/native';

const N = schema.nodes;
const M = schema.marks;
const t = (s: string, marks?: any[]) => schema.text(s, marks);
const P = (...c: (PMNode | string)[]) => N.paragraph.create(null, c.map((x) => (typeof x === 'string' ? t(x) : x)));
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks);
const withSettings = (s: any, ...blocks: PMNode[]) => schema.node('doc', { settings: normalizeSettings(s) }, blocks);
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const toast = fn(dialog.toast), promptDialog = fn(dialog.promptDialog), openDialog = fn(dialog.openDialog);

function mockApp(d: PMNode) {
  const listeners = new Set<(a: any) => void>();
  const view: any = { state: EditorState.create({ doc: d }), editable: true, dispatch(tr: any) { view.state = view.state.apply(tr); }, setProps() {} };
  const app: any = {
    view, get state() { return view.state; }, get settings() { return normalizeSettings(view.state.doc.attrs.settings); },
    tab: { id: 't1', view, viewMode: 'web', el: document.createElement('div'), readOnly: false, key: '', uri: null },
    docs: [] as any[], prefs: { ...defaultPrefs(), author: 'Tester' },
    updateSettings(f: any) { const c = JSON.parse(JSON.stringify(app.settings)); f(c); view.dispatch(view.state.tr.setDocAttribute('settings', c)); },
    updateFields() {}, savePrefs() {}, scheduleAutosave: vi.fn(), ui: { status() {}, rebuild() {}, tabsChanged() {} },
    onRefresh(l: (a: any) => void) { listeners.add(l); return () => listeners.delete(l); },
    refresh() { for (const l of [...listeners]) l(app); },
    exec: (id: string, arg?: any) => getCommand(id)!.run(app, arg),
  };
  app.docs.push(app.tab);
  return app;
}
const run = (app: any, id: string, arg?: any) => getCommand(id)!.run(app, arg);
const select = (app: any, from: number, to = from) => app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, from, to)));
const runs = (app: any) => { const out: string[] = []; app.state.doc.descendants((n: PMNode) => { if (n.isText) out.push(`${n.text}[${n.marks.map((m) => m.type.name).join(',')}]`); }); return out.join('|'); };

beforeEach(() => { toast.mockReset(); promptDialog.mockReset(); openDialog.mockReset(); });

describe('format painter', () => {
  const source = () => doc(P(t('Red', [M.bold.create()]), ' bold and plain words'));
  it('keeps the source formatting and paints the next selection', () => {
    const app = mockApp(source());
    select(app, 1, 9); // "Red bold": mixed formatting
    run(app, 'fmt.painter');
    app.refresh(); // the refresh that follows the command, with the source still selected
    expect(runs(app)).toBe('Red[bold]| bold and plain words[]');
    expect(getCommand('fmt.painter')!.isActive!(app)).toBe(true);
    select(app, 14, 19); // "plain"
    app.refresh();
    expect(runs(app)).toBe('Red[bold]| bold and []|plain[bold]| words[]');
    expect(getCommand('fmt.painter')!.isActive!(app)).toBe(false);
  });
  it('waits for the mouse button to be released', () => {
    const app = mockApp(source());
    select(app, 1, 4);
    run(app, 'fmt.painter');
    document.dispatchEvent(new Event('pointerdown'));
    select(app, 14, 15); // the first letter while dragging
    app.refresh();
    expect(runs(app)).toBe('Red[bold]| bold and plain words[]');
    select(app, 14, 19);
    document.dispatchEvent(new Event('pointerup')); // refreshes
    expect(runs(app)).toBe('Red[bold]| bold and []|plain[bold]| words[]');
  });
  it('stays on when sticky until Escape', () => {
    const app = mockApp(source());
    select(app, 1, 4);
    run(app, 'fmt.painter', 'sticky');
    select(app, 5, 9); app.refresh();
    select(app, 14, 19); app.refresh();
    expect(runs(app)).toBe('Red[bold]| []|bold[bold]| and []|plain[bold]| words[]');
    expect(getCommand('fmt.painter')!.isActive!(app)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(getCommand('fmt.painter')!.isActive!(app)).toBe(false);
  });
});

describe('saving', () => {
  const saveAs = fn(native.saveAs);
  const tabFor = (app: any) => Object.assign(app.tab, { fileName: 'notes.txt', title: 'notes', format: 'txt', dirty: true, saved: 0, displayName: 'notes.txt' });
  it('keeps edits made while the file is written unsaved', async () => {
    const app = mockApp(doc(P('First sentence.')));
    const tab = tabFor(app);
    saveAs.mockImplementation(async () => { app.view.dispatch(app.state.tr.insertText(' Typed while saving.', app.state.doc.content.size - 1)); return { uri: null, name: 'notes.txt' }; });
    expect(await saveTab(app, tab)).toBe(true);
    expect(tab.dirty).toBe(true);
    expect(app.scheduleAutosave).toHaveBeenCalled();
  });
  it('marks the tab saved when nothing changed', async () => {
    const app = mockApp(doc(P('First sentence.')));
    const tab = tabFor(app);
    saveAs.mockImplementation(async () => ({ uri: null, name: 'notes.txt' }));
    expect(await saveTab(app, tab)).toBe(true);
    expect(tab.dirty).toBe(false);
  });
});

describe('document keys', () => {
  const enc = (s: string) => new TextEncoder().encode(s).buffer;
  it('tells same-named files apart and recognizes the same file', () => {
    expect(localKey('report.txt', enc('folder X'))).not.toBe(localKey('report.txt', enc('folder Y')));
    expect(localKey('report.txt', enc('folder X'))).toBe(localKey('report.txt', enc('folder X')));
  });
  it('untitled documents and File System Access names do not share keys', () => {
    const a: any = { id: 'ta', uri: null, key: '', fileName: '', title: 'Document' }, b: any = { ...a, id: 'tb' };
    expect(docKey(a)).not.toBe(docKey(b));
    expect(docKey({ ...a, uri: 'fsa:report.docx', key: 'doc:report.docx:1' } as any)).toBe('doc:report.docx:1');
    expect(docKey({ ...a, uri: 'content://docs/42' } as any)).toBe('content://docs/42');
  });
});

describe('combine revisions', () => {
  const current = () => withSettings({ comments: { c1: { id: 'c1', author: 'Ann', date: 1, text: 'Check', resolved: false, replies: [] } }, header: { left: '', center: 'ACME', right: '' }, page: { margin: { left: 144 } } },
    P('Unchanged ', t('words', [M.bold.create()]), ' with ', t('note', [M.comment.create({ id: 'c1' })])), P('Old ending.'));
  it('keeps this document’s settings and formatting and shows the revised copy as tracked changes', () => {
    const st = EditorState.create({ doc: current() });
    const next = st.apply(combineTr(st, doc(P('Unchanged words with note'), P('New ending.')), 'revised'));
    const s = normalizeSettings(next.doc.attrs.settings);
    expect(Object.keys(s.comments)).toEqual(['c1']);
    expect(s.header.center).toBe('ACME');
    expect(s.page.margin.left).toBe(144);
    const ins: string[] = [], del: string[] = [];
    let bold = false, comment = false;
    next.doc.descendants((n) => { if (n.isText) { if (M.insertion.isInSet(n.marks)) ins.push(n.text!); if (M.deletion.isInSet(n.marks)) del.push(n.text!); if (n.text === 'words' && M.bold.isInSet(n.marks)) bold = true; if (n.text === 'note' && n.marks.some((m) => m.type === M.comment)) comment = true; } });
    expect(ins.join('')).toContain('New');
    expect(del.join('')).toContain('Old');
    expect(bold && comment).toBe(true);
  });
  it('block objects added or removed by the revised copy are tracked the right way round', () => {
    const st = EditorState.create({ doc: doc(P('One'), N.page_break.create(), P('Two')) });
    const next = st.apply(combineTr(st, doc(P('One'), P('Two'), N.horizontal_rule.create()), 'revised'));
    const kinds: string[] = [];
    next.doc.forEach((n) => { if (n.attrs.change) kinds.push(`${n.type.name}:${n.attrs.change.kind}`); });
    expect(kinds).toEqual(['page_break:deletion', 'horizontal_rule:insertion']);
  });
  it('refuses while the document is protected', async () => {
    const app = mockApp(withSettings({ protection: { mode: 'readonly' } }, P('x')));
    await run(app, 'review.combine');
    expect(native.openDocument).not.toHaveBeenCalled();
  });
});

describe('restrict editing', () => {
  it('a new password needs the current one even when the mode stays', async () => {
    const app = mockApp(withSettings({ protection: { mode: 'readonly', hash: await sha('secret') } }, P('x')));
    openDialog.mockResolvedValue({ mode: 'readonly', pw: 'mine' });
    promptDialog.mockResolvedValue(null);
    await run(app, 'review.restrictEditing');
    expect(app.settings.protection.hash).toBe(await sha('secret'));
    promptDialog.mockResolvedValue('secret');
    await run(app, 'review.restrictEditing');
    expect(await verifyPassword('mine', app.settings.protection.hash)).toBe(true);
  });
});

describe('links', () => {
  const linked = () => doc(P('See the ', t('project site', [M.link.create({ href: 'https://old.example.com' })]), ' for details.'));
  const hrefs = (app: any) => { const out: string[] = []; app.state.doc.descendants((n: PMNode) => { if (n.isText) out.push(`${n.text}=${M.link.isInSet(n.marks)?.attrs.href ?? ''}`); }); return out; };
  it('Edit Link with the cursor inside a link changes that link', async () => {
    const app = mockApp(linked());
    select(app, 14); // inside "project site"
    openDialog.mockImplementation(async (o: any) => ({ text: o.fields[0].value, href: 'https://new.example.com', title: '' }));
    await run(app, 'insert.link');
    expect(hrefs(app)).toEqual(['See the =', 'project site=https://new.example.com', ' for details.=']);
  });
  it('Edit Link can rename the link text', async () => {
    const app = mockApp(linked());
    select(app, 21); // at the end edge of the link
    openDialog.mockResolvedValue({ text: 'new site', href: 'https://new.example.com', title: '' });
    await run(app, 'insert.link');
    expect(app.state.doc.textContent).toBe('See the new site for details.');
    expect(hrefs(app)[1]).toBe('new site=https://new.example.com');
  });
  it('the link dialog focuses the address field and does not take focus back once the user is in a field', async () => {
    const real = await vi.importActual<typeof import('../../src/ui/dialog')>('../../src/ui/dialog');
    const wait = () => new Promise((r) => setTimeout(r, 60));
    const box = () => [...document.querySelectorAll<HTMLElement>('.qf-dialog')].pop()!;
    const cancel = () => box().querySelector<HTMLElement>('.qf-btn:not(.qf-primary)')!.click();
    const fields: any[] = [{ key: 'text', label: 'Text', type: 'text', value: 'project site' }, { key: 'href', label: 'Address', type: 'combo', options: [], value: '', autofocus: true }];
    let p = real.openDialog({ title: 'Edit Link', fields });
    await wait();
    expect(document.activeElement).toBe(box().querySelector('input[list]'));
    cancel();
    expect(await p).toBeNull();
    p = real.openDialog({ title: 'Edit Link', fields });
    const text = box().querySelector<HTMLInputElement>('input[type=text]:not([list])')!;
    text.focus();
    await wait();
    expect(document.activeElement).toBe(text);
    cancel();
    expect(await p).toBeNull();
  });
});

describe('shortcut keys', () => {
  const k = (init: KeyboardEventInit) => keyName(new KeyboardEvent('keydown', init));
  it('AltGr characters are text, not shortcuts', () => {
    expect(k({ key: '\\', code: 'Minus', ctrlKey: true, altKey: true })).toBeNull(); // German AltGr+ß
    expect(k({ key: ']', code: 'Minus', ctrlKey: true, altKey: true })).toBeNull(); // French AltGr+)
    expect(k({ key: '\\', code: 'Minus', modifierAltGraph: true } as any)).toBeNull(); // Linux AltGr
  });
  it('real Ctrl+Alt shortcuts still work', () => {
    expect(k({ key: '-', code: 'Minus', ctrlKey: true, altKey: true })).toBe('Mod-Alt--');
    expect(k({ key: '>', code: 'Period', ctrlKey: true, altKey: true, shiftKey: true })).toBe('Mod-Alt-Shift-.');
    expect(k({ key: ' ', code: 'Space', ctrlKey: true, altKey: true })).toBe('Mod-Alt-Space');
    expect(k({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true })).toBe('Mod-Alt-c');
    expect(k({ key: ':', code: 'Period', ctrlKey: true, shiftKey: true })).toBe('Mod-Shift-.');
  });
});

describe('preferences', () => {
  it('drops values of the wrong shape', () => {
    const p = sanitizePrefs({ customTabs: null, qat: 'file.save', units: 'furlong', theme: 'dark', keymap: { 'Mod-x': 5, 'Mod-y': 'fmt.bold' }, hiddenTabs: ['home', 3],
      macros: [{ name: 'bad', steps: [null] }, { name: 'ok', steps: [{ id: 'fmt.bold' }] }], autoformat: { smartQuotes: 'yes', dashes: false }, unknown: 1 });
    expect(p).toEqual({ theme: 'dark', keymap: { 'Mod-y': 'fmt.bold' }, hiddenTabs: ['home'], macros: [{ name: 'ok', steps: [{ id: 'fmt.bold' }] }], autoformat: { dashes: false } });
    expect(sanitizePrefs({ customTabs: [{ id: 'c1', label: 'Mine', groups: [{ id: 'g', label: 'G', items: ['fmt.bold', null] }, 'x'] }, { id: 2 }] }).customTabs)
      .toEqual([{ id: 'c1', label: 'Mine', groups: [{ id: 'g', label: 'G', items: ['fmt.bold'] }] }]);
    expect(sanitizePrefs([1, 2])).toEqual({});
  });
  it('a damaged stored file still loads', () => {
    localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ customTabs: null, qat: 5, theme: 'dark' }));
    const p = loadPrefs();
    expect(p.customTabs).toEqual([]);
    expect(p.qat).toEqual(defaultPrefs().qat);
    expect(p.theme).toBe('dark');
    localStorage.removeItem('quillpen.prefs.v1');
  });
});

describe('editing commands', () => {
  it('Shift+F3 cycles the case of the word at a collapsed cursor', () => {
    const app = mockApp(doc(P('say hello now')));
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) { select(app, 8); run(app, 'fmt.changeCase'); seen.push(app.state.doc.textContent); }
    expect(seen).toEqual(['say Hello now', 'say HELLO now', 'say hello now']);
  });
  it('single Replace (Replace All on the selected match) understands ^t and regex context', () => {
    const app = mockApp(doc(P('Name: Ann; Name: Bob')));
    select(app, 1, 7);
    replaceAll(app, { find: 'Name: ', replace: 'Name:^t', inSelection: true, quiet: true });
    expect(app.state.doc.textContent).toBe('Name:\tAnn; Name: Bob');
    expect(toast).not.toHaveBeenCalled();
    const app2 = mockApp(doc(P('price: 10 USD, cost: 20 USD')));
    select(app2, 11, 14);
    replaceAll(app2, { find: '(?<=\\d )USD', replace: 'EUR', regex: true, inSelection: true, quiet: true });
    expect(app2.state.doc.textContent).toBe('price: 10 EUR, cost: 20 USD');
  });
  it('a recorded editing key replays through the keymap', () => {
    const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc: doc(P('abcdef')), plugins: [keymap(baseKeymap)] }) });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));
    const app: any = { view, get state() { return view.state; } };
    run(app, 'edit.key', 'Enter');
    expect(view.state.doc.childCount).toBe(2);
    run(app, 'edit.key', 'Backspace'); // at a paragraph start: the keymap joins
    expect(view.state.doc.textContent).toBe('abcdef');
    expect(view.state.doc.childCount).toBe(1);
    run(app, 'edit.key', 'Backspace'); // mid-text: one character, as the browser would
    run(app, 'edit.key', 'Delete');
    expect(view.state.doc.textContent).toBe('abef');
    view.destroy();
  });
});
