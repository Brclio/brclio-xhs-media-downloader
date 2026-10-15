import { randomUUID } from 'node:crypto';
import { getMembershipPlan } from '../../lib/membership-plans.js';
import { PROTECTED_FEATURES } from '../../lib/membership-policy.js';
import { fail } from './errors.js';
import { createBrclioPayClient, paymentAmountCents, verifyBrclioPayEvent } from './brclio-pay-client.js';

const DAY = 86_400_000;
const owns = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const iso = time => new Date(time).toISOString();
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const payId = value => typeof value === 'string' && /^pay_[a-f0-9]{32}$/.test(value);
const invalidState = () => fail('STORAGE_INVALID', '在线支付数据格式异常。', 503);

/** Additive validation keeps the existing account JSON/SQLite transaction boundary. */
export function validateBrclioPayState(state) {
  if (state.paymentEvents === undefined) state.paymentEvents = {};
  if (!state.paymentEvents || typeof state.paymentEvents !== 'object' || Array.isArray(state.paymentEvents)) invalidState();
  const payments = new Set();
  for (const order of Object.values(state.orders || {})) {
    if (order?.source !== 'brclio_pay' && order?.paymentMethod !== 'brclio_pay') continue;
    const payment = order.payment, entitlement = order.entitlementSnapshot;
    if (order.source !== 'brclio_pay' || order.paymentMethod !== 'brclio_pay' || !payment || payment.clientId !== 'xhs-downloader' || payment.mode !== 'live' || payment.currency !== 'CNY' || typeof payment.sku !== 'string' || (payment.quoteAccepted && payment.sku !== order.planId) || !['creating', 'ready', 'quote_changed', 'paid'].includes(payment.state) || typeof payment.quoteAccepted !== 'boolean' || typeof payment.catalogVersion !== 'string' || !payment.catalogVersion || typeof payment.returnUrl !== 'string' || !entitlement || entitlement.type !== 'duration' || !Number.isSafeInteger(entitlement.days) || entitlement.days < 1 || entitlement.days > 36_500 || !Array.isArray(entitlement.features) || entitlement.features.some(feature => typeof feature !== 'string') || order.codeId) invalidState();
    try { paymentAmountCents(payment.quotedAmount); if (paymentAmountCents(payment.amount) !== order.priceCents) invalidState(); } catch { invalidState(); }
    if (payment.orderId !== null && (!payId(payment.orderId) || payments.has(payment.orderId))) invalidState();
    if (payment.orderId) payments.add(payment.orderId);
    if (payment.state !== 'creating' && !payment.orderId) invalidState();
    if (payment.state === 'ready' && !payment.quoteAccepted) invalidState();
    if (payment.state === 'quote_changed' && payment.quoteAccepted) invalidState();
    if (order.status === 'confirmed' && (payment.state !== 'paid' || !payment.quoteAccepted || order.amountCents !== order.priceCents)) invalidState();
  }
  for (const [eventId, event] of Object.entries(state.paymentEvents)) {
    const order = owns(state.orders || {}, event?.orderId);
    if (!event || eventId !== `evt_${event.paymentOrderId}` || !payId(event.paymentOrderId) || !uuid(event.orderId) || !validTime(event.at) || order?.source !== 'brclio_pay' || order.status !== 'confirmed' || order.payment?.orderId !== event.paymentOrderId) invalidState();
  }
  return state;
}

export function brclioOrderView(order) {
  return { id: order.id, userId: order.userId, planId: order.planId, planName: order.planName, priceCents: order.priceCents, amountCents: order.amountCents, status: order.status, paymentMethod: order.paymentMethod, paidAt: order.paidAt, createdAt: order.createdAt, confirmedAt: order.confirmedAt, codeId: null, source: order.source,
    paymentOrderId: order.payment.orderId, paymentStatus: order.status === 'confirmed' ? 'PAID' : order.payment.status || 'PENDING', quoteChanged: order.payment.state === 'quote_changed', days: order.entitlementSnapshot.days };
}

export function createBrclioPayService({ store, now = Date.now, authenticate, hash, config = {}, paymentClient, protectedFeatures = PROTECTED_FEATURES }) {
  function configured() {
    if (config.clientId !== 'xhs-downloader' || config.mode !== 'live') fail('PAYMENT_NOT_CONFIGURED', '在线支付尚未配置。', 503);
    let origin;
    try { origin = new URL(config.returnOrigin); if (origin.origin !== config.returnOrigin || origin.protocol !== 'https:') throw Error(); }
    catch { fail('PAYMENT_NOT_CONFIGURED', '支付返回地址尚未配置。', 503); }
    return paymentClient || createBrclioPayClient({ ...config, now });
  }
  function identity(state, request) {
    const result = authenticate(state, request, now());
    if (!['browser', 'desktop'].includes(result.session.client)) fail('USER_SESSION_REQUIRED', '请使用网页或客户端的软件账号操作。', 403);
    if (request.input.expectedUserId !== result.user.id) fail('ACCOUNT_CHANGED', '登录账号已变化，请刷新页面后重新操作。', 409);
    return result;
  }
  async function catalog() {
    const result = await configured().catalog(), source = result.catalog || result;
    if (source.clientId !== config.clientId || source.mode !== config.mode || source.currency !== 'CNY' || typeof source.enabled !== 'boolean' || (source.acceptingPayments !== undefined && typeof source.acceptingPayments !== 'boolean') || typeof source.version !== 'string' || !source.version || source.version.length > 128 || !source.skus || typeof source.skus !== 'object' || Array.isArray(source.skus)) fail('PAYMENT_INVALID_CATALOG', '支付商品目录无效。', 502);
    const plans = [];
    for (const [id, item] of Object.entries(source.skus)) {
      const local = getMembershipPlan(id);
      if (!local || item?.enabled === false) continue;
      if (!item || typeof item.subject !== 'string' || !item.subject.trim() || item.subject.length > 120 || (item.enabled !== undefined && typeof item.enabled !== 'boolean') || (item.description !== undefined && typeof item.description !== 'string') || (item.entitlement !== undefined && typeof item.entitlement !== 'string')) fail('PAYMENT_INVALID_CATALOG', '支付商品目录无效。', 502);
      plans.push({ id, name: item.subject, days: local.days, priceCents: paymentAmountCents(item.amount), amount: item.amount, description: item.description || '', entitlement: item.entitlement || '' });
    }
    return { enabled: source.enabled, ...(source.acceptingPayments !== undefined ? { acceptingPayments: source.enabled && source.acceptingPayments } : {}), mode: source.mode, currency: 'CNY', version: source.version, plans };
  }
  function checkedResponse(result, order, { allowChangedAmount = false } = {}) {
    const payment = result?.order || result;
    if (!payment || !payId(payment.id) || payment.productOrderId !== order.id || typeof payment.sku !== 'string' || (!allowChangedAmount && payment.sku !== order.payment.sku) || (payment.clientId !== undefined && payment.clientId !== config.clientId) || payment.mode !== config.mode || payment.currency !== 'CNY' || !['PENDING', 'PAID', 'CLOSED'].includes(payment.status)) fail('PAYMENT_INVALID_ORDER', '支付中心订单与业务订单不符。', 502);
    paymentAmountCents(payment.amount);
    if ((!allowChangedAmount && payment.amount !== order.payment.amount) || (order.payment.orderId && payment.id !== order.payment.orderId)) fail('PAYMENT_INVALID_ORDER', '支付中心订单金额或编号不符。', 502);
    return payment;
  }
  function checkout(result) {
    const value = result.checkoutUrl || result.order?.checkoutUrl;
    let url, base;
    try { url = new URL(value); base = new URL(config.baseUrl || 'https://pay.bornforthis.cn'); }
    catch { fail('PAYMENT_INVALID_ORDER', '支付收银台地址无效。', 502); }
    if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password || !/^#token=[A-Za-z0-9_-]{16,256}$/.test(url.hash)) fail('PAYMENT_INVALID_ORDER', '支付收银台地址无效。', 502);
    return url.href;
  }
  async function create(request) {
    const input = request.input;
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId) || !getMembershipPlan(input.planId) || typeof input.catalogVersion !== 'string' || !input.catalogVersion || input.catalogVersion.length > 128) fail('INVALID_ORDER', '请选择有效套餐并重新确认当前报价。');
    try { paymentAmountCents(input.amount); } catch { fail('INVALID_ORDER', '请选择有效套餐并重新确认当前报价。'); }
    const { state: initial } = await store.read(), { user } = identity(initial, request);
    const key = hash('brclio-payment-request', `${user.id}:${input.requestId}`);
    const inputHash = hash('brclio-payment-input', JSON.stringify({ planId: input.planId, amount: input.amount, catalogVersion: input.catalogVersion, expectedUserId: input.expectedUserId }));
    const prior = owns(initial.operations, key);
    if (prior && prior.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该请求 ID 已用于其他操作，请重新发起。', 409);
    let order;
    if (prior) {
      order = owns(initial.orders, prior.result?.orderId);
      if (!order || order.userId !== user.id || order.source !== 'brclio_pay') fail('PAYMENT_INVALID_ORDER', '业务订单记录无效。', 503);
    } else {
      if (user.membership?.type === 'permanent') fail('ALREADY_PERMANENT', '您已是永久会员，无需购买时长套餐。', 409);
      const current = await catalog(), plan = current.plans.find(item => item.id === input.planId);
      if (!current.enabled || !plan) fail('PAYMENT_PRODUCT_DISABLED', '该套餐暂不可购买，请刷新商品目录。', 409);
      if (current.acceptingPayments === false) fail('PAYMENT_SERVICE_DISABLED', '支付中心尚未启用在线收款，请稍后刷新报价或使用人工扫码。', 503);
      if (plan.amount !== input.amount || current.version !== input.catalogVersion) fail('QUOTE_CHANGED', '套餐报价已更新，请刷新并确认新报价后重新购买。', 409);
      const id = randomUUID();
      order = await store.transaction(state => {
        validateBrclioPayState(state);
        const { user: currentUser } = identity(state, request), existing = owns(state.operations, key);
        if (existing) {
          if (existing.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该请求 ID 已用于其他操作，请重新发起。', 409);
          return { changed: false, value: structuredClone(owns(state.orders, existing.result.orderId)) };
        }
        if (currentUser.membership?.type === 'permanent') fail('ALREADY_PERMANENT', '您已是永久会员，无需购买时长套餐。', 409);
        const created = { id, userId: currentUser.id, planId: plan.id, planName: plan.name, priceCents: plan.priceCents, amountCents: null, status: 'pending', paymentMethod: 'brclio_pay', paidAt: null, createdAt: iso(now()), confirmedAt: null, codeId: null, source: 'brclio_pay',
          entitlementSnapshot: { type: 'duration', days: plan.days, features: [...new Set([...protectedFeatures, 'watermark-free-video'])] },
          payment: { clientId: config.clientId, mode: config.mode, currency: 'CNY', sku: plan.id, catalogVersion: current.version, quotedAmount: plan.amount, amount: plan.amount, orderId: null, state: 'creating', quoteAccepted: false, status: 'PENDING', returnUrl: `${config.returnOrigin}/?payment_order=${encodeURIComponent(id)}` } };
        state.orders[id] = created;
        state.operations[key] = { actorId: currentUser.id, action: request.action, inputHash, at: iso(now()), result: { orderId: id } };
        return { value: structuredClone(created) };
      });
    }
    if (order.payment.state === 'quote_changed') fail('QUOTE_CHANGED', '套餐报价已更新，请刷新并确认新报价后使用新订单购买。', 409);
    if (order.status === 'confirmed') return { order: brclioOrderView(order), replayed: true };
    const result = await configured().createOrder({ productOrderId: order.id, sku: order.planId, returnUrl: order.payment.returnUrl });
    const authoritative = checkedResponse(result, order, { allowChangedAmount: true });
    const quoteMatches = authoritative.sku === order.planId && authoritative.amount === order.payment.quotedAmount;
    const checkoutUrl = quoteMatches && authoritative.status === 'PENDING' ? checkout(result) : undefined;
    const saved = await store.transaction(state => {
      identity(state, request);
      const current = owns(state.orders, order.id);
      if (!current || current.userId !== user.id || current.source !== 'brclio_pay' || (current.payment.orderId && current.payment.orderId !== authoritative.id)) fail('PAYMENT_INVALID_ORDER', '业务订单记录不符。', 503);
      if (current.status === 'confirmed') return { changed: false, value: structuredClone(current) };
      current.priceCents = paymentAmountCents(authoritative.amount);
      Object.assign(current.payment, { orderId: authoritative.id, sku: authoritative.sku, amount: authoritative.amount, status: authoritative.status, quoteAccepted: quoteMatches, state: quoteMatches ? 'ready' : 'quote_changed' });
      return { value: structuredClone(current) };
    });
    if (!saved.payment.quoteAccepted) fail('QUOTE_CHANGED', '套餐报价已更新，请刷新并确认新报价后使用新订单购买。', 409);
    return { order: brclioOrderView(saved), ...(checkoutUrl && saved.status !== 'confirmed' ? { checkoutUrl } : {}), replayed: Boolean(prior) };
  }
  async function status(request) {
    const { state } = await store.read(), { user } = identity(state, request), order = owns(state.orders, request.input.orderId);
    if (!order || order.userId !== user.id || order.source !== 'brclio_pay') fail('ORDER_NOT_FOUND', '没有找到当前账号的支付订单。', 404);
    if (!order.payment.orderId) return { order: brclioOrderView(order), paymentStatus: 'PENDING' };
    const payment = checkedResponse(await configured().getOrder(order.payment.orderId), order);
    // Querying or returning from checkout never grants membership. Only the
    // separately verified, durably committed webhook performs fulfillment.
    return { order: brclioOrderView(order), paymentStatus: payment.status };
  }
  async function receivePayment({ rawBody, headers }) {
    configured();
    const event = verifyBrclioPayEvent({ rawBody, headers, webhookSecret: config.webhookSecret, clientId: config.clientId, mode: config.mode, now: now() });
    return store.transaction(state => {
      validateBrclioPayState(state);
      const data = event.data, order = owns(state.orders, data.productOrderId);
      if (!order || order.source !== 'brclio_pay' || order.payment.clientId !== data.clientId || order.payment.mode !== event.mode || order.payment.currency !== data.currency || order.planId !== data.sku || order.payment.sku !== data.sku || order.payment.amount !== data.amount || order.priceCents !== paymentAmountCents(data.amount)) fail('PAYMENT_ORDER_MISMATCH', '支付通知与业务订单快照不符。', 409);
      if (order.payment.orderId !== data.orderId || !order.payment.quoteAccepted) fail('PAYMENT_ORDER_NOT_READY', '业务订单尚未确认当前支付报价，请稍后重试。', 409);
      const existing = owns(state.paymentEvents, event.id);
      if (existing) {
        if (existing.orderId !== order.id || existing.paymentOrderId !== data.orderId || order.transactionReference !== data.tradeNo) fail('PAYMENT_ORDER_MISMATCH', '支付通知重复记录不符。', 409);
        return { changed: false, value: { received: true, replayed: true } };
      }
      if (order.status === 'confirmed' || Object.values(state.paymentEvents).some(item => item.paymentOrderId === data.orderId)) fail('PAYMENT_ORDER_MISMATCH', '支付订单已由另一通知确认。', 409);
      const user = owns(state.users, order.userId);
      if (!user) fail('PAYMENT_ORDER_MISMATCH', '支付订单账号不存在。', 409);
      const time = now(), before = structuredClone(user.membership || { type: 'none', startsAt: null, expiresAt: null });
      // A later administrative permanent grant must never be downgraded by an
      // earlier duration purchase. The paid receipt still remains accounted for.
      if (before.type !== 'permanent') {
        const active = before.type === 'duration' && Date.parse(before.startsAt) <= time && Date.parse(before.expiresAt) > time;
        user.membership = { type: 'duration', startsAt: active ? before.startsAt : iso(time), expiresAt: iso(Math.max(time, Date.parse(before.expiresAt) || 0) + order.entitlementSnapshot.days * DAY) };
      }
      Object.assign(order, { status: 'confirmed', amountCents: order.priceCents, paidAt: iso(Date.parse(data.paidAt)), confirmedAt: iso(time), confirmedBy: 'brclio-pay', transactionReference: data.tradeNo, paymentKey: hash('order-payment', `brclio_pay:${data.orderId}`), reason: 'Brclio Pay 验签付款通知自动开通会员' });
      Object.assign(order.payment, { state: 'paid', status: 'PAID' });
      state.paymentEvents[event.id] = { orderId: order.id, paymentOrderId: data.orderId, at: iso(time) };
      state.audit.push({ id: randomUUID(), action: 'brclio-payment-paid', actorId: 'brclio-pay', targetId: user.id, at: iso(time), reason: `支付订单 ${order.id}`, before, after: structuredClone(user.membership), orderId: order.id });
      return { value: { received: true, replayed: false } };
    });
  }
  return { execute: request => request.action === 'payment-catalog' ? catalog().then(value => ({ catalog: value })) : request.action === 'payment-create' ? create(request) : status(request), receivePayment };
}
