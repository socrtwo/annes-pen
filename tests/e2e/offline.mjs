// Offline (PWA) test against a production build: the service worker precaches every built file on
// the first visit, then the app, a math font and the spelling dictionary load with the network off.
// Also fails on any Content Security Policy violation.
import { launchChromium } from './browser.mjs';
const URL = process.env.QF_URL || 'http://localhost:4173/';
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false }));
  document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
});
page.on('console', (m) => { if (m.type() === 'error' && /CSP violation|Content Security Policy/.test(m.text())) errors.push(m.text()); });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' ' + detail : ''}`); if (!ok) failures++; };

await page.goto(URL);
await page.waitForFunction(() => window.qf && window.qf.view);
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  const names = await caches.keys();
  const name = names.find((n) => n.startsWith('annes-pen-'));
  const keys = name ? (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname) : [];
  return { active: !!reg.active, names, keys };
});
check('service worker active', sw.active);
check('one versioned cache', sw.names.filter((n) => n.startsWith('annes-pen-')).length === 1 && !/annes-pen-dev$/.test(sw.names[0] || ''), sw.names.join(', '));
check('index precached', sw.keys.some((k) => k.endsWith('/index.html')));
check('KaTeX woff2 precached (no ttf/woff)', sw.keys.some((k) => /KaTeX_Main-Regular-.*\.woff2$/.test(k)) && !sw.keys.some((k) => /KaTeX.*\.(ttf|woff)$/.test(k)));
check('dictionary precached', sw.keys.some((k) => /dictionary-en-[^/]*\.js$/.test(k)));
check('fonts precached', sw.keys.some((k) => /material-symbols.*\.woff2$/.test(k)));

await ctx.setOffline(true);
await page.reload();
await page.waitForFunction(() => window.qf && window.qf.view, null, { timeout: 20000 });
check('app loads offline', true);
const math = await page.evaluate(async () => {
  await document.fonts.load('20px KaTeX_Main');
  return document.fonts.check('20px KaTeX_Main');
});
check('math font loads offline', math);
const spell = await page.evaluate(async () => {
  const app = window.qf;
  app.view.dispatch(app.state.tr.insertText('I will recieve it.'));
  await app.exec('review.spellDialect', 'en-GB');
  const issues = await app.proofer.run(app.tab);
  return issues.map((i) => i.kind + ':' + app.state.doc.textBetween(i.from, i.to)).join(' ');
});
check('spelling (en-GB dictionary) works offline', spell.includes('spell:recieve'), spell);
await ctx.setOffline(false);
check('no page errors or CSP violations', !errors.length, errors.slice(0, 5).join(' | '));
await browser.close();
process.exit(failures ? 1 : 0);
