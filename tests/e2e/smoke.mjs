// Smoke test: loads the built app in Chromium (phone + desktop), exercises core commands, screenshots.
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
const URL = process.env.QF_URL || 'http://localhost:4173/';
const OUT = process.env.QF_OUT || 'test-results';
fs.mkdirSync(OUT, { recursive: true });
const browser = await launchChromium();
let failures = 0;
async function run(name, viewport, fn) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(() => localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false })));
  await page.goto(URL);
  await page.waitForFunction(() => window.qf && window.qf.view);
  try { await fn(page); } catch (e) { errors.push('test: ' + (e.stack || e)); }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  if (errors.length) { failures++; console.log(`✗ ${name}\n  ` + errors.join('\n  ')); } else console.log(`✓ ${name}`);
  await ctx.close();
}
await run('desktop-home', { width: 1280, height: 800 }, async (page) => {
  await page.click('.qf-editor');
  await page.keyboard.type('Hello world. this is a test of teh editor.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# Heading via markdown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- bullet one');
  await page.waitForTimeout(800);
  const text = await page.evaluate(() => window.qf.view.state.doc.textContent);
  if (!text.includes('the editor')) throw new Error('autocorrect failed: ' + text);
  const style = await page.evaluate(() => window.qf.view.state.doc.child(1).attrs.style);
  if (style !== 'Heading 1') throw new Error('markdown heading failed: ' + style);
});
await run('desktop-spelling-varieties', { width: 1280, height: 800 }, async (page) => {
  const res = await page.evaluate(async () => {
    const app = window.qf;
    app.view.dispatch(app.state.tr.insertText('The colour and color of the organisation and organization. I will recieve it. A honest man waited a hour.'));
    const flagged = async (d) => {
      await app.exec('review.spellDialect', d);
      const issues = await app.proofer.run(app.tab);
      return issues.map((i) => i.kind + ':' + app.state.doc.textBetween(i.from, i.to)).join(' ');
    };
    return { any: await flagged('any'), us: await flagged('en-US'), gb: await flagged('en-GB') };
  });
  const want = {
    any: 'spell:recieve grammar:A honest grammar:a hour',
    us: 'spell:colour spell:organisation spell:recieve grammar:A honest grammar:a hour',
    gb: 'spell:color spell:recieve grammar:A honest grammar:a hour',
  };
  for (const k of Object.keys(want)) if (res[k] !== want[k]) throw new Error(`${k}: got "${res[k]}", want "${want[k]}"`);
  await page.evaluate(() => { window.qf.exec('help.notices'); });
  await page.waitForSelector('.qf-notices');
  const notices = await page.textContent('.qf-notices');
  for (const pkg of ['dictionary-en-gb', 'prosemirror-model', 'jszip', 'SIL OPEN FONT LICENSE']) if (!notices.includes(pkg)) throw new Error('notices missing ' + pkg);
});
await run('desktop-commands', { width: 1280, height: 800 }, async (page) => {
  const res = await page.evaluate(async () => {
    const app = window.qf;
    app.view.dispatch(app.state.tr.insertText('Sample text for formatting. '.repeat(40)));
    const out = [];
    for (const id of ['fmt.bold', 'fmt.italic', 'para.align.center', 'list.bullets', 'list.numbering', 'insert.pageBreak', 'insert.hr', 'review.trackChanges', 'view.print', 'view.mobile', 'view.web', 'view.outline', 'view.print', 'refs.updateToc', 'edit.selectAll', 'fmt.clear', 'view.formattingMarks', 'view.formattingMarks']) {
      try { app.exec(id); } catch (e) { out.push(id + ': ' + e.message); }
    }
    return { out, count: document.querySelectorAll('[data-cmd]').length };
  });
  if (res.out.length) throw new Error(res.out.join('; '));
  await page.waitForTimeout(800);
});
await run('desktop-print-layout', { width: 1280, height: 900 }, async (page) => {
  await page.evaluate(() => {
    const app = window.qf;
    const { state } = app.view;
    let tr = state.tr;
    for (let i = 0; i < 60; i++) tr = tr.insertText(`Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. `.repeat(2), tr.doc.content.size - 1).split(tr.doc.content.size - 1);
    app.view.dispatch(tr);
    app.updateSettings((s) => { s.footer = { left: '', center: 'Page {PAGE} of {NUMPAGES}', right: '' }; s.header = { left: '{TITLE}', center: '', right: '' }; });
    app.setViewMode('print');
  });
  await page.waitForTimeout(1500);
  const pages = await page.evaluate(() => document.querySelectorAll('.qf-pgap:not(.qf-pgap-first):not(.qf-pgap-last)').length + 1);
  if (pages < 3) throw new Error('pagination produced ' + pages + ' pages');
  console.log('   pages:', pages);
});
await run('phone-home', { width: 393, height: 851 }, async (page) => {
  await page.tap('.qf-editor');
  await page.keyboard.type('Typing on a phone.');
  await page.click('.qf-tab[data-tab=insert]');
  await page.waitForTimeout(300);
});
await run('phone-qat-customize', { width: 393, height: 851 }, async (page) => {
  await page.evaluate(() => window.qf.exec('file.customizeQat'));
  await page.waitForTimeout(400);
  await page.selectOption('.qf-customize select', 'all');
  await page.waitForTimeout(200);
});
await run('phone-backstage', { width: 393, height: 851 }, async (page) => {
  await page.evaluate(() => window.qf.ui.showBackstage('new'));
  await page.waitForTimeout(300);
});
await browser.close();
process.exit(failures ? 1 : 0);
