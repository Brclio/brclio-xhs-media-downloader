import fs from 'node:fs/promises';
import path from 'node:path';
import { isXhsVideoUrl } from '../lib/xhs.js';
import { isMemberVideoUrl } from '../lib/video-policy.js';
import { downloadMedia, safeFilename, assertSafeTarget, throwIfAborted, abortError } from './media-download.js';

function invalid(message) { return Object.assign(new Error(message), { code: 'VIDEO_INPUT_INVALID', status: 400 }); }

function selection(input) {
  if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw invalid('视频下载请求无效。');
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 1000)) throw invalid('视频标题无效。');
  if (input.filename !== undefined && (typeof input.filename !== 'string' || input.filename.length > 1000)) throw invalid('视频文件名无效。');
  const video = input.video;
  if (!video || typeof video !== 'object' || (video.backupUrls !== undefined && !Array.isArray(video.backupUrls))) throw invalid('视频信息无效，请重新解析。');
  const urls = [video.url, ...(video.backupUrls || [])];
  if (urls.length > 20 || urls.some(url => typeof url !== 'string' || url.length > 12020
    || !(url.startsWith('member-video:') ? /^member-video:[A-Za-z0-9_-]+$/.test(url) : isXhsVideoUrl(url) && new URL(url).protocol === 'https:'))) {
    throw invalid('视频链接无效，请重新解析。');
  }
  return { requestId: input.requestId, urls: [...new Set(urls)],
    filename: `${safeFilename((input.filename || input.title || '小红书视频').replace(/\.mp4$/i, ''), 100, 220)}.mp4`,
    requireAudio: input.requireAudio !== false, requiresMembership: video.requiresMembership === true };
}

function authorizationFailure(error) {
  return [401, 403].includes(error.status || error.statusCode)
    || /ACCOUNT|MEMBERSHIP|SESSION|AUTHORIZATION/.test(error.code || '');
}

async function abortable(promise, signal) {
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Downloads in the main process with bounded memory and an OS-approved target. */
export class NativeVideoDownload {
  constructor({ showSaveDialog, fetchImpl = fetch, authorize = async () => {}, ticketService,
    onProgress = () => {}, onDiagnostic = () => {} }) {
    Object.assign(this, { showSaveDialog, fetchImpl, authorize, ticketService, onProgress, onDiagnostic });
    this.requests = new Map();
    this.operations = new Set();
    this.stopping = false;
  }

  progress(requestId, value) {
    try { this.onProgress({ requestId, ...value }); } catch { /* UI cannot interrupt saving. */ }
  }

  save(input) {
    const operation = this.saveSelection(input);
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation));
    return operation;
  }

  async saveSelection(input) {
    let selected, controller, stage;
    try {
      if (this.stopping) throw Object.assign(new Error('客户端正在退出。'), { code: 'DOWNLOAD_SHUTDOWN' });
      selected = selection(input);
      if (this.requests.has(selected.requestId)) throw invalid('该视频正在下载，请稍候。');
      if (this.requests.size >= 4) throw invalid('同时下载的视频过多，请等待当前下载完成。');
      controller = new AbortController();
      this.requests.set(selected.requestId, controller);
      const { signal } = controller;
      await this.authorize('single-download');
      throwIfAborted(signal);
      let memberSession, activeTicket;
      const originalAuthorization = async () => {
        if (!memberSession) {
          if (!this.ticketService) throw Object.assign(new Error('会员视频服务暂不可用。'), { status: 503 });
          memberSession = await this.ticketService.session();
        }
        // Expiry is checked when a source ticket is resolved. A transfer already
        // admitted may continue for hours while its live account remains valid.
        await memberSession.recheck();
      };
      if (selected.requiresMembership || selected.urls.some(url => url.startsWith('member-video:') || isMemberVideoUrl(url))) {
        await originalAuthorization();
      }
      // A caller can supply media metadata, never an output path. Only the OS
      // dialog determines where the trusted process may publish the file.
      const choice = await abortable(this.showSaveDialog({ title: '保存视频', defaultPath: selected.filename,
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] }), signal);
      throwIfAborted(signal);
      if (choice?.canceled || !choice?.filePath) return { ok: true, cancelled: true };
      if (!path.isAbsolute(choice.filePath)) throw invalid('保存位置无效，请重新选择。');
      const root = await fs.realpath(path.dirname(choice.filePath));
      const name = path.basename(choice.filePath);
      await assertSafeTarget(root, root, name);
      throwIfAborted(signal);
      stage = await fs.mkdtemp(path.join(root, '.brclio-video-'));
      let file, lastError;
      for (const [index, source] of selected.urls.entries()) {
        throwIfAborted(signal);
        try {
          activeTicket = source.startsWith('member-video:') ? memberSession.resolve(source) : null;
          const url = activeTicket?.url || source;
          this.progress(selected.requestId, { phase: 'downloading', loadedBytes: 0, totalBytes: null, attempt: index + 1 });
          file = await downloadMedia({ root, directory: stage,
            asset: { key: 'video', kind: 'video', url, requireAudio: selected.requireAudio,
              watermarkFree: selected.requiresMembership || Boolean(activeTicket) },
            fetchImpl: this.fetchImpl, signal, authorize: originalAuthorization,
            beforeRequest: async () => { if (memberSession) await memberSession.recheck(); },
            onDiagnostic: this.onDiagnostic,
            onProgress: progress => this.progress(selected.requestId, { ...progress, attempt: index + 1 }),
          });
          break;
        } catch (error) {
          lastError = error;
          if (signal.aborted || authorizationFailure(error)) throw error;
        }
      }
      if (!file) throw lastError || new Error('视频下载失败，请重新解析。');
      throwIfAborted(signal);
      if (memberSession) await memberSession.recheck();
      await this.authorize('single-download');
      throwIfAborted(signal);
      await assertSafeTarget(root, root, name);
      throwIfAborted(signal);
      const target = path.join(root, name);
      await fs.rename(path.join(stage, file.name), target);
      this.progress(selected.requestId, { phase: 'saved', loadedBytes: file.bytes, totalBytes: file.bytes });
      return { ok: true, cancelled: false, path: target, bytes: file.bytes, mediaTracks: file.mediaTracks };
    } catch (error) {
      if (controller?.signal.aborted || error.name === 'AbortError') return { ok: true, cancelled: true };
      return { ok: false, cancelled: false, error: { code: error.cause?.code || error.code || 'VIDEO_DOWNLOAD_FAILED',
        status: error.status || error.statusCode || 500, message: error.message || '视频下载失败，请重试。' } };
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (selected && this.requests.get(selected.requestId) === controller) this.requests.delete(selected.requestId);
    }
  }

  cancel(requestId) {
    const controller = this.requests.get(requestId);
    controller?.abort();
    return { ok: true, cancelled: Boolean(controller) };
  }

  cancelAll() { for (const controller of this.requests.values()) controller.abort(); }

  async shutdown() {
    this.stopping = true;
    this.cancelAll();
    await Promise.allSettled([...this.operations]);
  }
}
