/**
 * Regression tests for content sniffing and text decoding: ordinary text must open as text
 * (not as WordPerfect, WordStar, CSV, mbox, media, PDF …), sniffing must stay linear on
 * crafted input, Windows smart punctuation and BOM-less UTF-16 must decode correctly, ZIP
 * size limits must not fall through to recovery, and a failed text-format import falls back
 * to plain text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { sniff, importFile, formatForSniff, formatById, friendlyOpenError, decodeText } from '../../src/io';
import { makeContext, wp42Score, wordstarScore } from '../../src/io/sniff';
import { detectTextile, detectMhtml, xmlRoot, skipProlog } from '../../src/io/sniff-b';
import { detectText } from '../../src/io/encoding';
import { ZipLimitError } from '../../src/io/zip';
import { toArrayBuffer } from '../../src/io/serialize';

const utf8 = (s: string) => new TextEncoder().encode(s);
const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const CP1252: Record<string, number> = { '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '…': 0x85 };
const cp1252 = (s: string) => Uint8Array.from([...s].map((c) => CP1252[c] ?? c.charCodeAt(0)));
const ab = (u8: Uint8Array) => toArrayBuffer(u8);
const paras = (d: { forEach: (f: (n: { textContent: string }) => void) => void }) => { const out: string[] = []; d.forEach((n) => out.push(n.textContent)); return out; };

async function openText(u8: Uint8Array, name: string) {
  const r = await importFile(ab(u8), name);
  return { id: r.format.id, paras: paras(r.doc), note: r.note };
}

const FRENCH = 'Je préfère le café très serré. Hélas, la dernière fois que j’y suis allé, c’était fermé.';

describe('accented text is not WordPerfect 4.2 or WordStar', () => {
  it('scores UTF-8 French as neither', () => {
    expect(wp42Score(utf8(FRENCH))).toBe(0);
    expect(wordstarScore(makeContext(utf8(FRENCH), 'x'))).toBe(0);
  });

  it('scores Latin-1 French as neither', () => {
    const l1 = latin(FRENCH.replace(/’/g, "'") + '\r\n' + 'Ça coûte très cher à Noël, déjà. Où est le thé? Été à la fête.\r\n');
    expect(wp42Score(l1)).toBe(0);
    expect(wordstarScore(makeContext(l1, 'x'))).toBe(0);
  });

  for (const name of ['notes.txt', 'notes']) {
    it(`opens UTF-8 and Latin-1 French as text (${name})`, async () => {
      const a = await openText(utf8(FRENCH + '\n'), name);
      expect(a.id).toBe('txt');
      expect(a.paras).toEqual([FRENCH]);
      const plain = FRENCH.replace(/’/g, "'");
      const b = await openText(latin(plain + '\n'), name);
      expect(b.id).toBe('txt');
      expect(b.paras).toEqual([plain]);
    });
  }

  it('still recognizes WordPerfect 4.2 codes and WordStar codes', () => {
    const wp = latin('\xc0\x0aJ\x09J\xc0\xce\x0c\x0a\xceSome WordPerfect 4.2 text here.\x0a\x9dBold\x9c\x0a\xd0BlBp\xd0More words follow.\x0a');
    expect(sniff(wp, 'file').format).toBe('wpd');
    const ws = latin('.he Report header\r\n\x02Bold\x02 start of a\x8d\x0awrapped paragraph\x13ul\x13.\r\n.pa\r\nAfter page break\r\n\x1a');
    expect(sniff(ws, 'file').format).toBe('wordstar');
  });

  it('opens a weak binary-heuristic match named .txt as text', () => {
    const ws = latin('.he Report header\r\nWords and more words in a plain file.\r\n');
    expect(sniff(ws, 'r.txt').format).toBe('txt');
  });
});

describe('sniffing stays linear on crafted input', () => {
  const time = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };

  it('skips many leading HTML comments quickly', () => {
    const bad = utf8('<!-- note -->\n'.repeat(40) + '<p>no doctype here');
    expect(time(() => sniff(bad, 'a.html'))).toBeLessThan(200);
    const ok = utf8('<!-- note -->\n'.repeat(40) + '<!DOCTYPE html><html><body><p>x</p></body></html>');
    expect(sniff(ok, 'file').format).toBe('html');
  });

  it('handles other adversarial prologs and headers quickly', () => {
    const inputs: [string, Uint8Array][] = [
      ['a.xml', utf8('<!DOCTYPE x' + ' '.repeat(15000))],
      ['a.xml', utf8('<' + 'a'.repeat(15000))],
      ['a.xml', utf8('<?x '.repeat(3000))],
      ['a.xml', utf8('<!--'.repeat(3000))],
      ['a.sam', utf8('[ver]' + '\n'.repeat(4000))],
      ['a.eml', utf8('X-Header: value\r\n'.repeat(60) + 'Subject: no multipart\r\n')],
      ['a', utf8('p' + '<'.repeat(40) + 'x\n')],
      ['a.md', utf8('['.repeat(8000))],
    ];
    for (const [name, u8] of inputs) expect(time(() => sniff(u8, name)), name).toBeLessThan(200);
    expect(time(() => detectMhtml(utf8('X-Header: value\r\n'.repeat(60) + 'Subject: x\r\n'), 'a.mht'))).toBeLessThan(200);
    expect(time(() => detectTextile(utf8('p' + '<'.repeat(40) + 'x\n'), 'a'))).toBeLessThan(200);
  });

  it('keeps the prolog skipping behaviour', () => {
    const t = '﻿<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE r [<!ENTITY a ">">]>\n<r/>';
    expect(t.slice(skipProlog(t))).toBe('<r/>');
    expect(xmlRoot(utf8('<?xml version="1.0"?><!-- c --><!DOCTYPE book><book><title>x</title></book>'))?.root).toBe('book');
    expect(sniff(utf8('<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg"/>'), 'file').label).toBe('SVG image');
    expect(detectMhtml(utf8('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--b--\r\n'), 'a.mht')).toBe(1);
  });
});

describe('plain text is not mistaken for tables, mail or binaries', () => {
  const cases: [string, string][] = [
    ['notes.txt', 'Hello, world\nGoodbye, world\n'],
    ['notes.txt', 'Name:\tAnn\nAge:\t42\n'],
    ['notes', 'Hello, world\nGoodbye, world\n'],
    ['notes.txt', 'a,b\n1,2\n3,4\n'],
    ['notes.txt', 'From here to eternity and back.\nNote: it is.\n'],
    ['notes', 'From here to eternity and back.\nNote: it is.\n'],
    ['notes.txt', 'ID3 tags hold the song title.\n'],
    ['notes', 'ID3 tags hold the song title.\n'],
    ['notes.txt', 'WordPro was a word processor.\n'],
    ['notes', 'WriteNow was a word processor.\n'],
    ['notes', 'The file starts with the bytes %PDF-1.7 and then binary.\n'],
    ['notes.me', 'Some notes about me.\nAnd more.\n'],
    ['notes.1', 'Chapter one.\nIt was a dark night.\n'],
    ['notes.t', 'Tasks for today.\n'],
    ['notes.txt', 'Meeting notes\n=============\nFirst point\nSecond point\n'],
    ['notes.txt', '# comment\nSee [1](2) and **this** here.\n'],
  ];
  for (const [name, text] of cases) {
    it(`opens ${JSON.stringify(text.slice(0, 24))} in ${name} as text`, async () => {
      expect(sniff(utf8(text), name).format).toBe('txt');
      const r = await openText(utf8(text), name);
      expect(r.id).toBe('txt');
      expect(r.paras).toEqual(text.replace(/\n$/, '').split('\n'));
    });
  }

  it('keeps real tables, mailboxes, tags, PDFs and troff', () => {
    expect(sniff(utf8('a,b\n1,2\n'), 'x.csv').format).toBe('csv');
    expect(sniff(utf8('a,b,c\n1,2,3\n4,5,6\n'), 'x.bin').format).toBe('csv');
    expect(sniff(utf8('a,b\n1,2\n'), 'x.bin').format).toBe('txt'); // two rows are not enough
    expect(sniff(utf8('From MAILER-DAEMON Fri Jul  8 12:08:34 2011\nReturn-Path: <a@b.c>\nSubject: x\n\nbody\n'), 'file').format).toBe('mbox');
    expect(sniff(utf8('From a@b.c Tue, 5 Mar 2024 10:00:00 +0000\nFrom: a@b.c\n\nbody\n'), 'file').format).toBe('mbox');
    expect(sniff(Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x10, 0x20, ...new Array(40).fill(0)]), 'file').format).toBe('media');
    expect(sniff(utf8('%PDF-1.4\n%...'), 'x.txt').format).toBe('pdf');
    expect(sniff(Uint8Array.from([0, 1, 2, 3, ...utf8('junk'), 0, 0, ...utf8('%PDF-1.4\n')]), 'file').format).toBe('pdf');
    expect(sniff(utf8('.pp\nSome paragraph.\n.sh 1 Intro\n'), 'paper.me').format).toBe('man');
  });

  it('wants a plausible dBASE header', () => {
    // Version '0', a sane date and lengths, but no records or field descriptors to back them.
    const fake = latin('0\x7c\x03\x0f\x05\x00\x00\x00\x41\x00\x0a\x00' + ' plain words follow in this text file.'.repeat(3));
    expect(sniff(fake, 'file').format).not.toBe('dbf');
  });
});

describe('format choice for .txt files', () => {
  const s = (format: string, confidence: number, category = 'document') => ({ format, label: format, confidence, category, note: '', ext: 'txt', exts: [] }) as never;
  it('keeps .txt for extension-only and light-markup guesses', () => {
    expect(formatForSniff(s('rst', 0.2), 'notes.txt')?.id).toBe('txt');
    expect(formatForSniff(s('md', 0.4), 'notes.txt')?.id).toBe('txt');
    expect(formatForSniff(s('csv', 0.65, 'spreadsheet'), 'notes.txt')?.id).toBe('txt');
    expect(formatForSniff(s('rtf', 0.99), 'notes.txt')?.id).toBe('rtf');
    expect(formatForSniff(s('md', 0.4), 'notes.md')?.id).toBe('md');
  });
});

describe('text encodings', () => {
  it('reads Windows smart quotes, apostrophes and dashes as Windows-1252', () => {
    for (const t of ['It’s a “test” – really. Don’t worry…\n', 'Don’t stop. It’s John’s book.\n', 'He said “yes”.\n', 'Wait — what? ‘Fine,’ she said…\n']) {
      const d = detectText(cp1252(t));
      expect(d.encoding, t).toBe('windows-1252');
      expect(d.text).toBe(t);
      expect(decodeText(ab(cp1252(t)))).toBe(t);
    }
  });

  it('opens a Windows-1252 .txt with smart punctuation intact', async () => {
    const r = await openText(cp1252('Don’t stop. It’s John’s book.\n'), 'b.txt');
    expect(r.paras).toEqual(['Don’t stop. It’s John’s book.']);
  });

  const utf16 = (s: string, le: boolean) => {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 * i + (le ? 0 : 1)] = c & 255; out[2 * i + (le ? 1 : 0)] = c >> 8; }
    return out;
  };
  const RU = 'Это проверочный текст на русском языке, чтобы определить кодировку файла.\nВторая строка.';
  const ZH = '这是一个中文测试文件，我们在这里写一些常用的汉字，看看能不能正确识别编码。\n第二行。';
  for (const [label, text] of [['Cyrillic', RU], ['Chinese', ZH]]) {
    for (const le of [true, false]) {
      it(`detects BOM-less UTF-16${le ? 'LE' : 'BE'} ${label}`, async () => {
        const u8 = utf16(text, le);
        const d = detectText(u8);
        expect(d.encoding).toBe(le ? 'utf-16le' : 'utf-16be');
        expect(d.text).toBe(text);
        expect(sniff(u8, 'a.txt').format).toBe('txt');
        const r = await openText(u8, 'a.txt');
        expect(r.paras).toEqual(text.split('\n'));
      });
    }
  }

  it('does not read ASCII or Latin-1 text as UTF-16', () => {
    expect(detectText(utf8('Plain ASCII text, nothing more to it.')).encoding).toBe('utf-8');
    expect(detectText(latin('Les élèves ont été très étonnés à la fête.')).encoding).not.toMatch(/utf-16/);
  });
});

describe('ZIP limits and failed imports', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A small package whose central directory claims a 2 GB document part. */
  async function bomb(): Promise<Uint8Array> {
    const z = new JSZip();
    z.file('[Content_Types].xml', '<Types/>');
    z.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>');
    const u8 = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let p = 0; p + 46 <= u8.length; p++) {
      if (dv.getUint32(p, true) !== 0x02014b50) continue;
      const nl = dv.getUint16(p + 28, true);
      if (new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl)) === 'word/document.xml') dv.setUint32(p + 24, 0x7fffffff, true);
    }
    return u8;
  }

  it('refuses a package over the limits without trying recovery', async () => {
    const u8 = await bomb();
    expect(sniff(u8, 'big.docx').format).toBe('docx');
    const rec = await import('../../src/io/recover');
    const spy = vi.spyOn(rec, 'recoverDocument');
    await expect(importFile(ab(u8), 'big.docx')).rejects.toBeInstanceOf(ZipLimitError);
    await expect(importFile(ab(u8), 'big.docx')).rejects.toThrow(/limit/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not inflate oversized entries while sniffing, and reads each part once', async () => {
    const z = new JSZip();
    z.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    z.file('content.xml', '<x/>');
    const u8 = await z.generateAsync({ type: 'uint8array' });
    const zi = makeContext(u8, 'a.odt').zip()!;
    const a = zi.read('content.xml', 100)!, b = zi.read('content.xml', 50)!;
    expect(new TextDecoder().decode(a)).toBe('<x/>');
    expect(b.buffer).toBe(a.buffer);
    const big = await bomb();
    expect(makeContext(big, 'a.docx').zip()!.read('word/document.xml')).toBeNull();
  });

  it('opens readable text as plain text when a text-format importer fails', async () => {
    const md = formatById('md')!;
    vi.spyOn(md, 'import').mockRejectedValue(new Error('boom'));
    const r = await importFile(ab(utf8('# Title\n\nSome *text* here.\n')), 'a.md');
    expect(r.format.id).toBe('txt');
    expect(paras(r.doc)).toEqual(['# Title', '', 'Some *text* here.']);
    expect(r.note).toMatch(/^Could not read as Markdown.*: boom; opened as plain text\.$/);
  });

  it('still fails for unreadable bytes when a non-recoverable importer fails', async () => {
    const z = new JSZip();
    z.file('xl/workbook.xml', '<workbook/>');
    const u8 = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const fmt = formatForSniff(sniff(u8, 'a.xlsx'), 'a.xlsx')!;
    vi.spyOn(fmt, 'import').mockRejectedValue(new Error('bad workbook'));
    await expect(importFile(ab(u8), 'a.xlsx')).rejects.toThrow('bad workbook');
  });

  it('explains raw JSZip errors', () => {
    expect(friendlyOpenError('End of data reached (data length = 10, asked index = 30). Corrupted zip ?')).toMatch(/cut short|damaged/);
    expect(friendlyOpenError('Corrupted zip: missing 12 bytes.')).toMatch(/cut short/);
    expect(friendlyOpenError("Corrupted zip: can't find end of central directory")).toMatch(/table of contents/);
  });
});
