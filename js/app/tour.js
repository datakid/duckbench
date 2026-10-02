import { el, $ } from '../ui/dom.js';
import { prefs } from './store.js';

const STEPS = [
  { target: '#queriesPanel', title: 'Queries', text: 'Each imported file is a query. Reference, duplicate or join them from the query menu.', place: 'right' },
  { target: '#stepList', title: 'Applied steps', text: 'Every change is a step. Click one to preview the data at that point and edit its settings. Drag to reorder.', place: 'right' },
  { target: '#ribbon', title: 'Transforms', text: 'Filter, reshape, split, join and more. Column headers and cells have context menus with the same actions.', place: 'bottom' },
  { target: '#gridHost', title: 'Preview', text: 'Double-click a header to rename, a cell to edit. The bar under each header shows how much of the column is filled.', place: 'left' },
  { target: '#paletteBtn', title: 'Actions', text: 'Search every step and command. ⌘K / Ctrl+K from anywhere.', place: 'bottom' },
  { target: '#exportBtn', title: 'Export', text: 'CSV, Excel, Parquet, JSON. Save a recipe to replay these steps on next month’s file.', place: 'bottom' },
];

let active = null;

export function maybeAutoTour() {
  if (prefs.get('tourDone', false)) return;
  setTimeout(() => startTour({}), 700);
}

export function startTour({ force = false } = {}) {
  if (active) return;
  if (!force && prefs.get('tourDone', false)) return;
  if ($('#workbench').hidden) {
    const btn = $('#sampleBtn');
    if (btn) { prefs.set('tourPending', true); btn.click(); }
    return;
  }
  const steps = STEPS.filter(s => { const n = document.querySelector(s.target); return n && n.offsetParent !== null; });
  if (!steps.length) return;
  let i = 0;
  const block = el('div', { class: 'tour-block' });
  const spot = el('div', { class: 'tour-spot' });
  const count = el('div', { class: 'tour-count' });
  const title = el('h3', {});
  const text = el('p', {});
  const back = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => go(i - 1) }, 'Back');
  const skip = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => end() }, 'Skip');
  const next = el('button', { class: 'btn btn-primary btn-sm', onclick: () => (i === steps.length - 1 ? end() : go(i + 1)) }, 'Next');
  const card = el('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tourTitle' }, count, title, text, el('div', { class: 'tour-actions' }, skip, back, next));
  title.id = 'tourTitle';
  document.body.append(block, spot, card);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); i === steps.length - 1 ? end() : go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(i - 1); }
  };
  const onResize = () => go(i);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  function go(k) {
    if (k < 0 || k >= steps.length) return;
    i = k;
    const s = steps[i];
    const n = document.querySelector(s.target);
    if (!n) { end(); return; }
    const r = n.getBoundingClientRect();
    const pad = 4;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    count.textContent = `${i + 1} / ${steps.length}`;
    title.textContent = s.title;
    text.textContent = s.text;
    back.disabled = i === 0;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    const cw = 300, ch = card.offsetHeight || 150, gap = 14, vw = innerWidth, vh = innerHeight;
    let x, y;
    if (s.place === 'right') { x = r.right + gap; y = r.top + Math.min(40, r.height / 3); }
    else if (s.place === 'left') { x = r.left + Math.min(r.width / 2, 340) - cw / 2; y = r.top + 60; }
    else { x = r.left; y = r.bottom + gap; }
    if (x + cw > vw - 12) x = Math.max(12, r.left - cw - gap);
    if (x < 12) x = 12;
    if (y + ch > vh - 12) y = Math.max(12, vh - ch - 12);
    Object.assign(card.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` });
    next.focus();
  }
  function end() {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    block.remove(); spot.remove(); card.remove();
    prefs.set('tourDone', true);
    prefs.set('tourPending', false);
    active = null;
  }
  active = { end };
  requestAnimationFrame(() => go(0));
}

export function resumePendingTour() {
  if (prefs.get('tourPending', false)) { prefs.set('tourPending', false); setTimeout(() => startTour({ force: true }), 600); }
}
