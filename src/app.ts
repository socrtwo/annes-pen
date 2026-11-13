/** Anne's Pen application core: document tabs, dispatch pipeline, command execution. */
import { isSafeExternalUrl } from './util/sanitize';
import { normalizeTables } from './editor/normalize';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { DocAttrStep, Mapping } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, emptyDoc } from './editor/schema';
import { buildPlugins, canonicalKey, keyName } from './editor/setup';
import { trackTransaction, trackKey } from './editor/plugins/trackChanges';
import { pageInfo, repaginate, type PageConfig } from './editor/plugins/pagination';
import { footnoteLabel, focusKey, proofKey } from './editor/plugins/decorations';
import { buildNodeViews } from './editor/nodeviews';
import { normalizeSettings, defaultSettings, pageDims, type DocSettings } from './editor/settings';
import { stylesCss } from './editor/styles';
import { expandTokens, computeFields, applyFieldValues } from './editor/fields';
import { getCommand, allCommands, type Command } from './commands/registry';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { kvSet, kvDel, kvLastError, SESSION_ID, sessionBeat } from './util/store';
import { toast } from './ui/dialog';
import { esc } from './ui/dom';
import type { Shell } from './ui/shell';
import { Proofer } from './proof/proofing';
import { embedHidden } from './embed/hidden';

export interface PositionTracker {
  tab: DocTab;
  map(pos: number, assoc?: number): number;
  deleted(pos: number, assoc?: number): boolean;
  /** The document was replaced (Revert, reload) or closed: old positions mean nothing. */
  readonly lost: boolean;
  readonly changed: boolean;
  done(): void;
}

/** App.trackPositions, or (for minimal stand-ins of App) a tracker that only notices a changed document. */
export function trackPositions(app: App): PositionTracker {
  if (typeof (app as any).trackPositions === 'function') return app.trackPositions();
  const doc0 = app.state.doc;
  return { tab: app.tab, map: (p) => p, deleted: () => false, get lost() { return app.state.doc !== doc0; }, get changed() { return app.state.doc !== doc0; }, done() {} };
}

/** A node to find again after waiting on the user (a dialog): where it was, or else where that same node
 *  object is now (nodes the edits did not touch stay the same objects). */
export interface PinnedNode { pos: number; node: PMNode | null }
export function pinNode(doc: PMNode, pos: number): PinnedNode {
  return { pos, node: pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null };
}
/** The pinned node's position in `doc`, or -1 if it is gone or was changed. */
export function findPinned(doc: PMNode, pin: PinnedNode): number {
  if (!pin.node) return -1;
  if (pin.pos < doc.content.size && doc.nodeAt(pin.pos) === pin.node) return pin.pos;
  let at = -1;
  doc.descendants((n, p) => { if (at < 0 && n === pin.node) at = p; return at < 0; });
  return at;
}

/** The link under a click inside a document. */
function linkTarget(view: EditorView, e: Event): HTMLAnchorElement | null {
  const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  return a && view.dom.contains(a) ? a : null;
}

export type ViewMode = 'print' | 'web' | 'mobile' | 'read' | 'outline' | 'draft' | 'focus';

let tabCounter = 0;
const RECORDED_KEYS = new Set(['Enter', 'Mod-Enter', 'Backspace', 'Mod-Backspace', 'Delete', 'Mod-Delete', 'Tab', 'Shift-Tab']);

export class DocTab {
  id = `t${Date.now().toString(36)}${tabCounter++}`;
  title = 'Document';
  fileName = '';
  format = 'docx';
  uri: string | null = null;
  dirty = false;
  created = Date.now();
  saved = 0;
  viewMode: ViewMode = 'print';
  zoom = 1;
  zoomMode: 'fixed' | 'pageWidth' | 'onePage' | 'multi' = 'pageWidth';
  readOnly = false;
  editStart = Date.now();
  sessionStartWords = -1;
  el!: HTMLElement;        // scroll container
  page!: HTMLElement;      // page column (zoom target)
  mount!: HTMLElement;
  view!: EditorView;
  styleEl!: HTMLStyleElement;
  lastSettings: any = null;
  mergeIndex: number | null = null;
  /** How this document was recovered from a damaged file, if it was. */
  recovery: import('./io/recover').RecoveryReport | null = null;
  /** Storage key for documents without a unique URI (see docKey in commands/file). */
  key = '';
  /** Opened from (or saved as) an encrypted .qpde file: the key derived from its password, kept in memory only.
   *  Save re-encrypts with it; drafts are stored encrypted and snapshots are not taken. */
  encryption: import('./util/crypto').DocKey | null = null;
  /** Recent edit locations in this document (Go Back). */
  editPositions: number[] = [];
  /** Position trackers of commands waiting on a dialog (see App.trackPositions). */
  posTrackers = new Set<{ mapping: Mapping; lost: boolean }>();
  constructor(public app: App) {}

  get state(): EditorState { return this.view.state; }
  initState: EditorState | null = null;
  get settings(): DocSettings { return normalizeSettings((this.view?.state ?? this.initState)?.doc.attrs.settings); }
  get displayName(): string { return this.fileName || this.title; }
}

export class App {
  prefs: Prefs = loadPrefs();
  docs: DocTab[] = [];
  active!: DocTab;
  ui!: Shell;
  recording: { name: string; steps: { id: string; arg?: any }[] } | null = null;
  recordingPaused = false;
  clipboard: { html: string; text: string; time: number }[] = [];
  spike: any[] = [];
  private refreshQueued = false;
  private autosaveTimer: any = null;
  private listeners = new Set<(app: App) => void>();
  lastCommand: { id: string; arg?: any } | null = null;
  keyIndex = new Map<string, string>();
  /** The active document's recent edit locations. */
  get editPositions(): number[] { return this.active?.editPositions ?? []; }
  proofer: Proofer;
  /** Embedded editor for Anne's Post (?embed=compose): no file commands, drafts or autosave (docs/EMBED.md). */
  embedded = false;
  /** Theme requested by the embedding app; overrides the preference without saving it. */
  embedTheme: 'light' | 'dark' | null = null;
  /** Done / Cancel of the embedded editor's bar (set by src/embed/mode.ts). */
  embedControls: { done(): void; cancel(): void } | null = null;
  private docChangeListeners = new Set<(tab: DocTab) => void>();

  constructor(public host: HTMLElement) {
    this.proofer = new Proofer(this);
    this.rebuildKeyIndex();
  }

  get tab(): DocTab { return this.active; }
  get view(): EditorView { return this.active.view; }
  get state(): EditorState { return this.active.view.state; }
  get settings(): DocSettings { return this.active.settings; }

  onRefresh(fn: (app: App) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Called after every user edit (not for loads, field updates or other derived changes). */
  onDocChange(fn: (tab: DocTab) => void): () => void { this.docChangeListeners.add(fn); return () => this.docChangeListeners.delete(fn); }

  savePrefs(): void { savePrefs(this.prefs); this.rebuildKeyIndex(); }

  rebuildKeyIndex(): void {
    this.keyIndex.clear();
    for (const c of allCommands()) for (const k of c.keys || []) this.keyIndex.set(canonicalKey(k), c.id);
    for (const [k, id] of Object.entries(this.prefs.keymap)) {
      if (id) this.keyIndex.set(canonicalKey(k), id); else this.keyIndex.delete(canonicalKey(k));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Documents

  createTab(doc?: PMNode, meta: Partial<DocTab> = {}): DocTab {
    if (doc) doc = normalizeTables(doc);
    const tab = new DocTab(this);
    Object.assign(tab, meta);
    if (!meta.viewMode) tab.viewMode = this.defaultViewMode();
    const settings = normalizeSettings(doc?.attrs.settings);
    if (!doc) {
      const s = defaultSettings();
      if (this.prefs.defaultFont || this.prefs.defaultSize) {
        s.styles.Normal = { name: 'Normal', type: 'paragraph', ...(this.prefs.defaultFont ? { font: this.prefs.defaultFont } : {}), ...(this.prefs.defaultSize ? { size: this.prefs.defaultSize } : {}) } as any;
      }
      s.properties.author = this.prefs.author;
      doc = emptyDoc(s);
    } else if (!doc.attrs.settings || !Object.keys(doc.attrs.settings).length) {
      doc = schema.node('doc', { settings }, doc.content);
    }
    this.ui.mountTab(tab);
    const self = this;
    const plugins = buildPlugins({
      autoformat: () => self.prefs.autoformat,
      replacements: () => self.prefs.replacements,
      pageConfig: () => self.pageConfig(tab),
      commandKey: (key) => self.handleKey(key),
      author: () => self.prefs.author,
      wordCompletion: () => self.prefs.wordCompletion,
      slashMenu: (view) => self.ui.slashMenu(view),
      slashEnabled: () => self.prefs.slashMenu,
    });
    const state = EditorState.create({ doc, plugins });
    tab.initState = state;
    tab.view = new EditorView(tab.mount, {
      state,
      dispatchTransaction: (tr) => this.dispatch(tab, tr),
      editable: () => !tab.readOnly && !tab.settings.markedFinal && tab.settings.protection.mode !== 'readonly' && tab.viewMode !== 'read',
      nodeViews: buildNodeViews({
        editMath: (view, pos) => this.exec('insert.equationEdit', { pos }),
        controlClick: (view, pos, node, el) => this.ui.controlClick(tab, pos, node, el),
        imageEdit: (view, pos) => this.exec('picture.formatDialog', { pos }),
        genBlockClick: (view, pos, node, e) => {
          const t = e.target as HTMLElement;
          if (t.closest('[data-act=update]')) { e.preventDefault(); this.exec('refs.updateGenerated', { pos }); }
          const a = t.closest('a[href^="#"]') as HTMLAnchorElement | null;
          if (a) { e.preventDefault(); this.exec('nav.gotoAnchor', a.getAttribute('href')!.slice(1)); }
        },
      }),
      attributes: () => ({
        class: 'qf-editor',
        spellcheck: this.prefs.nativeSpellcheck ? 'true' : 'false',
        lang: tab.settings.language || 'en-US',
        autocapitalize: 'sentences',
        'aria-label': 'Document body',
        role: 'textbox',
        'aria-multiline': 'true',
      }),
      handleDOMEvents: {
        contextmenu: (view, e) => { e.preventDefault(); this.ui.contextMenu(e as MouseEvent); return true; },
        copy: (view, e) => { this.rememberClipboard(); return false; },
        cut: (view, e) => { this.rememberClipboard(); return false; },
        // The click after the mouseup handled in handleClickOn would still follow the link and navigate
        // the app itself (relative links included): links are only ever opened by followLink.
        click: (view, e) => { if (linkTarget(view, e)) e.preventDefault(); return false; },
        auxclick: (view, e) => { if (linkTarget(view, e)) e.preventDefault(); return false; },
      },
      handleTextInput: (view, from, to, text) => {
        if (this.recording) this.recordStep('edit.typeText', text);
        return false;
      },
      handleKeyDown: (view, e) => {
        // Editing keys handled by the keymap rather than a command are recorded too (replayed by edit.key).
        const k = this.recording && keyName(e);
        if (k && RECORDED_KEYS.has(canonicalKey(k)) && !this.keyIndex.has(canonicalKey(k))) this.recordStep('edit.key', k);
        return false;
      },
      handleClickOn: (view, pos, node, nodePos, e) => {
        const t = e.target as HTMLElement;
        if (node.type === schema.nodes.task_item || t.closest?.('li.qf-task')) {
          const li = t.closest('li.qf-task') as HTMLElement | null;
          if (li && e.offsetX < 0 + 22 && t === li) {
            const n = view.state.doc.nodeAt(nodePos);
            if (n && n.type === schema.nodes.task_item) {
              view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { checked: !n.attrs.checked }));
              return true;
            }
          }
        }
        if (node.type === schema.nodes.footnote) { this.ui.showFootnote(tab, nodePos, node); return true; }
        if (node.type === schema.nodes.citation) { this.exec('refs.editCitation', { pos: nodePos }); return true; }
        if (node.type === schema.nodes.field && (e as MouseEvent).detail >= 2) { this.exec('insert.editField', { pos: nodePos }); return true; }
        const link = t.closest?.('a[href]') as HTMLAnchorElement | null;
        if (link) {
          // Never let the WebView navigate itself to a document link.
          e.preventDefault();
          if ((e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey || tab.viewMode === 'read' || !view.editable) {
            this.followLink(link.getAttribute('href') || '');
            return true;
          }
        }
        return false;
      },
    });
    tab.styleEl = document.createElement('style');
    tab.el.appendChild(tab.styleEl);
    this.docs.push(tab);
    this.activate(tab);
    this.applySettingsToDom(tab);
    this.applyViewMode(tab);
    this.updateFields(tab);
    tab.sessionStartWords = -1;
    this.proofer.schedule(tab, 400);
    return tab;
  }

  defaultViewMode(): ViewMode {
    const pref = this.prefs.defaultView;
    // A message has no pages: the embedded editor reflows to the frame.
    if (this.embedded) return window.innerWidth < 700 ? 'mobile' : 'web';
    if (pref !== 'auto') return pref;
    return window.innerWidth < 700 ? 'mobile' : 'print';
  }

  activate(tab: DocTab): void {
    this.active = tab;
    for (const d of this.docs) d.el.classList.toggle('qf-hidden-tab', d !== tab);
    this.ui.tabsChanged();
    this.refresh();
    document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – Anne\'s Pen`;
  }

  closeTab(tab: DocTab): void {
    const i = this.docs.indexOf(tab);
    if (i < 0) return;
    for (const t of tab.posTrackers) t.lost = true;
    tab.view.destroy();
    tab.el.remove();
    this.docs.splice(i, 1);
    kvDel('draft:' + tab.id);
    if (!this.docs.length) this.createTab();
    else this.activate(this.docs[Math.max(0, i - 1)]);
  }

  replaceDoc(tab: DocTab, doc: PMNode): void {
    const state = EditorState.create({ doc: normalizeTables(doc), plugins: tab.view.state.plugins });
    for (const t of tab.posTrackers) t.lost = true;
    tab.view.updateState(state);
    this.applySettingsToDom(tab);
    this.updateFields(tab);
    repaginate(tab.view, 0);
    this.refresh();
  }

  // ------------------------------------------------------------------------------------------
  // Dispatch

  dispatch(tab: DocTab, tr: Transaction): void {
    const view = tab.view;
    const old = view.state;
    // A transaction built before the document last changed (typically before an awaited dialog) cannot be
    // applied: refuse it with a message instead of a RangeError.
    if (tr.before !== old.doc) { toast('The document changed while this command was waiting. Try it again.'); return; }
    // Protection applies to every content change (trackSkip only means "do not track this"), except
    // explicitly allowed ones (field updates, Restrict Editing) and settings-only changes that leave
    // the protection itself alone.
    if (tr.docChanged && !tr.getMeta('allowProtected') && !this.isSettingsOnly(tab, tr)) {
      const s = tab.settings;
      if (s.protection.mode === 'readonly' || s.markedFinal) { this.blocked('This document is read-only. Use Review ▸ Restrict Editing to change protection.'); return; }
      if (s.protection.mode === 'comments' && !tr.getMeta('comment')) { this.blocked('Only comments are allowed in this document.'); return; }
      if (s.protection.mode === 'forms' && !tr.getMeta('form')) { this.blocked('Only form fields can be filled in.'); return; }
      if (s.protection.mode === 'tracked' && tr.getMeta('trackSkip') && !tr.getMeta('comment')) { this.blocked('Only tracked changes are allowed in this document.'); return; }
    }
    const t = trackTransaction(tr, old, tab.settings.protection.mode === 'tracked');
    const next = old.apply(t);
    view.updateState(next);
    if (t.docChanged) {
      for (const pt of tab.posTrackers) pt.mapping.appendMapping(t.mapping);
      const head = next.selection.head;
      const ep = tab.editPositions;
      for (let i = 0; i < ep.length; i++) ep[i] = t.mapping.map(ep[i]);
      const lastPos = ep[ep.length - 1];
      if (lastPos == null || Math.abs(lastPos - head) > 200) { ep.push(head); if (ep.length > 20) ep.shift(); }
      else ep[ep.length - 1] = head;
      // noDirty: derived updates (field values refreshed on open) are not user edits.
      if (!tr.getMeta('noDirty')) {
        if (!tab.dirty) { tab.dirty = true; this.ui.tabsChanged(); document.title = `${tab.displayName} • – Anne\'s Pen`; }
        this.scheduleAutosave();
        for (const fn of this.docChangeListeners) fn(tab);
      }
      this.proofer.schedule(tab);
    }
    if (old.doc.attrs.settings !== next.doc.attrs.settings) this.applySettingsToDom(tab);
    if (t.docChanged || t.selectionSet || t.storedMarksSet || t.getMeta('refresh') || t.getMeta(proofKey)) this.refresh();
    if (this.prefs.typewriter && (t.docChanged || t.selectionSet)) this.typewriterScroll(tab);
  }

  /**
   * Maps positions in a tab's current document through every change made to it until done() is called.
   * Commands that wait on a dialog use it to apply positions they found before the wait.
   */
  trackPositions(tab = this.active): PositionTracker {
    const t = { mapping: new Mapping(), lost: false };
    tab.posTrackers.add(t);
    return {
      tab,
      map: (pos, assoc = 1) => t.mapping.map(pos, assoc),
      deleted: (pos, assoc = 1) => t.mapping.mapResult(pos, assoc).deleted,
      get lost() { return t.lost; },
      get changed() { return t.lost || t.mapping.maps.length > 0; },
      done: () => { tab.posTrackers.delete(t); },
    };
  }

  /** A transaction that only changes document settings without touching protection. */
  private isSettingsOnly(tab: DocTab, tr: Transaction): boolean {
    if (!tr.steps.every((st) => st instanceof DocAttrStep)) return false;
    const before = tab.settings, after = normalizeSettings(tr.doc.attrs.settings);
    return JSON.stringify(before.protection) === JSON.stringify(after.protection) && before.markedFinal === after.markedFinal;
  }

  private blocked(msg: string): void {
    toast(msg);
  }

  refresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      if (!this.active) return;
      this.ui.refresh();
      for (const l of this.listeners) l(this);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Commands

  handleKey(key: string): boolean {
    const id = this.keyIndex.get(canonicalKey(key));
    if (!id) return false;
    const c = getCommand(id);
    if (!c) return false;
    if (c.isEnabled && !c.isEnabled(this)) return false;
    this.exec(id);
    return true;
  }

  exec(id: string, arg?: any): unknown {
    const c = getCommand(id);
    if (!c) { toast(`Unknown command: ${id}`); return false; }
    if (this.embedded && embedHidden(id)) { toast(`${c.label} is not available while you edit a message.`); return false; }
    if (c.edits && !this.view.editable) {
      toast('The document is read-only.');
      return false;
    }
    if (c.isEnabled && !c.isEnabled(this)) { toast(`${c.label} is not available here.`); return false; }
    if (this.recording && !c.noRecord && id !== 'dev.recordMacro' && id !== 'dev.stopRecording') this.recordStep(id, arg);
    if (!c.noRecord && id !== 'edit.repeat') this.lastCommand = { id, arg };
    try {
      const r = c.run(this, arg);
      if (r instanceof Promise) r.catch((e) => this.reportError(c, e)).finally(() => this.refresh());
      this.refresh();
      return r;
    } catch (e) {
      this.reportError(c, e);
      return false;
    }
  }

  private reportError(c: Command, e: unknown): void {
    console.error(e);
    toast(`${c.label}: ${(e as any)?.message || e}`);
  }

  recordStep(id: string, arg?: any): void {
    if (!this.recording || this.recordingPaused) return;
    const steps = this.recording.steps;
    const last = steps[steps.length - 1];
    if (id === 'edit.typeText' && last && last.id === 'edit.typeText') { last.arg += arg; return; }
    steps.push(arg === undefined ? { id } : { id, arg: JSON.parse(JSON.stringify(arg)) });
  }

  // ------------------------------------------------------------------------------------------
  // Settings, styles and pagination

  updateSettings(fn: (s: DocSettings) => void, tab = this.active): void {
    const cur = tab.settings;
    const copy = JSON.parse(JSON.stringify(cur)) as DocSettings;
    fn(copy);
    const tr = tab.view.state.tr.setDocAttribute('settings', copy).setMeta('settingsChanged', true).setMeta('trackSkip', true);
    tab.view.dispatch(tr);
  }

  applySettingsToDom(tab: DocTab): void {
    const s = tab.settings;
    const { w, h } = pageDims(s.page);
    const p = tab.page;
    p.style.setProperty('--qf-page-w', `${w}pt`);
    p.style.setProperty('--qf-page-h', `${h}pt`);
    p.style.setProperty('--qf-m-top', `${s.page.margin.top}pt`);
    p.style.setProperty('--qf-m-right', `${s.page.margin.right}pt`);
    p.style.setProperty('--qf-m-bottom', `${s.page.margin.bottom}pt`);
    p.style.setProperty('--qf-m-left', `${s.page.margin.left + (s.page.gutter || 0)}pt`);
    p.style.setProperty('--qf-page-color', s.pageColor || (this.prefs.darkPage ? '#1e1e1e' : '#ffffff'));
    p.classList.toggle('qf-dark-page', this.prefs.darkPage && !s.pageColor);
    p.style.setProperty('--qf-tab', `${s.defaultTab}pt`);
    p.dataset.pageBorder = s.pageBorder ? '1' : '';
    p.style.setProperty('--qf-page-border', s.pageBorder || 'none');
    p.classList.toggle('qf-line-numbers', !!s.lineNumbers.enabled);
    if (s.watermark && s.watermark.text) {
      p.style.setProperty('--qf-wm-text', JSON.stringify(s.watermark.text));
      p.style.setProperty('--qf-wm-color', s.watermark.color || '#c0c0c0');
      p.style.setProperty('--qf-wm-opacity', String(s.watermark.opacity ?? 0.35));
      p.style.setProperty('--qf-wm-rot', s.watermark.diagonal ? '-45deg' : '0deg');
      p.dataset.watermark = '1';
    } else delete p.dataset.watermark;
    const css = stylesCss(s);
    if (tab.styleEl.textContent !== css) tab.styleEl.textContent = css;
    tab.lastSettings = tab.view.state.doc.attrs.settings;
    this.ui.updatePrintCss(tab);
    repaginate(tab.view, 0);
  }

  pageConfig(tab: DocTab): PageConfig {
    const s = tab.settings;
    const { w, h } = pageDims(s.page);
    const enabled = tab.viewMode === 'print';
    const hfCtx = (page: number, pages: number) => ({ page, pages, settings: s, fileName: tab.displayName, userName: this.prefs.author });
    const render = (kind: 'header' | 'footer') => (page: number, pages: number) => {
      let hf = s[kind];
      if (s.differentFirst && page === 1) hf = kind === 'header' ? s.firstHeader : s.firstFooter;
      else if (s.differentOddEven && page % 2 === 0) hf = kind === 'header' ? s.evenHeader : s.evenFooter;
      const c = hfCtx(page, pages);
      // Escape after expanding: token values (title, author, file name...) come from the document.
      const part = (t: string) => esc(expandTokens(t || '', c)).replace(/\n/g, '<br>');
      if (!hf.left && !hf.center && !hf.right) return '';
      return `<span class="qf-hf-l">${part(hf.left)}</span><span class="qf-hf-c">${part(hf.center)}</span><span class="qf-hf-r">${part(hf.right)}</span>`;
    };
    return {
      enabled,
      widthPt: w,
      heightPt: h,
      margin: { ...s.page.margin, left: s.page.margin.left + (s.page.gutter || 0) },
      gapPx: 24,
      header: render('header'),
      footer: render('footer'),
      footnotesAtPageBottom: s.footnoteFormat.placement === 'page',
      footnoteNumber: (pos) => footnoteLabel(tab.view.state, pos),
      footnoteHtml: (node, num) => `<span class="qf-fn-item"><sup>${esc(num)}</sup> ${esc(node.attrs.text)}</span>`,
    };
  }

  setViewMode(mode: ViewMode, tab = this.active): void {
    tab.viewMode = mode;
    this.applyViewMode(tab);
    this.refresh();
  }

  applyViewMode(tab: DocTab): void {
    const modes: ViewMode[] = ['print', 'web', 'mobile', 'read', 'outline', 'draft', 'focus'];
    for (const m of modes) tab.el.classList.toggle('qf-mode-' + m, tab.viewMode === m);
    tab.view.setProps({});
    const focusMode = tab.viewMode === 'focus' ? (this.prefs.focus === 'off' ? 'paragraph' : this.prefs.focus) : this.prefs.focus;
    tab.view.dispatch(tab.view.state.tr.setMeta(focusKey, { mode: focusMode }).setMeta('addToHistory', false));
    this.applyZoom(tab);
    repaginate(tab.view, 0);
  }

  applyZoom(tab = this.active): void {
    const s = tab.settings;
    const { w, h } = pageDims(s.page);
    let z = tab.zoom;
    const avail = tab.el.clientWidth - 24;
    if (tab.viewMode === 'print' || tab.viewMode === 'read') {
      if (tab.zoomMode === 'pageWidth' && avail > 0) z = Math.min(2, avail / (w * 4 / 3));
      if (tab.zoomMode === 'onePage' && avail > 0) z = Math.min(avail / (w * 4 / 3), (tab.el.clientHeight - 24) / (h * 4 / 3));
    } else if (tab.zoomMode !== 'fixed') z = 1;
    z = Math.max(0.1, Math.min(5, z));
    tab.zoom = z;
    tab.page.style.zoom = String(z);
    this.ui.refresh();
  }

  setZoom(z: number, mode: DocTab['zoomMode'] = 'fixed'): void {
    this.active.zoom = z;
    this.active.zoomMode = mode;
    this.applyZoom();
    repaginate(this.view, 50);
  }

  typewriterScroll(tab: DocTab): void {
    const view = tab.view;
    try {
      const c = view.coordsAtPos(view.state.selection.head);
      const r = tab.el.getBoundingClientRect();
      const target = r.top + r.height * 0.45;
      tab.el.scrollTop += c.top - target;
    } catch { /* */ }
  }

  // ------------------------------------------------------------------------------------------
  // Fields

  updateFields(tab = this.active, range?: { from: number; to: number }): void {
    const s = tab.settings;
    const info = pageInfo(tab.view.state);
    const merge = s.mergeData && s.mergePreview != null ? Object.fromEntries(s.mergeData.fields.map((f, i) => [f, s.mergeData!.rows[s.mergePreview!]?.[i] ?? ''])) : null;
    const updates = computeFields({
      settings: s, fileName: tab.displayName, userName: this.prefs.author, userInitials: this.prefs.initials,
      pageOf: (pos) => { let p = 1; info.starts.forEach((st, i) => { if (st <= pos) p = i + 1; }); return p; },
      pages: info.pages, created: tab.created, saved: tab.saved, mergeRecord: merge, mergeIndex: s.mergePreview ?? undefined, doc: tab.view.state.doc,
    }, range);
    if (!updates.length) return;
    const tr = applyFieldValues(tab.view.state.tr, updates).setMeta('trackSkip', true).setMeta('addToHistory', false).setMeta('allowProtected', true).setMeta('noDirty', true);
    tab.view.dispatch(tr);
  }

  // ------------------------------------------------------------------------------------------
  // Clipboard history (multi-item clipboard pane)

  rememberClipboard(): void {
    const { state } = this.view;
    if (state.selection.empty) return;
    const slice = state.selection.content();
    const div = document.createElement('div');
    const ser = (window as any).__qfSerializer;
    if (ser) div.appendChild(ser.serializeFragment(slice.content));
    const text = state.doc.textBetween(state.selection.from, state.selection.to, '\n', ' ');
    this.clipboard.unshift({ html: div.innerHTML, text, time: Date.now() });
    this.clipboard.splice(this.prefs.clipboardHistory);
    this.refresh();
  }

  // ------------------------------------------------------------------------------------------
  // Autosave and drafts

  scheduleAutosave(): void {
    // Throttle, not debounce: continuous typing must still save every few seconds.
    if (this.embedded || !this.prefs.autosave || this.autosaveTimer) return;
    this.autosaveTimer = setTimeout(() => { this.autosaveTimer = null; void this.saveDrafts(); }, Math.max(3, this.prefs.autosaveSeconds) * 1000);
  }

  async saveDrafts(): Promise<void> {
    // The embedding app owns an embedded message: nothing of it is stored here.
    if (this.embedded) return;
    sessionBeat();
    let saved = 0, failed = 0;
    for (const tab of this.docs) {
      if (!tab.dirty) continue;
      // An encrypted document's draft is encrypted with its key (the plain text is never stored).
      const body = tab.encryption
        ? { enc: await (await import('./util/crypto')).encryptWithKey(tab.view.state.doc.toJSON(), tab.encryption) }
        : { json: tab.view.state.doc.toJSON() };
      const ok = await kvSet('draft:' + tab.id, {
        id: tab.id, ...body, title: tab.title, fileName: tab.fileName, format: tab.format, uri: tab.uri, key: tab.key, time: Date.now(), owner: SESSION_ID,
      });
      if (ok === false) failed++; else saved++;
    }
    if (failed) this.ui.status?.(kvLastError() === 'QuotaExceededError' ? 'Draft could not be saved: storage full' : 'Draft could not be saved');
    else if (saved) this.ui.status?.('Draft saved');
  }

  followLink(href: string): void {
    if (href.startsWith('#')) { this.exec('nav.gotoAnchor', href.slice(1)); return; }
    if (!isSafeExternalUrl(href)) { toast(`Blocked a link with an unsupported or unsafe address: ${href.slice(0, 60)}`); return; }
    import('./platform/native').then(({ openExternal }) => openExternal(href));
  }

  focus(): void {
    try { this.view.focus(); } catch { /* */ }
  }

  selectPos(pos: number): void {
    const view = this.view;
    const p = Math.max(0, Math.min(pos, view.state.doc.content.size));
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(p))).scrollIntoView());
    view.focus();
  }
}
