export const SHARE_VERSION = '1';
export const SHARE_MAX_URL = 8000;
export const SHARE_MAX_INPUT = 10000;
export const SHARE_MAX_BYTES = 1_000_000;
export const SHARE_MAX_STEPS = 500;

export const STRINGS = {
  previewBadge: 'preview',
  deltaNoChange: 'no change',
  deltaNoChangeTip: 'Same number of rows and columns. Values or types may still have changed.',
  sqlNofile: 'Open a file first.',
  sqlNosteps: 'No steps to copy yet.',
  sqlUnavailable: 'Copy as SQL is available for files opened with the SQL engine.',
  sqlError: 'Couldn’t build SQL for this pipeline. Try removing the last step and copy again.',
  copyDone: (label) => `${label} copied`,
  shareCopied: 'Share link copied',
  shareTooLong: 'This recipe is too long for a link. Download it as a recipe file instead.',
  shareUnsupported: 'This browser can’t create share links. Download the recipe file instead.',
  shareMulti: 'Share links carry the steps of one query. This query uses other queries, so download the recipe file instead.',
  shareNoSteps: 'There are no steps to share yet.',
  shareErr: {
    malformed: 'This link is incomplete or damaged. Ask for the link again or use a recipe file.',
    'too-large': 'This link is too large to load. Use a recipe file instead.',
    'too-long': 'This link is too long to be a Duckbench recipe. Check that you pasted only the link.',
    'newer-version': 'This link was made by a newer version of Duckbench. Update Duckbench and try again.',
  },
};

export const pad2 = (n) => String(n).padStart(2, '0');
export const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const baseName = (p) => String(p ?? '').split(/[\\/]/).pop() || '';
export const oneLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029\u0000-\u001f]+/g, ' ').trim();

export function firstPreviewOnlyIndex(diag) {
  if (!Array.isArray(diag)) return -1;
  return diag.findIndex(d => d && d.preview && !d.disabled && !d.error);
}

export function previewTaintedAt(diag, index) {
  if (!Array.isArray(diag) || index < 0) return -1;
  return firstPreviewOnlyIndex(diag.slice(0, index + 1));
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const plural = (n, one, many) => (n === 1 ? one : many);

export function formatStepDelta(prev, curr, { preview = false } = {}) {
  if (!prev || !curr) return null;
  const rowsKnown = num(prev.rows) && num(curr.rows);
  const colsKnown = num(prev.cols) && num(curr.cols);
  if (!rowsKnown && !colsKnown) return null;
  const dr = rowsKnown ? curr.rows - prev.rows : 0;
  const dc = colsKnown ? curr.cols - prev.cols : 0;
  const parts = [], words = [];
  const sign = (n) => (n < 0 ? '−' : '+');
  if (dr !== 0) {
    const a = Math.abs(dr);
    parts.push(`${sign(dr)}${a.toLocaleString()} ${plural(a, 'row', 'rows')}`);
    words.push(`${a.toLocaleString()} ${plural(a, 'row', 'rows')} ${dr < 0 ? 'removed' : 'added'}`);
  }
  if (dc !== 0) {
    const a = Math.abs(dc);
    parts.push(`${sign(dc)}${a.toLocaleString()} ${plural(a, 'col', 'cols')}`);
    words.push(`${a.toLocaleString()} ${plural(a, 'column', 'columns')} ${dc < 0 ? 'removed' : 'added'}`);
  }
  if (!parts.length) {
    if (!(rowsKnown && colsKnown)) return null;
    return { text: STRINGS.deltaNoChange, label: 'No change', muted: true, tip: STRINGS.deltaNoChangeTip, preview };
  }
  return { text: parts.join(' · '), label: words.join(', '), muted: false, tip: '', preview };
}

export function sqlHeader({ fileName, from = 1, to, total, date }) {
  const lines = [
    '-- Duckbench pipeline',
    `-- Source: ${oneLine(baseName(fileName)) || 'unknown'}`,
    to === from ? `-- Step ${from} of ${total}` : `-- Steps ${from} to ${to} of ${total}`,
    `-- Generated ${localDate(date instanceof Date ? date : new Date())}`,
  ];
  return lines.join('\n');
}

export function finishSql(sql) {
  const s = String(sql ?? '').replace(/\r\n?/g, '\n').trim().replace(/;+\s*$/, '');
  return `${s};`;
}

export function buildSqlCopy({ fileName, sql, from = 1, to, total, date }) {
  return `${sqlHeader({ fileName, from, to, total, date })}\n${finishSql(sql)}\n`;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const reviver = (k, v) => (FORBIDDEN_KEYS.has(k) ? undefined : v);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function stripForShare(steps) {
  return {
    app: 'duckbench',
    steps: (steps || []).map(s => {
      const out = { type: s.type, data: JSON.parse(JSON.stringify(s.data ?? {})) };
      if (s.disabled) out.disabled = true;
      if (s.name) out.name = s.name;
      if (s.note) out.note = s.note;
      return out;
    }),
  };
}

export const CROSS_QUERY_TYPES = new Set(['join', 'append']);

export function usesOtherQueries(steps) {
  return (steps || []).some(s => CROSS_QUERY_TYPES.has(s.type) || (s.type === 'sql' && (s.data?.tables || []).length > 0));
}

const toB64Url = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64Url = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function deflate(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflate(bytes, cap) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { try { await reader.cancel(); } catch {} return { tooLarge: true }; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { bytes: out };
}

export async function encodeShare(obj) {
  const json = JSON.stringify(obj);
  const packed = await deflate(new TextEncoder().encode(json));
  return `${SHARE_VERSION}.${toB64Url(packed)}`;
}

export function extractShare(text) {
  const t = String(text ?? '').trim();
  const hash = t.indexOf('#r=');
  if (hash >= 0) return t.slice(hash + 3).split(/\s/)[0];
  if (/^r=/.test(t)) return t.slice(2).split(/\s/)[0];
  return t.split(/\s/)[0];
}

export async function decodeShare(input, { isKnownStep } = {}) {
  const str = String(input ?? '');
  if (str.length > SHARE_MAX_INPUT) return { ok: false, reason: 'too-long' };
  if (!/^1\.[A-Za-z0-9_-]+$/.test(str)) return { ok: false, reason: /^[0-9]/.test(str) && str[0] !== '1' ? 'newer-version' : 'malformed' };
  let packed;
  try { packed = fromB64Url(str.slice(2)); } catch { return { ok: false, reason: 'malformed' }; }
  let raw;
  try { raw = await inflate(packed, SHARE_MAX_BYTES); } catch { return { ok: false, reason: 'malformed' }; }
  if (raw.tooLarge) return { ok: false, reason: 'too-large' };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes); } catch { return { ok: false, reason: 'malformed' }; }
  let recipe;
  try { recipe = JSON.parse(text, reviver); } catch { return { ok: false, reason: 'malformed' }; }
  if (!isPlain(recipe) || !Array.isArray(recipe.steps)) return { ok: false, reason: 'malformed' };
  if (recipe.steps.length > SHARE_MAX_STEPS) return { ok: false, reason: 'too-large' };
  if (recipe.steps.length === 0) return { ok: false, reason: 'malformed' };
  for (const s of recipe.steps) {
    if (!isPlain(s) || typeof s.type !== 'string' || s.type.length > 64) return { ok: false, reason: 'malformed' };
    if (s.data !== undefined && !isPlain(s.data)) return { ok: false, reason: 'malformed' };
    if (isKnownStep && !isKnownStep(s)) return { ok: false, reason: 'unsupported-step', type: s.type };
  }
  return { ok: true, recipe };
}

export async function createShareLink(steps, base) {
  if (!steps || !steps.length) return { ok: false, reason: 'no-steps' };
  if (usesOtherQueries(steps)) return { ok: false, reason: 'multi' };
  if (!canCompress()) return { ok: false, reason: 'unsupported' };
  if (!base) return { ok: false, reason: 'nobase' };
  let payload;
  try { payload = await encodeShare(stripForShare(steps)); } catch { return { ok: false, reason: 'unsupported' }; }
  const url = `${base}#r=${payload}`;
  if (url.length > SHARE_MAX_URL) return { ok: false, reason: 'too-long' };
  return { ok: true, url };
}
