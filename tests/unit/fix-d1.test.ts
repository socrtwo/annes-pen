import { describe, it, expect, vi } from 'vitest';
import { EditorState, TextSelection, NodeSelection, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { history, undo, closeHistory } from 'prosemirror-history';
import { splitBlock, joinBackward, deleteSelection } from 'prosemirror-commands';
import { deleteRow, addRowAfter, deleteTable, CellSelection } from 'prosemirror-tables';

vi.mock('../../src/ui/dialog', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ui/dialog')>();
  return { ...orig, toast: vi.fn(), promptDialog: vi.fn(), confirmDialog: vi.fn(), openDialog: vi.fn() };
});

import { Mapping } from 'prosemirror-transform';
import '../../src/commands';
import { getCommand } from '../../src/commands/registry';
import { sha } from '../../src/commands/review';
import { normalizeSettings } from '../../src/editor/settings';
import { defaultPrefs } from '../../src/prefs';
import { verifyPassword } from '../../src/util/crypto';
import * as dialog from '../../src/ui/dialog';
import { schema } from '../../src/editor/schema';
import { trackPlugin, trackKey, trackTransaction, listChanges, resolveChanges, trackAuthor } from '../../src/editor/plugins/trackChanges';
import { compareDocs } from '../../src/editor/compare';

const S = schema;
const P = (t: string) => S.nodes.paragraph.create(null, t ? S.text(t) : null);
const doc = (...b: PMNode[]) => S.node('doc', null, b);
const cell = (t: string) => S.nodes.table_cell.create(null, P(t));
const row = (...t: string[]) => S.nodes.table_row.create(null, t.map(cell));
const table = (...rows: PMNode[]) => S.nodes.table.create(null, rows);
const ul = (...t: string[]) => S.nodes.bullet_list.create(null, t.map((x) => S.nodes.list_item.create(null, P(x))));

const mk = (d: PMNode, author = 'Me') => EditorState.create({ doc: d, plugins: [history(), trackPlugin({ enabled: true, author })] });
const apply = (st: EditorState, tr: Transaction) => st.apply(trackTransaction(tr, st));
const run = (st: EditorState, cmd: (s: EditorState, d: (tr: Transaction) => void) => boolean) => { let out: Transaction | null = null; cmd(st, (tr) => { out = tr; }); return out ? apply(st, out) : st; };
const acceptAll = (st: EditorState) => st.apply(resolveChanges(st, listChanges(st.doc), true));
const rejectAll = (st: EditorState) => st.apply(resolveChanges(st, listChanges(st.doc), false));
const shape = (d: PMNode) => { const o: string[] = []; d.forEach((n) => o.push(n.type.name === 'paragraph' ? n.textContent : `${n.type.name}:${n.textContent}`)); return o.join(' | '); };
/** Document JSON without revision records, for comparing with the untracked result. */
const clean = (d: PMNode) => JSON.parse(JSON.stringify(d.toJSON(), (k, v) => (k === 'change' && v === null ? undefined : v)));
const at = (d: PMNode, text: string, offset = 0) => {
  let found = -1;
  d.descendants((n, pos) => { if (found < 0 && n.isText && n.text!.includes(text)) found = pos + n.text!.indexOf(text) + offset; return found < 0; });
  if (found < 0) throw new Error('not found: ' + text);
  return found;
};
const sel = (st: EditorState, from: number, to = from) => st.apply(st.tr.setSelection(TextSelection.create(st.doc, from, to)));
const noRecords = (d: PMNode) => { let n = 0; d.descendants((x) => { if (x.attrs.change || x.marks.some((m) => ['insertion', 'deletion', 'formatChange'].includes(m.type.name))) n++; return true; }); return n; };

/** Tracked deletion of [from, to): Accept gives the untracked result, Reject the original. */
function checkDelete(d: PMNode, from: number, to: number) {
  const st = sel(mk(d), from, to);
  const plain = st.apply(st.tr.deleteSelection());
  const tracked = apply(st, st.tr.deleteSelection());
  const acc = acceptAll(tracked), rej = rejectAll(tracked);
  expect(clean(acc.doc)).toEqual(clean(plain.doc));
  expect(rej.doc.eq(d)).toBe(true);
  expect(noRecords(acc.doc) + noRecords(rej.doc)).toBe(0);
  return { tracked, acc, rej, plain };
}

describe('paragraph-level deletions', () => {
  const five = () => doc(P('one'), P('two'), P('three'), P('four'), P('five'));

  it('deleting whole paragraphs 2–4 (with their marks) and accepting leaves one | five', () => {
    const d = five();
    const { tracked, acc } = checkDelete(d, at(d, 'two'), at(d, 'five'));
    expect(shape(tracked.doc)).toBe('one | two | three | four | five');
    expect(shape(acc.doc)).toBe('one | five');
    // One change, listed as text plus paragraph marks.
    const ch = listChanges(tracked.doc);
    expect(ch).toHaveLength(1);
    expect(ch[0].text).toBe('two¶three¶four¶');
  });

  it('deleting the text of paragraphs 2–4 accepts exactly like the untracked delete (no blank paragraphs pile up)', () => {
    const d = five();
    const { acc } = checkDelete(d, at(d, 'two'), at(d, 'four', 4));
    expect(shape(acc.doc)).toBe('one |  | five');
  });

  it('accepting a deleted last paragraph removes it', () => {
    const d = doc(P('one'), P('two'));
    const st = mk(d);
    const t = apply(st, st.tr.delete(5, d.content.size));
    expect(shape(t.doc)).toBe('one | two');
    expect(shape(acceptAll(t).doc)).toBe('one');
    expect(rejectAll(t).doc.eq(d)).toBe(true);
  });

  it('a tracked Backspace join keeps both paragraphs until accepted', () => {
    const d = doc(P('Hello'), P('World'));
    const st = sel(mk(d), at(d, 'World'));
    let out: Transaction | null = null;
    joinBackward(st, (tr) => { out = tr.setMeta('trackDir', 'back'); });
    const t = apply(st, out!);
    expect(shape(t.doc)).toBe('Hello | World');
    expect(t.selection.head).toBe(6); // end of "Hello"
    expect(listChanges(t.doc).map((c) => [c.kind, c.text])).toEqual([['deletion', '¶']]);
    expect(shape(acceptAll(t).doc)).toBe('HelloWorld');
    expect(rejectAll(t).doc.eq(d)).toBe(true);
  });

  it('node-selected table deletion: Accept removes the table, Reject restores it', () => {
    const d = doc(P('before'), table(row('a', 'b'), row('c', 'd')), P('after'));
    const st = mk(d);
    const st2 = st.apply(st.tr.setSelection(NodeSelection.create(st.doc, 8)));
    const t = apply(st2, st2.tr.deleteSelection());
    expect(shape(t.doc)).toBe('before | table:abcd | after');
    expect(listChanges(t.doc)).toHaveLength(1);
    expect(shape(acceptAll(t).doc)).toBe('before | after');
    expect(rejectAll(t).doc.eq(d)).toBe(true);
    // Delete Table, and clearing every cell (which keeps the table, as without tracking).
    const dt = run(sel(mk(d), at(d, 'c')), deleteTable);
    expect(shape(acceptAll(dt).doc)).toBe('before | after');
    expect(rejectAll(dt).doc.eq(d)).toBe(true);
    const cs = st.apply(st.tr.setSelection(CellSelection.create(st.doc, 10, 27)));
    const plain = cs.apply(cs.tr.deleteSelection());
    const cleared = apply(cs, cs.tr.deleteSelection());
    expect(clean(acceptAll(cleared).doc)).toEqual(clean(plain.doc));
    expect(rejectAll(cleared).doc.eq(d)).toBe(true);
  });

  it('tracked row deletion and row insertion resolve to whole rows', () => {
    const d = doc(P('x'), table(row('a', 'b'), row('c', 'd'), row('e', 'f')), P('y'));
    const st = sel(mk(d), at(d, 'c'));
    const del = run(st, deleteRow);
    expect(shape(del.doc)).toBe('x | table:abcdef | y');
    const acc = acceptAll(del);
    expect(shape(acc.doc)).toBe('x | table:abef | y');
    expect(acc.doc.child(1).childCount).toBe(2);
    expect(rejectAll(del).doc.eq(d)).toBe(true);

    const add = run(st, addRowAfter);
    expect(add.doc.child(1).childCount).toBe(4);
    expect(rejectAll(add).doc.eq(d)).toBe(true);
    const kept = acceptAll(add);
    expect(kept.doc.child(1).childCount).toBe(4);
    expect(noRecords(kept.doc)).toBe(0);
  });

  it('an inserted table is removed on Reject and kept on Accept', () => {
    const d = doc(P('one'), P('two'));
    const st = mk(d);
    const t = apply(st, st.tr.insert(5, table(row('', ''))));
    expect(listChanges(t.doc).length).toBe(1);
    expect(rejectAll(t).doc.eq(d)).toBe(true);
    const acc = acceptAll(t);
    expect(shape(acc.doc)).toBe('one | table: | two');
    expect(noRecords(acc.doc)).toBe(0);
  });

  it('a deletion spanning a list and a table accepts like the untracked delete', () => {
    const d = doc(P('intro text'), ul('alpha', 'beta'), table(row('a', 'b')), P('end text'));
    // From inside "intro" to inside "end": crosses the list and the table.
    const st = sel(mk(d), at(d, 'intro', 2), at(d, 'end', 2));
    const plain = st.apply(st.tr.deleteSelection());
    const t = apply(st, st.tr.deleteSelection());
    expect(clean(acceptAll(t).doc)).toEqual(clean(plain.doc));
    expect(rejectAll(t).doc.eq(d)).toBe(true);
    // A whole list and a whole table removed as nodes.
    const st2 = mk(d);
    const t2 = apply(st2, st2.tr.delete(12, d.content.size - 10));
    expect(shape(acceptAll(t2).doc)).toBe('intro text | end text');
    expect(rejectAll(t2).doc.eq(d)).toBe(true);
  });

  it('every text-to-text deletion range accepts like the untracked edit and rejects to the original', () => {
    const d = doc(P('ab'), ul('cd', 'ef'), P(''), P('gh'), P('ij'));
    const pos: number[] = [];
    d.descendants((n, p) => { if (n.isTextblock) for (let i = 0; i <= n.content.size; i++) pos.push(p + 1 + i); return true; });
    let tracked = 0;
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
      // Deletions that lift list items (ReplaceAroundStep) are still left untracked.
      const st = sel(mk(d), pos[i], pos[j]);
      if (!trackTransaction(st.tr.deleteSelection(), st).getMeta('tracked')) continue;
      checkDelete(d, pos[i], pos[j]);
      tracked++;
    }
    expect(tracked).toBeGreaterThan(50);
  });

  it('a deleted horizontal rule is tracked and resolved', () => {
    const d = doc(P('one'), S.nodes.horizontal_rule.create(), P('two'));
    const st = mk(d);
    const t = apply(st, st.tr.delete(5, 6));
    expect(listChanges(t.doc).map((c) => c.kind)).toEqual(['deletion']);
    expect(shape(acceptAll(t).doc)).toBe('one | two');
    expect(rejectAll(t).doc.eq(d)).toBe(true);
  });
});

describe('paragraph-level insertions', () => {
  it('pasting two paragraphs into "one two" rejects to "one two"', () => {
    const d = doc(P('one two'));
    const st = mk(d);
    const slice = doc(P('AAA'), P('BBB')).slice(1, 9);
    const t = apply(st, st.tr.replace(4, 4, slice));
    expect(shape(t.doc)).toBe('oneAAA | BBB two');
    expect(listChanges(t.doc)).toHaveLength(1);
    expect(rejectAll(t).doc.eq(d)).toBe(true);
    const acc = acceptAll(t);
    expect(shape(acc.doc)).toBe('oneAAA | BBB two');
    expect(noRecords(acc.doc)).toBe(0);
  });

  it('Enter is an inserted paragraph mark; Reject joins, Backspace withdraws it', () => {
    const d = doc(P('Hello World'));
    const st = sel(mk(d), 6);
    const t = run(st, splitBlock);
    expect(shape(t.doc)).toBe('Hello |  World');
    expect(listChanges(t.doc).map((c) => [c.kind, c.text])).toEqual([['insertion', '¶']]);
    expect(rejectAll(t).doc.eq(d)).toBe(true);
    const back = run(t, joinBackward);
    expect(back.doc.eq(d)).toBe(true);
    expect(listChanges(back.doc)).toHaveLength(0);
  });

  it('typed text plus Enter is one change; a new empty paragraph at the end rejects away', () => {
    const d = doc(P('Hello'));
    let st = sel(mk(d), 6);
    st = apply(st, st.tr.insertText(' there'));
    st = run(st, splitBlock);
    st = apply(st, st.tr.insertText('New'));
    expect(shape(st.doc)).toBe('Hello there | New');
    expect(rejectAll(st).doc.eq(d)).toBe(true);
    expect(shape(acceptAll(st).doc)).toBe('Hello there | New');
  });

  it('splitting a paragraph whose mark is deleted keeps the deletion on the second half only', () => {
    const d = doc(P('Hello'), P('World'));
    let st = sel(mk(d), at(d, 'World'));
    st = run(st, joinBackward); // "Hello" mark deleted
    st = sel(st, 3);
    st = run(st, splitBlock); // "He" | "llo"(mark deleted) | "World"
    expect(shape(st.doc)).toBe('He | llo | World');
    expect(shape(acceptAll(st).doc)).toBe('He | lloWorld');
    expect(rejectAll(st).doc.eq(d)).toBe(true);
  });
});

describe('typing inside a tracked deletion', () => {
  it('the typed text is an insertion, not part of the deletion', () => {
    const d = doc(P('Hello brave world'));
    let st = mk(d);
    st = apply(st, st.tr.delete(7, 13));
    st = sel(st, 10);
    st = st.apply(trackTransaction(st.tr.insertText('NEW'), st));
    const ch = listChanges(st.doc);
    expect(ch.map((c) => c.kind)).toEqual(['deletion', 'insertion', 'deletion']);
    expect(acceptAll(st).doc.textContent).toBe('Hello NEWworld');
    expect(rejectAll(st).doc.textContent).toBe('Hello brave world');
  });

  it('mixed insertion and deletion in one paragraph, accepted one at a time', () => {
    const d = doc(P('The quick fox'));
    let st = mk(d);
    st = apply(st, st.tr.insertText('slow', 5, 10)); // replace "quick"
    st = apply(st, st.tr.insertText(' brown', at(st.doc, ' fox')));
    const ch = listChanges(st.doc);
    // Typing on right after the earlier insertion extends it.
    expect(ch.map((c) => [c.kind, c.text])).toEqual([['deletion', 'quick'], ['insertion', 'slow brown']]);
    const one = st.apply(resolveChanges(st, [ch[0]], true));
    expect(one.doc.textContent).toBe('The slow brown fox');
    expect(listChanges(one.doc)).toHaveLength(1);
    expect(acceptAll(st).doc.textContent).toBe('The slow brown fox');
    expect(rejectAll(st).doc.textContent).toBe('The quick fox');
  });

  it('nested and adjacent changes by two authors', () => {
    const d = doc(P('aaa bbb ccc'));
    let st = mk(d, 'A');
    st = apply(st, st.tr.insertText('XX', 4)); // insertion by A
    st = st.apply(st.tr.setMeta(trackKey, { author: 'B' }));
    st = apply(st, st.tr.delete(2, 8)); // B deletes over A's insertion and original text
    const kinds = listChanges(st.doc).map((c) => `${c.kind}:${c.author}`);
    expect(kinds).toContain('deletion:B');
    // A's insertion inside B's deletion is withdrawn; the rest is B's deletion.
    expect(acceptAll(st).doc.textContent).toBe('abb ccc');
    expect(rejectAll(st).doc.textContent).toBe('aaa bbb ccc');
  });
});

describe('undo after Accept/Reject', () => {
  it('undoes the accept and then the tracked edit', () => {
    const d = doc(P('one'), P('two'), P('three'));
    let st = mk(d);
    st = apply(st, st.tr.delete(at(d, 'two'), at(d, 'three')));
    const tracked = st.doc;
    st = st.apply(closeHistory(st.tr));
    st = acceptAll(st);
    expect(shape(st.doc)).toBe('one | three');
    let u: Transaction | null = null;
    undo(st, (tr) => { u = tr; });
    st = st.apply(u!);
    expect(st.doc.eq(tracked)).toBe(true);
    undo(st, (tr) => { u = tr; });
    st = st.apply(u!);
    expect(st.doc.eq(d)).toBe(true);
  });
});

describe('compare produces block-level changes', () => {
  const cmp = (a: PMNode, b: PMNode) => {
    const st = EditorState.create({ doc: compareDocs(a, b, 'cmp') });
    return { acc: acceptAll(st).doc, rej: rejectAll(st).doc };
  };

  it('Accept All gives the revised text, Reject All the original', () => {
    const a = doc(P('Alpha'), P('Bravo'), P('Charlie'), P('Delta'));
    const b = doc(P('Alpha'), P('Charlie'), P('Echo new'), P('Delta'));
    const { acc, rej } = cmp(a, b);
    expect(shape(acc)).toBe(shape(b));
    expect(shape(rej)).toBe(shape(a));
  });

  it('whole lists, tables and empty paragraphs, at the start and end', () => {
    const a = doc(P('First'), ul('one', 'two'), P(''), P('Middle'), table(row('a', 'b')));
    const b = doc(P('New first'), P('First'), P('Middle'), table(row('x', 'y'), row('z', 'w')), P('Last'));
    const { acc, rej } = cmp(a, b);
    expect(clean(acc)).toEqual(clean(b));
    expect(shape(rej)).toBe(shape(a));
  });
});

describe('formatting changes', () => {
  it('bold applied under tracking is a format change; Reject removes it, Accept keeps it', () => {
    const d = doc(P('Hello world'));
    let st = mk(d);
    st = apply(st, st.tr.addMark(7, 12, S.marks.bold.create()));
    const ch = listChanges(st.doc);
    expect(ch.map((c) => [c.kind, c.text])).toEqual([['format', 'world']]);
    const rej = rejectAll(st);
    expect(rej.doc.eq(d)).toBe(true);
    const acc = acceptAll(st);
    expect(acc.doc.nodeAt(7)!.marks.map((m) => m.type.name)).toEqual(['bold']);
    expect(listChanges(acc.doc)).toHaveLength(0);
  });

  it('Reject restores the previous colour, font and italics; repeated changes keep the original', () => {
    const red = S.marks.color.create({ color: '#ff0000' });
    const d = doc(S.nodes.paragraph.create(null, [S.text('ab'), S.text('cd', [S.marks.italic.create(), red])]));
    let st = mk(d);
    const blue = S.marks.color.create({ color: '#0000ff' });
    st = apply(st, st.tr.removeMark(1, 5, S.marks.color).addMark(1, 5, blue));
    st = apply(st, st.tr.removeMark(1, 5, S.marks.italic));
    st = apply(st, st.tr.addMark(1, 5, S.marks.underline.create()));
    expect(listChanges(st.doc).every((c) => c.kind === 'format')).toBe(true);
    expect(rejectAll(st).doc.eq(d)).toBe(true);
  });

  it('formatting newly inserted text is not a separate change', () => {
    let st = mk(doc(P('ab')));
    st = apply(st, st.tr.insertText('XY', 2));
    st = apply(st, st.tr.addMark(2, 4, S.marks.bold.create()));
    expect(listChanges(st.doc).map((c) => c.kind)).toEqual(['insertion']);
  });

  it('untracked formatting is not recorded', () => {
    const st = EditorState.create({ doc: doc(P('ab')), plugins: [trackPlugin({ enabled: false })] });
    const tr = st.tr.addMark(1, 3, S.marks.bold.create());
    expect(trackTransaction(tr, st)).toBe(tr);
    expect(listChanges(st.apply(tr).doc)).toHaveLength(0);
  });
});

describe('track author and state', () => {
  it('follows the current user name and keeps an explicit other author', () => {
    let name = 'Ann';
    let st = EditorState.create({ doc: doc(P('ab')), plugins: [trackPlugin({ enabled: true, author: name, getAuthor: () => name })] });
    expect(trackAuthor(st)).toBe('Ann');
    name = 'Bea';
    st = apply(st, st.tr.insertText('X', 1));
    expect(listChanges(st.doc)[0].author).toBe('Bea');
    // setTracking/changeAuthor pass the current name: still follows it.
    st = st.apply(st.tr.setMeta(trackKey, { enabled: true, author: 'Bea' }));
    name = 'Cid';
    expect(trackAuthor(st)).toBe('Cid');
    // An AI edit's author stays until reset.
    st = st.apply(st.tr.setMeta(trackKey, { author: 'Assistant' }));
    expect(trackAuthor(st)).toBe('Assistant');
  });

  it('a new state with the same plugins (replaceDoc) keeps tracking on', () => {
    let st = EditorState.create({ doc: doc(P('ab')), plugins: [trackPlugin({ author: 'A' })] });
    st = st.apply(st.tr.setMeta(trackKey, { enabled: true, author: 'Z' }));
    const re = EditorState.create({ doc: doc(P('cd')), plugins: st.plugins });
    expect(trackKey.getState(re)).toMatchObject({ enabled: true, author: 'Z' });
  });

  it('deleteSelection through the command also tracks paragraph marks', () => {
    const d = doc(P('one'), P('two'));
    const st = sel(mk(d), 3, at(d, 'two', 1));
    const t = run(st, deleteSelection);
    expect(shape(acceptAll(t).doc)).toBe('onwo');
    expect(rejectAll(t).doc.eq(d)).toBe(true);
  });
});

describe('review commands (D2 requests)', () => {
  const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
  const promptDialog = fn(dialog.promptDialog), openDialog = fn(dialog.openDialog), toast = fn(dialog.toast);
  function mockApp(d: PMNode) {
    const trackers: { mapping: Mapping; lost: boolean; on: boolean }[] = [];
    const view: any = { state: EditorState.create({ doc: d }), editable: true, setProps() {}, dispatch(tr: Transaction) { view.state = view.state.apply(tr); for (const t of trackers) if (t.on) t.mapping.appendMapping(tr.mapping); } };
    const app: any = {
      view, get state() { return view.state; }, get settings() { return normalizeSettings(view.state.doc.attrs.settings); },
      tab: { id: 't1', view, el: document.createElement('div'), readOnly: false },
      docs: [] as any[], prefs: { ...defaultPrefs(), author: 'Tester' },
      ui: { openPane: vi.fn() }, refresh() {}, focus() {}, selectPos: vi.fn(),
      trackPositions() {
        const t = { mapping: new Mapping(), lost: false, on: true };
        trackers.push(t);
        return { tab: app.tab, map: (p: number, a = 1) => t.mapping.map(p, a), deleted: () => false, get lost() { return t.lost; }, get changed() { return t.mapping.maps.length > 0; }, done() { t.on = false; } };
      },
    };
    app.docs.push(app.tab);
    return app;
  }
  const run = (app: any, id: string) => getCommand(id)!.run(app, undefined);
  const commented = (app: any) => { const o: string[] = []; app.state.doc.descendants((n: PMNode) => { if (n.isText && n.marks.some((m) => m.type.name === 'comment')) o.push(n.text!); }); return o; };

  it('New Comment lands on the same text after edits made while the prompt was open', async () => {
    promptDialog.mockReset();
    const app = mockApp(doc(P('alpha beta gamma')));
    app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, 7, 11))); // "beta"
    let answer: (v: string) => void = () => {};
    promptDialog.mockImplementation(() => new Promise((r) => { answer = r; }));
    const p = run(app, 'review.newComment');
    app.view.dispatch(app.state.tr.insertText('NEW ', 1));
    answer('note');
    await p;
    expect(commented(app)).toEqual(['beta']);
  });

  it('New Comment gives up when the text was deleted meanwhile', async () => {
    toast.mockReset();
    const app = mockApp(doc(P('alpha beta gamma')));
    app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, 7, 11)));
    let answer: (v: string) => void = () => {};
    promptDialog.mockImplementation(() => new Promise((r) => { answer = r; }));
    const p = run(app, 'review.newComment');
    app.view.dispatch(app.state.tr.delete(5, 13));
    answer('note');
    await p;
    expect(commented(app)).toEqual([]);
    expect(toast).toHaveBeenCalledWith('The text you were commenting on was deleted.');
  });

  it('Restrict Editing stores a salted hash, verifies it and still accepts old hashes', async () => {
    const app = mockApp(doc(P('x')));
    openDialog.mockReset(); promptDialog.mockReset();
    openDialog.mockResolvedValue({ mode: 'readonly', pw: 'pw' });
    await run(app, 'review.restrictEditing');
    expect(openDialog.mock.calls[0][0].help).toMatch(/advisory/);
    const hash = app.settings.protection.hash as string;
    expect(hash.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('pw', hash)).toBe(true);
    openDialog.mockResolvedValue({ mode: 'none', pw: '' });
    promptDialog.mockResolvedValue('wrong');
    await run(app, 'review.restrictEditing');
    expect(app.settings.protection.mode).toBe('readonly');
    promptDialog.mockResolvedValue('pw');
    await run(app, 'review.restrictEditing');
    expect(app.settings.protection.mode).toBe('none');
    // A document protected with the old unsalted hash.
    const old = mockApp(S.node('doc', { settings: normalizeSettings({ protection: { mode: 'readonly', hash: await sha('old') } }) }, [P('x')]));
    promptDialog.mockResolvedValue('old');
    await run(old, 'review.restrictEditing');
    expect(old.settings.protection.mode).toBe('none');
  });

  it('Read Aloud stops when another document becomes active', async () => {
    const spoken: string[] = [];
    let app: any = null;
    // The user switches documents while the first paragraph is read.
    const synth = { speak: vi.fn((u: any) => { spoken.push(u.text); app.tab = { id: 'other' }; setTimeout(() => u.onend?.(), 0); }), cancel: vi.fn() };
    (window as any).speechSynthesis = synth;
    (globalThis as any).SpeechSynthesisUtterance = class { text: string; onend?: () => void; constructor(t: string) { this.text = t; } };
    app = mockApp(doc(P('one'), P('two'), P('three')));
    await run(app, 'review.readAloud');
    expect(spoken).toEqual(['one']);
    expect(synth.cancel).toHaveBeenCalled();
    delete (window as any).speechSynthesis;
  });
});
