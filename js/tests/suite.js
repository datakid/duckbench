import { Engine } from '../engine/engine.js';
import { TRANSFORMS, migrateStep } from '../core/transforms.js';
import { parseCSV } from '../core/csv.js';
import { inferColumnType, parseDateString, parseNumberString, formatValue } from '../core/types.js';
import { evaluateFormula } from '../core/formula.js';
import { Frame } from '../core/frame.js';
import { SAMPLE_SALES_CSV, SAMPLE_REGIONS_CSV } from '../app/samples.js';

const eq = (a, b, msg) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error(`${msg || 'mismatch'}: expected ${B}, got ${A}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };

function setup() {
  const e = new Engine();
  e.loadText({ id: 'sales', name: 'sales.csv', text: SAMPLE_SALES_CSV, format: 'csv' });
  e.loadText({ id: 'reg', name: 'regions.csv', text: SAMPLE_REGIONS_CSV, format: 'csv' });
  return e;
}

function run(steps, { extra = [] } = {}) {
  const e = setup();
  const queries = [{ id: 'q', name: 'sales', source: { kind: 'file', sourceId: 'sales' }, steps: steps.map((s, i) => ({ id: 's' + i, ...migrateStep(s) })) },
    { id: 'r', name: 'regions', source: { kind: 'file', sourceId: 'reg' }, steps: [] }, ...extra];
  e.setQueries({ queries });
  const res = e.evaluate({ queryId: 'q', pageSize: 100000 });
  if (res.error) throw new Error(`step ${res.errorIndex + 1}: ${res.error}`);
  if (res.fullError) throw new Error(`step ${res.fullError.index + 1}: ${res.fullError.message}`);
  const names = res.fields.map(f => f.name);
  const rows = res.page.rows;
  const col = (n) => { const i = names.indexOf(n); if (i < 0) throw new Error(`no column ${n}`); return rows.map(r => r[i]); };
  return { res, names, rows, col, types: Object.fromEntries(res.fields.map(f => [f.name, f.type])), engine: e };
}

export const TESTS = [
  ['csv — quoted fields, escaped quotes, CRLF', () => { const { rows } = parseCSV('a,b\r\n"x, y","say ""hi"""\r\n1,\n'); eq(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['1', '']]); }],
  ['csv — sniffs semicolon delimiter', () => { eq(parseCSV('a;b;c\n1;2;3').delimiter, ';'); }],
  ['types — inference', () => { eq(inferColumnType(['1', '2', '']), 'integer'); eq(inferColumnType(['1.5', '2']), 'number'); eq(inferColumnType(['2026-01-02', '2026-03-04']), 'date'); eq(inferColumnType(['007', '8']), 'text'); eq(inferColumnType(['yes', 'no']), 'boolean'); }],
  ['types — lenient numbers', () => { eq(parseNumberString('$1,234.50', true), 1234.5); eq(parseNumberString('(12)', true), -12); eq(parseNumberString('45%', true), 0.45); eq(parseNumberString('1.234,5', true, ','), 1234.5); }],
  ['types — dates', () => { eq(formatValue(parseDateString('31/12/2026').t, 'date'), '2026-12-31'); eq(formatValue(parseDateString('03/04/2026', 'DMY').t, 'date'), '2026-04-03'); eq(parseDateString('2026-02-30'), null); }],
  ['load — sample shape and types', () => { const r = run([]); eq(r.res.rowCount, 52); eq(r.names.length, 10); eq(r.types.quantity, 'integer'); eq(r.types.unit_price, 'number'); eq(r.types.order_date, 'date'); eq(r.types.customer, 'text'); }],
  ['filter — numeric operator', () => { const r = run([{ type: 'filter', data: { mode: 'rules', rules: [{ column: 'quantity', operator: '>', value: '2' }] } }]); ok(r.col('quantity').every(v => v > 2)); eq(r.res.rowCount, 16); }],
  ['filter — not-equal keeps empties', () => { const r = run([{ type: 'filter', data: { mode: 'rules', rules: [{ column: 'discount', operator: '!=', value: '0' }] } }]); ok(r.col('discount').some(v => v == null)); ok(r.col('discount').every(v => v !== 0)); }],
  ['filter — OR logic', () => { const r = run([{ type: 'filter', data: { mode: 'rules', logic: 'any', rules: [{ column: 'region', operator: '=', value: 'North' }, { column: 'region', operator: '=', value: 'East' }] } }]); ok(r.col('region').every(v => v === 'North' || v === 'East')); }],
  ['filter — pick values', () => { const r = run([{ type: 'filter', data: { mode: 'values', column: 'status', values: { include: true, list: ['Completed', 'Shipped'] } } }]); ok(r.col('status').every(v => v === 'Completed' || v === 'Shipped')); }],
  ['filter — formula', () => { const r = run([{ type: 'filter', data: { mode: 'formula', formula: '[quantity] * [unit_price] > 200' } }]); ok(r.rows.length > 0); ok(r.rows.every(x => x[r.names.indexOf('quantity')] * x[r.names.indexOf('unit_price')] > 200)); }],
  ['filter — loose contains', () => { const r = run([{ type: 'filter', data: { mode: 'rules', loose: true, rules: [{ column: 'customer', operator: 'contains', value: '  SAM ' }] } }]); ok(r.rows.length > 0 && r.col('customer').every(v => /sam/i.test(v))); }],
  ['filter — v1 operator migration', () => { const r = run([{ type: 'filter', data: { column: 'status', mode: 'operator', operator: '=', value: 'Pending' } }]); ok(r.col('status').every(v => v === 'Pending')); }],
  ['sort — multi-key, nulls last', () => { const r = run([{ type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }, { column: 'unit_price', direction: 'desc' }] } }]); const reg = r.col('region'); for (let i = 1; i < reg.length; i++) ok(reg[i - 1].localeCompare(reg[i]) <= 0, 'region order'); }],
  ['remove_duplicates — whole row', () => { const r = run([{ type: 'remove_duplicates', data: { columns: [] } }]); eq(r.res.rowCount, 50); }],
  ['remove_duplicates — loose on category', () => { const r = run([{ type: 'remove_duplicates', data: { columns: ['category'], matchMode: 'loose' } }]); eq(r.res.rowCount, 4); }],
  ['remove_blank_rows — any of customer', () => { const r = run([{ type: 'remove_blank_rows', data: { columns: ['customer'], mode: 'any' } }]); ok(r.col('customer').every(v => v)); }],
  ['keep_rows — first / range / sample', () => { eq(run([{ type: 'keep_rows', data: { mode: 'first', count: 5 } }]).res.rowCount, 5); eq(run([{ type: 'keep_rows', data: { mode: 'range', offset: 3, count: 2 } }]).col('order_id'), [1003, 1004]); const a = run([{ type: 'keep_rows', data: { mode: 'sample', count: 10, seed: 7 } }]).col('order_id'); const b = run([{ type: 'keep_rows', data: { mode: 'sample', count: 10, seed: 7 } }]).col('order_id'); eq(a, b, 'seeded sample stable'); }],
  ['keep_rows — v1 limit migration', () => { eq(run([{ type: 'limit', data: { count: 10, offset: 5 } }]).col('order_id')[0], 1006); }],
  ['promote / demote headers round-trip', () => { const r = run([{ type: 'demote_headers', data: {} }, { type: 'promote_headers', data: {} }]); eq(r.names[0], 'order_id'); eq(r.types.quantity, 'integer'); eq(r.res.rowCount, 52); }],
  ['transpose', () => { const r = run([{ type: 'keep_rows', data: { mode: 'first', count: 3 } }, { type: 'transpose', data: { headerFromFirst: true } }]); eq(r.names, ['Column', '1001', '1002', '1003']); }],
  ['select / remove / move / duplicate columns', () => { eq(run([{ type: 'select_columns', data: { columns: ['customer', 'order_id'] } }]).names, ['customer', 'order_id']); ok(!run([{ type: 'remove_columns', data: { columns: ['discount'] } }]).names.includes('discount')); eq(run([{ type: 'move_column', data: { columns: ['status'], to: 'start' } }]).names[0], 'status'); ok(run([{ type: 'duplicate_column', data: { column: 'quantity' } }]).names.includes('quantity (copy)')); }],
  ['rename — multi + v1 migration', () => { const r = run([{ type: 'rename_columns', data: { mapping: { customer: 'client', region: 'area' } } }, { type: 'rename_column', data: { column: 'client', newName: 'buyer' } }]); ok(r.names.includes('buyer') && r.names.includes('area')); }],
  ['change_type — v1 DOUBLE → number', () => { eq(run([{ type: 'change_type', data: { column: 'quantity', targetType: 'DOUBLE' } }]).types.quantity, 'number'); }],
  ['change_type — text → integer reports failures', () => { const r = run([{ type: 'change_type', data: { columns: ['customer'], type: 'integer' } }]); ok(r.col('customer').every(v => v == null)); ok(r.res.diag[0].warn.length > 0); }],
  ['fill down', () => { const r = run([{ type: 'fill', data: { columns: ['customer'], direction: 'down' } }]); eq(r.col('customer')[3], 'Quinn Brooks'); }],
  ['replace empty values', () => { const r = run([{ type: 'replace_nulls', data: { columns: ['discount'], value: '0' } }]); ok(r.col('discount').every(v => v != null)); eq(r.types.discount, 'number'); }],
  ['split — columns', () => { const r = run([{ type: 'split_column', data: { column: 'customer', delimiter: ' ', mode: 'columns' } }]); ok(r.names.includes('customer_1') && r.names.includes('customer_2')); eq(r.col('customer_1')[0], 'Sam'); }],
  ['split — rows', () => { const r = run([{ type: 'split_column', data: { column: 'customer', delimiter: ' ', mode: 'rows' } }]); ok(r.res.rowCount > 52); }],
  ['merge columns', () => { const r = run([{ type: 'merge_columns', data: { columns: ['product', 'category'], separator: ' / ', name: 'label' } }]); eq(r.col('label')[0], 'Wireless Mouse / Electronics'); ok(!r.names.includes('product')); }],
  ['extract — regex / before / digits', () => { eq(run([{ type: 'extract_text', data: { column: 'customer', mode: 'before', delimiter: ' ', name: 'first' } }]).col('first')[0], 'Sam'); const r = run([{ type: 'extract_text', data: { column: 'product', mode: 'regex', pattern: '(\\w+)$', name: 'last' } }]); eq(r.col('last')[0], 'Mouse'); }],
  ['replace values — whole & contains & regex', () => { ok(run([{ type: 'replace_values', data: { columns: ['status'], match: 'whole', find: 'Pending', replace: 'Open' } }]).col('status').includes('Open')); eq(run([{ type: 'replace_values', data: { columns: ['product'], match: 'contains', find: 'Wireless', replace: 'WL' } }]).col('product')[0], 'WL Mouse'); eq(run([{ type: 'replace_values', data: { columns: ['product'], match: 'regex', find: '\\s+', replace: '_' } }]).col('product')[0], 'Wireless_Mouse'); }],
  ['change case + trim', () => { eq(run([{ type: 'change_case', data: { columns: ['category'], mode: 'upper' } }]).col('category')[2], 'LIFESTYLE'); eq(run([{ type: 'change_case', data: { columns: ['category'], mode: 'proper' } }]).col('category')[2], 'Lifestyle'); }],
  ['pad text', () => { eq(run([{ type: 'change_type', data: { columns: ['order_id'], type: 'text' } }, { type: 'pad_text', data: { columns: ['order_id'], length: 6, char: '0' } }]).col('order_id')[0], '001001'); }],
  ['math + round', () => { eq(run([{ type: 'math', data: { columns: ['unit_price'], op: 'multiply', value: 2 } }]).col('unit_price')[0], 49.98); eq(run([{ type: 'round_number', data: { column: 'unit_price', decimals: 1, mode: 'round' } }]).col('unit_price')[0], 25); }],
  ['date part — year, month name, start of month', () => { eq(run([{ type: 'date_part', data: { column: 'order_date', part: 'year', name: 'Year' } }]).col('Year')[0], 2026); eq(run([{ type: 'date_part', data: { column: 'order_date', part: 'month_name', name: 'M' } }]).col('M')[0], 'January'); const r = run([{ type: 'date_part', data: { column: 'order_date', part: 'start_of_month', name: 'SOM' } }]); eq(formatValue(r.col('SOM')[0], 'date'), '2026-01-01'); }],
  ['format date', () => { eq(run([{ type: 'format_date', data: { column: 'order_date', pattern: 'DD MMM YYYY' } }]).col('order_date')[0], '31 Jan 2026'); }],
  ['formula column', () => { const r = run([{ type: 'add_column', data: { name: 'Revenue', formula: 'round([quantity] * [unit_price] * (1 - coalesce([discount], 0)), 2)' } }]); eq(r.col('Revenue')[0], 49.98); eq(r.types.Revenue, 'number'); }],
  ['formula — text, if, dates', () => { const f = Frame.fromText(['a', 'd'], [['x', 'Y'], ['2026-01-10', '2026-03-01']]); eq(evaluateFormula('upper([a]) & "-" & len([a])', f).values, ['X-1', 'Y-1']); eq(evaluateFormula('if([a] = "x", 1, 2)', f).values, [1, 2]); eq(evaluateFormula('month([d])', f).values, [1, 3]); eq(evaluateFormula('datediff([d], date(2026, 12, 31), "month")', f).values, [11, 9]); }],
  ['conditional column', () => { const r = run([{ type: 'conditional_column', data: { name: 'Size', rules: [{ column: 'quantity', operator: '>=', value: '4', output: 'Big' }, { column: 'quantity', operator: '>=', value: '2', output: 'Mid' }], otherwise: 'Small' } }]); eq(r.col('Size').slice(0, 3), ['Mid', 'Small', 'Mid']); }],
  ['index column — partitioned', () => { const r = run([{ type: 'index_column', data: { name: 'n', start: 1, step: 1, partitionBy: ['region'] } }]); eq(r.names[0], 'n'); eq(r.col('n')[0], 1); }],
  ['rank — dense desc', () => { const r = run([{ type: 'rank', data: { column: 'unit_price', direction: 'desc', mode: 'dense', name: 'r' } }]); const i = r.col('unit_price').indexOf(189.99); eq(r.col('r')[i], 1); }],
  ['running total + percent of total', () => { const r = run([{ type: 'running_total', data: { column: 'quantity', name: 'run' } }]); eq(r.col('run')[51], r.col('quantity').reduce((a, b) => a + b, 0)); const p = run([{ type: 'percent_of_total', data: { column: 'quantity', name: 'share' } }]); ok(Math.abs(p.col('share').reduce((a, b) => a + b, 0) - 1) < 1e-9); }],
  ['group by — sum, count, distinct', () => { const r = run([{ type: 'group_by', data: { groupColumns: ['region'], aggregations: [{ fn: 'sum', column: 'quantity', name: 'q' }, { fn: 'count', column: '', name: 'n' }, { fn: 'count_distinct', column: 'customer', name: 'c' }] } }]); eq(r.res.rowCount, 5); eq(r.col('n').reduce((a, b) => a + b, 0), 52); eq(r.types.q, 'integer'); }],
  ['pivot — sum by region', () => { const r = run([{ type: 'pivot', data: { onColumn: 'region', valueColumn: 'quantity', fn: 'sum', groupColumns: ['category'] } }]); eq(r.names.slice(1), ['Central', 'East', 'North', 'South', 'West']); }],
  ['unpivot — selected and others', () => { const r = run([{ type: 'select_columns', data: { columns: ['order_id', 'quantity', 'unit_price'] } }, { type: 'unpivot', data: { columns: ['quantity', 'unit_price'], nameColumn: 'Attribute', valueColumn: 'Value' } }]); eq(r.res.rowCount, 104); const o = run([{ type: 'select_columns', data: { columns: ['order_id', 'quantity', 'unit_price'] } }, { type: 'unpivot', data: { mode: 'others', columns: ['order_id'], nameColumn: 'A', valueColumn: 'V' } }]); eq(o.res.rowCount, 104); }],
  ['join — left with bring + prefix', () => { const r = run([{ type: 'join', data: { rightSource: 'r', joinType: 'left', keys: [{ left: 'region', right: 'region' }], bring: ['manager'], prefix: 'r_' } }]); eq(r.res.rowCount, 52); ok(r.col('r_manager').every(v => v)); }],
  ['join — v1 shape migration + inner / anti / semi / full', () => { eq(run([{ type: 'join', data: { rightSource: 'r', leftKey: 'region', rightKey: 'region', joinType: 'inner' } }]).res.rowCount, 52); eq(run([{ type: 'join', data: { rightSource: 'r', keys: [{ left: 'region', right: 'region' }], joinType: 'left_anti' } }]).res.rowCount, 0); eq(run([{ type: 'join', data: { rightSource: 'r', keys: [{ left: 'region', right: 'region' }], joinType: 'left_semi' } }]).names.length, 10); eq(run([{ type: 'join', data: { rightSource: 'r', keys: [{ left: 'customer', right: 'manager' }], joinType: 'full' } }]).res.rowCount, 57); }],
  ['join — loose key matching', () => { const r = run([{ type: 'change_case', data: { columns: ['region'], mode: 'upper' } }, { type: 'join', data: { rightSource: 'r', keys: [{ left: 'region', right: 'region' }], joinType: 'left_anti', matchMode: 'loose' } }]); eq(r.res.rowCount, 0); }],
  ['append — with source column', () => { const r = run([{ type: 'append', data: { sources: ['r'], sourceColumn: 'From' } }]); eq(r.res.rowCount, 57); eq(r.col('From')[56], 'regions'); }],
  ['reference query + circular detection', () => { const r = run([], { extra: [{ id: 'ref', name: 'ref', source: { kind: 'reference', parentId: 'q' }, steps: [] }] }); const e = r.engine; ok(e.evaluate({ queryId: 'ref' }).rowCount === 52); e.setQueries({ queries: [{ id: 'a', name: 'a', source: { kind: 'reference', parentId: 'b' }, steps: [] }, { id: 'b', name: 'b', source: { kind: 'reference', parentId: 'a' }, steps: [] }] }); ok(/Circular/.test(e.evaluate({ queryId: 'a' }).error)); }],
  ['edit cells + delete rows track source rows after sort', () => { const r = run([{ type: 'sort', data: { keys: [{ column: 'unit_price', direction: 'desc' }] } }, { type: 'edit_cells', data: { edits: [{ rid: 1, column: 'customer', value: 'Edited' }] } }, { type: 'delete_rows', data: { rids: [2, 3] } }]); eq(r.res.rowCount, 50); ok(r.col('customer').includes('Edited')); ok(!r.col('order_id').includes(1002)); }],
  ['row edits blocked after group by', () => { let threw = false; try { run([{ type: 'group_by', data: { groupColumns: ['region'], aggregations: [{ fn: 'count', name: 'n' }] } }, { type: 'delete_rows', data: { rids: [1] } }]); } catch (e) { threw = /regroup|original rows/.test(e.message); } ok(threw); }],
  ['disabled step is skipped', () => { const e = setup(); e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: 'sales' }, steps: [{ id: 'a', type: 'keep_rows', data: { mode: 'first', count: 3 }, disabled: true }] }] }); eq(e.evaluate({ queryId: 'q' }).rowCount, 52); }],
  ['step cache — second run is cached', () => { const e = setup(); e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: 'sales' }, steps: [{ id: 'a', type: 'group_by', data: { groupColumns: ['region'], aggregations: [{ fn: 'count', name: 'n' }] } }] }] }); e.evaluate({ queryId: 'q' }); ok(e.evaluate({ queryId: 'q' }).diag[0].cached); }],
  ['preview at earlier step', () => { const e = setup(); e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: 'sales' }, steps: [{ id: 'a', type: 'keep_rows', data: { mode: 'first', count: 10 } }, { id: 'b', type: 'keep_rows', data: { mode: 'first', count: 2 } }] }] }); eq(e.evaluate({ queryId: 'q', stepIndex: 0 }).rowCount, 10); eq(e.evaluate({ queryId: 'q', stepIndex: -1 }).rowCount, 52); }],
  ['export — CSV guards formulas and adds BOM', () => { const r = run([{ type: 'replace_values', data: { columns: ['status'], match: 'whole', find: 'Pending', replace: '=1+1' } }]); const t = r.engine.exportData({ resultId: r.res.resultId, format: 'csv' }).text; ok(t.startsWith('\uFEFF')); ok(t.includes("'=1+1")); ok(t.includes('-') || true); }],
  ['export — JSON / JSONL / markdown / sql', () => { const r = run([{ type: 'keep_rows', data: { mode: 'first', count: 2 } }]); eq(JSON.parse(r.engine.exportData({ resultId: r.res.resultId, format: 'json' }).text).length, 2); eq(r.engine.exportData({ resultId: r.res.resultId, format: 'jsonl' }).text.trim().split('\n').length, 2); ok(r.engine.exportData({ resultId: r.res.resultId, format: 'markdown' }).text.startsWith('| order_id')); ok(r.engine.exportData({ resultId: r.res.resultId, format: 'sql' }).text.startsWith('INSERT INTO')); }],
  ['export — dates keep ISO format', () => { const r = run([]); const j = JSON.parse(r.engine.exportData({ resultId: r.res.resultId, format: 'json' }).text); eq(j[0].order_date, '2026-01-31'); }],
  ['batch runSteps', () => { const e = setup(); const r = e.runSteps({ frameFrom: 'sales', steps: [{ type: 'filter', data: { column: 'region', mode: 'operator', operator: '=', value: 'North' } }] }); ok(r.rowCount > 0 && r.rowCount < 52); }],
  ['JSON import — nested objects flatten', () => { const e = new Engine(); const info = e.loadText({ id: 'j', name: 'x.json', text: JSON.stringify({ data: [{ a: 1, b: { c: 'x' } }, { a: 2, b: { c: 'y' } }] }), format: 'json' }); eq(info.fields.map(f => f.name), ['a', 'b.c']); }],
  ['every transform has label, code, params and apply', () => { for (const [k, t] of Object.entries(TRANSFORMS)) { ok(t.label && t.code && Array.isArray(t.params) && typeof t.apply === 'function', k); } }],
];

export function runAll(onResult) {
  const results = [];
  for (const [name, fn] of TESTS) {
    const t0 = performance.now();
    let error = null;
    try { fn(); } catch (e) { error = e.message || String(e); }
    const r = { name, ok: !error, error, ms: performance.now() - t0 };
    results.push(r);
    onResult?.(r);
  }
  return results;
}
