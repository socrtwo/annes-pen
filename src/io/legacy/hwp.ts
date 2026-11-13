/**
 * Hangul (HWP) documents, written from Hancom's published HWP 5.0 file format specification.
 *
 * HWP 5 (Hangul 2002 and later) is a compound file: FileHeader (signature, version, flags),
 * DocInfo (fonts, character shapes, paragraph shapes, styles) and BodyText/Section0..n, each a
 * sequence of tagged records ([tag:10][level:10][size:12], size 0xFFF = 32-bit size follows),
 * compressed with raw DEFLATE when the header says so. Paragraph text is UTF-16 with control
 * characters (extended and inline controls take 8 code units).
 *
 * Imported: text, paragraphs, bold/italic/underline/strike/super/subscript, font face and size,
 * colour, alignment, indents and spacing, tables (cells and spans), line and page breaks.
 * HWP 3 (Hangul 97) is a different, older format and is not imported.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { openCfb, le, type Cfb } from '../cfb';
import { immortalInflate, inflateLimit } from '../recover/inflate';
import { DocBuilder, hex, type CharProps, type ParaProps } from './builder';

const u8a = (d: ArrayBuffer | Uint8Array) => (d instanceof Uint8Array ? d : new Uint8Array(d));

const TAG = {
  FACE_NAME: 0x13, CHAR_SHAPE: 0x15, PARA_SHAPE: 0x19, STYLE: 0x1a,
  PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, CTRL_HEADER: 0x47, LIST_HEADER: 0x48, TABLE: 0x4d,
};

interface Rec { tag: number; level: number; data: Uint8Array }

export function hwpRecords(b: Uint8Array): Rec[] {
  const out: Rec[] = [];
  let p = 0;
  while (p + 4 <= b.length && out.length < 500000) {
    const h = le.u32(b, p);
    const tag = h & 0x3ff, level = (h >> 10) & 0x3ff;
    let size = h >>> 20;
    p += 4;
    if (size === 0xfff) { size = le.u32(b, p); p += 4; }
    if (p + size > b.length) { out.push({ tag, level, data: b.subarray(p) }); break; }
    out.push({ tag, level, data: b.subarray(p, p + size) });
    p += size;
  }
  return out;
}

interface CharShape { faces: number[]; size: number; italic: boolean; bold: boolean; underline: boolean; strike: boolean; sup: boolean; sub: boolean; color: string | null }
interface ParaShape { align: ParaProps['align']; left: number; right: number; indent: number; before: number; after: number; line: number; lineType: number }

const unit = (n: number) => n / 100; // HWPUNIT is 1/7200 inch = 1/100 pt

class HwpReader {
  cfb: Cfb;
  compressed: boolean;
  faces: string[] = [];
  chars: CharShape[] = [];
  paras: ParaShape[] = [];
  styles: string[] = [];
  b = new DocBuilder();

  constructor(cfb: Cfb) {
    this.cfb = cfb;
    const fh = cfb.read('FileHeader');
    if (!fh || String.fromCharCode(...fh.subarray(0, 17)) !== 'HWP Document File') throw new Error('Not an HWP 5 document');
    const flags = le.u32(fh, 36);
    if (flags & 2) throw new Error('This HWP document is password-protected');
    if (flags & 4) throw new Error('This HWP document is a distribution copy with encrypted text');
    this.compressed = !!(flags & 1);
  }

  stream(path: string): Uint8Array | null {
    const raw = this.cfb.read(path);
    if (!raw) return null;
    if (!this.compressed) return raw;
    try { return immortalInflate(raw, { maxOutput: inflateLimit(raw.length) }).data; } catch { return null; }
  }

  readDocInfo(): void {
    const d = this.stream('DocInfo');
    if (!d) return;
    for (const r of hwpRecords(d)) {
      const x = r.data;
      if (r.tag === TAG.FACE_NAME) {
        const len = le.u16(x, 1);
        let s = '';
        for (let i = 0; i < len && 3 + i * 2 + 1 < x.length; i++) s += String.fromCharCode(le.u16(x, 3 + i * 2));
        this.faces.push(s);
      } else if (r.tag === TAG.CHAR_SHAPE && x.length >= 56) {
        const a = le.u32(x, 46);
        const cr = le.u32(x, 52);
        this.chars.push({
          faces: [0, 1, 2, 3, 4, 5, 6].map((k) => le.u16(x, k * 2)), size: le.i32(x, 42) / 100,
          italic: !!(a & 1), bold: !!(a & 2), underline: ((a >> 2) & 3) === 1, strike: !!((a >> 18) & 7), sup: !!(a & (1 << 15)), sub: !!(a & (1 << 16)),
          color: cr ? hex(cr & 0xff, (cr >> 8) & 0xff, (cr >> 16) & 0xff) : null,
        });
      } else if (r.tag === TAG.PARA_SHAPE && x.length >= 28) {
        const a = le.u32(x, 0);
        const al = (a >> 2) & 7;
        this.paras.push({
          align: (['justify', 'left', 'right', 'center', 'justify', 'justify'] as const)[al] || 'left',
          left: le.i32(x, 4), right: le.i32(x, 8), indent: le.i32(x, 12), before: le.i32(x, 16), after: le.i32(x, 20), line: x.length >= 54 ? le.i32(x, 50) : le.i32(x, 24), lineType: a & 3,
        });
      } else if (r.tag === TAG.STYLE) {
        const len = le.u16(x, 0);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(le.u16(x, 2 + i * 2));
        this.styles.push(s);
      }
    }
  }

  charProps(id: number): CharProps {
    const c = this.chars[id];
    if (!c) return {};
    const face = this.faces[c.faces[0]] || this.faces[c.faces[1]];
    return { bold: c.bold, italic: c.italic, underline: c.underline, strike: c.strike, sup: c.sup, sub: c.sub, size: c.size > 0 && c.size < 500 ? c.size : null, font: face || null, color: c.color };
  }

  paraProps(id: number): ParaProps {
    const p = this.paras[id];
    if (!p) return {};
    return {
      align: p.align, indentLeft: unit(p.left) / 2, indentRight: unit(p.right) / 2, indentFirst: unit(p.indent) / 2,
      spaceBefore: unit(p.before) / 2, spaceAfter: unit(p.after) / 2,
      lineHeight: p.lineType === 0 && p.line > 0 && p.line !== 160 ? String(Math.round(p.line / 100 / 1.6 * 100) / 100) : null,
    };
  }

  /** Emit the paragraphs of a record list (one section, or a table cell's records). */
  emit(recs: Rec[], from: number, to: number, baseLevel: number): void {
    const b = this.b;
    for (let i = from; i < to; i++) {
      const r = recs[i];
      if (r.tag !== TAG.PARA_HEADER || r.level !== baseLevel) continue;
      const paraShape = le.u16(r.data, 8);
      // Collect this paragraph's records (deeper levels until the next header at this level).
      let j = i + 1;
      while (j < to && !(recs[j].tag === TAG.PARA_HEADER && recs[j].level <= baseLevel)) j++;
      let text: Uint8Array | null = null;
      let shapes: [number, number][] = [[0, 0]];
      const tables: number[] = [];
      for (let k = i + 1; k < j; k++) {
        const x = recs[k];
        if (x.level !== baseLevel + 1) continue;
        if (x.tag === TAG.PARA_TEXT) text = x.data;
        else if (x.tag === TAG.PARA_CHAR_SHAPE) { shapes = []; for (let q = 0; q + 8 <= x.data.length; q += 8) shapes.push([le.u32(x.data, q), le.u32(x.data, q + 4)]); }
        else if (x.tag === TAG.CTRL_HEADER && String.fromCharCode(...x.data.subarray(0, 4)).split('').reverse().join('') === 'tbl ') tables.push(k);
      }
      const pp = this.paraProps(paraShape);
      if (text) {
        const n = Math.floor(text.length / 2);
        let s = '';
        let shapeIdx = 0;
        const flush = (pos: number) => { if (s) { b.text(s, this.charProps(shapes[shapeIdx]?.[1] ?? 0)); s = ''; } void pos; };
        let tableNo = 0;
        for (let q = 0; q < n; q++) {
          while (shapeIdx + 1 < shapes.length && shapes[shapeIdx + 1][0] <= q) { flush(q); shapeIdx++; }
          const c = le.u16(text, q * 2);
          if (c >= 32) { s += String.fromCharCode(c); continue; }
          flush(q);
          if (c === 13) break;
          if (c === 10) b.lineBreak();
          else if (c === 9) { b.text('\t', this.charProps(shapes[shapeIdx]?.[1] ?? 0)); q += 7; }
          else if (c === 24) b.text('-');
          else if (c === 30 || c === 31) b.text(' ');
          else if ([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].includes(c)) {
            if (c === 11 && tables[tableNo] != null) { b.endParagraph(pp); this.table(recs, tables[tableNo++], j); }
            q += 7;
          }
        }
        flush(n);
      }
      if (b.hasInline || text) b.endParagraph(pp);
      i = j - 1;
    }
  }

  table(recs: Rec[], ctrlIdx: number, end: number): void {
    const level = recs[ctrlIdx].level;
    let k = ctrlIdx + 1;
    const tbl = recs[k] && recs[k].tag === TAG.TABLE ? recs[k] : null;
    const rows = tbl ? le.u16(tbl.data, 4) : 0;
    this.b.startTable();
    let currentRow = -1;
    for (; k < end; k++) {
      const r = recs[k];
      if (r.level <= level && k > ctrlIdx + 1 && r.tag !== TAG.LIST_HEADER) break;
      if (r.tag !== TAG.LIST_HEADER || r.level !== level + 1) continue;
      const x = r.data;
      // LIST_HEADER: paragraph count, flags, then cell address, span and size.
      const col = le.u16(x, 8), row = le.u16(x, 10), colspan = le.u16(x, 12) || 1, rowspan = le.u16(x, 14) || 1, width = le.u32(x, 16);
      void col;
      if (row !== currentRow) { if (currentRow >= 0) this.b.endRow(); this.b.startRow(); currentRow = row; }
      this.b.startCell({ colspan, rowspan, width: width ? unit(width) : null });
      let e = k + 1;
      while (e < end && !(recs[e].tag === TAG.LIST_HEADER && recs[e].level === level + 1) && recs[e].level > level) e++;
      this.emit(recs, k + 1, e, level + 1);
      this.b.endCell();
      k = e - 1;
    }
    void rows;
    this.b.endTable();
  }

  build(): PMNode {
    this.readDocInfo();
    const face = this.chars[0] ? this.faces[this.chars[0].faces[0]] : this.faces[0];
    if (face) this.b.defaultFont = face;
    this.b.page({ width: 595.3, height: 841.9, top: 56.7, bottom: 42.5, left: 85, right: 85 });
    for (let s = 0; s < 256; s++) {
      const d = this.stream(`BodyText/Section${s}`);
      if (!d) break;
      if (s > 0) this.b.sectionBreak('nextPage');
      const recs = hwpRecords(d);
      const page = recs.find((r) => r.tag === 0x49);
      if (page && s === 0 && page.data.length >= 36) {
        const x = page.data;
        const w = unit(le.u32(x, 0)), h = unit(le.u32(x, 4));
        this.b.page({ width: w, height: h, left: unit(le.u32(x, 8)), right: unit(le.u32(x, 12)), top: unit(le.u32(x, 16)), bottom: unit(le.u32(x, 20)), landscape: !!(le.u32(x, 36) & 1) });
      }
      this.emit(recs, 0, recs.length, 0);
    }
    return this.b.build();
  }
}

export async function importHwp(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const u8 = u8a(data);
  const cfb = openCfb(u8);
  if (cfb) return new HwpReader(cfb).build();
  if (String.fromCharCode(...u8.subarray(0, 17)) === 'HWP Document File') throw new Error('Hangul 97 (HWP 3) documents are not supported; save the file as HWP 5 or HWPX in Hangul');
  throw new Error('Not a Hangul document');
}

export function extractText(u8: Uint8Array): string {
  try {
    const cfb = openCfb(u8);
    if (!cfb) return '';
    const r = new HwpReader(cfb);
    let out = '';
    for (let s = 0; s < 256; s++) {
      const d = r.stream(`BodyText/Section${s}`);
      if (!d) break;
      for (const rec of hwpRecords(d)) {
        if (rec.tag !== TAG.PARA_TEXT) continue;
        for (let q = 0; q + 1 < rec.data.length; q += 2) {
          const c = le.u16(rec.data, q);
          if (c >= 32) out += String.fromCharCode(c);
          else if (c === 13) out += '\n';
          else if (c !== 10 && c !== 24 && c !== 30 && c !== 31 && c !== 13) q += 14;
        }
      }
    }
    return out;
  } catch { return ''; }
}
