/** Dialogs, prompts, menus, toasts and color pickers. */
import { h, icon, clear, isPhone } from './dom';
import type { MenuEntry } from '../commands/registry';

// ------------------------------------------------------------------------------------------
// Toast

export function toast(msg: string, opts: { action?: string; onAction?: () => void; ms?: number } = {}): void {
  const host = document.querySelector('.qf-toasts') || document.body.appendChild(h('div', { class: 'qf-toasts' }));
  const t = h('div', { class: 'qf-toast', role: 'status' }, h('span', null, msg));
  if (opts.action) t.appendChild(h('button', { class: 'qf-link', onclick: () => { opts.onAction?.(); t.remove(); } }, opts.action));
  host.appendChild(t);
  setTimeout(() => t.classList.add('qf-out'), opts.ms ?? 2800);
  setTimeout(() => t.remove(), (opts.ms ?? 2800) + 400);
}

// ------------------------------------------------------------------------------------------
// Dialog

export type FieldType = 'text' | 'number' | 'select' | 'checkbox' | 'color' | 'textarea' | 'radio' | 'range' | 'date' | 'info' | 'list' | 'heading' | 'password' | 'combo' | 'file' | 'button' | 'time';

export interface Field {
  key: string;
  label?: string;
  type: FieldType;
  value?: any;
  options?: (string | { value: any; label: string; style?: string })[];
  min?: number; max?: number; step?: number;
  suffix?: string;
  help?: string;
  placeholder?: string;
  rows?: number;
  multiple?: boolean;
  html?: string;
  width?: string;
  half?: boolean;
  visibleIf?: (v: Record<string, any>) => boolean;
  onClick?: (values: Record<string, any>, ctl: DialogControl) => void;
  accept?: string;
  autofocus?: boolean;
}

export interface DialogControl {
  set(key: string, value: any): void;
  get(key: string): any;
  values(): Record<string, any>;
  close(result?: any): void;
  body: HTMLElement;
  setPreview(html: string): void;
  rebuild(fields: Field[]): void;
}

export interface DialogOptions {
  title: string;
  fields?: Field[];
  ok?: string | false;
  cancel?: string | false;
  wide?: boolean;
  full?: boolean;
  preview?: boolean | string;
  previewStyle?: string;
  onChange?: (values: Record<string, any>, ctl: DialogControl, key: string) => void;
  onOpen?: (ctl: DialogControl) => void;
  buttons?: { label: string; onClick: (values: Record<string, any>, ctl: DialogControl) => void; primary?: boolean }[];
  validate?: (values: Record<string, any>) => string | null;
  content?: HTMLElement;
  help?: string;
}

let dialogDepth = 0;
/** Open dialogs, innermost last: only the top one handles Escape and Enter. */
const dialogStack: HTMLElement[] = [];

/** Elements made inert while a dialog is open (the app, and dialogs under the top one). */
const madeInert = new Set<HTMLElement>();
function updateInert(): void {
  const top = dialogStack[dialogStack.length - 1];
  const want = new Set<HTMLElement>();
  if (top) {
    for (const el of document.querySelectorAll<HTMLElement>('#app, .qf-app')) if (!el.closest('.qf-overlay')) want.add(el);
    for (const o of dialogStack) if (o !== top) want.add(o);
  }
  for (const el of [...madeInert]) if (!want.has(el)) { el.inert = false; el.removeAttribute('inert'); madeInert.delete(el); }
  for (const el of want) if (!el.inert && !madeInert.has(el)) { el.inert = true; el.setAttribute('inert', ''); madeInert.add(el); }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
/** Focusable elements of a dialog, in order, that are shown. */
export function focusables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]') && !el.closest('[style*="display: none"]') && el.getAttribute('aria-hidden') !== 'true');
}

export function openDialog(opts: DialogOptions): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    dialogDepth++;
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = h('div', { class: 'qf-overlay' });
    const box = h('div', { class: 'qf-dialog' + (opts.wide ? ' qf-wide' : '') + (opts.full ? ' qf-full' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title });
    const body = h('div', { class: 'qf-dialog-body' });
    const previewEl = opts.preview ? h('div', { class: 'qf-dialog-preview', style: opts.previewStyle || '' }, typeof opts.preview === 'string' ? opts.preview : '') : null;
    const inputs = new Map<string, { el: HTMLElement; field: Field; row: HTMLElement }>();
    let fields = opts.fields || [];
    let done = false;

    const values = (): Record<string, any> => {
      const v: Record<string, any> = {};
      for (const [k, { el, field }] of inputs) v[k] = readValue(el, field);
      return v;
    };
    const ctl: DialogControl = {
      set(key, value) { const i = inputs.get(key); if (i) writeValue(i.el, i.field, value); refreshVisibility(); },
      get(key) { const i = inputs.get(key); return i ? readValue(i.el, i.field) : undefined; },
      values,
      close(result) { finish(result === undefined ? null : result); },
      body,
      setPreview(html) { if (previewEl) previewEl.innerHTML = html; },
      rebuild(f) { fields = f; build(); },
    };

    function refreshVisibility() {
      const v = values();
      for (const { field, row } of inputs.values()) if (field.visibleIf) row.style.display = field.visibleIf(v) ? '' : 'none';
    }

    function build() {
      clear(body);
      inputs.clear();
      if (opts.help) body.appendChild(h('p', { class: 'qf-help' }, opts.help));
      if (opts.content) body.appendChild(opts.content);
      let rowWrap: HTMLElement | null = null;
      for (const f of fields) {
        const { row, el } = buildField(f, ctl, () => { refreshVisibility(); opts.onChange?.(values(), ctl, f.key); });
        if (f.half) {
          if (!rowWrap) { rowWrap = h('div', { class: 'qf-row2' }); body.appendChild(rowWrap); }
          rowWrap.appendChild(row);
          if (rowWrap.children.length >= 2) rowWrap = null;
        } else {
          rowWrap = null;
          body.appendChild(row);
        }
        if (f.type !== 'heading' && f.type !== 'info' && f.type !== 'button') inputs.set(f.key, { el, field: f, row });
        else inputs.set('__' + f.key, { el, field: f, row });
      }
      if (previewEl) body.appendChild(h('div', { class: 'qf-preview-wrap' }, h('div', { class: 'qf-label' }, 'Preview'), previewEl));
      for (const k of [...inputs.keys()]) if (k.startsWith('__')) inputs.delete(k);
      refreshVisibility();
    }

    function finish(result: Record<string, any> | null) {
      if (done) return;
      done = true;
      dialogDepth--;
      const at = dialogStack.indexOf(overlay);
      if (at >= 0) dialogStack.splice(at, 1);
      overlay.classList.add('qf-out');
      setTimeout(() => overlay.remove(), 120);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
      // The app (or the dialog below) is interactive again before focus goes back to it.
      updateInert();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus?.();
      resolve(result);
    }
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== overlay) return;
      // Shortcut capture boxes (Customize Keyboard) take Enter and modified keys themselves; plain Escape still closes.
      const plainEsc = e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if ((e.target as HTMLElement | null)?.closest?.('[data-capture-keys]') && !plainEsc) return;
      // Tab and Shift+Tab stay within the dialog.
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const list = focusables(box);
        if (!list.length) { e.preventDefault(); return; }
        const i = list.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
        else if (!e.shiftKey && (i < 0 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(null); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && opts.ok !== false) {
        e.preventDefault(); e.stopImmediatePropagation(); okClick();
      }
    };
    // Focus that lands outside the top dialog (a click on the page behind, a script) comes back into it.
    const onFocusIn = (e: FocusEvent) => {
      if (dialogStack[dialogStack.length - 1] !== overlay) return;
      const t = e.target as HTMLElement | null;
      if (!t || overlay.contains(t) || t.closest?.('.qf-menu, .qf-toasts, .qf-overlay')) return;
      (focusables(box)[0] || box).focus?.();
    };
    const okClick = () => {
      const v = values();
      const err = opts.validate?.(v);
      if (err) { toast(err); return; }
      finish(v);
    };

    const header = h('div', { class: 'qf-dialog-head' },
      h('h2', null, opts.title),
      h('button', { class: 'qf-iconbtn', 'aria-label': 'Close', onclick: () => finish(null) }, icon('close')));
    const footer = h('div', { class: 'qf-dialog-foot' });
    for (const b of opts.buttons || []) footer.appendChild(h('button', { class: 'qf-btn' + (b.primary ? ' qf-primary' : ''), onclick: () => b.onClick(values(), ctl) }, b.label));
    // OK and Cancel stay together at the right; on narrow screens the extra buttons wrap onto their own line.
    const main = h('span', { class: 'qf-foot-main' });
    if (opts.cancel !== false) main.appendChild(h('button', { class: 'qf-btn', onclick: () => finish(null) }, opts.cancel || 'Cancel'));
    if (opts.ok !== false) main.appendChild(h('button', { class: 'qf-btn qf-primary', onclick: okClick }, opts.ok || 'OK'));
    footer.appendChild(main);

    box.append(header, body, footer);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !isPhone()) finish(null); });
    document.body.appendChild(overlay);
    dialogStack.push(overlay);
    updateInert();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    build();
    opts.onOpen?.(ctl);
    opts.onChange?.(values(), ctl, '');
    // The field marked autofocus (else the first text field), unless the user already moved into the dialog.
    const first = body.querySelector<HTMLElement>('[autofocus]') || body.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), textarea, select');
    setTimeout(() => { if (!box.contains(document.activeElement)) first?.focus(); }, 30);
  });
}

function buildField(f: Field, ctl: DialogControl, changed: () => void): { row: HTMLElement; el: HTMLElement } {
  const id = 'f_' + f.key + '_' + Math.random().toString(36).slice(2, 7);
  let el: HTMLElement;
  const label = f.label ? h('label', { class: 'qf-label', for: id }, f.label) : null;
  switch (f.type) {
    case 'heading':
      el = h('h3', { class: 'qf-field-heading' }, f.label || '');
      return { row: el, el };
    case 'info':
      el = h('div', { class: 'qf-info', html: f.html ?? '' });
      if (!f.html && f.label) el.textContent = f.label;
      return { row: el, el };
    case 'button':
      el = h('button', { class: 'qf-btn', type: 'button', onclick: () => f.onClick?.(ctl.values(), ctl) }, f.label || '');
      return { row: h('div', { class: 'qf-field' }, el), el };
    case 'checkbox':
      el = h('input', { type: 'checkbox', id, checked: !!f.value });
      el.addEventListener('change', changed);
      return { row: h('div', { class: 'qf-field qf-check' + (f.half ? ' qf-half' : '') }, el, h('label', { for: id }, f.label || ''), f.help ? h('div', { class: 'qf-help' }, f.help) : null), el };
    case 'select': {
      const sel = h('select', { id }) as HTMLSelectElement;
      for (const o of f.options || []) {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        const oe = h('option', { value: String(opt.value) }, opt.label);
        if ((opt as any).style) oe.setAttribute('style', (opt as any).style);
        sel.appendChild(oe);
      }
      if (f.value != null) sel.value = String(f.value);
      sel.addEventListener('change', changed);
      el = sel;
      break;
    }
    case 'combo': {
      const listId = id + '_list';
      const inp = h('input', { id, type: 'text', list: listId, value: f.value ?? '', placeholder: f.placeholder || '' });
      const dl = h('datalist', { id: listId }, ...(f.options || []).map((o) => h('option', { value: typeof o === 'string' ? o : String(o.value) })));
      inp.addEventListener('input', changed);
      if (f.autofocus) inp.setAttribute('autofocus', '');
      el = inp;
      const row = h('div', { class: 'qf-field' + (f.half ? ' qf-half' : '') }, label, h('div', { class: 'qf-ctl' }, inp, dl, f.suffix ? h('span', { class: 'qf-suffix' }, f.suffix) : null), f.help ? h('div', { class: 'qf-help' }, f.help) : null);
      return { row, el };
    }
    case 'radio': {
      const wrap = h('div', { class: 'qf-radios', id, role: 'radiogroup' });
      for (const o of f.options || []) {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        const rid = id + '_' + String(opt.value).replace(/\W/g, '');
        const r = h('input', { type: 'radio', name: id, id: rid, value: String(opt.value), checked: String(f.value) === String(opt.value) });
        r.addEventListener('change', changed);
        wrap.appendChild(h('label', { class: 'qf-radio', for: rid }, r, ' ', opt.label));
      }
      el = wrap;
      break;
    }
    case 'list': {
      const sel = h('select', { id, size: String(f.rows || 8), multiple: !!f.multiple, class: 'qf-listbox' }) as HTMLSelectElement;
      for (const o of f.options || []) {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        const oe = h('option', { value: String(opt.value) }, opt.label);
        if ((opt as any).style) oe.setAttribute('style', (opt as any).style);
        sel.appendChild(oe);
      }
      if (f.value != null) {
        const vals = Array.isArray(f.value) ? f.value.map(String) : [String(f.value)];
        for (const o of sel.options) o.selected = vals.includes(o.value);
      }
      sel.addEventListener('change', changed);
      sel.addEventListener('dblclick', () => { (sel.closest('.qf-dialog')?.querySelector('.qf-primary') as HTMLElement | null)?.click(); });
      el = sel;
      break;
    }
    case 'textarea':
      el = h('textarea', { id, rows: String(f.rows || 4), placeholder: f.placeholder || '' }) as HTMLTextAreaElement;
      (el as HTMLTextAreaElement).value = f.value ?? '';
      el.addEventListener('input', changed);
      break;
    case 'color': {
      const inp = h('input', { id, type: 'color', value: toHex(f.value) || '#000000' });
      inp.addEventListener('input', changed);
      el = inp;
      break;
    }
    case 'range': {
      const inp = h('input', { id, type: 'range', min: String(f.min ?? 0), max: String(f.max ?? 100), step: String(f.step ?? 1), value: String(f.value ?? 0) });
      const out = h('span', { class: 'qf-suffix' }, String(f.value ?? 0) + (f.suffix || ''));
      inp.addEventListener('input', () => { out.textContent = (inp as HTMLInputElement).value + (f.suffix || ''); changed(); });
      el = inp;
      const row = h('div', { class: 'qf-field' + (f.half ? ' qf-half' : '') }, label, h('div', { class: 'qf-ctl' }, inp, out));
      return { row, el };
    }
    case 'file': {
      const inp = h('input', { id, type: 'file', accept: f.accept || '' });
      inp.addEventListener('change', changed);
      el = inp;
      break;
    }
    default: {
      const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'password' ? 'password' : f.type === 'time' ? 'time' : 'text';
      const inp = h('input', { id, type, placeholder: f.placeholder || '', autocomplete: 'off' }) as HTMLInputElement;
      if (f.type === 'number') {
        inp.inputMode = 'decimal';
        if (f.min != null) inp.min = String(f.min);
        if (f.max != null) inp.max = String(f.max);
        inp.step = String(f.step ?? 'any');
      }
      inp.value = f.value ?? '';
      inp.addEventListener('input', changed);
      if (f.autofocus) inp.setAttribute('autofocus', '');
      el = inp;
    }
  }
  if (f.width) el.style.width = f.width;
  const row = h('div', { class: 'qf-field' + (f.half ? ' qf-half' : '') }, label, h('div', { class: 'qf-ctl' }, el, f.suffix ? h('span', { class: 'qf-suffix' }, f.suffix) : null), f.help ? h('div', { class: 'qf-help' }, f.help) : null);
  return { row, el };
}

function readValue(el: HTMLElement, f: Field): any {
  switch (f.type) {
    case 'checkbox': return (el as HTMLInputElement).checked;
    case 'number': { const v = (el as HTMLInputElement).value; return v === '' ? null : parseFloat(v); }
    case 'range': return parseFloat((el as HTMLInputElement).value);
    case 'radio': { const c = el.querySelector<HTMLInputElement>('input:checked'); return c ? c.value : null; }
    case 'list': {
      const s = el as HTMLSelectElement;
      const sel = [...s.selectedOptions].map((o) => o.value);
      return f.multiple ? sel : sel[0] ?? null;
    }
    case 'file': return (el as HTMLInputElement).files?.[0] || null;
    default: return (el as HTMLInputElement).value;
  }
}

function writeValue(el: HTMLElement, f: Field, v: any): void {
  switch (f.type) {
    case 'checkbox': (el as HTMLInputElement).checked = !!v; break;
    case 'radio': { const r = el.querySelector<HTMLInputElement>(`input[value="${CSS.escape(String(v))}"]`); if (r) r.checked = true; break; }
    case 'list': {
      const s = el as HTMLSelectElement;
      if (Array.isArray(v) && !f.multiple) {
        clear(s);
        for (const o of v) { const opt = typeof o === 'string' ? { value: o, label: o } : o; s.appendChild(h('option', { value: String(opt.value) }, opt.label)); }
      } else {
        const vals = Array.isArray(v) ? v.map(String) : [String(v)];
        for (const o of s.options) o.selected = vals.includes(o.value);
      }
      break;
    }
    case 'color': (el as HTMLInputElement).value = toHex(v) || '#000000'; break;
    default: (el as HTMLInputElement).value = v ?? '';
  }
}

export function setListOptions(ctl: DialogControl, key: string, options: (string | { value: any; label: string; style?: string })[], selected?: string): void {
  const sel = ctl.body.querySelector<HTMLSelectElement>(`select.qf-listbox[id^="f_${key}_"]`);
  if (!sel) return;
  clear(sel);
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    const oe = h('option', { value: String(opt.value) }, opt.label);
    if ((opt as any).style) oe.setAttribute('style', (opt as any).style);
    if (selected != null && String(opt.value) === selected) oe.selected = true;
    sel.appendChild(oe);
  }
}

export function toHex(c: any): string | null {
  if (!c || typeof c !== 'string') return null;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  try {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = c;
    const v = ctx.fillStyle as string;
    return /^#/.test(v) ? v : null;
  } catch { return null; }
}

export async function alertDialog(title: string, message: string | HTMLElement): Promise<void> {
  const content = typeof message === 'string' ? h('div', { class: 'qf-msg' }, ...message.split('\n').map((l) => h('p', null, l))) : message;
  await openDialog({ title, content, cancel: false, ok: 'OK' });
}

export async function confirmDialog(title: string, message: string, ok = 'OK', cancel = 'Cancel'): Promise<boolean> {
  const r = await openDialog({ title, content: h('div', { class: 'qf-msg' }, ...message.split('\n').map((l) => h('p', null, l))), ok, cancel });
  return r !== null;
}

/** Three-way choice. Resolves to the index of the chosen button, or -1 for cancel. */
export function choiceDialog(title: string, message: string, choices: string[]): Promise<number> {
  return new Promise((resolve) => {
    let chosen = -1;
    openDialog({
      title, content: h('div', { class: 'qf-msg' }, message), ok: false, cancel: 'Cancel',
      buttons: choices.map((c, i) => ({ label: c, primary: i === 0, onClick: (_v, ctl) => { chosen = i; ctl.close({}); } })),
    }).then(() => resolve(chosen));
  });
}

export async function promptDialog(title: string, label: string, value = '', opts: Partial<Field> = {}): Promise<string | null> {
  const r = await openDialog({ title, fields: [{ key: 'v', label, type: 'text', value, autofocus: true, ...opts }] });
  return r ? (r.v as string) : null;
}

// ------------------------------------------------------------------------------------------
// Popup menus

let openMenus: HTMLElement[] = [];
/** Where focus goes back to when a menu is left with the keyboard (the button or editor it was opened from). */
let menuReturn: HTMLElement | null = null;
/** Whether the latest input was a key press: menus opened from the keyboard take focus, others leave it alone. */
let keyboardInput = false;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => { keyboardInput = true; }, true);
  for (const t of ['pointerdown', 'mousedown', 'touchstart']) document.addEventListener(t, () => { keyboardInput = false; }, true);
}

export function closeMenus(): void {
  for (const m of openMenus) m.remove();
  openMenus = [];
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('touchstart', outside, true);
}

function outside(e: Event) {
  if (openMenus.some((m) => m.contains(e.target as Node))) return;
  closeMenus();
}

export interface MenuOptions {
  onPick: (entry: MenuEntry) => void;
  anchor?: HTMLElement;
  x?: number; y?: number;
  level?: number;
  className?: string;
  title?: string;
  grid?: boolean;
  extra?: HTMLElement;
  /** Move focus into the menu (default: when it was opened from the keyboard). */
  focus?: boolean;
}

const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('button, input')].filter((x) => !(x as HTMLButtonElement).disabled && (x.offsetParent !== null || x === document.activeElement));

/** Arrow keys, Home/End, Right/Left for submenus, Escape and Tab inside a menu. */
function menuKey(ev: KeyboardEvent, menu: HTMLElement, level: number) {
  const items = menuItems(menu);
  const cur = document.activeElement as HTMLElement | null;
  const i = cur ? items.indexOf(cur) : -1;
  const typing = cur?.tagName === 'INPUT';
  const go = (j: number) => { ev.preventDefault(); items[(j + items.length) % items.length]?.focus(); };
  if (ev.key === 'ArrowDown') go(i + 1);
  else if (typing) { if (ev.key === 'Escape' || ev.key === 'Tab') leave(ev); }
  else if (ev.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
  else if (ev.key === 'Home') go(0);
  else if (ev.key === 'End') go(items.length - 1);
  else if (ev.key === 'ArrowRight' && cur?.querySelector('.qf-sub')) { ev.preventDefault(); cur.click(); }
  else if (ev.key === 'ArrowLeft' && level > 0) { ev.preventDefault(); for (const m of openMenus.slice(level)) m.remove(); openMenus = openMenus.slice(0, level); (menu as any)._back?.focus?.(); }
  else if (ev.key === 'Escape' || ev.key === 'Tab') leave(ev);
}
function leave(ev: KeyboardEvent) { ev.preventDefault(); const back = menuReturn; closeMenus(); back?.focus?.(); }

export function showMenu(entries: MenuEntry[], opts: MenuOptions): HTMLElement {
  const prior = document.activeElement as HTMLElement | null;
  if (!opts.level) { if (!prior?.closest?.('.qf-menu')) menuReturn = prior; closeMenus(); }
  const phone = isPhone();
  const menu = h('div', { class: 'qf-menu' + (opts.className ? ' ' + opts.className : '') + (opts.grid ? ' qf-menu-grid' : ''), role: 'menu' });
  if (opts.title) menu.appendChild(h('div', { class: 'qf-menu-title' }, opts.title));
  for (const e of entries) {
    if (e.separator) { menu.appendChild(h('div', { class: 'qf-menu-sep', role: 'separator' })); continue; }
    if (e.heading) { menu.appendChild(h('div', { class: 'qf-menu-heading' }, e.heading)); continue; }
    const item = h('button', { class: 'qf-menu-item' + (e.checked ? ' qf-checked' : ''), role: 'menuitem', type: 'button', title: e.label || '' });
    if (e.swatch !== undefined) item.appendChild(h('span', { class: 'qf-swatch', style: `background:${e.swatch || 'transparent'}` }));
    else if (e.icon) item.appendChild(icon(e.icon));
    else item.appendChild(h('span', { class: 'qf-icon-space' }, e.checked ? '✓' : ''));
    const lab = h('span', { class: 'qf-menu-label' }, e.label || e.id || '');
    if (e.preview) lab.setAttribute('style', e.preview);
    item.appendChild(lab);
    if (e.submenu) item.appendChild(icon('chevron_right', 'qf-sub'));
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (e.submenu) {
        const r = item.getBoundingClientRect();
        if (phone) {
          showMenu([{ label: '‹ Back', icon: 'arrow_back', id: '__back' }, { separator: true }, ...e.submenu], {
            ...opts, level: 0, x: r.left, y: r.top,
            onPick: (pe) => { if (pe.id === '__back') showMenu(entries, { ...opts, level: 0 }); else opts.onPick(pe); },
          });
        } else {
          for (const m of openMenus.slice((opts.level || 0) + 1)) m.remove();
          openMenus = openMenus.slice(0, (opts.level || 0) + 1);
          showMenu(e.submenu, { ...opts, level: (opts.level || 0) + 1, anchor: undefined, x: r.right - 4, y: r.top });
        }
        return;
      }
      const back = keyboardInput && menu.contains(document.activeElement) ? menuReturn : null;
      closeMenus();
      back?.focus?.();
      opts.onPick(e);
    });
    menu.appendChild(item);
  }
  if (opts.extra) menu.appendChild(opts.extra);
  document.body.appendChild(menu);
  openMenus.push(menu);
  (menu as any)._back = prior;
  menu.addEventListener('keydown', (ev) => menuKey(ev, menu, opts.level || 0));
  // Position: next to the anchor, kept inside the area not covered by status, navigation or gesture bars.
  const sa = safeInsets();
  const left = sa.left + 4, top = sa.top + 4, right = window.innerWidth - sa.right - 4, bottom = window.innerHeight - sa.bottom - 4;
  const mr = menu.getBoundingClientRect();
  let x = opts.x ?? 0, y = opts.y ?? 0;
  if (opts.anchor) { const r = opts.anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 2; if (y + mr.height > bottom - 4 && r.top - mr.height > top + 4) y = r.top - mr.height - 2; }
  if (x + mr.width > right) x = right - mr.width;
  if (y + mr.height > bottom) y = bottom - mr.height;
  x = Math.max(left, x); y = Math.max(top, y);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  if (opts.focus ?? keyboardInput) menuItems(menu)[0]?.focus();
  if (!opts.level) {
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('touchstart', outside, true);
    }, 0);
  }
  return menu;
}

/** Current system-bar insets in CSS pixels (the --sat/--sab/--sal/--sar variables in app.css). */
export function safeInsets(): { top: number; bottom: number; left: number; right: number } {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:var(--sat) var(--sar) var(--sab) var(--sal)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const r = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };
  probe.remove();
  return r;
}

// ------------------------------------------------------------------------------------------
// Color picker

export const THEME_COLORS = [
  ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'],
  ['#f2f2f2', '#7f7f7f', '#d0cece', '#d6dce4', '#d9e2f3', '#fbe5d5', '#ededed', '#fff2cc', '#deebf6', '#e2efd9'],
  ['#d8d8d8', '#595959', '#aeabab', '#adb9ca', '#b4c6e7', '#f7cbac', '#dbdbdb', '#fee599', '#bdd7ee', '#c5e0b3'],
  ['#bfbfbf', '#3f3f3f', '#757070', '#8496b0', '#8eaadb', '#f4b183', '#c9c9c9', '#ffd965', '#9cc3e5', '#a8d08d'],
  ['#a5a5a5', '#262626', '#3a3838', '#323f4f', '#2f5496', '#c55a11', '#7b7b7b', '#bf9000', '#2e75b5', '#538135'],
  ['#7f7f7f', '#0c0c0c', '#171616', '#222a35', '#1f3864', '#833c0b', '#525252', '#7f6000', '#1e4e79', '#375623'],
];
export const STANDARD_COLORS = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
export const HIGHLIGHT_COLORS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0', '#000000', '#ffd8a8', '#ffc9de', '#d0bfff'];

const recentColors: string[] = [];

export function colorMenu(anchor: HTMLElement | { x: number; y: number }, opts: { none?: string; auto?: string; highlight?: boolean; title?: string } = {}): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let resolved = false;
    const pick = (c: string | null) => {
      if (resolved) return;
      resolved = true;
      if (c && !recentColors.includes(c)) { recentColors.unshift(c); recentColors.splice(10); }
      const back = keyboardInput && m.contains(document.activeElement) ? menuReturn : null;
      closeMenus();
      back?.focus?.();
      resolve(c);
    };
    const grid = h('div', { class: 'qf-colors' });
    const sw = (c: string) => h('button', { class: 'qf-color', style: `background:${c}`, title: c, 'aria-label': c, onclick: () => pick(c) });
    if (opts.auto) grid.appendChild(h('button', { class: 'qf-btn qf-full', onclick: () => pick(null) }, opts.auto));
    if (opts.highlight) {
      grid.appendChild(h('div', { class: 'qf-color-row' }, ...HIGHLIGHT_COLORS.map(sw)));
    } else {
      grid.appendChild(h('div', { class: 'qf-menu-heading' }, 'Theme Colors'));
      for (const row of THEME_COLORS) grid.appendChild(h('div', { class: 'qf-color-row' }, ...row.map(sw)));
      grid.appendChild(h('div', { class: 'qf-menu-heading' }, 'Standard Colors'));
      grid.appendChild(h('div', { class: 'qf-color-row' }, ...STANDARD_COLORS.map(sw)));
    }
    if (recentColors.length) {
      grid.appendChild(h('div', { class: 'qf-menu-heading' }, 'Recent Colors'));
      grid.appendChild(h('div', { class: 'qf-color-row' }, ...recentColors.map(sw)));
    }
    if (opts.none) grid.appendChild(h('button', { class: 'qf-btn qf-full', onclick: () => pick(null) }, opts.none));
    const more = h('input', { type: 'color', class: 'qf-color-more', 'aria-label': 'More colors' }) as HTMLInputElement;
    more.addEventListener('change', () => pick(more.value));
    grid.appendChild(h('label', { class: 'qf-btn qf-full qf-morecolors' }, icon('palette'), ' More Colors… ', more));
    const pos = anchor instanceof HTMLElement ? { anchor } : { x: anchor.x, y: anchor.y };
    const m = showMenu([], { ...pos, onPick: () => undefined, extra: grid, title: opts.title, className: 'qf-color-menu' });
    const obs = new MutationObserver(() => { if (!m.isConnected) { obs.disconnect(); if (!resolved) { resolved = true; resolve(undefined); } } });
    obs.observe(document.body, { childList: true });
  });
}

export function inDialog(): boolean {
  return dialogDepth > 0;
}
