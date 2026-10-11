import { XhsError, extractInputUrl, extractNoteId, fetchNotePage, isDirectImageUrl } from '../lib/xhs.js';
import { MAX_API_BODY_BYTES, readBoundedBody } from './http-adapter.js';

const PAGE_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);
const NOTE_PATH = /^\/(?:explore|discovery\/item|item)\/[A-Za-z0-9_-]{12,64}\/?$/;
const CAPTCHA_TITLES = new Set(['小红书安全验证', '小红书 - 安全验证', '安全验证 - 小红书']);
const LOGIN_TITLES = new Set(['小红书登录', '小红书 - 登录', '登录 - 小红书']);
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const json = (body, status) => Response.json({ success: false, engine: 'python', ...body }, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-XHS-Engine': 'python' },
});

function candidate(body) {
  let data;
  try { data = JSON.parse(body); } catch { return null; }
  if (!data || typeof data.text !== 'string') return null;
  const text = data.text.trim();
  // Python counts Unicode code points, rather than JavaScript UTF-16 code units.
  if (!text || Array.from(text).length > 3000) return null;
  try {
    const sourceURL = extractInputUrl(text);
    if (isDirectImageUrl(sourceURL)) return null;
    const url = new URL(sourceURL);
    const page = PAGE_HOSTS.has(url.hostname) && NOTE_PATH.test(url.pathname);
    if (!page && !/(?:^|\.)xhslink\.(?:com|cn)$/.test(url.hostname)) return null;
    return { sourceURL, noteId: page ? extractNoteId(sourceURL) : null };
  } catch { return null; }
}

function finalPage(page, expectedId) {
  if (!page || typeof page.finalUrl !== 'string' || typeof page.html !== 'string') return null;
  let url;
  try { url = new URL(page.finalUrl); } catch { return null; }
  if (url.protocol !== 'https:' || !PAGE_HOSTS.has(url.hostname) || url.username || url.password
    || (url.port && url.port !== '443')) return null;
  const title = /<title\b[^>]*>([^<]{0,160})<\/title\s*>/i.exec(page.html)?.[1]?.trim() || '';
  const gate = /(?:^|\/)captcha(?:\/|$)/i.test(url.pathname) || CAPTCHA_TITLES.has(title) ? 'captcha'
    : /(?:^|\/)(?:login|signin|website-login)(?:\/|$)/i.test(url.pathname) || LOGIN_TITLES.has(title) ? 'login' : null;
  if (gate) return { gate };
  const noteId = extractNoteId(url.href);
  if (!NOTE_PATH.test(url.pathname) || !noteId || (expectedId && noteId !== expectedId)) return null;
  // Fragments are browser anchors, not part of the fetched note or its identity.
  url.hash = '';
  if (url.href.length > 3000) return null;
  return { finalUrl: url.href, noteId, html: page.html };
}

function fetchFailure(error) {
  if (error instanceof XhsError && ['RATE_LIMITED', 'AUTH_REQUIRED'].includes(error.code)) {
    return json({ code: error.code, message: error.code === 'AUTH_REQUIRED'
      ? '小红书要求登录后查看这篇笔记。' : '小红书要求安全验证或暂时限制了访问。' }, 422);
  }
  const status = error instanceof XhsError && [400, 413, 422, 502, 504].includes(error.statusCode) ? error.statusCode : 502;
  const message = status === 400 ? '分享链接或跳转地址不受支持。'
    : status === 413 ? '页面内容过大，已停止解析。'
      : status === 504 ? '访问小红书页面超时，请稍后重试。'
        : status === 422 ? '小红书暂未打开这篇笔记，请稍后重试或使用客户端。'
          : '访问小红书页面失败，请稍后重试。';
  return json({ message }, status);
}

/** Share only the note transport with Node; Python still owns every parse result. */
export async function parsePythonWithSharedPage(request, { body, pythonAPI, fetchPage = fetchNotePage } = {}) {
  if (!pythonAPI?.fetch) return json({ message: 'Python 服务暂时不可用，请稍后重试。' }, 503);
  const rawBody = body === undefined ? await readBoundedBody(request, MAX_API_BODY_BYTES) : body;
  const source = request.method === 'POST' ? candidate(rawBody) : null;
  if (!source) {
    // Preserve Python's public method/input/direct-image validation without forwarding visitor credentials.
    const url = new URL(request.url);
    return pythonAPI.fetch(new Request(`https://python.internal${url.pathname}${url.search}`, {
      method: request.method, headers: { 'Content-Type': 'application/json' },
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : rawBody,
    }));
  }
  let page;
  try { page = finalPage(await fetchPage(source.sourceURL, { signal: request.signal }), source.noteId); }
  catch (error) { return fetchFailure(error); }
  if (page?.gate) return json({ message: page.gate === 'captcha'
    ? '小红书要求安全验证后查看这篇笔记。' : '小红书要求登录后查看这篇笔记。' }, 422);
  if (!page) return json({ message: '小红书暂未打开所请求的笔记，请稍后重试或使用客户端。' }, 422);
  if (new TextEncoder().encode(page.html).byteLength > MAX_HTML_BYTES) {
    return json({ message: '页面内容过大，已停止解析。' }, 413);
  }
  // No public request HTML, cookies, authorization, or Node-parsed media enters this private contract.
  return pythonAPI.fetch(new Request('https://python.internal/__internal/parse-rendered-note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(page),
  }));
}
