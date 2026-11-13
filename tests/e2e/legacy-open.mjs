// Opens legacy and cross-category files through the real File ▸ Open path (file chooser) in Chromium,
// checks the imported text and the notes shown, and saves a screenshot of each.
//   npm run build && npx vite preview --port 4301 --strictPort &
//   QF_URL=http://localhost:4301/ node tests/e2e/legacy-open.mjs [files-dir] [screenshot-dir]
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = path.resolve(process.argv[2] || 'build/legacy-e2e');
const shots = path.resolve(process.argv[3] || 'build/legacy-e2e-shots');
if (!fs.existsSync(path.join(files, 'memo'))) execFileSync('npx', ['vite-node', 'tests/e2e/make-legacy-files.ts', files], { stdio: 'inherit' });
fs.mkdirSync(shots, { recursive: true });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false })));
await page.goto(process.env.QF_URL || 'http://localhost:4301/');
await page.waitForFunction(() => window.qf && window.__qfIO);

const cases = [
  { file: 'letter.doc', expect: ['WordPerfect Letter', 'bold', 'café'], note: /WordPerfect 5\.x document; the file name says \.doc/ },
  { file: 'memo', expect: ['Word 6.0 Memo', 'Arial 14 point'], note: /no extension/ },
  { file: 'notes.wri', expect: ['Windows Write Notes'] },
  { file: 'report.wps', expect: ['Microsoft Works Report'] },
  { file: 'hangul.hwp', expect: ['한글 문서 제목'] },
  { file: 'word97.doc', expect: ['Legacy Fixture Title', 'Cell B2'] },
  { file: 'budget.xlsx', expect: ['Budget', '2024-03-15'], choose: 'Import into a document' },
  { file: 'mail.eml', expect: ['Project update', 'new release'], choose: 'Import into a document' },
];

const results = [];
for (const c of cases) {
  const toasts = [];
  // A key press is a user gesture, which the browser requires before it shows a file chooser.
  const chooser = page.waitForEvent('filechooser', { timeout: 15000 });
  await page.locator('.ProseMirror:visible').first().click();
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles(path.join(files, c.file));
  if (c.choose) {
    const btn = page.locator('.qf-dialog .qf-btn', { hasText: c.choose });
    await btn.waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(shots, `${c.file}-choice.png`) });
    await btn.click();
  }
  // Wait for the document to show the expected text.
  let text = '';
  for (let i = 0; i < 60; i++) {
    text = await page.evaluate(() => window.qf.state.doc.textContent);
    toasts.push(...(await page.locator('.qf-toast').allInnerTexts()));
    if (c.expect.every((t) => text.includes(t))) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${c.file}.png`) });
  const missing = c.expect.filter((t) => !text.includes(t));
  const noteOk = !c.note || toasts.some((t) => c.note.test(t));
  results.push({ file: c.file, ok: !missing.length && noteOk, missing, toast: [...new Set(toasts)].join(' | ').slice(0, 160) });
}
await browser.close();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.missing.length ? ' missing: ' + r.missing.join(', ') : ''}  [${r.toast}]`);
if (errors.length) console.log('Page errors:\n' + errors.join('\n'));
console.log(`Screenshots: ${shots}`);
process.exit(results.every((r) => r.ok) && !errors.length ? 0 : 1);
