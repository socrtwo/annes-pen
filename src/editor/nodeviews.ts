/** Custom node views: images (resize handles), equations (KaTeX), content controls. */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { NodeSelection } from 'prosemirror-state';
import katex from 'katex';
import { sanitizeGeneratedHtml, escHtml } from '../util/sanitize';
import { blockChangeDom, imageStyle, safeImageSrc } from './schema';

/** Show a block-level tracked change (Compare) on a node view's own DOM. */
function showChange(dom: HTMLElement, node: PMNode): void {
  const c = node.attrs.change;
  dom.classList.toggle('qf-chg-ins', c?.kind === 'insertion');
  dom.classList.toggle('qf-chg-del', c?.kind === 'deletion');
  if (!c) { dom.removeAttribute('data-change'); dom.removeAttribute('style'); return; }
  const a = blockChangeDom(c);
  dom.setAttribute('data-change', a['data-change']);
  dom.setAttribute('style', a.style);
  dom.title = a.title;
}

export interface NodeViewHooks {
  editMath: (view: EditorView, pos: number, node: PMNode) => void;
  controlClick: (view: EditorView, pos: number, node: PMNode, el: HTMLElement) => void;
  imageEdit: (view: EditorView, pos: number, node: PMNode) => void;
  genBlockClick: (view: EditorView, pos: number, node: PMNode, e: MouseEvent) => void;
}

export function renderLatex(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex || '\\square', { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore' });
  } catch (e: any) {
    return `<span class="qf-math-error">${String(e.message || e)}</span>`;
  }
}

class MathView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined, private hooks: NodeViewHooks, private display: boolean) {
    this.dom = document.createElement(display ? 'div' : 'span');
    this.dom.className = display ? 'qf-math' : 'qf-math-inline';
    this.dom.contentEditable = 'false';
    this.render();
    this.dom.addEventListener('dblclick', (e) => { e.preventDefault(); const p = this.getPos(); if (p != null) this.hooks.editMath(this.view, p, this.node); });
  }
  render() {
    this.dom.innerHTML = renderLatex(this.node.attrs.latex, this.display);
    this.dom.setAttribute('data-latex', this.node.attrs.latex);
    this.dom.title = 'Double-tap to edit equation';
    if (this.display) showChange(this.dom, this.node);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent() { return false; }
  ignoreMutation() { return true; }
}

class ImageView implements NodeView {
  dom: HTMLElement;
  img: HTMLImageElement;
  handles: HTMLElement[] = [];
  /** Removes the window listeners of a resize or rotate drag in progress. */
  private endDrag: (() => void) | null = null;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined, private hooks: NodeViewHooks) {
    this.dom = document.createElement('span');
    this.dom.className = 'qf-imgwrap';
    this.img = document.createElement('img');
    this.dom.appendChild(this.img);
    for (const c of ['nw', 'ne', 'sw', 'se']) {
      const hdl = document.createElement('span');
      hdl.className = 'qf-handle qf-h-' + c;
      hdl.addEventListener('pointerdown', (e) => this.startResize(e, c));
      this.handles.push(hdl);
      this.dom.appendChild(hdl);
    }
    const rot = document.createElement('span');
    rot.className = 'qf-handle qf-h-rot';
    rot.title = 'Rotate';
    rot.addEventListener('pointerdown', (e) => this.startRotate(e));
    this.dom.appendChild(rot);
    this.dom.addEventListener('dblclick', (e) => { e.preventDefault(); const p = this.getPos(); if (p != null) this.hooks.imageEdit(this.view, p, this.node); });
    this.render();
  }
  render() {
    const a = this.node.attrs;
    this.img.src = safeImageSrc(a.src);
    this.img.alt = a.alt || '';
    if (a.title) this.img.title = a.title;
    this.img.style.cssText = imageStyle(a, true).join(';');
    this.dom.setAttribute('data-wrap', a.wrap || 'inline');
  }
  startResize(e: PointerEvent, corner: string) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const rect = this.img.getBoundingClientRect();
    const z = this.img.offsetWidth ? rect.width / this.img.offsetWidth : 1;
    const w0 = this.img.offsetWidth, h0 = this.img.offsetHeight;
    const ratio = h0 / (w0 || 1);
    const move = (ev: PointerEvent) => {
      let dx = (ev.clientX - startX) / z;
      if (corner.includes('w')) dx = -dx;
      const w = Math.max(16, w0 + dx);
      this.img.style.width = w + 'px';
      this.img.style.height = (ev.shiftKey ? h0 + ((ev.clientY - startY) / z) * (corner.includes('n') ? -1 : 1) : w * ratio) + 'px';
    };
    const up = () => {
      this.stopDrag();
      const pos = this.getPos();
      if (pos == null) return;
      const wpt = Math.round(this.img.offsetWidth * 0.75 * 10) / 10;
      const hpt = Math.round(this.img.offsetHeight * 0.75 * 10) / 10;
      const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width: wpt, height: hpt });
      // The selection must point into the changed document, not the one before the resize.
      this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
    };
    this.listen(move, up);
  }
  /** Track a drag on window; pointercancel or destroy ends it without committing. */
  private listen(move: (e: PointerEvent) => void, up: () => void) {
    this.stopDrag();
    const cancel = () => { this.stopDrag(); this.render(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    this.endDrag = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }
  private stopDrag() { this.endDrag?.(); this.endDrag = null; }
  destroy() { this.stopDrag(); }
  startRotate(e: PointerEvent) {
    e.preventDefault(); e.stopPropagation();
    const r = this.img.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let angle = this.node.attrs.rotate || 0;
    const move = (ev: PointerEvent) => {
      angle = Math.round((Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90);
      if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
      this.img.style.transform = `rotate(${angle}deg)`;
    };
    const up = () => {
      this.stopDrag();
      const pos = this.getPos();
      if (pos != null) this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, rotate: ((angle % 360) + 360) % 360 }));
    };
    this.listen(move, up);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(e: Event) { return (e.target as HTMLElement).classList?.contains('qf-handle'); }
  ignoreMutation() { return true; }
}

class ControlView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined, private hooks: NodeViewHooks) {
    this.dom = document.createElement('span');
    this.dom.className = 'qf-control';
    this.dom.contentEditable = 'false';
    this.render();
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const p = this.getPos();
      if (p != null) this.hooks.controlClick(this.view, p, this.node, this.dom);
    });
  }
  render() {
    const a = this.node.attrs;
    this.dom.dataset.kind = a.kind;
    let text = a.value || a.label || 'Click or tap here to enter text.';
    if (a.kind === 'checkbox') text = a.value === 'true' ? '☒' : '☐';
    else if (a.kind === 'dropdown' || a.kind === 'combo') text = (a.value || a.label || 'Choose an item.') + ' ▾';
    else if (a.kind === 'date') text = a.value || 'Click or tap to enter a date.';
    else if (a.kind === 'picture') text = '';
    this.dom.textContent = text;
    if (a.kind === 'picture') {
      if (a.value) { const img = document.createElement('img'); img.src = safeImageSrc(a.value); img.style.maxWidth = '200pt'; this.dom.appendChild(img); }
      else this.dom.textContent = '🖼 Click to insert picture';
    }
    this.dom.classList.toggle('qf-placeholder', !a.value && a.kind !== 'checkbox');
    this.dom.title = a.tag ? `${a.label || a.kind} [${a.tag}]` : a.label || a.kind;
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  stopEvent(e: Event) { return e.type === 'mousedown'; }
  ignoreMutation() { return true; }
}

class GenBlockView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined, private hooks: NodeViewHooks) {
    this.dom = document.createElement('div');
    this.dom.className = 'qf-gen';
    this.dom.contentEditable = 'false';
    this.render();
    this.dom.addEventListener('click', (e) => {
      const p = this.getPos();
      if (p != null) this.hooks.genBlockClick(this.view, p, this.node, e);
    });
  }
  render() {
    this.dom.dataset.kind = this.node.attrs.kind;
    showChange(this.dom, this.node);
    const label = escHtml(labelFor(this.node.attrs.kind));
    this.dom.innerHTML = (sanitizeGeneratedHtml(this.node.attrs.cache) || `<p class="qf-gen-empty">${label} — tap Update to generate</p>`) +
      `<div class="qf-gen-bar"><button type="button" data-act="update">↻ Update ${label}</button></div>`;
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(e: Event) { return (e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'A'; }
  ignoreMutation() { return true; }
}

function labelFor(kind: string): string {
  return ({ toc: 'Table of Contents', bibliography: 'Bibliography', index: 'Index', tof: 'Table of Figures', toa: 'Table of Authorities', endnotes: 'Endnotes' } as Record<string, string>)[kind] || kind;
}

export function buildNodeViews(hooks: NodeViewHooks): Record<string, NodeViewConstructor> {
  return {
    math_inline: (node, view, getPos) => new MathView(node, view, getPos, hooks, false),
    math_block: (node, view, getPos) => new MathView(node, view, getPos, hooks, true),
    image: (node, view, getPos) => new ImageView(node, view, getPos, hooks),
    control: (node, view, getPos) => new ControlView(node, view, getPos, hooks),
    gen_block: (node, view, getPos) => new GenBlockView(node, view, getPos, hooks),
  };
}
