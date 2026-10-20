import { fail } from './errors.js';

/** The caller supplies the authenticated session kind, never input.client. */
export function paymentReturnUrl(origin, orderId, sessionClient) {
  let base;
  try { base = new URL(origin); if (base.protocol !== 'https:' || base.origin !== origin || base.username || base.password) throw Error(); }
  catch { fail('PAYMENT_NOT_CONFIGURED', '支付返回地址尚未配置。', 503); }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(orderId || '')) fail('PAYMENT_INVALID_ORDER', '支付订单编号无效。', 500);
  const url = new URL(sessionClient === 'desktop' ? '/payment-return' : '/', base);
  url.searchParams.set('payment_order', orderId);
  if (sessionClient === 'desktop') url.searchParams.set('client', 'desktop');
  return url.href;
}
