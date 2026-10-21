import { createHash, randomUUID } from 'node:crypto';
import { MEMBERSHIP_PLANS, getMembershipPlan } from '../../lib/membership-plans.js';
import { PROTECTED_FEATURES } from '../../lib/membership-policy.js';
import { fail } from './errors.js';
import { createBrclioWechatPayClient, verifyBrclioWechatPayEvent } from './brclio-wechat-pay-client.js';
import { hasWechatTransaction, normalizePaymentReference } from './payment-reference.js';
import { paymentReturnUrl } from './payment-return-url.js';

const CLIENT_ID = 'p-2bb6d77a673327a2f8d881bac2d4fe26';
const CENTER = 'https://paywc.bornforthis.cn';
const SOURCE = 'brclio_wechat';
const DAY = 86_400_000;
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const iso = time => new Date(time).toISOString();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const paymentId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const transactionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{10,120}$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const invalidState = () => fail('STORAGE_INVALID', '微信支付数据格式异常。', 503);

/** Independent provider fields preserve every legacy Alipay order and event. */
export function validateBrclioWechatPayState(state) {
  if (state.wechatPaymentEvents === undefined) state.wechatPaymentEvents = {};
  if (!state.wechatPaymentEvents || typeof state.wechatPaymentEvents !== 'object' || Array.isArray(state.wechatPaymentEvents)) invalidState();
  const centers = new Set(), transactions = new Set();
  for (const [id, order] of Object.entries(state.orders || {})) {
    if (order?.source !== SOURCE && order?.paymentMethod !== SOURCE) continue;
    const p = order.payment, entitlement = order.entitlementSnapshot;
    if (order.source !== SOURCE || order.paymentMethod !== SOURCE || order.id !== id || !uuid(id) || typeof order.userId !== 'string' || !p || p.clientId !== CLIENT_ID || p.centerOrigin !== CENTER || p.userId !== order.userId || p.merchantOrderId !== id || p.sku !== order.planId || p.currency !== 'CNY' || p.quantity !== 1 || !Number.isSafeInteger(p.total) || p.total < 1 || order.priceCents !== p.total || typeof p.catalogVersion !== 'string' || !p.catalogVersion || typeof p.returnUrl !== 'string' || !['creating', 'ready', 'paid'].includes(p.state) || !['PENDING', 'PAID', 'CLOSED'].includes(p.status) || !entitlement || entitlement.type !== 'duration' || !Number.isSafeInteger(entitlement.days) || entitlement.days < 1 || entitlement.days > 36_500 || !Array.isArray(entitlement.features) || entitlement.features.some(feature => typeof feature !== 'string') || order.codeId) invalidState();
    if (p.orderId !== null && (!paymentId(p.orderId) || centers.has(p.orderId))) invalidState();
    if (p.orderId) centers.add(p.orderId);
    if (p.state !== 'creating' && !p.orderId) invalidState();
    if (order.status === 'confirmed') {
      if (p.state !== 'paid' || p.status !== 'PAID' || order.amountCents !== order.priceCents || !transactionId(order.transactionReference) || transactions.has(normalizePaymentReference(order.transactionReference))) invalidState();
      transactions.add(normalizePaymentReference(order.transactionReference));
    } else if (order.status !== 'pending' || p.state === 'paid' || p.status === 'PAID') invalidState();
  }
  for (const [eventId, event] of Object.entries(state.wechatPaymentEvents)) {
    const order = own(state.orders || {}, event?.orderId);
    if (!event || eventId !== `payment.success.${event.paymentOrderId}` || !paymentId(event.paymentOrderId) || !uuid(event.orderId) || !validTime(event.at) || !transactionId(event.transactionId) || order?.source !== SOURCE || order.status !== 'confirmed' || order.payment?.orderId !== event.paymentOrderId || order.transactionReference !== event.transactionId) invalidState();
  }
  return state;
}

export function brclioWechatOrderView(order) {
  return { id: order.id, userId: order.userId, planId: order.planId, planName: order.planName, priceCents: order.priceCents, amountCents: order.amountCents, status: order.status, paymentMethod: order.paymentMethod, provider: 'wechat', paidAt: order.paidAt, createdAt: order.createdAt, confirmedAt: order.confirmedAt, codeId: null, source: order.source,
    paymentOrderId: order.payment.orderId, paymentStatus: order.status === 'confirmed' ? 'PAID' : order.payment.status, quoteChanged: false, days: order.entitlementSnapshot.days };
}

export function createBrclioWechatPayService({ store, now = Date.now, authenticate, hash, config = {}, paymentClient, protectedFeatures = PROTECTED_FEATURES }) {
  function configured() {
    if (config.clientId !== CLIENT_ID || config.baseUrl !== CENTER) fail('PAYMENT_NOT_CONFIGURED', '微信在线支付尚未配置。', 503);
    try { const url = new URL(config.returnOrigin); if (url.protocol !== 'https:' || url.origin !== config.returnOrigin || url.username || url.password) throw Error(); }
    catch { fail('PAYMENT_NOT_CONFIGURED', '支付返回地址尚未配置。', 503); }
    return paymentClient || createBrclioWechatPayClient({ ...config, now });
  }
  function identity(state, request) {
    const result = authenticate(state, request, now());
    if (!['browser', 'desktop'].includes(result.session.client)) fail('USER_SESSION_REQUIRED', '请使用网页或客户端的软件账号操作。', 403);
    if (request.input.expectedUserId !== result.user.id) fail('ACCOUNT_CHANGED', '登录账号已变化，请刷新页面后重新操作。', 409);
    return result;
  }
  function catalog() {
    configured();
    const plans = MEMBERSHIP_PLANS.map(plan => ({ id: plan.id, name: plan.name, days: plan.days, priceCents: plan.priceCents, amount: (plan.priceCents / 100).toFixed(2), description: `Brclio 小红书下载器${plan.name}会员（${plan.days} 天，按次购买不自动续费）`, entitlement: `${plan.days} 天会员` }));
    const version = createHash('sha256').update(JSON.stringify({ clientId: CLIENT_ID, centerOrigin: CENTER, plans })).digest('hex');
    // This center has no public catalog endpoint. The registered local quote is
    // enforced again by expectedTotal at signed order creation.
    return { enabled: true, mode: 'live', currency: 'CNY', provider: 'wechat', channels: ['native'], version, plans };
  }
  function ownedOrder(state, request, user) {
    const order = uuid(request.input.orderId) ? own(state.orders, request.input.orderId) : null;
    if (!order || order.userId !== user.id || order.source !== SOURCE) fail('ORDER_NOT_FOUND', '没有找到当前账号的支付订单。', 404);
    return order;
  }
  function checkedPayment(result, order) {
    const raw = result?.order || result;
    if (!raw || typeof raw !== 'object' || (raw.total !== undefined && raw.amount?.total !== undefined && raw.total !== raw.amount.total) || (raw.currency !== undefined && raw.amount?.currency !== undefined && raw.currency !== raw.amount.currency)) fail('PAYMENT_INVALID_ORDER', '微信支付中心订单与业务订单不符。', 502);
    const p = { ...raw, total: raw.amount?.total ?? raw.total, currency: raw.amount?.currency ?? raw.currency, status: ({ CREATING: 'PENDING', SUCCESS: 'PAID', PAYERROR: 'CLOSED' })[raw.status] || raw.status };
    if (!paymentId(p.id) || p.clientId !== order.payment.clientId || p.merchantOrderId !== order.id || p.sku !== order.payment.sku || p.quantity !== 1 || p.total !== order.payment.total || p.currency !== 'CNY' || !['PENDING', 'PAID', 'CLOSED'].includes(p.status) || (p.channel !== undefined && p.channel !== 'native') || (p.payment?.channel !== undefined && p.payment.channel !== 'native') || (order.payment.orderId && p.id !== order.payment.orderId)) fail('PAYMENT_INVALID_ORDER', '微信支付中心订单与业务订单不符。', 502);
    if (p.status === 'PAID' && (!transactionId(p.transactionId) || !validTime(p.paidAt) || Date.parse(p.paidAt) > now() + 300_000)) fail('PAYMENT_INVALID_ORDER', '微信支付凭证无效。', 502);
    return p;
  }
  function checkout(result, centerId) {
    const raw = result.checkoutUrl || result.order?.checkoutUrl;
    let url;
    try { url = new URL(raw); } catch { fail('PAYMENT_INVALID_ORDER', '微信收银台地址无效。', 502); }
    const fragment = new URLSearchParams(url.hash.slice(1)), token = fragment.get('token');
    if (url.origin !== CENTER || url.pathname !== `/checkout/${centerId}` || url.search || url.username || url.password || fragment.size !== 1 || !token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) fail('PAYMENT_INVALID_ORDER', '微信收银台地址无效。', 502);
    return url.href;
  }
  function nativeQr(remote, order) {
    const unavailable = { qrCodeUrl: null, qrCodeExpiresAt: null };
    if (!remote || order.status !== 'pending' || order.payment.status !== 'PENDING' || remote.status !== 'PENDING' || order.payment.orderId !== remote.id) return unavailable;
    const value = remote.payment?.codeUrl, expiresAt = remote.expiresAt;
    if (remote.payment?.channel !== 'native' || typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(value) || typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt) || !validTime(expiresAt)) return unavailable;
    const expires = Date.parse(expiresAt);
    if (expires <= now()) return unavailable;
    let url;
    try { url = new URL(value); } catch { return unavailable; }
    const code = url.searchParams.get('pr');
    if (url.protocol !== 'weixin:' || url.hostname !== 'wxpay' || url.port || url.username || url.password || url.pathname !== '/bizpayurl' || url.hash || url.searchParams.size !== 1 || !code || !/^[A-Za-z0-9_-]{1,1024}$/.test(code)) return unavailable;
    // This ephemeral owner-only projection is never saved in orders, operation
    // results or audit entries. It carries no authority to grant membership.
    return { qrCodeUrl: value, qrCodeExpiresAt: iso(expires) };
  }
  function paidData(p) {
    return { eventId: `payment.success.${p.id}`, orderId: p.id, clientId: p.clientId, merchantOrderId: p.merchantOrderId, sku: p.sku, quantity: p.quantity, total: p.total, currency: p.currency, transactionId: p.transactionId, paidAt: p.paidAt };
  }
  /** Both authenticated queries and signed callbacks commit this one function. */
  async function fulfill(data, request) {
    return store.transaction(state => {
      validateBrclioWechatPayState(state);
      if (request) identity(state, request);
      const order = own(state.orders, data.merchantOrderId), p = order?.payment;
      if (!order || order.source !== SOURCE || p.centerOrigin !== CENTER || p.clientId !== config.clientId || p.clientId !== data.clientId || p.userId !== order.userId || p.merchantOrderId !== data.merchantOrderId || order.planId !== data.sku || p.sku !== data.sku || p.quantity !== data.quantity || p.total !== data.total || order.priceCents !== data.total || p.currency !== data.currency || data.currency !== 'CNY' || data.eventId !== `payment.success.${data.orderId}` || !transactionId(data.transactionId) || !validTime(data.paidAt) || Date.parse(data.paidAt) > now() + 300_000) fail('PAYMENT_ORDER_MISMATCH', '微信支付通知与业务订单快照不符。', 409);
      if (request && order.userId !== request.input.expectedUserId) fail('PAYMENT_ORDER_MISMATCH', '微信支付订单账号不符。', 409);
      if (!p.orderId || p.orderId !== data.orderId || p.state === 'creating') fail('PAYMENT_ORDER_NOT_READY', '业务订单尚未绑定微信支付订单，请稍后重试。', 409);
      const existing = own(state.wechatPaymentEvents, data.eventId);
      if (existing) {
        if (existing.orderId !== order.id || existing.paymentOrderId !== data.orderId || normalizePaymentReference(existing.transactionId) !== normalizePaymentReference(data.transactionId) || normalizePaymentReference(order.transactionReference) !== normalizePaymentReference(data.transactionId)) fail('PAYMENT_ORDER_MISMATCH', '微信支付重复通知不符。', 409);
        return { changed: false, value: { received: true, replayed: true } };
      }
      if (order.status === 'confirmed' || Object.values(state.wechatPaymentEvents).some(event => event.paymentOrderId === data.orderId || normalizePaymentReference(event.transactionId) === normalizePaymentReference(data.transactionId)) || hasWechatTransaction(state, data.transactionId, order.id)) fail('PAYMENT_ORDER_MISMATCH', '微信交易已关联其他收款记录。', 409);
      const user = own(state.users, p.userId);
      if (!user || user.id !== order.userId) fail('PAYMENT_ORDER_MISMATCH', '微信支付订单账号不存在。', 409);
      const time = now(), before = structuredClone(user.membership || { type: 'none', startsAt: null, expiresAt: null });
      if (before.type !== 'permanent') {
        const active = before.type === 'duration' && Date.parse(before.startsAt) <= time && Date.parse(before.expiresAt) > time;
        user.membership = { type: 'duration', startsAt: active ? before.startsAt : iso(time), expiresAt: iso(Math.max(time, Date.parse(before.expiresAt) || 0) + order.entitlementSnapshot.days * DAY) };
      }
      Object.assign(order, { status: 'confirmed', amountCents: order.priceCents, paidAt: iso(Date.parse(data.paidAt)), confirmedAt: iso(time), confirmedBy: 'brclio-wechat-pay', transactionReference: data.transactionId, paymentKey: hash('order-payment', `${SOURCE}:${data.transactionId}`), reason: 'Brclio 微信支付服务端核验自动开通会员' });
      Object.assign(p, { state: 'paid', status: 'PAID' });
      state.wechatPaymentEvents[data.eventId] = { orderId: order.id, paymentOrderId: data.orderId, transactionId: data.transactionId, at: iso(time) };
      state.audit.push({ id: randomUUID(), action: 'brclio-wechat-payment-paid', actorId: 'brclio-wechat-pay', targetId: user.id, at: iso(time), reason: `支付订单 ${order.id}`, before, after: structuredClone(user.membership), orderId: order.id });
      return { value: { received: true, replayed: false } };
    });
  }
  async function create(request) {
    configured();
    const input = request.input;
    const { state } = await store.read(), { user } = identity(state, request);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestId) || !getMembershipPlan(input.planId) || typeof input.amount !== 'string' || !/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(input.amount) || typeof input.catalogVersion !== 'string' || !input.catalogVersion || input.catalogVersion.length > 128) fail('INVALID_ORDER', '请选择有效套餐并重新确认当前报价。');
    const key = hash('brclio-payment-request', `${user.id}:${input.requestId}`);
    const inputHash = hash('brclio-payment-input', JSON.stringify({ provider: 'wechat', planId: input.planId, amount: input.amount, catalogVersion: input.catalogVersion, expectedUserId: input.expectedUserId }));
    const prior = own(state.operations, key);
    if (prior) {
      if (prior.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该请求 ID 已用于其他操作，请重新发起。', 409);
      const existing = own(state.orders, prior.result?.orderId);
      if (!existing || existing.source !== SOURCE || existing.userId !== user.id) fail('PAYMENT_INVALID_ORDER', '微信业务订单记录无效。', 503);
      return synchronize(request, existing, true);
    }
    const quote = catalog(), plan = quote.plans.find(item => item.id === input.planId);
    if (!plan || input.amount !== plan.amount || input.catalogVersion !== quote.version) fail('QUOTE_CHANGED', '套餐报价已更新，请刷新并确认当前报价。', 409);
    const order = await store.transaction(current => {
      validateBrclioWechatPayState(current);
      const { user: owner, session } = identity(current, request), prior = own(current.operations, key);
      if (prior) {
        if (prior.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该请求 ID 已用于其他操作，请重新发起。', 409);
        const existing = own(current.orders, prior.result?.orderId);
        if (!existing || existing.source !== SOURCE || existing.userId !== owner.id) fail('PAYMENT_INVALID_ORDER', '微信业务订单记录无效。', 503);
        return { changed: false, value: structuredClone(existing) };
      }
      if (owner.membership?.type === 'permanent') fail('ALREADY_PERMANENT', '您已是永久会员，无需购买时长套餐。', 409);
      const id = randomUUID(), created = { id, userId: owner.id, planId: plan.id, planName: plan.name, priceCents: plan.priceCents, amountCents: null, status: 'pending', paymentMethod: SOURCE, source: SOURCE, paidAt: null, createdAt: iso(now()), confirmedAt: null, codeId: null,
        entitlementSnapshot: { type: 'duration', days: plan.days, features: [...new Set([...protectedFeatures, 'watermark-free-video'])] },
        payment: { centerOrigin: CENTER, clientId: CLIENT_ID, userId: owner.id, merchantOrderId: id, sku: plan.id, quantity: 1, total: plan.priceCents, currency: 'CNY', catalogVersion: quote.version, returnUrl: paymentReturnUrl(config.returnOrigin, id, session.client), orderId: null, state: 'creating', status: 'PENDING' } };
      current.orders[id] = created;
      current.operations[key] = { actorId: owner.id, action: request.action, inputHash, at: iso(now()), result: { orderId: id } };
      return { value: structuredClone(created) };
    });
    return synchronize(request, order, false);
  }
  async function query(request, order) {
    if (order.status === 'confirmed' || order.payment.status === 'CLOSED' || !order.payment.orderId) return { order, remote: null };
    let p = checkedPayment(await configured().getOrder(order.payment.orderId), order);
    if (p.status === 'PENDING') p = checkedPayment(await configured().refreshOrder(order.payment.orderId), order);
    if (p.status === 'PAID') await fulfill(paidData(p), request);
    else if (p.status === 'CLOSED') await store.transaction(state => {
      const { user } = identity(state, request), current = ownedOrder(state, { ...request, input: { ...request.input, orderId: order.id } }, user);
      if (current.status === 'confirmed') return { changed: false, value: null };
      if (current.payment.orderId !== p.id) fail('PAYMENT_ORDER_MISMATCH', '微信支付订单编号不符。', 409);
      current.payment.status = 'CLOSED';
      return { value: null };
    });
    const { state } = await store.read();
    const { user } = identity(state, request);
    return { order: ownedOrder(state, { ...request, input: { ...request.input, orderId: order.id } }, user), remote: p };
  }
  async function synchronize(request, order, replayed) {
    ({ order } = await query(request, order));
    if (order.status === 'confirmed' || order.payment.status === 'CLOSED') return { order: brclioWechatOrderView(order), ...nativeQr(null, order), replayed: true };
    const p = order.payment;
    const result = await configured().createOrder({ merchantOrderId: order.id, sku: p.sku, quantity: 1, channel: 'native', expectedTotal: p.total, returnUrl: p.returnUrl });
    const created = result?.order || result;
    if (!paymentId(created?.id) || (p.orderId && created.id !== p.orderId)) fail('PAYMENT_INVALID_ORDER', '微信支付中心订单编号不符。', 502);
    // Some center releases return only a checkout projection from POST. Read
    // the authenticated full order before accepting its business binding.
    const remote = checkedPayment(created.clientId === undefined || created.merchantOrderId === undefined || created.sku === undefined || created.quantity === undefined || (created.total === undefined && created.amount?.total === undefined) ? await configured().getOrder(created.id) : result, order);
    if (remote.id !== created.id) fail('PAYMENT_INVALID_ORDER', '微信支付中心订单编号不符。', 502);
    const checkoutUrl = remote.status === 'PENDING' ? checkout(result, remote.id) : undefined;
    const saved = await store.transaction(state => {
      validateBrclioWechatPayState(state);
      const { user } = identity(state, request), current = ownedOrder(state, { ...request, input: { ...request.input, orderId: order.id } }, user);
      if (current.payment.orderId && current.payment.orderId !== remote.id) fail('PAYMENT_INVALID_ORDER', '微信支付订单绑定不符。', 503);
      if (Object.values(state.orders).some(item => item.id !== order.id && item.source === SOURCE && item.payment?.orderId === remote.id)) fail('PAYMENT_ORDER_MISMATCH', '微信支付订单已关联其他业务订单。', 409);
      if (current.status === 'confirmed' || current.payment.status === 'CLOSED') return { changed: false, value: structuredClone(current) };
      Object.assign(current.payment, { orderId: remote.id, state: 'ready', status: remote.status === 'PAID' ? 'PENDING' : remote.status });
      return { value: structuredClone(current) };
    });
    // A create response may bind the identifier, but paid fulfillment requires a
    // separately signed get/refresh query or a verified webhook.
    const final = remote.status === 'PAID' ? await query(request, saved) : { order: saved, remote };
    const finalOrder = final.order;
    return { order: brclioWechatOrderView(finalOrder), ...nativeQr(final.remote, finalOrder), ...(checkoutUrl && finalOrder.status !== 'confirmed' && finalOrder.payment.status === 'PENDING' ? { checkoutUrl } : {}), replayed };
  }
  async function resume(request) {
    const { state } = await store.read(), { user } = identity(state, request);
    return synchronize(request, ownedOrder(state, request, user), true);
  }
  async function status(request) {
    const { state } = await store.read(), { user } = identity(state, request);
    const { order, remote } = await query(request, ownedOrder(state, request, user));
    const view = brclioWechatOrderView(order);
    return { order: view, paymentStatus: view.paymentStatus, ...nativeQr(remote, order) };
  }
  async function receivePayment({ rawBody, headers }) {
    configured();
    const event = verifyBrclioWechatPayEvent({ rawBody, headers, webhookSecret: config.webhookSecret, clientId: config.clientId, now: now() });
    return fulfill(event);
  }
  return { execute: request => request.action === 'payment-catalog' ? Promise.resolve({ catalog: catalog() }) : request.action === 'payment-create' ? create(request) : request.action === 'payment-resume' ? resume(request) : status(request), receivePayment };
}
