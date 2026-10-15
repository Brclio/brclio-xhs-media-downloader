import { AccountError, fail } from '../server/auth/errors.js';
import { readConfig } from '../server/auth/config.js';
import { createGithubStore } from '../server/auth/store.js';
import { createAccountService } from '../server/auth/service.js';

// Vercel must give us the original bytes, including JSON whitespace and order.
export const config = { api: { bodyParser: false } };
const MAX_BYTES = 16_384;

async function rawBody(req) {
  if (Number(req.headers?.['content-length'] || 0) > MAX_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
  if (req.body !== undefined) {
    if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string') fail('INVALID_WEBHOOK_BODY', '支付通知必须保留原始请求体。');
    if (Buffer.byteLength(req.body) > MAX_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
    return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createBrclioPaymentHandler({ service, config: accountConfig, env, now = Date.now } = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail('METHOD_NOT_ALLOWED', '只支持 POST 请求。', 405); }
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) fail('UNSUPPORTED_MEDIA_TYPE', '请使用 JSON 请求。', 415);
      if (new URL(req.url || '/api/brclio-payment', 'https://account.internal').search) fail('INVALID_REQUEST', '支付通知不接受查询参数。');
      const body = await rawBody(req);
      const effectiveService = service || createAccountService({ store: createGithubStore(env), config: accountConfig || readConfig(env), mailer: { configured: false }, now });
      // This server-to-server endpoint uses only the signed body. Browser return
      // parameters and login cookies never authenticate a payment notification.
      await effectiveService.receivePayment({ rawBody: body, headers: new Headers(req.headers) });
      return res.status(200).json({ ok: true });
    } catch (error) {
      const known = error instanceof AccountError;
      return res.status(known ? error.status : 503).json({ ok: false, error: {
        code: known ? error.code : 'PAYMENT_UNAVAILABLE',
        message: known ? error.message : '支付通知暂未处理，请重试。',
      } });
    }
  };
}

export default createBrclioPaymentHandler();
