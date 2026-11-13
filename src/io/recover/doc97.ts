/**
 * Word 97-2003 (.doc) text extraction.
 *
 * Reads the OLE2 compound file, then the FIB and the piece table (CLX) in the 0Table/1Table
 * stream, and decodes each piece as CP1252 ("compressed") or UTF-16LE. Field codes are
 * dropped and their results kept. Paragraph, cell, row, line and page marks become text
 * structure. Character and paragraph formatting is not read.
 *
 * Every read is bounds-checked and every sector chain is cycle-guarded, so a damaged file
 * yields whatever text is still reachable instead of throwing.
 */
import { cp1252 } from './salvage';

const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END = 0xfffffffe;

export function isOle2(u8: Uint8Array): boolean {
  return OLE_SIG.every((b, i) => u8[i] === b);
}

export interface CfbStreams {
  /** Root-level streams by name (case preserved). */
  streams: Map<string, Uint8Array>;
  /** Chains that ended early or looped. */
  damaged: string[];
}

export function readCfb(b: Uint8Array): CfbStreams | null {
  if (b.length < 512 || !isOle2(b)) return null;
  const u16 = (o: number) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
  const u32 = (o: number) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : END);
  let shift = u16(0x1e);
  if (shift !== 9 && shift !== 12) shift = 9;
  const secSize = 1 << shift;
  let miniShift = u16(0x20);
  if (miniShift < 2 || miniShift > 12) miniShift = 6;
  const miniSize = 1 << miniShift;
  const dirStart = u32(0x30);
  const miniCutoff = u32(0x38) || 4096;
  const miniFatStart = u32(0x3c);
  const difatStart = u32(0x44);
  const damaged: string[] = [];
  const secOff = (sid: number) => (sid + 1) * secSize;
  const maxSid = Math.ceil(b.length / secSize);

  // FAT sector list from the header DIFAT and any DIFAT chain.
  // No more FAT sectors than it takes to map the file; a sector listed twice is read once.
  const perSec = secSize / 4;
  const maxFat = Math.ceil(maxSid / perSec);
  const fatSids: number[] = [];
  const listed = new Set<number>();
  const addFat = (s: number) => { if (s < maxSid && fatSids.length < maxFat) { fatSids.push(listed.has(s) ? 0xffffffff : s); listed.add(s); } };
  for (let k = 0; k < 109; k++) addFat(u32(0x4c + k * 4));
  const seenDifat = new Set<number>();
  for (let d = difatStart; d < maxSid && !seenDifat.has(d) && fatSids.length < maxFat; ) {
    seenDifat.add(d);
    const off = secOff(d);
    const per = secSize / 4 - 1;
    for (let k = 0; k < per; k++) addFat(u32(off + k * 4));
    d = u32(off + per * 4);
  }
  const fat = new Uint32Array(fatSids.length * perSec).fill(END);
  fatSids.forEach((sid, n) => { if (sid === 0xffffffff) return; const off = secOff(sid); for (let k = 0; k < perSec; k++) fat[n * perSec + k] = u32(off + k * 4); });

  /** Follow a sector chain. A chain that ends on anything but ENDOFCHAIN is reported as broken. */
  const chain = (start: number, table: Uint32Array, limit: number, label: string): { sids: number[]; broken: boolean } => {
    const out: number[] = [];
    const seen = new Set<number>();
    let s = start;
    while (s < limit && !seen.has(s)) {
      seen.add(s); out.push(s);
      if (s >= table.length) { s = 0xffffffff; break; }
      s = table[s];
    }
    const broken = s !== END && out.length > 0;
    if (broken) damaged.push(label);
    return { sids: out, broken };
  };
  /** Damaged FAT: assume the rest of a stream follows its last good sector (writers allocate sequentially). */
  const extend = (c: { sids: number[]; broken: boolean }, need: number, limit: number) => {
    if (!c.broken) return c.sids;
    const sids = [...c.sids];
    let next = (sids[sids.length - 1] ?? -1) + 1;
    while (sids.length < need && next < limit) sids.push(next++);
    return sids;
  };
  const readBig = (start: number, size: number | null, label: string): Uint8Array => {
    const c = chain(start, fat, maxSid, label);
    const sids = size != null ? extend(c, Math.ceil(size / secSize), maxSid) : c.sids;
    const total = size ?? sids.length * secSize;
    const out = new Uint8Array(Math.min(total, sids.length * secSize));
    let w = 0;
    for (const sid of sids) {
      if (w >= out.length) break;
      const off = secOff(sid);
      const n = Math.min(secSize, out.length - w, Math.max(0, b.length - off));
      out.set(b.subarray(off, off + n), w);
      w += n;
    }
    if (size != null && w < size) damaged.push(label);
    return out.subarray(0, w);
  };

  interface Entry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
  const parseEntries = (dir: Uint8Array, stopAtInvalid: boolean): Entry[] => {
    const entries: Entry[] = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
      const nameLen = dir[o + 0x40] | (dir[o + 0x41] << 8);
      const type = dir[o + 0x42];
      if (stopAtInvalid && (type > 5 || nameLen > 64 || nameLen % 2 || (type !== 0 && nameLen < 4))) break;
      let name = '';
      for (let k = 0; k + 1 < Math.min(64, nameLen) - 1; k += 2) name += String.fromCharCode(dir[o + k] | (dir[o + k + 1] << 8));
      const r32 = (p: number) => (dir[o + p] | (dir[o + p + 1] << 8) | (dir[o + p + 2] << 16) | (dir[o + p + 3] << 24)) >>> 0;
      entries.push({ name, type, left: r32(0x44), right: r32(0x48), child: r32(0x4c), start: r32(0x74), size: r32(0x78) });
    }
    return entries;
  };
  const dc = chain(dirStart, fat, maxSid, 'directory');
  let entries: Entry[];
  if (dc.broken) {
    // Unknown directory length: read on while the following sectors still look like entries.
    const sids = [...dc.sids];
    for (let n = (sids[sids.length - 1] ?? dirStart) + 1; n < maxSid; n++) {
      const probe = parseEntries(b.subarray(secOff(n), secOff(n) + secSize), true);
      if (probe.length < secSize / 128) { if (probe.length) sids.push(n); break; }
      sids.push(n);
    }
    entries = parseEntries(concatSectors(b, sids, secOff, secSize), true);
  } else entries = parseEntries(concatSectors(b, dc.sids, secOff, secSize), false);
  if (!entries[0] || entries[0].type !== 5) {
    // The header's directory pointer is bad: find the "Root Entry" record directly.
    const sig = [0x52, 0, 0x6f, 0, 0x6f, 0, 0x74, 0, 0x20, 0, 0x45, 0, 0x6e, 0, 0x74, 0, 0x72, 0, 0x79, 0];
    for (let o = 512; o + 128 <= b.length; o += 128) {
      if (sig.every((v, k) => b[o + k] === v) && b[o + 0x42] === 5) { entries = parseEntries(b.subarray(o), true); damaged.push('directory'); break; }
    }
  }
  const root = entries[0];
  if (!root || root.type !== 5) return null;
  const miniStream = readBig(root.start, root.size, 'mini stream');
  const miniFatBytes = readBig(miniFatStart, null, 'mini FAT');
  const miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
  for (let k = 0; k < miniFat.length; k++) miniFat[k] = (miniFatBytes[k * 4] | (miniFatBytes[k * 4 + 1] << 8) | (miniFatBytes[k * 4 + 2] << 16) | (miniFatBytes[k * 4 + 3] << 24)) >>> 0;
  const readMini = (start: number, size: number, label: string): Uint8Array => {
    const limit = Math.ceil(miniStream.length / miniSize);
    const sids = extend(chain(start, miniFat, limit, label), Math.ceil(size / miniSize), limit);
    const out = new Uint8Array(Math.min(size, sids.length * miniSize));
    let w = 0;
    for (const sid of sids) {
      if (w >= out.length) break;
      const off = sid * miniSize;
      const n = Math.min(miniSize, out.length - w, Math.max(0, miniStream.length - off));
      out.set(miniStream.subarray(off, off + n), w);
      w += n;
    }
    if (w < size) damaged.push(label);
    return out.subarray(0, w);
  };

  // Root-level children: walk the red-black sibling tree under root.child.
  const streams = new Map<string, Uint8Array>();
  const visit = new Set<number>();
  const stack = [root.child];
  while (stack.length) {
    const id = stack.pop()!;
    if (id >= entries.length || visit.has(id)) continue;
    visit.add(id);
    const e = entries[id];
    stack.push(e.left, e.right);
    if (e.type !== 2) continue;
    streams.set(e.name, e.size < miniCutoff ? readMini(e.start, e.size, e.name) : readBig(e.start, e.size, e.name));
  }
  // A damaged directory tree can hide streams; fall back to a flat scan of entries.
  if (!streams.has('WordDocument')) {
    for (const e of entries) {
      if (e.type === 2 && !streams.has(e.name)) streams.set(e.name, e.size < miniCutoff ? readMini(e.start, e.size, e.name) : readBig(e.start, e.size, e.name));
    }
  }
  return { streams, damaged: [...new Set(damaged)] };
}

function concatSectors(b: Uint8Array, sids: number[], secOff: (sid: number) => number, secSize: number): Uint8Array {
  const out = new Uint8Array(sids.length * secSize);
  sids.forEach((sid, k) => { const off = secOff(sid); out.set(b.subarray(off, Math.min(off + secSize, b.length)), k * secSize); });
  return out;
}

export interface Doc97Text {
  main: string;
  footnotes: string;
  comments: string;
  endnotes: string;
  textboxes: string;
  encrypted: boolean;
  method: 'piece table' | 'fcMin/fcMac' | 'stream scan';
  damaged: string[];
}

/** Turn Word binary special characters into plain text structure. */
export function cleanWordText(raw: string): string {
  let out = '';
  const fields: ('code' | 'result')[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x13) { fields.push('code'); continue; }
    if (c === 0x14) { if (fields.length) fields[fields.length - 1] = 'result'; continue; }
    if (c === 0x15) { fields.pop(); continue; }
    if (fields.length && fields.includes('code')) continue;
    if (c === 0x0d) out += '\n';
    else if (c === 0x07) {
      // Cell mark; a second mark straight after one ends the table row.
      if (raw.charCodeAt(i + 1) === 0x07) { out += '\n'; i++; }
      else out += '\t';
    } else if (c === 0x0b) out += '\n';
    else if (c === 0x0c) out += '\f';
    else if (c === 0x0e) out += '\n';
    else if (c === 0x1e) out += '‑';
    else if (c === 0x1f) continue;
    else if (c === 0x09) out += '\t';
    else if (c < 0x20) continue;
    else out += raw[i];
  }
  return out.replace(/\t+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
}

/** Find a FIB at a sector boundary: the start of the WordDocument stream when the directory is lost. */
function findFib(u8: Uint8Array): number {
  for (let o = 512; o + 64 < u8.length; o += 512) {
    if (u8[o] === 0xec && u8[o + 1] === 0xa5) {
      const nFib = u8[o + 2] | (u8[o + 3] << 8);
      if (nFib >= 0x65 && nFib <= 0x200) return o;
    }
  }
  return -1;
}

export function extractDoc97(u8: Uint8Array): Doc97Text | null {
  const cfb = readCfb(u8);
  let wd = cfb?.streams.get('WordDocument');
  let streams = cfb?.streams ?? new Map<string, Uint8Array>();
  const damaged = cfb?.damaged ?? [];
  if (!wd || wd.length < 64) {
    if (!isOle2(u8) && !(u8[0] === 0xec && u8[1] === 0xa5)) return null;
    const at = u8[0] === 0xec && u8[1] === 0xa5 ? 0 : findFib(u8);
    if (at < 0) return null;
    // Assume the stream is contiguous from the FIB to the end of the file; locate the piece table by search.
    wd = u8.subarray(at);
    streams = new Map([['WordDocument', wd]]);
    damaged.push('directory (WordDocument located by its FIB signature)');
  }
  const cfbLike: CfbStreams = { streams, damaged };
  return extractFromStreams(u8, wd, cfbLike);
}

function extractFromStreams(file: Uint8Array, wd: Uint8Array, cfb: CfbStreams): Doc97Text | null {
  const u16 = (b: Uint8Array, o: number) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
  const u32 = (b: Uint8Array, o: number) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);
  const res: Doc97Text = { main: '', footnotes: '', comments: '', endnotes: '', textboxes: '', encrypted: false, method: 'piece table', damaged: cfb.damaged };
  if (u16(wd, 0) !== 0xa5ec && u16(wd, 0) !== 0xa5dc) {
    res.method = 'stream scan';
    res.main = scanStreamText(wd);
    return res;
  }
  const nFib = u16(wd, 2);
  const flags = u16(wd, 0x0a);
  res.encrypted = !!(flags & 0x0100);
  if (res.encrypted) return res;

  // Word 6/95: text runs from fcMin to fcMac in the WordDocument stream, one byte per char.
  if (nFib < 101) {
    const fcMin = u32(wd, 0x18), fcMac = u32(wd, 0x1c);
    if (fcMac > fcMin && fcMac <= wd.length) {
      res.method = 'fcMin/fcMac';
      let s = '';
      for (let k = fcMin; k < fcMac; k++) s += cp1252(wd[k]);
      res.main = cleanWordText(s);
    } else { res.method = 'stream scan'; res.main = scanStreamText(wd); }
    return res;
  }

  let p = 32;
  const csw = u16(wd, p); p += 2 + csw * 2;
  const cslw = u16(wd, p);
  const lw = p + 2;
  p = lw + cslw * 4;
  const cbRgFcLcb = u16(wd, p);
  const fcBase = p + 2;
  const ccp = (k: number) => (k < cslw ? u32(wd, lw + k * 4) : 0);
  const ccpText = ccp(3), ccpFtn = ccp(4), ccpHdd = ccp(5), ccpMcr = ccp(6), ccpAtn = ccp(7), ccpEdn = ccp(8), ccpTxbx = ccp(9);
  const tbl = cfb.streams.get(flags & 0x0200 ? '1Table' : '0Table') || cfb.streams.get('1Table') || cfb.streams.get('0Table');
  const fcClx = cbRgFcLcb > 33 ? u32(wd, fcBase + 33 * 8) : 0;
  const lcbClx = cbRgFcLcb > 33 ? u32(wd, fcBase + 33 * 8 + 4) : 0;

  let full: string | null = null;
  if (tbl && lcbClx && fcClx + lcbClx <= tbl.length) full = readPieces(wd, tbl, fcClx, lcbClx);
  if (full == null) {
    // The table stream is lost or damaged: search the whole file for a piece table whose
    // character positions start at 0 and end at the document's total length.
    const total = ccpText + ccpFtn + ccpHdd + ccpMcr + ccpAtn + ccpEdn + ccpTxbx + ccp(10) + (ccpFtn + ccpHdd + ccpAtn + ccpEdn + ccpTxbx ? 1 : 0);
    const clx = findPcdt(file, total);
    if (clx) { full = readPieces(wd, file, clx.at, clx.lcb + 5); res.damaged.push('piece table located by search'); }
  }
  if (full == null && ccpText > 0) {
    // Non-complex files store the main text in one run starting at fcMin.
    const fcMin = u32(wd, 0x18);
    const cands = [fcMin, 0x400, 0x600, 0x800, 0xa00].filter((o, k, a) => o >= 0x200 && o < wd.length && a.indexOf(o) === k);
    let best = '', bestScore = 0;
    for (const off of cands) {
      let a = '', w = '';
      for (let i = off; i < Math.min(wd.length, off + ccpText); i++) a += cp1252(wd[i]);
      for (let i = off; i + 1 < Math.min(wd.length, off + ccpText * 2); i += 2) w += String.fromCharCode(wd[i] | (wd[i + 1] << 8));
      for (const t of [a, w]) { const sc = proseScore(t); if (sc > bestScore) { bestScore = sc; best = t; } }
    }
    if (best && bestScore > ccpText * 0.5) { res.method = 'fcMin/fcMac'; res.main = cleanWordText(best).trim(); return res; }
  }
  if (full == null) {
    res.method = 'stream scan';
    res.main = scanStreamText(wd);
    return res;
  }
  let at = 0;
  const take = (n: number) => { const s = full!.slice(at, at + n); at += n; return cleanWordText(s).trim(); };
  res.main = take(ccpText || full.length);
  res.footnotes = take(ccpFtn);
  take(ccpHdd + ccpMcr);
  res.comments = take(ccpAtn);
  res.endnotes = take(ccpEdn);
  res.textboxes = take(ccpTxbx);
  return res;
}

const proseScore = (s: string) => (s.match(/[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff ,.;:'"!?\r\u2018-\u201d]/g) || []).length;

/** Search for a Pcdt (clxt 0x02) whose CP array runs 0 .. total in increasing order. */
function findPcdt(b: Uint8Array, total: number): { at: number; lcb: number } | null {
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (total <= 0) return null;
  for (let q = 0; q + 17 < b.length; q++) {
    if (b[q] !== 2 || u32(q + 5) !== 0) continue;
    const lcb = u32(q + 1);
    if (lcb < 16 || (lcb - 4) % 12 || q + 5 + lcb > b.length) continue;
    const n = (lcb - 4) / 12;
    const last = u32(q + 5 + n * 4);
    if (last !== total && last !== total - 1 && last !== total + 1) continue;
    let ok = true;
    for (let k = 1; k <= n && ok; k++) if (u32(q + 5 + k * 4) <= u32(q + 5 + (k - 1) * 4)) ok = false;
    if (ok) return { at: q, lcb };
  }
  return null;
}

function readPieces(wd: Uint8Array, tbl: Uint8Array, fcClx: number, lcbClx: number): string | null {
  const u32 = (b: Uint8Array, o: number) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);
  let q = fcClx;
  const end = fcClx + lcbClx;
  // Skip Prc entries (clxt 1), stop at the Pcdt (clxt 2).
  while (q < end && tbl[q] === 1) {
    const cb = (tbl[q + 1] | (tbl[q + 2] << 8)) << 16 >> 16;
    q += 3 + Math.max(0, cb);
  }
  if (tbl[q] !== 2) return null;
  const lcb = u32(tbl, q + 1);
  q += 5;
  const n = Math.floor((lcb - 4) / 12);
  if (n <= 0 || q + lcb > tbl.length + 12) return null;
  const parts: string[] = [];
  // Each character comes from its own byte(s) of the WordDocument stream, so the text is never
  // longer than the stream; damaged or crafted tables whose pieces overlap must not multiply it.
  let budget = wd.length;
  for (let k = 0; k < n && budget > 0; k++) {
    const cpStart = u32(tbl, q + k * 4), cpEnd = u32(tbl, q + (k + 1) * 4);
    const pcd = q + (n + 1) * 4 + k * 8;
    let fc = u32(tbl, pcd + 2);
    const compressed = (fc & 0x40000000) !== 0;
    fc &= 0x3fffffff;
    const count = Math.max(0, Math.min(cpEnd - cpStart, 1 << 24, budget));
    let s = '';
    if (compressed) {
      const off = fc >>> 1;
      const stop = Math.min(off + count, wd.length);
      for (let i = off; i < stop; i++) s += cp1252(wd[i]);
    } else {
      const stop = Math.min(fc + count * 2, wd.length - 1);
      for (let i = fc; i < stop; i += 2) s += String.fromCharCode(wd[i] | (wd[i + 1] << 8));
    }
    parts.push(s);
    budget -= s.length;
  }
  return parts.join('');
}

/** When the FIB or piece table is unusable: decode the text area as UTF-16 or CP1252, whichever reads better. */
function scanStreamText(wd: Uint8Array): string {
  const body = wd.subarray(Math.min(0x200, wd.length));
  let a = '', w = '';
  for (let i = 0; i < body.length; i++) a += cp1252(body[i]);
  for (let i = 0; i + 1 < body.length; i += 2) w += String.fromCharCode(body[i] | (body[i + 1] << 8));
  const score = (s: string) => (s.match(/[A-Za-zÀ-ɏЀ-ӿ ,.;:'"!?\r]/g) || []).length;
  const best = score(w) > score(a) ? w : a;
  // Keep runs that look like prose.
  const runs = best.split(/[\x00-\x08\x0e-\x12\x16-\x1d\x7f-\x9f�-￿]+/).filter((r) => r.length >= 6 && /[a-z]{3}/i.test(r));
  return cleanWordText(runs.join('\r'));
}
