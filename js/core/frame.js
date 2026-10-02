import { compareValues, inferColumnType, convertValue, typeOfJsValues } from './types.js';

export class Frame {
  constructor(fields, columns, rowCount, rid = null) {
    this.fields = fields;
    this.columns = columns;
    this.rowCount = rowCount ?? (columns[0] ? columns[0].length : 0);
    this.rid = rid;
    this._index = null;
  }

  static empty(fields = []) {
    return new Frame(fields.map(f => ({ ...f })), fields.map(() => []), 0);
  }

  static fromRows(names, rows, types) {
    const cols = names.map(() => new Array(rows.length));
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < names.length; c++) cols[c][r] = row[c] === undefined ? null : row[c];
    }
    const fields = names.map((name, i) => ({ name, type: types ? types[i] : typeOfJsValues(sample(cols[i])) }));
    return new Frame(fields, cols, rows.length);
  }

  static fromObjects(objs) {
    const names = [];
    const seen = new Set();
    for (const o of objs) {
      if (o && typeof o === 'object') for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); names.push(k); }
    }
    const cols = names.map(() => new Array(objs.length));
    for (let r = 0; r < objs.length; r++) {
      const o = objs[r] || {};
      for (let c = 0; c < names.length; c++) {
        let v = o[names[c]];
        if (v === undefined) v = null;
        else if (typeof v === 'bigint') v = Number(v);
        else if (v instanceof Date) v = v.getTime();
        else if (v !== null && typeof v === 'object') v = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x));
        cols[c][r] = v;
      }
    }
    const fields = names.map((name, i) => ({ name, type: typeOfJsValues(sample(cols[i])) }));
    return new Frame(fields, cols, objs.length);
  }

  static fromText(names, cols, { infer = true } = {}) {
    const rowCount = cols[0] ? cols[0].length : 0;
    const fields = names.map(name => ({ name, type: 'text' }));
    const f = new Frame(fields, cols, rowCount);
    return infer ? f.autoType() : f.blankToNull();
  }

  get names() { return this.fields.map(f => f.name); }

  withRid() {
    if (this.rid) return this;
    const rid = new Array(this.rowCount);
    for (let i = 0; i < this.rowCount; i++) rid[i] = i + 1;
    return new Frame(this.fields, this.columns, this.rowCount, rid);
  }

  indexOf(name) {
    if (!this._index) {
      this._index = new Map();
      this.fields.forEach((f, i) => this._index.set(f.name, i));
    }
    const i = this._index.get(name);
    return i === undefined ? -1 : i;
  }

  has(name) { return this.indexOf(name) >= 0; }

  field(name) { const i = this.indexOf(name); return i >= 0 ? this.fields[i] : null; }

  col(name) {
    const i = this.indexOf(name);
    if (i < 0) throw new Error(`Column “${name}” does not exist at this step.`);
    return this.columns[i];
  }

  typeOf(name) { const f = this.field(name); return f ? f.type : 'text'; }

  require(...names) {
    for (const n of names.flat()) if (n != null && n !== '' && !this.has(n)) throw new Error(`Column “${n}” does not exist at this step.`);
  }

  row(r) { return this.columns.map(c => c[r]); }

  rowObject(r) {
    const o = {};
    for (let c = 0; c < this.fields.length; c++) o[this.fields[c].name] = this.columns[c][r];
    return o;
  }

  rows(start = 0, end = this.rowCount) {
    const out = [];
    const e = Math.min(end, this.rowCount);
    for (let r = start; r < e; r++) out.push(this.row(r));
    return out;
  }

  take(indices) {
    const n = indices.length;
    const cols = this.columns.map(src => {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = src[indices[i]];
      return out;
    });
    let rid = null;
    if (this.rid) { rid = new Array(n); for (let i = 0; i < n; i++) rid[i] = this.rid[indices[i]]; }
    return new Frame(this.fields.map(f => ({ ...f })), cols, n, rid);
  }

  slice(start, end) {
    const s = Math.max(0, start), e = Math.min(this.rowCount, end);
    return new Frame(this.fields.map(f => ({ ...f })), this.columns.map(c => c.slice(s, e)), Math.max(0, e - s), this.rid ? this.rid.slice(s, e) : null);
  }

  filterRows(pred) {
    const idx = [];
    for (let r = 0; r < this.rowCount; r++) if (pred(r)) idx.push(r);
    if (idx.length === this.rowCount) return this;
    return this.take(idx);
  }

  select(names) {
    const fields = [], cols = [];
    for (const n of names) {
      const i = this.indexOf(n);
      if (i < 0) throw new Error(`Column “${n}” does not exist at this step.`);
      fields.push({ ...this.fields[i] });
      cols.push(this.columns[i]);
    }
    return new Frame(fields, cols, this.rowCount, this.rid);
  }

  drop(names) {
    const set = new Set(names);
    return this.select(this.names.filter(n => !set.has(n)));
  }

  withColumn(name, type, values, at) {
    const fields = this.fields.map(f => ({ ...f }));
    const cols = this.columns.slice();
    const i = this.indexOf(name);
    if (i >= 0) { fields[i] = { name, type }; cols[i] = values; }
    else if (at != null && at >= 0 && at <= fields.length) { fields.splice(at, 0, { name, type }); cols.splice(at, 0, values); }
    else { fields.push({ name, type }); cols.push(values); }
    return new Frame(fields, cols, this.rowCount, this.rid);
  }

  replaceColumn(name, values, type) {
    const i = this.indexOf(name);
    if (i < 0) throw new Error(`Column “${name}” does not exist at this step.`);
    const fields = this.fields.map(f => ({ ...f }));
    const cols = this.columns.slice();
    cols[i] = values;
    if (type) fields[i].type = type;
    return new Frame(fields, cols, this.rowCount, this.rid);
  }

  rename(map) {
    const fields = this.fields.map(f => ({ ...f, name: map[f.name] ?? f.name }));
    const seen = new Set();
    for (const f of fields) {
      if (seen.has(f.name)) throw new Error(`Renaming would create two columns called “${f.name}”.`);
      seen.add(f.name);
    }
    return new Frame(fields, this.columns.slice(), this.rowCount, this.rid);
  }

  mapColumn(name, fn, type) {
    const src = this.col(name);
    const out = new Array(this.rowCount);
    for (let r = 0; r < this.rowCount; r++) out[r] = fn(src[r], r);
    return this.replaceColumn(name, out, type);
  }

  sortIndex(keys) {
    const idx = new Array(this.rowCount);
    for (let i = 0; i < this.rowCount; i++) idx[i] = i;
    const specs = keys.map(k => ({ col: this.col(k.column), dir: k.direction === 'desc' ? -1 : 1, nullsLast: k.nullsLast !== false }));
    idx.sort((a, b) => {
      for (const s of specs) {
        const va = s.col[a], vb = s.col[b];
        const na = va == null, nb = vb == null;
        if (na || nb) {
          if (na && nb) continue;
          return (na ? 1 : -1) * (s.nullsLast ? 1 : -1);
        }
        const c = compareValues(va, vb);
        if (c !== 0) return c * s.dir;
      }
      return a - b;
    });
    return idx;
  }

  blankToNull() {
    const cols = this.columns.map((src, c) => (this.fields[c].type === 'text' ? src.map(v => (v === '' ? null : v)) : src));
    return new Frame(this.fields.map(f => ({ ...f })), cols, this.rowCount, this.rid);
  }

  autoType() {
    const fields = this.fields.map(f => ({ ...f }));
    const cols = this.columns.slice();
    for (let c = 0; c < fields.length; c++) {
      if (fields[c].type !== 'text') continue;
      const src = cols[c];
      const t = inferColumnType(src);
      if (t === 'text') {
        cols[c] = src.map(v => (v === '' ? null : v));
        continue;
      }
      const out = new Array(src.length);
      let ok = true;
      for (let r = 0; r < src.length; r++) {
        const v = convertValue(src[r], t);
        if (v === undefined) { ok = false; break; }
        out[r] = v;
      }
      if (ok) { cols[c] = out; fields[c].type = t; }
      else cols[c] = src.map(v => (v === '' ? null : v));
    }
    return new Frame(fields, cols, this.rowCount, this.rid);
  }

  estimateBytes() {
    let total = 0;
    const n = Math.min(this.rowCount, 500);
    if (!n) return 0;
    for (const col of this.columns) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const v = col[Math.floor(i * this.rowCount / n)];
        s += v == null ? 8 : typeof v === 'string' ? 40 + v.length * 2 : 16;
      }
      total += (s / n) * this.rowCount;
    }
    return Math.round(total);
  }
}

function sample(arr, n = 2000) {
  if (arr.length <= n) return arr;
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}
