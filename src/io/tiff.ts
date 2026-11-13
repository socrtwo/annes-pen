/**
 * Minimal baseline TIFF reader that converts the first image to a 24-bit BMP, which every
 * browser can display (TIFF is only shown natively by Safari). Supports 8-bit grey, palette and
 * RGB(A) images and 1-bit bilevel images, uncompressed, PackBits or LZW (with or without the
 * horizontal predictor), chunky planar configuration. Anything else returns null.
 */

export function tiffToBmp(u8: Uint8Array): Uint8Array | null {
  try {
    return decode(u8);
  } catch {
    return null;
  }
}

/** Tags the decoder reads; others are skipped without reading their values. */
const USED_TAGS = new Set([256, 257, 258, 259, 262, 273, 277, 278, 279, 284, 317, 320]);

function decode(u8: Uint8Array): Uint8Array | null {
  if (u8.length < 8) return null;
  const le = u8[0] === 0x49 && u8[1] === 0x49;
  if (!le && !(u8[0] === 0x4d && u8[1] === 0x4d)) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map<number, number[]>();
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (!USED_TAGS.has(tag)) continue;
    const size = type === 3 ? 2 : type === 4 ? 4 : 1;
    const inline = size * count <= 4;
    const base = inline ? e + 8 : u32(e + 8);
    // The count is file-supplied: never read more values than the file holds.
    const avail = Math.max(0, Math.floor((u8.length - base) / size));
    const vals: number[] = [];
    for (let i = 0; i < Math.min(count, avail, 1 << 20); i++) vals.push(type === 3 ? u16(base + i * 2) : type === 4 ? u32(base + i * 4) : u8[base + i]);
    tags.set(tag, vals);
  }
  const g = (t: number, d: number) => tags.get(t)?.[0] ?? d;
  const w = g(256, 0), h = g(257, 0);
  if (!w || !h || w * h > 40_000_000) return null;
  const bps = tags.get(258) || [1];
  const comp = g(259, 1), photo = g(262, 1), spp = g(277, 1), rps = g(278, h), planar = g(284, 1), pred = g(317, 1);
  if (planar !== 1 || ![1, 5, 32773].includes(comp)) return null;
  const bits = bps[0];
  if (!(bits === 8 || (bits === 1 && spp === 1))) return null;
  const offsets = tags.get(273) || [], counts = tags.get(279) || [];
  const rowBytes = Math.ceil((w * spp * bits) / 8);
  // An image far larger than its strip data could ever expand to is not worth decoding.
  let stripBytes = 0;
  for (let s = 0; s < offsets.length; s++) stripBytes += Math.max(0, Math.min(counts[s] ?? 0, u8.length - offsets[s]));
  const ratio = comp === 1 ? 4 : comp === 32773 ? 130 : 1024;
  if (rowBytes * h > 65536 && rowBytes * h > stripBytes * ratio) return null;
  const raw = new Uint8Array(rowBytes * h);
  let o = 0;
  for (let s = 0; s < offsets.length && o < raw.length; s++) {
    const strip = u8.subarray(offsets[s], offsets[s] + (counts[s] ?? 0));
    const rows = Math.min(rps, h - Math.floor(o / rowBytes));
    const want = rows * rowBytes;
    const dec = comp === 1 ? strip : comp === 32773 ? packBits(strip, want) : lzw(strip, want);
    raw.set(dec.subarray(0, Math.min(want, raw.length - o)), o);
    o += want;
  }
  if (pred === 2 && bits === 8) {
    for (let y = 0; y < h; y++) for (let x = spp; x < w * spp; x++) raw[y * rowBytes + x] = (raw[y * rowBytes + x] + raw[y * rowBytes + x - spp]) & 255;
  }
  const map = tags.get(320);
  const px = (x: number, y: number): [number, number, number] => {
    const r = y * rowBytes;
    if (bits === 1) { const bit = (raw[r + (x >> 3)] >> (7 - (x & 7))) & 1; const v = (photo === 0 ? 1 - bit : bit) * 255; return [v, v, v]; }
    const i = r + x * spp;
    if (photo === 3 && map) { const k = raw[i], m = map.length / 3; return [map[k] >> 8, map[m + k] >> 8, map[2 * m + k] >> 8]; }
    if (photo === 2 && spp >= 3) {
      const a = spp >= 4 ? raw[i + 3] / 255 : 1;
      return [raw[i] * a + 255 * (1 - a), raw[i + 1] * a + 255 * (1 - a), raw[i + 2] * a + 255 * (1 - a)];
    }
    const v = photo === 0 ? 255 - raw[i] : raw[i];
    return [v, v, v];
  };
  // 24-bit bottom-up BMP.
  const stride = Math.ceil((w * 3) / 4) * 4;
  const out = new Uint8Array(54 + stride * h);
  const ov = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  ov.setUint32(2, out.length, true); ov.setUint32(10, 54, true); ov.setUint32(14, 40, true);
  ov.setInt32(18, w, true); ov.setInt32(22, h, true); ov.setUint16(26, 1, true); ov.setUint16(28, 24, true);
  ov.setUint32(34, stride * h, true); ov.setInt32(38, 2835, true); ov.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) { const [r, gg, b] = px(x, y); out[row + x * 3] = b; out[row + x * 3 + 1] = gg; out[row + x * 3 + 2] = r; }
  }
  return out;
}

function packBits(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want);
  let i = 0, o = 0;
  while (i < src.length && o < want) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < want; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < want; k++) out[o++] = v; }
  }
  return out;
}

function lzw(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want);
  let o = 0, bitPos = 0, width = 9;
  let dict: Uint8Array[] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push(Uint8Array.of(i)); dict.push(new Uint8Array(0), new Uint8Array(0)); width = 9; };
  reset();
  let prev: Uint8Array | null = null;
  const read = () => {
    let v = 0;
    for (let k = 0; k < width; k++) { const byte = src[(bitPos + k) >> 3] ?? 0; v = (v << 1) | ((byte >> (7 - ((bitPos + k) & 7))) & 1); }
    bitPos += width;
    return v;
  };
  while (bitPos + width <= src.length * 8 && o < want) {
    const code = read();
    if (code === 256) { reset(); prev = null; continue; }
    if (code === 257) break;
    let entry: Uint8Array;
    if (code < dict.length) entry = dict[code];
    else if (prev) { entry = new Uint8Array(prev.length + 1); entry.set(prev); entry[prev.length] = prev[0]; }
    else break;
    for (let k = 0; k < entry.length && o < want; k++) out[o++] = entry[k];
    if (prev) { const ne = new Uint8Array(prev.length + 1); ne.set(prev); ne[prev.length] = entry[0]; dict.push(ne); }
    prev = entry;
    // Early change: the code width grows one code before the table fills.
    if (dict.length + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}
