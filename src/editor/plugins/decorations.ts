/** Decoration-only plugins. */
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { ReplaceStep, ReplaceAroundStep, AddMarkStep, RemoveMarkStep } from 'prosemirror-transform';
import { schema, styleLevel } from '../schema';
import { normalizeSettings } from '../settings';

// ------------------------------------------------------------------------------------------
// Footnote / endnote numbering

export const footnoteKey = new PluginKey<{ deco: DecorationSet; labels: Map<number, string> }>('footnotes');

const SYMBOLS = ['*', '†', '‡', '§', '‖', '¶'];
export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case 'lower-roman': return toRoman(n).toLowerCase();
    case 'upper-roman': return toRoman(n);
    case 'lower-alpha': return toAlpha(n);
    case 'upper-alpha': return toAlpha(n).toUpperCase();
    case 'symbols': return SYMBOLS[(n - 1) % SYMBOLS.length].repeat(Math.floor((n - 1) / SYMBOLS.length) + 1);
    case 'decimal-zero': return String(n).padStart(2, '0');
    default: return String(n);
  }
}
export function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const t: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
export function toAlpha(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

/** Ranges of the new document touched by a transaction's steps. */
export function changedRanges(tr: Transaction): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  tr.mapping.maps.forEach((m, i) => m.forEach((_os, _oe, ns, ne) => {
    const rest = tr.mapping.slice(i + 1);
    out.push({ from: rest.map(ns, -1), to: rest.map(ne, 1) });
  }));
  return out;
}

/** True when a step replaced content containing a node of the given type (before or after). */
function touchesType(tr: Transaction, type: unknown): boolean {
  const has = (doc: PMNode, from: number, to: number) => {
    let hit = false;
    doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (n) => { if (n.type === type) hit = true; return !hit; });
    return hit;
  };
  for (let i = 0; i < tr.steps.length; i++) {
    const st = tr.steps[i];
    // Attribute steps have an empty step map, so they cannot be checked by range.
    if (!(st instanceof ReplaceStep || st instanceof ReplaceAroundStep || st instanceof AddMarkStep || st instanceof RemoveMarkStep)) return true;
    const before = tr.docs[i];
    let hit = false;
    tr.steps[i].getMap().forEach((os, oe) => { if (!hit && os < oe && has(before, os, oe)) hit = true; });
    if (hit) return true;
  }
  return changedRanges(tr).some((r) => r.from < r.to && has(tr.doc, r.from, r.to));
}

function computeFootnotes(doc: PMNode) {
  const settings = normalizeSettings(doc.attrs.settings);
  const labels = new Map<number, string>();
  const decos: Decoration[] = [];
  let f = 0, e = 0;
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.footnote) {
      const isEnd = node.attrs.kind === 'end';
      const label = node.attrs.mark || (isEnd ? formatNumber(++e, settings.footnoteFormat.end) : formatNumber(++f, settings.footnoteFormat.foot));
      labels.set(pos, label);
      decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-n': label }));
    }
    return true;
  });
  return { deco: DecorationSet.create(doc, decos), labels };
}

const footnotes = new Plugin({
  key: footnoteKey,
  state: {
    init: (_c, state) => computeFootnotes(state.doc),
    apply: (tr, v) => {
      if (!tr.docChanged) return v;
      // Typing elsewhere keeps the numbering: map it instead of rescanning the document.
      if (tr.doc.attrs.settings === tr.before.attrs.settings && !touchesType(tr, schema.nodes.footnote)) {
        const labels = new Map<number, string>();
        for (const [pos, l] of v.labels) labels.set(tr.mapping.map(pos, 1), l);
        return { deco: v.deco.map(tr.mapping, tr.doc), labels };
      }
      return computeFootnotes(tr.doc);
    },
  },
  props: { decorations: (state) => footnoteKey.getState(state)!.deco },
});

export function footnoteLabel(state: EditorState, pos: number): string | null {
  return footnoteKey.getState(state)?.labels.get(pos) ?? null;
}

// ------------------------------------------------------------------------------------------
// Find highlights

export interface FindState { query: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean; /** Word-style wildcards (? * ^# ^$ ^?), as Replace All uses them. */ wildcards?: boolean; matches: { from: number; to: number }[]; current: number; deco: DecorationSet }
export const findKey = new PluginKey<FindState>('find');

export function buildMatcher(q: string, regex: boolean, cs: boolean, whole: boolean, wildcards = false): RegExp | null {
  if (!q) return null;
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // After escaping, ^# is \^# (# is not escaped), ^$ is \^\$ and ^? is \^\?. The ^ codes go first so ^? is not read as ^ then ?.
  if (wildcards && !regex) src = src.replace(/\\\^\\\?/g, '.').replace(/\\\^#/g, '\\d').replace(/\\\^\\\$/g, '\\p{L}').replace(/\\\?/g, '.').replace(/\\\*/g, '.*?');
  if (!regex) src = src.replace(/\\\^p/g, '\n').replace(/\\\^t/g, '\t');
  if (whole) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(src, 'gu' + (cs ? '' : 'i')); } catch { return null; }
}

export function findMatches(doc: PMNode, re: RegExp | null): { from: number; to: number }[] {
  if (!re) return [];
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Build text with 1 char per position so offsets map exactly.
    let text = '';
    const posMap: number[] = [];
    node.forEach((child, off) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) { posMap.push(pos + 1 + off + i); }
        text += child.text;
      } else {
        posMap.push(pos + 1 + off);
        text += child.type === schema.nodes.hard_break ? '\n' : '￼';
      }
    });
    posMap.push(pos + 1 + node.content.size);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push({ from: posMap[m.index], to: posMap[m.index + m[0].length - 1] + 1 });
      if (out.length > 20000) break;
    }
    return false;
  });
  return out;
}

const find = new Plugin<FindState>({
  key: findKey,
  state: {
    init: () => ({ query: '', regex: false, caseSensitive: false, wholeWord: false, matches: [], current: -1, deco: DecorationSet.empty }),
    apply(tr, v) {
      const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
      let s = v;
      if (meta) s = { ...v, ...meta };
      if (!s.query) return { ...s, matches: [], deco: DecorationSet.empty, current: -1 };
      if (meta || tr.docChanged) {
        const matches = findMatches(tr.doc, buildMatcher(s.query, s.regex, s.caseSensitive, s.wholeWord, !!s.wildcards));
        const current = Math.min(s.current, matches.length - 1);
        const deco = DecorationSet.create(tr.doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'qf-find qf-find-current' : 'qf-find' })));
        return { ...s, matches, current, deco };
      }
      return s;
    },
  },
  props: { decorations: (state) => findKey.getState(state)!.deco },
});

// ------------------------------------------------------------------------------------------
// Focus mode (dims everything but the current sentence / paragraph / line)

export const focusKey = new PluginKey<{ mode: 'off' | 'paragraph' | 'sentence' | 'line' }>('focus');
const focus = new Plugin({
  key: focusKey,
  state: {
    init: () => ({ mode: 'off' as const }),
    apply: (tr, v) => (tr.getMeta(focusKey) ? { ...v, ...tr.getMeta(focusKey) } : v),
  },
  props: {
    decorations(state) {
      const mode = focusKey.getState(state)!.mode;
      if (mode === 'off') return null;
      const $h = state.selection.$head;
      if (!$h.parent.isTextblock) return null;
      const start = $h.start(), end = $h.end();
      if (mode === 'paragraph' || mode === 'line') return DecorationSet.create(state.doc, [Decoration.node($h.before(), $h.after(), { class: 'qf-focus-current' })]);
      const text = $h.parent.textBetween(0, $h.parent.content.size, '￼', '￼');
      const off = $h.parentOffset;
      let s = off, e = off;
      while (s > 0 && !/[.!?]/.test(text[s - 1])) s--;
      while (e < text.length && !/[.!?]/.test(text[e])) e++;
      if (e < text.length) e++;
      return DecorationSet.create(state.doc, [
        Decoration.node($h.before(), $h.after(), { class: 'qf-focus-para' }),
        Decoration.inline(start + s, Math.min(end, start + e), { class: 'qf-focus-current' }),
      ]);
    },
  },
});

// ------------------------------------------------------------------------------------------
// Word completion (offers long words already used in the document; Tab accepts, Esc dismisses,
// Enter is left alone so a new paragraph never picks up the suggestion)

export const completeKey = new PluginKey<{ suggestion: string | null; pos: number; prefix: string }>('complete');

function collectWords(doc: PMNode): string[] {
  const counts = new Map<string, number>();
  doc.descendants((n) => {
    if (n.isText) for (const w of n.text!.match(/[\p{L}][\p{L}'’-]{7,}/gu) || []) counts.set(w, (counts.get(w) || 0) + 1);
    return true;
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 2000);
}

function completion(enabled: () => boolean) {
  let words: string[] = [];
  let wordsDoc: PMNode | null = null;
  type CS = { suggestion: string | null; pos: number; prefix: string };
  return new Plugin<CS>({
    key: completeKey,
    state: {
      init: (): CS => ({ suggestion: null, pos: 0, prefix: '' }),
      apply(tr, v, _o, state) {
        if (tr.getMeta(completeKey) === 'clear') return { suggestion: null, pos: 0, prefix: '' };
        if (!enabled() || !tr.docChanged || !state.selection.empty) return tr.selectionSet || tr.docChanged ? { suggestion: null, pos: 0, prefix: '' } : v;
        const $h = state.selection.$head;
        if (!$h.parent.isTextblock || $h.parent.type.spec.code) return { suggestion: null, pos: 0, prefix: '' };
        const before = $h.parent.textBetween(Math.max(0, $h.parentOffset - 40), $h.parentOffset, '￼', '￼');
        const m = /([\p{L}][\p{L}'’-]{2,})$/u.exec(before);
        const after = $h.parent.textBetween($h.parentOffset, Math.min($h.parent.content.size, $h.parentOffset + 1), '￼', '￼');
        if (!m || /[\p{L}]/u.test(after)) return { suggestion: null, pos: 0, prefix: '' };
        if (wordsDoc !== state.doc && (!wordsDoc || Math.abs(wordsDoc.content.size - state.doc.content.size) > 30 || !words.length)) { words = collectWords(state.doc); wordsDoc = state.doc; }
        const prefix = m[1];
        const lower = prefix.toLowerCase();
        const hit = words.find((w) => w.length > prefix.length + 2 && w.toLowerCase().startsWith(lower));
        if (!hit) return { suggestion: null, pos: 0, prefix: '' };
        const rest = prefix[0] === prefix[0].toUpperCase() && hit[0] !== hit[0].toUpperCase() ? hit.slice(prefix.length) : hit.slice(prefix.length);
        return { suggestion: rest, pos: $h.pos, prefix };
      },
    },
    props: {
      decorations(state) {
        const s = completeKey.getState(state);
        if (!s?.suggestion) return null;
        return DecorationSet.create(state.doc, [Decoration.widget(s.pos, () => {
          const el = document.createElement('span');
          el.className = 'qf-complete';
          el.textContent = s.suggestion!;
          el.title = 'Tab to accept, Esc to dismiss';
          el.addEventListener('mousedown', (e) => { e.preventDefault(); });
          return el;
        }, { side: 1, key: 'complete-' + s.suggestion })]);
      },
      handleKeyDown(view, e) {
        const s = completeKey.getState(view.state);
        if (!s?.suggestion) return false;
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          view.dispatch(view.state.tr.insertText(s.suggestion, s.pos).setMeta(completeKey, 'clear'));
          return true;
        }
        if (e.key === 'Escape') { view.dispatch(view.state.tr.setMeta(completeKey, 'clear')); return true; }
        return false;
      },
      handleClickOn(view, _pos, _node, _np, event) {
        const t = event.target as HTMLElement;
        if (t.classList?.contains('qf-complete')) {
          const s = completeKey.getState(view.state);
          if (s?.suggestion) view.dispatch(view.state.tr.insertText(s.suggestion, s.pos).setMeta(completeKey, 'clear'));
          return true;
        }
        return false;
      },
    },
  });
}

// ------------------------------------------------------------------------------------------
// Proofing decorations (spelling + grammar), filled asynchronously by the proofing engine.

export interface ProofIssue { from: number; to: number; kind: 'spell' | 'grammar' | 'style'; message: string; suggestions: string[]; rule?: string; /** Spelling: the dictionary set that flagged the word. */ dialect?: string }
export const proofKey = new PluginKey<{ issues: ProofIssue[]; deco: DecorationSet }>('proof');
const proof = new Plugin<{ issues: ProofIssue[]; deco: DecorationSet }>({
  key: proofKey,
  state: {
    init: () => ({ issues: [] as ProofIssue[], deco: DecorationSet.empty }),
    apply(tr, v) {
      const meta = tr.getMeta(proofKey) as ProofIssue[] | undefined;
      if (meta) {
        return {
          issues: meta,
          deco: DecorationSet.create(tr.doc, meta.map((i) => Decoration.inline(i.from, i.to, { class: `qf-proof qf-${i.kind}`, 'data-msg': i.message }, { issue: i }))),
        };
      }
      if (!tr.docChanged) return v;
      const deco = v.deco.map(tr.mapping, tr.doc);
      // drop decorations that intersect edited ranges
      let changed: { from: number; to: number }[] = [];
      tr.mapping.maps.forEach((m, i) => m.forEach((_os, _oe, ns, ne) => changed.push({ from: tr.mapping.slice(i + 1).map(ns, -1), to: tr.mapping.slice(i + 1).map(ne, 1) })));
      let d = deco;
      for (const c of changed) d = d.remove(d.find(Math.max(0, c.from - 1), c.to + 1));
      changed = [];
      const issues = d.find().map((x) => ({ ...(x.spec.issue as ProofIssue), from: x.from, to: x.to }));
      return { issues, deco: d };
    },
  },
  props: { decorations: (state) => proofKey.getState(state)!.deco },
});

// ------------------------------------------------------------------------------------------
// Outline collapse (headings can be folded in any view)

export const foldKey = new PluginKey<{ folded: Set<string>; deco: DecorationSet }>('fold');

function headingKey(node: PMNode, index: number): string {
  return node.attrs.id || `${index}:${node.textContent.slice(0, 40)}`;
}

function computeFold(doc: PMNode, folded: Set<string>, levelFilter: number) {
  const decos: Decoration[] = [];
  let hideBelow = 0; // when > 0, hide blocks until a heading of level <= hideBelow
  doc.forEach((node, pos, index) => {
    const lvl = node.type === schema.nodes.paragraph ? styleLevel(node.attrs.style, node.attrs.outlineLevel) : 0;
    if (lvl && hideBelow && lvl <= hideBelow) hideBelow = 0;
    const filtered = levelFilter > 0 && (lvl === 0 || lvl > levelFilter);
    if (hideBelow || filtered) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'qf-folded-hidden' }));
    if (lvl && !hideBelow) {
      const key = headingKey(node, index);
      const isFolded = folded.has(key);
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: isFolded ? 'qf-heading qf-folded' : 'qf-heading', 'data-fold': key }));
      if (isFolded) hideBelow = lvl;
    }
  });
  return DecorationSet.create(doc, decos);
}

const fold = new Plugin({
  key: foldKey,
  state: {
    init: () => ({ folded: new Set<string>(), deco: DecorationSet.empty, level: 0 } as any),
    apply(tr, v: any) {
      const meta = tr.getMeta(foldKey);
      if (meta) {
        const folded = new Set<string>(v.folded);
        if (meta.toggle) { if (folded.has(meta.toggle)) folded.delete(meta.toggle); else folded.add(meta.toggle); }
        if (meta.expandAll) folded.clear();
        if (meta.collapseAll) for (const k of meta.collapseAll) folded.add(k);
        const level = meta.level !== undefined ? meta.level : v.level;
        return { folded, level, deco: computeFold(tr.doc, folded, level) };
      }
      if (tr.docChanged) return { ...v, deco: computeFold(tr.doc, v.folded, v.level) };
      return v;
    },
  },
  props: {
    decorations: (state) => foldKey.getState(state)!.deco,
    handleClickOn(view, pos, node, nodePos, event) {
      const t = event.target as HTMLElement;
      if (node.type !== schema.nodes.paragraph || !styleLevel(node.attrs.style, node.attrs.outlineLevel)) return false;
      const dom = view.nodeDOM(nodePos) as HTMLElement | null;
      if (!dom || t !== dom) return false;
      const r = dom.getBoundingClientRect();
      if ((event as MouseEvent).clientX > r.left + 2) return false; // only the fold arrow area (::before at left)
      const key = dom.getAttribute('data-fold');
      if (key) { view.dispatch(view.state.tr.setMeta(foldKey, { toggle: key })); return true; }
      return false;
    },
  },
});

export function allHeadingKeys(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((node, _p, i) => { if (node.type === schema.nodes.paragraph && styleLevel(node.attrs.style, node.attrs.outlineLevel)) out.push(headingKey(node, i)); });
  return out;
}

// ------------------------------------------------------------------------------------------
// Style highlighting (readability coach): long sentences, adverbs, passive voice, weak words

export const coachKey = new PluginKey<{ on: boolean; deco: DecorationSet }>('coach');
const ADVERB_EXCEPT = new Set(['only', 'early', 'family', 'reply', 'apply', 'supply', 'holy', 'italy', 'july', 'fly', 'ally', 'belly', 'bully', 'jelly', 'rely', 'imply', 'comply', 'multiply', 'ugly', 'lonely', 'friendly', 'lovely', 'daily', 'weekly', 'monthly', 'yearly', 'likely', 'unlikely', 'silly', 'chilly', 'hilly', 'curly', 'fully']);
const WEAK = /\b(very|really|just|quite|rather|somewhat|basically|actually|literally|totally|thing|things|stuff|in order to|due to the fact that|at this point in time|utilize|leverage)\b/gi;
const PASSIVE = /\b(am|is|are|was|were|be|been|being)\s+(\w+ed|\w+en|built|made|done|seen|known|given|taken|found|held|kept|left|lost|paid|put|read|said|sent|set|sold|told|thought|won|written)\b/gi;

function computeCoach(doc: PMNode) {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.spec.code) return true;
    coachBlock(node, pos, decos);
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** Recompute coach marks only in the textblocks a transaction touched. */
function updateCoach(tr: Transaction, deco: DecorationSet): DecorationSet {
  let d = deco.map(tr.mapping, tr.doc);
  const seen = new Set<number>();
  const add: Decoration[] = [];
  for (const r of changedRanges(tr)) {
    tr.doc.nodesBetween(Math.max(0, r.from), Math.min(tr.doc.content.size, r.to), (node, pos) => {
      if (!node.isTextblock) return true;
      if (seen.has(pos)) return false;
      seen.add(pos);
      d = d.remove(d.find(pos, pos + node.nodeSize));
      if (!node.type.spec.code) coachBlock(node, pos, add);
      return false;
    });
  }
  return add.length ? d.add(tr.doc, add) : d;
}

function coachBlock(node: PMNode, pos: number, decos: Decoration[]): void {
  const text = node.textBetween(0, node.content.size, '￼', '￼');
  const base = pos + 1;
  // sentences
  const sentRe = /[^.!?]+[.!?]*/g;
  let m: RegExpExecArray | null;
  while ((m = sentRe.exec(text))) {
    const words = (m[0].match(/[\p{L}\p{N}']+/gu) || []).length;
    if (words >= 30) decos.push(Decoration.inline(base + m.index, base + m.index + m[0].length, { class: 'qf-coach-vlong', title: `Very long sentence (${words} words)` }));
    else if (words >= 21) decos.push(Decoration.inline(base + m.index, base + m.index + m[0].length, { class: 'qf-coach-long', title: `Long sentence (${words} words)` }));
  }
  const adv = /\b(\w{3,}ly)\b/g;
  while ((m = adv.exec(text))) if (!ADVERB_EXCEPT.has(m[1].toLowerCase())) decos.push(Decoration.inline(base + m.index, base + m.index + m[1].length, { class: 'qf-coach-adverb', title: 'Adverb' }));
  WEAK.lastIndex = 0;
  while ((m = WEAK.exec(text))) decos.push(Decoration.inline(base + m.index, base + m.index + m[0].length, { class: 'qf-coach-weak', title: 'Weak or wordy phrase' }));
  PASSIVE.lastIndex = 0;
  while ((m = PASSIVE.exec(text))) decos.push(Decoration.inline(base + m.index, base + m.index + m[0].length, { class: 'qf-coach-passive', title: 'Possible passive voice' }));
}

const coach = new Plugin({
  key: coachKey,
  state: {
    init: () => ({ on: false, deco: DecorationSet.empty }),
    apply(tr, v) {
      const meta = tr.getMeta(coachKey);
      const on = meta !== undefined ? !!meta : v.on;
      if (!on) return { on, deco: DecorationSet.empty };
      if (meta !== undefined || !v.on) return { on, deco: computeCoach(tr.doc) };
      if (tr.docChanged) return { on, deco: updateCoach(tr, v.deco) };
      return v;
    },
  },
  props: { decorations: (state) => coachKey.getState(state)!.deco },
});

// ------------------------------------------------------------------------------------------
// Placeholder for empty documents

const placeholder = new Plugin({
  props: {
    decorations(state) {
      const d = state.doc;
      if (d.childCount !== 1 || d.firstChild!.content.size !== 0 || d.firstChild!.type !== schema.nodes.paragraph) return null;
      return DecorationSet.create(d, [Decoration.node(0, d.firstChild!.nodeSize, { class: 'qf-empty', 'data-placeholder': 'Start writing… (type / for commands)' })]);
    },
  },
});

// ------------------------------------------------------------------------------------------
// Active comment highlight

export const activeCommentKey = new PluginKey<{ id: string | null }>('activeComment');
const activeComment = new Plugin({
  key: activeCommentKey,
  state: {
    init: () => ({ id: null as string | null }),
    apply(tr, v, _o, state) {
      const meta = tr.getMeta(activeCommentKey);
      if (meta !== undefined) return { id: meta };
      if (tr.selectionSet) {
        const m = state.selection.$head.marks().find((x) => x.type === schema.marks.comment);
        return { id: m ? m.attrs.id : null };
      }
      return v;
    },
  },
  props: {
    decorations(state) {
      const id = activeCommentKey.getState(state)?.id;
      if (!id) return null;
      const decos: Decoration[] = [];
      state.doc.descendants((n, pos) => {
        if (n.isInline && n.marks.some((m) => m.type === schema.marks.comment && m.attrs.id === id)) decos.push(Decoration.inline(pos, pos + n.nodeSize, { class: 'qf-comment-active' }));
        return true;
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

export function decoPlugins(opts: { wordCompletion: () => boolean }): Plugin[] {
  return [footnotes, find, focus, completion(opts.wordCompletion), proof, fold, coach, placeholder, activeComment];
}

export function setFind(view: EditorView, patch: Partial<FindState>): FindState {
  view.dispatch(view.state.tr.setMeta(findKey, patch).setMeta('addToHistory', false));
  return findKey.getState(view.state)!;
}

export function selectMatch(view: EditorView, index: number): void {
  const s = findKey.getState(view.state)!;
  if (!s.matches.length) return;
  const i = ((index % s.matches.length) + s.matches.length) % s.matches.length;
  const m = s.matches[i];
  const tr = view.state.tr.setMeta(findKey, { current: i }).setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView();
  view.dispatch(tr);
}
