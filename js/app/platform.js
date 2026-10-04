const tauri = () => (typeof window !== 'undefined' ? window.__TAURI__ : null);

export const isDesktop = () => !!tauri()?.core?.invoke;

const MIME_EXT = {
  'text/csv': 'csv', 'text/tab-separated-values': 'tsv', 'application/json': 'json', 'application/x-ndjson': 'jsonl',
  'text/markdown': 'md', 'application/sql': 'sql', 'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.apache.parquet': 'parquet',
};

function filterFor(filename, mime) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || MIME_EXT[mime] || '').toLowerCase();
  return ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [];
}

export async function saveNative(blob, filename, mime) {
  const t = tauri();
  const path = await t.core.invoke('plugin:dialog|save', { options: { defaultPath: filename, filters: filterFor(filename, mime) } });
  if (!path) return { cancelled: true };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await t.core.invoke('save_file', bytes, { headers: { path: encodeURIComponent(path) } });
  return { path };
}

export async function pickFolderNative(title) {
  const path = await tauri().core.invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title } });
  return Array.isArray(path) ? path[0] || null : path || null;
}

export async function saveIntoFolder(folder, filename, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return tauri().core.invoke('save_into_dir', bytes, { headers: { dir: encodeURIComponent(folder), name: encodeURIComponent(filename) } });
}

export async function revealNative(path) {
  try { await tauri().core.invoke('reveal_path', { path }); return true; } catch { return false; }
}

const DATA_EXT = ['csv', 'tsv', 'txt', 'parquet', 'json', 'jsonl', 'ndjson', 'xlsx'];

export function nativeFileUrl(path) {
  const os = navigator.userAgent.includes('Windows') ? 'win' : 'unix';
  return os === 'win' ? `http://dbfile.localhost/${encodeURIComponent(path)}` : `dbfile://localhost/${encodeURIComponent(path)}`;
}

export async function pickNativeFiles() {
  const t = tauri();
  if (!t) return null;
  const sel = await t.core.invoke('plugin:dialog|open', { options: { multiple: true, filters: [{ name: 'Data files', extensions: DATA_EXT }] } });
  const paths = !sel ? [] : Array.isArray(sel) ? sel : [sel];
  const out = [];
  for (const path of paths) {
    const meta = await t.core.invoke('file_meta', { path });
    const name = path.split(/[\\/]/).pop();
    const file = new File([], name);
    Object.defineProperty(file, 'size', { value: meta.size });
    out.push({ path, file });
  }
  return out;
}

export async function checkForUpdate() {
  const t = tauri();
  if (!t?.core?.invoke) return null;
  try {
    const u = await t.core.invoke('plugin:updater|check', {});
    if (!u || !u.available) return null;
    return {
      version: u.version,
      async install() {
        await t.core.invoke('plugin:updater|download_and_install', { rid: u.rid, onEvent: new t.core.Channel() });
        await t.core.invoke('plugin:process|restart');
      },
    };
  } catch { return null; }
}

export function appInfo() {
  return { desktop: isDesktop(), platform: isDesktop() ? 'desktop' : 'web' };
}
