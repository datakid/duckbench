import { parseNumberString } from './types.js';

export const SUGGEST_MIN_NON_EMPTY = 20;
export const SUGGEST_NUMBER_RATIO = 0.95;
const PREFILTER_SAMPLE = 400;
const PREFILTER_RATIO = 0.9;
const LEADING_ZERO = /^\s*[-+]?0\d/;
const LONG_DIGITS = /\d{16,}/;

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

function looksNumeric(col, n) {
  let seen = 0, ok = 0;
  for (let r = 0; r < n && seen < PREFILTER_SAMPLE; r++) {
    const v = col[r];
    if (isBlank(v)) continue;
    seen++;
    if (typeof v === 'string' && parseNumberString(v) != null) ok++;
  }
  return seen > 0 && ok / seen >= PREFILTER_RATIO;
}

function numberColumn(col, n) {
  if (!looksNumeric(col, n)) return false;
  let nonEmpty = 0, ok = 0;
  for (let r = 0; r < n; r++) {
    const v = col[r];
    if (isBlank(v)) continue;
    nonEmpty++;
    if (typeof v !== 'string') { ok++; continue; }
    if (LEADING_ZERO.test(v) || LONG_DIGITS.test(v)) return false;
    if (parseNumberString(v) != null) ok++;
  }
  return nonEmpty >= SUGGEST_MIN_NON_EMPTY && ok / nonEmpty >= SUGGEST_NUMBER_RATIO;
}

function hasPaddedText(col, n) {
  for (let r = 0; r < n; r++) {
    const v = col[r];
    if (typeof v === 'string' && v !== v.trim() && v.trim() !== '') return true;
  }
  return false;
}

function blankRows(frame) {
  const n = frame.rowCount, cols = frame.columns;
  if (!cols.length) return 0;
  let blank = 0;
  for (let r = 0; r < n; r++) {
    let all = true;
    for (let c = 0; c < cols.length; c++) if (!isBlank(cols[c][r])) { all = false; break; }
    if (all) blank++;
  }
  return blank;
}

export function suggestCleanups(frame) {
  const n = frame.rowCount;
  const out = { number: null, trim: null, blank: null };
  if (!n) return out;
  for (let c = 0; c < frame.fields.length; c++) {
    if (out.number && out.trim) break;
    if (frame.fields[c].type !== 'text') continue;
    const col = frame.columns[c];
    const name = frame.fields[c].name;
    if (!out.number && numberColumn(col, n)) out.number = { column: name };
    if (!out.trim && hasPaddedText(col, n)) out.trim = { column: name };
  }
  const rows = blankRows(frame);
  if (rows > 0) out.blank = { rows };
  return out;
}
