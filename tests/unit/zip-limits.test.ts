import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { checkZipLimits, declaredSize, loadZip, ZipLimitError } from '../../src/io/zip';

async function pack(files: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('loadZip limits', () => {
  it('reads the declared uncompressed size from the central directory', async () => {
    const zip = await loadZip(await pack({ 'a.xml': 'x'.repeat(5000) }));
    expect(declaredSize(zip.file('a.xml')!)).toBe(5000);
  });

  it('accepts a package within the limits', async () => {
    const zip = await loadZip(await pack({ 'a.xml': 'x'.repeat(5000), 'b.xml': 'y' }));
    expect(await zip.file('b.xml')!.async('string')).toBe('y');
  });

  it('refuses an entry that expands past the per-entry limit before inflating it', async () => {
    const data = await pack({ 'word/document.xml': 'x'.repeat(200_000) });
    await expect(loadZip(data, { entry: 100_000 })).rejects.toBeInstanceOf(ZipLimitError);
  });

  it('refuses a package whose total expands past the limit', async () => {
    const zip = await JSZip.loadAsync(await pack({ a: 'x'.repeat(60_000), b: 'x'.repeat(60_000) }));
    expect(() => checkZipLimits(zip, { total: 100_000 })).toThrow(/too large/);
  });

  it('refuses a package with too many entries', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}`] = 'x';
    await expect(loadZip(await pack(files), { entries: 10 })).rejects.toThrow(/too many/);
  });
});
