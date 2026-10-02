self.importScripts('../../vendor/xlsx-0.20.3.full.min.js', '../io/xlsx-core.js');

self.onmessage = (e) => {
  const { id, method, args } = e.data;
  try {
    const result = self.DuckXlsx.handle(self.XLSX, method, args);
    const transfer = result && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};

self.postMessage({ ready: true });
