/**
 * Content-based file identification.
 *
 * sniff() identifies a file from its bytes: magic numbers, OLE2/CFB stream names, ZIP entry
 * names and "mimetype" entries, XML root elements and namespaces, RTF/HTML/MIME headers and
 * text heuristics (encoding, BOM, markup). The file name's extension is only a tie-breaker.
 *
 * The sniffer is table driven: every format is a SniffRule whose test() returns a confidence
 * (0..1). Format modules can add rules with registerSniffer(). Rules are cheap to evaluate:
 * the context parses the container (CFB directory, ZIP central directory, decoded text) once,
 * lazily, and shares it between rules.
 */
import { openCfb, type Cfb } from './cfb';
import { immortalInflate } from './recover/inflate';
import { bomlessUtf16 } from './encoding';
import { skipProlog } from './sniff-b';

export type SniffCategory = 'document' | 'spreadsheet' | 'presentation' | 'email' | 'unknown';

export interface SniffResult {
  /** Format id. For importable formats this is the id of the FormatDef that opens it. */
  format: string;
  /** Human-readable name of the format (and version when known). */
  label: string;
  /** 0..1: how sure the content match is (≤ 0.25 means "by extension only"). */
  confidence: number;
  category: SniffCategory;
  /** Short note for the user when the content and the file name disagree, else ''. */
  note: string;
  /** The extension the file name has ('' when none). */
  ext: string;
  /** Extensions this format normally uses. */
  exts: string[];
}

export interface SniffHit { confidence: number; label?: string; format?: string; category?: SniffCategory }

export interface SniffRule {
  /** Format id (see SniffResult.format). */
  format: string;
  label: string;
  category: SniffCategory;
  /** Extensions this format normally uses (lower case, no dot). */
  ext: string[];
  /** Return a confidence (0..1), a hit with a refined label/format, or null/0 for no match. */
  test?: (ctx: SniffContext) => number | SniffHit | null | undefined | false;
}

export interface ZipEntry { name: string; method: number; csize: number; size: number; offset: number }
export interface ZipIndex { names: string[]; has(name: string): boolean; find(re: RegExp): string | undefined; read(name: string, max?: number): Uint8Array | null }

export interface SniffContext {
  bytes: Uint8Array;
  name: string;
  ext: string;
  /** The first 4 KB as Latin-1 (one char per byte). */
  head: string;
  /** Up to 64 KB decoded as text (BOM, UTF-16 and UTF-8 detection; CP1252 fallback). */
  text(): string;
  /** The text encoding detect() chose: 'utf-8', 'utf-16le', 'utf-16be', 'windows-1252', or '' for binary. */
  encoding(): string;
  /** True when the first 4 KB contain control bytes that text never has. */
  binary(): boolean;
  cfb(): Cfb | null;
  zip(): ZipIndex | null;
  /** Root element of an XML file: local name, prefix and namespace URIs declared on it. */
  xmlRoot(): { name: string; prefix: string; ns: string[]; raw: string } | null;
  /** Bytes after the gzip header, inflated (up to max bytes). */
  gunzip(max?: number): Uint8Array | null;
  u16le(o: number): number; u16be(o: number): number; u32le(o: number): number; u32be(o: number): number;
  at(o: number, s: string): boolean;
}

// ---------------------------------------------------------------------------------------
// Context

/** Largest declared size of a ZIP entry the sniffer inflates (it reads at most a prefix). */
const SNIFF_MAX_ENTRY = 16 * 1024 * 1024;

function zipIndex(b: Uint8Array): ZipIndex | null {
  if (b.length < 22 || b[0] !== 0x50 || b[1] !== 0x4b) return null;
  const u16 = (o: number) => b[o] | (b[o + 1] << 8);
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const dec = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { eocd = i; break; }
  if (eocd >= 0) {
    let p = u32(eocd + 16);
    const n = u16(eocd + 10);
    for (let k = 0; k < n && p + 46 <= b.length && u32(p) === 0x02014b50; k++) {
      const nl = u16(p + 28), xl = u16(p + 30), cl = u16(p + 32);
      entries.push({ name: dec.decode(b.subarray(p + 46, p + 46 + nl)), method: u16(p + 10), csize: u32(p + 20), size: u32(p + 24), offset: u32(p + 42) });
      p += 46 + nl + xl + cl;
    }
  }
  if (!entries.length) {
    // No usable central directory (damaged or truncated): walk the local headers.
    let p = 0;
    for (let guard = 0; p + 30 <= b.length && u32(p) === 0x04034b50 && guard < 5000; guard++) {
      const nl = u16(p + 26), xl = u16(p + 28), cs = u32(p + 18);
      entries.push({ name: dec.decode(b.subarray(p + 30, p + 30 + nl)), method: u16(p + 8), csize: cs, size: u32(p + 22), offset: p });
      if (u16(p + 6) & 8 || !cs) break;
      p += 30 + nl + xl + cs;
    }
  }
  if (!entries.length) return null;
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  // Rules read the same small parts again and again: inflate each once (the longest prefix asked for).
  const cache = new Map<string, { max: number; data: Uint8Array | null }>();
  const readRaw = (e: ZipEntry, max: number): Uint8Array | null => {
    if (e.offset + 30 > b.length || u32(e.offset) !== 0x04034b50) return null;
    const start = e.offset + 30 + u16(e.offset + 26) + u16(e.offset + 28);
    const cs = Math.min(e.csize || b.length - start, b.length - start);
    const raw = b.subarray(start, start + cs);
    if (e.method === 0) return raw.subarray(0, Math.min(raw.length, max));
    if (e.method === 8) {
      try { return immortalInflate(raw.subarray(0, Math.min(raw.length, max)), { maxOutput: max }).data.subarray(0, max); } catch { return null; }
    }
    return null;
  };
  return {
    names: entries.map((e) => e.name),
    has: (n) => byName.has(n.toLowerCase()),
    find: (re) => entries.find((e) => re.test(e.name))?.name,
    read(n, max = 1 << 20) {
      const key = n.toLowerCase();
      const e = byName.get(key);
      // Sniffing needs only a prefix; an entry that claims to be huge is not worth inflating.
      if (!e || e.size > SNIFF_MAX_ENTRY) return null;
      max = Math.min(max, SNIFF_MAX_ENTRY);
      const hit = cache.get(key);
      if (hit && hit.max >= max) return hit.data && hit.data.subarray(0, max);
      const data = readRaw(e, max);
      cache.set(key, { max, data });
      return data;
    },
  };
}

function detectText(b: Uint8Array): { text: string; encoding: string } {
  const n = Math.min(b.length, 65536);
  const s = b.subarray(0, n);
  if (s[0] === 0xef && s[1] === 0xbb && s[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(s.subarray(3)), encoding: 'utf-8' };
  if (s[0] === 0xff && s[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(s.subarray(2, n - (n % 2))), encoding: 'utf-16le' };
  if (s[0] === 0xfe && s[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(s.subarray(2, n - (n % 2))), encoding: 'utf-16be' };
  // UTF-16 without a BOM: most odd (or even) bytes are zero.
  let zEven = 0, zOdd = 0;
  const m = Math.min(n, 4096);
  for (let i = 0; i < m; i++) if (!s[i]) { if (i % 2) zOdd++; else zEven++; }
  if (m >= 16 && zOdd > m * 0.35 && zEven < m * 0.05) return { text: new TextDecoder('utf-16le').decode(s.subarray(0, n - (n % 2))), encoding: 'utf-16le' };
  if (m >= 16 && zEven > m * 0.35 && zOdd < m * 0.05) return { text: new TextDecoder('utf-16be').decode(s.subarray(0, n - (n % 2))), encoding: 'utf-16be' };
  // UTF-16 of non-Latin text (Cyrillic, CJK) has few zero bytes: validate it as UTF-16 instead.
  const u16 = bomlessUtf16(s);
  if (u16) return { text: new TextDecoder(u16).decode(s.subarray(0, n - (n % 2))), encoding: u16 };
  try {
    // A multi-byte sequence may be cut at the 64 KB boundary.
    let end = n;
    if (n < b.length) while (end > n - 4 && (s[end - 1] & 0xc0) === 0x80) end--;
    if (n < b.length && s[end - 1] >= 0xc0) end--;
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(s.subarray(0, end)), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(s), encoding: 'windows-1252' };
  }
}

export function makeContext(data: ArrayBuffer | Uint8Array, name: string): SniffContext {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const lower = (name || '').toLowerCase().replace(/^.*[\\/]/, '');
  const dot = lower.lastIndexOf('.');
  let ext = dot > 0 && dot < lower.length - 1 && lower.length - dot <= 9 ? lower.slice(dot + 1) : '';
  if (/^\d+$/.test(ext) && ext !== '123' && ext !== '602') ext = '';
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) head += String.fromCharCode(bytes[i]);
  let txt: { text: string; encoding: string } | null = null;
  let bin: boolean | null = null;
  let cfb: Cfb | null | undefined;
  let zip: ZipIndex | null | undefined;
  let root: ReturnType<SniffContext['xmlRoot']> | undefined;
  let gz: Uint8Array | null | undefined;
  const ctx: SniffContext = {
    bytes, name, ext, head,
    text() { if (!txt) txt = detectText(bytes); return txt.text; },
    encoding() { return ctx.binary() ? '' : (ctx.text(), txt!.encoding); },
    binary() {
      if (bin == null) {
        const t = detectText(bytes.subarray(0, 4096));
        if (t.encoding.startsWith('utf-16')) { bin = /[\x00-\x08\x0e-\x1a\x1c-\x1f]/.test(t.text.slice(0, 2000)); }
        else {
          let bad = 0;
          const m = Math.min(bytes.length, 4096);
          for (let i = 0; i < m; i++) { const c = bytes[i]; if (c < 9 || (c > 13 && c < 32 && c !== 26 && c !== 27)) bad++; }
          bin = m === 0 ? false : bad > Math.max(1, m * 0.01);
        }
      }
      return bin;
    },
    cfb() { if (cfb === undefined) { try { cfb = openCfb(bytes); } catch { cfb = null; } } return cfb; },
    zip() { if (zip === undefined) { try { zip = zipIndex(bytes); } catch { zip = null; } } return zip; },
    xmlRoot() {
      if (root === undefined) {
        root = null;
        if (!ctx.binary()) {
          const t = ctx.text().slice(0, 16384);
          const m = /^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?=[\s/>])([^>]*)>/.exec(t.slice(skipProlog(t)));
          if (m) root = { prefix: (m[1] || '').replace(':', ''), name: m[2], ns: [...m[3].matchAll(/xmlns(?::[\w.-]+)?\s*=\s*["']([^"']*)["']/g)].map((x) => x[1]), raw: m[0] };
        }
      }
      return root;
    },
    gunzip(max = 65536) {
      if (gz === undefined) {
        gz = null;
        if (bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8) {
          const flg = bytes[3];
          let p = 10;
          if (flg & 4) p += 2 + (bytes[p] | (bytes[p + 1] << 8));
          if (flg & 8) { while (p < bytes.length && bytes[p]) p++; p++; }
          if (flg & 16) { while (p < bytes.length && bytes[p]) p++; p++; }
          if (flg & 2) p += 2;
          try { gz = immortalInflate(bytes.subarray(p, Math.min(bytes.length, p + max)), { maxOutput: max }).data.subarray(0, max); } catch { gz = null; }
        }
      }
      return gz;
    },
    u16le: (o) => (o + 2 <= bytes.length ? bytes[o] | (bytes[o + 1] << 8) : -1),
    u16be: (o) => (o + 2 <= bytes.length ? (bytes[o] << 8) | bytes[o + 1] : -1),
    u32le: (o) => (o + 4 <= bytes.length ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0 : -1),
    u32be: (o) => (o + 4 <= bytes.length ? ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0 : -1),
    at: (o, s) => head.startsWith(s, o) || (o + s.length > 4096 && o + s.length <= bytes.length && String.fromCharCode(...bytes.subarray(o, o + s.length)) === s),
  };
  return ctx;
}

// ---------------------------------------------------------------------------------------
// Helpers for rules

const cfbHas = (c: SniffContext, ...paths: string[]) => { const f = c.cfb(); return !!f && paths.every((p) => !!f.find(p)); };
const cfbStream = (c: SniffContext, p: string) => c.cfb()?.read(p) || null;
const zipHas = (c: SniffContext, ...names: string[]) => { const z = c.zip(); return !!z && names.every((n) => z.has(n)); };
const zipFind = (c: SniffContext, re: RegExp) => c.zip()?.find(re);
function zipMime(c: SniffContext): string {
  const z = c.zip();
  if (!z) return '';
  const d = z.has('mimetype') ? z.read('mimetype', 200) : null;
  if (d && d.length) return new TextDecoder().decode(d).trim();
  const man = z.has('META-INF/manifest.xml') ? zipText(c, 'META-INF/manifest.xml', 8192) : '';
  return /full-path="\/"\s+manifest:media-type="([^"]+)"|media-type="([^"]+)"\s+manifest:full-path="\/"/.exec(man)?.slice(1).find(Boolean) || '';
}
function zipText(c: SniffContext, name: string, max = 65536): string {
  const d = c.zip()?.read(name, max);
  return d ? new TextDecoder().decode(d) : '';
}
/** An OpenDocument/StarOffice package or flat XML with this media type. */
function odfType(c: SniffContext): string {
  const m = zipMime(c);
  if (m) return m;
  const r = c.xmlRoot();
  if (r && r.name === 'document' && r.ns.some((n) => n.includes('opendocument:xmlns:office'))) return /office:mimetype\s*=\s*["']([^"']+)/.exec(r.raw)?.[1] || '';
  return '';
}

/** Which iWork application wrote a package (Pages, Numbers or Keynote), or null. */
function iwork(c: SniffContext): 'pages' | 'numbers' | 'key' | null {
  const z = c.zip();
  if (!z) return null;
  if (z.find(/^(index|presentation)\.apxl(\.gz)?$/i) || z.find(/^Index\/(Slide|MasterSlide)/)) return 'key';
  if (z.has('index.xml') || z.has('index.xml.gz')) {
    const t = z.has('index.xml') ? zipText(c, 'index.xml', 8192) : '';
    if (/ls:document|namespaces\/ls"/.test(t)) return 'numbers';
    if (/sl:document|namespaces\/sl"/.test(t)) return 'pages';
    return c.ext === 'numbers' ? 'numbers' : c.ext === 'key' ? 'key' : 'pages';
  }
  if (!z.has('Index/Document.iwa') && !z.has('Index.zip')) return null;
  const hist = zipText(c, 'Metadata/BuildVersionHistory.plist', 8192) + zipText(c, 'Metadata/Properties.plist', 8192);
  if (/keynote/i.test(hist)) return 'key';
  if (/numbers/i.test(hist)) return 'numbers';
  if (/pages/i.test(hist)) return 'pages';
  if (c.ext === 'key' || c.ext === 'numbers' || c.ext === 'pages') return c.ext as 'key';
  return z.find(/^Index\/CalculationEngine/) && !z.find(/^Index\/.*Text/) ? 'numbers' : 'pages';
}

/** Word binary FIB magic and version at the start of the WordDocument stream. */
function wordFib(c: SniffContext): { ident: number; nFib: number; encrypted: boolean } | null {
  const wd = cfbStream(c, 'WordDocument');
  if (!wd || wd.length < 32) return null;
  return { ident: wd[0] | (wd[1] << 8), nFib: wd[2] | (wd[3] << 8), encrypted: !!((wd[0x0a] | (wd[0x0b] << 8)) & 0x0100) };
}

/** Clipboard-style program name stored in the CompObj stream ("Microsoft Works Document" …). */
function compObjName(c: SniffContext): string {
  const d = cfbStream(c, '\u0001CompObj') || cfbStream(c, 'CompObj');
  if (!d) return '';
  let s = '';
  for (let i = 28; i < Math.min(d.length, 400); i++) s += d[i] >= 32 && d[i] < 127 ? String.fromCharCode(d[i]) : '\n';
  return s;
}

/** WordPerfect-family prefix: FF 'WPC', product type at 8, file type at 9, major version at 10. */
function wpc(c: SniffContext, b = c.bytes): { product: number; type: number; major: number; minor: number } | null {
  if (b.length < 16 || b[0] !== 0xff || b[1] !== 0x57 || b[2] !== 0x50 || b[3] !== 0x43) return null;
  return { product: b[8], type: b[9], major: b[10], minor: b[11] };
}

/** True when the bytes are valid UTF-8 with at least one multi-byte sequence (accented text, not codes). */
function utf8Multibyte(b: Uint8Array): boolean {
  let end = b.length, k = 0;
  while (k < 3 && end > 0 && (b[end - 1] & 0xc0) === 0x80) { end--; k++; }
  if (end > 0 && b[end - 1] >= 0xc0) end--; else end = b.length;
  const s = b.subarray(0, end);
  if (!s.some((x) => x >= 0x80)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(s); return true; } catch { return false; }
}

const asciiLetter = (x: number | undefined) => x !== undefined && ((x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a));

/** WordPerfect 4.2 (no header): function codes 0xC0-0xFE are bracketed by the same code. */
export function wp42Score(b: Uint8Array): number {
  const n = Math.min(b.length, 8192);
  if (utf8Multibyte(b.subarray(0, n))) return 0;
  let good = 0, bad = 0, text = 0;
  for (let i = 0; i < n; ) {
    const c = b[i];
    if (c >= 0x20 && c < 0x7f) { text++; i++; continue; }
    if (c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x0b) { i++; continue; }
    if (c >= 0x80 && c < 0xc0) { i++; continue; } // one-byte codes
    if (c >= 0xc0 && c < 0xff) {
      // A run of one repeated byte (DOS box-drawing lines) is text, not a bracketed code.
      if (b[i + 1] === c) { let j = i; while (j < n && b[j] === c) j++; bad++; i = j; continue; }
      // A high byte inside a word is an accented letter (Latin-1 "Hélas"), not a code.
      if (asciiLetter(b[i - 1]) && asciiLetter(b[i + 1])) { bad++; i++; continue; }
      const end = b.indexOf(c, i + 2);
      if (end > 0 && end - i < 300) {
        // A code holds a few parameter bytes; a stretch of words between two "é" is prose.
        const inner = b.subarray(i + 1, end);
        const prose = inner.every((x) => (x >= 0x20 && x < 0x7f) || x >= 0xc0) && (inner.includes(0x20) || inner.length > 8);
        if (!prose) { good++; i = end + 1; continue; }
      }
    }
    bad++; i++;
  }
  if (good < 2 || bad * 3 > good || text < n * 0.15) return 0;
  return Math.min(0.75, 0.45 + good / (good + bad + 4) * 0.3);
}

/** WordStar: high-bit word endings, dot commands, ^B/^S/^Y toggles, soft returns (0x8D 0x0A). */
export function wordstarScore(c: SniffContext): number {
  const b = c.bytes;
  if (b[0] === 0x1d && b[1] === 0x7d) return 0.85; // WordStar 5-7 document header
  const n = Math.min(b.length, 16384);
  if (utf8Multibyte(b.subarray(0, n))) return 0;
  let hi = 0, mid = 0, soft = 0, ctrl = 0, letters = 0, zero = 0, words = 0;
  for (let i = 0; i < n; i++) {
    const x = b[i];
    if (x === 0) zero++;
    if (x === 0x20) words++;
    if (x >= 0xa1 && x <= 0xfa && (b[i + 1] === 0x20 || b[i + 1] === 0x0d || b[i + 1] === 0x8d || b[i + 1] === 0xa0) && ((x & 0x7f) >= 0x61 || ((x & 0x7f) >= 0x2c && (x & 0x7f) <= 0x3f))) hi++;
    // WordStar sets the high bit only on the last letter of a word; Latin-1 accents sit inside words too.
    if (x >= 0xc0 && asciiLetter(b[i - 1]) && asciiLetter(b[i + 1])) mid++;
    if (x === 0x8d && b[i + 1] === 0x0a) soft++;
    if (x === 0x02 || x === 0x13 || x === 0x19 || x === 0x14 || x === 0x16) ctrl++;
    if ((x >= 0x61 && x <= 0x7a) || (x >= 0x41 && x <= 0x5a)) letters++;
  }
  if (zero > n * 0.01 || letters < n * 0.3) return 0;
  const dots = (c.head.match(/(^|\r\n|\n)\.(pa|op|he|fo|lm|rm|pl|mt|mb|po|cw|lh|pn|cp|ig|\.\.)/gi) || []).length;
  // High-bit word endings alone are what accented text looks like: require WordStar's own codes.
  if (soft < 2 && dots === 0 && ctrl < 2) return 0;
  const hiOk = hi > 3 && mid * 2 < hi && hi >= words * 0.15;
  const s = (hiOk ? 0.3 : 0) + (soft > 1 ? 0.3 : 0) + (dots > 0 ? 0.25 : 0) + (ctrl > 1 ? 0.1 : 0);
  return s >= 0.3 ? Math.min(0.8, s) : 0;
}

/** RFC 822 / MIME header block at the start of a text file. */
function mailHeaders(t: string): { score: number; mime: string } {
  const top = t.slice(0, 8192).replace(/^﻿/, '');
  const end = top.search(/\r?\n\r?\n/);
  const block = end > 0 ? top.slice(0, end) : top;
  const names = [...block.matchAll(/^([A-Za-z][A-Za-z0-9-]{1,40}):[ \t]/gm)].map((m) => m[1].toLowerCase());
  const known = ['from', 'to', 'subject', 'date', 'message-id', 'received', 'return-path', 'mime-version', 'content-type', 'cc', 'reply-to', 'delivered-to', 'x-mailer', 'sender', 'in-reply-to', 'references', 'user-agent', 'dkim-signature', 'thread-topic'];
  const hits = new Set(names.filter((n) => known.includes(n)));
  const ct = /^content-type:\s*([^;\r\n]+)/im.exec(block)?.[1]?.trim().toLowerCase() || '';
  const lines = block.split(/\r?\n/).filter((l) => l.trim());
  const headerish = lines.filter((l) => /^[A-Za-z][A-Za-z0-9-]*:/.test(l) || /^[ \t]/.test(l)).length;
  if (!lines.length || headerish < lines.length * 0.9) return { score: 0, mime: ct };
  const score = hits.size >= 3 ? 0.9 : hits.size === 2 ? 0.6 : 0;
  return { score, mime: ct };
}

function csvScore(t: string, sep: string, minRows = 2): number {
  const lines = t.split(/\r?\n/).slice(0, 50).filter((l) => l.length);
  if (lines.length < minRows) return 0;
  const counts = lines.map((l) => {
    let n = 0, q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) n++; }
    return n;
  });
  const first = counts[0];
  if (first < 1) return 0;
  const same = counts.filter((n) => n === first).length;
  return same >= lines.length * 0.8 ? Math.min(0.7, 0.35 + same / lines.length * 0.3) : 0;
}

// ---------------------------------------------------------------------------------------
// The rule table

/** File-name extensions of plain text: weak content guesses (< 0.8) do not override them. */
export const PLAIN_TEXT_EXTS = ['txt', 'text', 'log'];
const TABLE_NO = /^(txt|text|log|)$/;
const tableRows = (c: SniffContext) => (c.ext === 'csv' || c.ext === 'tsv' || c.ext === 'tab' ? 2 : 3);
const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
// From_ line (asctime date, with or without a comma, zone or seconds), then a header line.
const MBOX_FROM = new RegExp(`^From \\S+ +(Mon|Tue|Wed|Thu|Fri|Sat|Sun),? +(${MON} +\\d{1,2}|\\d{1,2} +${MON}) +(\\d{4} +)?\\d{1,2}:\\d\\d(:\\d\\d)?[^\\r\\n]*\\r?\\n[A-Za-z][A-Za-z0-9-]*:[ \\t]`);
/** ID3v2 tag header: version 2-4, then four syncsafe size bytes. */
const id3Header = (b: Uint8Array) => b.length >= 10 && b[3] >= 2 && b[3] <= 4 && b[4] < 0x10 && b[6] < 0x80 && b[7] < 0x80 && b[8] < 0x80 && b[9] < 0x80;

const WORKS_NOT_WP = /DBDoc|SSDoc|database|spreadsheet|base de datos|datenbank|tabelle|hoja de c/i;
const R = (format: string, label: string, category: SniffCategory, ext: string[], test?: SniffRule['test']): SniffRule => ({ format, label, category, ext, test });
const DOC = 'document' as const, SHEET = 'spreadsheet' as const, PRES = 'presentation' as const, MAIL = 'email' as const, UNK = 'unknown' as const;

const RULES: SniffRule[] = [
  // ---- Microsoft Word binary family
  R('doc', 'Word 97-2003 document', DOC, ['doc', 'dot', 'wbk', 'asd', 'wps', 'wpt'], (c) => {
    const f = wordFib(c);
    if (!f || (f.ident >> 8 !== 0xa5 && f.ident >> 8 !== 0xa6) || f.nFib < 0x6a || f.nFib > 0x200) return 0;
    const kingsoft = /kingsoft|\bwps\b/i.test(compObjName(c)) || ((c.ext === 'wps' || c.ext === 'wpt') && !cfbHas(c, 'CONTENTS') && !cfbHas(c, 'MN0'));
    return { confidence: 0.98, label: kingsoft ? 'Kingsoft WPS Writer document (Word-compatible)' : f.encrypted ? 'Word 97-2003 document (password-protected)' : 'Word 97-2003 document' };
  }),
  R('doc6', 'Word 6.0/95 document', DOC, ['doc', 'dot'], (c) => {
    const f = wordFib(c);
    if (!f || (f.ident >> 8 !== 0xa5 && f.ident >> 8 !== 0xa6) || f.nFib < 0x65 || f.nFib > 0x69) return 0;
    return { confidence: 0.98, label: f.nFib >= 0x68 ? 'Word 95 document' : 'Word 6.0 document' };
  }),
  R('word2', 'Word for Windows 1.x/2.0 document', DOC, ['doc', 'dot'], (c) => {
    const id = c.u16le(0), nFib = c.u16le(2);
    if (id === 0xa59b && nFib >= 0x10 && nFib <= 0x30) return { confidence: 0.95, label: 'Word for Windows 1.x document' };
    if (id === 0xa5db && nFib >= 0x2a && nFib <= 0x40) return { confidence: 0.95, label: 'Word for Windows 2.0 document' };
    return 0;
  }),
  R('worddos', 'Word for DOS document', DOC, ['doc'], (c) => {
    if ((c.u16le(0) !== 0xbe31 && c.u16le(0) !== 0xbe32) || c.u16le(2) !== 0 || c.u16le(4) !== 0xab00) return 0;
    const sty = /^[\x20-\x7e]{1,12}\.STY/i.test(c.head.slice(0x1e, 0x5f).replace(/\0.*$/s, '') + '.STY') && /\S/.test(c.head.slice(0x1e, 0x2a).replace(/\0/g, ''));
    const printer = /^[A-Z0-9_]{2,8}\0/i.test(c.head.slice(0x62, 0x6c));
    return sty || printer ? { confidence: 0.95, label: 'Word for DOS document' } : 0;
  }),
  R('wri', 'Windows Write document', DOC, ['wri'], (c) => {
    if ((c.u16le(0) !== 0xbe31 && c.u16le(0) !== 0xbe32) || c.u16le(2) !== 0 || c.u16le(4) !== 0xab00) return 0;
    return 0.9;
  }),
  R('wordmac', 'Word for Macintosh document', DOC, ['doc', 'mcw'], (c) => {
    const id = c.u16be(0);
    if (id === 0xfe32 && c.u16be(2) === 0) return { confidence: 0.9, label: 'Word for Macintosh 1.x document' };
    if (id === 0xfe34 && c.u16be(2) === 0) return { confidence: 0.9, label: 'Word for Macintosh 3.0 document' };
    if (id === 0xfe37) {
      const v = c.u16be(2);
      if (v === 0x1c) return { confidence: 0.95, label: 'Word for Macintosh 4.0 document' };
      if (v === 0x23) return { confidence: 0.95, label: 'Word for Macintosh 5.x document' };
      return { confidence: 0.7, label: 'Word for Macintosh document' };
    }
    return 0;
  }),
  R('docx', 'Word document (Office Open XML)', DOC, ['docx', 'docm', 'dotx', 'dotm'], (c) => {
    if (!zipHas(c, 'word/document.xml') && !zipFind(c, /^word\/document\d*\.xml$/i)) return 0;
    const ct = zipText(c, '[Content_Types].xml');
    return { confidence: 0.99, label: /macroEnabled/i.test(ct) ? 'Word macro-enabled document' : /template\.main/i.test(ct) ? 'Word template' : 'Word document (Office Open XML)' };
  }),
  R('flatopc', 'Word XML document (Flat OPC)', DOC, ['xml'], (c) => { const r = c.xmlRoot(); return r && r.name === 'package' && /progid="Word\.Document"/i.test(c.head) ? 0.9 : 0; }),
  R('wordml', 'Word 2003 XML document', DOC, ['xml'], (c) => { const r = c.xmlRoot(); return r && r.name === 'wordDocument' && r.ns.some((n) => n.includes('office/word/2003/wordml')) ? 0.95 : 0; }),

  // ---- WordPerfect family
  R('wpd', 'WordPerfect document', DOC, ['wpd', 'wp', 'wp4', 'wp5', 'wp6', 'wp7', 'wpt', 'w51', 'w60', 'w61', 'frm'], (c) => {
    let h = wpc(c);
    let wrapped = false;
    if (!h && c.cfb()) { const m = cfbStream(c, 'PerfectOffice_MAIN'); if (m) { h = wpc(c, m); wrapped = true; } }
    if (h && (h.product === 1 || h.product === 0x10) && (h.type === 0x0a || h.type === 0x2c || h.type === 0x0b)) {
      const v = h.type === 0x2c ? (h.major >= 3 ? 'WordPerfect for Macintosh 3.x' : 'WordPerfect for Macintosh 2.x') : h.major === 0 ? 'WordPerfect 5.x' : h.major === 2 ? 'WordPerfect 6-X9' : 'WordPerfect';
      return { confidence: 0.98, label: `${h.product === 0x10 ? 'LetterPerfect' : v} document${wrapped ? ' (OLE wrapper)' : ''}` };
    }
    const s = c.cfb() ? 0 : wp42Score(c.bytes);
    return s ? { confidence: s, label: 'WordPerfect 4.2 document' } : 0;
  }),

  // ---- Microsoft Works, Kingsoft WPS
  R('wps', 'Microsoft Works document', DOC, ['wps', 'wpt'], (c) => {
    const f = c.cfb();
    if (f) {
      const contents = f.read('CONTENTS');
      if (contents && /^CHNK(WKS|INK)/.test(String.fromCharCode(...contents.subarray(0, 7)))) return { confidence: 0.97, label: 'Microsoft Works 4.5-9 document' };
      if (f.find('MN0') && !WORKS_NOT_WP.test(compObjName(c))) return { confidence: 0.95, label: 'Microsoft Works 3-4 document' };
      return 0;
    }
    // Works for DOS word processor
    if (c.bytes[0] === 0x01 && c.bytes[1] === 0xfe && c.u16le(2) <= 4) return { confidence: 0.7, label: 'Microsoft Works for DOS document' };
    return 0;
  }),

  // ---- Lotus
  // ASCII magics: the binary file structure must follow ("WordPro is…" in a text file is text).
  R('lwp', 'Lotus Word Pro document', DOC, ['lwp', 'mwp', 'smt'], (c) => (c.at(0, 'WordPro') && c.binary() ? 0.97 : 0)),
  R('sam', 'Ami Pro document', DOC, ['sam'], (c) => (!c.binary() && /^\s*\[ver\][ \t]*\r?\n\s*\d/.test(c.head) ? 0.95 : 0)),

  // ---- Macintosh word processors
  R('cwk', 'ClarisWorks / AppleWorks document', DOC, ['cwk', 'cws'], (c) => (c.at(4, 'BOBO') ? { confidence: 0.95, label: `ClarisWorks / AppleWorks ${c.bytes[0] >= 5 ? c.bytes[0] : ''} document`.replace('  ', ' ') } : 0)),
  R('wn', 'WriteNow document', DOC, ['wn', 'wn2', 'wn3', 'wn4'], (c) => (c.at(0, 'WriteNow') && c.binary() ? 0.95 : 0)),
  R('mcw', 'MacWrite document', DOC, ['mcw', 'mw', 'mwii', 'mwp'], (c) => {
    const v = c.u16be(0);
    if ((v === 3 || v === 6) && c.u16be(2) > 0 && c.u16be(2) < 2000 && c.bytes.length > 0x100) return { confidence: 0.45, label: v === 6 ? 'MacWrite 4.5-5.0 document' : 'MacWrite 2.2 document' };
    if (c.u32be(0) === 0x00040004 && c.u16be(4) > 0 && c.u16be(4) < 0x40) return { confidence: 0.35, label: 'MacWrite Pro document' };
    return 0;
  }),

  // ---- Character-mode word processors
  R('wordstar', 'WordStar document', DOC, ['ws', 'ws1', 'ws2', 'ws3', 'ws4', 'ws5', 'ws6', 'ws7', 'wsd', 'wsw'], (c) => wordstarScore(c)),
  R('xywrite', 'XyWrite document', DOC, ['xy', 'xyw', 'xy3', 'xy4', 'nb'], (c) => {
    if (c.cfb() || c.zip()) return 0;
    const m = c.head.match(/\xae(MD|PG|FC|LM|RM|TS|DF|SS|RH|RF|NP|FN|PL|LS|IP|BX|HY|AL|AJ|AR|AC|LB|EL)[A-Z0-9 ,.]{0,40}\xaf/g) || [];
    return m.length >= 2 ? 0.85 : m.length === 1 ? 0.5 : 0;
  }),
  R('rft', 'DisplayWrite / DCA-RFT document', DOC, ['rft', 'dca', 'fft', 'dw4', 'dw5', 'env'], (c) => {
    const b = c.bytes;
    if (b.length < 64 || c.cfb() || c.zip()) return 0;
    // An RFT document starts with a structured field introducer: length, then class X'D3'.
    const intro = b[2] === 0xd3 && (b[3] === 0xa8 || b[3] === 0xa6 || b[3] === 0xee || b[3] === 0xeb) ? 0.4 : 0;
    let ebc = 0;
    const n = Math.min(b.length, 8192);
    for (let i = 0; i < n; i++) { const x = b[i]; if (x === 0x40 || (x >= 0x81 && x <= 0xa9) || (x >= 0xc1 && x <= 0xe9) || (x >= 0xf0 && x <= 0xf9) || x === 0x4b || x === 0x6b) ebc++; }
    const csp = (c.head.match(/\x2b[\xd0-\xd4]/g) || []).length;
    const s = intro + (ebc > n * 0.5 ? 0.35 : 0) + (csp > 2 ? 0.2 : 0);
    return s >= 0.5 ? Math.min(0.85, s) : 0;
  }),
  R('multimate', 'MultiMate document', DOC, ['dox', 'mm'], (c) => {
    if (c.cfb() || c.zip()) return 0;
    // MultiMate pages are 512-byte records; text uses 0xAF as a soft carriage return and 0x14 for tabs.
    const b = c.bytes;
    let soft = 0;
    for (let i = 0; i < Math.min(b.length, 8192); i++) if (b[i] === 0xaf && b[i - 1] !== 0xae) soft++;
    return (c.ext === 'dox' || c.ext === 'mm') && soft > 2 ? 0.4 : 0;
  }),

  // ---- Hangul
  R('hwp', 'Hangul (HWP) document', DOC, ['hwp', 'hwt'], (c) => {
    const fh = cfbStream(c, 'FileHeader');
    if (fh && String.fromCharCode(...fh.subarray(0, 17)) === 'HWP Document File') return { confidence: 0.99, label: 'Hangul 2002+ (HWP 5) document' };
    if (c.at(0, 'HWP Document File V')) return { confidence: 0.97, label: 'Hangul 97 (HWP 3) document' };
    return 0;
  }),
  R('hwpx', 'Hangul HWPX document', DOC, ['hwpx', 'owpml'], (c) => (/hwp\+zip/.test(zipMime(c)) || zipHas(c, 'Contents/section0.xml') ? 0.98 : 0)),

  // ---- Open formats and other word processors (recognition)
  R('odt', 'OpenDocument text', DOC, ['odt', 'ott', 'odm', 'oth'], (c) => (/opendocument\.text(-template|-master)?$/.test(zipMime(c)) ? 0.99 : 0)),
  R('fodt', 'Flat OpenDocument text', DOC, ['fodt', 'xml'], (c) => (!c.zip() && /opendocument\.text/.test(odfType(c)) ? 0.97 : 0)),
  R('sxw', 'OpenOffice.org 1.x text document', DOC, ['sxw', 'stw', 'sxg'], (c) => (/sun\.xml\.writer/.test(zipMime(c)) ? 0.98 : 0)),
  R('sdw', 'StarWriter document', DOC, ['sdw', 'vor', 'sgl'], (c) => (cfbHas(c, 'StarWriterDocument') ? 0.98 : 0)),
  R('rtf', 'Rich Text Format document', DOC, ['rtf'], (c) => (/^\s*\{\\rtf/.test(c.head) ? 0.99 : 0)),
  R('psw', 'Pocket Word document', DOC, ['psw', 'pwd', 'pwi'], (c) => (c.at(0, '{\\pwi') ? 0.95 : 0)),
  R('epub', 'EPUB e-book', DOC, ['epub'], (c) => (zipMime(c) === 'application/epub+zip' || zipHas(c, 'META-INF/container.xml') && !!zipFind(c, /\.opf$/i) ? 0.99 : 0)),
  R('abw', 'AbiWord document', DOC, ['abw', 'awt', 'zabw'], (c) => {
    const r = c.xmlRoot();
    if (r && r.name === 'abiword') return 0.97;
    const g = c.gunzip(2048);
    return g && /<abiword|<!DOCTYPE abiword/i.test(new TextDecoder().decode(g)) ? 0.95 : 0;
  }),
  R('fb2', 'FictionBook e-book', DOC, ['fb2', 'fbz'], (c) => { const r = c.xmlRoot(); if (r && r.name === 'FictionBook') return 0.97; return zipFind(c, /\.fb2$/i) && c.zip()!.names.length <= 3 ? 0.8 : 0; }),
  R('docbook', 'DocBook document', DOC, ['dbk', 'docbook', 'xml'], (c) => { const r = c.xmlRoot(); return r && (r.ns.some((n) => n.includes('docbook.org')) || /DocBook/i.test(c.head.slice(0, 600))) && /^(book|article|chapter|section|set|part)$/.test(r.name) ? 0.9 : 0; }),
  R('pages', 'Apple Pages document', DOC, ['pages'], (c) => (iwork(c) === 'pages' ? 0.93 : 0)),
  R('kwd', 'KWord / Calligra Words document', DOC, ['kwd'], (c) => (/x-kword|vnd\.kde\.kword/.test(zipMime(c)) ? 0.95 : 0)),
  R('t602', 'T602 document', DOC, ['602'], (c) => (/^@(CT|RS|PL|LM|RM|PO|LH|MT|MB|PN|HE|FO) /m.test(c.head.slice(0, 400)) && !c.binary() ? 0.7 : 0)),
  R('pdb', 'Palm e-text (PalmDOC, eReader, Plucker, zTXT)', DOC, ['pdb', 'prc'], (c) => {
    const tc = c.head.slice(60, 68);
    const m: Record<string, string> = { TEXtREAd: 'PalmDOC e-text', TEXtTlDc: 'TealDoc e-text', DataPlkr: 'Plucker e-book', zTXTGPlm: 'Weasel zTXT e-text', PNRdPPrs: 'eReader (Peanut Press) e-book', 'ToGoToGo': 'iSilo e-book' };
    return m[tc] ? { confidence: 0.95, label: m[tc] } : 0;
  }),
  R('mobi', 'Mobipocket / Kindle e-book', DOC, ['mobi', 'azw', 'azw3', 'prc'], (c) => (c.head.slice(60, 68) === 'BOOKMOBI' ? 0.97 : 0)),
  R('lrf', 'Sony BBeB e-book', DOC, ['lrf'], (c) => (c.at(0, 'L\0R\0F\0') ? 0.95 : 0)),
  // %PDF- at the start; within the first 1 KB only behind binary junk (a wrapper), never inside text.
  R('pdf', 'PDF document', DOC, ['pdf', 'ai'], (c) => (/^(\xef\xbb\xbf)?\s*%PDF-/.test(c.head.slice(0, 1024)) || (c.head.slice(0, 1024).includes('%PDF-') && c.binary()) ? 0.99 : 0)),
  R('webarchive', 'Safari web archive', DOC, ['webarchive'], (c) => (c.at(0, 'bplist00') && c.bytes.length < 50e6 && /WebMainResource/.test(new TextDecoder('latin1').decode(c.bytes.subarray(0, 200000))) ? 0.9 : 0)),
  R('qpd', 'Anne\'s Pen document', DOC, ['qpd', 'json'], (c) => (/^\s*\{\s*"(type|qf)"/.test(c.head) ? 0.95 : 0)),
  R('html', 'Web page (HTML)', DOC, ['html', 'htm', 'xhtml', 'xht', 'shtml', 'php', 'asp'], (c) => {
    if (c.binary()) return 0;
    const t = c.text().slice(0, 4096).toLowerCase();
    // Leading comments are skipped by a linear scan (a nested regex here was exponential).
    const i = skipProlog(t, false);
    if (t.startsWith('<!doctype html', i) || /^<html[\s>]/.test(t.slice(i, i + 6))) return 0.95;
    const r = c.xmlRoot();
    if (r && r.name === 'html') return 0.9;
    return /<(head|body|meta|title|p|div|table)[\s>]/.test(t) && /<\/(p|div|body|html|table|title)>/.test(t) ? 0.5 : 0;
  }),
  R('latex', 'LaTeX document', DOC, ['tex', 'latex', 'ltx'], (c) => (!c.binary() && /\\documentclass|\\begin\{document\}/.test(c.text().slice(0, 8192)) ? 0.85 : 0)),
  R('man', 'troff / man page', DOC, ['man', 'ms', 'me', 'mm', 'roff', 't', '1', '2', '3', '4', '5', '6', '7', '8'], (c) => (!c.binary() && /^\.(TH|SH|PP|LP|NH|TL)\b/m.test(c.text().slice(0, 4096)) && (c.text().match(/^\.[A-Z]{1,2}\b/gm) || []).length > 3 ? 0.6 : 0)),
  R('rtfd', 'RTFD document (zipped)', DOC, ['rtfd', 'zip'], (c) => (c.zip()?.find(/(^|\/)TXT\.rtf$/) ? 0.85 : 0)),
  // Plain-text markup languages: recognized by extension (their importers add content rules).
  R('rst', 'reStructuredText document', DOC, ['rst', 'rest']),
  R('textile', 'Textile document', DOC, ['textile']),
  R('asciidoc', 'AsciiDoc document', DOC, ['adoc', 'asciidoc', 'asc']),
  R('org', 'Org mode document', DOC, ['org']),
  R('md', 'Markdown document', DOC, ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'txt.md'], (c) => {
    if (c.binary()) return 0;
    const t = c.text().slice(0, 8192);
    let s = 0;
    if (/^#{1,6} \S/m.test(t)) s += 0.25;
    if (/^```/m.test(t)) s += 0.2;
    if (/\[[^\]\n]+\]\([^)\s]+\)/.test(t)) s += 0.15;
    if (/^\s*[-*+] \S/m.test(t)) s += 0.05;
    if (/(\*\*|__)\S[^*\n]*\S\1/.test(t)) s += 0.1;
    if (/^\|.*\|\s*\n\|[ :-]+\|/m.test(t)) s += 0.15;
    return s >= 0.35 ? Math.min(0.6, s) : 0;
  }),

  // ---- Spreadsheets
  R('xlsx', 'Excel workbook (Office Open XML)', SHEET, ['xlsx', 'xlsm', 'xltx', 'xltm', 'xlam'], (c) => (zipHas(c, 'xl/workbook.xml') ? 0.99 : 0)),
  R('xlsb', 'Excel binary workbook', SHEET, ['xlsb'], (c) => (zipHas(c, 'xl/workbook.bin') ? 0.99 : 0)),
  R('xls', 'Excel 97-2003 workbook', SHEET, ['xls', 'xlt', 'xla', 'et', 'ett', 'xlr'], (c) => {
    if (cfbHas(c, 'Workbook')) return cfbHas(c, 'WksSSWorkBook') ? { confidence: 0.97, label: 'Microsoft Works spreadsheet', format: 'xls' } : { confidence: 0.98, label: 'Excel 97-2003 workbook' };
    if (cfbHas(c, 'Book')) return { confidence: 0.98, label: 'Excel 5.0/95 workbook' };
    const op = c.u16le(0), len = c.u16le(2);
    if ((op === 0x0009 || op === 0x0209 || op === 0x0409 || op === 0x0809) && len >= 4 && len <= 20) {
      const v: Record<number, string> = { 0x0009: '2.x', 0x0209: '3.0', 0x0409: '4.0', 0x0809: '5.0+' };
      return { confidence: 0.85, label: `Excel ${v[op]} worksheet` };
    }
    return 0;
  }),
  R('ods', 'OpenDocument spreadsheet', SHEET, ['ods', 'ots', 'fods'], (c) => (/opendocument\.spreadsheet/.test(odfType(c)) ? 0.99 : 0)),
  R('sxc', 'OpenOffice.org 1.x / StarCalc spreadsheet', SHEET, ['sxc', 'stc', 'sdc'], (c) => (/sun\.xml\.calc/.test(zipMime(c)) || cfbHas(c, 'StarCalcDocument') ? 0.97 : 0)),
  R('xlsx2003', 'Excel 2003 XML spreadsheet', SHEET, ['xml'], (c) => { const r = c.xmlRoot(); return r && r.name === 'Workbook' && r.ns.some((n) => n.includes('office:spreadsheet')) ? 0.95 : 0; }),
  R('numbers', 'Apple Numbers spreadsheet', SHEET, ['numbers'], (c) => (iwork(c) === 'numbers' ? 0.93 : 0)),
  R('gnumeric', 'Gnumeric spreadsheet', SHEET, ['gnumeric', 'gnm'], (c) => { const g = c.gunzip(2048); return g && /gnm:Workbook|gnumeric/i.test(new TextDecoder().decode(g)) ? 0.95 : c.xmlRoot()?.name === 'Workbook' && /gnumeric/i.test(c.head) ? 0.9 : 0; }),
  R('lotus123', 'Lotus 1-2-3 worksheet', SHEET, ['wk1', 'wks', 'wk3', 'wk4', '123', 'wk2', 'wr1', 'wrk'], (c) => {
    if (c.u16le(0) !== 0 || c.cfb()) return 0;
    const len = c.u16le(2), v = c.u16le(4);
    if (len === 2 && v === 0x0404) return { confidence: 0.75, label: 'Lotus 1-2-3 / Works worksheet (WKS)' };
    if (len === 2 && (v === 0x0406 || v === 0x0405)) return { confidence: 0.85, label: 'Lotus 1-2-3 Release 2 worksheet (WK1)' };
    if (len === 0x1a && v >= 0x1000 && v <= 0x1006) return { confidence: 0.9, label: v <= 0x1001 ? 'Lotus 1-2-3 Release 3 worksheet (WK3)' : v === 0x1002 ? 'Lotus 1-2-3 Release 4 worksheet (WK4)' : 'Lotus 1-2-3 97+ workbook (123)' };
    return 0;
  }),
  R('quattro', 'Quattro Pro spreadsheet', SHEET, ['qpw', 'wb1', 'wb2', 'wb3', 'wq1', 'wq2', 'wkq'], (c) => {
    if (cfbHas(c, 'NativeContent_MAIN')) return { confidence: 0.95, label: 'Quattro Pro 9+ notebook' };
    const pm = cfbStream(c, 'PerfectOffice_MAIN');
    if (pm && (c.cfb()!.root.clsid.startsWith('5c6f62eb') || /^(qpw|wb3)$/.test(c.ext))) return { confidence: 0.9, label: 'Quattro Pro 7/8 notebook' };
    if (c.u16le(0) === 0 && c.u16le(2) === 2) {
      const v = c.u16le(4);
      if (v === 0x1001 || v === 0x1002) return { confidence: 0.85, label: `Quattro Pro for Windows ${v === 0x1001 ? '1' : '5-6'} notebook` };
      if (v === 0x5120 || v === 0x5121) return { confidence: 0.85, label: 'Quattro Pro for DOS spreadsheet' };
    }
    return 0;
  }),
  R('works-sheet', 'Microsoft Works spreadsheet or database', SHEET, ['wks', 'wdb', 'xlr'], (c) => {
    if (c.cfb()?.find('MN0') && WORKS_NOT_WP.test(compObjName(c))) return 0.9;
    if (c.u16le(0) === 0x5420 && c.u16le(2) === 2) return 0.8;
    if (c.u16le(0) === 0xff && c.u16le(2) === 2 && c.u16le(4) === 0x0404) return 0.8;
    return 0;
  }),
  R('dbf', 'dBASE / FoxPro table', SHEET, ['dbf', 'dbase'], (c) => {
    const b = c.bytes;
    if (b.length < 66 || ![0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8b, 0xcb, 0xf5, 0xfb].includes(b[0])) return 0;
    const mm = b[2], dd = b[3], n = c.u32le(4), hdr = c.u16le(8), rec = c.u16le(10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hdr < 65 || hdr > b.length || rec < 1) return 0;
    if ((hdr - 33) % 32 !== 0 && (hdr - 33 - 263) % 32 !== 0 && b[hdr - 1] !== 0x0d) return 0;
    // The records must fit the file (a truncated table may end early), and the first field
    // descriptor needs a field type letter.
    if (hdr + n * rec > b.length + 1 || b.length - (hdr + n * rec) > Math.max(4096, rec)) return 0;
    if (!'CNLDMFBGPYTIV@O+0WQ'.includes(String.fromCharCode(b[43]))) return 0;
    return 0.8;
  }),
  R('sylk', 'SYLK spreadsheet', SHEET, ['slk', 'sylk'], (c) => (/^ID;(P|N)/.test(c.head) ? 0.9 : 0)),
  R('dif', 'Data Interchange Format', SHEET, ['dif'], (c) => (/^TABLE\r?\n0,1\r?\n/.test(c.head) ? 0.9 : 0)),
  // Prose has commas and tabs too: outside .csv/.tsv a table needs three consistent rows, and
  // never wins over a text file name or a name with no extension.
  R('csv', 'Comma-separated values', SHEET, ['csv'], (c) => (c.binary() || TABLE_NO.test(c.ext) ? 0 : Math.max(csvScore(c.text().slice(0, 16384), ',', tableRows(c)), csvScore(c.text().slice(0, 16384), ';', tableRows(c)) * 0.95))),
  R('tsv', 'Tab-separated values', SHEET, ['tsv', 'tab'], (c) => (c.binary() || TABLE_NO.test(c.ext) ? 0 : csvScore(c.text().slice(0, 16384), '\t', tableRows(c)) * 0.9)),

  // ---- Presentations
  R('pptx', 'PowerPoint presentation (Office Open XML)', PRES, ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'], (c) => (zipHas(c, 'ppt/presentation.xml') ? 0.99 : 0)),
  R('ppt', 'PowerPoint 97-2003 presentation', PRES, ['ppt', 'pps', 'pot', 'dps', 'dpt'], (c) => {
    if (cfbHas(c, 'PowerPoint Document')) return 0.98;
    if (cfbHas(c, 'PP40')) return { confidence: 0.95, label: 'PowerPoint 4.0 presentation' };
    if (c.u32le(0) === 0x0baddeed) return { confidence: 0.85, label: 'PowerPoint 2/3 presentation' };
    if (c.u32be(0) === 0x0baddeed) return { confidence: 0.85, label: 'PowerPoint for Macintosh presentation' };
    return 0;
  }),
  R('odp', 'OpenDocument presentation', PRES, ['odp', 'otp', 'fodp'], (c) => (/opendocument\.presentation/.test(odfType(c)) ? 0.99 : 0)),
  R('sxi', 'OpenOffice.org 1.x / StarImpress presentation', PRES, ['sxi', 'sti', 'sdd'], (c) => (/sun\.xml\.impress/.test(zipMime(c)) || (cfbHas(c, 'StarDrawDocument3') && /impress/i.test(compObjName(c) + c.ext)) ? 0.95 : 0)),
  R('key', 'Apple Keynote presentation', PRES, ['key', 'kth'], (c) => (iwork(c) === 'key' ? 0.93 : 0)),
  R('shw', 'Corel Presentations slide show', PRES, ['shw', 'shb'], (c) => (cfbHas(c, 'SlideShow') || (wpc(c)?.product === 0x0f) ? 0.9 : 0)),
  R('prz', 'Lotus Freelance Graphics presentation', PRES, ['prz', 'pre'], (c) => (c.ext === 'prz' || c.ext === 'pre' ? 0.2 : 0)),

  // ---- Email
  R('msg', 'Outlook message', MAIL, ['msg', 'oft'], (c) => { const f = c.cfb(); return f && f.find('__properties_version1.0') && (f.find('__substg1.0_0037001F') || f.find('__substg1.0_0037001E') || f.entries.some((e) => e.name.startsWith('__substg1.0_'))) ? 0.98 : 0; }),
  R('tnef', 'TNEF (winmail.dat) attachment bundle', MAIL, ['dat', 'tnef'], (c) => (c.u32le(0) === 0x223e9f78 ? 0.97 : 0)),
  R('pst', 'Outlook data file', MAIL, ['pst', 'ost'], (c) => (c.at(0, '!BDN') ? 0.97 : 0)),
  R('dbx', 'Outlook Express folder', MAIL, ['dbx'], (c) => (c.u32le(0) === 0xfe12adcf ? 0.95 : 0)),
  R('emlx', 'Apple Mail message', MAIL, ['emlx', 'partial.emlx'], (c) => { const m = /^(\d{1,9})[ \t]*\r?\n/.exec(c.head); return m && mailHeaders(c.text().slice(m[0].length)).score >= 0.6 ? 0.9 : 0; }),
  // "From <address> <asctime date>" followed by a header block ("From here to eternity" is prose).
  R('mbox', 'Mailbox (mbox)', MAIL, ['mbox', 'mbx', 'mbs', 'mail'], (c) => (c.binary() ? 0 : MBOX_FROM.test(c.head) ? 0.85 : 0)),
  R('mhtml', 'Web archive (MHTML)', MAIL, ['mht', 'mhtml'], (c) => {
    if (c.binary()) return 0;
    const h = mailHeaders(c.text());
    if (/multipart\/related/.test(h.mime) || (/^MIME-Version:/im.test(c.head) && /Snapshot-Content-Location|Content-Location:/i.test(c.text().slice(0, 16384)) && /text\/html/i.test(c.text().slice(0, 16384)) && !/^(Received|Message-ID|Delivered-To):/im.test(c.head))) return { confidence: 0.92, label: 'Web archive (MHTML)', category: 'document' };
    return 0;
  }),
  R('eml', 'Email message', MAIL, ['eml', 'nws', 'mim', 'mime', 'rfc822', 'email'], (c) => (c.binary() ? 0 : mailHeaders(c.text()).score * 0.98)),

  // ---- Other things people open by mistake (recognized, not imported)
  R('image', 'Image', UNK, ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'ico', 'heic', 'avif', 'wmf', 'emf', 'wpg', 'svg'], (c) => {
    const b = c.bytes;
    if (b[0] === 0x89 && c.at(1, 'PNG')) return { confidence: 0.99, label: 'PNG image' };
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { confidence: 0.99, label: 'JPEG image' };
    if (c.at(0, 'GIF8')) return { confidence: 0.99, label: 'GIF image' };
    if (c.at(0, 'BM') && c.u32le(2) === b.length) return { confidence: 0.9, label: 'BMP image' };
    if (c.at(0, 'II*\0') || c.at(0, 'MM\0*')) return { confidence: 0.95, label: 'TIFF image' };
    if (c.at(0, 'RIFF') && c.at(8, 'WEBP')) return { confidence: 0.99, label: 'WebP image' };
    if (c.u32le(0) === 0x9ac6cdd7) return { confidence: 0.95, label: 'Windows metafile (WMF)' };
    if (c.u32le(0) === 1 && c.at(40, ' EMF')) return { confidence: 0.95, label: 'Enhanced metafile (EMF)' };
    const w = wpc(c);
    if (w && w.type === 0x16) return { confidence: 0.95, label: 'WordPerfect graphic (WPG)' };
    const r = c.xmlRoot();
    if (r && r.name === 'svg') return { confidence: 0.9, label: 'SVG image' };
    return 0;
  }),
  R('archive', 'Archive', UNK, ['zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'cab', 'arj', 'lzh'], (c) => {
    if (c.at(0, '7z\xbc\xaf\x27\x1c')) return { confidence: 0.95, label: '7-Zip archive' };
    if (c.at(0, 'Rar!\x1a\x07')) return { confidence: 0.95, label: 'RAR archive' };
    if (c.at(0, 'MSCF')) return { confidence: 0.95, label: 'Cabinet archive' };
    if (c.at(257, 'ustar')) return { confidence: 0.9, label: 'TAR archive' };
    if (c.bytes[0] === 0x1f && c.bytes[1] === 0x8b) return { confidence: 0.3, label: 'gzip-compressed file' };
    if (c.zip()) return { confidence: 0.3, label: 'ZIP archive' };
    return 0;
  }),
  R('visio', 'Visio drawing', UNK, ['vsd', 'vss', 'vst', 'vsdx'], (c) => (cfbHas(c, 'VisioDocument') || zipHas(c, 'visio/document.xml') ? 0.97 : 0)),
  R('publisher', 'Publisher document', UNK, ['pub'], (c) => (cfbHas(c, 'Quill') ? 0.95 : 0)),
  R('ooxml-encrypted', 'Password-protected Office document', UNK, ['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm'], (c) => (cfbHas(c, 'EncryptedPackage') ? 0.97 : 0)),
  R('exe', 'Program file', UNK, ['exe', 'dll', 'com', 'msi', 'so', 'dylib'], (c) => (c.at(0, 'MZ') && c.u32le(0x3c) < c.bytes.length && c.at(c.u32le(0x3c), 'PE\0\0') ? 0.95 : c.at(0, '\x7fELF') ? 0.95 : 0)),
  R('media', 'Audio or video file', UNK, ['mp3', 'mp4', 'm4a', 'wav', 'avi', 'mov', 'ogg', 'flac', 'mkv', 'webm'], (c) => (c.at(4, 'ftyp') || (c.at(0, 'ID3') && id3Header(c.bytes)) || c.at(0, 'OggS') || c.at(0, 'fLaC') || (c.at(0, 'RIFF') && (c.at(8, 'WAVE') || c.at(8, 'AVI '))) || c.at(0, '\x1aE\xdf\xa3') ? 0.95 : 0)),
  R('sqlite', 'SQLite database', UNK, ['sqlite', 'db', 'sqlite3'], (c) => (c.at(0, 'SQLite format 3\0') ? 0.97 : 0)),
];

// Plain text is the fallback for anything textual; extension-only matches come last.
const TXT: SniffRule = R('txt', 'Plain text', DOC, ['txt', 'text', 'log', 'asc', 'nfo', 'me', 'ini', 'cfg', 'conf', 'diz', '1st', 'readme']);

const extra: SniffRule[] = [];

/**
 * Add a detection rule (format modules call this at load time). A module's rule replaces the
 * built-in rule for the same format, so each format has one rule; registering again replaces it.
 */
export function registerSniffer(rule: SniffRule): void {
  const i = extra.findIndex((r) => r.format === rule.format);
  if (i >= 0) extra[i] = rule; else extra.push(rule);
}

/** Every rule: the built-in ones not replaced by a registered rule, then the registered ones. */
export function sniffRules(): readonly SniffRule[] {
  const replaced = new Set(extra.map((r) => r.format));
  return [...RULES.filter((r) => !replaced.has(r.format)), ...extra];
}

const article = (s: string) => (/^[aeiou]/i.test(s) && !/^(one|uni|use|eu)/i.test(s) ? 'an' : 'a');
/** "Opened as a WordPerfect document; the file name says .doc". */
function mismatchNote(label: string, ext: string, by: 'content' | 'none'): string {
  const what = /\b(document|workbook|spreadsheet|presentation|message|file|worksheet|notebook|table|e-?book|e-text|page|archive|image|drawing|slide show|bundle|folder|values|format|data file|mailbox|values)\b/i.test(label) ? label : `${label} file`;
  const a = /^(Word|Excel|PowerPoint|Outlook|Microsoft|Lotus|Apple|Kingsoft|Hangul|OpenDocument|OpenOffice|StarOffice|Corel|Quattro|WordPerfect|ClarisWorks|MacWrite|WriteNow|WordStar|XyWrite|DisplayWrite|MultiMate|Ami Pro|AbiWord|KWord|Gnumeric|SYLK|dBASE|Windows|Safari|Palm|Mobipocket|Sony|FictionBook|DocBook|PDF|TNEF|Pocket|T602|Rich|Plain|Web|Email|Mailbox|LetterPerfect)\b/.test(what) ? article(what) + ' ' : '';
  const name = a ? `${a}${what}` : what;
  return by === 'none' ? `Opened as ${name}; the file name has no extension.` : `Opened as ${name}; the file name says .${ext}.`;
}

/** Identify a file from its content; the name's extension only breaks ties. */
export function sniff(data: ArrayBuffer | Uint8Array, name = ''): SniffResult {
  const ctx = makeContext(data, name);
  const ext = ctx.ext;
  let best: { rule: SniffRule; hit: SniffHit; score: number } | null = null;
  for (const rule of sniffRules()) {
    if (!rule.test) continue;
    let r: ReturnType<NonNullable<SniffRule['test']>>;
    try { r = rule.test(ctx); } catch { r = 0; }
    const hit: SniffHit | null = !r ? null : typeof r === 'number' ? { confidence: r } : r;
    if (!hit || !(hit.confidence > 0)) continue;
    const extMatch = ext && rule.ext.includes(ext) ? 0.06 : 0;
    const score = Math.min(1, hit.confidence) + extMatch;
    if (!best || score > best.score) best = { rule, hit, score };
  }
  const empty = ctx.bytes.length === 0;
  // A text file name wins over weak content guesses (heuristics, light markup, tables): only a
  // real signature (≥ 0.8) reopens a readable .txt as something else.
  if (best && PLAIN_TEXT_EXTS.includes(ext) && best.hit.confidence < 0.8 && best.rule.format !== 'txt' && !ctx.binary()) best = null;
  if (!best || best.hit.confidence < 0.3) {
    // Weak or no content match: trust the extension when a rule claims it, else plain text or unknown.
    const byExt = ext ? sniffRules().find((r) => r.ext[0] === ext && r.format !== 'txt') || sniffRules().find((r) => r.ext.includes(ext) && r.format !== 'txt') : undefined;
    if (byExt && byExt !== best?.rule) return { format: byExt.format, label: byExt.label, confidence: empty ? 0.1 : 0.2, category: byExt.category, note: '', ext, exts: byExt.ext };
    if (!best) {
      if (!ctx.binary() || empty) {
        const enc = ctx.encoding();
        const label = enc && enc !== 'utf-8' && enc !== 'windows-1252' ? `Plain text (${enc.toUpperCase()})` : 'Plain text';
        return { format: 'txt', label, confidence: empty ? 0.1 : 0.4, category: 'document', note: '', ext, exts: TXT.ext };
      }
      return { format: 'unknown', label: 'Unrecognized file', confidence: 0, category: 'unknown', note: '', ext, exts: [] };
    }
  }
  const { rule, hit } = best;
  const format = hit.format || rule.format;
  const label = hit.label || rule.label;
  const category = hit.category || rule.category;
  let note = '';
  if (!ext) note = category === 'unknown' ? '' : mismatchNote(label, '', 'none');
  else if (!rule.ext.includes(ext) && hit.confidence >= 0.5) note = mismatchNote(label, ext, 'content');
  return { format, label, confidence: Math.round(Math.min(1, hit.confidence) * 100) / 100, category, note, ext, exts: rule.ext };
}
