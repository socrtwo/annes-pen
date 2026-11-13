import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/editor/schema';
import { defaultSettings } from '../../src/editor/settings';
import { finishDoc, newSettings } from '../../src/io/serialize';
import { docToMarkdown, markdownToBlocks } from '../../src/io/markdown';
import { docToRtf, rtfToDoc } from '../../src/io/rtf';
import { exportDocx } from '../../src/io/docx-export';
import { importDocx } from '../../src/io/docx-import';
import { capNestingSource, docToHtml, htmlToBlocks, importHtml } from '../../src/io/html';
import { docToFodt, exportOdt, importFodt, importOdt } from '../../src/io/odt';
import { exportEpub, importEpub } from '../../src/io/epub';
import { escapeXml } from '../../src/io/serialize';
import { esc } from '../../src/io/ooxml-util';

const S = schema;
const docSettingsOf = (d: PMNode) => d.attrs.settings as ReturnType<typeof defaultSettings>;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const t = (text: string, ...marks: string[]) => S.text(text, marks.map((m) => S.marks[m].create()));
const p = (content: (PMNode | string)[] = [], attrs: Record<string, any> = {}) =>
  S.nodes.paragraph.create(attrs, content.map((c) => (typeof c === 'string' ? S.text(c) : c)));
const doc = (blocks: PMNode[]) => S.node('doc', { settings: defaultSettings() }, blocks);
const li = (...blocks: PMNode[]) => S.nodes.list_item.create(null, blocks);
const ul = (...items: PMNode[]) => S.nodes.bullet_list.create(null, items);
const ol = (order: number, ...items: PMNode[]) => S.nodes.ordered_list.create({ order }, items);
const mdBack = (d: PMNode) => { const s = newSettings(); return finishDoc(markdownToBlocks(docToMarkdown(d), s), s); };
const ms = (f: () => void) => { const t0 = Date.now(); f(); return Date.now() - t0; };

describe('finishDoc', () => {
  it('keeps every child of a very long document', () => {
    const n = 150_001;
    const blocks = Array.from({ length: n }, (_, i) => p([String(i)]));
    const d = finishDoc(blocks, newSettings());
    expect(d.childCount).toBe(n);
    expect(d.lastChild!.textContent).toBe(String(n - 1));
  });
  it('still unwraps containers that do not fit, in order', () => {
    const item = li(p(['a']), p(['b']));
    const cell = S.nodes.table_cell.create(null, [p(['c']), S.nodes.code_block.create(null, S.text('x'))]);
    const d = finishDoc([item, cell, p(['d'])], newSettings());
    expect(d.textContent).toBe('abcxd');
  });
});

describe('Markdown import performance', () => {
  it('is linear in soft line breaks', () => {
    const src = Array.from({ length: 100_000 }, (_, i) => 'line ' + i).join('\n');
    let blocks: PMNode[] = [];
    expect(ms(() => { blocks = markdownToBlocks(src); })).toBeLessThan(5000);
    expect(blocks[0].textContent.endsWith('line 99999')).toBe(true);
  });
  it('is linear in unclosed link tails and comments', () => {
    for (const unit of ['[a](', '[a](<', '[a](b (', 'x <!--']) {
      const src = unit.repeat(50_000);
      let text = '';
      expect(ms(() => { text = markdownToBlocks(src).map((b) => b.textContent).join(''); })).toBeLessThan(5000);
      expect(text.length).toBeGreaterThan(src.length * 0.9);
    }
  });
  it('handles a deeply nested list quickly', () => {
    let src = '';
    for (let i = 0; i < 1000; i++) src += '  '.repeat(i) + '- a\n';
    expect(ms(() => markdownToBlocks(src))).toBeLessThan(2000);
  });
  it('keeps hard breaks from trailing spaces and soft breaks as spaces', () => {
    const [b] = markdownToBlocks('one  \ntwo\nthree\\\nfour');
    const kinds: string[] = [];
    b.forEach((c) => kinds.push(c.isText ? c.text! : c.type.name));
    expect(kinds).toEqual(['one', 'hard_break', 'two three', 'hard_break', 'four']);
  });
  it('still parses links with nested parentheses', () => {
    const [b] = markdownToBlocks('[x](http://a/(b(c)))');
    expect(b.firstChild!.marks[0].attrs.href).toBe('http://a/(b(c))');
  });
});

describe('Markdown export', () => {
  it('nested ordered list not starting at 1 survives a round trip', () => {
    const d = doc([ul(li(p(['item']), ol(3, li(p(['three'])), li(p(['four'])))))]);
    const back = mdBack(d);
    const outer = back.firstChild!;
    expect(outer.type.name).toBe('bullet_list');
    const inner = outer.firstChild!.child(1);
    expect(inner.type.name).toBe('ordered_list');
    expect(inner.attrs.order).toBe(3);
    expect(outer.firstChild!.firstChild!.textContent).toBe('item');
  });
  it('nested list with an empty first item survives a round trip', () => {
    const d = doc([ul(li(p(['item']), ul(li(p()), li(p(['b'])))))]);
    const back = mdBack(d);
    const outer = back.firstChild!;
    expect(outer.firstChild!.firstChild!.textContent).toBe('item');
    expect(outer.firstChild!.child(1).type.name).toBe('bullet_list');
    expect(outer.firstChild!.child(1).childCount).toBe(2);
  });
  it('escapes a closing # run in headings', () => {
    const d = doc([p(['Section #'], { style: 'Heading 2' }), p(['##'], { style: 'Heading 1' })]);
    const back = mdBack(d);
    expect(back.child(0).textContent).toBe('Section #');
    expect(back.child(1).textContent).toBe('##');
  });
  it('bold ending in punctuation before a word stays bold', () => {
    const d = doc([p([t('bold.', 'bold'), 'next ', t('(x)', 'italic'), 'y'])]);
    const back = mdBack(d);
    const para = back.firstChild!;
    expect(para.textContent).toBe('bold.next (x)y');
    expect(para.child(0).text).toBe('bold.');
    expect(para.child(0).marks.map((m) => m.type.name)).toEqual(['bold']);
    expect(para.child(2).marks.map((m) => m.type.name)).toEqual(['italic']);
    // Plain cases keep the Markdown syntax.
    expect(docToMarkdown(doc([p(['a ', t('b', 'bold'), ' c'])]))).toBe('a **b** c\n');
  });
  it('drops a hard break at the end of a paragraph', () => {
    const d = doc([p(['end', S.nodes.hard_break.create()]), p(['next'])]);
    const md = docToMarkdown(d);
    expect(md).not.toContain('\\');
    const back = mdBack(d);
    expect(back.childCount).toBe(2);
    expect(back.child(0).textContent).toBe('end');
  });
  it('a list item with an empty first paragraph keeps its content', () => {
    const d = doc([ul(li(p(), p(['para'])), li(p(['b'])))]);
    const back = mdBack(d);
    expect(back.childCount).toBe(1);
    expect(back.firstChild!.childCount).toBe(2);
    expect(back.firstChild!.firstChild!.textContent).toBe('para');
  });
});

describe('RTF', () => {
  const OPTS = { fileName: 'x.rtf', author: 'T' };
  const rtfBack = (d: PMNode) => rtfToDoc(docToRtf(d, OPTS));
  const lists = (d: PMNode) => { const r: PMNode[] = []; d.forEach((b) => { if (/list/.test(b.type.name)) r.push(b); }); return r; };

  it('reads past 50M characters', () => {
    const body = 'a'.repeat(51_000_000);
    const d = rtfToDoc('{\\rtf1 ' + body + '\\par end\\par}');
    expect(d.lastChild!.textContent).toBe('end');
    expect(d.firstChild!.textContent.length).toBe(body.length);
  }, 120_000);
  it('reads a big picture without a per-character array', () => {
    const png = Uint8Array.from(atob(PNG.split(',')[1]), (c) => c.charCodeAt(0));
    const hex = Array.from(png, (b) => b.toString(16).padStart(2, '0')).join('');
    const d = rtfToDoc(`{\\rtf1 {\\pict\\pngblip\\picw1\\pich1 ${hex}\n${'0'.repeat(2_000_000)}}\\par}`);
    let img: PMNode | null = null;
    d.descendants((n) => { if (n.type.name === 'image') img = n; });
    expect(img).not.toBeNull();
  });
  it('adjacent lists with different \\ls stay apart', () => {
    const rtf = '{\\rtf1{\\*\\listtable{\\list\\listid1{\\listlevel\\levelnfc0\\levelstartat1{\\leveltext\\\'02\\\'00.;}}}{\\list\\listid2{\\listlevel\\levelnfc0\\levelstartat1{\\leveltext\\\'02\\\'00.;}}}}'
      + '{\\*\\listoverridetable{\\listoverride\\listid1\\ls1}{\\listoverride\\listid2\\ls2}}'
      + '\\pard\\ls1\\ilvl0{\\listtext 1.\\tab}A\\par\\pard\\ls1\\ilvl0{\\listtext 2.\\tab}B\\par'
      + '\\pard\\ls2\\ilvl0{\\listtext 1.\\tab}C\\par}';
    const ls = lists(rtfToDoc(rtf));
    expect(ls.length).toBe(2);
    expect(ls[0].childCount).toBe(2);
    expect(ls[1].textContent).toBe('C');
  });
  it('a list resumed after a paragraph keeps counting', () => {
    const rtf = '{\\rtf1{\\*\\listtable{\\list\\listid1{\\listlevel\\levelnfc0\\levelstartat1{\\leveltext\\\'02\\\'00.;}}}}'
      + '{\\*\\listoverridetable{\\listoverride\\listid1\\ls1}}'
      + '\\pard\\ls1\\ilvl0{\\listtext 1.\\tab}A\\par\\pard\\ls1\\ilvl0{\\listtext 2.\\tab}B\\par'
      + '\\pard Between\\par\\pard\\ls1\\ilvl0{\\listtext 3.\\tab}C\\par}';
    const ls = lists(rtfToDoc(rtf));
    expect(ls.length).toBe(2);
    expect(ls[1].attrs.order).toBe(3);
  });
  it('a second paragraph of a list item stays in the item', () => {
    const d = doc([ol(1, li(p(['one']), p(['more of one'])), li(p(['two'])))]);
    const back = rtfBack(d);
    expect(back.childCount).toBe(1);
    const list = back.firstChild!;
    expect(list.childCount).toBe(2);
    expect(list.firstChild!.childCount).toBe(2);
    expect(list.firstChild!.child(1).textContent).toBe('more of one');
    expect(list.firstChild!.child(1).attrs.indentLeft).toBeNull();
  });
  it('item order is kept when a continuation follows a nested list', () => {
    const d = doc([ul(li(p(['a']), ul(li(p(['a1']))), p(['a tail'])), li(p(['b'])))]);
    const back = rtfBack(d);
    const item = back.firstChild!.firstChild!;
    expect(item.childCount).toBe(3);
    expect(item.child(1).type.name).toBe('bullet_list');
    expect(item.child(2).textContent).toBe('a tail');
  });
  it('hyperlinks with quotes, spaces and backslashes keep their target', () => {
    const hrefs = ['https://x.test/a"b', 'https://x.test/a b', 'file:///C:\\dir\\f.doc', '#anchor'];
    const d = doc(hrefs.map((h) => p([S.text('link', [S.marks.link.create({ href: h })])])));
    const back = rtfBack(d);
    const got: string[] = [];
    back.descendants((n) => { const l = n.marks.find((m) => m.type.name === 'link'); if (l) got.push(l.attrs.href); });
    expect(got).toEqual(['https://x.test/a%22b', 'https://x.test/a%20b', 'file:///C:\\dir\\f.doc', '#anchor']);
  });
  it('writes and reads right-to-left paragraphs and runs', () => {
    const d = doc([p(['שלום'], { dir: 'rtl', align: 'right' }), p([S.text('abc', [S.marks.dir.create({ dir: 'rtl' })])])]);
    const rtf = docToRtf(d, OPTS);
    expect(rtf).toContain('\\rtlpar');
    const back = rtfToDoc(rtf);
    expect(back.child(0).attrs.dir).toBe('rtl');
    expect(back.child(0).attrs.align).toBe('right');
    expect(back.child(1).firstChild!.marks.some((m) => m.type.name === 'dir')).toBe(true);
    expect(back.child(1).attrs.dir).toBeNull();
  });
});

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function miniDocx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'arraybuffer' });
}
const docxRoundTrip = async (d: PMNode) => {
  const buf = await (await exportDocx(d, { fileName: 'x.docx', author: 'T' })).arrayBuffer();
  return { back: await importDocx(buf, 'x.docx'), xml: await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string') };
};
const cellXml = (text: string, pr = '') => `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const firstTable = (d: PMNode) => { let t: PMNode | null = null; d.descendants((n) => { if (!t && n.type.name === 'table') { t = n; return false; } return !t; }); return t! as PMNode; };

describe('DOCX', () => {
  it('bidi paragraphs swap jc left/right (leading/trailing) both ways', async () => {
    const d = doc([p(['r'], { dir: 'rtl', align: 'right' }), p(['l'], { dir: 'rtl', align: 'left' }), p(['x'], { align: 'right' })]);
    const { back, xml } = await docxRoundTrip(d);
    const jcs = [...xml.matchAll(/<w:jc w:val="(\w+)"\/>/g)].map((m) => m[1]);
    expect(jcs).toEqual(['left', 'right', 'right']);
    expect([0, 1, 2].map((i) => back.child(i).attrs.align)).toEqual(['right', 'left', 'right']);
    const imported = await importDocx(await miniDocx('<w:p><w:pPr><w:bidi/><w:jc w:val="start"/></w:pPr><w:r><w:t>s</w:t></w:r></w:p>'), 'x.docx');
    expect(imported.firstChild!.attrs.align).toBe('right');
  });
  it('clamps w:gridSpan to the grid', async () => {
    const body = `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cellXml('a', '<w:gridSpan w:val="5000000"/>')}</w:tr><w:tr>${cellXml('b')}${cellXml('c')}</w:tr></w:tbl>`;
    const d = await importDocx(await miniDocx(body), 'x.docx');
    const tbl = firstTable(d);
    expect(tbl.firstChild!.firstChild!.attrs.colspan).toBe(2);
    const noGrid = await importDocx(await miniDocx(`<w:tbl><w:tr>${cellXml('a', '<w:gridSpan w:val="99999"/>')}</w:tr></w:tbl>`), 'x.docx');
    expect(firstTable(noGrid).firstChild!.firstChild!.attrs.colspan).toBeLessThanOrEqual(63);
  });
  it('emits placeholder cells for w:gridBefore and w:gridAfter', async () => {
    const grid = '<w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/></w:tblGrid>';
    const body = `<w:tbl>${grid}<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${cellXml('b')}${cellXml('c')}</w:tr><w:tr><w:trPr><w:gridAfter w:val="2"/></w:trPr>${cellXml('a')}</w:tr><w:tr>${cellXml('1')}${cellXml('2')}${cellXml('3')}</w:tr></w:tbl>`;
    const tbl = firstTable(await importDocx(await miniDocx(body), 'x.docx'));
    const row = (r: number) => { const out: string[] = []; tbl.child(r).forEach((c) => out.push(c.textContent + '/' + c.attrs.colspan)); return out; };
    expect(row(0)).toEqual(['/1', 'b/1', 'c/1']);
    expect(row(1)).toEqual(['a/1', '/2']);
  });
  it('a cell that starts with a nested table gets no empty paragraph above it', async () => {
    const inner = `<w:tbl><w:tr>${cellXml('in')}</w:tr></w:tbl>`;
    const body = `<w:tbl><w:tr><w:tc>${inner}<w:p/></w:tc></w:tr></w:tbl>`;
    const tbl = firstTable(await importDocx(await miniDocx(body), 'x.docx'));
    expect(tbl.firstChild!.firstChild!.firstChild!.type.name).toBe('table');
  });
  it('a table or code block inside a list item stays in the item', async () => {
    const cell = S.nodes.table_cell.create(null, [p(['t'])]);
    const table = S.nodes.table.create(null, [S.nodes.table_row.create(null, [cell])]);
    const code = S.nodes.code_block.create(null, S.text('x = 1'));
    const d = doc([ol(1, li(p(['one']), table), li(p(['two']), code), li(p(['three'])))]);
    const { back } = await docxRoundTrip(d);
    expect(back.childCount).toBe(1);
    const list = back.firstChild!;
    expect(list.type.name).toBe('ordered_list');
    expect(list.childCount).toBe(3);
    expect(list.child(0).child(1).type.name).toBe('table');
    expect(list.child(1).child(1).type.name).toBe('code_block');
    // A code block in the last item is kept too (it is indented like the item).
    const d2 = doc([ul(li(p(['a'])), li(p(['b']), code)), p(['after'])]);
    const b2 = (await docxRoundTrip(d2)).back;
    expect(b2.firstChild!.lastChild!.childCount).toBe(2);
    expect(b2.lastChild!.textContent).toBe('after');
  });
});

describe('HTML nesting cap', () => {
  it('imports 5000 levels of nesting quickly and keeps the text', () => {
    for (const unit of ['<ol>\n', '<ol><li>a', '<pre>a', '<div>a', '<blockquote>a', '<table><tr><td>a', '<b>a', '<ul><li><p>a']) {
      const src = unit.repeat(5000) + 'end';
      let blocks: PMNode[] = [];
      const took = ms(() => { blocks = htmlToBlocks(src); });
      expect(took, unit).toBeLessThan(2500);
      const text = blocks.map((b) => b.textContent).join('');
      expect(text.replace(/\s/g, '').length, unit).toBe(unit.includes('a') ? 5003 : 3);
    }
  }, 60_000);
  it('leaves ordinary nesting and long flat lists alone', () => {
    const flat = '<ul>' + '<li>x'.repeat(500) + '</ul>';
    expect(capNestingSource(flat)).toBe(flat);
    const nested = '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul><table><tr><td>1<td>2<tr><td>3</table>';
    expect(capNestingSource(nested)).toBe(nested);
    const list = htmlToBlocks('<ul><li>a<ul><li>b</li></ul></li></ul>')[0];
    expect(list.type.name).toBe('bullet_list');
    expect(list.firstChild!.child(1).type.name).toBe('bullet_list');
  });
});

const enc = (str: string) => new TextEncoder().encode(str).buffer as ArrayBuffer;
const OO = { fileName: 'x.odt', author: 'T' };
const odtBack = async (d: PMNode) => importOdt(await (await exportOdt(d, OO)).arrayBuffer(), 'x.odt');

describe('ODT', () => {
  const withComment = () => {
    const st = defaultSettings();
    st.comments = { c1: { id: 'c1', author: 'Ann', date: Date.UTC(2024, 0, 2, 3, 4, 5), text: 'Top', resolved: true, replies: [{ id: 'r1', author: 'Bob', date: Date.UTC(2024, 0, 3), text: 'A reply' }] } };
    const cm = S.marks.comment.create({ id: 'c1' });
    const ins = S.marks.insertion.create({ author: 'Ann', date: Date.UTC(2024, 4, 5, 6, 7, 8), id: 'i1' });
    return S.node('doc', { settings: st }, [p(['before ', S.text('first', [cm])]), p([S.text('second', [cm]), ' after ', S.text('new', [ins])])]);
  };
  const dates = (xml: string) => [...xml.matchAll(/<dc:date>([^<]*)<\/dc:date>/g)].map((m) => m[1]).filter((d) => !d.startsWith('20' + '26'));
  it('dates keep their zone and survive repeated round trips unchanged', async () => {
    const f1 = docToFodt(withComment(), OO);
    const back = await importFodt(enc(f1), 'x.fodt');
    const f2 = docToFodt(back, OO);
    expect(dates(f1).length).toBeGreaterThanOrEqual(3);
    expect(dates(f1).every((d) => d.endsWith('Z'))).toBe(true);
    expect(dates(f2)).toEqual(dates(f1));
    const c = Object.values(docSettingsOf(back).comments)[0];
    expect(c.date).toBe(Date.UTC(2024, 0, 2, 3, 4, 5));
    let insDate: number | null = null;
    back.descendants((n) => { const m = n.marks.find((x) => x.type.name === 'insertion'); if (m) insDate = new Date(m.attrs.date).getTime(); });
    expect(insDate).toBe(Date.UTC(2024, 4, 5, 6, 7, 8));
  });
  it('a comment over two paragraphs stays one comment, with its reply and resolved state', async () => {
    const f = docToFodt(withComment(), OO);
    expect(f.match(/<office:annotation /g)!.length).toBe(2);
    expect(f).toContain('loext:parent-name=');
    const back = await importFodt(enc(f), 'x.fodt');
    const comments = Object.values(docSettingsOf(back).comments);
    expect(comments.length).toBe(1);
    expect(comments[0].resolved).toBe(true);
    expect(comments[0].replies.map((r) => [r.author, r.text])).toEqual([['Bob', 'A reply']]);
    const marked: string[] = [];
    back.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'comment')) marked.push(n.text!); });
    expect(marked).toEqual(['first', 'second']);
  });
  it('reads a reply written before its parent (as LibreOffice does)', async () => {
    const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"';
    const ann = (name: string, extra: string, t: string) => `<office:annotation office:name="${name}"${extra}><dc:creator>A</dc:creator><dc:date>2024-01-01T00:00:00</dc:date><text:p>${t}</text:p></office:annotation>`;
    const xml = `<?xml version="1.0"?><office:document ${ns} office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text><text:p>${ann('r', ' loext:parent-name="m"', 'reply')}${ann('m', '', 'main')}x<office:annotation-end office:name="m"/><office:annotation-end office:name="r"/></text:p></office:text></office:body></office:document>`;
    const back = await importFodt(enc(xml), 'x.fodt');
    const comments = Object.values(docSettingsOf(back).comments);
    expect(comments.length).toBe(1);
    expect(comments[0].text).toBe('main');
    expect(comments[0].replies.map((r) => r.text)).toEqual(['reply']);
  });
  it('keeps trailing spaces written as <text:s/>', async () => {
    const back = await odtBack(doc([p(['spaces  ']), p(['a\tb '])]));
    expect(back.child(0).textContent).toBe('spaces  ');
  });
  it('a table in a list item gives valid ODF and comes back inside the item', async () => {
    const cell = S.nodes.table_cell.create(null, [p(['t'])]);
    const table = S.nodes.table.create(null, [S.nodes.table_row.create(null, [cell])]);
    const d = doc([ol(1, li(p(['one']), ul(li(p(['deep']), table, p(['after table'])))), li(p(['two'])))]);
    const f = docToFodt(d, OO);
    expect(f).not.toMatch(/<text:list-item[^>]*>(?:(?!<\/text:list-item>).)*<table:table /);
    const back = await importFodt(enc(f), 'x.fodt');
    expect(back.childCount).toBe(1);
    const list = back.firstChild!;
    expect(list.childCount).toBe(2);
    const deepItem = list.firstChild!.child(1).firstChild!;
    expect(deepItem.childCount).toBe(3);
    expect(deepItem.child(1).type.name).toBe('table');
    expect(deepItem.child(2).textContent).toBe('after table');
    expect(list.child(1).textContent).toBe('two');
  });
  it('clamps cell spans', async () => {
    const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';
    const xml = `<?xml version="1.0"?><office:document ${ns} office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text><table:table><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell table:number-columns-spanned="5000000" table:number-rows-spanned="99999"><text:p>a</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>b</text:p></table:table-cell><table:table-cell><text:p>c</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document>`;
    const back = await importFodt(enc(xml), 'x.fodt');
    const tbl = firstTable(back);
    expect(tbl.firstChild!.firstChild!.attrs.colspan).toBeLessThanOrEqual(64);
    expect(tbl.firstChild!.firstChild!.attrs.rowspan).toBeLessThanOrEqual(2);
  });
});

describe('HTML and EPUB whitespace', () => {
  const ws = () => doc([p(['\tTab and  two spaces']), p(), p(['  leading']), p(['end'])]);
  it('HTML keeps tabs, space runs, leading spaces and empty paragraphs', async () => {
    const html = docToHtml(ws(), { fileName: 'x.html', author: 'T' });
    expect(html).toContain('white-space:pre-wrap');
    expect(html).toMatch(/<p[^>]*><br><\/p>/);
    const back = await importHtml(enc(html), 'x.html');
    const texts: string[] = [];
    back.forEach((b) => texts.push(b.textContent));
    expect(texts).toEqual(['\tTab and  two spaces', '', '  leading', 'end']);
    back.child(1).forEach(() => { throw new Error('empty paragraph gained content'); });
  });
  it('EPUB keeps them too', async () => {
    const back = await importEpub(await (await exportEpub(ws(), { fileName: 'x.epub', author: 'T' })).arrayBuffer(), 'x.epub');
    const texts: string[] = [];
    back.forEach((b) => texts.push(b.textContent));
    expect(texts).toEqual(['\tTab and  two spaces', '', '  leading', 'end']);
  });
  it('other HTML still collapses source whitespace', () => {
    const [b] = htmlToBlocks('<p>\n   a   b\n</p>');
    expect(b.textContent).toBe('a b');
    const [pre] = htmlToBlocks('<p style="white-space:pre-wrap">a   b</p>');
    expect(pre.textContent).toBe('a   b');
  });
  it('clamps colspan and rowspan to the table', () => {
    const blocks = htmlToBlocks('<table><tr><td colspan="99999" rowspan="99999">a</td></tr><tr><td>b</td><td>c</td></tr></table>');
    const tbl = blocks.find((b) => b.type.name === 'table')!;
    expect(tbl.firstChild!.firstChild!.attrs.colspan).toBe(2);
    expect(tbl.firstChild!.firstChild!.attrs.rowspan).toBe(2);
    expect(tbl.childCount).toBe(2);
  });
});

describe('XML escaping', () => {
  it('one rule everywhere: invalid characters and lone surrogates go, pairs stay', () => {
    const s = 'a\u0001b\ud800c\udc00d\ud83d\ude00<&>"\'';
    expect(esc(s)).toBe('abcd\ud83d\ude00&lt;&amp;&gt;&quot;&apos;');
    expect(escapeXml(s)).toBe('abcd\ud83d\ude00&lt;&amp;&gt;&quot;&#39;');
  });
});
