import { extractInitialStates, findExactNoteCandidates, extractInputUrl, extractNoteId, fetchNotePage, isDirectImageUrl, isXhsVideoUrl, normalizeImageUrl, XhsError } from '../lib/xhs.js';
import { isMemberVideoUrl } from '../lib/video-policy.js';
import { createImageHandler } from '../api/image.js';
import { createVideoHandler } from '../api/video.js';
import { invokeHandler, readBoundedBody, MAX_API_BODY_BYTES, RequestTooLargeError } from './http-adapter.js';

const MAX_HTML_BYTES = 6 * 1024 * 1024;
const NOTE_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);
const LINK_HOSTS = new Set(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
const STREAM_KEYS = ['h264', 'h265', 'h266', 'av1'];
const IMAGE_KEYS = new Set(['urlDefault', 'url_default', 'defaultUrl', 'default_url', 'originUrl', 'origin_url', 'original', 'originalUrl', 'original_url', 'url', 'imageUrl', 'image_url', 'fileUrl', 'file_url', 'urlPre', 'url_pre', 'previewUrl', 'preview_url', 'thumbnail', 'thumbnailUrl', 'thumbnail_url', 'infoList', 'info_list', 'urlList', 'url_list', 'urls', 'imageInfo', 'image_info']);
const NUMBER_KEYS = ['width', 'height', 'videoBitrate', 'video_bitrate', 'bitrate', 'size', 'fileSize', 'file_size', 'videoDuration', 'video_duration', 'duration', 'audioChannels', 'audio_channels', 'audioBitrate', 'audio_bitrate'];
const URL_PATTERN = /(?:https?:)?(?:\/\/|\\\/\\\/)[^\s<>"'`]+/gi;
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
} });

function allowedPage(value, { noteOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
    && ((NOTE_HOSTS.has(url.hostname) && /^\/(?:explore|discovery\/item)\/[a-f\d]{24}\/?$/i.test(url.pathname))
      || (!noteOnly && LINK_HOSTS.has(url.hostname)));
}

function decodedText(value) {
  return String(value).replace(/\\u([0-9a-f]{4})/gi, (_all, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_all, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/').replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (_all, hex, decimal) => {
      const point = parseInt(hex || decimal, hex ? 16 : 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/(?:%[0-9a-f]{2})+/gi, match => { try { return decodeURIComponent(match); } catch { return match; } });
}

function imageURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try { url = new URL(normalizeImageUrl(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || !(url.hostname === 'ci.xiaohongshu.com' || /^sns-(?:img|webpic)(?:-[a-z0-9]+)*\.xhscdn\.com$/i.test(url.hostname))) return null;
  return url.href;
}

function playbackURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const normalized = normalizeImageUrl(value);
  return isXhsVideoUrl(normalized) && !isMemberVideoUrl(normalized) ? normalized : null;
}

// A declared origin remains private even if its path resembles a public stream.
// CDN aliases, signed queries and percent-encoded paths do not change the asset.
function videoIdentity(value) {
  try { return decodeURIComponent(new URL(normalizeImageUrl(value)).pathname); }
  catch { return null; }
}

function originalInfo(note) {
  const video = note?.video;
  const originals = new Set(), declared = new Set(), markers = new Set();
  for (const raw of [video?.consumer?.originVideoKey, video?.consumer?.origin_video_key, video?.originVideoKey, video?.origin_video_key]) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096 || /[\x00-\x20\x7f]/.test(raw.trim())) continue;
    const normalized = normalizeImageUrl(raw).split('#', 1)[0];
    let url = normalized;
    if (!/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(raw.trim())) {
      const key = normalized.replace(/^\/+/, '');
      if (!/^[A-Za-z0-9/_~.\-]+$/.test(key) || key.split('/').some(part => part === '.' || part === '..')) continue;
      url = 'https://sns-video-bd.xhscdn.com/' + key;
    }
    if (/^http:/i.test(raw.trim()) || !isXhsVideoUrl(url)) continue;
    declared.add(url);
    if (isMemberVideoUrl(url)) originals.add(url);
    markers.add(raw); markers.add(normalized);
    try { markers.add(decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '')); } catch {}
  }
  let visited = 0;
  function walk(value, depth = 0) {
    if (++visited > 10000 || depth > 12 || markers.size > 128) return;
    if (typeof value === 'string') {
      const text = decodedText(value);
      if (text.length <= 1048576 && /^[\s]*[\[{]/.test(text)) {
        try { walk(JSON.parse(text), depth + 1); } catch {}
      }
      for (const match of text.matchAll(URL_PATTERN)) {
        const normalized = normalizeImageUrl(match[0]);
        if (isXhsVideoUrl(normalized) && !imageURL(normalized) && isMemberVideoUrl(normalized)) markers.add(normalized);
      }
    } else if (Array.isArray(value)) for (const child of value) walk(child, depth + 1);
    else if (value && typeof value === 'object') for (const child of Object.values(value)) walk(child, depth + 1);
  }
  walk(video);
  return { originals, declared, markers };
}

function publicText(value, maximum, markers) {
  if (typeof value !== 'string') return '';
  let text = decodedText(value.slice(0, maximum));
  for (const marker of markers) if (marker) {
    text = text.replaceAll(marker, '[原视频地址已隐藏]').replaceAll(encodeURIComponent(marker), '[原视频地址已隐藏]');
  }
  return text.replace(URL_PATTERN, match => {
    const url = normalizeImageUrl(match);
    return isXhsVideoUrl(url) && !imageURL(url) && isMemberVideoUrl(url) ? '[原视频地址已隐藏]' : match;
  });
}

function publicStreams(value, blocked = new Set()) {
  const streams = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return streams;
  for (const codec of STREAM_KEYS) {
    const raw = value[codec], list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
    streams[codec] = list.slice(0, 32).flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const urls = [...new Set([item.masterUrl, item.master_url, item.url,
        ...['masterUrls', 'master_urls', 'backupUrls', 'backup_urls'].flatMap(key => Array.isArray(item[key]) ? item[key] : [])].map(playbackURL).filter(url => url && !blocked.has(videoIdentity(url))))];
      if (!urls.length) return [];
      const result = { masterUrl: urls[0], backupUrls: urls.slice(1, 16) };
      for (const key of NUMBER_KEYS) if ((typeof item[key] === 'number' || typeof item[key] === 'string') && Number.isFinite(Number(item[key])) && Number(item[key]) >= 0 && Number(item[key]) <= 1e12) result[key] = Number(item[key]);
      for (const key of ['hasAudio', 'has_audio']) if (typeof item[key] === 'boolean') result[key] = item[key];
      for (const key of ['videoCodec', 'video_codec', 'codec', 'audioCodec', 'audio_codec']) if (typeof item[key] === 'string' && /^(?:h26[456]|avc1?|hvc1|hev1|hevc|av1|aac|mp4a(?:\.[a-z0-9]+)*|opus|mp3|none|null|unknown|0)$/i.test(item[key])) result[key] = item[key];
      for (const key of ['qualityType', 'quality_type']) if (/^(?:[0-9]{1,4}p?|[248]k|hd|sd|uhd|fhd)$/i.test(String(item[key] ?? ''))) result[key] = String(item[key]);
      return [result];
    });
    if (!streams[codec].length) delete streams[codec];
  }
  return streams;
}

function publicImage(value, depth = 0) {
  if (depth > 8) return undefined;
  if (typeof value === 'string') return imageURL(value) || undefined;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => publicImage(item, depth + 1)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) if (IMAGE_KEYS.has(key)) {
    const projected = publicImage(child, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

/** Rebuild only the data Python needs; never return upstream executable HTML. */
export function publicBrowserPythonPage(page, { source, requireMedia = false } = {}) {
  if (typeof page?.html !== 'string' || new TextEncoder().encode(page.html).byteLength > MAX_HTML_BYTES
    || !allowedPage(page.finalUrl, { noteOnly: true })) throw new XhsError('笔记页面信息无效。', 422);
  const noteId = extractNoteId(page.finalUrl);
  if (!noteId || (page.noteId && page.noteId !== noteId)) throw new XhsError('笔记页面信息无效。', 422);
  const candidates = [...new Set(extractInitialStates(page.html).flatMap(state => findExactNoteCandidates(state, noteId)))];
  if (candidates.length > 24) throw new XhsError('笔记页面信息过大。', 413);
  const originalSources = new Set(), allDeclared = new Set(), allMarkers = new Set(), notes = [];
  let hasMedia = false;
  const hasImage = value => typeof value === 'string' || Boolean(value && typeof value === 'object' && Object.values(value).some(hasImage));
  for (const candidate of candidates) {
    const { originals, declared, markers } = originalInfo(candidate);
    for (const value of originals) originalSources.add(value);
    for (const value of declared) allDeclared.add(videoIdentity(value));
    for (const value of markers) allMarkers.add(value);
    if (allMarkers.size > 512) throw new XhsError('笔记页面信息过大。', 413);
  }
  for (const candidate of candidates) {
    const note = { noteId, title: publicText(candidate.title ?? candidate.displayTitle ?? candidate.display_title, 120, allMarkers), desc: publicText(candidate.desc ?? candidate.description, 10000, allMarkers) };
    const images = candidate.imageList ?? candidate.image_list ?? candidate.images;
    if (Array.isArray(images)) note.imageList = images.slice(0, 50).flatMap(item => {
      const projected = publicImage(item);
      if (projected === undefined) return [];
      hasMedia ||= hasImage(projected);
      const result = typeof projected === 'string' ? { urlDefault: projected } : projected;
      result.livePhoto = [item?.livePhoto, item?.live_photo, item?.isLivePhoto, item?.is_live_photo].some(value => value === true || value === 1 || typeof value === 'string' && /^(?:true|1)$/i.test(value));
      const root = [item?.stream, item?.livePhotoStream, item?.live_photo_stream].find(value => value && typeof value === 'object' && Object.keys(value).length);
      const stream = publicStreams(root, allDeclared);
      if (Object.keys(stream).length) result.stream = stream;
      return [result];
    });
    const stream = publicStreams(candidate.video?.media?.stream, allDeclared);
    if (Object.keys(stream).length) { note.video = { media: { stream } }; hasMedia = true; }
    notes.push(note);
  }
  let title = '', metas = '';
  const titleMatch = /<title\b[^>]*>([^<]*)<\/title>/i.exec(page.html);
  if (titleMatch) title = publicText(titleMatch[1], 120, allMarkers);
  for (const [tag] of page.html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /\b(?:property|name)\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]?.toLowerCase();
    const value = /\bcontent\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    const url = ['og:image', 'twitter:image', 'twitter:image:src'].includes(key) ? imageURL(value)
      : ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(key) ? playbackURL(value) : null;
    if (url && !allDeclared.has(videoIdentity(url))) { metas += `<meta property="${key}" content="${escapeHTML(url)}">`; hasMedia = true; }
  }
  if ((!notes.length && !metas) || (requireMedia && !hasMedia && !originalSources.size)) throw new XhsError('没有可公开解析的笔记数据。', 422);
  // JSON escapes prevent note strings from manufacturing script/HTML markup.
  const state = JSON.stringify({ browserPublicNotes: notes }).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const html = `<title>${escapeHTML(title)}</title>${metas}<script>window.__INITIAL_STATE__=${state}</script>`;
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new XhsError('笔记页面信息过大。', 413);
  return { html, noteId, finalUrl: page.finalUrl, source, originalVideoCount: Math.min(12, originalSources.size) };
}

export function sameOriginWebRequest(request) {
  return request.headers.get('Origin') === new URL(request.url).origin
    && request.headers.get('Sec-Fetch-Site')?.toLowerCase() !== 'cross-site';
}

/** This getter exists only on a private Durable Object binding. */
export async function loadProxySettings(env) {
  if (!env.ACCOUNT_RUNTIME) throw new Error('settings-unavailable');
  const response = await env.ACCOUNT_RUNTIME.get(env.ACCOUNT_RUNTIME.idFromName('accounts-v1'))
    .fetch(new Request('https://account.internal/__internal/web-parse-proxy-settings', { signal: AbortSignal.timeout(10000) }));
  if (!response.ok) throw new Error('settings-unavailable');
  const body = JSON.parse(await readBoundedBody(response, MAX_API_BODY_BYTES));
  if (body?.ok !== true || typeof body.proxyConfig?.enabled !== 'boolean'
    || typeof body.proxyConfig.subscriptionUrl !== 'string') throw new Error('settings-unavailable');
  return body.proxyConfig;
}

async function proxyCall(env, operation, body, signal) {
  if (!env.SUBSCRIPTION_PROXY?.fetch) throw new Error('proxy-unavailable');
  return env.SUBSCRIPTION_PROXY.fetch(new Request(`https://proxy.internal/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  }));
}

const CHALLENGE_CODES = new Set(['UPSTREAM_VERIFICATION_REQUIRED', 'UPSTREAM_LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'RATE_LIMITED', 'AUTH_REQUIRED']);
const sourceFailure = error => CHALLENGE_CODES.has(error?.code) || error instanceof XhsError && [400, 401, 403, 422].includes(error.statusCode)
  ? 'challenge' : error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.statusCode === 504 ? 'timeout' : 'unavailable';

function projectedSource(page, sourceURL, source) {
  if (typeof page?.html !== 'string' || !page.html.trim()
    || new TextEncoder().encode(page.html).byteLength > MAX_HTML_BYTES) throw new XhsError('笔记页面读取暂时不可用。', 502);
  const noteId = extractNoteId(page.finalUrl), expectedId = extractNoteId(sourceURL);
  if (!allowedPage(page.finalUrl, { noteOnly: true }) || !noteId || (expectedId && expectedId !== noteId)) throw new XhsError('笔记页面信息无效。', 422);
  return publicBrowserPythonPage({ ...page, noteId }, { source, requireMedia: true });
}

async function boundedDirectMedia(response, maximum, signal) {
  if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel(); throw new XhsError('媒体内容过大。', 413);
  }
  const reader = response.body?.getReader();
  if (!reader) return response;
  const parts = []; let size = 0, onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => {
      reject(new DOMException('媒体读取已取消。', 'AbortError'));
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new XhsError('媒体内容过大。', 413); }
      parts.push(value);
    }
  } finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Return inert source data. Python execution is exclusively in the web worker. */
export async function browserPythonSource(request, env, { settings = loadProxySettings,
  proxy = proxyCall, direct = fetchNotePage } = {}) {
  if (request.method !== 'POST') return json({ success: false, message: '只支持 POST 请求。' }, 405);
  if (!sameOriginWebRequest(request)) return json({ success: false, message: '请求来源无效。' }, 403);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
      return json({ success: false, message: '请使用 JSON 请求。' }, 415);
    }
    let input;
    try { input = JSON.parse(await readBoundedBody(request, MAX_API_BODY_BYTES)); }
    catch (error) {
      if (error instanceof RequestTooLargeError) throw error;
      return json({ success: false, message: '请求 JSON 格式无效。' }, 400);
    }
    if (typeof input?.text !== 'string' || !input.text.trim()) return json({ success: false, message: '请粘贴小红书分享文案或链接。' }, 400);
    if (input.text.length > 3000) return json({ success: false, message: '输入内容过长。' }, 413);
    const sourceURL = extractInputUrl(input.text.trim());
    if (isDirectImageUrl(sourceURL)) return json({ success: true, kind: 'direct-image', directImageUrl: sourceURL, source: 'direct' });
    if (!allowedPage(sourceURL)) return json({ success: false, message: '只支持公开的小红书笔记分享链接。' }, 400);
    let config;
    try { config = await settings(env); }
    catch { return json({ success: false, engine: 'browser-python', code: 'WEB_PROXY_SETTINGS_UNAVAILABLE', message: '网页抓取网络配置暂时不可用，请稍后重试。' }, 503); }
    if (config.enabled && proxy === proxyCall && !env.SUBSCRIPTION_PROXY?.fetch) return json({ success: false, engine: 'browser-python', code: 'WEB_PROXY_UNAVAILABLE', message: '网页抓取代理尚未就绪，请稍后重试。' }, 503);
    let failure = 'unavailable';
    if (config.enabled) {
      try {
        const response = await proxy(env, 'fetch-note', { url: sourceURL, subscriptionUrl: config.subscriptionUrl }, request.signal);
        if (response.ok) {
          // Subscription and node credentials never enter this public envelope.
          const page = JSON.parse(await readBoundedBody(response, MAX_HTML_BYTES * 2 + 16384));
          return json({ success: true, ...projectedSource(page, sourceURL, 'proxy') });
        }
        let error;
        try { error = JSON.parse(await readBoundedBody(response, MAX_API_BODY_BYTES)); } catch { error = {}; }
        if (CHALLENGE_CODES.has(error.code) || [401, 403, 422, 429, 461, 471].includes(response.status)) failure = 'challenge';
        else if (response.status === 504) failure = 'timeout';
      } catch (error) { failure = sourceFailure(error); }
    }
    // One fresh direct attempt complements the fastest proxy route. Challenges
    // never rotate through more nodes, and failed configuration never gets here.
    try {
      request.signal.throwIfAborted();
      const page = await direct(sourceURL, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
      return json({ success: true, ...projectedSource(page, sourceURL, 'direct') });
    } catch (error) {
      const directFailure = sourceFailure(error);
      if (directFailure === 'challenge' || failure === 'challenge') failure = 'challenge';
      else if (directFailure === 'timeout' || failure === 'timeout') failure = 'timeout';
      else failure = 'unavailable';
    }
    if (failure === 'challenge') return json({ success: false, engine: 'browser-python', code: 'UPSTREAM_VERIFICATION_REQUIRED',
      message: '小红书要求安全验证，请在验证窗口处理后继续。' }, 422);
    return json({ success: false, engine: 'browser-python', code: 'SOURCE_UNAVAILABLE',
      message: failure === 'timeout' ? '笔记页面读取超时，请稍后重试。' : '笔记页面读取暂时不可用，请稍后重试。' }, failure === 'timeout' ? 504 : 502);
  } catch (error) {
    const tooLarge = error instanceof RequestTooLargeError;
    const status = tooLarge ? 413 : error instanceof XhsError ? error.statusCode : 502;
    return json({ success: false, engine: 'browser-python', code: 'SOURCE_UNAVAILABLE',
      message: tooLarge ? '请求内容过大。' : '笔记页面读取暂时不可用，请稍后重试。' }, status);
  }
}

/** Reuse existing range, size and member-video guards with a private transport. */
export async function browserPythonMedia(request, env, { settings = loadProxySettings, proxy = proxyCall,
  direct = (...args) => globalThis.fetch(...args) } = {}) {
  if (request.method !== 'GET') return json({ success: false, message: '只支持 GET 请求。' }, 405);
  // Same-origin image elements may omit Origin. Cross-site fetches remain ineligible.
  const origin = request.headers.get('Origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site')?.toLowerCase() === 'cross-site') {
    return json({ success: false, message: '请求来源无效。' }, 403);
  }
  const isImage = new URL(request.url).pathname === '/api/browser_python_image';
  const metadataOnly = !isImage && (!new URL(request.url).searchParams.get('action') || new URL(request.url).searchParams.get('action') === 'meta');
  let directSignal;
  const directMedia = async (initialURL, options) => {
    directSignal ||= AbortSignal.any([request.signal, options.signal, AbortSignal.timeout(15000)]);
    let url = String(initialURL);
    for (let hop = 0; hop < 6; hop++) {
      if (!(isImage ? imageURL(url) : playbackURL(url))) throw new XhsError('媒体地址不受支持。', 502);
      directSignal.throwIfAborted();
      const response = await direct(url, { ...options, signal: directSignal, redirect: 'manual' });
      if (!isImage || ![301, 302, 303, 307, 308].includes(response.status)) {
        // Buffer bounded bodies while the operation deadline remains active.
        // Metadata needs headers only, including servers that ignore Range.
        if (metadataOnly || !response.ok) {
          await response.body?.cancel();
          return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return boundedDirectMedia(response, isImage ? 4_200_000 : 3_500_000, directSignal);
      }
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || hop === 5) throw new XhsError('图片跳转地址无效。', 502);
      url = new URL(location, url).href;
    }
  };
  let configPromise, directSelected = false;
  const fetchImpl = async (url, options = {}) => {
    try {
      let config;
      try { config = await (configPromise ||= settings(env)); }
      catch { throw new XhsError('网页抓取网络配置暂时不可用。', 503); }
      const networkOptions = { ...options, signal: AbortSignal.any([options.signal, request.signal]) };
      if (config.enabled && !directSelected) {
        try {
          const response = await proxy(env, 'fetch-media', { url: String(url), subscriptionUrl: config.subscriptionUrl,
            range: new Headers(options.headers).get('range') || undefined }, networkOptions.signal);
          // The private service has already checked every upstream target and
          // range. Its Fetch URL identifies the internal service, not the CDN.
          if (response.ok) return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
          await response.body?.cancel();
        } catch { /* One controlled direct attempt; no transport details escape. */ }
        directSelected = true;
      }
      return await directMedia(url, networkOptions);
    } catch (error) {
      // Native handler errors can include transport.message. Project only fixed
      // messages here so neither subscription nor settings exceptions leak.
      if (options.signal?.aborted || request.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new XhsError('媒体读取超时，请稍后重试。', 504);
      if (error instanceof XhsError && error.statusCode === 503) throw new XhsError('网页抓取网络配置暂时不可用。', 503);
      throw new XhsError('媒体代理暂时不可用，请稍后重试。', 502);
    }
  };
  return invokeHandler(isImage ? createImageHandler({ fetchImpl, onError: () => {}, timeoutMs: 60000 })
    : createVideoHandler({ fetchImpl, onError: () => {}, timeoutMs: 60000 }), request);
}
