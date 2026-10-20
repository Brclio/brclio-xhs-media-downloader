// SERVER ONLY: product API and webhook secrets must stay in the trusted backend.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.js';

const CLIENT_ID = 'p-2bb6d77a673327a2f8d881bac2d4fe26';
const MAX_RESPONSE_BYTES = 131_072;
const hmac = (secret, value) => createHmac('sha256', secret).update(value, 'utf8').digest('hex');
const validText = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/u.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name.toLowerCase());
  return typeof headers?.[key] === 'string' ? headers[key] : '';
}

function validOrderId(value) {
  // Center IDs are opaque. Encode them as one path parameter without assuming a prefix.
  return validText(value) && value !== '.' && value !== '..';
}

async function responseText(response) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    fail('PAYMENT_UNAVAILABLE', '支付中心响应无效。', 503);
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) fail('PAYMENT_UNAVAILABLE', '支付中心响应无效。', 503);
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail('PAYMENT_UNAVAILABLE', '支付中心响应无效。', 503);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
}

function upstreamFailure(result) {
  const code = result?.error?.code || result?.code;
  if (code === 'CATALOG_PRICE_CHANGED') {
    fail('QUOTE_CHANGED', '支付金额已变化，请刷新套餐后重试。', 409);
  }
  fail('PAYMENT_UNAVAILABLE', '微信支付暂时不可用，请保留本次订单并重试。', 503);
}

/** Sign and send the same JSON bytes using this center's independent product key. */
export function createBrclioWechatPayClient({ baseUrl = 'https://paywc.bornforthis.cn', clientId, apiKey, fetcher = fetch, now = Date.now }) {
  let origin;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.origin !== baseUrl || url.username || url.password) throw Error();
    origin = url.origin;
  } catch { fail('PAYMENT_NOT_CONFIGURED', '微信支付中心地址配置无效。', 503); }
  if (clientId !== CLIENT_ID || typeof apiKey !== 'string' || apiKey.length < 32 || typeof fetcher !== 'function' || typeof now !== 'function') {
    fail('PAYMENT_NOT_CONFIGURED', '微信支付尚未配置。', 503);
  }
  async function call(method, path, value) {
    const body = value === undefined ? '' : JSON.stringify(value);
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = hmac(apiKey, `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
    let response, result;
    try {
      response = await fetcher(new URL(path, origin), {
        method, redirect: 'manual', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', 'X-Brclio-Client': clientId, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Signature': signature },
        ...(body ? { body } : {}),
      });
      // Redirects never receive a second signed request or expose checkout credentials.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel?.().catch(() => {});
        fail('PAYMENT_UNAVAILABLE', '微信支付暂时不可用，请保留本次订单并重试。', 503);
      }
      result = JSON.parse(await responseText(response));
    } catch {
      fail('PAYMENT_UNAVAILABLE', '微信支付暂时不可用，请保留本次订单并重试。', 503);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('PAYMENT_UNAVAILABLE', '支付中心响应无效。', 503);
    if (!response.ok) upstreamFailure(result);
    return result;
  }
  function checkedId(id) {
    if (!validOrderId(id)) fail('PAYMENT_INVALID_ORDER', '支付订单编号无效。');
    return encodeURIComponent(id);
  }
  return {
    createOrder: (input = {}) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PAYMENT_INVALID_ORDER', '支付订单参数无效。');
      const { merchantOrderId, sku, quantity = 1, channel = 'native', expectedTotal, returnUrl } = input;
      if (!validText(merchantOrderId, 128) || !validText(sku, 128) || quantity !== 1 || channel !== 'native' || !positiveInteger(expectedTotal)) {
        fail('PAYMENT_INVALID_ORDER', '支付订单参数无效。');
      }
      if (returnUrl !== undefined) {
        try {
          const url = new URL(returnUrl);
          if (typeof returnUrl !== 'string' || returnUrl.length > 2048 || url.protocol !== 'https:' || url.username || url.password) throw Error();
        } catch { fail('PAYMENT_INVALID_ORDER', '支付返回地址无效。'); }
      }
      return call('POST', '/api/v1/orders', { merchantOrderId, sku, quantity, channel, expectedTotal, ...(returnUrl !== undefined ? { returnUrl } : {}) });
    },
    getOrder: id => call('GET', `/api/v1/orders/${checkedId(id)}`),
    refreshOrder: id => call('POST', `/api/v1/orders/${checkedId(id)}/refresh`, {}),
  };
}

/** Authenticate original bytes; the fulfillment transaction durably deduplicates eventId. */
export function verifyBrclioWechatPayEvent({ rawBody, headers, webhookSecret, clientId, now = Date.now() }) {
  if (typeof webhookSecret !== 'string' || webhookSecret.length < 32 || clientId !== CLIENT_ID) fail('PAYMENT_NOT_CONFIGURED', '微信支付回调尚未配置。', 503);
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > 16_384) fail('PAYMENT_INVALID_EVENT', '支付通知无效。', 401);
  const timestamp = header(headers, 'X-Brclio-Timestamp'), nonce = header(headers, 'X-Brclio-Nonce'), signature = header(headers, 'X-Brclio-Signature');
  if (!Number.isFinite(now) || !/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) >= 300 || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) {
    fail('PAYMENT_INVALID_SIGNATURE', '支付通知验签失败。', 401);
  }
  const expected = hmac(webhookSecret, `${timestamp}\n${nonce}\n${rawBody}\n`);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) fail('PAYMENT_INVALID_SIGNATURE', '支付通知验签失败。', 401);
  let event;
  try { event = JSON.parse(rawBody); } catch { fail('PAYMENT_INVALID_EVENT', '支付通知无效。', 401); }
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== 'payment.success' || event.clientId !== clientId || !validOrderId(event.orderId) || event.eventId !== `payment.success.${event.orderId}` || header(headers, 'X-Brclio-Event') !== event.eventId || !validText(event.merchantOrderId, 128) || !validText(event.sku, 128) || event.quantity !== 1 || !positiveInteger(event.total) || event.currency !== 'CNY' || !validText(event.transactionId, 128) || typeof event.paidAt !== 'string' || event.paidAt.length > 64 || !Number.isFinite(Date.parse(event.paidAt)) || Date.parse(event.paidAt) < 0 || Date.parse(event.paidAt) > now + 300_000) {
    fail('PAYMENT_INVALID_EVENT', '支付通知所属产品、订单或金额无效。', 401);
  }
  return event;
}
