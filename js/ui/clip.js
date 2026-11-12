import { el, copyText, isMac } from './dom.js';
import { modal, toast } from './overlay.js';

export async function copyWithFeedback(text, label = 'Text', { message } = {}) {
  const ok = await copyText(text);
  if (ok) { toast(message || `${label} copied`, { kind: message ? 'info' : 'success', duration: message ? 6500 : undefined }); return true; }
  const area = el('textarea', { class: 'input copy-fallback', readonly: true, rows: '8', spellcheck: 'false' });
  area.value = text;
  const m = modal({
    title: `Copy ${label}`, width: 560,
    body: [el('p', { class: 'modal-text' }, `Your browser blocked copying. Press ${isMac ? '⌘' : 'Ctrl'}+C to copy.`), area],
    footer: [el('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Close')],
  });
  requestAnimationFrame(() => { area.focus(); area.select(); });
  return false;
}
