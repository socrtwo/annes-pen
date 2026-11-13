/**
 * RTFD import: the macOS TextEdit "rich text with attachments" bundle, as a ZIP of the
 * bundle directory (how it travels by mail, web and on non-Apple systems).
 *
 * The bundle holds TXT.rtf plus one file per attachment. Pictures are referenced from the RTF
 * with \NeXTGraphic <file name> \width \height groups; the RTF importer resolves those names
 * against the bundle's files. TIFF pictures (TextEdit's default for pasted images) are
 * converted for display when they are uncompressed, PackBits or LZW encoded.
 */
import { loadZip } from './zip';
import type { Node as PMNode } from 'prosemirror-model';
import { rtfToDoc } from './rtf';
import { mimeForName, sniffImageMime, toDataUrl } from './serialize';
import { tiffToBmp } from './tiff';

export async function importRtfd(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const zip = await loadZip(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name));
  const txt = entries.find((f) => /(^|\/)TXT\.rtf$/i.test(f.name)) || entries.find((f) => /\.rtf$/i.test(f.name));
  if (!txt) throw new Error('TXT.rtf is missing: not an RTFD bundle');
  const dir = txt.name.slice(0, txt.name.lastIndexOf('/') + 1);
  const attachments = new Map<string, string>();
  for (const f of entries) {
    if (f === txt || !f.name.startsWith(dir)) continue;
    const rel = f.name.slice(dir.length);
    let bytes = await f.async('uint8array');
    let mime = sniffImageMime(bytes) || mimeForName(rel);
    if (/^image\/tiff$/.test(mime) || /\.tiff?$/i.test(rel)) {
      const bmp = tiffToBmp(bytes);
      if (bmp) { bytes = bmp; mime = 'image/bmp'; }
    }
    if (mime.startsWith('image/')) attachments.set(rel, toDataUrl(bytes, mime));
  }
  const u8 = await txt.async('uint8array');
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  return rtfToDoc(bin, attachments);
}
