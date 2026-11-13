// Spelling Dictionaries wizard, end to end: downloads the real French dictionary (network needed),
// uses it for the document, checks French spelling with Hunspell, then removes it.
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
const URL = process.env.QF_URL || 'http://localhost:4173/';
const browser = await launchChromium();
// QF_IGNORE_HTTPS_ERRORS=1 for sandboxes whose HTTPS proxy Chromium does not trust.
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: !!process.env.QF_IGNORE_HTTPS_ERRORS });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false })));
await page.goto(URL);
await page.waitForFunction(() => window.qf && window.qf.view);
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' ' + detail}`); if (!ok) failures++; };
try {
  await page.evaluate(() => { window.qf.exec('review.dictionaries'); });
  await page.waitForSelector('.qf-dict-wizard');
  const sections = await page.$$eval('.qf-dict-head', (els) => els.map((e) => e.textContent));
  check('wizard lists languages', sections.includes('All languages'), sections.join(','));
  await page.fill('.qf-dict-wizard input[type=search]', 'French');
  const row = page.locator('.qf-dict-row', { hasText: 'French' }).first();
  await row.getByRole('button', { name: 'Download' }).click();
  await row.getByText('Installed').waitFor({ timeout: 120000 });
  check('downloads and verifies the French dictionary', true);
  await row.getByRole('button', { name: 'Use for this document' }).click();
  check('sets the document language', (await page.evaluate(() => window.qf.settings.language)) === 'fr');
  await page.keyboard.press('Escape');
  const res = await page.evaluate(async () => {
    const app = window.qf;
    app.view.dispatch(app.state.tr.insertText("Je vais à la maisonn aujourd'hui avec l'homme."));
    let issues = [];
    for (let i = 0; i < 20 && !issues.some((x) => x.kind === 'spell'); i++) { await new Promise((r) => setTimeout(r, 500)); issues = await app.proofer.run(app.tab); }
    return issues.map((i) => `${i.kind}:${app.state.doc.textBetween(i.from, i.to)}`).join(' ');
  });
  check('checks French with Hunspell (elisions, accents)', res === 'spell:maisonn', res);
  const sugg = await page.evaluate(async () => (await (await import('./src/proof/proofing.ts').catch(() => null))?.suggest?.('maisonn', 'dict:fr')) ?? 'n/a');
  if (sugg !== 'n/a') check('suggests', Array.isArray(sugg) && sugg.includes('maison'), String(sugg));
  // Remove it again.
  await page.evaluate(() => { window.qf.exec('review.dictionaries'); });
  await page.fill('.qf-dict-wizard input[type=search]', 'French');
  const row2 = page.locator('.qf-dict-row', { hasText: 'French' }).first();
  await row2.getByRole('button', { name: 'Remove' }).click();
  await page.locator('.qf-dialog').last().getByRole('button', { name: 'Remove' }).click();
  await row2.getByRole('button', { name: 'Download' }).waitFor({ timeout: 10000 });
  check('removes it', true);
  check('no page errors', !errors.length, errors.join('; '));
} catch (e) {
  failures++;
  console.log('✗ ' + (e.stack || e));
  await page.screenshot({ path: 'test-results/dictionaries-fail.png' }).catch(() => undefined);
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
