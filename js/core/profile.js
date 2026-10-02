import { isNumeric, isTemporal, formatValue, compareValues, DAY_MS } from './types.js';

export function columnQuality(frame) {
  return frame.fields.map((f, c) => {
    const col = frame.columns[c];
    let empty = 0;
    for (let r = 0; r < frame.rowCount; r++) {
      const v = col[r];
      if (v == null || (typeof v === 'string' && v.trim() === '')) empty++;
    }
    return { empty, valid: frame.rowCount - empty };
  });
}

export function profileColumn(frame, name, opts = {}) {
  const col = frame.col(name);
  const type = frame.typeOf(name);
  const n = frame.rowCount;
  let empty = 0, whitespace = 0;
  const counts = new Map();
  const nums = [];
  let minLen = Infinity, maxLen = 0, lenSum = 0, textCount = 0;
  for (let r = 0; r < n; r++) {
    const v = col[r];
    if (v == null) { empty++; continue; }
    if (typeof v === 'string') {
      if (v.trim() === '') { empty++; continue; }
      if (v !== v.trim()) whitespace++;
      const l = v.length;
      if (l < minLen) minLen = l;
      if (l > maxLen) maxLen = l;
      lenSum += l; textCount++;
    }
    const key = typeof v === 'string' ? v : formatValue(v, type);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (typeof v === 'number') nums.push(v);
  }
  const distinct = counts.size;
  let unique = 0;
  for (const c of counts.values()) if (c === 1) unique++;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareValues(a[0], b[0])).slice(0, opts.top || 12).map(([value, count]) => ({ value, count }));
  const out = { name, type, rows: n, empty, valid: n - empty, distinct, unique, whitespace, top };
  if ((isNumeric(type) || isTemporal(type)) && nums.length) {
    nums.sort((a, b) => a - b);
    const sum = nums.reduce((s, x) => s + x, 0);
    const mean = sum / nums.length;
    let sq = 0;
    for (const x of nums) sq += (x - mean) * (x - mean);
    const q = (p) => {
      const idx = (nums.length - 1) * p;
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
    };
    out.stats = { min: nums[0], max: nums[nums.length - 1], mean, median: q(0.5), q1: q(0.25), q3: q(0.75), sum, std: nums.length > 1 ? Math.sqrt(sq / (nums.length - 1)) : 0, zeros: nums.filter(x => x === 0).length, negatives: nums.filter(x => x < 0).length };
    out.histogram = histogram(nums, isTemporal(type));
  }
  if (textCount) out.text = { minLen, maxLen, avgLen: lenSum / textCount };
  return out;
}

function histogram(sorted, temporal) {
  const min = sorted[0], max = sorted[sorted.length - 1];
  if (min === max) return [{ from: min, to: max, count: sorted.length }];
  const bins = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(sorted.length))));
  let width = (max - min) / bins;
  if (temporal && width < DAY_MS) width = DAY_MS;
  const out = [];
  for (let i = 0; i < bins; i++) out.push({ from: min + i * width, to: min + (i + 1) * width, count: 0 });
  for (const x of sorted) {
    let i = Math.floor((x - min) / width);
    if (i >= bins) i = bins - 1;
    out[i].count++;
  }
  return out;
}

export function distinctValues(frame, name, { search = '', limit = 500 } = {}) {
  const col = frame.col(name);
  const type = frame.typeOf(name);
  const counts = new Map();
  let nulls = 0;
  for (let r = 0; r < frame.rowCount; r++) {
    const v = col[r];
    if (v == null) { nulls++; continue; }
    const key = typeof v === 'string' ? v : formatValue(v, type);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const s = search.trim().toLowerCase();
  let entries = [...counts.entries()];
  if (s) entries = entries.filter(([k]) => k.toLowerCase().includes(s));
  entries.sort((a, b) => compareValues(a[0], b[0]));
  const total = entries.length;
  const values = entries.slice(0, limit).map(([value, count]) => ({ value, count }));
  if (nulls && (!s || 'empty'.includes(s) || '(empty)'.includes(s))) values.unshift({ value: null, count: nulls });
  return { values, total, truncated: total > limit };
}
