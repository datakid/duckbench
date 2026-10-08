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

async function readZipEntry(file, wanted) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const cdSize = tv.getUint32(eocd + 12, true), cdOff = tv.getUint32(eocd + 16, true);
  if (cdOff === 0xFFFFFFFF || cdOff + cdSize > file.size) return null;
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dv = new DataView(cd.buffer);
  const dec = new TextDecoder();
  let p = 0;
  while (p + 46 <= cd.length && dv.getUint32(p, true) === 0x02014b50) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    if (name === wanted) {
      const lh = new DataView(await file.slice(off, off + 30).arrayBuffer());
      const start = off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const data = new Uint8Array(await file.slice(start, start + csize).arrayBuffer());
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      return null;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

export async function listSheets(file) {
  const data = await readZipEntry(file, 'xl/workbook.xml');
  if (!data) return [];
  const xml = new TextDecoder().decode(data);
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
}
