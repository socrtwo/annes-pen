/**
 * Platform bridge. One API, three back ends:
 * - Android: the `QuillNative` Capacitor plugin (android/app/src/main/java/.../QuillNativePlugin.java)
 *   provides the Storage Access Framework (real Open / Save As dialogs, write-back to the same file),
 *   the system print service (which also offers "Save as PDF"), sharing, and files opened from other apps.
 * - Desktop (Windows, macOS, Linux, Raspberry Pi OS): the Electron preload (electron/preload.cjs)
 *   exposes the same interface as `window.quillDesktop`, backed by native file dialogs and the file system.
 * - Browser and iOS: <input type=file>, the File System Access API or downloads, and window.print().
 *   On iOS, saved files go to the app's Documents folder (Files ▸ On My iPhone ▸ Anne's Pen).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { download, pickFile } from '../ui/dom';
import { OPEN_EXTENSIONS_B, OPEN_MIMES_B } from '../io/sniff-b';

export interface OpenedFile { name: string; data: ArrayBuffer; uri: string | null; mime?: string }

interface QuillNativePlugin {
  /** ACTION_OPEN_DOCUMENT. Resolves {canceled:true} when dismissed. */
  openDocument(opts: { mimeTypes: string[] }): Promise<{ canceled?: boolean; uri?: string; name?: string; mime?: string; data?: string /* base64 */ }>;
  /** ACTION_CREATE_DOCUMENT then write. */
  saveAs(opts: { name: string; mime: string; data: string /* base64 */ }): Promise<{ canceled?: boolean; uri?: string; name?: string }>;
  /** Overwrite an existing document URI obtained from openDocument/saveAs (persisted permission). */
  writeUri(opts: { uri: string; data: string /* base64 */ }): Promise<{ ok: boolean }>;
  /** Read a URI again (recent files). */
  readUri(opts: { uri: string }): Promise<{ name?: string; mime?: string; data: string }>;
  /** Print the current WebView through PrintManager. */
  print(opts: { jobName: string }): Promise<void>;
  /** Share a file through ACTION_SEND. */
  share(opts: { name: string; mime: string; data: string; title?: string }): Promise<void>;
  /** File the app was launched with (ACTION_VIEW / ACTION_SEND), consumed once. */
  getLaunchFile(): Promise<{ uri?: string; name?: string; mime?: string; data?: string }>;
  /** Keep the screen awake (read-aloud, teleprompter). */
  keepAwake(opts: { on: boolean }): Promise<void>;
  addListener(event: 'fileOpened', cb: (f: { uri?: string; name?: string; mime?: string; data?: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'oauthCallback', cb: (r: { url: string }) => void): Promise<{ remove: () => void }>;
  /** Android Keystore-backed encrypted preferences (API keys). */
  secureSet(opts: { key: string; value: string }): Promise<void>;
  secureGet(opts: { key: string }): Promise<{ value?: string | null }>;
  secureRemove(opts: { key: string }): Promise<void>;
  /** ClipboardManager text (foreground app only; Android 12+ shows a "pasted" notice). */
  readClipboard(): Promise<{ text?: string | null }>;
  writeClipboard(opts: { text: string; sensitive?: boolean }): Promise<void>;
  /** One-shot http://127.0.0.1:<port>/ listener for OAuth redirects (OpenRouter PKCE); only requests for `path` count. */
  startLoopback(opts: { timeoutMs: number; successHtml?: string; path?: string }): Promise<{ port: number }>;
  stopLoopback(): Promise<void>;
  /** Android: is a sister app (Anne's Grid, Anne's Post, Anne's Stage) installed? */
  canLaunchApp?(opts: { package: string }): Promise<{ installed: boolean }>;
  /** Android: open a file in a sister app (ACTION_VIEW restricted to that package). */
  launchApp?(opts: { package: string; uri?: string | null; name: string; mime: string; data?: string }): Promise<{ installed: boolean; launched: boolean }>;
}

/** The desktop bridge adds what Android gets from Capacitor itself. */
interface DesktopBridge extends QuillNativePlugin {
  /** 'win32' | 'darwin' | 'linux' */
  platform: string;
  openExternal(opts: { url: string }): Promise<void>;
  /** Open a file with a sister app when the system registers it for that file type. */
  openWith(opts: { app: string; uri?: string | null; name: string; data?: string }): Promise<{ ok: boolean; app: string; handler?: string; error?: string }>;
  /** HTTP from the main process (no CORS), for AI providers that block browsers. */
  http(opts: { url: string; method: string; headers: Record<string, string>; data?: unknown }): Promise<{ status: number; text: string }>;
  /** encrypted: false when the system has no keychain (some Linux desktops): keys are stored unencrypted. */
  secureInfo?(): Promise<{ encrypted: boolean }>;
}

const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? (window as any).quillDesktop : undefined;
const Native: QuillNativePlugin = desktop || registerPlugin<QuillNativePlugin>('QuillNative');

/** Running in the Capacitor app shell (Android or iOS). */
export const isCapacitor = (): boolean => Capacitor.isNativePlatform();
/** A native bridge is present: real file dialogs, write-back, secure storage, OAuth loopback (Android app or desktop app). */
export const isNative = (): boolean => !!desktop || (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('QuillNative'));
export const isDesktop = (): boolean => !!desktop;
export const isIOS = (): boolean => Capacitor.getPlatform() === 'ios';
/** 'android' | 'ios' | 'web' | 'windows' | 'macos' | 'linux' */
export const platformName = (): string => (desktop ? ({ win32: 'windows', darwin: 'macos' } as Record<string, string>)[desktop.platform] || 'linux' : Capacitor.getPlatform());
/** Desktop HTTP without CORS, or null when not on desktop. */
export const desktopHttp = desktop ? (o: { url: string; method: string; headers: Record<string, string>; data?: unknown }) => desktop.http(o) : null;

// iOS: files live in the app's Documents folder, which the Files app shows.
const IOS_PREFIX = 'ios-doc:';
async function iosWrite(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'document';
  await Filesystem.writeFile({ path: safe, data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Documents });
  return safe;
}
/** Save As on iOS has no picker: never replace another document's file, use "Name (2).ext" instead. */
async function iosFreeName(name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'document';
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 1; i < 500; i++) {
    const candidate = i === 1 ? safe : `${base} (${i})${ext}`;
    try { await Filesystem.stat({ path: candidate, directory: Directory.Documents }); } catch { return candidate; }
  }
  return `${base} (${Date.now()})${ext}`;
}

export function b64FromBuffer(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}

export function bufferFromB64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

export async function openDocument(accept: string, mimeTypes: string[]): Promise<OpenedFile | null> {
  if (isNative()) {
    const r = await Native.openDocument({ mimeTypes });
    if (r.canceled || !r.data) return null;
    return { name: r.name || 'document', data: bufferFromB64(r.data), uri: r.uri || null, mime: r.mime };
  }
  const files = await pickFile(accept);
  if (!files.length) return null;
  return { name: files[0].name, data: await files[0].arrayBuffer(), uri: null, mime: files[0].type };
}

function toastSaved(name: string): void {
  import('../ui/dialog').then(({ toast }) => toast(`Saved "${name}" to Files ▸ On My iPhone ▸ Anne\'s Pen`)).catch(() => undefined);
}

export async function saveAs(blob: Blob, name: string): Promise<{ uri: string | null; name: string } | null> {
  if (isNative()) {
    const r = await Native.saveAs({ name, mime: blob.type || 'application/octet-stream', data: b64FromBuffer(await blob.arrayBuffer()) });
    if (r.canceled) return null;
    return { uri: r.uri || null, name: r.name || name };
  }
  if (isIOS()) {
    const n = await iosWrite(blob, await iosFreeName(name));
    toastSaved(n);
    return { uri: IOS_PREFIX + n, name: n };
  }
  const anyWin = window as any;
  if (anyWin.showSaveFilePicker) {
    try {
      const handle = await anyWin.showSaveFilePicker({ suggestedName: name });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { uri: 'fsa:' + (await handleId(handle)), name: handle.name };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
    }
  }
  download(blob, name);
  return { uri: null, name };
}

/** File System Access handles by id. Names alone are not unique: two folders can hold "Report.docx". */
const handles = new Map<string, any>();
let handleSeq = 0;
async function handleId(handle: any): Promise<string> {
  // The same file saved again keeps its id (and so its recent-files and version-history entries).
  for (const [id, h] of handles) {
    try { if (await h.isSameEntry?.(handle)) { handles.set(id, handle); return id; } } catch { /* stale handle */ }
  }
  // Unique per save, so two files with the same name in different folders never share a handle.
  const id = `${Date.now().toString(36)}${(++handleSeq).toString(36)}:${handle.name}`;
  handles.set(id, handle);
  return id;
}

export async function writeBack(uri: string, blob: Blob): Promise<boolean> {
  if (uri.startsWith('fsa:')) {
    const h = handles.get(uri.slice(4));
    if (!h) return false;
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  }
  if (uri.startsWith(IOS_PREFIX)) { await iosWrite(blob, uri.slice(IOS_PREFIX.length)); return true; }
  if (!isNative()) return false;
  const r = await Native.writeUri({ uri, data: b64FromBuffer(await blob.arrayBuffer()) });
  return !!r.ok;
}

export async function readUri(uri: string): Promise<OpenedFile | null> {
  if (uri.startsWith(IOS_PREFIX)) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const r = await Filesystem.readFile({ path: uri.slice(IOS_PREFIX.length), directory: Directory.Documents });
      return { name: uri.slice(IOS_PREFIX.length), data: bufferFromB64(typeof r.data === 'string' ? r.data : b64FromBuffer(await (r.data as Blob).arrayBuffer())), uri };
    } catch { return null; }
  }
  if (!isNative()) return null;
  try {
    const r = await Native.readUri({ uri });
    return { name: r.name || 'document', data: bufferFromB64(r.data), uri, mime: r.mime };
  } catch {
    return null;
  }
}

export async function printDocument(jobName: string): Promise<void> {
  if (isNative()) { await Native.print({ jobName }); return; }
  window.print();
}

export async function shareFile(blob: Blob, name: string, title?: string): Promise<void> {
  if (isNative()) {
    await Native.share({ name, mime: blob.type || 'application/octet-stream', data: b64FromBuffer(await blob.arrayBuffer()), title });
    return;
  }
  if (isIOS()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const w = await Filesystem.writeFile({ path: name.replace(/[\\/:*?"<>|]/g, '_') || 'document', data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Cache });
    await Share.share({ title: title || name, files: [w.uri] });
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as any;
  if (nav.canShare && nav.canShare({ files: [file] })) { await nav.share({ files: [file], title: title || name }); return; }
  download(blob, name);
}

export async function launchFile(): Promise<OpenedFile | null> {
  if (!isNative()) return null;
  try {
    const r = await Native.getLaunchFile();
    if (!r || !r.data) return null;
    return { name: r.name || 'document', data: bufferFromB64(r.data), uri: r.uri || null, mime: r.mime };
  } catch {
    return null;
  }
}

export function onFileOpened(cb: (f: OpenedFile) => void): void {
  if (!isNative()) return;
  Native.addListener('fileOpened', (r) => { if (r.data) cb({ name: r.name || 'document', data: bufferFromB64(r.data), uri: r.uri || null, mime: r.mime }); });
}

export async function keepAwake(on: boolean): Promise<void> {
  if (!isNative()) {
    try { if (on) (window as any).__wake = await (navigator as any).wakeLock?.request('screen'); else (window as any).__wake?.release(); } catch { /* */ }
    return;
  }
  try { await Native.keepAwake({ on }); } catch { /* */ }
}

/** Open a URL outside the app (system browser, mail or phone app). */
export function openExternal(url: string): void {
  // Only hand ordinary web/mail/phone addresses to the system; never navigate this WebView to script.
  if (!/^(https?|mailto|tel|ftp|sms|geo):/i.test(url.trim())) return;
  if (desktop) { void desktop.openExternal({ url }); return; }
  if (isCapacitor()) { window.location.href = url; return; }
  window.open(url, '_blank', 'noopener');
}

export async function onBackButton(cb: () => boolean): Promise<void> {
  if (!isCapacitor() || isIOS()) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => { if (!cb()) App.minimizeApp(); });
}

// Files are identified by content, so the picker offers every type it can (and "All files").
export const OPEN_ACCEPT = [...new Set([
  ...'docx docm dotx dotm doc dot wbk asd odt ott fodt rtf html htm md markdown txt epub qpd json'.split(' '),
  'qfd', 'qfde', // rename:keep — Anne's Pen was named QuillForge; its .qfd/.qfde files still open
  ...'wpd wp wp4 wp5 wp6 wpt wps wri lwp sam mcw cwk wn ws ws4 ws5 ws6 ws7 xy xyw rft dca hwp sdw'.split(' '),
  ...'csv tsv xlsx xlsm xls ods dbf wk1 wks pptx ppt odp key eml emlx mbox msg'.split(' '),
  ...OPEN_EXTENSIONS_B,
])].map((e) => '.' + e).join(',');
export const OPEN_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/msword', 'application/vnd.ms-word.document.macroEnabled.12',
  'application/rtf', 'text/rtf', 'text/html', 'text/markdown', 'text/plain', 'application/epub+zip', 'application/json',
  ...OPEN_MIMES_B.filter((m) => !['text/plain', 'text/html'].includes(m)),
  'application/octet-stream', '*/*',
];

// ------------------------------------------------------------------------------------------
// Sister apps: Anne's Grid (spreadsheets), Anne's Post (email), Anne's Stage (presentations)

export interface SisterApp { id: 'quillgrid' | 'quillpost' | 'quillstage'; name: string; package: string; web: string; what: string }
export const SISTER_APPS: Record<'spreadsheet' | 'email' | 'presentation', SisterApp> = {
  spreadsheet: { id: 'quillgrid', name: 'Anne\'s Grid', package: 'io.github.socrtwo.quillgrid', web: 'https://socrtwo.github.io/QuillGrid/', what: 'spreadsheet' },
  email: { id: 'quillpost', name: 'Anne\'s Post', package: 'io.github.socrtwo.quillpost', web: 'https://socrtwo.github.io/QuillPost/', what: 'email' },
  presentation: { id: 'quillstage', name: 'Anne\'s Stage', package: 'io.github.socrtwo.quillstage', web: 'https://socrtwo.github.io/QuillStage/', what: 'presentation' },
};

/** 'yes' when the sister app can be launched here, 'maybe' when only trying will tell (desktop), 'web' for a link. */
export async function sisterAppReach(app: SisterApp): Promise<'yes' | 'maybe' | 'no' | 'web'> {
  if (desktop) return 'maybe';
  if (isCapacitor() && !isIOS() && Native.canLaunchApp) {
    try { return (await Native.canLaunchApp({ package: app.package })).installed ? 'yes' : 'no'; } catch { return 'no'; }
  }
  return 'web';
}

/** Hand a file to a sister app. Resolves with a message for the user when it did not open there. */
export async function openInSisterApp(app: SisterApp, f: OpenedFile): Promise<{ ok: boolean; message?: string }> {
  if (desktop) {
    const r = await desktop.openWith({ app: app.id, uri: f.uri, name: f.name, data: f.uri ? undefined : b64FromBuffer(f.data) });
    if (r.ok) return { ok: true };
    return { ok: false, message: r.error || `${app.name} is not the program your system uses for this kind of file${r.handler ? ` (it uses ${r.handler.replace(/\.desktop$/, '')})` : ''}. Install ${app.name} and make it the default app for ${app.what} files, or import the file here.` };
  }
  if (isCapacitor() && !isIOS() && Native.launchApp) {
    const r = await Native.launchApp({ package: app.package, uri: f.uri, name: f.name, mime: f.mime || 'application/octet-stream', data: f.uri?.startsWith('content:') ? undefined : b64FromBuffer(f.data) });
    if (r.launched) return { ok: true };
    return { ok: false, message: r.installed ? `${app.name} opened, but it could not take this file; open it from ${app.name}.` : `${app.name} is not installed.` };
  }
  openExternal(app.web);
  return { ok: true, message: `${app.name} opened in your browser. Open the file there.` };
}

// ------------------------------------------------------------------------------------------
// Secure storage, clipboard, OAuth loopback, app resume (AI setup)

export async function secureSet(key: string, value: string): Promise<void> {
  await Native.secureSet({ key, value });
}
export async function secureGet(key: string): Promise<string | null> {
  return (await Native.secureGet({ key })).value ?? null;
}
export async function secureRemove(key: string): Promise<void> {
  await Native.secureRemove({ key });
}
/** Whether secureSet encrypts: false only on a desktop without a system keychain (the AI settings can warn). */
export async function secureStorageEncrypted(): Promise<boolean> {
  if (!desktop?.secureInfo) return true;
  try { return (await desktop.secureInfo()).encrypted; } catch { return true; }
}

/** Read clipboard text. Returns null when the platform refuses (no permission, no focus). */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (isNative()) return (await Native.readClipboard()).text ?? null;
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch { /* denied */ }
  return null;
}

export async function writeClipboardText(text: string, sensitive = false): Promise<boolean> {
  try {
    if (isNative()) { await Native.writeClipboard({ text, sensitive }); return true; }
    await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}

export async function startOAuthLoopback(timeoutMs: number, successHtml?: string, path?: string): Promise<number> {
  return (await Native.startLoopback({ timeoutMs, successHtml, path })).port;
}
export async function stopOAuthLoopback(): Promise<void> {
  try { await Native.stopLoopback(); } catch { /* not running */ }
}
export function onOAuthCallback(cb: (url: string) => void): Promise<{ remove: () => void }> {
  return Native.addListener('oauthCallback', (r) => cb(r.url));
}

/** Called when the app returns to the foreground (Android resume, browser tab visible again). */
export function onAppResume(cb: () => void): () => void {
  const vis = () => { if (document.visibilityState === 'visible') cb(); };
  document.addEventListener('visibilitychange', vis);
  let remove: (() => void) | null = null;
  if (isCapacitor()) {
    import('@capacitor/app').then(({ App }) => App.addListener('resume', cb)).then((h) => { remove = () => h.remove(); }).catch(() => undefined);
  }
  return () => { document.removeEventListener('visibilitychange', vis); remove?.(); };
}
