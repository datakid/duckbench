import { uid } from '../core/util.js';

const HISTORY_LIMIT = 150;

export function createStore() {
  const listeners = new Set();
  const state = {
    projectName: 'Untitled project',
    queries: [],
    sources: [],
    activeQueryId: null,
    stepCursor: {},
  };
  const history = { past: [], future: [] };

  const snapshot = () => JSON.stringify({ queries: state.queries, sources: state.sources, activeQueryId: state.activeQueryId, projectName: state.projectName, stepCursor: state.stepCursor });
  const restore = (s) => { Object.assign(state, JSON.parse(s)); };

  function emit(kind) { for (const fn of listeners) fn(kind); }

  return {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit,
    commit(label, mutate, { silent = false } = {}) {
      const before = snapshot();
      mutate(state);
      const after = snapshot();
      if (before === after) return false;
      history.past.push({ label, s: before });
      if (history.past.length > HISTORY_LIMIT) history.past.shift();
      history.future = [];
      if (!silent) emit('change');
      return true;
    },
    quiet(mutate, kind = 'ui') { mutate(state); emit(kind); },
    undo() {
      const h = history.past.pop();
      if (!h) return null;
      history.future.push({ label: h.label, s: snapshot() });
      restore(h.s);
      emit('change');
      return h.label;
    },
    redo() {
      const h = history.future.pop();
      if (!h) return null;
      history.past.push({ label: h.label, s: snapshot() });
      restore(h.s);
      emit('change');
      return h.label;
    },
    canUndo: () => history.past.length > 0,
    canRedo: () => history.future.length > 0,
    undoLabel: () => history.past[history.past.length - 1]?.label || '',
    redoLabel: () => history.future[history.future.length - 1]?.label || '',
    resetHistory() { history.past = []; history.future = []; },
    activeQuery() { return state.queries.find(q => q.id === state.activeQueryId) || null; },
    query(id) { return state.queries.find(q => q.id === id) || null; },
    source(id) { return state.sources.find(s => s.id === id) || null; },
    cursor(qid = state.activeQueryId) {
      const q = state.queries.find(x => x.id === qid);
      if (!q) return -1;
      const c = state.stepCursor[qid];
      return c == null || c >= q.steps.length ? q.steps.length - 1 : c;
    },
    serialize: snapshot,
    load(json) { restore(json); history.past = []; history.future = []; emit('change'); },
  };
}

export function newStep(type, data, extra = {}) {
  return { id: uid('s'), type, data, disabled: false, name: '', note: '', ...extra };
}

export function newQuery(name, source, steps = []) {
  return { id: uid('q'), name, source, steps, loadEnabled: true, createdAt: Date.now() };
}

const DB_NAME = 'duckbench2';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Aborted'));
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const persist = {
  async putFile(id, blob) { try { await tx('files', 'readwrite', s => s.put(blob, id)); return true; } catch { return false; } },
  async getFile(id) { try { const db = await openDb(); return await reqP(db.transaction('files').objectStore('files').get(id)); } catch { return null; } },
  async deleteFile(id) { try { await tx('files', 'readwrite', s => s.delete(id)); } catch {} },
  async clearFiles() { try { await tx('files', 'readwrite', s => s.clear()); } catch {} },
  async putSession(json) { try { await tx('kv', 'readwrite', s => s.put({ json, at: Date.now() }, 'session')); return true; } catch { return false; } },
  async getSession() { try { const db = await openDb(); return await reqP(db.transaction('kv').objectStore('kv').get('session')); } catch { return null; } },
  async clearSession() { try { await tx('kv', 'readwrite', s => s.delete('session')); } catch {} },
  async listFileKeys() { try { const db = await openDb(); return await reqP(db.transaction('files').objectStore('files').getAllKeys()); } catch { return []; } },
};

export const prefs = {
  get(key, fallback) { try { const v = localStorage.getItem('duckbench2.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('duckbench2.' + key, JSON.stringify(value)); } catch {} },
};
