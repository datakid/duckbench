(function (root) {
  function sheetToColumns(XLSX, ws, opts) {
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    const skip = Math.max(0, Number(opts.skipRows) || 0);
    const body = rows.slice(skip);
    let width = 0;
    for (const r of body) if (r.length > width) width = r.length;
    const header = opts.header !== false;
    const names = header && body.length ? Array.from({ length: width }, (_, i) => (body[0][i] == null ? '' : String(body[0][i]).trim())) : Array.from({ length: width }, () => '');
    const start = header ? 1 : 0;
    const n = Math.max(0, body.length - start);
    const columns = names.map(() => new Array(n));
    const kinds = names.map(() => null);
    for (let r = 0; r < n; r++) {
      const row = body[r + start];
      for (let c = 0; c < width; c++) {
        const raw = row[c];
        let v = raw === undefined ? null : raw;
        const isDate = v instanceof Date;
        if (isDate) v = isNaN(v) ? null : Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
        if (typeof v === 'string' && v.trim() === '') v = null;
        columns[c][r] = v;
        if (v != null) {
          const k = isDate ? 'date' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v === 'boolean' ? 'boolean' : 'text';
          const p = kinds[c];
          if (p == null) kinds[c] = k;
          else if (p !== k) kinds[c] = (p === 'integer' && k === 'number') || (p === 'number' && k === 'integer') ? 'number' : 'mixed';
        }
      }
    }
    const types = kinds.map((k, c) => {
      if (k === 'date') return columns[c].every(v => v == null || v % 86400000 === 0) ? 'date' : 'datetime';
      if (k === 'mixed') {
        for (let r = 0; r < n; r++) {
          const v = columns[c][r];
          if (v == null || typeof v === 'string') continue;
          const raw = body[r + start][c];
          columns[c][r] = raw instanceof Date ? dateText(raw) : String(v);
        }
        return 'text';
      }
      return k || 'text';
    });
    return { names, columns, types };
  }

  function dateText(d) {
    const p = (x, w = 2) => String(x).padStart(w, '0');
    const day = p(d.getFullYear(), 4) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return d.getHours() || d.getMinutes() || d.getSeconds() ? day + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) : day;
  }

  function sheetName(raw, used) {
    const strip = (s) => s.replace(/^'+|'+$/g, '').trim();
    const base = strip(strip(String(raw || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').trim()).slice(0, 31)) || 'Sheet1';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ' (' + i + ')';
      name = base.slice(0, 31 - suffix.length).trimEnd() + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  }

  function handle(XLSX, method, args) {
    if (method === 'sheets') {
      const wb = XLSX.read(args.buffer, { type: 'array', bookSheets: true });
      return { sheets: wb.SheetNames };
    }
    if (method === 'read') {
      const wb = XLSX.read(args.buffer, { type: 'array', cellDates: true, dense: true, sheets: args.sheet ? [args.sheet] : undefined });
      const sheet = args.sheet && wb.Sheets[args.sheet] ? args.sheet : wb.SheetNames[0];
      if (!sheet) throw new Error('This workbook has no sheets.');
      return Object.assign(sheetToColumns(XLSX, wb.Sheets[sheet], args.options || {}), { sheet });
    }
    if (method === 'write') {
      const wb = XLSX.utils.book_new();
      const used = new Set();
      for (const sh of args.sheets) {
        const n = sh.columns[0] ? sh.columns[0].length : 0;
        if (n > 1048575) throw new Error('"' + sh.name + '" has ' + n.toLocaleString('en-US') + ' rows; an Excel sheet holds at most 1,048,575 data rows plus the header. Export CSV or Parquet instead.');
        if (sh.fields.length > 16384) throw new Error('"' + sh.name + '" has ' + sh.fields.length.toLocaleString('en-US') + ' columns; an Excel sheet holds at most 16,384. Export CSV or Parquet instead.');
        const aoa = [sh.fields.map(f => f.name)];
        for (let r = 0; r < n; r++) {
          const row = new Array(sh.fields.length);
          for (let c = 0; c < sh.fields.length; c++) {
            const v = sh.columns[c][r];
            const t = sh.fields[c].type;
            if (v == null) row[c] = null;
            else if (t === 'date' || t === 'datetime') { const d = new Date(v); row[c] = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()); }
            else row[c] = v;
          }
          aoa.push(row);
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
        sh.fields.forEach((f, c) => {
          if (f.type !== 'date' && f.type !== 'datetime') return;
          for (let r = 1; r <= n; r++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })];
            if (cell) cell.z = f.type === 'date' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss';
          }
        });
        ws['!cols'] = sh.fields.map((f, c) => {
          let w = f.name.length;
          for (let r = 0; r < Math.min(n, 200); r++) { const v = sh.columns[c][r]; if (v != null) w = Math.max(w, String(v).length); }
          return { wch: Math.min(60, Math.max(8, w + 2)) };
        });
        if (sh.fields.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: n, c: sh.fields.length - 1 } }) };
        XLSX.utils.book_append_sheet(wb, ws, sheetName(sh.name, used));
      }
      return { buffer: XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) };
    }
    throw new Error('Unknown method ' + method);
  }

  root.DuckXlsx = { handle: handle };
})(typeof self !== 'undefined' ? self : window);
