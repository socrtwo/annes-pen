// Shared by the e2e scripts: launch Chromium the way Playwright installed it, or, when that build
// is missing, a browser from PLAYWRIGHT_CHROMIUM_EXECUTABLE or the newest one under /opt/pw-browsers.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function fallbackExecutable() {
  const env = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (env && fs.existsSync(env)) return env;
  const root = '/opt/pw-browsers';
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { return null; }
  for (const d of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(root, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export async function launchChromium(options = {}) {
  try {
    return await chromium.launch(options);
  } catch (e) {
    const exe = fallbackExecutable();
    if (!exe) throw e;
    return chromium.launch({ ...options, executablePath: exe });
  }
}
