/** Anne's Pen entry point. */
import './util/legacy'; // first: carries data over from the app's former name
import 'material-symbols/outlined.css';
import 'katex/dist/katex.min.css';
import './styles/app.css';
import './styles/scrollcue.css';
import { DOMSerializer } from 'prosemirror-model';
import { installFonts } from './fonts';
import './commands';
import { App } from './app';
import { Shell } from './ui/shell';
import { schema } from './editor/schema';
import { wordAt } from './editor/ops';
import { launchFile, onFileOpened, onBackButton, isNative, isDesktop, isCapacitor } from './platform/native';
import { closeMenus, inDialog, toast } from './ui/dialog';
import { installScrollCues } from './ui/scrollcue';
import { embedModeFrom } from './embed/embed';
import { orphanedDrafts, startSession, endSession } from './util/store';
import { PREFS_KEY, mergePrefs } from './prefs';
import { allCommands, getCommand } from './commands/registry';

installFonts();
// "More below" cues on every scrollable list of choices: menus, dialogs, list boxes, panes, the File screen,
// command search and the customize lists. Not on the document itself or the sideways ribbon strips.
installScrollCues({
  selector: ['.qf-menu', '.qf-dialog-body', '.qf-dialog-preview', 'select.qf-listbox', 'select[size]', '.qf-cmdlist', '.qf-pane-body', '.qf-ai-log', '.qf-ai-out',
    '.qf-bs-nav', '.qf-bs-body', '.qf-palette-list', '.qf-symbol-grid', '.qf-dict-list', '.qf-notices', '.qf-ai-ens-text'].join(', '),
  ignore: '.qf-scroll',
});
(window as any).__qfSerializer = DOMSerializer.fromSchema(schema);
(window as any).__qfWordAt = wordAt;

const host = document.getElementById('app')!;
const app = new App(host);
// ?embed=compose: Anne's Post's embedded message editor (docs/EMBED.md).
app.embedded = embedModeFrom(location.search) === 'compose';
app.ui = new Shell(app);
app.rebuildKeyIndex();
app.createTab();
(window as any).qf = app;
(window as any).__qfAllIds = allCommands().map((c) => c.id);
(window as any).__qfGetCommand = getCommand;
(window as any).__qfIO = () => import('./io');
(window as any).__qfAi = async () => ({ ...(await import('./ai/client')), ...(await import('./ai/store')), ...(await import('./ai/providers')) });

async function start() {
  if (app.embedded) {
    // No launch files, draft recovery, sign-in callbacks or tour: the embedding app owns this document.
    const { startEmbed } = await import('./embed/mode');
    startEmbed(app);
    return;
  }
  // Browser build: this tab may be the OpenRouter sign-in callback opened by the AI setup wizard.
  if (!isNative() && /[?&]qf-oauth=/.test(location.search)) {
    try {
      const { handleOAuthRedirect } = await import('./ai/oauth');
      const { setApiKey, saveAiSettings } = await import('./ai/store');
      const ok = await handleOAuthRedirect(async (key) => {
        await setApiKey('openrouter', key);
        saveAiSettings((s) => {
          s.providers.openrouter = s.providers.openrouter || { id: 'openrouter', model: 'openrouter/free', fastModel: 'openrouter/free' };
          if (!s.active) s.active = 'openrouter';
        });
      });
      if (ok) toast('Signed in to OpenRouter and saved the key. You can close this tab and return to Anne\'s Pen.', { ms: 15000 });
    } catch (e: any) {
      toast(`OpenRouter sign-in did not complete: ${e?.message || e}`, { ms: 10000 });
    }
  }
  startSession();
  const { openBuffer } = await import('./commands/file');
  // Installed web app: files opened with it from the system (manifest file_handlers).
  const lq = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: readonly { getFile(): Promise<File> }[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (p) => {
    for (const h of p.files || []) {
      try { const f = await h.getFile(); await openBuffer(app, await f.arrayBuffer(), f.name, null); } catch (e: any) { toast(`Could not open the file: ${e?.message || e}`); }
    }
  });
  const lf = await launchFile();
  if (lf) await openBuffer(app, lf.data, lf.name, lf.uri);
  onFileOpened((f) => openBuffer(app, f.data, f.name, f.uri));
  // Drafts of documents still open in another window are not offered.
  const drafts = await orphanedDrafts((k) => app.docs.some((d) => 'draft:' + d.id === k));
  if (drafts.length) toast(`${drafts.length} unsaved document(s) can be recovered.`, { action: 'Recover', onAction: () => app.exec('file.recover'), ms: 8000 });
  if (app.prefs.firstRun && !lf) setTimeout(() => app.ui.tour(), 600);
}
start();

// Web build served over http(s): register the service worker so the app works offline and can be
// installed (ChromeOS, desktop Chrome/Edge, Android Chrome). Not used inside the Android, iOS or desktop apps.
if (!isNative() && !isCapacitor() && !app.embedded && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !import.meta.env.DEV) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}

onBackButton(() => {
  if (document.querySelector('.qf-menu')) { closeMenus(); return true; }
  if (inDialog()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; }
  if (host.classList.contains('qf-backstage-open')) { app.ui.hideBackstage(); return true; }
  if (app.ui.pane) { app.ui.closePane(); return true; }
  if (document.body.classList.contains('qf-zen')) { document.body.classList.remove('qf-zen'); return true; }
  if (app.tab.viewMode === 'read') { app.setViewMode('print'); return true; }
  app.saveDrafts();
  return false;
});

// Preferences saved in another window: merged, so this window's next save keeps what that one added.
window.addEventListener('storage', (e) => {
  if (e.key !== PREFS_KEY || !e.newValue || app.embedded) return;
  try {
    Object.assign(app.prefs, mergePrefs(app.prefs, JSON.parse(e.newValue)));
    app.rebuildKeyIndex();
    app.ui.applyPrefs();
    app.ui.rebuild();
  } catch { /* a damaged value: keep this window's */ }
});
window.addEventListener('pagehide', () => endSession());

window.addEventListener('beforeunload', (e) => {
  app.saveDrafts();
  // In the desktop app this makes the main process ask before closing (will-prevent-unload).
  if ((!isNative() || isDesktop()) && !app.embedded && app.docs.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') app.saveDrafts(); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.ui.applyPrefs());
