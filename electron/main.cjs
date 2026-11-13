// Anne's Pen desktop app (Windows, macOS, Linux, Raspberry Pi OS): Electron main process.
//
// The web build (dist/) is served from the privileged app:// scheme so module workers, fetch and
// IndexedDB behave as on the web. The renderer is sandboxed with context isolation and no Node;
// electron/preload.cjs exposes `window.quillDesktop`, the same interface as the Android plugin.
// File access is limited to files the user opened or saved through a dialog, or opened the app
// with, so document content cannot use the bridge to read or overwrite arbitrary files.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, clipboard, safeStorage, powerSaveBlocker, Menu, session } = require('electron');
const path = require('node:path');
// The data folder keeps the app's former name (QuillPen) so settings, drafts and keys stay where earlier versions put them. // rename:keep
app.setPath('userData', path.join(app.getPath('appData'), 'QuillPen')); // rename:keep
app.setPath('sessionData', app.getPath('userData')); // rename:keep
const fs = require('node:fs');

// Anne's Pen was formerly named QuillForge: on the first start after the rename, copy the old data
// folder (settings, drafts, granted files, stored keys) to the new one before anything writes there.
try {
  const userData = app.getPath('userData');
  const legacy = path.join(path.dirname(userData), 'QuillForge'); // rename:keep
  if (!fs.existsSync(userData) && fs.existsSync(legacy)) fs.cpSync(legacy, userData, { recursive: true });
} catch { /* first run, or no access: start fresh */ }
const http = require('node:http');
const { pathToFileURL, fileURLToPath } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
// The page's origin keeps the app's former name so settings, drafts and keys stored by earlier
// versions stay readable.
const ORIGIN = `${SCHEME}://quillforge`; // rename:keep
const ORIGIN_HOST = 'quillforge'; // rename:keep
/** Whether a URL belongs to the app itself (app://quillforge/...), compared by parts, not by prefix. */
function isAppUrl(u) {
  try { const x = new URL(u); return x.protocol === SCHEME + ':' && x.host === ORIGIN_HOST; } catch { return false; }
}
const OPENABLE = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'wbk', 'asd', 'odt', 'ott', 'fodt', 'rtf', 'html', 'htm', 'md', 'markdown', 'txt', 'epub', 'qpd', 'qpde', 'json', // rename:keep — Anne's Pen was named QuillForge; its .qfd/.qfde files still open
  // Legacy word processors (opened by content, so the extension is only a hint)
  'wpd', 'wp', 'wp4', 'wp5', 'wp6', 'wpt', 'wps', 'wri', 'lwp', 'sam', 'mcw', 'cwk', 'wn', 'ws', 'ws4', 'ws5', 'ws6', 'ws7', 'xy', 'xyw', 'rft', 'dca', 'hwp',
  // Spreadsheets, presentations and email (imported as documents, or handed to the sister apps)
  'csv', 'tsv', 'xlsx', 'xls', 'ods', 'dbf', 'wk1', 'wks', 'pptx', 'ppt', 'odp', 'eml', 'emlx', 'mbox', 'mht', 'mhtml', 'msg',
  // XML, archive and text-markup formats
  'xml', 'wml', 'sxw', 'stw', 'abw', 'zabw', 'kwd', 'pages', 'hwpx', 'fb2', 'fbz', 'dbk', 'rtfd', 'tex', 'latex', 'rst', 'textile', 'adoc', 'asciidoc', 'org', 'man', 'roff', 'qfd', 'qfde'];

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
let pendingLaunch = null; // file opened before the window was ready
let wakeId = -1;

// ------------------------------------------------------------------------------------------
// Files the renderer may read and write

const grantsFile = () => path.join(app.getPath('userData'), 'granted-files.json');
const GRANT_DAYS = 30; // a file not opened or saved for this long must be opened through a dialog again
/** path -> time it was last granted (ms) */
let grants = new Map();
function loadGrants() {
  grants = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(grantsFile(), 'utf8'));
    const now = Date.now();
    // Earlier versions stored a plain list of paths: those count as granted now.
    const entries = Array.isArray(saved) ? saved.map((p) => [p, now]) : Object.entries(saved);
    for (const [p, t] of entries) if (typeof p === 'string' && typeof t === 'number' && now - t < GRANT_DAYS * 86400000) grants.set(p, t);
  } catch { /* none yet */ }
}
function grant(p) {
  const key = path.resolve(p);
  grants.delete(key);
  grants.set(key, Date.now());
  // Keep the most recent 200 (enough for the recent-files list).
  grants = new Map([...grants].slice(-200));
  try { fs.writeFileSync(grantsFile(), JSON.stringify(Object.fromEntries(grants)), { mode: 0o600 }); } catch { /* read-only profile */ }
}
function grantedPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a file address');
  const p = path.resolve(fileURLToPath(uri));
  const t = grants.get(p);
  if (t === undefined || Date.now() - t >= GRANT_DAYS * 86400000) throw new Error('Anne\'s Pen has no permission for this file; open it again.');
  return p;
}
const MIME = { csv: 'text/csv', eml: 'message/rfc822', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf', html: 'text/html', htm: 'text/html', md: 'text/markdown', txt: 'text/plain', epub: 'application/epub+zip', doc: 'application/msword', json: 'application/json' };
function fileResult(p) {
  const data = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  return { uri: pathToFileURL(p).href, name: path.basename(p), mime: MIME[ext] || 'application/octet-stream', data: data.toString('base64') };
}
function fileFromArgs(argv) {
  // Any file the system hands over opens: the content, not the extension, decides how.
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    try { if (fs.statSync(a).isFile() && !/\.(asar|js|cjs|exe|app)$/i.test(a)) return path.resolve(a); } catch { /* not a file */ }
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Sister apps (Anne's Grid, Anne's Post, Anne's Stage): open a file there when the system says that app
// handles the file type.

const SISTERS = { quillgrid: 'Anne\'s Grid', quillpost: 'Anne\'s Post', quillstage: 'Anne\'s Stage' };
function run(cmd, args) {
  try { return require('node:child_process').execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim(); } catch { return ''; }
}
/** The application registered for a file, as a name the sister-app check can match. */
function handlerFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (process.platform === 'linux') {
    const mime = run('xdg-mime', ['query', 'filetype', p]);
    return mime ? run('xdg-mime', ['query', 'default', mime]) : '';
  }
  if (process.platform === 'win32') {
    const user = run('reg', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, '/v', 'ProgId']);
    return user || run('cmd', ['/c', 'assoc', ext]);
  }
  if (process.platform === 'darwin') {
    // Launch Services: the default app's path for this file (empty when unknown).
    return run('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(${JSON.stringify(p)})); u ? u.path.js : ''`]);
  }
  return '';
}
function openExternalFile(p) {
  grant(p);
  if (win && !win.webContents.isLoading()) win.webContents.send('qf:fileOpened', fileResult(p));
  else pendingLaunch = p;
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}

// ------------------------------------------------------------------------------------------
// Secure storage (API keys): encrypted with the OS keychain / DPAPI / libsecret via safeStorage

const secureFile = () => path.join(app.getPath('userData'), 'secure.json');
function readSecure() { try { return JSON.parse(fs.readFileSync(secureFile(), 'utf8')); } catch { return {}; } }
function writeSecure(o) { fs.writeFileSync(secureFile(), JSON.stringify(o), { mode: 0o600 }); }
function seal(v) {
  return safeStorage.isEncryptionAvailable() ? { enc: true, v: safeStorage.encryptString(v).toString('base64') } : { enc: false, v };
}
function unseal(rec) {
  if (!rec) return null;
  return rec.enc ? safeStorage.decryptString(Buffer.from(rec.v, 'base64')) : rec.v;
}
// Only the AI settings keep secrets here (src/ai/store.ts: "ai.key.<provider>").
function secureKey(key) {
  const k = String(key);
  if (!/^ai\.[\w.-]{1,120}$/.test(k)) throw new Error('Refused');
  return k;
}

// ------------------------------------------------------------------------------------------
// Hosts the qf:http bridge may reach. The built-in AI providers (keep in step with the baseUrl
// values in src/ai/providers.ts; tests/unit/fix-e.test.ts checks this) are allowed; any other https
// host (a custom server, Ollama behind a reverse proxy) is allowed once the user confirms it here,
// in the main process, so page content cannot widen the list by itself.

const AI_HOSTS = [
  'openrouter.ai', 'generativelanguage.googleapis.com', 'api.groq.com', 'api.mistral.ai', 'api.cerebras.ai',
  'api.sambanova.ai', 'api.z.ai', 'api.cohere.ai', 'api.openai.com', 'api.anthropic.com', 'api.deepseek.com',
  'api.x.ai', 'api.perplexity.ai', 'api.together.xyz', 'api.fireworks.ai', 'router.huggingface.co',
  'api.moonshot.ai', 'dashscope-intl.aliyuncs.com', 'integrate.api.nvidia.com', 'api.cloudflare.com',
];
const AI_HOST_PATTERNS = [/^[a-z0-9-]+\.openai\.azure\.com$/, /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/];
const hostsFile = () => path.join(app.getPath('userData'), 'allowed-hosts.json');
let userHosts = null;
function knownHost(host) {
  if (AI_HOSTS.includes(host) || AI_HOST_PATTERNS.some((r) => r.test(host))) return true;
  if (!userHosts) { try { userHosts = new Set(JSON.parse(fs.readFileSync(hostsFile(), 'utf8'))); } catch { userHosts = new Set(); } }
  return userHosts.has(host);
}
const asking = new Map();
async function allowHost(host) {
  if (knownHost(host)) return true;
  if (!asking.has(host)) {
    asking.set(host, dialog.showMessageBox(win, {
      type: 'question', buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, title: 'AI server',
      message: `Allow Anne's Pen to send AI requests to ${host}?`,
      detail: 'Allow this only if you set up this server in the AI settings. Your documents and API key are sent to it.',
    }).then((r) => {
      asking.delete(host);
      if (r.response !== 0) return false;
      userHosts.add(host);
      try { fs.writeFileSync(hostsFile(), JSON.stringify([...userHosts])); } catch { /* read-only profile */ }
      return true;
    }));
  }
  return asking.get(host);
}

// ------------------------------------------------------------------------------------------
// OAuth loopback (OpenRouter PKCE), as on Android: one-shot listener on 127.0.0.1 only

let loop = null;
function stopLoop() { if (loop) { clearTimeout(loop.timer); try { loop.server.close(); } catch { /* */ } loop = null; } }

// ------------------------------------------------------------------------------------------
// IPC

const safeUrl = (u) => typeof u === 'string' && /^(https?|mailto|tel|ftp|sms|geo):/i.test(u.trim());
function handle(name, fn) {
  ipcMain.handle('qf:' + name, async (e, opts) => {
    if (!win || e.sender !== win.webContents || !e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error('Refused');
    return fn(opts || {});
  });
}

function registerIpc() {
  handle('openDocument', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: OPENABLE }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    grant(r.filePaths[0]);
    return fileResult(r.filePaths[0]);
  });
  handle('saveAs', async ({ name, data }) => {
    const ext = path.extname(String(name || '')).slice(1);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'document'))),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64'));
    grant(r.filePath);
    return { uri: pathToFileURL(r.filePath).href, name: path.basename(r.filePath) };
  });
  handle('writeUri', async ({ uri, data }) => {
    const p = grantedPath(uri);
    // Write a temporary file first, so a failed write never truncates the document.
    const tmp = p + '.qf-saving';
    fs.writeFileSync(tmp, Buffer.from(String(data || ''), 'base64'));
    fs.renameSync(tmp, p);
    return { ok: true };
  });
  handle('readUri', async ({ uri }) => fileResult(grantedPath(uri)));
  handle('print', async () => new Promise((res) => win.webContents.print({}, () => res())));
  handle('share', async ({ name, data }) => {
    // Desktops have no share sheet: offer Save As.
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'document'))) });
    if (!r.canceled && r.filePath) { fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64')); grant(r.filePath); }
  });
  handle('getLaunchFile', async () => {
    const p = pendingLaunch;
    pendingLaunch = null;
    return p ? fileResult(p) : {};
  });
  handle('keepAwake', async ({ on }) => {
    if (on && wakeId < 0) wakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && wakeId >= 0) { powerSaveBlocker.stop(wakeId); wakeId = -1; }
  });
  handle('secureSet', async ({ key, value }) => { const k = secureKey(key); const o = readSecure(); o[k] = seal(String(value)); writeSecure(o); });
  handle('secureGet', async ({ key }) => { const k = secureKey(key); try { return { value: unseal(readSecure()[k]) }; } catch { return { value: null }; } });
  handle('secureRemove', async ({ key }) => { const k = secureKey(key); const o = readSecure(); delete o[k]; writeSecure(o); });
  // false when no OS keychain is available (some Linux desktops): keys are then stored unencrypted.
  handle('secureInfo', async () => ({ encrypted: safeStorage.isEncryptionAvailable() }));
  handle('readClipboard', async () => ({ text: clipboard.readText() }));
  handle('writeClipboard', async ({ text }) => { clipboard.writeText(String(text ?? '')); });
  handle('startLoopback', async ({ timeoutMs, successHtml, path: want }) => {
    stopLoop();
    const server = http.createServer((req, res) => {
      // Only this sign-in's nonce path counts: another program probing the port must not end it.
      if (typeof want === 'string' && want && String(req.url || '').split('?')[0] !== want) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(typeof successHtml === 'string' ? successHtml : '<p>You can close this tab.</p>');
      const port = server.address().port;
      if (win) win.webContents.send('qf:oauthCallback', { url: `http://127.0.0.1:${port}${req.url}` });
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      setTimeout(stopLoop, 500);
    });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    loop = { server, timer: setTimeout(stopLoop, Math.min(Number(timeoutMs) || 300000, 900000)) };
    return { port: server.address().port };
  });
  handle('stopLoopback', async () => stopLoop());
  handle('openExternal', async ({ url }) => { if (safeUrl(url)) await shell.openExternal(url); });
  handle('openWith', async ({ app: id, uri, name, data }) => {
    const label = SISTERS[id];
    if (!label) throw new Error('Unknown app');
    let p;
    if (typeof uri === 'string' && uri.startsWith('file:')) p = grantedPath(uri);
    else {
      // A file without a path on disk (opened from the web build or a recovered copy): write a temporary copy.
      const dir = path.join(app.getPath('temp'), 'quillpen-open');
      fs.mkdirSync(dir, { recursive: true });
      p = path.join(dir, path.basename(String(name || 'document')).replace(/[\\/:*?"<>|]/g, '_'));
      fs.writeFileSync(p, Buffer.from(String(data || ''), 'base64'));
    }
    const handler = handlerFor(p);
    // The sister app may be installed under its new name (Anne's Grid) or its old one (QuillGrid). // rename:keep
    if (!new RegExp(`${id}|anne'?s${id.slice(5)}`, 'i').test(handler.replace(/\s+/g, ''))) return { ok: false, handler, app: label };
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err, app: label } : { ok: true, app: label };
  });
  handle('http', async ({ url, method, headers, data }) => {
    let host;
    try { const u = new URL(String(url)); if (u.protocol !== 'https:') throw new Error(); host = u.hostname.toLowerCase(); } catch { throw new Error('Only https requests are allowed'); }
    if (!(await allowHost(host))) throw new Error(`Requests to ${host} are not allowed`);
    const res = await net.fetch(url, { method: method || 'GET', headers: headers || {}, body: data == null ? undefined : typeof data === 'string' ? data : JSON.stringify(data) });
    return { status: res.status, text: await res.text() };
  });
}

// ------------------------------------------------------------------------------------------
// Window

// Content Security Policy for the app. 'unsafe-eval' is needed by user macros (Developer tab, which
// run through new Function); the jsDelivr package paths (pinned versions, src/ai/local.ts) and wasm are
// for the optional on-device AI model; http to localhost is for Ollama and LM Studio. Inline
// scripts and plugins are never allowed. Keep in step with the meta CSP in index.html.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/ https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.0-dev.20251116-b39e144322/dist/",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* data: blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function serveApp() {
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return new Response('Forbidden', { status: 403 });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html');
    const res = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: 'Anne\'s Pen',
    backgroundColor: '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false, // Anne's Pen has its own spelling checker
    },
  });
  // Links open in the system browser; the window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (safeUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); if (safeUrl(url)) void shell.openExternal(url); } });
  // The page asks before unloading with unsaved documents: confirm here, as the browser would.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Unsaved changes', message: 'Some documents have unsaved changes. Close Anne\'s Pen anyway?' });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  void win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', (_e, argv) => {
  const p = fileFromArgs(argv);
  if (p) openExternalFile(p);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
// macOS: files opened from Finder (before or after launch).
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openExternalFile(p); else pendingLaunch = p; });

// Browser permissions: only what the app uses (clipboard, full screen, the microphone for
// dictation), and only for the app's own pages. Everything else is denied.
const PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media']);
function permitted(permission, url, details) {
  if (!PERMISSIONS.has(permission) || !isAppUrl(url)) return false;
  if (permission === 'media') return !!details && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio');
  return true;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(permitted(permission, (details && details.requestingUrl) || wc.getURL(), details)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) => permitted(permission, (details && details.requestingUrl) || origin, permission === 'media' ? { mediaTypes: details && details.mediaType ? [details.mediaType] : [] } : details));
  loadGrants();
  const p = pendingLaunch || fileFromArgs(process.argv);
  if (p) { grant(p); pendingLaunch = p; }
  serveApp();
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { stopLoop(); if (process.platform !== 'darwin') app.quit(); });
