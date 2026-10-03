import { el, clear, put, kbd } from './dom.js';
import { icon } from './icons.js';
import { TYPE_BADGES, isNumeric, isTemporal } from '../core/types.js';
import { FORMULA_FUNCTIONS } from '../core/formula.js';
import { sqlEditor, SQL_SNIPPETS } from './sqleditor.js';

export function buildForm(params, data, ctx, onChange) {
  const root = el('div', { class: 'form' });
  const render = () => {
    const active = document.activeElement;
    const activeKey = active?.dataset?.fkey;
    const selStart = active?.selectionStart, selEnd = active?.selectionEnd;
    clear(root);
    for (const p of params) {
      if (p.visible && !p.visible(data, ctx)) continue;
      root.appendChild(field(p, data, ctx, (v, opts = {}) => {
        data[p.key] = v;
        onChange(data, { key: p.key, structural: opts.structural || p.type === 'segmented' || p.type === 'enum' || p.type === 'toggle' });
        if (opts.structural || p.type === 'segmented' || p.type === 'enum' || p.type === 'toggle' || p.type === 'query') render();
      }, render));
    }
    if (activeKey) {
      const n = root.querySelector(`[data-fkey="${CSS.escape(activeKey)}"]`);
      if (n) { n.focus(); try { if (selStart != null) n.setSelectionRange(selStart, selEnd); } catch {} }
    }
  };
  render();
  root.refresh = render;
  return root;
}

function label(p, extra) {
  return el('label', { class: 'f-label' }, p.label, extra || null);
}

function colOption(f) {
  return el('option', { value: f.name }, `${f.name}  ·  ${TYPE_BADGES[f.type] || ''}`);
}

function columnSelect(fields, value, { optional, filter, placeholder = 'Choose a column…', fkey } = {}) {
  const list = filter ? fields.filter(filter) : fields;
  const sel = el('select', { class: 'input', dataset: fkey ? { fkey } : null });
  if (optional) sel.appendChild(el('option', { value: '' }, '— none —'));
  else if (!value) sel.appendChild(el('option', { value: '', disabled: true, selected: true }, placeholder));
  for (const f of list) sel.appendChild(colOption(f));
  if (value && !list.some(f => f.name === value)) sel.appendChild(el('option', { value }, `${value} (missing)`));
  sel.value = value || '';
  return sel;
}

function field(p, data, ctx, set, rerender) {
  const v = data[p.key];
  const wrap = el('div', { class: `f-row f-${p.type}` });
  const fields = ctx.fields || [];
  const help = p.help ? el('p', { class: 'f-help' }, p.help) : null;
  switch (p.type) {
    case 'column': case 'columnOptional': {
      const filter = p.numeric ? (f) => isNumeric(f.type) : p.temporal ? null : null;
      const sel = columnSelect(fields, v, { optional: p.type === 'columnOptional', filter: p.numeric ? null : filter, fkey: p.key });
      sel.addEventListener('change', () => set(sel.value, { structural: true }));
      put(wrap, label(p), sel, help);
      break;
    }
    case 'rightColumn': {
      const sel = columnSelect(ctx.rightFields || [], v, { fkey: p.key });
      sel.addEventListener('change', () => set(sel.value, { structural: true }));
      put(wrap, label(p), sel);
      break;
    }
    case 'columns': case 'rightColumns': {
      const src = p.type === 'rightColumns' ? (ctx.rightFields || []) : fields;
      put(wrap, label(p, el('span', { class: 'f-count' }, `${(v || []).length} selected`)), columnPicker(src, v || [], (nv) => set(nv, { structural: true }), { ordered: p.ordered }));
      break;
    }
    case 'text': {
      const input = el('input', { class: 'input', type: 'text', value: v ?? '', placeholder: p.placeholder || '', dataset: { fkey: p.key }, spellcheck: 'false' });
      input.addEventListener('input', () => set(input.value));
      put(wrap, label(p), input, help);
      break;
    }
    case 'number': {
      const input = el('input', { class: 'input', type: 'number', value: v ?? '', min: p.min ?? null, step: 'any', dataset: { fkey: p.key } });
      input.addEventListener('input', () => set(input.value === '' ? '' : Number(input.value)));
      put(wrap, label(p), input, help);
      break;
    }
    case 'toggle': {
      const cb = el('input', { type: 'checkbox', checked: !!v, dataset: { fkey: p.key } });
      cb.addEventListener('change', () => set(cb.checked));
      put(wrap, el('label', { class: 'f-toggle' }, cb, el('span', { class: 'toggle-ui' }), el('span', {}, p.label)));
      break;
    }
    case 'enum': {
      const sel = el('select', { class: 'input', dataset: { fkey: p.key } });
      for (const o of p.options) sel.appendChild(el('option', { value: o.value }, o.label));
      sel.value = v ?? p.options[0]?.value;
      sel.addEventListener('change', () => set(sel.value));
      put(wrap, label(p), sel, help);
      break;
    }
    case 'segmented': {
      const seg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': p.label });
      for (const o of p.options) {
        seg.appendChild(el('button', { type: 'button', class: `seg${(v ?? p.options[0].value) === o.value ? ' is-on' : ''}`, role: 'radio', 'aria-checked': String((v ?? p.options[0].value) === o.value), onclick: () => set(o.value) }, o.label));
      }
      put(wrap, label(p), seg);
      break;
    }
    case 'code': {
      const tables = ['input', ...(ctx.sqlTables || [])];
      const ed = sqlEditor({ value: v ?? '', rows: 10, fkey: p.key, label: p.label, getContext: () => ({ tables, columns: fields }), onChange: (val) => set(val), onRun: () => ctx.onRunSql?.() });
      const snippets = el('select', { class: 'input input-sm sql-snippets', 'aria-label': 'Insert a pattern' }, el('option', { value: '' }, 'Patterns…'), SQL_SNIPPETS.map((s, i) => el('option', { value: String(i) }, s.label)));
      snippets.addEventListener('change', () => { const s = SQL_SNIPPETS[Number(snippets.value)]; if (s) ed.setValue(s.sql); snippets.value = ''; });
      const cols = el('div', { class: 'sql-cols' }, fields.slice(0, 80).map(f => el('button', { type: 'button', class: 'chip chip-btn', title: `Insert "${f.name}"`, onclick: () => ed.insert(/^[a-z_][a-z0-9_]*$/.test(f.name) ? f.name : `"${f.name.replace(/"/g, '""')}"`) }, el('span', { class: `chip-type type-${f.type}` }, TYPE_BADGES[f.type] || ''), f.name)));
      put(wrap, 
        el('div', { class: 'f-label' }, el('span', {}, p.label), el('span', { class: 'f-count' }, kbd('⌘↵'))),
        ed,
        el('div', { class: 'sql-info' },
          el('div', { class: 'sql-info-row' }, el('span', { class: 'sql-tables' }, tables.map(t => el('code', {}, t))), snippets),
          p.help ? el('span', { class: 'f-help' }, p.help) : null,
          cols));
      break;
    }
    case 'formula': {
      put(wrap, label(p), formulaEditor(v || '', p, fields, (nv) => set(nv)));
      break;
    }
    case 'query': {
      const sel = el('select', { class: 'input', dataset: { fkey: p.key } });
      const options = (ctx.queries || []).filter(q => q.id !== ctx.queryId);
      if (!v) sel.appendChild(el('option', { value: '', disabled: true, selected: true }, options.length ? 'Choose a query…' : 'No other queries — import another file first'));
      for (const q of options) sel.appendChild(el('option', { value: q.id }, q.name));
      if (v) sel.value = v;
      sel.addEventListener('change', () => set(sel.value, { structural: true }));
      put(wrap, label(p), sel, ctx.onAddQuery ? el('button', { class: 'btn btn-ghost btn-xs f-inline-btn', type: 'button', onclick: () => ctx.onAddQuery() }, icon('plus', 12), 'Import another file') : null);
      break;
    }
    case 'queries': {
      const opts = (ctx.queries || []).filter(q => q.id !== ctx.queryId);
      const list = el('div', { class: 'check-list' });
      const cur = new Set(v || []);
      if (!opts.length) list.appendChild(el('p', { class: 'f-help' }, 'No other queries yet — import another file first.'));
      for (const q of opts) {
        const cb = el('input', { type: 'checkbox', checked: cur.has(q.id) });
        cb.addEventListener('change', () => { if (cb.checked) cur.add(q.id); else cur.delete(q.id); set(opts.filter(o => cur.has(o.id)).map(o => o.id), { structural: true }); });
        list.appendChild(el('label', { class: 'check-item' }, cb, el('span', {}, q.name)));
      }
      put(wrap, label(p), list, ctx.onAddQuery ? el('button', { class: 'btn btn-ghost btn-xs f-inline-btn', type: 'button', onclick: () => ctx.onAddQuery() }, icon('plus', 12), 'Import another file') : null);
      break;
    }
    case 'valueset': {
      put(wrap, label(p), valueSet(v || { include: true, list: [] }, data[p.column], ctx, (nv) => set(nv)));
      break;
    }
    case 'rename': {
      const box = el('div', { class: 'rename-list' });
      const mapping = { ...(v || {}) };
      const filterInput = el('input', { class: 'input input-sm', type: 'search', placeholder: 'Filter columns…' });
      const draw = () => {
        clear(box);
        const q = filterInput.value.toLowerCase();
        for (const f of fields) {
          if (q && !f.name.toLowerCase().includes(q) && !(mapping[f.name] || '').toLowerCase().includes(q)) continue;
          const input = el('input', { class: 'input input-sm', type: 'text', value: mapping[f.name] ?? '', placeholder: f.name, dataset: { fkey: `rn:${f.name}` }, spellcheck: 'false' });
          input.addEventListener('input', () => { if (input.value && input.value !== f.name) mapping[f.name] = input.value; else delete mapping[f.name]; set({ ...mapping }); });
          box.appendChild(el('div', { class: `rename-row${mapping[f.name] ? ' is-set' : ''}` }, el('span', { class: 'rename-old', title: f.name }, f.name), icon('arrow-right', 12), input));
        }
      };
      filterInput.addEventListener('input', draw);
      draw();
      put(wrap, label(p), fields.length > 8 ? filterInput : null, box);
      break;
    }
    case 'repeater': {
      put(wrap, label(p), repeater(p, v || [], ctx, (nv, structural) => set(nv, { structural })));
      break;
    }
    default:
      put(wrap, label(p), el('span', {}, String(v)));
  }
  return wrap;
}

function repeater(p, items, ctx, set) {
  const box = el('div', { class: 'repeater' });
  const list = items.map(x => ({ ...x }));
  const draw = () => {
    clear(box);
    list.forEach((item, i) => {
      const row = el('div', { class: 'rep-item' });
      for (const f of p.fields) {
        if (f.visible && !f.visible(item)) continue;
        const cell = el('div', { class: `rep-cell rep-${f.type}` });
        const val = item[f.key] ?? (typeof f.default === 'function' ? f.default() : f.default) ?? '';
        if (item[f.key] === undefined && f.default !== undefined) item[f.key] = val;
        if (f.type === 'column' || f.type === 'rightColumn') {
          const sel = columnSelect(f.type === 'rightColumn' ? (ctx.rightFields || []) : (ctx.fields || []), val, { placeholder: f.label, fkey: `${p.key}.${i}.${f.key}` });
          sel.setAttribute('aria-label', f.label);
          sel.addEventListener('change', () => { item[f.key] = sel.value; set(list.map(x => ({ ...x })), true); });
          cell.appendChild(sel);
        } else if (f.type === 'enum') {
          const sel = el('select', { class: 'input', 'aria-label': f.label, dataset: { fkey: `${p.key}.${i}.${f.key}` } });
          for (const o of f.options) sel.appendChild(el('option', { value: o.value }, o.label));
          sel.value = val;
          sel.addEventListener('change', () => { item[f.key] = sel.value; set(list.map(x => ({ ...x })), true); draw(); });
          cell.appendChild(sel);
        } else {
          const input = el('input', { class: 'input', type: 'text', value: val, placeholder: f.placeholder || f.label, 'aria-label': f.label, dataset: { fkey: `${p.key}.${i}.${f.key}` }, spellcheck: 'false' });
          input.addEventListener('input', () => { item[f.key] = input.value; set(list.map(x => ({ ...x })), false); });
          cell.appendChild(input);
        }
        row.appendChild(cell);
      }
      const tools = el('div', { class: 'rep-tools' });
      if (list.length > 1 && i > 0) tools.appendChild(el('button', { class: 'icon-btn icon-btn-xs', type: 'button', title: 'Move up', onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; set(list.map(x => ({ ...x })), true); draw(); } }, icon('chevron-down', 12, 'flip')));
      tools.appendChild(el('button', { class: 'icon-btn icon-btn-xs', type: 'button', title: 'Remove', disabled: list.length <= 1 && !p.allowEmpty, onclick: () => { list.splice(i, 1); set(list.map(x => ({ ...x })), true); draw(); } }, icon('x', 12)));
      row.appendChild(tools);
      box.appendChild(row);
    });
    box.appendChild(el('button', { class: 'btn btn-ghost btn-xs rep-add', type: 'button', onclick: () => {
      const base = {};
      for (const f of p.fields) if (f.default !== undefined) base[f.key] = typeof f.default === 'function' ? f.default() : f.default;
      const last = list[list.length - 1];
      if (last && p.fields.some(f => f.key === 'operator')) { base.column = last.column; }
      list.push(base); set(list.map(x => ({ ...x })), true); draw();
    } }, p.addLabel || '+ Add'));
  };
  draw();
  return box;
}

export function columnPicker(fields, selected, onChange, { ordered = false } = {}) {
  const box = el('div', { class: 'col-picker' });
  let sel = selected.slice();
  const search = el('input', { class: 'input input-sm', type: 'search', placeholder: 'Search columns…', 'aria-label': 'Search columns' });
  const list = el('div', { class: 'col-picker-list', role: 'listbox', 'aria-multiselectable': 'true' });
  const chips = el('div', { class: 'col-chips' });
  const tools = el('div', { class: 'col-picker-tools' },
    el('button', { class: 'link-btn', type: 'button', onclick: () => { const vis = visible(); sel = [...new Set([...sel, ...vis.map(f => f.name)])]; emit(); } }, 'All'),
    el('button', { class: 'link-btn', type: 'button', onclick: () => { const vis = new Set(visible().map(f => f.name)); sel = sel.filter(n => !vis.has(n)); emit(); } }, 'None'),
    el('button', { class: 'link-btn', type: 'button', onclick: () => { const vis = visible().map(f => f.name); const cur = new Set(sel); sel = [...sel.filter(n => !vis.includes(n)), ...vis.filter(n => !cur.has(n))]; emit(); } }, 'Invert'));
  const visible = () => { const q = search.value.toLowerCase(); return fields.filter(f => !q || f.name.toLowerCase().includes(q)); };
  const emit = () => { onChange(sel.slice()); draw(); };
  const draw = () => {
    clear(list);
    const set = new Set(sel);
    for (const f of visible()) {
      const cb = el('input', { type: 'checkbox', checked: set.has(f.name), tabindex: '-1' });
      const item = el('label', { class: `col-item${set.has(f.name) ? ' is-on' : ''}`, role: 'option', 'aria-selected': String(set.has(f.name)) }, cb, el('span', { class: `type-badge type-${f.type}` }, TYPE_BADGES[f.type]), el('span', { class: 'col-item-name' }, f.name));
      cb.addEventListener('change', () => { if (cb.checked) sel.push(f.name); else sel = sel.filter(n => n !== f.name); emit(); });
      list.appendChild(item);
    }
    const missing = sel.filter(n => !fields.some(f => f.name === n));
    for (const m of missing) {
      list.appendChild(el('div', { class: 'col-item is-missing' }, el('span', { class: 'col-item-name' }, `${m} — missing at this step`), el('button', { class: 'link-btn', type: 'button', onclick: () => { sel = sel.filter(n => n !== m); emit(); } }, 'remove')));
    }
    clear(chips);
    if (ordered && sel.length) {
      sel.forEach((n, i) => {
        const chip = el('span', { class: 'chip', draggable: 'true', dataset: { i: String(i) } }, icon('drag', 10), n);
        chip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); chip.classList.add('is-drag'); });
        chip.addEventListener('dragend', () => chip.classList.remove('is-drag'));
        chip.addEventListener('dragover', (e) => e.preventDefault());
        chip.addEventListener('drop', (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); const [x] = sel.splice(from, 1); sel.splice(i, 0, x); emit(); });
        chips.appendChild(chip);
      });
    }
  };
  search.addEventListener('input', draw);
  draw();
  box.append(fields.length > 6 ? el('div', { class: 'col-picker-head' }, search, tools) : el('div', { class: 'col-picker-head' }, tools), list, ordered ? el('div', { class: 'col-chips-wrap' }, el('span', { class: 'f-help' }, 'Order (drag to reorder):'), chips) : null);
  return box;
}

function valueSet(v, column, ctx, set) {
  const box = el('div', { class: 'valueset' });
  const state = { include: v.include !== false, list: (v.list || []).slice() };
  const search = el('input', { class: 'input input-sm', type: 'search', placeholder: 'Search values…' });
  const list = el('div', { class: 'vs-list' });
  const meta = el('div', { class: 'vs-meta' });
  const mode = el('div', { class: 'segmented' },
    el('button', { type: 'button', class: `seg${state.include ? ' is-on' : ''}`, onclick: () => { state.include = true; emit(); } }, 'Keep selected'),
    el('button', { type: 'button', class: `seg${!state.include ? ' is-on' : ''}`, onclick: () => { state.include = false; emit(); } }, 'Remove selected'));
  let values = [];
  let truncated = false;
  const emit = () => { set({ include: state.include, list: state.list.slice() }); [...mode.children].forEach((b, i) => b.classList.toggle('is-on', i === 0 ? state.include : !state.include)); draw(); };
  const draw = () => {
    clear(list);
    const chosen = new Set(state.list.map(x => (x == null ? '\u0000null' : String(x))));
    for (const { value, count } of values) {
      const key = value == null ? '\u0000null' : String(value);
      const cb = el('input', { type: 'checkbox', checked: chosen.has(key) });
      cb.addEventListener('change', () => { if (cb.checked) state.list.push(value); else state.list = state.list.filter(x => (x == null ? '\u0000null' : String(x)) !== key); emit(); });
      list.appendChild(el('label', { class: 'vs-item' }, cb, el('span', { class: `vs-val${value == null ? ' is-null' : ''}` }, value == null ? '(empty)' : value === '' ? '“”' : value), el('span', { class: 'vs-count' }, count.toLocaleString())));
    }
    meta.textContent = `${state.list.length} selected${truncated ? ' · showing first 500 — search to narrow' : ''}`;
  };
  const load = async () => {
    if (!column || !ctx.loadDistinct) { list.textContent = 'Choose a column first.'; return; }
    list.textContent = 'Loading values…';
    const res = await ctx.loadDistinct(column, search.value);
    values = res?.values || [];
    truncated = res?.truncated;
    draw();
  };
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 180); });
  box.append(mode, el('div', { class: 'vs-head' }, search,
    el('button', { class: 'link-btn', type: 'button', onclick: () => { const cur = new Set(state.list.map(String)); for (const x of values) if (!cur.has(String(x.value))) state.list.push(x.value); emit(); } }, 'All'),
    el('button', { class: 'link-btn', type: 'button', onclick: () => { state.list = []; emit(); } }, 'None')), list, meta);
  load();
  return box;
}

function formulaEditor(value, p, fields, set) {
  const box = el('div', { class: 'formula' });
  const ta = el('textarea', { class: 'input formula-input', rows: '3', placeholder: p.placeholder || '', spellcheck: 'false', dataset: { fkey: p.key } });
  ta.value = value;
  const suggest = el('div', { class: 'formula-suggest', hidden: true, role: 'listbox' });
  const help = el('details', { class: 'formula-help' },
    el('summary', {}, 'Formula reference'),
    el('p', { class: 'f-help' }, 'Refer to columns as [Column name]. Operators: + − * / % ^ & (join text), = != < > <= >=, and / or / not. Text in "quotes".'),
    el('div', { class: 'fn-list' }, FORMULA_FUNCTIONS.map(f => el('button', { type: 'button', class: 'fn-item', title: f.doc, onclick: () => insert(`${f.name}(`) }, el('code', {}, f.name), el('span', {}, f.doc.replace(/^[^—]*?—\s*/, '').replace(/^\w+\(.*?\)\s*/, ''))))));
  const insert = (text) => {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.focus();
    ta.setSelectionRange(s + text.length, s + text.length);
    set(ta.value);
  };
  let items = [], idx = 0, tokenStart = 0;
  const close = () => { suggest.hidden = true; items = []; };
  const update = () => {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = /\[([^\]]*)$/.exec(before) || /([A-Za-z_]\w*)$/.exec(before);
    if (!m) { close(); return; }
    const isCol = before.endsWith(m[0]) && m[0].startsWith('[');
    const q = m[1].toLowerCase();
    tokenStart = pos - m[0].length;
    if (isCol) items = fields.filter(f => f.name.toLowerCase().includes(q)).slice(0, 8).map(f => ({ label: f.name, insert: `[${f.name}]`, kind: TYPE_BADGES[f.type] }));
    else {
      if (q.length < 1) { close(); return; }
      items = [
        ...FORMULA_FUNCTIONS.filter(f => f.name.startsWith(q)).slice(0, 6).map(f => ({ label: f.name + '()', insert: f.name + '(', kind: 'fn', doc: f.doc })),
        ...fields.filter(f => f.name.toLowerCase().startsWith(q)).slice(0, 4).map(f => ({ label: f.name, insert: `[${f.name}]`, kind: TYPE_BADGES[f.type] })),
      ];
    }
    if (!items.length) { close(); return; }
    idx = 0;
    draw();
  };
  const draw = () => {
    clear(suggest);
    items.forEach((it, i) => suggest.appendChild(el('div', { class: `fs-item${i === idx ? ' is-on' : ''}`, role: 'option', onmousedown: (e) => { e.preventDefault(); pick(i); } }, el('span', { class: 'fs-kind' }, it.kind), el('span', {}, it.label), it.doc ? el('span', { class: 'fs-doc' }, it.doc) : null)));
    suggest.hidden = false;
  };
  const pick = (i) => {
    const it = items[i];
    const pos = ta.selectionStart;
    let end = pos;
    if (it.insert.startsWith('[') && ta.value[end] === ']') end++;
    ta.value = ta.value.slice(0, tokenStart) + it.insert + ta.value.slice(end);
    const np = tokenStart + it.insert.length;
    ta.setSelectionRange(np, np);
    close();
    set(ta.value);
  };
  ta.addEventListener('input', () => { set(ta.value); update(); });
  ta.addEventListener('keydown', (e) => {
    if (suggest.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; draw(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(idx); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  ta.addEventListener('blur', () => setTimeout(close, 120));
  const colBar = el('div', { class: 'formula-cols' }, fields.slice(0, 40).map(f => el('button', { type: 'button', class: 'chip chip-btn', title: `Insert [${f.name}]`, onclick: () => insert(`[${f.name}]`) }, f.name)));
  box.append(ta, suggest, colBar, help);
  return box;
}
