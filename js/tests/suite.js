import { Engine } from '../engine/engine.js';
import { TRANSFORMS, migrateStep } from '../core/transforms.js';
import { parseCSV } from '../core/csv.js';
import { inferColumnType, parseDateString, parseNumberString, formatValue } from '../core/types.js';
import { evaluateFormula } from '../core/formula.js';
import { Frame } from '../core/frame.js';
import { SAMPLE_SALES_CSV, SAMPLE_REGIONS_CSV } from '../app/samples.js';
import { validateSql, withInput, tableNameFor, referencedNames, arrowType, convertValue as duckConvert, decimalFromWords, readerFor } from '../engine/duck.js';
import { CsvStream, parseCSV as parseCsvAll } from '../core/csv.js';
import { highlightSql } from '../ui/sqleditor.js';
import { zipFiles, unzipEntries, crc32 } from '../io/zip.js';
import { createStore } from '../app/store.js';
import { compileStep, mayCompile } from '../engine/compile.js';
import { profileFromJson } from '../engine/duck.js';
import { suggestCleanups } from '../core/suggest.js';
import { addRecent, parseRecent, removeRecent, recentWhen, folderOf, pathName, readRecents, writeRecents, RECENT_KEY } from '../app/recents.js';
import { firstPreviewOnlyIndex, previewTaintedAt, formatStepDelta, sqlHeader, buildSqlCopy, finishSql, stripForShare, encodeShare, decodeShare, extractShare, createShareLink, usesOtherQueries, baseName } from '../app/vnext.js';

const SALES_FIELDS = [{ name: 'order_id', type: 'integer' }, { name: 'order_date', type: 'date' }, { name: 'customer', type: 'text' }, { name: 'region', type: 'text' }, { name: 'quantity', type: 'integer' }, { name: 'unit_price', type: 'number' }];
function duckEngine(steps, schemaFields = SALES_FIELDS) {
  const e = new Engine();
  e.setQueries({ queries: [{ id: 'd', name: 'd', source: { kind: 'duck', table: 'big', sql: 'SELECT * FROM src', limit: 10 }, steps: steps.map((s, i) => ({ id: 's' + i, ...migrateStep(s) })) }] });
  const first = e.evaluate({ queryId: 'd' });
  if (first.needsSql?.schema) e.putDuckSchema({ key: first.needsSql.key, fields: schemaFields });
  return e;
}

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
  ['sql — validator accepts reads, rejects writes and files', () => {
    ok(validateSql('SELECT * FROM input;').sql === 'SELECT * FROM input');
    ok(validateSql('-- note\nWITH a AS (SELECT 1) SELECT * FROM a').sql);
    ok(validateSql("SELECT 'drop table x' AS s FROM input").sql, 'keyword inside string is fine');
    ok(validateSql('SELECT 1; DROP TABLE input').error);
    ok(validateSql('DELETE FROM input').error);
    ok(validateSql("SELECT * FROM read_csv('x.csv')").error);
    ok(validateSql('COPY input TO \'x\'').error);
    ok(validateSql('').error);
  }],
  ['sql — WITH composition', () => {
    eq(withInput('SELECT 1', 'SELECT * FROM input'), 'WITH input AS (SELECT 1) SELECT * FROM input');
    eq(withInput('SELECT 1', 'WITH b AS (SELECT * FROM input) SELECT * FROM b'), 'WITH input AS (SELECT 1), b AS (SELECT * FROM input) SELECT * FROM b');
  }],
  ['sql — table names', () => { const t = new Set(['input']); eq(tableNameFor('Sample Sales (2026)', t), 'sample_sales_2026'); eq(tableNameFor('Sample sales 2026', t), 'sample_sales_2026_2'); eq(tableNameFor('input', t), 'input_query'); eq(tableNameFor('2026', t), 'q_2026'); }],
  ['sql step — pending, then resolved from cache', () => {
    const e = setup();
    e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: 'sales' }, steps: [{ id: 'a', type: 'keep_rows', data: { mode: 'first', count: 5 } }, { id: 'b', type: 'sql', data: { sql: 'SELECT region FROM input', tables: [] } }, { id: 'c', type: 'keep_rows', data: { mode: 'first', count: 2 } }] }] });
    const first = e.evaluate({ queryId: 'q' });
    ok(first.needsSql && first.needsSql.index === 1 && first.needsSql.key, 'reports pending SQL');
    const input = e.sqlInput({ queryId: 'q', index: 1 });
    eq(input.columns[0].length, 5);
    e.putSqlResult({ key: first.needsSql.key, fields: [{ name: 'region', type: 'text' }], columns: [['North', 'South', 'X', 'Y', 'Z']] });
    const second = e.evaluate({ queryId: 'q' });
    eq(second.rowCount, 2); eq(second.fields.map(f => f.name), ['region']);
    e.putSqlResult({ key: first.needsSql.key, error: 'Binder: no column foo' });
    const third = e.evaluate({ queryId: 'q' });
    ok(third.fullError && /foo/.test(third.fullError.message));
  }],
  ['sql step — v1 raw_sql migrates', () => { const s = migrateStep({ type: 'raw_sql', data: { sql: 'SELECT 1' } }); eq(s.type, 'sql'); eq(s.data.sql, 'SELECT 1'); }],
  ['duck source — pushdown of leading SQL step', () => {
    const e = new Engine();
    e.setQueries({ queries: [{ id: 'd', name: 'd', source: { kind: 'duck', table: 'big', sql: "SELECT * FROM read_parquet('big.parquet')", limit: 100 }, steps: [{ id: 'a', type: 'sql', data: { sql: 'SELECT COUNT(*) AS n FROM input', tables: [] } }] }] });
    const r = e.evaluate({ queryId: 'd' });
    ok(r.needsSql?.source && r.needsSql.source.pushed === 1, 'the SQL step is pushed into the whole-file source');
    ok(/read_parquet/.test(r.needsSql.source.sql) && /COUNT\(\*\)/.test(r.needsSql.source.sql));
    e.putSqlResult({ key: r.needsSql.key, fields: [{ name: 'n', type: 'integer' }], columns: [[123456789]] });
    eq(e.evaluate({ queryId: 'd' }).page.rows[0][0], 123456789);
  }],
  ['duck source — non-pushable steps load the preview slice', () => {
    const e = new Engine();
    e.setQueries({ queries: [{ id: 'd', name: 'd', source: { kind: 'duck', table: 'big', sql: 'SELECT 1', limit: 10 }, steps: [{ id: 'a', type: 'keep_rows', data: { mode: 'sample', count: 1 } }] }] });
    const r = e.evaluate({ queryId: 'd' });
    ok(r.needsSql && r.needsSql.source && r.needsSql.source.sql === 'SELECT 1', 'asks for the plain source slice');
    e.putSqlResult({ key: r.needsSql.key, fields: [{ name: 'x', type: 'integer' }], columns: [[1, 2, 3]], note: 'slice' });
    const r2 = e.evaluate({ queryId: 'd' });
    eq(r2.rowCount, 1); eq(r2.sourceNote, 'slice');
  }],
  ['batch — query survives setQueries and SQL resolves', () => {
    const e = setup();
    const first = e.runSteps({ frameFrom: 'sales', steps: [{ type: 'sql', data: { sql: 'SELECT 1', tables: [] } }], id: 'batchq_x' });
    ok(first.needsSql);
    e.setQueries({ queries: [] });
    e.putSqlResult({ key: first.needsSql.key, fields: [{ name: 'a', type: 'integer' }], columns: [[1, 2]] });
    eq(e.runSteps({ frameFrom: 'sales', steps: [{ type: 'sql', data: { sql: 'SELECT 1', tables: [] } }], id: 'batchq_x' }).rowCount, 2);
  }],
  ['zip — round trip with deflate and store, CRC valid', async () => {
    const big = 'region,amount\n' + 'North,1\n'.repeat(500);
    const blob = await zipFiles([{ name: 'a.csv', data: big }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }, { name: 'a.csv', data: 'dup' }]);
    const entries = await unzipEntries(blob);
    eq(entries.map(e => e.name), ['a.csv', 'b.bin', 'a (2).csv']);
    ok(entries.every(e => e.crcOk), 'CRC');
    eq(new TextDecoder().decode(entries[0].data), big);
    eq([...entries[1].data], [1, 2, 3]);
    if (typeof CompressionStream !== 'undefined') eq(entries[0].method, 8);
    eq(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  }],
  ['store — delete step keeps cursor on the same step', () => {
    const s = createStore();
    s.commit('init', (st) => { st.queries = [{ id: 'q', name: 'q', source: {}, steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }]; st.activeQueryId = 'q'; st.stepCursor = { q: 2 }; });
    s.commit('del', (st) => { const qq = st.queries[0]; const cur = st.stepCursor.q; qq.steps.splice(0, 1); const next = cur >= 0 ? cur - 1 : cur; st.stepCursor.q = next; });
    eq(s.state.queries[0].steps[s.cursor()].id, 'c');
    s.undo(); eq(s.state.queries[0].steps.length, 4); s.redo(); eq(s.state.queries[0].steps.length, 3);
  }],
  ['csv stream — matches the one-shot parser across every chunk boundary', () => {
    const src = 'a,b,c\r\n"x, ""y""",2,\r\n"multi\nline",3,z\n,,\n"end"';
    const want = parseCsvAll(src, { delimiter: ',' }).rows;
    for (let k = 1; k < src.length; k++) {
      const rows = []; const p = new CsvStream(',', (r) => rows.push(r));
      p.push(src.slice(0, k)); p.push(src.slice(k)); p.end();
      eq(rows, want, `split at ${k}`);
    }
    const rows = []; const p = new CsvStream(',', (r) => rows.push(r));
    for (const ch of src) p.push(ch);
    p.end(); eq(rows, want, 'one char at a time');
  }],
  ['engine loadFile — streams a Blob into a source', async () => {
    const e = new Engine();
    const file = new Blob(['\uFEFFid;name\n1;été\n2;"a;b"\n']);
    const info = await e.loadFile({ id: 'f', name: 'x.csv', file, format: 'csv' });
    eq(info.rowCount, 2); eq(info.delimiter, ';'); eq(info.fields.map(f => f.type), ['integer', 'text']);
    e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: 'f' }, steps: [] }] });
    eq(e.evaluate({ queryId: 'q' }).page.rows[1], [2, 'a;b']);
  }],
  ['sql — SUMMARIZE / DESCRIBE wrap correctly', () => {
    ok(validateSql('SUMMARIZE input').sql);
    eq(withInput('SELECT 1', 'SUMMARIZE input'), 'WITH input AS (SELECT 1) SELECT * FROM (SUMMARIZE SELECT * FROM input)');
    ok(validateSql("SELECT * FROM 'data.csv'").error, 'string-literal file read rejected');
    ok(validateSql('SELECT * FROM "x.parquet"').error, 'quoted file read rejected');
    ok(validateSql("SELECT 'a' FROM input WHERE x = 'from'").sql, 'strings are fine');
  }],
  ['sql — referenced table detection', () => { eq(referencedNames('SELECT * FROM input JOIN regions USING (region)', ['input', 'regions', 'sales']), ['input', 'regions']); eq(referencedNames("SELECT 'sales' FROM input", ['sales', 'input']), ['input']); }],
  ['sql — chained leading SQL steps push down to DuckDB', () => {
    const e = new Engine();
    e.setQueries({ queries: [{ id: 'd', name: 'd', source: { kind: 'duck', table: 'big', sql: 'SELECT * FROM src', limit: 10 }, steps: [{ id: 'a', type: 'sql', data: { sql: 'SELECT * FROM input WHERE x > 1', tables: [] } }, { id: 'b', type: 'sql', data: { sql: 'SELECT COUNT(*) AS n FROM input', tables: [] } }] }] });
    const r = e.evaluate({ queryId: 'd' });
    eq(r.needsSql.source.sql, 'WITH input AS (WITH input AS (SELECT * FROM src) SELECT * FROM input WHERE x > 1) SELECT COUNT(*) AS n FROM input');
    eq(e.duckPlan({ queryId: 'd', stepIndex: 0 }).sql, 'WITH input AS (SELECT * FROM src) SELECT * FROM input WHERE x > 1');
  }],
  ['sql — input key lets DuckDB reuse materialized tables', () => { const e = setup(); e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: 'sales' }, steps: [{ id: 'a', type: 'sql', data: { sql: 'SELECT 1', tables: ['r'] } }] }, { id: 'r', name: 'regions', source: { kind: 'file', sourceId: 'reg' }, steps: [] }] }); const i = e.sqlInput({ queryId: 'q', index: 0 }); ok(i.inputKey && i.inputKey.startsWith('src:sales')); ok(i.tables[0].key.startsWith('src:reg')); }],
  ['duck — arrow type mapping and value conversion', () => {
    eq(arrowType('Int64'), 'integer'); eq(arrowType('Float64'), 'number'); eq(arrowType('Decimal[10e+2]'), 'number'); eq(arrowType('Date32<DAY>'), 'date'); eq(arrowType('Timestamp<MICROSECOND>'), 'datetime'); eq(arrowType('Utf8'), 'text'); eq(arrowType('Bool'), 'boolean'); eq(arrowType('Time64<MICROSECOND>'), 'text');
    eq(duckConvert(12n, { type: 'integer', arrow: 'int64' }), 12);
    eq(duckConvert(1700000000000000n, { type: 'datetime', arrow: 'timestamp<microsecond>', unit: 2 }), 1700000000000);
    eq(duckConvert(19723, { type: 'date', arrow: 'date32<day>' }), 19723 * 86400000);
    eq(duckConvert({ a: 1n }, { type: 'text', arrow: 'struct' }), '{"a":1}');
    eq(decimalFromWords(new Uint32Array([12345, 0, 0, 0]), 2), 123.45);
    eq(decimalFromWords(new Uint32Array([0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF]), 0), -1);
  }],
  ['duck — reader options', () => { eq(readerFor('a.csv', 'csv', { delimiter: ';', header: false, skipRows: 2 }), "read_csv('a.csv', sample_size=20480, delim=';', header=false, skip=2)"); eq(readerFor('a.tsv', 'tsv'), "read_csv('a.tsv', sample_size=20480, delim='\t')"); }],
  ['sql editor — highlighter escapes and classifies', () => { const h = highlightSql("SELECT count(*) FROM input WHERE a = '<b>' -- x", { tables: ['input'] }); ok(h.includes('<span class="sq-k">SELECT</span>')); ok(h.includes('<span class="sq-f">count</span>')); ok(h.includes('<span class="sq-t">input</span>')); ok(h.includes('&lt;b&gt;')); ok(h.includes('sq-c')); }],
  ['compile — filter rules, values, blanks', () => {
    const f = compileStep({ type: 'filter', data: { mode: 'rules', logic: 'any', rules: [{ column: 'quantity', operator: '>', value: '2' }, { column: 'region', operator: '=', value: 'North' }] } }, SALES_FIELDS);
    eq(f.sql, "SELECT * FROM input WHERE (\"quantity\" > 2) OR (\"region\" IS NOT NULL AND lower(\"region\") = 'north')");
    ok(/BETWEEN DATE '2026-01-01' AND DATE '2026-02-01'/.test(compileStep({ type: 'filter', data: { mode: 'rules', rules: [{ column: 'order_date', operator: 'between', value: '2026-01-01', value2: '2026-02-01' }] } }, SALES_FIELDS).sql));
    ok(/contains\(lower\("customer"\), 'o''b'\)/.test(compileStep({ type: 'filter', data: { rules: [{ column: 'customer', operator: 'contains', value: "O'B" }] } }, SALES_FIELDS).sql), 'quotes escaped');
    ok(/IN \('North', 'East'\)/.test(compileStep({ type: 'filter', data: { mode: 'values', column: 'region', values: { include: true, list: ['North', 'East'] } } }, SALES_FIELDS).sql));
    ok(/trim\("customer"\) = ''/.test(compileStep({ type: 'remove_blank_rows', data: { columns: ['customer'], mode: 'any' } }, SALES_FIELDS).sql));
  }],
  ['compile — refuses what DuckDB would get wrong', () => {
    eq(compileStep({ type: 'filter', data: { mode: 'formula', formula: '[a] > 1' } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'filter', data: { loose: true, rules: [{ column: 'customer', operator: 'contains', value: 'x' }] } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'filter', data: { rules: [{ column: 'customer', operator: 'regex', value: 'x' }] } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'filter', data: { rules: [{ column: 'quantity', operator: '>', value: 'abc' }] } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'filter', data: { rules: [{ column: 'missing', operator: '=', value: '1' }] } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'keep_rows', data: { mode: 'sample', count: 5 } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'remove_duplicates', data: { columns: ['customer'], matchMode: 'loose' } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'group_by', data: { groupColumns: ['region'], aggregations: [{ fn: 'concat', column: 'customer', name: 'c' }] } }, SALES_FIELDS), null);
    eq(compileStep({ type: 'split_column', data: { column: 'region', delimiter: ' ' } }, SALES_FIELDS), null, 'split needs a probe');
    eq(compileStep({ type: 'join', data: { rightSource: 'x', joinType: 'full', keys: [{ left: 'region', right: 'region' }] } }, SALES_FIELDS), null, 'full join stays in JS');
    eq(compileStep({ type: 'replace_values', data: { columns: ['region'], match: 'regex', find: 'x', replace: 'y' } }, SALES_FIELDS), null, 'regex replace stays in JS');
    ok(/upper\("customer"\)/.test(compileStep({ type: 'change_case', data: { columns: ['customer'], mode: 'upper' } }, SALES_FIELDS, { probe: () => false }).sql), 'case compiles when probe says safe');
    eq(compileStep({ type: 'change_case', data: { columns: ['customer'], mode: 'upper' } }, SALES_FIELDS, { probe: () => true }), null, 'case refuses unsafe characters');
    ok(!mayCompile({ type: 'sort', disabled: true }));
  }],
  ['compile — columns, sort, limits, dedupe, group by', () => {
    const sel = compileStep({ type: 'select_columns', data: { columns: ['region', 'quantity'] } }, SALES_FIELDS);
    eq(sel.fields.map(f => f.name), ['region', 'quantity']);
    eq(compileStep({ type: 'remove_columns', data: { columns: ['customer'] } }, SALES_FIELDS).fields.length, 5);
    const ren = compileStep({ type: 'rename_columns', data: { mapping: { region: 'area' } } }, SALES_FIELDS);
    ok(ren.sql.includes('"region" AS "area"')); eq(ren.fields[3].name, 'area');
    eq(compileStep({ type: 'rename_columns', data: { mapping: { region: 'customer' } } }, SALES_FIELDS), null, 'clashing rename');
    ok(/ORDER BY lower\("region"\) ASC NULLS LAST, "unit_price" DESC NULLS LAST, __duckbench_rn$/.test(compileStep({ type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }, { column: 'unit_price', direction: 'desc' }] } }, SALES_FIELDS).sql), 'stable sort');
    eq(compileStep({ type: 'keep_rows', data: { mode: 'range', offset: 3, count: 2 } }, SALES_FIELDS).sql, 'SELECT * FROM input LIMIT 2 OFFSET 2');
    ok(/QUALIFY row_number\(\) OVER \(PARTITION BY "customer" ORDER BY __duckbench_rn DESC\) = 1/.test(compileStep({ type: 'remove_duplicates', data: { columns: ['customer'], keep: 'last' } }, SALES_FIELDS).sql));
    const g = compileStep({ type: 'group_by', data: { groupColumns: ['region'], aggregations: [{ fn: 'sum', column: 'quantity', name: 'q' }, { fn: 'count', name: 'n' }, { fn: 'avg', column: 'unit_price', name: 'p' }] } }, SALES_FIELDS);
    eq(g.fields, [{ name: 'region', type: 'text' }, { name: 'q', type: 'integer' }, { name: 'n', type: 'integer' }, { name: 'p', type: 'number' }]);
    ok(/GROUP BY "region" ORDER BY min\(__duckbench_rn\)/.test(g.sql), 'first-seen group order');
  }],
  ['engine — visual steps push down on DuckDB files', () => {
    const e = duckEngine([{ type: 'filter', data: { rules: [{ column: 'quantity', operator: '>', value: '2' }] } }, { type: 'select_columns', data: { columns: ['region', 'quantity'] } }, { type: 'split_column', data: { column: 'region', delimiter: ' ', mode: 'columns' } }]);
    let r = e.evaluate({ queryId: 'd' });
    for (let g = 0; g < 4 && r.needsSql?.probe; g++) { e.putDuckSchema({ key: r.needsSql.key, error: 'probe declined in test' }); r = e.evaluate({ queryId: 'd' }); }
    ok(r.needsSql?.source, 'asks for the pushed source');
    ok(/WHERE \("quantity" > 2\)/.test(r.needsSql.source.sql) && /SELECT "region", "quantity" FROM input/.test(r.needsSql.source.sql));
    eq(r.needsSql.source.pushed, 2);
    e.putSqlResult({ key: r.needsSql.key, fields: [{ name: 'region', type: 'text' }, { name: 'quantity', type: 'integer' }], columns: [['North East', 'South'], [3, 4]] });
    const r2 = e.evaluate({ queryId: 'd' });
    eq(r2.rowCount, 2); ok(r2.fields.some(f => f.name === 'region_1'));
    ok(r2.diag[0].pushed && r2.diag[1].pushed && !r2.diag[2].pushed);
    const plan = e.duckPlan({ queryId: 'd' });
    ok(!plan.complete && plan.blockedAt === 2 && plan.pushed === 2);
    ok(e.duckPlan({ queryId: 'd', stepIndex: 1 }).complete);
  }],
  ['engine — pushdown chains SQL after visual steps and reports errors at the step', () => {
    const e = duckEngine([{ type: 'keep_rows', data: { mode: 'first', count: 5 } }, { type: 'sql', data: { sql: 'SELECT COUNT(*) AS n FROM input', tables: [] } }]);
    const r = e.evaluate({ queryId: 'd' });
    eq(r.needsSql.source.sql, 'WITH input AS (WITH input AS (SELECT * FROM src) SELECT * FROM input LIMIT 5) SELECT COUNT(*) AS n FROM input');
    e.putSqlResult({ key: r.needsSql.key, error: 'bad column' });
    const r2 = e.evaluate({ queryId: 'd' });
    ok(r2.error && r2.errorIndex === 1, 'error points at the last pushed step');
    const qd = duckEngine([{ type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }] } }]).queryData({ queryId: 'd' });
    ok(qd.pushdown && /ORDER BY/.test(qd.pushdown), 'console sees the whole-file plan');
  }],
  ['engine — editing a step previews from the slice before it', () => {
    const e = duckEngine([{ type: 'filter', data: { rules: [{ column: 'quantity', operator: '>', value: '2' }] } }, { type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }] } }]);
    const r = e.evaluate({ queryId: 'd', override: { index: 1, step: { type: 'sort', data: { keys: [{ column: 'quantity', direction: 'desc' }] } } } });
    ok(r.needsSql?.source && !/ORDER BY/.test(r.needsSql.source.sql) && /WHERE/.test(r.needsSql.source.sql), 'draft step runs locally on the pushed prefix');
  }],
  ['duck — EXPLAIN ANALYZE JSON profile', () => {
    const p = profileFromJson({ latency: 0.012, children: [{ operator_name: 'PROJECTION', operator_timing: 0.001, operator_cardinality: 5, children: [{ operator_name: 'FILTER', operator_timing: 0.004, operator_cardinality: 5, children: [{ operator_name: 'TABLE_SCAN', operator_timing: 0.006, operator_cardinality: 52, children: [] }] }] }] });
    eq(p.ops.map(o => o.name), ['PROJECTION', 'FILTER', 'TABLE_SCAN']); eq(p.total, 0.012); ok(p.text.includes('    TABLE_SCAN  52 rows'));
  }],
  ['vNext — preview taint: no steps', () => { eq(firstPreviewOnlyIndex([]), -1); eq(previewTaintedAt([], 0), -1); }],
  ['vNext — preview taint: first preview-only step', () => { const d = [{ pushed: true }, { preview: true }, { preview: true }]; eq(firstPreviewOnlyIndex(d), 1); eq(previewTaintedAt(d, 0), -1); eq(previewTaintedAt(d, 2), 1); }],
  ['vNext — preview taint: disabled never taints, in-memory is clean', () => { eq(firstPreviewOnlyIndex([{ disabled: true, preview: true }, { rows: 3 }]), -1); eq(firstPreviewOnlyIndex([{ rows: 1 }, { rows: 2 }]), -1); }],
  ['vNext — engine flags steps that ran on a truncated DuckDB preview', () => {
    const e = duckEngine([{ type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }] } }, { type: 'extract_text', data: { column: 'region', mode: 'first', count: 2 } }, { type: 'keep_rows', data: { mode: 'first', count: 1 } }]);
    const first = e.evaluate({ queryId: 'd' });
    ok(first.needsSql && first.needsSql.source, 'wants source rows');
    e.putSqlResult({ key: first.needsSql.key, fields: [{ name: 'region', type: 'text' }], columns: [['North', 'South', 'East']], truncated: true });
    const r = e.evaluate({ queryId: 'd' });
    ok(r.diag[0].pushed && !r.diag[0].preview, 'pushed step is whole-file');
    ok(r.diag[1].preview && r.diag[2].preview, 'JS steps are preview-only');
    eq(firstPreviewOnlyIndex(r.diag), 1);
  }],
  ['vNext — engine does not flag steps when the DuckDB result is complete', () => {
    const e = duckEngine([{ type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }] } }, { type: 'keep_rows', data: { mode: 'first', count: 1 } }]);
    const first = e.evaluate({ queryId: 'd' });
    e.putSqlResult({ key: first.needsSql.key, fields: [{ name: 'region', type: 'text' }], columns: [['North', 'South']] });
    const r = e.evaluate({ queryId: 'd' });
    eq(firstPreviewOnlyIndex(r.diag), -1);
  }],
  ['vNext — engine ignores disabled steps for the preview flag', () => {
    const e = duckEngine([{ type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }] } }, { type: 'extract_text', data: { column: 'region', mode: 'first', count: 2 }, disabled: true }]);
    const first = e.evaluate({ queryId: 'd' });
    e.putSqlResult({ key: first.needsSql.key, fields: [{ name: 'region', type: 'text' }], columns: [['North', 'South']], truncated: true });
    const r = e.evaluate({ queryId: 'd' });
    eq(firstPreviewOnlyIndex(r.diag), -1);
  }],
  ['vNext — delta: unchanged shape', () => { const d = formatStepDelta({ rows: 10, cols: 3 }, { rows: 10, cols: 3 }); eq(d.text, 'no change'); ok(d.muted); ok(/Values or types may still have changed/.test(d.tip)); }],
  ['vNext — delta: rows removed', () => { const d = formatStepDelta({ rows: 2000, cols: 3 }, { rows: 796, cols: 3 }); eq(d.text, `−${(1204).toLocaleString()} rows`); eq(d.label, `${(1204).toLocaleString()} rows removed`); ok(!d.muted); }],
  ['vNext — delta: columns added', () => eq(formatStepDelta({ rows: 5, cols: 3 }, { rows: 5, cols: 5 }).text, '+2 cols')],
  ['vNext — delta: singular wording and both parts', () => { const d = formatStepDelta({ rows: 5, cols: 3 }, { rows: 4, cols: 2 }); eq(d.text, '−1 row · −1 col'); eq(d.label, '1 row removed, 1 column removed'); }],
  ['vNext — delta: columns only when rows unknown', () => eq(formatStepDelta({ cols: 3 }, { cols: 4 }).text, '+1 col')],
  ['vNext — delta: unknown sides show nothing', () => { eq(formatStepDelta({ rows: 5, cols: 3 }, {}), null); eq(formatStepDelta(undefined, { rows: 5, cols: 3 }), null); eq(formatStepDelta({ cols: 3 }, { cols: 3 }), null); }],
  ['vNext — delta: engine diag feeds the chip', () => {
    const e = setup();
    e.setQueries({ queries: [{ id: 'q', name: 'sales', source: { kind: 'file', sourceId: 'sales' }, steps: [{ id: 'a', type: 'keep_rows', data: { mode: 'first', count: 5 } }] }] });
    const d = e.evaluate({ queryId: 'q' }).diag[0];
    eq(formatStepDelta({ rows: d.prevRows, cols: d.prevCols }, { rows: d.rows, cols: d.cols }).text, `−${(d.prevRows - 5).toLocaleString()} rows`);
  }],
  ['vNext — sql header uses the file name only', () => { const h = sqlHeader({ fileName: 'C:\\Users\\alice\\data\\sales.csv', from: 1, to: 4, total: 6, date: new Date(2026, 10, 11) }); ok(h.includes('-- Source: sales.csv')); ok(!h.includes('alice')); ok(h.includes('-- Steps 1 to 4 of 6')); ok(h.includes('-- Generated 2026-11-11')); }],
  ['vNext — sql header: a single step reads naturally', () => ok(sqlHeader({ fileName: 'a.csv', from: 1, to: 1, total: 3, date: new Date(2026, 0, 2) }).includes('-- Step 1 of 3'))],
  ['vNext — sql header cannot be broken out of by a file name', () => { const h = sqlHeader({ fileName: 'a\nDROP TABLE x;.csv', from: 1, to: 1, total: 1, date: new Date(2026, 0, 2) }); eq(h.split('\n').filter(l => l.startsWith('-- Source:')).length, 1); ok(!h.split('\n').some(l => l.startsWith('DROP'))); ok(h.includes('-- Generated 2026-01-02')); }],
  ['vNext — sql copy ends with a single semicolon and LF endings', () => { const t = buildSqlCopy({ fileName: '/tmp/a.csv', sql: 'SELECT 1;;\r\n', to: 1, total: 1, date: new Date(2026, 10, 11) }); ok(t.endsWith('SELECT 1;\n')); ok(!t.includes('\r')); eq(finishSql('SELECT 2'), 'SELECT 2;'); eq(baseName('\\\\srv\\share\\x.csv'), 'x.csv'); }],
  ['vNext — copy sql: compiled plan matches the pipeline', () => {
    const e = duckEngine([{ type: 'filter', data: { rules: [{ column: 'quantity', operator: '>', value: '2' }] } }, { type: 'sort', data: { keys: [{ column: 'region', direction: 'asc' }] } }]);
    const plan = e.duckPlan({ queryId: 'd' });
    ok(plan.complete && plan.pushed === 2, 'both steps compile');
    const t = buildSqlCopy({ fileName: 'big.csv', sql: plan.sql, to: 2, total: 2, date: new Date(2026, 10, 11) });
    ok(/WHERE/i.test(t) && /ORDER BY/i.test(t) && t.trimEnd().endsWith(';'));
  }],
  ['vNext — share: round trip keeps unicode and emoji', async () => {
    const steps = [{ type: 'filter', data: { rules: [{ column: 'naïve "quoted"', operator: '=', value: '数量 🦆' }] }, name: 'Pick 🦆' }, { type: 'sort', data: { keys: [{ column: 'Unit Price', direction: 'desc' }] }, disabled: true }];
    const wire = stripForShare(steps);
    const enc = await encodeShare(wire);
    ok(/^1\.[A-Za-z0-9_-]+$/.test(enc), 'url-safe alphabet only');
    const dec = await decodeShare(enc);
    ok(dec.ok); eq(dec.recipe, wire);
  }],
  ['vNext — share: truncated, wrong version and bad characters are rejected', async () => {
    const enc = await encodeShare(stripForShare([{ type: 'sort', data: { keys: [{ column: 'a', direction: 'asc' }] } }]));
    const cut = await decodeShare(enc.slice(0, -10));
    ok(!cut.ok && cut.reason === 'malformed');
    eq((await decodeShare('2.abc')).reason, 'newer-version');
    eq((await decodeShare('1.!!!')).reason, 'malformed');
    eq((await decodeShare('')).reason, 'malformed');
    eq((await decodeShare('x'.repeat(10001))).reason, 'too-long');
  }],
  ['vNext — share: non-recipe payloads are rejected', async () => {
    eq((await decodeShare(await encodeShare([]))).reason, 'malformed');
    eq((await decodeShare(await encodeShare({ app: 'duckbench', steps: [] }))).reason, 'malformed');
    eq((await decodeShare(await encodeShare({ app: 'duckbench', steps: [1] }))).reason, 'malformed');
    eq((await decodeShare(await encodeShare({ app: 'duckbench', steps: [{ type: 'x'.repeat(80) }] }))).reason, 'malformed');
  }],
  ['vNext — share: prototype pollution keys are dropped', async () => {
    const enc = await encodeShare(JSON.parse('{"steps":[{"type":"sort","data":{"__proto__":{"x":1},"constructor":{"y":2},"keys":[]}}]}'));
    const dec = await decodeShare(enc);
    ok(dec.ok); eq({}.x, undefined); eq(Object.keys(dec.recipe.steps[0].data), ['keys']);
  }],
  ['vNext — share: decompression is capped', async () => {
    const enc = await encodeShare({ app: 'duckbench', steps: [{ type: 'sort', data: { pad: ' '.repeat(2_000_000) } }] });
    ok(enc.length < 10000, 'bomb is small on the wire');
    eq((await decodeShare(enc)).reason, 'too-large');
  }],
  ['vNext — share: unknown step types are reported', async () => {
    const enc = await encodeShare({ app: 'duckbench', steps: [{ type: 'sort', data: {} }, { type: 'time_travel', data: {} }] });
    const dec = await decodeShare(enc, { isKnownStep: (st) => st.type !== 'time_travel' });
    ok(!dec.ok && dec.reason === 'unsupported-step' && dec.type === 'time_travel');
  }],
  ['vNext — share: markup in names survives as plain data', async () => {
    const enc = await encodeShare(stripForShare([{ type: 'sort', data: {}, name: '<img src=x onerror=alert(1)>' }]));
    const dec = await decodeShare(enc);
    ok(dec.ok); eq(dec.recipe.steps[0].name, '<img src=x onerror=alert(1)>');
  }],
  ['vNext — share: pasted urls, fragments and trailing whitespace are accepted', () => { eq(extractShare('https://example.com/app/index.html?demo#r=1.abc_-\n'), '1.abc_-'); eq(extractShare('  r=1.abc  '), '1.abc'); eq(extractShare('#r=1.abc'), '1.abc'); eq(extractShare('1.abc'), '1.abc'); }],
  ['vNext — share: payload carries steps only, never paths or file names', async () => {
    const steps = [{ id: 's1', type: 'filter', data: { rules: [{ column: 'a', operator: '=', value: 'x' }] }, disabled: false, name: '', note: '' }];
    const wire = stripForShare(steps);
    eq(Object.keys(wire).sort(), ['app', 'steps']);
    eq(Object.keys(wire.steps[0]).sort(), ['data', 'type']);
    const link = await createShareLink(steps, 'https://duckbench2.vercel.app/');
    ok(link.ok && link.url.startsWith('https://duckbench2.vercel.app/#r=1.'));
    const dec = await decodeShare(extractShare(link.url));
    ok(!JSON.stringify(dec.recipe).includes('C:\\'));
  }],
  ['vNext — share: oversize recipes get no link, cross-query recipes are refused', async () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ type: 'replace_values', data: { column: 'c' + i, find: Math.random().toString(36).repeat(8) + i, replace: Math.random().toString(36).repeat(8) } }));
    eq((await createShareLink(big, 'https://x.test/')).reason, 'too-long');
    eq((await createShareLink([{ type: 'join', data: {} }], 'https://x.test/')).reason, 'multi');
    ok(usesOtherQueries([{ type: 'sql', data: { tables: ['q2'] } }]));
    eq((await createShareLink([{ type: 'sort', data: {} }], '')).reason, 'nobase');
    eq((await createShareLink([], 'https://x.test/')).reason, 'no-steps');
  }],
  ['clean-up suggestions: number rule needs 20 non-empty values and 95% parsing', () => {
    const mk = (vals) => ({ fields: [{ name: 'amt', type: 'text' }], columns: [vals], rowCount: vals.length });
    const nums = (n) => Array.from({ length: n }, (_, i) => String(i + 1));
    eq(suggestCleanups(mk(nums(20))).number, { column: 'amt' });
    eq(suggestCleanups(mk(nums(19))).number, null);
    eq(suggestCleanups(mk([...nums(19), 'n/a'])).number, { column: 'amt' });
    eq(suggestCleanups(mk([...nums(18), 'n/a', 'x'])).number, null);
    eq(suggestCleanups(mk([...nums(20), '', '  ', null])).number, { column: 'amt' });
  }],
  ['clean-up suggestions: codes with leading zeros, very long digit strings and typed columns are left alone', () => {
    const mk = (vals, type = 'text') => ({ fields: [{ name: 'c', type }], columns: [vals], rowCount: vals.length });
    eq(suggestCleanups(mk(Array.from({ length: 30 }, (_, i) => String(i).padStart(5, '0')))).number, null);
    eq(suggestCleanups(mk(Array.from({ length: 30 }, (_, i) => '1234567890123456' + i))).number, null);
    eq(suggestCleanups(mk(Array.from({ length: 30 }, (_, i) => String(i + 1)), 'integer')).number, null);
    eq(suggestCleanups(mk(Array.from({ length: 30 }, (_, i) => `${i + 1},5`))).number, null);
  }],
  ['clean-up suggestions: trim rule picks the first padded text column by order', () => {
    const f = { fields: [{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }, { name: 'c', type: 'text' }], columns: [['x', 'y'], ['ok', ' pad '], ['  z', 'w']], rowCount: 2 };
    eq(suggestCleanups(f).trim, { column: 'b' });
    eq(suggestCleanups({ fields: [{ name: 'a', type: 'text' }], columns: [['x', '   ', null]], rowCount: 3 }).trim, null);
  }],
  ['clean-up suggestions: blank rows are rows empty in every column', () => {
    const f = { fields: [{ name: 'a', type: 'text' }, { name: 'b', type: 'integer' }], columns: [['x', '', '  ', null], [1, null, null, null]], rowCount: 4 };
    eq(suggestCleanups(f).blank, { rows: 3 });
    eq(suggestCleanups({ fields: [{ name: 'a', type: 'text' }], columns: [['x', 'y']], rowCount: 2 }).blank, null);
    eq(suggestCleanups({ fields: [], columns: [], rowCount: 0 }), { number: null, trim: null, blank: null });
  }],
  ['clean-up suggestions: engine computes them on the loaded file only', () => {
    const e = setup();
    e.loadText({ id: 'm', name: 'm.csv', text: 'id,name\n1, a \n2,b\n,\n' });
    e.setQueries({ queries: [{ id: 'q', name: 'm', source: { kind: 'file', sourceId: 'm' }, steps: [] }] });
    const r = e.suggest({ queryId: 'q' });
    eq(r.items.trim, { column: 'name' });
    eq(r.items.blank, { rows: 1 });
    eq(e.suggest({ queryId: 'nope' }).items, null);
  }],
  ['clean-up suggestions: never computed for DuckDB-backed queries', () => {
    const e = duckEngine([]);
    eq(e.suggest({ queryId: 'd' }).items, null);
  }],
  ['recent files: newest first and de-duplicated ignoring case', () => {
    let l = [];
    l = addRecent(l, { path: 'C:\\A.csv', name: 'A.csv', openedAt: 1 });
    l = addRecent(l, { path: 'C:\\B.csv', name: 'B.csv', openedAt: 2 });
    l = addRecent(l, { path: 'c:\\a.csv', name: 'a.csv', openedAt: 3 });
    eq(l.map(e => e.path), ['c:\\a.csv', 'C:\\B.csv']);
  }],
  ['recent files: capped at ten', () => {
    let l = [];
    for (let i = 0; i < 15; i++) l = addRecent(l, { path: `/f/${i}.csv`, name: `${i}.csv`, openedAt: i });
    eq(l.length, 10); eq(l[0].path, '/f/14.csv'); eq(l[9].path, '/f/5.csv');
  }],
  ['recent files: parsing is defensive', () => {
    eq(parseRecent('garbage'), []); eq(parseRecent('[{"path":1}]'), []); eq(parseRecent(null), []); eq(parseRecent('{"path":"x"}'), []); eq(parseRecent('[null,3,{"path":""}]'), []);
    eq(parseRecent('[{"path":"/a/b.csv"},{"path":"/c.csv","name":"c","openedAt":5}]'), [{ path: '/a/b.csv', name: 'b.csv', openedAt: 0 }, { path: '/c.csv', name: 'c', openedAt: 5 }]);
  }],
  ['recent files: names and folders for Windows, UNC and unix paths', () => {
    eq(pathName('C:\\Users\\Zoë\\Données\\ventes.csv'), 'ventes.csv');
    eq(folderOf('C:\\Users\\Zoë\\Données\\ventes.csv'), 'C:\\Users\\Zoë\\Données');
    eq(pathName('\\\\server\\share\\file.csv'), 'file.csv'); eq(folderOf('\\\\server\\share\\file.csv'), '\\\\server\\share');
    eq(pathName('/home/a b/x.csv'), 'x.csv'); eq(folderOf('/x.csv'), ''); eq(pathName(''), '');
  }],
  ['recent files: remove by path ignores case', () => eq(removeRecent([{ path: 'C:\\A.csv' }, { path: 'C:\\B.csv' }], 'c:\\a.CSV').map(e => e.path), ['C:\\B.csv'])],
  ['recent files: relative time labels', () => {
    const now = new Date(2026, 10, 13, 15, 0).getTime();
    eq(recentWhen(new Date(2026, 10, 13, 1, 0).getTime(), now), 'today');
    eq(recentWhen(new Date(2026, 10, 12, 23, 59).getTime(), now), 'yesterday');
    eq(recentWhen(new Date(2026, 10, 1).getTime(), now), new Date(2026, 10, 1).toLocaleDateString());
  }],
  ['recent files: storage failures never throw', () => {
    const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
    eq(readRecents(bad), []); eq(writeRecents([{ path: 'x' }], bad), false);
    const mem = new Map(); const ok = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    ok.setItem(RECENT_KEY, 'not json'); eq(readRecents(ok), []);
    eq(writeRecents([{ path: '/a.csv', name: 'a.csv', openedAt: 1 }], ok), true); eq(readRecents(ok).length, 1);
  }],
  ['duckdb 2.0 readiness — compiled SQL never uses arrow lambdas', () => {
    const cases = [
      { type: 'change_case', data: { columns: ['customer', 'region'], mode: 'proper' } },
      { type: 'merge_columns', data: { columns: ['customer', 'region'], separator: ' / ', name: 'label', skipEmpty: true } },
      { type: 'trim_clean', data: { columns: ['customer'], trim: true } },
    ];
    let lambdas = 0;
    for (const c of cases) {
      const out = compileStep(migrateStep(c), SALES_FIELDS, { probe: () => false });
      ok(out && out.sql, `${c.type} compiles`);
      ok(!/\s->\s/.test(out.sql), `${c.type} has no arrow lambda`);
      if (/lambda\s+\w+\s*:/.test(out.sql)) lambdas++;
    }
    ok(lambdas >= 2, 'python-style lambda is used where a lambda is needed');
  }],
  ['every transform has label, code, params and apply', () => { for (const [k, t] of Object.entries(TRANSFORMS)) { ok(t.label && t.code && Array.isArray(t.params) && typeof t.apply === 'function', k); } }],
];

export async function runAll(onResult) {
  const results = [];
  for (const [name, fn] of TESTS) {
    const t0 = performance.now();
    let error = null;
    try { await fn(); } catch (e) { error = e.message || String(e); }
    const r = { name, ok: !error, error, ms: performance.now() - t0 };
    results.push(r);
    onResult?.(r);
  }
  return results;
}
