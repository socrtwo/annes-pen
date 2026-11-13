#!/usr/bin/env node
// Prints the Android versionCode for this build (docs/ANDROID.md, "Version codes"):
//   major * 1000000 + minor * 10000 + patch * 100 + n
// n is 99 for an official release (tag v<version>). For every other build (branch CI, test
// prereleases, tags with a suffix such as v0.6.0-beta.1) n is the number of commits since
// package.json got its current version, capped at 98, so test builds of a version rise with each
// commit and always sort below that version's release. Bump package.json after a release, or test
// builds would sort below the release that is already installed.
//
//   node scripts/android-version-code.mjs [--release] [--version 0.5.0] [--build 3]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const release = args.includes('--release');
const version = opt('--version') ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
if (!m) fail(`not a version: ${version}`);
const [major, minor, patch] = m.slice(1).map(Number);
if (minor > 99 || patch > 99 || major > 2000) fail(`version ${version} does not fit the versionCode scheme`);
if (release && version.includes('-')) fail(`--release needs a plain x.y.z version, got ${version}`);

function git(...a) { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }

function commitsSinceVersion() {
  try {
    // Oldest commit whose package.json gained this "version" line, then the commits after it.
    const intro = git('log', '--format=%H', '-S', `"version": "${version}"`, '--', 'package.json').split('\n').filter(Boolean).pop();
    return intro ? Number(git('rev-list', '--count', `${intro}..HEAD`)) : 0;
  } catch {
    console.error('android-version-code: no git history (shallow clone?), using build 0');
    return 0;
  }
}

const build = release ? 99 : Math.min(98, Math.max(0, Number(opt('--build') ?? commitsSinceVersion()) || 0));
process.stdout.write(String(major * 1000000 + minor * 10000 + patch * 100 + build) + '\n');

function fail(msg) { console.error(`android-version-code: ${msg}`); process.exit(1); }
