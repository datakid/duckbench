export const LOCAL_LIBS = false;

const CDN = {
  duckdb: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm',
  hyparquet: 'https://cdn.jsdelivr.net/npm/hyparquet@1/+esm',
  hyparquetCompressors: 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1/+esm',
  hyparquetWriter: 'https://cdn.jsdelivr.net/npm/hyparquet-writer@0/+esm',
};

const LOCAL = {
  duckdb: 'vendor/duckdb/duckdb.mjs',
  hyparquet: 'vendor/hyparquet/hyparquet.mjs',
  hyparquetCompressors: 'vendor/hyparquet/hyparquet-compressors.mjs',
  hyparquetWriter: 'vendor/hyparquet/hyparquet-writer.mjs',
};

const root = new URL('../../', import.meta.url);

export function libUrl(name) {
  return LOCAL_LIBS ? new URL(LOCAL[name], root).href : CDN[name];
}

export function duckBundles() {
  const base = new URL('vendor/duckdb/', root).href;
  return {
    mvp: { mainModule: base + 'duckdb-mvp.wasm', mainWorker: base + 'duckdb-browser-mvp.worker.js' },
    eh: { mainModule: base + 'duckdb-eh.wasm', mainWorker: base + 'duckdb-browser-eh.worker.js' },
  };
}

export const libSource = () => (LOCAL_LIBS ? 'bundled' : 'cdn.jsdelivr.net');
