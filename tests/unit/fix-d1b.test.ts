import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import { schema, safeHref, safeImageSrc } from '../../src/editor/schema';
import { buildPlugins, type SetupHooks } from '../../src/editor/setup';
import { DEFAULT_AUTOFORMAT, DEFAULT_REPLACEMENTS } from '../../src/editor/autoformat';
import { buildMatcher, findMatches, findKey, completeKey, footnoteKey, coachKey, decoPlugins } from '../../src/editor/plugins/decorations';
import { pageKey, paginationPlugin, repaginate, type PageConfig } from '../../src/editor/plugins/pagination';
import { buildNodeViews } from '../../src/editor/nodeviews';
import { displayPage, expandTokens, computeFields } from '../../src/editor/fields';
import { defaultSettings } from '../../src/editor/settings';
import { designLabel } from '../../src/editor/styles';
import { importNative, exportNative } from '../../src/io/native';
import { formatAuthors, formatBibEntry, formatInText, parseBibtex, toBibtex, generateBlock } from '../../src/commands/references';
import { getCommand } from '../../src/commands/registry';
import '../../src/commands/layout';
import { replaceAll } from '../../src/commands/edit';
import { Proofer } from '../../src/proof/proofing';
import { App, type DocTab } from '../../src/app';

// Dialogs are answered by the test (and may change the document while "open").
let dialogAnswer: (() => Record<string, any> | null) | null = null;
vi.mock('../../src/ui/dialog', async (orig) => {
  const real: any = await orig();
  return { ...real, toast: vi.fn(), openDialog: vi.fn(async () => (dialogAnswer ? dialogAnswer() : null)) };
});

const S = schema;
const P = (...c: (string | PMNode)[]) => S.nodes.paragraph.create(null, c.filter((x) => x !== '').map((x) => (typeof x === 'string' ? S.text(x) : x)));
const doc = (...blocks: PMNode[]) => S.node('doc', null, blocks);
const hooks: SetupHooks = {
  autoformat: () => DEFAULT_AUTOFORMAT,
  replacements: () => DEFAULT_REPLACEMENTS,
  pageConfig: () => ({ enabled: false, widthPt: 612, heightPt: 792, margin: { top: 72, right: 72, bottom: 72, left: 72 }, gapPx: 24, header: () => '', footer: () => '' }) as any,
  commandKey: () => false,
  author: () => 'A',
  wordCompletion: () => true,
  slashMenu: () => {},
  slashEnabled: () => false,
};
const plugins = buildPlugins(hooks);
function realView(d: PMNode, pos: number, ps = plugins, nodeViews?: any) {
  let state = EditorState.create({ doc: d, plugins: ps });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state, nodeViews });
}
const key = (view: EditorView, k: string) => view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const html = (d: PMNode) => { const box = document.createElement('div'); box.appendChild(DOMSerializer.fromSchema(S).serializeFragment(d.content)); return box.innerHTML; };

function makeApp(): App {
  const app = new App(document.createElement('div'));
  const noop = () => {};
  app.ui = new Proxy({
    mountTab(tab: DocTab) {
      tab.el = document.createElement('div');
      tab.page = document.createElement('div');
      tab.mount = document.createElement('div');
      tab.page.appendChild(tab.mount);
      tab.el.appendChild(tab.page);
      document.body.appendChild(tab.el);
    },
  } as any, { get: (t, k) => (k in t ? t[k] : noop) });
  app.prefs.spellcheck = false;
  app.prefs.grammar = false;
  return app;
}

afterEach(() => { dialogAnswer = null; });

// ------------------------------------------------------------------------------------------
describe('1. hostile .qpd attributes cannot inject CSS or script URLs', () => {
  const evil = 'red;position:fixed;inset:0;z-index:99999;background:url(https://evil/beacon)';
  const hostile = {
    type: 'doc', content: [
      { type: 'paragraph', attrs: { bg: evil, border: JSON.stringify({ top: evil }), indentLeft: '1;position:fixed', lineHeight: '2;position:fixed', align: 'left;position:fixed' }, content: [
        { type: 'text', text: 'a', marks: [{ type: 'color', attrs: { color: evil } }, { type: 'highlight', attrs: { color: evil } }, { type: 'charBorder', attrs: { border: evil } }, { type: 'size', attrs: { pt: '1;position:fixed' } }] },
        { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'typo', attrs: { features: '"liga";position:fixed', numerals: 'x;y' } }, { type: 'effect', attrs: { kind: 'x" onclick="y', color: evil } }] },
        { type: 'text', text: 'c', marks: [{ type: 'link', attrs: { href: 'file:///etc/passwd' } }, { type: 'shading', attrs: { color: 'url(x)' } }, { type: 'underline', attrs: { color: evil } }] },
        { type: 'image', attrs: { src: 'javascript:alert(1)', border: evil, filter: 'url(#x)', width: '1;position:fixed', opacity: 'x' } },
      ] },
      { type: 'horizontal_rule', attrs: { style: 'solid;position:fixed', color: evil, weight: '1;x' } },
      { type: 'text_box', attrs: { border: evil, bg: evil, width: '10px;position:fixed', padding: '1;x' }, content: [{ type: 'paragraph' }] },
      { type: 'bullet_list', attrs: { bullet: '";position:fixed;"' }, content: [{ type: 'list_item', content: [{ type: 'paragraph' }] }] },
      { type: 'ordered_list', attrs: { format: 'decimal;position:fixed' }, content: [{ type: 'list_item', content: [{ type: 'paragraph' }] }] },
      { type: 'column_section', attrs: { count: '2;position:fixed', gap: 'x' }, content: [{ type: 'paragraph' }] },
      { type: 'table', attrs: { width: '100%;position:fixed', indent: '1;x' }, content: [{ type: 'table_row', content: [{ type: 'table_cell', attrs: { background: evil, valign: 'top;position:fixed', borders: JSON.stringify({ left: evil }) }, content: [{ type: 'paragraph' }] }] }] },
    ],
  };

  it('renders no declaration, url() or script URL from attribute values', async () => {
    const d = await importNative(new TextEncoder().encode(JSON.stringify({ qf: 1, doc: hostile })).buffer as ArrayBuffer);
    const box = document.createElement('div');
    box.innerHTML = html(d);
    // No style attribute gained a declaration it should not have, or a url().
    for (const el of box.querySelectorAll<HTMLElement>('[style]')) {
      expect(el.style.position, el.outerHTML).toBe('');
      expect(el.style.zIndex).toBe('');
      expect(el.style.backgroundImage).toBe('');
      expect(el.getAttribute('style')).not.toMatch(/url\(|beacon|inset/);
    }
    for (const a of box.querySelectorAll('a')) expect(a.getAttribute('href')).toBe('#');
    expect(box.querySelector('img')!.getAttribute('src')).toBe('');
    expect(box.querySelector('[onclick]')).toBeNull();
  });

  it('keeps ordinary values', () => {
    const d = doc(S.nodes.paragraph.create({ bg: '#ffeeaa', indentLeft: 18, lineHeight: '1.15', border: JSON.stringify({ bottom: '1px solid #000' }) }, [
      S.text('x', [S.marks.color.create({ color: 'rgb(255, 0, 0)' }), S.marks.highlight.create({ color: 'yellow' }), S.marks.size.create({ pt: 14 }), S.marks.link.create({ href: 'https://example.com/a?b=1#c' })]),
      S.nodes.image.create({ src: 'data:image/png;base64,AAAA', border: '1px solid #444', filter: 'brightness(110%) contrast(90%)', width: 100 }),
    ]));
    const out = html(d); // jsdom normalizes style attributes ("a: b" and rgb())
    for (const s of ['background-color: rgb(255, 238, 170)', 'margin-left: 18pt', 'line-height: 1.15', 'border-bottom: 1px solid', 'color: rgb(255, 0, 0)', 'background-color: yellow', 'font-size: 14pt', 'href="https://example.com/a?b=1#c"', 'src="data:image/png;base64,AAAA"', 'border: 1px solid rgb(68, 68, 68)', 'filter: brightness(110%) contrast(90%)', 'width: 100pt'])
      expect(out).toContain(s);
  });

  it('allows only safe link and image schemes', () => {
    for (const ok of ['https://a.b', 'http://a', 'mailto:x@y', 'tel:123', '#anchor', 'relative/page.html', '../x'] ) expect(safeHref(ok)).toBe(ok);
    for (const bad of ['javascript:alert(1)', ' JavaScript:x', 'vbscript:x', 'file:///c:/x', 'data:text/html,x']) expect(safeHref(bad)).toBe('#');
    for (const ok of ['https://a/b.png', 'data:image/png;base64,AA', 'data:image/svg+xml;base64,AA', 'img/a.png', 'blob:https://x/1']) expect(safeImageSrc(ok)).toBe(ok);
    for (const bad of ['javascript:x', 'file:///x.png', 'data:text/html,x', 'vbscript:x']) expect(safeImageSrc(bad)).toBe('');
  });

  it('image node view uses the same sanitized style and source', () => {
    const img = S.nodes.image.create({ src: 'javascript:alert(1)', border: 'x;position:fixed', width: 50, crop: JSON.stringify({ t: '1;x', l: 5 }) });
    const view = realView(doc(P('a', img)), 1, plugins, buildNodeViews({ editMath() {}, controlClick() {}, imageEdit() {}, genBlockClick() {} }));
    const el = view.dom.querySelector('img') as HTMLImageElement;
    expect(el.getAttribute('src') || '').toBe('');
    expect(el.style.cssText).not.toMatch(/fixed/);
    expect(el.style.cssText).toContain('width: 50pt');
    view.destroy();
  });

  it('native import validates the document and explains bad files', async () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).buffer as ArrayBuffer;
    await expect(importNative(enc({ qf: 1, doc: { type: 'doc', content: [{ type: 'text', text: 'loose text' }] } }))).rejects.toThrow(/not a valid Anne's Pen document/);
    await expect(importNative(enc({ qf: 1, doc: { type: 'nosuch' } }))).rejects.toThrow(/not a valid Anne's Pen document/);
    await expect(importNative(new TextEncoder().encode('{oops').buffer as ArrayBuffer)).rejects.toThrow(/not a valid Anne's Pen document/);
    const good = doc(P('hello'));
    const back = await importNative(await (await exportNative(good)).arrayBuffer());
    expect(back.eq(good)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------
describe('2. word completion never swallows Enter', () => {
  it('Enter dismisses the suggestion and starts a new paragraph', () => {
    const d = doc(P('formatting matters'), P('Use this for'));
    const view = realView(d, d.content.size - 1);
    view.dispatch(view.state.tr.insertText('m'));
    expect(completeKey.getState(view.state)?.suggestion).toBe('atting');
    key(view, 'Enter');
    view.dispatch(view.state.tr.insertText('Next line'));
    const texts: string[] = []; view.state.doc.forEach((n) => texts.push(n.textContent));
    expect(texts).toEqual(['formatting matters', 'Use this form', 'Next line']);
    view.destroy();
  });
  it('Tab still accepts, and the hint says so', () => {
    const d = doc(P('formatting matters'), P('form'));
    const view = realView(d, d.content.size - 1);
    view.dispatch(view.state.tr.insertText('a'));
    expect(view.dom.querySelector('.qf-complete')?.getAttribute('title')).toBe('Tab to accept, Esc to dismiss');
    key(view, 'Tab');
    expect(view.state.doc.lastChild!.textContent).toBe('formatting');
    view.destroy();
  });
});

// ------------------------------------------------------------------------------------------
describe('3. wildcards in Find and Replace agree', () => {
  const d = doc(P('Room 42, cat cut c7t. ab-c'));
  const found = (q: string) => findMatches(d, buildMatcher(q, false, true, false, true)).map((m) => d.textBetween(m.from, m.to));
  it('builds the right expressions', () => {
    expect(found('^#')).toEqual(['4', '2', '7']);
    expect(found('^#^#')).toEqual(['42']);
    expect(found('c^?t')).toEqual(['cat', 'cut', 'c7t']);
    expect(found('c?t')).toEqual(['cat', 'cut', 'c7t']);
    expect(found('c^$t')).toEqual(['cat', 'cut']);
    expect(found('R*m')).toEqual(['Room']);
    expect(buildMatcher('^#', false, true, false, false)!.test('^#')).toBe(true); // literal without wildcards
  });
  it('find highlighting uses the wildcard flag from find state', () => {
    let st = EditorState.create({ doc: d, plugins: decoPlugins({ wordCompletion: () => false }) });
    st = st.apply(st.tr.setMeta(findKey, { query: '^#', wildcards: true, regex: false }));
    expect(findKey.getState(st)!.matches.length).toBe(3);
    st = st.apply(st.tr.setMeta(findKey, { wildcards: false }));
    expect(findKey.getState(st)!.matches.length).toBe(0);
  });
  it('Replace All replaces the same matches', () => {
    for (const [q, r, want] of [['^#', 'N', 'Room NN, cat cut cNt. ab-c'], ['c^?t', 'X', 'Room 42, X X X. ab-c'], ['c^$t', 'Y', 'Room 42, Y Y c7t. ab-c']] as const) {
      const app = makeApp();
      const tab = app.createTab(S.node('doc', { settings: defaultSettings() }, [P('Room 42, cat cut c7t. ab-c')]));
      replaceAll(app, { find: q, replace: r, wildcards: true, caseSensitive: true, quiet: true });
      expect(tab.view.state.doc.textContent, q).toBe(want);
    }
  });
});

// ------------------------------------------------------------------------------------------
describe('4. print layout breaks long lists and tables', () => {
  // A tiny block layout: paragraphs are one 20px line, containers stack their children,
  // table rows are as tall as their tallest cell, gap widgets are as tall as they say.
  let root: HTMLElement | null = null;
  const orig = { rect: Element.prototype.getBoundingClientRect, ow: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'), rects: (Range.prototype as any).getClientRects };
  const layout = () => {
    const m = new Map<Element, { top: number; h: number }>();
    const walk = (el: Element, y: number): number => {
      const he = el as HTMLElement;
      let h = 0;
      if (he.style?.display === 'none') h = 0;
      else if (el.classList.contains('qf-pgap')) h = parseFloat(he.dataset.h || '0');
      else if (/^(P|H\d)$/.test(el.tagName)) h = 20;
      else if (el.tagName === 'TR') { for (const c of el.children) h = Math.max(h, walk(c, y)); }
      else for (const c of el.children) h += walk(c, y + h);
      m.set(el, { top: y, h });
      return h;
    };
    if (root) walk(root, 0);
    return m;
  };
  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const r = layout().get(this) || { top: 0, h: 0 };
      return { top: r.top, bottom: r.top + r.h, height: r.h, left: 0, right: 816, width: 816, x: 0, y: r.top, toJSON() {} } as DOMRect;
    };
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 816 });
    (Range.prototype as any).getClientRects = () => [];
  });
  afterAll(() => {
    Element.prototype.getBoundingClientRect = orig.rect;
    if (orig.ow) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', orig.ow);
    (Range.prototype as any).getClientRects = orig.rects;
  });
  const cfg: PageConfig = {
    enabled: true, widthPt: 612, heightPt: 792, margin: { top: 72, right: 72, bottom: 72, left: 72 }, gapPx: 24,
    header: () => '', footer: (p, n) => `F${p}/${n}`, footnoteHtml: () => '', footnoteNumber: () => null, footnotesAtPageBottom: false,
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function paginate(d: PMNode) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const view = new EditorView(el, { state: EditorState.create({ doc: d, plugins: [paginationPlugin(() => cfg)] }) });
    root = view.dom;
    await wait(80);
    const first = pageKey.getState(view.state)!.info;
    repaginate(view, 0); // a second pass must measure the same natural layout through its own widgets
    await wait(20);
    return { view, first, info: pageKey.getState(view.state)!.info };
  }
  const items = (n: number) => Array.from({ length: n }, (_, i) => S.nodes.list_item.create(null, P('List item number ' + i)));
  const paras = (n: number) => Array.from({ length: n }, (_, i) => P('List item number ' + i));

  it('a 150-item list takes as many pages as 150 paragraphs', async () => {
    const asParas = await paginate(doc(P('Intro'), ...paras(150), P('After')));
    const asList = await paginate(doc(P('Intro'), S.nodes.bullet_list.create(null, items(150)), P('After')));
    expect(asParas.info.pages).toBe(4); // 152 lines of 20px, 43 lines per 864px page
    expect(asList.info.pages).toBe(asParas.info.pages);
    expect(asList.first).toEqual(asList.info);
    // Breaks fall between items, inside the list.
    const ul = asList.view.dom.querySelector('ul')!;
    expect(ul.querySelectorAll(':scope > .qf-pgap').length).toBe(3);
    expect([...asList.view.dom.querySelectorAll('.qf-pg-footer')].map((f) => f.textContent)).toEqual(['F1/4', 'F2/4', 'F3/4', 'F4/4']);
    for (const s of asList.info.starts.slice(1)) expect(asList.view.state.doc.resolve(s).parent.type.name).toBe('bullet_list');
    asParas.view.destroy(); asList.view.destroy();
  });

  it('a 200-row table breaks between rows with a gap row (banding parity kept)', async () => {
    const row = (i: number) => S.nodes.table_row.create(null, [S.nodes.table_cell.create(null, P('r' + i)), S.nodes.table_cell.create(null, P('x'))]);
    const { view, first, info } = await paginate(doc(P('Intro'), S.nodes.table.create(null, Array.from({ length: 200 }, (_, i) => row(i))), P('After')));
    expect(info.pages).toBe(5); // 202 lines
    expect(first).toEqual(info);
    const gaps = view.dom.querySelectorAll('tr.qf-pgap-row');
    expect(gaps.length).toBe(4);
    expect(view.dom.querySelectorAll('tr.qf-pgap-pad').length).toBe(4);
    for (const g of gaps) expect(g.querySelector('.qf-pgap')).not.toBeNull();
    view.destroy();
  });

  it('nested lists and multi-paragraph items break inside items when needed', async () => {
    const big = S.nodes.list_item.create(null, [P('head'), ...paras(60)]);
    const { view, info } = await paginate(doc(S.nodes.ordered_list.create(null, [S.nodes.list_item.create(null, P('one')), big])));
    expect(info.pages).toBe(2);
    expect(view.state.doc.resolve(info.starts[1]).parent.type.name).toBe('list_item');
    view.destroy();
  });
});

// ------------------------------------------------------------------------------------------
describe('5. page numbers honour the numbering start and format everywhere', () => {
  const s = defaultSettings();
  s.pageNumber = { start: 5, format: 'lower-roman' };
  it('displayPage, footer tokens, PAGE and PAGEREF agree', () => {
    expect(displayPage(1, s)).toBe('v');
    expect(displayPage(3, { ...s, pageNumber: { start: 5, format: 'decimal' } })).toBe('7');
    expect(expandTokens('{PAGE}', { page: 2, pages: 3, settings: s, fileName: 'f', userName: 'u' })).toBe('vi');
    const d = S.node('doc', { settings: s }, [P(S.nodes.bookmark.create({ name: 'b' }), S.nodes.field.create({ type: 'PAGE' }), S.nodes.field.create({ type: 'PAGEREF', arg: 'b' }))]);
    const vals = computeFields({ settings: s, fileName: 'f', userName: 'u', userInitials: 'U', pageOf: () => 2, pages: 3, doc: d } as any).map((x) => x.value);
    expect(vals).toEqual(['vi', 'vi']);
  });
  it('TOC page numbers use it too', () => {
    const d = S.node('doc', { settings: s }, [S.nodes.paragraph.create({ style: 'Heading 1' }, S.text('Intro'))]);
    const app = { state: EditorState.create({ doc: d }), settings: s, tab: { viewMode: 'print' } } as any;
    expect(generateBlock(app, 'toc', {})).toContain('<span class="qf-toc-page">v</span>');
  });
});

// ------------------------------------------------------------------------------------------
describe('6. citation formatting', () => {
  const who = { id: 'w', type: 'Report', author: 'World Health Organization', title: 'Report', year: '2020', publisher: 'WHO' } as any;
  it('corporate authors stay whole', () => {
    expect(formatAuthors('World Health Organization', 'APA')).toBe('World Health Organization');
    expect(formatAuthors('{Acme Widgets}', 'APA')).toBe('Acme Widgets');
    expect(formatAuthors('{Acme Widgets}', 'IEEE')).toBe('Acme Widgets');
    expect(formatInText([who], 'APA', null, () => 1)).toBe('(World Health Organization, 2020)');
    expect(formatBibEntry(who, 'APA')).toBe('World Health Organization (2020). <i>Report</i>. WHO.');
    expect(formatAuthors('Smith, John; World Health Organization', 'APA')).toBe('Smith, J., & World Health Organization');
  });
  it('names without first names get no stray commas', () => {
    expect(formatAuthors('Simon and Schuster', 'APA')).toBe('Simon & Schuster');
    expect(formatAuthors('Simon and Schuster', 'MLA')).toBe('Simon, and Schuster');
    expect(formatAuthors('Simon and Schuster', 'Chicago')).toBe('Simon and Schuster');
    expect(formatAuthors('Smith, John; Doe, Jane', 'APA')).toBe('Smith, J., & Doe, J.');
    expect(formatAuthors('John Smith', 'IEEE')).toBe('J. Smith');
  });
  it('missing volume, issue and pages leave no empty labels in any style', () => {
    const art = { id: 'a', type: 'Journal Article', author: 'Smith, John', title: 'On Things', journal: 'J. Stuff', year: '2019' } as any;
    expect(formatBibEntry(art, 'IEEE', 1)).toBe('[1] J. Smith, "On Things," <i>J. Stuff</i>, 2019.');
    expect(formatBibEntry(art, 'Harvard')).toBe("Smith, J. (2019) 'On Things', <i>J. Stuff</i>.");
    expect(formatBibEntry(art, 'APA')).toBe('Smith, J. (2019). On Things. <i>J. Stuff</i>.');
    expect(formatBibEntry(art, 'MLA')).toBe('Smith, John. "On Things." <i>J. Stuff</i>, 2019.');
    expect(formatBibEntry(art, 'Chicago')).toBe('Smith, John. "On Things." <i>J. Stuff</i> (2019).');
    for (const st of ['APA', 'MLA', 'Chicago', 'Turabian', 'Harvard', 'IEEE', 'ISO 690', 'GB7714']) {
      const out = formatBibEntry(art, st, 1);
      expect(out, st).not.toMatch(/vol\. ,|no\. ,|pp\. ,|, \.|\. \.|,\s*,|\(\)|: \./);
      const bare = formatBibEntry({ id: 'b', type: 'Book', title: 'Untitled' } as any, st, 1);
      expect(bare, st).not.toMatch(/, \.|\. \.|,\s*,|^\.|\(\)/);
    }
    const full = { ...art, volume: '3', issue: '2', pages: '10–20' };
    expect(formatBibEntry(full, 'IEEE', 1)).toBe('[1] J. Smith, "On Things," <i>J. Stuff</i>, vol. 3, no. 2, pp. 10–20, 2019.');
  });
  it('BibTeX keeps braced corporate authors on import and export', () => {
    const [src] = parseBibtex('@techreport{who, author = {{World Health Organization} and Smith, John}, title = {T}, year = 2020}');
    expect(src.author).toBe('{World Health Organization}; Smith, John');
    expect(formatAuthors(src.author!, 'APA')).toBe('World Health Organization & Smith, J.');
    expect(toBibtex([src])).toContain('author = {{World Health Organization} and Smith, John}');
    expect(toBibtex([who])).toContain('author = {{World Health Organization}}');
    const [b2] = parseBibtex('@book{s, author = {{Simon and Schuster}}, title = {X}}');
    expect(formatAuthors(b2.author!, 'APA')).toBe('Simon and Schuster');
  });
});

// ------------------------------------------------------------------------------------------
describe('7. reference dialogs work on the state after the dialog closes', () => {
  beforeAll(async () => { await import('../../src/commands/references'); });
  it('cross-reference: an edit made while the dialog was open is kept and positions re-resolved', async () => {
    const app = makeApp();
    const cap = S.nodes.paragraph.create({ style: 'Caption' }, S.text('Figure 1: A cat'));
    const tab = app.createTab(S.node('doc', { settings: defaultSettings() }, [P('see '), cap]));
    tab.view.dispatch(tab.view.state.tr.setSelection(TextSelection.create(tab.view.state.doc, 5)));
    dialogAnswer = () => {
      tab.view.dispatch(tab.view.state.tr.insert(0, P('Inserted while open')));
      return { type: 'Caption', what: 'text', target: 'c0', link: true };
    };
    await getCommand('refs.crossReference')!.run(app);
    const texts: string[] = []; tab.view.state.doc.forEach((n) => texts.push(n.textContent));
    expect(texts[0]).toBe('Inserted while open');
    expect(texts[1]).toBe('see Figure 1');
    expect(tab.view.state.doc.child(2).attrs.id).toMatch(/^cap-/);
  });
  it('edit footnote: updates the same note after the document changed', async () => {
    const app = makeApp();
    const fn = S.nodes.footnote.create({ text: 'old', id: 'f1' });
    const tab = app.createTab(S.node('doc', { settings: defaultSettings() }, [P('a', fn, 'b')]));
    dialogAnswer = () => { tab.view.dispatch(tab.view.state.tr.insertText('XYZ', 1)); return { text: 'new', mark: '' }; };
    await getCommand('refs.editFootnote')!.run(app, { pos: 2 });
    let text = ''; tab.view.state.doc.descendants((n) => { if (n.type === S.nodes.footnote) text = n.attrs.text; return true; });
    expect(text).toBe('new');
    expect(tab.view.state.doc.textContent).toBe('XYZab');
  });
});

// ------------------------------------------------------------------------------------------
describe('8. proofing timers are per tab', () => {
  it('two tabs scheduled back to back are both checked, and a busy run queues instead of cancelling', async () => {
    vi.useFakeTimers();
    try {
      const mk = () => ({ view: { state: EditorState.create({ doc: doc(P('x')) }), dispatch() {} }, settings: { language: 'en-US' } }) as any;
      const t1 = mk(), t2 = mk();
      const app = { prefs: { spellcheck: false, grammar: true, ignoredWords: [], dictionary: [] }, docs: [t1, t2], active: t1 } as any;
      const p = new Proofer(app);
      const seen: unknown[] = [];
      const real = p.run.bind(p);
      p.run = (async (t: DocTab) => { seen.push(t); return real(t); }) as any;
      p.schedule(t1, 10);
      p.schedule(t2, 10);
      await vi.advanceTimersByTimeAsync(20);
      expect(seen).toEqual([t1, t2]);
      seen.length = 0;
      (p as any).running = true;
      await real(t2); // busy: queued
      (p as any).running = false;
      p.schedule(t1, 10);
      await vi.advanceTimersByTimeAsync(80); // t1 runs, then the queued t2
      expect(seen).toContain(t1);
      expect(seen).toContain(t2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------------------------------
describe('9. the default style set shows its name, not the storage key', () => {
  it('labels', () => {
    expect(designLabel('QuillPen')).toBe('Anne\'s Pen');
    expect(designLabel('Classic')).toBe('Classic');
    const app = { settings: defaultSettings() } as any;
    const sets = getCommand('design.styleSet')!.menu!(app) as any[];
    expect(sets.map((x) => x.label)).toContain('Anne\'s Pen');
    expect(sets.map((x) => x.label)).not.toContain('QuillPen');
    expect(sets.find((x) => x.arg === 'QuillPen').checked).toBe(true);
    const themes = getCommand('design.themes')!.menu!(app) as any[];
    expect(themes.find((x) => x.arg === 'QuillPen').label).toMatch(/^Anne's Pen/);
    expect(themes.find((x) => x.arg === 'QuillPen').checked).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------
describe('10. incremental plugins and listener cleanup', () => {
  it('footnote numbers are mapped through typing and recomputed when notes change', () => {
    const fn = (id: string) => S.nodes.footnote.create({ text: id, id });
    let st = EditorState.create({ doc: doc(P('a', fn('1'), 'b', fn('2'))), plugins: decoPlugins({ wordCompletion: () => false }) });
    const labels = () => [...footnoteKey.getState(st)!.labels.entries()];
    expect(labels()).toEqual([[2, '1'], [4, '2']]);
    st = st.apply(st.tr.insertText('xx', 1));
    expect(labels()).toEqual([[4, '1'], [6, '2']]);
    st = st.apply(st.tr.insert(1, fn('0')));
    expect(labels()).toEqual([[1, '1'], [5, '2'], [7, '3']]);
    st = st.apply(st.tr.setNodeAttribute(5, 'mark', '*'));
    expect(labels()).toEqual([[1, '1'], [5, '*'], [7, '2']]);
  });
  it('coach marks updated per block equal a full recompute', () => {
    const ps = decoPlugins({ wordCompletion: () => false });
    let st = EditorState.create({ doc: doc(P('It was really done quickly.'), P('Fine text.')), plugins: ps });
    st = st.apply(st.tr.setMeta(coachKey, true));
    st = st.apply(st.tr.insertText(' very slowly', 4));
    st = st.apply(st.tr.delete(st.doc.content.size - 6, st.doc.content.size - 1));
    st = st.apply(st.tr.split(3));
    const fresh = EditorState.create({ doc: st.doc, plugins: ps });
    const all = (s: EditorState) => coachKey.getState(s)!.deco.find().map((x) => `${x.from}-${x.to}-${(x as any).type.attrs.class}`).sort();
    expect(all(st)).toEqual(all(fresh.apply(fresh.tr.setMeta(coachKey, true))));
  });
  it('image resize listeners go away on pointercancel and on destroy', () => {
    const view = realView(doc(P('a', S.nodes.image.create({ src: 'a.png', width: 50 }))), 1, plugins, buildNodeViews({ editMath() {}, controlClick() {}, imageEdit() {}, genBlockClick() {} }));
    const add = vi.spyOn(window, 'addEventListener');
    const rem = vi.spyOn(window, 'removeEventListener');
    const handle = view.dom.querySelector('.qf-h-se')!;
    handle.dispatchEvent(new (window.PointerEvent || MouseEvent)('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent);
    const added = add.mock.calls.map((c) => c[0]);
    expect(added).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']));
    window.dispatchEvent(new Event('pointercancel'));
    expect(rem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']));
    rem.mockClear();
    view.dom.querySelector('.qf-h-rot')!.dispatchEvent(new (window.PointerEvent || MouseEvent)('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent);
    view.destroy();
    expect(rem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']));
    add.mockRestore(); rem.mockRestore();
  });
});
