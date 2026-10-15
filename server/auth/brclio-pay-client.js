// SERVER ONLY: keep API/webhook secrets in the trusted backend.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AccountError, fail } from './errors.js';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (secret, value) => createHmac('sha256', secret).update(value, 'utf8').digest('hex');
const paymentId = value => typeof value === 'string' && /^pay_[a-f0-9]{32}$/.test(value);
const header = (headers, name) => String(typeof headers?.get === 'function' ? headers.get(name) || '' : headers?.[name.toLowerCase()] || '');

export function paymentAmountCents(amount) {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(amount) || amount === '0.00') fail('PAYMENT_INVALID_AMOUNT', '支付金额格式无效。', 502);
  const cents = Number(amount.replace('.', ''));
  if (!Number.isSafeInteger(cents) || cents < 1) fail('PAYMENT_INVALID_AMOUNT', '支付金额格式无效。', 502);
  return cents;
}

/** HMAC authentication is always server-to-server; nothing here is browser safe. */
export function createBrclioPayClient({ baseUrl = 'https://pay.bornforthis.cn', clientId, apiSecret, fetcher = fetch, now = Date.now }) {
  let origin;
  try { const url = new URL(baseUrl); if (url.protocol !== 'https:' || url.origin !== baseUrl || url.username || url.password) throw Error(); origin = url.origin; }
  catch { fail('PAYMENT_NOT_CONFIGURED', '支付中心地址配置无效。', 503); }
  if (clientId !== 'xhs-downloader' || typeof apiSecret !== 'string' || apiSecret.length < 32) fail('PAYMENT_NOT_CONFIGURED', '在线支付尚未配置。', 503);
  async function call(method, path, value) {
    const body = value === undefined ? '' : JSON.stringify(value);
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomBytes(24).toString('hex');
    const signature = hmac(apiSecret, [method, path, timestamp, nonce, sha256(body)].join('\n'));
    try {
      const response = await fetcher(new URL(path, origin), {
        method, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', 'X-Brclio-Client': clientId, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Signature': signature },
        ...(body ? { body } : {}),
      });
      // Never relay upstream error bodies; they may contain internal diagnostics.
      if (!response.ok) fail('PAYMENT_UNAVAILABLE', '支付中心暂时不可用，请保留本次请求并重试。', 503);
      const text = await response.text();
      if (Buffer.byteLength(text) > 131_072) fail('PAYMENT_UNAVAILABLE', '支付中心响应无效。', 503);
      const result = JSON.parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result)) fail('PAYMENT_UNAVAILABLE', '支付中心响应无效。', 503);
      return result;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      fail('PAYMENT_UNAVAILABLE', '支付中心暂时不可用，请保留本次请求并重试。', 503);
    }
  }
  function checkedId(id) {
    if (!paymentId(id)) fail('PAYMENT_INVALID_ORDER', '支付订单编号无效。');
    return id;
  }
  return {
    catalog: () => call('GET', '/api/v1/catalog'),
    createOrder: ({ productOrderId, sku, returnUrl }) => call('POST', '/api/v1/orders', { productOrderId, sku, returnUrl }),
    getOrder: id => call('GET', `/api/v1/orders/${checkedId(id)}`),
    refreshOrder: id => call('POST', `/api/v1/orders/${checkedId(id)}/refresh`, {}),
  };
}

/** Verify the original body before parsing; durable fulfillment happens separately. */
export function verifyBrclioPayEvent({ rawBody, headers, webhookSecret, clientId, mode = 'live', now = Date.now() }) {
  if (typeof webhookSecret !== 'string' || webhookSecret.length < 32) fail('PAYMENT_NOT_CONFIGURED', '支付回调尚未配置。', 503);
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > 16_384) fail('PAYMENT_INVALID_EVENT', '支付通知无效。', 401);
  const timestamp = header(headers, 'X-Brclio-Timestamp'), signature = header(headers, 'X-Brclio-Signature');
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/i.test(signature)) fail('PAYMENT_INVALID_SIGNATURE', '支付通知验签失败。', 401);
  const expected = hmac(webhookSecret, `${timestamp}.${rawBody}`);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) fail('PAYMENT_INVALID_SIGNATURE', '支付通知验签失败。', 401);
  let event;
  try { event = JSON.parse(rawBody); } catch { fail('PAYMENT_INVALID_EVENT', '支付通知无效。', 401); }
  const data = event?.data;
  if (event?.type !== 'payment.paid' || event.mode !== mode || event.id !== header(headers, 'X-Brclio-Event') || event.id !== `evt_${data?.orderId}` || !paymentId(data?.orderId) || data?.clientId !== clientId || data?.currency !== 'CNY' || typeof data?.productOrderId !== 'string' || typeof data?.sku !== 'string' || !/^\d{10,64}$/.test(data?.tradeNo || '') || typeof data?.paidAt !== 'string' || !Number.isFinite(Date.parse(data.paidAt)) || Date.parse(data.paidAt) > now + 300_000) fail('PAYMENT_INVALID_EVENT', '支付通知所属产品、环境或订单无效。', 401);
  try { paymentAmountCents(data.amount); } catch { fail('PAYMENT_INVALID_EVENT', '支付通知金额无效。', 401); }
  return event;
}
