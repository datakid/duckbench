const CANDIDATES = [',', ';', '\t', '|'];

export function sniffDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  const lines = splitSampleLines(sample).slice(0, 30).filter(l => l.length);
  if (!lines.length) return ',';
  let best = ',', bestScore = -1;
  for (const d of CANDIDATES) {
    const counts = lines.map(l => countOutsideQuotes(l, d));
    const first = counts[0];
    if (!first) continue;
    const consistent = counts.filter(c => c === first).length / counts.length;
    const score = consistent * 100 + Math.min(first, 50);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function splitSampleLines(s) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { q = !q; cur += ch; continue; }
    if (!q && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      out.push(cur); cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') q = !q;
    else if (!q && ch === d) n++;
  }
  return n;
}

export function parseCSV(text, opts = {}) {
  const delim = opts.delimiter || sniffDelimiter(text);
  const quote = opts.quote ?? '"';
  const maxRows = opts.maxRows ?? Infinity;
  const onProgress = opts.onProgress;
  let i = 0;
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  const n = text.length;
  const rows = [];
  let row = [];
  let field = '';
  const dc = delim.charCodeAt(0);
  const qc = quote ? quote.charCodeAt(0) : -1;
  let nextReport = 1 << 20;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === qc && field === '') {
      i++;
      let start = i;
      let buf = '';
      while (i < n) {
        const ch = text.charCodeAt(i);
        if (ch === qc) {
          if (text.charCodeAt(i + 1) === qc) { buf += text.slice(start, i + 1); i += 2; start = i; continue; }
          buf += text.slice(start, i);
          i++;
          break;
        }
        i++;
        if (i >= n) buf += text.slice(start, i);
      }
      field = buf;
      while (i < n) {
        const ch = text.charCodeAt(i);
        if (ch === dc || ch === 10 || ch === 13) break;
        field += text[i];
        i++;
      }
      field = { q: field };
      continue;
    }
    if (c === dc) {
      row.push(typeof field === 'object' ? field.q : field);
      field = '';
      i++;
      continue;
    }
    if (c === 10 || c === 13) {
      row.push(typeof field === 'object' ? field.q : field);
      field = '';
      rows.push(row);
      row = [];
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      i++;
      if (rows.length >= maxRows) break;
      if (onProgress && i > nextReport) { onProgress(i / n); nextReport = i + (1 << 20); }
      continue;
    }
    let j = i;
    while (j < n) {
      const ch = text.charCodeAt(j);
      if (ch === dc || ch === 10 || ch === 13) break;
      j++;
    }
    field = (typeof field === 'object' ? field.q : field) + text.slice(i, j);
    i = j;
  }
  if (field !== '' || row.length) {
    row.push(typeof field === 'object' ? field.q : field);
    rows.push(row);
  }
  return { rows, delimiter: delim };
}

export class CsvStream {
  constructor(delimiter, onRow, quote = '"') {
    this.d = delimiter;
    this.q = quote;
    this.onRow = onRow;
    this.row = [];
    this.field = '';
    this.mode = 0;
    this.pendingCR = false;
    this.rows = 0;
  }

  _endField() { this.row.push(this.field); this.field = ''; this.mode = 0; }
  _endRow() { this._endField(); const r = this.row; this.row = []; this.rows++; this.onRow(r); }

  push(text) {
    const d = this.d, q = this.q;
    const n = text.length;
    let i = 0;
    if (this.pendingCR) { this.pendingCR = false; if (n && text[0] === '\n') i = 1; }
    while (i < n) {
      if (this.mode === 2) {
        const j = text.indexOf(q, i);
        if (j < 0) { this.field += text.slice(i); return; }
        this.field += text.slice(i, j);
        this.mode = 3;
        i = j + 1;
        continue;
      }
      const ch = text[i];
      if (this.mode === 3) {
        if (ch === q) { this.field += q; this.mode = 2; i++; continue; }
        this.mode = 4;
      }
      if (ch === d) { this._endField(); i++; continue; }
      if (ch === '\n') { this._endRow(); i++; continue; }
      if (ch === '\r') {
        this._endRow();
        if (i + 1 < n) { if (text[i + 1] === '\n') i++; } else this.pendingCR = true;
        i++;
        continue;
      }
      if (ch === q && this.mode === 0 && this.field === '') { this.mode = 2; i++; continue; }
      let j = i + 1;
      while (j < n) { const c = text[j]; if (c === d || c === '\n' || c === '\r') break; j++; }
      this.field += text.slice(i, j);
      if (this.mode === 0) this.mode = 1;
      i = j;
    }
  }

  end() {
    if (this.field !== '' || this.row.length || this.mode >= 2) this._endRow();
  }
}

export function detectEncoding(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
  let end = bytes.length;
  let k = 0;
  while (k < 4 && end - k - 1 >= 0 && (bytes[end - k - 1] & 0xC0) === 0x80) k++;
  if (end - k - 1 >= 0 && bytes[end - k - 1] >= 0xC0) end = end - k - 1;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); return 'utf-8'; }
  catch { return 'windows-1252'; }
}

export function decodeBuffer(buffer, encoding = 'auto') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (encoding === 'auto') {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    } catch {
      return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
    }
  }
  return { text: new TextDecoder(encoding).decode(bytes), encoding };
}

export function rowsToColumns(rows, { header = true, skipRows = 0 } = {}) {
  const body = rows.slice(skipRows);
  while (body.length && body[body.length - 1].length === 1 && body[body.length - 1][0] === '') body.pop();
  let names;
  let start = 0;
  let width = 0;
  for (const r of body) if (r.length > width) width = r.length;
  if (header && body.length) {
    names = body[0].map(s => String(s ?? '').trim());
    start = 1;
  } else names = [];
  while (names.length < width) names.push('');
  const cols = names.map(() => new Array(body.length - start));
  for (let r = start; r < body.length; r++) {
    const row = body[r];
    for (let c = 0; c < names.length; c++) cols[c][r - start] = row[c] ?? null;
  }
  return { names, cols };
}

export function csvEscape(v, delim = ',', guard = true) {
  if (v == null) return '';
  let s = String(v);
  if (guard && s.length && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d/.test(s)) s = "'" + s;
  if (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
