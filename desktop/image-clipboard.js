import fs from 'node:fs/promises';
import path from 'node:path';
import { isXhsImageUrl, normalizeImageUrl } from '../lib/xhs.js';
import { downloadMedia, safeFilename } from './media-download.js';

export const MAX_DESKTOP_CLIPBOARD_IMAGES = 50;
const CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;

function selection(input) {
  if (!input || !Array.isArray(input.images) || !input.images.length
    || input.images.length > MAX_DESKTOP_CLIPBOARD_IMAGES) {
    throw new Error(`请选择 1–${MAX_DESKTOP_CLIPBOARD_IMAGES} 张图片。`);
  }
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 1000)) {
    throw new Error('笔记标题无效。');
  }
  const indices = new Set();
  return input.images.map(image => {
    if (!image || typeof image.url !== 'string' || image.url.length > 8192
      || !isXhsImageUrl(image.url) || !Number.isSafeInteger(image.index)
      || image.index < 1 || image.index > 10000 || indices.has(image.index)) {
      throw new Error('所选图片链接或序号无效，请重新解析笔记。');
    }
    indices.add(image.index);
    return { url: normalizeImageUrl(image.url), index: image.index };
  });
}

// Files must outlive the renderer and app: native file clipboard formats contain
// paths, not their contents. Prune only after a subsequent successful copy, never
// on shutdown/startup or on a failed request that leaves the old clipboard intact.
export class NativeImageClipboard {
  constructor({ directory, fetchImpl = fetch, writeFiles, writeImage,
    authorize = async () => {}, onProgress = () => {}, platform = process.platform,
    now = () => Date.now(), maxImageBytes = 30 * 1024 ** 2,
    maxTotalBytes = 120 * 1024 ** 2, timeoutMs = 20000 }) {
    Object.assign(this, { directory, fetchImpl, writeFiles, writeImage, authorize,
      onProgress, platform, now, maxImageBytes, maxTotalBytes, timeoutMs });
    this.busy = false;
  }

  async copy(input) {
    const images = selection(input);
    if (!['darwin', 'win32'].includes(this.platform)) throw new Error('系统图片复制目前支持 macOS 和 Windows。');
    if (this.busy) throw new Error('正在准备上一批图片，请稍候再复制。');
    this.busy = true;
    let batch;
    let committed = false;
    try {
      await this.authorize('single-download');
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const root = await fs.realpath(this.directory);
      batch = await fs.mkdtemp(path.join(root, 'batch-'));
      const title = safeFilename(input.title || '小红书图片', 48, 144);
      const files = [];
      let totalBytes = 0;
      this.progress(0, images.length, 'preparing');
      for (const image of images) {
        const remaining = this.maxTotalBytes - totalBytes;
        if (remaining <= 0) throw new Error('所选图片总大小超过复制上限，请减少勾选后重试。');
        const file = await downloadMedia({ root, directory: batch,
          asset: { key: `${String(image.index).padStart(3, '0')}-${title}`, kind: 'image', url: image.url },
          fetchImpl: this.fetchImpl, beforeRequest: async () => {},
          maxBytes: Math.min(this.maxImageBytes, remaining), timeoutMs: this.timeoutMs });
        totalBytes += file.bytes;
        files.push(path.join(batch, file.name));
        this.progress(files.length, images.length, 'preparing');
      }
      // Recheck membership after a slow download, before publishing its contents.
      await this.authorize('single-download');
      this.progress(images.length, images.length, 'writing');
      let kind = 'files';
      if (files.length === 1) {
        const result = await this.writeImage(files[0]);
        kind = result?.kind === 'files' ? 'files' : 'image';
      } else await this.writeFiles(files);
      committed = true;
      // Cleanup failure must not turn a successful clipboard write into an error.
      await this.prune(root, batch).catch(() => {});
      return { ok: true, count: files.length, kind };
    } finally {
      if (batch && !committed) await fs.rm(batch, { recursive: true, force: true }).catch(() => {});
      this.busy = false;
    }
  }

  progress(completed, total, phase) {
    try { this.onProgress({ completed, total, phase }); } catch { /* UI cannot interrupt copying. */ }
  }

  async prune(root, current) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^batch-[A-Za-z0-9]+$/.test(entry.name)) continue;
      const candidate = path.join(root, entry.name);
      if (candidate === current) continue;
      const stat = await fs.lstat(candidate);
      if (!stat.isSymbolicLink() && this.now() - stat.mtimeMs > CACHE_RETENTION_MS) {
        await fs.rm(candidate, { recursive: true, force: true });
      }
    }
  }
}
