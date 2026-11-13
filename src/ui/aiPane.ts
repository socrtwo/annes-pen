/** AI pane (chat and results) and the preview dialog used by rewrite-type commands. */
import { h, icon, clear } from './dom';
import { openDialog, toast } from './dialog';
import type { App } from '../app';
import type { PaneDef } from './panes';
import { chat, AiError, type ChatMessage, type ChatResult } from '../ai/client';
import { aiSettings, ensemblePlan, onAiSettingsChange } from '../ai/store';
import { providerById } from '../ai/providers';
import { outcomeLine, type EnsembleInfo } from '../ai/ensemble';
import { cleanOutput, insertAtCursor, insertBelow, replaceRange, documentText, rangeText, blocksFromText } from '../ai/apply';
import { BASE_SYSTEM } from '../ai/features';

// ------------------------------------------------------------------------------------------
// Busy indicator with Stop

let busyEl: HTMLElement | null = null;
let current: AbortController | null = null;

export function aiBusy(label: string): AbortController {
  current?.abort();
  const ctl = new AbortController();
  current = ctl;
  busyEl?.remove();
  busyEl = h('div', { class: 'qf-ai-busy', role: 'status' }, h('span', { class: 'qf-spin' }), h('span', null, label), h('span', { class: 'qf-ai-busy-status' }), h('button', { class: 'qf-link', onclick: () => ctl.abort() }, 'Stop'));
  document.body.appendChild(busyEl);
  ctl.signal.addEventListener('abort', () => aiIdle(ctl));
  return ctl;
}

export function aiIdle(ctl?: AbortController): void {
  if (ctl && ctl !== current) return;
  busyEl?.remove();
  busyEl = null;
  current = null;
}

export function stopAi(): void { current?.abort(); }

/** Progress from several AIs ("Asking 3 AIs…") next to the busy label. */
export function aiStatus(ctl: AbortController, text: string): void {
  if (ctl !== current || !busyEl) return;
  const el = busyEl.querySelector('.qf-ai-busy-status');
  if (el) el.textContent = text ? `· ${text}` : '';
}

const providerName = (id: string) => providerById(id)?.name || id;

export function aiAuthor(): string {
  const s = aiSettings();
  const plan = ensemblePlan(s);
  if (plan) return `AI (${plan.members.length} AIs, ${plan.mode === 'master' ? 'combined' : 'consensus'})`;
  const id = s.active || '';
  const cfg = s.providers[id];
  return `AI (${cfg?.model || providerById(id)?.name || 'assistant'})`;
}

// ------------------------------------------------------------------------------------------
// How the AIs answered

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const STANCE_LABEL = { unite: 'unites', 'stand-aside': 'stands aside', block: 'blocks' } as const;

/**
 * Below an answer from several AIs: "The AIs did not reach unity" with each block (always), and,
 * when "Show the discussion" is on, a collapsible "How the AIs answered" section with each
 * member's answer, each round's minute and stances, and the outcome line. Display only: the
 * discussion is never inserted into documents.
 */
export function ensembleView(info: EnsembleInfo, master: string): HTMLElement {
  const el = h('div', { class: 'qf-ai-ens' });
  const outcome = outcomeLine(info, master, providerName);
  if (info.outcome === 'no-unity') {
    el.append(h('div', { class: 'qf-ai-ens-warn', role: 'note' }, h('b', null, 'The AIs did not reach unity'),
      h('ul', null, ...(info.blocks || []).map((b) => h('li', null, `${providerName(b.provider)} blocks: ${b.reason}`)))));
  }
  if (!aiSettings().ensemble.showDeliberation) return el;
  const body = h('div', { class: 'qf-ai-ens-body' });
  for (const m of info.members) {
    body.append(h('div', { class: 'qf-ai-ens-member' + (m.error ? ' qf-ai-ens-failed' : '') },
      h('div', { class: 'qf-ai-ens-head' }, `${providerName(m.provider)} · ${m.model} · ${secs(m.ms)}`),
      h('div', { class: 'qf-ai-ens-text' }, m.error ? `⚠ Left out: ${m.error}` : m.text || '')));
  }
  (info.rounds || []).forEach((r, i) => {
    body.append(h('div', { class: 'qf-ai-ens-round' },
      h('div', { class: 'qf-ai-ens-head' }, `Round ${i + 1}`),
      h('details', null, h('summary', null, i === 0 ? 'Draft minute' : 'Revised minute'), h('div', { class: 'qf-ai-ens-text' }, r.minute)),
      h('ul', null, ...r.responses.map((x) => h('li', { class: `qf-ai-ens-${x.stance}` }, h('b', null, `${providerName(x.provider)} ${STANCE_LABEL[x.stance]}`), x.reason ? `: ${x.reason}` : '')))));
  });
  body.append(h('div', { class: 'qf-ai-ens-outcome' }, outcome));
  el.append(h('details', { class: 'qf-ai-ens-details' }, h('summary', null, 'How the AIs answered', h('span', { class: 'qf-help' }, ` · ${outcome}`)), body));
  return el;
}

// ------------------------------------------------------------------------------------------
// Preview dialog

export interface PreviewOptions {
  title: string;
  original?: string;
  /** Streams the first version; resolves with all versions. `ctx` shows progress and the AIs' discussion (several AIs). */
  generate: (onToken: (full: string) => void, signal: AbortSignal, ctx: GenerateContext) => Promise<string[]>;
  /** Range to replace (rewrite-type features). */
  range?: { from: number; to: number };
  /** Default action when the range is a draft position. */
  primary: 'replace' | 'insert' | 'cursor';
  markdown?: boolean;
  /** Ask again with a follow-up instruction. */
  refine?: (current: string, instruction: string) => Promise<string>;
}

export interface GenerateContext {
  /** Progress line while waiting ("Asking 3 AIs…"). */
  status: (text: string) => void;
  /** Shows how the AIs answered below the result. */
  result: (r: ChatResult) => void;
}

export async function showAiPreview(app: App, o: PreviewOptions): Promise<void> {
  const ctl = new AbortController();
  let versions: string[] = [''];
  let idx = 0;
  let done = false;
  let waiting = '';
  /** Why the last request failed, shown instead of the result. */
  let error = '';
  const out = h('div', { class: 'qf-ai-out', contenteditable: 'false' });
  const ens = h('div', { class: 'qf-ai-ens-slot' });
  const counter = h('span', { class: 'qf-help' });
  const track = h('input', { type: 'checkbox', checked: aiSettings().trackAsRevisions }) as HTMLInputElement;
  const nav = h('div', { class: 'qf-row qf-ai-nav' },
    h('button', { class: 'qf-iconbtn', title: 'Previous version', onclick: () => { if (idx > 0) { idx--; render(); } } }, icon('chevron_left')), counter,
    h('button', { class: 'qf-iconbtn', title: 'Next version', onclick: () => { if (idx < versions.length - 1) { idx++; render(); } } }, icon('chevron_right')));
  const refineIn = h('input', { type: 'text', class: 'qf-input', placeholder: 'Refine: e.g. shorter, more formal, mention the date…' }) as HTMLInputElement;
  const render = () => {
    out.textContent = versions[idx] || (done ? (error ? `⚠ ${error}` : '(empty response)') : waiting || '…');
    out.classList.toggle('qf-ai-error', !versions[idx] && done && !!error);
    counter.textContent = versions.length > 1 ? `Version ${idx + 1} of ${versions.length}` : '';
    nav.style.display = versions.length > 1 ? '' : 'none';
  };
  const body = h('div', { class: 'qf-ai-preview' },
    o.original ? h('details', null, h('summary', null, 'Original'), h('div', { class: 'qf-ai-orig' }, o.original)) : null,
    out, ens, nav,
    o.refine ? h('div', { class: 'qf-row' }, refineIn, h('button', { class: 'qf-btn', onclick: async () => {
      if (!refineIn.value.trim() || !done) return;
      done = false; error = ''; const base = versions[idx]; versions = ['']; idx = 0; waiting = ''; clear(ens); render();
      try { versions = [cleanOutput(await o.refine!(base, refineIn.value.trim()), { keepMarkdown: o.markdown })]; } catch (e: any) { versions = [base]; toast(String(e?.message || e)); }
      done = true; refineIn.value = ''; render();
    } }, 'Refine')) : null,
    h('label', { class: 'qf-check' }, track, ' Insert as tracked change'),
    h('p', { class: 'qf-help qf-ai-disclaimer' }, 'AI can be wrong. Check facts, names and dates before you keep this.'));
  render();

  const author = aiAuthor();
  const apply = async (mode: 'replace' | 'insert' | 'cursor') => {
    const text = versions[idx];
    if (!text) return;
    const opts = { track: track.checked, author, markdown: o.markdown };
    if (mode === 'replace' && o.range) await replaceRange(app, o.range, text, opts);
    else if (mode === 'insert') await insertBelow(app, text, opts);
    else await insertAtCursor(app, text, opts);
  };

  const buttons: { label: string; primary?: boolean; onClick: (v: any, c: any) => void }[] = [];
  if (o.range && o.primary === 'replace') buttons.push({ label: 'Replace', primary: true, onClick: async (_v, c) => { if (!done) return; c.close(null); await apply('replace'); } });
  buttons.push({ label: o.primary === 'cursor' ? 'Insert' : 'Insert below', primary: o.primary !== 'replace', onClick: async (_v, c) => { if (!done) return; c.close(null); await apply(o.primary === 'cursor' ? 'cursor' : 'insert'); } });
  buttons.push({ label: 'Copy', onClick: async () => { try { await navigator.clipboard.writeText(versions[idx]); toast('Copied'); } catch { toast('Clipboard is not available'); } } });
  buttons.push({ label: 'Retry', onClick: () => { if (done) void run(); } });

  const gctx: GenerateContext = {
    status: (t) => { waiting = t; if (!versions[0]) render(); },
    result: (r) => { clear(ens); if (r.ensemble) ens.append(ensembleView(r.ensemble, r.providerName)); },
  };
  const run = async () => {
    done = false; error = ''; versions = ['']; idx = 0; waiting = ''; clear(ens); render();
    try {
      const all = await o.generate((full) => { versions[0] = cleanOutput(full, { keepMarkdown: o.markdown }); render(); }, ctl.signal, gctx);
      versions = all.map((v) => cleanOutput(v, { keepMarkdown: o.markdown })).filter(Boolean);
      if (!versions.length) versions = [''];
    } catch (e: any) {
      // Kept for render(), which would otherwise show "(empty response)" over it.
      error = e instanceof AiError && e.code === 'aborted' ? 'Stopped.' : String(e?.message || e);
      versions = [''];
    }
    done = true;
    render();
  };
  void run();
  await openDialog({ title: o.title, content: body, wide: true, ok: false, cancel: 'Discard', buttons });
  ctl.abort();
}

// ------------------------------------------------------------------------------------------
// AI pane

interface Turn { role: 'user' | 'assistant'; text: string; title?: string; markdown?: boolean; status?: string; ensemble?: EnsembleInfo; by?: string; failed?: boolean }
/** Each document has its own conversation. */
const histories = new WeakMap<object, Turn[]>();
const EMPTY: Turn[] = [];
let paneEl: HTMLElement | null = null;
let paneApp: App | null = null;
let paneTab: object | null = null;
let offSettings: (() => void) | null = null;
let offRefresh: (() => void) | null = null;

function historyOf(tab: object | null | undefined): Turn[] {
  if (!tab) return EMPTY;
  let h = histories.get(tab);
  if (!h) histories.set(tab, (h = []));
  return h;
}
/** The conversation shown in the pane (the active document's). */
const shown = (): Turn[] => historyOf(paneTab ?? paneApp?.tab);

/** Earlier turns sent back to the AI: answered questions only (no failed, stopped or empty answers). */
export function chatHistory(turns: Turn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === 'assistant') { if (t.text && !t.failed) out.push({ role: 'assistant', content: t.text }); continue; }
    const a = turns[i + 1];
    if (a && a.role === 'assistant' && (!a.text || a.failed)) { i++; continue; }
    out.push({ role: 'user', content: t.text });
  }
  return out;
}

/** Which AI (or AIs) answer, for the pane's header. */
function paneHead(): string {
  const s = aiSettings();
  const plan = ensemblePlan(s);
  if (plan) return plan.mode === 'master' ? `${plan.members.length} AIs, combined by ${providerName(plan.master.provider)}` : `${plan.members.length} AIs in consensus, clerk ${providerName(plan.master.provider)}`;
  const prov = s.active ? providerById(s.active) : null;
  return prov ? `${prov.name} · ${s.providers[s.active!]?.model || ''}` : 'No AI provider';
}

/**
 * Show a result (or a streaming result) in the AI pane. Returns an updater. `done` takes the
 * chat result too, so an answer from several AIs shows how they answered.
 */
export function paneResult(app: App, title: string, markdown = true): { update: (t: string) => void; status: (t: string) => void; done: (t: string, r?: ChatResult) => void } {
  app.ui.openPane('ai');
  const turn: Turn = { role: 'assistant', text: '', title, markdown };
  historyOf(app.tab).push(turn);
  drawPane();
  return {
    update: (t) => { turn.text = t; drawTurnText(turn); },
    status: (t) => { turn.status = t; drawTurnText(turn); },
    done: (t, r) => { turn.text = t; turn.status = undefined; if (r?.ensemble) { turn.ensemble = r.ensemble; turn.by = r.providerName; } drawPane(); },
  };
}

function drawTurnText(turn: Turn) {
  const el = paneEl?.querySelector(`[data-turn="${shown().indexOf(turn)}"] .qf-ai-msg-text`);
  if (el) el.textContent = turn.text || turn.status || '…';
}

function drawPane() {
  if (!paneEl || !paneApp) return;
  const app = paneApp;
  const log = paneEl.querySelector('.qf-ai-log') as HTMLElement;
  if (!log) return;
  clear(log);
  paneTab = app.tab;
  const history = shown();
  if (!history.length) {
    log.append(h('p', { class: 'qf-help' }, aiSettings().active ? 'Ask anything about this document, or use the commands on the AI tab. Results appear here with buttons to insert them.' : 'AI is not set up yet.'));
    if (!aiSettings().active) log.append(h('button', { class: 'qf-btn qf-primary', onclick: () => app.exec('ai.setup') }, 'Set Up AI…'));
  }
  history.forEach((t, i) => {
    log.append(h('div', { class: `qf-ai-msg qf-ai-${t.role}`, 'data-turn': String(i) },
      t.title ? h('div', { class: 'qf-ai-msg-title' }, t.title) : null,
      h('div', { class: 'qf-ai-msg-text' }, t.text || t.status || '…'),
      t.ensemble && t.text ? ensembleView(t.ensemble, t.by || '') : null,
      t.role === 'assistant' && t.text ? h('div', { class: 'qf-row qf-ai-msg-actions' },
        h('button', { class: 'qf-btn qf-sm', title: 'Insert at the cursor', onclick: () => void insertAtCursor(app, t.text, { track: aiSettings().trackAsRevisions, author: aiAuthor(), markdown: t.markdown }) }, icon('input'), ' Insert'),
        h('button', { class: 'qf-btn qf-sm', title: 'Replace the selection', onclick: () => { const sel = app.state.selection; if (sel.empty) { toast('Select the text to replace first.'); return; } void replaceRange(app, { from: sel.from, to: sel.to }, t.text, { track: aiSettings().trackAsRevisions, author: aiAuthor(), markdown: t.markdown }); } }, icon('find_replace'), ' Replace'),
        h('button', { class: 'qf-btn qf-sm', title: 'Insert at the top of the document', onclick: () => void insertTop(app, t.text, t.markdown) }, icon('vertical_align_top'), ' Top'),
        h('button', { class: 'qf-btn qf-sm', onclick: async () => { try { await navigator.clipboard.writeText(t.text); toast('Copied'); } catch { toast('Clipboard is not available'); } } }, icon('content_copy'))) : null));
  });
  log.scrollTop = log.scrollHeight;
}

async function insertTop(app: App, text: string, markdown?: boolean) {
  const blocks = await blocksFromText(text, markdown !== false);
  app.tab.view.dispatch(app.state.tr.insert(0, blocks).scrollIntoView());
}

async function ask(app: App, question: string, include: 'none' | 'selection' | 'document') {
  const history = historyOf(app.tab);
  history.push({ role: 'user', text: question });
  const turn: Turn = { role: 'assistant', text: '', markdown: true };
  history.push(turn);
  drawPane();
  const msgs: ChatMessage[] = [{ role: 'system', content: `${BASE_SYSTEM} You are chatting with the author in a side panel; Markdown is fine here.` }];
  if (include !== 'none') {
    const st = app.state;
    const ctx = include === 'selection' && !st.selection.empty ? rangeText(st.doc, st.selection.from, st.selection.to) : documentText(app, 60000).text;
    msgs.push({ role: 'user', content: `${include === 'selection' ? 'Selected text' : 'The document'}:\n${ctx}` }, { role: 'assistant', content: 'Understood.' });
  }
  msgs.push(...chatHistory(history.slice(0, -2)).slice(-10));
  msgs.push({ role: 'user', content: question });
  const ctl = aiBusy('AI is answering…');
  try {
    const r = await chat({ messages: msgs, signal: ctl.signal, onToken: (_d, full) => { turn.text = full; drawTurnText(turn); }, onStatus: (st) => { turn.status = st; aiStatus(ctl, st); drawTurnText(turn); } });
    turn.text = cleanOutput(r.text, { keepMarkdown: true });
    if (r.ensemble) { turn.ensemble = r.ensemble; turn.by = r.providerName; }
  } catch (e: any) {
    const stopped = e instanceof AiError && e.code === 'aborted';
    turn.failed = !stopped || !turn.text;
    turn.text = stopped ? turn.text || '(stopped)' : `⚠ ${e?.message || e}`;
  } finally { aiIdle(ctl); }
  drawPane();
}

export const aiPaneDef: PaneDef = {
  id: 'ai',
  title: 'AI',
  render(app, el) {
    paneEl = el;
    paneApp = app;
    el.classList.add('qf-ai-pane');
    const input = h('textarea', { class: 'qf-input', rows: 3, placeholder: 'Ask about this document, or ask for anything…' }) as HTMLTextAreaElement;
    const include = h('select', { class: 'qf-input qf-sm' },
      h('option', { value: 'document' }, 'Use the document'), h('option', { value: 'selection' }, 'Use the selection'), h('option', { value: 'none' }, 'No document context')) as HTMLSelectElement;
    const send = () => { const q = input.value.trim(); if (!q) return; input.value = ''; void ask(app, q, include.value as any); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    const headText = h('span', null, paneHead());
    offSettings?.();
    offSettings = onAiSettingsChange(() => { headText.textContent = paneHead(); });
    // Switching documents shows that document's conversation.
    offRefresh?.();
    offRefresh = app.onRefresh?.(() => { if (paneEl && app.tab !== paneTab) drawPane(); }) ?? null;
    el.append(
      h('div', { class: 'qf-ai-head qf-help' }, headText, ' ', h('button', { class: 'qf-link', onclick: () => app.exec(ensemblePlan() ? 'ai.ensembleMembers' : 'ai.providers') }, 'Change')),
      h('div', { class: 'qf-ai-log' }),
      h('div', { class: 'qf-ai-compose' }, input, h('div', { class: 'qf-row' }, include, h('span', { class: 'qf-spacer' }),
        h('button', { class: 'qf-iconbtn', title: 'Clear conversation', onclick: () => { shown().length = 0; drawPane(); } }, icon('delete_sweep')),
        h('button', { class: 'qf-btn qf-primary', onclick: send }, icon('send'), ' Send'))));
    drawPane();
  },
  onClose() { paneEl = null; paneTab = null; offSettings?.(); offSettings = null; offRefresh?.(); offRefresh = null; },
};

/** Show a long result in a read-only dialog (used when the pane is too small, e.g. phones). */
export async function showAiText(title: string, text: string): Promise<void> {
  await openDialog({ title, content: h('div', { class: 'qf-ai-out' }, text), wide: true, ok: 'Close', cancel: false });
}
