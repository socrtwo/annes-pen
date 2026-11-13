// Executes every registered command against a rich sample document and reports runtime errors.
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
const URL = process.env.QF_URL || 'http://localhost:4173/';
const browser = await launchChromium();
// Copy commands write to the clipboard, which headless Chromium refuses without the permission.
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message + ' @ ' + (e.stack || '').split('\n')[1]));
// Stay offline: commands that look words up online (thesaurus, dictionary) get a network error,
// which the app reports in the page; the browser's own "Failed to load resource" line for those is not a failure.
const origin = new globalThis.URL(URL).origin;
await ctx.route((u) => u.origin !== origin, (r) => r.abort('internetdisconnected'));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const at = m.location()?.url || '';
  if (/^Failed to load resource/.test(m.text()) && at && !at.startsWith(origin)) return;
  errors.push('console: ' + m.text() + (at ? ' @ ' + at : ''));
});
await page.addInitScript(() => { localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false })); window.print = () => {}; window.open = () => null; HTMLInputElement.prototype.click = function () { if (this.type === 'file') { this.dispatchEvent(new Event('cancel')); return; } }; });
await page.goto(URL);
await page.waitForFunction(() => window.qf && window.qf.view);
const SKIP = new Set(['file.exit', 'review.readAloud', 'review.dictate', 'view.fullScreen', 'view.teleprompter', 'file.closeAll', 'help.tour']);
const result = await page.evaluate(async (skip) => {
  const app = window.qf;
  const reg = app.__registryIds || null;
  const sample = () => {
    const S = window.qf.view.state.schema;
    const p = (t, a) => S.nodes.paragraph.create(a || null, t ? S.text(t) : null);
    const doc = S.node('doc', { settings: app.state.doc.attrs.settings }, [
      p('Heading One', { style: 'Heading 1' }), p('The quick brown fox jumps over the lazy dog. teh second sentence here.'),
      S.nodes.bullet_list.create(null, [S.nodes.list_item.create(null, p('item a')), S.nodes.list_item.create(null, p('item b'))]),
      S.nodes.table.create(null, [S.nodes.table_row.create(null, [S.nodes.table_cell.create(null, p('1')), S.nodes.table_cell.create(null, p('2'))]), S.nodes.table_row.create(null, [S.nodes.table_cell.create(null, p('3')), S.nodes.table_cell.create(null, p('4'))])]),
      p('Heading Two', { style: 'Heading 2' }), p('Final paragraph with text.'),
    ]);
    app.replaceDoc(app.tab, doc);
    app.selectPos(20);
  };
  const ids = window.__qfAllIds;
  const failures = [];
  const closeAll = () => { document.querySelectorAll('.qf-overlay').forEach((o) => o.remove()); document.querySelectorAll('.qf-menu').forEach((o) => o.remove()); app.ui.hideBackstage(); };
  let n = 0;
  for (const id of ids) {
    if (skip.includes(id)) continue;
    sample();
    window.__lastId = id;
    const origErr = console.error; console.error = (...a) => { failures.push(id + ': ' + a.map((x) => (x && x.stack) || String(x)).join(' ').split('\n').slice(0,3).join(' | ')); };
    try {
      const r = app.exec(id);
      if (r && typeof r.then === 'function') await Promise.race([r.catch((e) => failures.push(id + ': ' + e.message)), new Promise((res) => setTimeout(res, 150))]);
    } catch (e) { failures.push(id + ': ' + e.message); }
    await new Promise((res) => setTimeout(res, 5));
    console.error = origErr;
    closeAll();
    n++;
    // Run every menu entry (argument variants) of this command.
    let entries = [];
    try { const c = window.__qfGetCommand(id); entries = c && c.menu ? c.menu(app) : []; } catch (e) { failures.push(id + ' menu(): ' + e.message); }
    const flat = []; const walk = (l) => { for (const e of l) { if (e.submenu) walk(e.submenu); else if (e.id && !String(e.id).startsWith('__') && e.arg !== undefined && !skip.includes(e.id)) flat.push(e); } }; walk(entries);
    for (const e of flat.slice(0, 40)) {
      sample();
      console.error = (...a) => { failures.push(`${e.id}(${JSON.stringify(e.arg)}): ` + a.map((x) => (x && x.stack) || String(x)).join(' ').split('\n').slice(0,3).join(' | ')); };
      try { const r = app.exec(e.id, e.arg); if (r && typeof r.then === 'function') await Promise.race([r.catch((er) => failures.push(e.id + ': ' + er.message)), new Promise((res) => setTimeout(res, 150))]); } catch (er) { failures.push(`${e.id}(${JSON.stringify(e.arg)}): ${er.message}`); }
      console.error = origErr;
      closeAll();
      n++;
    }
  }
  return { n, failures };
}, [...SKIP]);
console.log(`ran ${result.n} commands`);
console.log('exec failures:', result.failures.length); for (const f of result.failures) console.log('  ', f);
console.log('page errors:', errors.length); for (const e of [...new Set(errors)].slice(0, 60)) console.log('  ', e);
await browser.close();
process.exit(result.failures.length || errors.length ? 1 : 0);
