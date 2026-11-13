// @vitest-environment node
// Build, release and platform hardening: service worker precache, KaTeX fonts, Android version
// codes, workflow hygiene, desktop and web Content Security Policy, and the Android manifest.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { katexWoff2Only, swPrecache } from '../../vite.config';
import { PROVIDERS } from '../../src/ai/providers';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const call = (hook: unknown, ctx: unknown, ...args: unknown[]) => (typeof hook === 'function' ? hook : (hook as { handler: (...a: unknown[]) => unknown }).handler).apply(ctx, args);

describe('KaTeX fonts', () => {
  it('keeps only the woff2 source of each @font-face', () => {
    const css = '@font-face{font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),url(fonts/KaTeX_AMS-Regular.woff) format("woff"),url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")}';
    const out = call(katexWoff2Only().transform, {}, css, '/x/node_modules/katex/dist/katex.min.css') as { code: string };
    expect(out.code).toBe('@font-face{font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2")}');
    expect(call(katexWoff2Only().transform, {}, css, '/src/styles/app.css')).toBeNull();
  });
});

/** Builds a fake dist/ and runs the precache plugin over it. */
function buildSw(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'qf-sw-'));
  writeFileSync(join(dir, 'sw.js'), read('public/sw.js'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text); }
  const p = swPrecache();
  call(p.configResolved, {}, { root: dir, build: { outDir: '.' } });
  call(p.closeBundle, {});
  return readFileSync(join(dir, 'sw.js'), 'utf8');
}

/** Runs a service worker script against in-memory Cache Storage and a scripted network. */
function runSw(code: string, net: (url: string) => Response | Error) {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    const key = (r: Request | string) => new URL(typeof r === 'string' ? r : r.url).href;
    return {
      match: async (r: Request | string, o?: { ignoreSearch?: boolean }) => {
        const k = key(r);
        for (const [u, res] of m) if (u === k || (o?.ignoreSearch && u.split('?')[0] === k.split('?')[0])) return res.clone();
        return undefined;
      },
      put: async (r: Request | string, res: Response) => { m.set(key(r), res); },
      addAll: async (rs: Request[]) => { for (const r of rs) { const res = net(r.url); if (res instanceof Error) throw res; m.set(key(r), res); } },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
    match: async (r: Request | string, o: { cacheName: string; ignoreSearch?: boolean }) => (stores.has(o.cacheName) ? (await open(o.cacheName)).match(r, o) : undefined),
  };
  const listeners: Record<string, (e: any) => void> = {};
  const self = {
    registration: { scope: 'https://example.org/app/' },
    location: new URL('https://example.org/app/sw.js'),
    addEventListener: (t: string, f: (e: any) => void) => { listeners[t] = f; },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const fetchFn = async (r: Request) => { const res = net(r.url); if (res instanceof Error) throw res; return res; };
  new Function('self', 'caches', 'fetch', code)(self, caches, fetchFn);
  const dispatch = async (type: string, init: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners[type]({ ...init, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => { responded = p; } });
    const res = responded ? await responded : undefined;
    for (let i = 0; i < waits.length; i++) await waits[i];
    return res;
  };
  const navigate = (url: string) => dispatch('fetch', { request: { url, method: 'GET', mode: 'navigate', headers: new Headers() } });
  return { stores, dispatch, navigate };
}

const basic = (body: string, status = 200) => Object.defineProperty(new Response(body, { status }), 'type', { value: 'basic' });

describe('service worker', () => {
  it('precaches every built file under a cache named after the build', () => {
    const sw = buildSw({ 'index.html': '<html>', 'assets/index-abc.js': 'js', 'assets/KaTeX_Main-Regular-x.woff2': 'f', 'assets/dictionary-en-gb-y.js': 'd' });
    expect(sw).not.toContain('__PRECACHE__');
    const precache = JSON.parse(/const PRECACHE = (\[.*?\]);/.exec(sw)![1]);
    expect(precache).toEqual(['./', './assets/KaTeX_Main-Regular-x.woff2', './assets/dictionary-en-gb-y.js', './assets/index-abc.js', './index.html']);
    const version = JSON.parse(/const VERSION = ("[^"]*");/.exec(sw)![1]);
    expect(version).toMatch(/^\d+\.\d+\.\d+-[0-9a-f]{12}$/);
    // Another build gets another cache.
    const other = buildSw({ 'index.html': '<html>', 'assets/index-def.js': 'js' });
    expect(JSON.parse(/const VERSION = ("[^"]*");/.exec(other)![1])).not.toBe(version);
  });

  it('installs everything, drops its own old caches only, and serves offline', async () => {
    const sw = buildSw({ 'index.html': '<html>app</html>', 'assets/a.js': 'A' });
    let online = true;
    const env = runSw(sw, (u) => (online ? basic(u.endsWith('index.html') || u.endsWith('/app/') ? '<html>app</html>' : 'body of ' + u) : new TypeError('offline')));
    env.stores.set('quillpen-v1', new Map()); // rename:keep — this app's cache before the rename
    env.stores.set('annes-pen-0.4.0-old', new Map());
    env.stores.set('quillgrid-v1', new Map()); // a sister app on the same origin
    await env.dispatch('install');
    await env.dispatch('activate');
    const names = [...env.stores.keys()];
    expect(names.filter((n) => n.startsWith('annes-pen-'))).toHaveLength(1);
    expect(names).toContain('quillgrid-v1');
    expect(names).not.toContain('quillpen-v1'); // rename:keep
    const cache = env.stores.get(names.find((n) => n.startsWith('annes-pen-'))!)!;
    expect([...cache.keys()].sort()).toEqual(['https://example.org/app/', 'https://example.org/app/assets/a.js', 'https://example.org/app/index.html']);

    online = false;
    const page = await env.navigate('https://example.org/app/?embed=compose');
    expect(await page!.text()).toBe('<html>app</html>');
    const other = await env.navigate('https://example.org/app/missing/page');
    expect(await other!.text()).toBe('<html>app</html>');
  });

  it('caches only good copies of the app page from navigations', async () => {
    const sw = buildSw({ 'index.html': 'v1' });
    const net: { [u: string]: Response } = {};
    const env = runSw(sw, (u) => net[u] ?? basic('v1'));
    await env.dispatch('install');
    const name = [...env.stores.keys()][0];
    const cached = async () => (await env.stores.get(name)!.get('https://example.org/app/index.html')!.clone().text());
    net['https://example.org/app/third-party-notices.txt'] = basic('notices');
    await env.navigate('https://example.org/app/third-party-notices.txt');
    expect(await cached()).toBe('v1');
    net['https://example.org/app/'] = basic('not found', 404);
    await env.navigate('https://example.org/app/');
    expect(await cached()).toBe('v1');
    net['https://example.org/app/'] = Object.defineProperty(new Response('opaque', { status: 200 }), 'type', { value: 'opaqueredirect' });
    await env.navigate('https://example.org/app/');
    expect(await cached()).toBe('v1');
    net['https://example.org/app/'] = basic('v2');
    await env.navigate('https://example.org/app/');
    expect(await cached()).toBe('v2');
  });
});

describe('Android versionCode', () => {
  const code = (...args: string[]) => Number(execFileSync(process.execPath, [join(root, 'scripts/android-version-code.mjs'), ...args], { encoding: 'utf8' }).trim());
  it('derives the code from the version; test builds sort below the release', () => {
    expect(code('--version', '0.5.0', '--release')).toBe(50099);
    expect(code('--version', '1.2.3', '--release')).toBe(1020399);
    expect(code('--version', '0.5.0', '--build', '7')).toBe(50007);
    expect(code('--version', '0.5.0', '--build', '500')).toBe(50098);
    expect(code('--version', '0.6.0-beta.1', '--build', '3')).toBe(60003);
    expect(code('--version', '0.5.0', '--build', '98')).toBeLessThan(code('--version', '0.5.0', '--release'));
    expect(code('--version', '0.5.0', '--release')).toBeLessThan(code('--version', '0.5.1', '--build', '0'));
  });
  it('refuses versions that do not fit', () => {
    expect(() => execFileSync(process.execPath, [join(root, 'scripts/android-version-code.mjs'), '--version', '1.100.0'], { stdio: 'ignore' })).toThrow();
  });
});

describe('workflows', () => {
  const files = readdirSync(join(root, '.github/workflows')).filter((f) => f.endsWith('.yml'));
  it('pin every action to a commit and keep expressions out of run scripts', () => {
    for (const f of files) {
      const lines = read('.github/workflows/' + f).split('\n');
      for (const l of lines) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(l);
        if (m && !m[1].startsWith('./')) {
          expect(m[1], `${f}: ${l}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
          expect(m[2], `${f}: ${l}`).toMatch(/# v\d+\.\d+\.\d+/);
        }
      }
      // Lines of each `run:` block (inline or indented below it).
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        const block = [m[2]];
        const indent = m[1].length;
        if (/^[|>]/.test(m[2])) for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].search(/\S/) > indent); j++) block.push(lines[j]);
        expect(block.join('\n'), `${f}:${i + 1}`).not.toContain('${{');
      }
    }
  });
  it('publish releases only from tags or main, behind the release environment', () => {
    const rel = read('.github/workflows/release.yml');
    expect(rel).not.toMatch(/branches:\s*\['\*\*'\]/);
    expect(rel).toContain('environment: release');
    expect(rel).toMatch(/^permissions:\n\s+contents: read/m);
    expect(rel).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$');
    const android = read('.github/workflows/android.yml');
    expect(android).toContain('-android.');
    expect(rel).toContain('-build.');
  });
});

describe('desktop app', () => {
  const main = read('electron/main.cjs');
  it('allows the qf:http bridge to reach every built-in AI provider', () => {
    const hosts = JSON.parse(/const AI_HOSTS = (\[[\s\S]*?\]);/.exec(main)![1].replace(/'/g, '"').replace(/,\s*\]/, ']')) as string[];
    const patterns = [/^[a-z0-9-]+\.openai\.azure\.com$/, /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/];
    for (const p of PROVIDERS) {
      if (!/^https:/.test(p.baseUrl)) continue;
      const host = new URL(p.baseUrl.replace('{resource}', 'res').replace('{region}', 'us-east-1').replace('{accountId}', 'acc')).hostname;
      expect(hosts.includes(host) || patterns.some((r) => r.test(host)), host).toBe(true);
    }
  });
  it('checks the app origin by its parts and limits secure storage to AI keys', () => {
    expect(main).not.toMatch(/startsWith\(ORIGIN\)/);
    expect(main).toContain("x.protocol === SCHEME + ':' && x.host === ORIGIN_HOST");
    expect(main).toContain(String.raw`/^ai\.[\w.-]{1,120}$/`);
    expect(main).toContain('setPermissionRequestHandler');
  });
  it('uses the same script sources as the web CSP, covering the on-device AI library', () => {
    const scriptSrc = (csp: string) => /script-src ([^;"]+)/.exec(csp)![1].trim();
    const web = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read('index.html'))![1];
    const desk = /const CSP = \[([\s\S]*?)\]\.join/.exec(main)![1];
    expect(scriptSrc(desk)).toBe(scriptSrc(web));
    expect(scriptSrc(web)).not.toMatch(/https:\/\/cdn\.jsdelivr\.net(\s|$)/);
    const lib = /TRANSFORMERS_URL = '([^']+)'/.exec(read('src/ai/local.ts'))![1];
    expect(scriptSrc(web).split(/\s+/).some((s) => s.endsWith('/') && lib.startsWith(s))).toBe(true);
    for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'none'"]) expect(web).toContain(d);
  });
});

describe('Android manifest', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  it('accepts no file: URIs and shares only the share folder', () => {
    expect(manifest).not.toContain('android:scheme="file"');
    expect(manifest).toContain('android:allowBackup="false"');
    const paths = read('android/app/src/main/res/xml/file_paths.xml');
    expect(paths).not.toMatch(/external-path|path="\."/);
    expect(paths).toContain('<cache-path name="shared" path="shared/" />');
  });
  it('offers Share to for .doc files', () => {
    const send = manifest.slice(manifest.indexOf('android.intent.action.SEND'));
    expect(send.slice(0, send.indexOf('</intent-filter>'))).toContain('application/msword');
  });
});
