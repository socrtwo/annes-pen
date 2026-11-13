/**
 * troff / nroff manual page import (man and basic mdoc macros; .1–.9, .man, .roff).
 *
 * Mapped: .TH (title line → Title, header/footer text), .SH/.SS (and mdoc .Sh/.Ss) → headings,
 * .PP/.LP/.P/.Pp paragraphs, .TP/.IP/.HP tagged and indented paragraphs (bullet tags → lists),
 * .RS/.RE nesting, .nf/.fi, .EX/.EE and mdoc .Bd/.Ed/.Dl → code blocks, .br/.sp, .ce centering,
 * font macros (.B .I .R .BI .BR .IB .IR .RB .RI .SM .SB) and escapes (\fB \fI \fR \fP \f(CW
 * \f[…]), special characters (\(em \(bu \(lq \[rq] …), .UR/.UE and .MT/.ME links, mdoc
 * .Nm .Nd .Fl .Ar .Op .Xr .Em .Sy .Li .Bl/.It/.El lists, and tbl tables (.TS/.TE).
 * Not mapped: arbitrary troff programming (registers, conditionals, macro definitions).
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { gunzip } from './archive';
import { headingStyle, InlineBuf, makeTable, type CellSpec } from './runs';
import { buildNestedLists, decodeTextBytes, finishDoc, newSettings, type FlatListItem } from './serialize';
import { MK, S, p } from './lightmarkup';

const CHARS: Record<string, string> = {
  em: '—', en: '–', bu: '•', lq: '“', rq: '”', oq: '‘', cq: '’', aq: "'", dq: '"', co: '©', rg: '®', tm: '™', hy: '-', mi: '−', pl: '+',
  mu: '×', di: '÷', '<=': '≤', '>=': '≥', '!=': '≠', '->': '→', '<-': '←', de: '°', ga: '`', aa: '´', ti: '~', ha: '^', sl: '/', rs: '\\', ba: '|',
  sc: '§', ps: '¶', dg: '†', dd: '‡', Fo: '«', Fc: '»', fo: '‹', fc: '›', ct: '¢', Po: '£', Ye: '¥', Eu: '€', eu: '€', sq: '□', ci: '○', 'u2014': '—',
  ff: 'ff', fi: 'fi', fl: 'fl', '12': '½', '14': '¼', '34': '¾', '+-': '±', '**': '∗', ua: '↑', da: '↓', OK: '✓', 'em-dash': '—',
};
const FONT_MACROS = /^(B|I|R|BI|BR|IB|IR|RB|RI|SB|SM|CW|CR|CB|CI)$/;

interface Line { req: string | null; args: string[]; text: string; raw: string }

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      let j = i + 1, v = '';
      while (j < s.length && !(s[j] === '"' && s[j + 1] !== '"')) { if (s[j] === '"' && s[j + 1] === '"') { v += '"'; j += 2; continue; } v += s[j]; j++; }
      out.push(v);
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ' ' && s[j] !== '\t') { if (s[j] === '\\') j++; j++; }
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

class ManReader {
  settings = newSettings();
  out: PMNode[] = [];
  buf = new InlineBuf();
  font: 'R' | 'B' | 'I' | 'C' | 'BI' = 'R';
  prevFont: 'R' | 'B' | 'I' | 'C' | 'BI' = 'R';
  indent = 0;
  pendingTag: PMNode[] | null = null;
  listRun: FlatListItem[] = [];
  paraAttrs: Record<string, any> = {};
  link: string | null = null;
  fill = true;
  code: string[] = [];

  fontMarks(f = this.font): Mark[] {
    const m: Mark[] = [];
    if (f === 'B' || f === 'BI') m.push(MK.bold.create());
    if (f === 'I' || f === 'BI') m.push(MK.italic.create());
    if (f === 'C') m.push(MK.code.create());
    if (this.link) m.push(MK.link.create({ href: this.link }));
    return m;
  }

  /** Append text with troff escapes to the current paragraph. */
  text(s: string, forceFont?: 'R' | 'B' | 'I' | 'C' | 'BI'): void {
    const saved = this.font;
    if (forceFont) this.font = forceFont;
    let plain = '';
    const flush = () => { if (plain) this.buf.text(plain, this.fontMarks()); plain = ''; };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') { plain += c; continue; }
      const n = s[i + 1];
      i++;
      if (n === undefined) break;
      switch (n) {
        case 'f': {
          let f = s[i + 1] || 'R';
          if (f === '(') { f = s.slice(i + 2, i + 4); i += 3; }
          else if (f === '[') { const e = s.indexOf(']', i + 2); f = s.slice(i + 2, e < 0 ? undefined : e) || 'P'; i = e < 0 ? s.length : e; }
          else i += 1;
          flush();
          const next = f === 'P' || f === '' ? this.prevFont : /^(B|3)$/.test(f) ? 'B' : /^(I|2)$/.test(f) ? 'I' : /^(BI|4)$/.test(f) ? 'BI' : /^(CW|C|CR|CB|CI|tt|V|VB|VI|VBI)$/.test(f) ? 'C' : 'R';
          this.prevFont = this.font;
          this.font = next;
          break;
        }
        case '(': plain += CHARS[s.slice(i + 1, i + 3)] ?? ''; i += 2; break;
        case '[': { const e = s.indexOf(']', i + 1); const name = s.slice(i + 1, e < 0 ? undefined : e); plain += CHARS[name] ?? (/^u[0-9A-F]{4,5}$/i.test(name) ? String.fromCodePoint(parseInt(name.slice(1), 16)) : ''); i = e < 0 ? s.length : e; break; }
        case '*': { let name = s[i + 1]; if (name === '(') { name = s.slice(i + 2, i + 4); i += 3; } else if (name === '[') { const e = s.indexOf(']', i + 2); name = s.slice(i + 2, e); i = e; } else i += 1; plain += name === 'lq' ? '“' : name === 'rq' ? '”' : name === 'R' ? '®' : name === 'Tm' ? '™' : ''; break; }
        case '-': plain += '-'; break;
        case 'e': case '\\': plain += '\\'; break;
        case '&': case '|': case '^': case ')': case '%': case ':': case 'c': case 'd': case 'u': case 'r': break;
        case ' ': case '~': case '0': plain += '\u00a0'; break;
        case 't': plain += '\t'; break;
        case '"': i = s.length; break;
        case "'": plain += '´'; break;
        case '`': plain += '`'; break;
        case '.': plain += '.'; break;
        case 's': { while (/[-+\d(]/.test(s[i + 1] || '')) i++; break; }
        case 'h': case 'v': case 'w': case 'o': case 'l': case 'L': case 'D': case 'X': case 'Z': case 'k': case 'n': case 'g': case 'm': case 'M': case 'A': case 'B': case 'b': case 'x': case 'z': case 'N': {
          if (s[i + 1] === "'" || s[i + 1] === '[') { const close = s[i + 1] === '[' ? ']' : "'"; const e = s.indexOf(close, i + 2); i = e < 0 ? s.length : e; }
          else if (s[i + 1] === '(') i += 3; else i += 1;
          break;
        }
        default: plain += n;
      }
    }
    flush();
    if (forceFont) this.font = saved;
  }

  endPara(): void {
    const content = this.buf.take();
    // Drop trailing spaces.
    const last = content[content.length - 1];
    if (last?.isText && /\s$/.test(last.text!)) { const t = last.text!.replace(/\s+$/, ''); if (t) content[content.length - 1] = schema.text(t, last.marks); else content.pop(); }
    if (this.pendingTag) {
      const tag = this.pendingTag;
      this.pendingTag = null;
      const tagText = tag.map((n) => n.textContent).join('').trim();
      if (/^[•·*\-o]$/.test(tagText)) { this.listRun.push({ level: Math.max(0, this.indent), ordered: false, format: 'disc', start: 1, blocks: [p(content)] }); return; }
      const om = /^\(?(\d+|[a-zA-Z]|[ivxIVX]+)[.)]$/.exec(tagText);
      if (om) {
        const v = om[1];
        const format = /^\d+$/.test(v) ? 'decimal' : /^[ivx]{2,}$/.test(v) ? 'lower-roman' : /^[IVX]{2,}$/.test(v) ? 'upper-roman' : /^[a-z]$/.test(v) ? 'lower-alpha' : 'upper-alpha';
        const start = /^\d+$/.test(v) ? parseInt(v, 10) : /^[a-zA-Z]$/.test(v) ? v.toLowerCase().charCodeAt(0) - 96 : 1;
        this.listRun.push({ level: Math.max(0, this.indent), ordered: true, format, start, blocks: [p(content)] });
        return;
      }
      this.flushList();
      if (tag.length) this.out.push(p(tag, { keepNext: true, indentLeft: this.indent * 36 || null }));
      if (content.length) this.out.push(p(content, { indentLeft: (this.indent + 1) * 36 }));
      return;
    }
    if (!content.length) return;
    this.flushList();
    this.out.push(p(content, { ...this.paraAttrs, indentLeft: this.indent ? this.indent * 36 : this.paraAttrs.indentLeft ?? null }));
    this.paraAttrs = {};
  }

  flushList(): void {
    if (this.listRun.length) { this.out.push(...buildNestedLists(this.listRun)); this.listRun = []; }
  }

  flushCode(): void {
    if (!this.code.length) return;
    this.flushList();
    this.out.push(S.code_block.create(null, schema.text(this.code.join('\n').replace(/^\n+/, '').replace(/\s+$/, '') || ' ')));
    this.code = [];
  }

  /** Text of a code line: escapes resolved, fonts dropped. */
  plainLine(s: string): string {
    const saved = this.buf;
    this.buf = new InlineBuf();
    this.text(s);
    const t = this.buf.take().map((n) => n.textContent).join('');
    this.buf = saved;
    return t;
  }

  read(src: string): PMNode {
    const rawLines = src.replace(/\r\n?/g, '\n').split('\n');
    // Join continuation lines ending with a lone backslash.
    const lines: Line[] = [];
    for (let k = 0; k < rawLines.length; k++) {
      let l = rawLines[k];
      while (/(^|[^\\])\\$/.test(l) && k + 1 < rawLines.length) l = l.slice(0, -1) + rawLines[++k];
      const m = /^[.'](\s*)([A-Za-z0-9_\\"]+)\s*(.*)$/.exec(l);
      if (m && !m[2].startsWith('\\"')) lines.push({ req: m[2], args: splitArgs(m[3]), text: m[3], raw: l });
      else if (/^[.']\s*\\"/.test(l) || /^\\"/.test(l) || /^[.']\s*$/.test(l)) continue;
      else lines.push({ req: null, args: [], text: l, raw: l });
    }
    for (let k = 0; k < lines.length; k++) {
      const ln = lines[k];
      if (!this.fill && ln.req !== 'fi' && ln.req !== 'EE' && ln.req !== 'Ed') {
        if (ln.req === 'br' || ln.req === 'sp') { this.code.push(''); continue; }
        if (ln.req && FONT_MACROS.test(ln.req)) { this.code.push(this.plainLine(ln.args.join(' '))); continue; }
        if (ln.req) continue;
        this.code.push(this.plainLine(ln.text));
        continue;
      }
      if (!ln.req) {
        if (!ln.text.trim()) { this.endPara(); continue; }
        this.text(ln.text.replace(/^\s+/, '') + ' ');
        continue;
      }
      const a = ln.args;
      switch (ln.req) {
        case 'TH': case 'Dt': {
          const title = `${a[0] || ''}${a[1] ? `(${a[1]})` : ''}`;
          this.settings.properties.title = title;
          if (title) this.out.push(p([schema.text(title)], { style: 'Title' }));
          this.settings.header = { left: title, center: a[4] || '', right: title };
          this.settings.footer = { left: a[3] || '', center: a[2] || '', right: '{PAGE}' };
          break;
        }
        case 'SH': case 'SS': case 'Sh': case 'Ss': {
          this.endPara(); this.flushList(); this.indent = 0;
          let t = a.join(' ');
          if (!t && k + 1 < lines.length && !lines[k + 1].req) { t = lines[++k].text; }
          t = t.replace(/\\(.)/g, (_m, c) => (c === '-' ? '-' : ''));
          if (t) this.out.push(p([schema.text(t)], { style: headingStyle(ln.req.toUpperCase() === 'SH' ? 1 : 2) }));
          break;
        }
        case 'PP': case 'LP': case 'P': case 'Pp': this.endPara(); this.flushList(); break;
        case 'br': if (!this.buf.empty) this.buf.node(S.hard_break.create()); break;
        case 'sp': this.endPara(); break;
        case 'TP': case 'TQ': {
          this.endPara();
          // The next line is the tag.
          const tagLine = lines[k + 1];
          if (tagLine) {
            k++;
            const saved = this.buf;
            this.buf = new InlineBuf();
            if (tagLine.req && FONT_MACROS.test(tagLine.req)) this.fontMacro(tagLine.req, tagLine.args);
            else this.text(tagLine.text);
            this.pendingTag = this.buf.take();
            this.buf = saved;
          } else this.pendingTag = [];
          break;
        }
        case 'IP': case 'HP': {
          this.endPara();
          const saved = this.buf;
          this.buf = new InlineBuf();
          if (a[0]) this.text(a[0]);
          this.pendingTag = this.buf.take();
          this.buf = saved;
          if (ln.req === 'HP') this.pendingTag = null;
          break;
        }
        case 'RS': this.endPara(); this.indent++; break;
        case 'RE': this.endPara(); this.indent = Math.max(0, this.indent - 1); break;
        case 'nf': case 'EX': case 'Bd': this.endPara(); this.fill = false; break;
        case 'fi': case 'EE': case 'Ed': this.fill = true; this.flushCode(); break;
        case 'Dl': this.endPara(); this.code.push(this.plainLine(a.join(' '))); this.flushCode(); break;
        case 'ce': this.endPara(); this.paraAttrs = { align: 'center' }; break;
        case 'UR': this.link = a[0] || null; break;
        case 'UE': this.link = null; if (a[0]) this.text(a[0]); break;
        case 'MT': this.link = a[0] ? 'mailto:' + a[0] : null; break;
        case 'ME': this.link = null; break;
        case 'TS': {
          this.endPara(); this.flushList();
          let e = k + 1;
          while (e < lines.length && lines[e].req !== 'TE') e++;
          this.table(lines.slice(k + 1, e).map((x) => x.raw));
          k = e;
          break;
        }
        // mdoc: macros on the line (and nested in their arguments).
        case 'Nm': case 'Nd': case 'Fl': case 'Ar': case 'Va': case 'Em': case 'Pa': case 'Sy': case 'Cm': case 'Ic': case 'Li': case 'Ql': case 'Op': case 'Xr':
        case 'Dq': case 'Sq': case 'Pq': case 'Ev': case 'Dv': case 'Er': case 'Fn': case 'Fa': case 'Ft': case 'No': case 'Ns': case 'Aq': case 'Bq':
          this.mdoc([ln.req, ...a]);
          this.text(' ');
          break;
        case 'Bl': this.endPara(); this.indent++; break;
        case 'El': this.endPara(); this.indent = Math.max(0, this.indent - 1); break;
        case 'It': {
          this.endPara();
          const saved = this.buf;
          this.buf = new InlineBuf();
          if (a.length) this.mdoc(a);
          this.pendingTag = this.buf.take();
          if (!this.pendingTag.length) this.pendingTag = [schema.text('•')];
          this.buf = saved;
          break;
        }
        case 'Dd': case 'Os': case 'ad': case 'na': case 'hy': case 'nh': case 'll': case 'in': case 'ti': case 'ft': case 'ps': case 'vs': case 'ne': case 'so': case 'ds': case 'de': case 'ie': case 'el': case 'if': case 'nr': case 'tr': case 'cs': case 'ss': case 'PD': case 'IX': case 'DT': case 'UC': case 'AT': case 'mso': case 'hw': case 'ns': case 'rs': case 'bp':
          if (ln.req === 'bp') { this.endPara(); this.out.push(S.page_break.create()); }
          break;
        default:
          if (FONT_MACROS.test(ln.req)) this.fontMacro(ln.req, a);
          else if (/^[A-Z][a-z]$/.test(ln.req)) this.text(a.join(' ') + ' '); // other mdoc macros: keep arguments
      }
    }
    this.endPara();
    this.flushCode();
    this.flushList();
    return finishDoc(this.out, this.settings);
  }

  /** Render mdoc macro calls: each macro name consumes the arguments up to the next macro name. */
  private mdoc(args: string[]): void {
    const MACROS = /^(Nm|Nd|Fl|Ar|Va|Em|Pa|Sy|Cm|Ic|Li|Ql|Op|Xr|Dq|Sq|Pq|Ev|Dv|Er|Fn|Fa|Ft|No|Ns|Aq|Bq)$/;
    let i = 0;
    let first = true;
    const sep = () => { if (!first) this.text(' '); first = false; };
    while (i < args.length) {
      const m = args[i];
      if (!MACROS.test(m)) { sep(); this.text(m); i++; continue; }
      let j = i + 1;
      while (j < args.length && !MACROS.test(args[j])) j++;
      const own = args.slice(i + 1, j);
      const rest = (k: number) => args.slice(k);
      switch (m) {
        case 'Ns': first = true; break;
        case 'Fl': sep(); this.text('-' + own.join(' '), 'B'); break;
        case 'Nm': sep(); this.text(own.join(' ') || this.settings.properties.title.replace(/\(.*$/, ''), 'B'); break;
        case 'Nd': sep(); this.text('— ' + own.join(' ')); break;
        case 'Ar': case 'Va': case 'Em': case 'Pa': case 'Fa': case 'Ft': sep(); this.text(own.join(' ') || 'file ...', 'I'); break;
        case 'Sy': case 'Cm': case 'Ic': case 'Ev': case 'Dv': case 'Er': case 'Fn': sep(); this.text(own.join(' '), 'B'); break;
        case 'Li': case 'Ql': sep(); this.text(own.join(' '), 'C'); break;
        case 'Xr': sep(); this.text(`${own[0] || ''}(${own[1] || ''})`, 'B'); if (own.length > 2) this.text(own.slice(2).join('')); break;
        case 'Op': case 'Dq': case 'Sq': case 'Pq': case 'Aq': case 'Bq': {
          // Enclosures wrap everything after them on the line.
          const [o, c] = m === 'Op' || m === 'Bq' ? ['[', ']'] : m === 'Dq' ? ['“', '”'] : m === 'Sq' ? ['‘', '’'] : m === 'Aq' ? ['<', '>'] : ['(', ')'];
          sep(); this.text(o); this.mdoc(rest(i + 1)); this.text(c);
          return;
        }
        default: sep(); this.text(own.join(' '));
      }
      i = j;
    }
  }

  private fontMacro(req: string, a: string[]): void {
    const fonts = req === 'SM' ? ['R'] : req === 'SB' ? ['B'] : req.split('').map((c) => (c === 'B' ? 'B' : c === 'I' ? 'I' : c === 'C' ? 'C' : 'R'));
    if (/^C/.test(req)) { this.text(a.join(' ') + ' ', 'C'); return; }
    if (fonts.length === 1) { this.text(a.join(' ') + ' ', fonts[0] as 'R' | 'B' | 'I'); return; }
    a.forEach((arg, idx) => this.text(arg, fonts[idx % 2] as 'R' | 'B' | 'I'));
    this.text(' ');
  }

  private table(rows: string[]): void {
    // tbl: options line ending in ';', format lines ending in '.', then data with tab separators.
    let i = 0;
    let tab = '\t';
    if (rows[i] && /;\s*$/.test(rows[i])) { const tm = /tab\s*\((.)\)/.exec(rows[i]); if (tm) tab = tm[1]; i++; }
    while (i < rows.length && !/\.\s*$/.test(rows[i])) i++;
    i++;
    const out: CellSpec[][] = [];
    // Data lines; "T{ … T}" text blocks may span lines.
    const data: string[] = [];
    for (; i < rows.length; i++) {
      let r = rows[i];
      while (/T\{\s*$/.test(r) || (r.lastIndexOf('T{') > r.lastIndexOf('T}'))) {
        if (i + 1 >= rows.length) break;
        const next = rows[++i];
        r += (/T\{\s*$/.test(r) ? '' : ' ') + (/^T\}/.test(next) ? next : next.replace(/^\./, ''));
      }
      data.push(r);
    }
    for (const r of data) {
      if (/^[.']/.test(r) || /^[_=]\s*$/.test(r)) continue;
      out.push(r.split(tab).map((c) => { const saved = this.buf; this.buf = new InlineBuf(); this.text(c.replace(/T\{|T\}/g, '').trim()); const inl = this.buf.take(); this.buf = saved; return { blocks: [p(inl)] }; }));
    }
    const t = makeTable(out, { headerRows: 0 });
    if (t) this.out.push(t);
  }
}

export function troffToDoc(src: string): PMNode {
  return new ManReader().read(src);
}

export async function importTroff(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const u8 = new Uint8Array(data);
  return troffToDoc(decodeTextBytes(u8[0] === 0x1f && u8[1] === 0x8b ? gunzip(u8) : u8));
}
