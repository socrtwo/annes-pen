/**
 * AsciiDoc import (.adoc, .asciidoc).
 *
 * Mapped: document header (title, author line, attributes such as :author:, :description:,
 * :keywords:, :lang:, attribute references {name}), section titles (= to ======, and Markdown
 * style #), block titles (captions), paragraphs with hard line breaks (" +"), admonition
 * paragraphs and blocks (NOTE/TIP/IMPORTANT/WARNING/CAUTION → text boxes), delimited blocks
 * (---- listing/source, .... literal, ____ quote with attribution, ==== example, **** sidebar,
 * ++++ passthrough incl. latexmath, -- open, //// comment), literal (indented) paragraphs,
 * unordered / ordered (explicit and implicit numbering, list styles) / checklist / description
 * lists with nesting and "+" continuations, tables (|=== with cols, header option or implicit
 * header row, colspan "n+", rowspan ".n+", alignment), images (block and inline), thematic and
 * page breaks, and inline markup: *strong*, _emphasis_, `monospace`, #highlight#, ^super^,
 * ~sub~, [.underline]/[.line-through] roles, links (url[text], link:, mailto:, xrefs <<id>>),
 * footnote:[…], stem/latexmath:[…], kbd:[…], typographic replacements.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { headingStyle, makeTable, type CellSpec } from './runs';
import { buildNestedLists, decodeTextBytes, finishDoc, newSettings, type FlatListItem } from './serialize';
import { MK, S, blank, linkMark, p, parseInline, toLines, type InlineRule } from './lightmarkup';

const DELIMS: Record<string, string> = { '----': 'listing', '....': 'literal', '____': 'quote', '====': 'example', '****': 'sidebar', '++++': 'pass', '--': 'open', '////': 'comment', '```': 'listing' };
const ADMON = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+(.*)$/;
const ADMON_BG: Record<string, string> = { NOTE: '#eef4fb', TIP: '#eefbee', IMPORTANT: '#fdeeee', WARNING: '#fdf1e6', CAUTION: '#fdf1e6' };
const ORDERED_STYLES: Record<string, string> = { arabic: 'decimal', decimal: 'decimal', loweralpha: 'lower-alpha', upperalpha: 'upper-alpha', lowerroman: 'lower-roman', upperroman: 'upper-roman', lowergreek: 'lower-greek' };

class AdocReader {
  settings = newSettings();
  attrs = new Map<string, string>();
  rules: InlineRule[];

  constructor(private lines: string[]) {
    const ws = /[\w]/;
    const cons = (open: string, mark: () => Mark | null) => ({ re: new RegExp(`${open}(?![\\s${open[open.length - 1]}])([^\\n]*?[^\\s])${open}(?![\\w])`), notAfter: ws, run: (m: RegExpExecArray) => ({ mark: mark(), inner: m[1] }) });
    const uncons = (open: string, mark: () => Mark | null) => ({ re: new RegExp(`${open}([^\\n]+?)${open}`), run: (m: RegExpExecArray) => ({ mark: mark(), inner: m[1] }) });
    this.rules = [
      { re: /\\([*_`#^~{+])/, run: (m) => m[1] },
      { re: /\{([\w-]+)\}/, run: (m) => (this.attrs.has(m[1]) ? this.attrs.get(m[1])! : m[0]) },
      { re: /(?:latexmath|stem|asciimath):\[\$?([\s\S]*?)\$?\]/, run: (m) => [S.math_inline.create({ latex: m[1].replace(/^\\\(|\\\)$/g, '') })] },
      { re: /footnote(?:ref)?:([\w-]*)\[((?:[^\]\\]|\\.)*)\]/, run: (m) => (m[2] ? [S.footnote.create({ text: this.plain(m[2]) })] : '') },
      { re: /kbd:\[([^\]]+)\]/, run: (m) => ({ mark: MK.code.create(), inner: m[1] }) },
      { re: /(?:btn|menu):([^[\s]*)\[([^\]]*)\]/, run: (m) => ({ mark: MK.bold.create(), inner: [m[1], m[2]].filter(Boolean).join(' ▸ ') }) },
      { re: /pass:[a-z,]*\[([^\]]*)\]/, run: (m) => m[1] },
      { re: /image:(?!:)([^\s[]+)\[([^\]]*)\]/, run: (m) => [S.image.create({ src: m[1], alt: m[2].split(',')[0] || '' })] },
      { re: /link:([^\s[]+)\[([^\]]*)\]/, run: (m) => ({ mark: linkMark(m[1]), inner: (m[2] || m[1]).replace(/\^$/, '').replace(/,\s*window=.*$/, '').replace(/^"|"$/g, '') }) },
      { re: /mailto:([^\s[]+)\[([^\]]*)\]/, run: (m) => ({ mark: linkMark('mailto:' + m[1]), inner: m[2] || m[1] }) },
      { re: /((?:https?|ftp|irc|file):\/\/[^\s[<>]+)\[([^\]]*)\]/, run: (m) => ({ mark: linkMark(m[1]), inner: (m[2] || m[1]).replace(/\^$/, '').replace(/,\s*window=.*$/, '').replace(/^"|"$/g, '') }) },
      { re: /<?((?:https?|ftp):\/\/[^\s<>[\]]+[^\s<>[\].,;:!?)])>?/, notAfter: /[\w/:]/, run: (m) => ({ mark: linkMark(m[1]), inner: m[1], raw: true }) },
      { re: /<<([\w:.-]+)(?:,\s*([^>]+))?>>/, run: (m) => ({ mark: linkMark('#' + m[1]), inner: m[2] || m[1] }) },
      { re: /xref:([\w:.#-]+)\[([^\]]*)\]/, run: (m) => ({ mark: linkMark('#' + m[1]), inner: m[2] || m[1] }) },
      { re: /\[\.(underline|line-through|big|small|[\w-]+)\]#([^#\n]+)#/, run: (m) => ({ mark: m[1] === 'underline' ? MK.underline.create() : m[1] === 'line-through' ? MK.strike.create() : m[1] === 'big' ? MK.size.create({ pt: 14 }) : m[1] === 'small' ? MK.size.create({ pt: 9 }) : null, inner: m[2] }) },
      { re: /\[(red|green|blue|yellow|orange|purple|gray|grey|aqua|fuchsia|lime|maroon|navy|olive|silver|teal|white|black)\]#([^#\n]+)#/, run: (m) => ({ mark: MK.color.create({ color: m[1] }), inner: m[2] }) },
      { re: /\[line-through\]\*([^*\n]+)\*/, run: (m) => ({ mark: MK.strike.create(), inner: m[1] }) },
      { re: /\[[\w.#-]*\]/, notAfter: /\S/, run: (m) => m[0] },
      uncons('\\*\\*', () => MK.bold.create()),
      uncons('__', () => MK.italic.create()),
      uncons('``', () => MK.code.create()),
      uncons('##', () => MK.highlight.create({ color: '#ffff00' })),
      { re: /"`([^`\n]+)`"/, run: (m) => ({ mark: null, inner: '“' + m[1] + '”' }) },
      { re: /'`([^`\n]+)`'/, run: (m) => ({ mark: null, inner: '‘' + m[1] + '’' }) },
      cons('\\*', () => MK.bold.create()),
      cons('_', () => MK.italic.create()),
      { re: /`([^`\n]+)`/, notAfter: ws, run: (m) => ({ mark: MK.code.create(), inner: m[1] }) },
      cons('#', () => MK.highlight.create({ color: '#ffff00' })),
      { re: /\^([^^\s]+)\^/, run: (m) => ({ mark: MK.sup.create(), inner: m[1] }) },
      { re: /~([^~\s]+)~/, run: (m) => ({ mark: MK.sub.create(), inner: m[1] }) },
      { re: / \+$/, run: () => [S.hard_break.create()] },
      { re: /\(C\)/, run: () => '©' },
      { re: /\(R\)/, run: () => '®' },
      { re: /\(TM\)/, run: () => '™' },
      { re: /(?<=\w)--(?=\w)/, run: () => '—' },
      { re: / -- /, run: () => ' — ' },
      { re: /\.\.\./, run: () => '…' },
      { re: /->/, run: () => '→' },
      { re: /<-/, run: () => '←' },
      { re: /=>/, run: () => '⇒' },
    ];
  }

  private plain(t: string): string { return this.inline(t).map((n) => n.textContent).join(''); }

  inline(t: string, marks: readonly Mark[] = []): PMNode[] {
    return parseInline(t, this.rules, marks);
  }

  /** Inline content of a paragraph's lines, keeping hard breaks (" +" line ends). */
  paraInline(lines: string[]): PMNode[] {
    const out: PMNode[] = [];
    lines.forEach((l, k) => {
      const hard = / \+$/.test(l);
      out.push(...this.inline((k ? ' ' : '') + l.replace(/ \+$/, '').trim()));
      if (hard && k < lines.length - 1) out.push(S.hard_break.create());
    });
    return out;
  }

  read(): PMNode {
    let i = 0;
    const L = this.lines;
    // Header.
    while (i < L.length && /^\/\//.test(L[i])) i++;
    const out: PMNode[] = [];
    if (/^=\s+\S/.test(L[i] || '')) {
      const title = L[i].replace(/^=\s+/, '');
      this.settings.properties.title = this.plain(title);
      out.push(p(this.inline(title), { style: 'Title' }));
      i++;
      if (L[i] && !blank(L[i]) && !/^:/.test(L[i])) {
        const author = L[i].replace(/<[^>]*>/g, '').trim();
        this.settings.properties.author = author.replace(/;\s*/g, '; ');
        out.push(p([schema.text(author)], { align: 'center' }));
        i++;
        if (L[i] && /^v?\d|^\d{4}-\d\d/.test(L[i])) i++; // revision line
      }
    }
    for (let k = 0; k < L.length; k++) {
      const m = /^:([\w-]+):\s*(.*)$/.exec(L[k]);
      if (!m) continue;
      this.attrs.set(m[1], m[2]);
      const pr = this.settings.properties;
      if (m[1] === 'author') pr.author = m[2];
      else if (m[1] === 'description') pr.comments = m[2];
      else if (m[1] === 'keywords') pr.keywords = m[2];
      else if (m[1] === 'lang' && m[2]) this.settings.language = m[2];
      else if (m[1] === 'doctitle' && !pr.title) pr.title = m[2];
    }
    out.push(...this.blocks(L.slice(i)));
    return finishDoc(out, this.settings);
  }

  blocks(L: string[]): PMNode[] {
    const out: PMNode[] = [];
    let i = 0;
    let blockAttrs: string | null = null;
    let blockTitle: string | null = null;
    const n = L.length;
    const takeTitle = () => { const t = blockTitle; blockTitle = null; return t; };
    while (i < n) {
      const l = L[i];
      if (blank(l)) { i++; continue; }
      if (/^\/\/(?!\/)/.test(l)) { i++; continue; }
      if (/^:[\w-]+:/.test(l)) { i++; continue; }
      if (/^\[[^\]]*\]\s*$/.test(l) && !/^\[\[/.test(l)) { blockAttrs = l.slice(1, -1); i++; continue; }
      if (/^\[\[[^\]]*\]\]\s*$/.test(l)) { i++; continue; }
      if (/^\.[^\s.]/.test(l)) { blockTitle = l.slice(1); i++; continue; }
      // Section titles.
      const sm = /^(={2,6}|#{2,6})\s+(.*?)\s*(=*)$/.exec(l);
      if (sm) {
        out.push(p(this.inline(sm[2]), { style: headingStyle(sm[1].length - 1) }));
        blockAttrs = null;
        i++;
        continue;
      }
      if (/^'{3,}\s*$/.test(l) || /^(\*\s*){3,}$/.test(l) || /^-{3}\s*$/.test(l) && !DELIMS[l.trim()]) { out.push(S.horizontal_rule.create()); i++; continue; }
      if (/^<<<\s*$/.test(l)) { out.push(S.page_break.create()); i++; continue; }
      // Delimited blocks.
      const delim = /^(-{4,}|\.{4,}|_{4,}|={4,}|\*{4,}|\+{4,}|\/{4,}|--|`{3}\w*)\s*$/.exec(l);
      if (delim) {
        const mark = delim[1].startsWith('```') ? '```' : delim[1];
        const kind = DELIMS[mark.slice(0, 4)] || DELIMS[mark] || DELIMS[mark.slice(0, 2)] || 'open';
        let k = i + 1;
        while (k < n && L[k].trimEnd() !== mark) k++;
        const body = L.slice(i + 1, k);
        i = Math.min(n, k + 1);
        const attrs = blockAttrs || '';
        blockAttrs = null;
        const title = takeTitle();
        if (title) out.push(p(this.inline(title), { style: 'Caption' }));
        if (kind === 'comment') continue;
        if (kind === 'listing' || kind === 'literal') {
          const lang = /source,\s*([\w+-]+)/.exec(attrs)?.[1] || (mark.startsWith('```') ? l.slice(3).trim() || null : null);
          out.push(S.code_block.create({ language: lang }, body.join('\n') ? schema.text(body.join('\n')) : null));
          continue;
        }
        if (kind === 'pass') {
          if (/latexmath|stem/.test(attrs)) out.push(S.math_block.create({ latex: body.join('\n').trim().replace(/^\\\[|\\\]$/g, '').replace(/^\$\$|\$\$$/g, '').trim() }));
          continue;
        }
        if (kind === 'quote') {
          const parts = attrs.split(',').map((x) => x.trim());
          const inner = this.blocks(body);
          for (const b of inner) out.push(b.type === S.paragraph ? S.paragraph.create({ ...b.attrs, style: 'Quote' }, b.content) : b);
          if (parts[1]) out.push(p([schema.text('— ' + [parts[1], parts[2]].filter(Boolean).join(', '))], { style: 'Quote', align: 'right' }));
          continue;
        }
        const adm = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION)$/.exec(attrs);
        if (adm || kind === 'sidebar' || kind === 'example') {
          const inner = this.blocks(body);
          if (adm) inner.unshift(p([schema.text(adm[1][0] + adm[1].slice(1).toLowerCase(), [MK.bold.create()])]));
          out.push(S.text_box.create({ bg: adm ? ADMON_BG[adm[1]] : kind === 'sidebar' ? '#f4f4f4' : null, border: '1px solid #999' }, inner.length ? inner : [p([])]));
          continue;
        }
        out.push(...this.blocks(body));
        continue;
      }
      // Tables.
      if (/^[|!,:]===\s*$/.test(l)) {
        const sep = l[0];
        let k = i + 1;
        while (k < n && !new RegExp(`^\\${sep}===\\s*$`).test(L[k])) k++;
        const t = this.table(L.slice(i + 1, k), blockAttrs || '', sep);
        const title = takeTitle();
        if (title) out.push(p(this.inline(title), { style: 'Caption' }));
        if (t) out.push(t);
        blockAttrs = null;
        i = Math.min(n, k + 1);
        continue;
      }
      // Block image.
      const im = /^image::([^[]+)\[([^\]]*)\]\s*$/.exec(l);
      if (im) {
        const [alt, w, h] = im[2].split(',').map((x) => x.trim());
        const dim = (v?: string) => (v && /^\d+$/.test(v) ? parseInt(v, 10) * 0.75 : null);
        out.push(p([S.image.create({ src: im[1], alt: alt || '', width: dim(w), height: dim(h) })], { align: 'center' }));
        const title = takeTitle();
        if (title) out.push(p(this.inline(title), { style: 'Caption', align: 'center' }));
        i++;
        continue;
      }
      if (/^toc::\[\]/.test(l)) { out.push(S.gen_block.create({ kind: 'toc' })); i++; continue; }
      // Description lists: "term:: definition".
      if (/^[^\s:].*?(:{2,4}|;;)(\s+.*)?$/.test(l) && !/^[a-z]+:\/\//i.test(l) && !/^\w+::[^\s]/.test(l)) {
        while (i < n) {
          const dm = /^(.+?)(:{2,4}|;;)(?:\s+(.*))?$/.exec(L[i]);
          if (!dm || blank(L[i])) break;
          out.push(p(this.inline(dm[1].trim(), [MK.bold.create()]), { keepNext: true }));
          let def = dm[3] || '';
          i++;
          while (i < n && !blank(L[i]) && !/^(.+?)(:{2,4}|;;)(\s|$)/.test(L[i])) { def += ' ' + L[i].trim(); i++; }
          if (def.trim()) out.push(p(this.inline(def.trim()), { indentLeft: 36 }));
          while (i < n && blank(L[i]) && i + 1 < n && /^[^\s:].*?(:{2,4}|;;)(\s|$)/.test(L[i + 1])) i++;
        }
        blockAttrs = null;
        continue;
      }
      // Lists.
      if (/^\s*(\*{1,5}|-|\.{1,5}|\d+\.|[a-zA-Z]\.|[ivxIVX]+\))\s+\S/.test(l)) {
        const r = this.list(L, i, blockAttrs);
        if (r) { out.push(...r.nodes); i = r.end; blockAttrs = null; continue; }
      }
      // Literal paragraph (indented).
      if (/^\s+\S/.test(l)) {
        const body: string[] = [];
        while (i < n && !blank(L[i]) && /^\s/.test(L[i])) { body.push(L[i]); i++; }
        const ind = Math.min(...body.map((x) => x.length - x.trimStart().length));
        out.push(S.code_block.create(null, schema.text(body.map((x) => x.slice(ind)).join('\n'))));
        continue;
      }
      // Paragraph (maybe an admonition).
      const body: string[] = [];
      while (i < n && !blank(L[i]) && !(body.length && (/^(={2,6})\s/.test(L[i]) || /^[|]===/.test(L[i]) || /^(-{4,}|\.{4,}|_{4,}|={4,}|\*{4,})\s*$/.test(L[i])))) { body.push(L[i]); i++; }
      const title = takeTitle();
      if (title) out.push(p(this.inline(title), { style: 'Caption' }));
      const adm = ADMON.exec(body[0]);
      const attrs = blockAttrs || '';
      blockAttrs = null;
      if (adm || /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION)$/.test(attrs)) {
        const kind = adm ? adm[1] : attrs;
        const lines = adm ? [adm[2], ...body.slice(1)] : body;
        out.push(S.text_box.create({ bg: ADMON_BG[kind], border: '1px solid #999' }, [p([schema.text(kind[0] + kind.slice(1).toLowerCase() + ': ', [MK.bold.create()]), ...this.paraInline(lines)])]));
        continue;
      }
      if (/^quote|^verse/.test(attrs)) {
        const parts = attrs.split(',').map((x) => x.trim());
        out.push(p(this.paraInline(body), { style: 'Quote' }));
        if (parts[1]) out.push(p([schema.text('— ' + parts[1])], { style: 'Quote', align: 'right' }));
        continue;
      }
      const inl = this.paraInline(body);
      if (inl.length === 1 && inl[0].type === S.math_inline && /^\s*(latexmath|stem)/.test(body.join(''))) out.push(S.math_block.create({ latex: inl[0].attrs.latex }));
      else out.push(p(inl, /^\.?text-center|^\.?center/.test(attrs) ? { align: 'center' } : null));
    }
    return out;
  }

  private list(L: string[], start: number, attrs: string | null): { nodes: PMNode[]; end: number } | null {
    const items: FlatListItem[] = [];
    let i = start;
    const n = L.length;
    const styleFmt = attrs ? ORDERED_STYLES[attrs.split(',')[0].trim()] : undefined;
    const startAttr = attrs ? /start=(\d+)/.exec(attrs)?.[1] : undefined;
    let pendingFmt: string | undefined = styleFmt;
    while (i < n) {
      const l = L[i];
      if (blank(l)) {
        // A blank line ends the list unless another item follows.
        let k = i + 1;
        while (k < n && blank(L[k])) k++;
        if (k < n && /^\s*(\*{1,5}|-|\.{1,5}|\d+\.)\s+\S/.test(L[k])) { i = k; continue; }
        break;
      }
      if (/^\[[a-z]+[^\]]*\]\s*$/.test(l)) { pendingFmt = ORDERED_STYLES[l.slice(1, -1).split(',')[0].trim()]; i++; continue; }
      const um = /^\s*(\*{1,5}|-)\s+(\[[ xX*]\]\s+)?(.*)$/.exec(l);
      const om = /^\s*(\.{1,5}|\d+\.|[a-zA-Z]\.|[ivxIVX]+\))\s+(.*)$/.exec(l);
      let level = 0, ordered = false, format = 'disc', text = '', checked: boolean | null = null, task = false, begin = 1;
      if (um) { level = um[1] === '-' ? 0 : um[1].length - 1; text = um[3]; if (um[2]) { task = true; checked = /[xX*]/.test(um[2]); } }
      else if (om) {
        ordered = true;
        const mk = om[1];
        level = /^\.+$/.test(mk) ? mk.length - 1 : 0;
        format = pendingFmt || (/^\d/.test(mk) ? 'decimal' : /^[ivx]+\)$/.test(mk) ? 'lower-roman' : /^[IVX]+\)$/.test(mk) ? 'upper-roman' : /^[a-z]\.$/.test(mk) ? 'lower-alpha' : /^[A-Z]\.$/.test(mk) ? 'upper-alpha' : ['decimal', 'lower-alpha', 'lower-roman', 'upper-alpha', 'upper-roman'][level] || 'decimal');
        if (/^\d+\.$/.test(mk) && !items.length) begin = parseInt(mk, 10);
        if (startAttr && !items.length) begin = parseInt(startAttr, 10);
        text = om[2];
        pendingFmt = undefined;
      } else break;
      i++;
      // Continuation lines and "+"-attached blocks.
      const extra: PMNode[] = [];
      while (i < n && !blank(L[i]) && !/^\s*(\*{1,5}|-|\.{1,5}|\d+\.)\s+\S/.test(L[i]) && !/^\[[a-z][^\]]*\]\s*$/.test(L[i]) && L[i].trim() !== '+') { text += ' ' + L[i].trim(); i++; }
      while (i < n && L[i].trim() === '+') {
        i++;
        const d = /^(-{4,}|\.{4,}|_{4,}|={4,}|\*{4,}|--)\s*$/.exec(L[i] || '');
        let k = i;
        if (d) { k = i + 1; while (k < n && L[k].trimEnd() !== d[1]) k++; k = Math.min(n, k + 1); }
        else while (k < n && !blank(L[k]) && !/^\s*(\*{1,5}|-|\.{1,5}|\d+\.)\s+\S/.test(L[k]) && L[k].trim() !== '+') k++;
        extra.push(...this.blocks(L.slice(i, k)));
        i = k;
      }
      items.push({ level, ordered, format, start: begin, task, checked, blocks: [p(this.inline(text)), ...extra] });
    }
    if (!items.length) return null;
    return { nodes: buildNestedLists(items), end: i };
  }

  private table(rows: string[], attrs: string, sep: string): PMNode | null {
    const colsAttr = /cols="?([^"]*)"?/.exec(attrs)?.[1] || '';
    const colSpecs = colsAttr ? colsAttr.split(/[,;]/).flatMap((c) => { const mm = /^(\d+)\*(.*)$/.exec(c.trim()); return mm ? Array(parseInt(mm[1], 10)).fill(mm[2]) : [c.trim()]; }) : [];
    const aligns = colSpecs.map((c) => (/\^/.test(c) ? 'center' : />/.test(c) ? 'right' : null));
    const header = /options="?[^"]*header/.test(attrs) || /%header/.test(attrs);
    const ch = sep === '|' || sep === '!' ? sep : sep === ',' ? ',' : ':';
    // Cells: "spec|content"; rows end when the number of columns is reached.
    const cells: { text: string; colspan: number; rowspan: number; align: string | null; style: string }[] = [];
    let firstRowCells = 0, implicitHeader = false;
    rows.forEach((line, idx) => {
      if (blank(line)) { if (idx > 0 && cells.length && !firstRowCells) { firstRowCells = cells.length; implicitHeader = true; } return; }
      if (ch !== '|' && ch !== '!') { for (const v of line.split(ch)) cells.push({ text: v, colspan: 1, rowspan: 1, align: null, style: '' }); if (!firstRowCells && idx === 0) firstRowCells = cells.length; return; }
      const re = new RegExp(`(?:^|\\s)((?:\\d+\\+|\\.\\d+\\+|\\d+\\.\\d+\\+|\\d+\\*)?[<^>]?(?:\\.[<^>])?[adehlmsv]?)\\${ch}`, 'g');
      const parts: { spec: string; at: number; end: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) parts.push({ spec: m[1], at: m.index + m[0].length - 1 - m[1].length - (m[0].startsWith(' ') ? 0 : 0), end: m.index + m[0].length });
      if (!parts.length) { if (cells.length) cells[cells.length - 1].text += ' ' + line.trim(); return; }
      parts.forEach((pt, k) => {
        const text = line.slice(pt.end, k + 1 < parts.length ? parts[k + 1].end - 1 - parts[k + 1].spec.length : undefined).trim();
        const span = /^(?:(\d+))?(?:\.(\d+))?\+/.exec(pt.spec);
        cells.push({ text, colspan: span?.[1] ? parseInt(span[1], 10) : 1, rowspan: span?.[2] ? parseInt(span[2], 10) : 1, align: /\^/.test(pt.spec) ? 'center' : />/.test(pt.spec) ? 'right' : null, style: pt.spec.slice(-1) });
      });
      if (idx === 0 && !firstRowCells && rows[1] !== undefined && !blank(rows[1])) firstRowCells = 0;
      if (idx === 0) firstRowCells = cells.reduce((a, c) => a + c.colspan, 0);
    });
    const ncols = colSpecs.length || firstRowCells || 1;
    const out: CellSpec[][] = [];
    let row: CellSpec[] = [];
    let used = 0;
    const carry: number[] = Array(ncols).fill(0);
    for (const c of cells) {
      while (used < ncols && carry[used] > 0) { carry[used]--; used++; }
      const blocks = c.style === 'a' ? this.blocks(c.text.split('\n')) : [p(this.inline(c.text), c.align || aligns[used] ? { align: c.align || aligns[used] } : null)];
      row.push({ blocks, colspan: c.colspan, rowspan: c.rowspan, header: c.style === 'h' });
      if (c.rowspan > 1) for (let k = 0; k < c.colspan; k++) carry[used + k] = c.rowspan - 1;
      used += c.colspan;
      while (used < ncols && carry[used] > 0) { carry[used]--; used++; }
      if (used >= ncols) { out.push(row); row = []; used = 0; }
    }
    if (row.length) out.push(row);
    return makeTable(out, { headerRows: header || implicitHeader ? 1 : 0 });
  }
}

export function asciidocToDoc(text: string): PMNode {
  return new AdocReader(toLines(text)).read();
}

export async function importAsciidoc(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  return asciidocToDoc(decodeTextBytes(data).replace(/^\ufeff/, ''));
}
