import { Engine } from '../engine/engine.js';
import { migrateStep } from '../core/transforms.js';
import { compileStep } from '../engine/compile.js';
import { withInput } from '../engine/duck.js';
import * as duck from '../engine/duck.js';
import { formatValue } from '../core/types.js';
import { hashString } from '../core/util.js';
import { SAMPLE_SALES_CSV, SAMPLE_REGIONS_CSV } from '../app/samples.js';

const EXTRA = 'id,code,tags,when_txt,amount_txt,flag,name\n1,A-1,"x, y",2026-01-05,"$1,200.50",yes,  ﬁona  smith \n2,B-22,y,03/04/2026,(45),no,ÉLAN\n3,,"z,,w",2026-02-30,12%,maybe,o\'brien-jones\n4,C-3,,5 Mar 2026,abc,Y,straße\n5,A-1,"x",2026-01-05 10:30,7,1,\n';

const CASES = [
  ['trim_clean', 'x', { type: 'trim_clean', data: {} }],
  ['replace whole text', 's', { type: 'replace_values', data: { columns: ['status'], match: 'whole', find: 'Pending', replace: 'Open', caseSensitive: true } }],
  ['replace contains', 's', { type: 'replace_values', data: { columns: ['product'], match: 'contains', find: 'e', replace: '3', caseSensitive: true } }],
  ['replace numeric', 's', { type: 'replace_values', data: { columns: ['quantity'], match: 'whole', find: '2', replace: '20', caseSensitive: true } }],
  ['change_type text→number lenient', 'x', { type: 'change_type', data: { columns: ['amount_txt'], type: 'number', lenient: true } }],
  ['change_type text→integer', 'x', { type: 'change_type', data: { columns: ['amount_txt'], type: 'integer', lenient: true } }],
  ['change_type text→date', 'x', { type: 'change_type', data: { columns: ['when_txt'], type: 'date' } }],
  ['change_type text→datetime DMY', 'x', { type: 'change_type', data: { columns: ['when_txt'], type: 'datetime', dateOrder: 'DMY' } }],
  ['change_type text→boolean', 'x', { type: 'change_type', data: { columns: ['flag'], type: 'boolean' } }],
  ['change_type integer/date→text', 's', { type: 'change_type', data: { columns: ['quantity', 'order_date'], type: 'text' } }],
  ['change_type decimal→text refuses', 's', { type: 'change_type', data: { columns: ['unit_price'], type: 'text' } }, 'refuse'],
  ['change_type number→integer', 's', { type: 'change_type', data: { columns: ['unit_price'], type: 'integer' } }],
  ['change_case upper', 's', { type: 'change_case', data: { columns: ['customer'], mode: 'upper' } }],
  ['change_case proper', 's', { type: 'change_case', data: { columns: ['customer', 'category'], mode: 'proper' } }],
  ['change_case refuses ß', 'x', { type: 'change_case', data: { columns: ['name'], mode: 'upper' } }, 'refuse'],
  ['split each → columns', 'x', { type: 'split_column', data: { column: 'tags', by: 'delimiter', delimiter: ',', at: 'each', mode: 'columns', trimParts: true } }],
  ['split max parts', 'x', { type: 'split_column', data: { column: 'tags', by: 'delimiter', delimiter: ',', at: 'each', mode: 'columns', maxParts: 2, trimParts: true } }],
  ['split first / keep original', 'x', { type: 'split_column', data: { column: 'code', delimiter: '-', at: 'first', mode: 'columns', keepOriginal: true } }],
  ['split last', 'x', { type: 'split_column', data: { column: 'code', delimiter: '-', at: 'last', mode: 'columns' } }],
  ['split → rows', 'x', { type: 'split_column', data: { column: 'tags', delimiter: ',', at: 'each', mode: 'rows', trimParts: true } }],
  ['split infers dates', 'x', { type: 'split_column', data: { column: 'when_txt', delimiter: ' ', at: 'first', mode: 'columns' } }],
  ['join left', 's', { type: 'join', data: { rightSource: 'r', joinType: 'left', keys: [{ left: 'region', right: 'region' }] } }],
  ['join inner + prefix', 's', { type: 'join', data: { rightSource: 'r', joinType: 'inner', keys: [{ left: 'region', right: 'region' }], prefix: 'r_' } }],
  ['join anti', 's', { type: 'join', data: { rightSource: 'r', joinType: 'left_anti', keys: [{ left: 'region', right: 'region' }] } }],
  ['join semi', 's', { type: 'join', data: { rightSource: 'r', joinType: 'left_semi', keys: [{ left: 'region', right: 'region' }] } }],
  ['pivot sum by quantity', 's', { type: 'pivot', data: { onColumn: 'quantity', valueColumn: 'unit_price', fn: 'sum', groupColumns: ['region'] } }],
  ['pivot count fill 0', 's', { type: 'pivot', data: { onColumn: 'quantity', valueColumn: 'order_id', fn: 'count', groupColumns: ['category'], fillZero: true } }],
  ['merge columns skip empty', 's', { type: 'merge_columns', data: { columns: ['customer', 'region', 'quantity'], separator: ' / ', name: 'label', skipEmpty: true } }],
  ['merge columns keep original', 's', { type: 'merge_columns', data: { columns: ['order_date', 'status'], separator: '-', name: 'status', skipEmpty: false, keepOriginal: true } }],
  ['merge decimal refuses', 's', { type: 'merge_columns', data: { columns: ['customer', 'unit_price'], separator: ' ', name: 'x' } }, 'refuse'],
  ['unpivot selected', 's', { type: 'unpivot', data: { mode: 'selected', columns: ['quantity', 'unit_price', 'discount'], nameColumn: 'Attribute', valueColumn: 'Value' } }],
  ['unpivot others keep empty', 'x', { type: 'unpivot', data: { mode: 'others', columns: ['id'], nameColumn: 'Attribute', valueColumn: 'Value', keepEmpty: true } }],
  ...['year', 'quarter', 'month', 'day', 'weekday', 'day_of_year', 'week', 'month_name', 'day_name', 'year_month', 'start_of_week', 'start_of_month', 'end_of_month', 'start_of_quarter', 'start_of_year'].map(p => [`date_part ${p}`, 's', { type: 'date_part', data: { column: 'order_date', part: p, name: p === 'month' ? '' : `${p}_x` } }]),
  ['date_part on text refuses', 'x', { type: 'date_part', data: { column: 'when_txt', part: 'year' } }, 'refuse'],
  ['pivot first', 's', { type: 'pivot', data: { onColumn: 'quantity', valueColumn: 'customer', fn: 'first', groupColumns: ['region'] } }],
];

const list = document.getElementById('list');
const report = (name, ok, msg) => { const li = document.createElement('li'); li.className = 't-item'; li.innerHTML = `<span>${ok ? 'ok' : 'FAIL'}</span><span></span>`; li.children[1].textContent = name; if (msg) { const e = document.createElement('div'); e.className = 'err'; e.textContent = msg; li.appendChild(e); } list.appendChild(li); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${msg ? ' — ' + msg : ''}`); };

const norm = (fields, cols) => ({ fields: fields.map(f => `${f.name}:${f.type}`), rows: (cols[0] || []).map((_, r) => cols.map((c, i) => (c[r] == null ? null : formatValue(c[r], fields[i].type)))) });

async function compileWithProbes(step, srcSql, fields, deps) {
  const cache = new Map();
  for (let guard = 0; guard < 12; guard++) {
    let missing = null;
    const ctx = {
      probe: (p) => { const full = withInput(srcSql, p); if (cache.has(full)) return cache.get(full); missing = missing || full; return null; },
      dep: (id) => deps[id] || null,
    };
    const c = compileStep(step, fields, ctx);
    if (!missing) return c;
    try { const r = await duck.runQuery(missing, { maxRows: 1 }); let v = r.columns[0]?.[0]; if (typeof v === 'string' && /^\[/.test(v)) v = JSON.parse(v); cache.set(missing, v ?? null); } catch (err) { console.log('PROBE ERR ' + err.message.slice(0, 200)); cache.set(missing, null); }
  }
  return null;
}

let pass = 0, total = 0;
try {
  const e = new Engine();
  e.loadText({ id: 's', name: 's.csv', text: SAMPLE_SALES_CSV, format: 'csv' });
  e.loadText({ id: 'r', name: 'r.csv', text: SAMPLE_REGIONS_CSV, format: 'csv' });
  e.loadText({ id: 'x', name: 'x.csv', text: EXTRA, format: 'csv' });
  const base = {};
  for (const id of ['s', 'r', 'x']) {
    e.setQueries({ queries: [{ id, name: id, source: { kind: 'file', sourceId: id }, steps: [] }] });
    const r = e.evaluate({ queryId: id, pageSize: 1e6 });
    const cols = r.fields.map((_, c) => r.page.rows.map(row => row[c]));
    const t = `__parity_${id}`;
    await duck.putColumns(t, r.fields, cols);
    base[id] = { fields: r.fields, sql: `SELECT * FROM ${t}` };
  }
  for (const [name, src, raw, expect] of CASES) {
    total++;
    try {
      const step = { id: 'p', ...migrateStep(raw) };
      e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: src }, steps: [step] }, { id: 'r', name: 'regions', source: { kind: 'file', sourceId: 'r' }, steps: [] }] });
      const js = e.evaluate({ queryId: 'q', pageSize: 1e6 });
      if (js.error || js.fullError) throw new Error('JS: ' + (js.error || js.fullError.message));
      const c = await compileWithProbes(step, base[src].sql, base[src].fields, { r: base.r });
      if (expect === 'refuse') { if (c) throw new Error('compiled but should refuse'); report(name, true); pass++; continue; }
      if (!c) {
        const { MORE } = await import('../engine/compile-sql.js');
        let why = 'did not compile';
        try { const t = new Map(base[src].fields.map(f => [f.name, f.type])); MORE[step.type]?.(step.data, base[src].fields, t, { probe: () => null, dep: () => null }); } catch (x) { why += ': ' + x.message; }
        throw new Error(why);
      }
      const d = await duck.runQuery(withInput(base[src].sql, c.sql));
      const a = norm(js.fields, js.fields.map((_, i) => js.page.rows.map(row => row[i])));
      const b = norm(c.fields, d.columns);
      const A = JSON.stringify(a), B = JSON.stringify(b);
      if (A !== B) {
        let at = ''; if (JSON.stringify(a.fields) !== JSON.stringify(b.fields)) at = `fields js=${a.fields} duck=${b.fields}`; else { const i = a.rows.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(b.rows[k])); at = `rows ${a.rows.length}/${b.rows.length}, first diff #${i}: js=${JSON.stringify(a.rows[i])} duck=${JSON.stringify(b.rows[i])}`; }
        throw new Error(at);
      }
      report(name, true); pass++;
    } catch (err) { report(name, false, err.message); }
  }
} catch (err) { report('setup', false, err.message); }
document.getElementById('score').textContent = `DuckDB parity ${pass}/${total}`;
console.log(`PARITY ${pass}/${total}`);
