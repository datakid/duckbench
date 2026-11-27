import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const web = resolve(desktop, '..');
const dist = join(desktop, 'dist');
const NATIVE = process.argv.includes('--native');
const NATIVE_PLATFORMS = { 'win32-x64': 'windows_amd64', 'linux-x64': 'linux_amd64', 'darwin-arm64': 'osx_arm64', 'darwin-x64': 'osx_amd64' };

const WEB_ENTRIES = ['index.html', 'demo.html', 'tests.html', 'parity.html', 'selftest.html', 'favicon.svg', 'css', 'fonts', 'js', 'vendor'];
const DUCKDB_VERSION = '2.0.0';
const EXTENSIONS = ['excel', 'parquet', 'json'];
const EXTENSION_FILES = ['wasm_eh'].flatMap(p => EXTENSIONS.map(name => ({ p, name, url: `https://extensions.duckdb.org/v${DUCKDB_VERSION}/${p}/${name}.duckdb_extension.wasm` })));

function fail(msg) {
  console.error(`prepare: ${msg}`);
  process.exit(1);
}

function pkgDir(name) {
  for (let dir = desktop; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) break;
  }
  fail(`missing dependency ${name}. Run "npm install" in desktop/.`);
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
  let out = src.replace('export const LOCAL_LIBS = false;', 'export const LOCAL_LIBS = true;');
  if (out === src) fail('could not switch js/engine/libs.js to bundled libraries');
  if (NATIVE) {
    const native = out.replace('export const NATIVE_DUCK = false;', 'export const NATIVE_DUCK = true;');
    if (native === out) fail('could not switch js/engine/libs.js to the native DuckDB engine');
    out = native;
  }
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
      .replace(/ https:\/\/extensions\.duckdb\.org/g, '')
      .replace("connect-src 'self' blob: data:", "connect-src 'self' blob: data: ipc: http://ipc.localhost dbfile: http://dbfile.localhost");
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
  const bundle = (contents, outfile) => esbuild.build({
    stdin: { contents, resolveDir: desktop, loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'none', outfile, logLevel: 'warning',
  });
  if (!NATIVE) {
    const duckDir = pkgDir('@duckdb/duckdb-wasm');
    await bundle(`export * from ${JSON.stringify(join(duckDir, 'dist/duckdb-browser.mjs').replace(/\\/g, '/'))};`, join(duckOut, 'duckdb.mjs'));
    for (const f of ['duckdb-base.wasm', 'duckdb-browser-base.worker.js']) {
      const src = join(duckDir, 'dist', f);
      if (!existsSync(src)) fail(`DuckDB file missing: ${f}`);
      cpSync(src, join(duckOut, f));
    }
  }
  await bundle("export * from 'hyparquet';", join(hpOut, 'hyparquet.mjs'));
  await bundle("export * from 'hyparquet-compressors';", join(hpOut, 'hyparquet-compressors.mjs'));
  await bundle("export * from 'hyparquet-writer';", join(hpOut, 'hyparquet-writer.mjs'));
}

async function bundleExtensions() {
  const out = join(dist, 'vendor/duckdb/extensions');
  for (const { p, name, url } of EXTENSION_FILES) {
    const dir = join(out, `v${DUCKDB_VERSION}`, p);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${name}.duckdb_extension.wasm`);
    if (existsSync(target)) continue;
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) { console.warn(`prepare: could not fetch ${url}; the DuckDB ${name} extension will be unavailable offline`); continue; }
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }
}

async function fetchNativeExtension() {
  const platform = NATIVE_PLATFORMS[`${process.platform}-${process.arch}`];
  if (!platform) fail(`no native DuckDB extension build for ${process.platform}-${process.arch}`);
  const dir = join(desktop, 'src-tauri/native-resources');
  const target = join(dir, 'excel.duckdb_extension');
  mkdirSync(dir, { recursive: true });
  if (existsSync(target) && statSync(target).size > 0) return;
  const url = `https://extensions.duckdb.org/v${DUCKDB_VERSION}/${platform}/excel.duckdb_extension.gz`;
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) fail(`could not download ${url}; the native build bundles the Excel extension so it works offline`);
  const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
  if (!bytes.length) fail(`${url} was empty`);
  writeFileSync(target, bytes);
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
if (NATIVE) await fetchNativeExtension();
else await bundleExtensions();
ensureIcons();
console.log(`prepare: desktop/dist ready (${(sizeOf(dist) / 1048576).toFixed(1)} MB, ${NATIVE ? 'native DuckDB engine' : 'libraries bundled for offline use'})`);
