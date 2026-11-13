// Round-trips a template document through every export/import format inside Chromium.
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
const browser = await launchChromium();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false })));
await page.goto(process.env.QF_URL || 'http://localhost:4173/');
await page.waitForFunction(() => window.qf && window.__qfIO);
const res = await page.evaluate(async () => {
  const app = window.qf;
  app.exec('file.new', 'report');
  await new Promise((r) => setTimeout(r, 300));
  const io = await window.__qfIO();
  const out = [];
  const doc = app.state.doc;
  for (const f of io.FORMATS.filter((x) => x.canExport && x.export)) {
    try {
      const blob = await io.exportFile(doc, f.id, { fileName: 'test.' + f.ext[0], author: 'T', title: 'Report' });
      const buf = await blob.arrayBuffer();
      const back = await io.importFile(buf, 'test.' + f.ext[0]);
      back.doc.check();
      out.push(`${f.id}: ${buf.byteLength} bytes, ${back.doc.childCount} blocks, text ${back.doc.textContent.length}/${doc.textContent.length}`);
    } catch (e) { out.push(`${f.id}: ERROR ${e.message}`); }
  }
  return out;
});
console.log(res.join('\n'));
console.log('errors', errors);
await browser.close();
process.exit(errors.length || res.some((l) => l.includes(': ERROR ')) ? 1 : 0);
