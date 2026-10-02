export const TYPES = ['text', 'integer', 'number', 'boolean', 'date', 'datetime'];

export const TYPE_LABELS = {
  text: 'Text', integer: 'Whole number', number: 'Decimal number', boolean: 'True/False', date: 'Date', datetime: 'Date & time',
};

export const TYPE_BADGES = { text: 'Abc', integer: '123', number: '1.2', boolean: 'T/F', date: 'Date', datetime: 'Time' };

export const isNumeric = (t) => t === 'integer' || t === 'number';
export const isTemporal = (t) => t === 'date' || t === 'datetime';

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const INT_RE = /^[+-]?\d+$/;
const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const ISO_DT_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const SLASH_DATE_RE = /^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const TRUE_SET = new Set(['true', 't', 'yes', 'y', '1']);
const FALSE_SET = new Set(['false', 'f', 'no', 'n', '0']);
const BOOL_WORDS = new Set(['true', 'false', 'yes', 'no']);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const NAMED_DATE_RE = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{4})$|^([A-Za-z]{3,9})[\s-](\d{1,2}),?\s*(\d{4})$/;

function validYMD(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1 || y > 9999) return false;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  return dt.getUTCDate() === d && dt.getUTCMonth() === m - 1;
}

export function makeDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  const t = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  if (y < 100) return new Date(t).setUTCFullYear(y);
  return t;
}

export function parseDateString(s, order = 'auto') {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  let m = ISO_DATE_RE.exec(str);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    return validYMD(y, mo, d) ? { t: makeDate(y, mo, d), time: false } : null;
  }
  m = ISO_DT_RE.exec(str);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!validYMD(y, mo, d)) return null;
    const hh = +m[4], mi = +m[5], ss = +(m[6] || 0), ms = m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0;
    if (hh > 23 || mi > 59 || ss > 59) return null;
    let t = makeDate(y, mo, d, hh, mi, ss, ms);
    if (m[8] && m[8].toUpperCase() !== 'Z') {
      const sign = m[8][0] === '-' ? -1 : 1;
      const digits = m[8].replace(/[^\d]/g, '');
      t -= sign * ((+digits.slice(0, 2)) * 60 + (+digits.slice(2, 4))) * 60000;
    }
    return { t, time: true };
  }
  m = SLASH_DATE_RE.exec(str);
  if (m) {
    let a = +m[1], b = +m[2], c = +m[3], y, mo, d;
    if (m[1].length === 4) { y = a; mo = b; d = c; }
    else {
      if (m[3].length === 2) c += c < 50 ? 2000 : 1900;
      y = c;
      if (order === 'DMY') { d = a; mo = b; }
      else if (order === 'MDY') { mo = a; d = b; }
      else if (a > 12 && b <= 12) { d = a; mo = b; }
      else { mo = a; d = b; }
    }
    if (!validYMD(y, mo, d)) return null;
    if (m[4] != null) {
      let hh = +m[4];
      const mi = +m[5], ss = +(m[6] || 0);
      if (m[7]) { const pm = /p/i.test(m[7]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
      if (hh > 23 || mi > 59 || ss > 59) return null;
      return { t: makeDate(y, mo, d, hh, mi, ss), time: true };
    }
    return { t: makeDate(y, mo, d), time: false };
  }
  m = NAMED_DATE_RE.exec(str);
  if (m) {
    let d, mo, y;
    if (m[1]) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; }
    else { mo = MONTHS[m[4].toLowerCase()]; d = +m[5]; y = +m[6]; }
    if (!mo || !validYMD(y, mo, d)) return null;
    return { t: makeDate(y, mo, d), time: false };
  }
  return null;
}

export function parseNumberString(s, lenient = false, decimal = '.') {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  let str = String(s).trim();
  if (!str) return null;
  if (NUM_RE.test(str)) return +str;
  if (!lenient) return null;
  let neg = false;
  if (/^\(.*\)$/.test(str)) { neg = true; str = str.slice(1, -1); }
  let pct = false;
  if (str.endsWith('%')) { pct = true; str = str.slice(0, -1); }
  str = str.replace(/[\s\u00A0$€£¥₹]|[A-Za-z]{3}$|^[A-Za-z]{3}/g, '');
  if (decimal === ',') str = str.replace(/\./g, '').replace(',', '.');
  else str = str.replace(/,/g, '');
  if (str.startsWith('-')) { neg = !neg; str = str.slice(1); }
  if (!NUM_RE.test(str)) return null;
  let n = +str;
  if (pct) n /= 100;
  return neg ? -n : n;
}

export function parseBoolString(s) {
  if (s == null) return null;
  if (typeof s === 'boolean') return s;
  const v = String(s).trim().toLowerCase();
  if (TRUE_SET.has(v)) return true;
  if (FALSE_SET.has(v)) return false;
  return null;
}

function classify(str) {
  if (INT_RE.test(str)) {
    if (str.length > 1 && /^[+-]?0\d/.test(str)) return 'text';
    return Math.abs(+str) <= Number.MAX_SAFE_INTEGER ? 'integer' : 'text';
  }
  if (NUM_RE.test(str)) return 'number';
  if (BOOL_WORDS.has(str.toLowerCase())) return 'boolean';
  if (str.length >= 6 && str.length <= 35 && /\d/.test(str)) {
    const d = parseDateString(str);
    if (d) return d.time ? 'datetime' : 'date';
  }
  return 'text';
}

export function inferColumnType(values) {
  let state = null;
  let sawValue = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const str = typeof v === 'string' ? v.trim() : String(v);
    if (!str) continue;
    sawValue = true;
    const k = classify(str);
    if (state === null) { state = k; continue; }
    if (k === state) continue;
    if ((state === 'integer' && k === 'number') || (state === 'number' && k === 'integer')) { state = 'number'; continue; }
    if ((state === 'date' && k === 'datetime') || (state === 'datetime' && k === 'date')) { state = 'datetime'; continue; }
    return 'text';
  }
  return sawValue ? state : 'text';
}

export function convertValue(v, type, opts = {}) {
  if (v == null) return null;
  switch (type) {
    case 'text': {
      if (typeof v === 'string') return v;
      return formatValue(v, opts.fromType || guessJsType(v));
    }
    case 'integer': {
      if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string' && v.trim() === '') return null;
      const n = parseNumberString(v, opts.lenient, opts.decimal);
      return n == null ? undefined : Math.round(n);
    }
    case 'number': {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string' && v.trim() === '') return null;
      const n = parseNumberString(v, opts.lenient, opts.decimal);
      return n == null ? undefined : n;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string' && v.trim() === '') return null;
      const b = parseBoolString(v);
      return b == null ? undefined : b;
    }
    case 'date':
    case 'datetime': {
      if (typeof v === 'number') {
        if (opts.fromType === 'date' || opts.fromType === 'datetime') return type === 'date' ? floorDay(v) : v;
        if (opts.excelSerial) return type === 'date' ? floorDay(excelSerialToMs(v)) : excelSerialToMs(v);
        return undefined;
      }
      if (v instanceof Date) return isNaN(v) ? null : (type === 'date' ? floorDay(v.getTime()) : v.getTime());
      if (typeof v === 'string' && v.trim() === '') return null;
      const d = parseDateString(v, opts.dateOrder || 'auto');
      if (!d) return undefined;
      return type === 'date' ? floorDay(d.t) : d.t;
    }
    default: return v;
  }
}

export const DAY_MS = 86400000;
export const floorDay = (t) => Math.floor(t / DAY_MS) * DAY_MS;
export const excelSerialToMs = (n) => Math.round((n - 25569) * DAY_MS);

function guessJsType(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'text';
}

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

export function formatDate(t) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  return `${y < 1000 ? String(y).padStart(4, '0') : y}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function formatDateTime(t) {
  const d = new Date(t);
  const base = `${formatDate(t)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const ms = d.getUTCMilliseconds();
  return ms ? `${base}.${String(ms).padStart(3, '0')}` : base;
}

export function formatNumber(n) {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  const s = String(n);
  if (s.length > 17 && !/e/.test(s)) return String(+n.toPrecision(15));
  return s;
}

export function formatValue(v, type) {
  if (v == null) return '';
  switch (type) {
    case 'date': return typeof v === 'number' ? formatDate(v) : String(v);
    case 'datetime': return typeof v === 'number' ? formatDateTime(v) : String(v);
    case 'integer':
    case 'number': return typeof v === 'number' ? formatNumber(v) : String(v);
    case 'boolean': return v === true ? 'true' : v === false ? 'false' : String(v);
    default: return typeof v === 'number' ? formatNumber(v) : String(v);
  }
}

export function typeOfJsValues(values) {
  let t = null;
  for (const v of values) {
    if (v == null) continue;
    let k;
    if (typeof v === 'number') k = Number.isInteger(v) ? 'integer' : 'number';
    else if (typeof v === 'boolean') k = 'boolean';
    else k = 'text';
    if (t === null) t = k;
    else if (t !== k) {
      if ((t === 'integer' && k === 'number') || (t === 'number' && k === 'integer')) t = 'number';
      else return 'text';
    }
  }
  return t || 'text';
}

export function compareValues(a, b) {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'boolean' && tb === 'boolean') return a ? 1 : -1;
  if (ta === 'string' && tb === 'string') return collator.compare(a, b);
  return collator.compare(String(a), String(b));
}

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function unifyTypes(a, b) {
  if (a === b) return a;
  if (!a) return b;
  if (!b) return a;
  if (isNumeric(a) && isNumeric(b)) return 'number';
  if (isTemporal(a) && isTemporal(b)) return 'datetime';
  return 'text';
}
