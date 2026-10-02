const HYPARQUET_URL = 'https://cdn.jsdelivr.net/npm/hyparquet@1/+esm';
const HYPARQUET_COMPRESSORS_URL = 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1/+esm';
const HYPARQUET_WRITER_URL = 'https://cdn.jsdelivr.net/npm/hyparquet-writer@0/+esm';

let readerMod = null, compMod = null, writerMod = null;

async function loadReader() {
  if (!readerMod) {
    try { readerMod = await import(HYPARQUET_URL); } catch { throw new Error('Could not download the Parquet reader (hyparquet) from cdn.jsdelivr.net — check your connection.'); }
  }
  if (!compMod) { try { compMod = await import(HYPARQUET_COMPRESSORS_URL); } catch { compMod = {}; } }
  return readerMod;
}

export async function readParquet(buffer) {
  const hp = await loadReader();
  const file = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
  const metadata = hp.parquetMetadata(file);
  const schema = hp.parquetSchema ? hp.parquetSchema(metadata) : null;
  const names = (schema?.children || []).map(c => c.element.name);
  const rows = await new Promise((resolve, reject) => {
    const opts = { file, metadata, rowFormat: 'object', onComplete: resolve };
    if (compMod?.compressors) opts.compressors = compMod.compressors;
    hp.parquetRead(opts).catch(reject);
  });
  const cols = (names.length ? names : Object.keys(rows[0] || {})).map(() => new Array(rows.length));
  const finalNames = names.length ? names : Object.keys(rows[0] || {});
  const kinds = finalNames.map(() => null);
  for (let r = 0; r < rows.length; r++) {
    const o = rows[r];
    for (let c = 0; c < finalNames.length; c++) {
      let v = o[finalNames[c]];
      if (v === undefined) v = null;
      if (v != null) {
        let k;
        if (typeof v === 'bigint') { v = Number(v); k = 'integer'; }
        else if (v instanceof Date) { v = isNaN(v) ? null : v.getTime(); k = 'datetime'; }
        else if (typeof v === 'number') k = Number.isInteger(v) ? 'integer' : 'number';
        else if (typeof v === 'boolean') k = 'boolean';
        else if (typeof v === 'string') k = 'text';
        else if (v instanceof Uint8Array) { v = new TextDecoder().decode(v); k = 'text'; }
        else { v = JSON.stringify(v, (key, x) => (typeof x === 'bigint' ? Number(x) : x)); k = 'text'; }
        const prev = kinds[c];
        if (prev == null) kinds[c] = k;
        else if (prev !== k) kinds[c] = (prev === 'integer' && k === 'number') || (prev === 'number' && k === 'integer') ? 'number' : 'mixed';
      }
      cols[c][r] = v;
    }
  }
  const types = kinds.map((k, c) => {
    if (k === 'mixed') { for (let r = 0; r < rows.length; r++) if (cols[c][r] != null) cols[c][r] = String(cols[c][r]); return 'text'; }
    if (k === 'datetime') {
      const allMidnight = cols[c].every(v => v == null || v % 86400000 === 0);
      return allMidnight ? 'date' : 'datetime';
    }
    return k || 'text';
  });
  return { names: finalNames, columns: cols, types };
}

export async function writeParquet(fields, columns) {
  if (!writerMod) {
    try { writerMod = await import(HYPARQUET_WRITER_URL); } catch { throw new Error('Could not download the Parquet writer (hyparquet-writer) from cdn.jsdelivr.net — check your connection.'); }
  }
  const build = (typed) => fields.map((f, i) => {
    const src = columns[i];
    if (!typed) return { name: f.name, data: src.map(v => (v == null ? null : String(v))), type: 'STRING' };
    switch (f.type) {
      case 'integer': {
        const safe = src.every(v => v == null || (v >= -2147483648 && v <= 2147483647));
        return safe ? { name: f.name, data: src, type: 'INT32' } : { name: f.name, data: src, type: 'DOUBLE' };
      }
      case 'number': return { name: f.name, data: src, type: 'DOUBLE' };
      case 'boolean': return { name: f.name, data: src, type: 'BOOLEAN' };
      case 'date': case 'datetime': return { name: f.name, data: src.map(v => (v == null ? null : new Date(v))), type: 'TIMESTAMP' };
      default: return { name: f.name, data: src, type: 'STRING' };
    }
  });
  try {
    return writerMod.parquetWriteBuffer({ columnData: build(true) });
  } catch {
    return writerMod.parquetWriteBuffer({ columnData: build(false) });
  }
}
