import { el, isMac } from './dom.js';
import { menu, toast } from './overlay.js';

const TIP_DELAY = 420;
let tipNode = null;
let tipTimer = null;
let tipOwner = null;

function tipEl() {
  if (!tipNode) {
    tipNode = el('div', { class: 'tip', role: 'tooltip' });
    document.body.appendChild(tipNode);
  }
  return tipNode;
}

function claim(node) {
  const t = node.getAttribute('title');
  if (t != null) {
    node.removeAttribute('title');
    if (t.trim()) node.dataset.tip = t;
    else delete node.dataset.tip;
    if (t.trim() && !node.hasAttribute('aria-label') && !node.textContent.trim()) node.setAttribute('aria-label', t);
  }
  return node.dataset.tip || '';
}

function placeTip(node, target) {
  const r = target.getBoundingClientRect();
  node.style.left = '0px';
  node.style.top = '0px';
  const w = node.offsetWidth, h = node.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = r.left + r.width / 2 - w / 2;
  let top = r.bottom + 8;
  if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
  left = Math.max(8, Math.min(left, vw - w - 8));
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function showTip(target, text) {
  const node = tipEl();
  node.textContent = text;
  node.classList.add('is-on');
  placeTip(node, target);
  tipOwner = target;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  tipOwner = null;
  tipNode?.classList.remove('is-on');
}

export function installTips() {
  const over = (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const n = t.closest('[title],[data-tip]');
    if (!n) { if (tipOwner) hideTip(); return; }
    const text = claim(n);
    if (!text) { hideTip(); return; }
    if (n === tipOwner) return;
    hideTip();
    tipTimer = setTimeout(() => { if (document.contains(n)) showTip(n, text); }, TIP_DELAY);
  };
  document.addEventListener('pointerover', over, true);
  document.addEventListener('pointermove', over, true);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); }, true);
  document.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);
  document.addEventListener('focusin', (e) => {
    const n = e.target?.closest?.('[title],[data-tip]');
    if (!n) return;
    const text = claim(n);
    if (!text) return;
    let visible = false;
    try { visible = n.matches(':focus-visible'); } catch {}
    if (visible) { clearTimeout(tipTimer); showTip(n, text); }
  });
  document.addEventListener('focusout', hideTip);
}

const TEXT_FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]), textarea';

function fireInput(field) { field.dispatchEvent(new Event('input', { bubbles: true })); }

async function clipboardReadable() {
  try {
    if (!navigator.clipboard?.readText || !navigator.permissions?.query) return false;
    const s = await navigator.permissions.query({ name: 'clipboard-read' });
    return s.state === 'granted';
  } catch { return false; }
}

async function openEditMenu(field, e) {
  const start = field.selectionStart ?? 0, end = field.selectionEnd ?? 0;
  const hasSel = end > start;
  const readOnly = field.readOnly || field.disabled;
  const canRead = await clipboardReadable();
  const writeBack = (text, s, en) => { field.focus(); field.setRangeText(text, s, en, 'end'); fireInput(field); };
  const mod = isMac ? '⌘' : 'Ctrl';
  menu(field, [
    { label: 'Cut', hint: `${mod}+X`, disabled: !hasSel || readOnly, onClick: async () => { const t = field.value.slice(start, end); try { await navigator.clipboard.writeText(t); } catch { document.execCommand?.('copy'); } writeBack('', start, end); } },
    { label: 'Copy', hint: `${mod}+C`, disabled: !hasSel, onClick: async () => { field.focus(); field.setSelectionRange(start, end); const t = field.value.slice(start, end); try { await navigator.clipboard.writeText(t); } catch { document.execCommand?.('copy'); } } },
    { label: 'Paste', hint: `${mod}+V`, disabled: readOnly, onClick: async () => { if (canRead) { try { writeBack(await navigator.clipboard.readText(), start, end); return; } catch {} } field.focus(); toast(`Press ${mod}+V to paste.`); } },
    '-',
    { label: 'Select all', hint: `${mod}+A`, onClick: () => { field.focus(); field.select(); } },
  ], { x: e.clientX, y: e.clientY });
}

export function installContextGuard() {
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || e.shiftKey) return;
    const field = e.target?.closest?.(TEXT_FIELD);
    e.preventDefault();
    if (field) openEditMenu(field, e);
  });
}

export function hardenField(n) {
  if (!n || !n.tagName) return n;
  const tag = n.tagName;
  if (tag === 'TEXTAREA' || (tag === 'INPUT' && n.type !== 'file' && n.type !== 'checkbox' && n.type !== 'radio')) {
    if (!n.hasAttribute('spellcheck')) n.setAttribute('spellcheck', 'false');
    if (!n.hasAttribute('autocomplete')) n.setAttribute('autocomplete', 'off');
    if (!n.hasAttribute('autocapitalize')) n.setAttribute('autocapitalize', 'off');
    if (!n.hasAttribute('autocorrect')) n.setAttribute('autocorrect', 'off');
  }
  return n;
}

export function installFieldGuard() {
  document.querySelectorAll('input, textarea').forEach(hardenField);
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        hardenField(n);
        n.querySelectorAll?.('input, textarea').forEach(hardenField);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

export function installNativeGuards() {
  installTips();
  installContextGuard();
  installFieldGuard();
}
