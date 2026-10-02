const DUCKDB_VERSION = '1.32.0';
const DUCKDB_DENY = new Set(['1.29.2']);
const ESM = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;

let state = null;

export function duckStatus() {
  if (!state) return 'off';
  return state.ready ? 'ready' : 'loading';
}

export function duckVersion() { return DUCKDB_VERSION; }

export async function ensureDuck() {
  if (DUCKDB_DENY.has(DUCKDB_VERSION)) throw new Error('This DuckDB version is blocked.');
  if (state?.ready) return state;
  if (state?.promise) return state.promise;
  state = { ready: false };
  state.promise = (async () => {
    try {
      const duckdb = await import(ESM);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
      const worker = new Worker(workerUrl);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      const conn = await db.connect();
      Object.assign(state, { duckdb, db, conn, ready: true });
      return state;
    } catch (e) {
      state = null;
      throw new Error(`DuckDB could not be loaded from cdn.jsdelivr.net (${e.message || e}).`);
    }
  })();
  return state.promise;
}

export const qi = (n) => `"${String(n).replace(/"/g, '""')}"`;
export const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

const TYPE_TO_DUCK = { integer: 'BIGINT', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', datetime: 'TIMESTAMP', text: 'VARCHAR' };
const NULL_TOKEN = '\\N';

function csvCell(v, t) {
  if (v == null) return NULL_TOKEN;
  if (t === 'date') return new Date(v).toISOString().slice(0, 10);
  if (t === 'datetime') return new Date(v).toISOString().slice(0, 23).replace('T', ' ');
  if (t === 'integer' || t === 'number') return Number.isFinite(v) ? String(v) : NULL_TOKEN;
  if (t === 'boolean') return v ? 'true' : 'false';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

let fileSeq = 0;
export async function putColumns(table, fields, columns, { append = false } = {}) {
  const s = await ensureDuck();
  if (!fields.length) {
    await s.conn.query(`CREATE OR REPLACE TABLE ${qi(table)} AS SELECT NULL AS ${qi('_')} WHERE false`);
    return;
  }
  const n = columns[0]?.length ?? 0;
  const parts = [fields.map(f => '"' + f.name.replace(/"/g, '""') + '"').join(',')];
  for (let r = 0; r < n; r++) {
    let line = '';
    for (let c = 0; c < fields.length; c++) { if (c) line += ','; line += csvCell(columns[c][r], fields[c].type); }
    parts.push(line);
  }
  const fname = `__put_${++fileSeq}.csv`;
  await s.db.registerFileText(fname, parts.join('\n') + '\n');
  const spec = fields.map(f => `${sqlStr(f.name)}: ${sqlStr(TYPE_TO_DUCK[f.type] || 'VARCHAR')}`).join(', ');
  const reader = `read_csv(${sqlStr(fname)}, header=true, delim=',', quote='"', escape='"', nullstr=${sqlStr(NULL_TOKEN)}, columns={${spec}}, auto_detect=false)`;
  try {
    if (append) await s.conn.query(`INSERT INTO ${qi(table)} SELECT * FROM ${reader}`);
    else await s.conn.query(`CREATE OR REPLACE TABLE ${qi(table)} AS SELECT * FROM ${reader}`);
  } finally {
    await s.db.dropFile(fname).catch(() => {});
  }
}

export async function registerFile(name, file) {
  const s = await ensureDuck();
  await s.db.registerFileHandle(name, file, s.duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
}

export async function dropFile(name) {
  if (!state?.ready) return;
  try { await state.db.dropFile(name); } catch {}
}

export function readerFor(name, format) {
  if (format === 'parquet') return `read_parquet(${sqlStr(name)})`;
  if (format === 'jsonl') return `read_json_auto(${sqlStr(name)}, format='newline_delimited')`;
  if (format === 'json') return `read_json_auto(${sqlStr(name)})`;
  if (format === 'tsv') return `read_csv_auto(${sqlStr(name)}, delim='\t', sample_size=20000)`;
  return `read_csv_auto(${sqlStr(name)}, sample_size=20000)`;
}

export async function exec(sql) {
  const s = await ensureDuck();
  return s.conn.query(sql);
}

function arrowType(t) {
  const s = String(t).toLowerCase();
  if (/^(u?int)/.test(s) || /^int</.test(s)) return 'integer';
  if (/float|double|decimal/.test(s)) return 'number';
  if (/bool/.test(s)) return 'boolean';
  if (/timestamp|time/.test(s)) return 'datetime';
  if (/date/.test(s)) return 'date';
  return 'text';
}

function convertBatch(batch, fields) {
  const n = batch.numRows;
  return fields.map((f, i) => {
    const vec = batch.getChildAt(i);
    const out = new Array(n);
    for (let r = 0; r < n; r++) {
      let v = vec ? vec.get(r) : null;
      if (v == null) { out[r] = null; continue; }
      if (typeof v === 'bigint') v = Number(v);
      else if (v instanceof Date) v = v.getTime();
      else if (typeof v === 'object') {
        if (f.type === 'number' || f.type === 'integer') { const x = Number(v.valueOf ? v.valueOf() : v); v = Number.isFinite(x) ? x : null; }
        else v = typeof v.toJSON === 'function' ? JSON.stringify(v.toJSON()) : String(v);
      }
      if (f.type === 'date' && typeof v === 'number' && Math.abs(v) < 1e8) v = v * 86400000;
      if (f.type === 'text' && typeof v !== 'string') v = String(v);
      out[r] = v;
    }
    return out;
  });
}

export async function queryColumns(sql, limit = Infinity) {
  const s = await ensureDuck();
  const res = await s.conn.query(Number.isFinite(limit) ? `SELECT * FROM (${sql}) LIMIT ${Math.floor(limit)}` : sql);
  const fields = res.schema.fields.map(f => ({ name: f.name, type: arrowType(f.type) }));
  const columns = convertBatch(res, fields);
  return { fields, columns, rows: res.numRows };
}

export async function streamColumns(sql, chunkRows, onChunk) {
  const s = await ensureDuck();
  const reader = await s.conn.send(sql);
  let fields = null;
  let buf = null, bufRows = 0;
  const flush = async () => { if (bufRows) { await onChunk(fields, buf); buf = fields.map(() => []); bufRows = 0; } };
  for await (const batch of reader) {
    if (!fields) { fields = batch.schema.fields.map(f => ({ name: f.name, type: arrowType(f.type) })); buf = fields.map(() => []); }
    const cols = convertBatch(batch, fields);
    for (let c = 0; c < cols.length; c++) { const target = buf[c]; for (const v of cols[c]) target.push(v); }
    bufRows += batch.numRows;
    if (bufRows >= chunkRows) await flush();
  }
  if (fields) await flush();
  return fields;
}

export async function countRows(sql) {
  const s = await ensureDuck();
  const res = await s.conn.query(`SELECT COUNT(*) AS n FROM (${sql})`);
  return Number(res.getChildAt(0).get(0));
}

export async function copyTo(sql, format) {
  const s = await ensureDuck();
  const out = `__out_${Date.now()}.${format}`;
  const opt = format === 'parquet' ? '(FORMAT PARQUET, COMPRESSION ZSTD)' : format === 'csv' ? '(FORMAT CSV, HEADER)' : '(FORMAT JSON)';
  await s.conn.query(`COPY (${sql}) TO ${sqlStr(out)} ${opt}`);
  const buf = await s.db.copyFileToBuffer(out);
  await s.db.dropFile(out).catch(() => {});
  return buf;
}

export async function cancelDuck() {
  if (!state?.ready) return false;
  try { return await state.conn.cancelSent(); } catch { return false; }
}

function stripComments(sql) {
  let out = '', i = 0, q = null;
  while (i < sql.length) {
    const c = sql[i];
    if (q) { out += c; if (c === q) { if (sql[i + 1] === q) { out += q; i++; } else q = null; } i++; continue; }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}

function maskQuoted(sql) {
  let out = '', q = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) { if (c === q) { if (sql[i + 1] === q) { out += '  '; i++; continue; } q = null; out += c; continue; } out += ' '; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    out += c;
  }
  return out;
}

const FORBIDDEN = /\b(copy|attach|detach|install|load|pragma|export|import|create|drop|alter|insert|update|delete|truncate|set|reset|call|checkpoint|vacuum|use)\b/i;

export function validateSql(sql) {
  const s = stripComments(String(sql || '')).trim().replace(/;+\s*$/, '').trim();
  if (!s) return { error: 'Write a SELECT query.' };
  const masked = maskQuoted(s);
  if (masked.includes(';')) return { error: 'Only one statement is allowed.' };
  if (!/^\s*(select|with|from|values|pivot|unpivot|\()/i.test(masked)) return { error: 'The query must start with SELECT, WITH, FROM, VALUES, PIVOT or UNPIVOT.' };
  const m = FORBIDDEN.exec(masked);
  if (m) return { error: `“${m[1].toUpperCase()}” is not allowed in a SQL step. Steps are read-only.` };
  if (/\b(read_\w+|glob|parquet_scan|sniff_csv)\s*\(/i.test(masked)) return { error: 'SQL steps cannot read files directly. Use the step input and other queries.' };
  return { sql: s };
}

export function withInput(inputSql, userSql) {
  const m = /^\s*with\s+(recursive\s+)?/i.exec(userSql);
  if (m) return `WITH ${m[1] || ''}input AS (${inputSql}), ${userSql.slice(m[0].length)}`;
  return `WITH input AS (${inputSql}) ${userSql}`;
}

export function tableNameFor(name, taken) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'query';
  if (/^\d/.test(base)) base = 'q_' + base;
  if (base === 'input') base = 'input_query';
  let n = base, i = 2;
  while (taken.has(n)) n = `${base}_${i++}`;
  taken.add(n);
  return n;
}
