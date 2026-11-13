/**
 * Print Layout pagination.
 *
 * The document is rendered as one continuous column whose width equals the page width.
 * After layout settles, this plugin measures block and line boxes and inserts "page gap"
 * widget decorations that (a) fill the remainder of the current page, (b) show the footnotes
 * and footer of that page, (c) draw the gap between sheets, and (d) show the next page's
 * header. Paragraphs that straddle a page boundary are split with an inline block widget at
 * the first line that does not fit, honoring widow/orphan control, keep-with-next,
 * keep-lines-together and page-break-before. Lists break between items (and between or inside
 * the paragraphs of an item), tables between rows; a single row or image that does not fit
 * moves to the next page.
 *
 * Measurements never require removing existing widgets: block widgets are siblings of the
 * measured nodes, and the heights of inline widgets inside split paragraphs are subtracted.
 */
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema';

export interface PageConfig {
  enabled: boolean;
  widthPt: number;
  heightPt: number;
  margin: { top: number; right: number; bottom: number; left: number };
  gapPx: number;
  header: (page: number, pages: number) => string;
  footer: (page: number, pages: number) => string;
  footnoteHtml: (node: PMNode, num: string) => string;
  footnoteNumber: (pos: number) => string | null;
  footnotesAtPageBottom: boolean;
}

export interface PageInfo {
  /** Start position of each page (first page starts at 0). */
  starts: number[];
  pages: number;
}

type BrkKind = 'block' | 'inline' | 'row';

interface Brk {
  pos: number;          // doc position where the next page begins
  inline: boolean;      // break inside a paragraph
  row: boolean;         // break between table rows (the widget is a table row)
  cols: number;         // for row breaks: the table's column count
  fill: number;         // px of empty space to fill on the page before the break
  page: number;         // index of the page that ends here (0-based)
  fnHtml: string;       // footnote area html for the page ending here
  fnH: number;
  shiftLeft: number;    // for inline widgets: offset from paragraph content box to page edge
  shiftRight: number;
}

interface PState { deco: DecorationSet; info: PageInfo; sig: string }

export const pageKey = new PluginKey<PState>('pagination');

const PT = 4 / 3; // px per pt

function widgetDom(b: Brk | null, cfg: PageConfig, pages: number, last: boolean, first: boolean, fill: number, fnHtml: string, fnH: number, inline: boolean, shiftL: number, shiftR: number, pageIdx: number): HTMLElement {
  const mt = cfg.margin.top * PT, mb = cfg.margin.bottom * PT, ml = cfg.margin.left * PT, mr = cfg.margin.right * PT;
  const el = document.createElement(inline ? 'span' : 'div');
  el.className = 'qf-pgap' + (inline ? ' qf-pgap-inline' : '') + (last ? ' qf-pgap-last' : '') + (first ? ' qf-pgap-first' : '');
  el.contentEditable = 'false';
  el.setAttribute('aria-hidden', 'true');
  const total = first ? mt : last ? fill + mb : fill + mb + cfg.gapPx + mt;
  el.style.cssText = `display:block;height:${total}px;margin-left:${-(shiftL)}px;margin-right:${-(shiftR)}px;text-indent:0;` + (first ? `margin-top:${-mt}px;` : '');
  el.dataset.h = String(total);
  const part = (cls: string, h: number, html = '', pad = true) => {
    const d = document.createElement('span');
    d.className = cls;
    d.style.cssText = `display:block;height:${h}px;${pad ? `padding-left:${ml}px;padding-right:${mr}px;` : ''}`;
    if (html) d.innerHTML = html;
    el.appendChild(d);
    return d;
  };
  if (first) {
    const top = part('qf-pg-top', mt);
    top.innerHTML = `<span class="qf-pg-header" style="top:${cfg.margin.top * PT * 0.5}px">${cfg.header(1, pages)}</span>`;
    return el;
  }
  part('qf-pg-fill', Math.max(0, fill - fnH));
  if (fnH > 0) part('qf-pg-footnotes', fnH, fnHtml);
  const bottom = part('qf-pg-bottom', mb);
  bottom.innerHTML = `<span class="qf-pg-footer">${cfg.footer(pageIdx + 1, pages)}</span>`;
  if (!last) {
    part('qf-pg-gap', cfg.gapPx, `<span class="qf-pg-num">${pageIdx + 2}</span>`, false);
    const top = part('qf-pg-top', mt);
    top.innerHTML = `<span class="qf-pg-header">${cfg.header(pageIdx + 2, pages)}</span>`;
  }
  return el;
}

/** A page gap between table rows: a full-width row holding the gap. */
function rowWidget(inner: HTMLElement, cols: number): HTMLElement {
  const tr = document.createElement('tr');
  tr.className = 'qf-pgap-row';
  tr.contentEditable = 'false';
  tr.setAttribute('aria-hidden', 'true');
  const td = document.createElement('td');
  td.colSpan = Math.max(1, cols); // more columns than the table has would widen a fixed layout
  td.style.cssText = 'padding:0;border:0;outline:none;background:transparent;pointer-events:none';
  td.appendChild(inner);
  tr.appendChild(td);
  return tr;
}

/** A hidden row next to a row gap so nth-child banding keeps its parity. */
function rowPad(): HTMLElement {
  const tr = document.createElement('tr');
  tr.className = 'qf-pgap-pad';
  tr.style.display = 'none';
  return tr;
}

export function paginationPlugin(getConfig: () => PageConfig) {
  let timer: any = null;
  let lastCfgSig = '';

  return new Plugin<PState>({
    key: pageKey,
    state: {
      init: () => ({ deco: DecorationSet.empty, info: { starts: [0], pages: 1 }, sig: '' }),
      apply(tr, v) {
        const m = tr.getMeta(pageKey) as PState | undefined;
        if (m) return m;
        if (!tr.docChanged) return v;
        return { deco: v.deco.map(tr.mapping, tr.doc), info: { ...v.info, starts: v.info.starts.map((p) => tr.mapping.map(p)) }, sig: v.sig };
      },
    },
    props: {
      decorations(state) { return pageKey.getState(state)?.deco; },
    },
    view(view) {
      const schedule = (delay: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => run(view), delay);
      };
      const onResize = () => schedule(150);
      window.addEventListener('resize', onResize);
      (document as any).fonts?.ready?.then(() => schedule(0));
      (view as any)._qfPaginate = (delay = 0) => schedule(delay);
      schedule(50);
      return {
        update(v, prev) {
          const cfg = getConfig();
          const sig = JSON.stringify([cfg.enabled, cfg.widthPt, cfg.heightPt, cfg.margin, cfg.gapPx]);
          if (sig !== lastCfgSig) { lastCfgSig = sig; schedule(0); return; }
          if (v.state.doc !== prev.doc || v.state.doc.attrs.settings !== prev.doc.attrs.settings) schedule(350);
        },
        destroy() { clearTimeout(timer); window.removeEventListener('resize', onResize); },
      };
    },
  });

  function run(view: EditorView) {
    if ((view as any).isDestroyed) return;
    if (view.composing) { clearTimeout(timer); timer = setTimeout(() => run(view), 400); return; }
    const cfg = getConfig();
    const cur = pageKey.getState(view.state)!;
    if (!cfg.enabled) {
      if (cur.deco !== DecorationSet.empty) view.dispatch(view.state.tr.setMeta(pageKey, { deco: DecorationSet.empty, info: { starts: [0], pages: 1 }, sig: '' }).setMeta('addToHistory', false));
      return;
    }
    if (!view.dom.isConnected || view.dom.offsetWidth === 0) return;
    const result = measure(view, cfg);
    if (!result) return;
    const { breaks, finalFill, finalFnHtml, finalFnH } = result;
    const pages = breaks.length + 1;
    const sig = JSON.stringify([breaks.map((b) => [b.pos, Math.round(b.fill), b.inline, b.row && b.cols, Math.round(b.fnH), b.fnHtml.length, Math.round(b.shiftLeft)]), Math.round(finalFill), finalFnH, pages, cfg.header(1, pages), cfg.footer(1, pages)]);
    if (sig === cur.sig) return;
    const decos: Decoration[] = [];
    decos.push(Decoration.widget(0, () => widgetDom(null, cfg, pages, false, true, 0, '', 0, false, cfg.margin.left * PT, cfg.margin.right * PT, 0), { side: -1, key: `pg-first-${pages}-${cfg.header(1, pages)}`, ignoreSelection: true }));
    breaks.forEach((b, i) => {
      const make = () => widgetDom(b, cfg, pages, false, false, b.fill, b.fnHtml, b.fnH, b.inline, b.shiftLeft, b.shiftRight, b.page);
      decos.push(Decoration.widget(b.pos, b.row ? () => rowWidget(make(), b.cols) : make, {
        side: -1, key: `pg-${i}-${Math.round(b.fill)}-${b.inline ? 1 : b.row ? `r${b.cols}` : 0}-${pages}-${Math.round(b.fnH)}-${b.fnHtml.length}-${Math.round(b.shiftLeft)}`, ignoreSelection: true,
      }));
      if (b.row) decos.push(Decoration.widget(b.pos, rowPad, { side: -1, key: 'pg-pad', ignoreSelection: true }));
    });
    const end = view.state.doc.content.size;
    decos.push(Decoration.widget(end, () => widgetDom(null, cfg, pages, true, false, finalFill, finalFnHtml, finalFnH, false, cfg.margin.left * PT, cfg.margin.right * PT, pages - 1), { side: 1, key: `pg-last-${Math.round(finalFill)}-${pages}-${finalFnH}-${finalFnHtml.length}`, ignoreSelection: true }));
    const info: PageInfo = { starts: [0, ...breaks.map((b) => b.pos)], pages };
    const scroller = view.dom.closest('.qf-scroll') as HTMLElement | null;
    const st = scroller?.scrollTop;
    view.dispatch(view.state.tr.setMeta(pageKey, { deco: DecorationSet.create(view.state.doc, decos), info, sig }).setMeta('addToHistory', false).setMeta('pagination', true));
    if (scroller && st != null) scroller.scrollTop = st;
    view.dom.dispatchEvent(new CustomEvent('qf-paginated', { bubbles: true, detail: info }));
  }
}

interface LineBox { top: number; bottom: number; left: number }

function zoomRatio(view: EditorView): number {
  const r = view.dom.getBoundingClientRect();
  return view.dom.offsetWidth ? r.width / view.dom.offsetWidth : 1;
}

/** Natural line boxes of an element, in client px, with inline gap widgets subtracted. */
function lineBoxes(el: HTMLElement): { lines: LineBox[]; widgetsAbove: (y: number) => number } {
  const widgets = [...el.querySelectorAll<HTMLElement>('.qf-pgap-inline')].map((w) => { const r = w.getBoundingClientRect(); return { top: r.top, h: r.height }; });
  const widgetsAbove = (y: number) => widgets.filter((w) => w.top < y - 0.5).reduce((a, w) => a + w.h, 0);
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter((r) => r.height > 0 && r.width >= 0);
  const lines: LineBox[] = [];
  for (const r of rects) {
    // Skip rects that belong to the widgets themselves.
    if (widgets.some((w) => r.top >= w.top - 0.5 && r.bottom <= w.top + w.h + 0.5)) continue;
    const ex = lines.find((l) => Math.abs(l.top - r.top) < 2 || (r.top >= l.top - 1 && r.bottom <= l.bottom + 1) || (r.top < l.bottom - 2 && r.bottom > l.top + 2));
    if (ex) { ex.top = Math.min(ex.top, r.top); ex.bottom = Math.max(ex.bottom, r.bottom); ex.left = Math.min(ex.left, r.left); }
    else lines.push({ top: r.top, bottom: r.bottom, left: r.left });
  }
  lines.sort((a, b) => a.top - b.top);
  return { lines, widgetsAbove };
}

function measure(view: EditorView, cfg: PageConfig) {
  const z = zoomRatio(view) || 1;
  const contentH = (cfg.heightPt - cfg.margin.top - cfg.margin.bottom) * PT; // css px
  if (contentH <= 50) return null;
  const doc = view.state.doc;
  const breaks: Brk[] = [];
  let used = 0;
  let page = 0;
  let fnUsed = 0;
  let fnHtml = '';
  const ml = cfg.margin.left * PT, mr = cfg.margin.right * PT;
  const domRect = view.dom.getBoundingClientRect();
  const measurer = footnoteMeasurer(view, cfg, z);

  let cols = 1; // column count of the table being broken
  const pushBreak = (pos: number, kind: BrkKind, shiftL = ml, shiftR = mr) => {
    breaks.push({ pos, inline: kind === 'inline', row: kind === 'row', cols, fill: Math.max(0, contentH - used), page, fnHtml, fnH: fnUsed, shiftLeft: shiftL, shiftRight: shiftR });
    page++;
    used = 0; fnUsed = 0; fnHtml = '';
  };

  const footnotesIn = (node: PMNode, base: number, from = 0, to = Infinity) => {
    const out: { pos: number; node: PMNode }[] = [];
    if (!cfg.footnotesAtPageBottom) return out;
    node.descendants((n, p) => {
      if (n.type === schema.nodes.footnote && n.attrs.kind !== 'end') {
        const abs = base + 1 + p;
        if (abs >= from && abs < to) out.push({ pos: abs, node: n });
      }
      return true;
    });
    return out;
  };
  const addFootnotes = (list: { pos: number; node: PMNode }[]) => {
    for (const f of list) {
      const num = cfg.footnoteNumber(f.pos) || '';
      const html = cfg.footnoteHtml(f.node, num);
      const h = measurer.height(html);
      if (!fnHtml) fnUsed += 12; // separator line + spacing
      fnHtml += html;
      fnUsed += h;
    }
  };
  const fnHeightOf = (list: { pos: number; node: PMNode }[]) => list.reduce((a, f) => a + measurer.height(cfg.footnoteHtml(f.node, cfg.footnoteNumber(f.pos) || '')), 0) + (list.length && !fnHtml ? 12 : 0);

  type Shift = { l: number; r: number };
  type Fn = { pos: number; node: PMNode };
  const N = schema.nodes;
  const isContainer = (n: PMNode) => n.type === N.bullet_list || n.type === N.ordered_list || n.type === N.task_list || n.type === N.list_item || n.type === N.task_item || n.type === N.table;
  /** Our gap widgets inside an element (their height is not part of the natural layout). */
  const gapsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.qf-pgap')].map((w) => { const r = w.getBoundingClientRect(); return { top: r.top, h: r.height }; });
  const gapH = (el: HTMLElement) => gapsIn(el).reduce((a, w) => a + w.h, 0);
  /** Offsets of an element's content box from the page edges, for widgets placed inside it. */
  const shiftOf = (el: HTMLElement): Shift => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      l: (r.left - domRect.left) / z + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0),
      r: (domRect.right - r.right) / z + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderRightWidth) || 0),
    };
  };

  /**
   * Split a paragraph whose top is at `used` across pages. Returns false, having placed nothing,
   * when it should move to the next page whole but no break may go right before it.
   */
  const splitPara = (node: PMNode, pos: number, dom: HTMLElement, h: number, fns: Fn[], canBefore: boolean, atTop: boolean, sh: Shift): boolean => {
    const { lines, widgetsAbove } = lineBoxes(dom);
    if (lines.length < 2) return false;
    const top0 = dom.getBoundingClientRect().top;
    const naturalTop = (l: LineBox) => (l.top - top0 - widgetsAbove(l.top)) / z;
    const naturalBottom = (l: LineBox) => (l.bottom - top0 - widgetsAbove(l.top)) / z;
    let startLine = 0;
    let consumedBefore = 0; // natural px of this paragraph already placed on previous pages
    let guard = 0;
    while (guard++ < 200) {
      const avail = contentH - used - fnUsed;
      // find first line that doesn't fit
      let k = -1;
      for (let li = startLine; li < lines.length; li++) {
        if (naturalBottom(lines[li]) - consumedBefore > avail + 0.5) { k = li; break; }
      }
      if (k < 0) { used += h - consumedBefore; break; }
      const widow = node.attrs.widowControl;
      if (widow) {
        if (k - startLine < 2 && startLine === 0) k = startLine; // orphan: move whole paragraph
        else if (lines.length - k < 2 && k - 1 > startLine) k = k - 1; // widow: pull a line over
      }
      if (k <= startLine) {
        if (startLine === 0 && !atTop) {
          if (!canBefore) return false;
          pushBreak(pos, 'block', sh.l, sh.r); consumedBefore = 0; atTop = true; continue;
        }
        // cannot split meaningfully (first line taller than a page)
        used += h - consumedBefore; break;
      }
      // position at the start of line k
      const line = lines[k];
      const y = (line.top + line.bottom) / 2;
      const found = view.posAtCoords({ left: Math.max(domRect.left + 1, line.left + 1), top: y });
      let splitPos = found ? found.pos : -1;
      if (splitPos <= pos + 1 || splitPos >= pos + node.nodeSize - 1) { used += h - consumedBefore; break; }
      // ensure splitPos is at the start of the line (not at end of previous line)
      try {
        const c = view.coordsAtPos(splitPos, 1);
        if (c.top < line.top - 2) splitPos += 1;
      } catch { /* */ }
      const beforeH = naturalTop(line) - consumedBefore;
      used += beforeH;
      addFootnotes(fns.filter((f) => f.pos < splitPos && f.pos >= (breaks.length ? breaks[breaks.length - 1].pos : 0)));
      const pr = dom.getBoundingClientRect();
      const cs = getComputedStyle(dom);
      const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
      const leftOffset = (pr.left - domRect.left) / z + padL; // content box left from editor border-box
      const rightOffset = (domRect.right - pr.right) / z + padR;
      pushBreak(splitPos, 'inline', leftOffset, rightOffset);
      consumedBefore = naturalTop(line);
      startLine = k;
    }
    // footnotes after the last split point
    const lastBreak = breaks.length ? breaks[breaks.length - 1].pos : 0;
    if (lastBreak > pos) addFootnotes(fns.filter((f) => f.pos >= lastBreak));
    else addFootnotes(fns);
    return true;
  };

  /**
   * Place a block whose top is at `used`, leaving `used` at its bottom. Returns false, having
   * placed nothing, when the block must move to the next page but `canBefore` forbids a break
   * right before it (the first child of a list item or list): the caller breaks earlier.
   */
  const placeNode = (node: PMNode, pos: number, dom: HTMLElement, h: number, fns: Fn[], canBefore: boolean, atTop: boolean, sh: Shift, kind: BrkKind): boolean => {
    if (h + fnHeightOf(fns) <= contentH - used - fnUsed + 0.5) { used += h; addFootnotes(fns); return true; }
    if (node.type === N.paragraph && !node.attrs.keepLines) {
      if (splitPara(node, pos, dom, h, fns, canBefore, atTop, sh)) return true;
    } else if (isContainer(node)) {
      if (placeContainer(node, pos, dom, atTop)) return true;
    }
    if (atTop) { used += h; addFootnotes(fns); if (used > contentH) used = contentH; return true; } // overflowing block: the page grows
    if (!canBefore) return false;
    pushBreak(pos, kind, sh.l, sh.r);
    return placeNode(node, pos, dom, h, fns, canBefore, true, sh, kind);
  };

  /** Place a list, list item or table child by child, breaking between children. */
  const placeContainer = (node: PMNode, pos: number, dom: HTMLElement, entryTop: boolean): boolean => {
    const kids: { node: PMNode; pos: number; el: HTMLElement }[] = [];
    node.forEach((c, off) => { const el = view.nodeDOM(pos + 1 + off); if (el instanceof HTMLElement) kids.push({ node: c, pos: pos + 1 + off, el }); });
    if (!kids.length || !kids[0].el.parentElement) return false;
    const kind: BrkKind = node.type === N.table ? 'row' : 'block';
    if (kind === 'row') { cols = 0; node.firstChild?.forEach((c) => { cols += c.attrs.colspan || 1; }); }
    const sh = shiftOf(kids[0].el.parentElement);
    const r0 = dom.getBoundingClientRect();
    const gaps = gapsIn(dom);
    const nat = (y: number) => (y - r0.top - gaps.filter((w) => w.top < y - 0.5).reduce((a, w) => a + w.h, 0)) / z;
    const entryUsed = used;
    let off = used; // page fill at the container's natural top (minus what earlier pages took)
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k];
      const cr = c.el.getBoundingClientRect();
      const t = nat(cr.top);
      const hc = (cr.height - gaps.filter((w) => w.top >= cr.top - 0.5 && w.top < cr.bottom).reduce((a, w) => a + w.h, 0)) / z;
      used = off + t;
      const ok = placeNode(c.node, c.pos, c.el, hc, footnotesIn(c.node, c.pos), k > 0, used < 0.5 || (k === 0 && entryTop), sh, kind);
      if (!ok) { used = entryUsed; return false; }
      off = used - (t + hc);
    }
    used = Math.min(contentH, off + (r0.height - gaps.reduce((a, w) => a + w.h, 0)) / z);
    return true;
  };

  const children: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, offset) => children.push({ node, pos: offset }));

  for (let i = 0; i < children.length; i++) {
    const { node, pos } = children[i];
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) continue;
    const r = dom.getBoundingClientRect();
    const isPara = node.type === schema.nodes.paragraph;
    const h = (r.height - gapH(dom)) / z;
    const fns = footnotesIn(node, pos);
    const fnH = fnHeightOf(fns);

    if (isPara && node.attrs.pageBreakBefore && used > 0) pushBreak(pos, 'block');

    const remaining = contentH - used - fnUsed;
    if (h + fnH <= remaining + 0.5) {
      // keep-with-next: if the next block cannot start on this page, move this block too
      if (isPara && node.attrs.keepNext && i + 1 < children.length && used > 0) {
        const nd = view.nodeDOM(children[i + 1].pos) as HTMLElement | null;
        if (nd) {
          const nh = nd.getBoundingClientRect().height / z;
          const firstLines = Math.min(nh, 2.2 * 16);
          if (h + fnH + firstLines > remaining) { pushBreak(pos, 'block'); }
        }
      }
      used += h; addFootnotes(fns);
    } else {
      placeNode(node, pos, dom, h, fns, true, used <= 0, { l: ml, r: mr }, 'block');
    }

    const forced = node.type === schema.nodes.page_break || (node.type === schema.nodes.section_break && node.attrs.kind !== 'continuous');
    if (forced && i + 1 < children.length) {
      pushBreak(children[i + 1].pos, 'block');
      if (node.type === schema.nodes.section_break && (node.attrs.kind === 'oddPage' || node.attrs.kind === 'evenPage')) {
        const wantOdd = node.attrs.kind === 'oddPage';
        const isOdd = (page + 1) % 2 === 1;
        if (wantOdd !== isOdd) { used = 0; pushBreak(children[i + 1].pos, 'block'); }
      }
    }
  }
  measurer.dispose();
  return { breaks, finalFill: Math.max(0, contentH - used), finalFnHtml: fnHtml, finalFnH: fnUsed };
}

function footnoteMeasurer(view: EditorView, cfg: PageConfig, z = 1) {
  const host = document.createElement('div');
  host.className = 'qf-pg-footnotes qf-measure';
  host.style.cssText = `position:absolute;visibility:hidden;left:-10000px;top:0;width:${(cfg.widthPt - cfg.margin.left - cfg.margin.right) * PT}px`;
  (view.dom.parentElement || document.body).appendChild(host);
  const cache = new Map<string, number>();
  return {
    height(html: string): number {
      let h = cache.get(html);
      if (h == null) {
        host.innerHTML = html;
        h = Math.ceil(host.getBoundingClientRect().height / (z || 1)) + 1;
        cache.set(html, h);
      }
      return h;
    },
    dispose() { host.remove(); },
  };
}

export function pageInfo(state: EditorState): PageInfo {
  return pageKey.getState(state)?.info || { starts: [0], pages: 1 };
}

/** 1-based page number containing a document position. */
export function pageOfPos(state: EditorState, pos: number): number {
  const { starts } = pageInfo(state);
  let p = 1;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) p = i + 1;
  return p;
}

export function repaginate(view: EditorView, delay = 0): void {
  (view as any)._qfPaginate?.(delay);
}
