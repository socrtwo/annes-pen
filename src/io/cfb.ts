/**
 * Compound File Binary (OLE2 / "structured storage") reader, written from the published
 * [MS-CFB] specification.
 *
 * Used by every importer that reads a compound file: Word 6/95/97 (.doc), Works 3-9 (.wps),
 * Excel BIFF5/8 (.xls), Outlook (.msg), Hangul 5 (.hwp), PowerPoint (.ppt) and others. The
 * whole directory tree is read (storages and streams, with "/"-separated paths); stream data
 * is read on demand.
 *
 * Every read is bounds-checked and every sector chain is cycle-guarded, so a damaged file
 * yields whatever is still reachable instead of throwing.
 */

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const NOSTREAM = 0xffffffff;

export function isCfb(u8: Uint8Array): boolean {
  return u8.length >= 8 && SIG.every((b, i) => u8[i] === b);
}

export interface CfbEntry {
  /** Directory index. */
  id: number;
  name: string;
  /** Full path below the root, "/"-separated (root itself is ""). */
  path: string;
  type: 'root' | 'storage' | 'stream';
  size: number;
  start: number;
  clsid: string;
  children: CfbEntry[];
}

export interface Cfb {
  root: CfbEntry;
  /** All storages and streams below the root, depth first. */
  entries: CfbEntry[];
  /** Sector chains that ended early or looped while reading. */
  damaged: string[];
  /** Find an entry by path (case-insensitive, "/"-separated). */
  find(path: string): CfbEntry | null;
  /** Read a stream by path or entry; null when it does not exist. */
  read(path: string | CfbEntry): Uint8Array | null;
  /** Names of the streams and storages directly below a storage path ("" = root). */
  list(path?: string): string[];
}

export function openCfb(b: Uint8Array): Cfb | null {
  if (b.length < 512 || !isCfb(b)) return null;
  const u16 = (o: number) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
  const u32 = (o: number) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ENDOFCHAIN);
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
  const damaged = new Set<string>();
  const secOff = (sid: number) => (sid + 1) * secSize;
  const maxSid = Math.max(0, Math.ceil((b.length - secSize) / secSize));

  // FAT sectors: 109 in the header, the rest in the DIFAT chain. No more are needed than it
  // takes to map every sector in the file; a sector listed twice is read once (later copies
  // map nothing), so a crafted DIFAT can't multiply the FAT's size.
  const perSec = secSize / 4;
  const maxFat = Math.ceil(maxSid / perSec);
  const fatSids: number[] = [];
  const listed = new Set<number>();
  const addFat = (s: number) => { if (s < maxSid && fatSids.length < maxFat) { fatSids.push(listed.has(s) ? NOSTREAM : s); listed.add(s); } };
  for (let k = 0; k < 109; k++) addFat(u32(0x4c + k * 4));
  const seen = new Set<number>();
  for (let d = difatStart; d < maxSid && !seen.has(d) && fatSids.length < maxFat; ) {
    seen.add(d);
    const off = secOff(d), per = secSize / 4 - 1;
    for (let k = 0; k < per; k++) addFat(u32(off + k * 4));
    d = u32(off + per * 4);
  }
  const fat = new Uint32Array(fatSids.length * perSec).fill(ENDOFCHAIN);
  fatSids.forEach((sid, n) => { if (sid === NOSTREAM) return; const off = secOff(sid); for (let k = 0; k < perSec; k++) fat[n * perSec + k] = u32(off + k * 4); });

  const chain = (start: number, table: Uint32Array, limit: number, label: string): number[] => {
    const out: number[] = [];
    const visited = new Set<number>();
    let s = start;
    while (s < limit && !visited.has(s)) {
      visited.add(s); out.push(s);
      if (s >= table.length) { s = NOSTREAM; break; }
      s = table[s];
    }
    if (s !== ENDOFCHAIN && out.length) damaged.add(label);
    return out;
  };
  const readChain = (start: number, size: number | null, label: string): Uint8Array => {
    let sids = chain(start, fat, maxSid, label);
    // A broken FAT: assume the rest of the stream follows its last good sector (writers allocate sequentially).
    if (size != null && sids.length * secSize < size) {
      const need = Math.ceil(size / secSize);
      let next = (sids[sids.length - 1] ?? start - 1) + 1;
      sids = [...sids];
      while (sids.length < need && next < maxSid) sids.push(next++);
    }
    const total = Math.min(size ?? sids.length * secSize, sids.length * secSize);
    const out = new Uint8Array(Math.max(0, total));
    let w = 0;
    for (const sid of sids) {
      if (w >= out.length) break;
      const off = secOff(sid);
      const n = Math.min(secSize, out.length - w, Math.max(0, b.length - off));
      if (n <= 0) break;
      out.set(b.subarray(off, off + n), w);
      w += n;
    }
    if (size != null && w < size) damaged.add(label);
    return out.subarray(0, w);
  };

  // Directory
  const dir = readChain(dirStart, null, 'directory');
  interface Raw { name: string; type: number; left: number; right: number; child: number; start: number; size: number; clsid: string }
  const raws: Raw[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = dir[o + 0x40] | (dir[o + 0x41] << 8);
    let name = '';
    for (let k = 0; k + 1 < Math.min(64, nameLen) - 1; k += 2) name += String.fromCharCode(dir[o + k] | (dir[o + k + 1] << 8));
    const r32 = (p: number) => (dir[o + p] | (dir[o + p + 1] << 8) | (dir[o + p + 2] << 16) | (dir[o + p + 3] << 24)) >>> 0;
    let clsid = '';
    for (let k = 0; k < 16; k++) clsid += dir[o + 0x50 + k].toString(16).padStart(2, '0');
    raws.push({ name, type: dir[o + 0x42], left: r32(0x44), right: r32(0x48), child: r32(0x4c), start: r32(0x74), size: r32(0x78), clsid });
  }
  let rootIdx = raws.findIndex((r) => r.type === 5);
  if (rootIdx < 0) return null;
  if (rootIdx !== 0) damaged.add('directory');
  const rr = raws[rootIdx];
  const root: CfbEntry = { id: rootIdx, name: rr.name || 'Root Entry', path: '', type: 'root', size: rr.size, start: rr.start, clsid: rr.clsid, children: [] };
  const entries: CfbEntry[] = [];
  const placed = new Set<number>([rootIdx]);
  const build = (parent: CfbEntry, childIdx: number, depth: number) => {
    if (depth > 64) return;
    const stack = [childIdx];
    const sibs: number[] = [];
    while (stack.length && sibs.length < 1e5) {
      const id = stack.pop()!;
      if (id >= raws.length || placed.has(id)) continue;
      placed.add(id);
      const r = raws[id];
      if (r.type !== 1 && r.type !== 2) continue;
      sibs.push(id);
      stack.push(r.left, r.right);
    }
    sibs.sort((a, c) => (raws[a].name < raws[c].name ? -1 : 1));
    for (const id of sibs) {
      const r = raws[id];
      const e: CfbEntry = { id, name: r.name, path: parent.path ? `${parent.path}/${r.name}` : r.name, type: r.type === 1 ? 'storage' : 'stream', size: r.size, start: r.start, clsid: r.clsid, children: [] };
      parent.children.push(e);
      entries.push(e);
      if (r.type === 1) build(e, r.child, depth + 1);
    }
  };
  build(root, rr.child, 0);
  // A damaged tree can hide entries: list unreachable streams at the root.
  raws.forEach((r, id) => {
    if (placed.has(id) || r.type !== 2 || !r.name) return;
    const e: CfbEntry = { id, name: r.name, path: r.name, type: 'stream', size: r.size, start: r.start, clsid: r.clsid, children: [] };
    if (!root.children.some((c) => c.name === r.name)) { root.children.push(e); entries.push(e); damaged.add('directory tree'); }
  });

  // Mini stream
  let miniStream: Uint8Array | null = null;
  let miniFat: Uint32Array | null = null;
  const mini = () => {
    if (!miniStream) {
      miniStream = readChain(root.start, root.size, 'mini stream');
      const mf = readChain(miniFatStart, null, 'mini FAT');
      miniFat = new Uint32Array(Math.floor(mf.length / 4));
      for (let k = 0; k < miniFat.length; k++) miniFat[k] = (mf[k * 4] | (mf[k * 4 + 1] << 8) | (mf[k * 4 + 2] << 16) | (mf[k * 4 + 3] << 24)) >>> 0;
    }
    return { ms: miniStream, mf: miniFat! };
  };
  const readMini = (start: number, size: number, label: string): Uint8Array => {
    const { ms, mf } = mini();
    const limit = Math.ceil(ms.length / miniSize);
    let sids = chain(start, mf, limit, label);
    if (sids.length * miniSize < size) {
      sids = [...sids];
      let next = (sids[sids.length - 1] ?? start - 1) + 1;
      while (sids.length * miniSize < size && next < limit) sids.push(next++);
    }
    const out = new Uint8Array(Math.min(size, sids.length * miniSize));
    let w = 0;
    for (const sid of sids) {
      if (w >= out.length) break;
      const off = sid * miniSize;
      const n = Math.min(miniSize, out.length - w, Math.max(0, ms.length - off));
      if (n <= 0) break;
      out.set(ms.subarray(off, off + n), w);
      w += n;
    }
    if (w < size) damaged.add(label);
    return out.subarray(0, w);
  };

  const byPath = new Map<string, CfbEntry>();
  for (const e of entries) byPath.set(e.path.toLowerCase(), e);
  const cache = new Map<number, Uint8Array>();
  const cfb: Cfb = {
    root,
    entries,
    get damaged() { return [...damaged]; },
    find(path) { return path === '' ? root : byPath.get(path.replace(/^\/+/, '').toLowerCase()) || null; },
    read(p) {
      const e = typeof p === 'string' ? cfb.find(p) : p;
      if (!e || e.type !== 'stream') return null;
      let d = cache.get(e.id);
      if (!d) {
        // Version 3 files keep only the low 32 bits of the size; a huge value is damage.
        const size = Math.min(e.size, b.length * 2);
        d = size < miniCutoff ? readMini(e.start, size, e.path) : readChain(e.start, size, e.path);
        cache.set(e.id, d);
      }
      return d;
    },
    list(path = '') {
      const e = cfb.find(path);
      return e ? e.children.map((c) => c.name) : [];
    },
  };
  return cfb;
}

/** Read a little-endian unsigned integer of 1, 2 or 4 bytes; 0 past the end. */
export const le = {
  u8: (b: Uint8Array, o: number) => (o < b.length && o >= 0 ? b[o] : 0),
  u16: (b: Uint8Array, o: number) => (o >= 0 && o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0),
  i16: (b: Uint8Array, o: number) => (o >= 0 && o + 2 <= b.length ? ((b[o] | (b[o + 1] << 8)) << 16) >> 16 : 0),
  u32: (b: Uint8Array, o: number) => (o >= 0 && o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0),
  i32: (b: Uint8Array, o: number) => (o >= 0 && o + 4 <= b.length ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : 0),
};
export const be = {
  u16: (b: Uint8Array, o: number) => (o >= 0 && o + 2 <= b.length ? (b[o] << 8) | b[o + 1] : 0),
  i16: (b: Uint8Array, o: number) => (o >= 0 && o + 2 <= b.length ? (((b[o] << 8) | b[o + 1]) << 16) >> 16 : 0),
  u32: (b: Uint8Array, o: number) => (o >= 0 && o + 4 <= b.length ? ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 : 0),
};
