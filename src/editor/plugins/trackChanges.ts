/**
 * Track Changes ("suggesting" mode).
 *
 * When tracking is on, every user transaction is post-processed: inserted text receives an
 * `insertion` mark and deleted content is re-inserted with a `deletion` mark instead of being
 * removed. Text that is already a tracked insertion is deleted for real (deleting your own
 * suggestion simply withdraws it). Paragraph marks (the end of a textblock) are tracked through the
 * textblock's `change` attribute: a split or a new paragraph records an inserted mark, a join or a
 * deleted paragraph a deleted one, so Accept/Reject also join or remove the paragraphs. Formatting
 * applied to existing text is recorded with a `formatChange` mark holding the previous formatting.
 */
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Fragment, Slice, type Mark, type MarkType, type Node as PMNode } from 'prosemirror-model';
import { Transform, ReplaceStep, ReplaceAroundStep, AddMarkStep, RemoveMarkStep, AttrStep, DocAttrStep, AddNodeMarkStep, RemoveNodeMarkStep, canJoin } from 'prosemirror-transform';
import { ChangeSet, simplifyChanges } from 'prosemirror-changeset';
import { schema } from '../schema';

export interface TrackState { enabled: boolean; author: string; lockTracking: boolean }
export const trackKey = new PluginKey<TrackState>('track');

/**
 * `getAuthor` returns the current user name. An author equal to it is stored as '' so changes keep
 * following the user name (Options, Change User Name) instead of the name at the time tracking was
 * turned on; a different author (an AI edit, say) is kept as given. The state survives
 * EditorState.create with the same plugin (replaceDoc), so tracking and the author are not reset.
 */
export function trackPlugin(initial: Partial<TrackState> & { getAuthor?: () => string } = {}) {
  const { getAuthor, ...init } = initial;
  const norm = (s: TrackState): TrackState => (getAuthor && s.author && s.author === getAuthor() ? { ...s, author: '' } : s);
  let last: TrackState | null = null;
  return new Plugin<TrackState>({
    key: trackKey,
    getAuthor,
    state: {
      init: () => (last = last || norm({ enabled: false, author: getAuthor ? '' : 'Author', lockTracking: false, ...init })),
      apply(tr, v) {
        const m = tr.getMeta(trackKey);
        return (last = m ? norm({ ...v, ...m }) : v);
      },
    },
  });
}

export function isTracking(state: EditorState): boolean {
  return !!trackKey.getState(state)?.enabled;
}

/** The author recorded on new changes. */
export function trackAuthor(state: EditorState): string {
  const ts = trackKey.getState(state);
  const get = trackKey.get(state)?.spec.getAuthor as (() => string) | undefined;
  return ts?.author || get?.() || 'Author';
}

let idCounter = 0;
export function newChangeId(): string {
  return `c${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

/** Nodes whose own insertion/deletion (paragraph mark, block object) is the `change` attribute. */
const canChange = (n: PMNode) => !!n.type.spec.attrs?.change;
const changeOf = (m: Mark) => ({ kind: m.type === schema.marks.deletion ? 'deletion' : 'insertion', author: m.attrs.author, date: m.attrs.date, id: m.attrs.id });
/** Table structure: paragraph marks never join across it. */
const isolating = (n: PMNode) => !!(n.type.spec.isolating || n.type.spec.tableRole);

function markFragment(frag: Fragment, del: Mark): Fragment {
  const out: PMNode[] = [];
  frag.forEach((node) => {
    if (node.isText) {
      if (node.marks.some((m) => m.type === schema.marks.insertion)) return; // withdraw own insertions
      if (node.marks.some((m) => m.type === schema.marks.deletion)) { out.push(node); return; }
      out.push(node.mark(del.addToSet(node.marks)));
    } else if (node.isInline) {
      if (node.marks.some((m) => m.type === schema.marks.insertion)) return;
      out.push(node.mark(del.addToSet(node.marks)));
    } else if (node.isLeaf && canChange(node)) {
      if (node.attrs.change?.kind === 'insertion') return;
      out.push(node.type.create({ ...node.attrs, change: changeOf(del) }, null, node.marks));
    } else {
      out.push(node.copy(markFragment(node.content, del)));
    }
  });
  return Fragment.fromArray(out);
}

/**
 * The revision mark of `type` by `author` right next to [from, to): continued typing or deleting
 * extends that change instead of starting a new one for every keystroke.
 */
function adjacentMark(doc: PMNode, from: number, to: number, type: MarkType, author: string): Mark | null {
  for (const n of [doc.resolve(from).nodeBefore, doc.resolve(to).nodeAfter]) {
    const m = n?.marks.find((x) => x.type === type && x.attrs.author === author);
    if (m) return m;
  }
  return null;
}

function hasInlineContent(frag: Fragment): boolean {
  let found = false;
  frag.descendants((n) => {
    if (found) return false;
    if (n.isInline && !(n.type === schema.nodes.hard_break)) {
      if (!n.isText || n.text) found = true;
    }
    if (n.isBlock && n.isLeaf && n.attrs.change?.kind === 'deletion') found = true;
    return !found;
  });
  return found;
}

/** Marks that are not formatting (revision, comment and transient marks). */
const NOT_FORMAT = new Set(['insertion', 'deletion', 'formatChange', 'comment', 'mergeHighlight', 'link']);
const formatMarks = (marks: readonly Mark[]) => marks.filter((m) => !NOT_FORMAT.has(m.type.name));
const sameMarks = (a: readonly Mark[], b: readonly Mark[]) => a.length === b.length && a.every((m) => m.isInSet(b));
function parseBefore(s: string): Mark[] | null {
  if (!s) return null;
  try { return (JSON.parse(s) as unknown[]).map((j) => schema.markFromJSON(j)); } catch { return null; }
}

/** Record mark-only transactions (bold, colour, font...) as formatChange marks holding the old formatting. */
function trackFormat(tr: Transaction, oldState: EditorState, author: string): Transaction {
  const ranges: [number, number][] = [];
  for (const s of tr.steps) {
    const { from, to } = s as AddMarkStep;
    if (to > from) ranges.push([from, to]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const l = merged[merged.length - 1];
    if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]);
    else merged.push([...r]);
  }
  const date = Date.now(), id = newChangeId();
  const fc = schema.marks.formatChange;
  for (const [a, b] of merged) {
    oldState.doc.nodesBetween(a, b, (on, opos) => {
      if (!on.isInline) return true;
      // New text: its formatting is part of the insertion.
      if (on.marks.some((m) => m.type === schema.marks.insertion)) return false;
      const s0 = Math.max(opos, a), e0 = Math.min(opos + on.nodeSize, b);
      const prev = on.marks.find((m) => m.type === fc);
      const before = formatMarks(on.marks);
      tr.doc.nodesBetween(s0, e0, (nn, npos) => {
        if (!nn.isInline) return true;
        const s = Math.max(npos, s0), e = Math.min(npos + nn.nodeSize, e0);
        const now = formatMarks(nn.marks);
        if (prev) {
          // Keep the original formatting of an earlier change; drop it once the text is back to that.
          const orig = parseBefore(prev.attrs.before);
          if (orig && sameMarks(orig, now)) tr.removeMark(s, e, prev);
        } else if (!sameMarks(before, now)) {
          tr.addMark(s, e, fc.create({ author, date, id, before: JSON.stringify(before.map((m) => m.toJSON())) }));
        }
        return false;
      });
      return false;
    });
  }
  tr.setMeta('tracked', true);
  return tr;
}

/**
 * Join the textblock ending at `p` with the next one (withdrawing its own inserted paragraph mark);
 * the joined paragraph takes the second one's mark. Where they cannot join, the mark is deleted.
 */
function joinMark(t: Transform, p: number, del: Mark) {
  const $p = t.doc.resolve(p);
  const left = $p.nodeBefore, right = $p.nodeAfter;
  if (!left) return;
  if (canJoin(t.doc, p)) {
    if (canChange(left)) t.setNodeAttribute(p - left.nodeSize, 'change', right?.attrs.change ?? null);
    t.join(p);
  } else if (canChange(left)) t.setNodeAttribute(p - left.nodeSize, 'change', changeOf(del));
}

/** The old document with [from, to) marked as deleted (and own insertions in it withdrawn). */
function markDeletedRange(doc: PMNode, from: number, to: number, del: Mark): Transform {
  const t = new Transform(doc);
  const ops: { at: number; run: () => void }[] = [];
  doc.nodesBetween(from, to, (n, pos) => {
    if (n.isInline) {
      const a = Math.max(pos, from), b = Math.min(pos + n.nodeSize, to);
      if (n.marks.some((m) => m.type === schema.marks.insertion)) ops.push({ at: a, run: () => t.delete(t.mapping.map(a, 1), t.mapping.map(b, -1)) });
      else if (!n.marks.some((m) => m.type === schema.marks.deletion)) t.addMark(a, b, del);
      return false;
    }
    if (n.isTextblock) {
      const end = pos + n.nodeSize;
      if (end - 1 >= from && end <= to) {
        if (n.attrs.change?.kind === 'insertion') ops.push({ at: end, run: () => joinMark(t, t.mapping.map(end), del) });
        else if (canChange(n)) t.setNodeAttribute(pos, 'change', changeOf(del));
      }
    } else if (n.isLeaf && canChange(n) && pos >= from && pos + n.nodeSize <= to) {
      if (n.attrs.change?.kind === 'insertion') ops.push({ at: pos, run: () => t.delete(t.mapping.map(pos, 1), t.mapping.map(pos + n.nodeSize, -1)) });
      else t.setNodeAttribute(pos, 'change', changeOf(del));
    }
    return true;
  });
  for (const op of ops.sort((x, y) => y.at - x.at)) {
    try { op.run(); } catch { /* keep it */ }
  }
  return t;
}

/**
 * Convert a user transaction into a tracked one. Returns the transaction to dispatch.
 * `dir` is 'back' when the edit was a Backspace so the caret ends before the deleted text.
 */
export function trackTransaction(tr: Transaction, oldState: EditorState, force = false): Transaction {
  const ts = trackKey.getState(oldState);
  if (!(ts?.enabled || force) || !tr.docChanged || tr.getMeta('trackSkip') || tr.getMeta('history$')) return tr;
  if (tr.steps.some((s) => s instanceof ReplaceAroundStep)) return tr;
  const passthrough = (s: unknown) => s instanceof AddMarkStep || s instanceof RemoveMarkStep || s instanceof AttrStep || s instanceof DocAttrStep || s instanceof AddNodeMarkStep || s instanceof RemoveNodeMarkStep;
  if (!tr.steps.every((s) => s instanceof ReplaceStep || passthrough(s))) return tr;
  const author = trackAuthor(oldState);
  if (!tr.steps.some((s) => s instanceof ReplaceStep)) {
    if (tr.steps.every((s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep)) return trackFormat(tr, oldState, author);
    return tr;
  }

  const date = Date.now();
  const id = newChangeId();
  const insMark = schema.marks.insertion.create({ author, date, id });
  const delMark = schema.marks.deletion.create({ author, date, id });

  let cs = ChangeSet.create(oldState.doc);
  cs = cs.addSteps(tr.doc, tr.mapping.maps, null);
  // 'trackWords' (AI edits): present whole-word changes, as reviewers expect, instead of minimal character runs.
  const changes = tr.getMeta('trackWords') ? simplifyChanges(cs.changes, tr.doc) : [...cs.changes];
  if (!changes.length) return tr;

  const out = tr; // append steps to the same transaction so undo treats it as one unit
  const dir = tr.getMeta('trackDir') as 'back' | 'forward' | undefined;
  const selBefore = out.selection;
  let caret: number | null = selBefore.empty ? selBefore.head : null;

  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    // Mark inserted content: inline nodes (dropping a deletion mark they inherited), new paragraph
    // marks (textblocks ending inside the range) and block objects.
    if (c.toB > c.fromB) {
      const ins = adjacentMark(out.doc, c.fromB, c.toB, schema.marks.insertion, author) || insMark;
      out.doc.nodesBetween(c.fromB, c.toB, (node, pos) => {
        if (node.isInline) {
          const from = Math.max(pos, c.fromB);
          const to = Math.min(pos + node.nodeSize, c.toB);
          if (to > from) {
            out.addMark(from, to, ins);
            if (node.marks.some((m) => m.type === schema.marks.formatChange)) out.removeMark(from, to, schema.marks.formatChange);
          }
        } else if (node.isTextblock) {
          const end = pos + node.nodeSize;
          if (end - 1 >= c.fromB && end <= c.toB && canChange(node)) out.setNodeAttribute(pos, 'change', changeOf(ins));
        } else if (node.isLeaf && canChange(node) && pos >= c.fromB && pos + node.nodeSize <= c.toB) {
          out.setNodeAttribute(pos, 'change', changeOf(ins));
        }
        return true;
      });
    }
    // Re-insert deleted content, marked as a deletion, before the inserted text.
    if (c.toA > c.fromA) {
      // Paragraph marks removed by this change; own inserted ones are simply withdrawn.
      let trackedMarks = 0;
      oldState.doc.nodesBetween(c.fromA, c.toA, (n, pos) => {
        if (!n.isTextblock) return true;
        const end = pos + n.nodeSize;
        if (end - 1 >= c.fromA && end <= c.toA && n.attrs.change?.kind !== 'insertion') trackedMarks++;
        return false;
      });
      const slice = oldState.doc.slice(c.fromA, c.toA);
      const del = adjacentMark(out.doc, c.fromB, c.fromB, schema.marks.deletion, author) || delMark;
      const marked = new Slice(markFragment(slice.content, del), slice.openStart, slice.openEnd);
      // Structural (list joins...) or only withdrew own insertions: allow untracked.
      if (!trackedMarks && !hasInlineContent(marked.content)) {
        // A withdrawn paragraph mark: the joined paragraph now ends with the second one's mark.
        const $l = out.doc.resolve(c.fromB), $r = oldState.doc.resolve(c.toA);
        if ($l.parent.isTextblock && $r.parent.isTextblock && $l.parent.attrs.change && canChange($l.parent)) out.setNodeAttribute($l.before(), 'change', $r.parent.attrs.change ?? null);
        continue;
      }
      // A deletion across blocks restores the whole blocks it touched (pasting the deleted slice back
      // cannot always rebuild the structure the untracked delete merged).
      const $a = oldState.doc.resolve(c.fromA), $b = oldState.doc.resolve(c.toA);
      const d = $a.sharedDepth(c.toA);
      const ra = $a.depth > d ? $a.before(d + 1) : c.fromA, rb = $b.depth > d ? $b.after(d + 1) : c.toA;
      const alone = !changes.some((o, j) => j !== i && o.toA >= ra && o.fromA <= rb);
      let added: number;
      const before = out.doc.content.size;
      if ((slice.openStart || slice.openEnd) && alone && !hasInlineContent(out.doc.slice(c.fromB, c.toB).content)) {
        // Only structure was inserted (the untracked delete merged blocks): put the old blocks back.
        const t0 = markDeletedRange(oldState.doc, c.fromA, c.toA, del);
        const ma = t0.mapping.map(ra, -1);
        const repl = t0.doc.slice(ma, t0.mapping.map(rb, 1));
        const bFrom = c.fromB - (c.fromA - ra), bTo = c.toB + (rb - c.toA);
        try {
          out.replace(bFrom, bTo, repl);
        } catch {
          continue;
        }
        if (caret != null) {
          if (caret >= c.toB && caret > c.fromB) caret += out.doc.content.size - before;
          else if (caret >= c.fromB) caret = bFrom + (dir === 'back' ? t0.mapping.map(c.fromA, -1) : t0.mapping.map(c.toA, 1)) - ma;
        }
        continue;
      } else {
        try {
          out.replace(c.fromB, c.fromB, marked);
        } catch {
          continue;
        }
        added = out.doc.content.size - before;
        // Paragraph marks inside the re-inserted content are deleted, except own inserted ones (joined again).
        const joins: number[] = [];
        out.doc.nodesBetween(c.fromB, c.fromB + added, (n, pos) => {
          if (!n.isTextblock) return true;
          const end = pos + n.nodeSize;
          if (end - 1 >= c.fromB && end <= c.fromB + added) {
            if (n.attrs.change?.kind === 'insertion') joins.push(end);
            else if (canChange(n)) out.setNodeAttribute(pos, 'change', changeOf(del));
          }
          return false;
        });
        for (const p of joins.reverse()) {
          const s0 = out.doc.content.size;
          joinMark(out, p, del);
          if (caret != null && caret > p) caret -= s0 - out.doc.content.size;
          added -= s0 - out.doc.content.size;
        }
      }
      if (caret != null) {
        if (caret > c.fromB) caret += added;
        else if (caret === c.fromB && dir !== 'back') caret += added;
      }
    }
  }
  if (caret != null) {
    const pos = Math.max(0, Math.min(caret, out.doc.content.size));
    try { out.setSelection(TextSelection.near(out.doc.resolve(pos), dir === 'back' ? -1 : 1)); } catch { /* keep mapped selection */ }
  }
  out.setMeta('tracked', true);
  return out;
}

/**
 * `block`: a block-level object (rule, break, equation...) whose change is its `change` attribute.
 * `para`: a paragraph mark (the end of a textblock and the join with the next one).
 */
export interface ChangeInfo { kind: 'insertion' | 'deletion' | 'format'; id: string; author: string; date: number; from: number; to: number; text: string; block?: boolean; para?: boolean }

interface Item extends ChangeInfo { pos: number; mark?: Mark }

/**
 * Where a deleted/inserted paragraph mark of the textblock at `pos` ends: the start of the next
 * textblock it joins on Accept/Reject, or just past its own end when no textblock follows within the
 * same table cell (or a block object comes first).
 */
function paraMarkEnd(doc: PMNode, pos: number, node: PMNode): number {
  const end = pos + node.nodeSize;
  for (let q = end; ;) {
    const $q = doc.resolve(q);
    if ($q.parent.isTextblock) return q;
    const after = $q.nodeAfter;
    if (after ? after.isLeaf || isolating(after) : $q.depth === 0 || isolating($q.parent)) return end;
    q++;
  }
}

/** Revision items (inline marks, paragraph marks, block objects) in document order. */
function collect(doc: PMNode, from = 0, to = doc.content.size): Item[] {
  const out: Item[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isInline) {
      const text = node.isText ? node.text! : node.type.name === 'image' ? '[image]' : `[${node.type.name}]`;
      for (const m of node.marks) {
        const kind = m.type === schema.marks.insertion ? 'insertion' : m.type === schema.marks.deletion ? 'deletion' : m.type === schema.marks.formatChange ? 'format' : null;
        if (kind) out.push({ kind, id: m.attrs.id, author: m.attrs.author, date: m.attrs.date, from: pos, to: pos + node.nodeSize, text, pos, mark: m });
      }
      return false;
    }
    const bc = node.attrs.change;
    if (bc && (bc.kind === 'insertion' || bc.kind === 'deletion')) {
      if (node.isTextblock) {
        const end = pos + node.nodeSize - 1;
        if (end <= to) out.push({ kind: bc.kind, id: bc.id, author: bc.author, date: bc.date, from: end, to: paraMarkEnd(doc, pos, node), text: '¶', para: true, pos });
      } else if (node.isLeaf) {
        out.push({ kind: bc.kind, id: bc.id, author: bc.author, date: bc.date, from: pos, to: pos + node.nodeSize, text: `[${node.type.name.replace(/_/g, ' ')}]`, block: true, pos });
        return false;
      }
    }
    return true;
  });
  return out.sort((a, b) => a.from - b.from);
}

/** Whether only block structure (no text, no block object, no paragraph end) lies between a and b. */
function structural(doc: PMNode, a: number, b: number): boolean {
  for (let p = a; p < b; p++) {
    const $p = doc.resolve(p);
    if ($p.parent.isTextblock || $p.nodeAfter?.isLeaf) return false;
  }
  return true;
}

/** List tracked changes in document order, merging adjacent ranges with the same id/kind. */
export function listChanges(doc: PMNode): ChangeInfo[] {
  const out: ChangeInfo[] = [];
  // Latest entry per kind/id and whether it ends with a paragraph mark.
  const open = new Map<string, { c: ChangeInfo; para: boolean }>();
  for (const it of collect(doc)) {
    const key = `${it.kind}:${it.id}`;
    const prev = it.block ? undefined : open.get(key);
    const last = prev?.c;
    if (last && (last.to === it.from || (it.kind !== 'format' && (prev.para || it.para) && last.to < it.from && structural(doc, last.to, it.from)))) {
      last.to = Math.max(last.to, it.to);
      last.text += it.text;
      delete last.para;
      prev.para = !!it.para;
      continue;
    }
    const info: ChangeInfo = { kind: it.kind, id: it.id, author: it.author, date: it.date, from: it.from, to: it.to, text: it.text };
    if (it.block) info.block = true;
    if (it.para) info.para = true;
    out.push(info);
    if (it.block) open.delete(key);
    else open.set(key, { c: info, para: !!it.para });
  }
  return out;
}

/** Whether only closing tokens of non-textblock nodes lie between t and end. */
function coversEnd(doc: PMNode, t: number, end: number): boolean {
  while (t < end) {
    const $t = doc.resolve(t);
    if ($t.depth === 0 || $t.parent.isTextblock || $t.parentOffset !== $t.parent.content.size) return false;
    t = $t.after();
  }
  return true;
}

/**
 * The range to delete for a run of removed content [f, t): it grows to whole nodes the run covers
 * (paragraphs with their marks, cells, rows, tables, lists) and stops before the next block when the
 * run starts at a block boundary, so that block keeps its own attributes.
 */
function deletionRange(doc: PMNode, f: number, t: number): [number, number] {
  // Whole nodes go only when the run does not end inside a textblock that stays (as Delete does).
  const $end = doc.resolve(t);
  const whole = !$end.parent.isTextblock || $end.parentOffset === 0;
  for (let changed = true; changed;) {
    changed = false;
    const $f = doc.resolve(f);
    if (whole && $f.depth > 0 && $f.parentOffset === 0) {
      const end = $f.after();
      if (coversEnd(doc, t, end)) { f = $f.before(); t = Math.max(t, end); changed = true; continue; }
    }
    const $t = doc.resolve(t);
    if ($t.depth > 0 && !$t.parent.isTextblock && $t.parentOffset === $t.parent.content.size && $t.before() >= f) { t = $t.after(); changed = true; }
  }
  if (!doc.resolve(f).parent.isTextblock) {
    for (let $t = doc.resolve(t); $t.depth > 0 && $t.parentOffset === 0 && $t.before() >= f; $t = doc.resolve(t)) t = $t.before();
  }
  return [f, t];
}

/** Accept or reject the given changes. Returns a transaction (untracked). */
export function resolveChanges(state: EditorState, changes: ChangeInfo[], accept: boolean): Transaction {
  const tr = state.tr;
  tr.setMeta('trackSkip', true);
  const doc = state.doc;
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    for (const it of collect(doc, Math.max(0, c.from - 1), Math.min(doc.content.size, c.to))) {
      if (it.kind !== c.kind || it.id !== c.id || it.to <= c.from || it.from >= c.to && !(c.from === c.to && it.from === c.from)) continue;
      const key = `${it.from}:${it.to}:${it.kind}:${it.id}:${it.para ? 'p' : ''}`;
      if (!seen.has(key)) { seen.add(key); items.push(it); }
    }
  }
  const remove: Item[] = [];
  const cleared = new Set<number>();
  // Changes that stay: drop the record (position-neutral steps, so the removal positions still hold).
  for (const it of items) {
    if (it.kind === 'format') {
      const before = accept ? null : parseBefore(it.mark!.attrs.before);
      if (before) {
        const node = doc.nodeAt(it.pos);
        for (const m of formatMarks(node?.marks || [])) tr.removeMark(it.from, it.to, m);
        for (const m of before) tr.addMark(it.from, it.to, m);
      }
      tr.removeMark(it.from, it.to, it.mark!);
    } else if ((it.kind === 'insertion') !== accept) remove.push(it); // reject insertion or accept deletion
    else if (it.mark) tr.removeMark(it.from, it.to, it.mark.type);
    else if (doc.nodeAt(it.pos)?.attrs.change) { tr.setNodeAttribute(it.pos, 'change', null); cleared.add(it.pos); }
  }
  // Removed content: contiguous runs (across block structure) are deleted as one range.
  remove.sort((a, b) => a.from - b.from);
  const runs: [number, number][] = [];
  for (const it of remove) {
    const last = runs[runs.length - 1];
    if (last && (it.from <= last[1] || structural(doc, last[1], it.from))) last[1] = Math.max(last[1], it.to);
    else runs.push([it.from, it.to]);
  }
  for (let i = runs.length - 1; i >= 0; i--) {
    const [f, t] = deletionRange(doc, runs[i][0], runs[i][1]);
    // A join keeps the first paragraph, which now ends with the second one's paragraph mark.
    const $f = doc.resolve(f), $t = doc.resolve(t);
    if ($f.parent.isTextblock && $t.parent.isTextblock && $f.start() !== $t.start() && canChange($f.parent)) {
      const right = $t.before();
      tr.setNodeAttribute(tr.mapping.map($f.before()), 'change', cleared.has(right) ? null : $t.parent.attrs.change ?? null);
    }
    try {
      tr.deleteRange(tr.mapping.map(f, 1), tr.mapping.map(t, -1));
    } catch {
      try { tr.delete(tr.mapping.map(runs[i][0], 1), tr.mapping.map(runs[i][1], -1)); } catch { /* leave it */ }
    }
  }
  return tr;
}

export function changesInRange(doc: PMNode, from: number, to: number): ChangeInfo[] {
  return listChanges(doc).filter((c) => c.to > from && c.from < to || (from === to && c.from <= from && c.to >= to));
}
