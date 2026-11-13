/**
 * reStructuredText import (.rst).
 *
 * Mapped: section titles (underlined / overlined, levels by order of appearance; a lone
 * top-level title becomes the document Title), docinfo field lists (author, date…),
 * paragraphs, bullet / enumerated (arabic, alpha, roman, auto "#") / definition / field lists,
 * nested by indentation, block quotes, literal blocks ("::") and code directives, line blocks,
 * transitions, grid and simple tables, list-table, images and figures (with captions),
 * admonitions (note, warning, tip … → text boxes), math directive and :math: role, footnotes
 * (numbered, auto-numbered and named), hyperlink targets, substitutions, and inline markup:
 * emphasis, strong, literals, interpreted text roles (sub, sup, code, title-reference…),
 * hyperlink references and standalone URLs. Unknown directives keep their content as text.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { headingStyle, makeTable, type CellSpec } from './runs';
import { buildNestedLists, decodeTextBytes, finishDoc, newSettings, type FlatListItem } from './serialize';
import { MK, S, blank, indentOf, linkMark, p, parseInline, toLines, type InlineRule } from './lightmarkup';

const ADORN = /^([=\-`:'"~^_*+#<>.!$%&(),/;?@[\\\]{|}])\1{2,}\s*$/;
const ENUM = /^(\(?)(\d+|[a-zA-Z]|[ivxlcdm]+|[IVXLCDM]+|#)([.)])\s+/;
const ADMONITIONS = /^(note|warning|tip|important|attention|caution|danger|error|hint|seealso|admonition|versionadded|versionchanged|deprecated)$/;

class RstReader {
  settings = newSettings();
  styles: string[] = [];
  targets = new Map<string, string>();
  substitutions = new Map<string, string>();
  footnotes = new Map<string, string>();
  autoFootnotes: string[] = [];
  autoUsed = 0;
  rules: InlineRule[];

  constructor(private lines: string[]) {
    this.rules = this.inlineRules();
    // First pass: targets, substitutions and footnote bodies.
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m = /^\.\.\s+_([^:]+):\s*(\S.*)?$/.exec(l);
      if (m) { this.targets.set(m[1].replace(/^`|`$/g, '').toLowerCase(), (m[2] || '').trim()); continue; }
      m = /^\.\.\s+\|([^|]+)\|\s+replace::\s*(.*)$/.exec(l);
      if (m) { this.substitutions.set(m[1], m[2]); continue; }
      m = /^\.\.\s+\[(#?[\w-]*|\*|\d+)\](?:\s+(.*))?$/.exec(l);
      if (m) {
        const body = [m[2] || ''];
        for (let k = i + 1; k < lines.length && (blank(lines[k]) ? !blank(lines[k + 1]) && indentOf(lines[k + 1]) > 0 : indentOf(lines[k]) > 0); k++) body.push(lines[k].trim());
        const text = body.join(' ').replace(/\s+/g, ' ').trim();
        if (m[1] === '#' || m[1] === '*') this.autoFootnotes.push(text);
        else this.footnotes.set(m[1], text);
      }
    }
  }

  private inlineRules(): InlineRule[] {
    const ws = /[\w]/;
    return [
      { re: /\\(.)/, run: (m) => (/\s/.test(m[1]) ? '' : m[1]) },
      { re: /``([^`]+?)``/, notAfter: ws, run: (m) => ({ mark: MK.code.create(), inner: m[1], raw: true }) },
      { re: /:(sub|subscript):`([^`]+)`/, run: (m) => ({ mark: MK.sub.create(), inner: m[2] }) },
      { re: /:(sup|superscript):`([^`]+)`/, run: (m) => ({ mark: MK.sup.create(), inner: m[2] }) },
      { re: /:math:`([^`]+)`/, run: (m) => [S.math_inline.create({ latex: m[1] })] },
      { re: /:(code|literal|file|samp|command|program|envvar|option|kbd|py:\w+|func|class|meth|mod|attr|data|const|exc|obj)(?::\w+)?:`([^`]+)`/, run: (m) => ({ mark: MK.code.create(), inner: m[2].replace(/^~/, '') }) },
      { re: /:(strong):`([^`]+)`/, run: (m) => ({ mark: MK.bold.create(), inner: m[2] }) },
      { re: /:(emphasis|title-reference|title|t|dfn|term):`([^`]+)`/, run: (m) => ({ mark: MK.italic.create(), inner: m[2] }) },
      { re: /:(ref|doc|numref|abbr|guilabel|menuselection|[\w-]+):`([^`]+)`/, run: (m) => (/<[^>]+>$/.test(m[2]) ? m[2].replace(/\s*<[^>]+>$/, '') : m[2].replace(/\s*\([^)]*\)$/, '')) },
      { re: /`([^`<]*?)\s*<([^>]+)>`__?/, run: (m) => ({ mark: linkMark(m[2]), inner: m[1] || m[2] }) },
      { re: /`([^`]+)`__?/, notAfter: ws, run: (m) => { const t = this.targets.get(m[1].toLowerCase()); return t ? { mark: linkMark(t), inner: m[1] } : m[1]; } },
      { re: /\[(#[\w-]*|\*|\d+)\]_/, run: (m) => [S.footnote.create({ text: this.noteText(m[1]) })] },
      { re: /\*\*(\S(?:[^*]*?\S)?)\*\*/, notAfter: ws, run: (m) => ({ mark: MK.bold.create(), inner: m[1] }) },
      { re: /\*(\S(?:[^*]*?\S)?)\*/, notAfter: ws, run: (m) => ({ mark: MK.italic.create(), inner: m[1] }) },
      { re: /`([^`]+)`/, notAfter: ws, run: (m) => ({ mark: MK.italic.create(), inner: m[1] }) },
      { re: /\|([^|\s][^|]*)\|(_{0,2})/, run: (m) => this.substitutions.get(m[1]) ?? m[0] },
      { re: /(https?:\/\/[^\s<>`]+[^\s<>`.,;:!?)\]])/, notAfter: /[\w/]/, run: (m) => ({ mark: linkMark(m[1]), inner: m[1], raw: true }) },
      { re: /([A-Za-z0-9][\w-]*)_(?![\w])/, notAfter: ws, run: (m) => { const t = this.targets.get(m[1].toLowerCase()); return t ? { mark: linkMark(t), inner: m[1] } : m[1]; } },
    ];
  }

  private noteBusy = new Set<string>();
  private noteCache = new Map<string, string>();
  private noteText(label: string): string {
    const auto = label === '#' || label === '*';
    // A footnote citing itself (directly or via others) is not expanded again.
    if (!auto && this.noteBusy.has(label)) return '';
    const cached = auto ? null : this.noteCache.get(label);
    if (cached != null) return cached;
    const raw = auto ? this.autoFootnotes[this.autoUsed++] || '' : this.footnotes.get(label) ?? '';
    if (!auto) this.noteBusy.add(label);
    let t: string;
    try { t = this.inline(raw).map((x) => x.textContent).join(''); } finally { if (!auto) this.noteBusy.delete(label); }
    if (!auto) this.noteCache.set(label, t);
    return t;
  }

  inline(t: string, marks: readonly Mark[] = []): PMNode[] {
    return parseInline(t, this.rules, marks);
  }

  read(): PMNode {
    const blocks = this.blocks(this.lines, 0);
    // A single top-level title at the start is the document title.
    const first = blocks[0];
    if (first && first.type === S.paragraph && first.attrs.style === 'Heading 1') {
      const h1count = blocks.filter((b) => b.type === S.paragraph && b.attrs.style === 'Heading 1').length;
      if (h1count === 1) {
        blocks[0] = S.paragraph.create({ ...first.attrs, style: 'Title' }, first.content);
        for (let k = 1; k < blocks.length; k++) {
          const b = blocks[k];
          const m = b.type === S.paragraph ? /^Heading (\d)$/.exec(b.attrs.style) : null;
          if (m) blocks[k] = S.paragraph.create({ ...b.attrs, style: headingStyle(Math.max(1, parseInt(m[1], 10) - 1)) }, b.content);
        }
        if (!this.settings.properties.title) this.settings.properties.title = first.textContent;
      }
    }
    return finishDoc(blocks, this.settings);
  }

  private headingLevel(char: string, over: boolean): number {
    const key = (over ? 'o' : 'u') + char;
    let i = this.styles.indexOf(key);
    if (i < 0) { this.styles.push(key); i = this.styles.length - 1; }
    return i + 1;
  }

  /** Parse a run of lines (already de-indented by `base`). */
  blocks(lines: string[], depth: number): PMNode[] {
    const out: PMNode[] = [];
    let i = 0;
    const n = lines.length;
    const block = (from: number, minIndent: number): { lines: string[]; end: number } => {
      const got: string[] = [];
      let k = from;
      while (k < n && (blank(lines[k]) || indentOf(lines[k]) >= minIndent)) { got.push(lines[k]); k++; }
      while (got.length && blank(got[got.length - 1])) { got.pop(); k--; }
      const ind = Math.min(...got.filter((l) => !blank(l)).map(indentOf), 1e9);
      return { lines: got.map((l) => l.slice(Math.min(ind, indentOf(l) || 0))), end: k };
    };
    while (i < n) {
      const l = lines[i];
      if (blank(l)) { i++; continue; }
      const ind = indentOf(l);
      // Indented block at this level: block quote.
      if (ind > 0) {
        const b = block(i, 1);
        for (const x of this.blocks(b.lines, depth + 1)) out.push(x.type === S.paragraph ? S.paragraph.create({ ...x.attrs, style: 'Quote' }, x.content) : x);
        i = b.end;
        continue;
      }
      // Section with overline.
      if (ADORN.test(l) && i + 2 < n && !blank(lines[i + 1]) && lines[i + 2].trim()[0] === l.trim()[0] && ADORN.test(lines[i + 2])) {
        out.push(p(this.inline(lines[i + 1].trim()), { style: headingStyle(this.headingLevel(l.trim()[0], true)) }));
        i += 3;
        continue;
      }
      // Section with underline.
      if (i + 1 < n && ADORN.test(lines[i + 1]) && lines[i + 1].trim().length >= Math.min(l.trim().length, 3) && !ADORN.test(l)) {
        out.push(p(this.inline(l.trim()), { style: headingStyle(this.headingLevel(lines[i + 1].trim()[0], false)) }));
        i += 2;
        continue;
      }
      // Transition.
      if (ADORN.test(l) && l.trim().length >= 4 && blank(lines[i + 1]) && (i === 0 || blank(lines[i - 1]))) { out.push(S.horizontal_rule.create()); i++; continue; }
      // Directives, comments, footnotes and targets.
      if (/^\.\.(\s|$)/.test(l)) { i = this.directive(lines, i, out, block); continue; }
      // Grid table.
      if (/^\+[-=+]+\+\s*$/.test(l)) {
        let k = i;
        while (k < n && /^[+|]/.test(lines[k])) k++;
        const t = this.gridTable(lines.slice(i, k));
        if (t) out.push(t);
        i = k;
        continue;
      }
      // Simple table.
      if (/^=+(\s+=+)+\s*$/.test(l)) {
        let k = i + 1, borders = 1;
        while (k < n && borders < 3) { if (/^=+(\s+=+)+\s*$/.test(lines[k])) borders++; k++; if (blank(lines[k]) && borders >= 2 && !/^=+/.test(lines[k + 1] || '')) break; }
        const t = this.simpleTable(lines.slice(i, k));
        if (t) out.push(t);
        i = k;
        continue;
      }
      // Lists.
      const bullet = /^([-*+•‣⁃])\s+/.exec(l);
      const en = ENUM.exec(l);
      if (bullet || (en && this.isEnum(en, lines, i))) {
        const r = this.list(lines, i);
        out.push(...r.nodes);
        i = r.end;
        continue;
      }
      // Field list (docinfo at the top, otherwise a two-column list).
      if (/^:[^:\s][^:]*:(\s|$)/.test(l)) {
        let k = i;
        const fields: [string, string][] = [];
        while (k < n && /^:[^:]+:/.test(lines[k])) {
          const m = /^:([^:]+):\s*(.*)$/.exec(lines[k])!;
          let val = m[2];
          k++;
          while (k < n && !blank(lines[k]) && indentOf(lines[k]) > 0) { val += ' ' + lines[k].trim(); k++; }
          fields.push([m[1], val]);
        }
        const docinfo = out.length <= 2;
        for (const [name, val] of fields) {
          const low = name.toLowerCase();
          if (docinfo && /^(author|authors)$/.test(low)) this.settings.properties.author = val;
          else if (docinfo && /^(title)$/.test(low)) this.settings.properties.title = val;
          else if (docinfo && /^(keywords)$/.test(low)) this.settings.properties.keywords = val;
          else if (docinfo && /^(subject|abstract|description)$/.test(low)) this.settings.properties.comments = val;
          out.push(p([schema.text(name + ': ', [MK.bold.create()]), ...this.inline(val)]));
        }
        i = k;
        continue;
      }
      // Line block.
      if (/^\|(\s|$)/.test(l)) {
        const inl: PMNode[] = [];
        while (i < n && /^\|(\s|$)/.test(lines[i])) {
          if (inl.length) inl.push(S.hard_break.create());
          inl.push(...this.inline(lines[i].replace(/^\|\s?/, '')));
          i++;
          while (i < n && !blank(lines[i]) && indentOf(lines[i]) > 0 && !/^\|/.test(lines[i])) { inl.push(...this.inline(' ' + lines[i].trim())); i++; }
        }
        out.push(p(inl));
        continue;
      }
      // Paragraph (or definition list item when followed by an indented block).
      const para: string[] = [];
      while (i < n && !blank(lines[i]) && indentOf(lines[i]) === 0 && !(para.length && ADORN.test(lines[i]))) { para.push(lines[i]); i++; }
      if (para.length === 1 && i < n && !blank(lines[i]) && indentOf(lines[i]) > 0) {
        // Definition list: term, then indented definition.
        const b = block(i, 1);
        out.push(p(this.inline(para[0].trim(), [MK.bold.create()]), { keepNext: true }));
        for (const x of this.blocks(b.lines, depth + 1)) out.push(x.type === S.paragraph ? S.paragraph.create({ ...x.attrs, indentLeft: 36 }, x.content) : x);
        i = b.end;
        continue;
      }
      let text = para.map((x) => x.trim()).join(' ');
      let literal = false;
      if (/::\s*$/.test(text)) {
        literal = true;
        text = /\s::\s*$/.test(text) || text.trim() === '::' ? text.replace(/\s*::\s*$/, '') : text.replace(/::\s*$/, ':');
      }
      if (text.trim()) out.push(p(this.inline(text)));
      if (literal) {
        let k = i;
        while (k < n && blank(lines[k])) k++;
        if (k < n && indentOf(lines[k]) > 0) {
          const b = block(k, 1);
          out.push(S.code_block.create(null, b.lines.join('\n') ? schema.text(b.lines.join('\n')) : null));
          i = b.end;
        }
      }
    }
    return out;
  }

  private isEnum(m: RegExpExecArray, lines: string[], i: number): boolean {
    // "A. Smith wrote" is a paragraph; enumerations need a list-like neighbour or a number.
    if (/^\d+$|^#$/.test(m[2])) return true;
    const next = lines[i + 1];
    return blank(next) || ENUM.test(next || '') || indentOf(next || '') > 0;
  }

  private list(lines: string[], start: number): { nodes: PMNode[]; end: number } {
    const items: FlatListItem[] = [];
    let i = start;
    const n = lines.length;
    const first = lines[start];
    const isBullet = /^[-*+•‣⁃]\s/.test(first);
    while (i < n) {
      const l = lines[i];
      if (blank(l)) { if (i + 1 < n && (isBullet ? /^[-*+•‣⁃]\s/.test(lines[i + 1]) : ENUM.test(lines[i + 1]))) { i++; continue; } break; }
      const bm = /^([-*+•‣⁃])(\s+)/.exec(l);
      const em = ENUM.exec(l);
      if (indentOf(l) > 0 || (isBullet ? !bm : !em)) break;
      const markerLen = bm ? bm[0].length : em![0].length;
      const body: string[] = [l.slice(markerLen)];
      i++;
      while (i < n && (blank(lines[i]) ? i + 1 < n && indentOf(lines[i + 1]) >= markerLen && !blank(lines[i + 1]) : indentOf(lines[i]) >= Math.min(markerLen, 2))) {
        body.push(blank(lines[i]) ? '' : lines[i].slice(Math.min(markerLen, indentOf(lines[i]))));
        i++;
      }
      let ordered = false, format = 'disc', startNum = 1;
      if (em) {
        ordered = true;
        const v = em[2];
        if (/^\d+$/.test(v)) startNum = parseInt(v, 10);
        else if (v === '#') startNum = 1;
        else if (/^[ivxlcdm]+$/.test(v)) { format = 'lower-roman'; startNum = 1; }
        else if (/^[IVXLCDM]+$/.test(v)) { format = 'upper-roman'; startNum = 1; }
        else if (/^[a-z]$/.test(v)) { format = 'lower-alpha'; startNum = v.charCodeAt(0) - 96; }
        else if (/^[A-Z]$/.test(v)) { format = 'upper-alpha'; startNum = v.charCodeAt(0) - 64; }
        if (format === 'disc') format = 'decimal';
      } else format = bm![1] === '-' ? 'disc' : bm![1] === '*' ? 'disc' : 'circle';
      items.push({ level: 0, ordered, format, start: items.length ? items[0].start : startNum, blocks: this.blocks(body, 1) });
    }
    for (const it of items) if (!it.blocks.length) it.blocks.push(p([]));
    return { nodes: buildNestedLists(items), end: i };
  }

  private directive(lines: string[], i: number, out: PMNode[], block: (from: number, minIndent: number) => { lines: string[]; end: number }): number {
    const l = lines[i];
    // An empty comment ("..") followed by a blank line ends there (it separates block quotes).
    if (/^\.\.\s*$/.test(l) && blank(lines[i + 1])) return i + 1;
    const m = /^\.\.\s+([\w:-]+)::\s*(.*)$/.exec(l);
    const b = block(i + 1, 1);
    const end = Math.max(i + 1, b.end);
    if (!m) return end; // comment, target, footnote or substitution: already collected
    const name = m[1].toLowerCase();
    const arg = m[2].trim();
    // Options (":alt: text") come first in the directive block.
    const opts = new Map<string, string>();
    let k = 0;
    while (k < b.lines.length && /^:[\w-]+:/.test(b.lines[k])) { const om = /^:([\w-]+):\s*(.*)$/.exec(b.lines[k])!; opts.set(om[1], om[2]); k++; }
    const content = b.lines.slice(k);
    while (content.length && blank(content[0])) content.shift();
    if (name === 'image' || name === 'figure') {
      const w = opts.get('width'), h = opts.get('height');
      const dim = (v?: string) => (v && /^\d+(\.\d+)?(px)?$/.test(v) ? parseFloat(v) * 0.75 : v && /^[\d.]+pt$/.test(v) ? parseFloat(v) : null);
      out.push(p([S.image.create({ src: arg, alt: opts.get('alt') || '', width: dim(w), height: dim(h) })], { align: opts.get('align') === 'right' ? 'right' : opts.get('align') === 'left' ? null : 'center' }));
      if (name === 'figure' && content.length) for (const x of this.blocks(content, 1)) out.push(x.type === S.paragraph ? S.paragraph.create({ ...x.attrs, style: 'Caption', align: 'center' }, x.content) : x);
      return end;
    }
    if (/^(code|code-block|sourcecode|highlight|literalinclude|parsed-literal)$/.test(name)) {
      out.push(S.code_block.create({ language: arg || null }, content.join('\n') ? schema.text(content.join('\n')) : null));
      return end;
    }
    if (name === 'math') {
      const latex = [arg, ...content].filter(Boolean).join('\n').trim();
      if (latex) out.push(S.math_block.create({ latex }));
      return end;
    }
    if (name === 'contents' || name === 'toctree') { out.push(S.gen_block.create({ kind: 'toc' })); return end; }
    if (ADMONITIONS.test(name)) {
      const title = name === 'admonition' ? arg : name[0].toUpperCase() + name.slice(1);
      const inner = [p([schema.text(title, [MK.bold.create()])]), ...(name !== 'admonition' && arg ? [p(this.inline(arg))] : []), ...this.blocks(content, 1)];
      const bg: Record<string, string> = { note: '#eef4fb', tip: '#eefbee', hint: '#eefbee', warning: '#fdf1e6', caution: '#fdf1e6', attention: '#fdf1e6', important: '#fdeeee', danger: '#fdeeee', error: '#fdeeee' };
      out.push(S.text_box.create({ bg: bg[name] || '#f4f4f4', border: '1px solid #999' }, inner));
      return end;
    }
    if (name === 'list-table') {
      const items = this.list(content.filter((x, idx) => idx >= 0), 0);
      const rows: CellSpec[][] = [];
      const lst = items.nodes[0];
      lst?.forEach((row) => {
        const cells: CellSpec[] = [];
        row.forEach((child) => {
          if (child.type === S.bullet_list || child.type === S.ordered_list) child.forEach((cell) => { const bl: PMNode[] = []; cell.forEach((x) => bl.push(x)); cells.push({ blocks: bl }); });
        });
        if (cells.length) rows.push(cells);
      });
      if (arg) out.push(p(this.inline(arg), { style: 'Caption' }));
      const t = makeTable(rows, { headerRows: parseInt(opts.get('header-rows') || '0', 10) || 0 });
      if (t) out.push(t);
      return end;
    }
    if (name === 'raw' || name === 'only' || name === 'index' || name === 'meta' || name === 'include' || name === 'role' || name === 'default-role' || name === 'sectnum' || name === 'highlight' || name === 'currentmodule' || name === 'module') return end;
    if (name === 'topic' || name === 'sidebar' || name === 'rubric' || name === 'epigraph' || name === 'pull-quote' || name === 'container' || name === 'centered') {
      if (arg) out.push(p(this.inline(arg), { style: name === 'rubric' ? 'Heading 6' : 'Normal' }));
      for (const x of this.blocks(content, 1)) out.push(x.type === S.paragraph && /quote|epigraph/.test(name) ? S.paragraph.create({ ...x.attrs, style: 'Quote' }, x.content) : x);
      return end;
    }
    // Unknown directive: keep its content.
    if (arg) out.push(p(this.inline(arg)));
    out.push(...this.blocks(content, 1));
    return end;
  }

  private gridTable(rows: string[]): PMNode | null {
    const border = rows[0];
    const cols: number[] = [];
    for (let k = 0; k < border.length; k++) if (border[k] === '+') cols.push(k);
    if (cols.length < 2) return null;
    const out: CellSpec[][] = [];
    let headerRows = 0;
    let cur: string[][] = cols.slice(1).map(() => []);
    for (let r = 1; r < rows.length; r++) {
      const line = rows[r];
      if (/^\+[-=+]+\+\s*$/.test(line)) {
        if (cur.some((c) => c.some((x) => x.trim()))) out.push(cur.map((c) => ({ blocks: this.blocks(c.map((x) => x.trimEnd()), 1) })));
        if (/=/.test(line)) headerRows = out.length;
        cur = cols.slice(1).map(() => []);
        continue;
      }
      for (let c = 0; c + 1 < cols.length; c++) cur[c].push(line.slice(cols[c] + 1, cols[c + 1]).replace(/^ /, ''));
    }
    return makeTable(out.map((r) => r.map((c) => ({ ...c, blocks: c.blocks.length ? c.blocks : [p([])] }))), { headerRows });
  }

  private simpleTable(rows: string[]): PMNode | null {
    const border = rows[0];
    const spans: [number, number][] = [];
    const re = /=+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(border))) spans.push([m.index, m.index + m[0].length]);
    const out: CellSpec[][] = [];
    let headerRows = 0;
    for (let r = 1; r < rows.length; r++) {
      const line = rows[r];
      if (/^=+(\s+=+)*\s*$/.test(line)) { if (r < rows.length - 1) headerRows = out.length; continue; }
      if (blank(line)) continue;
      if (/^-+(\s+-+)*\s*$/.test(line)) continue;
      out.push(spans.map(([a], idx) => ({ blocks: [p(this.inline(line.slice(a, idx === spans.length - 1 ? undefined : spans[idx + 1][0]).trim()))] })));
    }
    return makeTable(out, { headerRows });
  }
}

export function rstToDoc(text: string): PMNode {
  return new RstReader(toLines(text)).read();
}

export async function importRst(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  return rstToDoc(decodeTextBytes(data).replace(/^\ufeff/, ''));
}
