import { runAll } from './suite.js';

try {
  const saved = JSON.parse(localStorage.getItem('duckbench2.theme') || 'null');
  if (saved ? saved === 'light' : matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.setAttribute('data-theme', 'light');
} catch {}

const list = document.getElementById('list');
const score = document.getElementById('score');
const results = await runAll((r) => {
  const li = document.createElement('li');
  li.className = `t-item${r.ok ? '' : ' is-bad'}`;
  li.innerHTML = `<span class="mark">${r.ok ? 'ok' : 'fail'}</span><span></span><span class="ms">${r.ms.toFixed(1)} ms</span>`;
  li.children[1].textContent = r.name;
  if (!r.ok) { const e = document.createElement('div'); e.className = 'err'; e.textContent = r.error; li.appendChild(e); }
  list.appendChild(li);
});
const passed = results.filter(r => r.ok).length;
score.textContent = `${passed}/${results.length}`;
score.className = `t-score ${passed === results.length ? 'is-ok' : 'is-bad'}`;
window.__selftest = { passed, total: results.length, failures: results.filter(r => !r.ok) };
for (const f of results.filter(r => !r.ok)) console.error(`FAIL ${f.name}: ${f.error}`);
console.log(`SELFTEST ${passed}/${results.length}`);
