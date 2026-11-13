/** Application preferences (per device), persisted to localStorage. */
import { DEFAULT_AUTOFORMAT, DEFAULT_REPLACEMENTS, type AutoFormatPrefs } from './editor/autoformat';

export interface CustomGroup { id: string; label: string; items: string[] }
export interface CustomTab { id: string; label: string; groups: CustomGroup[]; hidden?: boolean }
export interface RecentEntry { key: string; name: string; when: number; uri?: string; format?: string; pinned?: boolean }
export interface Macro {
  name: string; steps: { id: string; arg?: any }[]; description?: string; key?: string; created: number;
  /** An imported script macro: asks before it first runs. */
  untrusted?: boolean;
}
export interface Snippet { name: string; gallery: string; json: any; created: number }

export interface Prefs {
  author: string;
  initials: string;
  qat: string[];
  qatPosition: 'top' | 'bottom';
  qatLabels: boolean;
  customTabs: CustomTab[];
  hiddenTabs: string[];
  tabOrder: string[];
  keymap: Record<string, string>;
  units: 'in' | 'cm' | 'mm' | 'pt';
  autosave: boolean;
  autosaveSeconds: number;
  autoformat: AutoFormatPrefs;
  replacements: Record<string, string>;
  theme: 'system' | 'light' | 'dark';
  darkPage: boolean;
  ribbon: 'full' | 'tabs' | 'hidden';
  defaultView: 'auto' | 'print' | 'mobile' | 'web';
  spellcheck: boolean;
  grammar: boolean;
  nativeSpellcheck: boolean;
  wordCompletion: boolean;
  recent: RecentEntry[];
  snippets: Snippet[];
  macros: Macro[];
  dictionary: string[];
  ignoredWords: string[];
  showMarks: boolean;
  showRuler: boolean;
  writingGoal: number;
  defaultFont: string;
  defaultSize: number;
  typewriter: boolean;
  focus: 'off' | 'paragraph' | 'sentence' | 'line';
  miniToolbar: boolean;
  language: string;
  /** Spelling dictionary: all English varieties (default), the document's language, or one variety. */
  spellDialect: 'any' | 'document' | 'en-US' | 'en-GB' | 'en-CA' | 'en-AU';
  confirmClose: boolean;
  defaultSaveFormat: string;
  readAloudRate: number;
  slashMenu: boolean;
  pasteDefault: 'keep' | 'merge' | 'text';
  showHiddenText: boolean;
  showFieldCodes: boolean;
  fieldShading: 'always' | 'selected' | 'never';
  highContrastUI: boolean;
  uiScale: number;
  statusItems: string[];
  clipboardHistory: number;
  pinnedCommands: string[];
  firstRun: boolean;
}

export const DEFAULT_QAT = ['file.save', 'edit.undo', 'edit.redo', 'file.saveAs', 'file.print', 'view.cmdSearch'];

export function defaultPrefs(): Prefs {
  return {
    author: 'Author',
    initials: 'A',
    qat: [...DEFAULT_QAT],
    qatPosition: 'top',
    qatLabels: false,
    customTabs: [],
    hiddenTabs: [],
    tabOrder: [],
    keymap: {},
    units: 'in',
    autosave: true,
    autosaveSeconds: 10,
    autoformat: { ...DEFAULT_AUTOFORMAT },
    replacements: { ...DEFAULT_REPLACEMENTS },
    theme: 'system',
    darkPage: false,
    ribbon: 'full',
    defaultView: 'auto',
    spellcheck: true,
    grammar: true,
    nativeSpellcheck: true,
    wordCompletion: true,
    recent: [],
    snippets: [],
    macros: [],
    dictionary: [],
    ignoredWords: [],
    showMarks: false,
    showRuler: false,
    writingGoal: 0,
    defaultFont: '',
    defaultSize: 0,
    typewriter: false,
    focus: 'off',
    miniToolbar: true,
    language: 'en-US',
    spellDialect: 'any',
    confirmClose: true,
    defaultSaveFormat: 'docx',
    readAloudRate: 1,
    slashMenu: true,
    pasteDefault: 'keep',
    showHiddenText: false,
    showFieldCodes: false,
    fieldShading: 'selected',
    highContrastUI: false,
    uiScale: 1,
    statusItems: ['page', 'words', 'track', 'lang', 'views', 'zoom'],
    clipboardHistory: 24,
    pinnedCommands: [],
    firstRun: true,
  };
}

const KEY = 'quillpen.prefs.v1';

export function loadPrefs(): Prefs {
  const d = defaultPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = sanitizePrefs(JSON.parse(raw));
    return { ...d, ...p, autoformat: { ...d.autoformat, ...(p.autoformat || {}) }, replacements: p.replacements || d.replacements };
  } catch {
    return d;
  }
}

const ENUMS: Partial<Record<keyof Prefs, readonly string[]>> = {
  qatPosition: ['top', 'bottom'], units: ['in', 'cm', 'mm', 'pt'], theme: ['system', 'light', 'dark'], ribbon: ['full', 'tabs', 'hidden'],
  defaultView: ['auto', 'print', 'mobile', 'web'], focus: ['off', 'paragraph', 'sentence', 'line'],
  pasteDefault: ['keep', 'merge', 'text'], fieldShading: ['always', 'selected', 'never'],
};
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Keeps only preferences of the expected shape (stored, or pasted into Import Settings), so a damaged or
 *  hand-edited settings file cannot leave the app unable to start. Unknown keys are dropped. */
export function sanitizePrefs(raw: unknown): Partial<Prefs> {
  if (!isObj(raw)) return {};
  const d = defaultPrefs() as Record<string, any>;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in d)) continue;
    const def = d[k];
    if (Array.isArray(def) ? Array.isArray(v) : isObj(def) ? isObj(v) : typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  for (const [k, ok] of Object.entries(ENUMS)) if (k in out && !ok!.includes(out[k])) delete out[k];
  for (const k of ['qat', 'hiddenTabs', 'tabOrder', 'dictionary', 'ignoredWords', 'statusItems', 'pinnedCommands']) if (k in out) out[k] = strings(out[k]);
  for (const k of ['keymap', 'replacements']) if (k in out) out[k] = Object.fromEntries(Object.entries(out[k]).filter(([, x]) => typeof x === 'string'));
  if (out.autoformat) out.autoformat = Object.fromEntries(Object.entries(out.autoformat).filter(([k, x]) => k in d.autoformat && typeof x === typeof d.autoformat[k]));
  if (out.customTabs) {
    out.customTabs = out.customTabs.filter((t: any) => isObj(t) && typeof t.id === 'string' && Array.isArray(t.groups))
      .map((t: any) => ({ ...t, label: String(t.label ?? t.id), groups: t.groups.filter(isObj).map((g: any) => ({ ...g, id: String(g.id ?? ''), label: String(g.label ?? ''), items: strings(g.items) })) }));
  }
  if (out.recent) out.recent = out.recent.filter((r: any) => isObj(r) && typeof r.key === 'string' && typeof r.name === 'string');
  if (out.macros) out.macros = out.macros.filter((m: any) => isObj(m) && typeof m.name === 'string' && Array.isArray(m.steps) && m.steps.every((s: any) => isObj(s) && typeof s.id === 'string'));
  if (out.snippets) out.snippets = out.snippets.filter((s: any) => isObj(s) && typeof s.name === 'string');
  return out as Partial<Prefs>;
}

export const PREFS_KEY = KEY;

/**
 * Preferences saved by another window (the storage event) merged into this window's: lists that only
 * grow (Recent, dictionary, ignored words, building blocks, macros) keep the entries of both, and every
 * other preference takes the other window's value, so neither window's last save drops the other's additions.
 */
export function mergePrefs(local: Prefs, raw: unknown): Prefs {
  const remote = sanitizePrefs(raw);
  const out: Prefs = { ...local, ...remote, autoformat: { ...local.autoformat, ...(remote.autoformat || {}) } };
  const byKey = <T>(a: T[], b: T[], key: (x: T) => string, newer: (x: T, y: T) => boolean): T[] => {
    const m = new Map<string, T>();
    for (const x of [...a, ...b]) { const k = key(x); const cur = m.get(k); if (!cur || newer(x, cur)) m.set(k, x); }
    return [...m.values()];
  };
  if (remote.recent) {
    const list = byKey(local.recent, remote.recent, (r) => r.key, (x, y) => x.when > y.when).sort((a, b) => b.when - a.when);
    out.recent = [...list.filter((r) => r.pinned), ...list.filter((r) => !r.pinned)].slice(0, 40);
  }
  if (remote.dictionary) out.dictionary = [...new Set([...local.dictionary, ...remote.dictionary])];
  if (remote.ignoredWords) out.ignoredWords = [...new Set([...local.ignoredWords, ...remote.ignoredWords])];
  if (remote.snippets) out.snippets = byKey(local.snippets, remote.snippets, (x) => x.name, (x, y) => (x.created || 0) > (y.created || 0));
  // The other window's copy of a macro is its latest (edited there, or its untrusted mark cleared there).
  if (remote.macros) out.macros = byKey(local.macros, remote.macros, (x) => x.name, () => true);
  return out;
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage full or unavailable */ }
}

export const UNIT_PT: Record<Prefs['units'], number> = { in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1 };
export function toUnit(pt: number, u: Prefs['units']): number { return Math.round((pt / UNIT_PT[u]) * 100) / 100; }
export function fromUnit(v: number, u: Prefs['units']): number { return v * UNIT_PT[u]; }
