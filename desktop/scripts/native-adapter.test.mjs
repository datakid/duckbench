import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let duck;
let native;
let calls;
let handlers;

function invoke(command, args, options) {
  calls.push({ command, args, options });
  const h = handlers[command];
  if (!h) return Promise.reject(`no handler for ${command}`);
  return Promise.resolve().then(() => h(args, options));
}

const json = (value) => new TextEncoder().encode(JSON.stringify(value)).buffer;

before(async () => {
  globalThis.window = { __TAURI__: { core: { invoke } } };
  const dir = mkdtempSync(join(tmpdir(), 'duckbench-native-'));
  cpSync(join(root, 'js'), join(dir, 'js'), { recursive: true });
  const libs = join(dir, 'js/engine/libs.js');
  const src = readFileSync(libs, 'utf8');
  const out = src.replace('export const NATIVE_DUCK = false;', 'export const NATIVE_DUCK = true;');
  assert.notEqual(out, src, 'libs.js must declare NATIVE_DUCK = false for prepare.mjs to switch');
  writeFileSync(libs, out);
  duck = await import(pathToFileURL(join(dir, 'js/engine/duck.js')).href);
  native = await import(pathToFileURL(join(dir, 'js/engine/duck-native.js')).href);
});

beforeEach(() => {
  calls = [];
  handlers = { duck_init: () => ({ version: 'v2.0.0' }) };
});

test('the source tree keeps the web engine as the default', () => {
  const libs = readFileSync(join(root, 'js/engine/libs.js'), 'utf8');
  assert.match(libs, /export const NATIVE_DUCK = false;/);
});

test('starting the engine reports the native version and storage', async () => {
  const seen = [];
  duck.onDuckStatus((s) => seen.push(s));
  await duck.ensureDuck();
  assert.equal(duck.duckStatus(), 'ready');
  assert.equal(duck.duckVersion(), '2.0.0');
  assert.equal(duck.duckStorage(), 'native');
  assert.equal(duck.duckNative(), true);
  assert.equal(duck.opfsAvailable(), false);
  assert.ok(seen.includes('ready'));
});

test('runQuery sends the sql and the row limit and returns the parsed result', async () => {
  const result = { fields: [{ name: 'a', type: 'integer' }], columns: [[1, 2]], rows: 2, truncated: false, ms: 1 };
  handlers.duck_query = () => json(result);
  assert.deepEqual(await duck.runQuery('SELECT 1', { maxRows: 5 }), result);
  const q = calls.find((c) => c.command === 'duck_query');
  assert.deepEqual(q.args, { sql: 'SELECT 1', maxRows: 5 });
  await duck.runQuery('SELECT 2');
  assert.deepEqual(calls.filter((c) => c.command === 'duck_query')[1].args, { sql: 'SELECT 2', maxRows: null });
});

test('schemaOf, countRows and explain use their own commands', async () => {
  handlers.duck_schema = () => json({ fields: [{ name: 'a', type: 'text' }], columns: [[]], rows: 0, truncated: false, ms: 0 });
  handlers.duck_count = () => 41;
  handlers.duck_plan = ({ sql }) => (sql.includes('FORMAT JSON') ? ['{"latency":0.1,"children":[]}'] : ['SEQ_SCAN', 'x']);
  assert.deepEqual(await duck.schemaOf('SELECT 1'), [{ name: 'a', type: 'text' }]);
  assert.equal(await duck.countRows('SELECT 1'), 41);
  const plain = await duck.explain('SELECT 1');
  assert.equal(plain.text, 'SEQ_SCAN\nx');
  assert.equal(plain.timings, null);
  const analyzed = await duck.explain('SELECT 1', { analyze: true });
  assert.equal(analyzed.analyze, true);
  assert.ok(calls.some((c) => c.command === 'duck_plan' && c.args.sql === 'EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1'));
});

test('registerUrl turns the local file url into a path', async () => {
  handlers.duck_register = () => null;
  await duck.registerUrl('sales.csv', 'http://dbfile.localhost/' + encodeURIComponent('C:\\Users\\Ali Ahmad\\مبيعات 2024.csv'));
  await duck.registerUrl('b.csv', 'dbfile://localhost/' + encodeURIComponent('/home/ali/o\'brien.csv'));
  const regs = calls.filter((c) => c.command === 'duck_register').map((c) => c.args);
  assert.deepEqual(regs, [
    { name: 'sales.csv', path: 'C:\\Users\\Ali Ahmad\\مبيعات 2024.csv' },
    { name: 'b.csv', path: "/home/ali/o'brien.csv" },
  ]);
  await assert.rejects(() => duck.registerUrl('x.csv', 'not a url'), /from disk/);
});

test('pathFromUrl handles odd input', () => {
  assert.equal(native.pathFromUrl('dbfile://localhost/'), null);
  assert.equal(native.pathFromUrl(''), null);
  assert.equal(native.pathFromUrl('dbfile://localhost/%E0%A4%A'), null);
});

test('registerFile stages a file without a path in chunks', async () => {
  handlers.duck_stage = () => null;
  const slices = [];
  const file = {
    size: 70 * 1024 * 1024,
    slice(a, b) {
      slices.push([a, b]);
      return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    },
  };
  await duck.registerFile('big.csv', file);
  const stages = calls.filter((c) => c.command === 'duck_stage');
  assert.equal(stages.length, 3);
  assert.deepEqual(stages.map((c) => c.options.headers.append), ['0', '1', '1']);
  assert.ok(stages.every((c) => c.options.headers.name === 'big.csv'));
  assert.deepEqual(slices[1], [32 * 1024 * 1024, 64 * 1024 * 1024]);
  calls.length = 0;
  await duck.registerFile('empty.csv', new File([], 'empty.csv'));
  assert.equal(calls.filter((c) => c.command === 'duck_stage').length, 1);
});

test('putColumns stages a csv, runs the statement and drops the file', async () => {
  handlers.duck_stage = () => null;
  handlers.duck_exec = () => null;
  handlers.duck_drop_file = () => null;
  await duck.putColumns('t1', [{ name: 'a', type: 'integer' }, { name: 'b', type: 'text' }], [[1, 2], ['x', 'y"z']]);
  const order = calls.filter((c) => c.command !== 'duck_init').map((c) => c.command);
  assert.deepEqual(order, ['duck_stage', 'duck_exec', 'duck_drop_file']);
  const staged = calls.find((c) => c.command === 'duck_stage');
  assert.equal(new TextDecoder().decode(staged.args), '"a","b"\n1,"x"\n2,"y""z"\n');
  const exec = calls.find((c) => c.command === 'duck_exec').args.sql;
  assert.match(exec, /^CREATE OR REPLACE TABLE "t1" AS SELECT \* FROM read_csv\('__put_\d+\.csv'/);
  assert.match(exec, /columns=\{'a': 'BIGINT', 'b': 'VARCHAR'\}/);
});

test('putColumns drops the staged file even when the statement fails', async () => {
  handlers.duck_stage = () => null;
  handlers.duck_exec = () => { throw 'Conversion Error: nope'; };
  handlers.duck_drop_file = () => null;
  await assert.rejects(() => duck.putColumns('t2', [{ name: 'a', type: 'integer' }], [[1]]), /Conversion Error: nope/);
  assert.ok(calls.some((c) => c.command === 'duck_drop_file'));
});

test('engine failures surface as Error objects', async () => {
  handlers.duck_query = () => { throw 'Binder Error: no such column'; };
  await assert.rejects(() => duck.runQuery('SELECT x'), (e) => e instanceof Error && /Binder Error/.test(e.message));
});

test('copyTo returns bytes and copyToBlob returns a native file blob', async () => {
  handlers.duck_copy_bytes = () => new Uint8Array([80, 65, 82, 49]).buffer;
  handlers.duck_copy_file = () => ({ path: 'C:\\tmp\\export-1.parquet', size: 1234 });
  const bytes = await duck.copyTo('SELECT 1', 'parquet');
  assert.deepEqual(Array.from(bytes), [80, 65, 82, 49]);
  const blob = await duck.copyToBlob('SELECT 1', 'parquet');
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, 1234);
  assert.equal(blob.nativePath, 'C:\\tmp\\export-1.parquet');
  await assert.rejects(() => duck.copyToBlob('SELECT 1', 'xlsx'), /can’t write xlsx/);
});

test('ensureExcel loads the bundled extension once', async () => {
  handlers.duck_load_excel = () => null;
  await duck.ensureExcel();
  await duck.ensureExcel();
  assert.equal(calls.filter((c) => c.command === 'duck_load_excel').length, 1);
});

test('cancelDuck asks the engine to interrupt', async () => {
  await duck.ensureDuck();
  handlers.duck_cancel = () => true;
  assert.equal(await duck.cancelDuck(), true);
  handlers.duck_cancel = () => { throw 'gone'; };
  assert.equal(await duck.cancelDuck(), false);
});

test('dropFile forwards to the engine and ignores failures', async () => {
  await duck.ensureDuck();
  handlers.duck_drop_file = () => { throw 'gone'; };
  await duck.dropFile('a.csv');
  assert.ok(calls.some((c) => c.command === 'duck_drop_file' && c.args.name === 'a.csv'));
});

test('without the desktop bridge the adapter explains itself', async () => {
  const saved = globalThis.window;
  globalThis.window = {};
  await assert.rejects(() => native.init(), /Duckbench Native desktop app/);
  globalThis.window = saved;
});
