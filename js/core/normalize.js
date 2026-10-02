import { formatValue } from './types.js';

const ARABIC_MAP = {
  '\u0622': '\u0627', '\u0623': '\u0627', '\u0625': '\u0627', '\u0671': '\u0627',
  '\u0649': '\u064A', '\u06CC': '\u064A', '\u0626': '\u064A',
  '\u0629': '\u0647', '\u0624': '\u0648', '\u06A9': '\u0643',
};
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const ARABIC_CHARS = /[\u0622\u0623\u0625\u0671\u0649\u06CC\u0626\u0629\u0624\u06A9]/g;
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

export const MATCH_MODES = [
  { value: 'exact', label: 'Values are identical' },
  { value: 'loose', label: 'Same ignoring case, accents & spaces' },
  { value: 'arabic', label: 'Loose + Arabic spelling variants' },
];

export function normalizeKey(v, mode, type) {
  if (v == null) return null;
  if (mode !== 'loose' && mode !== 'arabic') return typeof v === 'string' ? v : formatValue(v, type);
  if (typeof v === 'number' || typeof v === 'boolean') return formatValue(v, type);
  let s = typeof v === 'string' ? v : formatValue(v, type);
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  if (mode === 'arabic') {
    s = s.replace(ARABIC_DIACRITICS, '').replace(ARABIC_CHARS, c => ARABIC_MAP[c] || c)
      .replace(ARABIC_DIGITS, d => String(d.charCodeAt(0) - (d.charCodeAt(0) >= 0x06F0 ? 0x06F0 : 0x0660)));
  }
  s = s.toLowerCase().replace(/[\s\u00A0\u200B-\u200F]+/g, ' ').trim();
  return s ? s : null;
}

export function looseText(v, mode = 'loose') {
  const k = normalizeKey(v, mode, 'text');
  return k == null ? '' : k;
}

export function compositeKey(cols, r, mode, types) {
  if (cols.length === 1) return normalizeKey(cols[0][r], mode, types[0]);
  let out = '';
  for (let i = 0; i < cols.length; i++) {
    const k = normalizeKey(cols[i][r], mode, types[i]);
    if (k == null) return null;
    out += k.length + ':' + k;
  }
  return out;
}

export function compositeKeyWithNulls(cols, r, mode, types) {
  let out = '';
  for (let i = 0; i < cols.length; i++) {
    const k = normalizeKey(cols[i][r], mode, types[i]);
    out += k == null ? '\u0000|' : k.length + ':' + k;
  }
  return out;
}
