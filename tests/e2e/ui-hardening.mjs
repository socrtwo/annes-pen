// UI hardening: regression checks for UI and command defects found in review (format painter, spelling and
// notes panes, comments on phones, menus and shortcut capture from the keyboard, AltGr, distraction-free exit,
// macros, links, saving while typing, same-named files and version history, Combine Revisions, damaged settings).
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const URL = process.env.QF_URL || 'http://localhost:4173/';
const OUT = process.env.QF_OUT || 'test-results';
fs.mkdirSync(OUT, { recursive: true });
const browser = await launchChromium();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-ui-'));
const file = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
let failures = 0;
async function run(name, viewport, fn, init) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.addInitScript(() => { if (!sessionStorage.getItem('qf-init')) { sessionStorage.setItem('qf-init', '1'); localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false })); } });
  if (init) await page.addInitScript(init);
  await page.goto(URL);
  await page.waitForFunction(() => window.qf && window.qf.view);
  try { await fn(page); } catch (e) { errors.push('test: ' + (e.stack || e)); }
  if (errors.length) { failures++; await page.screenshot({ path: `${OUT}/ui-hardening-${name}.png` }); console.log(`✗ ${name}\n  ` + errors.join('\n  ')); } else console.log(`✓ ${name}`);
  await ctx.close();
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const docText = (page) => page.evaluate(() => window.qf.state.doc.textContent);
const paras = (page) => page.evaluate(() => { const out = []; window.qf.state.doc.forEach((n) => out.push(n.textContent)); return out; });
const setDoc = (page, lines) => page.evaluate((ls) => { const app = window.qf; const s = app.state; app.view.dispatch(s.tr.replaceWith(0, s.doc.content.size, ls.map((l) => s.schema.nodes.paragraph.create(null, l ? s.schema.text(l) : null)))); }, lines);
const select = (page, from, to) => page.evaluate(([a, b]) => { const app = window.qf; app.view.dispatch(app.state.tr.setSelection(app.state.selection.constructor.create(app.state.doc, a, b ?? a))); }, [from, to]);
const pick = async (page, p) => { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => { window.qf.exec('file.open'); })]); await fc.setFiles(p); await page.waitForTimeout(800); };

await run('format-painter', { width: 1280, height: 800 }, async (page) => {
  await setDoc(page, ['Red bold and plain words']);
  await page.evaluate(() => { const app = window.qf; const tr = app.state.tr.addMark(1, 4, app.state.schema.marks.bold.create()); app.view.dispatch(tr.setSelection(app.state.selection.constructor.create(tr.doc, 1, 9))); });
  await page.click('[data-cmd="fmt.painter"]');
  await page.waitForTimeout(200);
  const bold = () => page.evaluate(() => { const out = []; window.qf.state.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'bold')) out.push(n.text); }); return out.join('|'); });
  expect(await bold() === 'Red', 'source changed: ' + await bold());
  expect(await page.evaluate(() => window.__qfGetCommand('fmt.painter').isActive(window.qf)), 'painter switched itself off');
  await select(page, 14, 19);
  await page.waitForTimeout(200);
  expect(await bold() === 'Red|plain', 'target not painted: ' + await bold());
});

await run('spelling-pane', { width: 1280, height: 800 }, async (page) => {
  await page.click('.qf-editor');
  await page.keyboard.type('Dear Sam, the zorbleq arrived.');
  await page.keyboard.press('F7'); // right after typing: the pane must catch up when the check finishes
  await page.waitForFunction(() => document.querySelector('.qf-proof-card h3')?.textContent === 'zorbleq', null, { timeout: 60000 });
  // the document changes while the pane is open: no suggestion may be applied at old positions
  await page.evaluate(() => { const app = window.qf; app.view.dispatch(app.state.tr.insertText('Hello. ', 1)); });
  await page.evaluate(() => document.querySelector('.qf-suggestions button')?.click());
  await page.waitForTimeout(500);
  const t = await docText(page);
  expect(t.startsWith('Hello. Dear Sam, the '), 'text corrupted: ' + t);
});

await run('notes-pane', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => {
    const app = window.qf; const s = app.state; const sc = s.schema;
    const note = (text, id) => sc.nodes.footnote.create({ text, kind: 'foot', id });
    app.view.dispatch(s.tr.replaceWith(0, s.doc.content.size, [sc.nodes.paragraph.create(null, [sc.text('Alpha'), note('Note A', 'a'), sc.text(' beta'), note('Note B', 'b')])]));
    app.exec('refs.showNotes');
    app.view.dispatch(app.state.tr.insertText('Intro ', 1));
  });
  await page.waitForTimeout(300);
  await page.locator('.qf-note textarea').first().fill('Note A (revised)');
  await page.evaluate(() => document.querySelector('.qf-note textarea').dispatchEvent(new Event('change')));
  const notes = await page.evaluate(() => { const out = []; window.qf.state.doc.descendants((n) => { if (n.type.name === 'footnote') out.push(n.attrs.text); }); return out.join('|'); });
  expect(notes === 'Note A (revised)|Note B', 'notes: ' + notes);
});

await run('phone-comment-reply', { width: 400, height: 800 }, async (page) => {
  await page.evaluate(() => {
    const app = window.qf; const s = app.state;
    app.view.dispatch(s.tr.insertText('Please review this paragraph.'));
    const st = JSON.parse(JSON.stringify(app.settings));
    st.comments.c1 = { id: 'c1', author: 'Ann', date: Date.now(), text: 'Is this right?', resolved: false, replies: [] };
    app.view.dispatch(app.state.tr.addMark(1, 7, s.schema.marks.comment.create({ id: 'c1' })).setDocAttribute('settings', st).setMeta('comment', true).setMeta('trackSkip', true));
    app.exec('review.showComments');
  });
  await page.waitForTimeout(300);
  await page.tap('input[aria-label="Reply"]');
  await page.keyboard.type('Yes');
  await page.setViewportSize({ width: 400, height: 480 }); // the on-screen keyboard opens
  await page.waitForTimeout(300);
  await page.keyboard.type(', confirmed');
  expect(await page.inputValue('input[aria-label="Reply"]') === 'Yes, confirmed', 'reply text lost');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const replies = await page.evaluate(() => window.qf.settings.comments.c1.replies.map((r) => r.text));
  expect(replies.join() === 'Yes, confirmed', 'reply not added: ' + replies);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Reply', 'focus left the reply box');
});

await run('menus-from-keyboard', { width: 1280, height: 800 }, async (page) => {
  await page.click('.qf-editor');
  await page.keyboard.type('hello');
  await page.focus('[data-cmd="para.lineSpacing"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.qf-menu')), 'menu did not take focus');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); // 1.0 → 1.15 → 1.5
  const label = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const lh = await page.evaluate(() => window.qf.state.doc.firstChild.attrs.lineHeight);
  expect(lh === '1.5' && /1\.5/.test(label), `picked ${label}, line height ${lh}`);
  await page.focus('[data-cmd="para.lineSpacing"]');
  await page.keyboard.press('Enter'); await page.waitForTimeout(100);
  await page.keyboard.press('Tab');
  expect(!(await page.evaluate(() => window.qf.state.doc.textContent.includes('\t'))), 'Tab reached the document');
  expect(await page.evaluate(() => !document.querySelector('.qf-menu') && document.activeElement?.getAttribute('data-cmd') === 'para.lineSpacing'), 'Tab did not close the menu back to its button');
  await page.keyboard.press('Enter'); await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => !document.querySelector('.qf-menu') && document.activeElement?.getAttribute('data-cmd') === 'para.lineSpacing'), 'Escape did not return focus');
});

await run('customize-keyboard', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => { window.qf.exec('file.customizeKeyboard'); });
  await page.waitForSelector('.qf-key-capture');
  await page.focus('.qf-key-capture');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => !!document.querySelector('.qf-overlay:not(.qf-out) .qf-key-capture')), 'Ctrl+Enter closed the dialog');
  expect(await page.inputValue('.qf-key-capture') === 'Ctrl+Enter', 'Ctrl+Enter not captured');
  await page.keyboard.press('Control+Shift+KeyY');
  await page.keyboard.press('Tab');
  expect(await page.inputValue('.qf-key-capture') === 'Ctrl+Shift+Y', 'Tab overwrote the captured key');
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim()) === 'Assign', 'Tab did not move to Assign');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => [...document.querySelectorAll('.qf-cust-keys kbd')].some((k) => k.textContent === 'Ctrl+Shift+Y')), 'shortcut not assigned');
});

await run('altgr-characters', { width: 1280, height: 800 }, async (page) => {
  await page.click('.qf-editor');
  const r = await page.evaluate(() => {
    const app = window.qf; const out = [];
    for (const [key, code] of [['\\', 'Minus'], [']', 'Minus']]) {
      const ev = new KeyboardEvent('keydown', { key, code, ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
      app.view.dom.dispatchEvent(ev);
      out.push(ev.defaultPrevented);
    }
    return { prevented: out, text: app.state.doc.textContent };
  });
  expect(!r.prevented.some(Boolean) && !r.text.includes('—'), 'AltGr keys were taken as shortcuts: ' + JSON.stringify(r));
});

await run('distraction-free-exit', { width: 400, height: 800 }, async (page) => {
  await page.evaluate(() => window.qf.exec('view.distractionFree'));
  await page.waitForTimeout(150);
  const hint = await page.evaluate(() => [...document.querySelectorAll('.qf-toast')].map((t) => t.textContent).pop() || '');
  expect(/Esc/.test(hint) && !/Shift\+Enter/.test(hint), 'hint: ' + hint);
  await page.tap('.qf-zen-exit');
  expect(!(await page.evaluate(() => document.body.classList.contains('qf-zen'))), 'exit button did not leave distraction-free mode');
});

await run('macro-editing-keys', { width: 1280, height: 800 }, async (page) => {
  await page.click('.qf-editor');
  await page.evaluate(() => { window.qf.exec('dev.recordMacro'); });
  await page.waitForSelector('.qf-dialog .qf-primary');
  await page.click('.qf-dialog .qf-primary');
  await page.waitForTimeout(200);
  await page.click('.qf-editor');
  await page.keyboard.type('Dear team,');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Thanks');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('!');
  await page.evaluate(() => window.qf.exec('dev.stopRecording'));
  const typed = await paras(page);
  await page.evaluate(() => window.qf.exec('file.new'));
  await page.waitForTimeout(200);
  await page.evaluate(async () => { await window.qf.exec('dev.runMacro', 'Macro1'); });
  await page.waitForTimeout(200);
  const replayed = await paras(page);
  expect(JSON.stringify(typed) === JSON.stringify(['Dear team,', 'Thank!']) && JSON.stringify(replayed) === JSON.stringify(typed), `typed ${JSON.stringify(typed)}, replayed ${JSON.stringify(replayed)}`);
});

await run('edit-link-from-context-menu', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => { const app = window.qf; const s = app.state; const sc = s.schema; app.view.dispatch(s.tr.replaceWith(0, s.doc.content.size, sc.nodes.paragraph.create(null, [sc.text('See the '), sc.text('project site', [sc.marks.link.create({ href: 'https://old.example.com' })]), sc.text(' for details.')]))); });
  const box = await page.evaluate(() => { const r = document.querySelector('.qf-editor a').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.locator('.qf-menu-item', { hasText: 'Edit Link' }).click();
  await page.waitForFunction(() => document.activeElement?.matches('.qf-dialog input[list]')); // the address field takes focus
  expect(await page.inputValue('.qf-dialog input[type=text]') === 'project site', 'link text not prefilled');
  await page.fill('.qf-dialog input[list]', 'https://new.example.com');
  await page.click('.qf-dialog .qf-primary');
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({ text: window.qf.state.doc.textContent, href: document.querySelector('.qf-editor a')?.getAttribute('href'), links: document.querySelectorAll('.qf-editor a').length }));
  expect(r.text === 'See the project site for details.' && r.href === 'https://new.example.com' && r.links === 1, JSON.stringify(r));
});

await run('find-single-replace', { width: 1280, height: 800 }, async (page) => {
  await setDoc(page, ['Name: Ann; Name: Bob']);
  await page.evaluate(() => window.qf.exec('edit.replace'));
  await page.waitForSelector('.qf-pane-body input[aria-label="Find"]');
  await page.fill('.qf-pane-body input[aria-label="Find"]', 'Name: ');
  await page.fill('.qf-pane-body input[aria-label="Replace with"]', 'Name:^t');
  const replaceBtn = page.locator('.qf-pane-body button', { hasText: /^\s*Replace$/ });
  await replaceBtn.click(); await replaceBtn.click();
  await page.waitForTimeout(150);
  expect(await docText(page) === 'Name:\tAnn; Name: Bob', 'Replace: ' + JSON.stringify(await docText(page)));
});

await run('typing-while-saving', { width: 1280, height: 800 }, async (page) => {
  await page.click('.qf-editor');
  await page.keyboard.type('First draft sentence.');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
  await page.keyboard.type(' Second.');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(100);
  await page.keyboard.type(' Typed while saving.');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.qf.tab.dirty), 'edits typed during the save were marked saved');
}, () => {
  window.showSaveFilePicker = async ({ suggestedName }) => ({ name: suggestedName, createWritable: async () => ({ write: () => new Promise((r) => setTimeout(r, 800)), close: async () => {} }) });
});

await run('same-named-files', { width: 1280, height: 800 }, async (page) => {
  await pick(page, file('x/report.txt', 'Contract version from folder X.\n'));
  const tabX = await page.evaluate(() => window.qf.tab.id);
  await page.evaluate(() => { const app = window.qf; app.view.dispatch(app.state.tr.insertText(' EDITED', app.state.doc.content.size - 1)); });
  await pick(page, file('y/report.txt', 'Different notes from folder Y.\n'));
  await page.evaluate((id) => window.qf.activate(window.qf.docs.find((d) => d.id === id)), tabX);
  await page.evaluate(() => { window.qf.exec('file.revert'); });
  await page.waitForSelector('.qf-dialog .qf-primary');
  await page.click('.qf-dialog .qf-primary');
  await page.waitForTimeout(800);
  expect(await docText(page) === 'Contract version from folder X.', 'reverted to: ' + await docText(page));
});

await run('version-history-per-document', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => { const app = window.qf; app.view.dispatch(app.state.tr.insertText('Secret draft A')); app.exec('file.snapshot'); });
  await page.waitForSelector('.qf-dialog .qf-primary');
  await page.click('.qf-dialog .qf-primary');
  await page.waitForTimeout(300);
  await page.evaluate(() => { const app = window.qf; app.exec('file.new'); app.view.dispatch(app.state.tr.insertText('Document B')); app.exec('file.versions'); });
  await page.waitForTimeout(500);
  const count = () => page.evaluate(() => document.querySelectorAll('.qf-version').length);
  expect(await count() === 0, 'untitled document B lists another document’s snapshots');
  await page.evaluate(() => window.qf.activate(window.qf.docs[0]));
  await page.waitForTimeout(500);
  expect(await count() === 1, 'the pane did not follow the active document');
});

await run('saved-file-keeps-history', { width: 1280, height: 800 }, async (page) => {
  await pick(page, file('h/notes.txt', 'Meeting notes.\n'));
  const key = await page.evaluate(() => window.qf.tab.key);
  await page.evaluate(() => { const app = window.qf; app.view.dispatch(app.state.tr.insertText(' Added.', app.state.doc.content.size - 1)); app.exec('file.save'); });
  await page.waitForFunction(() => window.__saved && !window.qf.tab.dirty);
  await page.waitForTimeout(300);
  const versions = async () => { await page.evaluate(() => window.qf.exec('file.versions')); await page.waitForTimeout(500); return page.evaluate(() => ({ key: window.qf.tab.key, n: document.querySelectorAll('.qf-version').length })); };
  await page.evaluate(() => window.qf.closeTab(window.qf.tab));
  await page.evaluate((k) => window.qf.exec('file.openRecent', k), key); // its handle is gone: opens the cached copy
  await page.waitForTimeout(800);
  let r = await versions();
  expect(r.key === key && r.n >= 1, 'reopened from Recent: ' + JSON.stringify({ expected: key, ...r }));
  await page.evaluate(() => window.qf.closeTab(window.qf.tab));
  await pick(page, file('h2/notes.txt', Buffer.from(await page.evaluate(() => window.__saved)))); // the saved file, opened again
  r = await versions();
  expect(r.key === key && r.n >= 1, 'reopened saved file: ' + JSON.stringify({ expected: key, ...r }));
}, () => {
  window.showSaveFilePicker = async ({ suggestedName }) => ({ name: suggestedName, createWritable: async () => ({ write: async (b) => { window.__saved = Array.from(new Uint8Array(await b.arrayBuffer())); }, close: async () => {} }) });
});

await run('combine-revisions', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => {
    const app = window.qf; const s = app.state;
    app.view.dispatch(s.tr.insertText('Original signed text.'));
    const st = JSON.parse(JSON.stringify(app.settings));
    st.comments.c1 = { id: 'c1', author: 'Ann', date: Date.now(), text: 'Confirm the date.', resolved: false, replies: [] };
    st.header.center = 'ACME CONFIDENTIAL';
    app.view.dispatch(app.state.tr.addMark(10, 16, s.schema.marks.comment.create({ id: 'c1' })).setDocAttribute('settings', st).setMeta('comment', true).setMeta('trackSkip', true));
    app.tab.dirty = false;
  });
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => { window.qf.exec('review.combine'); })]);
  await fc.setFiles(file('revised.txt', 'Revised text from a colleague.\n'));
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({ comments: Object.keys(window.qf.settings.comments), header: window.qf.settings.header.center, dirty: window.qf.tab.dirty, undo: window.__qfGetCommand('edit.undo').isEnabled(window.qf) }));
  expect(r.comments.includes('c1') && r.header === 'ACME CONFIDENTIAL' && r.dirty && r.undo, JSON.stringify(r));
});

await run('damaged-settings-import', { width: 1280, height: 800 }, async (page) => {
  await page.evaluate(() => { window.qf.exec('file.exportSettings'); });
  await page.waitForSelector('.qf-dialog textarea');
  await page.fill('.qf-dialog textarea', JSON.stringify({ customTabs: null, theme: 'dark' }));
  await page.click('.qf-dialog .qf-primary');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForFunction(() => window.qf && window.qf.view, null, { timeout: 10000 });
  expect(await page.evaluate(() => window.qf.prefs.theme === 'dark' && Array.isArray(window.qf.prefs.customTabs)), 'settings not applied safely');
});

fs.rmSync(tmp, { recursive: true, force: true });
await browser.close();
process.exit(failures ? 1 : 0);
