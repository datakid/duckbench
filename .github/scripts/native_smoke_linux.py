import json
import subprocess
import sys
import time

from selenium import webdriver
from selenium.webdriver.common.options import ArgOptions

APP = sys.argv[1]

JS = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const out = {};
  const db = window.duckbench;
  if (!db) { done({ error: 'no window.duckbench', url: location.href }); return; }
  const d = db.duck;
  out.desktop = db.desktop;
  out.native = d.duckNative();
  const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);
  const attempt = async (key, fn) => { try { out[key] = await race(fn(), 120000); } catch (e) { out[key] = 'ERR ' + String(e.message).slice(0, 240); } };
  try {
    await d.ensureDuck();
    out.engine = d.duckStatus();
    out.storage = d.duckStorage();
    out.version = d.duckVersion();
    const r = await d.runQuery('SELECT version() AS v');
    out.sqlVersion = String(r.columns[0][0]);
  } catch (e) { out.engineErr = String(e.message).slice(0, 300); done(out); return; }
  const plat = await import('/js/app/platform.js');
  const url = (p) => plat.nativeFileUrl(p);
  await attempt('types', async () => {
    const r = await d.runQuery("SELECT 1::BIGINT AS i, 2.5::DOUBLE AS f, DATE '2024-03-05' AS d, TIMESTAMP '2024-03-05 10:20:30.123' AS t, 'héllo' AS s, [1,2] AS l, 9007199254740993::BIGINT AS big");
    return JSON.stringify({ types: r.fields.map((f) => f.type), row: r.columns.map((c) => c[0]) });
  });
  await attempt('copy parquet', async () => { const r = await d.copyTo("SELECT 1 AS a, 'x' AS b", 'parquet'); return String.fromCharCode(...r.slice(0, 4)); });
  await attempt('copy json', async () => { const r = await d.copyTo("SELECT 1 AS a", 'json'); return String.fromCharCode(r[0]); });
  await attempt('copy csv', async () => { const r = await d.copyTo("SELECT 1 AS a, 'x' AS b", 'csv'); return new TextDecoder().decode(r).split('\n')[0]; });
  await attempt('json functions', async () => { const r = await d.runQuery("SELECT to_json({'a': 1}) AS j, json_extract('{\"a\": 7}', '$.a') AS k"); return r.columns.map((c) => c[0]).join('|'); });
  await attempt('excel', async () => {
    await d.ensureExcel();
    await d.registerUrl('probe.xlsx', url('/tmp/probe/book.xlsx'));
    const r = await d.runQuery("SELECT * FROM " + d.readerFor('probe.xlsx', 'excel', {}));
    return JSON.stringify({ names: r.fields.map((f) => f.name), rows: r.rows, first: r.columns[0] });
  });
  await attempt('csv rows', async () => {
    await d.registerUrl('probe.csv', url('/tmp/probe/big.csv'));
    const r = await d.runQuery('SELECT count(*) AS n FROM ' + d.readerFor('probe.csv', 'csv', {}));
    return r.columns[0][0];
  });
  await attempt('parquet rows', async () => {
    await d.registerUrl('probe.parquet', url('/tmp/probe/data.parquet'));
    const r = await d.runQuery('SELECT count(*) AS n FROM ' + d.readerFor('probe.parquet', 'parquet', {}));
    return r.columns[0][0];
  });
  await attempt('json rows', async () => {
    await d.registerUrl('probe.jsonl', url('/tmp/probe/data.jsonl'));
    const r = await d.runQuery('SELECT count(*) AS n FROM ' + d.readerFor('probe.jsonl', 'jsonl', {}));
    return r.columns[0][0];
  });
  await attempt('group by on the file', async () => {
    const src = d.readerFor('probe.csv', 'csv', {});
    const r = await d.runQuery('SELECT id % 10 AS k, count(*) AS n, sum(v) > 0 AS positive FROM ' + src + ' GROUP BY 1 ORDER BY 1');
    return JSON.stringify({ rows: r.rows, n0: r.columns[1][0] });
  });
  await attempt('join of two files', async () => {
    const a = d.readerFor('probe.csv', 'csv', {}), b = d.readerFor('probe.parquet', 'parquet', {});
    return await d.countRows('SELECT a.id FROM ' + a + ' a JOIN ' + b + ' b ON a.id = b.id');
  });
  await attempt('truncated preview', async () => {
    const r = await d.runQuery('SELECT * FROM ' + d.readerFor('probe.csv', 'csv', {}), { maxRows: 1000 });
    return JSON.stringify({ rows: r.rows, truncated: r.truncated });
  });
  await attempt('put columns', async () => {
    await d.putColumns('smoke_put', [{ name: 'a', type: 'integer' }, { name: 'b', type: 'text' }], [[1, 2, 3], ['x', null, 'z"q']]);
    await d.putColumns('smoke_put', [{ name: 'a', type: 'integer' }, { name: 'b', type: 'text' }], [[4], ['w']], { append: true });
    const r = await d.runQuery('SELECT count(*) AS n, count(b) AS nb FROM smoke_put');
    await d.dropTable('smoke_put');
    return r.columns.map((c) => c[0]).join('|');
  });
  await attempt('explain', async () => { const r = await d.explain('SELECT * FROM range(100)', { analyze: true }); return r.text.length > 0 && r.analyze; });
  await attempt('summarize', async () => { const r = await d.runQuery('SELECT * FROM (SUMMARIZE SELECT * FROM ' + d.readerFor('probe.csv', 'csv', {}) + ')', { maxRows: 100 }); return r.rows; });
  await attempt('cancel', async () => {
    const slow = d.runQuery('SELECT sum(hash(a.range * b.range)) FROM range(300000) a, range(300000) b');
    let state = 'running';
    slow.then(() => { state = 'finished'; }, () => { state = 'cancelled'; });
    for (let i = 0; i < 40 && state === 'running'; i++) { await new Promise((r) => setTimeout(r, 250)); await d.cancelDuck(); }
    const after = await d.runQuery('SELECT 42 AS a');
    return state + ':' + after.columns[0][0];
  });
  await attempt('export to a native file', async () => {
    const blob = await d.copyToBlob('SELECT * FROM ' + d.readerFor('probe.csv', 'csv', {}), 'parquet');
    return JSON.stringify({ size: blob.size, path: blob.nativePath, isBlob: blob instanceof Blob });
  });
  await attempt('stage a browser file', async () => {
    const file = new File(['a,b\n1,x\n2,y\n3,z\n'], 'staged.csv');
    await d.registerFile('staged.csv', file);
    const r = await d.runQuery('SELECT count(*) AS n FROM ' + d.readerFor('staged.csv', 'csv', {}));
    await d.dropFile('staged.csv');
    return r.columns[0][0];
  });
  await attempt('arabic round trip', async () => {
    const r = await d.runQuery("SELECT 'مرحبا' AS s, length('مرحبا') AS n");
    return r.columns.map((c) => c[0]).join('|');
  });
  await attempt('error message', async () => { try { await d.runQuery('SELEC 1'); return 'no error'; } catch (e) { return e instanceof Error ? e.message.slice(0, 60) : 'not an Error'; } });
  done(out);
})().catch((e) => done({ error: String(e && e.message || e).slice(0, 300) }));
"""

CHECKS = [
    ('running as the desktop app', lambda o: o.get('desktop') is True),
    ('native engine flag is on', lambda o: o.get('native') is True),
    ('engine ready with native storage', lambda o: o.get('engine') == 'ready' and o.get('storage') == 'native'),
    ('DuckDB 2.x engine', lambda o: str(o.get('sqlVersion', '')).startswith('v2.')),
    ('value types match the web engine', lambda o: o.get('types') == json.dumps({'types': ['integer', 'number', 'date', 'datetime', 'text', 'text', 'text'], 'row': [1, 2.5, 1709596800000, 1709634030123, 'héllo', '[1,2]', '9007199254740993']}, separators=(',', ':'), ensure_ascii=False)),
    ('Parquet export', lambda o: o.get('copy parquet') == 'PAR1'),
    ('JSON export', lambda o: o.get('copy json') == '['),
    ('CSV export', lambda o: o.get('copy csv') == 'a,b'),
    ('JSON functions', lambda o: o.get('json functions') == '{"a":1}|7'),
    ('Excel extension reads an xlsx file offline', lambda o: o.get('excel') == json.dumps({'names': ['Name', 'Qty'], 'rows': 3, 'first': ['alpha', 'beta', 'مرحبا']}, separators=(',', ':'), ensure_ascii=False)),
    ('reads 250000 CSV rows from disk', lambda o: o.get('csv rows') == 250000),
    ('reads 250000 Parquet rows from disk', lambda o: o.get('parquet rows') == 250000),
    ('reads 250000 JSON Lines rows from disk', lambda o: o.get('json rows') == 250000),
    ('group by over a file', lambda o: o.get('group by on the file') == '{"rows":10,"n0":25000}'),
    ('join of a CSV and a Parquet file', lambda o: o.get('join of two files') == 250000),
    ('preview limit truncates', lambda o: o.get('truncated preview') == '{"rows":1000,"truncated":true}'),
    ('put columns creates and appends', lambda o: o.get('put columns') == '4|3'),
    ('explain analyze', lambda o: o.get('explain') is True),
    ('summarize', lambda o: o.get('summarize') == 3),
    ('cancel stops a running query', lambda o: o.get('cancel') == 'cancelled:42'),
    ('export lands in a native file', lambda o: '"isBlob":true' in str(o.get('export to a native file')) and '"size":0' not in str(o.get('export to a native file')) and 'ERR' not in str(o.get('export to a native file'))),
    ('a browser file can be staged', lambda o: o.get('stage a browser file') == 3),
    ('Arabic text round trips', lambda o: o.get('arabic round trip') == 'مرحبا|5'),
    ('errors arrive as Error objects', lambda o: 'syntax error' in str(o.get('error message')) or 'Parser Error' in str(o.get('error message'))),
]


def main():
    driver_proc = subprocess.Popen(['tauri-driver'])
    time.sleep(4)
    result = {}
    try:
        opts = ArgOptions()
        opts.set_capability('browserName', 'wry')
        opts.set_capability('tauri:options', {'application': APP})
        driver = webdriver.Remote(command_executor='http://127.0.0.1:4444', options=opts)
        driver.set_script_timeout(900)
        ready = False
        for _ in range(60):
            try:
                if driver.execute_script('return !!(window.duckbench && window.duckbench.duck)'):
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(2)
        result = driver.execute_async_script(JS) if ready else {'error': 'app did not expose window.duckbench'}
        driver.quit()
    except Exception as e:
        result = {'error': 'driver failure: ' + str(e)[:300]}
    finally:
        driver_proc.terminate()
    print(json.dumps(result, indent=1, ensure_ascii=False), flush=True)
    failed = [name for name, ok in CHECKS if not ok(result)]
    for name, ok in CHECKS:
        print(('PASS ' if name not in failed else 'FAIL ') + name, flush=True)
    for name in failed:
        print('::error title=Native smoke test::' + name, flush=True)
    sys.exit(1 if failed else 0)


main()
