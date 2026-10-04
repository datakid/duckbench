import { qi, sqlStr } from './duck.js';
import { lit, literalFor } from './compile.js';
import { isNumeric, compareValues } from '../core/types.js';
import { uniqueName, dedupeNames, unescapeDelimiter } from '../core/util.js';
import { aggType } from '../core/transforms.js';

const WS = '[\\t\\n\\x0B\\f\\r \\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]';
const NUM = '(?i)[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)(e[+-]?[0-9]+)?';
const CTRL = '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F\\x{200B}-\\x{200D}\\x{FEFF}]';
const STRIP = `${WS.slice(0, -1)}$€£¥₹]|[A-Za-z]{3}$|^[A-Za-z]{3}`;

let seq = 0;
export const jsTrim = (e) => `regexp_replace(${e}, ${sqlStr(`^${WS}+|${WS}+$`)}, '', 'g')`;
const bind = (expr, fn) => { const v = `__db_v${++seq}`; return `(list_transform([${expr}], ${v} -> ${fn(v)}))[1]`; };
const isText = (types, c) => types.get(c) === 'text';
const project = (fields, map) => fields.map(f => (map.has(f.name) ? `${map.get(f.name)} AS ${qi(f.name)}` : qi(f.name))).join(', ');
const retype = (fields, map, types) => fields.map(f => ({ name: f.name, type: types?.get(f.name) || f.type }));

function trimClean(d, fields, types) {
  const cols = d.columns?.length ? d.columns : fields.filter(f => f.type === 'text').map(f => f.name);
  if (cols.some(c => !types.has(c))) return null;
  const map = new Map();
  for (const c of cols) {
    if (!isText(types, c)) continue;
    let s = qi(c);
    if (d.clean !== false) s = `replace(regexp_replace(${s}, ${sqlStr(CTRL)}, '', 'g'), chr(160), ' ')`;
    if (d.collapse !== false) s = `regexp_replace(${s}, '[ \\t]{2,}', ' ', 'g')`;
    if (d.trim !== false) s = jsTrim(s);
    if (d.emptyToNull !== false) s = `NULLIF(${s}, '')`;
    map.set(c, s);
  }
  if (!map.size) return null;
  return { sql: `SELECT ${project(fields, map)} FROM input`, fields };
}

function replaceValues(d, fields, types) {
  if (d.caseSensitive === false || !d.columns?.length || d.columns.some(c => !types.has(c))) return null;
  const map = new Map();
  for (const name of d.columns) {
    const c = qi(name), type = types.get(name);
    const find = String(d.find ?? ''), rep = String(d.replace ?? '');
    if (d.match === 'contains') {
      if (type !== 'text' || !find || rep.includes('$')) return null;
      map.set(name, `replace(${c}, ${sqlStr(find)}, ${sqlStr(rep)})`);
      continue;
    }
    if (d.match && d.match !== 'whole') return null;
    if (type === 'text') {
      const r = rep === '' ? 'NULL' : sqlStr(rep);
      map.set(name, find === '' ? `CASE WHEN ${c} IS NULL OR ${c} = '' THEN ${r} ELSE ${c} END` : `CASE WHEN ${c} = ${sqlStr(find)} THEN ${r} ELSE ${c} END`);
      continue;
    }
    const a = find === '' ? null : literalFor(find, type);
    const b = rep === '' ? null : literalFor(rep, type);
    if (a === undefined || b === undefined) return null;
    if (type === 'integer' && b != null && !Number.isInteger(b)) return null;
    const A = lit(a, type), B = lit(b, type);
    if (A == null || B == null) return null;
    map.set(name, `CASE WHEN ${a == null ? `${c} IS NULL` : `${c} = ${A}`} THEN ${B} ELSE ${c} END`);
  }
  return { sql: `SELECT ${project(fields, map)} FROM input`, fields };
}

function lenientNumber(t, decimal) {
  return bind(t, (s) => `CASE WHEN ${s} = '' THEN NULL WHEN regexp_full_match(${s}, ${sqlStr(NUM)}) THEN TRY_CAST(${s} AS DOUBLE) ELSE ${bind(`regexp_full_match(${s}, '^\\(.*\\)$')`, (neg) =>
    bind(`CASE WHEN ${neg} THEN substr(${s}, 2, length(${s}) - 2) ELSE ${s} END`, (u) =>
      bind(`suffix(${u}, '%')`, (pct) =>
        bind(`${decimal === ',' ? `regexp_replace(replace(%X%, '.', ''), ',', '.')` : `replace(%X%, ',', '')`}`.replace(/%X%/g, `regexp_replace(CASE WHEN ${pct} THEN left(${u}, length(${u}) - 1) ELSE ${u} END, ${sqlStr(STRIP)}, '', 'g')`), (w) =>
          bind(`starts_with(${w}, '-')`, (neg2) =>
            bind(`CASE WHEN ${neg2} THEN substr(${w}, 2) ELSE ${w} END`, (x) =>
              `CASE WHEN regexp_full_match(${x}, ${sqlStr(NUM)}) THEN (CASE WHEN ${neg} <> ${neg2} THEN -1 ELSE 1 END) * TRY_CAST(${x} AS DOUBLE) / (CASE WHEN ${pct} THEN 100 ELSE 1 END) END`))))))} END`);
}

const WSC = WS.slice(1, -1);
const MONTH_NAMES = [['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'], ['may'], ['jun', 'june'], ['jul', 'july'], ['aug', 'august'], ['sep', 'sept', 'september'], ['oct', 'october'], ['nov', 'november'], ['dec', 'december']];
const monthOf = (e) => `CASE ${MONTH_NAMES.map((ns, i) => `WHEN lower(${e}) IN (${ns.map(sqlStr).join(', ')}) THEN ${i + 1}`).join(' ')} END`;
const I = (e) => `CAST(${e} AS BIGINT)`;
const I0 = (e) => `CASE WHEN ${e} = '' THEN 0 ELSE CAST(${e} AS BIGINT) END`;

function ymd(y, m, d, hh = '0', mi = '0', ss = '0', ms = '0', off = '0') {
  return `CASE WHEN ${y} BETWEEN 1 AND 9999 AND ${m} BETWEEN 1 AND 12 AND ${d} BETWEEN 1 AND 31 AND TRY(make_date(${y}, ${m}, ${d})) IS NOT NULL AND ${hh} <= 23 AND ${mi} <= 59 AND ${ss} <= 59 THEN epoch_ms(make_timestamp(${y}, ${m}, ${d}, ${hh}, ${mi}, CAST(${ss} AS DOUBLE))) + ${ms} - ${off} * 60000 END`;
}

export function parseDateSql(src, order = 'auto') {
  const isoD = '^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$';
  const isoT = `(?i)^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})[T ]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2})(?:\\.([0-9]{1,9}))?)?[${WSC}]*(Z|[+-][0-9]{2}:?[0-9]{2})?$`;
  const slash = `^([0-9]{1,4})[/.-]([0-9]{1,2})[/.-]([0-9]{1,4})(?:[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?[${WSC}]*([AaPp][Mm])?)?$`;
  const named1 = `^([0-9]{1,2})[${WSC}-]([A-Za-z]{3,9})[${WSC},-]*([0-9]{4})$`;
  const named2 = `^([A-Za-z]{3,9})[${WSC}-]([0-9]{1,2}),?[${WSC}]*([0-9]{4})$`;
  const ex = (s, re, names) => `regexp_extract(${s}, ${sqlStr(re)}, [${names.map(sqlStr).join(', ')}])`;
  return bind(jsTrim(src), (s) => `CASE
    WHEN regexp_full_match(${s}, ${sqlStr(isoD)}) THEN ${bind(ex(s, isoD, ['y', 'm', 'd']), g => ymd(I(`${g}.y`), I(`${g}.m`), I(`${g}.d`)))}
    WHEN regexp_full_match(${s}, ${sqlStr(isoT)}) THEN ${bind(ex(s, isoT, ['y', 'm', 'd', 'h', 'i', 's', 'f', 'z']), g => {
      const ms = `CASE WHEN ${g}.f = '' THEN 0 ELSE CAST(round(CAST('0.' || ${g}.f AS DOUBLE) * 1000) AS BIGINT) END`;
      const off = `CASE WHEN ${g}.z = '' OR upper(${g}.z) = 'Z' THEN 0 ELSE (CASE WHEN left(${g}.z, 1) = '-' THEN -1 ELSE 1 END) * (CAST(substr(regexp_replace(${g}.z, '[^0-9]', '', 'g'), 1, 2) AS BIGINT) * 60 + CAST(substr(regexp_replace(${g}.z, '[^0-9]', '', 'g'), 3, 2) AS BIGINT)) END`;
      return ymd(I(`${g}.y`), I(`${g}.m`), I(`${g}.d`), I(`${g}.h`), I(`${g}.i`), I0(`${g}.s`), ms, off);
    })}
    WHEN regexp_full_match(${s}, ${sqlStr(slash)}) THEN ${bind(ex(s, slash, ['a', 'b', 'c', 'h', 'i', 's', 'p']), g => {
      const a = I(`${g}.a`), b = I(`${g}.b`), c = I(`${g}.c`);
      const four = `length(${g}.a) = 4`;
      const yy = `CASE WHEN ${four} THEN ${a} WHEN length(${g}.c) = 2 THEN ${c} + CASE WHEN ${c} < 50 THEN 2000 ELSE 1900 END ELSE ${c} END`;
      const dayFirst = order === 'DMY' ? 'TRUE' : order === 'MDY' ? 'FALSE' : `(${a} > 12 AND ${b} <= 12)`;
      const mo = `CASE WHEN ${four} THEN ${b} WHEN ${dayFirst} THEN ${b} ELSE ${a} END`;
      const dd = `CASE WHEN ${four} THEN ${c} WHEN ${dayFirst} THEN ${a} ELSE ${b} END`;
      const pm = `lower(left(${g}.p, 1)) = 'p'`;
      const hh = `CASE WHEN ${g}.h = '' THEN 0 WHEN ${g}.p = '' THEN ${I(`${g}.h`)} WHEN ${I(`${g}.h`)} = 12 THEN CASE WHEN ${pm} THEN 12 ELSE 0 END WHEN ${pm} THEN ${I(`${g}.h`)} + 12 ELSE ${I(`${g}.h`)} END`;
      return ymd(yy, mo, dd, hh, I0(`${g}.i`), I0(`${g}.s`));
    })}
    WHEN regexp_full_match(${s}, ${sqlStr(named1)}) THEN ${bind(ex(s, named1, ['d', 'n', 'y']), g => ymd(I(`${g}.y`), `coalesce(${monthOf(`${g}.n`)}, 0)`, I(`${g}.d`)))}
    WHEN regexp_full_match(${s}, ${sqlStr(named2)}) THEN ${bind(ex(s, named2, ['n', 'd', 'y']), g => ymd(I(`${g}.y`), `coalesce(${monthOf(`${g}.n`)}, 0)`, I(`${g}.d`)))}
  END`);
}

const jsRound = (n) => bind(n, (x) => `CASE WHEN ${x} - floor(${x}) >= 0.5 THEN ceil(${x}) ELSE floor(${x}) END`);

function convertExpr(name, from, to, d) {
  const c = qi(name);
  if (to === 'text') {
    if (from === 'integer' || from === 'boolean' || from === 'date') return `CAST(${c} AS VARCHAR)`;
    if (from === 'datetime') return `strftime(${c}, '%Y-%m-%d %H:%M:%S') || CASE WHEN millisecond(${c}) % 1000 <> 0 THEN '.' || lpad(CAST(millisecond(${c}) % 1000 AS VARCHAR), 3, '0') ELSE '' END`;
    return null;
  }
  if (isNumeric(to)) {
    let n;
    if (from === 'boolean') n = `CASE WHEN ${c} THEN 1 WHEN NOT ${c} THEN 0 END`;
    else if (isNumeric(from)) n = c;
    else if (from === 'text') {
      const t = jsTrim(c);
      n = d.lenient !== false ? lenientNumber(t, d.decimal || '.') : `CASE WHEN regexp_full_match(${t}, ${sqlStr(NUM)}) THEN TRY_CAST(${t} AS DOUBLE) END`;
    } else return null;
    if (to === 'number') return `CAST(${n} AS DOUBLE)`;
    return from === 'number' ? `TRY_CAST(trunc(${c}) AS BIGINT)` : from === 'text' ? `TRY_CAST(${jsRound(n)} AS BIGINT)` : `CAST(${n} AS BIGINT)`;
  }
  if (to === 'boolean') {
    if (isNumeric(from)) return `(${c} <> 0)`;
    if (from !== 'text') return null;
    return bind(`lower(${jsTrim(c)})`, (v) => `CASE WHEN ${v} IN ('true', 't', 'yes', 'y', '1') THEN TRUE WHEN ${v} IN ('false', 'f', 'no', 'n', '0') THEN FALSE END`);
  }
  if (to === 'date' || to === 'datetime') {
    if (from === 'date' || from === 'datetime') return to === 'date' ? `CAST(${c} AS DATE)` : `CAST(${c} AS TIMESTAMP)`;
    if (from === 'text') {
      const ms = parseDateSql(c, d.dateOrder || 'auto');
      return to === 'date' ? `CAST(epoch_ms(${ms}) AS DATE)` : `epoch_ms(${ms})`;
    }
    if (isNumeric(from) && d.excelSerial !== false) {
      const ts = `epoch_ms(TRY_CAST(floor((${c} - 25569) * 86400000 + 0.5) AS BIGINT))`;
      return to === 'date' ? `CAST(${ts} AS DATE)` : ts;
    }
  }
  return null;
}

function changeType(d, fields, types) {
  if (!d.columns?.length || d.columns.some(c => !types.has(c))) return null;
  const map = new Map(), out = new Map(types);
  for (const name of d.columns) {
    const from = types.get(name);
    if (from === d.type) continue;
    const e = convertExpr(name, from, d.type, d);
    if (!e) return null;
    map.set(name, e); out.set(name, d.type);
  }
  if (!map.size) return { sql: 'SELECT * FROM input', fields };
  return { sql: `SELECT ${project(fields, map)} FROM input`, fields: retype(fields, map, out) };
}

const LOWER_UNSAFE = '130,1c89,a7cb-a7cc,a7ce,a7d2,a7d4,a7da,a7dc,feff,10d50-10d65,16ea0-16eb8';
const UPPER_UNSAFE = 'df,149,19b,1f0,264,390,3b0,587,1c8a,1e96-1e9a,1f50,1f52,1f54,1f56,1f80-1faf,1fb2-1fb4,1fb6-1fb7,1fbc,1fc2-1fc4,1fc6-1fc7,1fcc,1fd2-1fd3,1fd6-1fd7,1fe2-1fe4,1fe6-1fe7,1ff2-1ff4,1ff6-1ff7,1ffc,a7cd,a7cf,a7d3,a7d5,a7db,fb00-fb06,fb13-fb17,feff,10d70-10d85,16ebb-16ed3';
const charClass = (...specs) => '[' + specs.join(',').split(',').map(r => r.split('-').map(h => `\\x{${h.toUpperCase()}}`).join('-')).join('') + ']';
const ASTRAL = '[\\x{10000}-\\x{10FFFF}]';
const SEP = `${WS.slice(0, -1)}\\-_'(/]`;
const NOT_SEP = '[^' + SEP.slice(1);

export function caseUnsafe(mode) {
  if (mode === 'upper') return charClass(UPPER_UNSAFE);
  if (mode === 'lower') return charClass(LOWER_UNSAFE);
  return charClass(LOWER_UNSAFE, UPPER_UNSAFE);
}

function properExpr(c) {
  const p = `__db_p${++seq}`;
  const word = bind(`regexp_extract(${p}, ${sqlStr(`^${SEP}*`)})`, (lead) =>
    bind(`substr(${p}, length(${lead}) + 1)`, (rest) => `CASE WHEN regexp_full_match(left(${rest}, 1), '\\pL') THEN ${lead} || upper(left(${rest}, 1)) || substr(${rest}, 2) ELSE ${p} END`));
  return bind(`lower(${c})`, (s) => `CASE WHEN ${s} = '' THEN ${s} ELSE array_to_string(list_transform(regexp_extract_all(${s}, ${sqlStr(`^${NOT_SEP}+|${SEP}+${NOT_SEP}*`)}), ${p} -> ${word}), '') END`);
}

function changeCase(d, fields, types, ctx) {
  if (!d.columns?.length || d.columns.some(c => !types.has(c))) return null;
  if (!['upper', 'lower', 'proper'].includes(d.mode)) return null;
  const cols = d.columns.filter(c => isText(types, c));
  if (!cols.length) return { sql: 'SELECT * FROM input', fields };
  const bad = cols.map(c => `regexp_matches(${qi(c)}, ${sqlStr(caseUnsafe(d.mode))})`).join(' OR ');
  if (ctx.probe(`SELECT EXISTS (SELECT 1 FROM input WHERE ${bad})`) !== false) return null;
  const map = new Map(cols.map(c => [c, d.mode === 'upper' ? `upper(${qi(c)})` : d.mode === 'lower' ? `lower(${qi(c)})` : properExpr(qi(c))]));
  return { sql: `SELECT ${project(fields, map)} FROM input`, fields };
}

const SAFE_INT = 9007199254740991;
function kindFlags(x) {
  const t = jsTrim(x);
  return bind(t, (s) => `CASE WHEN ${s} IS NULL OR ${s} = '' THEN NULL
    WHEN regexp_matches(${s}, ${sqlStr(ASTRAL)}) THEN 'X'
    WHEN regexp_full_match(${s}, '[+-]?[0-9]+') THEN CASE WHEN regexp_full_match(${s}, '[+-]?0[0-9].*') OR abs(TRY_CAST(${s} AS DOUBLE)) > ${SAFE_INT} THEN 'T' ELSE 'I' END
    WHEN regexp_full_match(${s}, ${sqlStr(NUM)}) THEN CASE WHEN TRY_CAST(${s} AS DOUBLE) IS NULL OR isinf(TRY_CAST(${s} AS DOUBLE)) THEN 'X' ELSE 'N' END
    WHEN lower(${s}) IN ('true', 'false', 'yes', 'no') THEN 'B'
    WHEN length(${s}) BETWEEN 6 AND 35 AND regexp_matches(${s}, '[0-9]') THEN CASE WHEN ${parseDateSql(s)} IS NULL THEN 'T' WHEN contains(${s}, ':') THEN 'S' ELSE 'D' END
    ELSE 'T' END`);
}

export function inferSql(exprs, from = 'input') {
  return `SELECT ${exprs.map(e => `coalesce(array_to_string(list_sort(list_distinct(list(${kindFlags(e)}))), ''), '')`).join(` || '|' || `)} FROM ${from}`;
}

export const parseKinds = (v) => (typeof v === 'string' ? v.split('|').map(s => [...s]) : null);

export function kindsToType(kinds) {
  const k = (kinds || []).filter(x => x != null);
  if (k.includes('X')) return null;
  if (!k.length) return 'text';
  const s = new Set(k);
  if (s.size === 1) return { I: 'integer', N: 'number', B: 'boolean', T: 'text', D: 'date', S: 'datetime' }[k[0]];
  if (s.size === 2 && s.has('I') && s.has('N')) return 'number';
  if (s.size === 2 && s.has('D') && s.has('S')) return 'datetime';
  return 'text';
}

export function castInferred(e, type) {
  const t = jsTrim(e);
  if (type === 'integer') return `CAST(round(TRY_CAST(${t} AS DOUBLE)) AS BIGINT)`;
  if (type === 'number') return `TRY_CAST(${t} AS DOUBLE)`;
  if (type === 'boolean') return bind(`lower(${t})`, (v) => `CASE WHEN ${v} IN ('true', 't', 'yes', 'y', '1') THEN TRUE WHEN ${v} IN ('false', 'f', 'no', 'n', '0') THEN FALSE END`);
  if (type === 'date') return `CAST(epoch_ms(${parseDateSql(e)}) AS DATE)`;
  if (type === 'datetime') return `epoch_ms(${parseDateSql(e)})`;
  return e;
}

const selfOverlaps = (s) => { for (let k = 1; k < s.length; k++) if (s.slice(0, k) === s.slice(-k)) return true; return false; };

function splitColumn(d, fields, types, ctx) {
  if (!types.has(d.column) || types.get(d.column) !== 'text') return null;
  if ((d.by && d.by !== 'delimiter') || d.rowsOutputName) return null;
  const delim = unescapeDelimiter(d.delimiter ?? ',');
  if (!delim) return null;
  const at = d.at || 'each';
  if (at === 'last' && selfOverlaps(delim)) return null;
  const c = qi(d.column), D = sqlStr(delim), L = [...delim].length;
  const clean = (e) => (d.trimParts !== false ? `NULLIF(${jsTrim(e)}, '')` : `NULLIF(${e}, '')`);
  if (d.mode === 'rows') {
    if (at !== 'each') return null;
    const part = clean('__db_lst[__db_k]');
    const kinds = parseKinds(ctx.probe(inferSql([part], `(SELECT CASE WHEN ${c} IS NULL THEN [NULL] ELSE string_split(${c}, ${D}) END AS __db_lst FROM input) b, unnest(range(1, len(b.__db_lst) + 1)) AS u(__db_k)`)));
    if (!kinds) return null;
    const type = kindsToType(kinds[0]);
    if (!type) return null;
    const others = fields.map(f => (f.name === d.column ? `${castInferred(part, type)} AS ${c}` : qi(f.name))).join(', ');
    return {
      sql: `SELECT ${others} FROM (SELECT *, CASE WHEN ${c} IS NULL THEN [NULL] ELSE string_split(${c}, ${D}) END AS __db_lst, row_number() OVER () AS __db_rn FROM input) b, unnest(range(1, len(b.__db_lst) + 1)) AS u(__db_k) ORDER BY __db_rn, __db_k`,
      fields: fields.map(f => (f.name === d.column ? { name: f.name, type } : f)),
    };
  }
  let width, parts, tail = -1;
  const max = Number(d.maxParts) || 0;
  if (at === 'each') {
    const w = ctx.probe(`SELECT coalesce(max(len(string_split(${c}, ${D}))), 0) FROM input`);
    if (w == null) return null;
    width = Math.max(1, Number(w) || 0);
    if (max > 0) width = Math.min(width, max);
    const v = `__db_t${++seq}`;
    const piece = d.trimParts !== false ? `list_transform(string_split(${c}, ${D})[${width}:], ${v} -> ${jsTrim(v)})` : `string_split(${c}, ${D})[${width}:]`;
    if (max > 0 && width === max) tail = width - 1;
    parts = Array.from({ length: width }, (_, i) => (i === tail ? `CASE WHEN len(string_split(${c}, ${D})) >= ${i + 1} THEN array_to_string(${piece}, ${D}) END` : `string_split(${c}, ${D})[${i + 1}]`));
  } else {
    const w = ctx.probe(`SELECT coalesce(max(CASE WHEN contains(${c}, ${D}) THEN 2 ELSE 1 END), 1) FROM input`);
    if (w == null) return null;
    width = Number(w) || 1;
    if (at === 'first') parts = [`CASE WHEN strpos(${c}, ${D}) > 0 THEN left(${c}, strpos(${c}, ${D}) - 1) ELSE ${c} END`, `CASE WHEN strpos(${c}, ${D}) > 0 THEN substr(${c}, strpos(${c}, ${D}) + ${L}) END`];
    else parts = [`CASE WHEN contains(${c}, ${D}) THEN array_to_string(string_split(${c}, ${D})[:-2], ${D}) ELSE ${c} END`, `CASE WHEN contains(${c}, ${D}) THEN string_split(${c}, ${D})[-1] END`];
    parts = parts.slice(0, width);
  }
  const exprs = parts.map((p, i) => (i === tail ? `NULLIF(${p}, '')` : clean(p)));
  const kinds = parseKinds(ctx.probe(inferSql(exprs)));
  if (!kinds) return null;
  const outTypes = exprs.map((_, i) => kindsToType(kinds?.[i]));
  if (outTypes.some(t => !t)) return null;
  const taken = new Set(fields.map(f => f.name).filter(n => n !== d.column || d.keepOriginal));
  const names = [];
  for (let i = 0; i < width; i++) { const n = uniqueName(`${d.column}_${i + 1}`, taken); taken.add(n); names.push(n); }
  const outFields = [], sel = [];
  for (const f of fields) {
    if (f.name === d.column) {
      if (d.keepOriginal) { outFields.push(f); sel.push(c); }
      names.forEach((n, i) => { outFields.push({ name: n, type: outTypes[i] }); sel.push(`${castInferred(exprs[i], outTypes[i])} AS ${qi(n)}`); });
      continue;
    }
    outFields.push(f); sel.push(qi(f.name));
  }
  return { sql: `SELECT ${sel.join(', ')} FROM input`, fields: outFields };
}

const SIMPLE_KEY = new Set(['text', 'integer', 'boolean', 'date']);

function join(d, fields, types, ctx) {
  const jt = d.joinType || 'left';
  if (!['left', 'inner', 'left_anti', 'left_semi'].includes(jt)) return null;
  if ((d.matchMode && d.matchMode !== 'exact') || d.matchCount) return null;
  const right = ctx.dep?.(d.rightSource);
  if (!right?.fields?.length || !d.keys?.length) return null;
  const rtypes = new Map(right.fields.map(f => [f.name, f.type]));
  for (const k of d.keys) {
    const lt = types.get(k.left), rt = rtypes.get(k.right);
    if (!lt || !rt || lt !== rt || !SIMPLE_KEY.has(lt)) return null;
  }
  const on = d.keys.map(k => `l.${qi(k.left)} = r.${qi(k.right)}`).join(' AND ');
  const R = `(${right.sql})`;
  const L = '(SELECT *, row_number() OVER () AS __db_lrn FROM input)';
  const lcols = fields.map(f => `l.${qi(f.name)}`).join(', ');
  if (jt === 'left_semi' || jt === 'left_anti') {
    return { sql: `SELECT ${lcols} FROM ${L} l WHERE ${jt === 'left_anti' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${R} r WHERE ${on}) ORDER BY l.__db_lrn`, fields };
  }
  const rk = d.keys.map(k => k.right);
  const bring = d.bring?.length ? d.bring : right.fields.map(f => f.name).filter(n => !rk.includes(n));
  if (bring.some(b => !rtypes.has(b))) return null;
  const taken = new Set(fields.map(f => f.name));
  const extra = [], sel = [];
  for (const b of bring) {
    const name = uniqueName((d.prefix || '') + b, taken, '_');
    taken.add(name);
    extra.push({ name, type: rtypes.get(b) });
    sel.push(`r.${qi(b)} AS ${qi(name)}`);
  }
  const rsrc = `(SELECT *, row_number() OVER () AS __db_rrn FROM ${R})`;
  return {
    sql: `SELECT ${[lcols, ...sel].join(', ')} FROM ${L} l ${jt === 'inner' ? 'INNER' : 'LEFT'} JOIN ${rsrc} r ON ${on} ORDER BY l.__db_lrn, r.__db_rrn NULLS FIRST`,
    fields: [...fields, ...extra],
  };
}

const PIVOT_FNS = { sum: 1, avg: 1, count: 1, count_distinct: 1, min: 1, max: 1, first: 1, median: 1 };

function keyText(type, v) {
  return type === 'text' ? v : type === 'integer' || type === 'boolean' || type === 'date' ? `CAST(${v} AS VARCHAR)` : null;
}

function pivot(d, fields, types, ctx) {
  if (!PIVOT_FNS[d.fn] || !types.has(d.onColumn) || !types.has(d.valueColumn) || d.onColumn === d.valueColumn) return null;
  const onType = types.get(d.onColumn), valType = types.get(d.valueColumn);
  if (onType !== 'integer' && onType !== 'date') return null;
  if (['sum', 'avg', 'median'].includes(d.fn) && !isNumeric(valType)) return null;
  if ((d.fn === 'min' || d.fn === 'max') && valType === 'text') return null;
  const gcols = d.groupColumns?.length ? d.groupColumns : fields.map(f => f.name).filter(n => n !== d.onColumn && n !== d.valueColumn);
  if (gcols.some(g => !types.has(g)) || gcols.some(g => !SIMPLE_KEY.has(types.get(g)))) return null;
  const on = qi(d.onColumn), val = qi(d.valueColumn);
  const rawKeys = ctx.probe(`SELECT list(o ORDER BY o NULLS LAST) FROM (SELECT DISTINCT ${on} AS o FROM input) t`);
  if (!Array.isArray(rawKeys) || rawKeys.length > 2000) return null;
  const labels = rawKeys.map(k => (k == null ? '(empty)' : null));
  const textKeys = ctx.probe(`SELECT list(${keyText(onType, 'o')} ORDER BY o NULLS LAST) FROM (SELECT DISTINCT ${on} AS o FROM input) t`);
  if (!Array.isArray(textKeys) || textKeys.length !== rawKeys.length) return null;
  for (let i = 0; i < textKeys.length; i++) labels[i] = textKeys[i] == null ? '(empty)' : textKeys[i];
  const names = dedupeNames([...gcols, ...labels]).slice(gcols.length);
  const outType = aggType(d.fn, valType);
  const agg = (cond) => {
    switch (d.fn) {
      case 'sum': return `CAST(round(fsum(${val}) FILTER (WHERE ${cond} AND ${val} IS NOT NULL), 10) AS ${outType === 'integer' ? 'BIGINT' : 'DOUBLE'})`;
      case 'avg': return `CAST(round(fsum(${val}) FILTER (WHERE ${cond}), 10) / count(${val}) FILTER (WHERE ${cond}) AS DOUBLE)`;
      case 'median': return `CAST(median(${val}) FILTER (WHERE ${cond}) AS DOUBLE)`;
      case 'count': return `CASE WHEN count(*) FILTER (WHERE ${cond}) > 0 THEN count(*) FILTER (WHERE ${cond}) END`;
      case 'count_distinct': return `CASE WHEN count(*) FILTER (WHERE ${cond}) > 0 THEN count(DISTINCT CASE WHEN NOT ${valType === 'text' ? `(${val} IS NULL OR trim(${val}) = '')` : `(${val} IS NULL)`} THEN ${val} END) FILTER (WHERE ${cond}) END`;
      case 'min': case 'max': return `${d.fn}(${val}) FILTER (WHERE ${cond})`;
      case 'first': return `arg_min(${val}, __db_rn) FILTER (WHERE ${cond} AND ${val} IS NOT NULL)`;
    }
    return null;
  };
  const cols = rawKeys.map((k, i) => {
    const cond = k == null ? `${on} IS NULL` : `${keyText(onType, on)} = ${sqlStr(textKeys[i])}`;
    let e = agg(cond);
    if (d.fillZero && isNumeric(outType)) e = `coalesce(${e}, 0)`;
    return `${e} AS ${qi(names[i])}`;
  });
  const g = gcols.map(qi).join(', ');
  const body = `FROM (SELECT *, row_number() OVER () AS __db_rn FROM input) t`;
  const sql = gcols.length
    ? `SELECT ${[g, ...cols].join(', ')} ${body} GROUP BY ${g} ORDER BY min(__db_rn)`
    : `SELECT ${cols.join(', ')} ${body} HAVING count(*) > 0`;
  return { sql, fields: [...gcols.map(n => ({ name: n, type: types.get(n) })), ...names.map(n => ({ name: n, type: outType }))] };
}

const TEXTABLE = new Set(['text', 'integer', 'boolean', 'date']);
const asText = (c, t) => (t === 'text' ? c : `CAST(${c} AS VARCHAR)`);
const blankOf = (c, t) => (t === 'text' ? `(${c} IS NULL OR trim(${c}) = '')` : `(${c} IS NULL)`);

function mergeColumns(d, fields, types) {
  const cols = d.columns || [];
  if (cols.length < 2 || !d.name?.trim() || cols.some(c => !types.has(c) || !TEXTABLE.has(types.get(c)))) return null;
  const sep = sqlStr(unescapeDelimiter(d.separator ?? ''));
  const skip = d.skipEmpty !== false;
  const parts = cols.map(c => { const q = qi(c), t = types.get(c); return skip ? `CASE WHEN ${blankOf(q, t)} THEN NULL ELSE ${asText(q, t)} END` : `coalesce(${asText(q, t)}, '')`; });
  const expr = bind(`list_filter([${parts.join(', ')}], __db_m -> __db_m IS NOT NULL)`, (l) => `CASE WHEN len(${l}) = 0 THEN NULL ELSE array_to_string(${l}, ${sep}) END`);
  const rest = d.keepOriginal ? fields : fields.filter(f => !cols.includes(f.name));
  const name = uniqueName(d.name.trim(), rest.map(f => f.name), ' ');
  const at = d.keepOriginal ? fields.length : Math.min(...cols.map(c => fields.findIndex(f => f.name === c)));
  const out = rest.map(f => ({ sel: qi(f.name), f }));
  out.splice(at, 0, { sel: `${expr} AS ${qi(name)}`, f: { name, type: 'text' } });
  return { sql: `SELECT ${out.map(o => o.sel).join(', ')} FROM input`, fields: out.map(o => o.f) };
}

function unpivotStep(d, fields, types) {
  if (!d.columns?.length || d.columns.some(c => !types.has(c))) return null;
  const melt = d.mode === 'others' ? fields.map(f => f.name).filter(n => !d.columns.includes(n)) : d.columns;
  if (!melt.length) return null;
  const keep = fields.map(f => f.name).filter(n => !melt.includes(n));
  const nameCol = d.nameColumn?.trim(), valCol = d.valueColumn?.trim();
  if (!nameCol || !valCol || nameCol === valCol || keep.includes(nameCol) || keep.includes(valCol)) return null;
  let vt = null;
  for (const m of melt) { const t = types.get(m); vt = vt == null || vt === t ? t : isNumeric(vt) && isNumeric(t) ? 'number' : (vt === 'date' || vt === 'datetime') && (t === 'date' || t === 'datetime') ? 'datetime' : 'text'; }
  const sqlT = { text: 'VARCHAR', integer: 'BIGINT', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', datetime: 'TIMESTAMP' }[vt];
  if (vt === 'text' && melt.some(m => !TEXTABLE.has(types.get(m)))) return null;
  const k = keep.map(qi).join(', ');
  const arms = melt.map((m, i) => `SELECT ${k ? k + ', ' : ''}${sqlStr(m)} AS ${qi(nameCol)}, CAST(${qi(m)} AS ${sqlT}) AS ${qi(valCol)}, __db_rn, ${i} AS __db_k FROM __db_b${d.keepEmpty ? '' : ` WHERE NOT ${blankOf(qi(m), types.get(m))}`}`);
  const outCols = [...keep.map(qi), qi(nameCol), qi(valCol)].join(', ');
  return {
    sql: `WITH __db_b AS (SELECT *, row_number() OVER () AS __db_rn FROM input) SELECT ${outCols} FROM (${arms.join(' UNION ALL ')}) u ORDER BY __db_rn, __db_k`,
    fields: [...keep.map(n => ({ name: n, type: types.get(n) })), { name: nameCol, type: 'text' }, { name: valCol, type: vt }],
  };
}

const DATE_SQL = {
  year: ['integer', c => `year(${c})`], quarter: ['integer', c => `quarter(${c})`], month: ['integer', c => `month(${c})`],
  day: ['integer', c => `day(${c})`], weekday: ['integer', c => `isodow(${c})`], day_of_year: ['integer', c => `dayofyear(${c})`],
  week: ['integer', c => `weekofyear(${c})`], hour: ['integer', c => `hour(${c})`], minute: ['integer', c => `minute(${c})`],
  month_name: ['text', c => `monthname(${c})`], day_name: ['text', c => `dayname(${c})`],
  year_month: ['text', c => `CAST(year(${c}) AS VARCHAR) || '-' || lpad(CAST(month(${c}) AS VARCHAR), 2, '0')`],
  date_only: ['date', c => `CAST(${c} AS DATE)`], start_of_week: ['date', c => `CAST(date_trunc('week', ${c}) AS DATE)`],
  start_of_month: ['date', c => `CAST(date_trunc('month', ${c}) AS DATE)`], end_of_month: ['date', c => `last_day(${c})`],
  start_of_quarter: ['date', c => `CAST(date_trunc('quarter', ${c}) AS DATE)`], start_of_year: ['date', c => `CAST(date_trunc('year', ${c}) AS DATE)`],
};

function datePartStep(d, fields, types) {
  const t = types.get(d.column), spec = DATE_SQL[d.part || 'year'];
  if (!spec || (t !== 'date' && t !== 'datetime')) return null;
  const [type, fn] = spec;
  const e = type === 'integer' ? `CAST(${fn(qi(d.column))} AS BIGINT)` : fn(qi(d.column));
  const name = d.name?.trim();
  if (!name) return { sql: `SELECT ${project(fields, new Map([[d.column, e]]))} FROM input`, fields: fields.map(f => (f.name === d.column ? { name: f.name, type } : f)) };
  const nn = uniqueName(name, fields.map(f => f.name), ' ');
  const at = fields.findIndex(f => f.name === d.column) + 1;
  const out = fields.map(f => ({ sel: qi(f.name), f }));
  out.splice(at, 0, { sel: `${e} AS ${qi(nn)}`, f: { name: nn, type } });
  return { sql: `SELECT ${out.map(o => o.sel).join(', ')} FROM input`, fields: out.map(o => o.f) };
}

function indexColumn(d, fields, types) {
  const name = d.name?.trim();
  if (!name || types.has(name) || (d.partitionBy || []).some(p => !types.has(p))) return null;
  const start = Number(d.start ?? 1), step = Number(d.step ?? 1) || 1;
  if (!Number.isFinite(start) || !Number.isFinite(step)) return null;
  const isInt = Number.isInteger(start) && Number.isInteger(step);
  const part = d.partitionBy?.length ? `PARTITION BY ${d.partitionBy.map(qi).join(', ')} ` : '';
  const e = `CAST(${start} + (row_number() OVER (${part}ORDER BY __db_rn) - 1) * ${step} AS ${isInt ? 'BIGINT' : 'DOUBLE'})`;
  return {
    sql: `SELECT ${e} AS ${qi(name)}, ${fields.map(f => qi(f.name)).join(', ')} FROM (SELECT *, row_number() OVER () AS __db_rn FROM input) t ORDER BY __db_rn`,
    fields: [{ name, type: isInt ? 'integer' : 'number' }, ...fields],
  };
}

function duplicateColumn(d, fields, types) {
  if (!types.has(d.column)) return null;
  const name = uniqueName(d.name?.trim() || `${d.column} (copy)`, fields.map(f => f.name), ' ');
  const at = fields.findIndex(f => f.name === d.column) + 1;
  const out = fields.map(f => ({ sel: qi(f.name), f }));
  out.splice(at, 0, { sel: `${qi(d.column)} AS ${qi(name)}`, f: { name, type: types.get(d.column) } });
  return { sql: `SELECT ${out.map(o => o.sel).join(', ')} FROM input`, fields: out.map(o => o.f) };
}

function moveColumn(d, fields, types) {
  const cols = d.columns || [];
  if (!cols.length || cols.some(c => !types.has(c))) return null;
  if ((d.to === 'before' || d.to === 'after') && (!types.has(d.target) || cols.includes(d.target))) return null;
  const rest = fields.map(f => f.name).filter(n => !cols.includes(n));
  const at = d.to === 'start' ? 0 : d.to === 'end' ? rest.length : rest.indexOf(d.target) + (d.to === 'after' ? 1 : 0);
  rest.splice(at, 0, ...cols);
  return { sql: `SELECT ${rest.map(qi).join(', ')} FROM input`, fields: rest.map(n => ({ name: n, type: types.get(n) })) };
}

const resetting = (fn) => (...a) => { seq = 0; return fn(...a); };
export const MORE = Object.fromEntries(Object.entries({ trim_clean: trimClean, replace_values: replaceValues, change_type: changeType, change_case: changeCase, split_column: splitColumn, join, pivot, merge_columns: mergeColumns, unpivot: unpivotStep, date_part: datePartStep, index_column: indexColumn, duplicate_column: duplicateColumn, move_column: moveColumn }).map(([k, f]) => [k, resetting(f)]));
export const MORE_HELPERS = { bind, project, WS, NUM };

