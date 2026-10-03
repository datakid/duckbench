const DUCKDB_VERSION = '1.32.0';
const DUCKDB_DENY = new Set(['1.29.2']);
const ESM = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;

let state = null;
let lastError = null;
const listeners = new Set();

export function onDuckStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { for (const fn of listeners) { try { fn(duckStatus()); } catch {} } }

export function duckStatus() {
  if (!state) return lastError ? 'failed' : 'off';
  return state.ready ? 'ready' : 'loading';
}

export function duckVersion() { return state?.engineVersion || DUCKDB_VERSION; }
export function duckError() { return lastError; }

export async function ensureDuck() {
  if (DUCKDB_DENY.has(DUCKDB_VERSION)) throw new Error('This DuckDB version is blocked.');
  if (state?.ready) return state;
  if (state?.promise) return state.promise;
  state = { ready: false };
  lastError = null;
  notify();
  state.promise = (async () => {
    try {
      const duckdb = await import(ESM);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
      const worker = new Worker(workerUrl);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      try { await db.open({ query: { castDecimalToDouble: true, castTimestampToDate: true } }); } catch {}
      const conn = await db.connect();
      let engineVersion = DUCKDB_VERSION;
      try { const v = await conn.query('SELECT version() AS v'); engineVersion = String(v.getChildAt(0).get(0)).replace(/^v/, ''); } catch {}
      Object.assign(state, { duckdb, db, conn, worker, ready: true, engineVersion });
      notify();
      return state;
    } catch (e) {
      lastError = e?.message || String(e);
      state = null;
      notify();
      throw new Error(`DuckDB could not be loaded from cdn.jsdelivr.net (${lastError}).`);
    }
  })();
  return state.promise;
}

export const qi = (n) => `"${String(n).replace(/"/g, '""')}"`;
export const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

const NULL_TOKEN = '\\N';

function duckTypeFor(field, col) {
  if (field.type === 'integer') {
    for (let r = 0; r < col.length; r++) { const v = col[r]; if (v != null && !Number.isSafeInteger(v)) return 'DOUBLE'; }
    return 'BIGINT';
  }
  return { number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', datetime: 'TIMESTAMP', text: 'VARCHAR' }[field.type] || 'VARCHAR';
}

function csvCell(v, dt) {
  if (v == null) return NULL_TOKEN;
  switch (dt) {
    case 'DATE': return Number.isFinite(v) ? new Date(v).toISOString().slice(0, 10) : NULL_TOKEN;
    case 'TIMESTAMP': return Number.isFinite(v) ? new Date(v).toISOString().slice(0, 23).replace('T', ' ') : NULL_TOKEN;
    case 'BIGINT': case 'DOUBLE': return typeof v === 'number' && Number.isFinite(v) ? String(v) : NULL_TOKEN;
    case 'BOOLEAN': return v ? 'true' : 'false';
    default: return '"' + String(v).replace(/"/g, '""') + '"';
  }
}

let fileSeq = 0;
export async function putColumns(table, fields, columns, { append = false } = {}) {
  const s = await ensureDuck();
  if (!fields.length) {
    await s.conn.query(`CREATE OR REPLACE TABLE ${qi(table)} AS SELECT NULL AS ${qi('_')} WHERE false`);
    return;
  }
  const n = columns[0]?.length ?? 0;
  const types = fields.map((f, c) => duckTypeFor(f, columns[c] || []));
  const parts = new Array(n + 1);
  parts[0] = fields.map(f => '"' + f.name.replace(/"/g, '""') + '"').join(',');
  for (let r = 0; r < n; r++) {
    let line = '';
    for (let c = 0; c < fields.length; c++) { if (c) line += ','; line += csvCell(columns[c][r], types[c]); }
    parts[r + 1] = line;
  }
  const fname = `__put_${++fileSeq}.csv`;
  await s.db.registerFileText(fname, parts.join('\n') + '\n');
  const spec = fields.map((f, c) => `${sqlStr(f.name)}: ${sqlStr(types[c])}`).join(', ');
  const reader = `read_csv(${sqlStr(fname)}, header=true, delim=',', quote='"', escape='"', nullstr=${sqlStr(NULL_TOKEN)}, allow_quoted_nulls=false, columns={${spec}}, auto_detect=false)`;
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

export function readerFor(name, format, options = {}) {
  if (format === 'parquet') return `read_parquet(${sqlStr(name)})`;
  if (format === 'jsonl') return `read_json_auto(${sqlStr(name)}, format='newline_delimited')`;
  if (format === 'json') return `read_json_auto(${sqlStr(name)})`;
  const args = [sqlStr(name), 'sample_size=20480'];
  const d = options.delimiter && options.delimiter !== 'auto' ? options.delimiter.replace('\\t', '\t') : (format === 'tsv' ? '\t' : null);
  if (d) args.push(`delim=${sqlStr(d)}`);
  if (options.header === false) args.push('header=false');
  if (Number(options.skipRows) > 0) args.push(`skip=${Math.floor(Number(options.skipRows))}`);
  if (options.detectTypes === false) args.push('all_varchar=true');
  return `read_csv(${args.join(', ')})`;
}

export async function exec(sql) {
  const s = await ensureDuck();
  return s.conn.query(sql);
}

export async function createView(name, sql) { await exec(`CREATE OR REPLACE TEMP VIEW ${qi(name)} AS ${sql}`); }
export async function dropView(name) { try { await exec(`DROP VIEW IF EXISTS ${qi(name)}`); } catch {} }
export async function dropTable(name) { try { await exec(`DROP TABLE IF EXISTS ${qi(name)}`); } catch {} }

export function arrowType(t) {
  const s = String(t).toLowerCase();
  if (s.startsWith('timestamp')) return 'datetime';
  if (s.startsWith('date')) return s.includes('day') ? 'date' : 'datetime';
  if (s.startsWith('time') || s.startsWith('interval') || s.startsWith('duration')) return 'text';
  if (/^u?int/.test(s)) return 'integer';
  if (/^(float|double|decimal)/.test(s)) return 'number';
  if (s.startsWith('bool')) return 'boolean';
  return 'text';
}

function fieldInfo(f) {
  const arrow = String(f.type);
  const scale = f.type?.scale || 0;
  let type = arrowType(arrow);
  if (type === 'number' && /^decimal/i.test(arrow) && scale === 0) type = 'integer';
  return { name: f.name, type, arrow: arrow.toLowerCase(), unit: f.type?.unit, scale };
}

export function decimalFromWords(w, scale = 0) {
  let b = 0n;
  for (let i = w.length - 1; i >= 0; i--) b = (b << 32n) + BigInt(w[i] >>> 0);
  if (w.length && (w[w.length - 1] & 0x80000000)) b -= 1n << BigInt(w.length * 32);
  return Number(b) / 10 ** scale;
}

const TS_TO_MS = [1000, 1, 1 / 1000, 1 / 1e6];
const jsonReplacer = (k, x) => (typeof x === 'bigint' ? (Number.isSafeInteger(Number(x)) ? Number(x) : String(x)) : x);

function fmtTime(v, f) {
  let ms = typeof v === 'bigint' ? Number(v) : Number(v);
  if (f.arrow.includes('micro')) ms = ms / 1000;
  else if (f.arrow.includes('nano')) ms = ms / 1e6;
  else if (f.arrow.includes('<second')) ms = ms * 1000;
  if (!Number.isFinite(ms)) return String(v);
  const d = new Date(Math.round(ms));
  return d.toISOString().slice(11, ms % 1000 ? 23 : 19);
}

export function convertValue(v, f) {
  if (v == null) return null;
  switch (f.type) {
    case 'integer':
      if (typeof v === 'bigint') return Number(v);
      if (ArrayBuffer.isView(v)) return decimalFromWords(v, 0);
      if (typeof v === 'number') return v;
      { const x = Number(v); return Number.isFinite(x) ? x : null; }
    case 'number': {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'bigint') return Number(v);
      if (ArrayBuffer.isView(v)) return decimalFromWords(v, f.scale);
      const x = Number(v);
      return Number.isFinite(x) ? x : null;
    }
    case 'boolean': return !!v;
    case 'date': case 'datetime': {
      let ms;
      if (v instanceof Date) ms = v.getTime();
      else if (typeof v === 'bigint') ms = Number(v) * (f.arrow.startsWith('timestamp') ? TS_TO_MS[f.unit ?? 1] : 1);
      else ms = Number(v);
      if (!Number.isFinite(ms)) return null;
      if (f.type === 'date' && Math.abs(ms) < 1e6) ms *= 86400000;
      return Math.round(ms);
    }
    default: {
      if (typeof v === 'string') return v;
      if (f.arrow.startsWith('time')) return fmtTime(v, f);
      if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
      if (v instanceof Uint8Array) { try { return new TextDecoder('utf-8', { fatal: true }).decode(v); } catch { return Array.from(v, b => b.toString(16).padStart(2, '0')).join(''); } }
      if (typeof v === 'object') {
        try { return JSON.stringify(typeof v.toJSON === 'function' ? v.toJSON() : v, jsonReplacer); } catch { return String(v); }
      }
      return String(v);
    }
  }
}

function convertVector(vec, f, n) {
  if (!vec) return new Array(n).fill(null);
  if ((f.type === 'number' || f.type === 'integer') && !vec.nullCount && !f.arrow.startsWith('decimal') && typeof vec.toArray === 'function') {
    const arr = vec.toArray();
    if (arr && arr.length >= n && typeof arr[0] !== 'object') {
      const out = new Array(n);
      if (typeof arr[0] === 'bigint') for (let r = 0; r < n; r++) out[r] = Number(arr[r]);
      else for (let r = 0; r < n; r++) out[r] = arr[r];
      return out;
    }
  }
  const out = new Array(n);
  for (let r = 0; r < n; r++) out[r] = convertValue(vec.get(r), f);
  return out;
}

function convertBatch(batch, fields, limit = Infinity) {
  const n = Math.min(batch.numRows, limit);
  return fields.map((f, i) => convertVector(batch.getChildAt(i), f, n));
}

export async function runQuery(sql, { maxRows = Infinity } = {}) {
  const s = await ensureDuck();
  const t0 = performance.now();
  const limited = Number.isFinite(maxRows) ? `SELECT * FROM (${sql}) LIMIT ${Math.floor(maxRows) + 1}` : sql;
  const res = await s.conn.query(limited);
  const fields = res.schema.fields.map(fieldInfo);
  const cols = fields.map(() => []);
  let n = 0, truncated = false;
  for (const batch of res.batches) {
    const room = maxRows - n;
    if (room <= 0) { if (batch.numRows) truncated = true; break; }
    const take = Math.min(batch.numRows, room);
    const conv = convertBatch(batch, fields, take);
    for (let c = 0; c < conv.length; c++) { const target = cols[c], src = conv[c]; for (let r = 0; r < src.length; r++) target.push(src[r]); }
    n += take;
    if (batch.numRows > take) { truncated = true; break; }
  }
  return { fields: fields.map(f => ({ name: f.name, type: f.type })), columns: cols, rows: n, truncated, ms: performance.now() - t0 };
}

export async function queryColumns(sql, limit = Infinity) {
  const r = await runQuery(sql, { maxRows: limit });
  return { fields: r.fields, columns: r.columns, rows: r.rows };
}

export async function countRows(sql) {
  const s = await ensureDuck();
  const res = await s.conn.query(`SELECT COUNT(*) AS n FROM (${sql})`);
  return Number(res.getChildAt(0).get(0));
}

const COPY_OPTIONS = {
  parquet: '(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)',
  csv: '(FORMAT CSV, HEADER)',
  json: '(FORMAT JSON, ARRAY true)',
  jsonl: '(FORMAT JSON)',
};

export async function copyTo(sql, format) {
  const s = await ensureDuck();
  const opt = COPY_OPTIONS[format];
  if (!opt) throw new Error(`DuckDB can’t write ${format}.`);
  const out = `__out_${Date.now()}_${++fileSeq}.${format === 'jsonl' ? 'jsonl' : format}`;
  await s.conn.query(`COPY (${sql}) TO ${sqlStr(out)} ${opt}`);
  try { return await s.db.copyFileToBuffer(out); }
  finally { await s.db.dropFile(out).catch(() => {}); }
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

export function maskQuoted(sql) {
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
const START = /^\s*(select|with|from|values|pivot|unpivot|summarize|describe|\()/i;

export function validateSql(sql) {
  const s = stripComments(String(sql || '')).trim().replace(/;+\s*$/, '').trim();
  if (!s) return { error: 'Write a SELECT query.' };
  const masked = maskQuoted(s);
  if (masked.includes(';')) return { error: 'Only one statement is allowed.' };
  if (!START.test(masked)) return { error: 'The query must start with SELECT, WITH, FROM, VALUES, PIVOT, UNPIVOT, SUMMARIZE or DESCRIBE.' };
  const m = FORBIDDEN.exec(masked);
  if (m) return { error: `“${m[1].toUpperCase()}” is not allowed in a SQL step. Steps are read-only.` };
  if (/\b(read_\w+|glob|parquet_scan|parquet_metadata|parquet_schema|sniff_csv|query|query_table|getenv)\s*\(/i.test(masked)) return { error: 'SQL steps cannot read files directly. Use the step input and other queries.' };
  if (/\b(from|join)\s*\(?\s*'/i.test(masked) || /\b(from|join)\s*"[^"]*\.(csv|tsv|txt|parquet|json|jsonl|ndjson|gz|zst)"/i.test(s)) return { error: 'SQL steps cannot read files directly. Use the step input and other queries.' };
  return { sql: s };
}

const META = /^\s*(summarize|describe)\s+/i;

export function referencedNames(sql, names) {
  const masked = maskQuoted(stripComments(String(sql || ''))).toLowerCase();
  const raw = stripComments(String(sql || '')).toLowerCase();
  return names.filter(n => {
    const ln = n.toLowerCase();
    const re = new RegExp(`(^|[^\\w])${ln.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`);
    return re.test(masked) || raw.includes(`"${ln}"`);
  });
}

export function normalizeMeta(userSql) {
  const meta = META.exec(userSql);
  if (!meta) return userSql;
  let rest = userSql.slice(meta[0].length).trim();
  if (/^[\w"]+$/.test(rest)) rest = `SELECT * FROM ${rest}`;
  return `SELECT * FROM (${meta[1].toUpperCase()} ${rest})`;
}

export function withInput(inputSql, userSql) {
  userSql = normalizeMeta(userSql);
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
