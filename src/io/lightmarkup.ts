/**
 * Shared machinery for the lightweight text markup importers (reStructuredText, Textile,
 * AsciiDoc, Org-mode, troff/man): a rule-driven inline parser and small block helpers.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { InlineBuf } from './runs';

export const S = schema.nodes;
export const MK = schema.marks;

export interface InlineRule {
  /** Pattern tried at the current position (compiled with the sticky flag). */
  re: RegExp;
  /** Character class that must not precede the match (constrained markup), e.g. /\w/. */
  notAfter?: RegExp;
  /** Produce output for a match: a mark wrapping parsed inner text (literal when `raw`), literal text, or nodes. */
  run: (m: RegExpExecArray, marks: readonly Mark[], parse: (text: string, marks: readonly Mark[]) => PMNode[]) => PMNode[] | { mark: Mark | Mark[] | null; inner: string; raw?: boolean } | string;
}

/** Parse inline markup with rules; text between matches is literal. */
export function parseInline(text: string, rules: InlineRule[], marks: readonly Mark[] = []): PMNode[] {
  const compiled = rules.map((r) => ({ ...r, re: new RegExp(r.re.source, r.re.flags.replace(/[gy]/g, '') + 'y') }));
  const buf = new InlineBuf();
  const parse = (t: string, m: readonly Mark[]): PMNode[] => parseInline(t, rules, m);
  let plain = '';
  const flush = () => { if (plain) buf.text(plain, marks); plain = ''; };
  let i = 0;
  outer: while (i < text.length) {
    for (const r of compiled) {
      if (r.notAfter && i > 0 && r.notAfter.test(text[i - 1])) continue;
      r.re.lastIndex = i;
      const m = r.re.exec(text);
      if (!m || !m[0]) continue;
      const res = r.run(m, marks, parse);
      flush();
      if (typeof res === 'string') buf.text(res, marks);
      else if (Array.isArray(res)) for (const n of res) buf.node(n);
      else {
        let ms = marks;
        const add = Array.isArray(res.mark) ? res.mark : res.mark ? [res.mark] : [];
        for (const mk of add) ms = mk.addToSet(ms);
        // Inner text that didn't shrink would re-match the same rule forever: keep it literal.
        if (res.raw || res.inner.length >= m[0].length) buf.text(res.inner, ms);
        else for (const n of parse(res.inner, ms)) buf.node(n);
      }
      i += m[0].length;
      continue outer;
    }
    plain += text[i];
    i++;
  }
  flush();
  return mergeText(buf.take());
}

/** Merge adjacent text nodes with equal marks (parse() results are appended as nodes). */
export function mergeText(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (last && last.isText && n.isText && last.sameMarkup(n)) out[out.length - 1] = schema.text(last.text! + n.text!, last.marks);
    else out.push(n);
  }
  return out;
}

export const linkMark = (href: string): Mark | null => (/^\s*(javascript|vbscript|data):/i.test(href) ? null : MK.link.create({ href: href.trim() }));

/** A paragraph from inline nodes (null when empty and not forced). */
export function p(inl: PMNode[], attrs: Record<string, any> | null = null): PMNode {
  return S.paragraph.create(attrs, inl);
}

/** Lines → text with soft line breaks joined by spaces. */
export function joinLines(lines: string[]): string {
  return lines.map((l) => l.trim()).join(' ');
}

/** Split a document into lines (normalizing newlines and tabs to 8-column stops). */
export function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((l) => {
    if (!l.includes('\t')) return l;
    let out = '';
    for (const c of l) out += c === '\t' ? ' '.repeat(8 - (out.length % 8)) : c;
    return out;
  });
}

export const indentOf = (l: string) => l.length - l.trimStart().length;
export const blank = (l: string | undefined) => l == null || !l.trim();
