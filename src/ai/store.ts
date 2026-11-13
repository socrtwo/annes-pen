/**
 * AI settings and API-key storage.
 *
 * Settings (which provider is active, models, options) live in localStorage. API keys never do:
 * on Android they are encrypted with a key held in the Android Keystore (QuillNative
 * secureSet/secureGet); in a browser they go to IndexedDB under a separate key, so settings
 * export, drafts and documents never contain them.
 */
import { kvGet, kvSet, kvDel } from '../util/store';
import { isNative, secureGet, secureSet, secureRemove } from '../platform/native';
import { providerById, type ProviderDef } from './providers';
import { defaultEnsembleSettings, normalizeEnsemble, MIN_MEMBERS, type EnsembleSettings, type EnsemblePlan } from './ensemble';

export interface ProviderConfig {
  id: string;
  /** Model for interactive commands. */
  model: string;
  /** Model for quick, cheap tasks (falls back to model). */
  fastModel?: string;
  baseUrl?: string;
  accountId?: string;
  resource?: string;
  region?: string;
  /** Last fetched model list. */
  models?: string[];
  verified?: number;
}

export interface SavedPrompt { id: string; name: string; prompt: string; input: 'selection' | 'document' | 'none'; output: 'replace' | 'insert' | 'pane' | 'comment' | 'newdoc' }

export interface AiSettings {
  enabled: boolean;
  active: string | null;
  providers: Record<string, ProviderConfig>;
  /** Insert AI edits as tracked changes by "AI (model)". */
  trackAsRevisions: boolean;
  /** Ask before sending the whole document to a cloud service. */
  confirmDocument: boolean;
  /** During setup, look for a copied key when returning to the app. */
  clipboardWatch: boolean;
  /** Remove a recognized key from the clipboard after saving it. */
  clearClipboard: boolean;
  /** Number of alternatives offered by Rewrite. */
  alternatives: number;
  /** Reply language for generated text: 'auto' follows the input. */
  language: string;
  styleGuide: string;
  voiceProfile: string;
  prompts: SavedPrompt[];
  usage: { requests: number; tokensIn: number; tokensOut: number; since: number };
  privacyAck: string[];
  /** Several AIs on one request (master or Quaker consensus). Never contains keys. */
  ensemble: EnsembleSettings;
}

const KEY = 'quillpen.ai.v1';

export function defaultAiSettings(): AiSettings {
  return {
    enabled: true, active: null, providers: {}, trackAsRevisions: false, confirmDocument: true, clipboardWatch: true, clearClipboard: true,
    alternatives: 3, language: 'auto', styleGuide: '', voiceProfile: '', prompts: [],
    usage: { requests: 0, tokensIn: 0, tokensOut: 0, since: Date.now() }, privacyAck: [],
    ensemble: defaultEnsembleSettings(),
  };
}

let cache: AiSettings | null = null;
const listeners = new Set<() => void>();

export function aiSettings(): AiSettings {
  if (cache) return cache;
  let s = defaultAiSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...s, ...JSON.parse(raw) };
  } catch { /* corrupt or unavailable storage: defaults */ }
  if (!s.providers || typeof s.providers !== 'object') s.providers = {};
  if (!Array.isArray(s.prompts)) s.prompts = [];
  s.prompts = s.prompts.filter((p) => p && typeof p.name === 'string' && typeof p.prompt === 'string');
  if (!Array.isArray(s.privacyAck)) s.privacyAck = [];
  s.ensemble = normalizeEnsemble(s.ensemble);
  cache = s;
  return s;
}

export function saveAiSettings(mut?: (s: AiSettings) => void): void {
  const s = aiSettings();
  mut?.(s);
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota */ }
  try { channel()?.postMessage({ type: 'settings', from: WINDOW_ID }); } catch { /* unsupported */ }
  listeners.forEach((f) => f());
}

export function onAiSettingsChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Reload after another window (the OAuth callback tab) changed settings. */
export function reloadAiSettings(): void {
  cache = null;
  listeners.forEach((f) => f());
}

// Settings changed in another tab (e.g. the OAuth callback tab): reload. Browser only, and unref'd so
// tooling that imports this module under Node can exit.
// One channel per window; a window's own messages are ignored (it has already applied them).
const WINDOW_ID = Math.random().toString(36).slice(2);
let bc: BroadcastChannel | null | undefined;
function channel(): BroadcastChannel | null {
  if (bc !== undefined) return bc;
  bc = null;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return bc;
  try {
    bc = new BroadcastChannel('quillpen-ai'); // rename:keep — other windows of older versions listen here
    bc.onmessage = (e) => { if (e.data?.from !== WINDOW_ID) reloadAiSettings(); };
    (bc as unknown as { unref?: () => void }).unref?.();
  } catch { /* unsupported */ }
  return bc;
}
channel();

// ------------------------------------------------------------------------------------------
// Keys

const keyCache = new Map<string, string>();

export async function getApiKey(providerId: string): Promise<string> {
  if (keyCache.has(providerId)) return keyCache.get(providerId)!;
  let k = '';
  try {
    k = isNative() ? (await secureGet('ai.key.' + providerId)) || '' : ((await kvGet('aikey:' + providerId)) as string) || '';
  } catch { k = ''; }
  keyCache.set(providerId, k);
  return k;
}

export async function setApiKey(providerId: string, key: string): Promise<void> {
  keyCache.set(providerId, key);
  if (isNative()) await secureSet('ai.key.' + providerId, key);
  else await kvSet('aikey:' + providerId, key);
}

export async function deleteApiKey(providerId: string): Promise<void> {
  keyCache.delete(providerId);
  if (isNative()) await secureRemove('ai.key.' + providerId);
  else await kvDel('aikey:' + providerId);
}

export function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 12 ? '•'.repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// ------------------------------------------------------------------------------------------
// Resolved configuration

export interface ResolvedProvider { def: ProviderDef; cfg: ProviderConfig; key: string; baseUrl: string }

export function resolveBaseUrl(def: ProviderDef, cfg: Partial<ProviderConfig>): string {
  let url = (cfg.baseUrl || def.baseUrl || '').trim();
  url = url.replace('{accountId}', encodeURIComponent(cfg.accountId || '')).replace('{resource}', encodeURIComponent(cfg.resource || '')).replace('{region}', encodeURIComponent(cfg.region || 'us-east-1'));
  return url.replace(/\/+$/, '');
}

export async function resolveProvider(id?: string | null): Promise<ResolvedProvider | null> {
  const s = aiSettings();
  const pid = id || s.active;
  if (!pid) return null;
  const def = providerById(pid);
  const cfg = s.providers[pid];
  if (!def || !cfg) return null;
  const key = def.needsKey || pid === 'custom' || pid === 'ollama' || pid === 'lmstudio' ? await getApiKey(pid) : '';
  return { def, cfg, key, baseUrl: resolveBaseUrl(def, cfg) };
}

export function recordUsage(tokensIn: number, tokensOut: number): void {
  saveAiSettings((s) => { s.usage.requests++; s.usage.tokensIn += tokensIn || 0; s.usage.tokensOut += tokensOut || 0; });
}

// ------------------------------------------------------------------------------------------
// Several AIs

/** The provider's quality model as configured here (or its default). */
export function qualityModel(id: string, s: AiSettings = aiSettings()): string {
  return s.providers[id]?.model || providerById(id)?.models.quality || '';
}

/**
 * The ensemble that normal AI commands use, or null for one AI: mode 'single', AI turned off, or
 * fewer than two members that are set up. The master/clerk must be set up; otherwise the active
 * provider (or the first member) takes that role.
 */
export function ensemblePlan(s: AiSettings = aiSettings()): EnsemblePlan | null {
  const e = s.ensemble;
  if (!s.enabled || !e || e.mode === 'single') return null;
  const usable = (id: string) => !!s.providers[id] && !!providerById(id);
  const members = e.members.filter((m) => usable(m.provider)).map((m) => ({ provider: m.provider, model: m.model || qualityModel(m.provider, s) }));
  if (members.length < MIN_MEMBERS) return null;
  const masterId = usable(e.master) ? e.master : s.active && usable(s.active) ? s.active : members[0].provider;
  const asMember = members.find((m) => m.provider === masterId);
  return { mode: e.mode, members, master: { provider: masterId, model: asMember?.model || qualityModel(masterId, s) }, maxRounds: e.maxRounds, memberTimeoutMs: e.memberTimeoutMs };
}

/** Every provider that receives the text of an AI command: the ensemble's members and master, or the active provider. */
export function receivingProviders(s: AiSettings = aiSettings()): string[] {
  const plan = ensemblePlan(s);
  if (!plan) return s.active ? [s.active] : [];
  return [...new Set([...plan.members.map((m) => m.provider), plan.master.provider])];
}
