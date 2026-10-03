import { Engine, ENGINE_METHODS } from './engine.js';
import { readParquet, writeParquet } from './parquet.js';

const engine = new Engine();

const handlers = {
  async loadParquet({ id, name, buffer, options }) {
    const { names, columns, types } = await readParquet(buffer);
    return engine.loadColumns({ id, name, format: 'parquet', names, columns, types, options: { detectTypes: options?.detectTypes !== false } });
  },
  async exportParquet(args) {
    const { fields, columns } = engine.exportData({ ...args, format: 'columns' });
    const buf = await writeParquet(fields, columns);
    return { buffer: buf, mime: 'application/vnd.apache.parquet' };
  },
};
for (const m of ENGINE_METHODS) handlers[m] = (args, progress) => engine[m](args || {}, progress);

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const fn = handlers[method];
    if (!fn) throw new Error(`Unknown engine method ${method}`);
    const progress = (p) => self.postMessage({ id, progress: p });
    const result = await fn(args, progress);
    const transfer = result && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};

self.postMessage({ ready: true });
