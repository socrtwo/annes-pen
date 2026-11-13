/** References tab: TOC, footnotes, citations & bibliography, captions, index, table of authorities. */
import { def } from './registry';
import type { App } from '../app';
import { NodeSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, styleLevel } from '../editor/schema';
import type { Source } from '../editor/settings';
import { insertBlock, insertInline, selectedText, setParaAttrs, currentParagraph } from '../editor/ops';
import { pageOfPos } from '../editor/plugins/pagination';
import { footnoteLabel } from '../editor/plugins/decorations';
import { displayPage } from '../editor/fields';
import { openDialog, toast, promptDialog } from '../ui/dialog';
import { esc } from '../ui/dom';
import { sanitizeGeneratedHtml } from '../util/sanitize';
import { slug } from './edit';

const N = schema.nodes;
const v = (app: App) => app.view;

/** Where `node` (found at `pos` before an await) is now, or -1 if it changed or went away. */
function relocate(app: App, pos: number, node: PMNode): number {
  const doc = app.state.doc;
  if (pos >= 0 && pos < doc.content.size && doc.nodeAt(pos) === node) return pos;
  let found = -1;
  doc.descendants((n, p) => { if (found >= 0) return false; if (n === node) found = p; return found < 0; });
  return found;
}

// ------------------------------------------------------------------------------------------
// Citation formatting

export const CITATION_STYLES = ['APA', 'MLA', 'Chicago', 'Turabian', 'Harvard', 'IEEE', 'ISO 690', 'GB7714'];
export const SOURCE_TYPES = ['Book', 'Book Section', 'Journal Article', 'Article in a Periodical', 'Conference Proceedings', 'Report', 'Web Site', 'Document from Web Site', 'Thesis', 'Film', 'Interview', 'Patent', 'Case', 'Statute', 'Manuscript / Archival', 'Census Record', 'Vital Record', 'Church Record', 'Miscellaneous'];

type Person = { first: string; last: string; literal?: boolean };

// Corporate authors: {Braced} as in BibTeX, or a name that reads like an organisation.
const CORPORATE = /\b(Organi[sz]ations?|Associations?|Institutes?|Inc|Ltd|Universit(y|ies)|Departments?|Committees?|Groups?|Agenc(y|ies)|Councils?|Societ(y|ies)|Foundations?)\b/i;

/** Splits an author list on ";" or " and ", ignoring separators inside {braces}. */
function splitAuthors(a: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && c === ';') { out.push(cur); cur = ''; continue; }
    if (depth === 0 && /\s/.test(c)) {
      const m = /^\s+and\s+/i.exec(a.slice(i));
      if (m) { out.push(cur); cur = ''; i += m[0].length - 1; continue; }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** True when the whole string is one {braced} group. */
function wholly(s: string): boolean {
  if (s[0] !== '{') return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i === s.length - 1;
  }
  return false;
}

function authorsList(a: string): Person[] {
  const raw = (a || '').trim();
  if (!raw) return [];
  // "Simon and Schuster Inc" is one publisher, not two people.
  if (!/[;,{]/.test(raw) && CORPORATE.test(raw)) return [{ first: '', last: raw, literal: true }];
  const names = splitAuthors(raw);
  return names.map((s): Person => {
    if (wholly(s)) return { first: '', last: s.slice(1, -1).replace(/[{}]/g, '').trim(), literal: true };
    s = s.replace(/[{}]/g, '');
    if (s.includes(',')) { const [last, ...rest] = s.split(',').map((x) => x.trim()); return { first: rest.join(' ').trim(), last }; }
    const parts = s.split(/\s+/);
    if (CORPORATE.test(s) || (names.length === 1 && parts.length >= 3)) return { first: '', last: s, literal: true };
    const last = parts.pop() || ''; return { first: parts.join(' '), last };
  }).filter((p) => p.last || p.first);
}
const initials = (f: string) => f.split(/[\s.-]+/).filter(Boolean).map((x) => x[0].toUpperCase() + '.').join(' ');
/** "Last, First" with the comma only when there is a first name. */
const lastFirst = (last: string, first: string) => (first ? `${last}, ${first}` : last);
const firstLast = (first: string, last: string) => [first, last].filter(Boolean).join(' ');

export function formatAuthors(a: string, style: string): string {
  const list = authorsList(a);
  if (!list.length) return '';
  switch (style) {
    case 'APA': case 'Harvard': {
      const f = list.map((p) => (p.literal ? p.last : lastFirst(p.last, initials(p.first))));
      if (f.length === 1) return f[0];
      // APA puts a comma before & after initials ("Smith, J., & Doe, J."), not after bare names.
      const sep = f.length > 2 || /\.$/.test(f[f.length - 2]) ? ', & ' : ' & ';
      return f.slice(0, -1).join(', ') + sep + f[f.length - 1];
    }
    case 'IEEE': return list.map((p) => (p.literal ? p.last : firstLast(initials(p.first), p.last))).join(', ');
    case 'MLA': {
      const inv = (p: Person) => (p.literal ? p.last : lastFirst(p.last, p.first));
      const fwd = (p: Person) => (p.literal ? p.last : firstLast(p.first, p.last));
      return list.length === 1 ? inv(list[0]) : list.length === 2 ? `${inv(list[0])}, and ${fwd(list[1])}` : `${inv(list[0])}, et al.`;
    }
    default: return list.map((p, i) => (p.literal ? p.last : i === 0 ? lastFirst(p.last, p.first) : firstLast(p.first, p.last))).join(list.length > 2 ? ', ' : ' and ');
  }
}

/** Ends a bibliography segment with a full stop (unless it already ends with one). */
const sentence = (x: string) => (!x ? '' : /[.?!]["'”’]?$|[.?!]<\/i>$/.test(x) ? x : x + '.');
const segs = (...xs: (string | false | null | undefined)[]) => xs.map((x) => sentence(x || '')).filter(Boolean).join(' ');
const list = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(', ');

export function formatBibEntry(s: Source, style: string, n?: number): string {
  const auRaw = formatAuthors(s.author || '', style);
  const au = esc(auRaw);
  const t = s.title ? esc(s.title) : '';
  const it = (x: string) => (x ? `<i>${x}</i>` : '');
  const book = /Book$|Report|Thesis|Film|Manuscript/.test(s.type) || !s.journal;
  const pub = [s.city, s.publisher].filter(Boolean).map((x) => esc(x!)).join(': ');
  const url = s.url ? esc(s.url) : '';
  const doi = s.doi ? `https://doi.org/${esc(s.doi)}` : '';
  const y = s.year ? esc(s.year) : '';
  const j = s.journal ? esc(s.journal) : '';
  const vol = s.volume ? esc(s.volume) : '', iss = s.issue ? esc(s.issue) : '', pg = s.pages ? esc(s.pages) : '';
  const vi = vol + (iss ? `(${iss})` : '');
  const tail = (x: string) => (x ? ' ' + x : '');
  switch (style) {
    case 'APA':
      return segs(`${au ? au + ' ' : ''}(${y || 'n.d.'})`, book ? it(t) + (s.edition ? ` (${esc(s.edition)} ed.)` : '') : t, book ? esc(s.publisher || '') : list(it(j), vol && it(vol) + (iss ? `(${iss})` : ''), pg)) + tail(doi || url);
    case 'MLA':
      return segs(au, book ? it(t) : t && `"${t}."`, book ? list(esc(s.publisher || ''), y) : list(it(j), vol && `vol. ${vol}`, iss && `no. ${iss}`, y, pg && `pp. ${pg}`)) + tail(url);
    case 'IEEE': {
      const num = `[${n ?? '?'}] `;
      if (book) return num + segs(list(au, it(t)), list(pub, y)) + tail(doi);
      const rest = list(it(j), vol && `vol. ${vol}`, iss && `no. ${iss}`, pg && `pp. ${pg}`, y);
      const title = t ? (rest ? `"${t},"` : `"${t}."`) : '';
      return num + sentence(title ? [list(au, title), rest].filter(Boolean).join(' ') : list(au, rest)) + tail(doi);
    }
    case 'Harvard': {
      const body = book ? it(t) : list(t && `'${t}'`, it(j), vi, pg && `pp. ${pg}`);
      return segs(`${au ? au + ' ' : ''}(${y || 'n.d.'})${body ? ' ' + body : ''}`, book && pub) + (url ? ` Available at: ${url}` : '') + (s.accessed ? ` (Accessed: ${esc(s.accessed)})` : '');
    }
    case 'ISO 690':
      return segs(esc(auRaw.toUpperCase()), book ? it(t) : t, !book && it(j), book ? list(pub, y) : list(y, vol && `vol. ${vol}`, iss && `no. ${iss}`, pg && `pp. ${pg}`)) + tail(url);
    case 'GB7714':
      return `[${n ?? '?'}] ` + segs(au, t && `${t}[${book ? 'M' : 'J'}]`, list(book ? pub : j, y, !book && vi) + (pg ? `: ${pg}` : ''));
    default: // Chicago / Turabian (notes-bibliography)
      return book ? segs(au, it(t), list(pub, y)) + tail(url)
        : segs(au, t && `"${t}."`, [it(j), vol].filter(Boolean).join(' ') + (iss ? `, no. ${iss}` : '') + (y ? ` (${y})` : '') + (pg ? `: ${pg}` : '')) + tail(doi || url);
  }
}

export function formatInText(sources: Source[], style: string, page: string | null, numberOf: (id: string) => number): string {
  if (!sources.length) return '(Unknown source)';
  const parts = sources.map((s) => {
    const people = authorsList(s.author || '');
    const last = people[0]?.last || s.title?.split(' ').slice(0, 3).join(' ') || 'Anon.';
    const many = people.length > 2 ? ' et al.' : people.length === 2 ? ` & ${people[1].last}` : '';
    switch (style) {
      case 'MLA': return `${last}${many.replace('&', 'and')}${page ? ' ' + page : ''}`;
      case 'IEEE': case 'GB7714': return `${numberOf(s.id)}`;
      case 'Chicago': case 'Turabian': return `${last}${many.replace('&', 'and')} ${s.year || 'n.d.'}${page ? ', ' + page : ''}`;
      default: return `${last}${many}, ${s.year || 'n.d.'}${page ? ', p. ' + page : ''}`;
    }
  });
  if (style === 'IEEE' || style === 'GB7714') return `[${parts.join(', ')}]`;
  return `(${parts.join('; ')})`;
}

function citedOrder(doc: PMNode): string[] {
  const order: string[] = [];
  doc.descendants((n) => { if (n.type === N.citation) for (const id of String(n.attrs.sources).split(',').filter(Boolean)) if (!order.includes(id)) order.push(id); return true; });
  return order;
}

export function refreshCitations(app: App): void {
  const st = app.state;
  const s = app.settings;
  const order = citedOrder(st.doc);
  const tr = st.tr;
  st.doc.descendants((n, pos) => {
    if (n.type !== N.citation) return true;
    const ids = String(n.attrs.sources).split(',').filter(Boolean);
    const srcs = ids.map((id) => s.sources.find((x) => x.id === id)).filter(Boolean) as Source[];
    const text = formatInText(srcs, s.citationStyle, n.attrs.page, (id) => order.indexOf(id) + 1);
    if (text !== n.attrs.cache) tr.setNodeMarkup(pos, undefined, { ...n.attrs, cache: text });
    return true;
  });
  if (tr.docChanged) v(app).dispatch(tr.setMeta('addToHistory', false));
}

// ------------------------------------------------------------------------------------------
// Generated blocks

function headingList(doc: PMNode, maxLevel: number) {
  const out: { level: number; text: string; pos: number }[] = [];
  doc.forEach((n, pos) => {
    const walk = (node: PMNode, p: number) => {
      if (node.type === N.paragraph) {
        const lvl = styleLevel(node.attrs.style, node.attrs.outlineLevel);
        if (lvl && lvl <= maxLevel && node.textContent.trim()) out.push({ level: lvl, text: node.textContent, pos: p });
      } else if (node.type === N.column_section || node.type === N.text_box) node.forEach((c, o) => walk(c, p + 1 + o));
    };
    walk(n, pos);
  });
  return out;
}

export function generateBlock(app: App, kind: string, options: Record<string, any>): string {
  const st = app.state;
  const s = app.settings;
  const paged = app.tab.viewMode === 'print';
  const pg = (pos: number) => (paged ? displayPage(pageOfPos(st, pos), s) : '');
  const leader = options.leader || 'dot';
  const row = (text: string, page: string, cls: string, href?: string) =>
    `<p class="qf-toc-row ${cls} qf-leader-${leader}">${href ? `<a href="#${href}">` : ''}<span class="qf-toc-text">${esc(text)}</span>${href ? '</a>' : ''}${options.pages !== false && page ? `<span class="qf-toc-page">${page}</span>` : ''}</p>`;
  switch (kind) {
    case 'toc': {
      const levels = options.levels || 3;
      const list = headingList(st.doc, levels);
      const title = options.title ?? 'Contents';
      if (!list.length) return `${title ? `<p class="qf-toc-title">${esc(title)}</p>` : ''}<p class="qf-gen-empty">No headings found. Apply Heading styles to your titles, then update.</p>`;
      return (title ? `<p class="qf-toc-title">${esc(title)}</p>` : '') + list.map((h) => row(h.text, pg(h.pos), `qf-toc-l${h.level}`, slug(h.text))).join('');
    }
    case 'tof': {
      const label = options.label || 'Figure';
      const items: { text: string; pos: number }[] = [];
      st.doc.descendants((n, pos) => { if (n.type === N.paragraph && n.attrs.style === 'Caption' && n.textContent.startsWith(label)) items.push({ text: n.textContent, pos }); return true; });
      if (!items.length) return `<p class="qf-gen-empty">No captions with the label "${esc(label)}" were found.</p>`;
      return `<p class="qf-toc-title">${esc(options.title || `Table of ${label}s`)}</p>` + items.map((i) => row(i.text, pg(i.pos), 'qf-toc-l1')).join('');
    }
    case 'index': {
      const entries = new Map<string, Map<string, Set<string>>>();
      st.doc.descendants((n, pos) => {
        if (n.type === N.index_entry && n.attrs.kind !== 'toa') {
          const term = String(n.attrs.term || '').trim(), sub = n.attrs.sub || '';
          if (!term) return true;
          if (!entries.has(term)) entries.set(term, new Map());
          const m = entries.get(term)!;
          if (!m.has(sub)) m.set(sub, new Set());
          m.get(sub)!.add(n.attrs.see ? esc(`see ${n.attrs.see}`) : pg(pos) || '•');
        }
        return true;
      });
      if (!entries.size) return '<p class="qf-gen-empty">No index entries. Use References ▸ Mark Entry first.</p>';
      const terms = [...entries.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      let html = '<div class="qf-index" style="column-count:2;column-gap:24pt">';
      let letter = '';
      for (const t of terms) {
        const L = (t[0] || '#').toUpperCase();
        if (L !== letter) { letter = L; html += `<p class="qf-index-letter">${esc(L)}</p>`; }
        const subs = entries.get(t)!;
        const main = subs.get('');
        html += `<p class="qf-index-1">${esc(t)}${main ? ', ' + [...main].join(', ') : ''}</p>`;
        for (const [sub, pages] of [...subs.entries()].filter(([k]) => k).sort()) html += `<p class="qf-index-2">${esc(sub)}, ${[...pages].join(', ')}</p>`;
      }
      return html + '</div>';
    }
    case 'toa': {
      const cats = new Map<string, Map<string, Set<string>>>();
      st.doc.descendants((n, pos) => {
        if (n.type === N.index_entry && n.attrs.kind === 'toa') {
          const cat = n.attrs.sub || 'Cases';
          if (!cats.has(cat)) cats.set(cat, new Map());
          const m = cats.get(cat)!;
          if (!m.has(n.attrs.term)) m.set(n.attrs.term, new Set());
          m.get(n.attrs.term)!.add(pg(pos) || 'passim');
        }
        return true;
      });
      if (!cats.size) return '<p class="qf-gen-empty">No citations marked. Use References ▸ Mark Citation.</p>';
      let html = '<p class="qf-toc-title">Table of Authorities</p>';
      for (const [cat, m] of cats) {
        html += `<p class="qf-index-letter">${esc(cat)}</p>`;
        for (const [term, pages] of [...m.entries()].sort()) html += row(term, [...pages].join(', '), 'qf-toc-l1');
      }
      return html;
    }
    case 'bibliography': {
      const order = citedOrder(st.doc);
      const style = s.citationStyle;
      const numeric = ['IEEE', 'GB7714'].includes(style);
      const cited = order.map((id) => s.sources.find((x) => x.id === id)).filter(Boolean) as Source[];
      // Numeric styles: cited sources keep their citation numbers; uncited ones ("All Sources") follow them.
      const uncited = options.all ? s.sources.filter((x) => !order.includes(x.id)) : [];
      let srcs = options.all ? (numeric ? [...cited, ...uncited] : [...s.sources]) : cited;
      if (!numeric) srcs = srcs.sort((a, b) => (a.author || a.title).localeCompare(b.author || b.title));
      const num = (x: Source) => { const i = order.indexOf(x.id); return i >= 0 ? i + 1 : order.length + uncited.indexOf(x) + 1; };
      const title = options.title ?? (style === 'MLA' ? 'Works Cited' : style === 'APA' ? 'References' : 'Bibliography');
      if (!srcs.length) return `<p class="qf-toc-title">${esc(title)}</p><p class="qf-gen-empty">No sources cited. Add citations with References ▸ Insert Citation.</p>`;
      return `<p class="qf-toc-title">${esc(title)}</p>` + srcs.map((x) => `<p class="qf-bib-entry">${formatBibEntry(x, style, num(x))}</p>`).join('');
    }
    case 'endnotes': {
      const items: string[] = [];
      st.doc.descendants((n, pos) => {
        if (n.type === N.footnote && (n.attrs.kind === 'end' || s.footnoteFormat.placement === 'end')) items.push(`<p class="qf-endnote"><sup>${esc(footnoteLabel(st, pos) || '')}</sup> ${esc(n.attrs.text)}</p>`);
        return true;
      });
      return `<p class="qf-toc-title">${esc(options.title || 'Notes')}</p>` + (items.join('') || '<p class="qf-gen-empty">No endnotes.</p>');
    }
  }
  return '';
}

export function updateGenerated(app: App, onlyPos?: number): number {
  const st = app.state;
  const tr = st.tr;
  let count = 0;
  st.doc.descendants((n, pos) => {
    if (n.type === N.gen_block && (onlyPos == null || pos === onlyPos)) {
      const cache = generateBlock(app, n.attrs.kind, n.attrs.options || {});
      if (cache !== n.attrs.cache) tr.setNodeMarkup(pos, undefined, { ...n.attrs, cache });
      count++;
    }
    return true;
  });
  if (tr.docChanged) v(app).dispatch(tr);
  return count;
}

function insertGen(app: App, kind: string, options: Record<string, any> = {}) {
  const node = N.gen_block.create({ kind, options, cache: '' });
  insertBlock(v(app), node);
  setTimeout(() => updateGenerated(app), 50);
}

// ------------------------------------------------------------------------------------------
// TOC

def([
  {
    id: 'refs.toc', label: 'Table of Contents', icon: 'toc', tab: 'References', group: 'Table of Contents', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => {
      if (arg === 'custom') return app.exec('refs.tocDialog');
      if (arg === 'remove') return app.exec('refs.removeToc');
      insertGen(app, 'toc', { levels: arg?.levels || 3, leader: arg?.leader || 'dot', title: arg?.title ?? 'Contents' });
    },
    menu: () => [
      { id: 'refs.toc', arg: { levels: 3 }, label: 'Automatic Table 1 (Contents, 3 levels)' }, { id: 'refs.toc', arg: { levels: 3, title: 'Table of Contents' }, label: 'Automatic Table 2 (Table of Contents)' },
      { id: 'refs.toc', arg: { levels: 2, leader: 'none' }, label: 'Simple (2 levels, no leaders)' }, { id: 'refs.toc', arg: { levels: 1, title: '' }, label: 'Chapters Only' },
      { separator: true }, { id: 'refs.toc', arg: 'custom', label: 'Custom Table of Contents…' }, { id: 'refs.toc', arg: 'remove', label: 'Remove Table of Contents' },
    ],
  },
  {
    id: 'refs.tocDialog', label: 'Custom Table of Contents…', icon: 'toc', tab: 'References', group: 'Table of Contents', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Table of Contents', fields: [
        { key: 'title', label: 'Title', type: 'text', value: 'Contents' },
        { key: 'levels', label: 'Show levels', type: 'number', min: 1, max: 9, value: 3, half: true },
        { key: 'leader', label: 'Tab leader', type: 'select', options: [{ value: 'dot', label: '.......' }, { value: 'dash', label: '-------' }, { value: 'line', label: '______' }, { value: 'none', label: '(none)' }], value: 'dot', half: true },
        { key: 'pages', label: 'Show page numbers', type: 'checkbox', value: true, half: true },
      ] });
      if (r) insertGen(app, 'toc', r);
    },
  },
  { id: 'refs.updateToc', label: 'Update Table', icon: 'sync', tab: 'References', group: 'Table of Contents', edits: true, popular: true, run: (app) => { const n = updateGenerated(app); toast(n ? `Updated ${n} generated table(s)` : 'No tables to update.'); } },
  {
    id: 'refs.removeToc', label: 'Remove Table of Contents', icon: 'delete', tab: 'References', group: 'Table of Contents', edits: true,
    run: (app) => { const st = app.state; const tr = st.tr; const ps: number[] = []; st.doc.descendants((n, pos) => { if (n.type === N.gen_block && n.attrs.kind === 'toc') ps.push(pos); return true; }); for (const p of ps.reverse()) tr.delete(p, p + 1); v(app).dispatch(tr); },
  },
  {
    id: 'refs.addText', label: 'Add Text (TOC Level)', icon: 'playlist_add', tab: 'References', group: 'Table of Contents', kind: 'menu', edits: true,
    run: (app, arg) => setParaAttrs(v(app), { outlineLevel: arg || null }),
    menu: (app) => [{ id: 'refs.addText', arg: 0, label: 'Do Not Show in Table of Contents', checked: !currentParagraph(app.state)?.attrs.outlineLevel }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: 'refs.addText', arg: n, label: `Level ${n}`, checked: currentParagraph(app.state)?.attrs.outlineLevel === n }))],
  },
  { id: 'refs.updateGenerated', label: 'Update Generated Block', icon: 'sync', tab: 'References', group: 'Table of Contents', internal: true, edits: true, run: (app, arg) => updateGenerated(app, arg?.pos) },
  { id: 'refs.updateAll', label: 'Update All (Fields, Tables, Citations)', icon: 'published_with_changes', tab: 'References', group: 'Table of Contents', edits: true, run: (app) => { app.updateFields(); refreshCitations(app); updateGenerated(app); toast('Everything updated'); } },
]);

// ------------------------------------------------------------------------------------------
// Footnotes

async function insertNote(app: App, kind: 'foot' | 'end') {
  const text = await promptDialog(kind === 'foot' ? 'Insert Footnote' : 'Insert Endnote', 'Note text:', '', { type: 'textarea' as any, rows: 4 } as any);
  if (text == null) return;
  insertInline(v(app), N.footnote.create({ text, kind, id: `fn${Date.now().toString(36)}` }));
  if (kind === 'end' || app.settings.footnoteFormat.placement === 'end') {
    let has = false;
    app.state.doc.descendants((n) => { if (n.type === N.gen_block && n.attrs.kind === 'endnotes') has = true; return !has; });
    if (!has) { const end = app.state.doc.content.size; v(app).dispatch(app.state.tr.insert(end, N.gen_block.create({ kind: 'endnotes', options: {} }))); }
    setTimeout(() => updateGenerated(app), 30);
  }
}
def([
  { id: 'refs.footnote', label: 'Insert Footnote', icon: 'notes', tab: 'References', group: 'Footnotes', keys: ['Mod-Alt-f'], edits: true, popular: true, run: (app) => insertNote(app, 'foot') },
  { id: 'refs.endnote', label: 'Insert Endnote', icon: 'note_stack_add', tab: 'References', group: 'Footnotes', keys: ['Mod-Alt-d'], edits: true, run: (app) => insertNote(app, 'end') },
  {
    id: 'refs.footnoteOptions', label: 'Footnote and Endnote Options…', icon: 'tune', tab: 'References', group: 'Footnotes', edits: true,
    run: async (app) => {
      const f = app.settings.footnoteFormat;
      const fmts = [{ value: 'decimal', label: '1, 2, 3' }, { value: 'lower-alpha', label: 'a, b, c' }, { value: 'upper-alpha', label: 'A, B, C' }, { value: 'lower-roman', label: 'i, ii, iii' }, { value: 'upper-roman', label: 'I, II, III' }, { value: 'symbols', label: '*, †, ‡, §' }];
      const r = await openDialog({ title: 'Footnote and Endnote', fields: [
        { key: 'foot', label: 'Footnote number format', type: 'select', options: fmts, value: f.foot },
        { key: 'end', label: 'Endnote number format', type: 'select', options: fmts, value: f.end },
        { key: 'placement', label: 'Footnotes appear', type: 'radio', options: [{ value: 'page', label: 'Bottom of page' }, { value: 'end', label: 'End of document (as endnotes)' }], value: f.placement },
      ] });
      if (r) app.updateSettings((s) => { s.footnoteFormat = { foot: r.foot, end: r.end, placement: r.placement }; });
    },
  },
  { id: 'refs.showNotes', label: 'Show Notes', icon: 'visibility', tab: 'References', group: 'Footnotes', run: (app) => app.ui.togglePane('notes') },
  {
    id: 'refs.convertNotes', label: 'Convert Footnotes ⇄ Endnotes', icon: 'swap_vert', tab: 'References', group: 'Footnotes', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Convert Notes', fields: [{ key: 'm', label: '', type: 'radio', options: [{ value: 'f2e', label: 'Convert all footnotes to endnotes' }, { value: 'e2f', label: 'Convert all endnotes to footnotes' }, { value: 'swap', label: 'Swap footnotes and endnotes' }], value: 'f2e' }] });
      if (!r) return;
      const tr = app.state.tr;
      app.state.doc.descendants((n, pos) => {
        if (n.type !== N.footnote) return true;
        const k = n.attrs.kind;
        const nk = r.m === 'f2e' ? 'end' : r.m === 'e2f' ? 'foot' : k === 'end' ? 'foot' : 'end';
        if (nk !== k) tr.setNodeMarkup(pos, undefined, { ...n.attrs, kind: nk });
        return true;
      });
      v(app).dispatch(tr);
      updateGenerated(app);
    },
  },
  {
    id: 'refs.editFootnote', label: 'Edit Footnote', icon: 'edit_note', tab: 'References', group: 'Footnotes', internal: true, edits: true,
    run: async (app, arg) => {
      const pos = arg?.pos ?? (app.state.selection instanceof NodeSelection ? app.state.selection.from : -1);
      const node = pos >= 0 ? app.state.doc.nodeAt(pos) : null;
      if (!node || node.type !== N.footnote) return;
      const r = await openDialog({ title: node.attrs.kind === 'end' ? 'Endnote' : 'Footnote', fields: [
        { key: 'text', label: 'Text', type: 'textarea', rows: 5, value: node.attrs.text },
        { key: 'mark', label: 'Custom mark (blank = automatic number)', type: 'text', value: node.attrs.mark || '' },
      ], buttons: [{ label: 'Delete Note', onClick: (_v, ctl) => { v(app).dispatch(app.state.tr.delete(pos, pos + 1)); ctl.close(); } }] });
      const at = r ? relocate(app, pos, node) : -1;
      if (r && at >= 0) { v(app).dispatch(app.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, text: r.text, mark: r.mark || null })); updateGenerated(app); }
    },
  },
]);

// ------------------------------------------------------------------------------------------
// Citations & bibliography

async function editSource(app: App, src?: Source): Promise<Source | null> {
  const s: Partial<Source> = src || { type: 'Book' };
  const r = await openDialog({ title: src ? 'Edit Source' : 'Create Source', wide: true, fields: [
    { key: 'type', label: 'Type of source', type: 'select', options: SOURCE_TYPES, value: s.type },
    { key: 'author', label: 'Author(s) — "Last, First; Last, First"', type: 'text', value: s.author || '' },
    { key: 'title', label: 'Title', type: 'text', value: s.title || '' },
    { key: 'year', label: 'Year', type: 'text', value: s.year || '', half: true },
    { key: 'edition', label: 'Edition', type: 'text', value: s.edition || '', half: true },
    { key: 'journal', label: 'Journal / periodical / website / collection', type: 'text', value: s.journal || '' },
    { key: 'volume', label: 'Volume', type: 'text', value: s.volume || '', half: true },
    { key: 'issue', label: 'Issue', type: 'text', value: s.issue || '', half: true },
    { key: 'pages', label: 'Pages', type: 'text', value: s.pages || '', half: true },
    { key: 'city', label: 'City', type: 'text', value: s.city || '', half: true },
    { key: 'publisher', label: 'Publisher / repository', type: 'text', value: s.publisher || '' },
    { key: 'url', label: 'URL', type: 'text', value: s.url || '' },
    { key: 'doi', label: 'DOI', type: 'text', value: s.doi || '', half: true },
    { key: 'accessed', label: 'Date accessed', type: 'text', value: s.accessed || '', half: true },
  ] });
  if (!r) return null;
  return { ...(src || {}), id: src?.id || `src${Date.now().toString(36)}`, ...r } as Source;
}

def([
  {
    id: 'refs.insertCitation', label: 'Insert Citation', icon: 'format_quote', tab: 'References', group: 'Citations & Bibliography', kind: 'menu', edits: true, popular: true,
    run: async (app, arg) => {
      const s = app.settings;
      if (arg === 'new' || (!arg && !s.sources.length)) {
        const src = await editSource(app);
        if (!src) return;
        app.updateSettings((st) => { st.sources.push(src); });
        arg = src.id;
      }
      if (!arg) {
        const r = await openDialog({ title: 'Insert Citation', fields: [
          { key: 'ids', label: 'Sources (select one or more)', type: 'list', multiple: true, rows: 8, options: s.sources.map((x) => ({ value: x.id, label: `${x.author || 'Anon.'} (${x.year}) ${x.title}` })), value: [] },
          { key: 'page', label: 'Page(s) (optional)', type: 'text', value: '' },
        ] });
        if (!r || !r.ids?.length) return;
        insertInline(v(app), N.citation.create({ sources: r.ids.join(','), page: r.page || null }));
      } else insertInline(v(app), N.citation.create({ sources: arg }));
      refreshCitations(app);
    },
    menu: (app) => [...app.settings.sources.map((x) => ({ id: 'refs.insertCitation', arg: x.id, label: `${x.author || 'Anon.'}, ${x.year} — ${x.title}` })), { separator: true }, { id: 'refs.insertCitation', arg: 'new', label: 'Add New Source…' }, { id: 'refs.insertCitation', label: 'Choose Sources…' }],
  },
  {
    id: 'refs.editCitation', label: 'Edit Citation', icon: 'edit', tab: 'References', group: 'Citations & Bibliography', internal: true, edits: true,
    run: async (app, arg) => {
      const pos = arg?.pos ?? app.state.selection.from;
      const node = app.state.doc.nodeAt(pos);
      if (!node || node.type !== N.citation) return;
      const s = app.settings;
      const r = await openDialog({ title: 'Edit Citation', fields: [
        { key: 'ids', label: 'Sources', type: 'list', multiple: true, rows: 8, options: s.sources.map((x) => ({ value: x.id, label: `${x.author} (${x.year}) ${x.title}` })), value: String(node.attrs.sources).split(',') },
        { key: 'page', label: 'Page(s)', type: 'text', value: node.attrs.page || '' },
      ], buttons: [{ label: 'Delete', onClick: (_v, ctl) => { v(app).dispatch(app.state.tr.delete(pos, pos + 1)); ctl.close(); } }] });
      if (!r) return;
      const at = relocate(app, pos, node);
      if (at < 0) return;
      v(app).dispatch(app.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, sources: (r.ids || []).join(','), page: r.page || null }));
      refreshCitations(app);
    },
  },
  {
    id: 'refs.manageSources', label: 'Manage Sources…', icon: 'library_books', tab: 'References', group: 'Citations & Bibliography', edits: true,
    run: async (app) => {
      for (;;) {
        const s = app.settings;
        const r = await openDialog({ title: 'Source Manager', wide: true, ok: 'Close', cancel: false, fields: [
          { key: 'id', label: `Current list (${s.sources.length})`, type: 'list', rows: 10, options: s.sources.map((x) => ({ value: x.id, label: `${x.author || 'Anon.'} (${x.year || 'n.d.'}) ${x.title}` })) },
          { key: 'preview', type: 'info', html: '' },
        ], buttons: [
          { label: 'New…', onClick: (_x, ctl) => ctl.close({ act: 'new' }) },
          { label: 'Edit…', onClick: (x, ctl) => ctl.close({ act: 'edit', id: x.id }) },
          { label: 'Delete', onClick: (x, ctl) => ctl.close({ act: 'delete', id: x.id }) },
          { label: 'Import BibTeX…', onClick: (_x, ctl) => ctl.close({ act: 'bibtex' }) },
          { label: 'Export BibTeX', onClick: (_x, ctl) => ctl.close({ act: 'export' }) },
        ], onChange: (x, ctl) => {
          const src = s.sources.find((q) => q.id === x.id);
          const info = ctl.body.querySelector('.qf-info');
          if (info) info.innerHTML = src ? `<p class="qf-help">Preview (${esc(s.citationStyle)}):</p><p>${sanitizeGeneratedHtml(formatBibEntry(src, s.citationStyle, 1))}</p>` : '';
        } });
        if (!r || !r.act) break;
        if (r.act === 'new') { const src = await editSource(app); if (src) app.updateSettings((st) => { st.sources.push(src); }); }
        if (r.act === 'edit' && r.id) { const cur = s.sources.find((x) => x.id === r.id); const src = await editSource(app, cur); if (src) app.updateSettings((st) => { st.sources = st.sources.map((x) => (x.id === src.id ? src : x)); }); }
        if (r.act === 'delete' && r.id) app.updateSettings((st) => { st.sources = st.sources.filter((x) => x.id !== r.id); });
        if (r.act === 'bibtex') {
          const txt = await promptDialog('Import BibTeX', 'Paste BibTeX entries:', '', { type: 'textarea' as any, rows: 10 } as any);
          if (txt) { const list = parseBibtex(txt); app.updateSettings((st) => { st.sources.push(...list); }); toast(`Imported ${list.length} source(s)`); }
        }
        if (r.act === 'export') { await navigator.clipboard?.writeText(toBibtex(app.settings.sources)); toast('BibTeX copied to clipboard'); }
      }
      refreshCitations(app);
      updateGenerated(app);
    },
  },
  {
    id: 'refs.citationStyle', label: 'Citation Style', icon: 'school', tab: 'References', group: 'Citations & Bibliography', kind: 'menu', edits: true,
    run: (app, arg) => { app.updateSettings((s) => { s.citationStyle = arg || 'APA'; }); refreshCitations(app); updateGenerated(app); },
    menu: (app) => CITATION_STYLES.map((s) => ({ id: 'refs.citationStyle', arg: s, label: s, checked: app.settings.citationStyle === s })),
  },
  {
    id: 'refs.bibliography', label: 'Bibliography', icon: 'menu_book', tab: 'References', group: 'Citations & Bibliography', kind: 'menu', edits: true, popular: true,
    run: (app, arg) => insertGen(app, 'bibliography', arg || {}),
    menu: () => [{ id: 'refs.bibliography', arg: {}, label: 'Bibliography (cited works)' }, { id: 'refs.bibliography', arg: { title: 'References' }, label: 'References' }, { id: 'refs.bibliography', arg: { title: 'Works Cited' }, label: 'Works Cited' }, { id: 'refs.bibliography', arg: { all: true, title: 'Sources Consulted' }, label: 'All Sources (including uncited)' }],
  },
  { id: 'refs.updateCitations', label: 'Update Citations and Bibliography', icon: 'sync', tab: 'References', group: 'Citations & Bibliography', edits: true, run: (app) => { refreshCitations(app); updateGenerated(app); } },
  {
    id: 'refs.citationToText', label: 'Convert Citations to Static Text', icon: 'text_snippet', tab: 'References', group: 'Citations & Bibliography', edits: true,
    run: (app) => { const tr = app.state.tr; const list: { pos: number; node: PMNode }[] = []; app.state.doc.descendants((n, pos) => { if (n.type === N.citation) list.push({ pos, node: n }); return true; }); for (const c of list.reverse()) tr.replaceWith(c.pos, c.pos + 1, schema.text(c.node.attrs.cache || '()')); v(app).dispatch(tr); },
  },
]);

const BIB_ACCENTS: Record<string, string> = { '"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307', c: '\u0327', v: '\u030C', u: '\u0306', H: '\u030B', k: '\u0328', r: '\u030A' };
const BIB_SYMBOLS: Record<string, string> = { ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł' };

/** Turns a raw BibTeX value (nested braces, TeX accents) into plain text. */
function bibText(raw: string, plain = false): string {
  let t = raw;
  if (!plain) {
    const acc = (a: string, ch: string) => (ch === '\\i' ? 'i' : ch === '\\j' ? 'j' : ch) + BIB_ACCENTS[a];
    t = t.replace(/\\([cvuHkr])(?:\s*\{\s*(\\[ij]|[A-Za-z])\s*\}|\s+([A-Za-z]))/g, (_m, a, b, c) => acc(a, b ?? c))
      .replace(/\\(["'`^~=.])\s*(?:\{\s*(\\[ij]|[A-Za-z])\s*\}|(\\[ij]|[A-Za-z]))/g, (_m, a, b, c) => acc(a, b ?? c))
      .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L)(?![A-Za-z])\s*/g, (_m, k) => BIB_SYMBOLS[k])
      .replace(/\\([&%$#_{}])/g, (_m, ch) => (ch === '{' || ch === '}' ? '' : ch));
  }
  return t.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().normalize('NFC');
}

/** BibTeX parser: a small scanner that counts braces, so values may nest braces, entries may be
 *  on one line and the closing brace may be anywhere. @string macros are expanded; @comment and
 *  @preamble are skipped; values may be {braced}, "quoted", bare numbers/macros, joined with #. */
export function parseBibtex(src: string): Source[] {
  const out: Source[] = [];
  const macros: Record<string, string> = {};
  const n = src.length;
  let i = 0;
  const ws = () => { while (i < n && /\s/.test(src[i])) i++; };
  const ident = () => { const s0 = i; while (i < n && /[^\s"#%'(),={}@]/.test(src[i])) i++; return src.slice(s0, i); };
  // Reads a {braced} or "quoted" group starting at src[i]; returns the inner text with nested braces kept.
  const group = () => {
    const quoted = src[i] === '"';
    const s0 = ++i;
    let depth = 0;
    for (; i < n; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') { if (depth === 0) { if (!quoted) break; } else depth--; }
      else if (c === '"' && quoted && depth === 0) break;
    }
    const inner = src.slice(s0, i);
    if (i < n) i++;
    return inner;
  };
  const value = (close: string) => {
    let v = '';
    for (;;) {
      ws();
      const c = src[i];
      if (c === '{' || c === '"') v += group();
      else {
        const s0 = i;
        while (i < n && /[^\s,#{}()"]/.test(src[i]) && src[i] !== close) i++;
        const w = src.slice(s0, i);
        if (!w) break;
        v += /^\d+$/.test(w) ? w : macros[w.toLowerCase()] ?? w;
      }
      ws();
      if (src[i] !== '#') break;
      i++;
    }
    return v;
  };
  // Skips to just after the entry's closing delimiter, honoring nested braces.
  const skipEntry = (close: string) => {
    let depth = 0;
    for (; i < n; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}' && depth > 0) depth--;
      else if (c === close && depth === 0) { i++; return; }
    }
  };
  const TYPES: Record<string, string> = { book: 'Book', article: 'Journal Article', inproceedings: 'Conference Proceedings', incollection: 'Book Section', phdthesis: 'Thesis', mastersthesis: 'Thesis', techreport: 'Report', misc: 'Miscellaneous', online: 'Web Site' };
  while (i < n) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    ws();
    const kind = ident().toLowerCase();
    ws();
    if (!kind || (src[i] !== '{' && src[i] !== '(')) continue;
    const close = src[i] === '(' ? ')' : '}';
    i++;
    if (kind === 'comment' || kind === 'preamble') { skipEntry(close); continue; }
    if (kind === 'string') {
      ws(); const name = ident(); ws();
      if (name && src[i] === '=') { i++; macros[name.toLowerCase()] = value(close); }
      skipEntry(close);
      continue;
    }
    ws();
    const s0 = i;
    while (i < n && src[i] !== ',' && src[i] !== close && src[i] !== '\n') i++;
    const key = src.slice(s0, i).trim();
    const fields: Record<string, string> = {};
    while (i < n) {
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === close) { i++; break; }
      if (src[i] === '@') break; // unterminated entry: let the next one start
      const name = ident().toLowerCase();
      if (!name) { i++; continue; }
      ws();
      if (src[i] !== '=') continue;
      i++;
      fields[name] = value(close);
    }
    const f = (k: string) => (fields[k] == null ? undefined : bibText(fields[k], k === 'url' || k === 'doi'));
    // Names in {braces} are corporate authors: keep the braces so formatting does not invert them.
    const author = fields.author == null ? '' : splitAuthors(fields.author).map((x) => (wholly(x) ? `{${bibText(x.slice(1, -1))}}` : bibText(x))).filter((x) => x && x !== '{}').join('; ');
    out.push({ id: key || `src${out.length}`, type: TYPES[kind] || 'Miscellaneous', author, title: f('title') || '', year: f('year') || '', publisher: f('publisher') || f('school') || f('institution'), city: f('address'), journal: f('journal') || f('booktitle'), volume: f('volume'), issue: f('number'), pages: f('pages')?.replace('--', '–'), url: f('url'), doi: f('doi'), edition: f('edition') });
  }
  return out;
}

/** Author list for BibTeX: " and " between names, corporate names in braces. */
function bibAuthor(a?: string): string | undefined {
  if (!a?.trim()) return a;
  const people = authorsList(a);
  if (people.length === 1 && people[0].literal) return wholly(a.trim()) ? a.trim() : `{${a.trim()}}`;
  return splitAuthors(a).map((x) => (!wholly(x) && !x.includes(',') && CORPORATE.test(x) ? `{${x}}` : x)).join(' and ');
}

export function toBibtex(list: Source[]): string {
  const map: Record<string, string> = { Book: 'book', 'Journal Article': 'article', 'Conference Proceedings': 'inproceedings', 'Book Section': 'incollection', Thesis: 'phdthesis', Report: 'techreport', 'Web Site': 'online' };
  return list.map((s) => {
    const f: [string, string | undefined][] = [['author', bibAuthor(s.author)], ['title', s.title], ['year', s.year], ['journal', s.journal], ['volume', s.volume], ['number', s.issue], ['pages', s.pages], ['publisher', s.publisher], ['address', s.city], ['url', s.url], ['doi', s.doi]];
    return `@${map[s.type] || 'misc'}{${s.id},\n${f.filter(([, x]) => x).map(([k, x]) => `  ${k} = {${x}}`).join(',\n')}\n}`;
  }).join('\n\n');
}

// ------------------------------------------------------------------------------------------
// Captions, cross-references, index, authorities

def([
  {
    id: 'refs.caption', label: 'Insert Caption…', icon: 'subtitles', tab: 'References', group: 'Captions', edits: true, popular: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Caption', fields: [
        { key: 'label', label: 'Label', type: 'combo', options: ['Figure', 'Table', 'Equation', 'Plate', 'Map', 'Chart', 'Listing', 'Exhibit'], value: app.state.selection instanceof NodeSelection && app.state.selection.node.type === N.table ? 'Table' : 'Figure', half: true },
        { key: 'fmt', label: 'Numbering', type: 'select', options: ['Arabic', 'roman', 'ROMAN', 'alphabetic', 'ALPHABETIC'], value: 'Arabic', half: true },
        { key: 'text', label: 'Caption text', type: 'text', value: '' },
        { key: 'position', label: 'Position', type: 'select', options: [{ value: 'below', label: 'Below selected item' }, { value: 'above', label: 'Above selected item' }], value: 'below' },
        { key: 'excludeLabel', label: 'Exclude label from caption', type: 'checkbox', value: false },
      ] });
      if (!r) return;
      const content: PMNode[] = [];
      if (!r.excludeLabel) content.push(schema.text(r.label + ' '));
      content.push(N.field.create({ type: 'SEQ', arg: r.label, format: r.fmt === 'Arabic' ? null : r.fmt, value: '#' }));
      if (r.text) content.push(schema.text((r.excludeLabel ? ' ' : ': ') + r.text));
      const cap = N.paragraph.create({ style: 'Caption' }, content);
      const st = app.state;
      const $f = st.selection.$from;
      const top = $f.depth >= 1 ? (r.position === 'above' ? $f.before(1) : $f.after(1)) : st.selection.from;
      v(app).dispatch(st.tr.insert(top, cap).scrollIntoView());
      app.updateFields();
    },
  },
  {
    id: 'refs.tof', label: 'Insert Table of Figures', icon: 'image_search', tab: 'References', group: 'Captions', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Table of Figures', fields: [{ key: 'label', label: 'Caption label', type: 'combo', options: ['Figure', 'Table', 'Equation', 'Map', 'Plate'], value: 'Figure' }, { key: 'pages', label: 'Show page numbers', type: 'checkbox', value: true }] });
      if (r) insertGen(app, 'tof', r);
    },
  },
  { id: 'refs.updateTof', label: 'Update Table of Figures', icon: 'sync', tab: 'References', group: 'Captions', edits: true, run: (app) => updateGenerated(app) },
  {
    id: 'refs.crossReference', label: 'Cross-reference…', icon: 'link', tab: 'References', group: 'Captions', edits: true, popular: true,
    run: async (app) => {
      const targets = (doc: PMNode) => {
        const bms: string[] = []; doc.descendants((n) => { if (n.type === N.bookmark) bms.push(n.attrs.name); return true; });
        const caps: { text: string; pos: number; node: PMNode }[] = []; doc.descendants((n, pos) => { if (n.type === N.paragraph && n.attrs.style === 'Caption') caps.push({ text: n.textContent, pos, node: n }); return true; });
        const notes: { text: string; pos: number }[] = []; doc.descendants((n, pos) => { if (n.type === N.footnote) notes.push({ text: n.attrs.text, pos }); return true; });
        return { heads: headingList(doc, 9), bms, caps, notes };
      };
      const before = app.state.doc;
      const { heads, bms, caps, notes } = targets(before);
      const r = await openDialog({ title: 'Cross-reference', wide: true, fields: [
        { key: 'type', label: 'Reference type', type: 'select', options: ['Heading', 'Bookmark', 'Caption', 'Footnote'], value: 'Heading', half: true },
        { key: 'what', label: 'Insert reference to', type: 'select', options: [{ value: 'text', label: 'Text' }, { value: 'page', label: 'Page number' }, { value: 'above', label: 'Above/below' }], value: 'text', half: true },
        { key: 'target', label: 'For which item', type: 'list', rows: 10, options: heads.map((h0, i) => ({ value: 'h' + i, label: '  '.repeat(h0.level - 1) + h0.text })), value: '' },
        { key: 'link', label: 'Insert as hyperlink', type: 'checkbox', value: true },
      ], onChange: (x, ctl, key) => {
        if (key !== 'type') return;
        const opts = x.type === 'Heading' ? heads.map((h0, i) => ({ value: 'h' + i, label: h0.text })) : x.type === 'Bookmark' ? bms.map((b) => ({ value: 'b' + b, label: b })) : x.type === 'Caption' ? caps.map((c, i) => ({ value: 'c' + i, label: c.text })) : notes.map((n, i) => ({ value: 'n' + i, label: `${i + 1}. ${n.text.slice(0, 60)}` }));
        import('../ui/dialog').then(({ setListOptions }) => setListOptions(ctl, 'target', opts));
      } });
      if (!r?.target) return;
      const t = String(r.target);
      // The document may have changed while the dialog was open: resolve the target again in
      // the current state (same kind and index, same text) and build the transaction from it.
      const st = app.state;
      const now = st.doc === before ? { heads, bms, caps, notes } : targets(st.doc);
      const idx = +t.slice(1);
      const same = t[0] === 'h' ? now.heads[idx]?.text === heads[idx]?.text : t[0] === 'c' ? now.caps[idx]?.text === caps[idx]?.text : t[0] === 'n' ? now.notes[idx]?.text === notes[idx]?.text : true;
      if (!same) { toast('The document changed. Choose the cross-reference again.'); return; }
      let name = '', text = '', pos = 0;
      let capId: { pos: number; node: PMNode } | null = null;
      if (t[0] === 'h') { const h0 = now.heads[idx]; text = h0.text; pos = h0.pos; name = slug(h0.text); }
      if (t[0] === 'b') { name = t.slice(1); }
      if (t[0] === 'c') {
        const c = now.caps[idx]; text = c.text.split(':')[0]; pos = c.pos;
        // nav.gotoAnchor resolves paragraph ids, so link to the caption's id (giving it a unique one if needed).
        name = c.node.attrs.id || '';
        if (!name) {
          const used = new Set<string>(); st.doc.descendants((n) => { if (typeof n.attrs?.id === 'string' && n.attrs.id) used.add(n.attrs.id); if (n.type === N.bookmark) used.add(n.attrs.name); return true; });
          const base = 'cap-' + (slug(c.text).slice(0, 30) || 'caption');
          name = base; for (let k = 2; used.has(name); k++) name = `${base}-${k}`;
          capId = { pos: c.pos, node: c.node };
        }
      }
      if (t[0] === 'n') { const nn = now.notes[idx]; text = footnoteLabel(st, nn.pos) || ''; pos = nn.pos; }
      const view = v(app);
      if (t[0] === 'b') {
        insertInline(view, N.field.create({ type: r.what === 'page' ? 'PAGEREF' : 'REF', arg: name }));
        app.updateFields();
        return;
      }
      if (r.what === 'page') text = displayPage(pageOfPos(st, pos), app.settings);
      if (r.what === 'above') text = pos < st.selection.from ? 'above' : 'below';
      const marks = r.link && name ? [schema.marks.link.create({ href: '#' + name })] : [];
      const tr = st.tr;
      if (capId && r.link) tr.setNodeMarkup(capId.pos, undefined, { ...capId.node.attrs, id: name });
      view.dispatch(tr.replaceSelectionWith(schema.text(text || '?', marks), false));
    },
  },
  {
    id: 'refs.markEntry', label: 'Mark Index Entry…', icon: 'bookmark_added', tab: 'References', group: 'Index', keys: ['Alt-Shift-x'], edits: true,
    run: async (app) => {
      const sel = selectedText(app.state).trim();
      const r = await openDialog({ title: 'Mark Index Entry', fields: [
        { key: 'term', label: 'Main entry', type: 'text', value: sel, autofocus: true },
        { key: 'sub', label: 'Subentry', type: 'text', value: '' },
        { key: 'see', label: 'Cross-reference ("See …")', type: 'text', value: '' },
        { key: 'all', label: 'Mark all occurrences of the main entry', type: 'checkbox', value: false },
      ] });
      if (!r?.term) return;
      const { findMatches, buildMatcher } = await import('../editor/plugins/decorations');
      const st = app.state;
      const tr = st.tr;
      const node = () => N.index_entry.create({ term: r.term, sub: r.sub || null, see: r.see || null });
      if (r.all) {
        const ms = findMatches(st.doc, buildMatcher(r.term, false, true, true));
        for (const m of ms.reverse()) tr.insert(m.to, node());
        toast(`${ms.length} entries marked`);
      } else tr.insert(st.selection.to, node());
      v(app).dispatch(tr);
    },
  },
  { id: 'refs.insertIndex', label: 'Insert Index', icon: 'sort_by_alpha', tab: 'References', group: 'Index', edits: true, run: (app) => insertGen(app, 'index') },
  { id: 'refs.updateIndex', label: 'Update Index', icon: 'sync', tab: 'References', group: 'Index', edits: true, run: (app) => updateGenerated(app) },
  {
    id: 'refs.autoMarkIndex', label: 'AutoMark Index from Word List…', icon: 'checklist_rtl', tab: 'References', group: 'Index', edits: true, origin: 'Concordance file',
    run: async (app) => {
      const txt = await promptDialog('AutoMark (Concordance)', 'One term per line (optionally "term<TAB>main:sub"):', '', { type: 'textarea' as any, rows: 10 } as any);
      if (!txt) return;
      const { findMatches, buildMatcher } = await import('../editor/plugins/decorations');
      const st = app.state; const tr = st.tr;
      let n = 0;
      const all: { pos: number; node: PMNode }[] = [];
      for (const line of txt.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const [term, entry] = line.split('\t');
        const [main, sub] = (entry || term).split(':');
        for (const m of findMatches(st.doc, buildMatcher(term, false, false, true))) { all.push({ pos: m.to, node: N.index_entry.create({ term: main, sub: sub || null }) }); n++; }
      }
      for (const a of all.sort((x, y) => y.pos - x.pos)) tr.insert(a.pos, a.node);
      v(app).dispatch(tr);
      toast(`${n} entries marked`);
    },
  },
  {
    id: 'refs.markCitation', label: 'Mark Citation (Authorities)…', icon: 'gavel', tab: 'References', group: 'Table of Authorities', keys: ['Alt-Shift-i'], edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Mark Citation', fields: [
        { key: 'term', label: 'Long citation', type: 'text', value: selectedText(app.state) },
        { key: 'cat', label: 'Category', type: 'combo', options: ['Cases', 'Statutes', 'Other Authorities', 'Rules', 'Treatises', 'Regulations', 'Constitutional Provisions'], value: 'Cases' },
      ] });
      if (r?.term) v(app).dispatch(app.state.tr.insert(app.state.selection.to, N.index_entry.create({ term: r.term, sub: r.cat, kind: 'toa' })));
    },
  },
  { id: 'refs.insertToa', label: 'Insert Table of Authorities', icon: 'balance', tab: 'References', group: 'Table of Authorities', edits: true, run: (app) => insertGen(app, 'toa') },
  { id: 'refs.updateToa', label: 'Update Table of Authorities', icon: 'sync', tab: 'References', group: 'Table of Authorities', edits: true, run: (app) => updateGenerated(app) },
  { id: 'refs.insertEndnotesSection', label: 'Insert Notes Section', icon: 'notes', tab: 'References', group: 'Footnotes', edits: true, run: (app) => insertGen(app, 'endnotes') },
]);
