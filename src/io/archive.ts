/**
 * Minimal gzip and tar readers for importers whose files are compressed XML (AbiWord .zabw,
 * KOffice 1.0–1.2 .kwd, Pages '09 index.xml.gz). Synchronous, dependency-free, never throws
 * on damaged input (returns what could be decoded).
 */
import { crc32, immortalInflate, inflateLimit } from './recover/inflate';

export interface GunzipResult {
  data: Uint8Array;
  /** Problems found: a member that didn't inflate cleanly, or a CRC32/size trailer mismatch. */
  damage: string[];
}

/** Decompress a gzip stream (RFC 1952), checking each member's trailer; concatenated members are joined. */
export function gunzipChecked(u8: Uint8Array): GunzipResult {
  const parts: Uint8Array[] = [];
  const damage: string[] = [];
  let p = 0, total = 0;
  const max = inflateLimit(u8.length);
  while (p + 18 <= u8.length && u8[p] === 0x1f && u8[p + 1] === 0x8b && u8[p + 2] === 8) {
    const flags = u8[p + 3];
    let i = p + 10;
    if (flags & 4) i += 2 + (u8[i] | (u8[i + 1] << 8)); // FEXTRA
    if (flags & 8) { while (i < u8.length && u8[i]) i++; i++; } // FNAME
    if (flags & 16) { while (i < u8.length && u8[i]) i++; i++; } // FCOMMENT
    if (flags & 2) i += 2; // FHCRC
    if (i >= u8.length) break;
    const r = immortalInflate(u8.subarray(i), { maxOutput: Math.max(1, max - total) });
    parts.push(r.data);
    total += r.data.length;
    const m = parts.length;
    if (r.isCorrupt) { damage.push(`gzip member ${m} is damaged`); break; }
    const t = i + (r.consumed ?? 0);
    if (t + 8 > u8.length) { damage.push(`gzip member ${m} has no trailer`); break; }
    const crc = (u8[t] | (u8[t + 1] << 8) | (u8[t + 2] << 16) | (u8[t + 3] << 24)) >>> 0;
    const size = (u8[t + 4] | (u8[t + 5] << 8) | (u8[t + 6] << 16) | (u8[t + 7] << 24)) >>> 0;
    if (crc !== crc32(r.data) || size !== (r.data.length >>> 0)) damage.push(`gzip member ${m} fails its CRC check`);
    p = t + 8;
  }
  if (parts.length <= 1) return { data: parts[0] ?? new Uint8Array(0), damage };
  const out = new Uint8Array(total);
  let w = 0;
  for (const x of parts) { out.set(x, w); w += x.length; }
  return { data: out, damage };
}

/** Decompress a gzip stream; damaged data yields what could be decoded. */
export function gunzip(u8: Uint8Array): Uint8Array {
  return gunzipChecked(u8).data;
}

export interface TarEntry { name: string; data: Uint8Array }

/** Read a POSIX/ustar tar archive. */
export function untar(u8: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const str = (a: number, b: number) => { let s = ''; for (let i = a; i < b && u8[i]; i++) s += String.fromCharCode(u8[i]); return s; };
  let p = 0;
  let longName: string | null = null;
  while (p + 512 <= u8.length) {
    if (u8[p] === 0) break;
    let name = str(p, p + 100);
    const size = parseInt(str(p + 124, p + 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(u8[p + 156] || 48);
    const prefix = str(p + 257, p + 263) === 'ustar' ? str(p + 345, p + 500) : '';
    if (prefix) name = `${prefix}/${name}`;
    const data = u8.subarray(p + 512, p + 512 + size);
    if (type === 'L') longName = str(p + 512, p + 512 + size);
    else {
      if (longName) { name = longName; longName = null; }
      if (type === '0' || type === '\0' || type === '7') out.push({ name: name.replace(/^\.\//, ''), data });
    }
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
