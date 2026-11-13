/**
 * LaTeX import (.tex): document structure and formatting, not typesetting.
 *
 * Mapped: \title/\author/\date (+ \maketitle) → properties and Title paragraphs; document class
 * and geometry options → page size, orientation and margins; \part…\subparagraph (starred too)
 * → headings; paragraphs; itemize/enumerate (with enumitem/\labelenumi styles) /description
 * lists, nested; quote/quotation/verse → Quote; center/flushright/flushleft → alignment;
 * verbatim/lstlisting/minted/Verbatim/Highlighting → code blocks; tabular(x)/longtable/array →
 * tables (\multicolumn, \multirow, alignment from the column spec, \hline rules ignored);
 * figure/table captions; \includegraphics → a placeholder naming the file (the image file is
 * not part of the .tex); math: $…$, \(…\) → inline equations, $$…$$, \[…\], equation, align,
 * gather, multline, eqnarray → display equations (rendered with KaTeX); \footnote; \href, \url;
 * \emph \textit \textbf \underline \sout \texttt \textsc \textsuperscript \textsubscript
 * \textcolor and the declaration forms (\bfseries, {\it …}, \color, font sizes); special
 * characters, quotes, dashes, accents and common symbols; \newpage/\clearpage → page breaks;
 * \tableofcontents → a table of contents. Unknown commands keep their argument text; macros
 * defined with \newcommand are expanded when they take no arguments.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { PAGE_SIZES } from '../editor/settings';
import { InlineBuf, headingStyle, makeTable, type CellSpec } from './runs';
import { buildNestedLists, decodeTextBytes, finishDoc, lengthToPt, newSettings, para, type FlatListItem } from './serialize';

const S = schema.nodes;
const MK = schema.marks;

const ACCENTS: Record<string, string> = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328', r: '\u030a', d: '\u0323', b: '\u0331', t: '\u0361' };
const SYMBOLS: Record<string, string> = {
  ldots: '…', dots: '…', textellipsis: '…', LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø',
  aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', S: '§', P: '¶', copyright: '©', textcopyright: '©', textregistered: '®', texttrademark: '™', dag: '†',
  ddag: '‡', pounds: '£', textsterling: '£', euro: '€', texteuro: '€', textdegree: '°', textbackslash: '\\', textbar: '|', textless: '<', textgreater: '>',
  textasciitilde: '~', textasciicircum: '^', textbullet: '•', textendash: '–', textemdash: '—', textquoteleft: '‘', textquoteright: '’',
  textquotedblleft: '“', textquotedblright: '”', guillemotleft: '«', guillemotright: '»', textperiodcentered: '·', textonehalf: '½', checkmark: '✓',
  quad: '\u2003', qquad: '\u2003\u2003', enspace: '\u2002', thinspace: '\u2009', nobreakspace: '\u00a0', space: ' ', slash: '/', textunderscore: '_',
  textdollar: '$', textpercent: '%', textampersand: '&', textsection: '§', textparagraph: '¶', textdagger: '†', textdaggerdbl: '‡',
};
const SIZES: Record<string, number> = { tiny: 5, scriptsize: 7, footnotesize: 8, small: 9, normalsize: 0, large: 12, Large: 14.4, LARGE: 17.28, huge: 20.74, Huge: 24.88 };
const NAMED_COLORS: Record<string, string> = { red: '#ff0000', green: '#00a000', blue: '#0000ff', cyan: '#00ffff', magenta: '#ff00ff', yellow: '#ffff00', black: '#000000', white: '#ffffff', gray: '#808080', darkgray: '#404040', lightgray: '#c0c0c0', brown: '#bf8040', lime: '#bfff00', olive: '#808000', orange: '#ff8000', pink: '#ffbfbf', purple: '#bf0040', teal: '#008080', violet: '#800080' };
const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'math', 'flalign', 'flalign*', 'alignat', 'alignat*']);
const CODE_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'BVerbatim', 'LVerbatim', 'Highlighting', 'alltt', 'code', 'comment-code']);
const IGNORE_ENVS = new Set(['comment', 'thebibliography-ignore']);

/** Index just past the brace group starting at s[i] === '{' (or i when there is none). */
function groupEnd(s: string, i: number, open = '{', close = '}'): number {
  if (s[i] !== open) return i;
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return k + 1; }
  }
  return s.length;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /[ \t\r\n]/.test(s[i])) i++;
  return i;
}

/** Read "[opt]" then "{arg}"… after a command; returns args and the new index. */
function readArgs(s: string, i: number, n: number, optional = true): { opt: string | null; args: string[]; end: number } {
  let j = i;
  let opt: string | null = null;
  const k0 = skipWs(s, j);
  if (optional && s[k0] === '[') { const e = groupEnd(s, k0, '[', ']'); opt = s.slice(k0 + 1, e - 1); j = e; }
  const args: string[] = [];
  for (let a = 0; a < n; a++) {
    const k = skipWs(s, j);
    if (s[k] === '{') { const e = groupEnd(s, k); args.push(s.slice(k + 1, e - 1)); j = e; }
    else if (k < s.length && s[k] !== '\\' && s[k] !== '}' && a === 0 && n > 0) { args.push(s[k]); j = k + 1; }
    else if (s[k] === '\\' && /[a-zA-Z]/.test(s[k + 1] || '')) { let e = k + 1; while (/[a-zA-Z]/.test(s[e] || '')) e++; args.push(s.slice(k, e)); j = e; }
    else args.push('');
  }
  return { opt, args, end: j };
}

function stripComments(s: string): string {
  return s.split('\n').map((line) => {
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '\\') { k++; continue; }
      if (line[k] === '%') return line.slice(0, k) + (k === 0 ? '\u0000' : '');
    }
    return line;
  }).filter((l) => l !== '\u0000').join('\n');
}

function colorValue(model: string | null, v: string): string | null {
  const name = v.trim();
  if (!model) return NAMED_COLORS[name.replace(/!.*$/, '')] || null;
  const nums = name.split(',').map((x) => parseFloat(x));
  const hx = (x: number) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0');
  if (model === 'HTML') return '#' + name.toLowerCase();
  if (model === 'rgb' && nums.length === 3) return '#' + nums.map((x) => hx(x * 255)).join('');
  if (model === 'RGB' && nums.length === 3) return '#' + nums.map(hx).join('');
  if (model === 'gray' && nums.length === 1) return '#' + hx(nums[0] * 255).repeat(3);
  return null;
}

interface Ctx { marks: readonly Mark[]; align?: string | null; style?: string }

class TexReader {
  settings = newSettings();
  macros = new Map<string, string>();
  chapters = false;
  title = '';
  author = '';
  date = '';

  read(src: string): PMNode {
    let text = stripComments(src.replace(/\r\n?/g, '\n'));
    // \newcommand{\name}{body} / \def\name{body} without arguments.
    text = text.replace(/\\(?:re)?newcommand\*?\s*\{?\\([a-zA-Z]+)\}?\s*(\[\d\])?\s*\{/g, (m, name: string, nargs: string | undefined, off: number) => {
      const start = off + m.length - 1;
      const end = groupEnd(text, start);
      if (!nargs) this.macros.set(name, text.slice(start + 1, end - 1));
      return m;
    });
    const bd = text.indexOf('\\begin{document}');
    const ed = text.indexOf('\\end{document}');
    const preamble = bd >= 0 ? text.slice(0, bd) : '';
    let body = bd >= 0 ? text.slice(bd + 16, ed > bd ? ed : undefined) : text;
    this.preamble(preamble);
    // Remove macro definitions from the body; expand argument-less macros.
    body = this.removeDefinitions(body);
    for (let round = 0; round < 3 && this.macros.size; round++) {
      body = body.replace(/\\([a-zA-Z]+)(?![a-zA-Z])/g, (m, n: string) => (this.macros.has(n) ? this.macros.get(n)! : m));
    }
    const blocks: PMNode[] = [];
    if (bd < 0) this.preamble(text); // title commands in fragment files
    this.blocks(body, blocks, { marks: [] });
    return finishDoc(blocks, this.settings);
  }

  private removeDefinitions(s: string): string {
    return s.replace(/\\(?:re)?newcommand\*?\s*\{?\\[a-zA-Z]+\}?\s*(\[\d\])?(\[[^\]]*\])?\s*/g, (m, _a, _b, off: number) => {
      void off;
      return '\\qfdropgroup';
    }).replace(/\\qfdropgroup\{/g, '\\qfdrop{');
  }

  private preamble(p: string): void {
    const dc = /\\documentclass\s*(\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(p);
    if (dc) {
      const opts = (dc[2] || '').split(',').map((o) => o.trim());
      this.chapters = /^(book|report|memoir|scrbook|scrreprt)$/.test(dc[3].trim());
      const pg = this.settings.page;
      if (opts.includes('a4paper')) { pg.sizeName = 'A4'; [pg.width, pg.height] = PAGE_SIZES.A4; }
      if (opts.includes('a5paper')) { pg.sizeName = 'A5'; [pg.width, pg.height] = PAGE_SIZES.A5; }
      if (opts.includes('legalpaper')) { pg.sizeName = 'Legal'; [pg.width, pg.height] = PAGE_SIZES.Legal; }
      if (opts.includes('landscape')) pg.orientation = 'landscape';
      const fs = opts.find((o) => /^\d+pt$/.test(o));
      if (fs) this.settings.styles = { ...this.settings.styles, Normal: { name: 'Normal', type: 'paragraph', size: parseInt(fs, 10) } };
    }
    const geo = [...p.matchAll(/\\usepackage\s*\[([^\]]*)\]\s*\{geometry\}/g), ...p.matchAll(/\\geometry\s*\{([^}]*)\}/g)].map((m) => m[1]).join(',');
    if (geo) {
      const pg = this.settings.page;
      for (const kv of geo.split(',')) {
        const [k, v] = kv.split('=').map((x) => x.trim());
        const len = v ? lengthToPt(v.replace(/\s+/g, '')) : null;
        if (k === 'a4paper') { pg.sizeName = 'A4'; [pg.width, pg.height] = PAGE_SIZES.A4; }
        else if (k === 'letterpaper') { pg.sizeName = 'Letter'; [pg.width, pg.height] = PAGE_SIZES.Letter; }
        else if (k === 'landscape') pg.orientation = 'landscape';
        else if (len != null) {
          if (k === 'margin') pg.margin = { top: len, bottom: len, left: len, right: len };
          else if (k === 'hmargin') { pg.margin.left = len; pg.margin.right = len; }
          else if (k === 'vmargin') { pg.margin.top = len; pg.margin.bottom = len; }
          else if (k === 'left' || k === 'lmargin' || k === 'inner') pg.margin.left = len;
          else if (k === 'right' || k === 'rmargin' || k === 'outer') pg.margin.right = len;
          else if (k === 'top' || k === 'tmargin') pg.margin.top = len;
          else if (k === 'bottom' || k === 'bmargin') pg.margin.bottom = len;
        }
      }
    }
    const one = (cmd: string) => { const m = new RegExp(`\\\\${cmd}\\s*(\\[[^\\]]*\\])?\\s*\\{`).exec(p); if (!m) return null; const st = m.index + m[0].length - 1; return p.slice(st + 1, groupEnd(p, st) - 1); };
    const t = one('title'), a = one('author'), d = one('date');
    if (t != null) this.title = t;
    if (a != null) this.author = a;
    if (d != null) this.date = d;
    const plain = (x: string) => this.inline(x, { marks: [] }).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
    if (this.title) this.settings.properties.title = plain(this.title);
    if (this.author) this.settings.properties.author = plain(this.author.replace(/\\and/g, ';').replace(/\\\\/g, ' '));
  }

  // ------------------------------------------------------------------------------------------
  // Blocks

  blocks(s: string, out: PMNode[], ctx: Ctx): void {
    let buf = '';
    const flush = () => {
      const t = buf.replace(/^\s+|\s+$/g, '');
      buf = '';
      if (!t) return;
      const inl = this.inline(t, ctx);
      if (inl.length) out.push(para(inl, { style: ctx.style || 'Normal', ...(ctx.align ? { align: ctx.align } : {}) }));
    };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') {
        const k = skipWs(s, i);
        if ((s.slice(i, k).match(/\n/g) || []).length >= 2) { flush(); i = k; continue; }
        buf += c; i++; continue;
      }
      if (c === '$' && s[i + 1] === '$') {
        const e = s.indexOf('$$', i + 2);
        flush();
        out.push(S.math_block.create({ latex: s.slice(i + 2, e < 0 ? undefined : e).trim() }));
        i = e < 0 ? s.length : e + 2;
        continue;
      }
      if (c === '\\' && s[i + 1] === '[') {
        const e = s.indexOf('\\]', i + 2);
        flush();
        out.push(S.math_block.create({ latex: s.slice(i + 2, e < 0 ? undefined : e).trim() }));
        i = e < 0 ? s.length : e + 2;
        continue;
      }
      if (c === '\\' && /[a-zA-Z]/.test(s[i + 1] || '')) {
        let e = i + 1;
        while (/[a-zA-Z]/.test(s[e] || '')) e++;
        const cmd = s.slice(i + 1, e);
        const star = s[e] === '*';
        const after = star ? e + 1 : e;
        const r = this.blockCommand(cmd, s, after, out, ctx, flush);
        if (r != null) { i = r; continue; }
        // Inline command: copy it with its arguments into the paragraph buffer.
        buf += s.slice(i, after);
        i = after;
        continue;
      }
      buf += c;
      i++;
    }
    flush();
  }

  /** Handle a block-level command; returns the index after it, or null when it is inline. */
  private blockCommand(cmd: string, s: string, i: number, out: PMNode[], ctx: Ctx, flush: () => void): number | null {
    const SECT: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
    if (cmd in SECT) {
      const { args, end } = readArgs(s, i, 1);
      flush();
      let level = SECT[cmd];
      if (!this.chapters) level = Math.max(1, level - 1);
      out.push(para(this.inline(args[0], ctx), { style: cmd === 'part' ? 'Title' : headingStyle(Math.min(9, level)) }));
      return end;
    }
    switch (cmd) {
      case 'begin': {
        const { args, end } = readArgs(s, i, 1, false);
        const env = args[0].trim();
        const close = `\\end{${env}}`;
        let depth = 1, k = end, bodyEnd = s.length;
        const open = `\\begin{${env}}`;
        while (k < s.length) {
          const o = s.indexOf(open, k), c = s.indexOf(close, k);
          if (c < 0) break;
          if (o >= 0 && o < c) { depth++; k = o + open.length; continue; }
          depth--;
          if (depth === 0) { bodyEnd = c; break; }
          k = c + close.length;
        }
        const inner = s.slice(end, bodyEnd);
        const next = Math.min(s.length, bodyEnd + close.length);
        if (this.environment(env, inner, out, ctx, flush)) return next;
        // Inline environment (e.g. math inside a paragraph): leave it to the inline converter.
        return null;
      }
      case 'maketitle': {
        flush();
        if (this.title) out.push(para(this.inline(this.title, ctx), { style: 'Title' }));
        if (this.author) out.push(para(this.inline(this.author.replace(/\\and/g, ', '), ctx), { align: 'center' }));
        const d = this.date === '' && !/\\date/.test(s) ? '' : this.date;
        if (d && !/^\s*$/.test(d)) out.push(para(this.inline(d, ctx), { align: 'center' }));
        return i;
      }
      case 'tableofcontents': case 'listoffigures': case 'listoftables': flush(); out.push(S.gen_block.create({ kind: 'toc' })); return i;
      case 'newpage': case 'clearpage': case 'cleardoublepage': case 'pagebreak': case 'newpage*': flush(); out.push(S.page_break.create()); return readArgs(s, i, 0).end;
      case 'par': flush(); return i;
      case 'hrule': case 'hrulefill': flush(); out.push(S.horizontal_rule.create()); return i;
      case 'rule': { const a = readArgs(s, i, 2); flush(); out.push(S.horizontal_rule.create()); return a.end; }
      case 'bigskip': case 'medskip': case 'smallskip': flush(); return i;
      case 'vspace': case 'vskip': { flush(); return readArgs(s, i, 1, false).end; }
      case 'item': return null;
      case 'centering': ctx.align = 'center'; return i;
      case 'raggedleft': ctx.align = 'right'; return i;
      case 'raggedright': ctx.align = null; return i;
      case 'title': case 'author': case 'date': case 'label': case 'hypertarget': case 'thanks': {
        if (cmd === 'hypertarget') {
          // \hypertarget{id}{content}: keep the content.
          const { args, end } = readArgs(s, i, 2, false);
          this.blocks(args[1], out, ctx);
          return end;
        }
        return readArgs(s, i, 1).end;
      }
      case 'qfdrop': return readArgs(s, i, 1, false).end;
      case 'usepackage': case 'documentclass': case 'pagestyle': case 'thispagestyle': case 'setlength': case 'addtolength': case 'setcounter': case 'bibliographystyle': case 'tightlist': case 'noindent': case 'indent': case 'def': case 'let': case 'newline-x': case 'appendix': case 'frontmatter': case 'mainmatter': case 'backmatter': case 'geometry': case 'hypersetup': case 'graphicspath':
        if (cmd === 'def' || cmd === 'let') { const m = /^\\?[a-zA-Z@]+\s*(\{)?/.exec(s.slice(i)); const j = i + (m ? m[0].length - (m[1] ? 1 : 0) : 0); return m && m[1] ? groupEnd(s, j) : j; }
        if (/^(setlength|addtolength|setcounter)$/.test(cmd)) return readArgs(s, i, 2, false).end;
        if (/^(tightlist|noindent|indent|appendix|frontmatter|mainmatter|backmatter)$/.test(cmd)) return i;
        return readArgs(s, i, 1).end;
      case 'bibliography': flush(); return readArgs(s, i, 1).end;
      case 'includegraphics': {
        const { opt, args, end } = readArgs(s, i, 1);
        flush();
        out.push(this.figurePlaceholder(args[0], opt));
        return end;
      }
      case 'caption': {
        const { args, end } = readArgs(s, i, 1);
        flush();
        out.push(para(this.inline(args[0], ctx), { style: 'Caption', align: 'center' }));
        return end;
      }
      default: return null;
    }
  }

  private figurePlaceholder(file: string, opt: string | null): PMNode {
    const w = opt ? /width\s*=\s*([\d.]+)\s*(\\(?:text|line|column)width|in|cm|mm|pt)/.exec(opt) : null;
    const label = `[Figure: ${file.trim()}]`;
    void w;
    return para([schema.text(label, [MK.italic.create()])], { align: 'center' });
  }

  private environment(env: string, inner: string, out: PMNode[], ctx: Ctx, flush: () => void): boolean {
    if (MATH_ENVS.has(env)) {
      if (env === 'math') return false;
      flush();
      let latex = inner.trim().replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
      if (/^(align|flalign|alignat|eqnarray)/.test(env)) latex = `\\begin{aligned}${latex.replace(/&\s*=\s*&/g, '&=')}\\end{aligned}`;
      else if (/^gather|^multline/.test(env)) latex = `\\begin{gathered}${latex}\\end{gathered}`;
      out.push(S.math_block.create({ latex, numbered: !env.endsWith('*') && env !== 'displaymath' }));
      return true;
    }
    if (CODE_ENVS.has(env) || env === 'Shaded') {
      flush();
      let code = inner.replace(/^\[[^\]\n]*\]/, '').replace(/^\{[^}\n]*\}/, '').replace(/^\n/, '').replace(/\s+$/, '');
      if (env === 'Shaded') { const m = /\\begin\{Highlighting\}(\[[^\]]*\])?([\s\S]*?)\\end\{Highlighting\}/.exec(inner); code = m ? m[2].replace(/^\n/, '').replace(/\s+$/, '') : code; }
      if (env === 'Shaded' || env === 'Highlighting') code = code.replace(/\\[A-Za-z]+Tok\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1').replace(/\\([{}\\$&%#_])/g, '$1').replace(/\\textbackslash\{\}/g, '\\').replace(/\\textasciitilde\{\}/g, '~').replace(/\\textasciicircum\{\}/g, '^').replace(/\\SpecialCharTok\{(.)\}/g, '$1');
      out.push(S.code_block.create({ language: env === 'minted' ? (/^\{([^}]*)\}/.exec(inner.replace(/^\[[^\]]*\]/, ''))?.[1] || null) : null }, code ? schema.text(code) : null));
      return true;
    }
    if (IGNORE_ENVS.has(env)) { flush(); return true; }
    switch (env) {
      case 'document': flush(); this.blocks(inner, out, ctx); return true;
      case 'itemize': case 'enumerate': case 'description': case 'compactitem': case 'compactenum': case 'inparaenum': case 'asparaenum': {
        flush();
        out.push(...buildNestedLists(this.listItems(env, inner, 0, ctx)));
        return true;
      }
      case 'quote': case 'quotation': case 'verse': case 'displayquote': {
        flush();
        const inner2: PMNode[] = [];
        this.blocks(env === 'verse' ? inner.replace(/\\\\\s*\n/g, '\\\\ ') : inner, inner2, { ...ctx, style: 'Quote' });
        out.push(...inner2);
        return true;
      }
      case 'abstract': {
        flush();
        out.push(para([schema.text('Abstract', [MK.bold.create()])], { align: 'center' }));
        this.blocks(inner, out, { ...ctx, style: 'Quote' });
        return true;
      }
      case 'center': case 'flushright': case 'flushleft': case 'centering': {
        flush();
        this.blocks(inner, out, { ...ctx, align: env === 'center' || env === 'centering' ? 'center' : env === 'flushright' ? 'right' : null });
        return true;
      }
      case 'figure': case 'figure*': case 'table': case 'table*': case 'wrapfigure': case 'subfigure': case 'minipage': case 'framed': case 'mdframed': case 'tcolorbox': {
        flush();
        const body = inner.replace(/^\s*(\[[^\]]*\])?(\{[^}]*\})?/, (m) => (/^(wrapfigure|minipage|subfigure)$/.test(env) ? '' : m.replace(/^\s*\[[^\]]*\]/, '')));
        const inner2: PMNode[] = [];
        this.blocks(body, inner2, { ...ctx, align: /figure/.test(env) ? 'center' : ctx.align });
        if (/framed|tcolorbox/.test(env)) out.push(S.text_box.create({ border: '1px solid #444' }, inner2.length ? inner2 : [para()]));
        else out.push(...inner2);
        return true;
      }
      case 'tabular': case 'tabular*': case 'tabularx': case 'tabulary': case 'longtable': case 'array': case 'tabu': case 'supertabular': case 'xltabular': {
        flush();
        const t = this.table(env, inner, ctx);
        if (t) out.push(...t);
        return true;
      }
      case 'thebibliography': {
        flush();
        out.push(para([schema.text('References')], { style: headingStyle(this.chapters ? 1 : 1) }));
        const body = inner.replace(/^\s*\{[^}]*\}/, '');
        for (const item of body.split(/\\bibitem/).slice(1)) {
          const { opt, args, end } = readArgs(item, 0, 1);
          const label = opt || args[0];
          out.push(para([schema.text(`[${label}] `), ...this.inline(item.slice(end).trim(), ctx)], { indentLeft: 36, indentFirst: -36 }));
        }
        return true;
      }
      default:
        flush();
        this.blocks(inner, out, ctx);
        return true;
    }
  }

  private listItems(env: string, inner: string, level: number, ctx: Ctx): FlatListItem[] {
    const ordered = /enum/.test(env);
    const description = env === 'description';
    let format = ordered ? 'decimal' : 'disc';
    let start = 1;
    // enumitem: [label=(\alph*)], [label=\Roman*.], [start=3]; \def\labelenumi{\roman{enumi}.}
    const optM = /^\s*\[([^\]]*)\]/.exec(inner);
    const head = inner.slice(0, Math.max(0, inner.search(/\\item\b/)));
    const opts = (optM?.[1] || '') + ' ' + ((/\\def\\labelenum\w+\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(head) || [])[1] || '');
    if (/\\alph/.test(opts)) format = 'lower-alpha';
    else if (/\\Alph/.test(opts)) format = 'upper-alpha';
    else if (/\\roman/.test(opts)) format = 'lower-roman';
    else if (/\\Roman/.test(opts)) format = 'upper-roman';
    else if (/^\s*\(?[a]\)?\.?\s*$/.test(optM?.[1] || '')) format = 'lower-alpha';
    else if (/^\s*\(?i\)?\.?\s*$/.test(optM?.[1] || '')) format = 'lower-roman';
    const sm = /start\s*=\s*(\d+)/.exec(opts);
    if (sm) start = parseInt(sm[1], 10);
    let body = optM ? inner.slice(optM[0].length) : inner;
    const fi = Math.max(0, body.search(/\\item\b/));
    body = body.slice(0, fi).replace(/\\def\\label\w+\{(?:[^{}]|\{[^{}]*\})*\}/g, '') + body.slice(fi);
    // Split at top-level \item.
    const items: { label: string | null; text: string }[] = [];
    let depth = 0, cur: { label: string | null; text: string } | null = null;
    for (let i = 0; i < body.length;) {
      if (body.startsWith('\\begin{', i)) {
        const e = groupEnd(body, i + 6);
        const env2 = body.slice(i + 7, e - 1);
        if (/^(itemize|enumerate|description|compactitem|compactenum)$/.test(env2)) depth++;
        if (cur) cur.text += body.slice(i, e);
        i = e;
        continue;
      }
      if (body.startsWith('\\end{', i)) {
        const e = groupEnd(body, i + 4);
        const env2 = body.slice(i + 5, e - 1);
        if (/^(itemize|enumerate|description|compactitem|compactenum)$/.test(env2)) depth--;
        if (cur) cur.text += body.slice(i, e);
        i = e;
        continue;
      }
      if (depth === 0 && body.startsWith('\\item', i) && !/[a-zA-Z]/.test(body[i + 5] || '')) {
        let j = i + 5;
        let label: string | null = null;
        const k = skipWs(body, j);
        if (body[k] === '[') { const e = groupEnd(body, k, '[', ']'); label = body.slice(k + 1, e - 1); j = e; }
        cur = { label, text: '' };
        items.push(cur);
        i = j;
        continue;
      }
      if (cur) cur.text += body[i];
      i++;
    }
    return items.map((it) => {
      const blocks: PMNode[] = [];
      const lead = description && it.label ? `\\textbf{${it.label}} ` : '';
      this.blocks(lead + it.text.trim(), blocks, { ...ctx, style: 'Normal' });
      if (!blocks.length || blocks[0].type !== S.paragraph) blocks.unshift(para());
      return { level, ordered: ordered && !description, format: description ? 'none' : format, start, blocks };
    });
  }

  private table(env: string, inner: string, ctx: Ctx): PMNode[] | null {
    let body = inner;
    // Skip width (tabular*, tabularx) and the column spec.
    const w = /^(tabular\*|tabularx|tabulary|xltabular|tabu)$/.test(env) ? readArgs(body, 0, 1, false) : null;
    if (w) body = body.slice(w.end);
    const posOpt = /^\s*\[[^\]]*\]/.exec(body);
    if (posOpt) body = body.slice(posOpt[0].length);
    const spec = readArgs(body, 0, 1, false);
    body = body.slice(spec.end);
    const aligns = this.colAligns(spec.args[0] || '');
    const out: PMNode[] = [];
    let caption: string | null = null;
    body = body.replace(/\\caption\s*(\[[^\]]*\])?\{/g, (m, _o, off: number) => { const st = off + m.length - 1; const e = groupEnd(body, st); caption = body.slice(st + 1, e - 1); return m; });
    if (caption) body = body.replace(/\\caption\s*(\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}(\s*\\\\)?/, '');
    body = body.replace(/\\(hline|toprule|midrule|bottomrule|endhead|endfirsthead|endfoot|endlastfoot|noalign\{\}|tabularnewline|centering)\b(\{\})?/g, ' ').replace(/\\(cline|cmidrule)(\([^)]*\))?\{[^}]*\}/g, ' ').replace(/\\noalign\{[^}]*\}/g, ' ');
    // Rows end at top-level \\.
    const rowsRaw: string[] = [];
    let depth = 0, cur = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '\\' && body[i + 1] === '\\' && depth === 0) { rowsRaw.push(cur); cur = ''; i++; const k = skipWs(body, i + 1); if (body[k] === '[') i = groupEnd(body, k, '[', ']') - 1; continue; }
      if (c === '\\') { cur += c + (body[i + 1] || ''); i++; continue; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      cur += c;
    }
    if (cur.trim()) rowsRaw.push(cur);
    const pendingRowspan: number[] = [];
    const rows: CellSpec[][] = [];
    for (const r of rowsRaw) {
      if (!r.trim()) continue;
      const cells: string[] = [];
      let d = 0, c = '';
      for (let i = 0; i < r.length; i++) {
        if (r[i] === '\\') { c += r[i] + (r[i + 1] || ''); i++; continue; }
        if (r[i] === '{') d++;
        if (r[i] === '}') d--;
        if (r[i] === '&' && d === 0) { cells.push(c); c = ''; continue; }
        c += r[i];
      }
      cells.push(c);
      const row: CellSpec[] = [];
      let col = 0;
      for (let raw of cells) {
        raw = raw.trim();
        while (pendingRowspan[col] > 0) { pendingRowspan[col]--; col++; }
        let colspan = 1, rowspan = 1;
        let align = aligns[col] || null;
        const mc = /^\\multicolumn\s*\{(\d+)\}\s*\{([^}]*)\}\s*\{([\s\S]*)\}$/.exec(raw);
        if (mc) { colspan = parseInt(mc[1], 10) || 1; align = this.colAligns(mc[2])[0] || align; raw = mc[3]; }
        const mr = /^\\multirow\s*\{(-?\d+)\}\s*(\[[^\]]*\])?\s*\{[^}]*\}\s*\{([\s\S]*)\}$/.exec(raw);
        if (mr) { rowspan = Math.abs(parseInt(mr[1], 10)) || 1; raw = mr[3]; for (let k = 0; k < colspan; k++) pendingRowspan[col + k] = rowspan - 1; }
        const blocks: PMNode[] = [];
        this.blocks(raw, blocks, { ...ctx, align: align === 'left' ? null : align });
        row.push({ blocks: blocks.length ? blocks : [para()], colspan, rowspan });
        col += colspan;
      }
      rows.push(row);
    }
    const t = makeTable(rows, { headerRows: /\\(toprule|endhead)/.test(inner) || /^\s*\\hline/.test(body) ? 1 : 0, borderless: !/\||\\hline|rule/.test(inner) });
    if (caption) out.push(para(this.inline(caption, ctx), { style: 'Caption', align: 'center' }));
    if (t) out.push(t);
    return out;
  }

  private colAligns(spec: string): (string | null)[] {
    const out: (string | null)[] = [];
    const s = spec.replace(/[|!]/g, '').replace(/@\{[^}]*\}/g, '').replace(/>\{[^}]*\}|<\{[^}]*\}/g, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === 'l') out.push('left');
      else if (c === 'c') out.push('center');
      else if (c === 'r') out.push('right');
      else if (c === 'X' || c === 'L' || c === 'J') out.push(null);
      else if (c === 'p' || c === 'm' || c === 'b') { out.push('justify'); i = groupEnd(s, i + 1) - 1; }
      else if (c === '*') { const a = readArgs(s, i + 1, 2, false); const n = parseInt(a.args[0], 10) || 0; for (let k = 0; k < n; k++) out.push(...this.colAligns(a.args[1])); i = a.end - 1; }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Inline

  inline(src: string, ctx: Ctx): PMNode[] {
    const buf = new InlineBuf();
    this.inlineInto(src, ctx.marks, buf);
    const items = buf.take();
    // Spaces collapse across formatting boundaries too.
    for (let k = 1; k < items.length; k++) {
      const a = items[k - 1], b = items[k];
      if (a.isText && b.isText && /\s$/.test(a.text!) && /^\s/.test(b.text!)) {
        const t = b.text!.replace(/^\s+/, '');
        if (t) items[k] = schema.text(t, b.marks); else { items.splice(k, 1); k--; }
      }
    }
    // Collapse leading/trailing whitespace.
    if (items[0]?.isText) { const t = items[0].text!.replace(/^\s+/, ''); if (t) items[0] = schema.text(t, items[0].marks); else items.shift(); }
    const last = items[items.length - 1];
    if (last?.isText) { const t = last.text!.replace(/\s+$/, ''); if (t) items[items.length - 1] = schema.text(t, last.marks); else items.pop(); }
    return items;
  }

  private text(buf: InlineBuf, t: string, marks: readonly Mark[]): void {
    if (!t) return;
    const out = t.replace(/\s+/g, ' ').replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '“').replace(/''/g, '”').replace(/`/g, '‘').replace(/(^|[^\w])'/g, '$1’').replace(/'/g, '’').replace(/~/g, '\u00a0').replace(/<</g, '«').replace(/>>/g, '»').replace(/!`/g, '¡').replace(/\?`/g, '¿');
    buf.text(out, marks);
  }

  private inlineDepth = 0;

  private inlineInto(s: string, marks: readonly Mark[], buf: InlineBuf): void {
    // Pathologically deep groups are flattened to their text rather than recursed into.
    if (this.inlineDepth >= 200) { this.text(buf, s.replace(/\\[a-zA-Z]+\*?|[{}\\]/g, ''), marks); return; }
    this.inlineDepth++;
    try { this.inlineBody(s, marks, buf); } finally { this.inlineDepth--; }
  }

  private inlineBody(s: string, marks: readonly Mark[], buf: InlineBuf): void {
    let m = marks;
    let plain = '';
    const flushText = () => { this.text(buf, plain, m); plain = ''; };
    const withMark = (mk: Mark | null, content: string) => { flushText(); this.inlineInto(content, mk ? mk.addToSet(m) : m, buf); };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '{') {
        const e = groupEnd(s, i);
        flushText();
        this.inlineInto(s.slice(i + 1, e - 1), m, buf);
        i = e;
        continue;
      }
      if (c === '}') { i++; continue; }
      if (c === '$') {
        const dbl = s[i + 1] === '$';
        const e = s.indexOf(dbl ? '$$' : '$', i + (dbl ? 2 : 1));
        flushText();
        buf.node(S.math_inline.create({ latex: s.slice(i + (dbl ? 2 : 1), e < 0 ? undefined : e).trim() }));
        i = e < 0 ? s.length : e + (dbl ? 2 : 1);
        continue;
      }
      if (c !== '\\') { plain += c; i++; continue; }
      const n = s[i + 1] || '';
      if (n === '(' || n === '[') {
        const close = n === '(' ? '\\)' : '\\]';
        const e = s.indexOf(close, i + 2);
        flushText();
        buf.node(S.math_inline.create({ latex: s.slice(i + 2, e < 0 ? undefined : e).trim() }));
        i = e < 0 ? s.length : e + 2;
        continue;
      }
      if (n === '\\') { flushText(); buf.node(S.hard_break.create()); i += 2; const k = skipWs(s, i); if (s[k] === '[') i = groupEnd(s, k, '[', ']'); continue; }
      if ('&%$#_{}~^ '.includes(n) && n) { plain += n === '~' ? '~' : n === ' ' ? ' ' : n; if (n === '^' || n === '~') { const a = readArgs(s, i + 2, 1, false); if (ACCENTS[n] && a.args[0]) { plain = plain.slice(0, -1) + (a.args[0] + ACCENTS[n]).normalize('NFC'); i = a.end; continue; } } i += 2; continue; }
      if (ACCENTS[n] && !/[a-zA-Z]/.test(n)) {
        const a = readArgs(s, i + 2, 1, false);
        plain += ((a.args[0] || '').replace(/^\\([ij])$/, (_x, l) => l) + ACCENTS[n]).normalize('NFC');
        i = a.end;
        continue;
      }
      if (n === '-' || n === '/' || n === '@' || n === ',' || n === ';' || n === ':' || n === '!' || n === '>') { if (n === ',' || n === ';' || n === ':' || n === '>') plain += '\u2009'; i += 2; continue; }
      let e = i + 1;
      while (/[a-zA-Z]/.test(s[e] || '')) e++;
      const cmd = s.slice(i + 1, e);
      if (!cmd) { plain += n; i += 2; continue; }
      let j = s[e] === '*' ? e + 1 : e;
      // Single-letter accent commands (\c{c}, \v{s}, \H{o} …).
      if (cmd.length === 1 && ACCENTS[cmd]) { const a = readArgs(s, j, 1, false); plain += ((a.args[0] || '') + ACCENTS[cmd]).normalize('NFC'); i = a.end; continue; }
      if (SYMBOLS[cmd] != null) { plain += SYMBOLS[cmd]; if (s[j] === '{' && s[j + 1] === '}') j += 2; else if (s[j] === ' ') j++; i = j; continue; }
      if (cmd in SIZES) {
        // Declaration: applies to the rest of the group.
        flushText();
        const pt = SIZES[cmd];
        m = pt ? MK.size.create({ pt }).addToSet(m) : m.filter((x) => x.type !== MK.size);
        i = j;
        continue;
      }
      const decl: Record<string, Mark> = { bfseries: MK.bold.create(), bf: MK.bold.create(), itshape: MK.italic.create(), it: MK.italic.create(), em: MK.italic.create(), slshape: MK.italic.create(), sl: MK.italic.create(), ttfamily: MK.code.create(), tt: MK.code.create(), scshape: MK.smallcaps.create(), sc: MK.smallcaps.create() };
      if (decl[cmd]) { flushText(); m = decl[cmd].addToSet(m); i = j; continue; }
      if (cmd === 'mdseries' || cmd === 'upshape' || cmd === 'rmfamily' || cmd === 'normalfont' || cmd === 'sffamily' || cmd === 'rm' || cmd === 'sf') { flushText(); if (cmd === 'mdseries') m = m.filter((x) => x.type !== MK.bold); else if (cmd === 'upshape') m = m.filter((x) => x.type !== MK.italic); else if (cmd === 'normalfont') m = m.filter((x) => ![MK.bold, MK.italic, MK.code, MK.smallcaps].includes(x.type)); i = j; continue; }
      const wrap: Record<string, () => Mark | null> = {
        emph: () => MK.italic.create(), textit: () => MK.italic.create(), textsl: () => MK.italic.create(), textbf: () => MK.bold.create(), underline: () => MK.underline.create(),
        uline: () => MK.underline.create(), ul: () => MK.underline.create(), uuline: () => MK.underline.create({ style: 'double' }), uwave: () => MK.underline.create({ style: 'wavy' }),
        sout: () => MK.strike.create(), st: () => MK.strike.create(), xout: () => MK.strike.create(), texttt: () => MK.code.create(), textsc: () => MK.smallcaps.create(),
        textsuperscript: () => MK.sup.create(), textsubscript: () => MK.sub.create(), textup: () => null, textrm: () => null, textsf: () => null, textmd: () => null, textnormal: () => null,
        mbox: () => null, makebox: () => null, hbox: () => null, text: () => null, textls: () => null, textlf: () => null, enquote: () => null, MakeUppercase: () => MK.allcaps.create(), uppercase: () => MK.allcaps.create(),
        hl: () => MK.highlight.create({ color: '#ffff00' }), hlc: () => MK.highlight.create({ color: '#ffff00' }), code: () => MK.code.create(), path: () => MK.code.create(), lstinline: () => MK.code.create(), mintinline: () => MK.code.create(),
      };
      if (wrap[cmd]) {
        const a = readArgs(s, j, cmd === 'mintinline' ? 2 : 1);
        if (cmd === 'enquote') { flushText(); plain = '“'; flushText(); this.inlineInto(a.args[0], m, buf); plain = '”'; i = a.end; continue; }
        withMark(wrap[cmd](), cmd === 'mintinline' ? a.args[1] : a.args[0]);
        i = a.end;
        continue;
      }
      switch (cmd) {
        case 'verb': {
          const d = s[j];
          const end = s.indexOf(d, j + 1);
          flushText();
          buf.text(s.slice(j + 1, end < 0 ? undefined : end), MK.code.create().addToSet(m));
          i = end < 0 ? s.length : end + 1;
          continue;
        }
        case 'textcolor': case 'colorbox': case 'fcolorbox': {
          const model = /^\s*\[([^\]]*)\]/.exec(s.slice(j));
          const a = readArgs(s, j, cmd === 'fcolorbox' ? 3 : 2);
          const col = colorValue(model ? model[1] : null, a.args[0]);
          const content = cmd === 'fcolorbox' ? a.args[2] : a.args[1];
          withMark(col ? (cmd === 'textcolor' ? MK.color.create({ color: col }) : MK.highlight.create({ color: col })) : null, content);
          i = a.end;
          continue;
        }
        case 'color': {
          const model = /^\s*\[([^\]]*)\]/.exec(s.slice(j));
          const a = readArgs(s, j, 1);
          const col = colorValue(model ? model[1] : null, a.args[0]);
          flushText();
          if (col) m = MK.color.create({ color: col }).addToSet(m);
          i = a.end;
          continue;
        }
        case 'href': { const a = readArgs(s, j, 2, false); withMark(/^\s*(javascript|vbscript):/i.test(a.args[0]) ? null : MK.link.create({ href: a.args[0].replace(/\\([#%&_])/g, '$1') }), a.args[1]); i = a.end; continue; }
        case 'url': case 'nolinkurl': { const a = readArgs(s, j, 1, false); const u = a.args[0].replace(/\\([#%&_])/g, '$1'); flushText(); buf.text(u, (cmd === 'url' ? MK.link.create({ href: u }) : MK.code.create()).addToSet(m)); i = a.end; continue; }
        case 'footnote': case 'footnotetext': {
          const a = readArgs(s, j, 1);
          flushText();
          const t = this.inline(a.args[0], { marks: [] }).map((x) => x.textContent || (x.type === S.math_inline ? x.attrs.latex : '')).join('').trim();
          buf.node(S.footnote.create({ text: t }));
          i = a.end;
          continue;
        }
        case 'cite': case 'citep': case 'citet': case 'parencite': case 'textcite': case 'autocite': case 'ref': case 'eqref': case 'pageref': case 'autoref': case 'cref': case 'Cref': case 'nameref': {
          const a = readArgs(s, j, 1);
          const v = a.args[0];
          plain += cmd === 'eqref' ? `(${v})` : /cite/.test(cmd) ? `[${v}${a.opt ? ', ' + a.opt : ''}]` : `[${v}]`;
          i = a.end;
          continue;
        }
        case 'today': plain += new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); i = j; continue;
        case 'includegraphics': { const a = readArgs(s, j, 1); flushText(); buf.text(`[Figure: ${a.args[0].trim()}]`, MK.italic.create().addToSet(m)); i = a.end; continue; }
        case 'label': case 'index': case 'hspace': case 'vspace': case 'phantom': case 'hphantom': case 'vphantom': case 'cline': case 'addcontentsline': case 'nocite': case 'glossary':
          i = readArgs(s, j, cmd === 'addcontentsline' ? 3 : 1).end; continue;
        case 'hypertarget': { const a = readArgs(s, j, 2, false); withMark(null, a.args[1]); i = a.end; continue; }
        case 'hyperlink': { const a = readArgs(s, j, 2, false); withMark(MK.link.create({ href: '#' + a.args[0] }), a.args[1]); i = a.end; continue; }
        case 'newline': case 'linebreak': flushText(); buf.node(S.hard_break.create()); i = j; continue;
        case 'noindent': case 'indent': case 'centering': case 'raggedright': case 'raggedleft': case 'protect': case 'relax': case 'nobreak': case 'allowbreak': case 'strut': case 'leavevmode': case 'null': case 'tightlist': case 'item': case 'hfill': case 'vfill':
          if (cmd === 'hfill') plain += ' ';
          i = j; continue;
        case 'begin': {
          const a = readArgs(s, j, 1, false);
          const env = a.args[0];
          const close = `\\end{${env}}`;
          const e2 = s.indexOf(close, a.end);
          const inner = s.slice(a.end, e2 < 0 ? undefined : e2);
          flushText();
          if (MATH_ENVS.has(env) || env === 'math') buf.node(S.math_inline.create({ latex: inner.trim() }));
          else this.inlineInto(inner, m, buf);
          i = e2 < 0 ? s.length : e2 + close.length;
          continue;
        }
        default: {
          // Unknown command: drop it, keep the text of its braced arguments.
          const k = skipWs(s, j);
          if (s[k] === '[' ) j = groupEnd(s, k, '[', ']');
          i = j;
          continue;
        }
      }
    }
    flushText();
  }
}

export function latexToDoc(src: string): PMNode {
  return new TexReader().read(src);
}

export async function importLatex(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  return latexToDoc(decodeTextBytes(data).replace(/^\ufeff/, ''));
}

