import { Frame } from '../core/frame.js';
import { TRANSFORMS, migrateStep, validateStep } from '../core/transforms.js';
import { parseCSV, decodeBuffer, rowsToColumns, csvEscape, sniffDelimiter } from '../core/csv.js';
import { columnQuality, profileColumn, distinctValues } from '../core/profile.js';
import { formatValue, convertValue } from '../core/types.js';
import { hashString, dedupeNames, now } from '../core/util.js';

const CACHE_LIMIT = 64;

export class Engine {
  constructor() {
    this.sources = new Map();
    this.queries = new Map();
    this.cache = new Map();
    this.results = new Map();
    this.resultSeq = 0;
  }

  ping() { return { ok: true, at: Date.now() }; }

  loadText({ id, name, text, buffer, format, options = {} }) {
    const t0 = now();
    let encoding = 'utf-8';
    if (text == null) { const dec = decodeBuffer(buffer, options.encoding || 'auto'); text = dec.text; encoding = dec.encoding; }
    let frame, detected = {};
    if (format === 'json' || format === 'jsonl') {
      frame = parseJsonText(text, format, options);
    } else {
      const delimiter = options.delimiter && options.delimiter !== 'auto' ? options.delimiter.replace('\\t', '\t') : (format === 'tsv' ? '\t' : sniffDelimiter(text));
      const { rows } = parseCSV(text, { delimiter });
      const header = options.header !== false;
      const skip = Math.max(0, Number(options.skipRows) || 0);
      const { names, cols } = rowsToColumns(rows, { header, skipRows: skip });
      frame = Frame.fromText(dedupeNames(names), cols, { infer: options.detectTypes !== false });
      detected = { delimiter };
    }
    return this._storeSource(id, name, format, frame, { ...detected, encoding, ms: now() - t0 });
  }

  loadColumns({ id, name, format, names, columns, types, options = {} }) {
    const t0 = now();
    const dn = dedupeNames(names);
    let frame;
    if (types) frame = new Frame(dn.map((n, i) => ({ name: n, type: types[i] || 'text' })), columns, columns[0]?.length ?? 0);
    else frame = Frame.fromText(dn, columns.map(c => c.map(v => (v == null ? null : typeof v === 'string' ? v : String(v)))), { infer: options.detectTypes !== false });
    if (types && options.detectTypes !== false) frame = frame.autoType();
    return this._storeSource(id, name, format, frame, { ms: now() - t0 });
  }

  _storeSource(id, name, format, frame, meta) {
    const prev = this.sources.get(id);
    const gen = (prev?.gen || 0) + 1;
    this.sources.set(id, { id, name, format, frame: frame.withRid(), gen });
    this.invalidate();
    return { id, name, format, rowCount: frame.rowCount, fields: frame.fields, ...meta };
  }

  peekText({ text, buffer, format, options = {} }) {
    if (text == null) text = decodeBuffer(buffer, options.encoding || 'auto').text;
    if (format === 'json' || format === 'jsonl') {
      const f = parseJsonText(text.length > 2e6 && format === 'jsonl' ? text.slice(0, text.indexOf('\n', 1e6) + 1 || 2e6) : text, format, options);
      return { fields: f.fields, rows: f.rows(0, 30).map(r => r.map((v, i) => formatValue(v, f.fields[i].type))), rowCount: f.rowCount };
    }
    const sample = text.slice(0, 256 * 1024);
    const delimiter = options.delimiter && options.delimiter !== 'auto' ? options.delimiter.replace('\\t', '\t') : (format === 'tsv' ? '\t' : sniffDelimiter(sample));
    const { rows } = parseCSV(sample, { delimiter, maxRows: 60 + (Number(options.skipRows) || 0) });
    const { names, cols } = rowsToColumns(rows, { header: options.header !== false, skipRows: Number(options.skipRows) || 0 });
    const f = Frame.fromText(dedupeNames(names), cols, { infer: options.detectTypes !== false });
    return { delimiter, fields: f.fields, rows: f.rows(0, 30).map(r => r.map((v, i) => formatValue(v, f.fields[i].type))) };
  }

  removeSource({ id }) { this.sources.delete(id); this.invalidate(); return true; }

  setQueries({ queries }) {
    this.queries = new Map(queries.map(q => [q.id, { ...q, steps: (q.steps || []).map(s => (s.unsupported ? s : s)) }]));
    return true;
  }

  invalidate() { this.cache.clear(); this.results.clear(); }

  sourceInfo() { return [...this.sources.values()].map(s => ({ id: s.id, name: s.name, format: s.format, rowCount: s.frame.rowCount, fields: s.frame.fields })); }

  _baseFor(q, stack) {
    const src = q.source || {};
    if (src.kind === 'reference') {
      const parent = this.queries.get(src.parentId);
      if (!parent) throw new Error('The query this one references no longer exists.');
      const r = this._run(parent, parent.steps.length - 1, null, stack);
      if (r.error) throw new Error(`The referenced query “${parent.name}” has an error: ${r.error}`);
      return { frame: r.frame, key: r.key };
    }
    if (src.kind === 'blank') {
      const f = Frame.fromText(src.names || ['Column1'], (src.names || ['Column1']).map(() => []), { infer: false });
      return { frame: f.withRid(), key: 'blank:' + hashString(JSON.stringify(src.names || [])) };
    }
    const s = this.sources.get(src.sourceId);
    if (!s) throw new Error('This query’s data file is not loaded. Use “Locate file…” to reconnect it.');
    return { frame: s.frame, key: `src:${s.id}:${s.gen}` };
  }

  _run(q, upto, override, stack = []) {
    if (stack.includes(q.id)) throw new Error(`Circular reference: ${[...stack, q.id].map(id => this.queries.get(id)?.name || id).join(' → ')}`);
    stack = [...stack, q.id];
    const diag = [];
    let base;
    try { base = this._baseFor(q, stack); } catch (e) { return { error: e.message, errorIndex: -1, diag, frame: null, key: null }; }
    let frame = base.frame;
    let key = base.key;
    const steps = q.steps;
    const last = Math.min(upto, steps.length - 1);
    let errorIndex = -1, error = null;
    for (let i = 0; i <= last; i++) {
      let step = steps[i];
      if (override && override.index === i) step = override.step;
      if (override && override.insertAt === i) {
        const r = this._applyStep(q, { ...override.step, _draft: true }, frame, key, stack);
        diag.push({ ...r.diag, draft: true });
        if (r.error) return { error: r.error, errorIndex: i, diag, frame, key, draftError: true };
        frame = r.frame; key = r.key;
      }
      if (!step) continue;
      if (step.disabled) { diag.push({ disabled: true, rows: frame.rowCount, cols: frame.fields.length }); continue; }
      if (error) { diag.push({ blocked: true }); continue; }
      const r = this._applyStep(q, step, frame, key, stack);
      diag.push(r.diag);
      if (r.error) { error = r.error; errorIndex = i; continue; }
      frame = r.frame; key = r.key;
    }
    if (override && override.insertAt === last + 1 && !error) {
      const r = this._applyStep(q, { ...override.step, _draft: true }, frame, key, stack);
      diag.push({ ...r.diag, draft: true });
      if (r.error) return { error: r.error, errorIndex: last + 1, diag, frame, key, draftError: true };
      frame = r.frame; key = r.key;
    }
    return { frame, key, diag, error, errorIndex };
  }

  _applyStep(q, step, frame, prevKey, stack) {
    const t = TRANSFORMS[step.type];
    const depKeys = [];
    if (t?.deps) {
      for (const dep of t.deps(step.data || {})) {
        const dq = this.queries.get(dep);
        if (!dq) return { error: `The query this step uses no longer exists.`, diag: { error: 'Missing query' } };
        if (dep === q.id) return { error: 'A query can’t combine with itself — reference it first.', diag: { error: 'Self reference' } };
        try {
          const r = this._run(dq, dq.steps.length - 1, null, stack);
          if (r.error) return { error: `“${dq.name}” has an error: ${r.error}`, diag: { error: r.error } };
          depKeys.push(r.key);
        } catch (e) { return { error: e.message, diag: { error: e.message } }; }
      }
    }
    const key = prevKey + '>' + hashString(JSON.stringify([step.type, step.data, depKeys]));
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); this.cache.set(key, hit);
      return { frame: hit.frame, key, diag: { ...hit.diag, cached: true } };
    }
    const messages = { info: [], warn: [] };
    const t0 = now();
    try {
      if (!t || step.unsupported) throw new Error(`“${step.type}” isn't available in Duckbench 2 — remove or replace this step.`);
      const ctxCols = frame.names;
      const verr = validateStep(step, { columns: ctxCols });
      if (verr) throw new Error(verr);
      const ctx = {
        info: (m) => messages.info.push(m),
        warn: (m) => { if (messages.warn.length < 8) messages.warn.push(m); },
        query: (id) => { const dq = this.queries.get(id); const r = this._run(dq, dq.steps.length - 1, null, stack); if (r.error) throw new Error(r.error); return r.frame; },
        queryName: (id) => this.queries.get(id)?.name || id,
        selfName: q.name,
      };
      if ((step.type === 'delete_rows' || step.type === 'edit_cells') && !frame.rid) throw new Error('Row edits need the original rows — move this step before any grouping, pivot or join.');
      const out = t.apply(frame, step.data || {}, ctx);
      const ms = now() - t0;
      const prevNames = new Map(frame.fields.map(f => [f.name, f.type]));
      const changed = out.fields.filter(f => prevNames.get(f.name) !== f.type).map(f => f.name);
      const diag = { rows: out.rowCount, cols: out.fields.length, ms, prevRows: frame.rowCount, prevCols: frame.fields.length, info: messages.info, warn: messages.warn, changed };
      this._cachePut(key, { frame: out, diag });
      return { frame: out, key, diag };
    } catch (e) {
      return { error: e.message || String(e), diag: { error: e.message || String(e), ms: now() - t0 } };
    }
  }

  _cachePut(key, v) {
    this.cache.set(key, v);
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
  }

  evaluate({ queryId, stepIndex, override, pageSize = 200 }) {
    const q = this.queries.get(queryId);
    if (!q) return { error: 'No such query.' };
    const t0 = now();
    const full = this._run(q, q.steps.length - 1, override?.full ? override : null);
    let view = full;
    const target = stepIndex == null ? q.steps.length - 1 : stepIndex;
    if (override && !override.full) view = this._run(q, target, override);
    else if (target < q.steps.length - 1) view = this._run(q, target, null);
    let frame = view.frame;
    let viewError = null;
    const failedAtView = view.error && (view.errorIndex <= target || view.draftError);
    if (failedAtView) viewError = { message: view.error, index: view.errorIndex, draft: !!view.draftError };
    if (!frame) return { error: view.error, errorIndex: view.errorIndex, diag: full.diag, sourceError: view.errorIndex === -1 };
    const id = `r${++this.resultSeq}`;
    this.results.set(id, frame);
    if (this.results.size > 12) this.results.delete(this.results.keys().next().value);
    const viewDiag = view.diag;
    const changed = override ? (viewDiag[viewDiag.length - 1]?.changed || []) : (viewDiag[target]?.changed || []);
    return {
      resultId: id,
      rowCount: frame.rowCount,
      fields: frame.fields,
      hasRid: !!frame.rid,
      quality: columnQuality(frame),
      page: this._page(frame, 0, pageSize),
      diag: full.diag,
      viewDiag: override ? viewDiag : null,
      viewError,
      fullError: full.error ? { message: full.error, index: full.errorIndex } : null,
      changed,
      bytes: frame.estimateBytes(),
      ms: now() - t0,
    };
  }

  _page(frame, start, end) {
    const s = Math.max(0, start), e = Math.min(frame.rowCount, end);
    const rows = [];
    for (let r = s; r < e; r++) rows.push(frame.columns.map(c => c[r]));
    return { start: s, rows, rids: frame.rid ? frame.rid.slice(s, e) : null };
  }

  rows({ resultId, start, end }) {
    const f = this.results.get(resultId);
    if (!f) return { expired: true };
    return this._page(f, start, end);
  }

  profile({ resultId, column }) {
    const f = this.results.get(resultId);
    if (!f) return { expired: true };
    return profileColumn(f, column);
  }

  distinct({ resultId, column, search, limit }) {
    const f = this.results.get(resultId);
    if (!f) return { expired: true };
    return distinctValues(f, column, { search, limit });
  }

  queryColumns({ queryId }) {
    const q = this.queries.get(queryId);
    if (!q) return { fields: [] };
    try {
      const r = this._run(q, q.steps.length - 1, null);
      return { fields: r.frame?.fields || [], error: r.error };
    } catch (e) { return { fields: [], error: e.message }; }
  }

  findRows({ resultId, text, column, limit = 1000 }) {
    const f = this.results.get(resultId);
    if (!f) return { expired: true };
    const needle = String(text || '').toLowerCase();
    if (!needle) return { matches: [] };
    const cols = column ? [f.indexOf(column)] : f.fields.map((_, i) => i);
    const out = [];
    for (let r = 0; r < f.rowCount && out.length < limit; r++) {
      for (const c of cols) {
        const v = f.columns[c][r];
        if (v != null && formatValue(v, f.fields[c].type).toLowerCase().includes(needle)) { out.push([r, c]); }
      }
    }
    return { matches: out, truncated: out.length >= limit };
  }

  exportData({ resultId, queryId, stepIndex, format, columns, nullText = '', delimiter = ',', bom = true, guard = true, rowStart = 0, rowEnd = Infinity, headers = true }) {
    let f = resultId ? this.results.get(resultId) : null;
    if (!f) {
      const q = this.queries.get(queryId);
      const r = this._run(q, stepIndex ?? q.steps.length - 1, null);
      if (r.error && !r.frame) throw new Error(r.error);
      f = r.frame;
    }
    if (columns?.length) f = f.select(columns.filter(c => f.has(c)));
    if (rowStart > 0 || rowEnd < f.rowCount) f = f.slice(rowStart, Math.min(rowEnd, f.rowCount));
    const fields = f.fields;
    if (format === 'csv' || format === 'tsv') {
      const d = format === 'tsv' ? '\t' : delimiter.replace('\\t', '\t');
      const lines = [];
      if (headers) lines.push(fields.map(x => csvEscape(x.name, d, guard)).join(d));
      for (let r = 0; r < f.rowCount; r++) {
        let line = '';
        for (let c = 0; c < fields.length; c++) {
          const v = f.columns[c][r];
          if (c) line += d;
          line += v == null ? csvEscape(nullText, d, false) : csvEscape(formatValue(v, fields[c].type), d, guard && fields[c].type === 'text');
        }
        lines.push(line);
      }
      return { text: (bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n', mime: 'text/csv', rows: f.rowCount };
    }
    if (format === 'json' || format === 'jsonl') {
      const toVal = (v, t) => (v == null ? null : t === 'date' || t === 'datetime' ? formatValue(v, t) : v);
      const objs = [];
      for (let r = 0; r < f.rowCount; r++) { const o = {}; for (let c = 0; c < fields.length; c++) o[fields[c].name] = toVal(f.columns[c][r], fields[c].type); objs.push(o); }
      const text = format === 'json' ? JSON.stringify(objs, null, 2) : objs.map(o => JSON.stringify(o)).join('\n') + '\n';
      return { text, mime: format === 'json' ? 'application/json' : 'application/x-ndjson', rows: f.rowCount };
    }
    if (format === 'markdown') {
      const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const lines = ['| ' + fields.map(x => esc(x.name)).join(' | ') + ' |', '| ' + fields.map(x => (x.type === 'integer' || x.type === 'number' ? '---:' : '---')).join(' | ') + ' |'];
      for (let r = 0; r < f.rowCount; r++) lines.push('| ' + fields.map((x, c) => esc(f.columns[c][r] == null ? nullText : formatValue(f.columns[c][r], x.type))).join(' | ') + ' |');
      return { text: lines.join('\n') + '\n', mime: 'text/markdown', rows: f.rowCount };
    }
    if (format === 'sql') {
      const table = 'data';
      const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';
      const lit = (v, t) => (v == null ? 'NULL' : t === 'integer' || t === 'number' ? String(v) : t === 'boolean' ? (v ? 'TRUE' : 'FALSE') : "'" + formatValue(v, t).replace(/'/g, "''") + "'");
      const lines = [];
      for (let r = 0; r < f.rowCount; r++) lines.push(`INSERT INTO ${table} (${fields.map(x => qi(x.name)).join(', ')}) VALUES (${fields.map((x, c) => lit(f.columns[c][r], x.type)).join(', ')});`);
      return { text: lines.join('\n') + '\n', mime: 'application/sql', rows: f.rowCount };
    }
    if (format === 'columns') {
      return { fields, columns: f.columns, rows: f.rowCount };
    }
    throw new Error(`Unknown export format ${format}`);
  }

  runSteps({ frameFrom, steps }) {
    const q = { id: '__batch', name: 'batch', source: { kind: 'file', sourceId: frameFrom }, steps: steps.map(migrateStep) };
    this.queries.set(q.id, q);
    try {
      const r = this._run(q, q.steps.length - 1, null);
      if (r.error) return { error: r.error, errorIndex: r.errorIndex };
      const id = `r${++this.resultSeq}`;
      this.results.set(id, r.frame);
      return { resultId: id, rowCount: r.frame.rowCount };
    } finally { this.queries.delete(q.id); }
  }
}

function parseJsonText(text, format, options) {
  let objs;
  if (format === 'jsonl') {
    objs = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      try { objs.push(JSON.parse(l)); } catch { throw new Error(`Line ${i + 1} isn't valid JSON.`); }
    }
  } else {
    let data;
    try { data = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch (e) { throw new Error('This file isn’t valid JSON: ' + e.message); }
    if (!Array.isArray(data)) {
      const arr = data && typeof data === 'object' ? Object.values(data).find(v => Array.isArray(v) && v.length && typeof v[0] === 'object') : null;
      if (arr) data = arr;
      else if (data && typeof data === 'object') data = [data];
      else throw new Error('Expected an array of objects.');
    }
    objs = data;
  }
  if (objs.length && Array.isArray(objs[0])) {
    const [head, ...rest] = objs;
    objs = rest.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  objs = objs.map(o => (o && typeof o === 'object' && !Array.isArray(o) ? (options.flatten !== false ? flatten(o) : o) : { value: o }));
  let f = Frame.fromObjects(objs);
  const textCols = f.fields.map((fl, i) => (fl.type === 'text' ? i : -1)).filter(i => i >= 0);
  if (textCols.length && options.detectTypes !== false) {
    const fields = f.fields.map(x => ({ ...x }));
    const cols = f.columns.slice();
    const tmp = new Frame(textCols.map(i => ({ ...fields[i] })), textCols.map(i => cols[i]), f.rowCount).autoType();
    textCols.forEach((i, k) => {
      const nt = tmp.fields[k].type;
      if (nt === 'date' || nt === 'datetime') { fields[i] = tmp.fields[k]; cols[i] = tmp.columns[k]; }
    });
    f = new Frame(fields, cols, f.rowCount);
  }
  return f;
}

function flatten(o, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatten(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

export const ENGINE_METHODS = ['ping', 'loadText', 'loadColumns', 'peekText', 'removeSource', 'setQueries', 'sourceInfo', 'evaluate', 'rows', 'profile', 'distinct', 'queryColumns', 'findRows', 'exportData', 'runSteps', 'invalidate'];
