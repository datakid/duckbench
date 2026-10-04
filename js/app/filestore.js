const DIR = 'duckbench_files';

export const opfsFilesAvailable = () => { try { return !!navigator.storage?.getDirectory; } catch { return false; } };

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function keepCopy(id, file, onProgress) {
  if (!opfsFilesAvailable()) return false;
  try {
    const est = await navigator.storage.estimate?.();
    if (est && est.quota - est.usage < file.size * 1.1) return false;
    try { await navigator.storage.persist?.(); } catch {}
    const d = await dir();
    const h = await d.getFileHandle(id, { create: true });
    if (typeof h.createWritable === 'function') {
      const w = await h.createWritable();
      let done = 0;
      const reader = file.stream().getReader();
      for (;;) { const { value, done: end } = await reader.read(); if (end) break; await w.write(value); done += value.length; onProgress?.(done / file.size); }
      await w.close();
      return true;
    }
    return false;
  } catch { return false; }
}

export async function getCopy(id, name) {
  if (!opfsFilesAvailable()) return null;
  try { const f = await (await (await dir()).getFileHandle(id)).getFile(); return new File([f], name || f.name, { type: f.type }); } catch { return null; }
}

export async function dropCopy(id) { try { await (await dir()).removeEntry(id); } catch {} }

export async function clearCopies(keep = []) {
  try { const d = await dir(); const ks = new Set(keep); for await (const n of d.keys()) if (!ks.has(n)) await d.removeEntry(n).catch(() => {}); } catch {}
}

export async function listSheets(file) {
  const buf = new Uint8Array(await file.slice(Math.max(0, file.size - 65557 - 1024 * 1024)).arrayBuffer());
  const { unzipEntries } = await import('../io/zip.js');
  const all = await unzipEntries(new Blob([await file.arrayBuffer()]));
  const wb = all.find(e => e.name === 'xl/workbook.xml');
  if (!wb || !buf.length) return [];
  const xml = new TextDecoder().decode(wb.data);
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
}
