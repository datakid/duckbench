export const uid = (p = 'id') => `${p}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 8)}`;

export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && Number.isNaN(v));

export function uniqueName(base, taken, sep = '_') {
  const set = taken instanceof Set ? taken : new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}${sep}${i}`)) i++;
  return `${base}${sep}${i}`;
}

export function dedupeNames(names, sep = '_') {
  const seen = new Set();
  return names.map((n, i) => {
    let base = n == null || String(n).trim() === '' ? `Column${i + 1}` : String(n);
    const name = uniqueName(base, seen, sep);
    seen.add(name);
    return name;
  });
}

export function seededRandom(seed) {
  let s = (Number(seed) || 1) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function unescapeDelimiter(d) {
  if (d == null) return '';
  return String(d).replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}

export function parseList(text) {
  if (Array.isArray(text)) return text.map(String);
  return String(text ?? '').split(/\r?\n|,/).map(s => s.trim()).filter(s => s.length);
}

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
