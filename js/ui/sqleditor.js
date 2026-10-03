import { el, clear, escapeHtml, modKey } from './dom.js';
import { TYPE_BADGES } from '../core/types.js';

export const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'WITH', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'INNER JOIN', 'CROSS JOIN', 'ASOF JOIN', 'POSITIONAL JOIN', 'ANTI JOIN', 'SEMI JOIN', 'ON', 'USING', 'UNION', 'UNION ALL', 'UNION BY NAME', 'EXCEPT', 'INTERSECT', 'DISTINCT', 'DISTINCT ON', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'OVER', 'PARTITION BY', 'ROWS', 'RANGE', 'QUALIFY', 'WINDOW', 'FILTER', 'EXCLUDE', 'REPLACE', 'COLUMNS', 'PIVOT', 'UNPIVOT', 'SUMMARIZE', 'DESCRIBE', 'VALUES', 'TRUE', 'FALSE', 'CAST', 'TRY_CAST', 'INTERVAL', 'ALL', 'ANY', 'EXISTS', 'RECURSIVE', 'SAMPLE', 'USING SAMPLE', 'GROUP BY ALL', 'ORDER BY ALL', 'LATERAL', 'UNNEST'];

export const SQL_FUNCTIONS = [
  ['count', 'count(x) — number of non-null values; count(*) counts rows'], ['sum', 'sum(x)'], ['avg', 'avg(x) — mean'], ['min', 'min(x)'], ['max', 'max(x)'],
  ['median', 'median(x)'], ['mode', 'mode(x) — most frequent value'], ['quantile_cont', 'quantile_cont(x, 0.9) — interpolated quantile'], ['quantile_disc', 'quantile_disc(x, 0.5)'],
  ['stddev', 'stddev(x)'], ['variance', 'variance(x)'], ['corr', 'corr(y, x)'], ['regr_slope', 'regr_slope(y, x)'], ['approx_count_distinct', 'approx_count_distinct(x) — HyperLogLog'],
  ['arg_max', 'arg_max(value, by) — value at the max of by'], ['arg_min', 'arg_min(value, by)'], ['first', 'first(x)'], ['last', 'last(x)'], ['any_value', 'any_value(x)'],
  ['list', 'list(x) — collect into a list'], ['string_agg', "string_agg(x, ', ')"], ['histogram', 'histogram(x) — map of value → count'], ['bool_and', 'bool_and(x)'], ['bool_or', 'bool_or(x)'],
  ['row_number', 'row_number() OVER (…)'], ['rank', 'rank() OVER (…)'], ['dense_rank', 'dense_rank() OVER (…)'], ['ntile', 'ntile(4) OVER (…)'], ['lag', 'lag(x, 1) OVER (…)'], ['lead', 'lead(x, 1) OVER (…)'], ['percent_rank', 'percent_rank() OVER (…)'], ['cume_dist', 'cume_dist() OVER (…)'],
  ['coalesce', 'coalesce(a, b, …) — first non-null'], ['nullif', 'nullif(a, b)'], ['ifnull', 'ifnull(a, b)'], ['greatest', 'greatest(a, b, …)'], ['least', 'least(a, b, …)'],
  ['lower', 'lower(s)'], ['upper', 'upper(s)'], ['trim', 'trim(s)'], ['ltrim', 'ltrim(s)'], ['rtrim', 'rtrim(s)'], ['length', 'length(s)'], ['concat', 'concat(a, b, …)'], ['concat_ws', "concat_ws(', ', a, b)"],
  ['substring', 'substring(s, start, length)'], ['left', 'left(s, n)'], ['right', 'right(s, n)'], ['replace', 'replace(s, from, to)'], ['split_part', "split_part(s, ',', 1)"], ['string_split', "string_split(s, ',') — list"],
  ['regexp_matches', 'regexp_matches(s, pattern)'], ['regexp_extract', 'regexp_extract(s, pattern, group)'], ['regexp_replace', "regexp_replace(s, pattern, repl, 'g')"], ['contains', 'contains(s, part)'], ['starts_with', 'starts_with(s, prefix)'], ['ends_with', 'ends_with(s, suffix)'],
  ['strip_accents', 'strip_accents(s)'], ['levenshtein', 'levenshtein(a, b)'], ['jaro_winkler_similarity', 'jaro_winkler_similarity(a, b)'], ['md5', 'md5(s)'], ['hash', 'hash(x)'], ['format', "format('{} — {}', a, b)"], ['printf', "printf('%.2f', x)"], ['lpad', "lpad(s, 6, '0')"], ['rpad', 'rpad(s, n, c)'],
  ['round', 'round(x, digits)'], ['floor', 'floor(x)'], ['ceil', 'ceil(x)'], ['abs', 'abs(x)'], ['sqrt', 'sqrt(x)'], ['ln', 'ln(x)'], ['log10', 'log10(x)'], ['pow', 'pow(x, y)'], ['random', 'random()'],
  ['date_trunc', "date_trunc('month', d)"], ['date_part', "date_part('year', d)"], ['date_diff', "date_diff('day', a, b)"], ['date_add', "date_add(d, INTERVAL 1 DAY)"], ['strftime', "strftime(d, '%Y-%m-%d')"], ['strptime', "strptime(s, '%d/%m/%Y')"],
  ['try_strptime', "try_strptime(s, '%d/%m/%Y') — NULL when it doesn't match"], ['make_date', 'make_date(y, m, d)'], ['current_date', 'current_date'], ['now', 'now()'], ['year', 'year(d)'], ['month', 'month(d)'], ['day', 'day(d)'], ['dayname', 'dayname(d)'], ['monthname', 'monthname(d)'], ['week', 'week(d)'], ['quarter', 'quarter(d)'], ['epoch', 'epoch(ts) — seconds'],
  ['generate_series', 'generate_series(1, 10)'], ['range', 'range(1, 10)'], ['unnest', 'unnest(list)'], ['list_value', 'list_value(a, b)'], ['len', 'len(list)'], ['list_contains', 'list_contains(list, x)'], ['struct_pack', 'struct_pack(a := 1)'],
  ['json_extract', "json_extract(j, '$.path')"], ['json_extract_string', "json_extract_string(j, '$.path')"], ['to_json', 'to_json(x)'], ['typeof', 'typeof(x)'], ['try_cast', 'try_cast(x AS INTEGER)'],
];

export const SQL_SNIPPETS = [
  { label: 'Group & count', sql: 'SELECT region, COUNT(*) AS n, SUM(quantity) AS qty\nFROM input\nGROUP BY ALL\nORDER BY n DESC' },
  { label: 'Top N per group', sql: 'SELECT *\nFROM input\nQUALIFY row_number() OVER (PARTITION BY region ORDER BY unit_price DESC) <= 3' },
  { label: 'Deduplicate', sql: 'SELECT DISTINCT ON (customer) *\nFROM input\nORDER BY customer, order_date DESC' },
  { label: 'Pivot', sql: 'PIVOT input\nON region\nUSING SUM(quantity)\nGROUP BY category' },
  { label: 'Unpivot', sql: 'UNPIVOT input\nON COLUMNS(* EXCLUDE (order_id))\nINTO NAME attribute VALUE value' },
  { label: 'Profile every column', sql: 'SUMMARIZE input' },
  { label: 'Running total', sql: 'SELECT *, SUM(quantity) OVER (ORDER BY order_date ROWS UNBOUNDED PRECEDING) AS running_qty\nFROM input' },
  { label: 'Month buckets', sql: "SELECT date_trunc('month', order_date) AS month, COUNT(*) AS orders\nFROM input\nGROUP BY ALL\nORDER BY month" },
  { label: 'Fuzzy match', sql: 'SELECT a.*, b.*\nFROM input a\nJOIN other b ON jaro_winkler_similarity(lower(a.name), lower(b.name)) > 0.9' },
];

const KW_SET = new Set(SQL_KEYWORDS.flatMap(k => k.split(' ')).map(k => k.toLowerCase()).concat(['by', 'group', 'order', 'left', 'right', 'full', 'inner', 'outer', 'cross', 'asof', 'positional', 'anti', 'semi', 'nulls', 'first', 'last', 'partition', 'unbounded', 'preceding', 'following', 'current', 'row', 'into', 'name', 'value', 'on', 'using', 'integer', 'bigint', 'double', 'varchar', 'date', 'timestamp', 'boolean', 'decimal', 'text']));
const FN_SET = new Set(SQL_FUNCTIONS.map(f => f[0]));
const TOKEN = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_][\w$]*)|(\s+)|([\s\S])/g;

export function highlightSql(src, { tables = [], columns = [] } = {}) {
  const tset = new Set(tables.map(t => t.toLowerCase()));
  const cset = new Set(columns.map(c => c.toLowerCase()));
  let out = '';
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src))) {
    const [tok, comment, str, ident, num, word] = m;
    const e = escapeHtml(tok);
    if (comment) out += `<span class="sq-c">${e}</span>`;
    else if (str) out += `<span class="sq-s">${e}</span>`;
    else if (ident) out += `<span class="${cset.has(tok.slice(1, -1).toLowerCase()) ? 'sq-col' : tset.has(tok.slice(1, -1).toLowerCase()) ? 'sq-t' : 'sq-i'}">${e}</span>`;
    else if (num) out += `<span class="sq-n">${e}</span>`;
    else if (word) {
      const lw = word.toLowerCase();
      const next = src.slice(TOKEN.lastIndex).match(/^\s*\(/);
      if (tset.has(lw)) out += `<span class="sq-t">${e}</span>`;
      else if (next && (FN_SET.has(lw) || !KW_SET.has(lw))) out += `<span class="sq-f">${e}</span>`;
      else if (KW_SET.has(lw)) out += `<span class="sq-k">${e}</span>`;
      else if (cset.has(lw)) out += `<span class="sq-col">${e}</span>`;
      else out += e;
    } else out += e;
  }
  return out + '\n';
}

const needsQuote = (n) => !/^[a-z_][a-z0-9_]*$/.test(n) || KW_SET.has(n.toLowerCase());
const ident = (n) => (needsQuote(n) ? `"${n.replace(/"/g, '""')}"` : n);

export function sqlEditor({ value = '', placeholder = '', rows = 8, getContext = () => ({}), onChange, onRun, fkey, autofocus = false, label = 'SQL' } = {}) {
  const root = el('div', { class: 'sqled' });
  const hl = el('pre', { class: 'sqled-hl', 'aria-hidden': 'true' });
  const ta = el('textarea', { class: 'sqled-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', rows: String(rows), placeholder, 'aria-label': label, dataset: fkey ? { fkey } : null, autofocus: autofocus || null });
  ta.value = value;
  const pop = el('div', { class: 'sqled-pop', role: 'listbox', hidden: true });
  const gutter = el('div', { class: 'sqled-gutter', 'aria-hidden': 'true' });
  const body = el('div', { class: 'sqled-body' }, hl, ta);
  root.append(gutter, body, pop);
  root.style.setProperty('--rows', rows);

  const paint = () => {
    const ctx = getContext();
    hl.innerHTML = highlightSql(ta.value, { tables: ctx.tables || [], columns: (ctx.columns || []).map(c => c.name) });
    const lines = ta.value.split('\n').length;
    if (gutter.childElementCount !== lines) { clear(gutter); for (let i = 1; i <= lines; i++) gutter.appendChild(el('span', {}, String(i))); }
    syncScroll();
  };
  const syncScroll = () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gutter.scrollTop = ta.scrollTop; };

  let items = [], idx = 0, tokStart = 0;
  const close = () => { pop.hidden = true; items = []; };
  const suggest = (force = false) => {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = /("?)([\w$]*)$/.exec(before);
    const quoted = m[1] === '"';
    const word = m[2];
    const prefix = before.slice(0, before.length - m[0].length);
    const dot = /([\w"]+)\.$/.exec(prefix);
    if (!force && word.length < 1 && !dot) { close(); return; }
    if (/'[^']*$/.test(before.replace(/'[^']*'/g, ''))) { close(); return; }
    tokStart = pos - m[0].length;
    const ctx = getContext();
    const lw = word.toLowerCase();
    const cols = (ctx.columns || []).filter(c => c.name.toLowerCase().includes(lw)).sort((a, b) => (b.name.toLowerCase().startsWith(lw) - a.name.toLowerCase().startsWith(lw)));
    const out = [];
    for (const c of cols.slice(0, 10)) out.push({ kind: TYPE_BADGES[c.type] || 'col', label: c.name, insert: quoted ? `"${c.name.replace(/"/g, '""')}"` : ident(c.name), cls: 'col' });
    if (!dot) {
      for (const t of (ctx.tables || []).filter(t => t.toLowerCase().startsWith(lw)).slice(0, 6)) out.push({ kind: 'tbl', label: t, insert: t, cls: 'tbl' });
      if (!quoted && lw) {
        for (const [f, doc] of SQL_FUNCTIONS.filter(([f]) => f.startsWith(lw)).slice(0, 6)) out.push({ kind: 'fn', label: `${f}()`, insert: `${f}(`, doc, cls: 'fn' });
        for (const k of SQL_KEYWORDS.filter(k => k.toLowerCase().startsWith(lw) && k.toLowerCase() !== lw).slice(0, 5)) out.push({ kind: 'kw', label: k, insert: k + ' ', cls: 'kw' });
      }
    }
    items = out;
    if (!items.length) { close(); return; }
    idx = 0;
    draw();
  };
  const draw = () => {
    clear(pop);
    items.forEach((it, i) => pop.appendChild(el('div', { class: `sqled-item is-${it.cls}${i === idx ? ' is-on' : ''}`, role: 'option', 'aria-selected': String(i === idx), onmousedown: (e) => { e.preventDefault(); pick(i); } },
      el('span', { class: 'sqled-kind' }, it.kind), el('span', { class: 'sqled-label' }, it.label), it.doc ? el('span', { class: 'sqled-doc' }, it.doc) : null)));
    const caret = caretXY();
    pop.style.left = `${Math.min(caret.x, Math.max(0, root.clientWidth - 300))}px`;
    pop.style.top = `${caret.y + 22}px`;
    pop.hidden = false;
    pop.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' });
  };
  const caretXY = () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const lines = before.split('\n');
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 19;
    const cw = measureChar(cs.font);
    return { x: gutter.offsetWidth + parseFloat(cs.paddingLeft) + lines[lines.length - 1].length * cw - ta.scrollLeft, y: parseFloat(cs.paddingTop) + (lines.length - 1) * lh - ta.scrollTop };
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    let end = ta.selectionStart;
    while (end < ta.value.length && /[\w$"]/.test(ta.value[end])) end++;
    ta.value = ta.value.slice(0, tokStart) + it.insert + ta.value.slice(end);
    const np = tokStart + it.insert.length;
    ta.setSelectionRange(np, np);
    close();
    emit();
  };
  const emit = () => { paint(); onChange?.(ta.value); };
  const insertText = (text) => {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.focus();
    ta.setSelectionRange(s + text.length, s + text.length);
    emit();
  };

  ta.addEventListener('input', () => { emit(); suggest(false); });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('blur', () => setTimeout(close, 140));
  ta.addEventListener('keydown', (e) => {
    if (modKey(e) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); onRun?.(ta.value); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); suggest(true); return; }
    if (!pop.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; draw(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; draw(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(idx); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insertText('  '); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      const s = ta.selectionStart;
      const line = ta.value.slice(0, s).split('\n').pop();
      const indent = (/^\s*/.exec(line) || [''])[0];
      if (indent) { e.preventDefault(); insertText('\n' + indent); }
    }
    if (modKey(e) && e.key === '/') {
      e.preventDefault();
      const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const le = v.indexOf('\n', en); const lend = le < 0 ? v.length : le;
      const block = v.slice(ls, lend).split('\n');
      const all = block.every(l => /^\s*--/.test(l) || !l.trim());
      const nb = block.map(l => (all ? l.replace(/^(\s*)-- ?/, '$1') : l.trim() ? `-- ${l}` : l)).join('\n');
      ta.value = v.slice(0, ls) + nb + v.slice(lend);
      ta.setSelectionRange(ls, ls + nb.length);
      emit();
    }
  });
  paint();
  root.textarea = ta;
  root.insert = insertText;
  root.setValue = (v) => { ta.value = v; emit(); };
  root.getValue = () => ta.value;
  root.repaint = paint;
  return root;
}

let charCache = new Map();
function measureChar(font) {
  if (charCache.has(font)) return charCache.get(font);
  const c = document.createElement('canvas').getContext('2d');
  c.font = font;
  const w = c.measureText('MMMMMMMMMM').width / 10 || 7.4;
  charCache.set(font, w);
  return w;
}
