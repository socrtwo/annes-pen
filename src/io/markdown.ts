/**
 * Markdown import / export (CommonMark + GitHub Flavored Markdown + common extensions).
 *
 * The parser is self-contained (no dependencies) and never throws: block structure is parsed
 * line by line (containers are parsed recursively), link reference and footnote definitions are
 * collected first, then inline content is parsed with a CommonMark-style delimiter algorithm.
 *
 * Supported: ATX and setext headings, emphasis/strong with * and _, ~~strike~~, ==highlight==,
 * `code`, fenced and indented code, blockquotes (→ "Quote" paragraphs), bullet / ordered / task
 * lists with nesting, GFM pipe tables with alignment, inline and reference links and images,
 * autolinks (<…> and bare URLs), thematic breaks, hard breaks, footnotes ([^1] + definitions),
 * HTML blocks (via the HTML importer) and inline HTML formatting tags, $math$ and $$math$$,
 * YAML front matter (title/author/…), <!-- pagebreak --> markers.
 */
import { Mark, type Node as PMNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { styleLevel } from '../editor/schema';
import type { ExportOptions } from './index';
import { htmlToBlocks } from './html';
import {
  S, collectFootnotes, decodeEntity, decodeTextBytes, finishDoc, htmlToTextLines, inlineAtomText, listStart, makeBlob, markSet, newSettings, para,
  prepareDoc, type NoteInfo,
} from './serialize';
import type { DocSettings } from '../editor/settings';

// =============================================================================================
// Block parsing

type Align = 'left' | 'center' | 'right' | null;

type MdBlock =
  | { t: 'para'; text: string }
  | { t: 'heading'; level: number; text: string }
  | { t: 'code'; lang: string | null; text: string }
  | { t: 'hr' }
  | { t: 'pagebreak'; kind: 'page' | 'section' | 'column' }
  | { t: 'quote'; children: MdBlock[] }
  | { t: 'list'; ordered: boolean; start: number; items: { children: MdBlock[]; task: boolean | null }[] }
  | { t: 'table'; align: Align[]; header: string[]; rows: string[][] }
  | { t: 'html'; html: string }
  | { t: 'math'; tex: string };

interface Ctx {
  refs: Map<string, { dest: string; title: string | null }>;
  footnotes: Map<string, MdBlock[]>;
  depth: number;
}

const normLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const isBlank = (l: string) => /^[ \t]*$/.test(l);
const indentOf = (l: string) => { const m = /^ */.exec(l); return m ? m[0].length : 0; };

/** Expand tabs (4-column stops) in the leading part of a line (indentation and container markers). */
function expandLeading(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; continue; }
    if (c === ' ' || c === '>' || c === '-' || c === '+' || c === '*' || c === '.' || c === ')' || (c >= '0' && c <= '9')) { out += c; col++; continue; }
    break;
  }
  return out + line.slice(i);
}

interface ListMarker { indent: number; ordered: boolean; bullet: string; start: number; contentIndent: number; rest: string; empty: boolean }

function listMarker(line: string): ListMarker | null {
  const m = /^( {0,3})([-+*]|(\d{1,9})([.)]))(?=[ \t]|$)/.exec(line);
  if (!m) return null;
  const after = line.slice(m[0].length);
  const spaces = (/^ */.exec(after) || [''])[0].length;
  const ordered = !!m[3];
  const base = { indent: m[1].length, ordered, bullet: ordered ? m[4] : m[2], start: ordered ? parseInt(m[3], 10) : 1 };
  if (isBlank(after)) return { ...base, contentIndent: m[0].length + 1, rest: '', empty: true };
  if (spaces > 4) return { ...base, contentIndent: m[0].length + 1, rest: after.slice(1), empty: false };
  return { ...base, contentIndent: m[0].length + spaces, rest: after.slice(spaces), empty: false };
}

const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HTML_BLOCK_6 = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s/>]|$)/i;
const HTML_BLOCK_1 = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;
const HTML_BLOCK_7 = /^ {0,3}(?:<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>)[ \t]*$/;

function htmlBlockKind(line: string): number {
  if (HTML_BLOCK_1.test(line)) return 1;
  if (/^ {0,3}<!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(line)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return 5;
  if (HTML_BLOCK_6.test(line)) return 6;
  if (HTML_BLOCK_7.test(line)) return 7;
  return 0;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') {
      let n = 1; while (s[i + n] === '`') n++;
      if (!inCode) inCode = n; else if (inCode === n) inCode = 0;
      cur += '`'.repeat(n); i += n - 1; continue;
    }
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isDelimRow(line: string): boolean {
  return /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line) && (line.includes('|') || /-/.test(line));
}

function startsBlock(line: string): boolean {
  if (isBlank(line)) return true;
  if (HR_RE.test(line) || ATX_RE.test(line) || FENCE_RE.test(line) || /^ {0,3}>/.test(line)) return true;
  const k = htmlBlockKind(line);
  if (k >= 1 && k <= 6) return true;
  const lm = listMarker(line);
  if (lm && !lm.empty && (!lm.ordered || lm.start === 1)) return true;
  if (/^ {0,3}\$\$/.test(line)) return true;
  return false;
}

function parseBlocks(lines: string[], ctx: Ctx): MdBlock[] {
  const out: MdBlock[] = [];
  if (ctx.depth > 40) { out.push({ t: 'para', text: lines.join('\n') }); return out; }
  let i = 0;
  let paraLines: string[] | null = null;
  const closePara = () => {
    if (!paraLines) return;
    const text = stripRefDefs(paraLines, ctx);
    if (text.trim()) out.push({ t: 'para', text });
    paraLines = null;
  };
  const n = lines.length;
  let last = -1;
  while (i < n) {
    // Every branch consumes at least one line; this makes that a guarantee.
    if (i <= last) i = last + 1;
    if (i >= n) break;
    last = i;
    const line = lines[i];
    if (isBlank(line)) { closePara(); i++; continue; }
    const ind = indentOf(line);

    if (ind >= 4) {
      if (paraLines) { paraLines.push(line.trim()); i++; continue; }
      const code: string[] = [];
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) { code.push(lines[i].slice(Math.min(4, indentOf(lines[i])))); i++; }
      while (code.length && isBlank(code[code.length - 1])) code.pop();
      out.push({ t: 'code', lang: null, text: code.join('\n') });
      continue;
    }

    // Fenced code
    let m = FENCE_RE.exec(line);
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      closePara();
      const fence = m[2];
      const fenceIndent = m[1].length;
      const info = m[3].trim();
      const body: string[] = [];
      i++;
      const closeRe = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      while (i < n && !closeRe.test(lines[i])) {
        const l = lines[i];
        const strip = Math.min(fenceIndent, indentOf(l));
        body.push(l.slice(strip));
        i++;
      }
      i++; // closing fence (or EOF)
      out.push({ t: 'code', lang: info ? info.split(/\s+/)[0].replace(/^\{\.?|\}$/g, '') || null : null, text: body.join('\n') });
      continue;
    }

    // Math block $$ … $$
    if (/^ {0,3}\$\$/.test(line)) {
      const s = line.trim();
      const single = /^\$\$(.+)\$\$$/.exec(s);
      if (single) { closePara(); out.push({ t: 'math', tex: single[1].trim() }); i++; continue; }
      if (s === '$$' || !s.slice(2).includes('$$')) {
        closePara();
        const body: string[] = [s.slice(2)];
        i++;
        while (i < n && !lines[i].trim().endsWith('$$')) { body.push(lines[i]); i++; }
        if (i < n) { body.push(lines[i].trim().slice(0, -2)); i++; }
        out.push({ t: 'math', tex: body.join('\n').trim() });
        continue;
      }
    }

    // ATX heading
    m = ATX_RE.exec(line);
    if (m) {
      closePara();
      let text = m[2].trim();
      text = text.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      if (/^#+$/.test(text)) text = '';
      out.push({ t: 'heading', level: m[1].length, text });
      i++;
      continue;
    }

    // Setext heading underline
    if (paraLines && /^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
      const level = line.trim()[0] === '=' ? 1 : 2;
      const text = stripRefDefs(paraLines, ctx);
      paraLines = null;
      if (text.trim()) out.push({ t: 'heading', level, text: text.trim() });
      else if (level === 2) out.push({ t: 'hr' });
      i++;
      continue;
    }

    // Thematic break
    if (HR_RE.test(line)) { closePara(); out.push({ t: 'hr' }); i++; continue; }

    // Blockquote
    if (/^ {0,3}>/.test(line)) {
      closePara();
      const inner: string[] = [];
      let lastWasText = false;
      while (i < n) {
        const l = lines[i];
        const qm = /^ {0,3}> ?(.*)$/.exec(l);
        if (qm) {
          const content = expandLeading(qm[1]);
          inner.push(content);
          lastWasText = !isBlank(content);
          i++;
          continue;
        }
        if (!isBlank(l) && lastWasText && !startsBlock(l)) { inner.push(l); i++; continue; }
        break;
      }
      out.push({ t: 'quote', children: parseBlocks(inner, { ...ctx, depth: ctx.depth + 1 }) });
      continue;
    }

    // HTML block
    const hk = htmlBlockKind(line);
    if (hk && !(hk === 7 && paraLines)) {
      closePara();
      const body: string[] = [];
      const ends: Record<number, RegExp> = { 1: /<\/(script|pre|style|textarea)>/i, 2: /-->/, 3: /\?>/, 4: />/, 5: /\]\]>/ };
      if (hk <= 5) {
        while (i < n) { body.push(lines[i]); if (ends[hk].test(lines[i]) && (body.length > 1 || ends[hk].test(lines[i].replace(/^ {0,3}<!--|^ {0,3}<\?|^ {0,3}<!\[CDATA\[|^ {0,3}<!/, '')))) { i++; break; } i++; }
      } else {
        while (i < n && !isBlank(lines[i])) { body.push(lines[i]); i++; }
      }
      const html = body.join('\n');
      const comment = /^\s*<!--\s*(page\s*-?break|pagebreak|section\s*-?break|sectionbreak|column\s*-?break|columnbreak)\s*-->\s*$/i.exec(html);
      if (comment) {
        const k = comment[1].toLowerCase();
        out.push({ t: 'pagebreak', kind: k.startsWith('section') ? 'section' : k.startsWith('column') ? 'column' : 'page' });
        // A thematic break right after the marker belongs to it.
        let j = i;
        while (j < n && isBlank(lines[j])) j++;
        if (j < n && HR_RE.test(lines[j])) i = j + 1;
        continue;
      }
      if (hk === 2 || hk === 3 || hk === 4 || hk === 5) continue; // comments, processing instructions, declarations
      out.push({ t: 'html', html });
      continue;
    }

    // Footnote definition
    m = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(line);
    if (m) {
      closePara();
      const label = normLabel(m[1]);
      const body: string[] = [m[2]];
      i++;
      while (i < n) {
        const l = lines[i];
        if (isBlank(l)) {
          let j = i; while (j < n && isBlank(lines[j])) j++;
          if (j < n && indentOf(lines[j]) >= 4) { for (; i < j; i++) body.push(''); continue; }
          break;
        }
        if (indentOf(l) >= 4) { body.push(l.slice(4)); i++; continue; }
        if (!startsBlock(l) && !/^ {0,3}\[\^[^\]]+\]:/.test(l) && !isBlank(body[body.length - 1] || '')) { body.push(l.trim()); i++; continue; }
        break;
      }
      if (!ctx.footnotes.has(label)) ctx.footnotes.set(label, parseBlocks(body, { ...ctx, depth: ctx.depth + 1 }));
      continue;
    }

    // GFM table
    if (line.includes('|') && i + 1 < n && isDelimRow(lines[i + 1])) {
      const header = splitRow(line);
      const delims = splitRow(lines[i + 1]);
      if (header.length === delims.length) {
        closePara();
        const align: Align[] = delims.map((d) => {
          const l = d.startsWith(':'), r = d.endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
        });
        const rows: string[][] = [];
        i += 2;
        while (i < n && !isBlank(lines[i]) && lines[i].includes('|') && !(HR_RE.test(lines[i]) || ATX_RE.test(lines[i]) || FENCE_RE.test(lines[i]) || /^ {0,3}>/.test(lines[i]))) {
          const cells = splitRow(lines[i]);
          rows.push(Array.from({ length: header.length }, (_, k) => cells[k] ?? ''));
          i++;
        }
        out.push({ t: 'table', align, header, rows });
        continue;
      }
    }

    // List
    const lm = listMarker(line);
    if (lm && (!paraLines || (!lm.empty && (!lm.ordered || lm.start === 1)))) {
      closePara();
      const res = parseList(lines, i, lm, ctx);
      out.push(res.block);
      i = res.next;
      continue;
    }

    // Paragraph text
    const content = line.replace(/^[ \t]+/, '');
    if (paraLines) paraLines.push(content); else paraLines = [content];
    i++;
  }
  closePara();
  return out;
}

function parseList(lines: string[], start: number, first: ListMarker, ctx: Ctx): { block: MdBlock; next: number } {
  const items: { children: MdBlock[]; task: boolean | null }[] = [];
  let i = start;
  const n = lines.length;
  let mk: ListMarker | null = first;
  while (mk && i < n) {
    const content: string[] = [mk.rest];
    const ci = mk.contentIndent;
    let j = i + 1;
    let lastText = !mk.empty;
    let inFence = FENCE_RE.test(mk.rest);
    let blankCount = 0;
    while (j < n) {
      const l = lines[j];
      if (isBlank(l)) {
        if (mk.empty && content.length === 1 && content[0] === '') break; // an empty item may begin with at most one blank line
        content.push(''); lastText = false; blankCount++; j++; continue;
      }
      const ind = indentOf(l);
      if (ind >= ci) {
        const c = l.slice(ci);
        content.push(c);
        if (FENCE_RE.test(c)) inFence = !inFence;
        lastText = !inFence && !isBlank(c);
        blankCount = 0;
        j++;
        continue;
      }
      if (lastText && blankCount === 0 && !inFence && !startsBlock(l) && !listMarker(l)) { content.push(l.trim()); j++; continue; }
      break;
    }
    // Trailing blank lines are not part of the item.
    while (content.length > 1 && content[content.length - 1] === '') content.pop();
    const children = parseBlocks(content.map(expandLeading), { ...ctx, depth: ctx.depth + 1 });
    let task: boolean | null = null;
    const f = children[0];
    if (f && f.t === 'para') {
      const tm = /^\[([ xX])\][ \t]+/.exec(f.text) || /^\[([ xX])\]$/.exec(f.text);
      if (tm) { task = tm[1] !== ' '; f.text = f.text.slice(tm[0].length); if (!f.text.trim()) children.shift(); }
    }
    items.push({ children, task });
    i = j;
    // Skip blank lines between items.
    let k = i;
    while (k < n && isBlank(lines[k])) k++;
    const next = k < n ? listMarker(lines[k]) : null;
    if (next && next.ordered === first.ordered && next.bullet === first.bullet && next.indent < ci && !HR_RE.test(lines[k])) { mk = next; i = k; }
    else mk = null;
  }
  return { block: { t: 'list', ordered: first.ordered, start: first.start, items }, next: i };
}

/** Remove (and record) link reference definitions at the start of a paragraph. */
function stripRefDefs(lines: string[], ctx: Ctx): string {
  let text = lines.join('\n');
  const re = /^ {0,3}\[((?:[^\]\\]|\\.){1,999})\]:[ \t]*\n?[ \t]*(<[^>\n]*>|\S+)(?:[ \t]*\n?[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\)))?[ \t]*(?:\n|$)/;
  let guard = 0;
  while (guard++ < 1000) {
    const m = re.exec(text);
    if (!m || m[1].startsWith('^')) break;
    let dest = m[2];
    if (dest.startsWith('<')) dest = dest.slice(1, -1);
    const label = normLabel(m[1]);
    if (label && !ctx.refs.has(label)) ctx.refs.set(label, { dest: unescapeMd(dest), title: m[3] ? unescapeMd(m[3].slice(1, -1)) : null });
    text = text.slice(m[0].length);
  }
  return text;
}

function unescapeMd(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m0, e) => decodeEntity(e) ?? m0);
}

// =============================================================================================
// Inline parsing

type Inl =
  | { t: 'text'; v: string }
  | { t: 'delim'; ch: string; n: number; origN: number; canOpen: boolean; canClose: boolean }
  | { t: 'wrap'; mark: string; kids: Inl[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; title: string | null; kids: Inl[] }
  | { t: 'img'; src: string; alt: string; title: string | null; width?: number | null; height?: number | null }
  | { t: 'fn'; id: string }
  | { t: 'math'; v: string }
  | { t: 'br' }
  | { t: 'tag'; name: string; close: boolean; attrs: Record<string, string> };

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const isWs = (c: string) => c === '' || /\s/.test(c);
const isPunct = (c: string) => !!c && /[\p{P}\p{S}]/u.test(c);

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = unescapeMd(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** What earlier link-tail scans learned about the rest of the text, so repeated failures stay linear. */
interface TailMemo { find: (ch: string, from: number) => number; noClose: Record<string, number> }

/** src.indexOf(ch, from) that reuses the last answer for each character while it still holds. */
function indexFinder(src: string): (ch: string, from: number) => number {
  const last: Record<string, { from: number; at: number }> = {};
  return (ch, from) => {
    const c = last[ch];
    if (c && from >= c.from && (c.at < 0 || from <= c.at)) return c.at;
    const at = src.indexOf(ch, from);
    last[ch] = { from, at };
    return at;
  };
}

function parseLinkTail(src: string, j: number, memo: TailMemo = { find: indexFinder(src), noClose: {} }): { dest: string; title: string | null; end: number } | null {
  if (src[j] !== '(') return null;
  let k = j + 1;
  const skipWs = () => { while (k < src.length && /[ \t\n]/.test(src[k])) k++; };
  skipWs();
  let dest = '';
  if (src[k] === '<') {
    const e = memo.find('>', k);
    if (e < 0) return null;
    const nl = memo.find('\n', k);
    if (nl >= 0 && nl < e) return null;
    dest = src.slice(k + 1, e);
    k = e + 1;
  } else {
    let depth = 0;
    const s0 = k;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\' && k + 1 < src.length && ASCII_PUNCT.test(src[k + 1])) { k += 2; continue; }
      if (/[\s]/.test(c) || c.charCodeAt(0) < 32) break;
      // Parentheses nest at most 32 deep (as in cmark), which keeps unclosed "(" runs linear.
      if (c === '(') { if (++depth > 32) return null; }
      if (c === ')') { if (depth === 0) break; depth--; }
      k++;
    }
    if (depth !== 0) return null;
    dest = src.slice(s0, k);
  }
  const beforeTitle = k;
  skipWs();
  let title: string | null = null;
  const q = src[k];
  if ((q === '"' || q === "'" || q === '(') && k > beforeTitle) {
    const close = q === '(' ? ')' : q;
    // No unescaped closer after an earlier opener means none after this one either.
    if (k >= (memo.noClose[close] ?? Infinity)) return null;
    let e = k + 1;
    while (e < src.length && src[e] !== close) { if (src[e] === '\\') e++; e++; }
    if (e >= src.length) { memo.noClose[close] = Math.min(memo.noClose[close] ?? Infinity, k); return null; }
    title = unescapeMd(src.slice(k + 1, e));
    k = e + 1;
    skipWs();
  }
  if (src[k] !== ')') return null;
  return { dest: unescapeMd(dest), title, end: k + 1 };
}

function plainOf(nodes: Inl[]): string {
  let s = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code' || n.t === 'math') s += n.v;
    else if (n.t === 'delim') s += n.ch.repeat(n.n);
    else if (n.t === 'wrap' || n.t === 'link') s += plainOf(n.kids);
    else if (n.t === 'img') s += n.alt;
    else if (n.t === 'br') s += ' ';
  }
  return s;
}

function processEmphasis(arr: Inl[]): void {
  // Per kind of closer, the element below which no opener can match (CommonMark's openers_bottom):
  // a run of closers without openers ("a* a* a* ...") is then linear, not quadratic.
  const bottom = new Map<string, Inl>();
  let i = 0;
  let guard = 0;
  while (i < arr.length && guard++ < 100000) {
    const closer = arr[i];
    if (closer.t !== 'delim' || !closer.canClose || closer.n === 0) { i++; continue; }
    const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.origN % 3}${closer.ch === '~' || closer.ch === '=' ? closer.n : ''}`;
    const stop = bottom.get(key);
    let found = -1;
    for (let j = i - 1; j >= 0; j--) {
      const op = arr[j];
      if (op === stop) break;
      if (op.t !== 'delim' || op.ch !== closer.ch || !op.canOpen || op.n === 0) continue;
      if (closer.ch === '*' || closer.ch === '_') {
        const odd = (op.canClose || closer.canOpen) && (op.origN + closer.origN) % 3 === 0 && !(op.origN % 3 === 0 && closer.origN % 3 === 0);
        if (!odd) { found = j; break; }
      } else if (closer.ch === '~') { if (op.n === closer.n) { found = j; break; } }
      else if (op.n === 2 && closer.n === 2) { found = j; break; }
    }
    if (found < 0) { if (i > 0) bottom.set(key, arr[i - 1]); i++; continue; }
    const op = arr[found] as Extract<Inl, { t: 'delim' }>;
    let use: number, mark: string;
    if (closer.ch === '~') { use = closer.n; mark = 'strike'; }
    else if (closer.ch === '=') { use = 2; mark = 'highlight'; }
    else { use = op.n >= 2 && closer.n >= 2 ? 2 : 1; mark = use === 2 ? 'strong' : 'em'; }
    const kids = arr.slice(found + 1, i);
    op.n -= use;
    closer.n -= use;
    const wrap: Inl = { t: 'wrap', mark, kids };
    arr.splice(found + 1, i - found - 1, wrap);
    if (bottom.size) {
      // A boundary that is wrapped or removed moves to the wrap, below which nothing changed.
      const gone = new Set<Inl>(kids);
      if (op.n === 0) gone.add(op);
      if (closer.n === 0) gone.add(closer);
      for (const [k, el] of bottom) if (gone.has(el)) bottom.set(k, wrap);
    }
    let ci = found + 2;
    if (op.n === 0) { arr.splice(found, 1); ci--; }
    if (closer.n === 0) arr.splice(ci, 1);
    i = ci;
  }
}

const TAG_MARKS: Record<string, string> = {
  u: 'underline', ins: 'underline', sup: 'sup', sub: 'sub', mark: 'highlight', s: 'strike', del: 'strike', strike: 'strike',
  b: 'strong', strong: 'strong', i: 'em', em: 'em', code: 'code', kbd: 'code', tt: 'code', small: 'small', span: 'span', a: 'a', big: 'span', cite: 'em', q: 'span', abbr: 'span', var: 'em', samp: 'code', font: 'span',
};

function processTags(arr: Inl[]): void {
  for (const n of arr) if (n.t === 'wrap' || n.t === 'link') processTags(n.kids);
  let i = 0;
  let guard = 0;
  while (i < arr.length && guard++ < 100000) {
    const n = arr[i];
    if (n.t !== 'tag') { i++; continue; }
    if (n.name === 'br') { arr[i] = { t: 'br' }; i++; continue; }
    if (n.name === 'img') {
      const w = parseFloat(n.attrs.width || ''), h = parseFloat(n.attrs.height || '');
      arr[i] = { t: 'img', src: n.attrs.src || '', alt: n.attrs.alt || '', title: n.attrs.title || null, width: w ? w * 0.75 : null, height: h ? h * 0.75 : null };
      i++;
      continue;
    }
    if (n.close || !TAG_MARKS[n.name]) { arr.splice(i, 1); continue; }
    // Find the matching close tag at this level.
    let depth = 0, end = -1;
    for (let j = i + 1; j < arr.length; j++) {
      const x = arr[j];
      if (x.t === 'tag' && x.name === n.name) {
        if (!x.close) depth++;
        else if (depth === 0) { end = j; break; } else depth--;
      }
    }
    if (end < 0) { arr.splice(i, 1); continue; }
    const kids = arr.slice(i + 1, end);
    processTags(kids);
    const mark = TAG_MARKS[n.name];
    let repl: Inl;
    if (mark === 'a') repl = n.attrs.href ? { t: 'link', href: n.attrs.href, title: n.attrs.title || null, kids } : { t: 'wrap', mark: 'span', kids };
    else repl = { t: 'wrap', mark, kids };
    arr.splice(i, end - i + 1, repl);
    i++;
  }
}

const EMAIL_RE = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const URI_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/;
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;

function parseInline(src: string, ctx: Ctx): Inl[] {
  const nodes: Inl[] = [];
  const brackets: { idx: number; image: boolean; active: boolean; pos: number }[] = [];
  let text = '';
  const pushText = () => { if (text) { nodes.push({ t: 'text', v: text }); text = ''; } };
  let i = 0;
  const len = src.length;
  let closers: number[] | null = null, nextCloser = 0;
  const memo: TailMemo = { find: indexFinder(src), noClose: {} };
  let noCommentEnd = Infinity;
  // Drop trailing spaces (and tabs) from the text collected since the last line break.
  const trimEnd = (tabs: boolean) => {
    let e = text.length;
    while (e > 0 && (text.charCodeAt(e - 1) === 32 || (tabs && text.charCodeAt(e - 1) === 9))) e--;
    if (e < text.length) text = text.slice(0, e);
  };
  // Every branch consumes at least one character.
  while (i < len) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { trimEnd(false); pushText(); nodes.push({ t: 'br' }); i += 2; while (src[i] === ' ' || src[i] === '\t') i++; continue; }
      if (nx && ASCII_PUNCT.test(nx)) { text += nx; i += 2; continue; }
      text += '\\'; i++; continue;
    }
    if (c === '`') {
      let n = 1; while (src[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let k = i + n;
      let end = -1;
      while (k < len) {
        const e = src.indexOf(fence, k);
        if (e < 0) break;
        let m = fence.length; while (src[e + m] === '`') m++;
        if (m === n) { end = e; break; }
        k = e + m;
      }
      if (end < 0) { text += fence; i += n; continue; }
      let v = src.slice(i + n, end).replace(/\n/g, ' ');
      if (v.length > 2 && v[0] === ' ' && v[v.length - 1] === ' ' && v.trim()) v = v.slice(1, -1);
      else if (v.length === 2 && v === '  ') v = ' ';
      pushText();
      nodes.push({ t: 'code', v });
      i = end + n;
      continue;
    }
    if (c === '*' || c === '_' || c === '~' || c === '=') {
      let n = 1; while (src[i + n] === c) n++;
      if ((c === '~' && n > 2) || (c === '=' && n !== 2)) { text += c.repeat(n); i += n; continue; }
      const before = i === 0 ? '' : src[i - 1];
      const after = i + n >= len ? '' : src[i + n];
      const left = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const right = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let canOpen = left, canClose = right;
      if (c === '_') { canOpen = left && (!right || isPunct(before)); canClose = right && (!left || isPunct(after)); }
      pushText();
      nodes.push({ t: 'delim', ch: c, n, origN: n, canOpen, canClose });
      i += n;
      continue;
    }
    if (c === '$') {
      if (src[i + 1] === '$') {
        const e = src.indexOf('$$', i + 2);
        if (e > i + 2) { pushText(); nodes.push({ t: 'math', v: src.slice(i + 2, e).trim() }); i = e + 2; continue; }
        text += '$$'; i += 2; continue;
      }
      const nx = src[i + 1];
      if (nx && !isWs(nx)) {
        // Closing $ positions (not escaped, not after a space, not before a digit), found once:
        // rescanning the rest of the text for every opener is quadratic ("$1 $2 $3 ...").
        if (!closers) {
          closers = [];
          for (let e = src.indexOf('$', 1); e >= 0; e = src.indexOf('$', e + 1)) if (src[e - 1] !== '\\' && !isWs(src[e - 1]) && !/\d/.test(src[e + 1] || '')) closers.push(e);
        }
        while (nextCloser < closers.length && closers[nextCloser] <= i) nextCloser++;
        const found = nextCloser < closers.length ? closers[nextCloser] : -1;
        if (found > i + 1) { pushText(); nodes.push({ t: 'math', v: src.slice(i + 1, found).replace(/\\\$/g, '$') }); i = found + 1; continue; }
      }
      text += '$'; i++; continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      pushText();
      nodes.push({ t: 'text', v: '![' });
      brackets.push({ idx: nodes.length - 1, image: true, active: true, pos: i + 2 });
      i += 2;
      continue;
    }
    if (c === '[') {
      const fm = /^\[\^([^\]\s]+)\]/.exec(src.slice(i, i + 200));
      if (fm && ctx.footnotes.has(normLabel(fm[1]))) { pushText(); nodes.push({ t: 'fn', id: normLabel(fm[1]) }); i += fm[0].length; continue; }
      pushText();
      nodes.push({ t: 'text', v: '[' });
      brackets.push({ idx: nodes.length - 1, image: false, active: true, pos: i + 1 });
      i++;
      continue;
    }
    if (c === ']') {
      const opener = brackets[brackets.length - 1];
      if (!opener) { text += ']'; i++; continue; }
      if (!opener.active) { brackets.pop(); text += ']'; i++; continue; }
      pushText();
      const labelText = src.slice(opener.pos, i);
      let j = i + 1;
      let dest: string | null = null, title: string | null = null;
      const tail = parseLinkTail(src, j, memo);
      if (tail) { dest = tail.dest; title = tail.title; j = tail.end; }
      else {
        const rm = /^\[((?:[^\]\\]|\\.){0,999})\]/.exec(src.slice(j, j + 1000));
        let label = labelText, refEnd = j;
        if (rm) { label = rm[1] || labelText; refEnd = j + rm[0].length; }
        const def = ctx.refs.get(normLabel(label));
        if (def) { dest = def.dest; title = def.title; j = refEnd; }
      }
      if (dest != null) {
        const kids = nodes.splice(opener.idx + 1);
        nodes.pop();
        processEmphasis(kids);
        if (opener.image) nodes.push({ t: 'img', src: dest, alt: plainOf(kids), title });
        else {
          nodes.push({ t: 'link', href: dest, title, kids });
          for (const b of brackets) if (!b.image) b.active = false;
        }
        brackets.pop();
        i = j;
      } else { brackets.pop(); text += ']'; i++; }
      continue;
    }
    if (c === '<') {
      const rest = src.slice(i, i + 2000);
      let m = URI_RE.exec(rest);
      if (m) { pushText(); nodes.push({ t: 'link', href: m[1], title: null, kids: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
      m = EMAIL_RE.exec(rest);
      if (m) { pushText(); nodes.push({ t: 'link', href: 'mailto:' + m[1], title: null, kids: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
      if (rest.startsWith('<!--') && i < noCommentEnd) { const e = src.indexOf('-->', i + 4); if (e >= 0) { i = e + 3; continue; } noCommentEnd = i; }
      m = TAG_RE.exec(rest);
      if (m) { pushText(); nodes.push({ t: 'tag', name: m[2].toLowerCase(), close: !!m[1], attrs: parseAttrs(m[3]) }); if (m[4]) { /* self-closing */ } i += m[0].length; continue; }
      text += '<'; i++; continue;
    }
    if (c === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i, i + 40));
      if (m) { const d = decodeEntity(m[1]); if (d != null) { text += d; i += m[0].length; continue; } }
      text += '&'; i++; continue;
    }
    if (c === '\n') {
      const tl = text.length;
      const hard = (tl >= 2 && text.charCodeAt(tl - 1) === 32 && text.charCodeAt(tl - 2) === 32) || (tl >= 1 && text.charCodeAt(tl - 1) === 9);
      if (hard) { trimEnd(true); pushText(); nodes.push({ t: 'br' }); }
      // The text ends here so the next line's checks only look at that line.
      else { trimEnd(false); text += ' '; pushText(); }
      i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      continue;
    }
    if ((c === 'h' || c === 'w' || c === 'H' || c === 'W') && (i === 0 || /[\s*_~(]/.test(src[i - 1]))) {
      const m = /^(?:https?:\/\/|www\.)[^\s<]+/i.exec(src.slice(i, i + 4000));
      if (m && (/^www\./i.test(m[0]) ? /^www\.[\w-]+\.[\w-]/i.test(m[0]) : /^https?:\/\/[\w-]/i.test(m[0])) && !brackets.some((b) => b.active && !b.image)) {
        let url = m[0];
        // Trailing punctuation and unbalanced parentheses are not part of the link.
        let guard2 = 0;
        while (guard2++ < 100) {
          const last = url[url.length - 1];
          if (/[?!.,:*_~'"]/.test(last)) { url = url.slice(0, -1); continue; }
          if (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) { url = url.slice(0, -1); continue; }
          if (last === ';' && /&\w+;$/.test(url)) { url = url.replace(/&\w+;$/, ''); continue; }
          break;
        }
        pushText();
        nodes.push({ t: 'link', href: /^www\./i.test(url) ? 'http://' + url : url, title: null, kids: [{ t: 'text', v: url }] });
        i += url.length;
        continue;
      }
    }
    text += c;
    i++;
  }
  pushText();
  processEmphasis(nodes);
  processTags(nodes);
  return nodes;
}

// =============================================================================================
// AST → ProseMirror

interface Conv { ctx: Ctx; notes: Map<string, string> }

function markFor(name: string): Mark | null {
  const M = S.marks;
  switch (name) {
    case 'strong': return M.bold.create();
    case 'em': return M.italic.create();
    case 'strike': return M.strike.create();
    case 'highlight': return M.highlight.create();
    case 'underline': return M.underline.create();
    case 'sup': return M.sup.create();
    case 'sub': return M.sub.create();
    case 'code': return M.code.create();
    default: return null;
  }
}

function inlToPM(nodes: Inl[], marks: readonly Mark[], conv: Conv, out: PMNode[]): void {
  for (const n of nodes) {
    switch (n.t) {
      case 'text': if (n.v) out.push(S.text(n.v, marks as Mark[])); break;
      case 'delim': if (n.n > 0) out.push(S.text(n.ch.repeat(n.n), marks as Mark[])); break;
      case 'wrap': { const m = markFor(n.mark); inlToPM(n.kids, m ? markSet([...marks, m]) : marks, conv, out); break; }
      case 'code': if (n.v) out.push(S.text(n.v, markSet([...marks, S.marks.code.create()]))); break;
      case 'link': inlToPM(n.kids, markSet([...marks, S.marks.link.create({ href: n.href, title: n.title })]), conv, out); break;
      case 'img': out.push(S.nodes.image.create({ src: n.src, alt: n.alt || '', title: n.title || null, width: n.width ?? null, height: n.height ?? null }, null, marks as Mark[])); break;
      case 'fn': out.push(S.nodes.footnote.create({ text: conv.notes.get(n.id) ?? '' }, null, marks.filter((m) => m.type !== S.marks.sup))); break;
      case 'math': if (n.v) out.push(S.nodes.math_inline.create({ latex: n.v }, null, marks as Mark[])); break;
      case 'br': out.push(S.nodes.hard_break.create(null, null, marks as Mark[])); break;
      default: break;
    }
  }
}

function inlineNodes(text: string, conv: Conv): PMNode[] {
  const out: PMNode[] = [];
  try {
    inlToPM(parseInline(text.trimEnd(), conv.ctx), [], conv, out);
  } catch {
    if (text) out.push(S.text(text));
  }
  return out;
}

function blocksToPM(blocks: MdBlock[], conv: Conv, quote: boolean): PMNode[] {
  const out: PMNode[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'para': out.push(para(inlineNodes(b.text, conv), quote ? { style: 'Quote' } : null)); break;
      case 'heading': out.push(para(inlineNodes(b.text, conv), { style: `Heading ${b.level}` })); break;
      case 'code': out.push(S.nodes.code_block.create({ language: b.lang }, b.text ? S.text(b.text) : null)); break;
      case 'hr': out.push(S.nodes.horizontal_rule.create()); break;
      case 'pagebreak': out.push(b.kind === 'section' ? S.nodes.section_break.create() : b.kind === 'column' ? S.nodes.column_break.create() : S.nodes.page_break.create()); break;
      case 'math': out.push(S.nodes.math_block.create({ latex: b.tex })); break;
      case 'quote': out.push(...blocksToPM(b.children, conv, true)); break;
      case 'html': {
        const blocks2 = htmlToBlocks(b.html);
        out.push(...blocks2);
        break;
      }
      case 'table': {
        const mkCell = (txt: string, header: boolean, align: Align) => (header ? S.nodes.table_header : S.nodes.table_cell).create(null,
          para(inlineNodes(txt, conv), align ? { align } : null));
        const rows = [S.nodes.table_row.create(null, b.header.map((h, k) => mkCell(h, true, b.align[k])))];
        for (const r of b.rows) rows.push(S.nodes.table_row.create(null, r.map((c, k) => mkCell(c, false, b.align[k]))));
        out.push(S.nodes.table.create({ headerRows: 1 }, rows));
        break;
      }
      case 'list': {
        const allTask = b.items.length > 0 && b.items.every((it) => it.task != null);
        const items = b.items.map((it) => {
          const kids = blocksToPM(it.children, conv, false);
          if (!kids.length || kids[0].type !== S.nodes.paragraph) kids.unshift(para());
          if (allTask) return S.nodes.task_item.create({ checked: !!it.task }, kids);
          return S.nodes.list_item.create({ checked: it.task }, kids);
        });
        if (allTask) out.push(S.nodes.task_list.create(null, items));
        else if (b.ordered) out.push(S.nodes.ordered_list.create({ order: b.start }, items));
        else out.push(S.nodes.bullet_list.create(null, items));
        break;
      }
    }
  }
  return out;
}

function footnoteText(blocks: MdBlock[], conv: Conv): string {
  const parts: string[] = [];
  const walk = (bs: MdBlock[]) => {
    for (const b of bs) {
      if (b.t === 'para' || b.t === 'heading') parts.push(plainOf(parseInline(b.text, conv.ctx)).trim());
      else if (b.t === 'code') parts.push(b.text);
      else if (b.t === 'quote') walk(b.children);
      else if (b.t === 'list') for (const it of b.items) walk(it.children);
      else if (b.t === 'math') parts.push(b.tex);
    }
  };
  walk(blocks);
  return parts.filter(Boolean).join('\n');
}

function parseFrontMatter(lines: string[], settings: DocSettings): string[] {
  if (lines[0]?.trim() !== '---') return lines;
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, 200); i++) if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  if (end < 2) return lines;
  const body = lines.slice(1, end);
  if (!body.every((l) => isBlank(l) || /^[\w-]+\s*:/.test(l) || /^\s+/.test(l) || /^\s*-\s/.test(l))) return lines;
  for (const l of body) {
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(l);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (!val) continue;
    if (key === 'title') settings.properties.title = val;
    else if (key === 'author' || key === 'authors') settings.properties.author = val.replace(/^\[|\]$/g, '');
    else if (key === 'subject') settings.properties.subject = val;
    else if (key === 'description' || key === 'abstract') settings.properties.comments = val;
    else if (key === 'keywords' || key === 'tags') settings.properties.keywords = val.replace(/^\[|\]$/g, '');
    else if (key === 'lang' || key === 'language') settings.language = val;
    else settings.customProps[m[1]] = val;
  }
  return lines.slice(end + 1);
}

/** Parse Markdown text into schema blocks (never throws). */
export function markdownToBlocks(md: string, settings?: DocSettings): PMNode[] {
  try {
    let lines = md.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\ufffd').split('\n').map(expandLeading);
    if (settings) lines = parseFrontMatter(lines, settings);
    const ctx: Ctx = { refs: new Map(), footnotes: new Map(), depth: 0 };
    const blocks = parseBlocks(lines, ctx);
    const conv: Conv = { ctx, notes: new Map() };
    for (const [k, v] of ctx.footnotes) conv.notes.set(k, footnoteText(v, conv));
    return blocksToPM(blocks, conv, false);
  } catch {
    return md.split(/\n/).map((l) => para(l ? [S.text(l)] : []));
  }
}

export async function importMarkdown(data: ArrayBuffer, name: string): Promise<PMNode> {
  const settings = newSettings();
  let blocks: PMNode[] = [];
  try {
    // Same decoding as plain text: BOMs (UTF-16 too), then UTF-8 with a Windows-1252 fallback.
    const text = decodeTextBytes(data).replace(/^\uFEFF/, '');
    blocks = markdownToBlocks(text, settings);
  } catch { /* empty doc */ }
  void name;
  return finishDoc(blocks, settings);
}

// =============================================================================================
// Export

interface WCtx { notes: Map<PMNode, NoteInfo>; used: NoteInfo[] }

const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'highlight', 'sup', 'sub', 'code'];

function escapeText(s: string): string {
  return s
    .replace(/[\\`*_[\]<>~|$]/g, '\\$&')
    .replace(/=(?==)/g, '\\=')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
    .replace(/\u00a0/g, '&nbsp;');
}

function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)([-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, '$1$2\\$3')
    .replace(/^(\s*)(=+|-+)\s*$/, (m, sp, run) => `${sp}\\${run}`)
    .replace(/^[ \t]+/, '');
}

function linkDest(href: string): string {
  if (!href) return '<>';
  if (/[\s()<>]/.test(href)) return `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`;
  return href;
}

function linkTitle(t: string | null | undefined): string {
  return t ? ` "${t.replace(/["\\]/g, '\\$&')}"` : '';
}

interface Seg { kind: 'text' | 'atom'; text: string; node: PMNode; marks: Mark[] }

function mdMarks(marks: readonly Mark[]): Mark[] {
  return marks.filter((m) => MARK_ORDER.includes(m.type.name)).sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
}

function openMark(m: Mark, codeContent: string): string {
  switch (m.type.name) {
    case 'link': return '[';
    case 'bold': return '**';
    case 'italic': return '*';
    case 'strike': return '~~';
    case 'underline': return '<u>';
    case 'highlight': return '==';
    case 'sup': return '<sup>';
    case 'sub': return '<sub>';
    case 'code': {
      const runs = codeContent.match(/`+/g) || [];
      const n = Math.max(0, ...runs.map((r) => r.length)) + 1;
      const pad = codeContent.startsWith('`') || codeContent.endsWith('`') || (/^ .* $/.test(codeContent) && codeContent.trim()) ? ' ' : '';
      return '`'.repeat(n) + pad;
    }
  }
  return '';
}

function closeMark(m: Mark, opened: string): string {
  switch (m.type.name) {
    case 'link': return `](${linkDest(m.attrs.href)}${linkTitle(m.attrs.title)})`;
    case 'bold': return '**';
    case 'italic': return '*';
    case 'strike': return '~~';
    case 'underline': return '</u>';
    case 'highlight': return '==';
    case 'sup': return '</sup>';
    case 'sub': return '</sub>';
    case 'code': { const ticks = opened.replace(/ $/, ''); return (opened.endsWith(' ') ? ' ' : '') + ticks; }
  }
  return '';
}

function atomMd(node: PMNode, w: WCtx, lineBreak: string): string {
  switch (node.type.name) {
    case 'hard_break': return lineBreak;
    case 'image': {
      const alt = String(node.attrs.alt || '').replace(/[[\]\\]/g, '\\$&');
      return `![${alt}](${linkDest(node.attrs.src)}${linkTitle(node.attrs.title)})`;
    }
    case 'footnote': {
      const info = w.notes.get(node);
      if (!info) return '';
      if (!w.used.includes(info)) w.used.push(info);
      return `[^${w.used.indexOf(info) + 1}]`;
    }
    case 'math_inline': return node.attrs.latex ? `$${String(node.attrs.latex).replace(/\$/g, '\\$')}$` : '';
    case 'bookmark': case 'index_entry': return '';
    case 'symbol': return node.attrs.kind === 'optionalHyphen' ? '&shy;' : '';
    default: return escapeText(inlineAtomText(node));
  }
}

/** Serialize the inline content of a textblock. */
function inlineMd(node: PMNode, w: WCtx, lineBreak = '\\\n'): string {
  const segs: Seg[] = [];
  node.forEach((c) => {
    if (c.isText) segs.push({ kind: 'text', text: c.text || '', node: c, marks: mdMarks(c.marks) });
    else segs.push({ kind: 'atom', text: '', node: c, marks: mdMarks(c.marks) });
  });
  // A hard break at the end of a block has nothing to break before (and "\" would be literal text).
  while (segs.length && segs[segs.length - 1].kind === 'atom' && segs[segs.length - 1].node.type === S.nodes.hard_break) segs.pop();
  // Output pieces; delimiter marks remember where they opened and closed so that runs which would
  // not parse as emphasis (such as "**bold.**next") can fall back to HTML tags.
  const out: string[] = [];
  const pairs: { mark: string; open: number; close: number }[] = [];
  const stack: { mark: Mark; opened: string; at: number }[] = [];
  const closeTop = () => {
    const s = stack.pop()!;
    if (s.at >= 0) pairs.push({ mark: s.mark.type.name, open: s.at, close: out.length });
    out.push(closeMark(s.mark, s.opened));
  };
  let pendingTrail = '';
  const prefixLen = (want: Mark[]) => { let k = 0; while (k < stack.length && k < want.length && stack[k].mark.eq(want[k])) k++; return k; };
  for (let idx = 0; idx < segs.length; idx++) {
    const seg = segs[idx];
    let want = seg.marks;
    const hasCode = want.some((m) => m.type.name === 'code');
    let lead = '', core = seg.text, trail = '';
    if (seg.kind === 'text' && !hasCode) {
      const lm = /^\s*/.exec(core)![0], tm = /\s*$/.exec(core)![0];
      if (lm.length === core.length) want = stack.slice(0, prefixLen(want)).map((x) => x.mark);
      else { lead = lm; trail = tm; core = core.slice(lm.length, core.length - tm.length); }
    }
    if (seg.kind === 'atom' && seg.node.type.name === 'hard_break') want = stack.slice(0, prefixLen(want)).map((x) => x.mark);
    const k = prefixLen(want);
    while (stack.length > k) closeTop();
    out.push(pendingTrail); pendingTrail = '';
    out.push(lead.replace(/\u00a0/g, '&nbsp;'));
    for (let x = k; x < want.length; x++) {
      let codeContent = '';
      if (want[x].type.name === 'code') {
        for (let y = idx; y < segs.length && segs[y].marks.some((m) => m.type.name === 'code'); y++) codeContent += segs[y].text;
      }
      const opened = openMark(want[x], codeContent);
      stack.push({ mark: want[x], opened, at: HTML_DELIM[want[x].type.name] ? out.length : -1 });
      out.push(opened);
    }
    if (seg.kind === 'text') out.push(hasCode ? core : escapeText(core));
    else out.push(atomMd(seg.node, w, lineBreak));
    pendingTrail = trail.replace(/\u00a0/g, '&nbsp;');
  }
  while (stack.length) closeTop();
  out.push(pendingTrail);
  fixFlanking(out, pairs);
  return out.join('');
}

const HTML_DELIM: Record<string, string> = { bold: 'strong', italic: 'em', strike: 'del', highlight: 'mark' };

/**
 * CommonMark only reads a delimiter run as an opener when it is left-flanking and as a closer when
 * it is right-flanking ("**bold.**next" is neither bold nor closed). Such pairs are written as HTML.
 */
function fixFlanking(out: string[], pairs: { mark: string; open: number; close: number }[]): void {
  if (!pairs.length) return;
  const delimAt = new Map<number, string>();
  for (const p of pairs) { delimAt.set(p.open, out[p.open][0]); delimAt.set(p.close, out[p.close][0]); }
  // The character next to a delimiter run: adjacent delimiters of the same character are one run.
  const near = (i: number, dir: -1 | 1) => {
    const ch = delimAt.get(i);
    for (let j = i + dir; j >= 0 && j < out.length; j += dir) {
      if (!out[j]) continue;
      if (delimAt.get(j) === ch) continue;
      return dir < 0 ? out[j][out[j].length - 1] : out[j][0];
    }
    return '';
  };
  const ws = (c: string) => !c || /\s/.test(c);
  const punct = (c: string) => !!c && /[\p{P}\p{S}]/u.test(c);
  const leftFlank = (b: string, a: string) => !ws(a) && (!punct(a) || ws(b) || punct(b));
  const rightFlank = (b: string, a: string) => !ws(b) && (!punct(b) || ws(a) || punct(a));
  const bad: typeof pairs = [];
  for (const p of pairs) {
    if (!leftFlank(near(p.open, -1), near(p.open, 1)) || !rightFlank(near(p.close, -1), near(p.close, 1))) bad.push(p);
  }
  for (const p of bad) {
    const tag = HTML_DELIM[p.mark];
    out[p.open] = `<${tag}>`;
    out[p.close] = `</${tag}>`;
  }
}

function indentLines(s: string, first: string, rest: string): string {
  return s.split('\n').map((l, i) => (i === 0 ? first + l : l ? rest + l : l)).join('\n');
}

function paragraphMd(node: PMNode, w: WCtx): string {
  const style = node.attrs.style as string;
  const lvl = styleLevel(style, node.attrs.outlineLevel);
  if (lvl > 0 || style === 'Title') {
    // A closing run of "#" would be read as the optional closing sequence.
    const text = inlineMd(node, w, ' ').replace(/\n/g, ' ').trim().replace(/(^|[ \t])(#+)$/, '$1\\$2');
    if (!text) return '';
    return `${'#'.repeat(style === 'Title' ? 1 : Math.min(6, lvl))} ${text}`;
  }
  const body = inlineMd(node, w).split('\n').map(escapeLineStart).join('\n');
  if (!body.trim()) return '';
  if (style === 'Subtitle') return `**${body.trim()}**`;
  if (style === 'Quote' || style === 'Intense Quote' || style === 'Block Text') return body.split('\n').map((l) => `> ${l}`).join('\n');
  return body;
}

function codeFence(text: string): string {
  const runs = text.match(/^`{3,}/gm) || [];
  return '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

function tableMd(node: PMNode, w: WCtx): string {
  let map: TableMap;
  try { map = TableMap.get(node); } catch { return ''; }
  const cellText = (cell: PMNode | null) => {
    if (!cell) return '';
    const parts: string[] = [];
    cell.forEach((b) => {
      if (b.isTextblock) parts.push(b.type === S.nodes.code_block ? '`' + b.textContent.replace(/\n/g, ' ') + '`' : inlineMd(b, w, '<br>').replace(/\n/g, ' '));
      else b.descendants((d) => { if (d.isTextblock) { parts.push(inlineMd(d, w, '<br>').replace(/\n/g, ' ')); return false; } return true; });
    });
    return parts.filter((p) => p.trim()).join('<br>').trim();
  };
  const rows: string[][] = [];
  const aligns: string[] = [];
  for (let r = 0; r < map.height; r++) {
    const row: string[] = [];
    for (let c = 0; c < map.width; c++) {
      const pos = map.map[r * map.width + c];
      const rect = map.findCell(pos);
      const cell = node.nodeAt(pos);
      if (rect.left === c && rect.top === r) {
        row.push(cellText(cell));
        if (r === 0) {
          const al = cell?.firstChild?.attrs.align;
          aligns[c] = al === 'center' ? ':---:' : al === 'right' ? '---:' : al === 'left' ? ':---' : '---';
        }
      } else {
        row.push('');
        if (r === 0) aligns[c] = '---';
      }
    }
    rows.push(row);
  }
  if (!rows.length) return '';
  const line = (cells: string[]) => `| ${cells.map((c) => c || ' ').join(' | ')} |`;
  return [line(rows[0]), `| ${aligns.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function listMd(node: PMNode, w: WCtx): string {
  const t = node.type;
  const items: string[] = [];
  let n = t === S.nodes.ordered_list ? Math.max(0, listStart(node.attrs.order)) : 1;
  node.forEach((item) => {
    let marker = '- ';
    if (t === S.nodes.ordered_list) marker = `${n++}. `;
    const checked = t === S.nodes.task_list ? !!item.attrs.checked : item.attrs.checked;
    const task = checked == null ? '' : checked ? '[x] ' : '[ ] ';
    const parts: string[] = [];
    let prevList = false;
    item.forEach((b, _o, i) => {
      const s = blockMd(b, w);
      if (s == null) return;
      const isList = b.type === S.nodes.bullet_list || b.type === S.nodes.ordered_list || b.type === S.nodes.task_list;
      // An item can't start with a blank line before more content: an empty first paragraph is left out.
      if (i === 1 && parts.length === 1 && parts[0] === '' && !task) { parts[0] = s; prevList = isList; return; }
      if (i === 0) parts.push(s);
      else parts.push((isList && !prevList && parts.length === 1 && canInterrupt(b) ? '\n' : '\n\n') + s);
      prevList = isList;
    });
    const body = parts.join('') || '';
    const pad = ' '.repeat(marker.length);
    items.push(indentLines(task + body, marker, pad));
  });
  return items.join('\n');
}

/** Whether a list can follow its item's first paragraph without a blank line (CommonMark: only a list starting at 1 with a non-empty first item). */
function canInterrupt(list: PMNode): boolean {
  if (list.type === S.nodes.ordered_list && listStart(list.attrs.order) !== 1) return false;
  const first = list.firstChild;
  return !!first && !!first.firstChild && first.firstChild.isTextblock && first.firstChild.content.size > 0;
}

function blockMd(node: PMNode, w: WCtx): string | null {
  const t = node.type;
  switch (t.name) {
    case 'paragraph': return paragraphMd(node, w);
    case 'code_block': { const f = codeFence(node.textContent); return `${f}${node.attrs.language || ''}\n${node.textContent}\n${f}`; }
    case 'horizontal_rule': return '---';
    case 'page_break': return '<!-- pagebreak -->\n\n---';
    case 'section_break': return '<!-- sectionbreak -->\n\n---';
    case 'column_break': return '<!-- columnbreak -->';
    case 'math_block': return `$$\n${node.attrs.latex}\n$$`;
    case 'gen_block': return htmlToTextLines(node.attrs.cache || '').map((l) => escapeLineStart(escapeText(l))).join('\n\n') || null;
    case 'bullet_list': case 'ordered_list': case 'task_list': return listMd(node, w);
    case 'table': return tableMd(node, w);
    default: {
      if (node.isLeaf) return null;
      const parts: string[] = [];
      node.forEach((c) => { const s = blockMd(c, w); if (s) parts.push(s); });
      return parts.join('\n\n');
    }
  }
}

export function docToMarkdown(doc: PMNode): string {
  const prepared = prepareDoc(doc);
  const notes = collectFootnotes(prepared);
  const w: WCtx = { notes: new Map(notes.map((n) => [n.node, n])), used: [] };
  const parts: string[] = [];
  prepared.forEach((b) => { const s = blockMd(b, w); if (s) parts.push(s); });
  let out = parts.join('\n\n');
  if (w.used.length) {
    out += '\n\n' + w.used.map((n, i) => {
      const paras = n.text.split(/\n+/).map((p) => escapeText(p.trim())).filter(Boolean);
      return `[^${i + 1}]: ${paras.join('\n\n    ') || ' '}`;
    }).join('\n');
  }
  return tidyBlankLines(out) + '\n';
}

/** Collapse runs of blank lines to one, except inside fenced code and $$ math, whose lines are content. */
function tidyBlankLines(md: string): string {
  let out = '', buf = '', close: RegExp | null = null;
  const flush = () => { out += buf.replace(/\n{3,}/g, '\n\n'); buf = ''; };
  md.split('\n').forEach((line, k) => {
    const sep = k ? '\n' : '';
    if (close) { out += sep + line; if (close.test(line)) close = null; return; }
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const fence = f && !(f[1][0] === '`' && f[2].includes('`'));
    if (fence || /^\s*\$\$\s*$/.test(line)) {
      buf += sep;
      flush();
      out += line;
      close = fence ? new RegExp(`^\\s*${f![1][0]}{${f![1].length},}\\s*$`) : /^\s*\$\$\s*$/;
      return;
    }
    buf += sep + line;
  });
  flush();
  return out;
}

export async function exportMarkdown(doc: PMNode, opts: ExportOptions): Promise<Blob> {
  void opts;
  return makeBlob(docToMarkdown(doc), 'text/markdown;charset=utf-8');
}
