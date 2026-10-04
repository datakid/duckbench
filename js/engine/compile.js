import { qi, sqlStr } from './duck.js';
import { formatDate, formatDateTime, parseNumberString, parseBoolString, convertValue, isNumeric, isTemporal } from '../core/types.js';
import { aggType, aggDefaultName } from '../core/transforms.js';
import { parseList } from '../core/util.js';
import { MORE } from './compile-sql.js';

const PUSHABLE = new Set(['filter', 'sort', 'select_columns', 'remove_columns', 'rename_columns', 'keep_rows', 'remove_blank_rows', 'remove_duplicates', 'group_by', 'trim_clean', 'replace_values', 'change_type', 'change_case', 'split_column', 'join', 'pivot', 'merge_columns', 'unpivot']);
const RN = '__duckbench_rn';
const TEXT_OPS = new Set(['contains', 'not_contains', 'starts_with', 'ends_with']);

export const PUSHABLE_STEPS = [...PUSHABLE];

export function mayCompile(step) {
  if (!step || step.disabled || !PUSHABLE.has(step.type)) return false;
  const d = step.data || {};
  switch (step.type) {
    case 'filter': return (d.mode === 'rules' || d.mode === 'values' || !d.mode) && !d.loose;
    case 'keep_rows': return d.mode === 'first' || d.mode === 'range' || d.mode === 'remove_first';
    case 'remove_duplicates': return !d.matchMode || d.matchMode === 'exact';
    default: return true;
  }
}

export function lit(v, type) {
  if (v == null) return 'NULL';
  if (type === 'date') return `DATE ${sqlStr(formatDate(v))}`;
  if (type === 'datetime') return `TIMESTAMP ${sqlStr(formatDateTime(v))}`;
  if (isNumeric(type)) return Number.isFinite(v) ? String(v) : null;
  if (type === 'boolean') return v ? 'TRUE' : 'FALSE';
  return sqlStr(v);
}

export function literalFor(raw, type) {
  if (raw == null || raw === '') return undefined;
  if (type === 'text') return String(raw);
  if (isNumeric(type)) { const n = parseNumberString(raw, true); return n == null ? undefined : n; }
  if (type === 'boolean') { const b = parseBoolString(raw); return b == null ? undefined : b; }
  if (isTemporal(type)) { const t = convertValue(String(raw), type); return t == null ? undefined : t; }
  return undefined;
}

function blank(c, type) {
  return type === 'text' ? `(${c} IS NULL OR trim(${c}) = '')` : `(${c} IS NULL)`;
}

function ruleSql(rule, types) {
  const type = types.get(rule.column);
  if (!type) return null;
  const c = qi(rule.column);
  const op = rule.operator || '=';
  if (op === 'is_null') return blank(c, type);
  if (op === 'is_not_null') return `(NOT ${blank(c, type)})`;
  if (rule.loose || op === 'regex') return null;
  const cs = !!rule.caseSensitive;
  if (TEXT_OPS.has(op)) {
    if (type !== 'text') return null;
    const raw = String(rule.value ?? '');
    const a = cs ? c : `lower(${c})`;
    const b = sqlStr(cs ? raw : raw.toLowerCase());
    if (op === 'contains') return `(${c} IS NOT NULL AND contains(${a}, ${b}))`;
    if (op === 'not_contains') return `(${c} IS NULL OR NOT contains(${a}, ${b}))`;
    if (op === 'starts_with') return `(${c} IS NOT NULL AND starts_with(${a}, ${b}))`;
    return `(${c} IS NOT NULL AND suffix(${a}, ${b}))`;
  }
  if (op === 'in_list' || op === 'not_in_list') {
    if (!(isNumeric(type) || (type === 'text' && cs))) return null;
    const vals = parseList(rule.value).map(s => literalFor(s, type)).filter(x => x !== undefined).map(x => lit(x, type));
    if (vals.some(v => v == null)) return null;
    if (!vals.length) return op === 'in_list' ? 'FALSE' : 'TRUE';
    return op === 'in_list' ? `(${c} IN (${vals.join(', ')}))` : `(${c} IS NULL OR ${c} NOT IN (${vals.join(', ')}))`;
  }
  const a = literalFor(rule.value, type);
  const b = op === 'between' ? literalFor(rule.value2, type) : undefined;
  if (a === undefined || (op === 'between' && b === undefined)) return null;
  if (type === 'text') {
    if (op !== '=' && op !== '!=') return null;
    const l = cs ? c : `lower(${c})`;
    const r = sqlStr(cs ? a : a.toLowerCase());
    return op === '=' ? `(${c} IS NOT NULL AND ${l} = ${r})` : `(${c} IS NULL OR ${l} <> ${r})`;
  }
  if (type === 'boolean' && op !== '=' && op !== '!=') return null;
  const A = lit(a, type);
  const B = b === undefined ? null : lit(b, type);
  if (A == null || (op === 'between' && B == null)) return null;
  switch (op) {
    case '=': return `(${c} IS NOT NULL AND ${c} = ${A})`;
    case '!=': return `(${c} IS NULL OR ${c} <> ${A})`;
    case '>': case '>=': case '<': case '<=': return `(${c} ${op} ${A})`;
    case 'between': return `(${c} BETWEEN ${A} AND ${B})`;
  }
  return null;
}

const selectList = (fields) => fields.map(f => qi(f.name)).join(', ');
const numbered = () => `(SELECT *, row_number() OVER () AS ${RN} FROM input)`;

const COMPILERS = {
  filter(d, fields, types) {
    if (d.loose) return null;
    if (d.mode === 'values') {
      const type = types.get(d.column);
      if (!type || !['text', 'integer', 'date', 'boolean'].includes(type)) return null;
      const c = qi(d.column);
      const items = d.values?.list || [];
      const hasNull = items.some(v => v == null);
      const vals = items.filter(v => v != null).map(v => sqlStr(String(v)));
      const include = d.values?.include !== false;
      const str = type === 'text' ? c : `CAST(${c} AS VARCHAR)`;
      const hit = vals.length ? `${str} IN (${vals.join(', ')})` : 'FALSE';
      return { where: `CASE WHEN ${c} IS NULL THEN ${hasNull === include ? 'TRUE' : 'FALSE'} ELSE ${include ? hit : `NOT (${hit})`} END`, fields };
    }
    if (d.mode && d.mode !== 'rules') return null;
    const rules = d.rules || [];
    if (!rules.length) return null;
    const parts = rules.map(r => ruleSql(r, types));
    if (parts.some(p => p == null)) return null;
    return { where: parts.join(d.logic === 'any' ? ' OR ' : ' AND '), fields };
  },

  sort(d, fields, types) {
    const keys = d.keys || [];
    if (!keys.length || keys.some(k => !types.has(k.column))) return null;
    const nulls = d.nullsLast !== false ? 'NULLS LAST' : 'NULLS FIRST';
    const order = keys.map(k => `${types.get(k.column) === 'text' ? `lower(${qi(k.column)})` : qi(k.column)} ${k.direction === 'desc' ? 'DESC' : 'ASC'} ${nulls}`);
    return { sql: `SELECT ${selectList(fields)} FROM ${numbered()} ORDER BY ${order.join(', ')}, ${RN}`, fields };
  },

  select_columns(d, fields, types) {
    const cols = d.columns || [];
    if (!cols.length || new Set(cols).size !== cols.length || cols.some(c => !types.has(c))) return null;
    const out = cols.map(c => ({ name: c, type: types.get(c) }));
    return { sql: `SELECT ${selectList(out)} FROM input`, fields: out };
  },

  remove_columns(d, fields, types) {
    const drop = new Set(d.columns || []);
    if (!drop.size || [...drop].some(c => !types.has(c))) return null;
    const out = fields.filter(f => !drop.has(f.name));
    if (!out.length) return null;
    return { sql: `SELECT ${selectList(out)} FROM input`, fields: out };
  },

  rename_columns(d, fields, types) {
    const map = new Map();
    for (const [a, b] of Object.entries(d.mapping || {})) {
      if (!b || a === b) continue;
      if (!types.has(a)) return null;
      map.set(a, String(b).trim());
    }
    if (!map.size) return null;
    const out = fields.map(f => ({ name: map.get(f.name) || f.name, type: f.type }));
    if (new Set(out.map(f => f.name)).size !== out.length) return null;
    return { sql: `SELECT ${fields.map((f, i) => (map.has(f.name) ? `${qi(f.name)} AS ${qi(out[i].name)}` : qi(f.name))).join(', ')} FROM input`, fields: out };
  },

  keep_rows(d, fields) {
    const n = Math.max(0, Math.floor(Number(d.count) || 0));
    if (d.mode === 'first') return { sql: `SELECT * FROM input LIMIT ${n}`, fields };
    if (d.mode === 'remove_first') return { sql: `SELECT * FROM input OFFSET ${n}`, fields };
    if (d.mode === 'range') return { sql: `SELECT * FROM input LIMIT ${n} OFFSET ${Math.max(0, (Number(d.offset) || 1) - 1)}`, fields };
    return null;
  },

  remove_blank_rows(d, fields, types) {
    const names = d.columns?.length ? d.columns : fields.map(f => f.name);
    if (names.some(n => !types.has(n))) return null;
    const parts = names.map(n => blank(qi(n), types.get(n)));
    return { where: `NOT (${parts.join(d.mode === 'any' ? ' OR ' : ' AND ')})`, fields };
  },

  remove_duplicates(d, fields, types) {
    if (d.matchMode && d.matchMode !== 'exact') return null;
    const keys = d.columns?.length ? d.columns : fields.map(f => f.name);
    if (!keys.length || keys.some(k => !types.has(k))) return null;
    let order;
    if (d.orderBy) {
      const t = types.get(d.orderBy);
      if (!t || t === 'text') return null;
      order = `${qi(d.orderBy)} ASC NULLS LAST, ${RN}`;
    } else order = d.keep === 'last' ? `${RN} DESC` : RN;
    return { sql: `SELECT ${selectList(fields)} FROM ${numbered()} QUALIFY row_number() OVER (PARTITION BY ${keys.map(qi).join(', ')} ORDER BY ${order}) = 1 ORDER BY ${RN}`, fields };
  },

  group_by(d, fields, types) {
    const gcols = d.groupColumns || [];
    const aggs = d.aggregations || [];
    if (!aggs.length || gcols.some(g => !types.has(g))) return null;
    const out = gcols.map(g => ({ name: g, type: types.get(g) }));
    const exprs = [];
    for (const a of aggs) {
      const name = a.name?.trim() || aggDefaultName(a);
      const type = a.fn === 'count' ? 'integer' : types.get(a.column);
      if (a.fn !== 'count' && !type) return null;
      const c = a.fn === 'count' ? null : qi(a.column);
      let e = null;
      switch (a.fn) {
        case 'count': e = 'count(*)'; break;
        case 'count_nonblank': e = `count(*) FILTER (WHERE NOT ${blank(c, type)})`; break;
        case 'count_distinct': e = `count(DISTINCT CASE WHEN NOT ${blank(c, type)} THEN ${c} END)`; break;
        case 'sum': if (isNumeric(type)) e = `CAST(sum(${c}) AS ${type === 'integer' ? 'BIGINT' : 'DOUBLE'})`; break;
        case 'avg': if (isNumeric(type)) e = `CAST(avg(${c}) AS DOUBLE)`; break;
        case 'median': if (isNumeric(type)) e = `CAST(median(${c}) AS DOUBLE)`; break;
        case 'std': if (isNumeric(type)) e = `CAST(stddev_samp(${c}) AS DOUBLE)`; break;
        case 'min': case 'max': if (type !== 'text') e = `${a.fn}(${c})`; break;
      }
      if (!e) return null;
      exprs.push(`${e} AS ${qi(name)}`);
      out.push({ name, type: aggType(a.fn, type) });
    }
    if (new Set(out.map(f => f.name)).size !== out.length) return null;
    if (!gcols.length) return { sql: `SELECT ${exprs.join(', ')} FROM input`, fields: out };
    const g = gcols.map(qi).join(', ');
    return { sql: `SELECT ${g}, ${exprs.join(', ')} FROM ${numbered()} GROUP BY ${g} ORDER BY min(${RN})`, fields: out };
  },
};

export function compileStep(step, fields, ctx = {}) {
  if (!mayCompile(step) || !Array.isArray(fields) || !fields.length) return null;
  const types = new Map(fields.map(f => [f.name, f.type]));
  const c = { probe: () => null, dep: () => null, ...ctx };
  let r;
  try { r = (COMPILERS[step.type] || MORE[step.type])(step.data || {}, fields, types, c); } catch { return null; }
  if (!r) return null;
  if (r.where != null) return { sql: `SELECT * FROM input WHERE ${r.where}`, fields: r.fields.map(f => ({ ...f })) };
  return { sql: r.sql, fields: r.fields.map(f => ({ ...f })) };
}
