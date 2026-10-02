function makeWorkerRpc(url, { module = true, timeout = 0 } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let readyPromise = null;
  const start = () => {
    worker = new Worker(url, module ? { type: 'module' } : undefined);
    readyPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Worker did not start')), 8000);
      worker.addEventListener('message', function first(e) {
        if (e.data && e.data.ready) { clearTimeout(t); worker.removeEventListener('message', first); resolve(); }
      });
      worker.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message || 'Worker failed to load')); }, { once: true });
    });
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data || {};
      if (id == null) return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
  };
  const call = (method, args, transfer = []) => {
    if (!worker) start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args }, transfer);
    });
  };
  const terminate = () => {
    if (worker) worker.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    pending.clear();
  };
  return { call, terminate, ready: () => { if (!worker) start(); return readyPromise; }, get busy() { return pending.size > 0; } };
}

class InlineEngine {
  constructor() { this.enginePromise = null; this.parquet = null; }
  async _engine() {
    if (!this.enginePromise) this.enginePromise = import('./engine.js').then(m => new m.Engine());
    return this.enginePromise;
  }
  async call(method, args) {
    const e = await this._engine();
    if (method === 'loadParquet' || method === 'exportParquet') {
      this.parquet = this.parquet || await import('./parquet.js');
      if (method === 'loadParquet') {
        const { names, columns, types } = await this.parquet.readParquet(args.buffer);
        return e.loadColumns({ id: args.id, name: args.name, format: 'parquet', names, columns, types, options: args.options });
      }
      const { fields, columns } = e.exportData({ ...args, format: 'columns' });
      return { buffer: await this.parquet.writeParquet(fields, columns) };
    }
    await new Promise(r => setTimeout(r, 0));
    return e[method](args || {});
  }
}

export class EngineClient {
  constructor() {
    this.mode = 'worker';
    this.rpc = null;
    this.inline = null;
    this.listeners = new Set();
    this.inflight = 0;
    this.lastQueries = null;
    this.replay = [];
  }

  async init() {
    try {
      this.rpc = makeWorkerRpc(new URL('./worker.js', import.meta.url));
      await this.rpc.ready();
      await this.rpc.call('ping');
      this.mode = 'worker';
    } catch (e) {
      console.warn('Duckbench: worker unavailable, running on the main thread', e);
      this.rpc?.terminate();
      this.rpc = null;
      this.inline = new InlineEngine();
      this.mode = 'inline';
    }
    return this.mode;
  }

  onBusy(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _busy(delta, label) {
    this.inflight += delta;
    for (const fn of this.listeners) fn(this.inflight, label);
  }

  async call(method, args = {}, { transfer = [], label = '', track = true } = {}) {
    if (track) this._busy(1, label);
    try {
      if (this.rpc) return await this.rpc.call(method, args, transfer);
      return await this.inline.call(method, args);
    } finally {
      if (track) this._busy(-1, label);
    }
  }

  remember(method, args) {
    if (method === 'setQueries') { this.lastQueries = args; return; }
    if (method === 'removeSource') { this.replay = this.replay.filter(r => r.args.id !== args.id); return; }
    this.replay = this.replay.filter(r => r.args.id !== args.id);
    this.replay.push({ method, args });
  }

  async cancel() {
    if (!this.rpc) return false;
    this.rpc.terminate();
    this.inflight = 0;
    for (const fn of this.listeners) fn(0, '');
    this.rpc = makeWorkerRpc(new URL('./worker.js', import.meta.url));
    await this.rpc.ready();
    for (const r of this.replay) await this.rpc.call(r.method, cloneArgs(r.args));
    if (this.lastQueries) await this.rpc.call('setQueries', this.lastQueries);
    return true;
  }

  get canCancel() { return !!this.rpc; }
}

function cloneArgs(a) {
  if (a.buffer instanceof ArrayBuffer) return { ...a, buffer: a.buffer.slice(0) };
  return a;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export function makeXlsxRpc() {
  let rpc = null;
  let mode = null;
  const base = new URL('../../', import.meta.url);
  async function ensure() {
    if (mode) return;
    try {
      rpc = makeWorkerRpc(new URL('./xlsx-worker.js', import.meta.url), { module: false });
      await rpc.ready();
      mode = 'worker';
    } catch {
      rpc?.terminate(); rpc = null;
      if (!window.XLSX) await loadScript(new URL('vendor/xlsx-0.20.3.full.min.js', base).href).catch(() => { throw new Error('The Excel reader (vendor/xlsx-0.20.3.full.min.js) is missing.'); });
      if (!window.DuckXlsx) await loadScript(new URL('js/io/xlsx-core.js', base).href);
      mode = 'inline';
    }
  }
  return {
    async call(method, args) {
      await ensure();
      if (mode === 'worker') return rpc.call(method, args);
      await new Promise(r => setTimeout(r, 0));
      return window.DuckXlsx.handle(window.XLSX, method, args);
    },
  };
}
