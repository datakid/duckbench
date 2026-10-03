import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const web = resolve(desktop, '..');
const dist = join(desktop, 'dist');
const require = createRequire(join(desktop, 'package.json'));

const WEB_ENTRIES = ['index.html', 'demo.html', 'tests.html', 'selftest.html', 'favicon.svg', 'css', 'fonts', 'js', 'vendor'];

function fail(msg) {
  console.error(`prepare: ${msg}`);
  process.exit(1);
}

function pkgDir(name) {
  try { return dirname(require.resolve(`${name}/package.json`)); } catch { fail(`missing dependency ${name}. Run "npm install" in desktop/.`); }
}

function copyWeb() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const entry of WEB_ENTRIES) {
    const src = join(web, entry);
    if (!existsSync(src)) fail(`web file not found: ${entry}`);
    cpSync(src, join(dist, entry), { recursive: true });
  }
}

function patchLibs() {
  const file = join(dist, 'js/engine/libs.js');
  const src = readFileSync(file, 'utf8');
  const out = src.replace('export const LOCAL_LIBS = false;', 'export const LOCAL_LIBS = true;');
  if (out === src) fail('could not switch js/engine/libs.js to bundled libraries');
  writeFileSync(file, out);
}

function patchCsp() {
  for (const name of readdirSync(dist)) {
    if (!name.endsWith('.html')) continue;
    const file = join(dist, name);
    const src = readFileSync(file, 'utf8');
    if (!src.includes('Content-Security-Policy')) continue;
    const out = src
      .replace(/ https:\/\/cdn\.jsdelivr\.net/g, '')
      .replace("connect-src 'self' blob: data:", "connect-src 'self' blob: data: ipc: http://ipc.localhost");
    if (!out.includes('ipc: http://ipc.localhost')) fail(`could not patch the CSP in ${name}`);
    writeFileSync(file, out);
  }
}

async function bundleLibs() {
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { fail('esbuild is not installed. Run "npm install" in desktop/.'); }
  const vendor = join(dist, 'vendor');
  const duckOut = join(vendor, 'duckdb');
  const hpOut = join(vendor, 'hyparquet');
  mkdirSync(duckOut, { recursive: true });
  mkdirSync(hpOut, { recursive: true });
  const duckDir = pkgDir('@duckdb/duckdb-wasm');
  const bundle = (contents, outfile) => esbuild.build({
    stdin: { contents, resolveDir: desktop, loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'none', outfile, logLevel: 'warning',
  });
  await bundle(`export * from ${JSON.stringify(join(duckDir, 'dist/duckdb-browser.mjs').replace(/\\/g, '/'))};`, join(duckOut, 'duckdb.mjs'));
  for (const f of ['duckdb-mvp.wasm', 'duckdb-eh.wasm', 'duckdb-browser-mvp.worker.js', 'duckdb-browser-eh.worker.js']) {
    const src = join(duckDir, 'dist', f);
    if (!existsSync(src)) fail(`DuckDB file missing: ${f}`);
    cpSync(src, join(duckOut, f));
  }
  await bundle("export * from 'hyparquet';", join(hpOut, 'hyparquet.mjs'));
  await bundle("export * from 'hyparquet-compressors';", join(hpOut, 'hyparquet-compressors.mjs'));
  await bundle("export * from 'hyparquet-writer';", join(hpOut, 'hyparquet-writer.mjs'));
}

function ensureIcons() {
  const icons = join(desktop, 'src-tauri/icons');
  const needed = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico'];
  if (needed.every(f => existsSync(join(icons, f)))) return;
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const r = spawnSync(bin, ['tauri', 'icon', 'app-icon.svg'], { cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !needed.every(f => existsSync(join(icons, f)))) fail('could not generate app icons (npx tauri icon app-icon.svg)');
}

function sizeOf(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    total += s.isDirectory() ? sizeOf(p) : s.size;
  }
  return total;
}

copyWeb();
patchLibs();
patchCsp();
await bundleLibs();
ensureIcons();
console.log(`prepare: desktop/dist ready (${(sizeOf(dist) / 1048576).toFixed(1)} MB, libraries bundled for offline use)`);
