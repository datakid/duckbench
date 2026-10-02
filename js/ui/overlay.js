import { el, $, clear } from './dom.js';
import { icon } from './icons.js';

const stack = [];

function onKey(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); top.close(); return; }
  if (e.key === 'Tab' && top.trap) {
    const f = [...top.node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(n => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function onDown(e) {
  const top = stack[stack.length - 1];
  if (!top || !top.light) return;
  if (top.node.contains(e.target)) return;
  if (top.anchor && top.anchor.contains && top.anchor.contains(e.target)) { e.stopPropagation(); e.preventDefault(); top.close(); return; }
  top.close();
}

function push(entry) {
  if (!stack.length) {
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
  }
  stack.push(entry);
}

function pop(entry) {
  const i = stack.indexOf(entry);
  if (i < 0) return;
  stack.splice(i, 1);
  if (!stack.length) {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
  }
}

export function hasOverlay() { return stack.length > 0; }
export function closeLightOverlays() { while (stack.length && stack[stack.length - 1].light) stack[stack.length - 1].close(); }

export function modal({ title, body, footer, width = 520, className = '', onClose, dismissable = true, icon: ic }) {
  const prevFocus = document.activeElement;
  const box = el('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog', style: { width: `min(${width}px, calc(100vw - 32px))` } });
  const head = title ? el('header', { class: 'modal-head' },
    ic ? icon(ic, 18) : null,
    el('h2', { class: 'modal-title' }, title),
    dismissable ? el('button', { class: 'icon-btn modal-x', 'aria-label': 'Close', onclick: () => entry.close() }, icon('x', 16)) : null) : null;
  const content = el('div', { class: 'modal-body' });
  if (body) content.append(...[].concat(body));
  const foot = footer ? el('footer', { class: 'modal-foot' }, ...[].concat(footer)) : null;
  box.append(...[head, content, foot].filter(Boolean));
  const backdrop = el('div', { class: 'modal-backdrop' }, box);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && dismissable) entry.close(); });
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  let closed = false;
  const entry = {
    node: box, trap: true, light: false,
    close: (result) => {
      if (closed) return;
      if (!dismissable && result === undefined) return;
      closed = true;
      pop(entry);
      backdrop.classList.remove('is-open');
      setTimeout(() => backdrop.remove(), 160);
      if (onClose) onClose(result);
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    },
    body: content, box, footer: foot,
  };
  push(entry);
  requestAnimationFrame(() => {
    const auto = box.querySelector('[autofocus]') || box.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea') || box.querySelector('.modal-foot .btn-primary') || box;
    if (auto === box) box.tabIndex = -1;
    auto.focus();
    if (auto.select && auto.type === 'text') auto.select();
  });
  return entry;
}

export function confirmDialog(message, { title = 'Are you sure?', ok = 'Confirm', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title, width: 420,
      body: el('p', { class: 'modal-text' }, message),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => m.close(false) }, cancel),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { result = true; m.close(true); } }, ok),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(message, { title = '', value = '', ok = 'OK', placeholder = '', validate } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = el('input', { class: 'input', type: 'text', value, placeholder, autofocus: true });
    const err = el('p', { class: 'field-error', hidden: true });
    const submit = () => {
      const v = input.value.trim();
      const e = validate ? validate(v) : (v ? null : 'Enter a value.');
      if (e) { err.textContent = e; err.hidden = false; return; }
      result = v; m.close(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const m = modal({
      title: title || message, width: 420,
      body: [title ? el('p', { class: 'modal-text' }, message) : null, input, err].filter(Boolean),
      footer: [el('button', { class: 'btn btn-ghost', onclick: () => m.close(null) }, 'Cancel'), el('button', { class: 'btn btn-primary', onclick: submit }, ok)],
      onClose: () => resolve(result),
    });
  });
}

function placeNear(node, anchor, { align = 'start', side = 'bottom', offset = 4, x, y } = {}) {
  node.style.visibility = 'hidden';
  node.style.left = '0px'; node.style.top = '0px';
  document.body.appendChild(node);
  const nr = node.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left, top;
  if (x != null) { left = x; top = y; }
  else {
    const r = anchor.getBoundingClientRect();
    if (side === 'right') { left = r.right + offset; top = r.top; }
    else { left = align === 'end' ? r.right - nr.width : r.left; top = r.bottom + offset; if (top + nr.height > vh - 8 && r.top - nr.height - offset > 8) top = r.top - nr.height - offset; }
  }
  if (left + nr.width > vw - 8) left = Math.max(8, (x != null ? x - nr.width : vw - nr.width - 8));
  if (top + nr.height > vh - 8) top = Math.max(8, vh - nr.height - 8);
  node.style.left = `${Math.round(Math.max(8, left))}px`;
  node.style.top = `${Math.round(Math.max(8, top))}px`;
  node.style.visibility = '';
}

export function popover(anchor, content, opts = {}) {
  const node = el('div', { class: `popover ${opts.className || ''}`, role: opts.role || 'dialog' });
  node.append(...[].concat(content));
  placeNear(node, anchor, opts);
  let closed = false;
  const entry = {
    node, light: true, anchor, trap: false,
    close: () => { if (closed) return; closed = true; pop(entry); node.remove(); opts.onClose?.(); },
    reposition: () => { node.remove(); placeNear(node, anchor, opts); },
  };
  push(entry);
  if (opts.focus !== false) requestAnimationFrame(() => (node.querySelector('[autofocus]') || node.querySelector('input, button, [tabindex]'))?.focus());
  return entry;
}

export function menu(anchor, items, opts = {}) {
  const node = el('div', { class: 'menu', role: 'menu' });
  let entry;
  let sub = null;
  const closeSub = () => { if (sub) { sub.close(); sub = null; } };
  const build = (list, container) => {
    for (const it of list) {
      if (!it) continue;
      if (it === '-' || it.divider) { container.appendChild(el('div', { class: 'menu-sep', role: 'separator' })); continue; }
      if (it.header) { container.appendChild(el('div', { class: 'menu-header' }, it.header)); continue; }
      const btn = el('button', { class: `menu-item${it.danger ? ' is-danger' : ''}${it.checked ? ' is-checked' : ''}`, role: 'menuitem', disabled: it.disabled, title: it.title || null },
        el('span', { class: 'menu-ico' }, it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 14) : null),
        el('span', { class: 'menu-label' }, it.label),
        it.hint ? el('span', { class: 'menu-hint' }, it.hint) : null,
        it.items ? el('span', { class: 'menu-sub' }, icon('chevron-right', 12)) : null);
      if (it.items) {
        const open = () => {
          closeSub();
          const subNode = el('div', { class: 'menu', role: 'menu' });
          build(it.items, subNode);
          placeNear(subNode, btn, { side: 'right', offset: 2 });
          sub = { node: subNode, close: () => subNode.remove() };
          subNode.addEventListener('mousedown', (e) => e.stopPropagation());
        };
        btn.addEventListener('mouseenter', open);
        btn.addEventListener('click', open);
        btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { open(); sub?.node.querySelector('button')?.focus(); } });
      } else {
        btn.addEventListener('mouseenter', () => { if (sub && !sub.node.contains(btn)) closeSub(); });
        btn.addEventListener('click', () => { closeSub(); entry.close(); it.onClick?.(); });
      }
      container.appendChild(btn);
    }
  };
  build(items, node);
  node.addEventListener('keydown', (e) => {
    const btns = [...(e.target.closest('.menu') || node).querySelectorAll('.menu-item:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    else if (e.key === 'ArrowLeft' && sub) { closeSub(); }
  });
  placeNear(node, anchor, opts);
  let closed = false;
  entry = {
    node, light: true, anchor: opts.x != null ? null : anchor,
    close: () => { if (closed) return; closed = true; closeSub(); pop(entry); node.remove(); opts.onClose?.(); },
  };
  const origContains = node.contains.bind(node);
  entry.node = { contains: (t) => origContains(t) || (sub && sub.node.contains(t)), querySelectorAll: (s) => node.querySelectorAll(s) };
  push(entry);
  requestAnimationFrame(() => node.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true }));
  return entry;
}

let toastHost = null;
export function toast(message, { kind = 'info', action, onAction, duration } = {}) {
  if (!toastHost) { toastHost = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastHost); }
  const t = el('div', { class: `toast toast-${kind}` },
    icon(kind === 'error' ? 'warn' : kind === 'success' ? 'check' : 'info', 15),
    el('span', { class: 'toast-msg' }, message),
    action ? el('button', { class: 'toast-action', onclick: () => { onAction?.(); dismiss(); } }, action) : null,
    el('button', { class: 'toast-x', 'aria-label': 'Dismiss', onclick: () => dismiss() }, icon('x', 12)));
  toastHost.appendChild(t);
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('is-in'));
  const ms = duration ?? (action ? 6500 : kind === 'error' ? 6000 : 3200);
  let timer = setTimeout(dismiss, ms);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1800); });
  function dismiss() { clearTimeout(timer); t.classList.remove('is-in'); setTimeout(() => t.remove(), 200); }
  return dismiss;
}

export function tooltip(node, text) { node.setAttribute('title', text); }
