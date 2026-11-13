import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Node as PMNode } from 'prosemirror-model';
import { importFile, sniff, registerSniffer, formatById } from '../../src/io';
import { openCfb } from '../../src/io/cfb';
import { recoverDocument } from '../../src/io/recover';
import { parseDelimited } from '../../src/io/convert/sheets';
import { decodeWords, parseMime, decompressRtf } from '../../src/io/convert/email';
import {
  ab, cat, latin, enc, utf16, W, buildCfb, buildWord6, buildWrite, buildWp5, wp5Fn, buildWp6, wp6Fn, buildWorksContents, buildWorksMn0,
  buildHwp, buildPpt, buildMsg, buildTnef, buildDbf, buildWk1, buildMacWrite, buildClarisWorks, buildWordPro,
} from './legacy-builders';

const F = resolve(__dirname, '../fixtures/legacy');
const fixture = (n: string) => new Uint8Array(readFileSync(resolve(F, n)));
const open = (u8: Uint8Array, name: string) => importFile(ab(u8), name);
const str = (u: Uint8Array) => Buffer.from(u).toString('utf8');

/** Paragraph texts (table cells and list items included), in order. */
function paras(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => { if (n.isTextblock) { out.push(n.textContent); return false; } return true; });
  return out;
}
function marksOf(doc: PMNode, text: string): string[] {
  let found: string[] = [];
  doc.descendants((n) => { if (n.isText && n.text!.includes(text)) found = n.marks.map((m) => m.type.name + (m.attrs.pt ? ':' + m.attrs.pt : m.attrs.family ? ':' + m.attrs.family : '')); return true; });
  return found;
}
function paraOf(doc: PMNode, text: string): PMNode | null {
  let p: PMNode | null = null;
  doc.descendants((n) => { if (!p && n.isTextblock && n.textContent.includes(text)) p = n; return !p; });
  return p;
}
const count = (doc: PMNode, type: string) => { let k = 0; doc.descendants((n) => { if (n.type.name === type) k++; return true; }); return k; };

// ---------------------------------------------------------------------------------------

describe('compound file reader', () => {
  it('reads nested storages and mini/regular streams', () => {
    const big = new Uint8Array(9000).map((_, i) => i & 0xff);
    const c = openCfb(buildCfb({ 'A': enc('alpha'), 'Dir/B': enc('beta'), 'Dir/Sub/C': big }))!;
    expect(c).toBeTruthy();
    expect(str(c.read('A')!)).toBe('alpha');
    expect(str(c.read('dir/b')!)).toBe('beta');
    expect(c.read('Dir/Sub/C')!.length).toBe(9000);
    expect(c.read('Dir/Sub/C')![8999]).toBe(8999 & 0xff);
    expect(c.list('Dir').sort()).toEqual(['B', 'Sub']);
    expect(c.damaged).toEqual([]);
  });
  it('never throws on truncated or garbage compound files', () => {
    const good = buildCfb({ WordDocument: new Uint8Array(5000).fill(65) });
    for (const cut of [512, 700, 1500, good.length - 100]) expect(() => openCfb(good.slice(0, cut))?.read('WordDocument')).not.toThrow();
    const junk = cat([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], new Uint8Array(3000).map((_, i) => (i * 97) & 0xff));
    expect(() => openCfb(junk)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------

describe('content sniffing', () => {
  const cases: [string, Uint8Array, string, string][] = [
    ['word97', fixture('word97.doc'), 'doc', 'document'],
    ['word6', buildWord6([{ runs: [{ text: 'Hi' }] }]), 'doc6', 'document'],
    ['write', buildWrite([{ text: 'Hi' }]), 'wri', 'document'],
    ['word dos', buildWrite([{ text: 'Hi' }], { dos: true }), 'worddos', 'document'],
    ['wp5', buildWp5(latin('Hello\n')), 'wpd', 'document'],
    ['wp6', buildWp6(latin('Hello\xcc')), 'wpd', 'document'],
    ['wp42', latin('\xc0\x0aJ\x09J\xc0\xce\x0c\x0a\xceSome WordPerfect 4.2 text here.\x0a\x9dBold\x9c\x0a\xd0BlBp\xd0More words follow.\x0a'), 'wpd', 'document'],
    ['works 4.5+', buildWorksContents('Works text'), 'wps', 'document'],
    ['works 3', buildWorksMn0('Works text'), 'wps', 'document'],
    ['word pro', buildWordPro(['Para']), 'lwp', 'document'],
    ['ami pro', latin('[ver]\r\n\t4\r\n[edoc]\r\nText\r\n'), 'sam', 'document'],
    ['clarisworks', buildClarisWorks('Some text for ClarisWorks.'), 'cwk', 'document'],
    ['hwp5', buildHwp([{ text: '안녕' }]), 'hwp', 'document'],
    ['wordstar5', cat([0x1d, 0x7d], new Uint8Array(126), latin('Text\r\n')), 'wordstar', 'document'],
    ['xywrite', latin('\xaeMDBO\xafBold\xaeMDNM\xaf and \xaePG\xaf more text\r\n'), 'xywrite', 'document'],
    ['rtf', enc('{\\rtf1\\ansi Hi}'), 'rtf', 'document'],
    ['html', enc('<!DOCTYPE html><html><body><p>x</p></body></html>'), 'html', 'document'],
    ['xlsx', fixture('sheet.xlsx'), 'xlsx', 'spreadsheet'],
    ['xls', fixture('sheet.xls'), 'xls', 'spreadsheet'],
    ['ods', fixture('sheet.ods'), 'ods', 'spreadsheet'],
    ['csv', enc('a,b,c\n1,2,3\n4,5,6\n'), 'csv', 'spreadsheet'],
    ['dbf', buildDbf([{ name: 'NAME', type: 'C', len: 10 }], [['Ann']]), 'dbf', 'spreadsheet'],
    ['wk1', buildWk1([{ r: 0, c: 0, v: 'x' }]), 'lotus123', 'spreadsheet'],
    ['pptx', fixture('slides.pptx'), 'pptx', 'presentation'],
    ['odp', fixture('slides.odp'), 'odp', 'presentation'],
    ['ppt', buildPpt([{ title: 'T', body: ['b'] }]), 'ppt', 'presentation'],
    ['eml', enc('From: a@b.c\r\nTo: d@e.f\r\nSubject: Hi\r\nDate: Tue, 5 Mar 2024 10:00:00 +0000\r\n\r\nBody\r\n'), 'eml', 'email'],
    ['mbox', enc('From a@b.c Tue Mar  5 10:00:00 2024\nFrom: a@b.c\nSubject: x\n\nbody\n'), 'mbox', 'email'],
    ['msg', buildMsg({ subject: 'S', from: 'F', to: 'T', body: 'B' }), 'msg', 'email'],
    ['tnef', buildTnef({ subject: 'S', body: 'B', attachment: 'a.txt' }), 'tnef', 'email'],
    ['pdf', enc('%PDF-1.4\n%...'), 'pdf', 'document'],
    ['png', cat([0x89], latin('PNG\r\n\x1a\n'), new Uint8Array(20)), 'image', 'unknown'],
  ];
  for (const [label, bytes, format, category] of cases) {
    it(`identifies ${label} with no extension`, () => {
      const r = sniff(bytes, 'file');
      // Prose has commas too: with no extension a table opens as text (.csv and other names keep it).
      if (label === 'csv') { expect(r.format).toBe('txt'); expect(sniff(bytes, 'file.csv').format).toBe('csv'); return; }
      expect(r.format).toBe(format);
      expect(r.category).toBe(category);
      if (r.category !== 'unknown') expect(r.note).toMatch(/no extension/);
    });
    it(`identifies ${label} under a wrong extension`, () => {
      const r = sniff(bytes, 'renamed.bin');
      expect(r.format).toBe(format);
    });
  }
  it('notes when the extension disagrees with the content', () => {
    const r = sniff(buildWp5(latin('Hello\n')), 'letter.doc');
    expect(r.format).toBe('wpd');
    expect(r.note).toBe('Opened as a WordPerfect 5.x document; the file name says .doc.');
    expect(sniff(buildWp5(latin('x')), 'letter.wpd').note).toBe('');
  });
  it('uses the extension only as a tie-breaker', () => {
    // Plain prose with a .wps extension: content says text, but a weak match keeps the extension's importer.
    expect(sniff(enc('just some words'), 'old.wps').format).toBe('wps');
    expect(sniff(enc('just some words'), 'notes.txt').format).toBe('txt');
    expect(sniff(enc('just some words'), 'notes').format).toBe('txt');
  });
  it('detects UTF-16 text without a BOM', () => {
    expect(sniff(utf16('Hello there, plain text'), 'x').label).toMatch(/UTF-16LE/i);
  });
  it('accepts sniffer rules from other modules', () => {
    registerSniffer({ format: 'test-fmt', label: 'Test format', category: 'document', ext: ['tst'], test: (c) => (c.at(0, 'TSTFMT') ? 0.99 : 0) });
    expect(sniff(enc('TSTFMT data'), 'a.txt').format).toBe('test-fmt');
  });
});

// ---------------------------------------------------------------------------------------

describe('Word binary importers', () => {
  it('imports Word 97-2003 with formatting, lists, tables, notes, pictures and headers', async () => {
    const { doc, format } = await open(fixture('word97.doc'), 'word97.doc');
    expect(format.id).toBe('doc');
    const p = paras(doc);
    expect(p[0]).toBe('Legacy Fixture Title');
    expect(paraOf(doc, 'Legacy Fixture Title')!.attrs.style).toBe('Heading 1');
    expect(marksOf(doc, 'bold words')).toContain('bold');
    expect(marksOf(doc, 'italic words')).toContain('italic');
    expect(marksOf(doc, 'underlined words')).toContain('underline');
    expect(marksOf(doc, 'struck')).toContain('strike');
    expect(marksOf(doc, 'big mono')).toEqual(expect.arrayContaining(['font:Liberation Mono', 'size:16']));
    expect(paraOf(doc, 'Centered paragraph')!.attrs.align).toBe('center');
    expect(paraOf(doc, 'Right aligned')!.attrs.align).toBe('right');
    expect(paraOf(doc, 'Justified and indented')!.attrs.indentLeft).toBe(36);
    expect(count(doc, 'bullet_list')).toBe(1);
    expect(count(doc, 'ordered_list')).toBe(1);
    expect(count(doc, 'table')).toBe(1);
    expect(count(doc, 'image')).toBe(1);
    let fn = '';
    doc.descendants((n) => { if (n.type.name === 'footnote') fn = n.attrs.text; return true; });
    expect(fn).toBe('Footnote body text.');
    const s = doc.attrs.settings;
    expect(s.header.center).toBe('Fixture Header Text');
    expect(s.footer.center).toBe('Page {PAGE}');
    expect(p).toContain('Second page paragraph after a page break.');
  });

  it('imports Word 6.0 text, character and paragraph formatting, styles, notes and headers', async () => {
    const bytes = buildWord6([
      { runs: [{ text: 'A Heading' }], istd: 1 },
      { runs: [{ text: 'plain ' }, { text: 'bold', sprms: [85, 1] }, { text: ' and ' }, { text: 'Arial 14', sprms: [93, 1, 0, 99, 28] }] },
      { runs: [{ text: 'centered' }], sprms: [5, 1] },
    ], { footnote: 'The note.', header: 'Running head' });
    const { doc, format } = await open(bytes, 'old.doc');
    expect(format.id).toBe('doc6');
    expect(paras(doc).slice(0, 3)).toEqual(['A Heading', 'plain bold and Arial 14', 'centered']);
    expect(paraOf(doc, 'A Heading')!.attrs.style).toBe('Heading 1');
    expect(doc.attrs.settings.styles['Heading 1']).toMatchObject({ bold: true, size: 16 });
    expect(marksOf(doc, 'bold')).toContain('bold');
    expect(marksOf(doc, 'Arial 14')).toEqual(expect.arrayContaining(['font:Arial', 'size:14']));
    expect(paraOf(doc, 'centered')!.attrs.align).toBe('center');
    let fn = '';
    doc.descendants((n) => { if (n.type.name === 'footnote') fn = n.attrs.text; return true; });
    expect(fn).toBe('The note.');
    expect(doc.attrs.settings.header.center).toBe('Running head');
    expect(doc.attrs.settings.page.margin.left).toBe(72);
  });

  it('imports Windows Write and Word for DOS with fonts and alignment', async () => {
    const w = await open(buildWrite([{ text: 'Title', bold: true, center: true, size: 16 }, { text: 'Body text' }], { fonts: ['Arial'] }), 'a.wri');
    expect(w.format.id).toBe('wri');
    expect(paras(w.doc)).toEqual(['Title', 'Body text']);
    expect(marksOf(w.doc, 'Title')).toEqual(expect.arrayContaining(['bold', 'size:16']));
    expect(paraOf(w.doc, 'Title')!.attrs.align).toBe('center');
    const d = await open(buildWrite([{ text: 'DOS words', bold: true }], { dos: true }), 'a.doc');
    expect(d.format.id).toBe('worddos');
    expect(paras(d.doc)).toEqual(['DOS words']);
    expect(marksOf(d.doc, 'DOS words')).toContain('bold');
  });

  it('imports Word for Macintosh 5 text', async () => {
    const text = 'Mac Word paragraph one\rSecond paragraph\r';
    const u8 = new W().u16be(0xfe37).u16be(0x23).pad(0x18).u32be(0x100 + text.length).pad(0x24).u32be(text.length).pad(0x100).str(text).out();
    const { doc, format } = await open(u8, 'macword');
    expect(format.id).toBe('wordmac');
    expect(paras(doc).slice(0, 2)).toEqual(['Mac Word paragraph one', 'Second paragraph']);
  });
});

// ---------------------------------------------------------------------------------------

describe('WordPerfect importer', () => {
  it('imports 5.x attributes, justification, extended characters, footnotes and headers', async () => {
    const body = cat(
      wp5Fn(0xd0, 0x06, [1, 2]), latin('Centered title\n'),
      wp5Fn(0xd0, 0x06, [2, 0]), latin('Some '), [0xc3, 12, 0xc3], latin('bold'), [0xc4, 12, 0xc4], latin(' and '), [0xc3, 8, 0xc3], latin('italic'), [0xc4, 8, 0xc4],
      latin(' caf'), [0xc0, 41, 1, 0xc0], latin(' '), [0xc0, 32, 4, 0xc0], latin('quoted'), [0xc0, 31, 4, 0xc0], latin('\n'),
      latin('Note here'), wp5Fn(0xd6, 0, [0, 1, 0, 0, 0, 0, 0, ...latin('The footnote text')]), latin('\n'),
      wp5Fn(0xd5, 0, [0, 0, 0, 0, 0, 0, 0, ...latin('Page header')]), [0x0c], latin('Second page\n'),
    );
    const { doc, format } = await open(buildWp5(body), 'letter.doc');
    expect(format.id).toBe('wpd');
    const p = paras(doc);
    expect(p[0]).toBe('Centered title');
    expect(paraOf(doc, 'Centered title')!.attrs.align).toBe('center');
    expect(paraOf(doc, 'Some bold')!.attrs.align).toBeNull();
    expect(marksOf(doc, 'bold')).toContain('bold');
    expect(marksOf(doc, 'italic')).toContain('italic');
    expect(p[1]).toBe('Some bold and italic café “quoted”');
    let fn = '';
    doc.descendants((n) => { if (n.type.name === 'footnote') fn = n.attrs.text; return true; });
    expect(fn).toBe('The footnote text');
    expect(doc.attrs.settings.header.left).toBe('Page header');
    expect(count(doc, 'page_break')).toBe(1);
    expect(p).toContain('Second page');
  });

  it('imports 6.x text, attributes, justification, fonts and header packets', async () => {
    const body = cat(
      wp6Fn(0xd3, 0x05, [2, 0]), latin('Title\x80line'), [0xcc],
      wp6Fn(0xd3, 0x05, [0, 2]), latin('A\x80'), [0xf2, 12, 0xf2], latin('bold'), [0xf3, 12, 0xf3], latin('\x80word'), [0xf0, 29, 4, 0xf0], latin('x'), [0xf0, 28, 4, 0xf0],
      [0xf1, 0, 1, 2, 0xf1], latin('deleted'), [0xf1, 1, 1, 2, 0xf1], [0xcc],
      wp6Fn(0xd6, 0x00, [0, 0], [2]), wp6Fn(0xd4, 0x1a, [0, 0], [1]), latin('In\x80font'), [0xcc],
      wp6Fn(0xd0, 0x09, [0, 0]), latin('Page\x80two'), [0xcc],
    );
    const { doc, format } = await open(buildWp6(body, { header: 'Header text', font: 'Courier New' }), 'six.wpd');
    expect(format.id).toBe('wpd');
    const p = paras(doc);
    expect(p[0]).toBe('Title line');
    expect(paraOf(doc, 'Title line')!.attrs.align).toBe('center');
    expect(p[1]).toBe('A bold word‘x’');
    expect(marksOf(doc, 'bold')).toContain('bold');
    expect(doc.attrs.settings.header.left).toBe('Header text');
    // The first typeface is the document's body font, so its runs carry no extra font mark.
    expect(doc.attrs.settings.theme.bodyFont).toBe('Courier New');
    expect(count(doc, 'page_break')).toBe(1);
    expect(p).toContain('Page two');
  });

  it('imports 4.2 bold and underline', async () => {
    const u8 = latin('\xc0\x0aJ\x09J\xc0Intro line\x0a\x9dBold\x9c and \x94under\x95\x0aLast line\x0a');
    const { doc, format } = await open(u8, 'old.wp');
    expect(format.id).toBe('wpd');
    expect(paras(doc).slice(0, 3)).toEqual(['Intro line', 'Bold and under', 'Last line']);
    expect(marksOf(doc, 'Bold')).toContain('bold');
    expect(marksOf(doc, 'under')).toContain('underline');
  });
});

// ---------------------------------------------------------------------------------------

describe('other legacy word processors', () => {
  it('imports Works 4.5-9 and Works 3-4 text', async () => {
    const a = await open(buildWorksContents('First paragraph\rSecond paragraph\r'), 'w.wps');
    expect(a.format.id).toBe('wps');
    expect(paras(a.doc).slice(0, 2)).toEqual(['First paragraph', 'Second paragraph']);
    const b = await open(buildWorksMn0('Old Works text\r\nMore\r\n'), 'w.wps');
    expect(paras(b.doc).slice(0, 2)).toEqual(['Old Works text', 'More']);
  });

  it('imports Ami Pro styles and character codes', async () => {
    const sam = '[ver]\r\n\t4\r\n[sty]\r\n\tBody Text\r\n[edoc]\r\n@Title@Ami Document\r\n\r\nPlain <+!>bold<-!> and <+">italic<-"> text\r\nwrapped line.\r\n\r\n@Bullet 1@First point\r\n\r\n';
    const { doc, format } = await open(latin(sam), 'doc.sam');
    expect(format.id).toBe('sam');
    const p = paras(doc);
    expect(p[0]).toBe('Ami Document');
    expect(paraOf(doc, 'Ami Document')!.attrs.style).toBe('Title');
    expect(p[1]).toBe('Plain bold and italic text wrapped line.');
    expect(marksOf(doc, 'bold')).toContain('bold');
    expect(marksOf(doc, 'italic')).toContain('italic');
    expect(count(doc, 'bullet_list')).toBe(1);
  });

  it('imports Lotus Word Pro paragraph text', async () => {
    const { doc, format } = await open(buildWordPro(['Word Pro paragraph one.', 'A second, longer paragraph that needs more than one literal run of sixty-four characters.']), 'x.lwp');
    expect(format.id).toBe('lwp');
    expect(paras(doc)).toEqual(['Word Pro paragraph one.', 'A second, longer paragraph that needs more than one literal run of sixty-four characters.']);
  });

  it('imports MacWrite paragraphs, plain and compressed', async () => {
    const { doc, format } = await open(buildMacWrite(['First paragraph here', 'Second one is compressed', 'Third plain']), 'letter');
    expect(format.id).toBe('mcw');
    expect(paras(doc)).toEqual(['First paragraph here', 'Second one is compressed', 'Third plain']);
  });

  it('imports ClarisWorks text', async () => {
    const { doc } = await open(buildClarisWorks('A ClarisWorks paragraph with words.'), 'cw.cwk');
    expect(paras(doc)).toContain('A ClarisWorks paragraph with words.');
  });

  it('imports WordStar with toggles, dot commands and soft returns', async () => {
    const ws = latin('.he Report header\r\n\x02Bold\x02 start of a\x8d\x0awrapped paragraph\x13ul\x13.\r\n.pa\r\nAfter page break\r\n\x1a');
    const { doc, format } = await open(ws, 'r.ws');
    expect(format.id).toBe('wordstar');
    const p = paras(doc);
    expect(p[0]).toBe('Bold start of a wrapped paragraphul.');
    expect(marksOf(doc, 'Bold')).toContain('bold');
    expect(marksOf(doc, 'ul')).toContain('underline');
    expect(doc.attrs.settings.header.left).toBe('Report header');
    expect(count(doc, 'page_break')).toBe(1);
    // High-bit word endings (WordStar 3/4) are stripped.
    const hi = await open(latin('Hell\xef worl\xe4\r\n'), 'h.ws');
    expect(paras(hi.doc)[0]).toBe('Hello world');
  });

  it('imports XyWrite modes and page breaks', async () => {
    const { doc } = await open(latin('Start \xaeMDBO\xafbold\xaeMDNM\xaf end\r\n\xaeFC\xafCentered\r\n\xaePG\xafNext page\r\n'), 'x.xy');
    expect(paras(doc).filter(Boolean)).toEqual(['Start bold end', 'Centered', 'Next page']);
    expect(marksOf(doc, 'bold')).toContain('bold');
    expect(paraOf(doc, 'Centered')!.attrs.align).toBe('center');
  });

  it('imports DCA-RFT EBCDIC text', async () => {
    const ebc = (s: string) => Uint8Array.from(s, (ch) => { const c = ch.charCodeAt(0); if (c === 32) return 0x40; if (c >= 97 && c <= 105) return 0x81 + c - 97; if (c >= 106 && c <= 114) return 0x91 + c - 106; if (c >= 115 && c <= 122) return 0xa2 + c - 115; if (c >= 65 && c <= 73) return 0xc1 + c - 65; if (c >= 74 && c <= 82) return 0xd1 + c - 74; if (c >= 83 && c <= 90) return 0xe2 + c - 83; if (c === 46) return 0x4b; return 0x40; });
    const u8 = cat([0, 8, 0xd3, 0xa8, 0, 0, 0, 0], [0, 3, 0xe0], ebc('Hello DisplayWrite.'), [0x06], ebc('Second para'), [0x06]);
    const { doc, format } = await open(u8, 'doc.rft');
    expect(format.id).toBe('rft');
    expect(paras(doc).slice(0, 2)).toEqual(['Hello DisplayWrite.', 'Second para']);
  });

  it('imports MultiMate text', async () => {
    const { doc } = await open(latin('MultiMate first paragraph\xafSecond\x14tabbed\xaf'), 'a.dox');
    expect(paras(doc).slice(0, 2)).toEqual(['MultiMate first paragraph', 'Second\ttabbed']);
  });

  it('imports Hangul HWP 5 text, character and paragraph shapes', async () => {
    const { doc, format } = await open(buildHwp([{ text: '한글 문서', center: true }, { text: 'Bold line', bold: true }]), 'k.hwp');
    expect(format.id).toBe('hwp');
    expect(paras(doc).slice(0, 2)).toEqual(['한글 문서', 'Bold line']);
    expect(paraOf(doc, '한글')!.attrs.align).toBe('center');
    expect(marksOf(doc, 'Bold line')).toContain('bold');
  });

  it('falls back to format-aware text in the recovery report when the structure is damaged', async () => {
    const good = buildWp5(cat(latin('Recoverable text that survives.\n'), [0xd0, 0x01, 0xff, 0xff]));
    const r = await recoverDocument(ab(good), 'broken.wpd', { textOnly: true, format: 'wpd' });
    const legacy = r.methods.find((m) => m.key === 'legacy')!;
    expect(legacy.status).not.toBe('skipped');
    expect(legacy.text).toContain('Recoverable text that survives.');
  });
});

// ---------------------------------------------------------------------------------------

describe('spreadsheets into documents', () => {
  for (const f of ['sheet.xlsx', 'sheet.xls', 'sheet.ods']) {
    it(`imports ${f} as one table per sheet`, async () => {
      const { doc, format } = await open(fixture(f), f);
      expect(formatById(format.id)?.category).toBe('spreadsheet');
      expect(count(doc, 'table')).toBe(2);
      const p = paras(doc);
      expect(p).toEqual(expect.arrayContaining(['Budget', 'Notes', 'Item', 'Amount', 'Paper', '12.5', '2024-03-15', '52.5', 'Second sheet text']));
    });
  }
  it('parses CSV with quotes, embedded separators and newlines', () => {
    expect(parseDelimited('a,"b,c","d ""q"""\n1,"two\nlines",3\n')).toEqual([['a', 'b,c', 'd "q"'], [1, 'two\nlines', 3]]);
    expect(parseDelimited('x;y\n1;2\n')).toEqual([['x', 'y'], [1, 2]]);
  });
  it('imports CSV, TSV, dBASE and Lotus 1-2-3 files', async () => {
    const csv = await open(enc('Name,Qty\nPens,3\n'), 'a.csv');
    expect(count(csv.doc, 'table')).toBe(1);
    expect(paras(csv.doc)).toEqual(expect.arrayContaining(['Name', 'Qty', 'Pens', '3']));
    const dbf = await open(buildDbf([{ name: 'NAME', type: 'C', len: 10 }, { name: 'AGE', type: 'N', len: 3 }, { name: 'BORN', type: 'D', len: 8 }], [['Ann', '42', '19820307']]), 't.dbf');
    expect(paras(dbf.doc)).toEqual(expect.arrayContaining(['NAME', 'AGE', 'Ann', '42', '1982-03-07']));
    const wk1 = await open(buildWk1([{ r: 0, c: 0, v: 'Label' }, { r: 1, c: 1, v: 2.5 }]), 'a.wk1');
    expect(paras(wk1.doc)).toEqual(expect.arrayContaining(['Label', '2.5']));
  });
});

describe('presentations into documents', () => {
  for (const f of ['slides.pptx', 'slides.odp']) {
    it(`imports ${f} as one section per slide`, async () => {
      const { doc } = await open(fixture(f), f);
      expect(count(doc, 'section_break')).toBe(1);
      const p = paras(doc);
      expect(p[0]).toBe('Quarterly Review');
      expect(paraOf(doc, 'Quarterly Review')!.attrs.style).toBe('Heading 1');
      expect(p).toEqual(expect.arrayContaining(['Sales grew strongly', 'Costs held steady', 'Picture Slide']));
      expect(count(doc, 'image')).toBe(1);
    });
  }
  it('imports PowerPoint 97 titles and body text', async () => {
    const { doc } = await open(buildPpt([{ title: 'First slide', body: ['Point one', 'Point two'] }, { title: 'Second', body: ['More'] }]), 'p.ppt');
    expect(paras(doc)).toEqual(['First slide', 'Point one', 'Point two', 'Second', 'More']);
    expect(count(doc, 'section_break')).toBe(1);
  });
});

describe('email into documents', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const eml = [
    'From: =?UTF-8?B?w4lsaXNl?= <elise@example.com>', 'To: bob@example.com', 'Cc: carol@example.com', 'Subject: =?ISO-8859-1?Q?Caf=E9_plans?=',
    'Date: Tue, 05 Mar 2024 10:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="XX"', '',
    '--XX', 'Content-Type: multipart/related; boundary="YY"', '',
    '--YY', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    '<p>Hello <b>Bob</b>, see =E2=86=92 <img src=3D"cid:pic1"></p>', '--YY', 'Content-Type: image/png', 'Content-ID: <pic1>', 'Content-Transfer-Encoding: base64', '', png, '--YY--',
    '--XX', 'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: attachment; filename="plan.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--XX--', '',
  ].join('\r\n');
  it('decodes encoded words and MIME parts', () => {
    expect(decodeWords('=?UTF-8?B?w4lsaXNl?= <e@x>')).toBe('Élise <e@x>');
    const m = parseMime(eml);
    expect(m.subject).toBe('Café plans');
    expect(m.html).toContain('Hello <b>Bob</b>, see →');
    expect(m.attachments.map((a) => a.name)).toEqual(['plan.pdf']);
    expect(m.inline.has('cid:pic1')).toBe(true);
  });
  it('imports an .eml with a header block, HTML body, inline picture and attachment list', async () => {
    const { doc, format } = await open(enc(eml), 'mail.eml');
    expect(format.id).toBe('eml');
    const p = paras(doc);
    expect(p[0]).toBe('Café plans');
    expect(p).toEqual(expect.arrayContaining(['From:', 'Élise <elise@example.com>', 'To:', 'bob@example.com', 'Date:', 'Attachments']));
    expect(p.some((t) => t.startsWith('Hello Bob, see →'))).toBe(true);
    expect(count(doc, 'image')).toBe(1);
    expect(p.some((t) => t.startsWith('plan.pdf (application/pdf'))).toBe(true);
  });
  it('imports .msg properties, body and attachments', async () => {
    const { doc } = await open(buildMsg({ subject: 'Quarterly numbers', from: 'Ann', to: 'Team', body: 'Numbers attached.', attachment: { name: 'q.xlsx', data: new Uint8Array(10) } }), 'm.msg');
    const p = paras(doc);
    expect(p[0]).toBe('Quarterly numbers');
    expect(p).toEqual(expect.arrayContaining(['Ann', 'Team', 'Tue, 05 Mar 2024 10:00:00 +0000', 'Numbers attached.']));
    expect(p.some((t) => t.startsWith('q.xlsx'))).toBe(true);
  });
  it('imports TNEF bundles and mbox mailboxes', async () => {
    const t = await open(buildTnef({ subject: 'Bundle', body: 'Body text', attachment: 'notes.txt' }), 'winmail.dat');
    expect(paras(t.doc)).toEqual(expect.arrayContaining(['Bundle', 'Body text']));
    expect(paras(t.doc).some((x) => x.startsWith('notes.txt'))).toBe(true);
    const mb = await open(enc('From a@b Tue Mar  5 10:00:00 2024\nSubject: One\n\nFirst\n\nFrom c@d Tue Mar  5 11:00:00 2024\nSubject: Two\n\nSecond\n'), 'box.mbox');
    expect(paras(mb.doc)).toEqual(expect.arrayContaining(['One', 'First', 'Two', 'Second']));
    expect(count(mb.doc, 'section_break')).toBe(1);
  });
  it('decompresses compressed RTF bodies (LZFu)', () => {
    // Literals then the end marker: a reference to the current write position (207 + 10).
    const text = latin('{\\rtf1 hi}');
    const end = (207 + text.length) << 4;
    const body = cat([0x00], text.subarray(0, 8), [0x04], text.subarray(8, 10), [end >> 8, end & 0xff]);
    const comp = cat(new W().u32(body.length + 12).u32(text.length).u32(0x75465a4c).u32(0).out(), body);
    expect(str(decompressRtf(comp)!)).toBe('{\\rtf1 hi}');
    const stored = cat(new W().u32(14).u32(4).u32(0x414c454d).u32(0).out(), latin('{\\rt'));
    expect(str(decompressRtf(stored)!)).toBe('{\\rt');
  });
});
