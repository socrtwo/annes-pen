// Visual checks of layout features; writes screenshots to test-results/.
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
const URL = process.env.QF_URL || 'http://localhost:4173/';
const browser = await launchChromium();
fs.mkdirSync('test-results', { recursive: true });
const errors = [];
async function open(viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false, spellcheck: false, grammar: false })));
  await page.goto(URL);
  await page.waitForFunction(() => window.qf && window.qf.view);
  return page;
}
const page = await open({ width: 1100, height: 1300 });
await page.evaluate(() => {
  const app = window.qf; const S = app.view.state.schema;
  const p = (t, a) => S.nodes.paragraph.create(a || null, t ? S.text(t) : null);
  const long = 'This long paragraph is intended to straddle a page boundary so that pagination has to split it in the middle, honoring widow and orphan control. '.repeat(14);
  const blocks = [p('Layout Test', { style: 'Title' }), p('Section heading', { style: 'Heading 1' })];
  for (let i = 0; i < 6; i++) blocks.push(p(`Body paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus lacinia odio vitae vestibulum vestibulum.`));
  blocks.push(S.nodes.paragraph.create(null, [S.text('A sentence with a footnote'), S.nodes.footnote.create({ text: 'This footnote should appear at the bottom of its page.' }), S.text(' and continues with a second one'), S.nodes.footnote.create({ text: 'Second note.' }), S.text('.')]));
  blocks.push(p(long));
  blocks.push(S.nodes.column_section.create({ count: 2, gap: 24, rule: true }, [p('Column text. '.repeat(60))]));
  blocks.push(S.nodes.paragraph.create(null, [S.text('Tracked: '), S.text('inserted words', [S.marks.insertion.create({ author: 'A', id: 'x' })]), S.text(' '), S.text('deleted words', [S.marks.deletion.create({ author: 'A', id: 'y' })]), S.text(' and an equation '), S.nodes.math_inline.create({ latex: 'E=mc^2' })]));
  app.replaceDoc(app.tab, S.node('doc', { settings: app.state.doc.attrs.settings }, blocks));
  app.updateSettings((s) => { s.header = { left: '{TITLE}', center: '', right: '{DATE:MMMM d, yyyy}' }; s.footer = { left: '', center: 'Page {PAGE} of {NUMPAGES}', right: '' }; s.watermark = { text: 'DRAFT', color: '#c0c0c0', opacity: .3, diagonal: true }; s.lineNumbers.enabled = true; s.properties.title = 'Layout Test'; });
  app.setViewMode('print'); app.setZoom(0.75);
});
await page.waitForTimeout(2500);
const info = await page.evaluate(() => ({ pages: document.querySelectorAll('.qf-pgap').length, inline: document.querySelectorAll('.qf-pgap-inline').length, fn: [...document.querySelectorAll('.qf-pg-footnotes')].map((e) => e.textContent) }));
console.log(JSON.stringify(info));
await page.screenshot({ path: 'test-results/visual-print.png', fullPage: false });
await page.evaluate(() => { const el = window.qf.tab.el; el.scrollTop = 700; });
await page.waitForTimeout(400);
await page.screenshot({ path: 'test-results/visual-print-2.png' });
const phone = await open({ width: 393, height: 851 });
await phone.evaluate(() => { const app = window.qf; app.exec('file.new', 'report'); });
await phone.waitForTimeout(800);
await phone.screenshot({ path: 'test-results/visual-phone-report.png' });
await phone.evaluate(() => window.qf.exec('view.navPane'));
await phone.waitForTimeout(400);
await phone.screenshot({ path: 'test-results/visual-phone-nav.png' });
console.log('errors:', errors);
await browser.close();
process.exit(errors.length ? 1 : 0);
