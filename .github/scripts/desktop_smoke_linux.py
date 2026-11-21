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
  out.desktop = db.desktop; out.version = db.version; out.ua = navigator.userAgent.slice(0, 160); out.origin = location.origin;
  out.opfsApi = typeof (navigator.storage && navigator.storage.getDirectory);
  const d = db.duck;
  const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);
  try {
    await d.ensureDuck();
    out.engine = d.duckStatus(); out.storage = d.duckStorage();
    const r = await d.runQuery('SELECT version() AS v'); out.duckdb = String(r.columns[0][0]);
  } catch (e) { out.engineErr = String(e.message).slice(0, 300); done(out); return; }
  for (const [k, fmt] of [['copy parquet', 'parquet'], ['copy json', 'json'], ['copy csv', 'csv']]) {
    try {
      const r = await race(d.copyTo("SELECT 1 AS a, 'x' AS b", fmt), 90000);
      if (r === 'TIMEOUT') { out[k] = 'TIMEOUT'; continue; }
      out[k] = 'ok ' + (r.byteLength ?? r.length) + ' bytes, starts "' + Array.from(new Uint8Array(r.buffer ? r : r).slice(0, 4)).map((n) => String.fromCharCode(n)).join('').replace(/[^\x20-\x7e]/g, '?') + '"';
    } catch (e) { out[k] = 'ERR ' + String(e.message).slice(0, 200); }
  }
  for (const [k, sql] of [['to_json', "SELECT to_json({'a': 1}) AS j"], ['json_extract', "SELECT json_extract('{\"a\": 1}', '$.a') AS j"]]) {
    try { await race(d.runQuery(sql), 90000); out[k] = 'ok'; } catch (e) { out[k] = 'ERR ' + String(e.message).slice(0, 200); }
  }
  try { await race(d.ensureExcel(), 90000); out.excel = 'ok'; } catch (e) { out.excel = 'ERR ' + String(e.message).slice(0, 200); }
  const plat = await import('/js/app/platform.js');
  for (const [name, path, fn] of [['probe.csv', '/tmp/probe/big.csv', "read_csv('probe.csv')"], ['probe.parquet', '/tmp/probe/data.parquet', "read_parquet('probe.parquet')"]]) {
    try {
      const rr = await fetch(plat.nativeFileUrl(path), { headers: { Range: 'bytes=0-9' } });
      out['range ' + name] = rr.status + ' "' + (await rr.text()).slice(0, 10).replace(/[^\x20-\x7e]/g, '?') + '"';
    } catch (e) { out['range ' + name] = 'ERR ' + String(e.message).slice(0, 120); }
    try {
      await d.registerUrl(name, plat.nativeFileUrl(path));
      const r = await race(d.runQuery('SELECT count(*) AS n FROM ' + fn), 120000);
      out['duckdb read ' + name] = r === 'TIMEOUT' ? 'TIMEOUT' : 'rows ' + r.columns[0][0];
    } catch (e) { out['duckdb read ' + name] = 'ERR ' + String(e.message).slice(0, 220); }
  }
  done(out);
})().catch((e) => done({ error: String(e && e.message || e).slice(0, 300) }));
"""

CHECKS = [
    ('running as the desktop app', lambda o: o.get('desktop') is True),
    ('DuckDB 2.x engine ready', lambda o: o.get('engine') == 'ready' and str(o.get('duckdb', '')).startswith('v2')),
    ('Parquet export (offline)', lambda o: 'PAR1' in str(o.get('copy parquet'))),
    ('JSON export (offline)', lambda o: str(o.get('copy json')).startswith('ok')),
    ('CSV export', lambda o: str(o.get('copy csv')).startswith('ok')),
    ('to_json (offline)', lambda o: o.get('to_json') == 'ok'),
    ('json_extract (offline)', lambda o: o.get('json_extract') == 'ok'),
    ('Excel extension (offline)', lambda o: o.get('excel') == 'ok'),
    ('ranged read of a CSV from disk', lambda o: str(o.get('range probe.csv')).startswith('206')),
    ('ranged read of a Parquet file from disk', lambda o: str(o.get('range probe.parquet')).startswith('206')),
    ('DuckDB reads 250000 CSV rows from disk', lambda o: o.get('duckdb read probe.csv') == 'rows 250000'),
    ('DuckDB reads 250000 Parquet rows from disk', lambda o: o.get('duckdb read probe.parquet') == 'rows 250000'),
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
        driver.set_script_timeout(300)
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
    print(json.dumps(result, indent=1), flush=True)
    failed = [name for name, ok in CHECKS if not ok(result)]
    for name, ok in CHECKS:
        print(('PASS ' if name not in failed else 'FAIL ') + name, flush=True)
    for name in failed:
        print('::error title=Linux smoke test::' + name, flush=True)
    print('::notice title=Linux storage mode::' + str(result.get('storage')) + ' (OPFS api: ' + str(result.get('opfsApi')) + ')', flush=True)
    sys.exit(1 if failed else 0)


main()
