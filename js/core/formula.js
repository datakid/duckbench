import { formatValue, parseNumberString, parseDateString, floorDay, DAY_MS, compareValues, isNumeric, isTemporal } from './types.js';

const TOKEN_RE = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|("(?:[^"\\]|\\.|"")*"|'(?:[^'\\]|\\.|'')*')|(\[(?:[^\]]|\]\])+\])|([A-Za-z_\u00C0-\uFFFF][\w\u00C0-\uFFFF]*)|(<>|!=|<=|>=|==|&&|\|\||[-+*/%^(),<>=&!]))/iy;

function tokenize(src) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) throw new FormulaError(`Unexpected character “${src.slice(pos).trim()[0]}”`, pos);
    const at = m.index + m[0].length - m[0].trimStart().length;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: +m[1], at });
    else if (m[2] !== undefined) {
      const qch = m[2][0];
      const body = m[2].slice(1, -1).replace(qch === '"' ? /""/g : /''/g, qch).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
      tokens.push({ t: 'str', v: body, at });
    } else if (m[3] !== undefined) tokens.push({ t: 'col', v: m[3].slice(1, -1).replace(/\]\]/g, ']'), at });
    else if (m[4] !== undefined) tokens.push({ t: 'id', v: m[4], at });
    else tokens.push({ t: 'op', v: m[5], at });
    pos = TOKEN_RE.lastIndex;
  }
  tokens.push({ t: 'eof', at: src.length });
  return tokens;
}

export class FormulaError extends Error {
  constructor(msg, at) { super(msg); this.at = at; }
}

const PREC = { '||': 1, or: 1, '&&': 2, and: 2, '=': 3, '==': 3, '!=': 3, '<>': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '&': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 9 };

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const expect = (v) => {
    const t = next();
    if (t.t !== 'op' || t.v !== v) throw new FormulaError(`Expected “${v}”`, t.at);
  };
  function binOp(t) {
    if (t.t === 'op' && PREC[t.v] && t.v !== '!') return t.v;
    if (t.t === 'id' && (t.v.toLowerCase() === 'and' || t.v.toLowerCase() === 'or')) return t.v.toLowerCase();
    return null;
  }
  function parseExpr(minPrec = 0) {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      const op = binOp(t);
      if (!op) break;
      const prec = PREC[op];
      if (prec < minPrec) break;
      next();
      const right = parseExpr(op === '^' ? prec : prec + 1);
      left = { k: 'bin', op, l: left, r: right };
    }
    return left;
  }
  function parseUnary() {
    const t = peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) { next(); return { k: 'un', op: t.v, e: parseUnary() }; }
    if (t.t === 'id' && t.v.toLowerCase() === 'not') { next(); return { k: 'un', op: '!', e: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = next();
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'col') return { k: 'col', name: t.v, at: t.at };
    if (t.t === 'op' && t.v === '(') { const e = parseExpr(); expect(')'); return e; }
    if (t.t === 'id') {
      const lower = t.v.toLowerCase();
      if (peek().t === 'op' && peek().v === '(') {
        next();
        const args = [];
        if (!(peek().t === 'op' && peek().v === ')')) {
          for (;;) {
            args.push(parseExpr());
            if (peek().t === 'op' && peek().v === ',') { next(); continue; }
            break;
          }
        }
        expect(')');
        return { k: 'call', name: lower, args, at: t.at };
      }
      if (lower === 'true') return { k: 'lit', v: true };
      if (lower === 'false') return { k: 'lit', v: false };
      if (lower === 'null') return { k: 'lit', v: null };
      return { k: 'col', name: t.v, at: t.at };
    }
    if (t.t === 'eof') throw new FormulaError('Formula ended unexpectedly', t.at);
    throw new FormulaError(`Unexpected “${t.v}”`, t.at);
  }
  const ast = parseExpr();
  if (peek().t !== 'eof') throw new FormulaError(`Unexpected “${peek().v}”`, peek().at);
  return ast;
}

const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return parseNumberString(v, true);
};
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' ? formatValue(v, 'number') : String(v));
const truthy = (v) => v != null && v !== false && v !== 0 && v !== '';
const toTime = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const d = parseDateString(v);
  return d ? d.t : null;
};
const nullIfNaN = (n) => (n == null || Number.isNaN(n) || !Number.isFinite(n) ? null : n);
const num1 = (f) => (a) => { const n = num(a); return n == null ? null : nullIfNaN(f(n)); };

const FUNCS = {
  if: { min: 2, max: 3, lazy: true, ret: null, doc: 'if(condition, then, else)' },
  ifs: { min: 2, max: 99, lazy: true, ret: null, doc: 'ifs(cond1, val1, cond2, val2, …, [else])' },
  coalesce: { min: 1, max: 99, f: (...a) => { for (const v of a) if (v != null && v !== '') return v; return null; }, doc: 'coalesce(a, b, …) — first non-empty' },
  isblank: { min: 1, max: 1, f: (v) => v == null || (typeof v === 'string' && v.trim() === ''), ret: 'boolean', doc: 'isblank(x)' },
  isnumber: { min: 1, max: 1, f: (v) => num(v) != null, ret: 'boolean', doc: 'isnumber(x)' },
  upper: { min: 1, max: 1, f: (v) => (v == null ? null : str(v).toUpperCase()), ret: 'text', doc: 'upper(text)' },
  lower: { min: 1, max: 1, f: (v) => (v == null ? null : str(v).toLowerCase()), ret: 'text', doc: 'lower(text)' },
  proper: { min: 1, max: 1, f: (v) => (v == null ? null : str(v).toLowerCase().replace(/(^|[\s\-_'(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())), ret: 'text', doc: 'proper(text)' },
  trim: { min: 1, max: 1, f: (v) => (v == null ? null : str(v).trim().replace(/\s+/g, ' ')), ret: 'text', doc: 'trim(text)' },
  len: { min: 1, max: 1, f: (v) => (v == null ? null : [...str(v)].length), ret: 'integer', doc: 'len(text)' },
  left: { min: 2, max: 2, f: (v, n) => (v == null ? null : [...str(v)].slice(0, Math.max(0, num(n) || 0)).join('')), ret: 'text', doc: 'left(text, n)' },
  right: { min: 2, max: 2, f: (v, n) => { if (v == null) return null; const a = [...str(v)]; const k = Math.max(0, num(n) || 0); return k ? a.slice(-k).join('') : ''; }, ret: 'text', doc: 'right(text, n)' },
  mid: { min: 2, max: 3, f: (v, s, n) => { if (v == null) return null; const a = [...str(v)]; const st = Math.max(1, num(s) || 1) - 1; return (n == null ? a.slice(st) : a.slice(st, st + Math.max(0, num(n) || 0))).join(''); }, ret: 'text', doc: 'mid(text, start, [length]) — 1-based' },
  concat: { min: 1, max: 99, f: (...a) => a.map(str).join(''), ret: 'text', doc: 'concat(a, b, …)' },
  textjoin: { min: 2, max: 99, f: (sep, ...a) => a.filter(v => v != null && v !== '').map(str).join(str(sep)), ret: 'text', doc: 'textjoin(sep, a, b, …) — skips empties' },
  contains: { min: 2, max: 2, f: (v, s) => v != null && str(v).toLowerCase().includes(str(s).toLowerCase()), ret: 'boolean', doc: 'contains(text, find) — case-insensitive' },
  startswith: { min: 2, max: 2, f: (v, s) => v != null && str(v).toLowerCase().startsWith(str(s).toLowerCase()), ret: 'boolean', doc: 'startswith(text, prefix)' },
  endswith: { min: 2, max: 2, f: (v, s) => v != null && str(v).toLowerCase().endsWith(str(s).toLowerCase()), ret: 'boolean', doc: 'endswith(text, suffix)' },
  find: { min: 2, max: 2, f: (v, s) => (v == null ? null : str(v).indexOf(str(s)) + 1), ret: 'integer', doc: 'find(text, find) — 1-based position, 0 if absent' },
  replace: { min: 3, max: 3, f: (v, a, b) => (v == null ? null : str(v).split(str(a)).join(str(b))), ret: 'text', doc: 'replace(text, find, with)' },
  regexmatch: { min: 2, max: 2, f: (v, re) => v != null && safeRegex(re).test(str(v)), ret: 'boolean', doc: 'regexmatch(text, pattern)' },
  regexextract: { min: 2, max: 3, f: (v, re, g) => { if (v == null) return null; const m = safeRegex(re).exec(str(v)); if (!m) return null; return m[g == null ? (m.length > 1 ? 1 : 0) : num(g)] ?? null; }, ret: 'text', doc: 'regexextract(text, pattern, [group])' },
  regexreplace: { min: 3, max: 3, f: (v, re, b) => (v == null ? null : str(v).replace(safeRegex(re, 'g'), str(b))), ret: 'text', doc: 'regexreplace(text, pattern, with)' },
  split: { min: 3, max: 3, f: (v, d, i) => { if (v == null) return null; const parts = str(v).split(str(d)); const k = num(i) || 1; return parts[k < 0 ? parts.length + k : k - 1] ?? null; }, ret: 'text', doc: 'split(text, delimiter, n) — n-th part (1-based, negative from end)' },
  padleft: { min: 3, max: 3, f: (v, n, c) => (v == null ? null : str(v).padStart(num(n) || 0, str(c) || ' ')), ret: 'text', doc: 'padleft(text, length, char)' },
  padright: { min: 3, max: 3, f: (v, n, c) => (v == null ? null : str(v).padEnd(num(n) || 0, str(c) || ' ')), ret: 'text', doc: 'padright(text, length, char)' },
  repeat: { min: 2, max: 2, f: (v, n) => (v == null ? null : str(v).repeat(Math.max(0, Math.min(1000, num(n) || 0)))), ret: 'text', doc: 'repeat(text, n)' },
  text: { min: 1, max: 1, f: (v) => (v == null ? null : str(v)), ret: 'text', doc: 'text(x)' },
  number: { min: 1, max: 1, f: (v) => num(v), ret: 'number', doc: 'number(x) — lenient: $1,200 → 1200' },
  abs: { min: 1, max: 1, f: num1(Math.abs), ret: 'number', doc: 'abs(n)' },
  round: { min: 1, max: 2, f: (v, d) => { const n = num(v); if (n == null) return null; const p = Math.pow(10, num(d) || 0); return Math.round((n + Number.EPSILON * Math.sign(n)) * p) / p; }, ret: 'number', doc: 'round(n, [decimals])' },
  floor: { min: 1, max: 1, f: num1(Math.floor), ret: 'integer', doc: 'floor(n)' },
  ceil: { min: 1, max: 1, f: num1(Math.ceil), ret: 'integer', doc: 'ceil(n)' },
  sqrt: { min: 1, max: 1, f: num1(Math.sqrt), ret: 'number', doc: 'sqrt(n)' },
  ln: { min: 1, max: 1, f: num1(Math.log), ret: 'number', doc: 'ln(n)' },
  log10: { min: 1, max: 1, f: num1(Math.log10), ret: 'number', doc: 'log10(n)' },
  exp: { min: 1, max: 1, f: num1(Math.exp), ret: 'number', doc: 'exp(n)' },
  power: { min: 2, max: 2, f: (a, b) => { const x = num(a), y = num(b); return x == null || y == null ? null : nullIfNaN(Math.pow(x, y)); }, ret: 'number', doc: 'power(n, exp)' },
  mod: { min: 2, max: 2, f: (a, b) => { const x = num(a), y = num(b); return x == null || !y ? null : ((x % y) + y) % y; }, ret: 'number', doc: 'mod(n, d)' },
  min: { min: 1, max: 99, f: (...a) => { const v = a.map(num).filter(x => x != null); return v.length ? Math.min(...v) : null; }, ret: 'number', doc: 'min(a, b, …)' },
  max: { min: 1, max: 99, f: (...a) => { const v = a.map(num).filter(x => x != null); return v.length ? Math.max(...v) : null; }, ret: 'number', doc: 'max(a, b, …)' },
  sum: { min: 1, max: 99, f: (...a) => a.map(num).reduce((s, x) => s + (x || 0), 0), ret: 'number', doc: 'sum(a, b, …) — empties count as 0' },
  avg: { min: 1, max: 99, f: (...a) => { const v = a.map(num).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }, ret: 'number', doc: 'avg(a, b, …)' },
  between: { min: 3, max: 3, f: (v, a, b) => v != null && compareValues(v, a) >= 0 && compareValues(v, b) <= 0, ret: 'boolean', doc: 'between(x, low, high)' },
  in: { min: 2, max: 99, f: (v, ...a) => a.some(x => (typeof v === 'string' && typeof x === 'string' ? v.toLowerCase() === x.toLowerCase() : v === x)), ret: 'boolean', doc: 'in(x, a, b, …)' },
  date: { min: 1, max: 3, f: (y, m, d) => { if (m === undefined) { const t = toTime(y); return t == null ? null : floorDay(t); } const Y = num(y), M = num(m), D = num(d); if (Y == null || M == null || D == null) return null; return Date.UTC(Y, M - 1, D); }, ret: 'date', doc: 'date(y, m, d) or date(text)' },
  today: { min: 0, max: 0, f: () => floorDay(Date.now()), ret: 'date', doc: 'today()', volatile: true },
  now: { min: 0, max: 0, f: () => Date.now(), ret: 'datetime', doc: 'now()', volatile: true },
  year: { min: 1, max: 1, f: (v) => { const t = toTime(v); return t == null ? null : new Date(t).getUTCFullYear(); }, ret: 'integer', doc: 'year(date)' },
  month: { min: 1, max: 1, f: (v) => { const t = toTime(v); return t == null ? null : new Date(t).getUTCMonth() + 1; }, ret: 'integer', doc: 'month(date)' },
  day: { min: 1, max: 1, f: (v) => { const t = toTime(v); return t == null ? null : new Date(t).getUTCDate(); }, ret: 'integer', doc: 'day(date)' },
  weekday: { min: 1, max: 1, f: (v) => { const t = toTime(v); return t == null ? null : ((new Date(t).getUTCDay() + 6) % 7) + 1; }, ret: 'integer', doc: 'weekday(date) — Monday = 1' },
  hour: { min: 1, max: 1, f: (v) => { const t = toTime(v); return t == null ? null : new Date(t).getUTCHours(); }, ret: 'integer', doc: 'hour(datetime)' },
  adddays: { min: 2, max: 2, f: (v, n) => { const t = toTime(v); const k = num(n); return t == null || k == null ? null : t + k * DAY_MS; }, ret: 'date', doc: 'adddays(date, n)' },
  datediff: { min: 2, max: 3, f: (a, b, unit) => { const x = toTime(a), y = toTime(b); if (x == null || y == null) return null; return diffUnits(x, y, str(unit || 'day').toLowerCase()); }, ret: 'integer', doc: 'datediff(start, end, [unit]) — day|week|month|year|hour|minute' },
  formatdate: { min: 2, max: 2, f: (v, p) => { const t = toTime(v); return t == null ? null : fmtDate(t, str(p)); }, ret: 'text', doc: 'formatdate(date, "YYYY-MM-DD")' },
};

function diffUnits(x, y, unit) {
  const ms = y - x;
  switch (unit) {
    case 'week': case 'weeks': return Math.trunc(ms / (7 * DAY_MS));
    case 'month': case 'months': { const a = new Date(x), b = new Date(y); return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0); }
    case 'year': case 'years': { const a = new Date(x), b = new Date(y); let d = b.getUTCFullYear() - a.getUTCFullYear(); if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) d--; return d; }
    case 'hour': case 'hours': return Math.trunc(ms / 3600000);
    case 'minute': case 'minutes': return Math.trunc(ms / 60000);
    case 'second': case 'seconds': return Math.trunc(ms / 1000);
    default: return Math.round(ms / DAY_MS);
  }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fmtDate(t, pattern) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  const map = {
    YYYY: String(d.getUTCFullYear()), YY: String(d.getUTCFullYear()).slice(-2),
    MMMM: MONTH_NAMES[d.getUTCMonth()], MMM: MONTH_NAMES[d.getUTCMonth()].slice(0, 3), MM: p2(d.getUTCMonth() + 1), M: String(d.getUTCMonth() + 1),
    DDDD: DAY_NAMES[d.getUTCDay()], DDD: DAY_NAMES[d.getUTCDay()].slice(0, 3), DD: p2(d.getUTCDate()), D: String(d.getUTCDate()),
    HH: p2(d.getUTCHours()), mm: p2(d.getUTCMinutes()), ss: p2(d.getUTCSeconds()),
  };
  return pattern.replace(/YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|DD|D|HH|mm|ss/g, (k) => map[k]);
}

const regexCache = new Map();
function safeRegex(src, flags = '') {
  const key = flags + '\u0000' + src;
  let re = regexCache.get(key);
  if (!re) {
    try { re = new RegExp(str(src), flags + 'u'); } catch { try { re = new RegExp(str(src), flags); } catch { throw new Error(`Invalid regular expression: ${src}`); } }
    if (regexCache.size > 200) regexCache.clear();
    regexCache.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}

function looseEq(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = num(a), y = num(b);
    if (x != null && y != null) return x === y;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  return str(a).toLowerCase() === str(b).toLowerCase();
}

function cmp(a, b) {
  if (typeof a === 'number' && typeof b !== 'number') { const y = num(b); if (y != null) b = y; else { const t = toTime(b); if (t != null) b = t; } }
  if (typeof b === 'number' && typeof a !== 'number') { const x = num(a); if (x != null) a = x; else { const t = toTime(a); if (t != null) a = t; } }
  return compareValues(a, b);
}

export function compileFormula(src, frame) {
  if (!String(src || '').trim()) throw new FormulaError('Formula is empty', 0);
  const ast = parse(tokenize(String(src)));
  const refs = new Set();
  const typeOf = (name) => frame.typeOf(name);
  function resolveCol(name) {
    if (frame.has(name)) return name;
    const lower = name.toLowerCase();
    const hit = frame.names.find(n => n.toLowerCase() === lower);
    if (hit) return hit;
    throw new FormulaError(`Unknown column “${name}”. Wrap names with spaces in [brackets].`);
  }
  function inferType(node) {
    switch (node.k) {
      case 'lit': return node.v == null ? null : typeof node.v === 'number' ? (Number.isInteger(node.v) ? 'integer' : 'number') : typeof node.v === 'boolean' ? 'boolean' : 'text';
      case 'col': return typeOf(resolveCol(node.name));
      case 'un': return node.op === '!' ? 'boolean' : 'number';
      case 'bin': {
        if (['=', '==', '!=', '<>', '<', '>', '<=', '>=', 'and', 'or', '&&', '||'].includes(node.op)) return 'boolean';
        if (node.op === '&') return 'text';
        const l = inferType(node.l), r = inferType(node.r);
        if (node.op === '-' && isTemporal(l) && isTemporal(r)) return 'integer';
        if ((node.op === '+' || node.op === '-') && isTemporal(l)) return l;
        if (l === 'integer' && r === 'integer' && ['+', '-', '*', '%'].includes(node.op)) return 'integer';
        return 'number';
      }
      case 'call': {
        const fn = FUNCS[node.name];
        if (!fn) return null;
        if (fn.ret) return fn.ret;
        if (node.name === 'if') return mergeTypes(node.args.slice(1).map(inferType));
        if (node.name === 'ifs') return mergeTypes(node.args.filter((_, i) => i % 2 === 1 || (i === node.args.length - 1 && node.args.length % 2 === 1)).map(inferType));
        if (node.name === 'coalesce') return mergeTypes(node.args.map(inferType));
        return null;
      }
    }
    return null;
  }
  function build(node) {
    switch (node.k) {
      case 'lit': { const v = node.v; return () => v; }
      case 'col': {
        const name = resolveCol(node.name);
        refs.add(name);
        const col = frame.col(name);
        return (r) => col[r];
      }
      case 'un': {
        const e = build(node.e);
        if (node.op === '!') return (r) => !truthy(e(r));
        if (node.op === '-') return (r) => { const n = num(e(r)); return n == null ? null : -n; };
        return (r) => num(e(r));
      }
      case 'bin': {
        const l = build(node.l), rr = build(node.r);
        const lt = inferType(node.l), rt = inferType(node.r);
        switch (node.op) {
          case '+':
            if (isTemporal(lt) && isNumeric(rt)) return (r) => { const a = l(r), b = num(rr(r)); return a == null || b == null ? null : a + b * DAY_MS; };
            return (r) => { const a = num(l(r)), b = num(rr(r)); return a == null || b == null ? null : a + b; };
          case '-':
            if (isTemporal(lt) && isTemporal(rt)) return (r) => { const a = l(r), b = rr(r); return a == null || b == null ? null : Math.round((a - b) / DAY_MS); };
            if (isTemporal(lt)) return (r) => { const a = l(r), b = num(rr(r)); return a == null || b == null ? null : a - b * DAY_MS; };
            return (r) => { const a = num(l(r)), b = num(rr(r)); return a == null || b == null ? null : a - b; };
          case '*': return (r) => { const a = num(l(r)), b = num(rr(r)); return a == null || b == null ? null : a * b; };
          case '/': return (r) => { const a = num(l(r)), b = num(rr(r)); return a == null || b == null || b === 0 ? null : a / b; };
          case '%': return (r) => { const a = num(l(r)), b = num(rr(r)); return a == null || !b ? null : a % b; };
          case '^': return (r) => { const a = num(l(r)), b = num(rr(r)); return a == null || b == null ? null : nullIfNaN(Math.pow(a, b)); };
          case '&': return (r) => str(l(r)) + str(rr(r));
          case '=': case '==': return (r) => looseEq(l(r), rr(r));
          case '!=': case '<>': return (r) => !looseEq(l(r), rr(r));
          case '<': return (r) => { const a = l(r), b = rr(r); return a != null && b != null && cmp(a, b) < 0; };
          case '>': return (r) => { const a = l(r), b = rr(r); return a != null && b != null && cmp(a, b) > 0; };
          case '<=': return (r) => { const a = l(r), b = rr(r); return a != null && b != null && cmp(a, b) <= 0; };
          case '>=': return (r) => { const a = l(r), b = rr(r); return a != null && b != null && cmp(a, b) >= 0; };
          case 'and': case '&&': return (r) => truthy(l(r)) && truthy(rr(r));
          case 'or': case '||': return (r) => truthy(l(r)) || truthy(rr(r));
        }
        throw new FormulaError(`Unknown operator ${node.op}`);
      }
      case 'call': {
        const fn = FUNCS[node.name];
        if (!fn) throw new FormulaError(`Unknown function “${node.name}()”`, node.at);
        if (node.args.length < fn.min || node.args.length > fn.max) throw new FormulaError(`${node.name}() expects ${fn.min === fn.max ? fn.min : `${fn.min}–${fn.max}`} argument${fn.max === 1 ? '' : 's'}`, node.at);
        const args = node.args.map(build);
        if (node.name === 'if') {
          const [c, a, b] = args;
          return (r) => (truthy(c(r)) ? a(r) : b ? b(r) : null);
        }
        if (node.name === 'ifs') {
          return (r) => {
            let i = 0;
            for (; i + 1 < args.length; i += 2) if (truthy(args[i](r))) return args[i + 1](r);
            return i < args.length ? args[i](r) : null;
          };
        }
        const f = fn.f;
        if (args.length === 0) { return () => f(); }
        if (args.length === 1) { const [a] = args; return (r) => f(a(r)); }
        if (args.length === 2) { const [a, b] = args; return (r) => f(a(r), b(r)); }
        if (args.length === 3) { const [a, b, c] = args; return (r) => f(a(r), b(r), c(r)); }
        return (r) => f(...args.map(g => g(r)));
      }
    }
    throw new FormulaError('Bad formula');
  }
  const fn = build(ast);
  let type = inferType(ast) || 'text';
  return { fn, type, refs: [...refs] };
}

function mergeTypes(ts) {
  const list = ts.filter(Boolean);
  if (!list.length) return null;
  let t = list[0];
  for (const x of list.slice(1)) {
    if (x === t) continue;
    if (isNumeric(x) && isNumeric(t)) t = 'number';
    else if (isTemporal(x) && isTemporal(t)) t = 'datetime';
    else return 'text';
  }
  return t;
}

export function evaluateFormula(src, frame, forcedType) {
  const { fn, type } = compileFormula(src, frame);
  const n = frame.rowCount;
  const out = new Array(n);
  let finalType = forcedType && forcedType !== 'auto' ? forcedType : type;
  for (let r = 0; r < n; r++) {
    let v = fn(r);
    if (typeof v === 'number' && !Number.isFinite(v)) v = null;
    out[r] = v === undefined ? null : v;
  }
  if (finalType === 'integer') {
    for (let r = 0; r < n; r++) if (typeof out[r] === 'number' && !Number.isInteger(out[r])) { finalType = 'number'; break; }
  }
  if (finalType === 'text') for (let r = 0; r < n; r++) if (out[r] != null && typeof out[r] !== 'string') out[r] = str(out[r]);
  if (finalType === 'boolean') for (let r = 0; r < n; r++) if (out[r] != null && typeof out[r] !== 'boolean') out[r] = truthy(out[r]);
  return { values: out, type: finalType };
}

export function formulaPredicate(src, frame) {
  const { fn } = compileFormula(src, frame);
  return (r) => truthy(fn(r));
}

export const FORMULA_FUNCTIONS = Object.entries(FUNCS).map(([name, f]) => ({ name, doc: f.doc }));
