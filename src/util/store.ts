/** Minimal IndexedDB key-value store with a localStorage fallback. */
import { migrateIndexedDb } from './legacy';
const DB = 'quillpen';
const OS = 'kv';
let dbp: Promise<IDBDatabase | null> | null = null;
let lastError: string | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onsuccess = () => { const db = req.result; void migrateIndexedDb(db, OS).finally(() => resolve(db)); };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

/** Why the last kvSet or kvDel failed ('QuotaExceededError' when storage is full), or null. */
export function kvLastError(): string | null { return lastError; }

const isQuota = (e: any) => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
function fail(e: any): false {
  lastError = isQuota(e) ? 'QuotaExceededError' : String(e?.name || e?.message || e || 'Error');
  return false;
}

// localStorage holds text only: binary values are stored as tagged base64 so they come back as ArrayBuffers.
const BIN = '__qfbin';
function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function encode(value: any): string {
  return JSON.stringify(value, function (this: any, k: string, v: any) {
    const raw = this[k];
    if (raw instanceof ArrayBuffer) return { [BIN]: toB64(new Uint8Array(raw)) };
    if (ArrayBuffer.isView(raw)) return { [BIN]: toB64(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), view: 'u8' };
    return v;
  });
}
function decode(text: string): any {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && typeof v[BIN] === 'string') {
      const s = atob(v[BIN]);
      const u8 = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
      return v.view === 'u8' ? u8 : u8.buffer;
    }
    return v;
  });
}

export async function kvGet<T = any>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) {
    try { const v = localStorage.getItem('qfkv:' + key); return v ? decode(v) : undefined; } catch { return undefined; }
  }
  return new Promise((resolve) => {
    try {
      const r = db.transaction(OS).objectStore(OS).get(key);
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

/** Resolves true once stored, false if it could not be (see kvLastError). Never rejects. */
export async function kvSet(key: string, value: any): Promise<boolean> {
  const db = await open();
  if (!db) {
    try { localStorage.setItem('qfkv:' + key, encode(value)); lastError = null; return true; } catch (e) { return fail(e); }
  }
  return write(db, (s) => s.put(value, key));
}

export async function kvDel(key: string): Promise<boolean> {
  const db = await open();
  if (!db) { try { localStorage.removeItem('qfkv:' + key); return true; } catch (e) { return fail(e); } }
  return write(db, (s) => s.delete(key));
}

/** One readwrite transaction; it settles on complete, error or abort (quota errors arrive as an abort). */
function write(db: IDBDatabase, op: (s: IDBObjectStore) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const end = (ok: boolean, e?: any) => { if (settled) return; settled = true; resolve(ok ? ((lastError = null), true) : fail(e)); };
    try {
      const tx = db.transaction(OS, 'readwrite');
      tx.oncomplete = () => end(true);
      tx.onerror = () => end(false, tx.error);
      tx.onabort = () => end(false, tx.error);
      op(tx.objectStore(OS));
    } catch (e) {
      end(false, e);
    }
  });
}

export async function kvKeys(prefix = ''): Promise<string[]> {
  const db = await open();
  if (!db) {
    try { return Object.keys(localStorage).filter((k) => k.startsWith('qfkv:' + prefix)).map((k) => k.slice(5)); } catch { return []; }
  }
  return new Promise((resolve) => {
    try {
      const r = db.transaction(OS).objectStore(OS).getAllKeys();
      r.onsuccess = () => resolve((r.result as string[]).filter((k) => String(k).startsWith(prefix)));
      r.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

/** For tests: use this database (or none, for the localStorage fallback) instead of opening one. */
export function _setDbForTest(db: IDBDatabase | null): void { dbp = Promise.resolve(db); }

// ------------------------------------------------------------------------------------------
// Window sessions: which window owns a draft. A window holds a Web Lock for its lifetime where
// locks exist, and writes a heartbeat to localStorage everywhere.

export const SESSION_ID = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const BEAT = 'annespen.session.';
/** Background tabs may run timers only once a minute, so a heartbeat counts as stale well after that. */
export const SESSION_STALE_MS = 75_000;
const lockName = (id: string) => `annespen-session-${id}`;
const locks = (): any => (typeof navigator !== 'undefined' ? (navigator as any).locks : undefined);

export function sessionBeat(): void {
  try { localStorage.setItem(BEAT + SESSION_ID, String(Date.now())); } catch { /* */ }
}

let started = false;
/** Starts this window's session: the lock, and a heartbeat every 10 seconds. */
export function startSession(): void {
  if (started) return;
  started = true;
  sessionBeat();
  setInterval(sessionBeat, 10_000);
  try { locks()?.request(lockName(SESSION_ID), () => new Promise(() => undefined)); } catch { /* */ }
  try {
    // Heartbeats of sessions that ended long ago.
    for (const k of Object.keys(localStorage)) if (k.startsWith(BEAT) && Date.now() - Number(localStorage.getItem(k)) > 86_400_000) localStorage.removeItem(k);
  } catch { /* */ }
}

export function endSession(): void {
  try { localStorage.removeItem(BEAT + SESSION_ID); } catch { /* */ }
}

/** Whether the window that wrote a draft is still open. Drafts from before sessions have no owner. */
export async function sessionAlive(id: string | undefined, now = Date.now()): Promise<boolean> {
  if (!id) return false;
  if (id === SESSION_ID) return true;
  const l = locks();
  if (l?.query) {
    try {
      const q = await l.query();
      return [...(q.held || []), ...(q.pending || [])].some((x: any) => x.name === lockName(id));
    } catch { /* fall back to the heartbeat */ }
  }
  let beat = 0;
  try { beat = Number(localStorage.getItem(BEAT + id)) || 0; } catch { /* */ }
  return now - beat < SESSION_STALE_MS;
}

/** Draft keys whose window is gone (so they can be offered for recovery). */
export async function orphanedDrafts(exclude: (key: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  for (const k of await kvKeys('draft:')) {
    if (exclude(k)) continue;
    const d = await kvGet(k);
    if (!(await sessionAlive(d?.owner))) out.push(k);
  }
  return out;
}
