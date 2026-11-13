import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState, TextSelection, NodeSelection, AllSelection, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { CellSelection } from 'prosemirror-tables';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/editor/schema';
import { buildPlugins, keyName, canonicalKey, type SetupHooks } from '../../src/editor/setup';
import { DEFAULT_AUTOFORMAT, DEFAULT_REPLACEMENTS } from '../../src/editor/autoformat';
import { compareDocs } from '../../src/editor/compare';
import { listChanges, resolveChanges } from '../../src/editor/plugins/trackChanges';
import { completeKey } from '../../src/editor/plugins/decorations';
import { setParaAttrs, mapSelectedText, moveBlocks, insertBlock, transformCase, clearAllFormatting } from '../../src/editor/ops';
import { computeFields } from '../../src/editor/fields';
import { defaultSettings } from '../../src/editor/settings';
import { App, type DocTab } from '../../src/app';

const S = schema;
const P = (...c: (string | PMNode)[]) => S.nodes.paragraph.create(null, c.filter((x) => x !== '').map((x) => (typeof x === 'string' ? S.text(x) : x)));
const doc = (...blocks: PMNode[]) => S.node('doc', null, blocks);

const hooks: SetupHooks = {
  autoformat: () => DEFAULT_AUTOFORMAT,
  replacements: () => DEFAULT_REPLACEMENTS,
  pageConfig: () => ({ enabled: false, widthPt: 612, heightPt: 792, margin: { top: 72, right: 72, bottom: 72, left: 72 }, gapPx: 24, header: () => '', footer: () => '' }) as any,
  commandKey: () => false,
  author: () => 'A',
  wordCompletion: () => true,
  slashMenu: () => {},
  slashEnabled: () => false,
};
const plugins = buildPlugins(hooks);

/** Minimal view for commands and handleTextInput-driven typing. */
function fakeView(state: EditorState) {
  const v: any = { state, composing: false, editable: true, dispatch(tr: any) { v.state = v.state.apply(tr); }, someProp() {} };
  return v;
}
function withSel(d: PMNode, from: number, to = from, ps: Plugin[] = plugins) {
  const st = EditorState.create({ doc: d, plugins: ps });
  return fakeView(st.apply(st.tr.setSelection(TextSelection.create(st.doc, from, to))));
}
/** Type text one character at a time through the plugins' handleTextInput, like the browser. */
function type(v: any, text: string) {
  for (const ch of text) {
    const { from, to } = v.state.selection;
    let handled = false;
    for (const p of v.state.plugins) {
      const f = p.props.handleTextInput;
      if (f && f.call(p, v, from, to, ch)) { handled = true; break; }
    }
    if (!handled) v.dispatch(v.state.tr.insertText(ch, from, to));
  }
}
function realView(d: PMNode, pos: number) {
  let state = EditorState.create({ doc: d, plugins });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state });
}
const key = (view: EditorView, k: string) => view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const names = (d: PMNode) => { const o: string[] = []; d.forEach((n) => o.push(n.type.name + (n.isTextblock ? `:${n.textContent}` : ''))); return o; };

function table(rows: string[][]) {
  return S.nodes.table.create(null, rows.map((r) => S.nodes.table_row.create(null, r.map((t) => S.nodes.table_cell.create(null, [P(t)])))));
}
function cellPositions(d: PMNode): Record<string, number> {
  const out: Record<string, number> = {};
  d.descendants((n, p) => { if (n.type === S.nodes.table_cell) out[n.textContent] = p; return true; });
  return out;
}

describe('autoformat: inline Markdown keeps atoms and marks (1)', () => {
  it('**bold** around an image, footnote and break keeps them and adds bold', () => {
    const img = S.nodes.image.create({ src: 'x.png' });
    const fn = S.nodes.footnote.create({ text: 'note' });
    const d = doc(P('x **a', img, S.text('b', [S.marks.italic.create()]), fn, S.nodes.hard_break.create(), 'c*'));
    const v = withSel(d, d.content.size - 1);
    type(v, '*');
    const p = v.state.doc.firstChild!;
    const kinds: string[] = [];
    p.forEach((n: PMNode) => kinds.push(n.type.name));
    expect(kinds).toEqual(['text', 'text', 'image', 'text', 'footnote', 'hard_break', 'text']);
    expect(p.textContent).toBe('x abc');
    p.forEach((n: PMNode, off: number) => { if (off > 1) expect(S.marks.bold.isInSet(n.marks), n.type.name).toBeTruthy(); });
    expect(S.marks.italic.isInSet(p.child(3).marks)).toBeTruthy(); // existing italic kept
    expect(S.marks.bold.isInSet(p.child(0).marks)).toBeFalsy();
    expect(v.state.storedMarks?.some((m: any) => m.type === S.marks.bold) ?? false).toBe(false);
  });
  it('single-character delimiters (`code`) still work', () => {
    const d = doc(P('use `x'));
    const v = withSel(d, d.content.size - 1);
    type(v, '`');
    expect(v.state.doc.textContent).toBe('use x');
    expect(S.marks.code.isInSet(v.state.doc.firstChild!.lastChild!.marks)).toBeTruthy();
  });
});

describe('compare: atoms, deleted blocks, unmarkable content (2)', () => {
  it('keeps inline atoms in paired paragraphs and marks deleted lists', () => {
    const img = S.nodes.image.create({ src: 'x.png' });
    const fn = S.nodes.footnote.create({ text: 'n' });
    const a = doc(P('Hello world'), S.nodes.bullet_list.create(null, [S.nodes.list_item.create(null, [P('item')])]));
    const b = doc(P('Hello there', img, fn));
    const r = compareDocs(a, b, 'me');
    r.check();
    const seen: string[] = [];
    r.descendants((n) => { seen.push(n.type.name); return true; });
    expect(seen).toContain('image');
    expect(seen).toContain('footnote');
    let imgIns = false;
    r.descendants((n) => { if (n.type === S.nodes.image) imgIns = !!S.marks.insertion.isInSet(n.marks); return true; });
    expect(imgIns).toBe(true);
    const ch = listChanges(r);
    expect(ch.some((c) => c.kind === 'deletion' && c.text.includes('item'))).toBe(true);
  });
  it('never puts revision marks into code blocks', () => {
    const r = compareDocs(doc(S.nodes.code_block.create(null, S.text('let a = 1'))), doc(S.nodes.code_block.create(null, S.text('let b = 1'))), 'me');
    expect(() => r.check()).not.toThrow();
    const st = EditorState.create({ doc: r });
    expect(() => st.apply(st.tr.insertText('z', 2))).not.toThrow();
    expect(listChanges(r).some((c) => c.kind === 'deletion' && c.text.includes('let a = 1'))).toBe(true);
    const r2 = compareDocs(doc(P('x')), doc(P('x'), S.nodes.code_block.create(null, S.text('new'))), 'me');
    expect(() => r2.check()).not.toThrow();
    expect(r2.lastChild!.textContent).toBe('new');
  });
});

describe('ops: cell selections (3)', () => {
  it('setParaAttrs and mapSelectedText affect every selected cell and keep the CellSelection', () => {
    const d = doc(table([['a0', 'b0', 'c0'], ['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]));
    const cp = cellPositions(d);
    const st = EditorState.create({ doc: d });
    const v = fakeView(st.apply(st.tr.setSelection(CellSelection.create(st.doc, cp.b0, cp.b2))));
    setParaAttrs(v, { align: 'center' });
    const aligned: string[] = [];
    v.state.doc.descendants((n: PMNode) => { if (n.type === S.nodes.paragraph && n.attrs.align === 'center') aligned.push(n.textContent); return true; });
    expect(aligned).toEqual(['b0', 'b1', 'b2']);
    mapSelectedText(v, (t) => t.toUpperCase());
    const texts: string[] = [];
    v.state.doc.descendants((n: PMNode) => { if (n.type === S.nodes.paragraph) texts.push(n.textContent); return true; });
    expect(texts).toEqual(['a0', 'B0', 'c0', 'a1', 'B1', 'c1', 'a2', 'B2', 'c2']);
    expect(v.state.selection).toBeInstanceOf(CellSelection);
  });
});

describe('ops: moveBlocks with a node selection (4)', () => {
  it('moves a selected rule down without splitting paragraphs and keeps it selected', () => {
    const d = doc(P('a'), S.nodes.horizontal_rule.create(), P('bb'), P('cccc'));
    const st = EditorState.create({ doc: d });
    const v = fakeView(st.apply(st.tr.setSelection(NodeSelection.create(st.doc, 3))));
    expect(moveBlocks(v, 1)).toBe(true);
    expect(names(v.state.doc)).toEqual(['paragraph:a', 'paragraph:bb', 'horizontal_rule', 'paragraph:cccc']);
    expect(v.state.selection).toBeInstanceOf(NodeSelection);
    expect((v.state.selection as NodeSelection).node.type.name).toBe('horizontal_rule');
    expect(moveBlocks(v, -1)).toBe(true);
    expect(names(v.state.doc)).toEqual(['paragraph:a', 'horizontal_rule', 'paragraph:bb', 'paragraph:cccc']);
    expect((v.state.selection as NodeSelection).node.type.name).toBe('horizontal_rule');
  });
  it('can move the second-to-last block down', () => {
    const d = doc(P('a'), S.nodes.horizontal_rule.create(), P('bb'));
    const st = EditorState.create({ doc: d });
    const v = fakeView(st.apply(st.tr.setSelection(NodeSelection.create(st.doc, 3))));
    expect(moveBlocks(v, 1)).toBe(true);
    expect(names(v.state.doc)).toEqual(['paragraph:a', 'paragraph:bb', 'horizontal_rule']);
  });
});

describe('proofing (5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  function fakeApp(text: string) {
    const state = EditorState.create({ doc: doc(P(text)) });
    const tab: any = { view: { state, isDestroyed: false, dispatch(tr: any) { tab.view.state = tab.view.state.apply(tr); } } };
    const app: any = { prefs: { spellcheck: false, grammar: true, ignoredWords: [], dictionary: [] }, docs: [tab], active: tab };
    return { app, tab };
  }
  it('does not flag "an hour" / "an honest" but flags "an house" and "an car"', async () => {
    const { Proofer } = await import('../../src/proof/proofing');
    const { app, tab } = fakeApp('It took an hour for an honest man in an car to find an house.');
    const issues = await new Proofer(app).run(tab);
    const aan = issues.filter((i) => i.rule === 'a-an').map((i) => tab.view.state.doc.textBetween(i.from, i.to));
    expect(aan).toEqual(['an car', 'an house']);
  });
  it('does not reschedule for closed tabs or destroyed views', async () => {
    const { Proofer } = await import('../../src/proof/proofing');
    vi.useFakeTimers();
    try {
      const { app, tab } = fakeApp('text');
      const p = new Proofer(app);
      const run = vi.spyOn(p, 'run');
      app.docs = [];
      p.schedule(tab, 10);
      tab.view.isDestroyed = true;
      app.docs = [tab];
      p.schedule(tab, 10);
      vi.advanceTimersByTime(50);
      expect(run).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('a worker error settles pending requests and proofing recovers', async () => {
    const workers: any[] = [];
    class FakeWorker { onmessage: any = null; onerror: any = null; posted: any[] = []; constructor() { workers.push(this); } postMessage(m: any) { this.posted.push(m); } terminate() {} }
    vi.stubGlobal('Worker', FakeWorker as any);
    const proof = await import('../../src/proof/proofing');
    const { app, tab } = fakeApp('Speling here');
    app.prefs.spellcheck = true; app.prefs.grammar = false;
    const p = new proof.Proofer(app);
    const first = p.run(tab);
    const sugg = proof.suggest('speling');
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    workers[0].onerror(new Event('error'));
    await expect(first).resolves.toEqual([]);
    await expect(sugg).resolves.toEqual([]);
    // A new run is not stuck behind the failed one: it starts a fresh worker and gets answered.
    const second = p.run(tab);
    await Promise.resolve();
    expect(workers).toHaveLength(2);
    const msg = workers[1].posted[0];
    workers[1].onmessage({ data: { id: msg.id, bad: ['Speling'] } });
    const issues = await second;
    expect(issues.map((i) => i.kind)).toEqual(['spell']);
  });
});

describe('fields: DOCPROPERTY / DOCVARIABLE own keys only (6)', () => {
  it('returns empty strings for prototype keys and stringifies values', () => {
    const s = defaultSettings();
    (s as any).variables = { ...(s as any).variables, n: 42 };
    const f = (type: string, arg: string) => S.nodes.field.create({ type, arg });
    const d = doc(P(f('DOCPROPERTY', 'constructor'), f('DOCPROPERTY', '__proto__'), f('DOCVARIABLE', 'toString'), f('DOCVARIABLE', 'n')));
    const up = computeFields({ settings: s, fileName: 'a', userName: 'u', userInitials: 'u', pageOf: () => 1, pages: 1, doc: d } as any);
    const byPos = new Map(up.map((u) => [u.pos, u.value]));
    const vals: unknown[] = [];
    d.descendants((n, pos) => { if (n.type === S.nodes.field) vals.push(byPos.has(pos) ? byPos.get(pos) : n.attrs.value); return true; });
    expect(vals.map((x) => typeof x)).toEqual(['string', 'string', 'string', 'string']);
    expect(vals.slice(0, 3).every((x) => !x)).toBe(true);
    expect(vals[3]).toBe('42');
  });
});

/** App with a stub shell, enough to create tabs and dispatch. */
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
function protectedDoc(mode: string, blocks: PMNode[]) {
  const s = defaultSettings();
  s.protection = { mode } as any;
  return S.node('doc', { settings: s }, blocks);
}

describe('app: protection gate (7)', () => {
  it('blocks Accept All under "tracked changes only" protection', () => {
    const app = makeApp();
    const ins = S.marks.insertion.create({ author: 'x', date: 1, id: 'c1' });
    const tab = app.createTab(protectedDoc('tracked', [P(S.text('new', [ins]), ' old')]));
    const before = tab.view.state.doc;
    tab.view.dispatch(resolveChanges(tab.view.state, listChanges(tab.view.state.doc), false));
    expect(tab.view.state.doc.eq(before)).toBe(true);
  });
  it('blocks trackSkip content edits in comments-only and read-only documents', () => {
    for (const mode of ['comments', 'readonly', 'forms']) {
      const app = makeApp();
      const tab = app.createTab(protectedDoc(mode, [P('secret text')]));
      tab.view.dispatch(tab.view.state.tr.delete(1, 7).setMeta('trackSkip', true));
      expect(tab.view.state.doc.textContent, mode).toBe('secret text');
    }
  });
  it('allows settings-only changes and explicitly allowed edits, but not unprotecting via settings', () => {
    const app = makeApp();
    const tab = app.createTab(protectedDoc('readonly', [P('text')]));
    app.updateSettings((s) => { s.properties.title = 'New title'; }, tab);
    expect(tab.settings.properties.title).toBe('New title');
    app.updateSettings((s) => { s.protection = { mode: 'none' }; }, tab);
    expect(tab.settings.protection.mode).toBe('readonly');
    tab.view.dispatch(tab.view.state.tr.insertText('!', 5).setMeta('allowProtected', true));
    expect(tab.view.state.doc.textContent).toBe('text!');
  });
  it('still tracks normal edits in tracked mode and allows comments', () => {
    const app = makeApp();
    const tab = app.createTab(protectedDoc('tracked', [P('abc')]));
    tab.view.dispatch(tab.view.state.tr.insertText('X', 2));
    expect(listChanges(tab.view.state.doc).map((c) => c.kind)).toEqual(['insertion']);
    tab.view.dispatch(tab.view.state.tr.addMark(1, 2, S.marks.comment.create({ id: 'k' })).setMeta('comment', true).setMeta('trackSkip', true));
    let commented = false;
    tab.view.state.doc.descendants((n) => { if (n.marks.some((m) => m.type === S.marks.comment)) commented = true; return true; });
    expect(commented).toBe(true);
  });
});

describe('app: opening a document with fields (8)', () => {
  it('updates fields without marking the document dirty or scheduling autosave', () => {
    const app = makeApp();
    app.prefs.autosave = true;
    const spy = vi.spyOn(app, 'scheduleAutosave');
    const tab = app.createTab(S.node('doc', { settings: defaultSettings() }, [P('Words: ', S.nodes.field.create({ type: 'NUMWORDS', value: 'stale' }))]));
    let value = '';
    tab.view.state.doc.descendants((n) => { if (n.type === S.nodes.field) value = n.attrs.value; return true; });
    expect(value).not.toBe('stale');
    expect(tab.dirty).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    tab.view.dispatch(tab.view.state.tr.insertText('x', 1));
    expect(tab.dirty).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});

describe('setup: word completion keys (9)', () => {
  // Enter no longer accepts (it would glue the word onto the next line); see fix-d1b.test.ts.
  for (const k of ['Tab']) {
    it(`${k} accepts the suggestion`, () => {
      const d = doc(P('extraordinary things happen. ext'));
      const view = realView(d, d.content.size - 1);
      view.dispatch(view.state.tr.insertText('r'));
      expect(completeKey.getState(view.state)?.suggestion).toBe('aordinary');
      key(view, k);
      expect(names(view.state.doc)).toEqual(['paragraph:extraordinary things happen. extraordinary']);
      view.destroy();
    });
  }
  it('Tab still indents/inserts a tab when no suggestion is showing', () => {
    const d = doc(P('ab'));
    const view = realView(d, 2);
    key(view, 'Tab');
    expect(view.state.doc.textContent).toBe('a\tb');
    view.destroy();
  });
});

describe('autoformat: smart quotes replace the selection (10)', () => {
  it('typing " over a selected word replaces it', () => {
    const v = withSel(doc(P('say hello now')), 5, 10);
    type(v, '"');
    expect(v.state.doc.textContent).toBe('say “ now');
    const v2 = withSel(doc(P('it is hers')), 7, 11);
    type(v2, "'");
    expect(v2.state.doc.textContent).toBe('it is ‘');
  });
});

describe('autoformat: lettered/roman lists and apostrophes (11)', () => {
  const cases: [string, string, number][] = [['a. ', 'lower-alpha', 1], ['b) ', 'lower-alpha', 2], ['i. ', 'lower-roman', 1], ['ii. ', 'lower-roman', 2], ['iv) ', 'lower-roman', 4]];
  for (const [t, format, order] of cases) {
    it(`"${t}" starts a ${format} list`, () => {
      const v = withSel(doc(P('')), 1);
      type(v, t + 'x');
      const list = v.state.doc.firstChild!;
      expect(list.type.name).toBe('ordered_list');
      expect(list.attrs.format).toBe(format);
      expect(list.attrs.order).toBe(order);
      expect(v.state.doc.textContent).toBe('x');
    });
  }
  it('still capitalizes a lone letter that is not a list marker', () => {
    const v = withSel(doc(P('')), 1);
    type(v, 'i think so. a test ');
    expect(v.state.doc.textContent).toBe('I think so. A test ');
  });
  it('AutoCorrect entries with apostrophes work after smart quotes', () => {
    const v = withSel(doc(P('so ')), 4);
    type(v, "i'm here and i dont know ");
    expect(v.state.doc.textContent).toBe('so I’m here and I don’t know ');
  });
});

describe('setup: Ctrl on macOS (12)', () => {
  const setPlatform = (p: string) => Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
  afterEach(() => { delete (navigator as any).platform; });
  it('keeps Ctrl distinct from Cmd on a Mac', () => {
    setPlatform('MacIntel');
    expect(keyName(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true }))).toBe('Ctrl-e');
    expect(keyName(new KeyboardEvent('keydown', { key: 'e', metaKey: true }))).toBe('Mod-e');
    expect(canonicalKey('Ctrl-e')).toBe('Ctrl-e');
    expect(canonicalKey('Shift-Ctrl-k')).toBe('Ctrl-Shift-k');
    expect(canonicalKey('Cmd-e')).toBe('Mod-e');
    expect(canonicalKey('Mod-e')).not.toBe(canonicalKey('Ctrl-e'));
  });
  it('maps Ctrl to Mod elsewhere, as before', () => {
    setPlatform('Win32');
    expect(keyName(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true }))).toBe('Mod-e');
    expect(keyName(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true }))).toBe('Mod-Shift-b');
    expect(canonicalKey('Ctrl-e')).toBe('Mod-e');
    expect(canonicalKey('Shift-Ctrl-Alt-k')).toBe('Mod-Alt-Shift-k');
  });
});

describe('ops: insertBlock with several blocks (13)', () => {
  it('Blank Page mid-paragraph splits once without stray paragraphs', () => {
    const d = doc(P('abcd'), P('next'));
    const v = withSel(d, 3, 3, []);
    insertBlock(v, [S.nodes.page_break.create(), P(), S.nodes.page_break.create()]);
    expect(names(v.state.doc)).toEqual(['paragraph:ab', 'page_break', 'paragraph:', 'page_break', 'paragraph:cd', 'paragraph:next']);
  });
  it('inserts address lines in order', () => {
    const v = withSel(doc(P('Dear abcd')), 6, 6, []);
    insertBlock(v, [P('L1'), P('L2'), P('L3')]);
    expect(names(v.state.doc)).toEqual(['paragraph:Dear ', 'paragraph:L1', 'paragraph:L2', 'paragraph:L3', 'paragraph:abcd']);
  });
});

describe('ops: case changes across formatting (14)', () => {
  it('title and sentence case treat a word split by marks as one word', () => {
    const mk = () => doc(P('the he', S.text('llo', [S.marks.bold.create()]), ' world. next.', S.text(' again', [S.marks.italic.create()])));
    for (const [mode, want] of [['title', 'The Hello World. Next. Again'], ['sentence', 'The hello world. Next. Again']] as const) {
      const d = mk();
      const v = withSel(d, 1, d.content.size - 1, []);
      mapSelectedText(v, (t) => transformCase(t, mode), true);
      expect(v.state.doc.textContent, mode).toBe(want);
      expect(S.marks.bold.isInSet(v.state.doc.firstChild!.child(1).marks)).toBeTruthy();
    }
  });
  it('keeps paragraphs as separate words', () => {
    const d = doc(P('one hello'), P('world'));
    const v = withSel(d, 1, d.content.size - 1, []);
    mapSelectedText(v, (t) => transformCase(t, 'title'), true);
    expect(names(v.state.doc)).toEqual(['paragraph:One Hello', 'paragraph:World']);
  });
});

describe('setup: border line inside a list item (15)', () => {
  it('--- + Enter as a list item\'s first paragraph does not put a rule into the item', () => {
    const d = doc(S.nodes.bullet_list.create(null, [S.nodes.list_item.create(null, [P('---')])]));
    const view = realView(d, 6);
    key(view, 'Enter');
    let hrInItem = false;
    view.state.doc.descendants((n, _p, parent) => { if (n.type === S.nodes.horizontal_rule && parent?.type === S.nodes.list_item) hrInItem = true; return true; });
    expect(hrInItem).toBe(false);
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph');
    view.destroy();
  });
  it('still draws a rule at top level with the caret after it', () => {
    const d = doc(P('---'));
    const view = realView(d, 4);
    key(view, 'Enter');
    expect(names(view.state.doc)).toEqual(['horizontal_rule', 'paragraph:']);
    expect(view.state.selection.from).toBe(2);
    view.destroy();
  });
});

describe('ops: clear all formatting keeps paragraph ids (16)', () => {
  it('preserves id and resets other attributes', () => {
    const d = doc(S.nodes.paragraph.create({ id: 'h-1', style: 'Heading 1', align: 'center' }, S.text('Title', [S.marks.bold.create()])));
    const st = EditorState.create({ doc: d });
    const v = fakeView(st.apply(st.tr.setSelection(new AllSelection(st.doc))));
    clearAllFormatting(v);
    const p = v.state.doc.firstChild!;
    expect(p.attrs.id).toBe('h-1');
    expect(p.attrs.style).toBe('Normal');
    expect(p.attrs.align).toBe(null);
    expect(p.firstChild!.marks).toHaveLength(0);
  });
});

describe('app: autosave throttles (17)', () => {
  it('saves during continuous typing', () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      app.prefs.autosave = true;
      app.prefs.autosaveSeconds = 5;
      const save = vi.spyOn(app, 'saveDrafts').mockResolvedValue();
      for (let i = 0; i < 12; i++) { app.scheduleAutosave(); vi.advanceTimersByTime(1000); }
      expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally { vi.useRealTimers(); }
  });
});
