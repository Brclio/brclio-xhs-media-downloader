import { AccountError, fail } from '../server/auth/errors.js';
import { readConfig } from '../server/auth/config.js';
import { createGithubStore } from '../server/auth/store.js';
import { createMailer } from '../server/auth/mailer.js';
import { createAccountService } from '../server/auth/service.js';

export const ADMIN_COOKIE = '__Host-xhs-admin';
export const BROWSER_COOKIE = '__Host-xhs-browser';
const MAX_BODY_BYTES = 16_384;
const FEEDBACK_BODY_BYTES = 1_600_000;
const header = (req, name) => String(req.headers?.[name] || '');

function bodyValue(req) {
  if (Number(header(req, 'content-length')) > FEEDBACK_BODY_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
  try {
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > FEEDBACK_BODY_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
      body = JSON.parse(body);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_REQUEST', '请求格式无效。');
    const limit = body.action === 'feedback-upload-part' ? FEEDBACK_BODY_BYTES : ['feedback-begin', 'feedback-reply', 'admin-feedback-reply', 'feedback-owner-reply', 'admin-save-update-proxy-config'].includes(body.action) ? 49_152 : MAX_BODY_BYTES;
    if (Buffer.byteLength(JSON.stringify(body)) > limit || Number(header(req, 'content-length')) > limit) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
    return body;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    fail('INVALID_JSON', '请求 JSON 格式无效。');
  }
}
function cookieValue(req, name) {
  const part = header(req, 'cookie').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : '';
}
function requireOrigin(req, origin) {
  let configured;
  try { configured = new URL(origin); } catch { fail('ADMIN_NOT_CONFIGURED', '管理员后台访问地址尚未配置。', 503); }
  if (configured.protocol !== 'https:' || configured.origin !== origin) fail('ADMIN_NOT_CONFIGURED', '管理员后台必须配置准确的 HTTPS Origin。', 503);
  if (header(req, 'origin') !== origin || header(req, 'sec-fetch-site') === 'cross-site') fail('ORIGIN_FORBIDDEN', '请求来源不受信任。', 403);
}

/** Injectable for HTTP boundary tests; the default instance is created lazily from platform Secrets. */
export function createAccountHandler({ service, config, env, clientIp, mailerFactory = createMailer, now = Date.now } = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin, Cookie, Authorization');
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail('METHOD_NOT_ALLOWED', '只支持 POST 请求。', 405); }
      if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) fail('UNSUPPORTED_MEDIA_TYPE', '请使用 JSON 请求。', 415);
      const body = bodyValue(req);
      // Workers supplies request-scoped bindings explicitly; never mutate process.env.
      // Omitted env retains the Vercel / local process environment behavior.
      const effectiveConfig = config || readConfig(env);
      const effectiveService = service || createAccountService({ store: createGithubStore(env), mailer: mailerFactory(env), config: effectiveConfig });
      const adminCookie = cookieValue(req, ADMIN_COOKIE), browserCookie = cookieValue(req, BROWSER_COOKIE);
      const bearer = header(req, 'authorization').match(/^Bearer ([A-Za-z0-9_-]{32,200})$/)?.[1] || '';
      const adminAction = body.action?.startsWith?.('admin-') || body.input?.client === 'admin';
      const browserFlow = !adminAction && (body.input?.client === 'browser' || ['feedback-owner-detail', 'feedback-owner-reply'].includes(body.action) || (body.action === 'feedback-public-comment' && Boolean(browserCookie)));
      const cookie = browserFlow ? browserCookie : adminCookie;
      const adminFlow = adminAction || (!browserFlow && Boolean(adminCookie));
      if (adminFlow || browserFlow || cookie) requireOrigin(req, effectiveConfig.siteOrigin);
      if ((adminCookie || browserCookie) && bearer) fail('AMBIGUOUS_CREDENTIALS', '请使用单一登录凭据。');
      // Only the deployment adapter can select another platform's trusted IP header.
      // The default is Vercel, which overwrites x-vercel-forwarded-for.
      const ip = clientIp ? clientIp(req) : header(req, 'x-vercel-forwarded-for').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
      const result = await effectiveService.execute({ action: body.action, input: body.input, proof: body.proof, token: bearer || cookie, ip, client: browserFlow ? 'browser' : adminFlow ? 'admin' : 'desktop' });
      if (body.action === 'verify-code' && ['admin', 'browser'].includes(body.input?.client)) {
        const cookieName = body.input.client === 'browser' ? BROWSER_COOKIE : ADMIN_COOKIE;
        res.setHeader('Set-Cookie', `${cookieName}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000`);
        const { token: ignored, ...publicResult } = result;
        return res.status(200).json({ ok: true, ...publicResult });
      }
      if (body.action === 'logout' && cookie) res.setHeader('Set-Cookie', `${browserFlow ? BROWSER_COOKIE : ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      const known = error instanceof AccountError;
      return res.status(known ? error.status : 503).json({ ok: false, error: { code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : '授权服务暂时不可用，请稍后重试。' }, serverTime: new Date(now()).toISOString() });
    }
  };
}

export default createAccountHandler();
