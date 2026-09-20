import { AccountError, fail } from '../server/auth/errors.js';
import { readConfig } from '../server/auth/config.js';
import { createGithubStore } from '../server/auth/store.js';
import { createMailer } from '../server/auth/mailer.js';
import { createAccountService } from '../server/auth/service.js';

export const ADMIN_COOKIE = '__Host-xhs-admin';
const MAX_BODY_BYTES = 16_384;
const header = (req, name) => String(req.headers?.[name] || '');

function bodyValue(req) {
  if (Number(header(req, 'content-length')) > MAX_BODY_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
  let body = req.body;
  try {
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
      body = JSON.parse(body);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_REQUEST', '请求格式无效。');
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
    return body;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    fail('INVALID_JSON', '请求 JSON 格式无效。');
  }
}
function cookieValue(req) {
  const part = header(req, 'cookie').split(';').map(s => s.trim()).find(s => s.startsWith(`${ADMIN_COOKIE}=`));
  return part ? part.slice(ADMIN_COOKIE.length + 1) : '';
}
function requireOrigin(req, origin) {
  let configured;
  try { configured = new URL(origin); } catch { fail('ADMIN_NOT_CONFIGURED', '管理员后台访问地址尚未配置。', 503); }
  if (configured.protocol !== 'https:' || configured.origin !== origin) fail('ADMIN_NOT_CONFIGURED', '管理员后台必须配置准确的 HTTPS Origin。', 503);
  if (header(req, 'origin') !== origin || header(req, 'sec-fetch-site') === 'cross-site') fail('ORIGIN_FORBIDDEN', '请求来源不受信任。', 403);
}

/** Injectable for HTTP boundary tests; the default instance is created lazily from platform Secrets. */
export function createAccountHandler({ service, config, now = Date.now } = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin, Cookie, Authorization');
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail('METHOD_NOT_ALLOWED', '只支持 POST 请求。', 405); }
      if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) fail('UNSUPPORTED_MEDIA_TYPE', '请使用 JSON 请求。', 415);
      const body = bodyValue(req);
      const effectiveConfig = config || readConfig();
      const effectiveService = service || createAccountService({ store: createGithubStore(), mailer: createMailer(), config: effectiveConfig });
      const cookie = cookieValue(req);
      const bearer = header(req, 'authorization').match(/^Bearer ([A-Za-z0-9_-]{32,200})$/)?.[1] || '';
      const adminFlow = body.action?.startsWith?.('admin-') || body.input?.client === 'admin' || Boolean(cookie);
      if (adminFlow) requireOrigin(req, effectiveConfig.siteOrigin);
      if (cookie && bearer) fail('AMBIGUOUS_CREDENTIALS', '请使用单一登录凭据。');
      // Vercel overwrites x-vercel-forwarded-for. Never accept caller-controlled x-forwarded-for.
      const ip = header(req, 'x-vercel-forwarded-for').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
      const result = await effectiveService.execute({ action: body.action, input: body.input, proof: body.proof, token: bearer || cookie, ip, client: adminFlow ? 'admin' : 'desktop' });
      if (body.action === 'verify-code' && body.input?.client === 'admin') {
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000`);
        const { token: ignored, ...publicResult } = result;
        return res.status(200).json({ ok: true, ...publicResult });
      }
      if (body.action === 'logout' && cookie) res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      const known = error instanceof AccountError;
      return res.status(known ? error.status : 503).json({ ok: false, error: { code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : '授权服务暂时不可用，请稍后重试。' }, serverTime: new Date(now()).toISOString() });
    }
  };
}

export default createAccountHandler();
