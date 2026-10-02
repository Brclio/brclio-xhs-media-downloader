import http from 'node:http';
import { BlockList, isIP } from 'node:net';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_FILES } from '../../deploy/build-web.mjs';
import { createHostedMemberVideoHandler } from '../../api/member_video.js';
import { createMediaRuntime, HttpError } from './media.js';

const MEDIA = new Set(['/api/parse', '/api/image', '/api/video', '/api/python_parse', '/api/python_image', '/api/python_video']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const normalizeIp = value => String(value || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');

/** Explicit trusted proxy addresses only; there is deliberately no trust-all setting. */
export function createClientIp(trusted = '') {
  const list = new BlockList();
  for (const item of trusted.split(',').map(value => value.trim()).filter(Boolean)) {
    const [address, prefix, extra] = item.split('/'), type = isIP(address);
    if (!type || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 0 || Number(prefix) > (type === 4 ? 32 : 128)))) throw new Error('SERVER_TRUST_PROXY must contain IP addresses or CIDR ranges.');
    const family = type === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, family); else list.addSubnet(address, Number(prefix), family);
  }
  const isTrusted = ip => isIP(ip) && list.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  return req => {
    let current = normalizeIp(req.socket?.remoteAddress);
    if (!isTrusted(current)) return current || 'unknown';
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(value => normalizeIp(value.trim()));
    if (forwarded.length > 20 || forwarded.some(value => !isIP(value))) return current;
    for (let i = forwarded.length - 1; i >= 0 && isTrusted(current); i -= 1) current = forwarded[i];
    return current;
  };
}

function json(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

/** Keep account checks and encrypted tickets here; bound every upstream media job. */
export function createStandaloneMemberVideoHandler({ env = process.env, accountHandler, media } = {}) {
  return (req, res) => createHostedMemberVideoHandler({
    env, accountHandler,
    resolve: async text => {
      const result = await media.runNode('/internal/member-video-resolve', { text }, req.signal);
      const payload = JSON.parse(Buffer.from(result.body).toString('utf8'));
      if (result.status < 200 || result.status >= 300) throw new HttpError(result.status, payload.code || 'MEMBER_VIDEO_ERROR', payload.message || '会员视频服务暂时不可用。');
      return payload;
    },
    video: async (request, response) => {
      // This path is reached only after decrypting an account-bound ticket.
      // Workers receive the media query, never cookies, account credentials or keys.
      const result = await media.runNode('/internal/member-video-download', { method: request.method,
        query: { url: request.query.url, action: request.query.action, start: request.query.start, end: request.query.end } }, req.signal);
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
      return response.status(result.status).send(result.body);
    },
  })(req, res);
}

async function readBody(req, limit, signal) {
  if (Number(req.headers['content-length'] || 0) > limit) throw new HttpError(413, 'REQUEST_TOO_LARGE', '请求内容过大。');
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); signal?.removeEventListener('abort', aborted); };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => error(new HttpError(400, 'REQUEST_ABORTED', '请求已中断。'));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size).toString('utf8')); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { error(new HttpError(413, 'REQUEST_TOO_LARGE', '请求内容过大。')); req.resume(); return; }
      chunks.push(chunk);
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted); signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function cleanPath(rawUrl) {
  const raw = rawUrl.split('?', 1)[0];
  if (!raw.startsWith('/') || raw.startsWith('//')) throw new HttpError(400, 'INVALID_PATH', '请求路径无效。');
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw new HttpError(400, 'INVALID_PATH', '请求路径无效。'); }
  if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').some(segment => segment.startsWith('.'))) throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
  return decoded;
}

async function staticFile(root, pathname, req, res) {
  let relative = pathname.slice(1);
  if (!relative) relative = 'index.html';
  else if (relative === 'admin' || relative === 'admin/') relative = 'admin/index.html';
  else if (!path.extname(relative)) relative += '.html';
  if (!Object.hasOwn(TYPES, path.extname(relative)) || !PUBLIC_FILES.some(name => relative === name || (['assets', 'admin'].includes(name) && relative.startsWith(`${name}/`)))) throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
  const destination = path.resolve(root, relative);
  if (!destination.startsWith(root + path.sep)) throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
  let current = root;
  try {
    // Refuse symlinks in every component, including a symlink to another public file.
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink');
    }
    if (!(await realpath(destination)).startsWith(root + path.sep)) throw new Error('Outside public root');
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Not a file');
      res.statusCode = 200;
      res.setHeader('Content-Type', TYPES[path.extname(relative)] || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (relative.startsWith('admin/')) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', ADMIN_CSP);
      }
      if (req.method === 'HEAD') res.end();
      else await new Promise((resolve, reject) => {
        const stream = file.createReadStream({ autoClose: false });
        const close = () => { stream.destroy(); resolve(); };
        res.once('close', close);
        stream.once('error', reject);
        stream.once('end', () => { res.off('close', close); resolve(); });
        stream.pipe(res);
      });
    } finally { await file.close(); }
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
  }
}

/** Node HTTP boundary shared by direct execution, Docker and integration tests. */
export async function createStandaloneServer({ staticRoot, accountHandler, memberVideoHandler, storageCheck = async () => {}, media = createMediaRuntime(),
  trustedProxy = '', requestTimeoutMs = 60_000, maxRequests = 32 } = {}) {
  const rootStat = await lstat(staticRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Static root must be the built dist-web directory, not a symlink.');
  const root = await realpath(staticRoot), getIp = createClientIp(trustedProxy);
  const membershipHandler = memberVideoHandler ?? createStandaloneMemberVideoHandler({ accountHandler, media });
  let active = 0, closing = false;
  const activeRequests = new Set();
  const server = http.createServer({ maxHeaderSize: 16_384, headersTimeout: Math.min(15_000, requestTimeoutMs), requestTimeout: requestTimeoutMs, keepAliveTimeout: 5_000 }, async (req, res) => {
    if (closing || active >= maxRequests) { req.resume(); res.setHeader('Connection', 'close'); json(res, 503, { ok: false, error: { code: 'SERVER_BUSY', message: '服务繁忙，请稍后重试。' } }); return; }
    active += 1;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      req.resume();
      if (!res.headersSent) res.setHeader('Connection', 'close');
      json(res, 504, { ok: false, error: { code: 'REQUEST_TIMEOUT', message: '请求超时，请稍后重试。' } });
    }, requestTimeoutMs);
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', onClose);
    const finished = (async () => {
      try {
        const pathname = cleanPath(req.url);
        if (pathname === '/healthz' || pathname === '/readyz') {
          if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '只支持 GET 请求。');
          if (pathname === '/readyz') await storageCheck();
          json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/account' || pathname === '/api/member_video' || MEDIA.has(pathname)) {
          const body = await readBody(req, pathname === '/api/account' ? 1_600_000 : 16_384, abort.signal);
          if (abort.signal.aborted) return;
          const url = new URL(req.url, 'http://localhost');
          const adapted = { method: req.method, url: req.url, headers: req.headers, body,
            query: Object.fromEntries(url.searchParams), socket: req.socket, clientIp: getIp(req), signal: abort.signal };
          if (pathname === '/api/account' || pathname === '/api/member_video') {
            // Buffer the handler result so a timed-out transaction cannot write to a closed socket.
            const headers = {}, reply = { status: 200, body: '' };
            const response = { setHeader(name, value) { headers[name] = value; return this; },
              status(value) { reply.status = value; return this; }, json(value) { reply.body = JSON.stringify(value); return this; } };
            const selectedHandler = pathname === '/api/member_video' ? membershipHandler : accountHandler;
            response.send = value => { reply.body = value; return response; };
            response.end = value => { reply.body = value || ''; return response; };
            await selectedHandler(adapted, response);
            if (!res.writableEnded && !res.destroyed) { res.writeHead(reply.status, headers); res.end(reply.body); }
          } else {
            const result = pathname.startsWith('/api/python_')
              ? await media.runPython({ path: req.url, method: req.method, body }, abort.signal)
              : await media.runNode(pathname, { method: req.method, query: adapted.query, body }, abort.signal);
            if (!res.writableEnded && !res.destroyed) { res.writeHead(result.status, { 'X-Content-Type-Options': 'nosniff', ...result.headers }); res.end(result.body); }
          }
          return;
        }
        if (pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
        if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'METHOD_NOT_ALLOWED', '只支持 GET 或 HEAD 请求。'); }
        await staticFile(root, pathname, req, res);
      } catch (error) {
        if (error?.status === 413) { req.resume(); res.setHeader('Connection', 'close'); }
        json(res, error instanceof HttpError ? error.status : 503, { ok: false, error: { code: error instanceof HttpError ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof HttpError ? error.message : '服务暂时不可用。' } });
      } finally {
        clearTimeout(timer); res.off('close', onClose); active -= 1;
      }
    })();
    activeRequests.add(finished);
    finished.finally(() => activeRequests.delete(finished));
  });
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = maxRequests * 4;
  return {
    server,
    async listen(port = 3000, host = '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      return server.address();
    },
    async close() {
      closing = true;
      const stopped = new Promise(resolve => server.close(resolve));
      const timer = setTimeout(() => { media.close(); server.closeAllConnections(); }, 10_000);
      try { await stopped; media.close(); await Promise.allSettled([...activeRequests]); }
      finally { clearTimeout(timer); }
    },
  };
}
