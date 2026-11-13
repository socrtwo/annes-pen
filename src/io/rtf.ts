/**
 * Rich Text Format (RTF 1.9) import / export.
 *
 * Export writes a font table, color table, style sheet (headings carry \outlinelevel), Word 97+
 * list tables (\listtable/\ls/\ilvl with \listtext fallbacks), tables (\trowd … \row with
 * horizontal/vertical merges), PNG/JPEG pictures, footnotes/endnotes, HYPERLINK and other fields,
 * bookmarks, page setup and headers/footers.
 *
 * Import is a real tokenizer + group/destination state machine: font/color/style/list tables,
 * \pard/\plain resets, character and paragraph properties, Unicode (\uN with \ucN skipping) and
 * code-page text (\'hh with \ansicpg and per-font \fcharset), tables, pictures, fields, footnotes,
 * headers/footers, bookmarks, old-style (\pn/\pntext) and new-style lists, section and page breaks.
 * It never throws: malformed input produces whatever could be recovered.
 */
import { Mark, type Node as PMNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { styleLevel } from '../editor/schema';
import { PAGE_SIZES, type DocSettings, type HF } from '../editor/settings';
import { resolveStyles, effectiveStyle, genericFor } from '../editor/styles';
import { formatNumber } from '../editor/plugins/decorations';
import type { StyleDef } from '../editor/settings';
import type { ExportOptions } from './index';
import {
  S, buildNestedLists, bytesToHex, canonicalStyleName, collectFootnotes, docSettings, docTitle, finishDoc, hexToBytes, htmlToTextLines,
  imagePixelSize, inlineAtomText, listStart, makeBlob, markSet, markerFormat, romanValue, newSettings, para, parseDataUrl, prepareDoc, resolveFontName,
  sniffImageMime, toDataUrl, toHexColor, normalizeImportedFormatting, type FlatListItem, type NoteInfo,
} from './serialize';

type Attrs = Record<string, any>;

// =============================================================================================
// Export

const tw = (pt: number | null | undefined) => Math.round((pt || 0) * 20);

/** Escape text for RTF: control characters, braces, backslashes and non-ASCII (\uN?). */
export function rtfEscape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (ch === '\t') out += '\\tab ';
    else if (ch === '\n') out += '\\line ';
    else if (c === 0xa0) out += '\\~';
    else if (c === 0xad) out += '\\-';
    else if (c === 0x2011) out += '\\_';
    else if (c < 0x20) continue;
    else if (c < 0x80) out += ch;
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return out;
}

const UL_CODES: Record<string, string> = {
  single: '\\ul', double: '\\uldb', dotted: '\\uld', dashed: '\\uldash', wavy: '\\ulwave', thick: '\\ulth', words: '\\ulw',
  dotDash: '\\uldashd', dotDotDash: '\\uldashdd',
};

const NFC: Record<string, number> = { decimal: 0, 'upper-roman': 1, 'lower-roman': 2, 'upper-alpha': 3, 'lower-alpha': 4, 'decimal-zero': 22 };

const LANG_IDS: Record<string, number> = {
  'en-us': 1033, 'en-gb': 2057, 'en-au': 3081, 'en-ca': 4105, 'de-de': 1031, 'fr-fr': 1036, 'es-es': 3082, 'it-it': 1040,
  'nl-nl': 1043, 'pt-br': 1046, 'pt-pt': 2070, 'ru-ru': 1049, 'ja-jp': 1041, 'zh-cn': 2052, 'zh-tw': 1028, 'ko-kr': 1042,
  'pl-pl': 1045, 'sv-se': 1053, 'da-dk': 1030, 'fi-fi': 1035, 'nb-no': 1044, 'cs-cz': 1029, 'tr-tr': 1055, 'el-gr': 1032,
  'he-il': 1037, 'ar-sa': 1025, 'hu-hu': 1038, 'uk-ua': 1058,
};

interface ListLevelDef { kind: 'bullet' | 'ordered' | 'task'; format: string; start: number; bullet: string; suffix: string }

function bulletChar(b: string | null | undefined): string {
  switch (b) {
    case 'circle': return '◦';
    case 'square': return '▪';
    case 'none': return '';
    case 'disc': case null: case undefined: case '': return '•';
    default: return b.length <= 2 ? b : b[0];
  }
}

function fieldInstruction(a: Attrs): string {
  const type = String(a.type || '').toUpperCase();
  const arg = a.arg ? String(a.arg) : '';
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
  const numFmt: Record<string, string> = { roman: 'roman', ROMAN: 'ROMAN', alphabetic: 'alphabetic', ALPHABETIC: 'ALPHABETIC', Ordinal: 'Ordinal', Arabic: 'Arabic' };
  let inst = type;
  if (type === '=') return `= ${arg}${a.format ? ` \\# "${a.format}"` : ''}`;
  if (arg) inst += ' ' + (type === 'QUOTE' || type === 'FILLIN' || type === 'STYLEREF' ? `"${arg.replace(/"/g, '')}"` : q(arg));
  if (a.format) {
    if (/DATE|TIME/.test(type)) inst += ` \\@ "${a.format}"`;
    else if (numFmt[a.format]) inst += ` \\* ${numFmt[a.format]}`;
  }
  if (type === 'REF') inst += ' \\h';
  return inst;
}

/** The number in a list marker such as "3.", "iv)" or "1.2.c" (its last part), read in the level's format. */
function markerNumber(marker: string, format: string): number | null {
  const parts = marker.replace(/\t/g, '').trim().match(/[0-9]+|[a-zA-Z]+/g);
  if (!parts) return null;
  const t = parts[parts.length - 1];
  if (format === 'decimal' || format === 'decimal-zero') return /^\d+$/.test(t) ? parseInt(t, 10) : null;
  if (format === 'lower-alpha' || format === 'upper-alpha') {
    // a..z, then aa, bb, ... (Word repeats the letter).
    if (!/^([a-zA-Z])\1*$/.test(t)) return null;
    return (t.toLowerCase().charCodeAt(0) - 96) + 26 * (t.length - 1);
  }
  if (format === 'lower-roman' || format === 'upper-roman') {
    return /^[ivxlcdm]+$/i.test(t) ? romanValue(t) : null;
  }
  return null;
}

/** A quoted field-instruction argument: backslashes and quotes are escaped with a backslash. */
function fieldQuote(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

/** Read a quoted field-instruction argument at the start of `s` (see fieldQuote). */
function fieldUnquote(s: string): { value: string; rest: string } | null {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  if (!m) return null;
  return { value: m[1].replace(/\\([\\"])/g, '$1'), rest: s.slice(m[0].length) };
}

class RtfWriter {
  settings: DocSettings;
  styles: Record<string, StyleDef>;
  fontIds = new Map<string, number>();
  fonts: string[] = [];
  colorIds = new Map<string, number>();
  colors: string[] = [];
  styleNums = new Map<string, number>();
  nextStyle = 10;
  notes: Map<PMNode, NoteInfo>;
  listDefs: string[] = [];
  listOverrides: string[] = [];
  nextList = 1;
  contentWidthTw: number;

  constructor(doc: PMNode, notes: NoteInfo[]) {
    this.settings = docSettings(doc);
    this.styles = resolveStyles(this.settings);
    this.notes = new Map(notes.map((n) => [n.node, n]));
    this.font(resolveFontName('+body', this.settings) || 'Calibri');
    this.font(resolveFontName('+heading', this.settings) || 'Calibri');
    this.styleNums.set('Normal', 0);
    for (let i = 1; i <= 9; i++) this.styleNums.set(`Heading ${i}`, i);
    const p = this.settings.page;
    const w = p.orientation === 'landscape' ? Math.max(p.width, p.height) : Math.min(p.width, p.height);
    this.contentWidthTw = tw(Math.max(72, w - p.margin.left - p.margin.right - (p.gutter || 0)));
  }

  font(name: string): number {
    const n = name.trim() || 'Calibri';
    let id = this.fontIds.get(n.toLowerCase());
    if (id == null) { id = this.fonts.length; this.fonts.push(n); this.fontIds.set(n.toLowerCase(), id); }
    return id;
  }

  color(c: string | null | undefined): number {
    const hex = toHexColor(c, this.settings);
    if (!hex) return 0;
    let id = this.colorIds.get(hex);
    if (id == null) { this.colors.push(hex); id = this.colors.length; this.colorIds.set(hex, id); }
    return id;
  }

  styleNum(name: string): number {
    let n = this.styleNums.get(name);
    if (n == null) { n = this.nextStyle++; this.styleNums.set(name, n); }
    return n;
  }

  eff(styleName: string): StyleDef {
    return effectiveStyle(this.styles, this.styles[styleName] ? styleName : 'Normal');
  }

  charStyleCodes(e: StyleDef): string {
    let s = '';
    const f = resolveFontName(e.font, this.settings);
    if (f) s += `\\f${this.font(f)}`;
    s += `\\fs${Math.round((e.size || 11) * 2)}`;
    if (e.bold) s += '\\b';
    if (e.italic) s += '\\i';
    if (e.underline) s += '\\ul';
    if (e.caps) s += '\\caps';
    if (e.smallCaps) s += '\\scaps';
    if (e.spacing) s += `\\expndtw${tw(e.spacing)}`;
    const c = this.color(e.color);
    if (c) s += `\\cf${c}`;
    return s;
  }

  lineSpacing(v: string | null | undefined): string {
    if (!v) return '';
    if (/^\d+(\.\d+)?$/.test(v)) return `\\sl${Math.round(parseFloat(v) * 240)}\\slmult1`;
    if (v.startsWith('atleast:')) return `\\sl${tw(parseFloat(v.slice(8)))}\\slmult0`;
    const pt = parseFloat(v);
    if (Number.isFinite(pt)) return `\\sl-${tw(pt)}\\slmult0`;
    return '';
  }

  paraStyleCodes(e: StyleDef, a: Attrs = {}): string {
    let s = '';
    const align = a.align ?? e.align;
    s += ({ left: '\\ql', center: '\\qc', right: '\\qr', justify: '\\qj', distribute: '\\qd' } as Record<string, string>)[align] || '\\ql';
    const li = a.indentLeft ?? e.indentLeft, ri = a.indentRight ?? e.indentRight, fi = a.indentFirst ?? e.indentFirst;
    if (li) s += `\\li${tw(li)}`;
    if (ri) s += `\\ri${tw(ri)}`;
    if (fi) s += `\\fi${tw(fi)}`;
    s += `\\sb${tw(a.spaceBefore ?? e.spaceBefore ?? 0)}\\sa${tw(a.spaceAfter ?? e.spaceAfter ?? 0)}`;
    s += this.lineSpacing(a.lineHeight ?? e.lineHeight);
    if (a.keepNext || e.keepNext) s += '\\keepn';
    if (a.keepLines || e.keepLines) s += '\\keep';
    if (a.pageBreakBefore || e.pageBreakBefore) s += '\\pagebb';
    const lvl = styleLevel(e.name, a.outlineLevel ?? e.outlineLevel);
    if (lvl > 0) s += `\\outlinelevel${lvl - 1}`;
    const bg = a.bg ?? (e as any).bg;
    const bgc = this.color(bg);
    if (bgc) s += `\\cbpat${bgc}`;
    const borderB = e.borderBottom, borderT = e.borderTop;
    const bcode = (side: string, v: string | undefined) => {
      if (!v) return '';
      const m = /(#[0-9a-f]{3,8}|rgb\([^)]*\)|var\([^)]*\)|[a-z]+)\s*$/i.exec(v.trim());
      const c = m ? this.color(m[1]) : 0;
      return `\\brdr${side}\\brdrs\\brdrw10\\brsp20${c ? `\\brdrcf${c}` : ''}`;
    };
    s += bcode('b', borderB) + bcode('t', borderT);
    return s;
  }

  paraStart(node: PMNode | null, opts: { intbl?: boolean; extra?: string } = {}): string {
    const a = node ? node.attrs : {};
    const styleName = (a.style as string) || 'Normal';
    const e = this.eff(styleName);
    let s = '\\pard\\plain';
    if (opts.intbl) s += '\\intbl';
    s += `\\s${this.styleNum(styleName)}`;
    if (a.dir === 'rtl') s += '\\rtlpar';
    s += this.paraStyleCodes(e, a);
    if (opts.extra) s += opts.extra;
    s += this.charStyleCodes(e);
    return s + ' ';
  }

  markCodes(marks: readonly Mark[]): string {
    let s = '';
    for (const m of marks) {
      const a = m.attrs;
      switch (m.type.name) {
        case 'bold': s += '\\b'; break;
        case 'italic': s += '\\i'; break;
        case 'underline': s += UL_CODES[a.style] || '\\ul'; if (a.color) { const c = this.color(a.color); if (c) s += `\\ulc${c}`; } break;
        case 'strike': s += '\\strike'; break;
        case 'dstrike': s += '\\striked1'; break;
        case 'sup': s += '\\super'; break;
        case 'sub': s += '\\sub'; break;
        case 'smallcaps': s += '\\scaps'; break;
        case 'allcaps': s += '\\caps'; break;
        case 'hidden': s += '\\v'; break;
        case 'code': s += `\\f${this.font('Courier New')}`; break;
        case 'font': s += `\\f${this.font(String(a.family || 'Calibri'))}`; break;
        case 'size': s += `\\fs${Math.max(2, Math.round(Number(a.pt) * 2))}`; break;
        case 'color': { const c = this.color(a.color); if (c) s += `\\cf${c}`; break; }
        case 'highlight': { const c = this.color(a.color || '#ffff00'); if (c) s += `\\highlight${c}`; break; }
        case 'shading': { const c = this.color(a.color); if (c) s += `\\chcbpat${c}`; break; }
        case 'spacing': s += `\\expndtw${tw(Number(a.pt))}\\expnd${Math.round(Number(a.pt) * 4)}`; break;
        case 'scale': if (a.pct && a.pct !== 100) s += `\\charscalex${Math.round(a.pct)}`; break;
        case 'position': { const hp = Math.round(Number(a.pt) * 2); if (hp > 0) s += `\\up${hp}`; else if (hp < 0) s += `\\dn${-hp}`; break; }
        case 'charBorder': s += '\\chbrdr\\brdrs\\brdrw10'; break;
        case 'lang': { const id = LANG_IDS[String(a.lang || '').toLowerCase()]; if (id) s += `\\lang${id}`; if (a.noProof) s += '\\noproof'; break; }
        case 'dir': if (a.dir === 'rtl') s += '\\rtlch'; break;
        default: break;
      }
    }
    return s;
  }

  image(node: PMNode): string {
    const a = node.attrs;
    const d = parseDataUrl(a.src);
    if (!d) return a.alt ? rtfEscape(`[${a.alt}]`) : '';
    const mime = sniffImageMime(d.bytes) || d.mime;
    const blip = mime === 'image/png' ? '\\pngblip' : mime === 'image/jpeg' ? '\\jpegblip' : null;
    if (!blip) return a.alt ? rtfEscape(`[${a.alt}]`) : '';
    const px = imagePixelSize(d.bytes) || { w: 100, h: 100 };
    let wPt = a.width as number | null, hPt = a.height as number | null;
    if (!wPt && !hPt) { wPt = px.w * 0.75; hPt = px.h * 0.75; }
    else if (wPt && !hPt) hPt = (wPt * px.h) / Math.max(1, px.w);
    else if (hPt && !wPt) wPt = (hPt * px.w) / Math.max(1, px.h);
    return `{\\pict${blip}\\picw${px.w}\\pich${px.h}\\picwgoal${tw(wPt)}\\pichgoal${tw(hPt)}\n${bytesToHex(d.bytes)}\n}`;
  }

  atom(node: PMNode): string {
    const a = node.attrs;
    switch (node.type.name) {
      case 'hard_break': return '\\line ';
      case 'image': return this.image(node);
      case 'footnote': {
        const info = this.notes.get(node);
        const custom = a.mark ? rtfEscape(String(a.mark)) : null;
        const ref = custom ? `{\\super ${custom}}` : '{\\super\\chftn}';
        const style = a.kind === 'end' ? 'Endnote Text' : 'Footnote Text';
        const body = String(info?.text ?? a.text ?? '').split('\n').map(rtfEscape).join('\\par ');
        const inner = custom ? '' : `${ref} `;
        return `${ref}{\\footnote${a.kind === 'end' ? '\\ftnalt' : ''}\\pard\\plain\\s${this.styleNum(style)}${this.charStyleCodes(this.eff(style))} ${inner}${body}}`;
      }
      case 'field': {
        const val = rtfEscape(String(a.value || ''));
        return `{\\field{\\*\\fldinst ${rtfEscape(fieldInstruction(a))}}{\\fldrslt ${val}}}`;
      }
      case 'bookmark': { const n = rtfEscape(String(a.name || '')); return n ? `{\\*\\bkmkstart ${n}}{\\*\\bkmkend ${n}}` : ''; }
      case 'index_entry': return a.term ? `{\\xe {${rtfEscape(String(a.term) + (a.sub ? ':' + a.sub : ''))}}}` : '';
      default: return rtfEscape(inlineAtomText(node));
    }
  }

  inline(node: PMNode): string {
    let out = '';
    let i = 0;
    const kids: PMNode[] = [];
    node.forEach((c) => kids.push(c));
    while (i < kids.length) {
      const link = kids[i].marks.find((m) => m.type.name === 'link');
      if (link) {
        let j = i;
        let inner = '';
        while (j < kids.length && kids[j].marks.some((m) => m.eq(link))) { inner += this.run(kids[j], true); j++; }
        const href = String(link.attrs.href || '');
        const inst = href.startsWith('#') ? `HYPERLINK \\l ${fieldQuote(href.slice(1))}` : `HYPERLINK ${fieldQuote(href.replace(/["\s]/g, (c) => encodeURIComponent(c)))}`;
        const lc = this.color('#0563c1');
        out += `{\\field{\\*\\fldinst {${rtfEscape(inst)}}}{\\fldrslt {\\ul\\cf${lc} ${inner}}}}`;
        i = j;
        continue;
      }
      out += this.run(kids[i], false);
      i++;
    }
    return out;
  }

  run(n: PMNode, inLink: boolean): string {
    const marks = n.marks.filter((m) => m.type.name !== 'link');
    const codes = this.markCodes(marks);
    const body = n.isText ? rtfEscape(n.text || '') : this.atom(n);
    if (!body) return '';
    void inLink;
    return codes ? `{${codes} ${body}}` : body;
  }

  paragraph(node: PMNode, opts: { intbl?: boolean; extra?: string; prefix?: string } = {}): string {
    return this.paraStart(node, opts) + (opts.prefix || '') + this.inline(node) + '\\par\n';
  }

  simplePara(text: string, opts: { intbl?: boolean; style?: string; extra?: string; codes?: string } = {}): string {
    const fake = { attrs: { style: opts.style || 'Normal' } } as unknown as PMNode;
    return this.paraStart(fake, opts) + (opts.codes ? `{${opts.codes} ${rtfEscape(text)}}` : rtfEscape(text)) + '\\par\n';
  }

  /** Register a list definition for a top-level list and return its \ls number. */
  defineList(node: PMNode): { ls: number; levels: ListLevelDef[] } {
    const levels: ListLevelDef[] = [];
    const visit = (list: PMNode, depth: number) => {
      if (depth > 8) return;
      if (!levels[depth]) {
        const t = list.type;
        levels[depth] = t === S.nodes.ordered_list
          ? { kind: 'ordered', format: list.attrs.format || 'decimal', start: listStart(list.attrs.order), bullet: '', suffix: list.attrs.suffix ?? '.' }
          : t === S.nodes.task_list ? { kind: 'task', format: 'none', start: 1, bullet: '', suffix: '' }
            : { kind: 'bullet', format: 'bullet', start: 1, bullet: bulletChar(list.attrs.bullet), suffix: '' };
      }
      list.forEach((item) => item.forEach((b) => { if (b.type === S.nodes.bullet_list || b.type === S.nodes.ordered_list || b.type === S.nodes.task_list) visit(b, depth + 1); }));
    };
    visit(node, 0);
    const dflt = ['•', '◦', '▪'];
    for (let d = 0; d < 9; d++) if (!levels[d]) levels[d] = { kind: 'bullet', format: 'bullet', start: 1, bullet: dflt[d % 3], suffix: '' };
    const id = 1000 + this.nextList;
    const ls = this.nextList++;
    const lv = levels.map((l, d) => {
      const nfc = l.kind === 'ordered' ? (NFC[l.format] ?? 0) : l.kind === 'task' || !l.bullet ? 255 : 23;
      const ind = 720 * (d + 1);
      let text: string, nums: string;
      if (l.kind === 'ordered') {
        const suf = rtfEscape(l.suffix || '');
        const len = 1 + (l.suffix || '').length;
        text = `\\'${len.toString(16).padStart(2, '0')}\\'${d.toString(16).padStart(2, '0')}${suf}`;
        nums = `\\'01`;
      } else if (nfc === 23) {
        text = `\\'01${rtfEscape(l.bullet)}`;
        nums = '';
      } else { text = `\\'00`; nums = ''; }
      return `{\\listlevel\\levelnfc${nfc}\\levelnfcn${nfc}\\leveljc0\\leveljcn0\\levelfollow0\\levelstartat${l.start || 1}\\levelspace0\\levelindent0{\\leveltext\\leveltemplateid${id * 10 + d}${text};}{\\levelnumbers${nums};}\\fi-360\\li${ind}\\lin${ind} }`;
    });
    this.listDefs.push(`{\\list\\listtemplateid${id}\\listhybrid${lv.join('')}{\\listname ;}\\listid${id}}`);
    this.listOverrides.push(`{\\listoverride\\listid${id}\\listoverridecount0\\ls${ls}}`);
    return { ls, levels };
  }

  list(node: PMNode, depth: number, def: { ls: number; levels: ListLevelDef[] }, intbl: boolean): string {
    let out = '';
    let n = node.type === S.nodes.ordered_list ? listStart(node.attrs.order) : 1;
    const lvl = def.levels[Math.min(depth, 8)];
    node.forEach((item) => {
      let marker: string;
      let prefix = '';
      if (node.type === S.nodes.ordered_list) marker = formatNumber(n++, node.attrs.format || 'decimal') + (node.attrs.suffix ?? '.');
      else if (node.type === S.nodes.task_list) { marker = ''; prefix = item.attrs.checked ? '☒ ' : '☐ '; }
      else marker = lvl.kind === 'bullet' ? lvl.bullet : bulletChar(node.attrs.bullet);
      if (node.type !== S.nodes.task_list && item.attrs.checked != null) prefix = item.attrs.checked ? '☒ ' : '☐ ';
      const ind = 720 * (Math.min(depth, 8) + 1);
      let first = true;
      item.forEach((b) => {
        if (first && b.type === S.nodes.paragraph) {
          first = false;
          const listtext = marker ? `{\\listtext\\pard\\plain ${rtfEscape(marker)}\\tab}` : '';
          out += this.paraStart(b, { intbl, extra: `\\ls${def.ls}\\ilvl${Math.min(depth, 8)}\\fi-360\\li${ind}` }) + listtext + rtfEscape(prefix) + this.inline(b) + '\\par\n';
          return;
        }
        first = false;
        if (b.type === S.nodes.bullet_list || b.type === S.nodes.ordered_list || b.type === S.nodes.task_list) { out += this.list(b, depth + 1, def, intbl); return; }
        if (b.type === S.nodes.paragraph) { out += this.paragraph(b, { intbl, extra: `\\li${ind}` }); return; }
        out += this.block(b, { intbl });
      });
    });
    return out;
  }

  table(node: PMNode): string {
    let map: TableMap;
    try { map = TableMap.get(node); } catch { return ''; }
    const W = map.width;
    // Column widths (twips)
    const widths: (number | null)[] = Array(W).fill(null);
    for (let r = 0; r < map.height; r++) {
      for (let c = 0; c < W; c++) {
        const pos = map.map[r * W + c];
        const rect = map.findCell(pos);
        if (rect.top !== r || rect.left !== c) continue;
        const cell = node.nodeAt(pos);
        const cw = cell?.attrs.colwidth as number[] | null;
        if (cw) cw.forEach((px, k) => { if (px && widths[c + k] == null) widths[c + k] = Math.round(px * 15); });
      }
    }
    const known = widths.filter((x) => x != null) as number[];
    const rest = W - known.length;
    const remaining = Math.max(rest * 500, this.contentWidthTw - known.reduce((a, b) => a + b, 0));
    for (let c = 0; c < W; c++) if (widths[c] == null) widths[c] = Math.round(rest ? remaining / rest : this.contentWidthTw / W);
    const ts = this.styles[node.attrs.style] || {} as StyleDef;
    const borderColor = this.color(ts.borderColor || '#000000');
    const borders = ts.borders || 'all';
    const headerRows = node.attrs.headerRows || 0;
    let out = '';
    for (let r = 0; r < map.height; r++) {
      let row = `\\trowd\\trgaph108\\trleft${node.attrs.indent ? tw(node.attrs.indent) : -108}`;
      if (r < headerRows) row += '\\trhdr';
      if (node.attrs.align === 'center') row += '\\trqc'; else if (node.attrs.align === 'right') row += '\\trqr';
      if (node.attrs.layout === 'fixed') row += '\\trautofit0'; else row += '\\trautofit1';
      let x = 0;
      const contents: string[] = [];
      for (let c = 0; c < W; c++) {
        const pos = map.map[r * W + c];
        const rect = map.findCell(pos);
        const cell = node.nodeAt(pos)!;
        x += widths[c] || 0;
        let def = '';
        const isOrigin = rect.top === r && rect.left === c;
        if (rect.right - rect.left > 1) def += c === rect.left ? '\\clmgf' : '\\clmrg';
        if (rect.bottom - rect.top > 1) def += r === rect.top ? '\\clvmgf' : '\\clvmrg';
        const va = cell.attrs.valign;
        if (va === 'middle' || va === 'center') def += '\\clvertalc'; else if (va === 'bottom') def += '\\clvertalb'; else def += '\\clvertalt';
        if (borders !== 'none') {
          const b = `\\brdrs\\brdrw10${borderColor ? `\\brdrcf${borderColor}` : ''}`;
          const top = borders === 'all' || borders === 'horizontal' || (borders === 'outer' && r === 0);
          const bottom = borders === 'all' || borders === 'horizontal' || (borders === 'outer' && r === map.height - 1);
          const left = borders === 'all' || (borders === 'outer' && c === 0);
          const right = borders === 'all' || (borders === 'outer' && c === W - 1);
          if (top) def += `\\clbrdrt${b}`;
          if (left) def += `\\clbrdrl${b}`;
          if (bottom) def += `\\clbrdrb${b}`;
          if (right) def += `\\clbrdrr${b}`;
        }
        const bg = this.color(cell.attrs.background);
        if (bg) def += `\\clcbpat${bg}`;
        row += `${def}\\cellx${x}`;
        if (isOrigin) contents.push(this.cellContent(cell));
        else contents.push('\\pard\\intbl\\cell\n');
      }
      out += row + '\n' + contents.join('') + row + '\\row\n';
    }
    return out + '\\pard\n';
  }

  cellContent(cell: PMNode): string {
    let s = '';
    cell.forEach((b) => {
      if (b.type === S.nodes.table) {
        // Nested tables are flattened into tab-separated paragraphs.
        b.forEach((row) => {
          const parts: string[] = [];
          row.forEach((c) => parts.push(c.textContent));
          s += this.simplePara(parts.join('\t'), { intbl: true });
        });
        return;
      }
      s += this.block(b, { intbl: true });
    });
    if (!s) s = '\\pard\\intbl\\par\n';
    return s.replace(/\\par\n$/, '\\cell\n');
  }

  block(node: PMNode, ctx: { intbl?: boolean; next?: PMNode | null } = {}): string {
    const t = node.type;
    const intbl = !!ctx.intbl;
    switch (t.name) {
      case 'paragraph': return this.paragraph(node, { intbl });
      case 'code_block': {
        const mono = this.font('Courier New');
        const lines = node.textContent.split('\n').map(rtfEscape).join('\\line ');
        return `\\pard\\plain${intbl ? '\\intbl' : ''}\\s${this.styleNum('Plain Text')}\\ql\\sb0\\sa0\\f${mono}\\fs20 ${lines}\\par\n`;
      }
      case 'horizontal_rule': {
        const c = this.color(node.attrs.color);
        return `\\pard\\plain${intbl ? '\\intbl' : ''}\\brdrb\\brdrs\\brdrw${Math.max(5, Math.round((node.attrs.weight || 1) * 10))}\\brsp20${c ? `\\brdrcf${c}` : ''}\\sb0\\sa120\\fs4 \\par\n`;
      }
      case 'page_break': {
        if (intbl) return '';
        if (ctx.next && ctx.next.type === S.nodes.paragraph) return '\\page\n';
        return '\\pard\\plain\\page\\par\n';
      }
      case 'column_break': return intbl ? '' : '\\column\n';
      case 'section_break': {
        if (intbl) return '';
        const k = ({ continuous: '\\sbknone', evenPage: '\\sbkeven', oddPage: '\\sbkodd', nextPage: '\\sbkpage' } as Record<string, string>)[node.attrs.kind] || '\\sbkpage';
        return `\\sect\\sectd${k}${this.sectionProps()}\n`;
      }
      case 'math_block': return this.simplePara(node.attrs.latex || '', { intbl, extra: '\\qc', codes: `\\i\\f${this.font('Cambria Math')}` });
      case 'gen_block': return htmlToTextLines(node.attrs.cache || '').map((l) => this.simplePara(l, { intbl })).join('');
      case 'bullet_list': case 'ordered_list': case 'task_list': return this.list(node, 0, this.defineList(node), intbl);
      case 'table': {
        if (intbl) {
          let s = '';
          node.forEach((row) => { const parts: string[] = []; row.forEach((c) => parts.push(c.textContent)); s += this.simplePara(parts.join('\t'), { intbl: true }); });
          return s;
        }
        return this.table(node);
      }
      case 'column_section': {
        if (intbl) return this.children(node, ctx);
        const cols = Math.max(1, node.attrs.count || 2);
        return `\\sect\\sectd\\sbknone\\cols${cols}\\colsx${tw(node.attrs.gap ?? 36)}${node.attrs.rule ? '\\linebetcol' : ''}${this.sectionProps()}\n` +
          this.children(node, ctx) + `\\sect\\sectd\\sbknone\\cols1${this.sectionProps()}\n`;
      }
      default:
        if (node.isLeaf) return '';
        return this.children(node, ctx);
    }
  }

  children(node: PMNode, ctx: { intbl?: boolean }): string {
    let s = '';
    const kids: PMNode[] = [];
    node.forEach((c) => kids.push(c));
    kids.forEach((c, i) => { s += this.block(c, { ...ctx, next: kids[i + 1] || null }); });
    return s;
  }

  sectionProps(): string {
    const p = this.settings.page;
    const land = p.orientation === 'landscape';
    const w = land ? Math.max(p.width, p.height) : Math.min(p.width, p.height);
    const h = land ? Math.min(p.width, p.height) : Math.max(p.width, p.height);
    let s = `\\pgwsxn${tw(w)}\\pghsxn${tw(h)}\\marglsxn${tw(p.margin.left)}\\margrsxn${tw(p.margin.right)}\\margtsxn${tw(p.margin.top)}\\margbsxn${tw(p.margin.bottom)}`;
    if (p.gutter) s += `\\guttersxn${tw(p.gutter)}`;
    s += `\\headery${tw(p.headerDist)}\\footery${tw(p.footerDist)}`;
    if (land) s += '\\lndscpsxn';
    const fmt: Record<string, string> = { decimal: '\\pgndec', 'lower-roman': '\\pgnlcrm', 'upper-roman': '\\pgnucrm', 'lower-alpha': '\\pgnlcltr', 'upper-alpha': '\\pgnucltr', roman: '\\pgnlcrm', ROMAN: '\\pgnucrm' };
    s += fmt[this.settings.pageNumber.format] || '\\pgndec';
    if (this.settings.pageNumber.start && this.settings.pageNumber.start !== 1) s += `\\pgnstarts${this.settings.pageNumber.start}\\pgnrestart`;
    return s;
  }

  hfText(template: string, title: string, author: string, fileName: string): string {
    let out = '';
    const re = /\{([A-Z=]+)(?::([^}]*))?\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) {
      out += rtfEscape(template.slice(last, m.index));
      last = m.index + m[0].length;
      const t = m[1];
      const fld = (inst: string, v: string) => `{\\field{\\*\\fldinst ${inst}}{\\fldrslt ${rtfEscape(v)}}}`;
      switch (t) {
        case 'PAGE': out += '\\chpgn '; break;
        case 'NUMPAGES': out += fld('NUMPAGES', '1'); break;
        case 'DATE': out += fld(`DATE${m[2] ? ` \\\\@ "${rtfEscape(m[2])}"` : ''}`, new Date().toLocaleDateString()); break;
        case 'TIME': out += fld('TIME', new Date().toLocaleTimeString()); break;
        case 'TITLE': out += rtfEscape(title); break;
        case 'AUTHOR': out += rtfEscape(author); break;
        case 'FILENAME': out += rtfEscape(fileName); break;
        case 'SUBJECT': out += rtfEscape(this.settings.properties.subject || ''); break;
        case 'COMPANY': out += rtfEscape(this.settings.properties.company || ''); break;
        case 'SECTION': out += fld('SECTION', '1'); break;
        default: out += rtfEscape(m[0]);
      }
    }
    return out + rtfEscape(template.slice(last));
  }

  hfGroup(dest: string, hf: HF, title: string, author: string, fileName: string, footer: boolean): string {
    if (!hf || (!hf.left && !hf.center && !hf.right)) return '';
    const style = footer ? 'Footer' : 'Header';
    const center = Math.round(this.contentWidthTw / 2), right = this.contentWidthTw;
    const e = this.eff(style);
    const font = this.settings.headerFooterFont ? `\\f${this.font(this.settings.headerFooterFont)}` : '';
    const parts = [hf.left, hf.center, hf.right].map((x) => this.hfText(x || '', title, author, fileName));
    return `{\\${dest}\\pard\\plain\\s${this.styleNum(style)}\\ql\\tqc\\tx${center}\\tqr\\tx${right}${this.charStyleCodes(e)}${font} ${parts[0]}\\tab ${parts[1]}\\tab ${parts[2]}\\par}\n`;
  }

  styleSheet(): string {
    const entries: string[] = [];
    for (const [name, num] of [...this.styleNums.entries()].sort((a, b) => a[1] - b[1])) {
      const e = this.eff(name);
      const based = e.basedOn && this.styleNums.has(e.basedOn) ? `\\sbasedon${this.styleNums.get(e.basedOn)}` : '';
      const next = e.next && this.styleNums.has(e.next) ? `\\snext${this.styleNums.get(e.next)}` : `\\snext${num === 0 ? 0 : this.styleNums.get('Normal')}`;
      const wordName = /^Heading \d$/.test(name) ? name.toLowerCase() : name === 'Header' ? 'header' : name === 'Footer' ? 'footer' : name === 'Footnote Text' ? 'footnote text' : name;
      entries.push(`{\\s${num}${this.paraStyleCodes(e)}${this.charStyleCodes(e)}${based}${next}${num === 0 ? '' : '\\qformat'} ${rtfEscape(wordName)};}`);
    }
    return `{\\stylesheet\n${entries.join('\n')}\n}`;
  }

  render(doc: PMNode, opts: ExportOptions, title: string): string {
    const s = this.settings;
    // Body first, so fonts/colors/styles/lists are registered.
    const body = this.children(doc, {});
    const author = s.properties.author || opts.author || '';
    const fileName = opts.fileName || '';
    let hf = '';
    hf += this.hfGroup('header', s.header, title, author, fileName, false);
    hf += this.hfGroup('footer', s.footer, title, author, fileName, true);
    if (s.differentFirst) {
      hf += this.hfGroup('headerf', s.firstHeader, title, author, fileName, false);
      hf += this.hfGroup('footerf', s.firstFooter, title, author, fileName, true);
    }
    if (s.differentOddEven) {
      hf += this.hfGroup('headerl', s.evenHeader, title, author, fileName, false);
      hf += this.hfGroup('footerl', s.evenFooter, title, author, fileName, true);
      hf += this.hfGroup('headerr', s.header, title, author, fileName, false);
      hf += this.hfGroup('footerr', s.footer, title, author, fileName, true);
    }
    // Header / footer fonts and styles are now registered too.
    const fonttbl = this.fonts.map((f, i) => {
      const g = genericFor(f);
      const fam = /courier|mono|cousine/i.test(f) ? '\\fmodern' : g === 'serif' ? '\\froman' : /symbol|wingdings/i.test(f) ? '\\ftech' : '\\fswiss';
      return `{\\f${i}${fam}\\fcharset${/symbol|wingdings/i.test(f) ? 2 : 0}\\fprq2 ${rtfEscape(f)};}`;
    }).join('\n');
    const colortbl = `{\\colortbl;${this.colors.map((c) => `\\red${parseInt(c.slice(1, 3), 16)}\\green${parseInt(c.slice(3, 5), 16)}\\blue${parseInt(c.slice(5, 7), 16)};`).join('')}}`;
    const lists = this.listDefs.length ? `{\\*\\listtable\n${this.listDefs.join('\n')}\n}\n{\\*\\listoverridetable${this.listOverrides.join('')}}\n` : '';
    const p = s.page;
    const land = p.orientation === 'landscape';
    const w = land ? Math.max(p.width, p.height) : Math.min(p.width, p.height);
    const h = land ? Math.min(p.width, p.height) : Math.max(p.width, p.height);
    const now = new Date();
    const info = [
      title ? `{\\title ${rtfEscape(title)}}` : '',
      s.properties.subject ? `{\\subject ${rtfEscape(s.properties.subject)}}` : '',
      author ? `{\\author ${rtfEscape(author)}}` : '',
      s.properties.manager ? `{\\manager ${rtfEscape(s.properties.manager)}}` : '',
      s.properties.company ? `{\\company ${rtfEscape(s.properties.company)}}` : '',
      s.properties.category ? `{\\category ${rtfEscape(s.properties.category)}}` : '',
      s.properties.keywords ? `{\\keywords ${rtfEscape(s.properties.keywords)}}` : '',
      s.properties.comments ? `{\\doccomm ${rtfEscape(s.properties.comments)}}` : '',
      `{\\creatim\\yr${now.getFullYear()}\\mo${now.getMonth() + 1}\\dy${now.getDate()}\\hr${now.getHours()}\\min${now.getMinutes()}}`,
    ].join('');
    const lang = LANG_IDS[(s.language || 'en-US').toLowerCase()] || 1033;
    const docProps = `\\paperw${tw(w)}\\paperh${tw(h)}\\margl${tw(p.margin.left)}\\margr${tw(p.margin.right)}\\margt${tw(p.margin.top)}\\margb${tw(p.margin.bottom)}` +
      (p.gutter ? `\\gutter${tw(p.gutter)}` : '') + (land ? '\\landscape' : '') + (s.differentOddEven ? '\\facingp' : '') + (p.mirror ? '\\margmirror' : '') +
      `\\deftab${tw(s.defaultTab || 36)}\\widowctrl\\ftnbj\\aenddoc\\ftnrstcont\\aftnnrlc\\viewkind1\\viewscale100`;
    const sect = `\\sectd${s.differentFirst ? '\\titlepg' : ''}${this.sectionProps()}`;
    const header = `{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang${lang}\\uc1\n{\\fonttbl\n${fonttbl}\n}\n${colortbl}\n${this.styleSheet()}\n${lists}{\\*\\generator Anne\'s Pen;}\n{\\info${info}}\n${docProps}\n${sect}\n`;
    return header + hf + body + '}';
  }
}

export function docToRtf(doc: PMNode, opts: ExportOptions): string {
  const prepared = prepareDoc(doc);
  const notes = collectFootnotes(prepared);
  const w = new RtfWriter(prepared, notes);
  return w.render(prepared, opts, docTitle(doc, opts));
}

export async function exportRtf(doc: PMNode, opts: ExportOptions): Promise<Blob> {
  return makeBlob(docToRtf(doc, opts), 'application/rtf');
}

// =============================================================================================
// Import

interface CharState {
  b: boolean; i: boolean; ul: string | null; strike: boolean; dstrike: boolean; sup: boolean; sub: boolean;
  scaps: boolean; caps: boolean; v: boolean; rtl: boolean; f: number | null; fs: number | null; cf: number; hl: number; shade: number;
  expnd: number; scale: number; up: number;
  /** Tracked change: 1 insertion (\revised), 2 deletion (\deleted), with author index and DTTM. */
  rev: number; revAuth: number; revDt: number; revAuthDel: number; revDtDel: number;
}
interface ParaState {
  align: string | null; li: number; ri: number; fi: number; sb: number | null; sa: number | null; sl: number; slmult: number;
  keepn: boolean; keep: boolean; pagebb: boolean; outline: number | null; s: number | null; intbl: boolean; ls: number; ilvl: number; cbpat: number;
  border: Record<string, string> | null; rtl: boolean;
}
interface Sink { text: string; align: string | null; kind: string }
interface FieldState { inst: string; hyperlink: string | null; resultStarted: boolean; startPara: number; startIdx: number; sinkStart: number; sink: Sink | null }
interface Group {
  ch: CharState; pa: ParaState; dest: string; uc: number; link: string | null; sink: Sink | null;
  field: FieldState | null; ownsField: boolean; ownsNote: boolean; noteKind: string; ownsSink: boolean; uprDest: string | null;
  ownsPict: boolean; ownsBkmk: boolean; ownsInfo: string | null; styleEntry: boolean;
  /** Owns a metadata capture (annotation id/author/ref/date, comment range, shape property). */
  ownsMeta: string | null; ownsAnnot: boolean; ownsShape: boolean; ownsShpTxt: boolean; ownsSp: boolean;
}
interface CellDef { right: number; mgf: boolean; mrg: boolean; vmgf: boolean; vmrg: boolean; bg: number; valign: string | null; borders?: Record<string, string> }
/** A list paragraph keeps its left indent so that following indented paragraphs can join its item. */
type Entry = PMNode | { list: FlatListItem; li?: number } | { sect: string };
interface RowBuild { cells: Entry[][]; defs: CellDef[]; header: boolean }

const freshChar = (): CharState => ({ b: false, i: false, ul: null, strike: false, dstrike: false, sup: false, sub: false, scaps: false, caps: false, v: false, rtl: false, f: null, fs: null, cf: 0, hl: 0, shade: 0, expnd: 0, scale: 100, up: 0, rev: 0, revAuth: 0, revDt: 0, revAuthDel: 0, revDtDel: 0 });
const freshPara = (): ParaState => ({ align: null, li: 0, ri: 0, fi: 0, sb: null, sa: null, sl: 0, slmult: 0, keepn: false, keep: false, pagebb: false, outline: null, s: null, intbl: false, ls: 0, ilvl: 0, cbpat: 0, border: null, rtl: false });

const CHARSET_CP: Record<number, string> = {
  0: 'windows-1252', 1: 'windows-1252', 2: 'windows-1252', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 130: 'euc-kr', 134: 'gbk', 136: 'big5',
  161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251',
  222: 'windows-874', 238: 'windows-1250',
};
const CP_LABEL: Record<number, string> = {
  437: 'windows-1252', 850: 'windows-1252', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250',
  1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256',
  1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh', 65001: 'utf-8', 20866: 'koi8-r', 28591: 'iso-8859-1', 28592: 'iso-8859-2',
};

const UL_STYLES: Record<string, string> = {
  ul: 'single', uldb: 'double', uld: 'dotted', uldash: 'dashed', ulwave: 'wavy', ulth: 'thick', ulw: 'words', uldashd: 'dotDash',
  uldashdd: 'dotDotDash', ulthd: 'thick', ulthdash: 'thick', ulldash: 'dashed', ulhwave: 'wavy', ululdbwave: 'wavy', ulthdashd: 'thick', ulthdashdd: 'thick', ulthldash: 'thick',
};

const SKIP_DESTS = new Set(['themedata', 'colorschememapping', 'datastore', 'latentstyles', 'rsidtbl', 'filetbl', 'xmlnstbl', 'mmathPr',
  'pgdsctbl', 'objdata', 'objclass', 'nonshppict', 'fldtype', 'ftnsep', 'ftnsepc', 'ftncn', 'aftnsep', 'aftnsepc', 'aftncn', 'pnseclvl',
  'listpicture', 'userprops', 'docvar', 'template', 'nesttableprops', 'nonesttables', 'atnicn', 'atntime', 'atnparent',
  'xe', 'tc', 'txe', 'rxe', 'bkmkend', 'blipuid', 'picprop', 'wgrffmtfilter', 'fchars', 'lchars', 'background', 'operator', 'password', 'passwordhash',
  'mmath', 'mmathPict', 'oleclsid', 'panose', 'falt', 'fname', 'keycode', 'formfield', 'datafield', 'printim', 'buptim', 'revtim', 'generator', 'hlinkbase',
  'do', 'dptxbxtext', 'protusertbl', 'ebcstart', 'ebcend', 'pxe', 'factoidname']);

const INFO_KEYS: Record<string, string> = { title: 'title', subject: 'subject', author: 'author', manager: 'manager', company: 'company', category: 'category', keywords: 'keywords', doccomm: 'comments', comment: 'comments', operator: '' };

const FIELD_TYPES = new Set(['DATE', 'TIME', 'CREATEDATE', 'SAVEDATE', 'PRINTDATE', 'PAGE', 'NUMPAGES', 'NUMWORDS', 'NUMCHARS', 'AUTHOR', 'TITLE', 'SUBJECT', 'KEYWORDS',
  'COMMENTS', 'FILENAME', 'DOCPROPERTY', 'DOCVARIABLE', 'USERNAME', 'USERINITIALS', 'SEQ', 'REF', 'PAGEREF', 'STYLEREF', 'MERGEFIELD', 'MERGEREC', 'FILLIN', 'QUOTE', '=', 'SECTION']);

interface ListDef { id: number; levels: { nfc: number; start: number; text?: string }[] }

/** Bullet character from \leveltext → list bullet attribute (private-use Symbol/Wingdings glyphs mapped). */
function rtfBullet(ch: string): string {
  if (!ch || ch === '•' || ch === '·' || ch === '\uf0b7' || ch === '\u00b7') return 'disc';
  if (ch === 'o' || ch === '◦' || ch === '○') return 'circle';
  if (ch === '▪' || ch === '■' || ch === '\uf0a7' || ch === '§') return 'square';
  if (ch.charCodeAt(0) >= 0xf000) return 'disc';
  return ch;
}

/** Decode an RTF/Word DTTM (packed minute/hour/day/month/year) into epoch milliseconds (0 when absent). */
export function dttmToMs(v: number): number {
  if (!v) return 0;
  const x = v >>> 0;
  const min = x & 63, hr = (x >>> 6) & 31, day = (x >>> 11) & 31, mon = (x >>> 16) & 15, yr = 1900 + ((x >>> 20) & 511);
  if (!day || !mon || mon > 12) return 0;
  return Date.UTC(yr, mon - 1, day, hr, min);
}

/** Group nesting kept as separate states; deeper groups (only crafted files) reuse the deepest. */
export const RTF_MAX_DEPTH = 1000;

export class RtfReader {
  s: string;
  pos = 0;
  settings = newSettings();
  groups: Group[] = [];
  /** Open groups beyond RTF_MAX_DEPTH. */
  overflow = 0;
  g: Group;
  fonts = new Map<number, { name: string; charset: number }>();
  fontEntry: { num: number; name: string; charset: number } | null = null;
  colors: (string | null)[] = [];
  colorCur: { r: number; g: number; b: number; set: boolean } = { r: 0, g: 0, b: 0, set: false };
  styles = new Map<number, { name: string; outline: number | null }>();
  styleEntry: { num: number; name: string; outline: number | null; kind: string } | null = null;
  lists: ListDef[] = [];
  overrides = new Map<number, number>();
  codepage = 'windows-1252';
  deff = 0;
  bytes: number[] = [];
  ucSkip = 0;
  // Content
  blocks: Entry[] = [];
  inlines: PMNode[] = [];
  paraId = 0;
  marker: string | null = null;
  pn: { bullet: boolean; level: number; format: string | null; start: number } | null = null;
  table: { rows: RowBuild[]; curRow: Entry[][]; curCell: Entry[]; defs: CellDef[]; pending: CellDef; header: boolean } | null = null;
  rowDefs: CellDef[] = [];
  pendingCell: CellDef = { right: 0, mgf: false, mrg: false, vmgf: false, vmrg: false, bg: 0, valign: null };
  rowHeader = false;
  pict: { type: string; hex: string[]; bin: Uint8Array[]; picw: number; pich: number; goalw: number; goalh: number; scalex: number; scaley: number } | null = null;
  bkmk = '';
  info: Record<string, string> = {};
  bodyStarted = false;
  lastSect: { sect: string } | null = null;
  page: { w?: number; h?: number; ml?: number; mr?: number; mt?: number; mb?: number; land?: boolean; hy?: number; fy?: number; gutter?: number } = {};
  titlepg = false;
  facingp = false;
  // Review: revision authors, comment ranges and the annotation being read.
  revAuthors: string[] = [];
  revAuthorBuf = '';
  activeComments: string[] = [];
  rangedComments = new Set<string>();
  meta: Record<string, string> = {};
  annotCount = 0;
  // Shapes (\shp): properties, picture (pib) and text (\shptxt).
  shapes: { props: Map<string, string>; img: { src: string; w: number | null; h: number | null } | null; blocks: PMNode[] | null; box: Record<string, number>; saved: PMNode[] | null; blockStart: number }[] = [];
  spName = '';
  spValue = '';
  borderTarget: Record<string, string> | null = null;
  borderSide = '';
  borderSpec = { style: 'solid', w: 10, cf: 0 };
  paraStyles: Record<string, StyleDef> = {};
  /** RTFD attachments (file name → data URL) for \NeXTGraphic references. */
  attachments: Map<string, string> | null = null;
  nextGraphic: { name: string; w: number; h: number } | null = null;
  skipAttachmentChar = false;

  constructor(s: string) {
    this.s = s;
    this.g = { ch: freshChar(), pa: freshPara(), dest: 'body', uc: 1, link: null, sink: null, field: null, ownsField: false, ownsNote: false, noteKind: 'foot', ownsSink: false, uprDest: null, ownsPict: false, ownsBkmk: false, ownsInfo: null, styleEntry: false, ownsMeta: null, ownsAnnot: false, ownsShape: false, ownsShpTxt: false, ownsSp: false };
  }

  // ---------------------------------------------------------------- text plumbing

  decoder(): string {
    const f = this.g.ch.f != null ? this.fonts.get(this.g.ch.f) : null;
    if (f && f.charset && CHARSET_CP[f.charset] && f.charset !== 0 && f.charset !== 1 && f.charset !== 2) return CHARSET_CP[f.charset];
    return this.codepage;
  }

  flushBytes(): void {
    if (!this.bytes.length) return;
    const u8 = new Uint8Array(this.bytes);
    this.bytes = [];
    let text: string;
    try { text = new TextDecoder(this.decoder()).decode(u8); } catch { text = String.fromCharCode(...Array.from(u8)); }
    this.emit(text);
  }

  byte(b: number): void {
    if (this.ucSkip > 0) { this.ucSkip--; return; }
    const d = this.g.dest;
    if (d === 'body' || d === 'sink' || d === 'fldinst' || d === 'listtext' || d === 'bkmk' || d.startsWith('info:') || d.startsWith('meta:') || d === 'sv' || d === 'sn' || d === 'revtbl' || d === 'leveltext' || d === 'nextgraphic') { this.bytes.push(b); return; }
    if (d === 'pict') { this.pict?.hex.push(String.fromCharCode(b)); return; }
    if (d === 'fonttbl' || d === 'stylesheet' || d === 'colortbl') this.emit(String.fromCharCode(b));
  }

  emit(text: string): void {
    if (!text) return;
    const g = this.g;
    switch (g.dest) {
      case 'body': this.emitBody(text); break;
      case 'sink': if (g.sink) g.sink.text += text; break;
      case 'fldinst': if (g.field) g.field.inst += text; break;
      case 'listtext': this.marker = (this.marker || '') + text; break;
      case 'bkmk': this.bkmk += text; break;
      case 'pict': this.pict?.hex.push(text); break;
      case 'fonttbl': {
        for (const c of text) {
          if (c === ';') { this.finishFont(); continue; }
          if (!this.fontEntry) this.fontEntry = { num: this.fonts.size, name: '', charset: 0 };
          this.fontEntry.name += c;
        }
        break;
      }
      case 'colortbl': {
        for (const c of text) if (c === ';') {
          this.colors.push(this.colorCur.set ? '#' + [this.colorCur.r, this.colorCur.g, this.colorCur.b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('') : null);
          this.colorCur = { r: 0, g: 0, b: 0, set: false };
        }
        break;
      }
      case 'stylesheet': {
        if (!this.styleEntry) break;
        for (const c of text) {
          if (c === ';') { this.finishStyle(); continue; }
          if (this.styleEntry) this.styleEntry.name += c;
        }
        break;
      }
      case 'sn': this.spName += text; break;
      case 'nextgraphic': if (this.nextGraphic) this.nextGraphic.name += text; break;
      case 'leveltext': {
        const l = this.lists[this.lists.length - 1];
        const lv = l?.levels[l.levels.length - 1];
        if (lv) lv.text = (lv.text || '') + text;
        break;
      }
      case 'sv': this.spValue += text; break;
      case 'revtbl': {
        for (const c of text) {
          if (c === ';') { this.revAuthors.push(this.revAuthorBuf.trim()); this.revAuthorBuf = ''; } else this.revAuthorBuf += c;
        }
        break;
      }
      default:
        if (g.dest.startsWith('info:')) { const k = g.dest.slice(5); this.info[k] = (this.info[k] || '') + text; }
        else if (g.dest.startsWith('meta:')) { const k = g.dest.slice(5); this.meta[k] = (this.meta[k] || '') + text; }
    }
  }

  finishFont(): void {
    const e = this.fontEntry;
    if (e) this.fonts.set(e.num, { name: e.name.trim().replace(/;$/, ''), charset: e.charset });
    this.fontEntry = null;
  }

  finishStyle(): void {
    const e = this.styleEntry;
    if (e && e.kind === 'para') this.styles.set(e.num, { name: e.name.trim(), outline: e.outline });
    this.styleEntry = null;
  }

  marks(): Mark[] {
    const c = this.g.ch;
    const M = S.marks;
    const out: Mark[] = [];
    if (c.b) out.push(M.bold.create());
    if (c.i) out.push(M.italic.create());
    const linkLook = !!this.g.link;
    if (c.ul && !(linkLook && c.ul === 'single')) out.push(M.underline.create({ style: c.ul }));
    if (c.strike) out.push(M.strike.create());
    if (c.dstrike) out.push(M.dstrike.create());
    if (c.sup) out.push(M.sup.create()); else if (c.sub) out.push(M.sub.create());
    if (c.scaps) out.push(M.smallcaps.create());
    if (c.caps) out.push(M.allcaps.create());
    if (c.v) out.push(M.hidden.create());
    if (c.rtl) out.push(M.dir.create({ dir: 'rtl' }));
    const f = this.fonts.get(c.f ?? this.deff);
    if (f && f.name && !/^(symbol|wingdings|webdings)/i.test(f.name)) out.push(M.font.create({ family: f.name }));
    const fs = c.fs != null && c.fs > 0 ? c.fs : 24; // RTF default: 12pt
    out.push(M.size.create({ pt: fs / 2 }));
    if (c.cf > 0 && this.colors[c.cf] && !(linkLook && /^#(0563c1|0000ff|0000ee|1155cc|0066cc)$/.test(this.colors[c.cf] || ''))) out.push(M.color.create({ color: this.colors[c.cf] }));
    if (c.hl > 0 && this.colors[c.hl]) out.push(M.highlight.create({ color: this.colors[c.hl] }));
    if (c.shade > 0 && this.colors[c.shade] && this.colors[c.shade] !== '#ffffff') out.push(M.shading.create({ color: this.colors[c.shade] }));
    if (c.expnd) out.push(M.spacing.create({ pt: c.expnd / 20 }));
    if (c.scale && c.scale !== 100) out.push(M.scale.create({ pct: c.scale }));
    if (c.up) out.push(M.position.create({ pt: c.up / 2 }));
    if (this.g.link) out.push(M.link.create({ href: this.g.link }));
    if (c.rev === 1) out.push(M.insertion.create({ author: this.revAuthors[c.revAuth] || 'Unknown', date: dttmToMs(c.revDt), id: `rtf-r${c.revAuth}-${c.revDt}` }));
    else if (c.rev === 2) out.push(M.deletion.create({ author: this.revAuthors[c.revAuthDel] || 'Unknown', date: dttmToMs(c.revDtDel), id: `rtf-d${c.revAuthDel}-${c.revDtDel}` }));
    for (const id of this.activeComments) out.push(M.comment.create({ id: 'rtf-c' + id }));
    return markSet(out);
  }

  emitBody(text: string): void {
    if (this.skipAttachmentChar) {
      // The attachment placeholder character that follows a \NeXTGraphic group.
      this.skipAttachmentChar = false;
      text = text.replace(/^[\u00ac\ufffc]/, '');
    }
    const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    if (!clean) return;
    this.bodyStarted = true;
    this.inlines.push(S.text(clean, this.marks()));
  }

  pushInline(node: PMNode): void {
    if (this.g.dest === 'sink') return;
    this.bodyStarted = true;
    this.inlines.push(node);
  }

  // ---------------------------------------------------------------- paragraphs, lists, tables

  styleName(ps: ParaState): string {
    let name: string | null = null;
    if (ps.s != null && this.styles.has(ps.s)) {
      const st = this.styles.get(ps.s)!;
      name = canonicalStyleName(st.name);
      if (!name && st.outline != null && st.outline < 9) name = `Heading ${st.outline + 1}`;
    }
    if ((!name || name === 'Normal') && ps.outline != null && ps.outline < 9) name = `Heading ${ps.outline + 1}`;
    if (!name && ps.s != null && ps.s !== 0 && this.styles.has(ps.s)) {
      // A custom paragraph style: keep its name (the text carries its formatting directly).
      const raw = this.styles.get(ps.s)!.name.replace(/;$/, '').trim();
      if (raw && !/^(default|normal|standard|default paragraph style)$/i.test(raw)) {
        name = raw;
        if (!this.paraStyles[raw]) this.paraStyles[raw] = { name: raw, type: 'paragraph', basedOn: 'Normal', quick: true };
      }
    }
    if (!name || name === 'List Paragraph') name = 'Normal';
    return name;
  }

  paraAttrs(ps: ParaState, inList: boolean): Attrs {
    const a: Attrs = { style: this.styleName(ps) };
    if (ps.align) a.align = ps.align;
    if (ps.rtl) a.dir = 'rtl';
    if (!inList) {
      if (ps.li) a.indentLeft = ps.li / 20;
      if (ps.fi) a.indentFirst = ps.fi / 20;
    }
    if (ps.ri) a.indentRight = ps.ri / 20;
    if (ps.sb != null) a.spaceBefore = ps.sb / 20;
    if (ps.sa != null) a.spaceAfter = ps.sa / 20;
    if (ps.sl) {
      if (ps.slmult) a.lineHeight = String(Math.round((Math.abs(ps.sl) / 240) * 100) / 100);
      else if (ps.sl > 0) a.lineHeight = `atleast:${ps.sl / 20}`;
      else a.lineHeight = `${-ps.sl / 20}pt`;
    }
    if (ps.keepn) a.keepNext = true;
    if (ps.keep) a.keepLines = true;
    if (ps.pagebb) a.pageBreakBefore = true;
    if (ps.cbpat && this.colors[ps.cbpat]) a.bg = this.colors[ps.cbpat];
    if (ps.border && Object.keys(ps.border).length) a.border = JSON.stringify(ps.border);
    return a;
  }

  listInfo(ps: ParaState, text: string): FlatListItem | null {
    let ordered = false, format = 'disc', start = 1, level = 0;
    let suffix: string | null = null;
    let isList = false;
    if (ps.ls > 0) {
      const id = this.overrides.get(ps.ls);
      const def = this.lists.find((l) => l.id === id);
      const lv = def?.levels[Math.min(ps.ilvl, (def?.levels.length || 1) - 1)];
      level = ps.ilvl;
      isList = true;
      // Outline numbering without a number on headings (LibreOffice chapter numbering) is not a list.
      if (lv && lv.nfc === 255 && /^(Heading \d|Title)$/.test(this.styleName(ps))) return null;
      if (lv) {
        const map: Record<number, string> = { 0: 'decimal', 1: 'upper-roman', 2: 'lower-roman', 3: 'upper-alpha', 4: 'lower-alpha', 22: 'decimal-zero' };
        const lt = (lv.text || '').replace(/;$/, '');
        if (lv.nfc === 23 || lv.nfc === 255) {
          ordered = false;
          // \leveltext: a length byte, then the bullet character.
          const ch = lt.slice(1).replace(/[\u0000-\u0008]/g, '').trim();
          format = lv.nfc === 255 && !ch ? 'none' : rtfBullet(ch);
        } else {
          ordered = true; format = map[lv.nfc] || 'decimal'; start = lv.start || 1;
          // The number actually shown: a list that resumes after other paragraphs goes on counting.
          const shown = this.marker != null ? markerNumber(this.marker, format) : null;
          if (shown != null) start = shown;
          const tail = lt.slice(1).split(/[\u0000-\u0008]/).pop() || '';
          if (tail.trim() && tail.trim().length <= 2) suffix = tail.trim();
        }
      } else if (this.marker) {
        const mf = markerFormat(this.marker.replace(/\t/g, ''));
        ordered = mf.ordered; format = mf.format; start = mf.start;
      }
    } else if (this.pn) {
      isList = true;
      ordered = !this.pn.bullet;
      format = ordered ? this.pn.format || 'decimal' : 'disc';
      start = this.pn.start || 1;
      level = Math.max(0, this.pn.level - 1);
      if (!this.pn.level && ps.li) level = Math.max(0, Math.round(ps.li / 360) - 1);
    } else if (this.marker != null) {
      isList = true;
      const mf = markerFormat(this.marker.replace(/\t/g, '').trim());
      ordered = mf.ordered; format = mf.format; start = mf.start;
      level = ps.li ? Math.max(0, Math.round(ps.li / 360) - 1) : 0;
    }
    if (!isList) return null;
    const task = /^[☐☒☑]\s?/.test(text);
    return { level: Math.min(8, level), ordered: task ? false : ordered, format, start, task, checked: task ? !/^☐/.test(text) : null, blocks: [], ...(suffix ? { suffix } : {}), ...(ps.ls > 0 ? { ls: ps.ls } : {}) } as FlatListItem;
  }

  endPara(kind: 'par' | 'cell' | 'eof'): void {
    this.flushBytes();
    const g = this.g;
    if (g.dest === 'sink') {
      if (g.sink) { g.sink.text += '\n'; g.sink.align = g.pa.align; }
      return;
    }
    if (g.dest !== 'body') return;
    const ps = g.pa;
    let inlines = this.inlines;
    this.inlines = [];
    this.paraId++;
    const text = inlines.map((n) => (n.isText ? n.text : '')).join('');
    const li = this.listInfo(ps, text);
    if (li && li.task) {
      // Strip the checkbox character.
      const first = inlines[0];
      if (first && first.isText) {
        const t = (first.text || '').replace(/^[☐☒☑]\s?/, '');
        inlines = t ? [S.text(t, first.marks), ...inlines.slice(1)] : inlines.slice(1);
      }
    }
    this.marker = null;
    this.pn = null;
    const inTable = ps.intbl || kind === 'cell';
    if (!inTable && this.table) this.closeTable();
    const target = inTable ? this.table?.curCell : this.blocks;
    // An unnumbered paragraph indented like a list item just before it continues that item.
    const owner = !li && ps.li > 0 && target ? this.continuedItem(target, ps.li) : null;
    const node = S.nodes.paragraph.create(this.paraAttrs(ps, !!li || !!owner), inlines.length ? inlines : null);
    const entry: Entry = li ? { list: { ...li, blocks: [node] }, li: ps.li }
      : owner ? { list: { ...owner, cont: true, blocks: [node] }, li: ps.li } : node;
    if (inTable) {
      if (!this.table) this.table = { rows: [], curRow: [], curCell: [], defs: [], pending: { ...this.pendingCell }, header: false };
      this.table.curCell.push(entry);
    } else this.blocks.push(entry);
  }

  /** The list item an indented paragraph continues: the nearest earlier item of the same list run with that indent. */
  continuedItem(entries: Entry[], li: number): FlatListItem | null {
    for (let k = entries.length - 1; k >= 0; k--) {
      const e = entries[k] as { list?: FlatListItem; li?: number };
      if (!e.list) return null;
      if (e.li === li && !e.list.cont) return e.list;
    }
    return null;
  }

  hasPendingContent(): boolean {
    return this.inlines.length > 0 || this.bytes.length > 0;
  }

  cell(): void {
    if (this.g.dest !== 'body') return;
    if (!this.table) this.table = { rows: [], curRow: [], curCell: [], defs: [], pending: { ...this.pendingCell }, header: false };
    // \cell terminates the cell's last paragraph.
    this.endPara('cell');
    const t = this.table!;
    t.curRow.push(t.curCell);
    t.curCell = [];
  }

  row(): void {
    if (!this.table) return;
    const t = this.table;
    if (t.curCell.length) { t.curRow.push(t.curCell); t.curCell = []; }
    t.rows.push({ cells: t.curRow, defs: [...this.rowDefs], header: this.rowHeader });
    t.curRow = [];
  }

  closeTable(): void {
    const t = this.table;
    this.table = null;
    if (!t) return;
    if (t.curCell.length) t.curRow.push(t.curCell);
    if (t.curRow.length) t.rows.push({ cells: t.curRow, defs: [...this.rowDefs], header: false });
    if (!t.rows.length) return;
    // Build cells with merges.
    type CB = { blocks: PMNode[]; colspan: number; rowspan: number; header: boolean; widths: number[]; bg: string | null; valign: string | null; col: number; borders: string | null };
    const grid: CB[][] = [];
    // Column grid: the distinct cell edges of all rows (rows may merge cells simply by omitting edges).
    const edges: number[] = [];
    for (const row of t.rows) for (const d of row.defs) if (d.right > 0 && !edges.some((e) => Math.abs(e - d.right) <= 30)) edges.push(d.right);
    edges.sort((a, b) => a - b);
    const gridIndex = (right: number) => { let best = -1; for (let i = 0; i < edges.length; i++) if (Math.abs(edges[i] - right) <= 30) best = i; return best; };
    for (let r = 0; r < t.rows.length; r++) {
      const row = t.rows[r];
      const cells: CB[] = [];
      let col = 0;
      let prevRight = 0;
      for (let k = 0; k < row.cells.length; k++) {
        const def = row.defs[k] || { right: prevRight + 1440, mgf: false, mrg: false, vmgf: false, vmrg: false, bg: 0, valign: null };
        const width = Math.max(1, Math.round((def.right - prevRight) / 15));
        prevRight = def.right;
        const gi = row.defs[k] ? gridIndex(def.right) : -1;
        const span = gi >= col ? gi - col + 1 : 1;
        if (def.mrg && cells.length) { const last = cells[cells.length - 1]; last.colspan += span; last.widths.push(width); col += span; continue; }
        if (def.vmrg && r > 0) {
          const above = this.findOrigin(grid, r - 1, col);
          if (above) { above.rowspan++; col += span; continue; }
        }
        const widths = span > 1 ? Array.from({ length: span }, () => Math.max(1, Math.round(width / span))) : [width];
        cells.push({ blocks: this.finalize(row.cells[k]), colspan: span, rowspan: 1, header: row.header, widths, bg: def.bg && this.colors[def.bg] ? this.colors[def.bg] : null, valign: def.valign, col, borders: def.borders && Object.keys(def.borders).length ? JSON.stringify(def.borders) : null });
        col += span;
      }
      grid.push(cells);
    }
    let headerRows = 0;
    while (headerRows < t.rows.length && t.rows[headerRows].header) headerRows++;
    const rows = grid.map((cells, r) => S.nodes.table_row.create(null, cells.map((c) => (r < headerRows ? S.nodes.table_header : S.nodes.table_cell).create(
      { colspan: c.colspan, rowspan: c.rowspan, colwidth: c.widths.every((w) => w > 1) ? c.widths : null, background: c.bg, valign: c.valign, borders: c.borders },
      c.blocks.length ? c.blocks : [para()],
    ))));
    this.blocks.push(S.nodes.table.create({ headerRows }, rows.filter((r) => r.childCount > 0)));
  }

  findOrigin(grid: { col: number; colspan: number; rowspan: number }[][], r: number, col: number): { rowspan: number } | null {
    for (let rr = r; rr >= 0; rr--) {
      for (const c of grid[rr]) if (c.col <= col && col < c.col + c.colspan && rr + c.rowspan - 1 >= r) return c;
    }
    return null;
  }

  /** Turn entries into blocks: group list paragraphs into nested lists, resolve section breaks. */
  finalize(entries: Entry[]): PMNode[] {
    const out: PMNode[] = [];
    let run: FlatListItem[] = [];
    const flush = () => { if (run.length) { out.push(...buildNestedLists(run)); run = []; } };
    for (const e of entries) {
      if ((e as any).list) { run.push((e as any).list); continue; }
      flush();
      if ((e as any).sect) { out.push(S.nodes.section_break.create({ kind: (e as any).sect })); continue; }
      out.push(e as PMNode);
    }
    flush();
    while (out.length && out[out.length - 1].type === S.nodes.section_break) out.pop();
    return out;
  }

  // ---------------------------------------------------------------- groups

  pushGroup(): void {
    this.flushBytes();
    this.groups.push(this.g);
    const g = this.g;
    this.g = { ...g, ch: { ...g.ch }, pa: { ...g.pa, border: g.pa.border ? { ...g.pa.border } : null }, ownsField: false, ownsNote: false, ownsSink: false, ownsPict: false, ownsBkmk: false, ownsInfo: null, styleEntry: false, ownsMeta: null, ownsAnnot: false, ownsShape: false, ownsShpTxt: false, ownsSp: false };
    this.ucSkip = 0;
  }

  popGroup(): void {
    this.flushBytes();
    const g = this.g;
    // Close what this group opened.
    if (g.dest === 'fonttbl' && this.fontEntry && this.groups.length && this.groups[this.groups.length - 1].dest === 'fonttbl') { if (this.fontEntry.name.trim()) this.finishFont(); }
    if (g.styleEntry && this.styleEntry) this.finishStyle();
    if (g.ownsPict) this.finishPict();
    if (g.ownsBkmk) { const name = this.bkmk.trim(); this.bkmk = ''; const parent = this.groups[this.groups.length - 1]; if (name && parent && parent.dest === 'body') this.inlines.push(S.nodes.bookmark.create({ name })); }
    if (g.ownsField && g.field) this.finishField(g.field);
    if (g.ownsNote && g.sink) {
      const text = g.sink.text.replace(/\n+$/, '').replace(/^\s+/, '').trim();
      const parent = this.groups[this.groups.length - 1];
      if (parent && parent.dest === 'body') this.inlines.push(S.nodes.footnote.create({ text, kind: g.noteKind }));
    }
    if (g.ownsAnnot && g.sink) this.finishAnnotation(g.sink.text);
    else if (g.ownsSink && !g.ownsNote && g.sink) this.finishHF(g.sink);
    if (g.ownsMeta) this.finishMeta(g.ownsMeta);
    if (g.ownsSp && this.shapes.length) { this.shapes[this.shapes.length - 1].props.set(this.spName.trim(), this.spValue.trim()); this.spName = ''; this.spValue = ''; }
    if (g.ownsShpTxt) this.finishShapeText();
    if (g.ownsShape) this.finishShape();
    if (g.ownsMeta === 'nextgraphic') this.finishNextGraphic();
    if (g.ownsInfo) { /* info text already captured */ }
    const parent = this.groups.pop();
    if (parent) this.g = parent;
    this.ucSkip = 0;
  }

  finishPict(): void {
    const p = this.pict;
    this.pict = null;
    if (!p) return;
    let bytes: Uint8Array;
    if (p.bin.length) {
      const total = p.bin.reduce((a, b) => a + b.length, 0);
      bytes = new Uint8Array(total);
      let o = 0;
      for (const b of p.bin) { bytes.set(b, o); o += b.length; }
    } else bytes = hexToBytes(p.hex.join(''));
    if (!bytes.length) return;
    const mime = sniffImageMime(bytes) || (p.type === 'png' ? 'image/png' : p.type === 'jpeg' ? 'image/jpeg' : null);
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif' && mime !== 'image/bmp') return;
    const px = imagePixelSize(bytes);
    let w = p.goalw ? (p.goalw / 20) * (p.scalex / 100) : px ? px.w * 0.75 : p.picw ? p.picw * 0.75 : null;
    let h = p.goalh ? (p.goalh / 20) * (p.scaley / 100) : px ? px.h * 0.75 : p.pich ? p.pich * 0.75 : null;
    if (w != null) w = Math.round(w * 100) / 100;
    if (h != null) h = Math.round(h * 100) / 100;
    const parent = this.groups[this.groups.length - 1];
    if (parent && parent.dest === 'sv') {
      const shape = this.shapes[this.shapes.length - 1];
      if (shape && this.spName.trim() === 'pib') shape.img = { src: toDataUrl(bytes, mime), w, h };
      return;
    }
    if (parent && (parent.dest === 'body')) this.pushInline(S.nodes.image.create({ src: toDataUrl(bytes, mime), width: w, height: h }, null, this.g.link ? [S.marks.link.create({ href: this.g.link })] : []));
  }

  /** End of a captured metadata destination (comment ranges, annotation fields). */
  finishMeta(key: string): void {
    const v = (this.meta[key] || '').trim();
    delete this.meta[key];
    if (key === 'atrfstart') { if (v) { this.activeComments.push(v); this.rangedComments.add(v); } }
    else if (key === 'atrfend') this.activeComments = this.activeComments.filter((x) => x !== v);
    else this.meta['done:' + key] = v;
  }

  finishAnnotation(text: string): void {
    const ref = this.meta['done:atnref'] || this.meta['done:atnid'] || String(++this.annotCount);
    const author = this.meta['done:atnauthor'] || 'Unknown';
    const dateRaw = this.meta['done:atndate'];
    for (const k of ['done:atnref', 'done:atnid', 'done:atnauthor', 'done:atndate']) delete this.meta[k];
    const id = 'rtf-c' + ref;
    const n = Number(dateRaw);
    this.settings.comments[id] = { id, author, date: dateRaw && Number.isFinite(n) ? dttmToMs(n) : 0, text: text.replace(/\n+$/, '').trim(), resolved: false, replies: [] };
    if (!this.rangedComments.has(ref)) {
      // A point annotation: anchor it on the preceding text run.
      for (let i = this.inlines.length - 1; i >= 0; i--) {
        const n2 = this.inlines[i];
        if (n2.isText && n2.text) { this.inlines[i] = n2.mark(S.marks.comment.create({ id }).addToSet(n2.marks)); break; }
      }
    }
  }

  finishNextGraphic(): void {
    const ng = this.nextGraphic;
    this.nextGraphic = null;
    if (!ng) return;
    const name = ng.name.trim();
    const src = this.attachments?.get(name) || this.attachments?.get(name.normalize('NFC')) || [...(this.attachments?.entries() || [])].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    this.skipAttachmentChar = true;
    if (!src) { this.emitBody(`[${name}]`); this.skipAttachmentChar = true; return; }
    this.pushInline(S.nodes.image.create({ src, alt: name.replace(/\.[^.]+$/, ''), width: ng.w ? ng.w / 20 : null, height: ng.h ? ng.h / 20 : null }));
  }

  finishShapeText(): void {
    const shape = this.shapes[this.shapes.length - 1];
    if (!shape) return;
    if (this.hasPendingContent()) this.endPara('par');
    if (this.table && !shape.saved) this.closeTable();
    const entries = this.blocks.splice(shape.blockStart);
    shape.blocks = this.finalize(entries);
    this.inlines = shape.saved || [];
    shape.saved = null;
  }

  finishShape(): void {
    const shape = this.shapes.pop();
    if (!shape) return;
    const twip = (k: string) => shape.box[k];
    const w = twip('shpright') != null && twip('shpleft') != null ? Math.abs(twip('shpright') - twip('shpleft')) / 20 : null;
    const h = twip('shpbottom') != null && twip('shptop') != null ? Math.abs(twip('shpbottom') - twip('shptop')) / 20 : null;
    if (shape.img) {
      const alt = shape.props.get('wzDescription') || shape.props.get('wzName') || '';
      const wrap = shape.props.get('fBehindDocument') === '1' ? 'behind' : null;
      this.pushInline(S.nodes.image.create({ src: shape.img.src, alt: /^(Image|Picture|Grafik)\s*\d*$/i.test(alt) ? '' : alt, width: w && w > 1 ? Math.round(w * 100) / 100 : shape.img.w, height: h && h > 1 ? Math.round(h * 100) / 100 : shape.img.h, ...(wrap ? { wrap } : {}) }));
    }
    if (shape.blocks && shape.blocks.length) {
      const fill = Number(shape.props.get('fillColor'));
      const bgr = Number.isFinite(fill) && shape.props.has('fillColor') ? '#' + [fill & 255, (fill >> 8) & 255, (fill >> 16) & 255].map((x) => x.toString(16).padStart(2, '0')).join('') : null;
      const box = S.nodes.text_box.create({ width: w && w > 1 ? String(Math.round(w)) : null, bg: shape.props.get('fFilled') === '0' ? null : bgr, border: shape.props.get('fLine') === '0' ? null : '1px solid #444' }, shape.blocks);
      if (this.g.pa.intbl && this.table) this.table.curCell.push(box); else this.blocks.push(box);
    }
  }

  parseInstruction(inst: string): { type: string; arg: string | null; format: string | null; href: string | null } {
    const t = inst.replace(/\s+/g, ' ').trim();
    const m = /^(\S+)\s*(.*)$/.exec(t) || ['', '', ''];
    const type = m[1].toUpperCase();
    const rest = m[2];
    if (type === 'HYPERLINK') {
      let url: string | null = null, tail = rest;
      const q = fieldUnquote(rest);
      if (q) { url = q.value; tail = q.rest; }
      else { const b = /^([^\s\\]+)/.exec(rest); if (b) { url = b[1]; tail = rest.slice(b[0].length); } }
      const am = /\\l\s+(.*)$/.exec(tail);
      const anchor = am ? (fieldUnquote(am[1])?.value ?? am[1].split(/\s/)[0]) : null;
      const href = url ? url + (anchor ? '#' + anchor : '') : anchor ? '#' + anchor : '';
      return { type, arg: null, format: null, href: href || null };
    }
    if (type.startsWith('=')) return { type: '=', arg: (type.slice(1) + ' ' + rest.replace(/\\#.*$/, '')).trim(), format: (/\\#\s*"([^"]*)"/.exec(rest) || [])[1] || null, href: null };
    const argM = /^"([^"]*)"|^([^\s\\]+)/.exec(rest);
    const dateFmt = /\\@\s*"([^"]*)"/.exec(rest) || /\\@\s*(\S+)/.exec(rest);
    const numFmt = /\\\*\s*(roman|ROMAN|alphabetic|ALPHABETIC|Ordinal|Arabic|arabic)\b/.exec(rest);
    return { type, arg: argM ? (argM[1] ?? argM[2]) : null, format: dateFmt ? dateFmt[1] : numFmt ? (numFmt[1] === 'arabic' ? 'Arabic' : numFmt[1]) : null, href: null };
  }

  finishField(f: FieldState): void {
    const info = this.parseInstruction(f.inst);
    if (info.type === 'HYPERLINK') return;
    const tokenFor: Record<string, string> = { PAGE: '{PAGE}', NUMPAGES: '{NUMPAGES}', DATE: '{DATE}', TIME: '{TIME}', TITLE: '{TITLE}', AUTHOR: '{AUTHOR}', FILENAME: '{FILENAME}', SECTION: '{SECTION}' };
    if (f.sink) {
      if (tokenFor[info.type] && f.resultStarted) f.sink.text = f.sink.text.slice(0, f.sinkStart) + tokenFor[info.type];
      else if (tokenFor[info.type] && !f.resultStarted) f.sink.text += tokenFor[info.type];
      return;
    }
    if (info.type === 'SYMBOL') {
      const code = parseInt(info.arg || '', 10);
      if (code > 0) this.emitBody(code === 183 ? '•' : String.fromCharCode(code));
      return;
    }
    if (!FIELD_TYPES.has(info.type)) return;
    if (!f.resultStarted) {
      this.pushInline(S.nodes.field.create({ type: info.type, arg: info.arg, format: info.format, value: '' }));
      return;
    }
    if (f.startPara !== this.paraId) return; // result spans paragraphs (e.g. TOC): keep as text
    const removed = this.inlines.splice(f.startIdx);
    const value = removed.map((n) => (n.isText ? n.text : '')).join('');
    const marks = removed.find((n) => n.isText)?.marks || [];
    this.inlines.push(S.nodes.field.create({ type: info.type, arg: info.arg, format: info.format, value }, null, marks.filter((m) => m.type !== S.marks.link)));
  }

  finishHF(sink: Sink): void {
    const lines = sink.text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (!lines.length) return;
    const text = lines.join(' ');
    const parts = text.split('\t');
    let hf: HF;
    if (parts.length >= 3) hf = { left: parts[0].trim(), center: parts[1].trim(), right: parts.slice(2).join(' ').trim() };
    else if (parts.length === 2) hf = { left: parts[0].trim(), center: parts[1].trim(), right: '' };
    else {
      const t = parts[0].trim();
      hf = sink.align === 'center' ? { left: '', center: t, right: '' } : sink.align === 'right' ? { left: '', center: '', right: t } : { left: t, center: '', right: '' };
    }
    const s = this.settings;
    switch (sink.kind) {
      case 'header': case 'headerr': s.header = hf; break;
      case 'footer': case 'footerr': s.footer = hf; break;
      case 'headerl': s.evenHeader = hf; s.differentOddEven = true; break;
      case 'footerl': s.evenFooter = hf; s.differentOddEven = true; break;
      case 'headerf': s.firstHeader = hf; s.differentFirst = true; break;
      case 'footerf': s.firstFooter = hf; s.differentFirst = true; break;
    }
  }

  // ---------------------------------------------------------------- control words

  word(w: string, param: number | null, hasParam: boolean, starred: boolean): void {
    const g = this.g;
    const on = !hasParam || param !== 0;
    const p = param ?? 0;

    // Destinations ------------------------------------------------------------------------
    if (g.dest === 'skip') {
      if (starred && w === 'ud' && g.uprDest) g.dest = g.uprDest;
      else if (w === 'bin' && param && param > 0) this.pos += param;
      return;
    }
    if (starred) {
      switch (w) {
        case 'shppict': return; // transparent: process its \pict
        case 'fldinst': if (g.field) { this.flushBytes(); g.dest = 'fldinst'; } else g.dest = 'skip'; return;
        case 'bkmkstart': if (g.dest === 'body') { g.dest = 'bkmk'; g.ownsBkmk = true; this.bkmk = ''; } else g.dest = 'skip'; return;
        case 'listtable': g.dest = 'listtable'; return;
        case 'listoverridetable': g.dest = 'listoverride'; return;
        case 'pn': g.dest = 'pn'; this.pn = this.pn || { bullet: false, level: 0, format: null, start: 1 }; return;
        case 'ud': g.dest = g.uprDest || g.dest; return;
        case 'cs': case 'ts': case 'ds': if (g.dest === 'stylesheet') { this.styleEntry = { num: p, name: '', outline: null, kind: 'char' }; g.styleEntry = true; return; } g.dest = 'skip'; return;
        case 'footnote': break;
        case 'revtbl': g.dest = 'revtbl'; this.revAuthors = []; this.revAuthorBuf = ''; return;
        case 'atrfstart': case 'atrfend': case 'atnid': case 'atnauthor': case 'atnref': case 'atndate':
          this.flushBytes(); g.dest = 'meta:' + w; g.ownsMeta = w; this.meta[w] = hasParam ? String(p) : ''; return;
        case 'annotation': {
          this.flushBytes();
          if (g.dest !== 'body') { g.dest = 'skip'; return; }
          g.sink = { text: '', align: null, kind: 'annot' };
          g.dest = 'sink'; g.ownsAnnot = true; g.ownsSink = true;
          return;
        }
        case 'shpinst': g.dest = this.shapes.length ? 'shpinst' : 'skip'; return;
        default:
          if (!this.isKnownDestination(w)) { g.dest = 'skip'; return; }
      }
    }
    switch (w) {
      // Tables / destinations
      case 'fonttbl': g.dest = 'fonttbl'; return;
      // Writers differ on whether these carry \*: both forms are the same table.
      case 'listtable': g.dest = 'listtable'; return;
      case 'listoverridetable': g.dest = 'listoverride'; return;
      case 'colortbl': g.dest = 'colortbl'; this.colors = []; return;
      case 'stylesheet': g.dest = 'stylesheet'; return;
      case 'info': g.dest = 'info'; return;
      case 'pict': this.flushBytes(); g.dest = 'pict'; g.ownsPict = true; this.pict = { type: 'unknown', hex: [], bin: [], picw: 0, pich: 0, goalw: 0, goalh: 0, scalex: 100, scaley: 100 }; return;
      case 'field': this.flushBytes(); g.field = { inst: '', hyperlink: null, resultStarted: false, startPara: this.paraId, startIdx: this.inlines.length, sinkStart: 0, sink: g.dest === 'sink' ? g.sink : null }; g.ownsField = true; return;
      case 'fldrslt': {
        this.flushBytes();
        const f = g.field;
        if (f) {
          const info = this.parseInstruction(f.inst);
          if (info.type === 'HYPERLINK' && info.href) g.link = info.href;
          f.resultStarted = true;
          f.startPara = this.paraId;
          f.startIdx = this.inlines.length;
          if (f.sink) f.sinkStart = f.sink.text.length;
          const parentDest = this.groups.length ? this.groups[this.groups.length - 1].dest : 'body';
          g.dest = parentDest === 'fldinst' ? 'skip' : (f.sink ? 'sink' : 'body');
        }
        return;
      }
      case 'footnote': {
        this.flushBytes();
        if (g.dest !== 'body') { g.dest = 'skip'; return; }
        g.sink = { text: '', align: null, kind: 'note' };
        g.dest = 'sink'; g.ownsNote = true; g.ownsSink = true; g.noteKind = 'foot';
        return;
      }
      case 'ftnalt': g.noteKind = 'end'; return;
      case 'header': case 'footer': case 'headerl': case 'headerr': case 'headerf': case 'footerl': case 'footerr': case 'footerf':
        this.flushBytes();
        g.sink = { text: '', align: null, kind: w };
        g.dest = 'sink'; g.ownsSink = true;
        return;
      case 'pntext': case 'listtext': this.flushBytes(); g.dest = 'listtext'; this.marker = this.marker || ''; return;
      case 'pn': g.dest = 'pn'; this.pn = this.pn || { bullet: false, level: 0, format: null, start: 1 }; return;
      case 'upr': g.uprDest = g.dest; g.dest = 'skip'; return;
      case 'object': return;
      case 'result': if (this.groups.length && this.groups[this.groups.length - 1].dest !== 'skip') g.dest = 'body'; return;
      case 'shp': {
        if (g.dest !== 'body' && g.dest !== 'shpinst') { g.dest = 'skip'; return; }
        this.flushBytes();
        this.shapes.push({ props: new Map(), img: null, blocks: null, box: {}, saved: null, blockStart: 0 });
        g.ownsShape = true;
        return;
      }
      case 'shprslt': {
        // The result is a fallback rendering of the shape: skip it when the shape itself was understood.
        const shape = this.shapes[this.shapes.length - 1];
        if (shape && (shape.img || shape.blocks || shape.props.has('pib'))) g.dest = 'skip';
        return;
      }
      case 'shpgrp': return;
      case 'NeXTGraphic':
        this.flushBytes();
        this.nextGraphic = { name: '', w: 0, h: 0 };
        g.dest = 'nextgraphic'; g.ownsMeta = 'nextgraphic';
        return;
      case 'sp': if (g.dest === 'shpinst') { g.dest = 'sp'; g.ownsSp = true; this.spName = ''; this.spValue = ''; } return;
      case 'sn': if (g.dest === 'sp') { this.flushBytes(); g.dest = 'sn'; } else g.dest = 'skip'; return;
      case 'sv': if (g.dest === 'sp') { this.flushBytes(); g.dest = 'sv'; } else g.dest = 'skip'; return;
      case 'shptxt': {
        const shape = this.shapes[this.shapes.length - 1];
        if (!shape || g.dest !== 'shpinst') { g.dest = 'skip'; return; }
        this.flushBytes();
        shape.saved = this.inlines; this.inlines = []; shape.blockStart = this.blocks.length;
        g.dest = 'body'; g.ownsShpTxt = true; g.pa = freshPara();
        return;
      }
      case 'shpleft': case 'shpright': case 'shptop': case 'shpbottom':
        if (this.shapes.length) this.shapes[this.shapes.length - 1].box[w] = p;
        return;
      case 'bin': {
        // The declared length can exceed what the file holds: never allocate more than remains.
        const n = Math.min(Math.max(0, p), this.s.length - this.pos);
        if (g.dest === 'pict' && this.pict) {
          const chunk = new Uint8Array(n);
          for (let k = 0; k < n && this.pos + k < this.s.length; k++) chunk[k] = this.s.charCodeAt(this.pos + k) & 0xff;
          this.pict.bin.push(chunk);
        }
        this.pos += n;
        return;
      }
    }
    if (g.dest === 'nextgraphic') {
      if (w === 'width' && this.nextGraphic) this.nextGraphic.w = p;
      else if (w === 'height' && this.nextGraphic) this.nextGraphic.h = p;
      return;
    }
    if (SKIP_DESTS.has(w)) { g.dest = 'skip'; return; }
    if (g.dest === 'info' && INFO_KEYS[w] !== undefined) { const k = INFO_KEYS[w]; g.dest = k && !(this.info[k] || '').trim() ? 'info:' + k : 'skip'; return; }
    if (g.dest === 'info' && /^(creatim|revtim|printim|buptim|version|vern|edmins|nofpages|nofwords|nofchars|nofcharsws|id|hlinkbase)$/.test(w)) { g.dest = 'skip'; return; }

    // Table-ish destinations ----------------------------------------------------------------
    if (g.dest === 'fonttbl') {
      if (w === 'f') { if (this.fontEntry && this.fontEntry.name.trim()) this.finishFont(); this.fontEntry = { num: p, name: '', charset: 0 }; }
      else if (w === 'fcharset' && this.fontEntry) this.fontEntry.charset = p;
      return;
    }
    if (g.dest === 'colortbl') {
      if (w === 'red') { this.colorCur.r = p; this.colorCur.set = true; }
      else if (w === 'green') { this.colorCur.g = p; this.colorCur.set = true; }
      else if (w === 'blue') { this.colorCur.b = p; this.colorCur.set = true; }
      return;
    }
    if (g.dest === 'stylesheet') {
      if (w === 's') { if (!this.styleEntry || this.styleEntry.kind !== 'para' || this.styleEntry.name) { this.styleEntry = { num: p, name: '', outline: null, kind: 'para' }; g.styleEntry = true; } else this.styleEntry.num = p; }
      else if (w === 'outlinelevel' && this.styleEntry) this.styleEntry.outline = p;
      else if ((w === 'cs' || w === 'ts' || w === 'ds')) { this.styleEntry = { num: p, name: '', outline: null, kind: 'char' }; g.styleEntry = true; }
      else if (!this.styleEntry && this.groups.length && this.groups[this.groups.length - 1].dest === 'stylesheet') { this.styleEntry = { num: 0, name: '', outline: null, kind: 'para' }; g.styleEntry = true; }
      return;
    }
    if (g.dest === 'listtable') {
      if (w === 'list') this.lists.push({ id: 0, levels: [] });
      else if (w === 'listlevel') { const l = this.lists[this.lists.length - 1]; if (l) l.levels.push({ nfc: 0, start: 1 }); }
      else if (w === 'levelnfc' || w === 'levelnfcn') { const l = this.lists[this.lists.length - 1]; const lv = l?.levels[l.levels.length - 1]; if (lv) lv.nfc = p; }
      else if (w === 'levelstartat') { const l = this.lists[this.lists.length - 1]; const lv = l?.levels[l.levels.length - 1]; if (lv) lv.start = p; }
      else if (w === 'listid') { const l = this.lists[this.lists.length - 1]; if (l && !l.id) l.id = p; }
      else if (w === 'leveltext') { this.flushBytes(); g.dest = 'leveltext'; }
      else if (w === 'levelnumbers' || w === 'listname') g.dest = 'skip';
      return;
    }
    if (g.dest === 'listoverride') {
      if (w === 'listoverride') (this as any)._lo = { id: 0, ls: 0 };
      else if (w === 'listid') { const lo = (this as any)._lo; if (lo) lo.id = p; if (lo && lo.ls) this.overrides.set(lo.ls, lo.id); }
      else if (w === 'ls') { const lo = (this as any)._lo; if (lo) { lo.ls = p; this.overrides.set(p, lo.id); } }
      else if (w === 'lfolevel') g.dest = 'skip';
      return;
    }
    if (g.dest === 'pn') {
      const pn = this.pn!;
      switch (w) {
        case 'pnlvlblt': pn.bullet = true; break;
        case 'pnlvlbody': pn.bullet = false; break;
        case 'pnlvlcont': break;
        case 'pnlvl': pn.level = p; break;
        case 'pndec': pn.format = 'decimal'; break;
        case 'pnlcltr': pn.format = 'lower-alpha'; break;
        case 'pnucltr': pn.format = 'upper-alpha'; break;
        case 'pnlcrm': pn.format = 'lower-roman'; break;
        case 'pnucrm': pn.format = 'upper-roman'; break;
        case 'pnstart': pn.start = p; break;
        case 'pntxta': case 'pntxtb': g.dest = 'skip'; break;
      }
      return;
    }
    if (g.dest === 'pict') {
      const pc = this.pict!;
      switch (w) {
        case 'pngblip': pc.type = 'png'; break;
        case 'jpegblip': pc.type = 'jpeg'; break;
        case 'emfblip': pc.type = 'emf'; break;
        case 'wmetafile': pc.type = 'wmf'; break;
        case 'dibitmap': case 'wbitmap': pc.type = 'dib'; break;
        case 'picw': pc.picw = p; break;
        case 'pich': pc.pich = p; break;
        case 'picwgoal': pc.goalw = p; break;
        case 'pichgoal': pc.goalh = p; break;
        case 'picscalex': pc.scalex = p || 100; break;
        case 'picscaley': pc.scaley = p || 100; break;
      }
      return;
    }

    // Document / section --------------------------------------------------------------------
    switch (w) {
      case 'ansi': this.codepage = 'windows-1252'; return;
      case 'mac': this.codepage = 'macintosh'; return;
      case 'pc': case 'pca': this.codepage = 'windows-1252'; return;
      case 'ansicpg': this.codepage = CP_LABEL[p] || 'windows-1252'; return;
      case 'deff': this.deff = p; return;
      case 'uc': g.uc = Math.max(0, p); return;
      case 'u': {
        this.flushBytes();
        const code = p < 0 ? p + 65536 : p;
        this.emit(String.fromCharCode(code));
        this.ucSkip = g.uc;
        return;
      }
      case 'paperw': if (!this.bodyStarted) this.page.w = p; return;
      case 'paperh': if (!this.bodyStarted) this.page.h = p; return;
      case 'pgwsxn': if (!this.bodyStarted) this.page.w = p; return;
      case 'pghsxn': if (!this.bodyStarted) this.page.h = p; return;
      case 'margl': case 'marglsxn': if (!this.bodyStarted) this.page.ml = p; return;
      case 'margr': case 'margrsxn': if (!this.bodyStarted) this.page.mr = p; return;
      case 'margt': case 'margtsxn': if (!this.bodyStarted) this.page.mt = p; return;
      case 'margb': case 'margbsxn': if (!this.bodyStarted) this.page.mb = p; return;
      case 'gutter': case 'guttersxn': if (!this.bodyStarted) this.page.gutter = p; return;
      case 'landscape': case 'lndscpsxn': if (!this.bodyStarted) this.page.land = true; return;
      case 'headery': if (!this.bodyStarted) this.page.hy = p; return;
      case 'footery': if (!this.bodyStarted) this.page.fy = p; return;
      case 'titlepg': this.titlepg = true; return;
      case 'facingp': this.facingp = true; return;
      case 'pgnstarts': if (!this.bodyStarted) this.settings.pageNumber.start = p || 1; return;
      case 'pgnlcrm': if (!this.bodyStarted) this.settings.pageNumber.format = 'lower-roman'; return;
      case 'pgnucrm': if (!this.bodyStarted) this.settings.pageNumber.format = 'upper-roman'; return;
      case 'pgnlcltr': if (!this.bodyStarted) this.settings.pageNumber.format = 'lower-alpha'; return;
      case 'pgnucltr': if (!this.bodyStarted) this.settings.pageNumber.format = 'upper-alpha'; return;
      case 'deftab': this.settings.defaultTab = p / 20 || 36; return;
      case 'sect': {
        if (this.hasPendingContent()) this.endPara('par');
        if (this.table) this.closeTable();
        if (g.dest === 'body') { const e = { sect: 'nextPage' }; this.blocks.push(e); this.lastSect = e; }
        return;
      }
      case 'sbknone': if (this.lastSect) this.lastSect.sect = 'continuous'; return;
      case 'sbkpage': if (this.lastSect) this.lastSect.sect = 'nextPage'; return;
      case 'sbkeven': if (this.lastSect) this.lastSect.sect = 'evenPage'; return;
      case 'sbkodd': if (this.lastSect) this.lastSect.sect = 'oddPage'; return;
      case 'sbkcol': if (this.lastSect) this.lastSect.sect = 'continuous'; return;
      case 'sectd': return;
    }

    // Breaks and special characters ------------------------------------------------------------
    switch (w) {
      case 'par': this.endPara('par'); this.lastSect = null; return;
      case 'cell': this.cell(); return;
      case 'nestcell': this.endPara('cell'); return;
      case 'nestrow': return;
      case 'row': this.row(); return;
      case 'line': this.flushBytes(); if (g.dest === 'sink') { if (g.sink) g.sink.text += ' '; } else if (g.dest === 'body') this.pushInline(S.nodes.hard_break.create(null, null, this.marks().filter((m) => m.type === S.marks.link))); return;
      case 'page': {
        this.flushBytes();
        if (g.dest !== 'body' || g.pa.intbl) { if (g.dest === 'body') this.pushInline(S.nodes.hard_break.create()); return; }
        // Split the paragraph at the break.
        if (this.inlines.length) {
          const saved = this.g.pa;
          this.endPara('par');
          this.g.pa = saved;
        } else if (this.table) this.closeTable();
        this.blocks.push(S.nodes.page_break.create());
        return;
      }
      case 'column': { this.flushBytes(); if (g.dest === 'body' && !g.pa.intbl) { if (this.inlines.length) { const saved = g.pa; this.endPara('par'); this.g.pa = saved; } this.blocks.push(S.nodes.column_break.create()); } return; }
      case 'tab': this.flushBytes(); this.emit('\t'); return;
      case 'emdash': this.flushBytes(); this.emit('—'); return;
      case 'endash': this.flushBytes(); this.emit('–'); return;
      case 'bullet': this.flushBytes(); this.emit('•'); return;
      case 'lquote': this.flushBytes(); this.emit('‘'); return;
      case 'rquote': this.flushBytes(); this.emit('’'); return;
      case 'ldblquote': this.flushBytes(); this.emit('“'); return;
      case 'rdblquote': this.flushBytes(); this.emit('”'); return;
      case 'emspace': this.flushBytes(); this.emit('\u2003'); return;
      case 'enspace': this.flushBytes(); this.emit('\u2002'); return;
      case 'qmspace': this.flushBytes(); this.emit('\u2005'); return;
      case 'zwj': this.flushBytes(); this.emit('\u200d'); return;
      case 'zwnj': this.flushBytes(); this.emit('\u200c'); return;
      case 'zwbo': this.flushBytes(); this.emit('\u200b'); return;
      case 'chpgn': this.flushBytes(); if (g.dest === 'sink') { if (g.sink) g.sink.text += '{PAGE}'; } else if (g.dest === 'body') this.pushInline(S.nodes.field.create({ type: 'PAGE', value: '1' })); return;
      case 'chftn': return;
      case 'chdate': this.flushBytes(); if (g.dest === 'sink' && g.sink) g.sink.text += '{DATE}'; return;
    }

    // Paragraph properties ---------------------------------------------------------------------
    const pa = g.pa;
    switch (w) {
      case 'pard': this.flushBytes(); g.pa = freshPara(); return;
      case 'ql': pa.align = null; return;
      case 'qc': pa.align = 'center'; return;
      case 'qr': pa.align = 'right'; return;
      case 'qj': pa.align = 'justify'; return;
      case 'qd': pa.align = 'distribute'; return;
      case 'li': case 'lin': pa.li = p; return;
      case 'ri': case 'rin': pa.ri = p; return;
      case 'fi': pa.fi = p; return;
      case 'sb': pa.sb = p; return;
      case 'sa': pa.sa = p; return;
      case 'sl': pa.sl = p; return;
      case 'slmult': pa.slmult = p; return;
      case 'keepn': pa.keepn = on; return;
      case 'keep': pa.keep = on; return;
      case 'pagebb': pa.pagebb = on; return;
      case 'outlinelevel': pa.outline = p; return;
      case 's': pa.s = p; return;
      case 'intbl': pa.intbl = true; return;
      case 'itap': if (p > 0) pa.intbl = true; return;
      case 'ls': pa.ls = p; return;
      case 'rtlpar': pa.rtl = true; return;
      case 'ltrpar': pa.rtl = false; return;
      case 'ilvl': pa.ilvl = p; return;
      case 'cbpat': pa.cbpat = p; return;
      // Borders: the side word selects the target, the following \brdr* words describe it.
      case 'brdrt': case 'brdrb': case 'brdrl': case 'brdrr': case 'box':
        if (!pa.border) pa.border = {};
        this.borderTarget = pa.border; this.borderSide = w === 'box' ? 'box' : ({ brdrt: 'top', brdrb: 'bottom', brdrl: 'left', brdrr: 'right' } as Record<string, string>)[w];
        this.borderSpec = { style: 'solid', w: 10, cf: 0 }; this.applyBorder(); return;
      case 'clbrdrt': case 'clbrdrb': case 'clbrdrl': case 'clbrdrr':
        if (!this.pendingCell.borders) this.pendingCell.borders = {};
        this.borderTarget = this.pendingCell.borders; this.borderSide = ({ clbrdrt: 'top', clbrdrb: 'bottom', clbrdrl: 'left', clbrdrr: 'right' } as Record<string, string>)[w];
        this.borderSpec = { style: 'solid', w: 10, cf: 0 }; this.applyBorder(); return;
      case 'brdrs': case 'brdrth': case 'brdrsh': case 'brdrhair': case 'brdrdb': case 'brdrdot': case 'brdrdash': case 'brdrdashsm': case 'brdrdashd': case 'brdrdashdd':
      case 'brdrtriple': case 'brdrwavy': case 'brdrinset': case 'brdroutset': case 'brdrengrave': case 'brdremboss': case 'brdrnone': case 'brdrnil': case 'brdrtbl': {
        const map: Record<string, string> = { brdrdb: 'double', brdrtriple: 'double', brdrdot: 'dotted', brdrdash: 'dashed', brdrdashsm: 'dashed', brdrdashd: 'dashed', brdrdashdd: 'dotted', brdrinset: 'inset', brdroutset: 'outset', brdrengrave: 'groove', brdremboss: 'ridge', brdrwavy: 'solid' };
        this.borderSpec.style = w === 'brdrnone' || w === 'brdrnil' || w === 'brdrtbl' ? 'none' : map[w] || 'solid';
        if (w === 'brdrth') this.borderSpec.w = Math.max(this.borderSpec.w, 30);
        this.applyBorder(); return;
      }
      case 'brdrw': this.borderSpec.w = p; this.applyBorder(); return;
      case 'brdrcf': this.borderSpec.cf = p; this.applyBorder(); return;
      // Row / cell definitions
      case 'trowd': this.borderTarget = null; this.rowDefs = []; this.pendingCell = { right: 0, mgf: false, mrg: false, vmgf: false, vmrg: false, bg: 0, valign: null }; this.rowHeader = false; return;
      case 'trhdr': this.rowHeader = true; return;
      case 'clmgf': this.pendingCell.mgf = true; return;
      case 'clmrg': this.pendingCell.mrg = true; return;
      case 'clvmgf': this.pendingCell.vmgf = true; return;
      case 'clvmrg': this.pendingCell.vmrg = true; return;
      case 'clcbpat': this.pendingCell.bg = p; return;
      case 'clvertalc': this.pendingCell.valign = 'middle'; return;
      case 'clvertalb': this.pendingCell.valign = 'bottom'; return;
      case 'clvertalt': this.pendingCell.valign = null; return;
      case 'cellx': this.rowDefs.push({ ...this.pendingCell, right: p }); this.pendingCell = { right: 0, mgf: false, mrg: false, vmgf: false, vmrg: false, bg: 0, valign: null }; return;
    }

    // Character properties ---------------------------------------------------------------------
    const c = g.ch;
    this.flushBytes();
    switch (w) {
      case 'plain': g.ch = freshChar(); return;
      case 'b': c.b = on; return;
      case 'i': c.i = on; return;
      case 'ul': c.ul = on ? 'single' : null; return;
      case 'ulnone': c.ul = null; return;
      case 'strike': c.strike = on; return;
      case 'striked': c.dstrike = on; return;
      case 'super': c.sup = on; c.sub = false; return;
      case 'sub': c.sub = on; c.sup = false; return;
      case 'nosupersub': c.sup = false; c.sub = false; return;
      case 'up': c.up = p || 6; return;
      case 'dn': c.up = -(p || 6); return;
      case 'scaps': c.scaps = on; return;
      case 'caps': c.caps = on; return;
      case 'v': c.v = on; return;
      case 'rtlch': c.rtl = true; return;
      case 'ltrch': c.rtl = false; return;
      case 'f': c.f = p; return;
      case 'fs': c.fs = p; return;
      case 'cf': c.cf = p; return;
      case 'highlight': c.hl = p; return;
      case 'cb': c.hl = p; return;
      case 'chcbpat': c.shade = p; return;
      case 'expndtw': c.expnd = p; return;
      case 'expnd': c.expnd = p * 5; return;
      case 'charscalex': c.scale = p || 100; return;
      case 'revised': c.rev = on ? 1 : 0; return;
      case 'deleted': c.rev = on ? 2 : 0; return;
      case 'revauth': c.revAuth = p; return;
      case 'revdttm': c.revDt = p; return;
      case 'revauthdel': c.revAuthDel = p; return;
      case 'revdttmdel': c.revDtDel = p; return;
    }
    if (UL_STYLES[w]) { c.ul = on ? UL_STYLES[w] : null; return; }
  }

  applyBorder(): void {
    const t = this.borderTarget;
    if (!t || !this.borderSide) return;
    const b = this.borderSpec;
    const color = (b.cf && this.colors[b.cf]) || '#000000';
    const css = b.style === 'none' ? '' : `${Math.max(0.25, Math.round((b.w / 20) * 100) / 100)}pt ${b.style} ${color}`;
    const sides = this.borderSide === 'box' ? ['top', 'right', 'bottom', 'left'] : [this.borderSide];
    for (const side of sides) { if (css) t[side] = css; else delete t[side]; }
  }

  isKnownDestination(w: string): boolean {
    return ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'field', 'fldrslt', 'footnote', 'header', 'footer', 'headerl', 'headerr', 'headerf',
      'footerl', 'footerr', 'footerf', 'pntext', 'listtext', 'shp', 'shprslt', 'result', 'object', 'title', 'subject', 'author', 'keywords', 'doccomm',
      'company', 'manager', 'category', 'upr', 'shpinst', 'shptxt', 'sp', 'sn', 'sv', 'revtbl', 'annotation', 'atnid', 'atnauthor', 'atnref', 'atndate', 'atrfstart', 'atrfend'].includes(w);
  }

  symbol(c: string): void {
    switch (c) {
      case '\\': case '{': case '}': this.byte(c.charCodeAt(0)); return;
      case '~': this.flushBytes(); this.emit('\u00a0'); return;
      case '-': this.flushBytes(); this.emit('\u00ad'); return;
      case '_': this.flushBytes(); this.emit('\u2011'); return;
      case '\n': case '\r': this.word('par', null, false, false); return;
      default: return; // \: \| etc.
    }
  }

  // ---------------------------------------------------------------- main loop

  parse(): PMNode {
    const s = this.s;
    const len = s.length;
    let starred = false;
    // Every step consumes at least one character.
    while (this.pos < len) {
      const ch = s[this.pos];
      // Groups nested deeper than any real document share the deepest state (each level copies it).
      if (ch === '{') { if (this.groups.length < RTF_MAX_DEPTH) this.pushGroup(); else this.overflow++; this.pos++; starred = false; continue; }
      if (ch === '}') { if (this.overflow) this.overflow--; else if (this.groups.length) this.popGroup(); this.pos++; starred = false; continue; }
      if (ch === '\\') {
        const nx = s[this.pos + 1];
        if (nx === undefined) { this.pos++; continue; }
        if (/[a-zA-Z]/.test(nx)) {
          let j = this.pos + 1;
          while (j < len && j - this.pos <= 32 && /[a-zA-Z]/.test(s[j])) j++;
          const w = s.slice(this.pos + 1, j);
          let k = j;
          if (s[k] === '-' && /\d/.test(s[k + 1] || '')) k++;
          while (k < len && k - j < 11 && /\d/.test(s[k])) k++;
          const hasParam = k > j;
          let param: number | null = hasParam ? parseInt(s.slice(j, k), 10) : null;
          if (param != null && !Number.isFinite(param)) param = 0;
          if (s[k] === ' ') k++;
          this.pos = k;
          if (this.ucSkip > 0 && !/^(u|par|cell|row|line|tab|page|sect|bin)$/.test(w)) { this.ucSkip--; starred = false; continue; }
          if (w !== 'u') this.ucSkip = 0;
          try { this.word(w, param, hasParam, starred); } catch { /* ignore malformed word */ }
          starred = false;
          continue;
        }
        if (nx === "'") {
          const hex = s.slice(this.pos + 2, this.pos + 4);
          this.pos += 4;
          if (/^[0-9a-fA-F]{2}$/.test(hex)) this.byte(parseInt(hex, 16));
          continue;
        }
        if (nx === '*') { starred = true; this.pos += 2; continue; }
        this.pos += 2;
        try { this.symbol(nx); } catch { /* ignore */ }
        continue;
      }
      if (this.g.dest === 'pict' && this.ucSkip === 0) {
        // Picture hex: the whole run up to the next control character at once.
        let j = this.pos + 1;
        while (j < len) { const c = s.charCodeAt(j); if (c === 92 || c === 123 || c === 125) break; j++; }
        this.pict?.hex.push(s.slice(this.pos, j));
        this.pos = j;
        continue;
      }
      if (ch === '\r' || ch === '\n') { this.pos++; continue; }
      this.byte(s.charCodeAt(this.pos) & 0xff);
      this.pos++;
    }
    // EOF
    while (this.groups.length) this.popGroup();
    this.flushBytes();
    if (this.inlines.length) this.endPara('eof');
    if (this.table) this.closeTable();
    return this.build();
  }

  build(): PMNode {
    const s = this.settings;
    const pg = this.page;
    if (pg.w && pg.h) {
      const w = pg.w / 20, h = pg.h / 20;
      const land = !!pg.land || w > h;
      s.page.width = Math.min(w, h);
      s.page.height = Math.max(w, h);
      s.page.orientation = land ? 'landscape' : 'portrait';
      const match = Object.entries(PAGE_SIZES).find(([, d]) => Math.abs(d[0] - s.page.width) < 2 && Math.abs(d[1] - s.page.height) < 2);
      s.page.sizeName = match ? match[0] : 'Custom';
    }
    if (pg.ml != null) s.page.margin.left = pg.ml / 20;
    if (pg.mr != null) s.page.margin.right = pg.mr / 20;
    if (pg.mt != null) s.page.margin.top = pg.mt / 20;
    if (pg.mb != null) s.page.margin.bottom = pg.mb / 20;
    if (pg.gutter) s.page.gutter = pg.gutter / 20;
    if (pg.hy != null) s.page.headerDist = pg.hy / 20;
    if (pg.fy != null) s.page.footerDist = pg.fy / 20;
    if (!this.titlepg) { s.differentFirst = false; }
    if (!this.facingp) { s.differentOddEven = false; }
    for (const [k, v] of Object.entries(this.info)) if (v.trim()) (s.properties as any)[k] = v.trim();
    const deffFont = this.fonts.get(this.deff)?.name || null;
    let blocks = this.finalize(this.blocks);
    if (Object.keys(this.paraStyles).length) s.styles = { ...this.paraStyles, ...s.styles };
    blocks = normalizeImportedFormatting(blocks, s, null);
    void deffFont;
    return finishDoc(blocks, s);
  }
}

/** Parse RTF text (as a binary string, one char per byte). */
export function rtfToDoc(binary: string, attachments?: Map<string, string>): PMNode {
  try {
    if (!/^\s*\{\\rtf/.test(binary.slice(0, 100))) {
      // Not RTF at all: treat as text.
      return finishDoc(binary.split(/\r?\n/).map((l) => para(l ? [S.text(l)] : [])), newSettings());
    }
    const r = new RtfReader(binary);
    if (attachments) r.attachments = attachments;
    return r.parse();
  } catch {
    const text = binary.replace(/\\[a-z]+-?\d* ?|[{}]/g, '');
    return finishDoc(text.split(/\r?\n/).filter((l) => l.trim()).map((l) => para([S.text(l)])), newSettings());
  }
}

export async function importRtf(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const u8 = new Uint8Array(data);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
  return rtfToDoc(bin);
}
