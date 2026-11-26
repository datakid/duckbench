import { readNativeFile } from '../app/platform.js';

const CHUNK = 32 * 1024 * 1024;
const decoder = new TextDecoder();

function tauri() {
  return typeof window !== 'undefined' ? window.__TAURI__ : null;
}

async function call(command, args, options) {
  const t = tauri();
  if (!t?.core?.invoke) throw new Error('The native DuckDB engine only runs in the Duckbench Native desktop app.');
  try {
    return await t.core.invoke(command, args, options);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

const parse = (buffer) => JSON.parse(decoder.decode(buffer));

export const init = () => call('duck_init');

export async function query(sql, maxRows) {
  const limit = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : null;
  return parse(await call('duck_query', { sql, maxRows: limit }));
}

export async function schema(sql) {
  return parse(await call('duck_schema', { sql })).fields;
}

export const count = (sql) => call('duck_count', { sql });
export const plan = (sql) => call('duck_plan', { sql });
export const exec = (sql) => call('duck_exec', { sql });
export const register = (name, path) => call('duck_register', { name, path });
export const dropFile = (name) => call('duck_drop_file', { name });
export const cancel = () => call('duck_cancel');
export const loadExcel = () => call('duck_load_excel');
export const moveFile = (from, to) => call('native_move_file', { from, to });
export const copyFile = (sql, format) => call('duck_copy_file', { sql, format });
export async function copyBytes(sql, format) {
  return new Uint8Array(await call('duck_copy_bytes', { sql, format }));
}

export function pathFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const raw = pathname.replace(/^\//, '');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function stageBytes(name, bytes, append) {
  return call('duck_stage', bytes, { headers: { name: encodeURIComponent(name), append: append ? '1' : '0' } });
}

export async function stageFile(name, file) {
  if (!file.size) {
    await stageBytes(name, new Uint8Array(0), false);
    return;
  }
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
    await stageBytes(name, bytes, offset > 0);
  }
}

export class NativeFileBlob extends Blob {
  constructor(path, size, type = 'application/octet-stream') {
    super([], { type });
    this.nativePath = path;
    this.nativeSize = size;
  }

  get size() {
    return this.nativeSize;
  }

  async arrayBuffer() {
    return (await readNativeFile(this.nativePath, this.nativeSize)).arrayBuffer();
  }

  async text() {
    return (await readNativeFile(this.nativePath, this.nativeSize)).text();
  }
}
