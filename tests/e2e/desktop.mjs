// Desktop (Electron) test: launches the staged app (npm run build && node scripts/prepare-desktop.mjs)
// with a document on the command line and checks the bridge, file permissions, the spelling
// worker under app://, and the notices file. Linux CI: run under xvfb-run.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-desktop-'));
const doc = path.join(tmp, 'launch.docx');
fs.copyFileSync(path.join(root, 'tests/fixtures/recovery/sample.docx'), doc);
const secret = path.join(tmp, 'not-granted.txt');
fs.writeFileSync(secret, 'private');

// QF_ELECTRON_EXE tests a packaged build (e.g. release/linux-unpacked/quillpen) instead.
const exe = process.env.QF_ELECTRON_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: exe ? ['--no-sandbox', doc] : ['--no-sandbox', path.join(root, 'build/desktop-app'), doc],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
});
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' ' + detail}`); if (!ok) failures++; };
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => window.qf && window.qf.view, null, { timeout: 30000 });
  // The origin keeps the app's former name so data stored by earlier versions stays readable (electron/main.cjs).
  check('loads from app://', page.url().startsWith('app://quillforge/'), page.url()); // rename:keep
  check('bridge is exposed', await page.evaluate(() => typeof window.quillDesktop?.openDocument === 'function' && !('require' in window)));

  // The file given on the command line opens.
  await page.waitForFunction(() => window.qf.docs.some((d) => /launch/.test(d.title || d.fileName || '')) || window.qf.view.state.doc.textContent.length > 20, null, { timeout: 15000 }).catch(() => undefined);
  const text = await page.evaluate(() => window.qf.view.state.doc.textContent);
  check('opens the launch file', text.length > 20, JSON.stringify(text.slice(0, 80)));

  // Files not opened or saved through a dialog are off limits.
  const denied = await page.evaluate(async (u) => { try { await window.quillDesktop.readUri({ uri: u }); return 'read'; } catch (e) { return String(e.message); } }, 'file://' + secret);
  check('refuses ungranted files', /no permission/.test(denied), denied);
  const http = await page.evaluate(async () => { try { await window.quillDesktop.http({ url: 'http://example.com', method: 'GET', headers: {} }); return 'sent'; } catch (e) { return String(e.message); } });
  check('refuses plain-http requests', /Only https/.test(http), http);

  // Secure storage round trip.
  const v = await page.evaluate(async () => { await window.quillDesktop.secureSet({ key: 'ai.key.test', value: 'sk-test' }); const r = await window.quillDesktop.secureGet({ key: 'ai.key.test' }); await window.quillDesktop.secureRemove({ key: 'ai.key.test' }); return r.value; });
  check('secure storage', v === 'sk-test', String(v));
  const other = await page.evaluate(async () => { try { await window.quillDesktop.secureGet({ key: 'prefs' }); return 'read'; } catch (e) { return String(e.message); } });
  check('secure storage holds only AI keys', /Refused/.test(other), other);
  const info = await page.evaluate(() => window.quillDesktop.secureInfo());
  check('reports whether keys are encrypted', typeof info.encrypted === 'boolean', JSON.stringify(info));

  // Spelling worker and dictionaries load under app://.
  const spell = await page.evaluate(async () => {
    const app = window.qf;
    app.createTab();
    app.view.dispatch(app.state.tr.insertText('The colour and color. I will recieve it.'));
    // A pass started by the new tab may be running; run() then defers, so try again.
    let issues = [];
    for (let i = 0; i < 10 && !issues.length; i++) { await new Promise((r) => setTimeout(r, 500)); issues = await app.proofer.run(app.tab); }
    return issues.filter((i) => i.kind === 'spell').map((i) => app.state.doc.textBetween(i.from, i.to)).join(' ');
  });
  check('spelling worker', spell === 'recieve', spell);
  const notices = await page.evaluate(async () => (await fetch('./third-party-notices.txt')).text());
  check('notices file', notices.includes('prosemirror-model'));
  check('no page errors', !errors.length, errors.join('; '));
  // Unsaved documents make the app ask before closing; this test discards them.
  await page.evaluate(() => { for (const d of window.qf.docs) d.dirty = false; });
} catch (e) {
  failures++;
  console.log('✗ ' + (e.stack || e));
} finally {
  await app.close().catch(() => undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
