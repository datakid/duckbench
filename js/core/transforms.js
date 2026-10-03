import { Frame } from './frame.js';
import { convertValue, formatValue, parseNumberString, parseBoolString, compareValues, isNumeric, isTemporal, unifyTypes, inferColumnType, floorDay, DAY_MS, TYPE_LABELS } from './types.js';
import { normalizeKey, looseText, compositeKey, compositeKeyWithNulls, MATCH_MODES } from './normalize.js';
import { evaluateFormula, formulaPredicate, fmtDate } from './formula.js';
import { uniqueName, dedupeNames, seededRandom, unescapeDelimiter, parseList } from './util.js';

export const TRANSFORMS = {};
const def = (type, spec) => { TRANSFORMS[type] = { type, ...spec }; };

const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const fmt = (v, t) => (v == null ? '' : typeof v === 'string' ? v : formatValue(v, t));
const list = (a) => (Array.isArray(a) ? a.filter(x => x != null && x !== '') : a ? [a] : []);

export const OPERATORS = [
  { value: '=', label: 'equals', sym: '=' },
  { value: '!=', label: 'does not equal', sym: '≠' },
  { value: '>', label: 'greater than', sym: '>' },
  { value: '>=', label: 'at least', sym: '≥' },
  { value: '<', label: 'less than', sym: '<' },
  { value: '<=', label: 'at most', sym: '≤' },
  { value: 'between', label: 'is between', sym: 'between' },
  { value: 'contains', label: 'contains', sym: 'contains' },
  { value: 'not_contains', label: 'does not contain', sym: '∌' },
  { value: 'starts_with', label: 'starts with', sym: 'starts' },
  { value: 'ends_with', label: 'ends with', sym: 'ends' },
  { value: 'in_list', label: 'is one of (comma list)', sym: '∈' },
  { value: 'not_in_list', label: 'is not one of', sym: '∉' },
  { value: 'regex', label: 'matches regex', sym: '~' },
  { value: 'is_null', label: 'is empty', sym: 'is empty' },
  { value: 'is_not_null', label: 'is not empty', sym: 'not empty' },
];
const NO_VALUE_OPS = new Set(['is_null', 'is_not_null']);
const TEXT_OPS = new Set(['contains', 'not_contains', 'starts_with', 'ends_with', 'regex']);
const opSym = (op) => OPERATORS.find(o => o.value === op)?.sym || op;

function coerceLiteral(raw, type) {
  if (raw == null) return undefined;
  if (type === 'text') return String(raw);
  if (isNumeric(type)) { const n = parseNumberString(raw, true); return n == null ? undefined : n; }
  if (type === 'boolean') { const b = parseBoolString(raw); return b == null ? undefined : b; }
  if (isTemporal(type)) { const t = convertValue(String(raw), type); return t == null ? undefined : t; }
  return raw;
}

export function rulePredicate(frame, rule) {
  frame.require(rule.column);
  const col = frame.col(rule.column);
  const type = frame.typeOf(rule.column);
  const op = rule.operator || '=';
  if (op === 'is_null') return (r) => isEmpty(col[r]);
  if (op === 'is_not_null') return (r) => !isEmpty(col[r]);
  const raw = rule.value ?? '';
  if (TEXT_OPS.has(op)) {
    if (op === 'regex') {
      let re;
      try { re = new RegExp(String(raw), rule.caseSensitive ? 'u' : 'iu'); } catch { throw new Error(`Invalid regular expression: ${raw}`); }
      return (r) => col[r] != null && re.test(fmt(col[r], type));
    }
    const norm = rule.loose ? (v) => looseText(v, 'arabic') : rule.caseSensitive ? (v) => fmt(v, type) : (v) => fmt(v, type).toLowerCase();
    const needle = rule.loose ? looseText(raw, 'arabic') : rule.caseSensitive ? String(raw) : String(raw).toLowerCase();
    switch (op) {
      case 'contains': return (r) => col[r] != null && norm(col[r]).includes(needle);
      case 'not_contains': return (r) => col[r] == null || !norm(col[r]).includes(needle);
      case 'starts_with': return (r) => col[r] != null && norm(col[r]).startsWith(needle);
      case 'ends_with': return (r) => col[r] != null && norm(col[r]).endsWith(needle);
    }
  }
  if (op === 'in_list' || op === 'not_in_list') {
    const mode = rule.loose ? 'arabic' : type === 'text' && !rule.caseSensitive ? 'loose' : 'exact';
    const items = parseList(raw).map(s => {
      const lit = coerceLiteral(s, type);
      return normalizeKey(lit === undefined ? s : lit, mode, type);
    });
    const set = new Set(items);
    const neg = op === 'not_in_list';
    return (r) => {
      const v = col[r];
      if (v == null) return neg;
      const hit = set.has(normalizeKey(v, mode, type));
      return neg ? !hit : hit;
    };
  }
  if (rule.loose && type === 'text' && (op === '=' || op === '!=')) {
    const needle = looseText(raw, 'arabic');
    return op === '=' ? (r) => col[r] != null && looseText(col[r], 'arabic') === needle : (r) => col[r] == null || looseText(col[r], 'arabic') !== needle;
  }
  const lit = coerceLiteral(raw, type);
  const lit2 = op === 'between' ? coerceLiteral(rule.value2 ?? '', type) : undefined;
  const textual = lit === undefined || (op === 'between' && lit2 === undefined);
  const get = textual ? (r) => fmt(col[r], type) : (r) => col[r];
  const a = textual ? String(raw) : lit;
  const b = textual ? String(rule.value2 ?? '') : lit2;
  const eq = (v) => {
    if (typeof v === 'string' && typeof a === 'string') return type === 'text' && !rule.caseSensitive ? v.toLowerCase() === a.toLowerCase() : v === a;
    return v === a;
  };
  switch (op) {
    case '=': return (r) => col[r] != null && eq(get(r));
    case '!=': return (r) => col[r] == null || !eq(get(r));
    case '>': return (r) => col[r] != null && compareValues(get(r), a) > 0;
    case '>=': return (r) => col[r] != null && compareValues(get(r), a) >= 0;
    case '<': return (r) => col[r] != null && compareValues(get(r), a) < 0;
    case '<=': return (r) => col[r] != null && compareValues(get(r), a) <= 0;
    case 'between': return (r) => col[r] != null && compareValues(get(r), a) >= 0 && compareValues(get(r), b) <= 0;
  }
  throw new Error(`Unknown condition “${op}”.`);
}

function ruleSummary(rule) {
  if (!rule) return '';
  if (NO_VALUE_OPS.has(rule.operator)) return `${rule.column} ${opSym(rule.operator)}`;
  if (rule.operator === 'between') return `${rule.column} between ${rule.value} and ${rule.value2}`;
  return `${rule.column} ${opSym(rule.operator)} ${rule.value}`;
}

function ruleValidate(rule) {
  if (!rule.column) return 'Every condition needs a column.';
  if (!NO_VALUE_OPS.has(rule.operator) && (rule.value === '' || rule.value == null)) return `Enter a value for “${rule.column}”.`;
  if (rule.operator === 'between' && (rule.value2 === '' || rule.value2 == null)) return 'Enter both ends of the range.';
  return null;
}

const RULE_FIELDS = [
  { key: 'column', type: 'column', label: 'Column' },
  { key: 'operator', type: 'enum', label: 'Condition', options: OPERATORS.map(o => ({ value: o.value, label: o.label })), default: '=' },
  { key: 'value', type: 'text', label: 'Value', placeholder: 'Value', visible: (f) => !NO_VALUE_OPS.has(f.operator) },
  { key: 'value2', type: 'text', label: 'and', placeholder: 'Upper bound', visible: (f) => f.operator === 'between' },
];

const AGG_FNS = [
  { value: 'count', label: 'Count rows' },
  { value: 'count_nonblank', label: 'Count non-empty' },
  { value: 'count_distinct', label: 'Count distinct' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'std', label: 'Std deviation' },
  { value: 'first', label: 'First value' },
  { value: 'last', label: 'Last value' },
  { value: 'concat', label: 'Join distinct values' },
];

function aggregate(fn, values, type) {
  switch (fn) {
    case 'count': return values.length;
    case 'count_nonblank': { let n = 0; for (const v of values) if (!isEmpty(v)) n++; return n; }
    case 'count_distinct': { const s = new Set(); for (const v of values) if (!isEmpty(v)) s.add(typeof v === 'string' ? v : formatValue(v, type)); return s.size; }
    case 'first': { for (const v of values) if (v != null) return v; return null; }
    case 'last': { for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]; return null; }
    case 'concat': { const s = []; const seen = new Set(); for (const v of values) { if (isEmpty(v)) continue; const k = fmt(v, type); if (!seen.has(k)) { seen.add(k); s.push(k); } } return s.length ? s.join(', ') : null; }
    case 'min': case 'max': {
      let best = null;
      for (const v of values) { if (v == null) continue; if (best == null || (fn === 'min' ? compareValues(v, best) < 0 : compareValues(v, best) > 0)) best = v; }
      return best;
    }
  }
  const nums = [];
  for (const v of values) { const n = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : parseNumberString(v); if (n != null && Number.isFinite(n)) nums.push(n); }
  if (fn === 'sum') return nums.length ? kahanSum(nums) : null;
  if (!nums.length) return null;
  if (fn === 'avg') return kahanSum(nums) / nums.length;
  if (fn === 'median') { nums.sort((a, b) => a - b); const m = nums.length >> 1; return nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2; }
  if (fn === 'std') { if (nums.length < 2) return null; const mean = kahanSum(nums) / nums.length; let s = 0; for (const x of nums) s += (x - mean) ** 2; return Math.sqrt(s / (nums.length - 1)); }
  return null;
}

function kahanSum(nums) {
  let sum = 0, c = 0;
  for (const x of nums) { const y = x - c; const t = sum + y; c = (t - sum) - y; sum = t; }
  return Math.round(sum * 1e10) / 1e10;
}

export function aggType(fn, type) {
  if (fn.startsWith('count')) return 'integer';
  if (fn === 'sum') return type === 'integer' ? 'integer' : 'number';
  if (fn === 'avg' || fn === 'median' || fn === 'std') return 'number';
  if (fn === 'concat') return 'text';
  return type || 'text';
}

export const aggDefaultName = (a) => (a.fn === 'count' ? 'Count' : `${AGG_FNS.find(f => f.value === a.fn)?.label.split(' ')[0] || a.fn} of ${a.column}`);

function groupRows(frame, columns) {
  const cols = columns.map(c => frame.col(c));
  const types = columns.map(c => frame.typeOf(c));
  const map = new Map();
  const groups = [];
  for (let r = 0; r < frame.rowCount; r++) {
    const key = columns.length ? compositeKeyWithNulls(cols, r, 'exact', types) : '';
    let g = map.get(key);
    if (!g) { g = { first: r, rows: [] }; map.set(key, g); groups.push(g); }
    g.rows.push(r);
  }
  return groups;
}

function convertColumn(values, from, to, opts, counter) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = null; continue; }
    let c = convertValue(v, to, { ...opts, fromType: from });
    if (c === undefined) { counter.failed++; if (counter.examples.length < 3) counter.examples.push(String(v)); c = null; }
    out[i] = c;
  }
  return out;
}

function retypeColumns(frame, names) {
  let f = frame;
  for (const n of names) {
    const vals = f.col(n);
    const t = inferColumnType(vals);
    if (t === 'text') continue;
    const counter = { failed: 0, examples: [] };
    const out = convertColumn(vals, 'text', t, {}, counter);
    if (!counter.failed) f = f.replaceColumn(n, out, t);
  }
  return f;
}

const textColumns = (frame, cols) => (cols && cols.length ? cols : frame.fields.filter(f => f.type === 'text').map(f => f.name));

function mapTextColumns(frame, columns, fn) {
  let f = frame;
  for (const c of columns) {
    frame.require(c);
    const type = f.typeOf(c);
    f = f.mapColumn(c, (v) => {
      if (v == null) return null;
      const s = typeof v === 'string' ? v : formatValue(v, type);
      const out = fn(s);
      return out === '' && type !== 'text' ? null : out;
    }, 'text');
  }
  return f;
}

const posOf = (frame, col) => frame.indexOf(col) + 1;

def('filter', {
  label: 'Filter rows', code: 'FLT', category: 'Rows', icon: 'filter',
  ribbon: { tab: 'home', group: 'Reduce rows', size: 'large' },
  keywords: 'where keep exclude condition',
  params: [
    { key: 'mode', type: 'segmented', label: 'Filter by', default: 'rules', options: [{ value: 'rules', label: 'Conditions' }, { value: 'values', label: 'Pick values' }, { value: 'formula', label: 'Formula' }] },
    { key: 'logic', type: 'segmented', label: 'Keep rows matching', default: 'all', options: [{ value: 'all', label: 'All conditions' }, { value: 'any', label: 'Any condition' }], visible: (d) => d.mode === 'rules' && (d.rules?.length || 0) > 1 },
    { key: 'rules', type: 'repeater', label: 'Conditions', addLabel: '+ Add condition', fields: RULE_FIELDS, default: (d, ctx) => [{ column: ctx.firstColumn, operator: '=', value: '' }], visible: (d) => d.mode === 'rules' },
    { key: 'loose', type: 'toggle', label: 'Loose text match (ignore case, accents, spaces & Arabic variants)', default: false, visible: (d) => d.mode === 'rules' },
    { key: 'column', type: 'column', label: 'Column', visible: (d) => d.mode === 'values', default: (d, ctx) => ctx.firstColumn },
    { key: 'values', type: 'valueset', label: 'Values', column: 'column', default: () => ({ include: true, list: [] }), visible: (d) => d.mode === 'values' },
    { key: 'formula', type: 'formula', label: 'Keep rows where', placeholder: '[quantity] > 2 and contains([status], "ship")', visible: (d) => d.mode === 'formula' },
  ],
  seed: (sel, cell) => {
    if (sel?.column && cell !== undefined) return { mode: 'rules', rules: [{ column: sel.column, operator: cell == null ? 'is_null' : '=', value: cell == null ? '' : String(cell) }] };
    if (sel?.column) return { mode: 'values', column: sel.column, values: { include: true, list: [] } };
    return {};
  },
  migrate(d) {
    if (d.mode === 'operator') return { mode: 'rules', logic: 'all', loose: !!d.loose, rules: [{ column: d.column, operator: d.operator, value: d.value ?? '', value2: d.value2 }] };
    return d;
  },
  validate(d) {
    if (d.mode === 'values') {
      if (!d.column) return 'Choose a column.';
      if (!d.values?.list?.length) return 'Pick at least one value.';
      return null;
    }
    if (d.mode === 'formula') return d.formula?.trim() ? null : 'Write a formula that is true for the rows to keep.';
    if (!d.rules?.length) return 'Add at least one condition.';
    for (const r of d.rules) { const e = ruleValidate(r); if (e) return e; }
    return null;
  },
  summary(d) {
    if (d.mode === 'values') {
      const l = d.values?.list || [];
      const shown = l.slice(0, 3).map(v => (v == null ? '∅' : v)).join(', ');
      return `${d.column} ${d.values?.include === false ? '∉' : '∈'} {${shown}${l.length > 3 ? ` +${l.length - 3}` : ''}}`;
    }
    if (d.mode === 'formula') return d.formula;
    return (d.rules || []).map(ruleSummary).join(d.logic === 'any' ? ' or ' : ' and ');
  },
  apply(frame, d) {
    if (d.mode === 'values') {
      frame.require(d.column);
      const col = frame.col(d.column), type = frame.typeOf(d.column);
      const items = d.values?.list || [];
      const hasNull = items.some(v => v == null);
      const set = new Set(items.filter(v => v != null).map(String));
      const include = d.values?.include !== false;
      return frame.filterRows((r) => {
        const v = col[r];
        const hit = v == null ? hasNull : set.has(fmt(v, type));
        return include ? hit : !hit;
      });
    }
    if (d.mode === 'formula') return frame.filterRows(formulaPredicate(d.formula, frame));
    const preds = d.rules.map(rule => rulePredicate(frame, { ...rule, loose: d.loose || rule.loose }));
    if (preds.length === 1) return frame.filterRows(preds[0]);
    return frame.filterRows(d.logic === 'any' ? (r) => preds.some(p => p(r)) : (r) => preds.every(p => p(r)));
  },
});

def('sort', {
  label: 'Sort rows', code: 'SRT', category: 'Rows', icon: 'sort',
  ribbon: { tab: 'home', group: 'Reduce rows', size: 'large' },
  keywords: 'order ascending descending',
  params: [
    { key: 'keys', type: 'repeater', label: 'Sort by', addLabel: '+ Then by', fields: [
      { key: 'column', type: 'column', label: 'Column' },
      { key: 'direction', type: 'enum', label: 'Order', default: 'asc', options: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }] },
    ], default: (d, ctx) => [{ column: ctx.firstColumn, direction: 'asc' }] },
    { key: 'nullsLast', type: 'toggle', label: 'Empty values last', default: true },
  ],
  seed: (sel) => (sel?.columns?.length ? { keys: sel.columns.map(c => ({ column: c, direction: 'asc' })) } : {}),
  migrate(d) { return d.keys ? d : { keys: [{ column: d.column, direction: d.direction || 'asc' }], nullsLast: d.nullsLast !== false }; },
  validate(d) { return d.keys?.length && d.keys.every(k => k.column) ? null : 'Choose a column to sort by.'; },
  summary(d) { return (d.keys || []).map(k => `${k.column} ${k.direction === 'desc' ? '↓' : '↑'}`).join(', '); },
  apply(frame, d) {
    frame.require(d.keys.map(k => k.column));
    return frame.take(frame.sortIndex(d.keys.map(k => ({ ...k, nullsLast: d.nullsLast !== false }))));
  },
});

def('remove_duplicates', {
  label: 'Remove duplicates', code: 'DUP', category: 'Rows', icon: 'layers',
  ribbon: { tab: 'home', group: 'Reduce rows', size: 'large' },
  keywords: 'distinct unique dedupe',
  params: [
    { key: 'columns', type: 'columns', label: 'Match on (empty = whole row)', default: () => [] },
    { key: 'matchMode', type: 'enum', label: 'Treat as duplicates when', default: 'exact', options: MATCH_MODES },
    { key: 'keep', type: 'segmented', label: 'Keep', default: 'first', options: [{ value: 'first', label: 'First occurrence' }, { value: 'last', label: 'Last occurrence' }] },
    { key: 'orderBy', type: 'columnOptional', label: 'Or keep the row with the lowest', default: '' },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  summary(d) { const mm = d.matchMode && d.matchMode !== 'exact' ? ` (${d.matchMode})` : ''; return (d.columns?.length ? `on ${d.columns.join(', ')}` : 'whole row') + mm; },
  apply(frame, d, ctx) {
    const keys = d.columns?.length ? d.columns : frame.names;
    frame.require(keys);
    const cols = keys.map(c => frame.col(c)), types = keys.map(c => frame.typeOf(c));
    const mode = d.matchMode || 'exact';
    const winners = new Map();
    const orderCol = d.orderBy ? frame.col(d.orderBy) : null;
    for (let r = 0; r < frame.rowCount; r++) {
      const k = compositeKeyWithNulls(cols, r, mode, types);
      const cur = winners.get(k);
      if (cur === undefined) winners.set(k, r);
      else if (orderCol) {
        const a = orderCol[r], b = orderCol[cur];
        if (b == null && a != null) winners.set(k, r);
        else if (a != null && compareValues(a, b) < 0) winners.set(k, r);
      } else if (d.keep === 'last') winners.set(k, r);
    }
    const idx = [...winners.values()].sort((a, b) => a - b);
    const removed = frame.rowCount - idx.length;
    if (removed) ctx.info(`${removed.toLocaleString()} duplicate row${removed === 1 ? '' : 's'} removed`);
    return frame.take(idx);
  },
});

def('remove_blank_rows', {
  label: 'Remove blank rows', code: 'BLK', category: 'Rows', icon: 'eraser',
  ribbon: { tab: 'home', group: 'Reduce rows', size: 'small' },
  keywords: 'empty null missing',
  params: [
    { key: 'columns', type: 'columns', label: 'Look at (empty = every column)', default: () => [] },
    { key: 'mode', type: 'segmented', label: 'Remove a row when', default: 'all', options: [{ value: 'all', label: 'All are blank' }, { value: 'any', label: 'Any is blank' }] },
  ],
  seed: (sel) => (sel?.columns?.length ? { columns: sel.columns, mode: 'any' } : {}),
  summary(d) { return d.columns?.length ? `${d.mode === 'any' ? 'any' : 'all'} of ${d.columns.join(', ')} blank` : 'rows blank in every column'; },
  apply(frame, d) {
    const names = d.columns?.length ? d.columns : frame.names;
    frame.require(names);
    const cols = names.map(n => frame.col(n));
    if (d.mode === 'any') return frame.filterRows((r) => !cols.some(c => isEmpty(c[r])));
    return frame.filterRows((r) => !cols.every(c => isEmpty(c[r])));
  },
});

def('keep_rows', {
  label: 'Keep / remove rows', code: 'TOP', category: 'Rows', icon: 'crop',
  ribbon: { tab: 'home', group: 'Reduce rows', size: 'small' },
  keywords: 'limit top bottom first last head tail sample range offset skip',
  params: [
    { key: 'mode', type: 'enum', label: 'Action', default: 'first', options: [
      { value: 'first', label: 'Keep first N rows' }, { value: 'last', label: 'Keep last N rows' },
      { value: 'range', label: 'Keep a range of rows' }, { value: 'remove_first', label: 'Remove first N rows' },
      { value: 'remove_last', label: 'Remove last N rows' }, { value: 'every', label: 'Keep every Nth row' },
      { value: 'sample', label: 'Random sample of N rows' },
    ] },
    { key: 'offset', type: 'number', label: 'Starting at row', default: 1, min: 1, visible: (d) => d.mode === 'range' },
    { key: 'count', type: 'number', label: 'N', default: 100, min: 0 },
    { key: 'seed', type: 'number', label: 'Random seed', default: 42, visible: (d) => d.mode === 'sample' },
  ],
  migrate(d) { return d.mode ? d : { mode: 'range', offset: (Number(d.offset) || 0) + 1, count: d.count }; },
  validate(d) { return Number(d.count) >= 0 ? null : 'Enter how many rows.'; },
  summary(d) {
    const n = Number(d.count) || 0;
    return { first: `first ${n}`, last: `last ${n}`, range: `rows ${d.offset}–${(Number(d.offset) || 1) + n - 1}`, remove_first: `drop first ${n}`, remove_last: `drop last ${n}`, every: `every ${n}th`, sample: `sample ${n}` }[d.mode];
  },
  apply(frame, d) {
    const n = Math.max(0, Math.floor(Number(d.count) || 0));
    const total = frame.rowCount;
    switch (d.mode) {
      case 'first': return frame.slice(0, n);
      case 'last': return frame.slice(Math.max(0, total - n), total);
      case 'range': { const s = Math.max(0, (Number(d.offset) || 1) - 1); return frame.slice(s, s + n); }
      case 'remove_first': return frame.slice(n, total);
      case 'remove_last': return frame.slice(0, Math.max(0, total - n));
      case 'every': { if (n < 1) return frame; const idx = []; for (let i = 0; i < total; i += n) idx.push(i); return frame.take(idx); }
      case 'sample': {
        if (n >= total) return frame;
        const rnd = seededRandom(d.seed ?? 42);
        const idx = Array.from({ length: total }, (_, i) => i);
        for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (total - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        return frame.take(idx.slice(0, n).sort((a, b) => a - b));
      }
    }
    return frame;
  },
});

def('promote_headers', {
  label: 'Use first row as headers', code: 'HDR', category: 'Table', icon: 'heading',
  ribbon: { tab: 'transform', group: 'Table', size: 'small' },
  keywords: 'header promote',
  params: [],
  summary() { return 'row 1 → column names'; },
  apply(frame) {
    if (!frame.rowCount) throw new Error('There is no row to promote.');
    const names = dedupeNames(frame.columns.map((c, i) => fmt(c[0], frame.fields[i].type).trim()));
    const rest = frame.slice(1, frame.rowCount);
    const f = new Frame(names.map(n => ({ name: n, type: 'text' })), rest.columns.map((c, i) => (frame.fields[i].type === 'text' ? c : c.map(v => (v == null ? null : formatValue(v, frame.fields[i].type))))), rest.rowCount, rest.rid);
    return f.autoType();
  },
});

def('demote_headers', {
  label: 'Use headers as first row', code: 'DEM', category: 'Table', icon: 'heading',
  ribbon: { tab: 'transform', group: 'Table', size: 'small' },
  keywords: 'header demote',
  params: [],
  summary() { return 'column names → row 1'; },
  apply(frame) {
    const cols = frame.columns.map((c, i) => [frame.fields[i].name, ...c.map(v => (v == null ? null : fmt(v, frame.fields[i].type)))]);
    return new Frame(frame.fields.map((_, i) => ({ name: `Column${i + 1}`, type: 'text' })), cols, frame.rowCount + 1);
  },
});

def('transpose', {
  label: 'Transpose', code: 'TRN', category: 'Table', icon: 'pivot',
  ribbon: { tab: 'transform', group: 'Table', size: 'small' },
  keywords: 'flip swap rows columns',
  params: [{ key: 'headerFromFirst', type: 'toggle', label: 'Use first column as new headers', default: true }],
  summary(d) { return d.headerFromFirst ? 'rows ↔ columns, first column as headers' : 'rows ↔ columns'; },
  apply(frame, d) {
    if (frame.rowCount > 5000) throw new Error('Transpose is limited to 5,000 rows — filter or group first.');
    const useFirst = d.headerFromFirst && frame.fields.length > 0;
    const startCol = useFirst ? 1 : 0;
    const headerNames = useFirst ? dedupeNames(frame.columns[0].map(v => fmt(v, frame.fields[0].type))) : Array.from({ length: frame.rowCount }, (_, i) => `Row${i + 1}`);
    const names = dedupeNames(['Column', ...headerNames]);
    const outCols = names.map(() => []);
    for (let c = startCol; c < frame.fields.length; c++) {
      outCols[0].push(frame.fields[c].name);
      for (let r = 0; r < frame.rowCount; r++) outCols[r + 1].push(fmt(frame.columns[c][r], frame.fields[c].type) || null);
    }
    return Frame.fromText(names, outCols);
  },
});

def('delete_rows', {
  label: 'Delete rows', code: 'DEL', category: 'Rows', icon: 'trash',
  hidden: true,
  params: [],
  summary(d) { const n = d.rids?.length || 0; return `${n} row${n === 1 ? '' : 's'} by hand`; },
  validate(d) { return d.rids?.length ? null : 'No rows selected.'; },
  apply(frame, d) {
    const set = new Set(d.rids.map(Number));
    const rid = frame.rid;
    return frame.filterRows((r) => !set.has(rid[r]));
  },
});

def('edit_cells', {
  label: 'Edit cells', code: 'EDT', category: 'Rows', icon: 'edit',
  hidden: true,
  params: [],
  summary(d) { const n = d.edits?.length || 0; if (n === 1) { const e = d.edits[0]; return `${e.column} @ row ${e.rid} → ${e.value ?? '∅'}`; } return `${n} cells by hand`; },
  migrate(d) { return d.edits ? d : { edits: [{ rid: Number(d.rid), column: d.column, value: d.value }] }; },
  apply(frame, d, ctx) {
    const byRid = new Map();
    for (let r = 0; r < frame.rowCount; r++) byRid.set(frame.rid[r], r);
    const changed = new Map();
    let missing = 0;
    for (const e of d.edits || []) {
      if (!frame.has(e.column)) { missing++; continue; }
      const r = byRid.get(Number(e.rid));
      if (r === undefined) { missing++; continue; }
      let col = changed.get(e.column);
      if (!col) { col = frame.col(e.column).slice(); changed.set(e.column, col); }
      const type = frame.typeOf(e.column);
      const v = e.value == null || e.value === '' ? null : convertValue(e.value, type, { lenient: true });
      if (v === undefined) { ctx.warn(`“${e.value}” isn't a valid ${TYPE_LABELS[type].toLowerCase()} for ${e.column}; left empty`); col[r] = null; }
      else col[r] = v;
    }
    if (missing) ctx.warn(`${missing} edit${missing === 1 ? '' : 's'} no longer match a row or column`);
    let f = frame;
    for (const [name, col] of changed) f = f.replaceColumn(name, col);
    return f;
  },
});

def('fill', {
  label: 'Fill down / up', code: 'FIL', category: 'Columns', icon: 'arrow-down',
  ribbon: { tab: 'transform', group: 'Any column', size: 'small' },
  keywords: 'forward fill carry previous',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', default: (d, ctx) => ctx.selection || [] },
    { key: 'direction', type: 'segmented', label: 'Direction', default: 'down', options: [{ value: 'down', label: 'Down' }, { value: 'up', label: 'Up' }] },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { return d.columns?.length ? null : 'Pick at least one column.'; },
  summary(d) { return `${d.columns.join(', ')} ${d.direction === 'up' ? '↑' : '↓'}`; },
  apply(frame, d) {
    let f = frame;
    for (const c of d.columns) {
      const src = f.col(c);
      const out = src.slice();
      if (d.direction === 'up') { let last = null; for (let r = out.length - 1; r >= 0; r--) { if (isEmpty(out[r])) out[r] = last; else last = out[r]; } }
      else { let last = null; for (let r = 0; r < out.length; r++) { if (isEmpty(out[r])) out[r] = last; else last = out[r]; } }
      f = f.replaceColumn(c, out);
    }
    return f;
  },
});

def('replace_nulls', {
  label: 'Replace empty values', code: 'NUL', category: 'Columns', icon: 'replace',
  ribbon: { tab: 'transform', group: 'Any column', size: 'small' },
  keywords: 'null blank missing default coalesce',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', default: (d, ctx) => ctx.selection || [] },
    { key: 'value', type: 'text', label: 'Replace with', default: '' },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { return d.columns?.length ? null : 'Pick at least one column.'; },
  summary(d) { return `${d.columns.join(', ')} ∅ → ${d.value === '' ? '“”' : d.value}`; },
  apply(frame, d, ctx) {
    let f = frame;
    for (const c of d.columns) {
      const type = f.typeOf(c);
      let lit = d.value === '' && type === 'text' ? '' : convertValue(d.value, type, { lenient: true });
      if (lit === undefined || (lit === null && d.value !== '')) {
        ctx.warn(`“${d.value}” isn't a valid ${TYPE_LABELS[type].toLowerCase()} — ${c} converted to text`);
        f = f.mapColumn(c, v => (isEmpty(v) ? String(d.value) : fmt(v, type)), 'text');
        continue;
      }
      f = f.mapColumn(c, v => (isEmpty(v) ? lit : v));
    }
    return f;
  },
});

def('select_columns', {
  label: 'Choose columns', code: 'SEL', category: 'Columns', icon: 'columns-keep',
  ribbon: { tab: 'home', group: 'Manage columns', size: 'large' },
  keywords: 'keep only pick reorder',
  params: [{ key: 'columns', type: 'columns', label: 'Keep these columns (in this order)', ordered: true, default: (d, ctx) => ctx.selection?.length ? ctx.selection : ctx.columns }],
  seed: (sel) => (sel?.columns?.length ? { columns: sel.columns } : {}),
  validate(d) { return d.columns?.length ? null : 'Keep at least one column.'; },
  summary(d) { return `${d.columns.length} column${d.columns.length === 1 ? '' : 's'}: ${d.columns.slice(0, 4).join(', ')}${d.columns.length > 4 ? '…' : ''}`; },
  apply(frame, d) { return frame.select(d.columns); },
});

def('remove_columns', {
  label: 'Remove columns', code: 'RMV', category: 'Columns', icon: 'columns-remove',
  ribbon: { tab: 'home', group: 'Manage columns', size: 'large' },
  keywords: 'drop delete',
  params: [{ key: 'columns', type: 'columns', label: 'Remove these columns', default: (d, ctx) => ctx.selection || [] }],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d, ctx) {
    if (!d.columns?.length) return 'Pick at least one column.';
    if (ctx.columns && d.columns.length >= ctx.columns.length) return 'That would remove every column.';
    return null;
  },
  summary(d) { return d.columns.join(', '); },
  apply(frame, d) { frame.require(d.columns); return frame.drop(d.columns); },
});

def('rename_columns', {
  label: 'Rename columns', code: 'REN', category: 'Columns', icon: 'edit',
  ribbon: { tab: 'home', group: 'Manage columns', size: 'small' },
  keywords: 'rename header label',
  params: [{ key: 'mapping', type: 'rename', label: 'New names', default: () => ({}) }],
  seed: (sel) => (sel?.column ? { mapping: { [sel.column]: sel.column } } : {}),
  migrate(d) { return d.mapping ? d : { mapping: { [d.column]: d.newName } }; },
  validate(d) {
    const entries = Object.entries(d.mapping || {}).filter(([a, b]) => b && a !== b);
    if (!entries.length) return 'Type a new name for at least one column.';
    return null;
  },
  summary(d) { return Object.entries(d.mapping || {}).filter(([a, b]) => b && a !== b).map(([a, b]) => `${a} → ${b}`).join(', '); },
  apply(frame, d) {
    const map = {};
    for (const [a, b] of Object.entries(d.mapping || {})) { if (!b || a === b) continue; frame.require(a); map[a] = String(b).trim(); }
    return frame.rename(map);
  },
});

def('move_column', {
  label: 'Move column', code: 'MOV', category: 'Columns', icon: 'arrow-right',
  ribbon: { tab: 'home', group: 'Manage columns', size: 'small' },
  keywords: 'reorder position',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns to move', default: (d, ctx) => ctx.selection || [] },
    { key: 'to', type: 'enum', label: 'Move to', default: 'start', options: [{ value: 'start', label: 'Beginning' }, { value: 'end', label: 'End' }, { value: 'before', label: 'Before column…' }, { value: 'after', label: 'After column…' }] },
    { key: 'target', type: 'column', label: 'Column', visible: (d) => d.to === 'before' || d.to === 'after' },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { if (!d.columns?.length) return 'Pick a column to move.'; if ((d.to === 'before' || d.to === 'after') && !d.target) return 'Pick the target column.'; if (d.columns.includes(d.target)) return 'Target must be a different column.'; return null; },
  summary(d) { return `${d.columns.join(', ')} → ${d.to === 'before' || d.to === 'after' ? `${d.to} ${d.target}` : d.to}`; },
  apply(frame, d) {
    frame.require(d.columns, d.target);
    const rest = frame.names.filter(n => !d.columns.includes(n));
    let at = d.to === 'start' ? 0 : d.to === 'end' ? rest.length : rest.indexOf(d.target) + (d.to === 'after' ? 1 : 0);
    rest.splice(at, 0, ...d.columns);
    return frame.select(rest);
  },
});

def('duplicate_column', {
  label: 'Duplicate column', code: 'CPY', category: 'Add column', icon: 'copy',
  ribbon: { tab: 'add', group: 'General', size: 'small' },
  keywords: 'copy clone',
  params: [
    { key: 'column', type: 'column', label: 'Column', default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'name', type: 'text', label: 'New column name', default: '', placeholder: 'e.g. quantity (copy)' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  validate(d) { return d.column ? null : 'Choose a column.'; },
  summary(d) { return `${d.column} → ${d.name || `${d.column} (copy)`}`; },
  apply(frame, d) {
    frame.require(d.column);
    const name = uniqueName(d.name?.trim() || `${d.column} (copy)`, frame.names, ' ');
    return frame.withColumn(name, frame.typeOf(d.column), frame.col(d.column).slice(), posOf(frame, d.column));
  },
});

const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }));
const V1_TYPES = { DOUBLE: 'number', FLOAT: 'number', REAL: 'number', DECIMAL: 'number', BIGINT: 'integer', INTEGER: 'integer', INT: 'integer', SMALLINT: 'integer', VARCHAR: 'text', TEXT: 'text', DATE: 'date', TIMESTAMP: 'datetime', BOOLEAN: 'boolean' };

def('change_type', {
  label: 'Change type', code: 'TYP', category: 'Columns', icon: 'type',
  ribbon: { tab: 'transform', group: 'Any column', size: 'large' },
  keywords: 'convert cast number date text integer',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', default: (d, ctx) => ctx.selection || [] },
    { key: 'type', type: 'enum', label: 'Convert to', default: 'text', options: TYPE_OPTIONS },
    { key: 'lenient', type: 'toggle', label: 'Strip currency, thousands separators, % and (negatives)', default: true, visible: (d) => isNumeric(d.type) },
    { key: 'decimal', type: 'segmented', label: 'Decimal separator', default: '.', options: [{ value: '.', label: '1,234.5' }, { value: ',', label: '1.234,5' }], visible: (d) => isNumeric(d.type) && d.lenient !== false },
    { key: 'dateOrder', type: 'segmented', label: 'Ambiguous dates like 03/04', default: 'auto', options: [{ value: 'auto', label: 'Guess' }, { value: 'MDY', label: 'Month first' }, { value: 'DMY', label: 'Day first' }], visible: (d) => isTemporal(d.type) },
    { key: 'excelSerial', type: 'toggle', label: 'Treat numbers as Excel date serials', default: true, visible: (d) => isTemporal(d.type) },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  migrate(d) { return d.columns ? d : { columns: [d.column], type: V1_TYPES[String(d.targetType || '').toUpperCase().split('(')[0]] || 'text', lenient: true }; },
  validate(d) { return d.columns?.length ? null : 'Pick at least one column.'; },
  summary(d) { return `${d.columns.join(', ')} → ${TYPE_LABELS[d.type] || d.type}`; },
  apply(frame, d, ctx) {
    frame.require(d.columns);
    let f = frame;
    for (const c of d.columns) {
      const from = f.typeOf(c);
      if (from === d.type) continue;
      const counter = { failed: 0, examples: [] };
      const out = convertColumn(f.col(c), from, d.type, { lenient: d.lenient !== false, decimal: d.decimal || '.', dateOrder: d.dateOrder, excelSerial: d.excelSerial !== false }, counter);
      if (counter.failed) ctx.warn(`${c}: ${counter.failed.toLocaleString()} value${counter.failed === 1 ? '' : 's'} couldn't convert (e.g. “${counter.examples.join('”, “')}”) → empty`);
      f = f.replaceColumn(c, out, d.type);
    }
    return f;
  },
});

def('detect_types', {
  label: 'Detect types', code: 'DET', category: 'Columns', icon: 'type',
  ribbon: { tab: 'transform', group: 'Any column', size: 'small' },
  keywords: 'infer auto type',
  params: [{ key: 'columns', type: 'columns', label: 'Columns (empty = all text columns)', default: () => [] }],
  summary(d) { return d.columns?.length ? d.columns.join(', ') : 'all text columns'; },
  apply(frame, d) { return retypeColumns(frame, textColumns(frame, d.columns)); },
});

def('add_column', {
  label: 'Formula column', code: 'FX', category: 'Add column', icon: 'function',
  ribbon: { tab: 'add', group: 'General', size: 'large' },
  keywords: 'custom calculated expression compute derive formula',
  params: [
    { key: 'name', type: 'text', label: 'Column name', default: 'New column' },
    { key: 'formula', type: 'formula', label: 'Formula', placeholder: '[quantity] * [unit_price] * (1 - coalesce([discount], 0))' },
    { key: 'type', type: 'enum', label: 'Result type', default: 'auto', options: [{ value: 'auto', label: 'Detect automatically' }, ...TYPE_OPTIONS] },
    { key: 'replace', type: 'toggle', label: 'Replace the column if this name already exists', default: false },
  ],
  seed: (sel) => (sel?.column ? { formula: `[${sel.column}]` } : {}),
  validate(d, ctx) {
    if (!d.name?.trim()) return 'Name the new column.';
    if (!d.formula?.trim()) return 'Write a formula.';
    if (!d.replace && ctx.columns?.includes(d.name.trim())) return `“${d.name}” already exists — pick another name or turn on “Replace”.`;
    return null;
  },
  summary(d) { return `${d.name} = ${d.formula}`; },
  apply(frame, d) {
    const name = d.name.trim();
    const { values, type } = evaluateFormula(d.formula, frame, d.type);
    let out = values, t = type;
    if (d.type && d.type !== 'auto' && d.type !== type) {
      out = values.map(v => { const c = convertValue(v, d.type, { lenient: true }); return c === undefined ? null : c; });
      t = d.type;
    }
    if (frame.has(name) && !d.replace) throw new Error(`“${name}” already exists.`);
    return frame.withColumn(name, t, out);
  },
});

def('conditional_column', {
  label: 'Conditional column', code: 'IF', category: 'Add column', icon: 'git-branch',
  ribbon: { tab: 'add', group: 'General', size: 'large' },
  keywords: 'if then else case when bucket category',
  params: [
    { key: 'name', type: 'text', label: 'Column name', default: 'Category' },
    { key: 'rules', type: 'repeater', label: 'Rules (first match wins)', addLabel: '+ Add rule', fields: [...RULE_FIELDS, { key: 'output', type: 'text', label: 'Then', placeholder: 'Output (or =[column])' }], default: (d, ctx) => [{ column: ctx.firstColumn, operator: '=', value: '', output: '' }] },
    { key: 'otherwise', type: 'text', label: 'Otherwise', default: '', placeholder: 'Leave empty for blank, or =[column]' },
  ],
  validate(d, ctx) {
    if (!d.name?.trim()) return 'Name the new column.';
    if (ctx.columns?.includes(d.name.trim())) return `“${d.name}” already exists.`;
    if (!d.rules?.length) return 'Add at least one rule.';
    for (const r of d.rules) { const e = ruleValidate(r); if (e) return e; }
    return null;
  },
  summary(d) { return `${d.name}: ${(d.rules || []).length} rule${d.rules?.length === 1 ? '' : 's'}`; },
  apply(frame, d) {
    const preds = d.rules.map(r => rulePredicate(frame, r));
    const outputFor = (spec) => {
      const s = String(spec ?? '');
      const m = /^=\s*\[(.+)\]\s*$/.exec(s);
      if (m) { frame.require(m[1]); const col = frame.col(m[1]); const t = frame.typeOf(m[1]); return (r) => (col[r] == null ? null : fmt(col[r], t)); }
      const v = s === '' ? null : s;
      return () => v;
    };
    const outs = d.rules.map(r => outputFor(r.output));
    const other = outputFor(d.otherwise);
    const vals = new Array(frame.rowCount);
    for (let r = 0; r < frame.rowCount; r++) {
      let v;
      let hit = false;
      for (let i = 0; i < preds.length; i++) if (preds[i](r)) { v = outs[i](r); hit = true; break; }
      vals[r] = hit ? v : other(r);
    }
    const f = frame.withColumn(d.name.trim(), 'text', vals);
    return retypeColumns(f, [d.name.trim()]);
  },
});

def('index_column', {
  label: 'Index column', code: 'IDX', category: 'Add column', icon: 'hash',
  ribbon: { tab: 'add', group: 'General', size: 'small' },
  keywords: 'row number sequence id counter',
  params: [
    { key: 'name', type: 'text', label: 'Column name', default: 'Index' },
    { key: 'start', type: 'number', label: 'Start at', default: 1 },
    { key: 'step', type: 'number', label: 'Increment', default: 1 },
    { key: 'partitionBy', type: 'columns', label: 'Restart for each (optional)', default: () => [] },
  ],
  validate(d, ctx) { if (!d.name?.trim()) return 'Name the column.'; if (ctx.columns?.includes(d.name.trim())) return `“${d.name}” already exists.`; return null; },
  summary(d) { return `${d.name} from ${d.start ?? 1}${d.partitionBy?.length ? ` per ${d.partitionBy.join(', ')}` : ''}`; },
  apply(frame, d) {
    const start = Number(d.start ?? 1), step = Number(d.step ?? 1) || 1;
    const out = new Array(frame.rowCount);
    if (d.partitionBy?.length) {
      frame.require(d.partitionBy);
      const cols = d.partitionBy.map(c => frame.col(c)), types = d.partitionBy.map(c => frame.typeOf(c));
      const counters = new Map();
      for (let r = 0; r < frame.rowCount; r++) { const k = compositeKeyWithNulls(cols, r, 'exact', types); const n = counters.get(k) ?? 0; out[r] = start + n * step; counters.set(k, n + 1); }
    } else for (let r = 0; r < frame.rowCount; r++) out[r] = start + r * step;
    const isInt = Number.isInteger(start) && Number.isInteger(step);
    const f = frame.withColumn(d.name.trim(), isInt ? 'integer' : 'number', out, 0);
    return f;
  },
});

def('split_column', {
  label: 'Split column', code: 'SPL', category: 'Text', icon: 'split',
  ribbon: { tab: 'transform', group: 'Text', size: 'large' },
  keywords: 'delimiter separate explode tokens',
  params: [
    { key: 'column', type: 'column', label: 'Column', default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'by', type: 'segmented', label: 'Split by', default: 'delimiter', options: [{ value: 'delimiter', label: 'Delimiter' }, { value: 'positions', label: 'Positions' }, { value: 'transition', label: 'Digit ↔ letter' }] },
    { key: 'delimiter', type: 'text', label: 'Delimiter', default: ',', placeholder: ', or \\t', visible: (d) => d.by !== 'positions' && d.by !== 'transition' },
    { key: 'at', type: 'enum', label: 'Split at', default: 'each', options: [{ value: 'each', label: 'Each occurrence' }, { value: 'first', label: 'Left-most occurrence' }, { value: 'last', label: 'Right-most occurrence' }], visible: (d) => d.by !== 'positions' && d.by !== 'transition' },
    { key: 'positions', type: 'text', label: 'Positions (0-based, comma separated)', default: '0, 3', visible: (d) => d.by === 'positions' },
    { key: 'mode', type: 'segmented', label: 'Into', default: 'columns', options: [{ value: 'columns', label: 'Columns' }, { value: 'rows', label: 'Rows' }] },
    { key: 'maxParts', type: 'number', label: 'Max columns (0 = auto)', default: 0, min: 0, visible: (d) => d.mode !== 'rows' && d.at !== 'first' && d.at !== 'last' },
    { key: 'trimParts', type: 'toggle', label: 'Trim whitespace around parts', default: true },
    { key: 'keepOriginal', type: 'toggle', label: 'Keep the original column', default: false, visible: (d) => d.mode !== 'rows' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  migrate(d) { return d.by ? d : { ...d, by: 'delimiter', at: 'each', trimParts: false, maxParts: d.maxParts ?? 0 }; },
  validate(d) { if (!d.column) return 'Choose a column.'; if (d.by === 'delimiter' && !d.delimiter) return 'Enter a delimiter.'; return null; },
  summary(d) { const how = d.by === 'positions' ? `at ${d.positions}` : d.by === 'transition' ? 'digit↔letter' : `on “${d.delimiter}”`; return `${d.column} ${how} → ${d.mode === 'rows' ? 'rows' : 'columns'}`; },
  apply(frame, d) {
    frame.require(d.column);
    const col = frame.col(d.column), type = frame.typeOf(d.column);
    const delim = unescapeDelimiter(d.delimiter ?? ',');
    const positions = d.by === 'positions' ? parseList(d.positions).map(Number).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b) : [];
    const splitOne = (v) => {
      if (v == null) return null;
      const s = fmt(v, type);
      let parts;
      if (d.by === 'positions') { parts = []; const ps = positions[0] === 0 ? positions : [0, ...positions]; for (let i = 0; i < ps.length; i++) parts.push(s.slice(ps[i], ps[i + 1])); }
      else if (d.by === 'transition') parts = s.match(/\d+(?:[.,]\d+)*|[^\d]+/g) || [s];
      else if (d.at === 'first') { const i = s.indexOf(delim); parts = i < 0 ? [s] : [s.slice(0, i), s.slice(i + delim.length)]; }
      else if (d.at === 'last') { const i = s.lastIndexOf(delim); parts = i < 0 ? [s] : [s.slice(0, i), s.slice(i + delim.length)]; }
      else parts = s.split(delim);
      return d.trimParts !== false ? parts.map(p => p.trim()) : parts;
    };
    if (d.mode === 'rows') {
      const idx = [], vals = [];
      for (let r = 0; r < frame.rowCount; r++) {
        const parts = splitOne(col[r]);
        if (parts == null) { idx.push(r); vals.push(null); continue; }
        for (const p of parts) { idx.push(r); vals.push(p === '' ? null : p); }
      }
      const out = frame.take(idx);
      out.rid = null;
      const name = d.rowsOutputName && d.rowsOutputName !== d.column ? d.rowsOutputName : d.column;
      let f = d.rowsOutputName && d.rowsOutputName !== d.column && d.keepOriginal ? out.withColumn(name, 'text', vals, posOf(out, d.column)) : out.replaceColumn(d.column, vals, 'text');
      if (name !== d.column && !d.keepOriginal) f = f.rename({ [d.column]: name });
      return retypeColumns(f, [name]);
    }
    const all = new Array(frame.rowCount);
    let width = 0;
    for (let r = 0; r < frame.rowCount; r++) { const p = splitOne(col[r]); all[r] = p; if (p && p.length > width) width = p.length; }
    const max = Number(d.maxParts) || 0;
    if (max > 0 && d.by === 'delimiter' && d.at === 'each') {
      width = Math.min(width, max);
      for (let r = 0; r < all.length; r++) { const p = all[r]; if (p && p.length > max) all[r] = [...p.slice(0, max - 1), p.slice(max - 1).join(delim)]; }
    }
    width = Math.max(width, 1);
    const taken = new Set(frame.names.filter(n => n !== d.column || d.keepOriginal));
    const names = [];
    for (let i = 0; i < width; i++) { const n = uniqueName(`${d.column}_${i + 1}`, taken); taken.add(n); names.push(n); }
    const at = frame.indexOf(d.column);
    let f = d.keepOriginal ? frame : frame.drop([d.column]);
    const insertAt = d.keepOriginal ? at + 1 : at;
    for (let i = width - 1; i >= 0; i--) {
      const vals = all.map(p => (p && p[i] !== undefined && p[i] !== '' ? p[i] : null));
      f = f.withColumn(names[i], 'text', vals, insertAt);
    }
    return retypeColumns(f, names);
  },
});

def('merge_columns', {
  label: 'Merge columns', code: 'MRG', category: 'Text', icon: 'merge',
  ribbon: { tab: 'transform', group: 'Text', size: 'large' },
  keywords: 'concatenate combine join text',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns (in order)', ordered: true, default: (d, ctx) => ctx.selection || [] },
    { key: 'separator', type: 'text', label: 'Separator', default: ' ' },
    { key: 'name', type: 'text', label: 'New column name', default: 'Merged' },
    { key: 'skipEmpty', type: 'toggle', label: 'Skip empty values', default: true },
    { key: 'keepOriginal', type: 'toggle', label: 'Keep the original columns', default: false },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { if ((d.columns?.length || 0) < 2) return 'Pick at least two columns.'; if (!d.name?.trim()) return 'Name the new column.'; return null; },
  summary(d) { return `${d.columns.join(` ${d.separator || ''} `)} → ${d.name}`; },
  apply(frame, d) {
    frame.require(d.columns);
    const cols = d.columns.map(c => frame.col(c)), types = d.columns.map(c => frame.typeOf(c));
    const sep = unescapeDelimiter(d.separator ?? '');
    const vals = new Array(frame.rowCount);
    for (let r = 0; r < frame.rowCount; r++) {
      const parts = [];
      for (let i = 0; i < cols.length; i++) { const v = cols[i][r]; if (d.skipEmpty !== false && isEmpty(v)) continue; parts.push(fmt(v, types[i])); }
      vals[r] = parts.length ? parts.join(sep) : null;
    }
    const at = Math.min(...d.columns.map(c => frame.indexOf(c)));
    let f = d.keepOriginal ? frame : frame.drop(d.columns);
    const name = uniqueName(d.name.trim(), f.names, ' ');
    return f.withColumn(name, 'text', vals, d.keepOriginal ? frame.fields.length : at);
  },
});

def('extract_text', {
  label: 'Extract text', code: 'EXT', category: 'Text', icon: 'scissors',
  ribbon: { tab: 'transform', group: 'Text', size: 'small' },
  keywords: 'substring left right mid before after between regex digits',
  params: [
    { key: 'column', type: 'column', label: 'Column', default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'mode', type: 'enum', label: 'Extract', default: 'first', options: [
      { value: 'first', label: 'First N characters' }, { value: 'last', label: 'Last N characters' }, { value: 'range', label: 'Range (start, length)' },
      { value: 'before', label: 'Text before delimiter' }, { value: 'after', label: 'Text after delimiter' }, { value: 'between', label: 'Text between delimiters' },
      { value: 'regex', label: 'Regex match' }, { value: 'digits', label: 'Only digits' }, { value: 'letters', label: 'Only letters' }, { value: 'length', label: 'Length' },
    ] },
    { key: 'count', type: 'number', label: 'N', default: 3, min: 0, visible: (d) => ['first', 'last', 'range'].includes(d.mode) },
    { key: 'start', type: 'number', label: 'Start at (1-based)', default: 1, min: 1, visible: (d) => d.mode === 'range' },
    { key: 'delimiter', type: 'text', label: 'Delimiter', default: '-', visible: (d) => ['before', 'after', 'between'].includes(d.mode) },
    { key: 'delimiter2', type: 'text', label: 'End delimiter', default: '-', visible: (d) => d.mode === 'between' },
    { key: 'fromEnd', type: 'toggle', label: 'Use the last occurrence', default: false, visible: (d) => ['before', 'after'].includes(d.mode) },
    { key: 'pattern', type: 'text', label: 'Pattern (first capture group if any)', default: '(\\d+)', visible: (d) => d.mode === 'regex' },
    { key: 'name', type: 'text', label: 'New column name (empty = replace in place)', default: '' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  validate(d) { if (!d.column) return 'Choose a column.'; if (d.mode === 'regex') { try { new RegExp(d.pattern); } catch { return 'That regex is invalid.'; } } return null; },
  summary(d) {
    const what = { first: `first ${d.count}`, last: `last ${d.count}`, range: `${d.count} from ${d.start}`, before: `before “${d.delimiter}”`, after: `after “${d.delimiter}”`, between: `between “${d.delimiter}” & “${d.delimiter2}”`, regex: `/${d.pattern}/`, digits: 'digits', letters: 'letters', length: 'length' }[d.mode];
    return `${d.column}: ${what}${d.name ? ` → ${d.name}` : ''}`;
  },
  apply(frame, d) {
    frame.require(d.column);
    const col = frame.col(d.column), type = frame.typeOf(d.column);
    const n = Math.max(0, Number(d.count) || 0);
    const dl = unescapeDelimiter(d.delimiter ?? ''), dl2 = unescapeDelimiter(d.delimiter2 ?? '');
    let re = null;
    if (d.mode === 'regex') re = new RegExp(d.pattern, 'u');
    const fn = (s) => {
      const chars = () => [...s];
      switch (d.mode) {
        case 'first': return chars().slice(0, n).join('');
        case 'last': return n ? chars().slice(-n).join('') : '';
        case 'range': { const st = Math.max(1, Number(d.start) || 1) - 1; return chars().slice(st, st + n).join(''); }
        case 'before': { const i = d.fromEnd ? s.lastIndexOf(dl) : s.indexOf(dl); return i < 0 ? null : s.slice(0, i); }
        case 'after': { const i = d.fromEnd ? s.lastIndexOf(dl) : s.indexOf(dl); return i < 0 ? null : s.slice(i + dl.length); }
        case 'between': { const i = s.indexOf(dl); if (i < 0) return null; const j = s.indexOf(dl2, i + dl.length); return j < 0 ? null : s.slice(i + dl.length, j); }
        case 'regex': { const m = re.exec(s); return m ? (m.length > 1 ? m[1] ?? null : m[0]) : null; }
        case 'digits': return s.replace(/\D+/g, '');
        case 'letters': return s.replace(/[^\p{L}]+/gu, '');
        case 'length': return [...s].length;
      }
      return s;
    };
    const vals = new Array(frame.rowCount);
    for (let r = 0; r < frame.rowCount; r++) { const v = col[r]; if (v == null) { vals[r] = null; continue; } const o = fn(fmt(v, type)); vals[r] = o === '' ? null : o; }
    const outType = d.mode === 'length' ? 'integer' : 'text';
    const name = d.name?.trim();
    let f = name ? frame.withColumn(uniqueName(name, frame.names, ' '), outType, vals, posOf(frame, d.column)) : frame.replaceColumn(d.column, vals, outType);
    if (d.mode === 'digits' || d.mode === 'regex') f = retypeColumns(f, [name ? f.names[posOf(frame, d.column)] : d.column]);
    return f;
  },
});

def('replace_values', {
  label: 'Replace values', code: 'RPL', category: 'Text', icon: 'replace',
  ribbon: { tab: 'transform', group: 'Any column', size: 'large' },
  keywords: 'find substitute regex map',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', default: (d, ctx) => ctx.selection || [] },
    { key: 'match', type: 'segmented', label: 'Match', default: 'whole', options: [{ value: 'whole', label: 'Whole value' }, { value: 'contains', label: 'Part of text' }, { value: 'regex', label: 'Regex' }] },
    { key: 'find', type: 'text', label: 'Find', default: '' },
    { key: 'replace', type: 'text', label: 'Replace with', default: '' },
    { key: 'caseSensitive', type: 'toggle', label: 'Match case', default: true },
  ],
  seed: (sel, cell) => ({ columns: sel?.columns || [], find: cell != null ? String(cell) : '' }),
  migrate(d) { return d.columns ? d : { columns: [d.column], match: d.scope === 'substring' || d.scope === 'contains' ? 'contains' : 'whole', find: d.find, replace: d.replace, caseSensitive: true }; },
  validate(d) { if (!d.columns?.length) return 'Pick at least one column.'; if (d.find === '' && d.match !== 'whole') return 'Enter what to find.'; if (d.match === 'regex') { try { new RegExp(d.find); } catch { return 'That regex is invalid.'; } } return null; },
  summary(d) { return `${d.columns.join(', ')}: “${d.find}” → “${d.replace}”`; },
  apply(frame, d, ctx) {
    frame.require(d.columns);
    let f = frame;
    let changed = 0;
    for (const c of d.columns) {
      const type = f.typeOf(c);
      if (d.match === 'whole') {
        if (type !== 'text') {
          const a = d.find === '' ? null : coerceLiteral(d.find, type);
          const b = d.replace === '' ? null : coerceLiteral(d.replace, type);
          if (a !== undefined && b !== undefined) { f = f.mapColumn(c, v => { if ((v == null && a == null) || (v != null && a != null && compareValues(v, a) === 0)) { changed++; return b; } return v; }); continue; }
          f = f.mapColumn(c, v => (v == null ? null : fmt(v, type)), 'text');
        }
        const find = d.find, ci = d.caseSensitive === false;
        const target = ci ? find.toLowerCase() : find;
        const rep = d.replace === '' ? null : d.replace;
        f = f.mapColumn(c, v => {
          if (v == null) { if (find === '') { changed++; return rep; } return v; }
          if ((ci ? v.toLowerCase() : v) === target) { changed++; return rep; }
          return v;
        });
        continue;
      }
      const re = d.match === 'regex' ? new RegExp(d.find, d.caseSensitive === false ? 'giu' : 'gu') : new RegExp(d.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), d.caseSensitive === false ? 'gi' : 'g');
      f = mapTextColumns(f, [c], (s) => { const o = s.replace(re, d.replace ?? ''); if (o !== s) changed++; return o; });
      if (type !== 'text') f = retypeColumns(f, [c]);
    }
    ctx.info(`${changed.toLocaleString()} value${changed === 1 ? '' : 's'} replaced`);
    return f;
  },
});

def('change_case', {
  label: 'Change case', code: 'CAS', category: 'Text', icon: 'case',
  ribbon: { tab: 'transform', group: 'Text', size: 'small' },
  keywords: 'upper lower proper title capitalize',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', default: (d, ctx) => ctx.selection || [] },
    { key: 'mode', type: 'segmented', label: 'Case', default: 'upper', options: [{ value: 'upper', label: 'UPPER' }, { value: 'lower', label: 'lower' }, { value: 'proper', label: 'Proper' }, { value: 'sentence', label: 'Sentence' }] },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { return d.columns?.length ? null : 'Pick at least one column.'; },
  summary(d) { return `${d.columns.join(', ')} → ${d.mode}`; },
  apply(frame, d) {
    frame.require(d.columns);
    const fn = { upper: s => s.toUpperCase(), lower: s => s.toLowerCase(), proper: s => s.toLowerCase().replace(/(^|[\s\-_'(/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()), sentence: s => s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) }[d.mode] || (s => s);
    let f = frame;
    for (const c of d.columns) { if (f.typeOf(c) !== 'text') continue; f = f.mapColumn(c, v => (v == null ? null : fn(v))); }
    return f;
  },
});

def('trim_clean', {
  label: 'Trim & clean', code: 'TRM', category: 'Text', icon: 'trim',
  ribbon: { tab: 'transform', group: 'Text', size: 'small' },
  keywords: 'whitespace spaces strip clean non-printing',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns (empty = all text columns)', default: (d, ctx) => ctx.selection || [] },
    { key: 'trim', type: 'toggle', label: 'Trim leading & trailing spaces', default: true },
    { key: 'collapse', type: 'toggle', label: 'Collapse repeated spaces', default: true },
    { key: 'clean', type: 'toggle', label: 'Remove non-printing characters', default: true },
    { key: 'emptyToNull', type: 'toggle', label: 'Turn resulting empty text into empty values', default: true },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  summary(d) { return d.columns?.length ? d.columns.join(', ') : 'all text columns'; },
  apply(frame, d) {
    const cols = textColumns(frame, d.columns);
    frame.require(cols);
    let f = frame;
    for (const c of cols) {
      if (f.typeOf(c) !== 'text') continue;
      f = f.mapColumn(c, v => {
        if (v == null) return null;
        let s = v;
        if (d.clean !== false) s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ');
        if (d.collapse !== false) s = s.replace(/[ \t]{2,}/g, ' ');
        if (d.trim !== false) s = s.trim();
        return s === '' && d.emptyToNull !== false ? null : s;
      });
    }
    return f;
  },
});

def('pad_text', {
  label: 'Pad text', code: 'PAD', category: 'Text', icon: 'trim',
  ribbon: { tab: 'transform', group: 'Text', size: 'small' },
  keywords: 'leading zeros pad left right',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', default: (d, ctx) => ctx.selection || [] },
    { key: 'length', type: 'number', label: 'Target length', default: 5, min: 1 },
    { key: 'char', type: 'text', label: 'Pad with', default: '0' },
    { key: 'side', type: 'segmented', label: 'Side', default: 'left', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { return d.columns?.length ? null : 'Pick at least one column.'; },
  summary(d) { return `${d.columns.join(', ')} to ${d.length} with “${d.char}”`; },
  apply(frame, d) {
    const len = Number(d.length) || 0, ch = d.char || ' ';
    return mapTextColumns(frame, d.columns, s => (d.side === 'right' ? s.padEnd(len, ch) : s.padStart(len, ch)));
  },
});

const MATH_OPS = [
  { value: 'add', label: 'Add', sym: '+' }, { value: 'subtract', label: 'Subtract', sym: '−' },
  { value: 'multiply', label: 'Multiply', sym: '×' }, { value: 'divide', label: 'Divide', sym: '÷' },
  { value: 'power', label: 'Power', sym: '^' }, { value: 'mod', label: 'Modulo', sym: 'mod' },
  { value: 'percent', label: 'Percent (÷100)', sym: '%', noValue: true }, { value: 'abs', label: 'Absolute value', sym: 'abs', noValue: true },
  { value: 'negate', label: 'Negate', sym: '−x', noValue: true }, { value: 'sqrt', label: 'Square root', sym: '√', noValue: true },
  { value: 'log10', label: 'Log10', sym: 'log', noValue: true },
];

def('math', {
  label: 'Number math', code: 'MTH', category: 'Number', icon: 'calculator',
  ribbon: { tab: 'transform', group: 'Number', size: 'large' },
  keywords: 'add subtract multiply divide percent abs arithmetic',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', numeric: true, default: (d, ctx) => ctx.selection || [] },
    { key: 'op', type: 'enum', label: 'Operation', default: 'multiply', options: MATH_OPS },
    { key: 'value', type: 'number', label: 'Value', default: 1, visible: (d) => !MATH_OPS.find(o => o.value === d.op)?.noValue },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { return d.columns?.length ? null : 'Pick at least one numeric column.'; },
  summary(d) { const o = MATH_OPS.find(x => x.value === d.op); return `${d.columns.join(', ')} ${o?.sym || d.op}${o?.noValue ? '' : ` ${d.value}`}`; },
  apply(frame, d) {
    frame.require(d.columns);
    const k = Number(d.value);
    const fn = { add: x => x + k, subtract: x => x - k, multiply: x => x * k, divide: x => (k === 0 ? null : x / k), power: x => x ** k, mod: x => (k === 0 ? null : ((x % k) + k) % k), percent: x => x / 100, abs: Math.abs, negate: x => -x, sqrt: x => (x < 0 ? null : Math.sqrt(x)), log10: x => (x <= 0 ? null : Math.log10(x)) }[d.op];
    let f = frame;
    for (const c of d.columns) {
      const type = f.typeOf(c);
      if (!isNumeric(type)) throw new Error(`“${c}” isn't a number column — change its type first.`);
      let allInt = type === 'integer';
      const out = f.col(c).map(v => { if (v == null) return null; const r = fn(v); if (r == null || !Number.isFinite(r)) return null; if (allInt && !Number.isInteger(r)) allInt = false; return Math.round(r * 1e12) / 1e12; });
      f = f.replaceColumn(c, out, allInt ? 'integer' : 'number');
    }
    return f;
  },
});

def('round_number', {
  label: 'Round', code: 'RND', category: 'Number', icon: 'hash',
  ribbon: { tab: 'transform', group: 'Number', size: 'small' },
  keywords: 'round floor ceiling truncate decimals',
  params: [
    { key: 'columns', type: 'columns', label: 'Columns', numeric: true, default: (d, ctx) => ctx.selection || [] },
    { key: 'mode', type: 'segmented', label: 'Mode', default: 'round', options: [{ value: 'round', label: 'Round' }, { value: 'floor', label: 'Down' }, { value: 'ceil', label: 'Up' }, { value: 'trunc', label: 'Truncate' }] },
    { key: 'decimals', type: 'number', label: 'Decimals', default: 0 },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  migrate(d) { return d.columns ? d : { columns: [d.column], mode: d.mode || 'round', decimals: d.decimals ?? 0 }; },
  validate(d) { return d.columns?.length ? null : 'Pick at least one numeric column.'; },
  summary(d) { return `${d.columns.join(', ')} ${d.mode} to ${d.decimals} dp`; },
  apply(frame, d) {
    frame.require(d.columns);
    const dec = Number(d.decimals) || 0;
    const p = Math.pow(10, dec);
    const fn = { round: Math.round, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc }[d.mode] || Math.round;
    let f = frame;
    for (const c of d.columns) {
      const type = f.typeOf(c);
      if (!isNumeric(type)) throw new Error(`“${c}” isn't a number column — change its type first.`);
      const out = f.col(c).map(v => (v == null ? null : fn((v + (d.mode === 'round' ? Math.sign(v) * Number.EPSILON * Math.abs(v) : 0)) * p) / p));
      f = f.replaceColumn(c, out, dec <= 0 ? 'integer' : type);
    }
    return f;
  },
});

const DATE_PARTS = [
  { value: 'year', label: 'Year', type: 'integer' }, { value: 'quarter', label: 'Quarter', type: 'integer' },
  { value: 'month', label: 'Month number', type: 'integer' }, { value: 'month_name', label: 'Month name', type: 'text' },
  { value: 'year_month', label: 'Year-month (2026-03)', type: 'text' }, { value: 'day', label: 'Day of month', type: 'integer' },
  { value: 'weekday', label: 'Day of week (Mon=1)', type: 'integer' }, { value: 'day_name', label: 'Day name', type: 'text' },
  { value: 'week', label: 'ISO week number', type: 'integer' }, { value: 'day_of_year', label: 'Day of year', type: 'integer' },
  { value: 'hour', label: 'Hour', type: 'integer' }, { value: 'minute', label: 'Minute', type: 'integer' },
  { value: 'date_only', label: 'Date only (drop time)', type: 'date' }, { value: 'start_of_week', label: 'Start of week', type: 'date' },
  { value: 'start_of_month', label: 'Start of month', type: 'date' }, { value: 'end_of_month', label: 'End of month', type: 'date' },
  { value: 'start_of_quarter', label: 'Start of quarter', type: 'date' }, { value: 'start_of_year', label: 'Start of year', type: 'date' },
  { value: 'age', label: 'Age in years (to today)', type: 'integer' }, { value: 'days_ago', label: 'Days until today', type: 'integer' },
];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function isoWeek(t) {
  const d = new Date(floorDay(t));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - firstThu) / DAY_MS - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

function datePart(t, part) {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  switch (part) {
    case 'year': return y;
    case 'quarter': return Math.floor(m / 3) + 1;
    case 'month': return m + 1;
    case 'month_name': return MONTH_NAMES[m];
    case 'year_month': return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'day': return day;
    case 'weekday': return ((d.getUTCDay() + 6) % 7) + 1;
    case 'day_name': return DAY_NAMES[(d.getUTCDay() + 6) % 7];
    case 'week': return isoWeek(t);
    case 'day_of_year': return Math.floor((Date.UTC(y, m, day) - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
    case 'hour': return d.getUTCHours();
    case 'minute': return d.getUTCMinutes();
    case 'date_only': return floorDay(t);
    case 'start_of_week': return floorDay(t) - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    case 'start_of_month': return Date.UTC(y, m, 1);
    case 'end_of_month': return Date.UTC(y, m + 1, 0);
    case 'start_of_quarter': return Date.UTC(y, Math.floor(m / 3) * 3, 1);
    case 'start_of_year': return Date.UTC(y, 0, 1);
    case 'age': { const n = new Date(); let a = n.getUTCFullYear() - y; if (n.getUTCMonth() < m || (n.getUTCMonth() === m && n.getUTCDate() < day)) a--; return a; }
    case 'days_ago': return Math.round((floorDay(Date.now()) - floorDay(t)) / DAY_MS);
  }
  return null;
}

def('date_part', {
  label: 'Date part', code: 'DTE', category: 'Date', icon: 'calendar',
  ribbon: { tab: 'add', group: 'From date', size: 'large' },
  keywords: 'year month day week quarter weekday extract',
  params: [
    { key: 'column', type: 'column', label: 'Date column', temporal: true, default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'part', type: 'enum', label: 'Part', default: 'year', options: DATE_PARTS },
    { key: 'name', type: 'text', label: 'New column name (empty = replace in place)', default: '' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  validate(d) { return d.column ? null : 'Choose a date column.'; },
  summary(d) { return `${DATE_PARTS.find(p => p.value === d.part)?.label || d.part} of ${d.column}${d.name ? ` → ${d.name}` : ''}`; },
  apply(frame, d) {
    frame.require(d.column);
    const type = frame.typeOf(d.column);
    let col = frame.col(d.column);
    if (!isTemporal(type)) {
      const conv = col.map(v => { const c = convertValue(v, 'datetime', { fromType: type }); return c === undefined ? null : c; });
      if (!conv.some(v => v != null)) throw new Error(`“${d.column}” doesn't contain dates — change its type to Date first.`);
      col = conv;
    }
    const meta = DATE_PARTS.find(p => p.value === d.part) || DATE_PARTS[0];
    const vals = col.map(v => (v == null ? null : datePart(v, d.part)));
    const name = d.name?.trim();
    if (name) return frame.withColumn(uniqueName(name, frame.names, ' '), meta.type, vals, posOf(frame, d.column));
    return frame.replaceColumn(d.column, vals, meta.type);
  },
});

def('format_date', {
  label: 'Format date as text', code: 'FMT', category: 'Date', icon: 'calendar',
  ribbon: { tab: 'transform', group: 'Date', size: 'small' },
  keywords: 'date format pattern text',
  params: [
    { key: 'column', type: 'column', label: 'Date column', temporal: true, default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'pattern', type: 'text', label: 'Pattern', default: 'DD/MM/YYYY', help: 'YYYY YY MMMM MMM MM M DDDD DDD DD D HH mm ss' },
    { key: 'name', type: 'text', label: 'New column name (empty = replace in place)', default: '' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  validate(d) { return d.column && d.pattern ? null : 'Choose a column and a pattern.'; },
  summary(d) { return `${d.column} as ${d.pattern}`; },
  apply(frame, d) {
    frame.require(d.column);
    if (!isTemporal(frame.typeOf(d.column))) throw new Error(`“${d.column}” isn't a date column — change its type first.`);
    const vals = frame.col(d.column).map(v => (v == null ? null : fmtDate(v, d.pattern)));
    const name = d.name?.trim();
    if (name) return frame.withColumn(uniqueName(name, frame.names, ' '), 'text', vals, posOf(frame, d.column));
    return frame.replaceColumn(d.column, vals, 'text');
  },
});

def('rank', {
  label: 'Rank', code: 'RNK', category: 'Add column', icon: 'trophy',
  ribbon: { tab: 'add', group: 'Window', size: 'small' },
  keywords: 'rank top position dense row number percentile',
  params: [
    { key: 'column', type: 'column', label: 'Rank by', default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'direction', type: 'segmented', label: 'Highest first?', default: 'desc', options: [{ value: 'desc', label: 'Highest = 1' }, { value: 'asc', label: 'Lowest = 1' }] },
    { key: 'mode', type: 'enum', label: 'Ties', default: 'rank', options: [{ value: 'rank', label: 'Standard (1, 1, 3)' }, { value: 'dense', label: 'Dense (1, 1, 2)' }, { value: 'row_number', label: 'Unique (1, 2, 3)' }, { value: 'percent', label: 'Percentile (0–1)' }] },
    { key: 'partitionBy', type: 'columns', label: 'Within each (optional)', default: () => [] },
    { key: 'name', type: 'text', label: 'New column name', default: 'Rank' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  validate(d, ctx) { if (!d.column) return 'Choose a column.'; if (!d.name?.trim()) return 'Name the new column.'; if (ctx.columns?.includes(d.name.trim())) return `“${d.name}” already exists.`; return null; },
  summary(d) { return `${d.name} by ${d.column} ${d.direction === 'asc' ? '↑' : '↓'}${d.partitionBy?.length ? ` per ${d.partitionBy.join(', ')}` : ''}`; },
  apply(frame, d) {
    frame.require(d.column, d.partitionBy || []);
    const col = frame.col(d.column);
    const groups = groupRows(frame, d.partitionBy || []);
    const out = new Array(frame.rowCount).fill(null);
    const dir = d.direction === 'asc' ? 1 : -1;
    for (const g of groups) {
      const rows = g.rows.filter(r => col[r] != null).sort((a, b) => compareValues(col[a], col[b]) * dir || a - b);
      let rank = 0, dense = 0, prev;
      rows.forEach((r, i) => {
        const v = col[r];
        const same = i > 0 && compareValues(v, prev) === 0;
        if (!same) { rank = i + 1; dense++; }
        prev = v;
        out[r] = d.mode === 'dense' ? dense : d.mode === 'row_number' ? i + 1 : d.mode === 'percent' ? (rows.length > 1 ? (rank - 1) / (rows.length - 1) : 0) : rank;
      });
    }
    return frame.withColumn(d.name.trim(), d.mode === 'percent' ? 'number' : 'integer', out);
  },
});

def('running_total', {
  label: 'Running total', code: 'RUN', category: 'Add column', icon: 'trending-up',
  ribbon: { tab: 'add', group: 'Window', size: 'small' },
  keywords: 'cumulative sum accumulate',
  params: [
    { key: 'column', type: 'column', label: 'Sum this column', numeric: true, default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'orderBy', type: 'columnOptional', label: 'In order of (empty = current row order)', default: '' },
    { key: 'partitionBy', type: 'columns', label: 'Restart within (optional)', default: () => [] },
    { key: 'name', type: 'text', label: 'New column name', default: 'Running total' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  validate(d, ctx) { if (!d.column) return 'Choose a column to sum.'; if (!d.name?.trim()) return 'Name the new column.'; if (ctx.columns?.includes(d.name.trim())) return `“${d.name}” already exists.`; return null; },
  summary(d) { return `${d.name} = running ${d.column}${d.partitionBy?.length ? ` per ${d.partitionBy.join(', ')}` : ''}`; },
  apply(frame, d) {
    frame.require(d.column, d.orderBy, d.partitionBy || []);
    const col = frame.col(d.column);
    const ord = d.orderBy ? frame.col(d.orderBy) : null;
    const out = new Array(frame.rowCount);
    let allInt = true;
    for (const g of groupRows(frame, d.partitionBy || [])) {
      const rows = ord ? g.rows.slice().sort((a, b) => { const x = ord[a], y = ord[b]; if (x == null || y == null) return x == null ? (y == null ? a - b : 1) : -1; return compareValues(x, y) || a - b; }) : g.rows;
      let s = 0;
      for (const r of rows) { const v = col[r]; const n = typeof v === 'number' ? v : parseNumberString(v); if (n != null) { s += n; if (!Number.isInteger(n)) allInt = false; } out[r] = Math.round(s * 1e10) / 1e10; }
    }
    return frame.withColumn(d.name.trim(), allInt ? 'integer' : 'number', out);
  },
});

def('percent_of_total', {
  label: 'Percent of total', code: 'PCT', category: 'Add column', icon: 'percent',
  ribbon: { tab: 'add', group: 'Window', size: 'small' },
  keywords: 'share proportion ratio',
  params: [
    { key: 'column', type: 'column', label: 'Column', numeric: true, default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'partitionBy', type: 'columns', label: 'Total within (optional)', default: () => [] },
    { key: 'name', type: 'text', label: 'New column name', default: 'Share' },
  ],
  seed: (sel) => ({ column: sel?.column }),
  validate(d, ctx) { if (!d.column) return 'Choose a column.'; if (!d.name?.trim()) return 'Name the new column.'; if (ctx.columns?.includes(d.name.trim())) return `“${d.name}” already exists.`; return null; },
  summary(d) { return `${d.name} = ${d.column} / total`; },
  apply(frame, d) {
    frame.require(d.column, d.partitionBy || []);
    const col = frame.col(d.column);
    const out = new Array(frame.rowCount).fill(null);
    for (const g of groupRows(frame, d.partitionBy || [])) {
      let s = 0; for (const r of g.rows) if (typeof col[r] === 'number') s += col[r];
      for (const r of g.rows) out[r] = typeof col[r] === 'number' && s ? col[r] / s : null;
    }
    return frame.withColumn(d.name.trim(), 'number', out);
  },
});

def('group_by', {
  label: 'Group by', code: 'GRP', category: 'Summarize', icon: 'group',
  ribbon: { tab: 'home', group: 'Summarize', size: 'large' },
  keywords: 'aggregate summarize sum count average total rollup',
  params: [
    { key: 'groupColumns', type: 'columns', label: 'Group by', default: (d, ctx) => ctx.selection || [] },
    { key: 'aggregations', type: 'repeater', label: 'Calculate', addLabel: '+ Add calculation', fields: [
      { key: 'fn', type: 'enum', label: 'Function', options: AGG_FNS, default: 'count' },
      { key: 'column', type: 'column', label: 'Column', visible: (f) => f.fn !== 'count' },
      { key: 'name', type: 'text', label: 'Result name', placeholder: 'Result name' },
    ], default: () => [{ fn: 'count', column: '', name: 'Count' }] },
  ],
  seed: (sel) => ({ groupColumns: sel?.columns || [] }),
  validate(d) {
    if (!d.aggregations?.length) return 'Add at least one calculation.';
    for (const a of d.aggregations) if (a.fn !== 'count' && !a.column) return 'Every calculation except “Count rows” needs a column.';
    const names = d.aggregations.map(a => a.name?.trim() || aggDefaultName(a));
    if (new Set(names).size !== names.length) return 'Give each calculation a unique name.';
    if (names.some(n => d.groupColumns?.includes(n))) return 'A result name clashes with a group-by column.';
    return null;
  },
  summary(d) { const n = d.aggregations?.length || 0; return `${d.groupColumns?.length ? `by ${d.groupColumns.join(', ')}` : 'whole table'} — ${n} calc${n === 1 ? '' : 's'}`; },
  apply(frame, d) {
    const gcols = d.groupColumns || [];
    frame.require(gcols, d.aggregations.map(a => (a.fn === 'count' ? null : a.column)));
    const groups = groupRows(frame, gcols);
    if (!gcols.length && !groups.length) groups.push({ first: -1, rows: [] });
    const fields = [], cols = [];
    for (const g of gcols) {
      const src = frame.col(g);
      fields.push({ name: g, type: frame.typeOf(g) });
      cols.push(groups.map(gr => (gr.first >= 0 ? src[gr.first] : null)));
    }
    for (const a of d.aggregations) {
      const name = a.name?.trim() || aggDefaultName(a);
      const type = a.fn === 'count' ? 'integer' : frame.typeOf(a.column);
      const src = a.fn === 'count' ? null : frame.col(a.column);
      fields.push({ name, type: aggType(a.fn, type) });
      cols.push(groups.map(gr => aggregate(a.fn, src ? gr.rows.map(r => src[r]) : gr.rows, type)));
    }
    return new Frame(fields, cols, groups.length);
  },
});

def('pivot', {
  label: 'Pivot', code: 'PVT', category: 'Reshape', icon: 'pivot',
  ribbon: { tab: 'transform', group: 'Reshape', size: 'large' },
  keywords: 'crosstab wide spread columns',
  params: [
    { key: 'onColumn', type: 'column', label: 'New column headers from', default: (d, ctx) => ctx.selection?.[0] || ctx.firstColumn },
    { key: 'valueColumn', type: 'column', label: 'Values from' },
    { key: 'fn', type: 'enum', label: 'Combine with', default: 'sum', options: AGG_FNS.filter(f => ['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'first', 'concat', 'median'].includes(f.value)) },
    { key: 'groupColumns', type: 'columns', label: 'Keep as rows (empty = every other column)', default: () => [] },
    { key: 'fillZero', type: 'toggle', label: 'Fill empty cells with 0 (numeric results)', default: false },
  ],
  seed: (sel) => ({ onColumn: sel?.column }),
  validate(d) { if (!d.onColumn) return 'Choose which column’s values become headers.'; if (!d.valueColumn) return 'Choose which column fills the cells.'; if (d.onColumn === d.valueColumn) return 'Header and value columns must differ.'; return null; },
  summary(d) { return `${d.onColumn} → columns, ${d.fn}(${d.valueColumn})`; },
  apply(frame, d) {
    frame.require(d.onColumn, d.valueColumn, d.groupColumns || []);
    const gcols = d.groupColumns?.length ? d.groupColumns : frame.names.filter(n => n !== d.onColumn && n !== d.valueColumn);
    const on = frame.col(d.onColumn), onType = frame.typeOf(d.onColumn);
    const val = frame.col(d.valueColumn), valType = frame.typeOf(d.valueColumn);
    const keysRaw = new Map();
    for (let r = 0; r < frame.rowCount; r++) { const k = on[r] == null ? '(empty)' : fmt(on[r], onType); if (!keysRaw.has(k)) keysRaw.set(k, on[r]); }
    const keys = [...keysRaw.keys()].sort((a, b) => compareValues(keysRaw.get(a), keysRaw.get(b)));
    if (keys.length > 2000) throw new Error(`“${d.onColumn}” has ${keys.length.toLocaleString()} distinct values — too many to become columns.`);
    const keyIndex = new Map(keys.map((k, i) => [k, i]));
    const groups = groupRows(frame, gcols);
    const fields = [], cols = [];
    for (const g of gcols) { const src = frame.col(g); fields.push({ name: g, type: frame.typeOf(g) }); cols.push(groups.map(gr => src[gr.first])); }
    const names = dedupeNames([...gcols, ...keys]).slice(gcols.length);
    const outType = aggType(d.fn, valType);
    const cells = keys.map(() => new Array(groups.length).fill(null));
    groups.forEach((gr, gi) => {
      const buckets = new Map();
      for (const r of gr.rows) { const k = on[r] == null ? '(empty)' : fmt(on[r], onType); let b = buckets.get(k); if (!b) { b = []; buckets.set(k, b); } b.push(val[r]); }
      for (const [k, vals] of buckets) cells[keyIndex.get(k)][gi] = aggregate(d.fn, vals, valType);
    });
    keys.forEach((k, i) => {
      let c = cells[i];
      if (d.fillZero && isNumeric(outType)) c = c.map(v => (v == null ? 0 : v));
      fields.push({ name: names[i], type: outType }); cols.push(c);
    });
    return new Frame(fields, cols, groups.length);
  },
});

def('unpivot', {
  label: 'Unpivot', code: 'UNP', category: 'Reshape', icon: 'unpivot',
  ribbon: { tab: 'transform', group: 'Reshape', size: 'large' },
  keywords: 'melt long gather stack',
  params: [
    { key: 'mode', type: 'segmented', label: 'Unpivot', default: 'selected', options: [{ value: 'selected', label: 'These columns' }, { value: 'others', label: 'All except these' }] },
    { key: 'columns', type: 'columns', label: 'Columns', default: (d, ctx) => ctx.selection || [] },
    { key: 'nameColumn', type: 'text', label: 'Attribute column name', default: 'Attribute' },
    { key: 'valueColumn', type: 'text', label: 'Value column name', default: 'Value' },
    { key: 'keepEmpty', type: 'toggle', label: 'Keep empty values', default: false },
  ],
  seed: (sel) => ({ columns: sel?.columns || [] }),
  validate(d) { if (!d.columns?.length) return 'Pick columns.'; if (!d.nameColumn?.trim() || !d.valueColumn?.trim()) return 'Name both output columns.'; if (d.nameColumn.trim() === d.valueColumn.trim()) return 'Output names must differ.'; return null; },
  summary(d) { return `${d.mode === 'others' ? 'all except ' : ''}${d.columns.join(', ')} → ${d.nameColumn}/${d.valueColumn}`; },
  apply(frame, d) {
    frame.require(d.columns);
    const melt = d.mode === 'others' ? frame.names.filter(n => !d.columns.includes(n)) : d.columns;
    const keep = frame.names.filter(n => !melt.includes(n));
    const nameCol = d.nameColumn.trim(), valCol = d.valueColumn.trim();
    if (keep.includes(nameCol) || keep.includes(valCol)) throw new Error('An output column name clashes with a kept column.');
    let vtype = null;
    for (const m of melt) vtype = unifyTypes(vtype, frame.typeOf(m));
    vtype = vtype || 'text';
    const srcs = melt.map(m => ({ name: m, col: frame.col(m), type: frame.typeOf(m) }));
    const idx = [], names = [], vals = [];
    for (let r = 0; r < frame.rowCount; r++) {
      for (const s of srcs) {
        const v = s.col[r];
        if (!d.keepEmpty && isEmpty(v)) continue;
        idx.push(r); names.push(s.name);
        vals.push(v == null ? null : vtype === 'text' && s.type !== 'text' ? formatValue(v, s.type) : v);
      }
    }
    const base = frame.select(keep).take(idx);
    return new Frame([...base.fields, { name: nameCol, type: 'text' }, { name: valCol, type: vtype }], [...base.columns, names, vals], idx.length);
  },
});

const JOIN_TYPES = [
  { value: 'left', label: 'Left — all rows from this query' }, { value: 'inner', label: 'Inner — only matching rows' },
  { value: 'right', label: 'Right — all rows from the other query' }, { value: 'full', label: 'Full — all rows from both' },
  { value: 'left_anti', label: 'Left anti — rows with no match' }, { value: 'right_anti', label: 'Right anti — other rows with no match' },
  { value: 'left_semi', label: 'Semi — rows that have a match (no new columns)' },
];

def('join', {
  label: 'Merge queries (join)', code: 'JON', category: 'Combine', icon: 'merge',
  ribbon: { tab: 'home', group: 'Combine', size: 'large' },
  keywords: 'join lookup vlookup merge relate match',
  params: [
    { key: 'rightSource', type: 'query', label: 'Join with' },
    { key: 'joinType', type: 'enum', label: 'Kind of join', default: 'left', options: JOIN_TYPES },
    { key: 'keys', type: 'repeater', label: 'Match rows where', addLabel: '+ Add key pair', fields: [
      { key: 'left', type: 'column', label: 'This column' },
      { key: 'right', type: 'rightColumn', label: 'equals other column' },
    ], default: (d, ctx) => [{ left: ctx.selection?.[0] || ctx.firstColumn, right: '' }] },
    { key: 'matchMode', type: 'enum', label: 'Key matching', default: 'exact', options: MATCH_MODES },
    { key: 'bring', type: 'rightColumns', label: 'Bring these columns (empty = all)', default: () => [], visible: (d) => !['left_anti', 'right_anti', 'left_semi'].includes(d.joinType) },
    { key: 'prefix', type: 'text', label: 'Prefix for new columns (optional)', default: '', visible: (d) => !['left_anti', 'right_anti', 'left_semi'].includes(d.joinType) },
    { key: 'matchCount', type: 'toggle', label: 'Add a “match count” column', default: false, visible: (d) => ['left', 'full', 'inner'].includes(d.joinType) },
  ],
  seed: (sel) => ({ keys: [{ left: sel?.column || '', right: sel?.column || '' }] }),
  migrate(d) {
    if (d.keys) return d;
    const keys = [{ left: d.leftKey, right: d.rightKey }, ...(d.extraKeys || []).map(k => ({ left: k.leftKey, right: k.rightKey }))];
    return { rightSource: d.rightSource, joinType: d.joinType || 'left', keys, matchMode: d.matchMode || 'exact', bring: d.bring || [], prefix: d.prefix || '' };
  },
  validate(d) { if (!d.rightSource) return 'Choose a query to join with.'; if (!d.keys?.length || d.keys.some(k => !k.left || !k.right)) return 'Pick matching columns on both sides.'; return null; },
  summary(d, ctx) { return `${d.joinType} with ${ctx?.queryName?.(d.rightSource) || d.rightSource} on ${(d.keys || []).map(k => (k.left === k.right ? k.left : `${k.left}=${k.right}`)).join(', ')}`; },
  deps(d) { return d.rightSource ? [d.rightSource] : []; },
  apply(frame, d, ctx) {
    const right = ctx.query(d.rightSource);
    const lk = d.keys.map(k => k.left), rk = d.keys.map(k => k.right);
    frame.require(lk);
    right.require(rk);
    const mode = d.matchMode || 'exact';
    const lcols = lk.map(c => frame.col(c)), ltypes = lk.map(c => frame.typeOf(c));
    const rcols = rk.map(c => right.col(c)), rtypes = rk.map(c => right.typeOf(c));
    const index = new Map();
    for (let r = 0; r < right.rowCount; r++) {
      const k = compositeKey(rcols, r, mode, rtypes);
      if (k == null) continue;
      let a = index.get(k); if (!a) { a = []; index.set(k, a); } a.push(r);
    }
    const jt = d.joinType || 'left';
    const leftMatches = new Array(frame.rowCount);
    const rightMatched = jt === 'right' || jt === 'full' || jt === 'right_anti' ? new Uint8Array(right.rowCount) : null;
    for (let r = 0; r < frame.rowCount; r++) {
      const k = compositeKey(lcols, r, mode, ltypes);
      const m = k == null ? null : index.get(k) || null;
      leftMatches[r] = m;
      if (m && rightMatched) for (const x of m) rightMatched[x] = 1;
    }
    if (jt === 'left_semi') return frame.filterRows(r => !!leftMatches[r]);
    if (jt === 'left_anti') return frame.filterRows(r => !leftMatches[r]);
    if (jt === 'right_anti') { const idx = []; for (let r = 0; r < right.rowCount; r++) if (!rightMatched[r]) idx.push(r); const t = right.take(idx); t.rid = null; return t; }
    const li = [], ri = [];
    for (let r = 0; r < frame.rowCount; r++) {
      const m = leftMatches[r];
      if (m) for (const x of m) { li.push(r); ri.push(x); }
      else if (jt === 'left' || jt === 'full') { li.push(r); ri.push(-1); }
    }
    if (jt === 'right') {
      li.length = 0; ri.length = 0;
      const byRight = new Map();
      for (let r = 0; r < frame.rowCount; r++) if (leftMatches[r]) for (const x of leftMatches[r]) { let a = byRight.get(x); if (!a) { a = []; byRight.set(x, a); } a.push(r); }
      for (let x = 0; x < right.rowCount; x++) { const a = byRight.get(x); if (a) for (const r of a) { li.push(r); ri.push(x); } else { li.push(-1); ri.push(x); } }
    } else if (jt === 'full') for (let x = 0; x < right.rowCount; x++) if (!rightMatched[x]) { li.push(-1); ri.push(x); }
    const bring = (d.bring?.length ? d.bring : right.names.filter(n => !rk.includes(n)));
    right.require(bring);
    const taken = new Set(frame.names);
    const fields = [], cols = [];
    frame.fields.forEach((f, c) => {
      const src = frame.columns[c];
      const keyPos = lk.indexOf(f.name);
      const rsrc = keyPos >= 0 && (jt === 'right' || jt === 'full') ? rcols[keyPos] : null;
      let type = f.type;
      if (rsrc && rtypes[keyPos] !== f.type) type = unifyTypes(f.type, rtypes[keyPos]);
      const out = new Array(li.length);
      for (let i = 0; i < li.length; i++) {
        let v = li[i] >= 0 ? src[li[i]] : rsrc ? rsrc[ri[i]] : null;
        if (v != null && type === 'text' && typeof v !== 'string') v = formatValue(v, li[i] >= 0 ? f.type : rtypes[keyPos]);
        out[i] = v;
      }
      fields.push({ name: f.name, type }); cols.push(out);
    });
    for (const b of bring) {
      const src = right.col(b);
      const name = uniqueName((d.prefix || '') + b, taken, '_');
      taken.add(name);
      const out = new Array(ri.length);
      for (let i = 0; i < ri.length; i++) out[i] = ri[i] >= 0 ? src[ri[i]] : null;
      fields.push({ name, type: right.typeOf(b) }); cols.push(out);
    }
    if (d.matchCount) {
      const name = uniqueName('Match count', taken, ' ');
      fields.push({ name, type: 'integer' });
      cols.push(li.map(r => (r >= 0 ? (leftMatches[r]?.length || 0) : 0)));
    }
    const unmatchedLeft = leftMatches.filter(m => !m).length;
    if (jt === 'left' && unmatchedLeft) ctx.info(`${unmatchedLeft.toLocaleString()} row${unmatchedLeft === 1 ? '' : 's'} had no match`);
    const dupes = li.length - frame.rowCount;
    if (jt === 'left' && dupes > 0) ctx.warn(`Some keys matched several rows — ${dupes.toLocaleString()} extra row${dupes === 1 ? '' : 's'} created`);
    return new Frame(fields, cols, li.length);
  },
});

def('append', {
  label: 'Append queries', code: 'APP', category: 'Combine', icon: 'layers',
  ribbon: { tab: 'home', group: 'Combine', size: 'large' },
  keywords: 'union stack concat combine rows',
  params: [
    { key: 'sources', type: 'queries', label: 'Append rows from' },
    { key: 'sourceColumn', type: 'text', label: 'Add a column with the query name (optional)', default: '', placeholder: 'e.g. Source' },
  ],
  migrate(d) { return d.sources ? d : { sources: d.rightSource ? [d.rightSource] : [], sourceColumn: '' }; },
  validate(d) { return d.sources?.length ? null : 'Pick at least one query to append.'; },
  summary(d, ctx) { return `+ ${(d.sources || []).map(s => ctx?.queryName?.(s) || s).join(', ')}`; },
  deps(d) { return d.sources || []; },
  apply(frame, d, ctx) {
    const parts = [{ name: ctx.selfName, frame }, ...d.sources.map(s => ({ name: ctx.queryName(s), frame: ctx.query(s) }))];
    const names = [], types = new Map();
    for (const p of parts) for (const f of p.frame.fields) { if (!types.has(f.name)) { names.push(f.name); types.set(f.name, f.type); } else types.set(f.name, unifyTypes(types.get(f.name), f.type)); }
    const total = parts.reduce((s, p) => s + p.frame.rowCount, 0);
    const cols = names.map(n => {
      const out = new Array(total);
      const t = types.get(n);
      let o = 0;
      for (const p of parts) {
        const i = p.frame.indexOf(n);
        const st = i >= 0 ? p.frame.fields[i].type : null;
        for (let r = 0; r < p.frame.rowCount; r++) {
          let v = i >= 0 ? p.frame.columns[i][r] : null;
          if (v != null && t === 'text' && st !== 'text') v = formatValue(v, st);
          out[o++] = v;
        }
      }
      return out;
    });
    const fields = names.map(n => ({ name: n, type: types.get(n) }));
    if (d.sourceColumn?.trim()) {
      const sc = uniqueName(d.sourceColumn.trim(), names, ' ');
      const out = new Array(total); let o = 0;
      for (const p of parts) for (let r = 0; r < p.frame.rowCount; r++) out[o++] = p.name;
      fields.push({ name: sc, type: 'text' }); cols.push(out);
    }
    return new Frame(fields, cols, total);
  },
});

def('sql', {
  label: 'SQL query', code: 'SQL', category: 'Table', icon: 'database',
  ribbon: { tab: 'transform', group: 'SQL', size: 'large' },
  keywords: 'sql duckdb select query custom raw_sql',
  params: [
    { key: 'sql', type: 'code', label: 'Query', default: 'SELECT *\nFROM input', help: 'DuckDB. The current data is input.' },
    { key: 'tables', type: 'queries', label: 'Also expose these queries as tables', default: () => [] },
  ],
  migrate(d) { return d.sql != null ? { sql: d.sql, tables: d.tables || [] } : { sql: d.query || d.raw || 'SELECT * FROM input', tables: [] }; },
  validate(d) { return String(d.sql || '').trim() ? null : 'Write a query.'; },
  summary(d) { return String(d.sql || '').replace(/\s+/g, ' ').trim(); },
  deps(d) { return d.tables || []; },
  apply(frame, d, ctx) {
    const hit = ctx.sqlResult();
    if (!hit) { const e = new Error('Waiting for DuckDB…'); e.needsSql = true; throw e; }
    if (hit.error) throw new Error(hit.error);
    if (hit.note) ctx.info(hit.note);
    return new Frame(hit.fields.map(f => ({ ...f })), hit.columns, hit.columns[0]?.length ?? 0);
  },
});

const STEP_ALIASES = { raw_sql: 'sql', custom_sql: 'sql', limit: 'keep_rows', rename_column: 'rename_columns', edit_cell: 'edit_cells', select: 'select_columns' };

export function migrateStep(step) {
  if (!step || typeof step !== 'object') return null;
  let type = STEP_ALIASES[step.type] || step.type;
  const t = TRANSFORMS[type];
  if (!t) return { ...step, type, unsupported: true };
  const data = t.migrate ? t.migrate({ ...(step.data || {}) }) : { ...(step.data || {}) };
  return { id: step.id, type, data, disabled: !!step.disabled, name: step.name || step.label || '', note: step.note || '' };
}

export function defaultsFor(type, ctx, seed = {}) {
  const t = TRANSFORMS[type];
  const d = {};
  const apply = (params, target) => {
    for (const p of params) {
      if (p.default === undefined) continue;
      target[p.key] = typeof p.default === 'function' ? p.default(target, ctx) : JSON.parse(JSON.stringify(p.default));
    }
  };
  apply(t.params, d);
  Object.assign(d, seed);
  return d;
}

export function validateStep(step, ctx) {
  const t = TRANSFORMS[step.type];
  if (!t) return `Unknown step “${step.type}”.`;
  return t.validate ? t.validate(step.data || {}, ctx || {}) : null;
}

export function stepSummary(step, ctx) {
  const t = TRANSFORMS[step.type];
  if (!t) return '';
  try { return t.summary ? t.summary(step.data || {}, ctx) || '' : ''; } catch { return ''; }
}

export function stepDeps(step) {
  const t = TRANSFORMS[step.type];
  return t?.deps ? t.deps(step.data || {}) : [];
}

export const RIBBON_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'transform', label: 'Transform' },
  { id: 'add', label: 'Add column' },
  { id: 'view', label: 'View' },
];

export function transformCatalog() {
  return Object.values(TRANSFORMS).filter(t => !t.hidden).map(t => ({ type: t.type, label: t.label, code: t.code, category: t.category, icon: t.icon, ribbon: t.ribbon, keywords: t.keywords || '' }));
}
