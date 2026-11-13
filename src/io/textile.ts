/**
 * Textile import (.textile).
 *
 * Mapped: block signatures h1.–h6., p., bq. (and bq.. extended), bc./pre. (extended too),
 * fnN. footnotes, alignment and class modifiers (<, >, =, <>, (class), {style} with color /
 * text-align), bullet (*) and numbered (#) lists with nesting, tables (|_. header cells, cell
 * alignment, colspan \N and rowspan /N), inline HTML blocks, and inline markup: *strong*,
 * _emphasis_, **bold**, __italic__, -deleted-, +inserted+, ^sup^, ~sub~, @code@, %span%,
 * ??citation??, "links":url, !images(alt)!, footnote references [1], and acronyms ABC(text).
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { htmlToBlocks } from './html';
import { headingStyle, makeTable, normAlign, type CellSpec } from './runs';
import { buildNestedLists, decodeTextBytes, finishDoc, newSettings, type FlatListItem } from './serialize';
import { MK, S, blank, linkMark, p, parseInline, toLines, type InlineRule } from './lightmarkup';

const MOD = String.raw`(?:\([^)]*\)|\{[^}]*\}|\[[^\]]*\]|<>|<|>|=|\(+|\)+)*`;

function modifiers(mod: string): Record<string, any> {
  const a: Record<string, any> = {};
  if (/<>/.test(mod)) a.align = 'justify';
  else if (/(^|[^<])>/.test(mod.replace(/<>/g, ''))) a.align = 'right';
  else if (/=/.test(mod.replace(/\{[^}]*\}/g, ''))) a.align = 'center';
  const style = /\{([^}]*)\}/.exec(mod)?.[1] || '';
  const ta = /text-align\s*:\s*(\w+)/.exec(style);
  if (ta) a.align = normAlign(ta[1]);
  const pl = (mod.match(/\(/g) || []).length - (mod.match(/\([^)]*\)/g) || []).length;
  if (pl > 0) a.indentLeft = pl * 18;
  return a;
}

class TextileReader {
  settings = newSettings();
  notes = new Map<string, string>();
  rules: InlineRule[];

  constructor(private lines: string[]) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^fn(\d+)\^?(?:\([^)]*\))?\.\s+(.*)$/.exec(lines[i]);
      if (m) {
        let t = m[2];
        for (let k = i + 1; k < lines.length && !blank(lines[k]); k++) t += ' ' + lines[k].trim();
        this.notes.set(m[1], t);
      }
    }
    const ws = /[\w]/;
    const span = (ch: string, mark: () => Mark | null) => ({ re: new RegExp(`\\[?${ch}(?!\\s)([^${ch[ch.length - 1]}\\n](?:[^\\n]*?[^\\s])?)${ch}\\]?(?![\\w])`), notAfter: ws, run: (m: RegExpExecArray) => ({ mark: mark(), inner: m[1] }) });
    this.rules = [
      { re: /==(.+?)==/, run: (m) => m[1] },
      { re: /"([^"\n]+?)(?:\(([^)]*)\))?":((?:https?|ftp|mailto|file):[^\s<>"]+[^\s<>".,;:!?)]|[^\s<>"]+[^\s<>".,;:!?)])/, run: (m) => ({ mark: linkMark(m[3]), inner: m[1] }) },
      { re: /\[\^([^^\n]+)\^\]/, run: (m) => ({ mark: MK.sup.create(), inner: m[1] }) },
      { re: /\[~([^~\n]+)~\]/, run: (m) => ({ mark: MK.sub.create(), inner: m[1] }) },
      { re: /\[(\d+)\]/, run: (m) => (this.notes.has(m[1]) && !this.noteBusy.has(m[1]) ? [S.footnote.create({ text: this.noteText(m[1]) })] : m[0]) },
      { re: /!(\{[^}]*\}|<|>|=)*([^\s!(]+)(?:\(([^)]*)\))?!(?::(\S+))?/, run: (m) => [S.image.create({ src: m[2], alt: m[3] || '', link: m[4] || null })] },
      { re: /@([^@\n]+)@/, run: (m) => ({ mark: MK.code.create(), inner: m[1] }) },
      span('\\*\\*', () => MK.bold.create()),
      span('__', () => MK.italic.create()),
      span('\\*', () => MK.bold.create()),
      span('_', () => MK.italic.create()),
      span('\\?\\?', () => MK.italic.create()),
      span('-', () => MK.strike.create()),
      span('\\+', () => MK.underline.create()),
      { re: /\[?\^([^^\n]+)\^\]?/, run: (m) => ({ mark: MK.sup.create(), inner: m[1] }) },
      { re: /\[?~([^~\n]+)~\]?/, run: (m) => ({ mark: MK.sub.create(), inner: m[1] }) },
      { re: /%(\{[^}]*\})?([^%\n]+)%/, run: (m) => { const c = /color\s*:\s*([#\w]+)/.exec(m[1] || ''); return { mark: c ? MK.color.create({ color: c[1] }) : null, inner: m[2] }; } },
      { re: /\b([A-Z][A-Z0-9]{1,})\(([^)]+)\)/, run: (m) => m[1] },
      { re: /<br\s*\/?>/i, run: () => [S.hard_break.create()] },
      { re: /<span class="math">([\s\S]*?)<\/span>/, run: (m) => [S.math_inline.create({ latex: m[1] })] },
      { re: /<\/?[a-zA-Z][^>]*>/, run: () => '' },
      { re: /\(c\)|\(C\)/, run: () => '©' },
      { re: /\(r\)|\(R\)/, run: () => '®' },
      { re: /\(tm\)|\(TM\)/, run: () => '™' },
      { re: / -- /, run: () => ' – ' },
      { re: /--/, run: () => '—' },
      { re: /\.\.\./, run: () => '…' },
    ];
  }

  private plain(t: string): string { return this.inline(t).map((n) => n.textContent).join(''); }

  /** A footnote's text; a note citing itself (directly or via others) stays a literal "[n]". */
  private noteBusy = new Set<string>();
  private noteCache = new Map<string, string>();
  private noteText(id: string): string {
    let t = this.noteCache.get(id);
    if (t != null) return t;
    this.noteBusy.add(id);
    try { t = this.plain(this.notes.get(id)!); } finally { this.noteBusy.delete(id); }
    this.noteCache.set(id, t);
    return t;
  }

  inline(t: string, marks: readonly Mark[] = []): PMNode[] {
    return parseInline(t.replace(/\n/g, ' '), this.rules, marks);
  }

  read(): PMNode {
    const out: PMNode[] = [];
    const lines = this.lines;
    let i = 0;
    const n = lines.length;
    const sig = new RegExp(`^(h[1-6]|p|bq|bc|pre|fn\\d+|notextile|###)(${MOD})(\\.\\.?)\\s+(.*)$`);
    while (i < n) {
      const l = lines[i];
      if (blank(l)) { i++; continue; }
      const m = sig.exec(l);
      if (m) {
        const [, tag, mod, dots, first] = m;
        const extended = dots === '..';
        const body: string[] = [first];
        i++;
        if (extended) {
          // Continues across blank lines until the next block signature.
          while (i < n && !sig.test(lines[i])) { body.push(lines[i]); i++; }
        } else while (i < n && !blank(lines[i])) { body.push(lines[i]); i++; }
        const attrs = modifiers(mod);
        if (/^h[1-6]$/.test(tag)) out.push(p(this.inline(body.join(' ')), { ...attrs, style: headingStyle(parseInt(tag[1], 10)) }));
        else if (tag === 'bq') for (const para of splitParas(body)) out.push(p(this.inline(para.join(' ')), { ...attrs, style: 'Quote' }));
        else if (tag === 'bc' || tag === 'pre') {
          const code = body.join('\n').replace(/\s+$/, '');
          const lang = /\(([\w+-]+)\)/.exec(mod)?.[1] || null;
          out.push(S.code_block.create({ language: lang }, code ? schema.text(code) : null));
        } else if (tag === 'notextile' || tag === '###') { /* raw / comment */ }
        else if (/^fn\d+$/.test(tag)) { /* collected as a footnote */ }
        else for (const para of splitParas(body)) out.push(p(this.inline(para.join(' ')), attrs));
        continue;
      }
      // Lists.
      if (/^([*#]+)(\([^)]*\))?\s+/.test(l)) {
        const items: FlatListItem[] = [];
        while (i < n && /^([*#;:]+)/.test(lines[i]) && !blank(lines[i])) {
          const lm = /^([*#]+)(\([^)]*\)|\{[^}]*\})?\s+(.*)$/.exec(lines[i]);
          if (!lm) break;
          let t = lm[3];
          i++;
          while (i < n && !blank(lines[i]) && !/^[*#]+\s/.test(lines[i]) && !/^\|/.test(lines[i])) { t += ' ' + lines[i].trim(); i++; }
          const ordered = lm[1].endsWith('#');
          items.push({ level: lm[1].length - 1, ordered, format: ordered ? 'decimal' : 'disc', start: 1, blocks: [p(this.inline(t))] });
        }
        out.push(...buildNestedLists(items));
        continue;
      }
      // Tables.
      if (/^(table(\S*)\.\s*$|\|)/.test(l)) {
        const start = i;
        if (/^table/.test(l)) i++;
        const rows: CellSpec[][] = [];
        let headerRows = 0;
        while (i < n && /^(\|.*\|\s*|\S*\.\s*\|.*)$/.test(lines[i])) {
          const row = lines[i].replace(/^[^|]*\.\s*/, '').trim().replace(/^\|/, '').replace(/\|$/, '');
          const cells = row.split('|');
          const spec: CellSpec[] = cells.map((c) => {
            const cm = /^((?:_|\\\d+|\/\d+|<>|<|>|=|\^|~|\{[^}]*\}|\([^)]*\))*)\.\s?(.*)$/.exec(c);
            const mods = cm ? cm[1] : '';
            const text = cm ? cm[2] : c;
            return {
              blocks: [p(this.inline(text.trim()), modifiers(mods.replace(/[_\\/]\d*/g, '')))],
              header: mods.includes('_'), colspan: parseInt(/\\(\d+)/.exec(mods)?.[1] || '1', 10), rowspan: parseInt(/\/(\d+)/.exec(mods)?.[1] || '1', 10),
            };
          });
          if (spec.every((c) => c.header) && rows.length === headerRows) headerRows++;
          rows.push(spec);
          i++;
        }
        if (i > start) {
          const t = makeTable(rows, { headerRows });
          if (t) out.push(t);
          continue;
        }
        // A "|" line that isn't a table row: read it as a paragraph.
      }
      // Raw HTML: list/table/pre blocks go through the HTML importer; lone wrapper tags are dropped.
      if (/^\s*<(\/?)[a-zA-Z]/.test(l)) {
        const open = /^\s*<(ol|ul|dl|table|pre|blockquote|p|h[1-6])\b/i.exec(l);
        if (open) {
          const tag = open[1].toLowerCase();
          const html: string[] = [];
          let depth = 0;
          while (i < n) {
            const line = lines[i];
            html.push(line);
            depth += (line.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length - (line.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
            i++;
            if (depth <= 0) break;
          }
          const src = html.join('\n').replace(/<span class="math">([\s\S]*?)<\/span>/g, (_x, tex) => `<span class="qf-math-inline" data-latex="${tex.replace(/"/g, '&quot;')}"></span>`);
          out.push(...htmlToBlocks(src));
          continue;
        }
        if (/^\s*<hr\b/i.test(l)) { out.push(S.horizontal_rule.create()); i++; continue; }
        if (/^\s*<\/?[a-zA-Z][^>]*>\s*$/.test(l)) { i++; continue; }
      }
      // Plain paragraph.
      const body: string[] = [];
      while (i < n && !blank(lines[i])) { body.push(lines[i]); i++; }
      const inl: PMNode[] = [];
      body.forEach((b, k) => { if (k) inl.push(S.hard_break.create()); inl.push(...this.inline(b)); });
      // A paragraph that is only an equation is a display equation.
      if (inl.length === 1 && inl[0].type === S.math_inline) out.push(S.math_block.create({ latex: inl[0].attrs.latex }));
      else out.push(p(inl));
    }
    return finishDoc(out, this.settings);
  }
}

function splitParas(lines: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) { if (blank(l)) { if (cur.length) out.push(cur); cur = []; } else cur.push(l); }
  if (cur.length) out.push(cur);
  return out;
}

export function textileToDoc(text: string): PMNode {
  return new TextileReader(toLines(text)).read();
}

export async function importTextile(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  return textileToDoc(decodeTextBytes(data).replace(/^\ufeff/, ''));
}
