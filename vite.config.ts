import { defineConfig, type Plugin } from 'vite';

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** KaTeX lists woff2, woff and ttf for each font; every supported browser reads woff2, so ship only those. */
export function katexWoff2Only(): Plugin {
  return {
    name: 'katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/katex(\.min)?\.css(\?|$)/.test(id)) return null;
      return { code: code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g, ''), map: null };
    },
  };
}

/** All files under dir, as paths relative to it with forward slashes, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Fills public/sw.js in the built output with the build's version (app version plus a hash of
 * every emitted file) and the list of files to precache, so the app works offline after the first
 * visit and each build gets its own cache.
 */
export function swPrecache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'sw-precache',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      let sw: string;
      try { sw = readFileSync(swPath, 'utf8'); } catch { return; }
      const files = listFiles(outDir).filter((f) => f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update('\0').update(readFileSync(join(outDir, f)));
      const version = `${pkg.version}-${hash.digest('hex').slice(0, 12)}`;
      const urls = ['./', ...files.map((f) => './' + f)];
      const filled = sw.replace("/*__VERSION__*/'dev'", JSON.stringify(version)).replace('/*__PRECACHE__*/[]', JSON.stringify(urls));
      if (filled === sw) throw new Error('sw-precache: placeholders not found in sw.js');
      writeFileSync(swPath, filled);
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  plugins: [katexWoff2Only(), swPrecache()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
  },
} as any);
