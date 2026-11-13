// Layout audit: opens every command that shows a window, menu, pane or Backstage page on emulated phones
// with system bars (Android 15+ edge-to-edge: Capacitor injects --safe-area-inset-* CSS variables), and
// checks that nothing sits under the status or navigation bar, off screen, under the on-screen keyboard,
// clipped sideways, overlapping, or makes the page scroll sideways.
//
//   npm run e2e:layout                    starts a Vite dev server on a free port and tests it
//   QF_URL=http://localhost:4173/ npm run e2e:layout     tests a running server (e.g. vite preview)
//   QF_LAYOUT_OUT=dir                     where screenshots of the first failures go (default test-results/layout)
//   QF_LAYOUT_SCENARIOS=phone,small      run only some scenarios
//
// Scenarios: phone portrait 412x915 (24 px status bar, 48 px navigation bar), small phone 320x640, landscape
// 915x412 (navigation bar on the right), and portrait with the on-screen keyboard open (the WebView shrinks to
// 412x560 and Capacitor reports a bottom inset of 0 while the keyboard is up).
import { launchChromium } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.QF_LAYOUT_OUT || path.join(root, 'test-results/layout');
fs.mkdirSync(OUT, { recursive: true });

const SCENARIOS = [
  { name: 'phone', viewport: { width: 412, height: 915 }, insets: { top: 24, right: 0, bottom: 48, left: 0 } },
  { name: 'small', viewport: { width: 320, height: 640 }, insets: { top: 24, right: 0, bottom: 48, left: 0 } },
  { name: 'landscape', viewport: { width: 915, height: 412 }, insets: { top: 24, right: 48, bottom: 0, left: 0 } },
  { name: 'keyboard', viewport: { width: 412, height: 560 }, insets: { top: 24, right: 0, bottom: 0, left: 0 }, keyboard: true },
].filter((s) => !process.env.QF_LAYOUT_SCENARIOS || process.env.QF_LAYOUT_SCENARIOS.split(',').includes(s.name));

// Commands that leave the page, need a real device or file, or would block the run.
const SKIP = new Set(['file.exit', 'file.closeAll', 'view.newWindow', 'view.fullScreen', 'review.dictate', 'review.readAloud', 'help.tour', 'help.feedback', 'file.print', 'file.quickPrint', 'file.exportPdf']);
const SKIP_RE = /^(edit\.(cut|copy|paste)|dev\.(runMacro|stop)|macro:)/;

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

let server = null;
let URL = process.env.QF_URL;
if (!URL) {
  const port = await freePort();
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  URL = `http://localhost:${port}/`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(URL)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
}
const browser = await launchChromium();

/** Runs in the page: measures every visible overlay surface and returns layout defects. */
function measure({ sc, frame }) {
  const vw = innerWidth, vh = innerHeight, I = sc.insets;
  const safe = { left: I.left, top: I.top, right: vw - I.right, bottom: vh - I.bottom };
  const out = [];
  const shown = (e) => e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const name = (e) => '.' + [...e.classList].filter((c) => c.startsWith('qf-')).slice(0, 2).join('.');
  const r = (e) => e.getBoundingClientRect();
  const outside = (b, area = safe) => b.left < area.left - 0.5 || b.top < area.top - 0.5 || b.right > area.right + 0.5 || b.bottom > area.bottom + 0.5;
  const fmt = (b) => `${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}`;
  const check = (e, what) => { if (!shown(e)) return; const b = r(e); if (b.width < 1 || b.height < 1) return; if (outside(b)) out.push(`system-bars: ${what || name(e)} at ${fmt(b)} (safe ${fmt(safe)})`); };
  let surfaces = 0;
  // Dialogs (top one only: lower ones are covered)
  const dialogs = [...document.querySelectorAll('.qf-dialog')].filter(shown);
  for (const d of dialogs) {
    surfaces++;
    for (const part of d.querySelectorAll(':scope > .qf-dialog-head, :scope > .qf-dialog-body, :scope > .qf-dialog-foot')) check(part, `dialog "${d.getAttribute('aria-label')}" ${name(part)}`);
    const body = d.querySelector(':scope > .qf-dialog-body');
    if (body && body.scrollWidth > body.clientWidth + 2) out.push(`side-scroll: dialog "${d.getAttribute('aria-label')}" body is ${body.scrollWidth}px wide in ${body.clientWidth}px`);
    const db = r(d);
    // Controls sticking out of the dialog sideways (clipped)
    for (const c of d.querySelectorAll('button, input, select, textarea, .qf-cmdlist')) {
      if (!shown(c)) continue;
      const b = r(c);
      if (b.width && (b.left < db.left - 1 || b.right > db.right + 1)) { out.push(`clipped: dialog "${d.getAttribute('aria-label')}" ${c.tagName.toLowerCase()}${name(c) === '.' ? '' : name(c)} "${(c.textContent || c.getAttribute('aria-label') || c.placeholder || '').trim().slice(0, 30)}" at ${fmt(b)} outside ${fmt(db)}`); break; }
    }
    // Stacked content drawn over each other (a column squeezed below its content height)
    for (const col of [d, ...d.querySelectorAll('*')].slice(0, 2000)) {
      const cs = getComputedStyle(col);
      if (!/flex|grid/.test(cs.display)) continue;
      // Content spilling out of a box that does not scroll (squeezed below its content height)
      if (cs.overflowY === 'visible' && col.clientHeight > 0 && col.scrollHeight > col.clientHeight + 4 && col !== d) { out.push(`overlap: dialog "${d.getAttribute('aria-label')}" content of ${name(col) === '.' ? col.tagName.toLowerCase() : name(col)} spills ${col.scrollHeight - col.clientHeight}px out of its box over what follows`); break; }
      if (cs.display.includes('flex') && !cs.flexDirection.startsWith('column')) continue;
      const kids = [...col.children].filter((k) => shown(k) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed').map((k) => [k, r(k)]);
      let hit = null;
      for (let i = 0; i < kids.length && !hit; i++) for (let j = i + 1; j < kids.length && !hit; j++) {
        const a = kids[i][1], b = kids[j][1];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) hit = `${name(kids[i][0]) === '.' ? kids[i][0].tagName.toLowerCase() : name(kids[i][0])} and ${name(kids[j][0]) === '.' ? kids[j][0].tagName.toLowerCase() : name(kids[j][0])}`;
      }
      if (hit) { out.push(`overlap: dialog "${d.getAttribute('aria-label')}" ${hit} are drawn over each other in ${name(col)}`); break; }
    }
    // Overlapping buttons (head, footer and the body's own buttons)
    for (const bar of [d]) {
      // Only the part of each button that is visible inside its scrolling container counts.
      const visible = (x) => { let b = r(x); for (let p = x.parentElement; p && p !== d.parentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) { const pr = r(p); b = { left: Math.max(b.left, pr.left), right: Math.min(b.right, pr.right), top: Math.max(b.top, pr.top), bottom: Math.min(b.bottom, pr.bottom) }; } } return b; };
      const bs = [...bar.querySelectorAll('button.qf-btn, button.qf-iconbtn, .qf-dialog-foot button, .qf-dialog-head button')].filter(shown).slice(0, 150).map((x) => [x, visible(x)]).filter(([, b]) => b.right - b.left > 1 && b.bottom - b.top > 1);
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i][1], b = bs[j][1];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) out.push(`overlap: dialog "${d.getAttribute('aria-label')}" buttons "${bs[i][0].textContent.trim()}" and "${bs[j][0].textContent.trim()}"`);
      }
      for (const [x] of bs) if (x.scrollWidth > x.clientWidth + 2 && getComputedStyle(x).overflow !== 'visible') out.push(`clipped: dialog "${d.getAttribute('aria-label')}" button "${x.textContent.trim()}" text cut off`);
    }
  }
  for (const m of document.querySelectorAll('.qf-menu')) { if (shown(m)) { surfaces++; check(m); } }
  // Sideways scrolling inside lists, panes and menus (cut-off content)
  for (const e of document.querySelectorAll('.qf-menu, .qf-pane-body, .qf-bs-body, .qf-bs-nav, .qf-palette-list, .qf-cmdlist')) {
    if (shown(e) && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== 'hidden') out.push(`side-scroll: ${name(e)} is ${e.scrollWidth}px wide in ${e.clientWidth}px`);
  }
  for (const p of document.querySelectorAll('.qf-palette')) { if (shown(p)) { surfaces++; check(p); } }
  const bs = document.querySelector('.qf-backstage');
  if (shown(bs)) { surfaces++; for (const part of bs.querySelectorAll('.qf-bs-nav, .qf-bs-body')) check(part, 'backstage ' + name(part)); }
  const pane = document.querySelector('.qf-pane');
  if (shown(pane)) { surfaces++; for (const part of pane.querySelectorAll('.qf-pane-head, .qf-pane-body')) check(part, 'pane ' + name(part)); }
  for (const t of document.querySelectorAll('.qf-toast, .qf-ai-busy, .qf-minibar.qf-show, .sc-chip:not(.sc-hidden)')) check(t);
  // The app frame itself
  if (frame) { const tb = document.querySelector('.qf-titlebar'); if (shown(tb) && tb.scrollWidth > tb.clientWidth + 1) out.push(`clipped: title bar content is ${tb.scrollWidth}px wide in ${tb.clientWidth}px`); }
  if (frame) for (const sel of ['.qf-titlebar', '.qf-tabs', '.qf-ribbon', '.qf-doctabs', '.qf-status', '.qf-qat-bottom', '.qf-zen-exit']) { const e = document.querySelector(sel); if (e && shown(e)) check(e, 'app ' + sel); }
  // Horizontal page scroll
  const se = document.scrollingElement;
  if (se.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1) out.push(`page-scroll: page is ${Math.max(se.scrollWidth, document.body.scrollWidth)}px wide in a ${vw}px window`);
  if (se.scrollLeft || window.scrollX) out.push(`page-scroll: page scrolled sideways by ${se.scrollLeft || window.scrollX}px`);
  // On-screen keyboard: the focused field must be visible above it (and inside its scroller)
  if (sc.keyboard) {
    const top = dialogs[dialogs.length - 1];
    const f = top?.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=color]):not([type=range]):not([type=file]):not([readonly]), textarea');
    if (f && shown(f)) {
      f.focus();
      f.scrollIntoView({ block: 'nearest' });
      const b = r(f);
      if (outside({ left: safe.left, right: safe.right, top: b.top, bottom: b.bottom }) || b.bottom > safe.bottom + 0.5 || b.top < safe.top - 0.5) out.push(`keyboard: focused field in "${top.getAttribute('aria-label')}" at ${fmt(b)} not visible above the keyboard`);
    }
  }
  return { surfaces, defects: [...new Set(out)] };
}

function cleanupScript() {
  const app = window.qf;
  try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); } catch { /* */ }
  document.querySelectorAll('.qf-overlay, .qf-menu, .qf-toast').forEach((e) => e.remove());
  try { app.ui.hideBackstage(); app.ui.closePane(); } catch { /* */ }
  document.body.classList.remove('qf-zen');
  document.querySelector('.qf-ai-busy')?.remove();
  window.scrollTo(0, 0); document.scrollingElement.scrollLeft = 0;
}

async function newPage(sc, query = '') {
  const ctx = await browser.newContext({ viewport: sc.viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((I) => {
    localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false }));
    window.print = () => {}; window.open = () => null;
    HTMLInputElement.prototype.showPicker = function () {};
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') return; return click.call(this); };
    try { navigator.clipboard.writeText = async () => {}; navigator.clipboard.readText = async () => ''; navigator.clipboard.read = async () => []; } catch { /* */ }
    try { speechSynthesis.speak = () => {}; } catch { /* */ }
    // Offline: commands that call the network fail fast instead of hanging.
    const realFetch = window.fetch.bind(window);
    window.fetch = (u, o) => { const s = String(u && u.url || u); return /^https?:/.test(s) && !s.startsWith(location.origin) ? Promise.reject(new Error('offline (layout test)')) : realFetch(u, o); };
    const setInsets = () => { const s = document.documentElement.style; for (const k of ['top', 'right', 'bottom', 'left']) s.setProperty(`--safe-area-inset-${k}`, I[k] + 'px'); };
    document.addEventListener('DOMContentLoaded', setInsets);
  }, sc.insets);
  await page.goto(URL + query);
  await page.waitForFunction(() => window.qf && window.qf.view, null, { timeout: 60000 });
  // Icons are a ligature font: until it loads they render as their (wide) names and skew every measurement.
  await page.evaluate(async () => { try { await document.fonts.ready; await document.fonts.load('24px "Material Symbols Outlined"', 'home'); } catch { /* measured anyway */ } }).catch(() => {});
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

const report = {};
let total = 0;
let menuIds = null;
for (const sc of SCENARIOS) {
  let { ctx, page } = await newPage(sc);
  const ids = menuIds || (await page.evaluate(() => window.__qfAllIds)).filter((id) => !SKIP.has(id) && !SKIP_RE.test(id));
  const defects = [];
  const showing = [];
  let shots = 0, n = 0;
  // The bare app frame first, then the File screen, the Quick Access Bar menu and every command.
  const steps = [['(app frame)', () => undefined], ['(file screen)', () => window.qf.ui.showBackstage()], ['(qat menu)', () => window.qf.ui.qatMenu(document.querySelector('.qf-qat-customize'))], ['(more menu)', () => window.qf.ui.moreMenu(document.querySelector('.qf-titlebar .qf-iconbtn[aria-label=More]'))], ['(command search)', () => window.qf.ui.commandPalette()],
    ['(two documents)', () => window.qf.exec('file.new')],
    ['(qat at bottom)', () => { const a = window.qf; a.prefs.qatPosition = 'bottom'; a.ui.applyPrefs(); }],
    ['(distraction-free)', () => { const a = window.qf; a.prefs.qatPosition = 'top'; a.ui.applyPrefs(); a.exec('view.distractionFree'); }]];
  for (const [label, fn] of steps) {
    await page.evaluate(fn);
    await page.waitForTimeout(250);
    const res = await page.evaluate(measure, { sc, frame: true });
    for (const d of res.defects) defects.push(`${label}: ${d}`);
    await page.evaluate(cleanupScript);
  }
  for (const id of ids) {
    if (++n % 80 === 0) { await ctx.close(); ({ ctx, page } = await newPage(sc)); }
    let res;
    try {
      await page.evaluate((id) => {
        const app = window.qf, c = window.__qfGetCommand(id);
        if (!c) return;
        if (c.menu && (c.kind === 'menu' || c.kind === 'split' || c.kind === 'gallery' || c.kind === 'font' || c.kind === 'size')) {
          const a = app.ui.anchorFor(id);
          app.ui.openCommandMenu(c, a && a.offsetParent ? a : document.querySelector('.qf-ribbon'));
        } else {
          const r = c.kind === 'color' ? app.exec(id, 'menu') : app.exec(id);
          if (r && r.catch) r.catch(() => {});
        }
      }, id);
      await page.waitForTimeout(150);
      res = await page.evaluate(measure, { sc, frame: false });
    } catch (e) {
      defects.push(`${id}: harness error ${String(e.message || e).split('\n')[0]}`);
      await ctx.close(); ({ ctx, page } = await newPage(sc));
      continue;
    }
    if (res.surfaces) showing.push(id);
    if (res.defects.length) {
      for (const d of res.defects) defects.push(`${id}: ${d}`);
      if (shots < 6) { shots++; await page.screenshot({ path: path.join(OUT, `${sc.name}-${shots}-${id.replace(/[^\w.-]/g, '_')}.png`) }).catch(() => {}); }
    }
    await page.evaluate(cleanupScript).catch(() => {});
  }
  await ctx.close();
  // Anne's Post's embedded editor (?embed=compose): its Done/Cancel bar and frame.
  {
    const emb = await newPage(sc, '?embed=compose&host=quillpost&v=1');
    const res = await emb.page.evaluate(measure, { sc, frame: true });
    const bar = await emb.page.evaluate((sc) => { const b = document.querySelector('.qf-embed-bar'); if (!b) return 'missing'; const r = b.getBoundingClientRect(); return r.top < sc.insets.top - 0.5 || r.left < sc.insets.left - 0.5 || r.right > innerWidth - sc.insets.right + 0.5 ? `at ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}` : ''; }, sc);
    for (const d of res.defects) defects.push(`(embedded editor): ${d}`);
    if (bar) defects.push(`(embedded editor): system-bars: Done/Cancel bar ${bar}`);
    await emb.ctx.close();
  }
  if (!menuIds) menuIds = showing; // later scenarios only re-open commands that show something
  const failing = new Set(defects.map((d) => d.split(': ')[0]));
  report[sc.name] = { checked: ids.length, showing: showing.length, failing: failing.size, defects };
  total += defects.length;
  console.log(`\n[${sc.name}] ${sc.viewport.width}x${sc.viewport.height} insets ${JSON.stringify(sc.insets)}${sc.keyboard ? ' keyboard open' : ''}: ${ids.length} commands opened, ${showing.length} showed a window/menu/pane; ${failing.size} with defects, ${defects.length} defect(s)`);
  const byKind = {};
  for (const d of defects) { const k = (d.split(': ')[1] || 'other'); byKind[k] = (byKind[k] || 0) + 1; }
  if (defects.length) console.log('  by kind: ' + Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', '));
  for (const d of defects.slice(0, Number(process.env.QF_LAYOUT_SHOW || 40))) console.log('  ' + d);
  if (defects.length > Number(process.env.QF_LAYOUT_SHOW || 40)) console.log(`  … and ${defects.length - Number(process.env.QF_LAYOUT_SHOW || 40)} more (full list in ${path.relative(root, path.join(OUT, 'report.json'))})`);
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
if (server) server.kill();
console.log(total ? `\nlayout: ${total} defect(s)` : '\nlayout: no defects');
process.exit(total ? 1 : 0);
