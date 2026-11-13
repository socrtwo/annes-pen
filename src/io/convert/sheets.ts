/**
 * Spreadsheets into documents: every sheet becomes a table (cell values as the spreadsheet shows
 * them, with dates formatted), preceded by the sheet name when there are several sheets.
 *
 * Minimal readers, written from the published formats: Office Open XML (xlsx), OpenDocument
 * (ods/fods), Excel BIFF2-BIFF8 (xls, including Excel 5/95 and Works spreadsheets), CSV/TSV
 * (RFC 4180), dBASE (dbf) and Lotus 1-2-3 (wks/wk1, wk3/wk4 values).
 */
import { loadZip } from '../zip';
import type { Node as PMNode } from 'prosemirror-model';
import { openCfb, le } from '../cfb';
import { DocBuilder } from '../legacy/builder';
import { decodeCodepage } from '../legacy/codepage';

export type Cell = string | number | boolean | Date | null;
export interface Sheet { name: string; rows: Cell[][] }

const u8a = (d: ArrayBuffer | Uint8Array) => (d instanceof Uint8Array ? d : new Uint8Array(d));
/** Rows and columns imported per sheet (a table larger than this is cut, with a note). */
export const MAX_ROWS = 5000;
export const MAX_COLS = 64;
/** Cells imported per sheet (rows are cut to stay within it). */
export const MAX_CELLS = 50_000;

function put(rows: Cell[][], r: number, c: number, v: Cell): void {
  if (r < 0 || c < 0 || r >= MAX_ROWS * 4 || c >= 16384) return;
  while (rows.length <= r) rows.push([]);
  rows[r][c] = v;
}

// ---------------------------------------------------------------------------------------
// Values

/** Excel serial date (1900 system) to a Date (UTC). */
export function excelDate(n: number, date1904 = false): Date {
  const days = date1904 ? n + 1462 : n;
  return new Date(Math.round((days - 25569) * 86400000));
}

export function isDateFormat(code: string | number): boolean {
  if (typeof code === 'number') return (code >= 14 && code <= 22) || (code >= 45 && code <= 47) || (code >= 27 && code <= 36) || (code >= 50 && code <= 58);
  const c = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dmyhs]/i.test(c) && !/^[#0.,% ]*$/.test(c);
}

export function cellText(v: Cell): string {
  if (v == null) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

// ---------------------------------------------------------------------------------------
// CSV / TSV

export function parseDelimited(text: string, sep?: string): Cell[][] {
  const t = text.replace(/^﻿/, '');
  if (!sep) {
    const first = t.split(/\r?\n/, 5).join('\n');
    const count = (ch: string) => (first.match(new RegExp(ch === '\t' ? '\t' : '\\' + ch, 'g')) || []).length;
    sep = [',', ';', '\t', '|'].sort((a, b) => count(b) - count(a))[0];
  }
  const rows: Cell[][] = [];
  let row: Cell[] = [], field = '', q = false, quoted = false;
  const endField = () => { row.push(quoted ? field : field.trim() === '' ? null : /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(field.trim()) && !/^0\d/.test(field.trim()) ? Number(field.trim()) : field); field = ''; quoted = false; };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field === '') { q = true; quoted = true; }
    else if (ch === sep) endField();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; endField(); rows.push(row); row = []; if (rows.length > MAX_ROWS * 4) break; }
    else field += ch;
  }
  if (field || row.length) { endField(); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------------------
// Office Open XML

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el: Element | Document, local: string) => Array.from(el.getElementsByTagNameNS('*', local));
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  const zip = await loadZip(data);
  const text = async (p: string) => { const f = zip.file(p) || zip.file(p.replace(/^\//, '')); return f ? f.async('string') : ''; };
  const wb = xml(await text('xl/workbook.xml'));
  const date1904 = kids(wb, 'workbookPr').some((e) => /^(1|true)$/.test(e.getAttribute('date1904') || ''));
  const rels = xml(await text('xl/_rels/workbook.xml.rels'));
  const target = new Map(kids(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target') || '']));
  const sst: string[] = [];
  const ss = await text('xl/sharedStrings.xml');
  if (ss) for (const si of kids(xml(ss), 'si')) sst.push(kids(si, 't').filter((t) => (t.parentNode as Element)?.localName !== 'rPh').map((t) => t.textContent || '').join(''));
  // Number formats → which cell styles are dates.
  const dateXf = new Set<number>();
  const st = await text('xl/styles.xml');
  if (st) {
    const sd = xml(st);
    const custom = new Map(kids(sd, 'numFmt').map((n) => [Number(n.getAttribute('numFmtId')), n.getAttribute('formatCode') || '']));
    const xfs = kids(sd, 'cellXfs')[0];
    if (xfs) Array.from(xfs.children).forEach((xf, i) => { const id = Number(xf.getAttribute('numFmtId') || 0); if (isDateFormat(custom.get(id) ?? id)) dateXf.add(i); });
  }
  const sheets: Sheet[] = [];
  for (const s of kids(wb, 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id') || '';
    let path = target.get(rid) || '';
    if (!path) continue;
    path = path.startsWith('/') ? path.slice(1) : 'xl/' + path.replace(/^\.\//, '');
    const sx = await text(path);
    if (!sx) continue;
    const rows: Cell[][] = [];
    let rAuto = 0;
    for (const row of kids(xml(sx), 'row')) {
      const r = Number(row.getAttribute('r') || rAuto + 1) - 1;
      rAuto = r + 1;
      if (r >= MAX_ROWS) break;
      let cAuto = 0;
      for (const c of Array.from(row.children).filter((e) => e.localName === 'c')) {
        const ref = c.getAttribute('r');
        const col = ref ? colIndex(ref) : cAuto;
        cAuto = col + 1;
        const t = c.getAttribute('t') || 'n';
        const v = Array.from(c.children).find((e) => e.localName === 'v')?.textContent ?? null;
        let val: Cell = null;
        if (t === 's') val = v != null ? sst[Number(v)] ?? '' : null;
        else if (t === 'inlineStr') val = kids(c, 't').map((x) => x.textContent || '').join('');
        else if (t === 'str' || t === 'e') val = v;
        else if (t === 'b') val = v === '1';
        else if (v != null && v !== '') { const n = Number(v); val = dateXf.has(Number(c.getAttribute('s') || 0)) ? excelDate(n, date1904) : n; }
        if (val != null && val !== '') put(rows, r, col, val);
      }
    }
    sheets.push({ name: s.getAttribute('name') || `Sheet${sheets.length + 1}`, rows });
  }
  return sheets;
}

// ---------------------------------------------------------------------------------------
// OpenDocument

export async function readOds(data: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  const u8 = u8a(data);
  let content: string;
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const zip = await loadZip(u8);
    content = (await zip.file('content.xml')?.async('string')) || '';
  } else content = new TextDecoder().decode(u8);
  const d = xml(content);
  const T = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0', O = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
  const sheets: Sheet[] = [];
  for (const t of kids(d, 'table').filter((e) => e.namespaceURI === T)) {
    const rows: Cell[][] = [];
    let r = 0;
    for (const row of Array.from(t.getElementsByTagNameNS(T, 'table-row'))) {
      const rep = Math.min(Number(row.getAttributeNS(T, 'number-rows-repeated') || 1), MAX_ROWS);
      const cells: Cell[] = [];
      for (const c of Array.from(row.children).filter((e) => e.localName === 'table-cell' || e.localName === 'covered-table-cell')) {
        const n = Math.min(Number(c.getAttributeNS(T, 'number-columns-repeated') || 1), MAX_COLS * 4);
        const type = c.getAttributeNS(O, 'value-type');
        const txt = Array.from(c.children).filter((e) => e.localName === 'p').map((p) => p.textContent || '').join('\n');
        let v: Cell = txt || null;
        if (type === 'float' || type === 'percentage' || type === 'currency') v = txt || Number(c.getAttributeNS(O, 'value'));
        for (let k = 0; k < n; k++) cells.push(v);
      }
      while (cells.length && cells[cells.length - 1] == null) cells.pop();
      if (!cells.length && rep > 1) { r += rep; continue; }
      for (let k = 0; k < rep && r < MAX_ROWS; k++) { cells.forEach((v, c) => { if (v != null) put(rows, r, c, v); }); r++; }
      if (r >= MAX_ROWS) break;
    }
    sheets.push({ name: t.getAttributeNS(T, 'name') || `Sheet${sheets.length + 1}`, rows });
  }
  return sheets;
}

// ---------------------------------------------------------------------------------------
// Excel BIFF2-8

export function readXls(data: ArrayBuffer | Uint8Array): Sheet[] {
  const u8 = u8a(data);
  const cfb = openCfb(u8);
  const wb = cfb ? cfb.read('Workbook') || cfb.read('Book') || cfb.read('WORKBOOK') : u8;
  if (!wb) throw new Error('No workbook stream was found');
  if (cfb && cfb.find('EncryptionInfo')) throw new Error('This workbook is password-protected');
  let biff = 8, codepage = 1252, date1904 = false;
  const sst: string[] = [];
  const fmts = new Map<number, string>();
  const xfFmt: number[] = [];
  const bounds: { name: string; pos: number }[] = [];
  const sheets: Sheet[] = [];
  let cur: Sheet | null = null;
  let pendingString: { r: number; c: number } | null = null;
  const dec8 = (b: Uint8Array) => decodeCodepage(b, codepage);
  /** XLUnicodeString (BIFF8: 16-bit length) or byte string (BIFF2-5). */
  const str = (b: Uint8Array, p: number, lenBytes: 1 | 2): string => {
    const n = lenBytes === 2 ? le.u16(b, p) : b[p];
    p += lenBytes;
    if (biff < 8) return dec8(b.subarray(p, p + n));
    const f = b[p++];
    if (f & 8) p += 2;
    if (f & 4) p += 4;
    if (f & 1) { let s = ''; for (let i = 0; i < n && p + 1 < b.length; i++, p += 2) s += String.fromCharCode(le.u16(b, p)); return s; }
    return decodeCodepage(b.subarray(p, p + n), 1252);
  };
  const f64 = (b: Uint8Array, p: number) => new DataView(b.buffer, b.byteOffset + p, 8).getFloat64(0, true);
  const rk = (v: number): number => {
    let n: number;
    if (v & 2) n = v >> 2;
    else { const buf = new DataView(new ArrayBuffer(8)); buf.setUint32(4, v & 0xfffffffc, true); n = buf.getFloat64(0, true); }
    return v & 1 ? n / 100 : n;
  };
  const num = (r: number, c: number, xf: number, v: number) => {
    if (!cur) return;
    const f = fmts.get(xfFmt[xf]) ?? xfFmt[xf];
    put(cur.rows, r, c, f != null && isDateFormat(f) ? excelDate(v, date1904) : v);
  };
  // Records, with SST CONTINUE handling.
  const recs: { op: number; d: Uint8Array; at: number }[] = [];
  for (let p = 0; p + 4 <= wb.length; ) {
    const op = le.u16(wb, p), len = le.u16(wb, p + 2);
    recs.push({ op, d: wb.subarray(p + 4, Math.min(wb.length, p + 4 + len)), at: p });
    p += 4 + len;
    if (recs.length > 2000000) break;
  }
  for (let k = 0; k < recs.length; k++) {
    const { op, d, at } = recs[k];
    switch (op) {
      case 0x0809: case 0x0409: case 0x0209: case 0x0009: {
        const v = le.u16(d, 0);
        biff = op === 0x0009 ? 2 : op === 0x0209 ? 3 : op === 0x0409 ? 4 : v === 0x0500 ? 5 : 8;
        const type = le.u16(d, 2);
        if (type === 0x10 || type === 0x0010 || (op !== 0x0809 && type !== 0x0100)) {
          const b = bounds.find((x) => x.pos === at);
          cur = { name: b?.name || (bounds.length ? `Sheet${sheets.length + 1}` : 'Sheet1'), rows: [] };
          sheets.push(cur);
        }
        break;
      }
      case 0x0042: codepage = le.u16(d, 0) === 1200 ? 1252 : le.u16(d, 0); break;
      case 0x0022: date1904 = le.u16(d, 0) === 1; break;
      case 0x0085: bounds.push({ pos: le.u32(d, 0), name: biff >= 8 ? str(d, 6, 1) : dec8(d.subarray(7, 7 + d[6])) }); break;
      case 0x041e: case 0x001e: {
        if (biff >= 8) fmts.set(le.u16(d, 0), str(d, 2, 2));
        else if (biff >= 5) fmts.set(le.u16(d, 0), dec8(d.subarray(3, 3 + d[2])));
        break;
      }
      case 0x00e0: xfFmt.push(biff >= 8 ? le.u16(d, 2) : biff >= 5 ? le.u16(d, 2) : d[1]); break;
      case 0x0443: case 0x0243: xfFmt.push(d[1]); break;
      case 0x00fc: {
        // SST: strings may continue into CONTINUE records, re-announcing their 8/16-bit flag.
        const parts = [d];
        while (recs[k + 1]?.op === 0x003c) parts.push(recs[++k].d);
        let pi = 0, p = 8;
        // The count is file-supplied: every string takes at least 3 bytes, so cap it by the data.
        let bytesLeft = -8;
        for (const x of parts) bytesLeft += x.length;
        const total = Math.min(le.u32(d, 4), Math.max(0, Math.floor(bytesLeft / 3)));
        const need = () => { if (p >= parts[pi].length && pi + 1 < parts.length) { pi++; p = 0; } return parts[pi]; };
        for (let i = 0; i < total && pi < parts.length; i++) {
          let b = need();
          if (p + 3 > b.length && pi + 1 >= parts.length) break; // data exhausted
          const n = le.u16(b, p); p += 2;
          b = need();
          let f = b[p++];
          let rich = 0, ext = 0;
          if (f & 8) { rich = le.u16(b, p); p += 2; }
          if (f & 4) { ext = le.u32(b, p); p += 4; }
          let s = '';
          while (s.length < n) {
            b = need();
            if (p >= b.length) break;
            const wide = f & 1;
            const avail = wide ? Math.floor((b.length - p) / 2) : b.length - p;
            const take = Math.min(n - s.length, avail);
            if (wide) { for (let q = 0; q < take; q++) s += String.fromCharCode(le.u16(b, p + q * 2)); p += take * 2; }
            else { s += decodeCodepage(b.subarray(p, p + take), 1252); p += take; }
            if (s.length < n) { if (pi + 1 >= parts.length) break; pi++; p = 0; f = parts[pi][p++]; }
          }
          sst.push(s);
          let skip = rich * 4 + ext;
          while (skip > 0 && pi < parts.length) { const b2 = parts[pi]; const step = Math.min(skip, b2.length - p); p += step; skip -= step; if (skip > 0) { pi++; p = 0; } }
        }
        break;
      }
      case 0x00fd: if (cur) put(cur.rows, le.u16(d, 0), le.u16(d, 2), sst[le.u32(d, 6)] ?? ''); break;
      case 0x0204: if (cur) put(cur.rows, le.u16(d, 0), le.u16(d, 2), biff >= 8 ? str(d, 6, 2) : dec8(d.subarray(8, 8 + le.u16(d, 6)))); break;
      case 0x0004: if (cur) put(cur.rows, le.u16(d, 0), le.u16(d, 2), dec8(d.subarray(8, 8 + d[7]))); break;
      case 0x00d6: if (cur) put(cur.rows, le.u16(d, 0), le.u16(d, 2), biff >= 8 ? str(d, 6, 2) : dec8(d.subarray(8, 8 + le.u16(d, 6)))); break;
      case 0x0203: if (d.length >= 14) num(le.u16(d, 0), le.u16(d, 2), le.u16(d, 4), f64(d, 6)); break;
      case 0x0003: if (d.length >= 15) num(le.u16(d, 0), le.u16(d, 2), 0, f64(d, 7)); break;
      case 0x0002: num(le.u16(d, 0), le.u16(d, 2), 0, le.u16(d, 7)); break;
      case 0x027e: num(le.u16(d, 0), le.u16(d, 2), le.u16(d, 4), rk(le.u32(d, 6))); break;
      case 0x00bd: {
        const r = le.u16(d, 0), c0 = le.u16(d, 2), c1 = le.u16(d, d.length - 2);
        for (let c = c0, p = 4; c <= c1 && p + 6 <= d.length; c++, p += 6) num(r, c, le.u16(d, p), rk(le.u32(d, p + 2)));
        break;
      }
      case 0x0006: case 0x0206: case 0x0406: {
        const r = le.u16(d, 0), c = le.u16(d, 2), xf = le.u16(d, 4);
        const resAt = biff === 2 ? 7 : 6;
        if (le.u16(d, resAt + 6) === 0xffff) {
          const kind = d[resAt];
          if (kind === 0) pendingString = { r, c };
          else if (kind === 1 && cur) put(cur.rows, r, c, !!d[resAt + 2]);
        } else if (d.length >= resAt + 8) num(r, c, xf, f64(d, resAt));
        break;
      }
      case 0x0207: case 0x0007: if (pendingString && cur) { put(cur.rows, pendingString.r, pendingString.c, biff >= 8 ? str(d, 0, 2) : biff === 2 ? dec8(d.subarray(1, 1 + d[0])) : dec8(d.subarray(2, 2 + le.u16(d, 0)))); pendingString = null; } break;
      case 0x0205: if (cur && d[biff >= 3 ? 7 : 8] === 0) put(cur.rows, le.u16(d, 0), le.u16(d, 2), !!d[biff >= 3 ? 6 : 7]); break;
    }
  }
  return sheets;
}

// ---------------------------------------------------------------------------------------
// dBASE

export function readDbf(data: ArrayBuffer | Uint8Array): Sheet[] {
  const u8 = u8a(data);
  const n = le.u32(u8, 4), hlen = le.u16(u8, 8), rlen = le.u16(u8, 10);
  const ld = u8[29];
  const cp = ({ 0x01: 437, 0x02: 850, 0x03: 1252, 0x57: 1252, 0x64: 852, 0x65: 866, 0x6a: 737, 0x7a: 936, 0xc8: 1250, 0xc9: 1251, 0xca: 1254, 0xcb: 1253, 0x4d: 936, 0x4e: 949, 0x4f: 950, 0x7b: 932 } as Record<number, number>)[ld] || 1252;
  const fields: { name: string; type: string; len: number; dec: number }[] = [];
  for (let p = 32; p + 32 <= hlen && u8[p] !== 0x0d; p += 32) {
    let name = '';
    for (let i = 0; i < 11 && u8[p + i]; i++) name += String.fromCharCode(u8[p + i]);
    fields.push({ name, type: String.fromCharCode(u8[p + 11]), len: u8[p + 16], dec: u8[p + 17] });
  }
  const rows: Cell[][] = [fields.map((f) => f.name)];
  for (let r = 0; r < Math.min(n, MAX_ROWS); r++) {
    const at = hlen + r * rlen;
    if (at + rlen > u8.length) break;
    if (u8[at] === 0x2a) continue; // deleted
    let p = at + 1;
    const row: Cell[] = [];
    for (const f of fields) {
      const raw = decodeCodepage(u8.subarray(p, p + f.len), cp).trim();
      p += f.len;
      if (f.type === 'N' || f.type === 'F') row.push(raw === '' ? null : Number(raw));
      else if (f.type === 'D' && /^\d{8}$/.test(raw)) row.push(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`);
      else if (f.type === 'L') row.push(/^[YyTt]/.test(raw) ? true : /^[NnFf]/.test(raw) ? false : null);
      else row.push(raw || null);
    }
    rows.push(row);
  }
  return [{ name: 'Table', rows }];
}

// ---------------------------------------------------------------------------------------
// Lotus 1-2-3

/**
 * WK3/WK4 "small number" cell (16-bit). Bit 0 clear: the value is the integer in bits 1-15.
 * Bit 0 set: bits 4-15 are a signed mantissa and bits 1-3 select a scale, multiplying by
 * 5000 or 500 or dividing by 20, 200, 2000, 20000, 16 or 64 (the encoding Gnumeric and libwps read).
 */
export function smallNum(v: number): number {
  if (!(v & 1)) return v >> 1;
  const f = [5000, 500, -20, -200, -2000, -20000, -16, -64][(v >> 1) & 7];
  const mant = v >> 4;
  return f > 0 ? mant * f : mant / -f;
}

export function readLotus(data: ArrayBuffer | Uint8Array): Sheet[] {
  const u8 = u8a(data);
  const sheets = new Map<number, Sheet>();
  const sheet = (k: number) => { let s = sheets.get(k); if (!s) { s = { name: `Sheet ${String.fromCharCode(65 + (k % 26))}`, rows: [] }; sheets.set(k, s); } return s; };
  const label = (b: Uint8Array) => { let s = ''; for (const x of b) { if (!x) break; s += String.fromCharCode(x); } return s.replace(/^['"^\\|]/, ''); };
  const f80 = (b: Uint8Array, p: number) => {
    // 80-bit extended: sign+exponent (2 bytes, high), 64-bit mantissa.
    const exp = le.u16(b, p + 8) & 0x7fff, sign = le.u16(b, p + 8) & 0x8000 ? -1 : 1;
    let m = 0;
    for (let i = 7; i >= 0; i--) m = m * 256 + b[p + i];
    return exp === 0 && m === 0 ? 0 : sign * m * Math.pow(2, exp - 16383 - 63);
  };
  for (let p = 0; p + 4 <= u8.length; ) {
    const op = le.u16(u8, p);
    // A truncated record holds fewer bytes than it declares: test what is there.
    const d = u8.subarray(p + 4, p + 4 + le.u16(u8, p + 2));
    const len = d.length;
    p += 4 + le.u16(u8, p + 2);
    if (op === 0x01) break; // EOF
    if (op === 0x0f && len >= 6) put(sheet(0).rows, le.u16(d, 3), le.u16(d, 1), label(d.subarray(5)));
    else if (op === 0x0e && len >= 13) put(sheet(0).rows, le.u16(d, 3), le.u16(d, 1), new DataView(d.buffer, d.byteOffset + 5, 8).getFloat64(0, true));
    else if (op === 0x0d && len >= 7) put(sheet(0).rows, le.u16(d, 3), le.u16(d, 1), le.i16(d, 5));
    else if (op === 0x10 && len >= 13) put(sheet(0).rows, le.u16(d, 3), le.u16(d, 1), new DataView(d.buffer, d.byteOffset + 5, 8).getFloat64(0, true));
    else if (op === 0x16 && len >= 5) put(sheet(d[2]).rows, le.u16(d, 0), d[3], label(d.subarray(4)));
    else if (op === 0x17 && len >= 14) put(sheet(d[2]).rows, le.u16(d, 0), d[3], f80(d, 4));
    else if (op === 0x18 && len >= 6) put(sheet(d[2]).rows, le.u16(d, 0), d[3], smallNum(le.i16(d, 4)));
    else if (op === 0x19 && len >= 14) put(sheet(d[2]).rows, le.u16(d, 0), d[3], f80(d, 4));
    if (sheets.size > 256) break;
  }
  return [...sheets.values()];
}

// ---------------------------------------------------------------------------------------
// Into a document

export function sheetsToDoc(sheets: Sheet[], title: string): PMNode {
  const b = new DocBuilder();
  b.property('title', title);
  let first = true;
  for (const s of sheets) {
    // Used range: drop empty leading/trailing rows and trailing columns. Rows are read in place
    // (never copied), since a sparse row can be very long.
    const filled = (v: Cell | undefined) => v != null && v !== '';
    const used = (r: Cell[] | undefined) => !!r && r.some(filled);
    let first0 = 0, end = s.rows.length;
    while (end > 0 && !used(s.rows[end - 1])) end--;
    while (first0 < end && !used(s.rows[first0])) first0++;
    let rowIdx: number[] = [];
    for (let r = first0; r < end; r++) rowIdx.push(r);
    const cols = new Set<number>();
    for (const r of rowIdx) s.rows[r]?.forEach((v, c) => { if (filled(v)) cols.add(c); });
    const widest = cols.size ? Math.max(...cols) + 1 : 0;
    let colIdx: number[] = [];
    for (let c = 0; c < widest; c++) colIdx.push(c);
    // A sparse sheet whose used range is huge: keep only the rows and columns that hold values.
    if (rowIdx.length * Math.min(MAX_COLS, colIdx.length) > MAX_CELLS) {
      rowIdx = rowIdx.filter((r) => used(s.rows[r]));
      colIdx = [...cols].sort((a, b) => a - b);
    }
    const width = Math.min(MAX_COLS, colIdx.length);
    if (!first) b.pageBreak();
    first = false;
    if (sheets.length > 1 || s.name) { b.text(s.name || 'Sheet'); b.endParagraph({ style: 'Heading 2' }); }
    if (!rowIdx.length || !width) { b.text('(empty sheet)', { italic: true }); b.endParagraph(); continue; }
    const maxRows = Math.max(1, Math.min(MAX_ROWS, Math.floor(MAX_CELLS / width)));
    const shown = rowIdx.slice(0, maxRows);
    b.startTable({ headerRows: 0 });
    for (const ri of shown) {
      const r = s.rows[ri] || [];
      b.startRow();
      for (let k = 0; k < width; k++) {
        b.startCell();
        const v = r[colIdx[k]] ?? null;
        const t = cellText(v);
        if (t) b.text(t);
        b.endParagraph({ align: typeof v === 'number' ? 'right' : null });
        b.endCell();
      }
      b.endRow();
    }
    b.endTable();
    const cut = [rowIdx.length > maxRows ? `the first ${maxRows.toLocaleString()} of ${rowIdx.length.toLocaleString()} rows` : '', colIdx.length > MAX_COLS ? `the first ${MAX_COLS} columns` : ''].filter(Boolean);
    if (cut.length) { b.text(`Only ${cut.join(' and ')} were imported.`, { italic: true }); b.endParagraph(); }
  }
  if (!sheets.length) { b.text('The workbook has no sheets with values.', { italic: true }); b.endParagraph(); }
  return b.build();
}

export async function readSpreadsheet(data: ArrayBuffer, kind: string): Promise<Sheet[]> {
  const u8 = u8a(data);
  switch (kind) {
    case 'xlsx': return readXlsx(u8);
    case 'ods': return readOds(u8);
    case 'xls': return readXls(u8);
    case 'dbf': return readDbf(u8);
    case 'lotus123': return readLotus(u8);
    case 'tsv': return [{ name: '', rows: parseDelimited(new TextDecoder().decode(u8), '\t') }];
    default: {
      let t: string;
      try { t = new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { t = new TextDecoder('windows-1252').decode(u8); }
      return [{ name: '', rows: parseDelimited(t) }];
    }
  }
}

export async function importSpreadsheet(data: ArrayBuffer, name: string, kind: string): Promise<PMNode> {
  const sheets = await readSpreadsheet(data, kind);
  return sheetsToDoc(sheets, name.replace(/\.[^.]+$/, ''));
}
