/**
 * OpenRouter sign-in with OAuth PKCE: the user signs in on openrouter.ai in the default
 * browser and OpenRouter hands back a code that Anne's Pen exchanges for an API key. No
 * copying or pasting.
 *
 * OpenRouter accepts https callbacks and http://localhost / 127.0.0.1 on any port.
 *  - Browser build: the callback is this page (opened in a new tab), which finishes the
 *    exchange and tells the original tab through BroadcastChannel.
 *  - Android: QuillNative listens once on http://127.0.0.1:<port>/ and passes the redirect to
 *    the app.
 * If neither works (for example a browser that blocks the local redirect), the user can paste
 * the address bar URL or the code shown by OpenRouter; parseOAuthInput() accepts both.
 *
 * Each sign-in puts a random nonce in the callback address (a path on the loopback, a query
 * parameter in the browser). Redirects without it are ignored: another app on the device could
 * otherwise end the sign-in with a bogus code, or hand Anne's Pen a code for an account of its own.
 */
import { isNative, openExternal, startOAuthLoopback, stopOAuthLoopback, onOAuthCallback } from '../platform/native';

const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const SESSION_KEY = 'quillpen.oauth.openrouter';

function b64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter did not accept the sign-in code (${res.status}): ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (!j.key) throw new Error('OpenRouter did not return a key.');
  return j.key as string;
}

/** A loopback redirect for this sign-in (its nonce path), not some other request to the port. */
export function isOurCallback(url: string, path: string): boolean {
  try { return new URL(url).pathname === path; } catch { return false; }
}

/** Extract an authorization code from a pasted redirect URL or a bare code. */
export function parseOAuthInput(s: string): string | null {
  const t = s.trim();
  const m = /[?&]code=([^&#\s]+)/.exec(t);
  if (m) return decodeURIComponent(m[1]);
  return /^[A-Za-z0-9._~-]{16,}$/.test(t) ? t : null;
}

export interface OAuthSession {
  /** Resolves with the API key, or rejects on timeout/cancel. */
  key: Promise<string>;
  /** Finish manually with a pasted URL or code. */
  complete(input: string): Promise<string>;
  cancel(): void;
}

/** Start sign-in: opens openrouter.ai in the default browser. */
export async function startOpenRouterSignIn(timeoutMs = 10 * 60 * 1000): Promise<OAuthSession> {
  const { verifier, challenge } = await pkce();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  let settle!: { resolve: (k: string) => void; reject: (e: Error) => void };
  const key = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  let done = false;
  const cleanup: (() => void)[] = [];
  const finish = async (code: string) => {
    if (done) return;
    try {
      const k = await exchangeCode(code, verifier);
      done = true;
      cleanup.forEach((f) => f());
      settle.resolve(k);
    } catch (e) {
      if (!done) { done = true; cleanup.forEach((f) => f()); settle.reject(e as Error); }
    }
  };

  let callback: string;
  if (isNative()) {
    const path = `/callback/${nonce}`;
    const port = await startOAuthLoopback(timeoutMs, '<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px;text-align:center"><h2>Signed in</h2><p>Anne\'s Pen received your OpenRouter key. You can close this tab and return to Anne\'s Pen.</p></body>', path);
    callback = `http://127.0.0.1:${port}${path}`;
    const h = await onOAuthCallback((url) => {
      if (!isOurCallback(url, path)) return;
      const err = new URL(url).searchParams.get('error');
      if (err && !done) { done = true; cleanup.forEach((f) => f()); settle.reject(new Error(`OpenRouter sign-in did not complete (${err}).`)); return; }
      const c = parseOAuthInput(url);
      if (c) void finish(c);
    });
    cleanup.push(() => h.remove(), () => void stopOAuthLoopback());
  } else {
    // The callback page is Anne's Pen itself in a new tab; it finishes the exchange and broadcasts.
    const session = JSON.stringify({ verifier, nonce });
    sessionStorage.setItem(SESSION_KEY, session);
    try { localStorage.setItem(SESSION_KEY, session); } catch { /* storage off */ }
    const u = new URL(location.href);
    u.search = `?qf-oauth=openrouter&qf-state=${nonce}`;
    u.hash = '';
    callback = u.toString();
    const bc = new BroadcastChannel('quillpen-oauth');
    bc.onmessage = (e) => { if (e.data?.type === 'openrouter-key' && e.data.key) { done = true; cleanup.forEach((f) => f()); settle.resolve(e.data.key); } };
    cleanup.push(() => bc.close(), () => { try { localStorage.removeItem(SESSION_KEY); } catch { /* */ } });
  }
  const timer = setTimeout(() => { if (!done) { done = true; cleanup.forEach((f) => f()); settle.reject(new Error('Sign-in timed out.')); } }, timeoutMs);
  cleanup.push(() => clearTimeout(timer));

  const url = `${AUTH_URL}?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
  if (isNative()) openExternal(url);
  else window.open(url, '_blank', 'noopener');

  return {
    key,
    async complete(input: string) {
      const c = parseOAuthInput(input);
      if (!c) throw new Error('That does not look like an OpenRouter sign-in code or redirect address.');
      await finish(c);
      return key;
    },
    cancel() { if (!done) { done = true; cleanup.forEach((f) => f()); settle.reject(new Error('Canceled')); } },
  };
}

/**
 * Browser build: if this page was opened as the OAuth callback, finish the exchange, save the
 * key and tell the original tab. Returns true when it handled a callback.
 */
export async function handleOAuthRedirect(save: (key: string) => Promise<void>): Promise<boolean> {
  const u = new URL(location.href);
  if (u.searchParams.get('qf-oauth') !== 'openrouter') return false;
  const code = u.searchParams.get('code');
  const raw = sessionStorage.getItem(SESSION_KEY) || (() => { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } })();
  history.replaceState(null, '', u.pathname);
  let session: { verifier?: string; nonce?: string } = {};
  try { session = JSON.parse(raw || '{}'); } catch { /* none */ }
  // Only the redirect of the sign-in this browser started (another site could open this address).
  if (!code || !session.verifier || !session.nonce || u.searchParams.get('qf-state') !== session.nonce) return false;
  const key = await exchangeCode(code, session.verifier);
  await save(key);
  try { new BroadcastChannel('quillpen-oauth').postMessage({ type: 'openrouter-key', key }); } catch { /* */ }
  try { localStorage.removeItem(SESSION_KEY); } catch { /* */ }
  return true;
}
