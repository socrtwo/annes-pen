// AI end-to-end: a mock OpenAI-compatible server (SSE streaming, CORS) and the real app in Chromium.
// Verifies the wizard, streaming previews, word-level replacement, tracked AI edits, comments,
// tables from Markdown, new documents, the AI pane, error handling, and the Anthropic/Gemini adapters.
import { launchChromium } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';

const URL = process.env.QF_URL || 'http://localhost:4173/';
const OUT = process.env.QF_OUT || 'test-results';
fs.mkdirSync(OUT, { recursive: true });
const PORT = 4199;
const seen = [];

function answer(prompt, sys) {
  if (/Reply with one short friendly sentence|Reply with OK/.test(prompt)) return 'OK, the mock AI is working.';
  if (/Correct spelling, grammar/.test(prompt)) return prompt.split(/:\n\n/).slice(1).join(':\n\n').replace(/teh/g, 'the').replace(/recieve/g, 'receive');
  if (/different ways/.test(prompt)) return 'The fast brown fox leaps over the lazy dog.\n---\nA quick brown fox jumps across the sleepy dog.\n---\nThe quick fox vaults over a lazy hound.';
  if (/Markdown table/.test(prompt)) return '| Name | Born |\n| --- | --- |\n| John Pruitt | 1843 |\n| Mary Pruitt | 1847 |';
  if (/JSON only/.test(prompt)) return '```json\n[{"quote": "lazy dog", "comment": "Consider a more specific animal."}, {"quote": "not in the text at all", "comment": "unmatched"}]\n```';
  if (/Summarize/.test(prompt)) return 'A fox jumps over a dog.';
  if (/Translate this document into Spanish/.test(prompt)) return '# Título\n\nEl rápido zorro marrón.';
  if (/^QUOTA/.test(prompt)) return null;
  return 'Generic mock answer.' + (sys ? '' : '');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '';
    if (req.url.includes('bad-key') || auth.includes('bad')) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Invalid API key"}}'); return; }
    if (req.method === 'GET' && /\/models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/gemini/')) res.end(JSON.stringify({ models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }] }));
      else res.end(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-mini' }] }));
      return;
    }
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* */ }
    seen.push({ url: req.url, body: j, headers: req.headers });
    // Anthropic Messages
    if (req.url.endsWith('/messages')) {
      const text = answer(JSON.stringify(j.messages || []), j.system) || '';
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`);
        for (const w of text.split(/(?<= )/)) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: w } })}\n\n`);
        res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}\n\n`);
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } })); }
      return;
    }
    // Gemini
    if (/:(stream)?[gG]enerateContent/.test(req.url)) {
      const prompt = (j.contents || []).map((c) => c.parts.map((p) => p.text).join('')).join('\n');
      const text = answer(prompt) || '';
      if (/stream/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const w of text.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: w }] } }] })}\n\n`);
        res.end();
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })); }
      return;
    }
    // OpenAI-compatible chat
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1];
    const prompt = typeof last?.content === 'string' ? last.content : (last?.content || []).map((p) => p.text || '').join('');
    const sys = msgs.find((m) => m.role === 'system')?.content || '';
    if (j.temperature != null && j.model === 'no-temp') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Unsupported value: temperature"}}'); return; }
    const text = answer(prompt, sys);
    if (text == null) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Quota exceeded"}}'); return; }
    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const w of text.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    }
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.addInitScript((port) => {
  localStorage.setItem('quillpen.prefs.v1', JSON.stringify({ firstRun: false }));
  if (!sessionStorage.getItem('ai-init')) {
    sessionStorage.setItem('ai-init', '1');
    localStorage.setItem('quillpen.ai.v1', JSON.stringify({
      active: 'custom', confirmDocument: false, privacyAck: ['custom', 'anthropic', 'gemini'], trackAsRevisions: false,
      providers: { custom: { id: 'custom', model: 'mock-large', fastModel: 'mock-mini', baseUrl: `http://localhost:${port}/v1` } },
    }));
  }
}, PORT);
await page.goto(URL);
await page.waitForFunction(() => window.qf && window.qf.view);

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}: ${e.message || e}`); await page.screenshot({ path: `${OUT}/ai-fail-${name.replace(/\W+/g, '-')}.png` }); }
  await page.evaluate(() => document.querySelectorAll('.qf-overlay').forEach((o) => o.remove()));
}
const setDoc = (text) => page.evaluate((t) => {
  const app = window.qf;
  const s = app.view.state;
  app.view.dispatch(s.tr.replaceWith(0, s.doc.content.size, t.split('\n').map((l) => s.schema.nodes.paragraph.create(null, l ? s.schema.text(l) : null))));
}, text);
const docText = () => page.evaluate(() => window.qf.view.state.doc.textContent);
const selectText = (needle) => page.evaluate((n) => {
  // Find the needle across text nodes of one textblock (formatting splits text nodes).
  const app = window.qf;
  let from = -1, to = -1;
  app.view.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isTextblock) return from < 0;
    const i = node.textContent.indexOf(n);
    if (i >= 0) { from = pos + 1 + i; to = from + n.length; }
    return false;
  });
  if (from < 0) throw new Error('not found: ' + n);
  const sel = app.view.state.selection.constructor.create(app.view.state.doc, from, to);
  app.view.dispatch(app.view.state.tr.setSelection(sel));
  return from;
}, needle);
const clickButton = async (label) => { await page.locator('.qf-dialog button', { hasText: label }).first().click(); };

await check('AI tab renders with its groups', async () => {
  await page.locator('[role="tab"], .qf-tab', { hasText: /^AI$/ }).first().click();
  await page.waitForTimeout(300);
  const n = await page.evaluate(() => document.querySelectorAll('[data-cmd^="ai."]').length);
  if (n < 30) throw new Error(`only ${n} AI buttons`);
  await page.screenshot({ path: `${OUT}/ai-tab.png` });
});

await check('Rewrite: streamed alternatives, word-level replace keeps formatting', async () => {
  await setDoc('The quick brown fox jumps over the lazy dog.');
  // Bold "lazy" to check that unchanged words keep their formatting.
  await page.evaluate(() => { const app = window.qf; const s = app.view.state; let f = -1; s.doc.descendants((n, p) => { if (n.isText && f < 0) f = p + n.text.indexOf('lazy'); }); app.view.dispatch(s.tr.addMark(f, f + 4, s.schema.marks.bold.create())); });
  await selectText('The quick brown fox jumps over the lazy dog.');
  await page.evaluate(() => { window.qf.exec('ai.rewrite'); });
  await page.waitForSelector('.qf-ai-out');
  await page.waitForFunction(() => /Version 1 of 3/.test(document.querySelector('.qf-ai-nav')?.textContent || ''), null, { timeout: 8000 });
  await page.screenshot({ path: `${OUT}/ai-preview.png` });
  await clickButton('Replace');
  await page.waitForTimeout(400);
  const t = await docText();
  if (t !== 'The fast brown fox leaps over the lazy dog.') throw new Error(t);
  const boldLazy = await page.evaluate(() => { let b = false; window.qf.view.state.doc.descendants((n) => { if (n.isText && n.text.includes('lazy') && n.marks.some((m) => m.type.name === 'bold')) b = true; }); return b; });
  if (!boldLazy) throw new Error('bold on an unchanged word was lost');
});

await check('Proofread: tracked changes by "AI (mock-large)"', async () => {
  await setDoc('I will recieve teh package.\nSecond line is fine.');
  await page.evaluate(() => { const app = window.qf; app.view.dispatch(app.view.state.tr.setSelection(app.view.state.selection.constructor.near(app.view.state.doc.resolve(1)))); });
  await page.evaluate(() => { window.qf.exec('ai.proofread'); });
  await page.waitForFunction(() => !document.querySelector('.qf-ai-busy'), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const out = { ins: [], del: [], authors: new Set() };
    window.qf.view.state.doc.descendants((n) => { if (n.isText) for (const m of n.marks) { if (m.type.name === 'insertion') { out.ins.push(n.text); out.authors.add(m.attrs.author); } if (m.type.name === 'deletion') out.del.push(n.text); } });
    return { ins: out.ins, del: out.del, authors: [...out.authors] };
  });
  if (!info.ins.includes('the') || !info.del.includes('teh') || !info.ins.includes('receive')) throw new Error('expected whole-word changes: ' + JSON.stringify(info));
  const accepted = await page.evaluate(() => { let t = ''; window.qf.view.state.doc.descendants((n) => { if (n.isText && !n.marks.some((m) => m.type.name === 'deletion')) t += n.text; if (n.isTextblock && t) t += '|'; }); return t; });
  if (!accepted.startsWith('I will receive the package.')) throw new Error('accepted text: ' + accepted);
  if (!info.authors[0]?.startsWith('AI (')) throw new Error('author ' + info.authors);
  const tracking = await page.evaluate(() => window.qf.view.state.plugins.map((p) => p.getState?.(window.qf.view.state)).find((s) => s && 'enabled' in s)?.enabled);
  if (tracking) throw new Error('tracking left on after the AI edit');
});

await check('Feedback: JSON comments attached to quoted text; unmatched reported', async () => {
  await setDoc('The quick brown fox jumps over the lazy dog.');
  await selectText('The quick brown fox jumps over the lazy dog.');
  await page.evaluate(() => { window.qf.exec('ai.feedback'); });
  await page.waitForFunction(() => Object.keys(window.qf.settings.comments || {}).length > 0, null, { timeout: 8000 });
  const c = await page.evaluate(() => Object.values(window.qf.settings.comments).map((x) => [x.author, x.text]));
  if (!c.some(([, t]) => /specific animal/.test(t))) throw new Error(JSON.stringify(c));
});

await check('Convert to Table: Markdown table becomes a real table', async () => {
  await setDoc('John Pruitt was born in 1843 and Mary Pruitt in 1847.');
  await selectText('John Pruitt was born in 1843 and Mary Pruitt in 1847.');
  await page.evaluate(() => { window.qf.exec('ai.table'); });
  await page.waitForSelector('.qf-ai-out');
  await page.waitForFunction(() => /Mary Pruitt/.test(document.querySelector('.qf-ai-out')?.textContent || ''));
  await page.waitForTimeout(200);
  await clickButton('Replace');
  await page.waitForTimeout(500);
  const hasTable = await page.evaluate(() => { let t = 0; window.qf.view.state.doc.descendants((n) => { if (n.type.name === 'table') t++; }); return t; });
  if (!hasTable) throw new Error('no table: ' + (await docText()));
});

await check('Summarize: streams into the AI pane', async () => {
  await setDoc('The quick brown fox jumps over the lazy dog.');
  await selectText('The quick brown fox');
  await page.evaluate(() => { window.qf.exec('ai.summarize', 'paragraph'); });
  await page.waitForFunction(() => /fox jumps over a dog/.test(document.querySelector('.qf-ai-log')?.textContent || ''), null, { timeout: 8000 });
  await page.screenshot({ path: `${OUT}/ai-pane.png` });
});

await check('Translate Document: opens a new tab with structure', async () => {
  const before = await page.evaluate(() => window.qf.docs.length);
  await page.evaluate(() => { window.qf.exec('ai.translateDoc', 'Spanish'); });
  await page.waitForFunction((b) => window.qf.docs.length > b, before, { timeout: 8000 });
  const t = await page.evaluate(() => [window.qf.view.state.doc.child(0).attrs.style, window.qf.view.state.doc.textContent]);
  if (t[0] !== 'Heading 1' || !/zorro/.test(t[1])) throw new Error(JSON.stringify(t));
});

await check('Errors: rate limit becomes a quota error with the provider message', async () => {
  const r = await page.evaluate(async () => {
    const m = await window.__qfAi();
    try { await m.chat({ messages: [{ role: 'user', content: 'QUOTA test' }] }); return 'no error'; } catch (e) { return `${e.code}|${e.message}`; }
  });
  if (!/^quota\|.*Quota exceeded/.test(r)) throw new Error(r);
});

await check('Anthropic adapter: headers, system prompt, SSE deltas', async () => {
  const r = await page.evaluate(async (port) => {
    const m = await window.__qfAi();
    m.saveAiSettings((s) => { s.providers.anthropic = { id: 'anthropic', model: 'claude-test', baseUrl: `http://localhost:${port}/anth/v1` }; });
    await m.setApiKey('anthropic', 'sk-ant-test');
    let streamed = '';
    const res = await m.chat({ provider: 'anthropic', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Summarize this' }], onToken: (_d, f) => { streamed = f; } });
    return { text: res.text, streamed };
  }, PORT);
  if (r.text !== 'A fox jumps over a dog.' || r.streamed !== r.text) throw new Error(JSON.stringify(r));
  const req = seen.filter((s) => s.url.endsWith('/messages')).pop();
  if (req.body.system !== 'SYS' || req.headers['anthropic-dangerous-direct-browser-access'] !== 'true' || req.headers['x-api-key'] !== 'sk-ant-test') throw new Error('bad request ' + JSON.stringify(req.headers));
});

await check('Gemini adapter: x-goog-api-key, model listing, streaming', async () => {
  const r = await page.evaluate(async (port) => {
    const m = await window.__qfAi();
    m.saveAiSettings((s) => { s.providers.gemini = { id: 'gemini', model: 'gemini-flash-latest', baseUrl: `http://localhost:${port}/gemini/v1beta` }; });
    await m.setApiKey('gemini', 'AQ.testkey');
    const rp = await m.resolveProvider('gemini');
    const models = await m.listModels(rp);
    const res = await m.chat({ provider: 'gemini', messages: [{ role: 'user', content: 'Summarize this' }], onToken: () => {} });
    return { models, text: res.text };
  }, PORT);
  if (r.models[0] !== 'gemini-flash-latest' || r.text !== 'A fox jumps over a dog.') throw new Error(JSON.stringify(r));
  const req = seen.filter((s) => /generatecontent/i.test(s.url)).pop();
  if (req.headers['x-goog-api-key'] !== 'AQ.testkey') throw new Error('missing key header');
});

await check('Rejected key: friendly auth error', async () => {
  const msg = await page.evaluate(async (port) => {
    const m = await window.__qfAi();
    try {
      await m.listModels({ def: m.providerById('custom'), cfg: { id: 'custom', model: 'x' }, key: 'bad', baseUrl: `http://localhost:${port}/v1` });
      return 'no error';
    } catch (e) { return e.message; }
  }, PORT);
  if (!/rejected the API key/.test(msg)) throw new Error(msg);
});

await check('Parameter retry: model refusing temperature', async () => {
  const t = await page.evaluate(async () => {
    const m = await window.__qfAi();
    const r = await m.chat({ model: 'no-temp', temperature: 0.7, messages: [{ role: 'user', content: 'Summarize' }] });
    return r.text;
  });
  if (t !== 'A fox jumps over a dog.') throw new Error(t);
});

await check('Key detection recognizes formats', async () => {
  const r = await page.evaluate(async () => {
    const m = await window.__qfAi();
    return [
      m.detectKey('my key: sk-or-v1-' + 'a'.repeat(64))?.provider,
      m.detectKey('gsk_' + 'A'.repeat(52))?.provider,
      m.detectKey('sk-ant-api03-' + 'x'.repeat(90) + 'AA')?.provider,
      m.detectKey('AIza' + 'b'.repeat(35))?.provider,
      m.detectKey('hf_' + 'c'.repeat(34))?.provider,
      m.detectKey('nothing here')?.provider ?? null,
    ];
  });
  if (JSON.stringify(r) !== JSON.stringify(['openrouter', 'groq', 'anthropic', 'gemini', 'huggingface', null])) throw new Error(JSON.stringify(r));
});

await check('Setup wizard: chooser, provider page, key test and save', async () => {
  await page.evaluate(() => { window.qf.exec('ai.setup'); });
  await page.waitForSelector('.qf-ai-cards');
  await page.screenshot({ path: `${OUT}/ai-wizard.png` });
  await page.locator('.qf-ai-card', { hasText: 'Other OpenAI-compatible' }).click();
  await page.waitForSelector('.qf-ai-actions');
  await page.locator('.qf-ai-wizard input[placeholder="https://example.com/v1"]').fill(`http://localhost:${PORT}/v1`);
  await page.locator('.qf-ai-wizard input[type=password]').fill('test-key');
  await page.locator('.qf-ai-wizard button', { hasText: 'Test & Save' }).click();
  await page.waitForSelector('text=is ready', { timeout: 8000 });
  await page.screenshot({ path: `${OUT}/ai-wizard-done.png` });
  const models = await page.evaluate(() => JSON.parse(localStorage.getItem('quillpen.ai.v1')).providers.custom.models);
  if (!models.includes('mock-mini')) throw new Error(JSON.stringify(models));
  const keyInStorage = await page.evaluate(() => localStorage.getItem('quillpen.ai.v1').includes('test-key'));
  if (keyInStorage) throw new Error('API key leaked into localStorage settings');
});

console.log(`\n${passed} passed, ${failed} failed${errors.length ? `; page errors:\n  ${errors.join('\n  ')}` : ''}`);
await browser.close();
server.close();
process.exit(failed || errors.length ? 1 : 0);
