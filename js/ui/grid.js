import { el, clear, copyText } from './dom.js';
import { icon } from './icons.js';
import { formatValue, TYPE_BADGES, TYPE_LABELS, isNumeric } from '../core/types.js';

const ROW_H = 28;
const HEAD_H = 52;
const GUTTER_W = 56;
const PAGE = 200;
const OVERSCAN_ROWS = 12;
const MIN_W = 60;
const MAX_AUTO_W = 320;

export class Grid {
  constructor(host, handlers = {}) {
    this.host = host;
    this.h = handlers;
    this.fields = [];
    this.rowCount = 0;
    this.pages = new Map();
    this.pending = new Set();
    this.widths = new Map();
    this.resultId = null;
    this.selCols = [];
    this.anchor = null;
    this.focus = null;
    this.selRows = new Set();
    this.rowAnchor = null;
    this.changed = new Set();
    this.quality = [];
    this.showQuality = true;
    this.sortHint = new Map();
    this.filterHint = new Set();
    this.search = null;
    this.build();
  }

  build() {
    clear(this.host);
    this.host.classList.add('grid');
    this.viewport = el('div', { class: 'grid-viewport', tabindex: '0', role: 'grid', 'aria-label': 'Data preview' });
    this.sizer = el('div', { class: 'grid-sizer' });
    this.header = el('div', { class: 'grid-header', role: 'row' });
    this.body = el('div', { class: 'grid-body', role: 'rowgroup' });
    this.corner = el('div', { class: 'grid-corner', title: 'Select all' }, '#');
    this.gutter = el('div', { class: 'grid-gutter' });
    this.viewport.append(this.sizer);
    this.sizer.append(this.header, this.gutter, this.body);
    this.editor = null;
    this.host.append(this.viewport);
    this.viewport.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.viewport);
    this.viewport.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('mousedown', (e) => this.onCellDown(e));
    this.body.addEventListener('dblclick', (e) => this.onCellDbl(e));
    this.body.addEventListener('contextmenu', (e) => this.onCellContext(e));
    this.gutter.addEventListener('mousedown', (e) => this.onGutterDown(e));
    this.gutter.addEventListener('contextmenu', (e) => this.onGutterContext(e));
    this.corner.addEventListener('click', () => this.selectAll());
    this.header.addEventListener('mousedown', (e) => this.onHeaderDown(e));
    this.header.addEventListener('dblclick', (e) => this.onHeaderDbl(e));
    this.header.addEventListener('contextmenu', (e) => this.onHeaderContext(e));
    this.body.addEventListener('mouseover', (e) => {
      if (!this.dragging) return;
      const c = this.cellFromEvent(e);
      if (c) { this.focus = c; this.paintSelection(); }
    });
    window.addEventListener('mouseup', () => { if (this.dragging) { this.dragging = false; this.emitSelection(); } });
  }

  setData({ resultId, fields, rowCount, firstPage, quality, changed, keepScroll = true }) {
    const sameShape = this.fields.length === fields.length && this.fields.every((f, i) => f.name === fields[i].name);
    this.resultId = resultId;
    this.fields = fields;
    this.rowCount = rowCount;
    this.quality = quality || [];
    this.changed = new Set(changed || []);
    this.pages.clear();
    this.pending.clear();
    if (firstPage) this.pages.set(0, firstPage);
    this.autoWidths(firstPage);
    const names = new Set(fields.map(f => f.name));
    this.selCols = this.selCols.filter(n => names.has(n));
    if (!sameShape) { this.anchor = null; this.focus = null; }
    if (this.anchor && (this.anchor.r >= rowCount || this.anchor.c >= fields.length)) { this.anchor = null; this.focus = null; }
    this.selRows.clear();
    this.computeOffsets();
    if (!keepScroll) { this.viewport.scrollTop = 0; this.viewport.scrollLeft = 0; }
    this.renderHeader();
    this.render(true);
  }

  autoWidths(page) {
    const ctx = Grid.measureCtx || (Grid.measureCtx = document.createElement('canvas').getContext('2d'));
    ctx.font = '13px "IBM Plex Sans", system-ui, sans-serif';
    this.fields.forEach((f, c) => {
      if (this.widths.has(f.name)) return;
      ctx.font = '600 12.5px "IBM Plex Sans", system-ui, sans-serif';
      let w = ctx.measureText(f.name).width + 64;
      ctx.font = (isNumeric(f.type) ? '12.5px "IBM Plex Mono", monospace' : '13px "IBM Plex Sans", system-ui, sans-serif');
      const rows = page?.rows || [];
      for (let r = 0; r < Math.min(rows.length, 80); r++) {
        const v = rows[r][c];
        if (v == null) continue;
        const s = formatValue(v, f.type);
        w = Math.max(w, ctx.measureText(s.length > 60 ? s.slice(0, 60) : s).width + 24);
      }
      this.widths.set(f.name, Math.round(Math.min(MAX_AUTO_W, Math.max(MIN_W + 20, w))));
    });
  }

  computeOffsets() {
    this.offsets = [0];
    for (const f of this.fields) this.offsets.push(this.offsets[this.offsets.length - 1] + this.widths.get(f.name));
    const totalW = this.offsets[this.offsets.length - 1] + GUTTER_W;
    const totalH = HEAD_H + this.rowCount * ROW_H;
    this.sizer.style.width = `${totalW}px`;
    this.sizer.style.height = `${totalH}px`;
    this.header.style.width = `${totalW}px`;
    this.gutter.style.height = `${this.rowCount * ROW_H}px`;
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); });
  }

  visibleRange() {
    const vh = this.viewport.clientHeight - HEAD_H;
    const st = this.viewport.scrollTop;
    const r0 = Math.max(0, Math.floor(st / ROW_H) - OVERSCAN_ROWS);
    const r1 = Math.min(this.rowCount, Math.ceil((st + vh) / ROW_H) + OVERSCAN_ROWS);
    const sl = this.viewport.scrollLeft;
    const vw = this.viewport.clientWidth - GUTTER_W;
    let c0 = 0, c1 = this.fields.length;
    if (this.fields.length > 30) {
      c0 = Math.max(0, bisect(this.offsets, sl) - 2);
      c1 = Math.min(this.fields.length, bisect(this.offsets, sl + vw) + 2);
    }
    return { r0, r1, c0, c1 };
  }

  renderHeader() {
    clear(this.header);
    this.header.style.height = `${HEAD_H}px`;
    this.header.appendChild(this.corner);
    this.fields.forEach((f, c) => {
      const q = this.quality[c];
      const total = q ? q.empty + q.valid : 0;
      const pctEmpty = total ? q.empty / total : 0;
      const cell = el('div', {
        class: `gh-cell${this.selCols.includes(f.name) ? ' is-selected' : ''}${this.changed.has(f.name) ? ' is-changed' : ''}`,
        dataset: { c: String(c) },
        role: 'columnheader',
        title: `${f.name}\n${TYPE_LABELS[f.type] || f.type}${q ? `\n${q.valid.toLocaleString()} values · ${q.empty.toLocaleString()} empty` : ''}`,
        style: { left: `${GUTTER_W + this.offsets[c]}px`, width: `${this.widths.get(f.name)}px` },
      },
        el('div', { class: 'gh-top' },
          el('span', { class: `type-badge type-${f.type}` }, TYPE_BADGES[f.type] || f.type),
          el('span', { class: 'gh-name' }, f.name),
          this.sortHint.has(f.name) ? el('span', { class: 'gh-flag' }, icon(this.sortHint.get(f.name) === 'desc' ? 'sort-desc' : 'sort-asc', 12)) : null,
          this.filterHint.has(f.name) ? el('span', { class: 'gh-flag' }, icon('filter', 12)) : null,
          el('button', { class: 'gh-menu', tabindex: '-1', 'aria-label': `Column menu for ${f.name}`, dataset: { menu: '1' } }, icon('chevron-down', 13))),
        this.showQuality && q ? el('div', { class: 'gh-quality', title: `${Math.round((1 - pctEmpty) * 1000) / 10}% filled` },
          el('span', { class: 'gq-valid', style: { width: `${(1 - pctEmpty) * 100}%` } }),
          el('span', { class: 'gq-empty', style: { width: `${pctEmpty * 100}%` } })) : null,
        el('div', { class: 'gh-resize', dataset: { resize: String(c) } }));
      this.header.appendChild(cell);
    });
  }

  render(force = false) {
    if (!this.fields.length) { clear(this.body); clear(this.gutter); return; }
    const { r0, r1, c0, c1 } = this.visibleRange();
    const key = `${r0}:${r1}:${c0}:${c1}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.ensureRows(r0, r1);
    const frag = document.createDocumentFragment();
    const gfrag = document.createDocumentFragment();
    for (let r = r0; r < r1; r++) {
      const row = this.rowAt(r);
      const top = HEAD_H + r * ROW_H;
      const rowEl = el('div', { class: `g-row${r % 2 ? ' is-alt' : ''}`, style: { top: `${top}px` }, dataset: { r: String(r) }, role: 'row' });
      for (let c = c0; c < c1; c++) {
        const f = this.fields[c];
        const cell = document.createElement('div');
        cell.className = 'g-cell';
        cell.dataset.c = c;
        cell.style.left = `${GUTTER_W + this.offsets[c]}px`;
        cell.style.width = `${this.widths.get(f.name)}px`;
        if (!row) { cell.classList.add('is-loading'); rowEl.appendChild(cell); continue; }
        const v = row[c];
        if (v == null) { cell.classList.add('is-null'); cell.textContent = 'null'; }
        else {
          const s = formatValue(v, f.type);
          if (isNumeric(f.type)) cell.classList.add('is-num');
          else if (f.type === 'boolean') cell.classList.add(v ? 'is-true' : 'is-false');
          else if (f.type === 'date' || f.type === 'datetime') cell.classList.add('is-date');
          if (typeof v === 'string' && v !== v.trim()) cell.classList.add('has-ws');
          cell.textContent = s.length > 400 ? s.slice(0, 400) + '…' : s;
        }
        if (this.changed.has(f.name)) cell.classList.add('is-changed');
        rowEl.appendChild(cell);
      }
      frag.appendChild(rowEl);
      const rid = this.ridAt(r);
      gfrag.appendChild(el('div', { class: `g-gut${rid != null && this.selRows.has(rid) ? ' is-selected' : ''}`, style: { top: `${r * ROW_H}px` }, dataset: { r: String(r) }, title: rid != null ? `Row ${(r + 1).toLocaleString()} · source row ${rid}` : `Row ${(r + 1).toLocaleString()}` }, String(r + 1)));
    }
    clear(this.body).appendChild(frag);
    clear(this.gutter).appendChild(gfrag);
    this.paintSelection();
  }

  rowAt(r) {
    const p = this.pages.get(Math.floor(r / PAGE));
    if (!p) return null;
    return p.rows[r - p.start] || null;
  }

  ridAt(r) {
    const p = this.pages.get(Math.floor(r / PAGE));
    if (!p || !p.rids) return null;
    return p.rids[r - p.start] ?? null;
  }

  ensureRows(r0, r1) {
    const p0 = Math.floor(r0 / PAGE), p1 = Math.floor(Math.max(r0, r1 - 1) / PAGE);
    for (let p = p0; p <= p1; p++) {
      if (this.pages.has(p) || this.pending.has(p)) continue;
      this.pending.add(p);
      const rid = this.resultId;
      Promise.resolve(this.h.fetchRows?.(rid, p * PAGE, (p + 1) * PAGE)).then((res) => {
        if (rid !== this.resultId) return;
        this.pending.delete(p);
        if (!res || res.expired) return;
        this.pages.set(p, res);
        if (this.pages.size > 40) { const first = this.pages.keys().next().value; if (first !== p) this.pages.delete(first); }
        this.render(true);
      }).catch(() => this.pending.delete(p));
    }
  }

  async getRows(r0, r1) {
    const out = [];
    for (let p = Math.floor(r0 / PAGE); p <= Math.floor((r1 - 1) / PAGE); p++) {
      let page = this.pages.get(p);
      if (!page) { page = await this.h.fetchRows?.(this.resultId, p * PAGE, (p + 1) * PAGE); if (page && !page.expired) this.pages.set(p, page); }
      if (!page || page.expired) continue;
      for (let i = 0; i < page.rows.length; i++) { const r = page.start + i; if (r >= r0 && r < r1) out.push({ row: page.rows[i], rid: page.rids ? page.rids[i] : null }); }
    }
    return out;
  }

  cellFromEvent(e) {
    const cell = e.target.closest('.g-cell');
    const row = e.target.closest('.g-row');
    if (!cell || !row) return null;
    return { r: Number(row.dataset.r), c: Number(cell.dataset.c) };
  }

  onCellDown(e) {
    if (e.button !== 0) return;
    const p = this.cellFromEvent(e);
    if (!p) return;
    this.viewport.focus({ preventScroll: true });
    if (e.shiftKey && this.anchor) this.focus = p;
    else { this.anchor = p; this.focus = p; this.dragging = true; }
    this.selCols = [];
    this.selRows.clear();
    this.renderHeaderSel();
    this.paintSelection();
    this.render(true);
    if (!this.dragging) this.emitSelection();
  }

  onCellDbl(e) {
    const p = this.cellFromEvent(e);
    if (!p) return;
    this.startEdit(p);
  }

  onCellContext(e) {
    const p = this.cellFromEvent(e);
    if (!p) return;
    e.preventDefault();
    if (!this.inSelection(p)) { this.anchor = p; this.focus = p; this.selCols = []; this.renderHeaderSel(); this.paintSelection(); }
    const row = this.rowAt(p.r);
    this.h.onCellMenu?.({ x: e.clientX, y: e.clientY, r: p.r, c: p.c, field: this.fields[p.c], value: row ? row[p.c] : undefined, rid: this.ridAt(p.r) });
  }

  onGutterDown(e) {
    const g = e.target.closest('.g-gut');
    if (!g || e.button !== 0) return;
    const r = Number(g.dataset.r);
    const rid = this.ridAt(r);
    this.viewport.focus({ preventScroll: true });
    if (e.shiftKey && this.rowAnchor != null) {
      const a = Math.min(this.rowAnchor, r), b = Math.max(this.rowAnchor, r);
      if (!(modKey(e))) this.selRows.clear();
      for (let i = a; i <= b; i++) { const x = this.ridAt(i); if (x != null) this.selRows.add(x); }
    } else if (modKey(e)) {
      if (rid != null) { if (this.selRows.has(rid)) this.selRows.delete(rid); else this.selRows.add(rid); }
      this.rowAnchor = r;
    } else {
      this.selRows.clear();
      if (rid != null) this.selRows.add(rid);
      this.rowAnchor = r;
    }
    this.anchor = { r, c: 0 }; this.focus = { r, c: this.fields.length - 1 };
    this.selCols = [];
    this.renderHeaderSel();
    this.render(true);
    this.emitSelection();
  }

  onGutterContext(e) {
    const g = e.target.closest('.g-gut');
    if (!g) return;
    e.preventDefault();
    const r = Number(g.dataset.r);
    const rid = this.ridAt(r);
    if (rid != null && !this.selRows.has(rid)) { this.selRows.clear(); this.selRows.add(rid); this.rowAnchor = r; this.render(true); }
    this.h.onRowMenu?.({ x: e.clientX, y: e.clientY, rids: [...this.selRows], r });
  }

  onHeaderDown(e) {
    const rz = e.target.closest('.gh-resize');
    if (rz) { this.startResize(e, Number(rz.dataset.resize)); return; }
    const cell = e.target.closest('.gh-cell');
    if (!cell || e.button !== 0) return;
    const c = Number(cell.dataset.c);
    const name = this.fields[c].name;
    if (e.target.closest('[data-menu]')) {
      e.preventDefault();
      if (!this.selCols.includes(name)) { this.selCols = [name]; this.renderHeaderSel(); this.emitSelection(); }
      this.h.onHeaderMenu?.({ anchor: e.target.closest('[data-menu]'), field: this.fields[c], c });
      return;
    }
    this.viewport.focus({ preventScroll: true });
    if (e.shiftKey && this.selCols.length) {
      const last = this.fields.findIndex(f => f.name === this.selCols[this.selCols.length - 1]);
      const [a, b] = [Math.min(last, c), Math.max(last, c)];
      const add = this.fields.slice(a, b + 1).map(f => f.name);
      this.selCols = [...new Set([...this.selCols, ...add])];
    } else if (modKey(e)) {
      this.selCols = this.selCols.includes(name) ? this.selCols.filter(n => n !== name) : [...this.selCols, name];
    } else this.selCols = [name];
    this.anchor = null; this.focus = null;
    this.selRows.clear();
    this.renderHeaderSel();
    this.render(true);
    this.emitSelection();
  }

  onHeaderDbl(e) {
    const rz = e.target.closest('.gh-resize');
    if (rz) { const c = Number(rz.dataset.resize); this.widths.delete(this.fields[c].name); this.autoWidths(this.pages.get(0)); this.computeOffsets(); this.renderHeader(); this.render(true); return; }
    const cell = e.target.closest('.gh-cell');
    if (!cell || e.target.closest('[data-menu]')) return;
    this.h.onHeaderRename?.({ field: this.fields[Number(cell.dataset.c)], node: cell });
  }

  onHeaderContext(e) {
    const cell = e.target.closest('.gh-cell');
    if (!cell) return;
    e.preventDefault();
    const c = Number(cell.dataset.c);
    const name = this.fields[c].name;
    if (!this.selCols.includes(name)) { this.selCols = [name]; this.renderHeaderSel(); this.emitSelection(); }
    this.h.onHeaderMenu?.({ x: e.clientX, y: e.clientY, field: this.fields[c], c });
  }

  startResize(e, c) {
    e.preventDefault();
    e.stopPropagation();
    const name = this.fields[c].name;
    const startX = e.clientX, startW = this.widths.get(name);
    document.body.classList.add('is-resizing');
    const move = (ev) => {
      this.widths.set(name, Math.max(MIN_W, startW + ev.clientX - startX));
      this.computeOffsets();
      this.renderHeader();
      this.render(true);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('is-resizing'); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  renderHeaderSel() {
    for (const n of this.header.children) {
      if (n === this.corner) continue;
      const c = Number(n.dataset.c);
      n.classList.toggle('is-selected', this.selCols.includes(this.fields[c]?.name));
    }
    for (const row of this.body.children) for (const cell of row.children) cell.classList.toggle('is-colsel', this.selCols.includes(this.fields[Number(cell.dataset.c)]?.name));
  }

  rect() {
    if (!this.anchor || !this.focus) return null;
    return { r0: Math.min(this.anchor.r, this.focus.r), r1: Math.max(this.anchor.r, this.focus.r), c0: Math.min(this.anchor.c, this.focus.c), c1: Math.max(this.anchor.c, this.focus.c) };
  }

  inSelection(p) { const R = this.rect(); return R && p.r >= R.r0 && p.r <= R.r1 && p.c >= R.c0 && p.c <= R.c1; }

  paintSelection() {
    const R = this.rect();
    for (const row of this.body.children) {
      const r = Number(row.dataset.r);
      for (const cell of row.children) {
        const c = Number(cell.dataset.c);
        const inR = R && r >= R.r0 && r <= R.r1 && c >= R.c0 && c <= R.c1;
        cell.classList.toggle('is-sel', !!inR);
        cell.classList.toggle('is-focus', !!(this.focus && this.focus.r === r && this.focus.c === c));
        cell.classList.toggle('is-colsel', this.selCols.includes(this.fields[c]?.name));
        cell.classList.toggle('is-hit', !!(this.search && this.search.has(`${r}:${c}`)));
      }
    }
  }

  emitSelection() {
    const R = this.rect();
    this.h.onSelection?.({
      columns: this.selCols.length ? this.selCols : R ? this.fields.slice(R.c0, R.c1 + 1).map(f => f.name) : [],
      explicitColumns: this.selCols.slice(),
      rect: R,
      rids: [...this.selRows],
      focus: this.focus ? { ...this.focus, field: this.fields[this.focus.c], value: this.rowAt(this.focus.r)?.[this.focus.c], rid: this.ridAt(this.focus.r) } : null,
    });
  }

  selectAll() {
    if (!this.fields.length) return;
    this.anchor = { r: 0, c: 0 };
    this.focus = { r: this.rowCount - 1, c: this.fields.length - 1 };
    this.selCols = this.fields.map(f => f.name);
    this.renderHeaderSel();
    this.paintSelection();
    this.emitSelection();
  }

  scrollToCell(r, c) {
    const top = HEAD_H + r * ROW_H;
    const vt = this.viewport.scrollTop, vh = this.viewport.clientHeight;
    if (top - HEAD_H < vt) this.viewport.scrollTop = top - HEAD_H;
    else if (top + ROW_H > vt + vh) this.viewport.scrollTop = top + ROW_H - vh;
    if (c != null) {
      const left = this.offsets[c], right = this.offsets[c + 1];
      const vl = this.viewport.scrollLeft, vw = this.viewport.clientWidth - GUTTER_W;
      if (left < vl) this.viewport.scrollLeft = left;
      else if (right > vl + vw) this.viewport.scrollLeft = right - vw;
    }
  }

  onKey(e) {
    if (this.editor) return;
    if (!this.fields.length) return;
    const mod = modKey(e);
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); this.copySelection(e.shiftKey); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return; }
    if (e.key === 'Escape') { this.anchor = null; this.focus = null; this.selCols = []; this.selRows.clear(); this.renderHeaderSel(); this.render(true); this.emitSelection(); return; }
    const f = this.focus || { r: 0, c: 0 };
    let { r, c } = f;
    const page = Math.max(1, Math.floor((this.viewport.clientHeight - HEAD_H) / ROW_H) - 1);
    switch (e.key) {
      case 'ArrowDown': r = mod ? this.rowCount - 1 : r + 1; break;
      case 'ArrowUp': r = mod ? 0 : r - 1; break;
      case 'ArrowRight': c = mod ? this.fields.length - 1 : c + 1; break;
      case 'ArrowLeft': c = mod ? 0 : c - 1; break;
      case 'PageDown': r += page; break;
      case 'PageUp': r -= page; break;
      case 'Home': c = 0; if (mod) r = 0; break;
      case 'End': c = this.fields.length - 1; if (mod) r = this.rowCount - 1; break;
      case 'Tab': c += e.shiftKey ? -1 : 1; break;
      case 'Enter': case 'F2': if (this.focus) { e.preventDefault(); this.startEdit(this.focus); } return;
      case 'Delete': case 'Backspace': if (this.selRows.size) { e.preventDefault(); this.h.onDeleteRows?.([...this.selRows]); } return;
      default:
        if (this.focus && e.key.length === 1 && !mod && !e.altKey) { this.startEdit(this.focus, e.key); e.preventDefault(); }
        return;
    }
    e.preventDefault();
    r = Math.max(0, Math.min(this.rowCount - 1, r));
    c = Math.max(0, Math.min(this.fields.length - 1, c));
    if (e.shiftKey && e.key !== 'Tab') { if (!this.anchor) this.anchor = { ...f }; this.focus = { r, c }; }
    else { this.anchor = { r, c }; this.focus = { r, c }; }
    this.selCols = [];
    this.renderHeaderSel();
    this.scrollToCell(r, c);
    this.render(true);
    this.emitSelection();
  }

  async copySelection(withHeaders = false) {
    let R = this.rect();
    let cols;
    if (this.selCols.length && !R) { cols = this.selCols.map(n => this.fields.findIndex(f => f.name === n)).sort((a, b) => a - b); R = { r0: 0, r1: Math.min(this.rowCount, 100000) - 1 }; }
    else if (R) cols = range(R.c0, R.c1);
    else return;
    const rows = await this.getRows(R.r0, R.r1 + 1);
    const lines = [];
    if (withHeaders || this.selCols.length) lines.push(cols.map(c => this.fields[c].name).join('\t'));
    for (const { row } of rows) lines.push(cols.map(c => { const v = row[c]; const s = v == null ? '' : formatValue(v, this.fields[c].type); return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join('\t'));
    await copyText(lines.join('\n'));
    this.h.onCopied?.(rows.length, cols.length);
  }

  startEdit(p, initial) {
    if (!this.h.onCellEdit) return;
    const row = this.rowAt(p.r);
    if (!row) return;
    const rid = this.ridAt(p.r);
    if (rid == null) { this.h.onEditBlocked?.(); return; }
    this.scrollToCell(p.r, p.c);
    const f = this.fields[p.c];
    const v = row[p.c];
    const input = el('input', { class: 'g-editor', type: 'text', value: initial ?? (v == null ? '' : formatValue(v, f.type)) });
    input.style.top = `${HEAD_H + p.r * ROW_H}px`;
    input.style.left = `${GUTTER_W + this.offsets[p.c]}px`;
    input.style.width = `${Math.max(140, this.widths.get(f.name))}px`;
    this.sizer.appendChild(input);
    this.editor = input;
    input.focus();
    if (initial == null) input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const val = input.value;
      input.remove();
      this.editor = null;
      this.viewport.focus({ preventScroll: true });
      const before = v == null ? '' : formatValue(v, f.type);
      if (commit && val !== before) this.h.onCellEdit({ rid, column: f.name, value: val === '' ? null : val, r: p.r, c: p.c });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  setSearchHits(list) {
    this.search = list ? new Set(list.map(([r, c]) => `${r}:${c}`)) : null;
    this.paintSelection();
  }

  setHints({ sort, filter }) {
    this.sortHint = new Map(sort || []);
    this.filterHint = new Set(filter || []);
    this.renderHeader();
  }

  setColumnSelection(names) {
    this.selCols = names.filter(n => this.fields.some(f => f.name === n));
    this.anchor = null; this.focus = null;
    this.renderHeaderSel();
    this.render(true);
    this.emitSelection();
    const c = this.fields.findIndex(f => f.name === this.selCols[0]);
    if (c >= 0) this.scrollToCell(Math.floor(this.viewport.scrollTop / ROW_H), c);
  }

  setQualityVisible(v) { this.showQuality = v; this.renderHeader(); }

  clearWidths() { this.widths.clear(); }

  destroy() { this.ro.disconnect(); }
}

function bisect(arr, x) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function range(a, b) { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }

const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function modKey(e) { return isMacPlatform ? e.metaKey : e.ctrlKey; }
