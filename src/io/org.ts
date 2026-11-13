/**
 * Org-mode import (.org).
 *
 * Mapped: #+TITLE / AUTHOR / DATE / EMAIL / KEYWORDS / DESCRIPTION / LANGUAGE → properties
 * (title and author shown at the top), headlines (levels, TODO/DONE keywords and priorities kept
 * as text, tags dropped), drawers and planning lines skipped, paragraphs, plain lists ("-", "+",
 * "*", "1.", "1)") with nesting by indentation, checkboxes and "term :: definition" items,
 * blocks (SRC, EXAMPLE, fixed-width ": " lines → code; QUOTE, VERSE, CENTER; EXPORT html →
 * HTML; COMMENT dropped), tables (with header separator), #+CAPTION, links ([[url][desc]],
 * [[url]], file links to images → pictures, bare URLs), footnotes ([fn:N] with definitions,
 * inline [fn::text]), LaTeX fragments ($…$, \(…\), \[…\], \begin{equation}) → equations,
 * horizontal rules, and inline markup: *bold*, /italic/, _underline_, +strike+, =verbatim=,
 * ~code~, x^{sup}, x_{sub}.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { htmlToBlocks } from './html';
import { headingStyle, makeTable, type CellSpec } from './runs';
import { buildNestedLists, decodeTextBytes, finishDoc, newSettings, type FlatListItem } from './serialize';
import { MK, S, blank, indentOf, linkMark, p, parseInline, toLines, type InlineRule } from './lightmarkup';

const IMG = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;
const LIST_RE = /^(\s*)([-+]|\*(?=\s)|\d+[.)]|[a-zA-Z][.)])\s+(\[[ X-]\]\s+)?(.*)$/;

class OrgReader {
  settings = newSettings();
  notes = new Map<string, string>();
  rules: InlineRule[];

  constructor(private lines: string[]) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\[fn:([\w-]+)\]\s+(.*)$/.exec(lines[i]);
      if (!m) continue;
      let t = m[2];
      for (let k = i + 1; k < lines.length && !blank(lines[k]) && !/^\[fn:|^\*+\s/.test(lines[k]); k++) t += ' ' + lines[k].trim();
      this.notes.set(m[1], t);
    }
    const emph = (ch: string, mark: () => Mark) => ({ re: new RegExp(`\\${ch}([^\\s${ch}](?:[^\\n]*?[^\\s])?)\\${ch}(?=[\\s\\-.,:!?;'")}\\[]|$)`), notAfter: /[^\s('"{\-]/, run: (m: RegExpExecArray) => ({ mark: mark(), inner: m[1] }) });
    this.rules = [
      { re: /\[\[([^\]]+)\](?:\[([^\]]*)\])?\]/, run: (m) => {
        const target = m[1];
        const file = target.replace(/^file:/, '');
        if (IMG.test(file) && !m[2]) return [S.image.create({ src: file })];
        const desc = m[2] || target.replace(/^file:/, '');
        if (m[2] && IMG.test(m[2].replace(/^file:/, ''))) return [S.image.create({ src: m[2].replace(/^file:/, ''), link: target })];
        return { mark: /^[a-z]+:/i.test(target) && !/^file:/.test(target) ? linkMark(target) : linkMark(/^#|\*/.test(target) ? '#' + target.replace(/^[#*]/, '') : target), inner: desc };
      } },
      { re: /\[fn:([\w-]*):([^\]]+)\]/, run: (m) => [S.footnote.create({ text: this.plain(m[2]) })] },
      { re: /\[fn:([\w-]+)\]/, run: (m) => (this.noteBusy.has(m[1]) ? m[0] : [S.footnote.create({ text: this.noteText(m[1]) })]) },
      { re: /\\\(([\s\S]+?)\\\)/, run: (m) => [S.math_inline.create({ latex: m[1].trim() })] },
      { re: /\$([^$\s](?:[^$]*?[^$\s])?)\$(?![\w])/, run: (m) => [S.math_inline.create({ latex: m[1] })] },
      emph('=', () => MK.code.create()),
      emph('~', () => MK.code.create()),
      emph('*', () => MK.bold.create()),
      emph('/', () => MK.italic.create()),
      emph('_', () => MK.underline.create()),
      emph('+', () => MK.strike.create()),
      { re: /\^\{([^}]*)\}/, run: (m) => ({ mark: MK.sup.create(), inner: m[1] }) },
      { re: /_\{([^}]*)\}/, run: (m) => ({ mark: MK.sub.create(), inner: m[1] }) },
      { re: /(https?:\/\/[^\s<>\]]+[^\s<>\].,;:!?)])/, notAfter: /[\w/[]/, run: (m) => ({ mark: linkMark(m[1]), inner: m[1], raw: true }) },
      { re: /\\\\$/, run: () => [S.hard_break.create()] },
      { re: /---/, run: () => '—' },
      { re: /--/, run: () => '–' },
      { re: /\.\.\./, run: () => '…' },
    ];
  }

  private plain(t: string): string { return this.inline(t).map((n) => n.textContent).join(''); }

  /** A footnote's text; a note citing itself (directly or via others) stays a literal "[fn:x]". */
  private noteBusy = new Set<string>();
  private noteCache = new Map<string, string>();
  private noteText(id: string): string {
    let t = this.noteCache.get(id);
    if (t != null) return t;
    this.noteBusy.add(id);
    try { t = this.plain(this.notes.get(id) || ''); } finally { this.noteBusy.delete(id); }
    this.noteCache.set(id, t);
    return t;
  }

  inline(t: string, marks: readonly Mark[] = []): PMNode[] {
    return parseInline(t, this.rules, marks);
  }

  read(): PMNode {
    const L = this.lines;
    const out: PMNode[] = [];
    const kw = (name: string) => L.map((l) => new RegExp(`^#\\+${name}:\\s*(.*)$`, 'i').exec(l)).filter(Boolean).map((m) => m![1].trim());
    const pr = this.settings.properties;
    const title = kw('TITLE').join(' ');
    const author = kw('AUTHOR').join('; ');
    pr.title = title; pr.author = author; pr.keywords = kw('KEYWORDS').join(', '); pr.comments = kw('DESCRIPTION').join(' '); pr.subject = kw('SUBTITLE').join(' ');
    const lang = kw('LANGUAGE')[0];
    if (lang) this.settings.language = lang;
    if (title) out.push(p(this.inline(title), { style: 'Title' }));
    if (kw('SUBTITLE').length) out.push(p(this.inline(kw('SUBTITLE').join(' ')), { style: 'Subtitle' }));
    if (author) out.push(p([schema.text(author)], { align: 'center' }));
    const date = kw('DATE')[0];
    if (date) out.push(p([schema.text(date.replace(/^<|>$/g, ''))], { align: 'center' }));
    out.push(...this.blocks(L));
    return finishDoc(out, this.settings);
  }

  blocks(L: string[]): PMNode[] {
    const out: PMNode[] = [];
    let caption: string | null = null;
    let i = 0;
    const n = L.length;
    while (i < n) {
      const l = L[i];
      if (blank(l)) { i++; continue; }
      const hm = /^(\*+)\s+(.*)$/.exec(l);
      if (hm) {
        const text = hm[2].replace(/\s+(:[\w@#%:]+:)\s*$/, '').replace(/^\[#[A-C]\]\s+/, '');
        out.push(p(this.inline(text), { style: headingStyle(hm[1].length) }));
        i++;
        // Planning line and drawers right under the headline.
        while (i < n && /^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(L[i])) i++;
        continue;
      }
      if (/^\s*:[A-Z_]+:\s*$/.test(l) && !/^\s*:END:/.test(l)) { while (i < n && !/^\s*:END:\s*$/i.test(L[i])) i++; i++; continue; }
      if (/^#\+CAPTION:/i.test(l)) { caption = l.replace(/^#\+CAPTION:\s*/i, ''); i++; continue; }
      const bm = /^\s*#\+BEGIN_(\w+)(?:\s+(.*))?$/i.exec(l);
      if (bm) {
        const kind = bm[1].toUpperCase();
        let k = i + 1;
        while (k < n && !new RegExp(`^\\s*#\\+END_${kind}\\s*$`, 'i').test(L[k])) k++;
        const body = L.slice(i + 1, k);
        const ind = Math.min(...body.filter((x) => !blank(x)).map(indentOf), 1e9);
        const de = body.map((x) => x.slice(Math.min(ind, indentOf(x))));
        i = Math.min(n, k + 1);
        if (kind === 'SRC' || kind === 'EXAMPLE') out.push(S.code_block.create({ language: kind === 'SRC' ? (bm[2] || '').split(/\s+/)[0] || null : null }, de.join('\n') ? schema.text(de.join('\n').replace(/^,(\*|#\+)/gm, '$1')) : null));
        else if (kind === 'QUOTE') for (const b of this.blocks(de)) out.push(b.type === S.paragraph ? S.paragraph.create({ ...b.attrs, style: 'Quote' }, b.content) : b);
        else if (kind === 'VERSE') {
          const inl: PMNode[] = [];
          de.forEach((x, idx) => { if (idx) inl.push(S.hard_break.create()); inl.push(...this.inline(x)); });
          out.push(p(inl, { style: 'Quote' }));
        } else if (kind === 'CENTER') for (const b of this.blocks(de)) out.push(b.type === S.paragraph ? S.paragraph.create({ ...b.attrs, align: 'center' }, b.content) : b);
        else if (kind === 'EXPORT' && /^html/i.test(bm[2] || '')) out.push(...htmlToBlocks(de.join('\n')));
        else if (kind === 'COMMENT' || kind === 'EXPORT') { /* dropped */ }
        else out.push(...this.blocks(de));
        continue;
      }
      if (/^\s*\\begin\{(equation|align|gather|multline)\*?\}/.test(l)) {
        let k = i;
        while (k < n && !/\\end\{/.test(L[k])) k++;
        out.push(S.math_block.create({ latex: L.slice(i, k + 1).join('\n').replace(/\\(begin|end)\{(equation|gather|multline)\*?\}/g, '').replace(/\\begin\{align\*?\}/, '\\begin{aligned}').replace(/\\end\{align\*?\}/, '\\end{aligned}').trim() }));
        i = k + 1;
        continue;
      }
      if (/^\s*\\\[/.test(l)) {
        let k = i;
        while (k < n && !/\\\]/.test(L[k])) k++;
        out.push(S.math_block.create({ latex: L.slice(i, k + 1).join('\n').replace(/^\s*\\\[|\\\]\s*$/g, '').trim() }));
        i = k + 1;
        continue;
      }
      if (/^\s*#\+/.test(l) || /^\s*#(\s|$)/.test(l)) { i++; continue; }
      if (/^\s*-{5,}\s*$/.test(l)) { out.push(S.horizontal_rule.create()); i++; continue; }
      if (/^\[fn:[\w-]+\]\s/.test(l)) { i++; while (i < n && !blank(L[i]) && !/^\[fn:|^\*+\s/.test(L[i])) i++; continue; }
      if (/^\s*:(\s|$)/.test(l)) {
        const body: string[] = [];
        while (i < n && /^\s*:(\s|$)/.test(L[i])) { body.push(L[i].replace(/^\s*:\s?/, '')); i++; }
        out.push(S.code_block.create(null, schema.text(body.join('\n') || ' ')));
        continue;
      }
      if (/^\s*\|/.test(l)) {
        const rows: CellSpec[][] = [];
        let headerRows = 0;
        while (i < n && /^\s*\|/.test(L[i])) {
          const line = L[i].trim();
          if (/^\|[-+]+\|?$/.test(line)) { if (!headerRows && rows.length) headerRows = rows.length; i++; continue; }
          rows.push(line.replace(/^\||\|$/g, '').split('|').map((c) => ({ blocks: [p(this.inline(c.trim()), /^\s*-?[\d.,]+\s*$/.test(c) ? { align: 'right' } : null)] })));
          i++;
        }
        if (caption) { out.push(p(this.inline(caption), { style: 'Caption' })); caption = null; }
        const t = makeTable(rows, { headerRows: headerRows < rows.length ? headerRows : 0 });
        if (t) out.push(t);
        continue;
      }
      if (LIST_RE.test(l)) {
        const r = this.list(L, i);
        out.push(...r.nodes);
        i = r.end;
        continue;
      }
      const body: string[] = [];
      while (i < n && !blank(L[i]) && !/^\*+\s/.test(L[i]) && !/^\s*#\+/.test(L[i]) && !(body.length && LIST_RE.test(L[i]) && !/^\s*\*/.test(L[i])) && !/^\s*\|/.test(L[i])) { body.push(L[i]); i++; }
      const inl: PMNode[] = [];
      body.forEach((b, k) => { const hard = /\\\\\s*$/.test(b); inl.push(...this.inline((k ? ' ' : '') + b.trim().replace(/\\\\$/, ''))); if (hard) inl.push(S.hard_break.create()); });
      const lone = inl.length === 1 && inl[0].type === S.image;
      out.push(p(inl, lone ? { align: 'center' } : null));
      if (caption) { out.push(p(this.inline(caption), { style: 'Caption', align: lone ? 'center' : null })); caption = null; }
    }
    return out;
  }

  private list(L: string[], start: number): { nodes: PMNode[]; end: number } {
    const items: (FlatListItem & { ind: number })[] = [];
    let i = start;
    const n = L.length;
    const baseInd = indentOf(L[start]);
    const defs: PMNode[] = [];
    while (i < n) {
      const l = L[i];
      if (blank(l)) {
        let k = i + 1;
        while (k < n && blank(L[k])) k++;
        if (k - i >= 2 || k >= n || indentOf(L[k]) < baseInd || (!LIST_RE.test(L[k]) && indentOf(L[k]) <= baseInd)) { i = k - i >= 2 ? k : i; break; }
        i = k;
        continue;
      }
      const m = LIST_RE.exec(l);
      if (!m || indentOf(l) < baseInd || /^\*/.test(l)) {
        if (indentOf(l) > baseInd && items.length) {
          // Continuation of the previous item.
          const prev = items[items.length - 1];
          const last = prev.blocks[prev.blocks.length - 1];
          prev.blocks[prev.blocks.length - 1] = S.paragraph.create(last.attrs, [...this.contentOf(last), ...this.inline(' ' + l.trim())]);
          i++;
          continue;
        }
        break;
      }
      const marker = m[2];
      const ordered = /^\d|^[a-zA-Z][.)]/.test(marker);
      const checkbox = m[3];
      let text = m[4];
      const dm = /^(.*?)\s+::\s*(.*)$/.exec(text);
      const ind = indentOf(l);
      const level = items.length ? Math.max(0, items.filter((x) => x.ind < ind).reduce((a, x) => Math.max(a, x.level + 1), 0)) : 0;
      if (dm && !ordered) {
        defs.push(p(this.inline(dm[1], [MK.bold.create()]), { keepNext: true }), p(this.inline(dm[2]), { indentLeft: 36 }));
        i++;
        continue;
      }
      i++;
      while (i < n && !blank(L[i]) && indentOf(L[i]) > ind && !LIST_RE.test(L[i])) { text += ' ' + L[i].trim(); i++; }
      items.push({
        level: ind === baseInd ? 0 : level, ind, ordered, format: ordered ? (/^[a-z]/.test(marker) ? 'lower-alpha' : /^[A-Z]/.test(marker) ? 'upper-alpha' : 'decimal') : 'disc',
        start: ordered && /^\d+/.test(marker) && !items.length ? parseInt(marker, 10) : 1, task: !!checkbox, checked: checkbox ? /X/.test(checkbox) : null, blocks: [p(this.inline(text))],
      });
    }
    const nodes = items.length ? buildNestedLists(items) : [];
    return { nodes: [...nodes, ...defs], end: i };
  }

  private contentOf(n: PMNode): PMNode[] { const out: PMNode[] = []; n.forEach((c) => out.push(c)); return out; }
}

export function orgToDoc(text: string): PMNode {
  return new OrgReader(toLines(text)).read();
}

export async function importOrg(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  return orgToDoc(decodeTextBytes(data).replace(/^\ufeff/, ''));
}
