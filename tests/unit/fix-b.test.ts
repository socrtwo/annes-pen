/**
 * Regression tests for importer hardening (fix set B): runaway recursion and loops in the
 * light-markup readers, file-supplied lengths in binary readers, email/MHTML parsing errors.
 * Inputs are small crafted files; time and size bounds catch hangs and memory blow-ups.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync, gzipSync } from 'node:zlib';
import type { Node as PMNode } from 'prosemirror-model';
import { asciidocToDoc } from '../../src/io/asciidoc';
import { rstToDoc } from '../../src/io/rst';
import { orgToDoc } from '../../src/io/org';
import { textileToDoc } from '../../src/io/textile';
import { troffToDoc } from '../../src/io/troff';
import { latexToDoc } from '../../src/io/latex';
import { tiffToBmp } from '../../src/io/tiff';
import { openCfb } from '../../src/io/cfb';
import { readCfb } from '../../src/io/recover/doc97';
import { immortalInflate } from '../../src/io/recover/inflate';
import { gunzip, gunzipChecked } from '../../src/io/archive';
import { snappyDecompress } from '../../src/io/iwa';
import { readPpt } from '../../src/io/convert/slides';
import { readXls, readLotus, readDbf, sheetsToDoc, smallNum, MAX_CELLS } from '../../src/io/convert/sheets';
import { parseMime as parseEmail, mboxMessages, importEmail } from '../../src/io/convert/email';
import { parseContentType, mhtmlToHtml } from '../../src/io/mhtml';
import { decodeCodepage } from '../../src/io/legacy/codepage';
import { W, ab, buildCfb, buildDbf, buildWk1, cat, latin } from './legacy-builders';

const timed = <T>(f: () => T, ms = 2000): T => {
  const t = performance.now();
  const r = f();
  expect(performance.now() - t).toBeLessThan(ms);
  return r;
};
const links = (doc: PMNode) => {
  const out: { text: string; href: string }[] = [];
  doc.descendants((n) => { const l = n.marks.find((m) => m.type.name === 'link'); if (n.isText && l) out.push({ text: n.text!, href: l.attrs.href }); });
  return out;
};
const footnotes = (doc: PMNode) => { const out: string[] = []; doc.descendants((n) => { if (n.type.name === 'footnote') out.push(n.attrs.text); }); return out; };

describe('light markup: bare URLs (1)', () => {
  const line = 'Visit https://example.com/page for details.';
  for (const [name, f] of [['asciidoc', asciidocToDoc], ['rst', rstToDoc], ['org', orgToDoc]] as const) {
    it(`${name} links a bare URL without re-parsing it`, () => {
      const doc = timed(() => f(line));
      expect(doc.textContent).toContain('Visit https://example.com/page for details.');
      expect(links(doc)).toEqual([{ text: 'https://example.com/page', href: 'https://example.com/page' }]);
    });
  }
  it('rst inline literals stay literal', () => {
    const doc = rstToDoc('Run ``a\\\\\\b *x*`` now.');
    let code = ''; doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'code')) code += n.text; });
    expect(code).toBe('a\\\\\\b *x*');
  });
    it('asciidoc <URL> form', () => {
    const doc = asciidocToDoc('See <https://example.com/x> now.');
    expect(links(doc)).toEqual([{ text: 'https://example.com/x', href: 'https://example.com/x' }]);
  });
});

describe('textile tables (2)', () => {
  it('a "|" line that is not a table row ends as a paragraph', () => {
    expect(timed(() => textileToDoc('|a\n')).textContent).toContain('|a');
    expect(timed(() => textileToDoc('|_. Name\n\nAfter')).textContent).toContain('After');
  });
  it('still reads real tables', () => {
    const doc = textileToDoc('|a|b|\n|c|d|\n');
    let tables = 0; doc.descendants((n) => { if (n.type.name === 'table') tables++; });
    expect(tables).toBe(1);
  });
});

describe('self-referencing footnotes and deep LaTeX groups (7)', () => {
  it('textile', () => {
    const doc = timed(() => textileToDoc('Text[1]\n\nfn1. see [1] again'));
    expect(footnotes(doc)).toEqual(['see [1] again']);
  });
  it('rst', () => {
    const doc = timed(() => rstToDoc('Text [1]_\n\n.. [1] see [1]_ again\n'));
    expect(footnotes(doc)[0]).toMatch(/^see\s+again$/);
  });
  it('org', () => {
    const doc = timed(() => orgToDoc('Text[fn:1]\n\n[fn:1] See [fn:1] again\n'));
    expect(footnotes(doc)[0]).toBe('See [fn:1] again');
  });
  it('mutually citing footnotes stay finite', () => {
    const notes = Array.from({ length: 30 }, (_, i) => `fn${i + 1}. n${i + 1} [${i + 2}] [${i + 2}]`).join('\n\n');
    const doc = timed(() => textileToDoc(`Text[1]\n\n${notes}`));
    expect(footnotes(doc).length).toBe(1);
  });
  it('latex flattens 4000 nested groups', () => {
    const doc = timed(() => latexToDoc('\\begin{document}' + '{'.repeat(4000) + 'deep' + '}'.repeat(4000) + '\\end{document}'));
    expect(doc.textContent).toContain('deep');
  });
});

describe('troff empty headings (6)', () => {
  it('.TH and .SH without text', () => {
    expect(() => troffToDoc('.TH\n.SH\n')).not.toThrow();
    expect(troffToDoc('.TH\n.SS\n.SH\nbody text\n').textContent).toContain('body text');
  });
});

describe('PowerPoint text atom lengths (3)', () => {
  it('a huge declared atom length is clamped to the stream', () => {
    const rec = (verInst: number, type: number, len: number, data: Uint8Array) => cat(new W().u16(verInst).u16(type).u32(len).out(), data);
    const slide = rec(0, 0x03f3, 20, new Uint8Array(20));
    const atom = rec(0, 0x0fa8, 0xfffffff0, latin('Hello slide'));
    const list = rec(0x000f, 0x0ff0, slide.length + atom.length, cat(slide, atom));
    const doc = rec(0x000f, 0x03e8, list.length, list);
    const slides = timed(() => readPpt(buildCfb({ 'PowerPoint Document': doc, 'Current User': new Uint8Array(32) })));
    expect(slides.length).toBe(1);
    expect(slides[0].body.map((p) => p.runs[0].text).join('')).toBe('Hello slide');
  });
});

describe('spreadsheets (4, 11, 13)', () => {
  const biff = (op: number, d: Uint8Array) => cat(new W().u16(op).u16(d.length).out(), d);
  const bof = biff(0x0809, new W().u16(0x0600).u16(0x0010).pad(16).out());
  it('an SST count larger than its data is capped', () => {
    const sst = biff(0x00fc, new W().u32(0xffffffff).u32(0xffffffff).u16(2).u8(0).str('ab').out());
    const sheets = timed(() => readXls(cat(bof, sst, biff(0x000a, new Uint8Array(0)))));
    expect(sheets.length).toBe(1);
  });
  it('truncated NUMBER and FORMULA records are skipped, not thrown', () => {
    const num = new W().u16(0x0203).u16(14).u16(0).u16(0).u16(0).u8(1).out(); // 14 declared, 7 present
    expect(() => readXls(cat(bof, num))).not.toThrow();
    const formula = new W().u16(0x0006).u16(20).u16(0).u16(0).u16(0).u8(1).u8(2).out();
    expect(() => readXls(cat(bof, formula))).not.toThrow();
  });
  it('a sparse Lotus sheet is compacted instead of expanded', () => {
    const wk1 = buildWk1([{ r: 0, c: 0, v: 1 }, { r: 4999, c: 63, v: 2 }]);
    const doc = timed(() => sheetsToDoc(readLotus(wk1), 'x'));
    let cells = 0; doc.descendants((n) => { if (n.type.name === 'table_cell') cells++; });
    expect(cells).toBeLessThanOrEqual(4);
    expect(doc.textContent).toContain('2');
  });
  it('a dense sheet is cut at the cell cap with a note', () => {
    const rows = Array.from({ length: 2000 }, (_, r) => Array.from({ length: 50 }, (_, c) => r * 50 + c));
    const doc = sheetsToDoc([{ name: '', rows }], 'x');
    let cells = 0; doc.descendants((n) => { if (n.type.name === 'table_cell') cells++; });
    expect(cells).toBeLessThanOrEqual(MAX_CELLS);
    expect(doc.textContent).toContain('were imported');
  });
  it('a truncated Lotus record does not throw', () => {
    const wk1 = buildWk1([{ r: 0, c: 0, v: 1.5 }]);
    for (let n = 6; n < wk1.length; n++) expect(() => readLotus(wk1.subarray(0, n))).not.toThrow();
  });
  it('WK3 small numbers', () => {
    expect(smallNum(42 << 1)).toBe(42);
    expect(smallNum((-3 << 1))).toBe(-3);
    expect(smallNum((7 << 4) | (0 << 1) | 1)).toBe(35000);
    expect(smallNum((7 << 4) | (1 << 1) | 1)).toBe(3500);
    expect(smallNum((7 << 4) | (2 << 1) | 1)).toBeCloseTo(0.35);
    expect(smallNum((5 << 4) | (6 << 1) | 1)).toBeCloseTo(5 / 16);
    expect(smallNum((-5 << 4) | (7 << 1) | 1)).toBeCloseTo(-5 / 64);
    const rec = new W().u16(0x18).u16(6).u16(0).u8(0).u8(0).u16((7 << 4) | (3 << 1) | 1).out();
    expect(readLotus(cat(rec, new W().u16(1).u16(0).out()))[0].rows[0][0]).toBeCloseTo(0.035);
  });
  it('dBASE code page 852', () => {
    const dbf = buildDbf([{ name: 'N', type: 'C', len: 4 }], [['xxxx']]);
    dbf[29] = 0x64;
    const at = dbf.indexOf(0x78);
    dbf.set([0xa5, 0xa9, 0x9f, 0xe7], at);
    expect(readDbf(dbf)[0].rows[1][0]).toBe('ąęčš');
    expect(decodeCodepage(Uint8Array.of(0x80, 0xe0), 737)).toBe('Αω');
    expect(decodeCodepage(Uint8Array.of(0x80, 0xd8), 775)).toBe('Ćž');
  });
});

describe('TIFF (5)', () => {
  it('a BYTE tag with a 4 G count is not read', () => {
    const n = 200;
    const u = new Uint8Array(8 + 2 + n * 12 + 4 + 300);
    const dv = new DataView(u.buffer);
    u.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true); dv.setUint16(8, n, true);
    for (let k = 0; k < n; k++) { const e = 10 + k * 12; dv.setUint16(e, 256 + k, true); dv.setUint16(e + 2, 1, true); dv.setUint32(e + 4, 0xffffffff, true); dv.setUint32(e + 8, 16, true); }
    expect(timed(() => tiffToBmp(u))).toBeNull();
  });
  it('a 6000×6000 image with no strip data is rejected', () => {
    const entries: [number, number, number][] = [[256, 4, 6000], [257, 4, 6000], [258, 3, 8], [259, 3, 1], [262, 3, 2], [277, 3, 4]];
    const u = new Uint8Array(8 + 2 + entries.length * 12 + 4);
    const dv = new DataView(u.buffer);
    u.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true); dv.setUint16(8, entries.length, true);
    entries.forEach(([tag, type, v], k) => { const e = 10 + k * 12; dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, 1, true); if (type === 3) dv.setUint16(e + 8, v, true); else dv.setUint32(e + 8, v, true); });
    expect(tiffToBmp(u)).toBeNull();
  });
});

describe('compound files and inflate (12)', () => {
  /** A CFB whose DIFAT chain runs through every sector, each listing sector 0 as a FAT sector 127 times. */
  const repeatedDifat = (sectors: number) => {
    const u = new Uint8Array(512 * (sectors + 1));
    const dv = new DataView(u.buffer);
    u.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    dv.setUint16(0x1e, 9, true); dv.setUint16(0x20, 6, true);
    dv.setUint32(0x30, 0xfffffffe, true); dv.setUint32(0x3c, 0xfffffffe, true); dv.setUint32(0x44, 1, true);
    for (let s = 1; s < sectors; s++) dv.setUint32((s + 1) * 512 + 508, s + 1, true);
    return u;
  };
  it('a DIFAT listing one FAT sector over and over stays small', () => {
    const u = repeatedDifat(8192); // 4 MB: was a 500 MB FAT
    timed(() => openCfb(u), 1500);
    timed(() => readCfb(u), 1500);
  });
  it('real compound files still read', () => {
    const data = latin('x'.repeat(5000));
    const u = buildCfb({ Big: data, Small: latin('hi') });
    expect(openCfb(u)!.read('Big')!.length).toBe(5000);
    expect(readCfb(u)!.streams.get('Big')!.length).toBe(5000);
  });
  it('per-call output limit', () => {
    const z = deflateRawSync(new Uint8Array(8 << 20));
    const r = immortalInflate(z, { maxOutput: 1 << 20 });
    expect(r.isCorrupt).toBe(true);
    expect(r.data.length).toBeLessThanOrEqual(1 << 20);
    expect(immortalInflate(z).data.length).toBe(8 << 20);
  });
  it('a stored block with a bad NLEN is kept but reported', () => {
    const r = immortalInflate(Uint8Array.of(1, 3, 0, 0, 0, 0x61, 0x62, 0x63));
    expect(new TextDecoder().decode(r.data)).toBe('abc');
    expect(r.isCorrupt).toBe(true);
    expect(immortalInflate(Uint8Array.of(1, 3, 0, 0xfc, 0xff, 0x61, 0x62, 0x63)).isCorrupt).toBe(false);
  });
  it('gzip: every member is decoded and trailers are checked', () => {
    const two = cat(gzipSync(latin('Hello, ')), gzipSync(latin('world')));
    expect(new TextDecoder().decode(gunzip(two))).toBe('Hello, world');
    expect(gunzipChecked(two).damage).toEqual([]);
    const bad = gzipSync(latin('Hello'));
    bad[bad.length - 8] ^= 0xff;
    const r = gunzipChecked(bad);
    expect(new TextDecoder().decode(r.data)).toBe('Hello');
    expect(r.damage.length).toBe(1);
  });
  it('snappy rejects a declared length its data cannot reach', () => {
    const src = Uint8Array.of(0x80, 0x80, 0x80, 0x60, 0x00, 0x41); // 200 MB declared, one literal
    expect(() => timed(() => snappyDecompress(src), 200)).toThrow(/snappy/);
  });
});

describe('email (8, 9, 10)', () => {
  const eml = (s: string) => s.replace(/\n/g, '\r\n');
  it('RFC 2231 filenames are decoded with their charset', () => {
    const m = parseEmail(eml('Content-Type: multipart/mixed; boundary=XX\n\n--XX\nContent-Type: text/plain\n\nHi\n--XX\nContent-Type: application/pdf\nContent-Disposition: attachment; filename*=iso-8859-1\'\'r%E9sum%E9.pdf\n\nPDF\n--XX--\n'));
    expect(m.attachments.map((a) => a.name)).toEqual(['résumé.pdf']);
    const u = parseEmail(eml('Content-Type: application/pdf\nContent-Disposition: attachment; filename*=UTF-8\'\'%E2%82%AC%ZZ.pdf\n\nx'));
    expect(u.attachments[0].name).toBe('€%ZZ.pdf');
  });
  it('boundaries match only whole delimiter lines', () => {
    const m = parseEmail(eml('Content-Type: multipart/mixed; boundary=XX\n\n--XX\nContent-Type: text/plain\n\nline one --XXL still body\n--XXL not a boundary\nend\n--XX--\n'));
    expect(m.text).toBe('line one --XXL still body\r\n--XXL not a boundary\r\nend');
  });
  it('raw UTF-8 headers', () => {
    const raw = new TextDecoder('latin1').decode(new TextEncoder().encode('Subject: Café déjà vu\r\n\r\nx'));
    expect(parseEmail(raw).subject).toBe('Café déjà vu');
  });
  it('quoted-printable soft breaks with trailing spaces', () => {
    const m = parseEmail(eml('Content-Transfer-Encoding: quoted-printable\n\nsoft= \nbreak=\t\nhere'));
    expect(m.text).toBe('softbreakhere');
  });
  it('emlx: the message is the byte count on line 1', async () => {
    const msg = 'Subject: Hi\n\nBody mentions <?xml version="1.0"?> inline.\n';
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n';
    const doc = await importEmail(ab(latin(`${msg.length}\n${msg}${plist}`)), 'm.emlx', 'emlx');
    expect(doc.textContent).toContain('inline.');
    expect(doc.textContent).not.toContain('plist');
  });
  it('mbox splits only at From_ lines after a blank line', () => {
    const box = 'From a@b Tue Mar  5 10:00:00 2024\nSubject: One\n\nFirst\nFrom here on, body text\n\nFrom c@d Tue Mar  5 11:00:00 2024\nSubject: Two\n\nSecond\n>From quoted\n';
    const msgs = mboxMessages(box);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toContain('From here on, body text');
    expect(msgs[1]).toContain('\nFrom quoted');
  });
  it('nested message/rfc822 is depth-limited', () => {
    let raw = 'Content-Type: text/plain\n\ninnermost';
    for (let i = 0; i < 3000; i++) raw = `Content-Type: message/rfc822\n\n${raw}`;
    expect(() => timed(() => parseEmail(raw), 1500)).not.toThrow();
  });
  it('script stripping is linear', async () => {
    const html = '<p>keep</p>' + '<script>'.repeat(30000);
    const raw = `Content-Type: text/html\n\n${html}`;
    const t = performance.now();
    const doc = await importEmail(ab(latin(raw)), 'm.eml', 'eml');
    expect(performance.now() - t).toBeLessThan(5000);
    expect(doc.textContent).toContain('keep');
  });
});

describe('MHTML (8, 10)', () => {
  it('content type with 80 KB of semicolons', () => {
    const r = timed(() => parseContentType('text/html; ' + ';'.repeat(80000) + 'charset="a;b"'), 500);
    expect(r.type).toBe('text/html');
  });
  it('quoted parameters keep their semicolons', () => {
    expect(parseContentType('multipart/related; boundary="a;b"; type="text/html"').params).toEqual({ boundary: 'a;b', type: 'text/html' });
  });
  it('a malformed percent escape in a reference does not abort', () => {
    const mht = 'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/html\r\nContent-Location: http://x/a.html\r\n\r\n<img src="dir/%E9%ZZ.png"><p>page</p>\r\n--B--\r\n';
    expect(mhtmlToHtml(latin(mht))).toContain('page');
  });
});
