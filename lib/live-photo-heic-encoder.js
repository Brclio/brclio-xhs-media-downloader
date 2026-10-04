// HEIC is encoded locally in a disposable worker, so software HEVC works on
// macOS, Windows, and supported browsers without exposing a native bridge.
const MAX_DIMENSION = 1440;
const ENCODING_TIMEOUT = 120000;

function cancelled(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('制作已取消。', 'AbortError');
}

export function encodeHeicCanvas(canvas, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(cancelled(signal));
  const width = canvas?.width, height = canvas?.height;
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_DIMENSION))
    return Promise.reject(new Error('HEIC 封面尺寸无效，最长边不能超过 1440 像素。'));
  if (typeof Worker !== 'function') return Promise.reject(new Error('当前浏览器不支持本地 HEIC 编码，请使用桌面客户端或新版 Chrome、Edge。'));
  let pixels;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('封面画面无法读取。');
    pixels = context.getImageData(0, 0, width, height).data;
  } catch (error) { return Promise.reject(new Error(`HEIC 封面读取失败：${error.message}`)); }

  return new Promise((resolve, reject) => {
    let worker, timer, completed = false;
    const finish = (error, data) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      // Termination releases all WASM memory after success, failure, and abort.
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
      error ? reject(error) : resolve(data);
    };
    const cancel = () => finish(cancelled(signal));
    try {
      worker = new Worker(new URL('./live-photo-heic-worker.js', import.meta.url), { type: 'module', name: 'live-photo-heic' });
      worker.onmessage = event => {
        if (event.data?.error) { finish(new Error(`HEIC 封面编码失败：${String(event.data.error).slice(0, 400)}`)); return; }
        const buffer = event.data?.buffer;
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24) { finish(new Error('HEIC 编码未返回完整文件。')); return; }
        finish(null, new Uint8Array(buffer));
      };
      worker.onerror = event => { event.preventDefault(); finish(new Error('本地 HEIC 编码器加载失败，请重试或更新客户端。')); };
      worker.onmessageerror = () => finish(new Error('本地 HEIC 编码结果无法读取，请重试。'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => finish(new Error('HEIC 封面编码超时，请重试或缩小素材。')), ENCODING_TIMEOUT);
      worker.postMessage({ width, height, rgba: pixels.buffer }, [pixels.buffer]);
    } catch (error) { finish(error); }
  });
}
