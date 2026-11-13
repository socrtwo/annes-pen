/**
 * iWork Archive (IWA) reader: the container used by Pages, Numbers and Keynote since 2013.
 *
 * An .iwa file is a sequence of chunks (1 byte type 0, 3 byte little-endian length) holding
 * Snappy-compressed data without the framing format's checksums. The decompressed stream is a
 * series of archives: a varint-length ArchiveInfo message (identifier + MessageInfo entries
 * with type and length) followed by the message payloads, which are Protocol Buffers.
 *
 * This module is schema-less: it decodes Snappy and protobuf wire format, and exposes fields
 * by number. The field meanings used by the importers were determined from documents
 * (see pages.ts for the ones it relies on).
 */

/** Decompress raw Snappy data (the block format, no stream framing). Throws on malformed input. */
export function snappyDecompress(src: Uint8Array): Uint8Array {
  let i = 0, len = 0, shift = 0;
  for (;;) {
    if (i >= src.length) throw new Error('snappy: truncated length');
    const c = src[i++];
    len |= (c & 0x7f) << shift;
    if (c < 0x80) break;
    shift += 7;
    if (shift > 28) throw new Error('snappy: bad length');
  }
  if (len > 256 * 1024 * 1024) throw new Error('snappy: too large');
  // Each tag expands to at most 64 bytes, so a length beyond that ratio can't be honest.
  if (len > (src.length - i) * 64) throw new Error('snappy: bad length');
  const out = new Uint8Array(len);
  let o = 0;
  while (i < src.length) {
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const nb = n - 59;
        n = 0;
        for (let k = 0; k < nb; k++) n |= src[i++] << (8 * k);
      }
      n += 1;
      if (o + n > len || i + n > src.length) throw new Error('snappy: literal overflow');
      out.set(src.subarray(i, i + n), o);
      i += n; o += n;
      continue;
    }
    let n: number, off: number;
    if (kind === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[i++]; }
    else if (kind === 2) { n = (tag >> 2) + 1; off = src[i] | (src[i + 1] << 8); i += 2; }
    else { n = (tag >> 2) + 1; off = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0; i += 4; }
    if (!off || off > o || o + n > len) throw new Error('snappy: bad copy');
    for (let k = 0; k < n; k++, o++) out[o] = out[o - off];
  }
  return o === len ? out : out.subarray(0, o);
}

/** Decompress an .iwa file's chunks into one stream. */
export function iwaDecompress(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 0, total = 0;
  while (i + 4 <= data.length) {
    const type = data[i];
    const n = data[i + 1] | (data[i + 2] << 8) | (data[i + 3] << 16);
    const chunk = data.subarray(i + 4, i + 4 + n);
    i += 4 + n;
    if (type !== 0) continue;
    const d = snappyDecompress(chunk);
    parts.push(d); total += d.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface PbField { n: number; wire: number; v: number | bigint | Uint8Array }

/** One protobuf message, decoded lazily into fields by number. */
export class Pb {
  fields: PbField[] = [];
  constructor(public bytes: Uint8Array) {
    let i = 0;
    const b = bytes;
    const varint = (): number | bigint => {
      let lo = 0, shift = 0, k = 0;
      let big: bigint | null = null;
      for (;;) {
        if (i >= b.length) throw new Error('pb: truncated varint');
        const c = b[i++];
        if (shift < 28) lo |= (c & 0x7f) << shift;
        else { big = (big ?? BigInt(lo >>> 0)) | (BigInt(c & 0x7f) << BigInt(shift)); }
        shift += 7; k++;
        if (c < 0x80 || k > 10) break;
      }
      return big != null ? big : lo >>> 0;
    };
    while (i < b.length) {
      const key = Number(varint());
      const n = key >>> 3, wire = key & 7;
      if (wire === 0) this.fields.push({ n, wire, v: varint() });
      else if (wire === 1) { this.fields.push({ n, wire, v: b.subarray(i, i + 8) }); i += 8; }
      else if (wire === 2) { const l = Number(varint()); if (i + l > b.length) throw new Error('pb: truncated bytes'); this.fields.push({ n, wire, v: b.subarray(i, i + l) }); i += l; }
      else if (wire === 5) { this.fields.push({ n, wire, v: b.subarray(i, i + 4) }); i += 4; }
      else throw new Error('pb: unsupported wire type ' + wire);
    }
  }
  all(n: number): PbField[] { return this.fields.filter((f) => f.n === n); }
  has(n: number): boolean { return this.fields.some((f) => f.n === n); }
  int(n: number): number | null { const f = this.fields.find((x) => x.n === n && x.wire === 0); return f ? Number(f.v) : null; }
  bool(n: number): boolean | null { const v = this.int(n); return v == null ? null : v !== 0; }
  float(n: number): number | null {
    const f = this.fields.find((x) => x.n === n && (x.wire === 5 || x.wire === 1));
    if (!f) return null;
    const u = f.v as Uint8Array;
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    return f.wire === 5 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
  }
  str(n: number): string | null { const f = this.fields.find((x) => x.n === n && x.wire === 2); return f ? new TextDecoder().decode(f.v as Uint8Array) : null; }
  strs(n: number): string[] { return this.all(n).filter((x) => x.wire === 2).map((x) => new TextDecoder().decode(x.v as Uint8Array)); }
  msg(n: number): Pb | null { const f = this.fields.find((x) => x.n === n && x.wire === 2); try { return f ? new Pb(f.v as Uint8Array) : null; } catch { return null; } }
  msgs(n: number): Pb[] { const out: Pb[] = []; for (const f of this.all(n)) if (f.wire === 2) { try { out.push(new Pb(f.v as Uint8Array)); } catch { /* skip */ } } return out; }
  /** A TSP.Reference (message with field 1 = object identifier). */
  ref(n: number): number | null { return this.msg(n)?.int(1) ?? null; }
  /** Packed or repeated varints. */
  ints(n: number): number[] {
    const out: number[] = [];
    for (const f of this.all(n)) {
      if (f.wire === 0) out.push(Number(f.v));
      else if (f.wire === 2) out.push(...packedVarints(f.v as Uint8Array));
    }
    return out;
  }
}

function packedVarints(b: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < b.length) {
    let v = 0, s = 0;
    for (;;) { const c = b[i++]; v += (c & 0x7f) * 2 ** s; s += 7; if (c < 0x80 || i >= b.length) break; }
    out.push(v);
  }
  return out;
}

export interface IwaObject { id: number; type: number; msg: Pb; file: string }

/** Parse a decompressed IWA stream into objects (first message of each archive). */
export function iwaObjects(stream: Uint8Array, file = ''): IwaObject[] {
  const out: IwaObject[] = [];
  let i = 0;
  const varint = () => { let v = 0, s = 0; for (;;) { const c = stream[i++]; v += (c & 0x7f) * 2 ** s; s += 7; if (c < 0x80 || i >= stream.length) break; } return v; };
  while (i < stream.length) {
    const len = varint();
    if (i + len > stream.length) break;
    let info: Pb;
    try { info = new Pb(stream.subarray(i, i + len)); } catch { break; }
    i += len;
    const id = info.int(1) ?? 0;
    let first = true;
    for (const mi of info.msgs(2)) {
      const type = mi.int(1) ?? 0;
      const l = mi.int(3) ?? 0;
      const payload = stream.subarray(i, i + l);
      i += l;
      if (!first) continue;
      first = false;
      try { out.push({ id, type, msg: new Pb(payload), file }); } catch { /* undecodable payload */ }
    }
  }
  return out;
}
