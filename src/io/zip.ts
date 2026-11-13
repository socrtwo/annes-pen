/**
 * Guarded ZIP loading for importers.
 *
 * JSZip inflates an entry in full when it is read, with no output limit, so a
 * small hostile package (a "zip bomb") can exhaust memory in a browser tab or
 * WebView. loadZip() opens the archive and refuses it before anything is
 * inflated when the central directory declares an entry or a total above the
 * limits below. JSZip itself rejects an entry whose inflated length differs
 * from the declared size, so a package that understates its sizes fails too.
 */
import JSZip from 'jszip';

/** Largest single entry accepted, after decompression. */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** Largest total of all entries accepted, after decompression. */
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** Most entries accepted in one package. */
export const MAX_ENTRIES = 20000;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

type ZipData = Parameters<typeof JSZip.loadAsync>[0];

/** Declared uncompressed size of an entry read from an archive, or 0 when unknown. */
export function declaredSize(f: JSZip.JSZipObject): number {
  const d = (f as unknown as { _data?: { uncompressedSize?: number } })._data;
  const n = d && typeof d.uncompressedSize === 'number' ? d.uncompressedSize : 0;
  return n > 0 ? n : 0;
}

/** Throw ZipLimitError when an already-loaded archive exceeds the size limits. */
export function checkZipLimits(zip: JSZip, limits: { entry?: number; total?: number; entries?: number } = {}): void {
  const maxEntry = limits.entry ?? MAX_ENTRY_BYTES;
  const maxTotal = limits.total ?? MAX_TOTAL_BYTES;
  const maxEntries = limits.entries ?? MAX_ENTRIES;
  let total = 0;
  let count = 0;
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue;
    count++;
    if (count > maxEntries) throw new ZipLimitError(`The package holds more than ${maxEntries} files, which is too many to open safely.`);
    const n = declaredSize(f);
    if (n > maxEntry) throw new ZipLimitError(`"${f.name}" expands to ${mb(n)}, more than the ${mb(maxEntry)} limit for one part of a document.`);
    total += n;
    if (total > maxTotal) throw new ZipLimitError(`The package expands to more than ${mb(maxTotal)}, which is too large to open safely.`);
  }
}

/** JSZip.loadAsync followed by checkZipLimits(). */
export async function loadZip(data: ZipData, limits?: { entry?: number; total?: number; entries?: number }): Promise<JSZip> {
  const zip = await JSZip.loadAsync(data);
  checkZipLimits(zip, limits);
  return zip;
}

function mb(n: number): string {
  return `${Math.round(n / (1024 * 1024))} MB`;
}
