import { extractInputUrl, extractNoteId, isDirectImageUrl, isXhsImageUrl, validateAssetToken } from './xhs.js';
import { publicPlaybackVideo } from './video-policy.js';

const MAX_HTML_BYTES = 6 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 60_000;
const NOTE_PATH = /^\/(?:explore|discovery\/item|item)\/([A-Za-z0-9_-]{12,64})\/?$/;
const PAGE_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);
const unavailable = () => new Error('浏览器 Python 运行环境暂时不可用，请重试或切换 Node.js。');
const safeOriginalVideoCount = value => Number.isInteger(value) && value >= 0 && value <= 20 ? value : 0;

function checkedSource(source, expectedId, inputUrl) {
  if (source?.success === true && source.kind === 'direct-image' && source.source === 'direct'
    && source.directImageUrl === inputUrl && isDirectImageUrl(inputUrl)) {
    return { kind: 'direct-image', directImageUrl: inputUrl };
  }
  let url;
  try { url = new URL(source?.finalUrl); } catch { throw new Error('笔记页面信息无效，请重新解析。'); }
  const match = NOTE_PATH.exec(url.pathname);
  if (source?.success !== true || !['proxy', 'direct', 'browser'].includes(source.source) || typeof source.html !== 'string'
    || !source.html || new TextEncoder().encode(source.html).byteLength > MAX_HTML_BYTES
    || url.protocol !== 'https:' || !PAGE_HOSTS.has(url.hostname) || url.username || url.password
    || (url.port && url.port !== '443') || !match || source.noteId !== match[1]
    || (expectedId && source.noteId !== expectedId)) throw new Error('笔记页面信息无效，请重新解析。');
  return { html: source.html, noteId: source.noteId, originalVideoCount: safeOriginalVideoCount(source.originalVideoCount) };
}

function playbackFields(value, { video = false } = {}) {
  const item = publicPlaybackVideo(value);
  if (!item) return null;
  const result = { url: item.url, backupUrls: item.backupUrls };
  for (const key of ['codec', 'width', 'height', 'bitrate', 'size', 'duration', 'qualityType']) result[key] = item[key];
  if (video) for (const key of ['hasAudio', 'audioCodec', 'audioChannels', 'audioBitrate', 'label']) result[key] = item[key];
  return result;
}

/** Match the public Python response without exposing original-upload addresses. */
export function normalizeBrowserPythonResult(parsed, noteId, declaredOriginalVideoCount = 0) {
  if (!parsed || !Array.isArray(parsed.images) || !Array.isArray(parsed.videos)) throw unavailable();
  const images = parsed.images.filter(item => item && validateAssetToken(item.token) && isXhsImageUrl(item.url))
    .slice(0, 50).map((item, index) => ({ index: index + 1, token: item.token, url: item.url,
      livePhoto: Boolean(item.livePhoto), liveVideo: playbackFields(item.liveVideo) }));
  const videos = parsed.videos.map(item => playbackFields(item, { video: true })).filter(Boolean)
    .map((item, index) => ({ index: index + 1, ...item, isDefault: index === 0 }));
  const originalVideoCount = Math.max(Array.isArray(parsed.originalVideos) ? Math.min(20, parsed.originalVideos.length) : 0,
    safeOriginalVideoCount(declaredOriginalVideoCount));
  if (!images.length && !videos.length && !originalVideoCount) {
    throw new Error('没有解析到图片或视频。笔记可能已删除、需要登录，或者小红书页面结构已更新。');
  }
  return { success: true, engine: 'python', title: typeof parsed.title === 'string' ? parsed.title : '',
    content: typeof parsed.content === 'string' ? parsed.content : '', noteId,
    strategy: typeof parsed.strategy === 'string' ? parsed.strategy : '',
    type: videos.length || originalVideoCount ? (images.length ? 'mixed' : 'video') : 'image',
    count: images.length, livePhotoCount: images.filter(item => item.liveVideo).length,
    videoCount: videos.length, originalVideoCount, hasOriginalVideo: originalVideoCount > 0, images, videos };
}

function parseInWorker(source, WorkerImpl) {
  if (typeof WorkerImpl !== 'function') return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let settled = false;
    const end = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); worker?.terminate();
      if (error) reject(error); else resolve(value);
    };
    try {
      worker = new WorkerImpl(new URL('./browser-python-worker.js', import.meta.url), { type: 'module' });
      timer = setTimeout(() => end(new Error('浏览器 Python 加载或解析超时，请重试或切换 Node.js。')), PARSE_TIMEOUT_MS);
      worker.onerror = () => end(unavailable());
      worker.onmessageerror = () => end(unavailable());
      worker.onmessage = event => event.data?.success === true
        ? end(null, event.data.parsed) : end(unavailable());
      worker.postMessage(source);
    } catch { end(unavailable()); }
  });
}

export async function parseWithBrowserPython(text, { verify, fetchImpl = globalThis.fetch, WorkerImpl = globalThis.Worker } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 3000) throw new Error('请粘贴有效的小红书分享文案或链接。');
  let expectedId, inputUrl;
  try { inputUrl = extractInputUrl(text); expectedId = extractNoteId(inputUrl); } catch { throw new Error('请粘贴有效的小红书分享文案或链接。'); }
  const response = await fetchImpl('/api/browser_python_source', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS), cache: 'no-store',
  });
  let source = await response.json().catch(() => ({}));
  if (source.code === 'VERIFICATION_REQUIRED' && typeof verify === 'function') source = await verify(source);
  else if (!response.ok || !source.success) throw new Error(source.message || `解析失败：HTTP ${response.status}`);
  const { originalVideoCount, ...page } = checkedSource(source, expectedId, inputUrl);
  const parsed = await parseInWorker(page, WorkerImpl);
  return normalizeBrowserPythonResult(parsed, page.noteId, originalVideoCount);
}
