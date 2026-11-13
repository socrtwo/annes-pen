#!/usr/bin/env node
// Builds the web app, serves it with `vite preview` on a free port and runs browser tests against it.
//   node scripts/run-e2e.mjs                    build, then smoke, ui-hardening, all-commands, io, visual, offline
//   node scripts/run-e2e.mjs smoke ui-hardening only these (names of tests/e2e/*.mjs)
//   --no-build                                  test the existing dist/
//   QF_URL=http://localhost:4173/ ...           test a server that is already running (no build, no preview)
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build') || !!process.env.QF_URL;
const names = args.filter((a) => !a.startsWith('--'));
const tests = names.length ? names : ['smoke', 'ui-hardening', 'all-commands', 'io', 'visual', 'offline'];

function run(cmd, cmdArgs, env) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  return r.status ?? 1;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

if (!noBuild && run('npm', ['run', 'build']) !== 0) process.exit(1);

let server = null;
let url = process.env.QF_URL;
if (!url) {
  const port = await freePort();
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  url = `http://localhost:${port}/`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(url)).ok; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { server.kill(); console.error(`vite preview did not start on ${url}`); process.exit(1); }
}

const failed = [];
for (const t of tests) {
  console.log(`\n=== e2e: ${t} (${url})`);
  if (run(process.execPath, [path.join(root, 'tests/e2e', t + '.mjs')], { QF_URL: url }) !== 0) failed.push(t);
}
if (server) server.kill();
console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : `\nAll passed: ${tests.join(', ')}`);
process.exit(failed.length ? 1 : 0);
