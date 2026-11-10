// Print lifetime test: on a phone browser print() returns at once and the print UI keeps laying the
// live page out for its preview, so the print layout must stay until the user is back in the app.
// Usage: npm run build && npm run e2e:print   (set QF_URL to test an already-running server instead)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4184;
let server = null;
let url = process.env.QF_URL;
if (!url) {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
const failures = [];
const check = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => failures.push('pageerror: ' + e.message));
  await p.addInitScript(() => {
    localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false }));
    window.print = () => { window.__printed = (window.__printed || 0) + 1; setTimeout(() => window.dispatchEvent(new Event('afterprint')), 50); };
  });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.qf && qf.tab);
  await p.waitForTimeout(800);
  // Start in Web Layout: printing switches to Print Layout and must stay there until the print UI closes.
  await p.evaluate(() => qf.setViewMode('web'));
  await p.waitForTimeout(200);
  await p.evaluate(() => { Promise.resolve(qf.exec('file.print')).catch((e) => { window.__printErr = String(e); }); });
  await p.waitForFunction(() => window.__printed === 1, null, { timeout: 10000 });
  await p.waitForTimeout(3000);
  check('print layout kept while the print UI is open', await p.evaluate(() => qf.tab.viewMode), 'print');
  await p.touchscreen.tap(200, 880);
  await p.waitForTimeout(1200);
  check('view restored afterwards', await p.evaluate(() => qf.tab.viewMode), 'web');
  check('print error', await p.evaluate(() => window.__printErr || null), null);
} finally {
  await browser.close();
  if (server) { try { process.kill(-server.pid); } catch { /* */ } }
}
if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exit(1); }
console.log('print e2e: ok');
