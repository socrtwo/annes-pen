/** Proofing engine: background spelling (worker) + rule-based grammar and style checks. */
import type { App, DocTab } from '../app';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { proofKey, type ProofIssue } from '../editor/plugins/decorations';
import { installedDictionaries, dictionaryFor, loadDictionary } from './dictionaries';

let worker: Worker | null = null;
let workerFailures = 0;
let reqId = 0;
const pending = new Map<number, (v: any) => void>();
const EMPTY = { bad: [], suggestions: [] };
/** The answer to every request a failed (or missing) worker leaves unanswered. */
const FAILED = { ...EMPTY, failed: true };

function getWorker(): Worker | null {
  if (worker) return worker;
  if (workerFailures >= 3) return null;
  try {
    const w = new Worker(new URL('./spell.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { const cb = pending.get(e.data.id); if (cb) { pending.delete(e.data.id); cb(e.data); } };
    w.onerror = () => {
      // A crashed or unloadable worker never answers: settle every waiting request with empty
      // results so the proofing run finishes (and clears its running flag) instead of hanging.
      workerFailures++;
      if (worker === w) { worker = null; inWorker.clear(); }
      try { w.terminate(); } catch { /* */ }
      for (const cb of pending.values()) cb(FAILED);
      pending.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Downloaded dictionaries already sent to the current worker. */
const inWorker = new Set<string>();

/** Send a downloaded dictionary to the worker once. Returns false if it is not available. */
async function ensureLoaded(id: string): Promise<boolean> {
  if (inWorker.has(id) && worker) return true;
  const d = await loadDictionary(id);
  if (!d) return false;
  const r = await call({ type: 'load', dialect: 'dict:' + id, aff: d.aff, dic: d.dic });
  if (r.failed || r.error) return false;
  inWorker.add(id);
  return true;
}

const NONE = new Set<string>();
/** Downloaded dictionaries matter only for text that is not (or is South African) English. */
function needsDictionaries(doc: PMNode, docLang: string | undefined): boolean {
  const special = (l: string | null | undefined) => !isEnglish(l) || /^en[-_]za\b/i.test(l || '');
  if (special(docLang)) return true;
  let found = false;
  doc.descendants((n) => {
    if (found) return false;
    if (n.isText && n.marks.some((m) => m.type === schema.marks.lang && special(m.attrs.lang))) found = true;
    return !found;
  });
  return found;
}

/** Forget a dictionary in the worker (after it is removed). */
export async function unloadDictionary(id: string): Promise<void> {
  inWorker.delete(id);
  if (worker) await call({ type: 'unload', dialect: 'dict:' + id });
}

function call(msg: Record<string, any>): Promise<any> {
  const w = getWorker();
  if (!w) return Promise.resolve(FAILED);
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); w.postMessage({ ...msg, id }); });
}

export type SpellDialect = 'any' | 'document' | 'en-US' | 'en-GB' | 'en-CA' | 'en-AU';

export const SPELL_DIALECTS: { value: SpellDialect; label: string }[] = [
  { value: 'any', label: 'English — all varieties (accept any standard spelling)' },
  { value: 'document', label: 'English — follow each document\'s language' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom, including Oxford -ize spelling)' },
  { value: 'en-CA', label: 'English (Canada)' },
  { value: 'en-AU', label: 'English (Australia)' },
];

/** The dictionary set for a preference and a document language tag (BCP 47). */
export function dialectFor(pref: SpellDialect | undefined, docLang: string | undefined): 'any' | 'en-US' | 'en-GB' | 'en-CA' | 'en-AU' {
  if (pref && pref !== 'document') return pref;
  // "en_US" and "en-Latn-US" are written "en-us" here.
  const l = (docLang || '').toLowerCase().replace(/_/g, '-').replace(/^en-[a-z]{4}(?=-|$)/, 'en');
  if (!l || !isEnglish(l)) return 'any';
  if (/^en-(us|as|gu|mp|pr|um|vi|ph)\b/.test(l)) return 'en-US';
  if (/^en-ca\b/.test(l)) return 'en-CA';
  if (/^en-(au|nz)\b/.test(l)) return 'en-AU';
  if (l === 'en') return 'any';
  return 'en-GB'; // GB, IE, IN, ZA, SG, NG, KE, HK, MT, JM... follow British spelling
}

/** True for an English language tag ("en", "en-GB", "en-IN"...) or no tag. */
export function isEnglish(lang: string | null | undefined): boolean {
  return !lang || /^en([-_]|$)/i.test(lang);
}

export async function suggest(word: string, dialect?: string): Promise<string[]> { return (await call({ type: 'suggest', word, dialect })).suggestions || []; }
export async function addWord(word: string): Promise<void> { await call({ type: 'add', word }); }

interface Seg {
  text: string; pos: number[]; base: number;
  /** Not checked at all. */
  noProof: Set<number>;
  /** Text in another language with a downloaded dictionary: spelling only, no English grammar rules. */
  noGrammar: Set<number>;
  /** Runs with their own language: an English tag, or 'dict:<id>' for a downloaded dictionary. */
  langs: { from: number; to: number; lang: string }[];
}

/**
 * Text blocks as plain text with a position map. Characters that are not proofed: "do not
 * check" text, code, deletions, links, and text in a language other than English (marked on the
 * run, or the document's default language when the run has none) unless a dictionary for that
 * language was downloaded; English grammar rules never apply to other languages.
 */
function segments(doc: PMNode, docLang: string | undefined, installed: Set<string>): Seg[] {
  const out: Seg[] = [];
  const docEnglish = isEnglish(docLang);
  const docDict = docEnglish ? null : dictionaryFor(docLang, installed);
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    let text = '';
    const map: number[] = [];
    const noProof = new Set<number>();
    const noGrammar = new Set<number>();
    const langs: Seg['langs'] = [];
    node.forEach((child, off) => {
      if (child.isText) {
        const lm = child.marks.find((m) => m.type === schema.marks.lang);
        const lang: string | null = lm?.attrs.lang || null;
        const english = lang ? isEnglish(lang) : docEnglish;
        const foreign = english ? null : lang ? dictionaryFor(lang, installed) : docDict;
        const skip = !!lm?.attrs.noProof || (!english && !foreign) || child.marks.some((m) => m.type === schema.marks.code || m.type === schema.marks.deletion || m.type === schema.marks.link);
        const from = text.length, to = text.length + child.text!.length;
        if (!skip && foreign) langs.push({ from, to, lang: 'dict:' + foreign });
        else if (!skip && lang) langs.push({ from, to, lang });
        for (let i = 0; i < child.text!.length; i++) { if (skip) noProof.add(from + i); else if (foreign) noGrammar.add(from + i); map.push(pos + 1 + off + i); }
        text += child.text;
      } else { map.push(pos + 1 + off); text += '\ufffc'; }
    });
    map.push(pos + 1 + node.content.size);
    out.push({ text, pos: map, base: pos + 1, noProof, noGrammar, langs });
    return false;
  });
  return out;
}

export interface GrammarMatch { start: number; end: number; rule: string; message: string; suggestions: string[]; kind: 'grammar' | 'style' }

/** Grammar and style matches in one paragraph's text (offsets into the text). */
export function grammarMatches(text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const r of GRAMMAR_RULES) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(text))) {
      if (m[0].length === 0) { r.re.lastIndex++; continue; }
      if (r.rule === 'repeat' && /^(had|that|is|do|very|bye|no|so|ha|go)$/i.test(m[1])) continue;
      if (r.rule === 'cap' && /\b(e\.g|i\.e|etc|vs|cf|al)\.\s+[a-z]$/i.test(text.slice(Math.max(0, m.index - 8), m.index + m[0].length))) continue;
      if (r.rule === 'a-an' && /^(uni|use|usu|one|once\b|eu|ur)/i.test(m[2])) continue;
      // Initialisms depend on how the letters are said ("an FBI agent", "a NATO base"; "an HR
      // manager", or "a HR manager" where h is "haitch"), which spelling does not show.
      if (r.rule === 'a-an' && /^[A-Z]{2,}/.test(m[2])) continue;
      // "an" before h: silent-h words are "an" everywhere; for the others usage differs by
      // variety ("an herb" in North America, "a herb" in Britain; "an historic", "an hotel"
      // in some British usage), so none of those is marked.
      if (r.rule === 'a-an' && /^an$/i.test(m[1]) && /^h(our|onest|onou?r|eir|erb|istor|otel|ypothe|abit|ero|orrif|ilari|eredit|yster|umble|omage)/i.test(m[2])) continue;
      const start = m.index + (r.rule === 'cap' ? m[0].length - 1 : 0);
      out.push({
        start, end: m.index + m[0].length, rule: r.rule, message: r.msg,
        suggestions: r.fix ? (r.rule === 'cap' ? [m[1].toUpperCase()] : r.fix(m)) : [],
        kind: r.rule === 'spaces' || r.rule === 'paren' ? 'style' : 'grammar',
      });
    }
  }
  return out;
}

const WORD_RE = /[\p{L}][\p{L}\p{M}'’]*[\p{L}\p{M}]|[\p{L}]/gu;

const GRAMMAR_RULES: { re: RegExp; msg: string; fix?: (m: RegExpExecArray) => string[]; rule: string }[] = [
  { re: /\b(\w+)\s+\1\b/gi, msg: 'Repeated word', fix: (m) => [m[1]], rule: 'repeat' },
  { re: / {2,}(?=\S)/g, msg: 'Extra spaces between words', fix: () => [' '], rule: 'spaces' },
  { re: /\s+([,.;:!?])(?!\w)/g, msg: 'Space before punctuation', fix: (m) => [m[1]], rule: 'spacepunct' },
  { re: /\b(a)\s+([aeiou]\w+)/gi, msg: 'Use "an" before a vowel sound', fix: (m) => [`${m[1] === 'A' ? 'An' : 'an'} ${m[2]}`], rule: 'a-an' },
  { re: /\b(an)\s+([bcdfghjklmnpqrstvwxyz]\w+)/gi, msg: 'Use "a" before a consonant sound', fix: (m) => [`${m[1] === 'An' ? 'A' : 'a'} ${m[2]}`], rule: 'a-an' },
  // Silent h in every variety of English: "an hour", "an honest", "an honour/honor", "an heir".
  { re: /\b(a)\s+((?:hour|honest|honou?r|heir)\w*)/gi, msg: 'Use "an" before a silent h', fix: (m) => [`${m[1] === 'A' ? 'An' : 'an'} ${m[2]}`], rule: 'a-an-h' },
  { re: /\b(could|should|would|must|might) of\b/gi, msg: 'Did you mean "have"?', fix: (m) => [`${m[1]} have`], rule: 'of-have' },
  { re: /\b(alot)\b/gi, msg: '"A lot" is two words', fix: () => ['a lot'], rule: 'alot' },
  { re: /\b(irregardless)\b/gi, msg: 'Nonstandard; use "regardless"', fix: () => ['regardless'], rule: 'irregardless' },
  { re: /\b(i)\b(?!\.)/g, msg: 'Capitalize the pronoun "I"', fix: () => ['I'], rule: 'i' },
  { re: /(?:^|[.!?]\s+)([a-z])/g, msg: 'Capitalize the first word of a sentence', fix: (m) => [m[0].replace(m[1], m[1].toUpperCase())], rule: 'cap' },
  { re: /\b(their|there|they're) (is|are|was|were)\b/gi, msg: 'Check their / there / they\'re', rule: 'their' },
  { re: /\b(your) (welcome|right|wrong)\b/gi, msg: 'Did you mean "you\'re"?', fix: (m) => [`you're ${m[2]}`], rule: 'your' },
  { re: /\b(its) (a|an|the|been|not)\b/gi, msg: 'Did you mean "it\'s"?', fix: (m) => [`it's ${m[2]}`], rule: 'its' },
  { re: /\b(then) (I|we|you|he|she|they) (thought|reali[sz]ed)\b/g, msg: 'Check "then" vs "than"', rule: 'then' },
  { re: /\b(less) (people|items|things|words|cars|books)\b/gi, msg: 'Use "fewer" with countable nouns', fix: (m) => [`fewer ${m[2]}`], rule: 'fewer' },
  { re: /,{2,}|\.{4,}|!{2,}|\?{2,}/g, msg: 'Repeated punctuation', rule: 'punct' },
  { re: /\(\s+|\s+\)/g, msg: 'Space inside parentheses', fix: (m) => [m[0].trim()], rule: 'paren' },
];

export class Proofer {
  // One timer per tab, so scheduling one tab never cancels another tab's pending check.
  private timers = new Map<DocTab, ReturnType<typeof setTimeout>>();
  /** Tabs that asked for a check while another was running; each is checked once it ends. */
  private queued = new Set<DocTab>();
  private running = false;
  constructor(private app: App) {}

  private closed(tab: DocTab | undefined): boolean {
    return !tab?.view || (tab.view as any).isDestroyed || !this.app.docs.includes(tab);
  }

  /** Drop a tab's pending check (call when the tab closes). */
  forget(tab: DocTab): void {
    clearTimeout(this.timers.get(tab));
    this.timers.delete(tab);
    this.queued.delete(tab);
  }

  schedule(tab: DocTab = this.app.active, delay = 1200) {
    // Closed tabs and destroyed views are never proofed (or rescheduled) again.
    if (this.closed(tab)) { if (tab) this.forget(tab); return; }
    if (!this.app.prefs.spellcheck && !this.app.prefs.grammar) {
      if ((proofKey.getState(tab.view.state)?.issues.length || 0) > 0) tab.view.dispatch(tab.view.state.tr.setMeta(proofKey, []).setMeta('addToHistory', false));
      return;
    }
    clearTimeout(this.timers.get(tab));
    this.timers.set(tab, setTimeout(() => { this.timers.delete(tab); void this.run(tab); }, delay));
  }

  async run(tab: DocTab): Promise<ProofIssue[]> {
    if (this.closed(tab)) { this.forget(tab); return []; }
    if (this.running) { this.queued.add(tab); return []; }
    this.running = true;
    try {
      const doc = tab.view.state.doc;
      const installed = needsDictionaries(doc, tab.settings?.language) ? await installedDictionaries() : NONE;
      const segs = segments(doc, tab.settings?.language, installed);
      const issues: ProofIssue[] = [];
      const ignored = new Set(this.app.prefs.ignoredWords.map((w) => w.toLowerCase()));
      const dict = new Set(this.app.prefs.dictionary.map((w) => w.toLowerCase()));
      if (this.app.prefs.spellcheck) {
        // Words grouped by dictionary set: the preference, or with "follow the document" the
        // language of each run (a quotation marked en-GB in an American document, say).
        const pref = this.app.prefs.spellDialect;
        // South African English has its own dictionary when downloaded; otherwise it uses British.
        const english = (tag: string | undefined) => (pref === 'document' && tag && /^en[-_]za\b/i.test(tag) && installed.has('en-za') ? 'dict:en-za' : dialectFor(pref, tag));
        const docDialect = english(tab.settings?.language);
        const words = new Map<string, Set<string>>();
        const occurrences: { word: string; from: number; to: number; dialect: string }[] = [];
        for (const s of segs) {
          WORD_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = WORD_RE.exec(s.text))) {
            const w = m[0].replace(/’/g, "'").replace(/'s$/i, '').replace(/^'|'$/g, '');
            if (!w || s.noProof.has(m.index)) continue;
            if (/\d/.test(w) || w.length < 2) continue;
            if (/^[\p{Lu}]{2,}$/u.test(w)) continue; // acronyms
            if (ignored.has(w.toLowerCase()) || dict.has(w.toLowerCase())) continue;
            const at = m.index;
            const run = s.langs.find((r) => at >= r.from && at < r.to)?.lang;
            const d = run?.startsWith('dict:') ? run : run && pref === 'document' ? english(run) : docDialect;
            if (!words.has(d)) words.set(d, new Set());
            words.get(d)!.add(w);
            occurrences.push({ word: w, from: s.pos[at], to: s.pos[at + m[0].length - 1] + 1, dialect: d });
          }
        }
        const bad = new Map<string, Set<string>>();
        for (const [d, set] of words) {
          if (d.startsWith('dict:') && !(await ensureLoaded(d.slice(5)))) continue;
          const res = await call({ type: 'check', words: [...set], dialect: d });
          if (res.failed) break; // the worker crashed: finish this run without spelling results
          bad.set(d, new Set<string>(res.bad || []));
        }
        for (const o of occurrences) if (bad.get(o.dialect)?.has(o.word)) issues.push({ from: o.from, to: o.to, kind: 'spell', message: `"${o.word}" may be misspelled`, suggestions: [], dialect: o.dialect });
      }
      if (this.app.prefs.grammar) {
        for (const s of segs) {
          for (const g of grammarMatches(s.text)) {
            if (s.noProof.has(g.start) || s.noGrammar.has(g.start)) continue;
            issues.push({ from: s.pos[g.start], to: s.pos[g.end - 1] + 1, kind: g.kind, message: g.message, suggestions: g.suggestions, rule: g.rule });
          }
        }
      }
      if (tab.view.state.doc === doc && !(tab.view as any).isDestroyed) tab.view.dispatch(tab.view.state.tr.setMeta(proofKey, issues).setMeta('addToHistory', false));
      else this.schedule(tab, 600);
      return issues;
    } finally {
      this.running = false;
      const next = [...this.queued];
      this.queued.clear();
      for (const t of next) this.schedule(t, 50);
    }
  }
}
