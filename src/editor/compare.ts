/** Legal-blackline style document comparison producing tracked changes. */
import { Fragment, type Node as PMNode, type Mark } from 'prosemirror-model';
import { schema } from './schema';

function lcsTable<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Uint32Array[] {
  const t: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = eq(a[i], b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t;
}

type Op<T> = { op: 'eq' | 'del' | 'ins'; a?: T; b?: T };
export function diff<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Op<T>[] {
  // Trim common prefix/suffix to keep the table small.
  let pre = 0;
  while (pre < a.length && pre < b.length && eq(a[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && eq(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  const out: Op<T>[] = a.slice(0, pre).map((x, i) => ({ op: 'eq', a: x, b: b[i] }));
  if (am.length * bm.length > 9_000_000) {
    for (const x of am) out.push({ op: 'del', a: x });
    for (const y of bm) out.push({ op: 'ins', b: y });
  } else {
    const t = lcsTable(am, bm, eq);
    let i = 0, j = 0;
    while (i < am.length && j < bm.length) {
      if (eq(am[i], bm[j])) { out.push({ op: 'eq', a: am[i], b: bm[j] }); i++; j++; }
      else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: 'del', a: am[i++] });
      else out.push({ op: 'ins', b: bm[j++] });
    }
    while (i < am.length) out.push({ op: 'del', a: am[i++] });
    while (j < bm.length) out.push({ op: 'ins', b: bm[j++] });
  }
  for (let k = 0; k < suf; k++) out.push({ op: 'eq', a: a[a.length - suf + k], b: b[b.length - suf + k] });
  return out;
}

type Token = { text: string; marks: readonly Mark[]; node?: PMNode };

function tokens(node: PMNode): Token[] {
  const out: Token[] = [];
  node.forEach((c) => {
    if (c.isText) for (const t of c.text!.match(/\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu) || []) out.push({ text: t, marks: c.marks });
    else out.push({ text: '￼', marks: c.marks, node: c });
  });
  return out;
}

/** Inline atoms (images, footnotes, fields...) are equal when they match apart from their marks. */
const sameToken = (x: Token, y: Token) => x.text === y.text && (x.node ? !!y.node && x.node.mark([]).eq(y.node.mark([])) : !y.node);

/** Whether a node's content can carry insertion/deletion marks (code blocks cannot). */
const canMark = (node: PMNode, mark: Mark) => node.type.allowsMarkType(mark.type);

/** Compare two documents; returns the revised document with insertions and deletions marked. */
export function compareDocs(original: PMNode, revised: PMNode, author: string): PMNode {
  const date = Date.now();
  const ins = schema.marks.insertion.create({ author, date, id: 'cmp-i' });
  const del = schema.marks.deletion.create({ author, date, id: 'cmp-d' });
  const A: PMNode[] = []; original.forEach((n) => A.push(n));
  const B: PMNode[] = []; revised.forEach((n) => B.push(n));
  const ops = diff(A, B, (x, y) => x.eq(y) || (x.isTextblock && y.isTextblock && x.textContent === y.textContent && x.attrs.style === y.attrs.style));
  const out: PMNode[] = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (o.op === 'eq') { out.push(o.b!); continue; }
    // Pair a deleted paragraph with a following inserted paragraph for a word-level diff.
    const nb = ops[k + 1]?.op === 'ins' ? ops[k + 1].b! : null;
    if (o.op === 'del' && nb && o.a!.isTextblock && nb.isTextblock && canMark(nb, ins) && canMark(nb, del)) {
      const a = o.a!, b = nb;
      const ta = tokens(a), tb = tokens(b);
      const wops = diff(ta, tb, sameToken);
      const content: PMNode[] = [];
      for (const w of wops) {
        const t = w.op === 'del' ? w.a! : w.b!;
        const change = w.op === 'del' ? del : w.op === 'ins' ? ins : null;
        // Keep inline atoms (images, footnotes...) as nodes, marked like the text around them.
        if (t.node) { content.push(change ? t.node.mark(change.addToSet(t.node.marks)) : t.node); continue; }
        const marks = change ? change.addToSet(t.marks) : t.marks;
        const last = content[content.length - 1];
        if (last && last.isText && last.marks.length === marks.length && last.marks.every((m, i) => m.eq(marks[i]))) content[content.length - 1] = schema.text(last.text! + t.text, marks);
        else content.push(schema.text(t.text, marks));
      }
      if (b.type.validContent(Fragment.from(content))) {
        out.push(b.type.create(b.attrs, content));
        k++;
        continue;
      }
    }
    if (o.op === 'del') { out.push(markText(o.a!, del)); continue; }
    out.push(markText(o.b!, ins));
  }
  return schema.node('doc', revised.attrs, out.length ? out : [schema.nodes.paragraph.create()]);
}

/** Block-level objects (rules, breaks, equations, generated blocks) record the change as an attribute. */
const changeOf = (mark: Mark) => ({ kind: mark.type === schema.marks.deletion ? 'deletion' : 'insertion', author: mark.attrs.author, date: mark.attrs.date, id: mark.attrs.id });

function markLeaf(node: PMNode, mark: Mark): PMNode {
  if (!node.type.spec.attrs?.change || node.isInline) return node;
  return node.type.create({ ...node.attrs, change: changeOf(mark) }, node.content, node.marks);
}

function markText(node: PMNode, mark: Mark): PMNode {
  if (node.isTextblock && !canMark(node, mark)) {
    // Code blocks cannot hold revision marks: an insertion stays as is, a deletion is shown as a
    // struck-through paragraph so the old text is visible and Accept All removes it.
    if (mark.type !== schema.marks.deletion) return node;
    node = schema.nodes.paragraph.create(null, node.content);
  }
  if (node.isTextblock) {
    const kids: PMNode[] = [];
    node.forEach((c) => kids.push(c.mark(mark.addToSet(c.marks))));
    // The paragraph mark is part of the change too, so Accept/Reject remove the whole paragraph.
    return node.type.create(node.type.spec.attrs?.change ? { ...node.attrs, change: changeOf(mark) } : node.attrs, kids, node.marks);
  }
  if (node.isLeaf) return markLeaf(node, mark);
  const kids: PMNode[] = [];
  node.forEach((c) => kids.push(markText(c, mark)));
  return node.type.create(node.attrs, kids, node.marks);
}
