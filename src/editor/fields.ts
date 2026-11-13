/** Field codes: computation, formatting and updating. */
import type { EditorState, Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { normalizeSettings, type DocSettings } from './settings';
import { formatNumber, toRoman } from './plugins/decorations';
import { countWords, docText } from './ops';

export interface FieldContext {
  settings: DocSettings;
  fileName: string;
  userName: string;
  userInitials: string;
  pageOf: (pos: number) => number;
  pages: number;
  created?: number;
  saved?: number;
  mergeRecord?: Record<string, string> | null;
  mergeIndex?: number;
  doc: PMNode;
}

export const FIELD_TYPES: { type: string; label: string; arg?: string; formats?: string[]; group: string }[] = [
  { type: 'DATE', label: 'Current date', formats: ['M/d/yyyy', 'MMMM d, yyyy', 'dddd, MMMM d, yyyy', 'd MMMM yyyy', 'yyyy-MM-dd', 'd/M/yyyy', 'MMM d, yy', 'MMMM yyyy'], group: 'Date and Time' },
  { type: 'TIME', label: 'Current time', formats: ['h:mm am/pm', 'h:mm:ss am/pm', 'HH:mm', 'HH:mm:ss'], group: 'Date and Time' },
  { type: 'CREATEDATE', label: 'Date created', formats: ['M/d/yyyy', 'MMMM d, yyyy', 'yyyy-MM-dd'], group: 'Date and Time' },
  { type: 'SAVEDATE', label: 'Date last saved', formats: ['M/d/yyyy', 'MMMM d, yyyy', 'yyyy-MM-dd'], group: 'Date and Time' },
  { type: 'PRINTDATE', label: 'Date last printed', formats: ['M/d/yyyy', 'MMMM d, yyyy'], group: 'Date and Time' },
  { type: 'PAGE', label: 'Page number', formats: ['Arabic', 'roman', 'ROMAN', 'alphabetic', 'ALPHABETIC', 'Ordinal'], group: 'Numbering' },
  { type: 'NUMPAGES', label: 'Number of pages', formats: ['Arabic', 'roman', 'ROMAN'], group: 'Document Information' },
  { type: 'NUMWORDS', label: 'Number of words', group: 'Document Information' },
  { type: 'NUMCHARS', label: 'Number of characters', group: 'Document Information' },
  { type: 'AUTHOR', label: 'Author', group: 'Document Information' },
  { type: 'TITLE', label: 'Title', group: 'Document Information' },
  { type: 'SUBJECT', label: 'Subject', group: 'Document Information' },
  { type: 'KEYWORDS', label: 'Keywords', group: 'Document Information' },
  { type: 'COMMENTS', label: 'Comments property', group: 'Document Information' },
  { type: 'FILENAME', label: 'File name', group: 'Document Information' },
  { type: 'DOCPROPERTY', label: 'Document property', arg: 'Property name', group: 'Document Information' },
  { type: 'DOCVARIABLE', label: 'Document variable', arg: 'Variable name', group: 'Document Automation' },
  { type: 'USERNAME', label: 'User name', group: 'User Information' },
  { type: 'USERINITIALS', label: 'User initials', group: 'User Information' },
  { type: 'SEQ', label: 'Sequence number', arg: 'Identifier (e.g. Figure)', formats: ['Arabic', 'roman', 'ROMAN', 'alphabetic', 'ALPHABETIC'], group: 'Numbering' },
  { type: 'REF', label: 'Bookmark text', arg: 'Bookmark name', group: 'Links and References' },
  { type: 'PAGEREF', label: 'Page of bookmark', arg: 'Bookmark name', group: 'Links and References' },
  { type: 'STYLEREF', label: 'Text of nearest style', arg: 'Style name', group: 'Links and References' },
  { type: 'MERGEFIELD', label: 'Merge field', arg: 'Field name', group: 'Mail Merge' },
  { type: 'MERGEREC', label: 'Merge record number', group: 'Mail Merge' },
  { type: 'FILLIN', label: 'Prompt for text', arg: 'Prompt', group: 'Mail Merge' },
  { type: 'QUOTE', label: 'Literal text', arg: 'Text', group: 'Document Automation' },
  { type: '=', label: 'Formula', arg: 'Expression (e.g. 2*(3+4))', formats: ['0', '0.00', '#,##0', '#,##0.00', '$#,##0.00', '0%'], group: 'Equations and Formulas' },
  { type: 'SECTION', label: 'Section number', group: 'Numbering' },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const tokens: Record<string, () => string> = {
    yyyy: () => String(d.getFullYear()), yy: () => pad(d.getFullYear() % 100),
    MMMM: () => MONTHS[d.getMonth()], MMM: () => MONTHS[d.getMonth()].slice(0, 3), MM: () => pad(d.getMonth() + 1), M: () => String(d.getMonth() + 1),
    dddd: () => DAYS[d.getDay()], ddd: () => DAYS[d.getDay()].slice(0, 3), dd: () => pad(d.getDate()), d: () => String(d.getDate()),
    HH: () => pad(d.getHours()), H: () => String(d.getHours()),
    hh: () => pad(((d.getHours() + 11) % 12) + 1), h: () => String(((d.getHours() + 11) % 12) + 1),
    mm: () => pad(d.getMinutes()), ss: () => pad(d.getSeconds()),
    'am/pm': () => (d.getHours() < 12 ? 'am' : 'pm'), 'AM/PM': () => (d.getHours() < 12 ? 'AM' : 'PM'),
  };
  const re = /yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|ss|am\/pm|AM\/PM|'[^']*'/g;
  return fmt.replace(re, (t) => (t.startsWith("'") ? t.slice(1, -1) : tokens[t]()));
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return n + s;
}

export function formatPageNumber(n: number, fmt: string | null): string {
  switch (fmt) {
    case 'roman': return toRoman(n).toLowerCase();
    case 'ROMAN': return toRoman(n);
    case 'alphabetic': return formatNumber(n, 'lower-alpha');
    case 'ALPHABETIC': return formatNumber(n, 'upper-alpha');
    case 'Ordinal': return ordinal(n);
    case 'lower-roman': return toRoman(n).toLowerCase();
    case 'upper-roman': return toRoman(n);
    case 'lower-alpha': return formatNumber(n, 'lower-alpha');
    case 'upper-alpha': return formatNumber(n, 'upper-alpha');
    default: return String(n);
  }
}

/**
 * A physical 1-based page as the document numbers it: the page-numbering start and format
 * applied. Footers, PAGE, PAGEREF, the TOC and cross-references all use this.
 */
export function displayPage(page: number, settings: DocSettings, fmt?: string | null): string {
  const start = Number(settings.pageNumber?.start);
  return formatPageNumber(page + (Number.isFinite(start) ? Math.trunc(start) : 1) - 1, fmt || settings.pageNumber?.format || 'decimal');
}

/** Safe arithmetic evaluator for "=" formula fields (numbers, + - * / ^ %, parentheses, SUM/AVERAGE/MIN/MAX/ROUND/ABS). */
export function evalFormula(expr: string, vars: Record<string, number> = {}): number {
  const src = expr.replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];
  const num = (): number => {
    const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    const id = /^[A-Za-z_][\w]*/.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      const name = id[0].toUpperCase();
      if (peek() === '(') {
        i++;
        const args: number[] = [];
        if (peek() !== ')') { args.push(expr0()); while (peek() === ',') { i++; args.push(expr0()); } }
        if (peek() !== ')') throw new Error('Expected )');
        i++;
        switch (name) {
          case 'SUM': return args.reduce((a, b) => a + b, 0);
          case 'AVERAGE': return args.reduce((a, b) => a + b, 0) / (args.length || 1);
          case 'MIN': return Math.min(...args);
          case 'MAX': return Math.max(...args);
          case 'ROUND': return Math.round(args[0] * 10 ** (args[1] || 0)) / 10 ** (args[1] || 0);
          case 'ABS': return Math.abs(args[0]);
          case 'INT': return Math.trunc(args[0]);
          case 'MOD': return args[0] % args[1];
          case 'SQRT': return Math.sqrt(args[0]);
          case 'PRODUCT': return args.reduce((a, b) => a * b, 1);
          case 'COUNT': return args.length;
          default: throw new Error('Unknown function ' + name);
        }
      }
      if (name in vars) return vars[name];
      if (id[0] in vars) return vars[id[0]];
      if (name === 'PI') return Math.PI;
      throw new Error('Unknown name ' + id[0]);
    }
    if (peek() === '(') { i++; const v = expr0(); if (peek() !== ')') throw new Error('Expected )'); i++; return v; }
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    throw new Error('Syntax error');
  };
  const factor = (): number => {
    let v = num();
    while (peek() === '%') { i++; v /= 100; }
    if (peek() === '^') { i++; v = v ** factor(); }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = src[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const expr0 = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const v = expr0();
  if (i < src.length) throw new Error('Unexpected ' + src.slice(i));
  return v;
}

export function formatNumberPicture(n: number, pic: string | null): string {
  if (!pic) return String(Math.round(n * 1e10) / 1e10);
  const pct = pic.endsWith('%');
  if (pct) n *= 100;
  const dec = (pic.split('.')[1] || '').replace(/[^0#]/g, '').length;
  const grouping = pic.includes(',');
  let s = n.toFixed(dec);
  if (grouping) {
    const [a, b] = s.split('.');
    s = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b ? '.' + b : '');
  }
  const prefix = (/^[^#0]*/.exec(pic) || [''])[0].replace(/[,.]/g, '');
  return prefix + s + (pct ? '%' : '');
}

function bookmarkInfo(doc: PMNode, name: string): { pos: number; text: string } | null {
  let out: { pos: number; text: string } | null = null;
  doc.descendants((n, pos, parent) => {
    if (out) return false;
    if (n.type === schema.nodes.bookmark && n.attrs.name === name) {
      const $p = doc.resolve(pos);
      const textAfter = $p.parent.textBetween($p.parentOffset, $p.parent.content.size, ' ', ' ');
      out = { pos, text: textAfter.trim() || (parent ? parent.textContent : '') };
      return false;
    }
    return true;
  });
  return out;
}

function ownValue(obj: object | null | undefined, key: string | null | undefined): unknown {
  return obj && key != null && Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Compute display values for every field in the document in one pass (SEQ needs order). */
export function computeFields(ctx: FieldContext, onlyRange?: { from: number; to: number }): { pos: number; value: string }[] {
  const out: { pos: number; value: string }[] = [];
  const seq = new Map<string, number>();
  const s = ctx.settings;
  const now = new Date();
  const text = docText(ctx.doc);
  let section = 1;
  ctx.doc.descendants((node, pos) => {
    if (node.type === schema.nodes.section_break) section++;
    if (node.type !== schema.nodes.field) return true;
    const { type, arg, format, locked } = node.attrs;
    let v = node.attrs.value as string;
    if (type === 'SEQ') {
      const id = (arg || 'Figure').trim();
      const n = (seq.get(id) || 0) + 1;
      seq.set(id, n);
      v = formatPageNumber(n, format);
    }
    if (onlyRange && (pos < onlyRange.from || pos > onlyRange.to)) return true;
    if (locked) return true;
    try {
      switch (type) {
        case 'DATE': v = formatDate(now, format || 'M/d/yyyy'); break;
        case 'TIME': v = formatDate(now, format || 'h:mm am/pm'); break;
        case 'CREATEDATE': v = formatDate(new Date(ctx.created || Date.now()), format || 'M/d/yyyy'); break;
        case 'SAVEDATE': v = ctx.saved ? formatDate(new Date(ctx.saved), format || 'M/d/yyyy') : '(not saved)'; break;
        case 'PRINTDATE': v = formatDate(now, format || 'M/d/yyyy'); break;
        case 'PAGE': v = displayPage(ctx.pageOf(pos), s, format); break;
        case 'NUMPAGES': v = formatPageNumber(ctx.pages, format); break;
        case 'NUMWORDS': v = String(countWords(text)); break;
        case 'NUMCHARS': v = String(text.replace(/\s/g, '').length); break;
        case 'AUTHOR': v = s.properties.author || ctx.userName; break;
        case 'TITLE': v = s.properties.title || ctx.fileName.replace(/\.[^.]+$/, ''); break;
        case 'SUBJECT': v = s.properties.subject || ''; break;
        case 'KEYWORDS': v = s.properties.keywords || ''; break;
        case 'COMMENTS': v = s.properties.comments || ''; break;
        case 'FILENAME': v = ctx.fileName; break;
        // Own keys only, so names like "constructor" or "__proto__" do not reach Object.prototype.
        case 'DOCPROPERTY': v = String(ownValue(s.properties, arg?.toLowerCase()) ?? ownValue(s.customProps, arg) ?? ''); break;
        case 'DOCVARIABLE': v = String(ownValue(s.variables, arg) ?? ''); break;
        case 'USERNAME': v = ctx.userName; break;
        case 'USERINITIALS': v = ctx.userInitials; break;
        case 'REF': v = bookmarkInfo(ctx.doc, arg)?.text ?? 'Error! Reference source not found.'; break;
        case 'PAGEREF': { const b = bookmarkInfo(ctx.doc, arg); v = b ? displayPage(ctx.pageOf(b.pos), s, format) : 'Error! Bookmark not defined.'; break; }
        case 'STYLEREF': {
          let found = '';
          ctx.doc.nodesBetween(0, pos, (n) => { if (n.type === schema.nodes.paragraph && n.attrs.style === arg) found = n.textContent; return true; });
          v = found || 'Error! No text of specified style in document.';
          break;
        }
        case 'MERGEFIELD': v = ctx.mergeRecord ? (ctx.mergeRecord[arg] ?? '') : `«${arg}»`; break;
        case 'MERGEREC': v = ctx.mergeIndex != null ? String(ctx.mergeIndex + 1) : '«MERGEREC»'; break;
        case 'QUOTE': v = arg || ''; break;
        case 'FILLIN': v = node.attrs.value || ''; break;
        case '=': v = formatNumberPicture(evalFormula(arg || '0'), format); break;
        case 'SECTION': v = String(section); break;
        case 'SEQ': break;
        default: break;
      }
    } catch (e: any) {
      v = '!Syntax Error, ' + (e?.message || '');
    }
    if (v !== node.attrs.value) out.push({ pos, value: v });
    return true;
  });
  return out;
}

export function applyFieldValues(tr: Transaction, updates: { pos: number; value: string }[]): Transaction {
  for (const u of updates) {
    const node = tr.doc.nodeAt(u.pos);
    if (node && node.type === schema.nodes.field) tr.setNodeMarkup(u.pos, undefined, { ...node.attrs, value: u.value });
  }
  return tr;
}

/** Expand header/footer tokens such as {PAGE}, {NUMPAGES}, {DATE:MMMM d, yyyy}. */
export function expandTokens(template: string, ctx: { page: number; pages: number; settings: DocSettings; fileName: string; userName: string; section?: number }): string {
  return template.replace(/\{([A-Z=]+)(?::([^}]*))?\}/g, (_m, t: string, arg?: string) => {
    const s = ctx.settings;
    switch (t) {
      case 'PAGE': return displayPage(ctx.page, s, arg);
      case 'NUMPAGES': return formatPageNumber(ctx.pages, arg || null);
      case 'DATE': return formatDate(new Date(), arg || 'M/d/yyyy');
      case 'TIME': return formatDate(new Date(), arg || 'h:mm am/pm');
      case 'TITLE': return s.properties.title || ctx.fileName.replace(/\.[^.]+$/, '');
      case 'AUTHOR': return s.properties.author || ctx.userName;
      case 'FILENAME': return ctx.fileName;
      case 'SUBJECT': return s.properties.subject;
      case 'COMPANY': return s.properties.company;
      case 'SECTION': return String(ctx.section || 1);
      default: return _m;
    }
  });
}

export function settingsFromState(state: EditorState): DocSettings {
  return normalizeSettings(state.doc.attrs.settings);
}
