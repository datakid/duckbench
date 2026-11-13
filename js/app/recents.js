export const RECENT_KEY = 'duckbench.recentFiles';
export const RECENT_MAX = 10;

export const pathName = (p) => String(p ?? '').split(/[\\/]/).pop() || '';

export function folderOf(p) {
  const s = String(p ?? '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
}

const sameKey = (p) => String(p).toLowerCase();

export function parseRecent(raw) {
  if (raw == null) return [];
  let v;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!Array.isArray(v)) return [];
  return v
    .filter(e => e && typeof e === 'object' && typeof e.path === 'string' && e.path)
    .map(e => ({ path: e.path, name: typeof e.name === 'string' && e.name ? e.name : pathName(e.path), openedAt: Number.isFinite(e.openedAt) ? e.openedAt : 0 }))
    .slice(0, RECENT_MAX);
}

export function addRecent(list, entry) {
  const key = sameKey(entry.path);
  const rest = (list || []).filter(e => sameKey(e.path) !== key);
  return [entry, ...rest].slice(0, RECENT_MAX);
}

export function removeRecent(list, path) {
  const key = sameKey(path);
  return (list || []).filter(e => sameKey(e.path) !== key);
}

export function recentWhen(openedAt, now = Date.now()) {
  const d = new Date(openedAt), n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return d.toLocaleDateString();
}

export function readRecents(storage = globalThis.localStorage) {
  try { return parseRecent(storage.getItem(RECENT_KEY)); } catch { return []; }
}

export function writeRecents(list, storage = globalThis.localStorage) {
  try { storage.setItem(RECENT_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
