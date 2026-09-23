import parse from '../api/parse.js';
import image from '../api/image.js';
import video from '../api/video.js';
import { createAccountHandler } from '../api/account.js';
import packageInfo from '../package.json' with { type: 'json' };
import { parseWithFallback } from './parse-fallback.js';
export { AccountRuntime } from './account-runtime.js';
export { ParseRuntime } from './parse-runtime.js';
import { invokeHandler, readBoundedBody, RequestTooLargeError, MAX_API_BODY_BYTES, MAX_ACCOUNT_BODY_BYTES } from './http-adapter.js';

const NODE_ROUTES = { '/api/parse': parse, '/api/image': image, '/api/video': video };
const PYTHON_ROUTES = new Set(['/api/python_parse', '/api/python_image', '/api/python_video']);
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function json(body, status = 200, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

export function cloudflareClientIp(req) {
  // Cloudflare overwrites this on incoming requests. x-vercel-forwarded-for and
  // x-forwarded-for are caller-controlled here and must never enter rate limits.
  return String(req.headers?.['cf-connecting-ip'] || '').trim() || 'unknown';
}

function applySecurityHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  if (pathname.startsWith('/api/') || pathname.startsWith('/admin')) {
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
  }
  if (pathname.startsWith('/admin')) {
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Content-Security-Policy', ADMIN_CSP);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Overrides keep boundary tests independent from external media/account services. */
export function createWorker({ nodeRoutes = NODE_ROUTES, accountFactory = createAccountHandler } = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const path = url.pathname;
      let response;
      try {
        if (path === '/api/health') {
          response = request.method === 'GET' || request.method === 'HEAD'
            ? json({ ok: true, platform: 'cloudflare', version: env.VERSION || packageInfo.version, pythonBinding: Boolean(env.PYTHON_API?.fetch), ...(env.DEPLOYMENT?.id ? { deploymentId: env.DEPLOYMENT.id } : {}) })
            : json({ success: false, message: '只支持 GET 请求。' }, 405, { Allow: 'GET, HEAD' });
        } else if (path === '/api/account') {
          response = env.ACCOUNT_RUNTIME
            ? await env.ACCOUNT_RUNTIME.get(env.ACCOUNT_RUNTIME.idFromName('accounts-v1')).fetch(request)
            : await invokeHandler(accountFactory({ env, clientIp: cloudflareClientIp }), request, { maxBodyBytes: MAX_ACCOUNT_BODY_BYTES });
        } else if (['/api/parse', '/api/python_parse'].includes(path) && env.PARSE_RUNTIME) {
          response = await env.PARSE_RUNTIME.get(env.PARSE_RUNTIME.idFromName('parsing-v1')).fetch(request);
        } else if (Object.hasOwn(nodeRoutes, path)) {
          response = await parseWithFallback(request, env, nativeRequest => invokeHandler(nodeRoutes[path], nativeRequest));
        } else if (PYTHON_ROUTES.has(path)) {
          response = await parseWithFallback(request, env, async nativeRequest => {
          if (!env.PYTHON_API?.fetch) {
            return json({ success: false, engine: 'python', message: 'Python 服务暂时不可用，请稍后重试。' }, 503);
          } else {
            // Bound chunked uploads before forwarding; copying preserves method,
            // URL, query and headers while the private binding avoids public hops.
            const body = await readBoundedBody(nativeRequest, MAX_API_BODY_BYTES);
            const forwarded = new Request(nativeRequest, { body: ['GET', 'HEAD'].includes(nativeRequest.method) ? undefined : body });
            return env.PYTHON_API.fetch(forwarded);
          }
          });
        } else if (path.startsWith('/api/')) {
          response = json({ success: false, message: '接口不存在。' }, 404);
        } else if (env.ASSETS?.fetch) {
          // Static Assets handles extensionless HTML and directory indexes.
          response = await env.ASSETS.fetch(request);
        } else {
          response = new Response('Not Found', { status: 404 });
        }
      } catch (error) {
        const tooLarge = error instanceof RequestTooLargeError;
        response = path === '/api/account'
          ? json({ ok: false, error: { code: tooLarge ? 'REQUEST_TOO_LARGE' : 'SERVICE_UNAVAILABLE', message: tooLarge ? '请求内容过大。' : '授权服务暂时不可用，请稍后重试。' }, serverTime: new Date().toISOString() }, tooLarge ? 413 : 503)
          : json({ success: false, ...(PYTHON_ROUTES.has(path) ? { engine: 'python' } : {}), message: tooLarge ? '请求内容过大。' : '服务暂时不可用，请稍后重试。' }, tooLarge ? 413 : 503);
      }
      if (request.method === 'HEAD') response = new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      return applySecurityHeaders(response, path);
    },
  };
}

export default createWorker();
