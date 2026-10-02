import { $, el, clear, debounce, modKey, kbd, fmtCount, fmtBytes, fmtMs, fmtAgo, download, copyText, pickFiles, fuzzyScore } from '../ui/dom.js';
import { icon, svg, LOGO } from '../ui/icons.js';
import { modal, confirmDialog, promptDialog, menu, toast, hasOverlay } from '../ui/overlay.js';
import { Grid } from '../ui/grid.js';
import { buildForm } from '../ui/forms.js';
import { EngineClient, makeXlsxRpc } from '../engine/client.js';
import { createStore, newStep, newQuery, persist, prefs } from './store.js';
import { TRANSFORMS, RIBBON_TABS, transformCatalog, defaultsFor, stepSummary, migrateStep } from '../core/transforms.js';
import { TYPE_LABELS, formatValue } from '../core/types.js';
import { uid, uniqueName } from '../core/util.js';
import { SAMPLE_SALES_CSV, SAMPLE_REGIONS_CSV } from './samples.js';
import { createSqlRunner } from './sqlrunner.js';
import { startTour, maybeAutoTour, resumePendingTour } from './tour.js';
import { zipFiles } from '../io/zip.js';
import * as duck from '../engine/duck.js';

const store = createStore();
const client = new EngineClient();
const xlsx = makeXlsxRpc();
const sql = createSqlRunner(client, { onStatus: () => renderMast() });
const LARGE_FILE_BYTES = 1024 * 1024 * 1024;
const DUCK_PREVIEW_ROWS = 1_000_000;
const duckFiles = new Map();

function engineLabel() {
  const st = duck.duckStatus();
  const base = client.mode === 'worker' ? 'Worker engine' : 'Inline engine';
  return st === 'ready' ? `${base} + DuckDB` : st === 'loading' ? `${base} · loading DuckDB` : base;
}
const ui = {
  result: null, selection: { columns: [] }, selectedStep: null, rightMode: null, profileColumn: null,
  showQuality: prefs.get('quality', true), evalToken: 0, diag: [], inputFields: [], search: '',
};
let grid = null;
const ACCEPT = '.csv,.tsv,.txt,.json,.jsonl,.ndjson,.xlsx,.xls,.xlsm,.ods,.parquet';

function formatOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  if (ext === 'json') return 'json';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (['xlsx', 'xls', 'xlsm', 'ods'].includes(ext)) return 'excel';
  if (ext === 'parquet') return 'parquet';
  return 'csv';
}

async function loadFileIntoEngine(file, sourceId, options = {}) {
  const format = formatOf(file.name);
  const buffer = await file.arrayBuffer();
  if (format === 'excel') {
    let sheet = options.sheet;
    if (!sheet) {
      const { sheets } = await xlsx.call('sheets', { buffer: buffer.slice(0) });
      sheet = sheets.length > 1 ? await chooseSheet(file.name, sheets) : sheets[0];
      if (!sheet) return null;
    }
    const r = await xlsx.call('read', { buffer, sheet, options });
    const args = { id: sourceId, name: file.name, format, names: r.names, columns: r.columns, types: r.types, options };
    client.remember('loadColumns', args);
    const info = await client.call('loadColumns', args, { label: `Reading ${file.name}` });
    return { ...info, options: { ...options, sheet } };
  }
  if (format === 'parquet') {
    const args = { id: sourceId, name: file.name, buffer, options };
    client.remember('loadParquet', args);
    return { ...(await client.call('loadParquet', args, { label: `Reading ${file.name}` })), options };
  }
  const args = { id: sourceId, name: file.name, format, buffer, options };
  client.remember('loadText', args);
  return { ...(await client.call('loadText', args, { label: `Reading ${file.name}` })), options };
}

function chooseSheet(name, sheets) {
  return new Promise((resolve) => {
    let out = null;
    const sel = el('select', { class: 'input' }, sheets.map(s => el('option', { value: s }, s)));
    const m = modal({ title: `Which sheet of ${name}?`, width: 420, body: [sel], footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => m.close(null) }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onclick: () => { out = sel.value; m.close(out); } }, 'Import sheet')], onClose: () => resolve(out) });
  });
}

async function importLargeViaDuck(file, { asNewProject }) {
  const format = formatOf(file.name);
  if (format === 'excel') throw new Error('Excel files over 1 GB are not supported. Save the sheet as CSV or Parquet first.');
  const table = duck.tableNameFor(file.name.replace(/\.[^.]+$/, ''), new Set([...duckFiles.values()].map(d => d.table)));
  const fname = `${table}.${format === 'parquet' ? 'parquet' : format === 'jsonl' ? 'jsonl' : format === 'json' ? 'json' : 'csv'}`;
  await duck.registerFile(fname, file);
  const srcSql = `SELECT * FROM ${duck.readerFor(fname, format)}`;
  const sid = uid('d');
  duckFiles.set(sid, { table, fname, file });
  const qname = uniqueName(file.name.replace(/\.[^.]+$/, ''), store.state.queries.map(q => q.name), ' ');
  const q = newQuery(qname, { kind: 'duck', sourceId: sid, table, sql: srcSql, limit: DUCK_PREVIEW_ROWS });
  const src = { id: sid, name: file.name, format, options: { duck: true }, rowCount: null, size: file.size, fields: [], duck: true };
  store.commit(`Import ${file.name}`, (s) => {
    if (asNewProject) { s.queries = []; s.sources = []; s.projectName = qname; }
    s.sources.push(src); s.queries.push(q); s.activeQueryId = q.id;
  });
  toast(`${file.name} opened with DuckDB`, { kind: 'success' });
}

async function importFiles(files, { asNewProject = false, options, viaDuck = false } = {}) {
  const done = [];
  for (const file of files) {
    try {
      if (viaDuck || file.size > LARGE_FILE_BYTES) {
        if (!viaDuck && !(await confirmDialog(`${file.name} is ${fmtBytes(file.size)}. Files this large open with DuckDB, downloaded once from cdn.jsdelivr.net. The first ${DUCK_PREVIEW_ROWS.toLocaleString()} rows are loaded for steps; exports can run over the whole file.`, { title: 'Open with DuckDB', ok: 'Open' }))) continue;
        await importLargeViaDuck(file, { asNewProject });
        asNewProject = false;
        continue;
      }
      const sid = uid('f');
      const info = await loadFileIntoEngine(file, sid, options || {});
      if (!info) continue;
      persist.putFile(sid, file);
      const src = { id: sid, name: file.name, format: info.format, options: info.options || {}, rowCount: info.rowCount, size: file.size, fields: info.fields };
      const qname = uniqueName(file.name.replace(/\.[^.]+$/, ''), store.state.queries.map(q => q.name), ' ');
      const q = newQuery(qname, { kind: 'file', sourceId: sid });
      store.commit(`Import ${file.name}`, (s) => {
        if (asNewProject) { s.queries = []; s.sources = []; s.projectName = qname; }
        s.sources.push(src); s.queries.push(q); s.activeQueryId = q.id;
      });
      asNewProject = false;
      done.push(`${file.name}: ${fmtCount(info.rowCount)} rows`);
    } catch (e) {
      toast(`Couldn’t read ${file.name}: ${e.message}`, { kind: 'error' });
    }
  }
  if (done.length === 1) toast(done[0], { kind: 'success' });
  else if (done.length > 1) toast(`${done.length} files imported`, { kind: 'success' });
  if (store.state.queries.length) showWorkbench();
}

async function importWithOptions(asNewProject) {
  const [file] = await pickFiles({ accept: ACCEPT });
  if (!file) return;
  const format = formatOf(file.name);
  const opts = { delimiter: 'auto', header: true, skipRows: 0, detectTypes: true, encoding: 'auto' };
  const body = [];
  const row = (label, ctrl) => el('label', { class: 'f-row' }, el('span', { class: 'f-label' }, label), ctrl);
  if (format === 'csv' || format === 'tsv') {
    const d = el('select', { class: 'input', onchange: (e) => { opts.delimiter = e.target.value; } }, [['auto', 'Detect automatically'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['\\t', 'Tab'], ['|', 'Pipe |']].map(([v, l]) => el('option', { value: v }, l)));
    const enc = el('select', { class: 'input', onchange: (e) => { opts.encoding = e.target.value; } }, [['auto', 'Detect (UTF-8 / UTF-16 / Windows-1252)'], ['utf-8', 'UTF-8'], ['windows-1252', 'Windows-1252'], ['iso-8859-1', 'ISO-8859-1'], ['utf-16le', 'UTF-16 LE']].map(([v, l]) => el('option', { value: v }, l)));
    body.push(row('Delimiter', d), row('Encoding', enc));
  }
  if (format !== 'parquet' && format !== 'json' && format !== 'jsonl') {
    body.push(row('Skip rows before the header', el('input', { class: 'input', type: 'number', min: '0', value: '0', oninput: (e) => { opts.skipRows = Number(e.target.value) || 0; } })));
    body.push(el('label', { class: 'f-toggle' }, el('input', { type: 'checkbox', checked: true, onchange: (e) => { opts.header = e.target.checked; } }), el('span', { class: 'toggle-ui' }), el('span', {}, 'First row contains column names')));
  }
  body.push(el('label', { class: 'f-toggle' }, el('input', { type: 'checkbox', checked: true, onchange: (e) => { opts.detectTypes = e.target.checked; } }), el('span', { class: 'toggle-ui' }), el('span', {}, 'Detect column types')));
  let viaDuck = false;
  if (format !== 'excel') body.push(el('label', { class: 'f-toggle' }, el('input', { type: 'checkbox', onchange: (e) => { viaDuck = e.target.checked; } }), el('span', { class: 'toggle-ui' }), el('span', {}, 'Open with DuckDB (for very large files; delimiter and type options are detected by DuckDB)')));
  const m = modal({ title: `Import ${file.name}`, icon: 'file', body: el('div', { class: 'form' }, body), footer: [
    el('span', { class: 'f-help' }, fmtBytes(file.size)), el('span', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
    el('button', { class: 'btn btn-primary', onclick: () => { m.close(); importFiles([file], { asNewProject, options: opts, viaDuck }); } }, 'Import')] });
}

async function loadSample() {
  const a = new File([SAMPLE_SALES_CSV], 'sample_sales.csv', { type: 'text/csv' });
  const b = new File([SAMPLE_REGIONS_CSV], 'regions.csv', { type: 'text/csv' });
  await importFiles([a, b], { asNewProject: true });
  const first = store.state.queries[0];
  if (first) store.quiet((s) => { s.activeQueryId = first.id; s.projectName = 'Sample sales'; }, 'change');
}

function renderImport() {
  const screen = $('#importScreen');
  clear(screen);
  const drop = el('label', { class: 'drop-zone', tabindex: '0', id: 'dropZone' },
    icon('upload', 26),
    el('p', { class: 'drop-title' }, 'Drop files or click to browse'),
    el('p', { class: 'drop-hint' }, 'CSV, TSV, Excel, JSON, JSONL, Parquet'));
  drop.addEventListener('click', async (e) => { e.preventDefault(); const files = await pickFiles({ accept: ACCEPT, multiple: true }); if (files.length) importFiles(files, { asNewProject: true }); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); } });
  const resume = el('div', { class: 'resume-slot' });
  const action = (ic, label, hint, fn, id) => el('button', { class: 'import-action', onclick: fn, id: id || null }, icon(ic, 16), el('span', { class: 'ia-text' }, el('span', { class: 'ia-label' }, label), el('span', { class: 'ia-hint' }, hint)));
  screen.append(el('div', { class: 'import-panel' },
    el('div', { class: 'import-head' }, el('h2', { class: 'import-title' }, 'New project'), el('div', { class: 'import-sub' }, 'Files are processed in this tab and are not uploaded.')),
    resume, drop,
    el('div', { class: 'import-actions' },
      action('table', 'Sample data', 'Sales orders and regions', loadSample, 'sampleBtn'),
      action('settings', 'Import with options', 'Delimiter, encoding, header', () => importWithOptions(true)),
      action('clipboard', 'Open recipe', '.duckbench.json', loadRecipeFile),
      action('layers', 'Batch apply', 'One recipe, many files', openBatch),
      action('play', 'Tour', 'Walk through the workbench', () => startTour({ force: true }))),
    el('div', { class: 'import-foot' }, el('span', {}, `Duckbench 2 · ${engineLabel()}`), el('a', { href: 'tests.html' }, 'Self-test'))));
  persist.getSession().then((sess) => {
    if (!sess?.json) return;
    let data; try { data = JSON.parse(sess.json); } catch { return; }
    if (!data.queries?.length) return;
    resume.appendChild(el('div', { class: 'resume-card' },
      icon('database', 18),
      el('div', { class: 'resume-text' }, el('strong', {}, data.projectName || 'Previous session'), el('span', {}, `${data.queries.length} quer${data.queries.length === 1 ? 'y' : 'ies'} · ${data.queries.reduce((n, q) => n + q.steps.length, 0)} steps · saved ${fmtAgo(sess.at)}`)),
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => resumeSession(data) }, 'Resume'),
      el('button', { class: 'icon-btn', title: 'Forget this session', onclick: async () => { await persist.clearSession(); await persist.clearFiles(); resume.remove(); } }, icon('x', 14))));
  });
}

async function resumeSession(data) {
  const missing = [];
  for (const s of data.sources || []) {
    if (s.duck) { s.missing = true; missing.push(s.name); continue; }
    const blob = await persist.getFile(s.id);
    if (!blob) { s.missing = true; missing.push(s.name); continue; }
    try {
      const file = blob instanceof File ? blob : new File([blob], s.name);
      const info = await loadFileIntoEngine(file, s.id, s.options || {});
      Object.assign(s, { rowCount: info.rowCount, fields: info.fields, missing: false });
    } catch (e) { s.missing = true; missing.push(s.name); }
  }
  store.load(JSON.stringify(data));
  showWorkbench();
  if (missing.length) toast(`Reconnect ${missing.join(', ')} — use “Locate file…” on the query.`, { kind: 'error' });
}

function showWorkbench() {
  $('#importScreen').hidden = true;
  $('#workbench').hidden = false;
  if (!grid) {
    grid = new Grid($('#gridHost'), gridHandlers);
    grid.setQualityVisible(ui.showQuality);
  }
  renderAll();
  refresh();
  resumePendingTour();
  if (!prefs.get('tourDone', false)) maybeAutoTour();
}

function showImport() {
  $('#workbench').hidden = true;
  $('#importScreen').hidden = false;
  renderImport();
  renderMast();
}

function queryName(id) { return store.query(id)?.name || 'missing query'; }

function enginePayload() {
  return store.state.queries.map(q => ({ id: q.id, name: q.name, source: q.source, steps: q.steps.map(s => ({ id: s.id, type: s.type, data: s.data, disabled: s.disabled, unsupported: s.unsupported })) }));
}

const refresh = debounce(async () => {
  const q = store.activeQuery();
  if (!q) return;
  const token = ++ui.evalToken;
  const cursor = store.cursor();
  try {
    const payload = { queries: enginePayload() };
    client.remember('setQueries', payload);
    await client.call('setQueries', payload, { track: false });
    const res = await sql.evaluate({ queryId: q.id, stepIndex: cursor, pageSize: 200 }, { label: 'Running steps' });
    if (token !== ui.evalToken) return;
    ui.diag = res.diag || [];
    if (res.error) {
      ui.result = null;
      showGridMessage(res.sourceError ? 'Source unavailable' : `Step ${res.errorIndex + 1} failed`, res.error, res.sourceError ? { label: 'Locate file…', fn: () => locateSource(q) } : null);
      renderSteps(); renderStatus();
      return;
    }
    ui.result = res;
    $('#gridEmpty').hidden = true;
    $('#gridHost').hidden = false;
    grid.setData({ resultId: res.resultId, fields: res.fields, rowCount: res.rowCount, firstPage: res.page, quality: res.quality, changed: res.changed });
    grid.setHints(hintsFor(q, cursor));
    const banner = $('#gridBanner');
    clear(banner);
    const vd = ui.diag[cursor];
    const msgs = [];
    if (res.viewError) msgs.push(['error', `Step ${res.viewError.index + 1}: ${res.viewError.message}`]);
    if (vd?.warn?.length) vd.warn.forEach(w => msgs.push(['warn', w]));
    if (vd?.info?.length) vd.info.forEach(w => msgs.push(['info', w]));
    if (res.sourceNote) msgs.push(['info', res.sourceNote]);
    if (cursor < q.steps.length - 1) msgs.push(['info', `Showing step ${cursor + 1} of ${q.steps.length}.`]);
    banner.hidden = !msgs.length;
    for (const [k, m] of msgs.slice(0, 4)) banner.appendChild(el('div', { class: `banner-line banner-${k}` }, icon(k === 'error' ? 'warn' : k === 'warn' ? 'warn' : 'info', 14), el('span', {}, m)));
    if (cursor < q.steps.length - 1) banner.appendChild(el('button', { class: 'btn btn-ghost btn-xs', onclick: () => setCursor(q.steps.length - 1) }, 'Jump to last step'));
    renderSteps(); renderStatus(); renderToolbar();
    if (ui.rightMode === 'profile' && ui.profileColumn) renderProfile(ui.profileColumn);
  } catch (e) {
    if (e.cancelled || token !== ui.evalToken) return;
    ui.result = null;
    showGridMessage('The preview could not be computed', e.message);
    renderSteps(); renderStatus();
  }
}, 60);

function hintsFor(q, cursor) {
  const sort = [], filter = [];
  q.steps.slice(0, cursor + 1).forEach(s => {
    if (s.disabled) return;
    if (s.type === 'sort') { sort.length = 0; (s.data.keys || []).forEach(k => sort.push([k.column, k.direction])); }
    if (s.type === 'filter') { if (s.data.mode === 'values') filter.push(s.data.column); (s.data.rules || []).forEach(r => filter.push(r.column)); }
  });
  return { sort, filter };
}

function showGridMessage(title, message, action) {
  $('#gridHost').hidden = true;
  const box = $('#gridEmpty');
  box.hidden = false;
  clear(box).append(icon('warn', 28), el('h3', {}, title), el('p', {}, message), action ? el('button', { class: 'btn btn-primary', onclick: action.fn }, action.label) : null);
  $('#gridBanner').hidden = true;
}

async function locateSource(q) {
  const src = store.source(q.source?.sourceId);
  const [file] = await pickFiles({ accept: ACCEPT });
  if (!file) return;
  if (q.source?.kind === 'duck') {
    try {
      const d = duckFiles.get(q.source.sourceId) || { table: q.source.table, fname: q.source.sql.match(/'([^']+)'/)?.[1] };
      await duck.registerFile(d.fname, file);
      duckFiles.set(q.source.sourceId, { ...d, file });
      await client.call('invalidate');
      store.commit('Reconnect file', (s) => { const x = s.sources.find(y => y.id === q.source.sourceId); if (x) { x.missing = false; x.size = file.size; } });
      refresh();
    } catch (e) { toast(`Couldn’t open ${file.name}: ${e.message}`, { kind: 'error' }); }
    return;
  }
  try {
    const sid = src?.id || uid('f');
    const info = await loadFileIntoEngine(file, sid, src?.options || {});
    persist.putFile(sid, file);
    store.commit('Reconnect file', (s) => {
      const existing = s.sources.find(x => x.id === sid);
      const meta = { id: sid, name: file.name, format: info.format, options: info.options || {}, rowCount: info.rowCount, size: file.size, fields: info.fields, missing: false };
      if (existing) Object.assign(existing, meta); else s.sources.push(meta);
      const qq = s.queries.find(x => x.id === q.id);
      qq.source = { kind: 'file', sourceId: sid };
    });
    toast(`Reconnected ${file.name}`, { kind: 'success' });
  } catch (e) { toast(`Couldn’t read ${file.name}: ${e.message}`, { kind: 'error' }); }
}

function setCursor(i) {
  const q = store.activeQuery();
  store.quiet((s) => { s.stepCursor[q.id] = i; }, 'cursor');
  ui.selectedStep = i >= 0 ? q.steps[i]?.id : null;
  if (ui.selectedStep && ui.rightMode !== 'profile') openInspector(ui.selectedStep);
  else if (!ui.selectedStep && ui.rightMode === 'inspector') closeRight();
  renderSteps();
  refresh();
}

function addStep(type, seed = {}, { open = true, label } = {}) {
  const q = store.activeQuery();
  if (!q) return;
  const t = TRANSFORMS[type];
  const fields = ui.result?.fields || [];
  const sel = ui.selection;
  const ctx = { columns: fields.map(f => f.name), firstColumn: sel.columns?.[0] || fields[0]?.name || '', selection: sel.columns?.length ? sel.columns : null };
  const seeded = { ...(t.seed ? t.seed({ column: sel.columns?.[0], columns: sel.columns }, undefined) : {}), ...seed };
  for (const k of Object.keys(seeded)) if (seeded[k] === undefined) delete seeded[k];
  const data = defaultsFor(type, ctx, seeded);
  const step = newStep(type, data);
  const at = store.cursor() + 1;
  store.commit(label || `Add ${t.label}`, (s) => {
    const qq = s.queries.find(x => x.id === q.id);
    qq.steps.splice(at, 0, step);
    s.stepCursor[q.id] = at;
  });
  ui.selectedStep = step.id;
  if (open) openInspector(step.id); else renderSteps();
}

function updateStep(stepId, mutate, label = 'Edit step') {
  const q = store.activeQuery();
  store.commit(label, (s) => {
    const st = s.queries.find(x => x.id === q.id).steps.find(x => x.id === stepId);
    if (st) mutate(st);
  });
}

function deleteStep(stepId) {
  const q = store.activeQuery();
  const i = q.steps.findIndex(s => s.id === stepId);
  if (i < 0) return;
  const label = TRANSFORMS[q.steps[i].type]?.label || q.steps[i].type;
  store.commit(`Delete ${label}`, (s) => {
    const qq = s.queries.find(x => x.id === q.id);
    const cur = s.stepCursor[q.id];
    qq.steps.splice(i, 1);
    if (cur == null) return;
    const next = cur >= i ? cur - 1 : cur;
    if (next >= qq.steps.length - 1) delete s.stepCursor[q.id];
    else s.stepCursor[q.id] = Math.max(-1, next);
  });
  if (ui.selectedStep === stepId) { ui.selectedStep = null; closeRight(); }
  toast(`Deleted ${label}`, { action: 'Undo', onAction: () => store.undo() });
}

function moveStep(stepId, delta) {
  const q = store.activeQuery();
  const i = q.steps.findIndex(s => s.id === stepId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= q.steps.length) return;
  store.commit('Move step', (s) => { const st = s.queries.find(x => x.id === q.id).steps; [st[i], st[j]] = [st[j], st[i]]; });
}

function renderAll() { renderMast(); renderRibbon(); renderQueries(); renderSteps(); renderToolbar(); renderStatus(); }

function renderMast() {
  $('#brandMark').innerHTML = LOGO;
  const pn = $('#projectName');
  pn.textContent = store.state.projectName;
  pn.onclick = async () => { const v = await promptDialog('Project name', { value: store.state.projectName }); if (v) store.commit('Rename project', (s) => { s.projectName = v; }); };
  const nav = clear($('#mastActions'));
  const inBench = !$('#workbench').hidden;
  const btn = (ic, title, fn, opts = {}) => el('button', { class: `icon-btn${opts.cls ? ' ' + opts.cls : ''}`, title, 'aria-label': title, disabled: opts.disabled, onclick: fn }, icon(ic, 17));
  if (inBench) {
    nav.append(
      btn('undo', `Undo ${store.undoLabel()} (${kbd('⌘Z')})`, () => doUndo(), { disabled: !store.canUndo() }),
      btn('redo', `Redo ${store.redoLabel()} (${kbd('⌘⇧Z')})`, () => doRedo(), { disabled: !store.canRedo() }),
      el('span', { class: 'mast-sep' }),
      el('button', { class: 'btn btn-ghost btn-sm palette-btn', id: 'paletteBtn', onclick: openPalette, title: 'Command palette' }, icon('search', 14), el('span', {}, 'Actions'), el('kbd', {}, kbd('⌘K'))),
      btn('save', `Save recipe (${kbd('⌘S')})`, saveRecipe),
      btn('clipboard', 'Open recipe', loadRecipeFile),
      el('button', { class: 'btn btn-primary btn-sm', id: 'exportBtn', onclick: (e) => openExportMenu(e.currentTarget) }, icon('download', 14), 'Export'),
      el('span', { class: 'mast-sep' }));
  }
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  nav.append(
    btn(light ? 'moon' : 'sun', 'Toggle light / dark', toggleTheme),
    btn('keyboard', 'Keyboard shortcuts (?)', openHelp),
    inBench ? btn('help', 'Tour', () => startTour({ force: true })) : null,
    inBench ? btn('x', 'Close project', closeProject) : null,
    el('span', { class: 'engine-pill', title: `DuckDB ${duck.duckVersion()} loads on first SQL step or large file` }, el('span', { class: 'dot' }), engineLabel()));
}

function toggleTheme() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  if (light) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', 'light');
  prefs.set('theme', light ? 'dark' : 'light');
  renderMast();
}

async function closeProject() {
  if (!(await confirmDialog('The session stays saved in this browser and can be resumed.', { title: 'Close project', ok: 'Close' }))) return;
  await saveSessionNow();
  store.load(JSON.stringify({ queries: [], sources: [], activeQueryId: null, projectName: 'Untitled project', stepCursor: {} }));
  ui.result = null; closeRight();
  showImport();
}

function renderRibbon() {
  const host = clear($('#ribbon'));
  const active = prefs.get('ribbonTab', 'home');
  const tabs = el('div', { class: 'ribbon-tabs', role: 'tablist', id: 'ribbonTabs' }, RIBBON_TABS.map(t => el('button', { class: `ribbon-tab${t.id === active ? ' is-on' : ''}`, role: 'tab', 'aria-selected': String(t.id === active), onclick: () => { prefs.set('ribbonTab', t.id); renderRibbon(); } }, t.label)));
  const groups = el('div', { class: 'ribbon-groups' });
  if (active === 'view') {
    const g = (title, ...btns) => el('div', { class: 'ribbon-group' }, el('div', { class: 'rg-items' }, btns), el('div', { class: 'rg-title' }, title));
    const b = (ic, label, fn, on) => el('button', { class: `rb rb-large${on ? ' is-on' : ''}`, onclick: fn }, icon(ic, 20), el('span', {}, label));
    groups.append(
      g('Grid', b('chart', 'Column quality', () => { ui.showQuality = !ui.showQuality; prefs.set('quality', ui.showQuality); grid?.setQualityVisible(ui.showQuality); renderRibbon(); }, ui.showQuality), b('table', 'Reset widths', () => { grid?.clearWidths(); refresh(); })),
      g('Panels', b('panel-right', 'Column profile', () => { const c = ui.selection.columns?.[0] || ui.result?.fields[0]?.name; if (c) openProfile(c); }, ui.rightMode === 'profile')),
      g('Engine', b('stop', 'Clear cache', async () => { await client.call('invalidate'); refresh(); toast('Step cache cleared'); }), b('database', duck.duckStatus() === 'ready' ? 'DuckDB ready' : 'Load DuckDB', async () => { try { renderMast(); await duck.ensureDuck(); toast(`DuckDB ${duck.duckVersion()} ready`, { kind: 'success' }); } catch (e) { toast(e.message, { kind: 'error' }); } renderMast(); renderRibbon(); }, duck.duckStatus() === 'ready')));
  } else {
    const byGroup = new Map();
    for (const t of transformCatalog()) {
      if (t.ribbon?.tab !== active) continue;
      if (!byGroup.has(t.ribbon.group)) byGroup.set(t.ribbon.group, []);
      byGroup.get(t.ribbon.group).push(t);
    }
    for (const [name, items] of byGroup) {
      const large = items.filter(t => t.ribbon.size === 'large');
      const small = items.filter(t => t.ribbon.size !== 'large');
      const col = el('div', { class: 'rg-small' }, small.map(t => el('button', { class: 'rb rb-small', title: t.label, onclick: () => addStep(t.type) }, icon(t.icon, 14), el('span', {}, t.label))));
      groups.appendChild(el('div', { class: 'ribbon-group' }, el('div', { class: 'rg-items' }, large.map(t => el('button', { class: 'rb rb-large', title: t.label, onclick: () => addStep(t.type) }, icon(t.icon, 20), el('span', {}, t.label))), small.length ? col : null), el('div', { class: 'rg-title' }, name)));
    }
  }
  host.append(tabs, groups);
}

function renderQueries() {
  const host = clear($('#queriesPanel'));
  host.appendChild(el('div', { class: 'panel-head' }, el('h2', {}, 'Queries'), el('button', { class: 'icon-btn icon-btn-sm', title: 'Import another file as a new query', onclick: async () => { const f = await pickFiles({ accept: ACCEPT, multiple: true }); if (f.length) importFiles(f); } }, icon('plus', 15))));
  const list = el('ul', { class: 'query-list', role: 'listbox', 'aria-label': 'Queries' });
  for (const q of store.state.queries) {
    const src = q.source?.kind === 'file' || q.source?.kind === 'duck' ? store.source(q.source.sourceId) : null;
    const on = q.id === store.state.activeQueryId;
    const meta = q.source?.kind === 'reference' ? `→ ${queryName(q.source.parentId)}` : src ? `${src.missing ? 'file missing · ' : ''}${src.duck ? `DuckDB · ${fmtBytes(src.size)}` : `${fmtCount(src.rowCount)} rows`}` : '';
    const li = el('li', { class: `query-item${on ? ' is-on' : ''}${src?.missing ? ' is-missing' : ''}`, role: 'option', 'aria-selected': String(on), tabindex: '0' },
      icon(q.source?.kind === 'reference' ? 'ref' : 'table', 15),
      el('span', { class: 'qi-text' }, el('span', { class: 'qi-name' }, q.name), el('span', { class: 'qi-meta' }, `${meta} · ${q.steps.length} step${q.steps.length === 1 ? '' : 's'}`)),
      el('button', { class: 'icon-btn icon-btn-xs qi-more', 'aria-label': `Actions for ${q.name}`, onclick: (e) => { e.stopPropagation(); queryMenu(q, e.currentTarget); } }, icon('more', 14)));
    li.addEventListener('click', () => activateQuery(q.id));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') activateQuery(q.id); });
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); queryMenu(q, li, { x: e.clientX, y: e.clientY }); });
    list.appendChild(li);
  }
  host.appendChild(list);
}

function activateQuery(id) {
  if (store.state.activeQueryId === id) return;
  store.quiet((s) => { s.activeQueryId = id; }, 'change');
  ui.selectedStep = null; ui.selection = { columns: [] }; closeRight();
}

function queryMenu(q, anchor, pos = {}) {
  const src = q.source?.kind === 'file' || q.source?.kind === 'duck' ? store.source(q.source.sourceId) : null;
  menu(anchor, [
    { label: 'Rename…', icon: 'edit', onClick: async () => { const v = await promptDialog('Rename query', { value: q.name, validate: (v) => (!v ? 'Enter a name.' : store.state.queries.some(x => x.name === v && x.id !== q.id) ? 'Another query has that name.' : null) }); if (v) store.commit('Rename query', (s) => { s.queries.find(x => x.id === q.id).name = v; }); } },
    { label: 'Duplicate', icon: 'copy', onClick: () => { const c = newQuery(uniqueName(`${q.name} (copy)`, store.state.queries.map(x => x.name), ' '), { ...q.source }, q.steps.map(s => ({ ...JSON.parse(JSON.stringify(s)), id: uid('s') }))); store.commit('Duplicate query', (s) => { s.queries.push(c); s.activeQueryId = c.id; }); } },
    { label: 'Reference (start a new query from its output)', icon: 'ref', onClick: () => { const c = newQuery(uniqueName(`${q.name} (ref)`, store.state.queries.map(x => x.name), ' '), { kind: 'reference', parentId: q.id }); store.commit('Reference query', (s) => { s.queries.push(c); s.activeQueryId = c.id; }); } },
    src ? { label: src.missing ? 'Locate file…' : 'Replace data file, keep steps…', icon: 'file', onClick: () => locateSource(q) } : null,
    '-',
    { label: 'Delete query', icon: 'trash', danger: true, disabled: store.state.queries.length <= 1, onClick: async () => {
      const users = store.state.queries.filter(x => x.id !== q.id && (x.source?.parentId === q.id || x.steps.some(s => (s.data?.rightSource === q.id) || (s.data?.sources || []).includes(q.id))));
      if (users.length && !(await confirmDialog(`${users.map(u => u.name).join(', ')} use${users.length === 1 ? 's' : ''} this query and will break. Delete anyway?`, { danger: true, ok: 'Delete' }))) return;
      store.commit('Delete query', (s) => { s.queries = s.queries.filter(x => x.id !== q.id); if (s.activeQueryId === q.id) s.activeQueryId = s.queries[0]?.id; });
      toast(`Deleted query “${q.name}”`, { action: 'Undo', onAction: () => store.undo() });
    } },
  ], pos);
}

function renderSteps() {
  const host = clear($('#stepsPanel'));
  const q = store.activeQuery();
  if (!q) return;
  const cursor = store.cursor();
  host.appendChild(el('div', { class: 'panel-head' }, el('h2', {}, 'Applied steps'), el('span', { class: 'panel-count' }, String(q.steps.length))));
  host.appendChild(el('button', { class: 'btn btn-primary btn-block add-step-btn', id: 'addStepBtn', onclick: openPalette }, icon('plus', 15), 'Add step', el('kbd', {}, kbd('⌘K'))));
  const list = el('ol', { class: 'step-list', id: 'stepList' });
  const src = q.source?.kind === 'file' || q.source?.kind === 'duck' ? store.source(q.source.sourceId) : null;
  const srcItem = el('li', { class: `step-item step-source${cursor === -1 ? ' is-cursor' : ''}`, tabindex: '0', onclick: () => setCursor(-1) },
    el('span', { class: 'step-code' }, 'SRC'),
    el('span', { class: 'step-text' }, el('span', { class: 'step-name' }, q.source?.kind === 'reference' ? `From ${queryName(q.source.parentId)}` : src?.name || 'Source'), el('span', { class: 'step-sum' }, src ? `${src.duck ? 'DuckDB · ' : ''}${src.format}${src.options?.sheet ? ` · ${src.options.sheet}` : ''}${src.size ? ` · ${fmtBytes(src.size)}` : ''}` : '')));
  list.appendChild(srcItem);
  q.steps.forEach((s, i) => {
    const t = TRANSFORMS[s.type];
    const d = ui.diag[i] || {};
    const status = d.error ? 'error' : d.blocked ? 'blocked' : d.warn?.length ? 'warn' : '';
    const delta = d.rows != null && d.prevRows != null && d.rows !== d.prevRows ? `${d.rows > d.prevRows ? '+' : '−'}${fmtCount(Math.abs(d.rows - d.prevRows))} rows` : '';
    const li = el('li', { class: `step-item${i === cursor ? ' is-cursor' : ''}${i > cursor ? ' is-after' : ''}${s.disabled ? ' is-disabled' : ''}${status ? ` is-${status}` : ''}${s.id === ui.selectedStep ? ' is-selected' : ''}`, tabindex: '0', draggable: 'true', dataset: { i: String(i) }, title: d.error || (d.warn || []).join('\n') || '' },
      el('span', { class: 'step-code' }, t?.code || '??'),
      el('span', { class: 'step-text' },
        el('span', { class: 'step-name' }, s.name || t?.label || s.type),
        el('span', { class: 'step-sum' }, d.error ? d.error : stepSummary(s, { queryName }))),
      el('span', { class: 'step-meta' }, d.cached ? el('span', { class: 'step-cached', title: 'Served from cache' }, '●') : null, delta ? el('span', { class: 'step-delta' }, delta) : null, d.ms != null && !d.cached ? el('span', { class: 'step-ms' }, fmtMs(d.ms)) : null),
      el('button', { class: 'icon-btn icon-btn-xs step-more', 'aria-label': 'Step actions', onclick: (e) => { e.stopPropagation(); stepMenu(s, i, e.currentTarget); } }, icon('more', 14)));
    li.addEventListener('click', () => { ui.selectedStep = s.id; ui.rightMode = 'inspector'; setCursor(i); });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteStep(s.id); }
      if (e.key === 'F2') { e.preventDefault(); renameStep(s); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const j = i + (e.key === 'ArrowDown' ? 1 : -1);
        if (j < -1 || j >= q.steps.length) return;
        if (j >= 0) ui.selectedStep = q.steps[j].id;
        setCursor(j);
        requestAnimationFrame(() => $(`#stepList > li:nth-child(${j + 2})`)?.focus());
      }
    });
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); stepMenu(s, i, li, { x: e.clientX, y: e.clientY }); });
    li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-step', String(i)); li.classList.add('is-drag'); });
    li.addEventListener('dragend', () => li.classList.remove('is-drag'));
    li.addEventListener('dragover', (e) => { if (!e.dataTransfer.types.includes('text/x-step')) return; e.preventDefault(); li.classList.add('is-drop'); });
    li.addEventListener('dragleave', () => li.classList.remove('is-drop'));
    li.addEventListener('drop', (e) => {
      e.preventDefault(); li.classList.remove('is-drop');
      const from = Number(e.dataTransfer.getData('text/x-step'));
      if (Number.isNaN(from) || from === i) return;
      store.commit('Reorder steps', (st) => { const arr = st.queries.find(x => x.id === q.id).steps; const [x] = arr.splice(from, 1); arr.splice(i, 0, x); });
    });
    list.appendChild(li);
  });
  host.appendChild(list);
  if (!q.steps.length) host.appendChild(el('p', { class: 'panel-empty' }, 'No steps yet.'));
}

async function renameStep(s) {
  const v = await promptDialog('Step name', { value: s.name || TRANSFORMS[s.type]?.label || '', validate: () => null });
  if (v != null) updateStep(s.id, (x) => { x.name = v; }, 'Rename step');
}

function stepMenu(s, i, anchor, pos = {}) {
  const q = store.activeQuery();
  menu(anchor, [
    { label: 'Edit settings', icon: 'settings', onClick: () => { ui.selectedStep = s.id; setCursor(i); openInspector(s.id); } },
    { label: 'Rename…', icon: 'edit', hint: 'F2', onClick: () => renameStep(s) },
    { label: s.disabled ? 'Enable step' : 'Disable step', icon: s.disabled ? 'eye' : 'eye-off', onClick: () => updateStep(s.id, (x) => { x.disabled = !x.disabled; }, s.disabled ? 'Enable step' : 'Disable step') },
    { label: 'Duplicate', icon: 'copy', onClick: () => store.commit('Duplicate step', (st) => { const arr = st.queries.find(x => x.id === q.id).steps; arr.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(s)), id: uid('s') }); }) },
    { label: 'Insert step after…', icon: 'plus', onClick: () => { setCursor(i); openPalette(); } },
    '-',
    { label: 'Move up', icon: 'chevron-left', disabled: i === 0, onClick: () => moveStep(s.id, -1) },
    { label: 'Move down', icon: 'chevron-right', disabled: i === q.steps.length - 1, onClick: () => moveStep(s.id, 1) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, hint: 'Del', onClick: () => deleteStep(s.id) },
    { label: 'Delete until end', icon: 'trash', danger: true, disabled: i === q.steps.length - 1, onClick: () => { store.commit('Delete steps', (st) => { st.queries.find(x => x.id === q.id).steps.splice(i); delete st.stepCursor[q.id]; }); toast('Steps deleted', { action: 'Undo', onAction: () => store.undo() }); } },
  ], pos);
}

function closeRight() { ui.rightMode = null; const r = $('#rightRail'); r.hidden = true; clear(r); }

async function openInspector(stepId) {
  const q = store.activeQuery();
  const idx = q.steps.findIndex(s => s.id === stepId);
  if (idx < 0) { closeRight(); return; }
  ui.rightMode = 'inspector';
  const rail = $('#rightRail');
  rail.hidden = false;
  const step = q.steps[idx];
  const t = TRANSFORMS[step.type];
  let input;
  try { input = await sql.evaluate({ queryId: q.id, stepIndex: idx - 1, pageSize: 0 }, { track: false }); } catch { input = {}; }
  if (ui.selectedStep !== stepId || ui.rightMode !== 'inspector') return;
  const fields = input.fields || [];
  let rightFields = [];
  const rightId = step.data?.rightSource;
  if (rightId) { try { rightFields = (await sql.queryColumns({ queryId: rightId })).fields || []; } catch {} }
  const data = JSON.parse(JSON.stringify(step.data || {}));
  const errBox = el('div', { class: 'insp-error', hidden: true });
  const showErr = () => { const d = ui.diag[idx]; errBox.hidden = !d?.error; errBox.textContent = d?.error || ''; };
  const commit = debounce((label) => { updateStep(stepId, (x) => { x.data = JSON.parse(JSON.stringify(data)); }, label); }, 260);
  const sqlTaken = new Set(['input']);
  const sqlTables = step.type === 'sql' ? (step.data?.tables || []).map(id => duck.tableNameFor(queryName(id), sqlTaken)) : [];
  const ctx = {
    fields, rightFields, sqlTables, queryId: q.id, queries: store.state.queries,
    loadDistinct: (column, search) => (input.resultId ? client.call('distinct', { resultId: input.resultId, column, search, limit: 500 }, { track: false }) : null),
    onAddQuery: async () => { const f = await pickFiles({ accept: ACCEPT }); if (f.length) { const keep = store.state.activeQueryId; await importFiles(f); store.quiet((s) => { s.activeQueryId = keep; }, 'change'); openInspector(stepId); } },
  };
  const form = buildForm(t?.params || [], data, ctx, (d, meta) => {
    commit(`Edit ${t.label}`);
    if (meta.key === 'rightSource' || (step.type === 'sql' && meta.key === 'tables')) setTimeout(() => openInspector(stepId), 320);
  });
  clear(rail).append(
    el('header', { class: 'rail-head' },
      el('span', { class: 'step-code' }, t?.code || '??'),
      el('div', { class: 'rail-title' }, el('h2', {}, step.name || t?.label || step.type), el('span', {}, `Step ${idx + 1} · input ${fmtCount(input.rowCount)} rows × ${fields.length} cols`)),
      el('button', { class: 'icon-btn', 'aria-label': 'Close inspector', onclick: () => { closeRight(); } }, icon('x', 16))),
    errBox,
    t ? el('div', { class: 'rail-body' }, form) : el('p', { class: 'panel-empty' }, `“${step.type}” isn't supported in Duckbench 2.`),
    el('footer', { class: 'rail-foot' },
      el('label', { class: 'f-row' }, el('span', { class: 'f-label' }, 'Note'), (() => { const ta = el('textarea', { class: 'input', rows: '2', placeholder: 'Why this step exists (saved in the recipe)' }); ta.value = step.note || ''; ta.addEventListener('change', () => updateStep(stepId, (x) => { x.note = ta.value; }, 'Edit note')); return ta; })()),
      el('div', { class: 'rail-actions' },
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => updateStep(stepId, (x) => { x.disabled = !x.disabled; }, 'Toggle step') }, step.disabled ? 'Enable' : 'Disable'),
        el('button', { class: 'btn btn-ghost btn-sm btn-danger-text', onclick: () => deleteStep(stepId) }, icon('trash', 14), 'Delete'),
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => { commit.cancel?.(); updateStep(stepId, (x) => { x.data = JSON.parse(JSON.stringify(data)); }, `Edit ${t?.label}`); closeRight(); } }, 'Done'))));
  showErr();
  ui.inspectorErr = showErr;
}

async function openProfile(column) {
  ui.rightMode = 'profile';
  ui.profileColumn = column;
  renderProfile(column);
}

async function renderProfile(column) {
  if (!ui.result) return;
  const rail = $('#rightRail');
  rail.hidden = false;
  const p = await client.call('profile', { resultId: ui.result.resultId, column }, { track: false });
  if (ui.rightMode !== 'profile' || p.expired) return;
  const pct = (n) => (p.rows ? `${Math.round((n / p.rows) * 1000) / 10}%` : '0%');
  const stat = (k, v) => el('div', { class: 'stat' }, el('span', {}, k), el('strong', {}, v));
  const fv = (v) => (v == null ? '—' : typeof v === 'number' ? formatValue(Math.round(v * 1e6) / 1e6, p.type) : String(v));
  const maxTop = Math.max(1, ...p.top.map(t => t.count));
  const hist = p.histogram ? el('div', { class: 'histogram', role: 'img', 'aria-label': 'Value distribution' }, (() => { const m = Math.max(...p.histogram.map(h => h.count)); return p.histogram.map(h => el('span', { class: 'hbar', style: { height: `${Math.max(2, (h.count / m) * 100)}%` }, title: `${fv(h.from)} – ${fv(h.to)}: ${h.count}` })); })()) : null;
  clear(rail).append(
    el('header', { class: 'rail-head' }, el('span', { class: `type-badge type-${p.type}` }, TYPE_LABELS[p.type]), el('div', { class: 'rail-title' }, el('h2', {}, column), el('span', {}, 'Column profile · all rows')), el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeRight }, icon('x', 16))),
    el('div', { class: 'rail-body' },
      el('div', { class: 'quality-bar' }, el('span', { class: 'gq-valid', style: { width: pct(p.valid) } }), el('span', { class: 'gq-empty', style: { width: pct(p.empty) } })),
      el('div', { class: 'stats' }, stat('Rows', fmtCount(p.rows)), stat('Filled', `${fmtCount(p.valid)} (${pct(p.valid)})`), stat('Empty', `${fmtCount(p.empty)} (${pct(p.empty)})`), stat('Distinct', fmtCount(p.distinct)), stat('Unique', fmtCount(p.unique)), p.whitespace ? stat('Untrimmed', fmtCount(p.whitespace)) : null),
      p.stats ? el('div', { class: 'stats' }, stat('Min', fv(p.stats.min)), stat('Max', fv(p.stats.max)), p.type !== 'date' && p.type !== 'datetime' ? [stat('Mean', fv(p.stats.mean)), stat('Median', fv(p.stats.median)), stat('Std dev', fv(p.stats.std)), stat('Sum', fv(p.stats.sum))] : null) : null,
      p.text ? el('div', { class: 'stats' }, stat('Shortest', `${p.text.minLen} chars`), stat('Longest', `${p.text.maxLen} chars`)) : null,
      hist,
      el('h3', { class: 'rail-sub' }, 'Most common values'),
      el('ul', { class: 'top-values' }, p.top.map(t => el('li', { onclick: () => addStep('filter', { mode: 'values', column, values: { include: true, list: [t.value] } }, { open: false, label: 'Filter to value' }), title: 'Click to keep only this value' }, el('span', { class: 'tv-bar', style: { width: `${(t.count / maxTop) * 100}%` } }), el('span', { class: 'tv-val' }, t.value === '' ? '“”' : t.value), el('span', { class: 'tv-count' }, fmtCount(t.count))))),
      p.whitespace ? el('button', { class: 'btn btn-ghost btn-sm', onclick: () => addStep('trim_clean', { columns: [column] }, { open: false }) }, icon('trim', 14), 'Trim this column') : null,
      p.empty ? el('button', { class: 'btn btn-ghost btn-sm', onclick: () => addStep('remove_blank_rows', { columns: [column], mode: 'any' }, { open: false }) }, icon('eraser', 14), 'Remove rows where empty') : null));
}

const gridHandlers = {
  fetchRows: (resultId, start, end) => client.call('rows', { resultId, start, end }, { track: false }),
  onSelection: (sel) => { ui.selection = sel; renderStatus(); if (ui.rightMode === 'profile' && sel.explicitColumns?.length === 1 && sel.explicitColumns[0] !== ui.profileColumn) openProfile(sel.explicitColumns[0]); },
  onHeaderMenu: ({ anchor, x, y, field }) => headerMenu(field, anchor || document.body, x != null ? { x, y } : {}),
  onHeaderRename: async ({ field }) => {
    const v = await promptDialog(`Rename “${field.name}”`, { value: field.name, validate: (v) => (!v ? 'Enter a name.' : v !== field.name && ui.result.fields.some(f => f.name === v) ? 'A column with that name exists.' : null) });
    if (v && v !== field.name) addStep('rename_columns', { mapping: { [field.name]: v } }, { open: false, label: 'Rename column' });
  },
  onCellMenu: ({ x, y, field, value, rid }) => cellMenu(field, value, rid, { x, y }),
  onRowMenu: ({ x, y, rids }) => menu(document.body, [
    { label: `Delete ${rids.length} row${rids.length === 1 ? '' : 's'}`, icon: 'trash', danger: true, disabled: !rids.length, onClick: () => deleteRows(rids) },
    { label: 'Keep rows above', icon: 'crop', onClick: () => {} , disabled: true },
  ], { x, y }),
  onDeleteRows: (rids) => deleteRows(rids),
  onCellEdit: ({ rid, column, value }) => {
    const q = store.activeQuery();
    const cursor = store.cursor();
    const last = q.steps[cursor];
    if (last && last.type === 'edit_cells' && !last.disabled) updateStep(last.id, (x) => { x.data.edits = [...(x.data.edits || []).filter(e => !(e.rid === rid && e.column === column)), { rid, column, value }]; }, 'Edit cell');
    else addStep('edit_cells', { edits: [{ rid, column, value }] }, { open: false, label: 'Edit cell' });
  },
  onEditBlocked: () => toast('Cells can only be edited before steps that regroup rows (group by, pivot, join…). Select an earlier step.', { kind: 'error' }),
  onCopied: (r, c) => toast(`Copied ${fmtCount(r)} × ${c} cells`),
};

function deleteRows(rids) {
  if (!rids.length) return;
  if (!ui.result?.hasRid) { gridHandlers.onEditBlocked(); return; }
  addStep('delete_rows', { rids }, { open: false, label: `Delete ${rids.length} rows` });
}

function headerMenu(field, anchor, pos) {
  const cols = ui.selection.explicitColumns?.length ? ui.selection.explicitColumns : [field.name];
  const many = cols.length > 1;
  const quick = (type, data, label) => addStep(type, data, { open: false, label });
  menu(anchor, [
    { header: many ? `${cols.length} columns` : field.name },
    { label: 'Sort ascending', icon: 'sort-asc', onClick: () => quick('sort', { keys: cols.map(c => ({ column: c, direction: 'asc' })) }) },
    { label: 'Sort descending', icon: 'sort-desc', onClick: () => quick('sort', { keys: cols.map(c => ({ column: c, direction: 'desc' })) }) },
    { label: 'Filter…', icon: 'filter', onClick: () => addStep('filter', { mode: 'values', column: field.name, values: { include: true, list: [] } }) },
    { label: 'Remove empty', icon: 'eraser', onClick: () => quick('remove_blank_rows', { columns: cols, mode: 'any' }) },
    { label: 'Remove duplicates', icon: 'layers', onClick: () => quick('remove_duplicates', { columns: cols }) },
    '-',
    { label: 'Change type', icon: 'type', items: Object.entries(TYPE_LABELS).map(([k, l]) => ({ label: l, checked: !many && field.type === k, onClick: () => quick('change_type', { columns: cols, type: k }, `Change type to ${l}`) })) },
    { label: 'Rename…', icon: 'edit', disabled: many, onClick: () => gridHandlers.onHeaderRename({ field }) },
    { label: 'Replace values…', icon: 'replace', onClick: () => addStep('replace_values', { columns: cols }) },
    { label: 'Fill down', icon: 'arrow-down', onClick: () => quick('fill', { columns: cols, direction: 'down' }) },
    { label: 'Text', icon: 'case', items: [
      { label: 'Trim & clean', onClick: () => quick('trim_clean', { columns: cols }) },
      { label: 'UPPERCASE', onClick: () => quick('change_case', { columns: cols, mode: 'upper' }) },
      { label: 'lowercase', onClick: () => quick('change_case', { columns: cols, mode: 'lower' }) },
      { label: 'Proper Case', onClick: () => quick('change_case', { columns: cols, mode: 'proper' }) },
      { label: 'Split column…', disabled: many, onClick: () => addStep('split_column', { column: field.name }) },
      { label: 'Extract…', disabled: many, onClick: () => addStep('extract_text', { column: field.name }) },
      { label: 'Merge columns…', disabled: !many, onClick: () => addStep('merge_columns', { columns: cols }) },
    ] },
    { label: 'Group by…', icon: 'group', onClick: () => addStep('group_by', { groupColumns: cols }) },
    { label: 'Unpivot', icon: 'unpivot', onClick: () => quick('unpivot', { columns: cols, mode: 'selected' }) },
    { label: 'Unpivot other columns', icon: 'unpivot', onClick: () => quick('unpivot', { columns: cols, mode: 'others' }) },
    '-',
    { label: 'Duplicate column', icon: 'copy', disabled: many, onClick: () => quick('duplicate_column', { column: field.name, name: '' }) },
    { label: 'Keep only selected', icon: 'columns-keep', onClick: () => quick('select_columns', { columns: cols }) },
    { label: 'Move to start', icon: 'chevron-left', onClick: () => quick('move_column', { columns: cols, to: 'start' }) },
    { label: 'Remove', icon: 'columns-remove', danger: true, onClick: () => quick('remove_columns', { columns: cols }) },
    '-',
    { label: 'Profile column', icon: 'chart', onClick: () => openProfile(field.name) },
  ], pos);
}

function cellMenu(field, value, rid, pos) {
  const shown = value == null ? '(empty)' : formatValue(value, field.type);
  const short = shown.length > 24 ? shown.slice(0, 24) + '…' : shown;
  const lit = value == null ? '' : formatValue(value, field.type);
  const rule = (op) => ({ mode: 'rules', logic: 'all', loose: false, rules: [{ column: field.name, operator: value == null ? (op === '=' ? 'is_null' : 'is_not_null') : op, value: lit }] });
  menu(document.body, [
    { header: `${field.name} = ${short}` },
    { label: `Keep rows = ${short}`, icon: 'filter', onClick: () => addStep('filter', rule('='), { open: false, label: 'Filter to value' }) },
    { label: `Exclude ${short}`, icon: 'filter', onClick: () => addStep('filter', rule('!='), { open: false, label: 'Exclude value' }) },
    value != null && typeof value === 'number' ? { label: `Keep rows > ${short}`, icon: 'filter', onClick: () => addStep('filter', rule('>'), { open: false }) } : null,
    { label: 'Replace this value…', icon: 'replace', onClick: () => addStep('replace_values', { columns: [field.name], match: 'whole', find: lit, replace: '' }) },
    '-',
    { label: 'Copy value', icon: 'copy', onClick: () => copyText(lit).then(() => toast('Copied')) },
    { label: 'Copy selection', icon: 'copy', hint: kbd('⌘C'), onClick: () => grid.copySelection() },
    rid != null ? { label: 'Delete this row', icon: 'trash', danger: true, onClick: () => deleteRows(ui.selection.rids?.length ? ui.selection.rids : [rid]) } : null,
  ], pos);
}

function renderToolbar() {
  const host = clear($('#gridToolbar'));
  const r = ui.result;
  const q = store.activeQuery();
  const search = el('input', { class: 'input input-sm grid-search', type: 'search', placeholder: 'Find in preview…', value: ui.search, 'aria-label': 'Find in data' });
  const hitLabel = el('span', { class: 'hit-label' });
  const run = debounce(async () => {
    ui.search = search.value;
    if (!search.value || !r) { grid.setSearchHits(null); hitLabel.textContent = ''; return; }
    const res = await client.call('findRows', { resultId: r.resultId, text: search.value, limit: 2000 }, { track: false });
    grid.setSearchHits(res.matches || []);
    hitLabel.textContent = `${fmtCount(res.matches?.length || 0)}${res.truncated ? '+' : ''} hits`;
    if (res.matches?.length) { grid.scrollToCell(res.matches[0][0], res.matches[0][1]); grid.render(true); }
  }, 220);
  search.addEventListener('input', run);
  host.append(
    el('div', { class: 'tb-left' }, el('h2', { class: 'tb-title' }, q?.name || ''), r ? el('span', { class: 'tb-shape' }, `${fmtCount(r.rowCount)} rows × ${r.fields.length} columns`) : null),
    el('div', { class: 'tb-right' }, search, hitLabel,
      el('button', { class: `btn btn-ghost btn-sm${ui.showQuality ? ' is-on' : ''}`, onclick: () => { ui.showQuality = !ui.showQuality; prefs.set('quality', ui.showQuality); grid.setQualityVisible(ui.showQuality); renderToolbar(); } }, icon('chart', 14), 'Quality'),
      el('button', { class: `btn btn-ghost btn-sm${ui.rightMode === 'profile' ? ' is-on' : ''}`, onclick: () => { if (ui.rightMode === 'profile') closeRight(); else { const c = ui.selection.columns?.[0] || r?.fields[0]?.name; if (c) openProfile(c); } renderToolbar(); } }, icon('panel-right', 14), 'Profile')));
}

function renderStatus() {
  const host = clear($('#statusBar'));
  const r = ui.result;
  const q = store.activeQuery();
  if (!q) return;
  const cursor = store.cursor();
  const errs = ui.diag.filter(d => d.error).length;
  const warns = ui.diag.reduce((n, d) => n + (d.warn?.length || 0), 0);
  const sel = ui.selection;
  const item = (t, cls = '') => el('span', { class: `sb-item ${cls}` }, t);
  host.append(
    item(r ? `${fmtCount(r.rowCount)} rows` : '— rows'),
    item(r ? `${r.fields.length} columns` : ''),
    item(cursor < 0 ? 'at source' : `step ${cursor + 1}/${q.steps.length}`),
    sel.rect ? item(`${fmtCount(sel.rect.r1 - sel.rect.r0 + 1)} × ${sel.rect.c1 - sel.rect.c0 + 1} selected`) : sel.explicitColumns?.length ? item(`${sel.explicitColumns.length} column${sel.explicitColumns.length === 1 ? '' : 's'} selected`) : null,
    sel.rids?.length ? item(`${sel.rids.length} rows selected — Del to remove`) : null,
    el('span', { class: 'sb-spacer' }),
    errs ? item(`${errs} error${errs === 1 ? '' : 's'}`, 'sb-err') : null,
    warns ? item(`${warns} warning${warns === 1 ? '' : 's'}`, 'sb-warn') : null,
    r ? item(`~${fmtBytes(r.bytes)}`) : null,
    r ? item(fmtMs(r.ms)) : null,
    item('Saved locally', 'sb-saved'));
}

const CATEGORY_ORDER = ['Rows', 'Columns', 'Text', 'Number', 'Date', 'Add column', 'Summarize', 'Reshape', 'Combine', 'Table'];

function openPalette() {
  if (!store.activeQuery()) return;
  const input = el('input', { class: 'palette-input', type: 'text', placeholder: 'Add a step or run a command…', autocomplete: 'off', 'aria-label': 'Search' });
  const list = el('div', { class: 'palette-list', role: 'listbox' });
  const commands = [
    { label: 'Export…', icon: 'download', run: () => openExportDialog() },
    { label: 'Save recipe', icon: 'save', run: saveRecipe },
    { label: 'Open recipe…', icon: 'clipboard', run: loadRecipeFile },
    { label: 'Batch apply steps to many files…', icon: 'layers', run: openBatch },
    { label: 'Import another file', icon: 'upload', run: async () => { const f = await pickFiles({ accept: ACCEPT, multiple: true }); if (f.length) importFiles(f); } },
    { label: 'Toggle light / dark theme', icon: 'sun', run: toggleTheme },
    { label: 'Undo', icon: 'undo', run: doUndo },
    { label: 'Redo', icon: 'redo', run: doRedo },
    { label: 'Keyboard shortcuts', icon: 'keyboard', run: openHelp },
  ];
  const all = [...transformCatalog().map(t => ({ label: t.label, icon: t.icon, cat: t.category, code: t.code, kw: t.keywords, run: () => addStep(t.type) })), ...commands.map(c => ({ ...c, cat: 'Commands' }))];
  let items = [], idx = 0;
  const draw = () => {
    const qv = input.value.trim();
    items = all.map(it => ({ it, s: qv ? Math.max(fuzzyScore(qv, it.label), fuzzyScore(qv, it.kw || '') * 0.7, it.code && it.code.toLowerCase() === qv.toLowerCase() ? 120 : 0) : 1 })).filter(x => x.s > 0);
    if (qv) items.sort((a, b) => b.s - a.s); else items.sort((a, b) => (CATEGORY_ORDER.indexOf(a.it.cat) + 1 || 99) - (CATEGORY_ORDER.indexOf(b.it.cat) + 1 || 99));
    items = items.map(x => x.it);
    idx = Math.min(idx, Math.max(0, items.length - 1));
    clear(list);
    let lastCat = null;
    items.forEach((it, i) => {
      if (!qv && it.cat !== lastCat) { list.appendChild(el('div', { class: 'palette-cat' }, it.cat)); lastCat = it.cat; }
      list.appendChild(el('div', { class: `palette-item${i === idx ? ' is-on' : ''}`, role: 'option', onmousedown: (e) => { e.preventDefault(); choose(i); }, onmousemove: () => { if (idx !== i) { idx = i; draw(); } } }, icon(it.icon, 16), el('span', { class: 'pi-label' }, it.label), it.code ? el('span', { class: 'pi-code' }, it.code) : null, qv ? el('span', { class: 'pi-cat' }, it.cat) : null));
    });
    if (!items.length) list.appendChild(el('p', { class: 'panel-empty' }, 'Nothing matches. Try “filter”, “split”, “join”…'));
    list.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => { const it = items[i]; if (!it) return; m.close(); setTimeout(it.run, 0); };
  input.addEventListener('input', () => { idx = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(idx); }
  });
  const m = modal({ width: 600, className: 'palette', body: [el('div', { class: 'palette-search' }, icon('search', 18), input, el('kbd', {}, 'esc')), list] });
  draw();
  input.focus();
}

function openHelp() {
  const rows = [['Command palette / add step', '⌘K'], ['Undo', '⌘Z'], ['Redo', '⌘⇧Z'], ['Save recipe', '⌘S'], ['Export', '⌘E'], ['Find in preview', '⌘F'], ['Copy selection', '⌘C'], ['Copy with headers', '⌘⇧C'], ['Edit a cell', 'Enter / type / dbl-click'], ['Rename column', 'dbl-click header'], ['Column menu', 'right-click header'], ['Multi-select columns', '⌘/Shift-click header'], ['Select rows', 'click / Shift-click row number'], ['Delete selected rows', 'Delete'], ['Rename step', 'F2'], ['Delete step', 'Delete (step focused)'], ['This help', '?']];
  modal({ title: 'Keyboard shortcuts', icon: 'keyboard', width: 520, body: el('div', { class: 'help-grid' }, rows.map(([a, b]) => el('div', { class: 'help-row' }, el('span', {}, a), el('kbd', {}, kbd(b))))) });
}

function openExportMenu(anchor) {
  const quick = (format) => runExport({ format });
  menu(anchor, [
    { label: 'CSV', hint: '.csv', icon: 'file', onClick: () => quick('csv') },
    { label: 'Excel workbook', hint: '.xlsx', icon: 'table', onClick: () => quick('xlsx') },
    { label: 'Excel — every query as a sheet', hint: '.xlsx', icon: 'layers', onClick: () => quick('xlsx-all') },
    { label: 'Parquet', hint: '.parquet', icon: 'database', onClick: () => quick('parquet') },
    { label: 'JSON', hint: '.json', icon: 'file', onClick: () => quick('json') },
    { label: 'JSON Lines', hint: '.jsonl', icon: 'file', onClick: () => quick('jsonl') },
    '-',
    { label: 'Copy as Markdown table', icon: 'clipboard', onClick: () => runExport({ format: 'markdown', clipboard: true, rowEnd: 500 }) },
    { label: 'Copy as SQL INSERT', icon: 'clipboard', onClick: () => runExport({ format: 'sql', clipboard: true, rowEnd: 1000 }) },
    '-',
    { label: 'Export options…', icon: 'settings', onClick: () => openExportDialog() },
    store.activeQuery()?.source?.kind === 'duck' ? { label: 'Export full file via DuckDB…', icon: 'database', onClick: () => exportFullViaDuck() } : null,
  ], { align: 'end' });
}

function openExportDialog() {
  const fields = ui.result?.fields || [];
  const o = { format: 'csv', columns: fields.map(f => f.name), nullText: '', delimiter: ',', bom: true, guard: true, atStep: false, rowStart: 1, rowEnd: '' };
  const form = buildForm([
    { key: 'format', type: 'enum', label: 'Format', options: [{ value: 'csv', label: 'CSV' }, { value: 'tsv', label: 'TSV' }, { value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'parquet', label: 'Parquet' }, { value: 'json', label: 'JSON' }, { value: 'jsonl', label: 'JSON Lines' }, { value: 'markdown', label: 'Markdown' }, { value: 'sql', label: 'SQL INSERT' }] },
    { key: 'columns', type: 'columns', label: 'Columns', ordered: true },
    { key: 'delimiter', type: 'text', label: 'Delimiter', visible: (d) => d.format === 'csv' },
    { key: 'nullText', type: 'text', label: 'Write empty values as', visible: (d) => ['csv', 'tsv', 'markdown'].includes(d.format) },
    { key: 'bom', type: 'toggle', label: 'Add UTF-8 BOM (helps Excel open accents correctly)', visible: (d) => ['csv', 'tsv'].includes(d.format) },
    { key: 'guard', type: 'toggle', label: 'Guard against spreadsheet formula injection', visible: (d) => ['csv', 'tsv'].includes(d.format) },
    { key: 'rowStart', type: 'number', label: 'From row', min: 1 },
    { key: 'rowEnd', type: 'number', label: 'To row (empty = last)', min: 1 },
    { key: 'atStep', type: 'toggle', label: 'Export the step I am previewing (not the final step)' },
  ], o, { fields }, () => {});
  const m = modal({ title: 'Export', icon: 'download', width: 560, body: form, footer: [
    el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
    el('button', { class: 'btn btn-primary', onclick: () => { m.close(); runExport({ ...o, rowStart: Math.max(0, (Number(o.rowStart) || 1) - 1), rowEnd: o.rowEnd === '' ? Infinity : Number(o.rowEnd) }); } }, 'Export')] });
}

async function exportFullViaDuck() {
  const q = store.activeQuery();
  const active = q.steps.filter(s => !s.disabled);
  if (active.some(s => s.type !== 'sql')) {
    toast('Full-file export runs SQL steps only. Other steps work on the loaded rows; use Export for those.', { kind: 'error', duration: 8000 });
    return;
  }
  if (active.some(s => (s.data?.tables || []).length)) { toast('Full-file export can’t combine with other queries.', { kind: 'error' }); return; }
  const fmtSel = el('select', { class: 'input' }, [['parquet', 'Parquet'], ['csv', 'CSV'], ['json', 'JSON']].map(([v, l]) => el('option', { value: v }, l)));
  const m = modal({ title: 'Export full file', icon: 'database', width: 440, body: [el('p', { class: 'modal-text' }, `Runs ${active.length ? `${active.length} SQL step${active.length === 1 ? '' : 's'}` : 'the source'} over every row with DuckDB.`), el('label', { class: 'f-row' }, el('span', { class: 'f-label' }, 'Format'), fmtSel)], footer: [
    el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
    el('button', { class: 'btn btn-primary', onclick: async () => {
      const format = fmtSel.value;
      m.close();
      const dismiss = toast('Exporting with DuckDB…', { duration: 600000 });
      try {
        let cur = q.source.sql;
        for (const s of active) {
          const v = duck.validateSql(s.data.sql);
          if (v.error) throw new Error(v.error);
          cur = duck.withInput(cur, v.sql);
        }
        const buf = await duck.copyTo(cur, format);
        download(new Blob([buf]), `${q.name.replace(/[\\/:*?"<>|]+/g, '_')}.${format}`);
        dismiss();
        toast('Exported', { kind: 'success' });
      } catch (e) { dismiss(); toast(`Export failed: ${e.message}`, { kind: 'error' }); }
    } }, 'Export')] });
}

async function runExport(opts) {
  const q = store.activeQuery();
  if (!q) return;
  const base = (q.name || 'export').replace(/[\\/:*?"<>|]+/g, '_');
  const stepIndex = opts.atStep ? store.cursor() : q.steps.length - 1;
  const args = { queryId: q.id, stepIndex, columns: opts.columns, nullText: opts.nullText ?? '', delimiter: opts.delimiter || ',', bom: opts.bom !== false, guard: opts.guard !== false, rowStart: opts.rowStart || 0, rowEnd: opts.rowEnd ?? Infinity };
  try {
    const targetsToResolve = opts.format === 'xlsx-all' ? store.state.queries : [q];
    for (const t of targetsToResolve) await sql.exportPrepared(t.id, t.id === q.id ? stepIndex : t.steps.length - 1);
    if (opts.format === 'xlsx' || opts.format === 'xlsx-all') {
      const targets = opts.format === 'xlsx-all' ? store.state.queries : [q];
      const sheets = [];
      for (const t of targets) {
        const r = await client.call('exportData', { ...args, queryId: t.id, stepIndex: t.id === q.id ? stepIndex : t.steps.length - 1, columns: t.id === q.id ? opts.columns : null, format: 'columns' }, { label: 'Preparing Excel' });
        sheets.push({ name: t.name, fields: r.fields, columns: r.columns });
      }
      const { buffer } = await xlsx.call('write', { sheets });
      download(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${opts.format === 'xlsx-all' ? store.state.projectName.replace(/[\\/:*?"<>|]+/g, '_') : base}.xlsx`);
      toast(`Exported ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`, { kind: 'success' });
      return;
    }
    if (opts.format === 'parquet') {
      const r = await client.call('exportParquet', args, { label: 'Writing Parquet' });
      download(new Blob([r.buffer], { type: 'application/octet-stream' }), `${base}.parquet`);
      toast('Exported Parquet', { kind: 'success' });
      return;
    }
    const r = await client.call('exportData', { ...args, format: opts.format }, { label: 'Exporting' });
    if (opts.clipboard) { await copyText(r.text); toast(`Copied ${fmtCount(r.rows)} rows`, { kind: 'success' }); return; }
    const ext = { csv: 'csv', tsv: 'tsv', json: 'json', jsonl: 'jsonl', markdown: 'md', sql: 'sql' }[opts.format];
    download(r.text, `${base}.${ext}`, r.mime);
    toast(`Exported ${fmtCount(r.rows)} rows`, { kind: 'success' });
  } catch (e) { toast(`Export failed: ${e.message}`, { kind: 'error' }); }
}

function buildRecipe() {
  return {
    app: 'duckbench', version: 2, savedAt: new Date().toISOString(), projectName: store.state.projectName,
    sources: store.state.sources.map(s => ({ id: s.id, name: s.name, format: s.format, options: s.options, columns: (s.fields || []).map(f => ({ name: f.name, type: f.type })) })),
    queries: store.state.queries.map(q => ({ id: q.id, name: q.name, source: q.source, steps: q.steps })),
    activeQueryId: store.state.activeQueryId,
  };
}

function saveRecipe() {
  if (!store.state.queries.length) return;
  download(JSON.stringify(buildRecipe(), null, 2), `${store.state.projectName.replace(/[\\/:*?"<>|]+/g, '_')}.duckbench.json`, 'application/json');
  toast('Recipe saved', { kind: 'success' });
}

async function loadRecipeFile() {
  const [file] = await pickFiles({ accept: '.json,.duckbench.json' });
  if (!file) return;
  let r;
  try { r = JSON.parse(await file.text()); } catch { toast('That file isn’t valid JSON.', { kind: 'error' }); return; }
  if (r.version === 2 && Array.isArray(r.queries)) {
    const sources = (r.sources || []).map(s => {
      const loaded = store.state.sources.find(x => x.name === s.name && x.format === s.format && !x.missing);
      return loaded ? { ...loaded, id: s.id, _reuse: loaded.id } : { ...s, fields: s.columns, missing: true };
    });
    for (const s of sources) if (s._reuse && s._reuse !== s.id) { const blob = await persist.getFile(s._reuse); if (blob) { await loadFileIntoEngine(blob instanceof File ? blob : new File([blob], s.name), s.id, s.options); persist.putFile(s.id, blob); } else s.missing = true; }
    sources.forEach(s => delete s._reuse);
    store.commit('Open recipe', (st) => {
      st.projectName = r.projectName || st.projectName;
      st.sources = sources;
      st.queries = r.queries.map(q => ({ ...q, loadEnabled: true, steps: (q.steps || []).map(migrateStep).filter(Boolean) }));
      st.activeQueryId = r.activeQueryId && st.queries.some(q => q.id === r.activeQueryId) ? r.activeQueryId : st.queries[0]?.id;
      st.stepCursor = {};
    });
    const missing = sources.filter(s => s.missing);
    showWorkbench();
    if (missing.length) toast(`Recipe opened. Reconnect: ${missing.map(s => s.name).join(', ')} (query menu → Locate file…)`, { kind: 'info', duration: 9000 });
    else toast('Recipe opened', { kind: 'success' });
    return;
  }
  if (Array.isArray(r.steps)) {
    const q = store.activeQuery();
    if (!q) { toast('Import a data file first, then open this Duckbench 1 recipe to apply its steps.', { kind: 'error', duration: 8000 }); return; }
    const steps = r.steps.map(migrateStep).filter(Boolean).map(s => ({ ...s, id: uid('s') }));
    const unsupported = steps.filter(s => s.unsupported).length;
    store.commit('Apply v1 recipe', (st) => { st.queries.find(x => x.id === q.id).steps.push(...steps); delete st.stepCursor[q.id]; });
    toast(`Applied ${steps.length} steps${unsupported ? `, ${unsupported} unsupported` : ''}`, { kind: unsupported ? 'info' : 'success' });
    return;
  }
  toast('That doesn’t look like a Duckbench recipe.', { kind: 'error' });
}

const BATCH_FORMATS = [['csv', 'CSV'], ['xlsx', 'Excel (.xlsx)'], ['json', 'JSON'], ['jsonl', 'JSON Lines'], ['parquet', 'Parquet']];
const CROSS_QUERY = new Set(['join', 'append']);

async function exportResult(resultId, format, base) {
  if (format === 'xlsx') {
    const c = await client.call('exportData', { resultId, format: 'columns' }, { track: false });
    const { buffer } = await xlsx.call('write', { sheets: [{ name: base.slice(0, 31), fields: c.fields, columns: c.columns }] });
    return { name: `${base}.xlsx`, data: new Uint8Array(buffer) };
  }
  if (format === 'parquet') {
    const p = await client.call('exportParquet', { resultId }, { track: false });
    return { name: `${base}.parquet`, data: new Uint8Array(p.buffer) };
  }
  const t = await client.call('exportData', { resultId, format }, { track: false });
  return { name: `${base}.${format}`, data: t.text, mime: t.mime };
}

function openBatch() {
  const st = { steps: null, recipeName: '', files: [], format: 'csv', zip: true, running: false, cancel: false };
  const fromProject = store.activeQuery();
  if (fromProject?.steps.length) { st.steps = fromProject.steps.map(s => migrateStep(JSON.parse(JSON.stringify(s)))); st.recipeName = fromProject.name; }
  const recipeLabel = el('span', { class: 'f-help' });
  const warn = el('p', { class: 'field-error', hidden: true });
  const list = el('ul', { class: 'batch-list' });
  const runBtn = el('button', { class: 'btn btn-primary' }, icon('play', 14), 'Run');
  const progress = el('span', { class: 'f-help' });
  const draw = () => {
    recipeLabel.textContent = st.steps ? `${st.recipeName} · ${st.steps.length} step${st.steps.length === 1 ? '' : 's'}` : 'None chosen';
    const cross = (st.steps || []).filter(s => CROSS_QUERY.has(s.type) && !s.disabled).length;
    warn.hidden = !cross;
    warn.textContent = cross ? `${cross} step${cross === 1 ? ' joins or appends' : 's join or append'} other queries and will fail in batch runs. Disable ${cross === 1 ? 'it' : 'them'} in the project first.` : '';
    clear(list);
    if (!st.files.length) list.appendChild(el('li', { class: 'batch-item' }, el('span', { class: 'bi-name', style: { color: 'var(--muted)' } }, 'No files')));
    st.files.forEach((f, i) => list.appendChild(el('li', { class: `batch-item${f.status === 'done' ? ' is-ok' : f.status === 'error' ? ' is-err' : f.status === 'running' ? ' is-run' : ''}`, title: f.error || '' },
      icon('file', 14), el('span', { class: 'bi-name' }, f.file.name),
      el('span', { class: 'bi-status' }, f.status === 'done' ? `${fmtCount(f.rows)} rows` : f.status === 'error' ? 'failed' : f.status === 'running' ? 'running' : fmtBytes(f.file.size)),
      !st.running && !f.status ? el('button', { class: 'icon-btn icon-btn-xs', 'aria-label': `Remove ${f.file.name}`, onclick: () => { st.files.splice(i, 1); draw(); } }, icon('x', 12)) : null)));
    runBtn.disabled = st.running || !st.steps || !st.files.length;
    const failures = st.files.filter(f => f.status === 'error');
    if (failures.length && !st.running) progress.textContent = failures.map(f => `${f.file.name}: ${f.error}`).join(' · ');
  };
  const pickRecipe = async () => {
    const [file] = await pickFiles({ accept: '.json' });
    if (!file) return;
    try {
      const r = JSON.parse(await file.text());
      let steps = null, name = file.name;
      if (r.version === 2 && Array.isArray(r.queries)) {
        const qs = r.queries.filter(q => q.steps?.length);
        let q = qs.find(x => x.id === r.activeQueryId) || qs[0] || r.queries[0];
        if (qs.length > 1) q = await chooseQuery(qs, q);
        if (!q) return;
        steps = q.steps; name = `${file.name} › ${q.name}`;
      } else if (Array.isArray(r.steps)) steps = r.steps;
      if (!steps) throw new Error('No steps found');
      st.steps = steps.map(migrateStep).filter(Boolean);
      st.recipeName = name;
      draw();
    } catch (e) { toast(`Couldn’t read recipe: ${e.message}`, { kind: 'error' }); }
  };
  const pickData = async () => { const files = await pickFiles({ accept: ACCEPT, multiple: true }); for (const f of files) if (f.size > LARGE_FILE_BYTES) { toast(`${f.name} is over 1 GB; batch runs load files in memory.`, { kind: 'error' }); } else st.files.push({ file: f }); draw(); };
  const fmt = el('select', { class: 'input', onchange: (e) => { st.format = e.target.value; } }, BATCH_FORMATS.map(([v, l]) => el('option', { value: v }, l)));
  const zipToggle = el('input', { type: 'checkbox', checked: true, onchange: (e) => { st.zip = e.target.checked; } });
  runBtn.addEventListener('click', async () => {
    st.running = true; st.cancel = false;
    for (const f of st.files) { f.status = null; f.error = null; }
    draw();
    const outputs = [];
    let ok = 0;
    const qid = uid('batchq');
    for (let i = 0; i < st.files.length; i++) {
      if (st.cancel) break;
      const item = st.files[i];
      item.status = 'running';
      progress.textContent = `${i + 1} of ${st.files.length}`;
      draw();
      const sid = uid('batch');
      try {
        const info = await loadFileIntoEngine(item.file, sid, {});
        if (!info) throw new Error('Skipped');
        const r = await sql.runSteps({ frameFrom: sid, steps: st.steps, id: qid, queryName: item.file.name }, { label: `Processing ${item.file.name}` });
        if (r.error) throw new Error(r.errorIndex >= 0 ? `Step ${r.errorIndex + 1}: ${r.error}` : r.error);
        const out = await exportResult(r.resultId, st.format, item.file.name.replace(/\.[^.]+$/, ''));
        if (st.zip) outputs.push(out);
        else { download(out.data instanceof Uint8Array ? new Blob([out.data]) : out.data, out.name, out.mime); await new Promise(res => setTimeout(res, 300)); }
        item.status = 'done'; item.rows = r.rowCount; ok++;
      } catch (e) { item.status = 'error'; item.error = e.message; }
      finally {
        await client.call('removeSource', { id: sid }, { track: false }).catch(() => {});
        client.remember('removeSource', { id: sid });
      }
      draw();
    }
    await client.call('dropQuery', { id: qid }, { track: false }).catch(() => {});
    if (st.zip && outputs.length) {
      progress.textContent = 'Building ZIP…';
      try {
        const blob = await zipFiles(outputs, { compress: st.format !== 'parquet' && st.format !== 'xlsx' });
        download(blob, `${(st.recipeName.split(' › ').pop() || 'batch').replace(/\.duckbench\.json$|\.json$/i, '').replace(/[\\/:*?"<>|]+/g, '_')}_batch.zip`);
      } catch (e) { toast(`ZIP failed: ${e.message}`, { kind: 'error' }); }
    }
    st.running = false;
    progress.textContent = `${ok} of ${st.files.length} exported`;
    draw();
  });
  const m = modal({ title: 'Batch apply', icon: 'layers', width: 580, onClose: () => { st.cancel = true; }, body: el('div', { class: 'form' },
    el('div', { class: 'f-row' }, el('span', { class: 'f-label' }, 'Steps'), el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, el('button', { class: 'btn btn-ghost btn-sm', onclick: pickRecipe }, icon('clipboard', 14), 'From recipe…'), recipeLabel), warn),
    el('div', { class: 'f-row' }, el('span', { class: 'f-label' }, 'Files'), list, el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-start' }, onclick: pickData }, icon('plus', 14), 'Add files…')),
    el('label', { class: 'f-row' }, el('span', { class: 'f-label' }, 'Output format'), fmt),
    el('label', { class: 'f-toggle' }, zipToggle, el('span', { class: 'toggle-ui' }), el('span', {}, 'Download as one ZIP'))),
    footer: [progress, el('span', { class: 'spacer' }), el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Close'), runBtn] });
  draw();
}

function chooseQuery(qs, preferred) {
  return new Promise((resolve) => {
    let out = null;
    const sel = el('select', { class: 'input' }, qs.map(q => el('option', { value: q.id }, `${q.name} · ${q.steps.length} steps`)));
    sel.value = preferred?.id || qs[0].id;
    const m = modal({ title: 'Which query’s steps?', width: 420, body: [sel], footer: [
      el('button', { class: 'btn btn-ghost', onclick: () => m.close(null) }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onclick: () => { out = qs.find(q => q.id === sel.value); m.close(out); } }, 'Use')], onClose: () => resolve(out) });
  });
}

function doUndo() { const l = store.undo(); if (l) toast(`Undid: ${l}`); }
function doRedo() { const l = store.redo(); if (l) toast(`Redid: ${l}`); }

async function saveSessionNow() {
  if (!store.state.queries.length) return;
  await persist.putSession(store.serialize());
}
const saveSession = debounce(saveSessionNow, 700);

store.subscribe((kind) => {
  if ($('#workbench').hidden) return;
  if (kind === 'change') {
    if (!store.activeQuery() && store.state.queries.length) store.quiet((s) => { s.activeQueryId = s.queries[0].id; }, 'ui');
    if (!store.state.queries.length) { showImport(); return; }
    renderMast(); renderQueries(); renderSteps(); refresh(); saveSession();
    if (ui.rightMode === 'inspector' && ui.selectedStep) {
      const q = store.activeQuery();
      if (!q.steps.some(s => s.id === ui.selectedStep)) closeRight();
      else if (!$('#rightRail').contains(document.activeElement)) setTimeout(() => openInspector(ui.selectedStep), 120);
      else setTimeout(() => ui.inspectorErr?.(), 150);
    }
  }
  if (kind === 'cursor') saveSession();
});

let busyTimer = null;
client.onBusy((n, label) => {
  const bar = $('#jobBar');
  if (n > 0) {
    if (busyTimer || !bar.hidden) return;
    const t0 = performance.now();
    busyTimer = setTimeout(() => {
      bar.hidden = false;
      clear(bar).append(el('span', { class: 'job-dot' }), el('span', { class: 'job-label' }, `${label || 'Working'}…`), el('span', { class: 'job-time' }), client.canCancel ? el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { await client.cancel(); bar.hidden = true; toast('Cancelled'); refresh(); } }, 'Cancel') : null);
      bar._tick = setInterval(() => { const t = bar.querySelector('.job-time'); if (t) t.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`; }, 200);
    }, 450);
  } else {
    clearTimeout(busyTimer); busyTimer = null;
    clearInterval(bar._tick);
    bar.hidden = true;
  }
});

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  const inBench = !$('#workbench').hidden;
  if (modKey(e) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (inBench && !hasOverlay()) openPalette(); return; }
  if (!inBench || hasOverlay()) return;
  if (modKey(e) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRecipe(); return; }
  if (modKey(e) && e.key.toLowerCase() === 'e') { e.preventDefault(); openExportDialog(); return; }
  if (modKey(e) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('.grid-search')?.focus(); return; }
  if (typing) return;
  if (modKey(e) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if (modKey(e) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
  if (e.key === '?') { e.preventDefault(); openHelp(); }
});

['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.body.classList.add('is-dropping'); } }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, (e) => { if (ev === 'dragleave' && e.relatedTarget) return; document.body.classList.remove('is-dropping'); }));
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  const recipe = files.find(f => /\.json$/i.test(f.name) && /duckbench/i.test(f.name));
  if (recipe) { toast('Use “Open recipe” to load recipes'); return; }
  importFiles(files, { asNewProject: $('#workbench').hidden });
});

window.addEventListener('beforeunload', () => { if (store.state.queries.length) persist.putSession(store.serialize()); });

(async function boot() {
  await client.init();
  renderMast();
  renderImport();
  $('#importScreen').hidden = false;
  window.duckbench = { store, client, version: '2.0.0' };
  const params = new URLSearchParams(location.search);
  if (params.has('notour')) prefs.set('tourDone', true);
  if (params.has('demo')) loadSample();
})();
