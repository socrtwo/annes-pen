import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import { schema } from '../../src/editor/schema';
import { defaultSettings } from '../../src/editor/settings';
import { exportDocx, latexToOmml } from '../../src/io/docx-export';
import { importDocx, ommlToLatex } from '../../src/io/docx-import';

const N = schema.nodes;
const M = schema.marks;

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof (blob as any).arrayBuffer === 'function') return (blob as any).arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

const t = (text: string, marks: Mark[] = []) => schema.text(text, marks);
const p = (content: PMNode[] | string, attrs: Record<string, any> = {}) =>
  N.paragraph.create(attrs, typeof content === 'string' ? (content ? t(content) : null) : content);

function find(doc: PMNode, pred: (n: PMNode) => boolean): PMNode | null {
  let found: PMNode | null = null;
  doc.descendants((n) => {
    if (found) return false;
    if (pred(n)) { found = n; return false; }
    return true;
  });
  return found;
}
function findAll(doc: PMNode, pred: (n: PMNode) => boolean): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((n) => { if (pred(n)) out.push(n); return true; });
  return out;
}
const markOf = (doc: PMNode, text: string, name: string) => {
  const n = find(doc, (x) => x.isText && x.text === text);
  return n ? n.marks.find((m) => m.type.name === name)?.attrs ?? null : null;
};
const textWithMark = (doc: PMNode, name: string) => find(doc, (n) => n.isText && n.marks.some((m) => m.type.name === name));

function richDoc(): PMNode {
  const settings: any = defaultSettings();
  settings.header = { left: 'Quarterly Report', center: '', right: 'Page {PAGE} of {NUMPAGES}' };
  settings.footer = { left: '', center: '{DATE}', right: '' };
  settings.properties.title = 'Round Trip';
  settings.properties.author = 'Ada Lovelace';
  settings.properties.company = 'Analytical Engines';
  settings.comments = {
    c1: { id: 'c1', author: 'Reviewer', date: Date.UTC(2024, 0, 2), text: 'Please check this.', resolved: false, replies: [{ id: 'r1', author: 'Ada', date: Date.UTC(2024, 0, 3), text: 'Done.' }] },
  };
  settings.page = { ...settings.page, sizeName: 'A4', width: 595.28, height: 841.89, orientation: 'portrait', margin: { top: 72, right: 54, bottom: 72, left: 54 } };

  const formatted = p([
    t('Bold', [M.bold.create()]),
    t(' '),
    t('italic', [M.italic.create()]),
    t(' '),
    t('double', [M.underline.create({ style: 'double' })]),
    t(' '),
    t('red', [M.color.create({ color: '#c00000' })]),
    t(' '),
    t('big', [M.size.create({ pt: 14 })]),
    t(' '),
    t('georgia', [M.font.create({ family: 'Georgia' })]),
    t(' '),
    t('marked', [M.highlight.create({ color: '#ffff00' })]),
    t(' '),
    t('gone', [M.strike.create()]),
    t(' E=mc'),
    t('2', [M.sup.create()]),
    t('\tafter tab'),
    N.hard_break.create(),
    t('link', [M.link.create({ href: 'https://example.com/' })]),
    t(' '),
    t('anchor', [M.link.create({ href: '#target' })]),
    N.bookmark.create({ name: 'target' }),
    t(' commented text', [M.comment.create({ id: 'c1' })]),
    t(' added', [M.insertion.create({ author: 'Ada', date: Date.UTC(2024, 1, 1), id: 'i1' })]),
    t(' removed', [M.deletion.create({ author: 'Ada', date: Date.UTC(2024, 1, 1), id: 'd1' })]),
    t(' page '),
    N.field.create({ type: 'PAGE', value: '1' }),
    t(' date '),
    N.field.create({ type: 'DATE', format: 'MMMM d, yyyy', value: 'January 1, 2024' }),
    N.footnote.create({ text: 'A footnote.', kind: 'foot' }),
    N.footnote.create({ text: 'An endnote.', kind: 'end' }),
    t(' '),
    N.math_inline.create({ latex: 'x^{2}' }),
  ]);

  const nestedList = N.bullet_list.create(null, [
    N.list_item.create(null, [p('First bullet')]),
    N.list_item.create(null, [
      p('Second bullet'),
      N.ordered_list.create({ format: 'lower-alpha' }, [
        N.list_item.create(null, [p('Sub a')]),
        N.list_item.create(null, [p('Sub b')]),
      ]),
    ]),
  ]);
  const ordered = N.ordered_list.create({ order: 3 }, [
    N.list_item.create(null, [p('Three')]),
    N.list_item.create(null, [p('Four')]),
  ]);
  const table = N.table.create({ style: 'Table Grid', headerRows: 1 }, [
    N.table_row.create(null, [
      N.table_header.create({ colspan: 2, colwidth: [120, 80] }, [p('Merged header')]),
    ]),
    N.table_row.create(null, [
      N.table_cell.create({ colwidth: [120], background: '#ddeeff' }, [p('A2')]),
      N.table_cell.create({ colwidth: [80], valign: 'middle' }, [p('B2')]),
    ]),
  ]);
  const rowspanTable = N.table.create(null, [
    N.table_row.create(null, [N.table_cell.create({ rowspan: 2 }, [p('Tall')]), N.table_cell.create(null, [p('R1')])]),
    N.table_row.create(null, [N.table_cell.create(null, [p('R2')])]),
  ]);

  return N.doc.create({ settings }, [
    p('Introduction', { style: 'Heading 1' }),
    formatted,
    p('Centered and indented', { align: 'center', indentLeft: 36, indentFirst: -18, spaceBefore: 6, spaceAfter: 12, lineHeight: '1.5', keepNext: true }),
    p('Exact spacing', { lineHeight: '14pt', bg: '#eeeeee', border: JSON.stringify({ top: '1px solid #000000', bottom: '1px solid #000000' }) }),
    nestedList,
    ordered,
    table,
    rowspanTable,
    p([N.image.create({ src: PNG, alt: 'A dot', width: 50, height: 40 })]),
    N.page_break.create(),
    p('After the break'),
    N.math_block.create({ latex: '\\frac{a}{b}' }),
    N.code_block.create(null, t('const x = 1;\nconsole.log(x);')),
    N.horizontal_rule.create(),
    N.task_list.create(null, [
      N.task_item.create({ checked: true }, [p('Done item')]),
      N.task_item.create({ checked: false }, [p('Open item')]),
    ]),
    N.text_box.create({ float: 'right', width: '144' }, [p('Inside the box')]),
    N.gen_block.create({ kind: 'toc', cache: '<p class="toc-l1">Introduction\t1</p><p class="toc-l2">Details\t2</p>' }),
    p([t('Choose: '), N.control.create({ kind: 'dropdown', options: 'Red|Green|Blue', value: 'Green' }), t(' '), N.control.create({ kind: 'checkbox', value: 'true' })]),
    N.section_break.create({ kind: 'nextPage' }),
    N.column_section.create({ count: 2, gap: 24 }, [p('Column text one'), p('Column text two')]),
    p('The end', { style: 'Quote' }),
  ]);
}

async function roundTrip(doc: PMNode): Promise<{ doc: PMNode; zip: JSZip; buf: ArrayBuffer }> {
  const blob = await exportDocx(doc, { fileName: 'test.docx', author: 'Tester' });
  const buf = await blobToArrayBuffer(blob);
  const zip = await JSZip.loadAsync(buf);
  const back = await importDocx(buf, 'test.docx');
  return { doc: back, zip, buf };
}

describe('DOCX export', () => {
  it('produces a package whose XML parts are all well-formed', async () => {
    doc0.check();
    const blob = await exportDocx(doc0, { fileName: 'test.docx', author: 'Tester' });
    expect(blob.type).toContain('wordprocessingml');
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    const names = Object.keys(zip.files);
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/numbering.xml',
      'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'docProps/app.xml']) {
      expect(names, required).toContain(required);
    }
    expect(names[0]).toBe('[Content_Types].xml');
    expect(names.some((n) => /^word\/media\/image\d+\.png$/.test(n))).toBe(true);
    expect(names.some((n) => /^word\/header\d+\.xml$/.test(n))).toBe(true);
    for (const name of names) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      const text = await zip.file(name)!.async('string');
      const parsed = new DOMParser().parseFromString(text, 'application/xml');
      expect(parsed.getElementsByTagName('parsererror').length, `${name} parses`).toBe(0);
    }
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('<w:footnoteReference');
    expect(docXml).toContain('<w:commentRangeStart');
    expect(docXml).toContain('<w:ins ');
    expect(docXml).toContain('<w:delText');
    expect(docXml).toContain('<w:br w:type="page"/>');
    expect(docXml).toContain('w:gridSpan w:val="2"');
    expect(docXml).toContain('<w:vMerge w:val="restart"/>');
    expect(docXml).toContain('TOC \\o &quot;1-3&quot; \\h \\z \\u');
    expect(docXml).toContain('<m:f>');
    expect(docXml).toContain('w14:checkbox');
    expect(docXml).toContain('<w:cols w:space="480" w:num="2"/>');
    const styles = await zip.file('word/styles.xml')!.async('string');
    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('<w:name w:val="heading 1"/>');
    expect(styles).toContain('w:ascii="Calibri"'); // Carlito is written as its metric-compatible Calibri
    expect(styles).toContain('w:styleId="TableGrid"');
    const header = await zip.file(Object.keys(zip.files).find((n) => /^word\/header\d+\.xml$/.test(n))!)!.async('string');
    expect(header).toContain(' PAGE ');
    expect(header).toContain(' NUMPAGES ');
    expect(header).toContain('w:val="right"');
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(core).toContain('<dc:title>Round Trip</dc:title>');
    expect(core).toContain('<dc:creator>Ada Lovelace</dc:creator>');
    const settingsXml = await zip.file('word/settings.xml')!.async('string');
    expect(settingsXml).toContain('<w:trackRevisions/>');
  });

  it('escapes XML and strips invalid characters', async () => {
    const doc = N.doc.create({ settings: defaultSettings() }, [p('a < b & "c" \u0001 ￾ done')]);
    const { zip, doc: back } = await roundTrip(doc);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror').length).toBe(0);
    expect(back.textContent).toBe('a < b & "c"   done');
  });

  it('converts common LaTeX to OMML', () => {
    expect(latexToOmml('\\frac{1}{2}')).toContain('<m:f>');
    expect(latexToOmml('x^2')).toContain('<m:sSup>');
    expect(latexToOmml('a_i^n')).toContain('<m:sSubSup>');
    expect(latexToOmml('\\sqrt{x}')).toContain('<m:rad>');
    expect(latexToOmml('\\sum_{i=1}^{n} i')).toContain('m:val="∑"');
    expect(latexToOmml('\\int_0^1 f')).toContain('m:val="∫"');
    expect(latexToOmml('\\alpha + \\beta')).toContain('α');
    expect(latexToOmml('\\left( x \\right)')).toContain('<m:d>');
  });
});

const doc0 = richDoc();

describe('DOCX round trip', () => {
  it('preserves structure, formatting and settings', async () => {
    const { doc } = await roundTrip(doc0);
    expect(() => doc.check()).not.toThrow();

    // Heading
    const first = doc.firstChild!;
    expect(first.type.name).toBe('paragraph');
    expect(first.attrs.style).toBe('Heading 1');
    expect(first.textContent).toBe('Introduction');

    // Character formatting
    const markAttr = (text: string, name: string) => {
      const n = find(doc, (x) => x.isText && x.text!.includes(text) && x.marks.some((m) => m.type.name === name));
      return n ? n.marks.find((m) => m.type.name === name)!.attrs : null;
    };
    expect(markAttr('Bold', 'bold')).not.toBeNull();
    expect(markAttr('italic', 'italic')).not.toBeNull();
    expect(markAttr('double', 'underline')!.style).toBe('double');
    expect(markAttr('red', 'color')!.color).toBe('#c00000');
    expect(markAttr('big', 'size')!.pt).toBe(14);
    expect(markAttr('georgia', 'font')!.family).toBe('Georgia');
    expect(markAttr('marked', 'highlight')!.color).toBe('#ffff00');
    expect(markAttr('gone', 'strike')).not.toBeNull();
    expect(markAttr('2', 'sup')).not.toBeNull();
    expect(markAttr('link', 'link')!.href).toBe('https://example.com/');
    expect(markAttr('anchor', 'link')!.href).toBe('#target');
    expect(find(doc, (n) => n.type === N.bookmark)!.attrs.name).toBe('target');
    expect(find(doc, (n) => n.isText && n.text!.includes('after tab'))!.text).toContain('\tafter tab');
    expect(find(doc, (n) => n.type === N.hard_break)).not.toBeNull();

    // Comments
    const commented = textWithMark(doc, 'comment')!;
    expect(commented.text).toContain('commented text');
    const cid = commented.marks.find((m) => m.type === M.comment)!.attrs.id;
    const cm = doc.attrs.settings.comments[cid];
    expect(cm.text).toBe('Please check this.');
    expect(cm.author).toBe('Reviewer');
    expect(cm.date).toBe(Date.UTC(2024, 0, 2));
    expect(cm.replies.length).toBe(1);
    expect(cm.replies[0].text).toBe('Done.');

    // Tracked changes
    const ins = textWithMark(doc, 'insertion')!;
    expect(ins.text).toContain('added');
    expect(ins.marks.find((m) => m.type === M.insertion)!.attrs.author).toBe('Ada');
    expect(ins.marks.find((m) => m.type === M.insertion)!.attrs.date).toBe(Date.UTC(2024, 1, 1));
    expect(textWithMark(doc, 'deletion')!.text).toContain('removed');

    // Fields, notes, math
    const page = find(doc, (n) => n.type === N.field && n.attrs.type === 'PAGE')!;
    expect(page).not.toBeNull();
    const date = find(doc, (n) => n.type === N.field && n.attrs.type === 'DATE')!;
    expect(date.attrs.format).toBe('MMMM d, yyyy');
    expect(date.attrs.value).toBe('January 1, 2024');
    const notes = findAll(doc, (n) => n.type === N.footnote);
    expect(notes.map((n) => [n.attrs.kind, n.attrs.text])).toEqual([['foot', 'A footnote.'], ['end', 'An endnote.']]);
    expect(find(doc, (n) => n.type === N.math_inline)!.attrs.latex.replace(/\s/g, '')).toBe('x^{2}');
    expect(find(doc, (n) => n.type === N.math_block)!.attrs.latex.replace(/\s/g, '')).toBe('\\frac{a}{b}');

    // Paragraph attributes
    const centered = find(doc, (n) => n.type === N.paragraph && n.textContent === 'Centered and indented')!;
    expect(centered.attrs).toMatchObject({ align: 'center', indentLeft: 36, indentFirst: -18, spaceBefore: 6, spaceAfter: 12, lineHeight: '1.5', keepNext: true });
    const exact = find(doc, (n) => n.type === N.paragraph && n.textContent === 'Exact spacing')!;
    expect(exact.attrs.lineHeight).toBe('14pt');
    expect(exact.attrs.bg).toBe('#eeeeee');
    expect(Object.keys(JSON.parse(exact.attrs.border)).sort()).toEqual(['bottom', 'top']);

    // Lists
    const bullet = find(doc, (n) => n.type === N.bullet_list)!;
    expect(bullet.childCount).toBe(2);
    const nested = bullet.child(1).child(1);
    expect(nested.type.name).toBe('ordered_list');
    expect(nested.attrs.format).toBe('lower-alpha');
    expect(nested.childCount).toBe(2);
    expect(nested.textContent).toBe('Sub aSub b');
    const ord = find(doc, (n) => n.type === N.ordered_list && n.textContent === 'ThreeFour')!;
    expect(ord.attrs.order).toBe(3);
    expect(ord.attrs.format).toBe('decimal');
    const tasks = find(doc, (n) => n.type === N.task_list)!;
    expect(tasks).not.toBeNull();
    expect(tasks.childCount).toBe(2);
    expect(tasks.child(0).attrs.checked).toBe(true);
    expect(tasks.child(1).attrs.checked).toBe(false);
    expect(tasks.child(0).textContent).toBe('Done item');

    // Tables
    const tables = findAll(doc, (n) => n.type === N.table);
    expect(tables.length).toBe(2);
    const head = tables[0].child(0).child(0);
    expect(head.type.name).toBe('table_header');
    expect(head.attrs.colspan).toBe(2);
    expect(head.attrs.colwidth).toEqual([120, 80]);
    expect(tables[0].attrs.headerRows).toBe(1);
    expect(tables[0].attrs.style).toBe('Table Grid');
    expect(tables[0].child(1).child(0).attrs.background).toBe('#ddeeff');
    expect(tables[0].child(1).child(1).attrs.valign).toBe('middle');
    expect(tables[1].child(0).child(0).attrs.rowspan).toBe(2);
    expect(tables[1].child(1).childCount).toBe(1);
    expect(tables[1].child(1).textContent).toBe('R2');

    // Image
    const img = find(doc, (n) => n.type === N.image)!;
    expect(img.attrs.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(img.attrs.width).toBe(50);
    expect(img.attrs.height).toBe(40);
    expect(img.attrs.alt).toBe('A dot');

    // Blocks
    expect(find(doc, (n) => n.type === N.page_break)).not.toBeNull();
    expect(find(doc, (n) => n.type === N.code_block)!.textContent).toBe('const x = 1;\nconsole.log(x);');
    expect(find(doc, (n) => n.type === N.horizontal_rule)).not.toBeNull();
    const box = find(doc, (n) => n.type === N.text_box)!;
    expect(box.attrs.float).toBe('right');
    expect(box.attrs.width).toBe('144');
    expect(box.textContent).toBe('Inside the box');
    const toc = find(doc, (n) => n.type === N.gen_block)!;
    expect(toc.attrs.kind).toBe('toc');
    expect(toc.attrs.cache).toContain('Introduction');
    const dd = find(doc, (n) => n.type === N.control && n.attrs.kind === 'dropdown')!;
    expect(dd.attrs.options).toBe('Red|Green|Blue');
    expect(dd.attrs.value).toBe('Green');
    expect(find(doc, (n) => n.type === N.control && n.attrs.kind === 'checkbox')!.attrs.value).toBe('true');
    expect(find(doc, (n) => n.type === N.section_break)!.attrs.kind).toBe('nextPage');
    const cols = find(doc, (n) => n.type === N.column_section)!;
    expect(cols.attrs.count).toBe(2);
    expect(cols.attrs.gap).toBe(24);
    expect(cols.textContent).toBe('Column text oneColumn text two');
    expect(doc.lastChild!.attrs.style).toBe('Quote');
    expect(findAll(doc, (n) => n.type === N.section_break).length).toBe(1);

    // Settings
    const s = doc.attrs.settings;
    expect(s.header.left).toBe('Quarterly Report');
    expect(s.header.right).toBe('Page {PAGE} of {NUMPAGES}');
    expect(s.footer.center).toMatch(/^\{DATE(:.*)?\}$/);
    expect(s.properties.title).toBe('Round Trip');
    expect(s.properties.author).toBe('Ada Lovelace');
    expect(s.properties.company).toBe('Analytical Engines');
    expect(s.page.sizeName).toBe('A4');
    expect(s.page.margin).toEqual({ top: 72, right: 54, bottom: 72, left: 54 });
    // Built-in styles that match Anne's Pen's own definitions are not re-imported as overrides.
    expect(s.styles['Heading 1']).toBeUndefined();
    expect(s.styles.Normal).toBeUndefined();
  });

  it('round-trips comments across paragraphs, adjacent tables, wrapped images and more', async () => {
    const settings: any = defaultSettings();
    settings.comments = { k: { id: 'k', author: 'Kim', date: 0, text: 'Spans two paragraphs', resolved: true, replies: [] } };
    settings.styles = { 'My Para': { name: 'My Para', type: 'paragraph', basedOn: 'Normal', italic: true, color: '#336699', spaceAfter: 3 } };
    const cm = [M.comment.create({ id: 'k' })];
    const cell = (x: string) => N.table_cell.create(null, [p(x)]);
    const doc = N.doc.create({ settings }, [
      p([t('start '), t('first half', cm)]),
      p([t('second half', cm), t(' tail')]),
      N.table.create(null, [N.table_row.create(null, [cell('T1')])]),
      N.table.create(null, [N.table_row.create(null, [cell('T2')])]),
      p([N.image.create({ src: PNG, width: 30, height: 30, wrap: 'left', rotate: 90 }), t('wrapped')]),
      p([t('odd', [M.highlight.create({ color: '#123456' })]), t(' secret', [M.hidden.create()]), t(' code', [M.code.create()])]),
      p('custom styled', { style: 'My Para' }),
    ]);
    const { doc: back } = await roundTrip(doc);
    back.check();
    const commented = findAll(back, (n) => n.isText && n.marks.some((m) => m.type === M.comment));
    expect(commented.map((n) => n.text)).toEqual(['first half', 'second half']);
    const id = commented[0].marks.find((m) => m.type === M.comment)!.attrs.id;
    expect(back.attrs.settings.comments[id]).toMatchObject({ author: 'Kim', text: 'Spans two paragraphs', resolved: true });
    expect(back.child(2).type.name).toBe('table');
    expect(back.child(3).type.name).toBe('table');
    const img = find(back, (n) => n.type === N.image)!;
    expect(img.attrs).toMatchObject({ wrap: 'left', rotate: 90, width: 30, height: 30 });
    expect(markOf(back, 'odd', 'shading')!.color).toBe('#123456');
    expect(markOf(back, ' secret', 'hidden')).not.toBeNull();
    expect(markOf(back, ' code', 'code')).not.toBeNull();
    expect(find(back, (n) => n.isText && n.text === ' code')!.marks.some((m) => m.type === M.font)).toBe(false);
    expect(back.lastChild!.attrs.style).toBe('My Para');
    expect(back.attrs.settings.styles['My Para']).toMatchObject({ type: 'paragraph', basedOn: 'Normal', italic: true, color: '#336699', spaceAfter: 3 });
  });

  it('round-trips an empty document', async () => {
    const { doc } = await roundTrip(N.doc.create({ settings: defaultSettings() }, [p('')]));
    doc.check();
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild!.type.name).toBe('paragraph');
    expect(doc.firstChild!.childCount).toBe(0);
  });

  it('keeps landscape orientation, page numbering and line numbers', async () => {
    const settings: any = defaultSettings();
    settings.page.orientation = 'landscape';
    settings.pageNumber = { format: 'lower-roman', start: 5 };
    settings.lineNumbers = { enabled: true, countBy: 5, restart: 'page' };
    settings.differentFirst = true;
    settings.firstHeader = { left: '', center: 'First page', right: '' };
    settings.header = { left: '{TITLE}', center: '', right: '{PAGE}' };
    const { doc } = await roundTrip(N.doc.create({ settings }, [p('Wide')]));
    const s = doc.attrs.settings;
    expect(s.page.orientation).toBe('landscape');
    expect(s.page.sizeName).toBe('Letter');
    expect(s.pageNumber).toEqual({ format: 'lower-roman', start: 5 });
    expect(s.lineNumbers).toEqual({ enabled: true, countBy: 5, restart: 'page' });
    expect(s.differentFirst).toBe(true);
    expect(s.firstHeader.center).toBe('First page');
    expect(s.header.left).toBe('{TITLE}');
    expect(s.header.right).toBe('{PAGE}');
  });
});

// ------------------------------------------------------------------------------------------
// Hand-built documents

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT_W = 'http://purl.oclc.org/ooxml/wordprocessingml/main';

async function makeDocx(parts: Record<string, string>, opts: { strict?: boolean } = {}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const overrides = Object.keys(parts).filter((p) => p.startsWith('word/') && p.endsWith('.xml')).map((p) => {
    const kind = p.slice(5, -4).replace(/\d+$/, '');
    const ct = kind === 'document' ? 'document.main' : kind;
    return `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${ct}+xml"/>`;
  }).join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides}</Types>`);
  const relNs = opts.strict ? 'http://purl.oclc.org/ooxml/officeDocument/relationships' : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relNs}/officeDocument" Target="word/document.xml"/></Relationships>`);
  const docRels: string[] = [];
  let n = 1;
  for (const part of Object.keys(parts)) {
    const m = /^word\/(styles|numbering|footnotes|comments|header\d*|footer\d*)\.xml$/.exec(part);
    if (m) docRels.push(`<Relationship Id="rIdP${n++}" Type="${relNs}/${m[1].replace(/\d+$/, '')}" Target="${part.slice(5)}"/>`);
  }
  if (parts['__rels']) docRels.push(parts['__rels']);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRels.join('')}</Relationships>`);
  for (const [path, content] of Object.entries(parts)) if (path !== '__rels') zip.file(path, content);
  return zip.generateAsync({ type: 'arraybuffer' });
}

const docXml = (body: string, ns = W) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`;

describe('DOCX import of hand-built documents', () => {
  it('imports an empty body as a single empty paragraph', async () => {
    const doc = await importDocx(await makeDocx({ 'word/document.xml': docXml('') }), 'empty.docx');
    doc.check();
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild!.type.name).toBe('paragraph');
  });

  it('handles styles, numbering, fields, tables, controls, math and sections', async () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="${W}">
      <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:color w:val="FF0000"/><w:sz w:val="40"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="MyFancy"><w:name w:val="My Fancy Style"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"/></w:rPr></w:style>
      <w:style w:type="character" w:styleId="Emph"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>
      <w:style w:type="table" w:styleId="GridTable4-Accent1"><w:name w:val="Grid Table 4 Accent 1"/></w:style>
    </w:styles>`;
    const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="${W}">
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride></w:num>
    </w:numbering>`;
    const footnotes = `<?xml version="1.0"?><w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note one.</w:t></w:r></w:p><w:p><w:r><w:t>Second line.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const comments = `<?xml version="1.0"?><w:comments xmlns:w="${W}"><w:comment w:id="7" w:author="Bob" w:date="2023-05-06T07:08:09Z"><w:p><w:r><w:t>Nice</w:t></w:r></w:p></w:comment></w:comments>`;
    const header = `<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Left</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Center</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:hdr>`;
    const body = `
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title here</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="MyFancy"/><w:ind w:left="720" w:hanging="360"/><w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="auto"/></w:pPr>
        <w:r><w:rPr><w:rStyle w:val="Emph"/></w:rPr><w:t>styled</w:t></w:r>
        <w:proofErr w:type="spellStart"/>
        <w:r><w:rPr><w:highlight w:val="cyan"/><w:u w:val="wave"/><w:vertAlign w:val="subscript"/><w:smallCaps/><w:spacing w:val="40"/><w:position w:val="6"/><w:w w:val="150"/></w:rPr><w:t xml:space="preserve"> fancy</w:t></w:r>
        <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE \\@ "yyyy-MM-dd" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2024-03-04</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
        <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://quill.example/" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>field link</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
        <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> MACROBUTTON NoMacro </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>kept text</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
        <w:hyperlink w:anchor="bm1"><w:r><w:t>jump</w:t></w:r></w:hyperlink>
        <w:bookmarkStart w:id="0" w:name="bm1"/><w:bookmarkEnd w:id="0"/>
        <w:bookmarkStart w:id="1" w:name="_GoBack"/><w:bookmarkEnd w:id="1"/>
        <w:commentRangeStart w:id="7"/><w:r><w:t>with comment</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>
        <w:r><w:footnoteReference w:id="1"/></w:r>
        <w:r><w:sym w:font="Wingdings" w:char="F04A"/><w:noBreakHyphen/><w:softHyphen/></w:r>
        <w:r><w:br/><w:t>after br</w:t></w:r>
      </w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Bullet 1</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Bullet 1.1</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Bullet 2</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Roman four</w:t></w:r></w:p>
      <w:tbl><w:tblPr><w:tblStyle w:val="GridTable4-Accent1"/><w:tblW w:w="5000" w:type="pct"/><w:jc w:val="center"/></w:tblPr><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:vMerge w:val="restart"/><w:shd w:val="clear" w:fill="FFFF00"/><w:vAlign w:val="bottom"/></w:tcPr><w:p><w:r><w:t>Span</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr>
      </w:tbl>
      <w:p>
        <w:sdt><w:sdtPr><w:tag w:val="agree"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☒</w:t></w:r></w:sdtContent></w:sdt>
        <w:sdt><w:sdtPr><w:dropDownList><w:listItem w:displayText="One" w:value="1"/><w:listItem w:displayText="Two" w:value="2"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>Two</w:t></w:r></w:sdtContent></w:sdt>
        <w:sdt><w:sdtPr><w:date><w:dateFormat w:val="M/d/yyyy"/></w:date></w:sdtPr><w:sdtContent><w:r><w:t>1/2/2025</w:t></w:r></w:sdtContent></w:sdt>
        <w:sdt><w:sdtPr><w:text/></w:sdtPr><w:sdtContent><w:r><w:t xml:space="preserve"> plain sdt</w:t></w:r></w:sdtContent></w:sdt>
        <mc:AlternateContent><mc:Choice Requires="w14"><w:r><w:t xml:space="preserve"> choice</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>fallback</w:t></w:r></mc:Fallback></mc:AlternateContent>
        <w:smartTag><w:r><w:t xml:space="preserve"> smart</w:t></w:r></w:smartTag>
        <w:ins w:id="5" w:author="Eve" w:date="2022-01-01T00:00:00Z"><w:r><w:t xml:space="preserve"> inserted</w:t></w:r></w:ins>
        <w:del w:id="6" w:author="Eve"><w:r><w:delText xml:space="preserve"> deleted</w:delText></w:r></w:del>
        <m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f><m:r><m:t>+</m:t></m:r><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>
      </w:p>
      <w:p><w:r><w:t>Before page break</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>after page break</w:t></w:r></w:p>
      <w:p><m:oMathPara><m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>α</m:t></m:r></m:e></m:rad></m:oMath></m:oMathPara></w:p>
      <w:p><w:pPr><w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>End of section one</w:t></w:r></w:p>
      <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Title here</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second entry</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
      <w:p><w:r><w:t>Last</w:t></w:r></w:p>
      <w:sectPr><w:headerReference w:type="default" r:id="rIdP5"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:titlePg/></w:sectPr>`;
    const buf = await makeDocx({
      'word/document.xml': docXml(body),
      'word/styles.xml': styles,
      'word/numbering.xml': numbering,
      'word/footnotes.xml': footnotes,
      'word/comments.xml': comments,
      'word/header1.xml': header,
    });
    const doc = await importDocx(buf, 'hand.docx');
    expect(() => doc.check()).not.toThrow();
    const s = doc.attrs.settings;

    // Styles
    expect(doc.firstChild!.attrs.style).toBe('Heading 1');
    expect(s.styles['Heading 1'].color).toBe('#ff0000');
    expect(s.styles['Heading 1'].size).toBe(20);
    expect(s.styles['My Fancy Style']).toMatchObject({ type: 'paragraph', basedOn: 'Normal', align: 'center', bold: true, font: 'Verdana', quick: true });
    const fancy = doc.child(1);
    expect(fancy.attrs).toMatchObject({ style: 'My Fancy Style', indentLeft: 36, indentFirst: -18, spaceBefore: 6, spaceAfter: 12, lineHeight: '1.5' });
    const styled = find(doc, (n) => n.isText && n.text === 'styled')!;
    expect(styled.marks.find((m) => m.type === M.charStyle)!.attrs.name).toBe('Emphasis');
    const fancyRun = find(doc, (n) => n.isText && n.text === ' fancy')!;
    const names = fancyRun.marks.map((m) => m.type.name).sort();
    expect(names).toEqual(['highlight', 'position', 'scale', 'smallcaps', 'spacing', 'sub', 'underline']);
    expect(fancyRun.marks.find((m) => m.type === M.highlight)!.attrs.color).toBe('#00ffff');
    expect(fancyRun.marks.find((m) => m.type === M.underline)!.attrs.style).toBe('wavy');
    expect(fancyRun.marks.find((m) => m.type === M.spacing)!.attrs.pt).toBe(2);
    expect(fancyRun.marks.find((m) => m.type === M.position)!.attrs.pt).toBe(3);
    expect(fancyRun.marks.find((m) => m.type === M.scale)!.attrs.pct).toBe(150);

    // Fields
    const date = find(doc, (n) => n.type === N.field)!;
    expect(date.attrs).toMatchObject({ type: 'DATE', format: 'yyyy-MM-dd', value: '2024-03-04' });
    expect(find(doc, (n) => n.isText && n.text === 'field link')!.marks.find((m) => m.type === M.link)!.attrs.href).toBe('https://quill.example/');
    expect(find(doc, (n) => n.isText && !!n.text && n.text.includes('kept text'))).not.toBeNull();
    expect(find(doc, (n) => n.isText && n.text === 'jump')!.marks[0].attrs.href).toBe('#bm1');
    expect(findAll(doc, (n) => n.type === N.bookmark).map((b) => b.attrs.name)).toEqual(['bm1']);

    // Comments, notes, symbols, breaks
    const withComment = find(doc, (n) => n.isText && n.text === 'with comment')!;
    expect(withComment.marks.find((m) => m.type === M.comment)!.attrs.id).toBe('7');
    expect(s.comments['7']).toMatchObject({ author: 'Bob', text: 'Nice', date: Date.parse('2023-05-06T07:08:09Z'), resolved: false });
    expect(find(doc, (n) => n.type === N.footnote)!.attrs).toMatchObject({ text: 'Note one.\nSecond line.', kind: 'foot', id: '1' });
    expect(fancy.textContent).toContain('J‑­');
    expect(find(doc, (n) => n.isText && n.text === 'J')!.marks.find((m) => m.type === M.font)!.attrs.family).toBe('Wingdings');
    expect(find(doc, (n) => n.type === N.hard_break)).not.toBeNull();

    // Lists
    const bl = doc.child(2);
    expect(bl.type.name).toBe('bullet_list');
    expect(bl.attrs.bullet).toBe('disc');
    expect(bl.childCount).toBe(2);
    expect(bl.child(0).child(1).type.name).toBe('bullet_list');
    expect(bl.child(0).child(1).attrs.bullet).toBe('circle');
    const ol = doc.child(3);
    expect(ol.type.name).toBe('ordered_list');
    expect(ol.attrs).toMatchObject({ order: 4, format: 'upper-roman', suffix: ')' });

    // Table
    const table = doc.child(4);
    expect(table.type.name).toBe('table');
    expect(table.attrs.style).toBe('Grid Table Accent');
    expect(table.attrs.width).toBe('100%');
    expect(table.attrs.align).toBe('center');
    expect(table.attrs.headerRows).toBe(1);
    const span = table.child(0).child(0);
    expect(span.type.name).toBe('table_header');
    expect(span.attrs).toMatchObject({ rowspan: 2, colwidth: [100], background: '#ffff00', valign: 'bottom' });
    expect(table.child(1).childCount).toBe(1);
    const cellWithTable = table.child(1).child(0);
    // table_cell content is block+: a cell that starts with a nested table keeps it first.
    expect(cellWithTable.firstChild!.type.name).toBe('table');
    expect(find(cellWithTable, (n) => n.type === N.table)!.textContent).toBe('nested');

    // Controls, alternate content, revisions, math
    const ctrl = doc.child(5);
    const controls = findAll(ctrl, (n) => n.type === N.control);
    expect(controls.map((c) => c.attrs.kind)).toEqual(['checkbox', 'dropdown', 'date']);
    expect(controls[0].attrs).toMatchObject({ value: 'true', tag: 'agree' });
    expect(controls[1].attrs).toMatchObject({ options: 'One|Two', value: 'Two' });
    expect(controls[2].attrs.value).toBe('1/2/2025');
    expect(ctrl.textContent).toContain(' plain sdt choice smart inserted deleted');
    expect(ctrl.textContent).not.toContain('fallback');
    expect(find(ctrl, (n) => n.isText && n.text === ' inserted')!.marks[0].attrs.author).toBe('Eve');
    expect(find(ctrl, (n) => n.isText && n.text === ' deleted')!.marks[0].type.name).toBe('deletion');
    expect(find(ctrl, (n) => n.type === N.math_inline)!.attrs.latex.replace(/\s/g, '')).toBe('\\frac{1}{2}+x^{2}');

    // Page break splits the paragraph
    expect(doc.child(6).textContent).toBe('Before page break');
    expect(doc.child(7).type.name).toBe('page_break');
    expect(doc.child(8).textContent).toBe('after page break');
    expect(doc.child(9).type.name).toBe('math_block');
    expect(doc.child(9).attrs.latex).toBe('\\sqrt{\\alpha}');
    expect(doc.child(10).textContent).toBe('End of section one');
    // Section break and TOC
    expect(doc.child(11).type.name).toBe('section_break');
    expect(doc.child(11).attrs.kind).toBe('nextPage');
    expect(doc.child(11).attrs.page).toMatchObject({ orientation: 'portrait' });
    expect(doc.child(12).type.name).toBe('gen_block');
    expect(doc.child(12).attrs.kind).toBe('toc');
    expect(doc.child(12).attrs.options).toEqual({ levels: 2 });
    expect(doc.child(12).attrs.cache).toBe('<p>Title here\t1</p><p>Second entry</p>');
    expect(doc.child(13).textContent).toBe('Last');
    expect(doc.childCount).toBe(14);

    // Section / header settings
    expect(s.page).toMatchObject({ sizeName: 'A4', orientation: 'landscape', margin: { top: 72, right: 54, bottom: 72, left: 54 }, headerDist: 35.4 });
    expect(s.differentFirst).toBe(true);
    expect(s.header).toEqual({ left: 'Left', center: 'Center', right: 'Page {PAGE}' });
  });

  it('supports the Strict OOXML namespace', async () => {
    const body = `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Strict bold</w:t></w:r></w:p>
      <w:sectPr><w:pgSz w:w="8.5in" w:h="11in"/><w:pgMar w:top="1in" w:right="1in" w:bottom="1in" w:left="1in" w:header="0.5in" w:footer="0.5in" w:gutter="0"/></w:sectPr>`;
    const doc = await importDocx(await makeDocx({ 'word/document.xml': docXml(body, STRICT_W) }, { strict: true }), 'strict.docx');
    doc.check();
    const para = doc.firstChild!;
    expect(para.attrs.align).toBe('justify');
    expect(para.textContent).toBe('Strict bold');
    expect(para.firstChild!.marks.map((m) => m.type.name).sort()).toEqual(['bold', 'size']);
    expect(doc.attrs.settings.page).toMatchObject({ sizeName: 'Letter', margin: { top: 72, right: 72, bottom: 72, left: 72 }, headerDist: 36 });
  });

  it('imports images and drop caps', async () => {
    const png = PNG.split(',')[1];
    const body = `<w:p><w:pPr><w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/></w:pPr><w:r><w:t>O</w:t></w:r></w:p>
      <w:p><w:r><w:t>nce upon a time</w:t></w:r></w:p>
      <w:p><w:r><w:drawing><wp:anchor behindDoc="0"><wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH><wp:extent cx="1270000" cy="635000"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Pic" descr="Logo"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
    const zipParts = {
      'word/document.xml': docXml(body),
      '__rels': '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>',
    };
    const zip = await JSZip.loadAsync(await makeDocx(zipParts));
    zip.file('word/media/logo.png', png, { base64: true });
    const doc = await importDocx(await zip.generateAsync({ type: 'arraybuffer' }), 'img.docx');
    doc.check();
    expect(doc.child(0).attrs.dropCap).toBe(3);
    expect(doc.child(0).textContent).toBe('Once upon a time');
    const img = find(doc, (n) => n.type === N.image)!;
    expect(img.attrs).toMatchObject({ width: 100, height: 50, wrap: 'right', alt: 'Logo' });
    expect(img.attrs.src).toBe(PNG);
  });

  it('converts OMML to LaTeX', () => {
    const xml = (inner: string) => new DOMParser().parseFromString(`<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${inner}</m:oMath>`, 'application/xml').documentElement;
    expect(ommlToLatex(xml('<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup><m:e><m:r><m:t>i</m:t></m:r></m:e></m:nary>'))).toBe('\\sum_{i=1}^{n} i');
    expect(ommlToLatex(xml('<m:d><m:e><m:r><m:t>a</m:t></m:r></m:e></m:d>'))).toBe('\\left(a\\right)');
    expect(ommlToLatex(xml('<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r></m:fName><m:e><m:r><m:t>θ</m:t></m:r></m:e></m:func>'))).toBe('\\sin \\theta');
    expect(ommlToLatex(xml('<m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>n</m:t></m:r></m:sub></m:sSub>'))).toBe('x_{n}');
  });

  it('rejects files that are not Word documents', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await expect(importDocx(await zip.generateAsync({ type: 'arraybuffer' }), 'x.docx')).rejects.toThrow();
  });
});
