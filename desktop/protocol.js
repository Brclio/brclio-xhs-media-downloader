import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PROTECTED_FEATURES } from '../lib/membership-policy.js';
import parseHandler from '../api/parse.js';
import imageHandler from '../api/image.js';
import videoHandler from '../api/video.js';

export const APP_URL = 'xhs-app://local';
const STATIC_FILES = new Set([
  'index.html', 'changelog.html', 'app.js', 'style.css', 'changelog.css',
  'download.html', 'download.css', 'download.js',
  'support.css', 'visit-counter.js', 'visit-counter.css', 'favicon.svg', 'aiyc.svg',
  'desktop-ui.js', 'desktop-ui.css', 'account-ui.js', 'account-ui.css', 'lib/archive.js', 'lib/clipboard.js', 'lib/image-dimensions.js', 'lib/media-tracks.js', 'lib/membership-plans.js'
]);
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const NODE_HANDLERS = { '/api/parse': parseHandler, '/api/image': imageHandler, '/api/video': videoHandler };
const PYTHON_ROUTES = new Set(['/api/python_parse', '/api/python_image', '/api/python_video']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://*.xhscdn.com https://ci.xiaohongshu.com; media-src 'self' blob: https://*.xhscdn.com; connect-src 'self' https://*.xhscdn.com https://ci.xiaohongshu.com; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

export function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'xhs-app:' && url.hostname === 'local' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function jsonError(message, status) {
  return Response.json({ success: false, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readBody(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16 * 1024) {
        await reader.cancel();
        throw Object.assign(new Error('输入内容过长。'), { status: 413 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function invokeNodeHandler(handler, request, url) {
  const headers = new Headers();
  let status = 200;
  let payload = null;
  const res = {
    setHeader(name, value) { headers.set(name, String(value)); return this; },
    status(value) { status = value; return this; },
    json(value) { headers.set('Content-Type', 'application/json; charset=utf-8'); payload = JSON.stringify(value); return this; },
    send(value) { payload = value; return this; },
    end(value) { payload = value ?? null; return this; }
  };
  await handler({ method: request.method, query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(request.headers), body: await readBody(request) }, res);
  return new Response(payload, { status, headers });
}

async function defaultAuthorization(feature) {
  if (PROTECTED_FEATURES.includes(feature)) throw Object.assign(new Error('软件账号授权服务不可用。'), { status: 503 });
}

export function createProtocolHandler({ rootDirectory, pythonBackend, nodeHandlers = NODE_HANDLERS, authorize = defaultAuthorization, onDiagnostic = () => {} }) {
  return async (request) => {
    const started = Date.now();
    let route;
    try {
      if ((request.referrer && request.referrer !== 'about:client' && !isAppUrl(request.referrer)) || (request.initiatorOrigin && !isAppUrl(request.initiatorOrigin))) return jsonError('不受信任的请求来源。', 403);
      if (!isAppUrl(request.url)) return jsonError('不受支持的应用地址。', 403);
      const url = new URL(request.url);
      route = url.pathname.replace(/\.(?:js|py)$/, '');
      if (nodeHandlers[route]) {
        await authorize('single-download');
        const response = await invokeNodeHandler(nodeHandlers[route], request, url);
        onDiagnostic('single.response', { route, status: response.status, durationMs: Date.now() - started });
        return response;
      }
      if (PYTHON_ROUTES.has(route)) {
        await authorize('single-download');
        if (!pythonBackend?.available) return jsonError('Python 后台不可用，请使用完整安装包。', 503);
        const response = await pythonBackend.request({ path: `${route}${url.search}`, method: request.method,
          headers: Object.fromEntries(request.headers), body: await readBody(request) }, request.signal);
        onDiagnostic('single.response', { route, status: response.status, durationMs: Date.now() - started });
        return response;
      }
      if (!['GET', 'HEAD'].includes(request.method)) return jsonError('只支持 GET 请求。', 405);
      let name;
      try { name = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html'; }
      catch { return jsonError('无效的路径。', 400); }
      if ((!STATIC_FILES.has(name) && !/^assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|svg)$/.test(name))
        || name.split('/').includes('..') || name.includes('\\') || name.includes('\0')) {
        return jsonError('文件不存在。', 404);
      }
      const root = await realpath(rootDirectory);
      const filename = await realpath(path.join(root, name));
      if (!filename.startsWith(`${root}${path.sep}`)) return jsonError('文件不存在。', 404);
      const body = request.method === 'HEAD' ? null : await readFile(filename);
      return new Response(body, { headers: {
        'Content-Type': MIME_TYPES[path.extname(name)] || 'application/octet-stream',
        'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache'
      } });
    } catch (error) {
      onDiagnostic('single.request_failed', { route, error, durationMs: Date.now() - started }, 'error');
      if (error.code === 'ENOENT') return jsonError('文件不存在。', 404);
      return jsonError(error.status ? error.message : '本地请求失败，请稍后重试。', error.status || 500);
    }
  };
}
