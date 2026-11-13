/** Tools tab: text clean-up (OCR, typography), transformations, calculations and writing aids. */
import { def } from './registry';
import { trackPositions, type App } from '../app';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { topLevelRange, mapSelectedText, selectedText, docText, countWords, textblocks } from '../editor/ops';
import { evalFormula } from '../editor/fields';
import { openDialog, toast, alertDialog } from '../ui/dialog';
import { h } from '../ui/dom';

const N = schema.nodes;
const v = (app: App) => app.view;

/** Range to operate on: the selected top-level blocks, or the whole document. */
function scope(app: App): { from: number; to: number } {
  const st = app.state;
  if (st.selection.empty) return { from: 0, to: st.doc.content.size };
  const r = topLevelRange(st);
  return { from: r.from, to: r.to };
}

function paragraphsIn(app: App): { node: PMNode; pos: number }[] {
  const { from, to } = scope(app);
  const out: { node: PMNode; pos: number }[] = [];
  app.state.doc.nodesBetween(from, to, (n, pos) => { if (n.type === N.paragraph) { out.push({ node: n, pos }); return false; } return true; });
  return out;
}

/** Replace top-level paragraph run with transformed paragraphs (keeps first paragraph's attrs for new ones). */
function transformParagraphs(app: App, fn: (paras: PMNode[]) => PMNode[]) {
  const st = app.state;
  const { from, to } = scope(app);
  const blocks: PMNode[] = [];
  st.doc.nodesBetween(from, to, (n) => { blocks.push(n); return false; });
  if (!blocks.length || !blocks.every((b) => b.type === N.paragraph)) {
    if (!blocks.every((b) => b.type === N.paragraph)) toast('This tool works on plain paragraphs; tables and lists in the selection were left unchanged.');
  }
  const paras = blocks.filter((b) => b.type === N.paragraph);
  if (!paras.length) return;
  const out = fn(paras);
  if (blocks.every((b) => b.type === N.paragraph)) v(app).dispatch(st.tr.replaceWith(from, to, out.length ? out : [N.paragraph.create()]).scrollIntoView());
}

function textEach(app: App, fn: (t: string) => string) {
  const st = app.state;
  if (st.selection.empty) {
    const tr = st.tr;
    st.doc.descendants((n, pos) => {
      if (!n.isText) return true;
      const t = fn(n.text!);
      if (t !== n.text) tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + n.nodeSize), t ? schema.text(t, n.marks) : []);
      return false;
    });
    if (tr.docChanged) v(app).dispatch(tr);
    return;
  }
  mapSelectedText(v(app), fn);
}

/** Paragraph text with manual line breaks as '\n' (textContent would glue the words on either side). */
const paraText = (p: PMNode) => p.textBetween(0, p.content.size, '\n', (n) => (n.type === N.hard_break ? '\n' : ''));
/** Plain paragraph with the source's attributes; '\n' becomes a manual line break. */
const sameAttrs = (src: PMNode, text: string) => N.paragraph.create(src.attrs, text.split('\n').flatMap((l, i) => [...(i ? [N.hard_break.create()] : []), ...(l ? [schema.text(l)] : [])]));

def([
  {
    id: 'tools.sort', label: 'Sort Paragraphs…', icon: 'sort_by_alpha', tab: 'Tools', group: 'Text', edits: true, popular: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Sort Text', fields: [
        { key: 'type', label: 'Type', type: 'select', options: ['Text', 'Number', 'Date', 'Length'], value: 'Text', half: true },
        { key: 'dir', label: 'Order', type: 'radio', options: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], value: 'asc', half: true },
        { key: 'field', label: 'Sort by field # (separated by tab/comma; 0 = whole paragraph)', type: 'number', value: 0, half: true },
        { key: 'cs', label: 'Case sensitive', type: 'checkbox', value: false, half: true },
      ] });
      if (!r) return;
      const key = (p: PMNode) => { const t = paraText(p); return r.field > 0 ? (t.split(/\t|,/)[r.field - 1] || '').trim() : t; };
      const cmp = (a: string, b: string) => r.type === 'Number' ? (parseFloat(a.replace(/[^\d.-]/g, '')) || 0) - (parseFloat(b.replace(/[^\d.-]/g, '')) || 0) : r.type === 'Date' ? Date.parse(a) - Date.parse(b) : r.type === 'Length' ? a.length - b.length : a.localeCompare(b, undefined, { numeric: true, sensitivity: r.cs ? 'case' : 'base' });
      transformParagraphs(app, (ps) => [...ps].sort((a, b) => (r.dir === 'desc' ? -1 : 1) * cmp(key(a), key(b))));
    },
  },
  { id: 'tools.reverse', label: 'Reverse Paragraph Order', icon: 'swap_vert', tab: 'Tools', group: 'Text', edits: true, run: (app) => transformParagraphs(app, (ps) => [...ps].reverse()) },
  { id: 'tools.shuffle', label: 'Shuffle Paragraphs', icon: 'shuffle', tab: 'Tools', group: 'Text', edits: true, run: (app) => transformParagraphs(app, (ps) => { const a = [...ps]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }) },
  { id: 'tools.dedupe', label: 'Remove Duplicate Paragraphs', icon: 'filter_alt_off', tab: 'Tools', group: 'Text', edits: true, run: (app) => { let n = 0; transformParagraphs(app, (ps) => { const seen = new Set<string>(); return ps.filter((p) => { const k = paraText(p).trim().toLowerCase(); if (k && seen.has(k)) { n++; return false; } seen.add(k); return true; }); }); toast(`${n} duplicate(s) removed`); } },
  {
    id: 'tools.removeEmpty', label: 'Remove Empty Paragraphs', icon: 'format_line_spacing', tab: 'Tools', group: 'Clean Up', edits: true, popular: true,
    run: (app) => {
      const st = app.state; const tr = st.tr; let n = 0;
      const { from, to } = scope(app);
      st.doc.nodesBetween(from, to, (node, pos) => { if (node.type === N.paragraph && !node.textContent.trim() && !node.childCount) { const m = tr.mapping.map(pos); tr.delete(m, m + node.nodeSize); n++; return false; } return node.type !== N.paragraph; });
      if (tr.doc.childCount === 0) tr.insert(0, N.paragraph.create());
      v(app).dispatch(tr); toast(`${n} empty paragraph(s) removed`);
    },
  },
  { id: 'tools.trim', label: 'Trim Leading/Trailing Spaces', icon: 'format_clear', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => transformParagraphs(app, (ps) => ps.map((p) => (paraText(p) === paraText(p).trim() ? p : (p.childCount === 1 && p.firstChild!.isText ? N.paragraph.create(p.attrs, schema.text(paraText(p).trim() || ' ', p.firstChild!.marks)) : p)))) },
  { id: 'tools.collapseSpaces', label: 'Collapse Multiple Spaces', icon: 'space_bar', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => textEach(app, (t) => t.replace(/ {2,}/g, ' ')) },
  { id: 'tools.oneSpaceAfterPeriod', label: 'One Space After Sentences', icon: 'space_bar', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => textEach(app, (t) => t.replace(/([.!?]["'”’)]?) {2,}/g, '$1 ')) },
  {
    id: 'tools.unwrapLines', label: 'Join Broken Lines (Unwrap)', icon: 'wrap_text', tab: 'Tools', group: 'Clean Up', edits: true, popular: true, origin: 'OCR and plain-text cleanup',
    run: async (app) => {
      const r = await openDialog({ title: 'Join Broken Lines', help: 'Merges lines that were broken in the middle of sentences (typical of OCR, PDF copy and e-mail). A paragraph ends where a line ends with . ! ? : or is followed by a blank line or an indented line.', fields: [
        { key: 'dehyph', label: 'Rejoin words hyphenated across lines (exam- ple → example)', type: 'checkbox', value: true },
        { key: 'keepIndent', label: 'Treat indented lines as new paragraphs', type: 'checkbox', value: true },
        { key: 'shortLine', label: 'Lines shorter than this many characters end a paragraph (0 = off)', type: 'number', value: 0 },
      ] });
      if (!r) return;
      transformParagraphs(app, (ps) => {
        const out: PMNode[] = [];
        let buf = '', attrs = ps[0]?.attrs;
        const flush = () => { if (buf) out.push(N.paragraph.create(attrs, schema.text(buf.trim()))); buf = ''; };
        for (const p of ps) {
          const lines = paraText(p).split('\n');
          for (const line of lines) {
            const t = line.replace(/\s+$/, '');
            if (!t.trim()) { flush(); out.push(N.paragraph.create(p.attrs)); continue; }
            if (buf && r.keepIndent && /^\s{2,}|\t/.test(line)) flush();
            if (!buf) { attrs = p.attrs; buf = t.trim(); }
            else if (r.dehyph && /[\p{L}]-$/u.test(buf) && /^\p{Ll}/u.test(t.trim())) buf = buf.slice(0, -1) + t.trim();
            else buf += ' ' + t.trim();
            if (/[.!?:]["'”’)]?$/.test(t) || (r.shortLine && t.length < r.shortLine)) flush();
          }
        }
        flush();
        return out.filter((n, i, a) => !(n.content.size === 0 && a[i - 1]?.content.size === 0));
      });
    },
  },
  {
    id: 'tools.ocrCleanup', label: 'Clean Up OCR Text…', icon: 'document_scanner', tab: 'Tools', group: 'Clean Up', edits: true, popular: true, origin: 'OCR post-processing',
    run: async (app) => {
      const r = await openDialog({ title: 'Clean Up OCR Text', wide: true, fields: [
        { key: 'unwrap', label: 'Join broken lines and rejoin hyphenated words', type: 'checkbox', value: true },
        { key: 'ligatures', label: 'Expand ligature characters (ﬁ ﬂ ﬀ ﬃ ﬄ → fi fl ff ffi ffl)', type: 'checkbox', value: true },
        { key: 'quotes', label: 'Normalize quotes (smart)', type: 'checkbox', value: true },
        { key: 'spaces', label: 'Collapse spaces; remove space before punctuation', type: 'checkbox', value: true },
        { key: 'pageNums', label: 'Remove lines that are only page numbers', type: 'checkbox', value: true },
        { key: 'headers', label: 'Remove repeated running headers/footers (lines seen 3+ times)', type: 'checkbox', value: true },
        { key: 'confusions', label: 'Fix common OCR confusions (rn→m in dictionary-like contexts, 0/O, l/1 in words)', type: 'checkbox', value: false },
        { key: 'control', label: 'Remove control and zero-width characters', type: 'checkbox', value: true },
        { key: 'nfc', label: 'Normalize Unicode (NFC)', type: 'checkbox', value: true },
      ] });
      if (!r) return;
      const lines = paragraphsIn(app).flatMap((p) => paraText(p.node).split('\n'));
      const counts = new Map<string, number>();
      for (const l of lines) { const k = l.trim().replace(/\d+/g, '#'); if (k.length > 3 && k.length < 80) counts.set(k, (counts.get(k) || 0) + 1); }
      transformParagraphs(app, (ps) => {
        let out = ps.map((p) => {
          let t = paraText(p);
          if (r.control) t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​‌‍⁠﻿]/g, '');
          if (r.nfc) t = t.normalize('NFC');
          if (r.ligatures) t = t.replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ|ﬆ/g, 'st');
          if (r.pageNums) t = t.split('\n').filter((l) => !/^\s*(page\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/i.test(l)).join('\n');
          if (r.headers) t = t.split('\n').filter((l) => (counts.get(l.trim().replace(/\d+/g, '#')) || 0) < 3).join('\n');
          if (r.spaces) t = t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1');
          if (r.confusions) t = t.replace(/\b([a-z]*)0([a-z]+)\b/g, '$1o$2').replace(/\b([a-z]+)1([a-z]*)\b/g, '$1l$2');
          if (r.quotes) t = t.replace(/(^|[\s([{])"/g, '$1“').replace(/"/g, '”').replace(/(^|[\s([{])'/g, '$1‘').replace(/'/g, '’');
          return sameAttrs(p, t);
        }).filter((p) => p.textContent.length || true);
        if (r.unwrap) {
          const joined: PMNode[] = [];
          let buf = '';
          const flush = (attrs: any) => { if (buf) joined.push(N.paragraph.create(attrs, schema.text(buf))); buf = ''; };
          for (const p of out) {
            for (const line of paraText(p).split('\n')) {
              const tl = line.trim();
              if (!tl) { flush(p.attrs); continue; }
              if (buf && /[\p{L}]-$/u.test(buf) && /^\p{Ll}/u.test(tl)) buf = buf.slice(0, -1) + tl;
              else buf = buf ? buf + ' ' + tl : tl;
              if (/[.!?:]["'”’)]?$/.test(tl)) flush(p.attrs);
            }
          }
          flush(ps[0].attrs);
          out = joined;
        }
        return out;
      });
      toast('OCR clean-up complete');
    },
  },
  { id: 'tools.dehyphenate', label: 'Remove Line-End Hyphenation', icon: 'horizontal_rule', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => textEach(app, (t) => t.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').replace(/(\p{L})­/gu, '$1')) },
  { id: 'tools.removeLineBreaks', label: 'Remove Manual Line Breaks', icon: 'keyboard_return', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => { const st = app.state; const tr = st.tr; const { from, to } = scope(app); const list: number[] = []; st.doc.nodesBetween(from, to, (n, pos) => { if (n.type === N.hard_break) list.push(pos); return true; }); for (const p of list.reverse()) tr.replaceWith(p, p + 1, schema.text(' ')); v(app).dispatch(tr); toast(`${list.length} line break(s) removed`); } },
  { id: 'tools.smartQuotes', label: 'Convert to Smart Quotes', icon: 'format_quote', tab: 'Tools', group: 'Typography', edits: true, run: (app) => textEach(app, (t) => t.replace(/(^|[\s([{—–-])"/g, '$1“').replace(/"/g, '”').replace(/(^|[\s([{—–-])'/g, '$1‘').replace(/'/g, '’')) },
  { id: 'tools.straightQuotes', label: 'Convert to Straight Quotes', icon: 'format_quote', tab: 'Tools', group: 'Typography', edits: true, run: (app) => textEach(app, (t) => t.replace(/[“”„«»]/g, '"').replace(/[‘’‚‹›]/g, "'")) },
  { id: 'tools.dashes', label: 'Fix Dashes and Ellipses', icon: 'remove', tab: 'Tools', group: 'Typography', edits: true, run: (app) => textEach(app, (t) => t.replace(/---/g, '—').replace(/--/g, '—').replace(/(\d)-(\d)/g, '$1–$2').replace(/ - /g, ' – ').replace(/\.\.\./g, '…')) },
  {
    id: 'tools.typographer', label: 'Typographic Clean-Up (All)', icon: 'auto_fix_high', tab: 'Tools', group: 'Typography', edits: true, origin: 'Publishing typography',
    run: (app) => textEach(app, (t) => t.replace(/ {2,}/g, ' ').replace(/---|--/g, '—').replace(/\.\.\./g, '…').replace(/(\d)-(\d)/g, '$1–$2').replace(/(^|[\s([{—–-])"/g, '$1“').replace(/"/g, '”').replace(/(^|[\s([{—–-])'/g, '$1‘').replace(/'/g, '’').replace(/\(c\)/gi, '©').replace(/\(r\)/gi, '®').replace(/\(tm\)/gi, '™').replace(/(\d) ?x ?(\d)/g, '$1×$2').replace(/(\d+)(st|nd|rd|th)\b/g, '$1$2')),
  },
  {
    id: 'tools.nbspUnits', label: 'Non-Breaking Spaces Before Units/Numbers', icon: 'space_bar', tab: 'Tools', group: 'Typography', edits: true,
    run: (app) => textEach(app, (t) => t.replace(/(\d) (%|°|cm|mm|km|kg|g|lb|lbs|oz|in|ft|mi|pp?\.|AM|PM|a\.m\.|p\.m\.)/g, '$1 $2').replace(/\b(Mr|Mrs|Ms|Dr|St|No|Fig|vol|ch|pp?)\. (?=\S)/g, '$1. ')),
  },
  { id: 'tools.normalize', label: 'Normalize Unicode (NFC)', icon: 'translate', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => textEach(app, (t) => t.normalize('NFC')) },
  { id: 'tools.stripInvisible', label: 'Remove Invisible Characters', icon: 'visibility_off', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => textEach(app, (t) => t.replace(/[​‌‍⁠﻿­]/g, '')) },
  { id: 'tools.tabsToSpaces', label: 'Tabs to Spaces', icon: 'keyboard_tab', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => textEach(app, (t) => t.replace(/\t/g, '    ')) },
  { id: 'tools.spacesToTabs', label: 'Leading Spaces to Tabs', icon: 'keyboard_tab', tab: 'Tools', group: 'Clean Up', edits: true, run: (app) => textEach(app, (t) => t.replace(/^( {4})+/gm, (m) => '\t'.repeat(m.length / 4))) },
  {
    id: 'tools.stripLinks', label: 'Remove All Hyperlinks', icon: 'link_off', tab: 'Tools', group: 'Clean Up', edits: true,
    run: (app) => { const { from, to } = scope(app); v(app).dispatch(app.state.tr.removeMark(from, to, schema.marks.link)); },
  },
  {
    id: 'tools.linkUrls', label: 'Link All URLs and Emails', icon: 'add_link', tab: 'Tools', group: 'Clean Up', edits: true,
    run: async (app) => {
      const { findMatches, buildMatcher } = await import('../editor/plugins/decorations');
      const st = app.state; const tr = st.tr;
      const urls = findMatches(st.doc, buildMatcher('(https?://|www\\.)[^\\s<>()"]+[^\\s<>()".,;:!?]', true, false, false));
      const mails = findMatches(st.doc, buildMatcher('[\\w.+-]+@[\\w-]+\\.[\\w.]+[\\w]', true, false, false));
      for (const m of urls) { const t = st.doc.textBetween(m.from, m.to); tr.addMark(m.from, m.to, schema.marks.link.create({ href: t.startsWith('www.') ? 'https://' + t : t })); }
      for (const m of mails) tr.addMark(m.from, m.to, schema.marks.link.create({ href: 'mailto:' + st.doc.textBetween(m.from, m.to) }));
      v(app).dispatch(tr); toast(`${urls.length + mails.length} link(s) created`);
    },
  },
  {
    id: 'tools.autoFormatNow', label: 'AutoFormat Now', icon: 'auto_awesome', tab: 'Tools', group: 'Typography', edits: true,
    run: (app) => {
      const st = app.state; const tr = st.tr;
      st.doc.forEach((n, p0) => {
        if (n.type !== N.paragraph) return;
        // Earlier '#' deletions shift the document: map positions from st.doc into tr.doc.
        const pos = tr.mapping.map(p0);
        const t = n.textContent;
        const m = /^(#{1,6})\s+/.exec(t);
        if (m) { tr.setNodeMarkup(pos, undefined, { ...n.attrs, style: `Heading ${m[1].length}` }); tr.delete(pos + 1, pos + 1 + m[0].length); return; }
        if (t.length < 70 && /^[A-Z0-9][A-Z0-9 ,.:'’&-]{3,}$/.test(t) && !/[.!?]$/.test(t)) tr.setNodeMarkup(pos, undefined, { ...n.attrs, style: 'Heading 1' });
        else if (/^(chapter|part|section)\s+[\divxlc]+/i.test(t) && t.length < 60) tr.setNodeMarkup(pos, undefined, { ...n.attrs, style: 'Heading 1' });
      });
      v(app).dispatch(tr);
      app.exec('tools.typographer');
      toast('AutoFormat applied: headings detected and typography fixed');
    },
  },
  {
    id: 'tools.markdownToFormat', label: 'Convert Markdown Syntax in Document', icon: 'markdown', tab: 'Tools', group: 'Typography', edits: true, origin: 'Markdown editors',
    run: async (app) => {
      const st = app.state;
      const { from, to } = scope(app);
      const md = st.doc.textBetween(from, to, '\n\n', '');
      const pt = trackPositions(app);
      const { importMarkdown } = await import('../io/markdown');
      const doc = await importMarkdown(new TextEncoder().encode(md).buffer, 'x.md');
      pt.done();
      // Converted from the text as it was: if it was edited meanwhile, converting would lose that edit.
      if (pt.changed) { toast('The document changed during the conversion. Try again.'); return; }
      v(app).dispatch(app.state.tr.replaceWith(from, to, doc.content));
    },
  },
  {
    id: 'tools.hardWrap', label: 'Hard-Wrap Lines at Column…', icon: 'wrap_text', tab: 'Tools', group: 'Text', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Hard Wrap', fields: [{ key: 'col', label: 'Wrap at column', type: 'number', value: 72 }] });
      if (!r) return;
      transformParagraphs(app, (ps) => ps.map((p) => { const words = paraText(p).split(/\s+/); const lines: string[] = []; let cur = ''; for (const w of words) { if ((cur + ' ' + w).trim().length > r.col && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); } lines.push(cur); const kids: PMNode[] = []; lines.forEach((l, i) => { if (i) kids.push(N.hard_break.create()); if (l) kids.push(schema.text(l)); }); return N.paragraph.create(p.attrs, kids); }));
    },
  },
  { id: 'tools.numberLines', label: 'Number Paragraphs (Prefix)', icon: 'format_list_numbered', tab: 'Tools', group: 'Text', edits: true, run: (app) => { let i = 0; transformParagraphs(app, (ps) => ps.map((p) => (p.textContent.trim() ? N.paragraph.create(p.attrs, [schema.text(`${++i}. `), ...((): PMNode[] => { const a: PMNode[] = []; p.forEach((c) => a.push(c)); return a; })()]) : p))); } },
  {
    id: 'tools.prefixSuffix', label: 'Add Prefix/Suffix to Paragraphs…', icon: 'format_quote', tab: 'Tools', group: 'Text', edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Prefix / Suffix', fields: [{ key: 'pre', label: 'Prefix', type: 'text', value: '' }, { key: 'suf', label: 'Suffix', type: 'text', value: '' }, { key: 'skipEmpty', label: 'Skip empty paragraphs', type: 'checkbox', value: true }] });
      if (!r) return;
      transformParagraphs(app, (ps) => ps.map((p) => { if (r.skipEmpty && !p.textContent.trim()) return p; const kids: PMNode[] = []; if (r.pre) kids.push(schema.text(r.pre)); p.forEach((c) => kids.push(c)); if (r.suf) kids.push(schema.text(r.suf)); return N.paragraph.create(p.attrs, kids); }));
    },
  },
  {
    id: 'tools.extract', label: 'Extract Emails / URLs / Numbers…', icon: 'filter_list', tab: 'Tools', group: 'Text',
    run: async (app) => {
      const r = await openDialog({ title: 'Extract', fields: [{ key: 'kind', label: 'Extract', type: 'radio', options: [{ value: 'email', label: 'Email addresses' }, { value: 'url', label: 'Web addresses' }, { value: 'number', label: 'Numbers' }, { value: 'date', label: 'Dates' }, { value: 'caps', label: 'Capitalized names' }, { value: 'regex', label: 'Custom regular expression' }], value: 'email' }, { key: 're', label: 'Regex', type: 'text', value: '', visibleIf: (x) => x.kind === 'regex' }] });
      if (!r) return;
      const res: Record<string, RegExp> = { email: /[\w.+-]+@[\w-]+\.[\w.]+\w/g, url: /(https?:\/\/|www\.)[^\s<>()"]+/g, number: /-?\d[\d,]*(\.\d+)?/g, date: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}\b/g, caps: /\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g };
      let re: RegExp; try { re = r.kind === 'regex' ? new RegExp(r.re, 'g') : res[r.kind]; } catch { toast('Invalid expression.'); return; }
      const found = [...new Set(docText(app.state.doc).match(re) || [])];
      const r2 = await openDialog({ title: `Found ${found.length}`, fields: [{ key: 't', label: 'Results', type: 'textarea', rows: 12, value: found.join('\n') }], ok: 'Insert in New Document', buttons: [{ label: 'Copy', onClick: (x) => { navigator.clipboard?.writeText(x.t); toast('Copied'); } }] });
      if (r2) app.createTab(schema.node('doc', null, found.length ? found.map((f) => N.paragraph.create(null, schema.text(f))) : [N.paragraph.create()]), { title: 'Extracted' });
    },
  },
  {
    id: 'tools.wordFrequency', label: 'Word Frequency', icon: 'bar_chart', tab: 'Tools', group: 'Analyze', origin: 'Concordance tools',
    run: async (app) => {
      const STOP = new Set('the a an and or but of to in on at for with by from as is are was were be been it this that these those i you he she we they not no so if then than there their his her its our your my me him them us'.split(' '));
      const words = (app.state.selection.empty ? docText(app.state.doc) : selectedText(app.state)).toLowerCase().match(/[\p{L}'’]+/gu) || [];
      const counts = new Map<string, number>();
      for (const w of words) if (!STOP.has(w) && w.length > 2) counts.set(w, (counts.get(w) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
      await alertDialog('Word Frequency (excluding common words)', h('table', { class: 'qf-stats' }, ...top.map(([w, n]) => h('tr', null, h('td', null, w), h('td', null, String(n))))));
    },
  },
  {
    id: 'tools.repeatedPhrases', label: 'Find Overused Phrases', icon: 'repeat', tab: 'Tools', group: 'Analyze',
    run: async (app) => {
      const words = docText(app.state.doc).toLowerCase().match(/[\p{L}'’]+/gu) || [];
      const counts = new Map<string, number>();
      for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= words.length; i++) { const k = words.slice(i, i + n).join(' '); counts.set(k, (counts.get(k) || 0) + 1); }
      const top = [...counts.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 40);
      await alertDialog('Repeated Phrases', top.length ? h('table', { class: 'qf-stats' }, ...top.map(([w, c]) => h('tr', null, h('td', null, w), h('td', null, String(c))))) : 'No phrase of 3–5 words appears 3 or more times.');
    },
  },
  {
    id: 'tools.calculate', label: 'Calculate Selection', icon: 'calculate', tab: 'Tools', group: 'Analyze', edits: true, origin: 'Classic word-processor Calculate command',
    run: (app) => {
      const t = selectedText(app.state).trim();
      if (!t) { toast('Select an expression such as 12*(3+4) or a list of numbers.'); return; }
      let val: number;
      try { val = evalFormula(t.replace(/[,$]/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/\n/g, '+')); } catch { const nums = (t.match(/-?\d+(\.\d+)?/g) || []).map(Number); val = nums.reduce((a, b) => a + b, 0); }
      const res = String(Math.round(val * 1e10) / 1e10);
      navigator.clipboard?.writeText(res);
      toast(`= ${res} (copied to clipboard)`, { action: 'Insert', onAction: () => v(app).dispatch(app.state.tr.insertText(` = ${res}`, app.state.selection.to)) });
    },
  },
  {
    id: 'tools.statistics', label: 'Document Statistics', icon: 'analytics', tab: 'Tools', group: 'Analyze',
    run: async (app) => {
      const st = app.state;
      let tables = 0, images = 0, notes = 0, links = 0, fields = 0, headings = 0, comments = Object.keys(app.settings.comments).length;
      st.doc.descendants((n) => { if (n.type === N.table) tables++; if (n.type === N.image) images++; if (n.type === N.footnote) notes++; if (n.type === N.field) fields++; if (n.type === N.paragraph && /^Heading/.test(n.attrs.style)) headings++; if (n.isText && n.marks.some((m) => m.type === schema.marks.link)) links++; return true; });
      const text = docText(st.doc);
      const rows: [string, number | string][] = [['Words', countWords(text)], ['Characters', text.length], ['Paragraphs', textblocks(st.doc).length], ['Headings', headings], ['Tables', tables], ['Pictures', images], ['Footnotes/endnotes', notes], ['Fields', fields], ['Linked runs', links], ['Comments', comments], ['Sources', app.settings.sources.length], ['Approx. size (JSON)', `${Math.round(JSON.stringify(st.doc.toJSON()).length / 1024)} KB`]];
      await alertDialog('Document Statistics', h('table', { class: 'qf-stats' }, ...rows.map(([k, n]) => h('tr', null, h('td', null, k), h('td', null, String(n))))));
    },
  },
  {
    id: 'tools.insertTimestamp', label: 'Insert Timestamp', icon: 'schedule', tab: 'Tools', group: 'Text', keys: ['Mod-Alt-Shift-t'], edits: true, origin: 'Journaling apps',
    run: (app) => v(app).dispatch(app.state.tr.insertText(new Date().toLocaleString() + ' — ').scrollIntoView()),
  },
  {
    id: 'tools.rot13', label: 'ROT13 / Spoiler Encode', icon: 'lock', tab: 'Tools', group: 'Text', edits: true,
    run: (app) => mapSelectedText(v(app), (t) => t.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = String.fromCharCode(c.charCodeAt(0) + 13)).charCodeAt(0) ? c.charCodeAt(0) : c.charCodeAt(0) - 26))),
  },
  { id: 'tools.compareText', label: 'Compare Documents', icon: 'difference', tab: 'Tools', group: 'Analyze', run: (app) => app.exec('review.compare') },
]);
