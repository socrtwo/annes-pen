/**
 * HTML import / export and clipboard clean-up.
 *
 * Export produces a standalone HTML5 document: the document is rendered with the schema's
 * DOMSerializer (see serialize.ts › renderHtml), editor-only artifacts are removed and the
 * style sheet produced by stylesCss() is embedded so paragraph styles look the same as in the
 * editor. Footnotes become an endnotes section with back-links; comments are omitted; tracked
 * deletions are dropped and insertions kept as plain text.
 *
 * Import cleans typical junk (MS Office HTML, Google Docs wrappers, scripts/styles), rewrites a
 * few structures into forms the schema's parse rules understand (Word list paragraphs, footnote
 * links, KaTeX/MathJax math, task lists, nested-list quirks) and then runs
 * DOMParser.fromSchema(schema).
 */
import { stripActiveContent, escHtml } from '../util/sanitize';
import { decodeAuto } from './encoding';
import { applyPageCss, extractHeaderFooter, inlineDocumentCss, moveBlockBackgrounds } from './html-extras';
import { DOMParser as PMDOMParser, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { stylesCss } from '../editor/styles';
import type { ExportOptions } from './index';
import {
  baseCss, canonicalStyleName, collectFootnotes, docSettings, docTitle, escapeHtml, finishDoc, makeBlob, markerFormat,
  newSettings, normalizeImportedFormatting, prepareDoc, renderHtml, toHexColor, utf8Encode, bytesToBase64,
} from './serialize';

// ---------------------------------------------------------------------------------------------
// Decoding

export function decodeHtmlBytes(data: ArrayBuffer): string {
  const u8 = new Uint8Array(data);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch { /* not UTF-8 */ }
  const head = new TextDecoder('windows-1252').decode(u8.subarray(0, 4096));
  const m = /charset\s*=\s*["']?([\w:.-]+)/i.exec(head);
  if (m) {
    try { return new TextDecoder(m[1].toLowerCase()).decode(u8); } catch { /* unknown label */ }
  }
  return decodeAuto(u8);
}

// ---------------------------------------------------------------------------------------------
// Clean-up

/** String-level clean-up applied before DOM parsing. */
function preClean(html: string): string {
  return html
    .replace(/^\uFEFF/, '')
    .replace(/^Version:\d[\s\S]*?(?=<)/, '') // Windows CF_HTML clipboard header
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '') // downlevel-hidden conditional comments (VML, XML islands)
    .replace(/<!\[if[^\]>]*\]>/gi, '') // downlevel-revealed markers (content is kept)
    .replace(/<!\[endif\]>/gi, '')
    .replace(/<\?xml[^>]*>/gi, '')
    .replace(/<\?mso-[^>]*>/gi, '')
    .replace(/<\/?o:p\s*>/gi, '')
    .replace(/<\/?(?:v|w|m|st1|st2|x|dt|wp|a14):[^>]*>/gi, '');
}

/** Block containers counted for the nesting cap. */
const NEST_TAGS = new Set(['OL', 'UL', 'LI', 'DL', 'DD', 'DT', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH', 'PRE', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'MAIN', 'FIGURE', 'DETAILS', 'FIELDSET', 'CENTER', 'FORM']);
const MAX_NEST = 100;
/** Any element nesting (inline markup too) beyond this is flattened as well. */
const MAX_ELEMENT_DEPTH = 400;
const LINE_TAGS = /^(P|DIV|LI|DT|DD|TR|TD|TH|PRE|BLOCKQUOTE|H[1-6]|BR|HR|TABLE|OL|UL|DL|SECTION|ARTICLE)$/;

/**
 * Content nested deeper than real documents go (MAX_NEST block containers, or MAX_ELEMENT_DEPTH
 * elements) becomes plain paragraphs: the clean-up and the schema parser are super-linear on it.
 */
export function capNesting(root: Element): void {
  const doc = root.ownerDocument;
  const deep: Element[] = [];
  const stack: [Element, number, number][] = [[root, 0, 0]];
  while (stack.length) {
    const [el, nest, depth] = stack.pop()!;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      const n = nest + (NEST_TAGS.has(c.tagName) ? 1 : 0);
      if (n > MAX_NEST || depth + 1 > MAX_ELEMENT_DEPTH) deep.push(c);
      else stack.push([c, n, depth + 1]);
    }
  }
  for (const el of deep) {
    // Text by lines: block boundaries and line breaks (and newlines inside <pre>) end a paragraph.
    const lines: string[] = [];
    let cur = '';
    const inPre = el.closest('pre') != null;
    const walk: ([Node, boolean] | null)[] = [[el, inPre]];
    while (walk.length) {
      const w = walk.pop();
      if (w === null) { lines.push(cur); cur = ''; continue; }
      const [n, pre] = w!;
      if (n.nodeType === 3) {
        const t = n.nodeValue || '';
        if (pre && t.includes('\n')) { const parts = t.split('\n'); cur += parts[0]; for (const q of parts.slice(1)) { lines.push(cur); cur = q; } }
        else cur += pre ? t : t.replace(/\s+/g, ' ');
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = (n as Element).tagName;
      const block = LINE_TAGS.test(tag);
      if (block) walk.push(null);
      const kidPre = pre || tag === 'PRE';
      for (let k = n.childNodes.length - 1; k >= 0; k--) walk.push([n.childNodes[k], kidPre]);
      if (block && cur) { lines.push(cur); cur = ''; }
    }
    lines.push(cur);
    const frag = doc.createDocumentFragment();
    for (const l of lines) {
      if (!l.trim()) continue;
      const p = doc.createElement('p');
      p.textContent = l;
      frag.appendChild(p);
    }
    el.replaceWith(frag);
  }
}

const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'CODE', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TT', 'U', 'VAR']);
const MAX_INLINE = 200;
/** Lower caps where deeper nesting means nothing in the document model (quotes and code are flattened). */
const TAG_NEST: Record<string, number> = { BLOCKQUOTE: 4, PRE: 2 };
const LINE_BREAK_TAGS = new Set(['LI', 'DT', 'DD', 'PRE', 'BLOCKQUOTE', 'DIV']);

/**
 * The same cap on the markup before parsing (HTML parsers are quadratic in nesting depth too):
 * container tags past MAX_NEST open levels are dropped with their end tags, leaving their text
 * (in a new paragraph where the tag started a block).
 * Implied ends (a new <li> ends the open one, and so on) are followed so long flat lists stay intact.
 */
export function capNestingSource(html: string): string {
  const stack: string[] = [];
  const dropped = new Map<string, number>();
  const implied: Record<string, string[]> = { LI: ['LI'], DT: ['DT', 'DD'], DD: ['DT', 'DD'], TD: ['TD', 'TH'], TH: ['TD', 'TH'], TR: ['TD', 'TH', 'TR'] };
  let changed = false;
  const inline: string[] = [];
  const out = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, close: string, name: string) => {
    const tag = name.toUpperCase();
    if (INLINE_TAGS.has(tag)) {
      // Formatting tags are normally closed explicitly; past MAX_INLINE open ones they are dropped.
      if (!close) {
        if (inline.length >= MAX_INLINE) { dropped.set(tag, (dropped.get(tag) || 0) + 1); changed = true; return ''; }
        inline.push(tag);
        return m;
      }
      const d = dropped.get(tag) || 0;
      if (d > 0) { dropped.set(tag, d - 1); return ''; }
      const at = inline.lastIndexOf(tag);
      if (at >= 0) inline.length = at;
      return m;
    }
    if (!NEST_TAGS.has(tag)) return m;
    if (!close) {
      const ends = implied[tag];
      if (ends) while (stack.length && ends.includes(stack[stack.length - 1])) stack.pop();
      if (stack.length >= MAX_NEST || (TAG_NEST[tag] != null && stack.filter((t) => t === tag).length >= TAG_NEST[tag])) {
        dropped.set(tag, (dropped.get(tag) || 0) + 1);
        changed = true;
        return LINE_BREAK_TAGS.has(tag) ? '<p>' : '';
      }
      stack.push(tag);
      return m;
    }
    const d = dropped.get(tag) || 0;
    if (d > 0) { dropped.set(tag, d - 1); return ''; }
    const at = stack.lastIndexOf(tag);
    if (at >= 0) stack.length = at;
    return m;
  });
  return changed ? out : html;
}

const REMOVE_SELECTOR = 'script:not([type^="math/tex"]), style, meta, link, title, noscript, template, iframe, object, embed, xml, head, canvas, video, audio, select, textarea, map, area, svg title';

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  // One insertion of all children (moving them one by one is quadratic in some DOMs).
  const frag = el.ownerDocument.createDocumentFragment();
  while (el.firstChild) frag.appendChild(el.firstChild);
  parent.replaceChild(frag, el);
}

function rename(el: Element, tag: string): Element {
  const doc = el.ownerDocument;
  const n = doc.createElement(tag);
  for (const a of Array.from(el.attributes)) {
    try { n.setAttribute(a.name, a.value); } catch { /* invalid attribute name */ }
  }
  while (el.firstChild) n.appendChild(el.firstChild);
  el.parentNode?.replaceChild(n, el);
  return n;
}

function styleOf(el: Element): string {
  return (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
}

/** Remove declarations we never want (mso-*, junk colors, inherit fonts). */
function cleanStyleAttr(el: HTMLElement): void {
  const raw = el.getAttribute('style');
  if (raw == null) return;
  const decls = raw.split(';').map((d) => d.trim()).filter(Boolean);
  const keep: string[] = [];
  for (const d of decls) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    const prop = d.slice(0, i).trim().toLowerCase();
    const val = d.slice(i + 1).trim();
    const lv = val.toLowerCase();
    if (prop.startsWith('mso-') || prop.startsWith('-qt-') || prop === 'tab-stops' || prop === 'text-autospace' || prop === 'layout-grid-mode' ||
      prop === 'font-variant-east-asian' || prop === 'font-variant-alternates' || prop === 'font-variant-numeric' || prop === 'font-variant-position' ||
      prop === 'white-space' || prop === 'text-wrap' || prop === 'word-spacing' && lv === 'normal') continue;
    if (prop === 'color') {
      const hex = toHexColor(val);
      if (!hex || hex === '#000000') continue;
    }
    if (prop === 'background-color' || prop === 'background') {
      const hex = toHexColor(val);
      if (!hex || hex === '#ffffff') continue;
      keep.push(`background-color:${hex}`);
      continue;
    }
    if (prop === 'font-family' && /^(inherit|initial|unset|var\()/.test(lv)) continue;
    if (prop === 'font-size' && !/^[\d.]+(pt|px|em|rem|in|cm|mm|pc)$/.test(lv)) continue;
    if ((prop === 'font-weight' || prop === 'font-style') && /^(inherit|initial)$/.test(lv)) continue;
    if (prop === 'text-decoration' && lv === 'none') continue;
    if (prop === 'vertical-align' && lv === 'baseline') continue;
    if (prop === 'line-height' && /%$/.test(lv)) { const n = parseFloat(lv); if (n) keep.push(`line-height:${Math.round(n) / 100}`); continue; }
    keep.push(`${prop}:${val}`);
  }
  if (keep.length) el.setAttribute('style', keep.join(';')); else el.removeAttribute('style');
}

const BULLET_RE = /^[\s\u00a0]*[\u2022\u25cf\u25e6\u25aa\u25a0\u25a1\u2023\u2043\u2219\u00b7\u00a7\u2013\u2014\u27a2\u2713\u2714\u25c6\u25c7\u2666\u00d8\-*o\uf0b7\uf0a7\uf0d8\uf076\uf0fc]+[\s\u00a0]*$/;

/** Convert Word "MsoListParagraph" sequences (mso-list: l0 level1 lfo1) into real nested lists. */
function convertWordLists(root: Element): void {
  const doc = root.ownerDocument;
  const paras = Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6')).filter((p) => /mso-list:\s*l\d+/i.test(p.getAttribute('style') || '') && !/mso-list:\s*ignore/i.test(p.getAttribute('style') || ''));
  const done = new Set<Element>();
  for (const first of paras) {
    if (done.has(first)) continue;
    // Collect the run of adjacent list paragraphs.
    const run: Element[] = [first];
    done.add(first);
    let next = first.nextElementSibling;
    while (next && paras.includes(next) && !done.has(next)) {
      run.push(next); done.add(next); next = next.nextElementSibling;
    }
    const entries = run.map((p) => {
      const st = p.getAttribute('style') || '';
      const lvl = /level(\d+)/i.exec(st);
      let marker = '';
      p.querySelectorAll('span').forEach((s) => {
        if (/mso-list:\s*ignore/i.test(s.getAttribute('style') || '')) { if (!marker) marker = (s.textContent || '').trim(); s.remove(); }
      });
      if (!marker) {
        // Some exporters put the marker as a leading text run.
        const t = (p.textContent || '').trim();
        const mm = /^([\u2022\u00b7o§\-*]|\(?\w{1,4}[.)])\s+/.exec(t);
        if (mm) marker = mm[1];
      }
      const fmt = BULLET_RE.test(marker) || !marker ? { ordered: false, format: 'disc', start: 1 } : markerFormat(marker);
      return { p, level: lvl ? parseInt(lvl[1], 10) : 1, fmt };
    });
    // Build nested lists in DOM.
    const stack: { level: number; el: Element; ordered: boolean }[] = [];
    const container = doc.createElement('div');
    first.parentNode!.insertBefore(container, first);
    for (const e of entries) {
      while (stack.length && stack[stack.length - 1].level > e.level) stack.pop();
      let cur = stack[stack.length - 1];
      if (cur && cur.level === e.level && cur.ordered !== e.fmt.ordered) { stack.pop(); cur = stack[stack.length - 1]; }
      if (!cur || cur.level < e.level) {
        const list = doc.createElement(e.fmt.ordered ? 'ol' : 'ul');
        if (e.fmt.ordered) {
          if (e.fmt.start !== 1) list.setAttribute('start', String(e.fmt.start));
          if (e.fmt.format !== 'decimal') list.setAttribute('data-format', e.fmt.format);
        }
        if (cur) {
          let li = cur.el.lastElementChild;
          if (!li) { li = doc.createElement('li'); li.appendChild(doc.createElement('p')); cur.el.appendChild(li); }
          li.appendChild(list);
        } else container.appendChild(list);
        cur = { level: e.level, el: list, ordered: e.fmt.ordered };
        stack.push(cur);
      }
      const li = doc.createElement('li');
      const isHeading = /^H\d$/.test(e.p.tagName);
      const p = doc.createElement(isHeading ? e.p.tagName.toLowerCase() : 'p');
      while (e.p.firstChild) p.appendChild(e.p.firstChild);
      const st = (e.p.getAttribute('style') || '').replace(/mso-list:[^;]*;?/gi, '').replace(/(margin-left|text-indent):[^;]*;?/gi, '');
      if (st.trim()) p.setAttribute('style', st);
      li.appendChild(p);
      cur.el.appendChild(li);
      e.p.remove();
    }
    unwrap(container);
  }
}

/** Find footnote references whose targets are notes in the same document and convert them. */
function convertFootnotes(root: Element): void {
  const doc = root.ownerDocument;
  const byId = (id: string): Element | null => {
    if (!id) return null;
    try {
      return root.querySelector(`[id="${id.replace(/["\\]/g, '\\$&')}"]`) || root.querySelector(`a[name="${id.replace(/["\\]/g, '\\$&')}"]`);
    } catch { return null; }
  };
  const isNoteContainer = (el: Element | null): Element | null => {
    let e: Element | null = el;
    while (e && e !== root) {
      if (/^(SUP|SUB|SPAN|A|EM|STRONG|B|I|U|SMALL)$/.test(e.tagName)) { e = e.parentElement; continue; }
      const cls = (e.getAttribute('class') || '').toLowerCase();
      const et = (e.getAttribute('epub:type') || e.getAttribute('role') || '').toLowerCase();
      const st = styleOf(e);
      if (/footnote|endnote|rearnote/.test(et) || /\b(footnotes?|endnotes?|notes)\b/.test(cls) || st.includes('mso-element:footnote') || st.includes('mso-element:endnote') ||
        (e.tagName === 'ASIDE' && /note/.test(et + cls))) return e;
      if (/^(_?ftn|_?edn|fn|(?:sd)?footnote|(?:sd)?endnote|note)[-_:]?\d+(sym|anc)?$/i.test(e.id || '')) return e;
      e = e.parentElement;
    }
    return null;
  };
  const anchors = Array.from(root.querySelectorAll('a[href^="#"]'));
  const removeTargets = new Set<Element>();
  for (const a of anchors) {
    if (!a.isConnected) continue;
    const id = safeDecode((a.getAttribute('href') || '').slice(1));
    const et = (a.getAttribute('epub:type') || a.getAttribute('role') || '').toLowerCase();
    const cls = (a.getAttribute('class') || '').toLowerCase();
    const looksRef = /noteref/.test(et) || /footnote-ref|fnref|noteref|footnote/.test(cls) || /^(_?ftn|_?edn|fn|(?:sd)?footnote|(?:sd)?endnote|note)[-_:]?\d+(sym|anc)?$/i.test(id) ||
      (a.parentElement?.tagName === 'SUP') || !!a.querySelector('sup, .MsoFootnoteReference, .MsoEndnoteReference');
    if (!looksRef) continue;
    if (isNoteContainer(a)) continue; // a back-link inside the notes themselves
    const target = byId(id);
    if (!target) continue;
    // The note body: the closest li/aside/div/p holding the target.
    let body: Element = target;
    if (target.tagName === 'A' && !target.textContent?.trim().length) body = target.parentElement || target;
    const holder = target.closest('li, aside, div[id], p') || body;
    const container = isNoteContainer(holder) || (holder.tagName === 'LI' || holder.tagName === 'ASIDE' ? holder : null);
    if (!container && !/^(_?ftn|_?edn|fn|(?:sd)?footnote|(?:sd)?endnote|note)/i.test(id)) continue;
    const noteEl = holder.tagName === 'A' ? (holder.parentElement || holder) : holder;
    const clone = noteEl.cloneNode(true) as Element;
    // Strip back-links and labels.
    let removedLabel = false;
    clone.querySelectorAll('a').forEach((x) => {
      const h = x.getAttribute('href') || '';
      const r = (x.getAttribute('role') || x.getAttribute('epub:type') || '').toLowerCase();
      const c = (x.getAttribute('class') || '').toLowerCase();
      if (/backlink/.test(r) || /footnote-back|fn-back|backref/.test(c) || (h.startsWith('#') && byId(h.slice(1)) && (a.id === h.slice(1) || a.getAttribute('name') === h.slice(1) || isNoteContainer(byId(h.slice(1))) === null)) || /^[\s↩↑⤴︎\u21a9\ufe0e]*$/.test(x.textContent || '')) {
        if ((x.textContent || '').trim()) removedLabel = true;
        x.remove();
      }
    });
    clone.querySelectorAll('.MsoFootnoteReference, .MsoEndnoteReference').forEach((x) => x.remove());
    const paras = clone.querySelectorAll('p');
    let text = paras.length ? Array.from(paras).map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n') : (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (!removedLabel) text = text.replace(/^\[?\(?\d{1,4}[\])]?[.:]?\s+/, '');
    text = text.replace(/^[\s.:]+/, '').replace(/\s*[↩\u21a9\ufe0e]+\s*$/, '').trim();
    const isEnd = /edn|endnote/i.test(id) || (a.parentElement?.getAttribute('data-kind') === 'end') || /endnote/i.test((container?.getAttribute('class') || '') + (container?.getAttribute('epub:type') || '')) || noteEl.getAttribute('data-kind') === 'end';
    const sup = doc.createElement('sup');
    sup.className = 'qf-fn';
    sup.setAttribute('data-text', text);
    sup.setAttribute('data-kind', isEnd ? 'end' : 'foot');
    const refHolder = a.parentElement && a.parentElement.tagName === 'SUP' && a.parentElement.childNodes.length === 1 ? a.parentElement : a;
    refHolder.parentNode?.replaceChild(sup, refHolder);
    removeTargets.add(noteEl);
    if (container) removeTargets.add(container);
  }
  for (const t of removeTargets) {
    if (!t.isConnected) continue;
    // Remove the container only if no unconverted links remain inside.
    t.remove();
  }
  // Remove empty footnote sections (and their separator rules).
  root.querySelectorAll('section.footnotes, div.footnotes, section[role="doc-endnotes"], div[style]').forEach((s) => {
    if (s.tagName === 'DIV' && !/mso-element:(footnote|endnote)-list/.test(styleOf(s))) return;
    if (!(s.textContent || '').trim() && !s.querySelector('img')) s.remove();
  });
}

function latexFromMath(el: Element): string {
  const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"], annotation');
  if (ann && ann.textContent) return ann.textContent.trim();
  const alt = el.getAttribute('alttext') || el.getAttribute('data-latex');
  if (alt) return alt;
  return (el.textContent || '').trim();
}

/** DOM-level clean-up of pasted or imported HTML (operates in place). */
const safeDecode = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };

export interface CleanOptions {
  /** Keep <img src="cid:…"> (inline attachments of an email body being edited for its mail app). */
  keepCidImages?: boolean;
}

export function cleanHtmlDom(root: HTMLElement, opts: CleanOptions = {}): void {
  const doc = root.ownerDocument;
  stripActiveContent(root);
  // Whitespace that the page keeps (white-space:pre*, and our own export, whose style sheet sets
  // pre-wrap on text) is kept on import: tabs, space runs, leading spaces.
  const keepWs = new Set<Element>();
  root.querySelectorAll('[style*="white-space"]').forEach((el) => { if (/white-space\s*:\s*(pre|break-spaces)/i.test(el.getAttribute('style') || '')) keepWs.add(el); });
  root.querySelectorAll('.qf-doc p, .qf-doc h1, .qf-doc h2, .qf-doc h3, .qf-doc h4, .qf-doc h5, .qf-doc h6').forEach((el) => keepWs.add(el));
  // A line break that ends a block adds no line (browsers ignore it): our export writes one in empty paragraphs.
  root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th').forEach((el) => {
    const last = el.lastChild;
    if (last && last.nodeType === 1 && (last as Element).tagName === 'BR' && !(last as Element).getAttribute('style') && !(last as Element).getAttribute('class')) last.remove();
  });
  const raw = root.innerHTML;
  const isWord = /mso-|class="?Mso|urn:schemas-microsoft-com/i.test(raw);
  // <ol start=""> (or any non-number) would give the list a NaN start.
  root.querySelectorAll('ol[start]').forEach((ol) => { if (!/^\s*-?\d+\s*$/.test(ol.getAttribute('start') || '')) ol.removeAttribute('start'); });

  // Math first (MathJax uses <script type="math/tex">).
  root.querySelectorAll('script[type^="math/tex"]').forEach((s) => {
    const display = /mode=display/.test(s.getAttribute('type') || '');
    const el = doc.createElement(display ? 'div' : 'span');
    el.className = display ? 'qf-math' : 'qf-math-inline';
    el.setAttribute('data-latex', (s.textContent || '').trim());
    s.replaceWith(el);
  });
  root.querySelectorAll('.MathJax, .MathJax_Preview, .MathJax_Display, mjx-container').forEach((m) => {
    if (m.tagName === 'MJX-CONTAINER') {
      const latex = latexFromMath(m);
      const display = m.getAttribute('display') === 'true';
      const el = doc.createElement(display ? 'div' : 'span');
      el.className = display ? 'qf-math' : 'qf-math-inline';
      el.setAttribute('data-latex', latex);
      m.replaceWith(el);
    } else m.remove();
  });
  root.querySelectorAll('.katex-display').forEach((k) => {
    const el = doc.createElement('div');
    el.className = 'qf-math';
    el.setAttribute('data-latex', latexFromMath(k));
    k.replaceWith(el);
  });
  root.querySelectorAll('.katex').forEach((k) => {
    const el = doc.createElement('span');
    el.className = 'qf-math-inline';
    el.setAttribute('data-latex', latexFromMath(k));
    k.replaceWith(el);
  });
  root.querySelectorAll('math').forEach((m) => {
    const display = m.getAttribute('display') === 'block';
    const el = doc.createElement(display ? 'div' : 'span');
    el.className = display ? 'qf-math' : 'qf-math-inline';
    el.setAttribute('data-latex', latexFromMath(m));
    m.replaceWith(el);
  });
  root.querySelectorAll('div.math[data-latex], div.math-display, .math.display').forEach((m) => {
    const el = doc.createElement('div');
    el.className = 'qf-math';
    el.setAttribute('data-latex', m.getAttribute('data-latex') || (m.textContent || '').trim().replace(/^\\\[|\\\]$/g, '').replace(/^\$\$|\$\$$/g, '').trim());
    m.replaceWith(el);
  });
  root.querySelectorAll('span.math[data-latex], span.math, span.math-inline').forEach((m) => {
    if (!m.isConnected) return;
    const el = doc.createElement('span');
    el.className = 'qf-math-inline';
    el.setAttribute('data-latex', m.getAttribute('data-latex') || (m.textContent || '').trim().replace(/^\\\(|\\\)$/g, '').replace(/^\$|\$$/g, '').trim());
    m.replaceWith(el);
  });

  // Junk elements.
  root.querySelectorAll(REMOVE_SELECTOR).forEach((e) => e.remove());
  root.querySelectorAll('[style]').forEach((e) => {
    const st = styleOf(e);
    if (st.includes('mso-hide:all') || /(^|;)display:none/.test(st)) e.remove();
  });
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src || /^(file|blob|about):/i.test(src) || (/^cid:/i.test(src) && !opts.keepCidImages)) img.remove();
  });

  // Inline SVG → image.
  root.querySelectorAll('svg').forEach((svg) => {
    try {
      if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const xml = new XMLSerializer().serializeToString(svg);
      const img = doc.createElement('img');
      img.setAttribute('src', 'data:image/svg+xml;base64,' + bytesToBase64(utf8Encode(xml)));
      const w = parseFloat(svg.getAttribute('width') || ''), h = parseFloat(svg.getAttribute('height') || '');
      if (w) img.setAttribute('width', String(w));
      if (h) img.setAttribute('height', String(h));
      svg.replaceWith(img);
    } catch { svg.remove(); }
  });

  // Google Docs wrapper: <b style="font-weight:normal" id="docs-internal-guid-...">.
  root.querySelectorAll('b[id^="docs-internal-guid"], span[id^="docs-internal-guid"]').forEach(unwrap);
  root.querySelectorAll('b, strong').forEach((b) => { if (/font-weight:(normal|400)/.test(styleOf(b))) unwrap(b); });
  root.querySelectorAll('[id^="docs-internal-guid"]').forEach((e) => e.removeAttribute('id'));
  root.querySelectorAll('[dir="ltr"]').forEach((e) => e.removeAttribute('dir'));

  // <font> → span.
  root.querySelectorAll('font').forEach((f) => {
    const span = doc.createElement('span');
    const st: string[] = [];
    const face = f.getAttribute('face');
    const color = f.getAttribute('color');
    const size = f.getAttribute('size');
    if (face) st.push(`font-family:${face}`);
    if (color) st.push(`color:${color}`);
    if (size && /^[+-]?\d$/.test(size)) {
      const n = size.startsWith('+') || size.startsWith('-') ? 3 + parseInt(size, 10) : parseInt(size, 10);
      st.push(`font-size:${[8, 10, 12, 14, 18, 24, 36][Math.max(1, Math.min(7, n)) - 1]}pt`);
    }
    if (f.getAttribute('style')) st.push(f.getAttribute('style')!);
    if (st.length) span.setAttribute('style', st.join(';'));
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
  });
  root.querySelectorAll('center').forEach(unwrap);

  // MS Office specifics.
  if (isWord) {
    convertWordLists(root);
    root.querySelectorAll('span').forEach((s) => {
      const st = styleOf(s);
      if (st.includes('mso-tab-count')) { s.replaceWith(doc.createTextNode('\t')); return; }
      if (st.includes('mso-field-code')) s.remove();
    });
    root.querySelectorAll('[lang]').forEach((e) => e.removeAttribute('lang'));
    root.querySelectorAll('[class]').forEach((e) => {
      const cls = e.getAttribute('class') || '';
      const m = /\bMso(\w+)/.exec(cls);
      if (m && (e.tagName === 'P' || e.tagName === 'DIV') && !e.hasAttribute('data-style')) {
        const name = canonicalStyleName('Mso' + m[1]);
        if (name && name !== 'Normal' && name !== 'List Paragraph') e.setAttribute('data-style', name);
      }
      if (/\bMso/.test(cls)) e.removeAttribute('class');
    });
  }
  root.querySelectorAll('a[name]:not([href])').forEach((a) => {
    const name = a.getAttribute('name') || '';
    if (/^_GoBack$/i.test(name)) { unwrap(a); return; }
    if (/^_(ftn|edn)/i.test(name)) return; // footnote targets are handled below
    if (!a.id) a.setAttribute('id', name);
  });

  // Page / section breaks.
  root.querySelectorAll('br').forEach((br) => {
    const st = styleOf(br);
    if (st.includes('page-break-before:always') || st.includes('break-before:page')) {
      const d = doc.createElement('div');
      d.className = 'qf-page-break';
      br.replaceWith(d);
    }
  });
  root.querySelectorAll('div.page-break, div.pagebreak, hr.page-break, hr.pagebreak, div[style*="page-break-after"], div[style*="break-after"]').forEach((d) => {
    const st = styleOf(d);
    if (d.classList.contains('page-break') || d.classList.contains('pagebreak') || ((st.includes('page-break-after:always') || st.includes('break-after:page')) && !(d.textContent || '').trim())) {
      const n = doc.createElement('div');
      n.className = 'qf-page-break';
      d.replaceWith(n);
    }
  });
  root.querySelectorAll('div.section-break').forEach((d) => {
    const n = doc.createElement('div');
    n.className = 'qf-section-break';
    n.setAttribute('data-kind', d.getAttribute('data-kind') || 'nextPage');
    d.replaceWith(n);
  });
  root.querySelectorAll('div.column-break').forEach((d) => { const n = doc.createElement('div'); n.className = 'qf-column-break'; d.replaceWith(n); });

  // Footnotes.
  convertFootnotes(root);

  // Bookmarks.
  root.querySelectorAll('a.bookmark, a[data-name]:not([href])').forEach((a) => {
    a.classList.add('qf-bookmark');
    if (!a.getAttribute('data-name')) a.setAttribute('data-name', (a.id || '').replace(/^bm-/, ''));
  });
  root.querySelectorAll('a[id]:not([href]):not(.qf-bookmark)').forEach((a) => {
    if ((a.textContent || '').trim()) { unwrap(a); return; }
    a.classList.add('qf-bookmark');
    a.setAttribute('data-name', (a.id || '').replace(/^bm-/, ''));
  });
  root.querySelectorAll('a[name]:not([href]):not(.qf-bookmark)').forEach(unwrap);

  // Task lists.
  const anyBox = !!root.querySelector('input[type="checkbox"]');
  root.querySelectorAll('ul, ol').forEach((list) => {
    // Without any checkbox only the class or data-type can make a task list (and the per-item search is skipped).
    if (!anyBox && !(list.getAttribute('data-type') === 'task' || list.classList.contains('task-list') || list.classList.contains('contains-task-list'))) return;
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
    if (!items.length) return;
    const boxOf = (li: Element): HTMLInputElement | null => {
      const box = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!box) return null;
      // Must be the first meaningful thing in the item.
      const firstText = (() => {
        const walker = li.ownerDocument.createTreeWalker(li, 5 /* element + text */);
        let n: Node | null = walker.nextNode();
        while (n) {
          if (n === box) return true;
          if (n.nodeType === 3 && (n.textContent || '').trim()) return false;
          n = walker.nextNode();
        }
        return false;
      })();
      return firstText ? box : null;
    };
    const isTask = list.getAttribute('data-type') === 'task' || list.classList.contains('task-list') || list.classList.contains('contains-task-list') || items.every((li) => boxOf(li));
    if (!isTask) return;
    if (list.tagName === 'OL') list = rename(list, 'ul');
    list.setAttribute('data-type', 'task');
    for (const li of Array.from(list.children).filter((c) => c.tagName === 'LI')) {
      const box = boxOf(li);
      if (box) {
        li.setAttribute('data-checked', String(box.checked || box.hasAttribute('checked')));
        box.remove();
      } else if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
    }
  });
  root.querySelectorAll('input[type="checkbox"]').forEach((b) => {
    b.replaceWith(doc.createTextNode((b as HTMLInputElement).checked || b.hasAttribute('checked') ? '☒ ' : '☐ '));
  });
  root.querySelectorAll('input, button, label, form, fieldset, legend').forEach((e) => {
    if (e.tagName === 'INPUT') { const v = (e as HTMLInputElement).value; e.replaceWith(doc.createTextNode(v || '')); } else unwrap(e);
  });

  // Lists nested directly in lists (Google Docs, some editors): move into the previous item.
  root.querySelectorAll('ul > ul, ul > ol, ol > ol, ol > ul').forEach((inner) => {
    const prev = inner.previousElementSibling;
    if (prev && prev.tagName === 'LI') prev.appendChild(inner);
    else {
      const li = doc.createElement('li');
      li.appendChild(doc.createElement('p'));
      inner.parentNode!.insertBefore(li, inner);
      li.appendChild(inner);
    }
  });
  // Google Docs marks nesting with aria-level on flat items.
  root.querySelectorAll('li[aria-level]').forEach((li) => li.removeAttribute('aria-level'));

  // Blockquotes holding blocks: style the paragraphs as quotes and unwrap.
  const quotes = Array.from(root.querySelectorAll('blockquote')).reverse();
  for (const q of quotes) {
    // Sibling walks rather than .children/.childNodes: those are live lists that every later move must update.
    let hasBlocks = false;
    for (let c = q.firstElementChild; c && !hasBlocks; c = c.nextElementSibling) hasBlocks = /^(P|DIV|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE|FIGURE|HR)$/.test(c.tagName);
    if (!hasBlocks) continue;
    for (let c = q.firstChild, next = c?.nextSibling ?? null; c; c = next, next = c?.nextSibling ?? null) {
      if (c.nodeType === 3 && (c.textContent || '').trim()) {
        const p = doc.createElement('p');
        p.setAttribute('data-style', 'Quote');
        q.insertBefore(p, c);
        p.appendChild(c);
      } else if (c.nodeType === 1) {
        const el = c as Element;
        if ((el.tagName === 'P' || el.tagName === 'DIV') && !el.hasAttribute('data-style')) {
          const p = el.tagName === 'DIV' && !Array.from(el.children).some((x) => /^(P|DIV|UL|OL|TABLE)$/.test(x.tagName)) ? rename(el, 'p') : el;
          if (p.tagName === 'P') p.setAttribute('data-style', 'Quote');
        }
      }
    }
    unwrap(q);
  }

  // Code blocks: language from <code class="language-x">.
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code[class*="language-"], code[class*="lang-"]');
    if (code && !pre.getAttribute('data-language')) {
      const m = /(?:language|lang)-([\w+#.-]+)/.exec(code.getAttribute('class') || '');
      if (m) pre.setAttribute('data-language', m[1]);
    }
  });

  // Definition lists, figures, captions.
  root.querySelectorAll('dt, dd').forEach((d) => {
    const p = rename(d, 'p');
    if (d.tagName === 'DD') p.setAttribute('style', 'margin-left:36pt');
    else p.innerHTML = `<strong>${p.innerHTML}</strong>`;
  });
  root.querySelectorAll('dl').forEach(unwrap);
  root.querySelectorAll('figcaption, caption').forEach((c) => {
    if (c.tagName === 'CAPTION') {
      const table = c.closest('table');
      const p = doc.createElement('p');
      p.setAttribute('data-style', 'Caption');
      while (c.firstChild) p.appendChild(c.firstChild);
      c.remove();
      table?.parentNode?.insertBefore(p, table.nextSibling);
      return;
    }
    const p = rename(c, 'p');
    p.setAttribute('data-style', 'Caption');
  });

  // Spans past the table's grid (colspan="99999") would make the table that big: clamp them to it.
  root.querySelectorAll('table').forEach((tbl) => {
    const rows = Array.from((tbl as HTMLTableElement).rows || []);
    let width = 0;
    tbl.querySelectorAll(':scope > col, :scope > colgroup > col').forEach(() => { width++; });
    for (const r of rows) width = Math.max(width, r.cells.length);
    rows.forEach((r, ri) => {
      for (const c of Array.from(r.cells)) {
        const cs = parseInt(c.getAttribute('colspan') || '1', 10);
        if (cs > width) c.setAttribute('colspan', String(Math.max(1, width)));
        const rs = parseInt(c.getAttribute('rowspan') || '1', 10);
        if (rs > rows.length - ri) c.setAttribute('rowspan', String(Math.max(1, rows.length - ri)));
      }
    });
  });

  // Table widths → colwidth (pixels) for prosemirror-tables.
  root.querySelectorAll('td, th').forEach((td) => {
    if (td.hasAttribute('data-colwidth')) return;
    const w = td.getAttribute('width') || (/(?:^|;)\s*width:\s*([\d.]+)(px|pt)?/i.exec(td.getAttribute('style') || '') || [])[1];
    const unit = (/(?:^|;)\s*width:\s*[\d.]+(px|pt)/i.exec(td.getAttribute('style') || '') || [])[1];
    const n = w ? parseFloat(w) : NaN;
    if (n > 0 && !/%/.test(td.getAttribute('width') || '')) {
      const colspan = parseInt(td.getAttribute('colspan') || '1', 10) || 1;
      const px = unit === 'pt' ? n / 0.75 : n;
      if (colspan === 1) td.setAttribute('data-colwidth', String(Math.round(px)));
    }
  });

  // Style attributes.
  root.querySelectorAll('[style]').forEach((e) => cleanStyleAttr(e as HTMLElement));
  for (const el of keepWs) if (el.isConnected && el.tagName !== 'PRE') el.setAttribute('style', [el.getAttribute('style'), 'white-space:pre-wrap'].filter(Boolean).join(';'));
  // Word wraps everything in <div class=WordSection1>.
  root.querySelectorAll('div[class^="WordSection"], div[class^="Section"]').forEach(unwrap);
  // Empty spans.
  root.querySelectorAll('span:not([class]):not([style]):not([lang]):not([data-cstyle])').forEach(unwrap);
}

/** Clean HTML coming from the clipboard (Word, Google Docs, web pages) and return HTML for pasting. */
export function cleanPastedHtml(html: string): string {
  try {
    const d = parseHtmlDocument(html);
    cleanHtmlDom(d.body);
    return d.body.innerHTML;
  } catch {
    // Never fall back to the raw clipboard HTML: paste it as plain text instead.
    const t = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
    return t.split(/\n/).map((l) => `<p>${escHtml(l)}</p>`).join('');
  }
}

/** Parse an HTML string into an HTML Document, applying the string-level clean-up. */
export function parseHtmlDocument(html: string): Document {
  const d = new DOMParser().parseFromString(capNestingSource(preClean(html)), 'text/html');
  if (d.body) capNesting(d.body);
  return d;
}

/** Convert an (already cleaned) element's children into schema blocks. */
export function domToBlocks(root: HTMLElement): PMNode[] {
  try {
    const parsed = PMDOMParser.fromSchema(schema).parse(root);
    const out: PMNode[] = [];
    parsed.forEach((b) => out.push(b));
    return out;
  } catch {
    const t = (root.textContent || '').trim();
    return t ? t.split(/\n+/).map((l) => schema.nodes.paragraph.create(null, l ? schema.text(l) : null)) : [];
  }
}

/** Convert an HTML string (fragment or document) into schema blocks. */
export function htmlToBlocks(html: string): PMNode[] {
  try {
    const d = parseHtmlDocument(html);
    cleanHtmlDom(d.body);
    return domToBlocks(d.body);
  } catch {
    return [];
  }
}

export async function importHtml(data: ArrayBuffer, name: string, opts: CleanOptions = {}): Promise<PMNode> {
  const settings = newSettings();
  let blocks: PMNode[] = [];
  try {
    const html = decodeHtmlBytes(data);
    const d = parseHtmlDocument(html);
    const title = d.querySelector('title')?.textContent?.trim();
    if (title) settings.properties.title = title;
    const meta = (n: string) => d.querySelector(`meta[name="${n}" i]`)?.getAttribute('content')?.trim() || '';
    if (meta('author')) settings.properties.author = meta('author');
    if (meta('description')) settings.properties.comments = meta('description');
    if (meta('keywords')) settings.properties.keywords = meta('keywords');
    if (meta('subject')) settings.properties.subject = meta('subject');
    const lang = d.documentElement.getAttribute('lang') || d.body?.getAttribute('lang');
    if (lang) settings.language = lang;
    applyPageCss(inlineDocumentCss(d), settings);
    extractHeaderFooter(d, settings);
    cleanHtmlDom(d.body, opts);
    moveBlockBackgrounds(d.body);
    blocks = normalizeImportedFormatting(domToBlocks(d.body), settings, null);
  } catch { /* fall through with what we have */ }
  void name;
  return finishDoc(blocks, settings);
}

// ---------------------------------------------------------------------------------------------
// Export

/** Render the footnotes collected during rendering as an endnotes section. */
export function notesSectionHtml(notes: { label: string; text: string; index: number; kind: string }[]): string {
  if (!notes.length) return '';
  const items = notes.map((n) => {
    const paras = n.text.split(/\n+/).filter((x) => x.trim().length);
    const first = paras.shift() || '';
    const back = `<a href="#fnref-${n.index}" class="footnote-back" role="doc-backlink">${escapeHtml(n.label)}</a>`;
    return `<li id="fn-${n.index}"${n.kind === 'end' ? ' data-kind="end"' : ''}><p>${back} ${escapeHtml(first)}</p>${paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</li>`;
  });
  return `<section class="footnotes" role="doc-endnotes"><hr><ol style="list-style:none;padding-left:0">\n${items.join('\n')}\n</ol></section>`;
}

/** Produce the standalone HTML text for a document. */
export function docToHtml(doc: PMNode, opts: ExportOptions): string {
  const settings = docSettings(doc);
  const prepared = prepareDoc(doc, { headingIds: false });
  const notes = collectFootnotes(prepared);
  const { container, notes: used } = renderHtml(prepared.content, notes);
  const title = docTitle(doc, opts);
  const author = settings.properties.author || opts.author || '';
  const metas = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Anne\'s Pen">',
  ];
  if (author) metas.push(`<meta name="author" content="${escapeHtml(author)}">`);
  if (settings.properties.subject) metas.push(`<meta name="subject" content="${escapeHtml(settings.properties.subject)}">`);
  if (settings.properties.comments) metas.push(`<meta name="description" content="${escapeHtml(settings.properties.comments)}">`);
  if (settings.properties.keywords) metas.push(`<meta name="keywords" content="${escapeHtml(settings.properties.keywords)}">`);
  const css = `${baseCss(settings)}\n${stylesCss(settings)}`;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(settings.language || 'en')}">
<head>
${metas.join('\n')}
<title>${escapeHtml(title)}</title>
<style>
${css.replace(/<\/style/gi, '<\\/style')}
</style>
</head>
<body>
<div class="qf-doc">
${container.outerHTML}
${notesSectionHtml(used)}
</div>
</body>
</html>
`;
}

export async function exportHtml(doc: PMNode, opts: ExportOptions): Promise<Blob> {
  return makeBlob(docToHtml(doc, opts), 'text/html;charset=utf-8');
}
