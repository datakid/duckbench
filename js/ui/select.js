import { el } from './dom.js';
import { icon } from './icons.js';
import { popover } from './overlay.js';

const coarse = () => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } };

function open(sel) {
  const opts = [...sel.options].filter(o => !o.hidden && !(o.disabled && o.value === ''));
  if (!opts.length) return;
  const w = Math.round(sel.getBoundingClientRect().width);
  const list = el('div', { class: 'sel-list', role: 'listbox', tabindex: '-1', 'aria-label': sel.getAttribute('aria-label') || 'Options', style: { minWidth: `${w}px` } });
  let idx = opts.findIndex(o => o.selected);
  if (idx < 0) idx = opts.findIndex(o => !o.disabled);
  const btns = opts.map((o, i) => {
    const b = el('button', { type: 'button', class: `sel-opt${o.selected ? ' is-selected' : ''}`, role: 'option', 'aria-selected': String(o.selected), disabled: o.disabled, tabindex: '-1' },
      el('span', { class: 'sel-check' }, o.selected ? icon('check', 13) : null),
      el('span', { class: 'sel-label' }, o.textContent));
    b.addEventListener('click', () => pick(i));
    b.addEventListener('mousemove', () => { if (idx !== i && !o.disabled) { idx = i; paint(false); } });
    return b;
  });
  list.append(...btns);
  const paint = (scroll = true) => { btns.forEach((b, i) => b.classList.toggle('is-active', i === idx)); if (scroll) btns[idx]?.scrollIntoView({ block: 'nearest' }); };
  const step = (d) => { let j = idx; for (let k = 0; k < opts.length; k++) { j = Math.max(0, Math.min(opts.length - 1, j + d)); if (!opts[j].disabled) { idx = j; break; } } paint(); };
  let typed = '', typedAt = 0;
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); idx = -1; step(1); }
    else if (e.key === 'End') { e.preventDefault(); idx = opts.length; step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(idx); }
    else if (e.key === 'Tab') { e.preventDefault(); entry.close(); }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const t = performance.now();
      typed = t - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = t;
      const j = opts.findIndex(o => !o.disabled && o.textContent.trim().toLowerCase().startsWith(typed));
      if (j >= 0) { idx = j; paint(); }
    }
  });
  const pick = (i) => {
    const o = opts[i];
    if (!o || o.disabled) return;
    entry.close();
    if (sel.selectedIndex !== o.index) {
      sel.selectedIndex = o.index;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  sel.classList.add('is-open');
  const entry = popover(sel, list, { className: 'select-pop', role: 'presentation', focus: false, onClose: () => { sel.classList.remove('is-open'); if (document.contains(sel)) sel.focus({ preventScroll: true }); } });
  requestAnimationFrame(() => { list.focus({ preventScroll: true }); paint(); });
}

export function enhanceSelects() {
  const eligible = (sel) => sel && !sel.multiple && !(sel.size > 1) && !sel.disabled && !coarse();
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const sel = e.target.closest?.('select');
    if (!eligible(sel)) return;
    e.preventDefault();
    sel.focus({ preventScroll: true });
    open(sel);
  });
  document.addEventListener('keydown', (e) => {
    const sel = e.target;
    if (!(sel instanceof HTMLSelectElement) || !eligible(sel)) return;
    if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); open(sel); }
  });
}
