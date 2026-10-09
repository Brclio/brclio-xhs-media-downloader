import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { getMembershipPlan } from '../../lib/membership-plans.js';
import { defaultReviewNickname, normalizeReviewNickname } from '../../lib/review-nicknames.js';

const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const iso = time => new Date(time).toISOString();
const methods = ['alipay', 'wechat', 'other'];
const maxAmount = 1_000_000_000;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
// Keep URL paths and query keys when an address appears inside a link. Quoted
// local parts, dot-atoms and IP literals share the same email-only redaction.
const emailPattern = /((?:https?:\/\/|www\.)[^\s<>"@]*[/?&#=])?(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+|\[(?:IPv6:[a-f0-9:.]+|(?:\d{1,3}\.){3}\d{1,3})\])/gi;
const emailOnlyText = value => value.replace(emailPattern, (_address, urlPrefix = '') => `${urlPrefix}[EMAIL]`);
function nicknameValue(value) {
  try { return normalizeReviewNickname(emailOnlyText(normalizeReviewNickname(value))); }
  catch { fail('INVALID_NICKNAME', '请填写 2 至 24 个字的昵称，不要包含换行或不可见字符。'); }
}
const validNickname = value => { try { return nicknameValue(value) === value; } catch { return false; } };
export const accountNickname = user => user.nickname || defaultReviewNickname(user.id);

/** Additive fields keep both GitHub snapshots and SQLite v1 databases readable. */
export function validateCommerceState(state) {
  for (const key of ['reviews', 'orders']) {
    if (state[key] === undefined) state[key] = {};
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) fail('STORAGE_INVALID', '评价或订单数据格式异常。', 503);
  }
  for (const [userId, review] of Object.entries(state.reviews)) {
    if (!review || review.userId !== userId || !uuidPattern.test(review.id || '') || !Number.isSafeInteger(review.rating) || review.rating < 1 || review.rating > 5 || typeof review.content !== 'string' || review.content.length > 2000 || !validTime(review.createdAt) || (review.nickname !== undefined && !validNickname(review.nickname))) fail('STORAGE_INVALID', '软件评价数据格式异常。', 503);
  }
  for (const user of Object.values(state.users)) if (user?.nickname !== undefined && !validNickname(user.nickname)) fail('STORAGE_INVALID', '软件账号昵称格式异常。', 503);
  const payments = new Set(), codes = new Set();
  for (const [id, order] of Object.entries(state.orders)) {
    if (!order || order.id !== id || !uuidPattern.test(id) || typeof order.userId !== 'string' || !getMembershipPlan(order.planId) || !Number.isSafeInteger(order.priceCents) || order.priceCents < 0 || !['pending', 'confirmed'].includes(order.status) || !methods.includes(order.paymentMethod) || !validTime(order.createdAt)) fail('STORAGE_INVALID', '订单数据格式异常。', 503);
    if (order.status === 'confirmed') {
      if (!Number.isSafeInteger(order.amountCents) || order.amountCents < 1 || order.amountCents > maxAmount || !validTime(order.paidAt) || !validTime(order.confirmedAt) || !/^[a-f0-9]{64}$/.test(order.paymentKey || '') || typeof order.transactionReference !== 'string' || order.transactionReference.trim().length < 3 || order.transactionReference.length > 120 || typeof order.reason !== 'string' || order.reason.trim().length < 2 || typeof order.confirmedBy !== 'string' || payments.has(order.paymentKey)) fail('STORAGE_INVALID', '收款记录数据格式异常。', 503);
      payments.add(order.paymentKey);
    } else if (order.amountCents !== null || order.paidAt !== null || order.confirmedAt !== null) fail('STORAGE_INVALID', '未确认订单不能包含实收金额。', 503);
    if (order.codeId) {
      if (!uuidPattern.test(order.codeId) || codes.has(order.codeId)) fail('STORAGE_INVALID', '订单激活码关联重复或无效。', 503);
      codes.add(order.codeId);
    }
  }
  return state;
}

function pageValue(input, defaultSize = 20) {
  const page = input.page === undefined ? 1 : input.page, pageSize = input.pageSize === undefined ? defaultSize : input.pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) fail('INVALID_PAGINATION', '分页参数无效。');
  return { page, pageSize };
}
function paginate(items, input, key, defaultSize) {
  const { page, pageSize } = pageValue(input, defaultSize);
  return { [key]: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, totalPages: Math.ceil(items.length / pageSize) };
}
function dateValue(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_DATE_RANGE', '日期请使用 YYYY-MM-DD 格式。');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || iso(time).slice(0, 10) !== value) fail('INVALID_DATE_RANGE', '日期无效。');
  return value;
}
function rangeValue(input) {
  const startDate = dateValue(input.startDate), endDate = dateValue(input.endDate);
  if (startDate && endDate && startDate > endDate) fail('INVALID_DATE_RANGE', '开始日期不能晚于结束日期。');
  return { startDate, endDate };
}
const shanghaiDate = value => iso(Date.parse(value) + 8 * 3_600_000).slice(0, 10);
const inRange = (value, range) => (!range.startDate || shanghaiDate(value) >= range.startDate) && (!range.endDate || shanghaiDate(value) <= range.endDate);

export function createCommerceService({ store, now, authenticate, hash, operation, audit }) {
  const reviewView = (state, review) => review ? { id: review.id, authorLabel: own(state.users, review.userId)?.nickname || review.nickname || defaultReviewNickname(review.userId), rating: review.rating, content: emailOnlyText(review.content), createdAt: review.createdAt } : null;
  function userIdentity(state, request, time) {
    const identity = authenticate(state, request, time);
    if (!['browser', 'desktop'].includes(identity.session.client)) fail('USER_SESSION_REQUIRED', '请使用网页或客户端的软件账号操作。', 403);
    return identity;
  }
  function expectedUser(input, user) {
    if (input.expectedUserId !== user.id) fail('ACCOUNT_CHANGED', '登录账号已变化，请刷新页面后重新操作。', 409);
  }
  function orderView(order, state, admin = false) {
    const result = { id: order.id, userId: order.userId, planId: order.planId, planName: order.planName, priceCents: order.priceCents, amountCents: order.amountCents, status: order.status, paymentMethod: order.paymentMethod, paidAt: order.paidAt, createdAt: order.createdAt, confirmedAt: order.confirmedAt, codeId: order.codeId || null, source: order.source };
    if (admin) Object.assign(result, { email: own(state.users, order.userId)?.email || '', transactionReference: order.transactionReference || '', reason: order.reason || '', confirmedBy: order.confirmedBy || null });
    return result;
  }
  function legacyOrder(code) {
    return { id: `legacy-${code.id}`, userId: code.recipientId, planId: code.planId, planName: code.planName || getMembershipPlan(code.planId).name, priceCents: code.priceCents, amountCents: null, status: 'legacy_unverified', paymentMethod: '', paidAt: null, createdAt: code.createdAt, confirmedAt: null, codeId: code.id, source: 'legacy_activation' };
  }
  function ledger(state) {
    const orders = Object.values(state.orders || {}), linked = new Set(orders.map(order => order.codeId).filter(Boolean));
    for (const code of Object.values(state.codes)) {
      // A quoted plan price is not a payment. Generic gifts and redemptions never
      // become sales; old targeted issues remain explicitly unverified records.
      if (['unused', 'used'].includes(code.status) && code.recipientId && getMembershipPlan(code.planId) && Number.isSafeInteger(code.priceCents) && code.priceCents >= 0 && validTime(code.createdAt) && !linked.has(code.id)) orders.push(legacyOrder(code));
    }
    return orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async function read(request) {
    const { state } = await store.read();
    if (request.action === 'reviews-public') {
      const reviews = Object.values(state.reviews || {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      return { ...paginate(reviews.map(review => reviewView(state, review)), request.input, 'reviews', 6), summary: { count: reviews.length, averageRating: reviews.length ? Number((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length).toFixed(1)) : 0 } };
    }
    const admin = request.action.startsWith('admin-');
    const { user } = admin ? authenticate(state, request, now(), true) : userIdentity(state, request, now());
    // A different tab may replace the browser cookie between rendering a draft
    // and this request. Reads must not silently return the replacement account.
    if (!admin && request.input.expectedUserId !== undefined) expectedUser(request.input, user);
    if (request.action === 'review-mine') return { review: reviewView(state, own(state.reviews || {}, user.id)) };
    const orders = ledger(state);
    if (request.action === 'orders-mine') return paginate(orders.filter(order => order.userId === user.id).map(order => orderView(order, state)), request.input, 'orders');
    const range = rangeValue(request.input);
    const ranged = orders.filter(order => inRange(order.status === 'confirmed' ? order.paidAt : order.createdAt, range));
    if (request.action === 'admin-orders') {
      const status = request.input.status || '', query = request.input.query || '';
      if (!['', 'pending', 'confirmed', 'legacy_unverified'].includes(status) || typeof query !== 'string' || query.length > 254) fail('INVALID_ORDER_FILTER', '订单筛选条件无效。');
      const term = query.trim().toLowerCase();
      const filtered = ranged.filter(order => (!status || order.status === status) && (!term || order.id.toLowerCase().includes(term) || String(own(state.users, order.userId)?.email || '').includes(term) || String(order.transactionReference || '').toLowerCase().includes(term)));
      return paginate(filtered.map(order => orderView(order, state, true)), request.input, 'orders');
    }
    const confirmed = ranged.filter(order => order.status === 'confirmed');
    const byPlan = new Map(), byPaymentMethod = new Map(), byDay = new Map();
    const add = (map, key, info, cents) => { const item = map.get(key) || { ...info, totalCents: 0, count: 0 }; item.totalCents += cents; item.count++; map.set(key, item); };
    let totalCents = 0;
    for (const order of confirmed) {
      totalCents += order.amountCents;
      if (!Number.isSafeInteger(totalCents)) fail('REVENUE_CAPACITY', '营业额超出安全金额范围，请联系管理员。', 503);
      add(byPlan, order.planId, { planId: order.planId, planName: order.planName }, order.amountCents);
      add(byPaymentMethod, order.paymentMethod, { paymentMethod: order.paymentMethod }, order.amountCents);
      const date = shanghaiDate(order.paidAt); add(byDay, date, { date }, order.amountCents);
    }
    return { revenue: { currency: 'CNY', timeZone: 'Asia/Shanghai', ...range, totalCents, confirmedCount: confirmed.length, pendingCount: ranged.filter(order => order.status === 'pending').length, legacyUnverifiedCount: ranged.filter(order => order.status === 'legacy_unverified').length, byPlan: [...byPlan.values()], byPaymentMethod: [...byPaymentMethod.values()], byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)) } };
  }
  async function mutate(request) {
    const id = randomUUID();
    return store.transaction(state => {
      validateCommerceState(state);
      const time = now(), admin = request.action.startsWith('admin-');
      const { user } = admin ? authenticate(state, request, time, true) : userIdentity(state, request, time);
      if (!admin) expectedUser(request.input, user);
      const result = operation(state, user, request, () => {
        const input = request.input;
        if (request.action === 'profile-update') {
          user.nickname = nicknameValue(input.nickname);
          return { profile: { nickname: user.nickname }, replayed: false };
        }
        if (request.action === 'review-submit') {
          if (own(state.reviews, user.id)) fail('REVIEW_ALREADY_EXISTS', '每位用户仅可评价一次，您已经提交过评价。', 409);
          if (!Number.isSafeInteger(input.rating) || input.rating < 1 || input.rating > 5 || typeof input.content !== 'string' || input.content.trim().length < 5 || input.content.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.content)) fail('INVALID_REVIEW', '请选择 1 至 5 星，并填写 5 至 1000 字的评价。');
          const nickname = input.nickname === undefined ? accountNickname(user) : nicknameValue(input.nickname);
          const review = { id, userId: user.id, nickname, rating: input.rating, content: emailOnlyText(input.content), createdAt: iso(time) };
          user.nickname = nickname;
          state.reviews[user.id] = review;
          return { review: reviewView(state, review), replayed: false };
        }
        if (request.action === 'order-create') {
          const plan = getMembershipPlan(input.planId);
          if (!plan || !['alipay', 'wechat'].includes(input.paymentMethod)) fail('INVALID_ORDER', '请选择有效套餐和支付渠道。');
          const prior = Object.values(state.orders).find(order => order.userId === user.id && order.planId === plan.id && order.paymentMethod === input.paymentMethod && order.status === 'pending');
          if (prior) return { order: orderView(prior, state), replayed: true };
          const order = { id, userId: user.id, planId: plan.id, planName: plan.name, priceCents: plan.priceCents, amountCents: null, status: 'pending', paymentMethod: input.paymentMethod, paidAt: null, createdAt: iso(time), confirmedAt: null, codeId: null, source: 'user_report' };
          state.orders[id] = order;
          return { order: orderView(order, state), replayed: false };
        }
        if (request.action === 'admin-link-order-code') {
          if (typeof input.orderId !== 'string' || !uuidPattern.test(input.orderId) || typeof input.codeId !== 'string' || !uuidPattern.test(input.codeId)) fail('INVALID_ORDER', '订单或激活码编号无效。');
          if (typeof input.reason !== 'string' || input.reason.trim().length < 2 || input.reason.length > 500) fail('REASON_REQUIRED', '请填写 2 至 500 字的关联说明。');
          const order = own(state.orders, input.orderId);
          if (!order) fail('ORDER_NOT_FOUND', '订单不存在。', 404);
          if (order.status !== 'confirmed') fail('ORDER_NOT_CONFIRMED', '请先核实并确认实际收款，再关联激活码。', 409);
          if (order.codeId) fail('ORDER_ALREADY_LINKED', '该订单已经关联激活码，不能再次修改。', 409);
          const code = own(state.codes, input.codeId);
          if (!code || code.status === 'void' || code.planId !== order.planId || (code.recipientId !== order.userId && code.redeemedBy !== order.userId) || (code.recipientId && code.recipientId !== order.userId) || (code.redeemedBy && code.redeemedBy !== order.userId)) fail('ORDER_CODE_MISMATCH', '激活码不存在、已作废或与订单用户及套餐不符。', 409);
          if (Object.values(state.orders).some(item => item.codeId === code.id)) fail('ORDER_CODE_DUPLICATE', '该激活码已经关联其他订单。', 409);
          const before = orderView(order, state, true);
          // Linking fulfillment after recording the receipt changes no monetary
          // field, payment evidence, confirmation time or membership entitlement.
          order.codeId = code.id;
          audit(state, user, request.action, order.id, input.reason.trim(), before, orderView(order, state, true), time);
          return { order: orderView(order, state, true), replayed: false };
        }
        if (typeof input.userId !== 'string' || (input.orderId !== undefined && input.orderId !== '' && typeof input.orderId !== 'string') || (input.codeId !== undefined && input.codeId !== '' && typeof input.codeId !== 'string')) fail('INVALID_ORDER', '用户、订单或激活码编号无效。');
        const target = own(state.users, input.userId), plan = getMembershipPlan(input.planId);
        if (!target) fail('USER_NOT_FOUND', '没有找到该用户。', 404);
        if (!plan || !methods.includes(input.paymentMethod) || !Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > maxAmount) fail('INVALID_ORDER', '套餐、渠道或实收金额无效，金额必须为正整数分。');
        if (typeof input.reason !== 'string' || input.reason.trim().length < 2 || input.reason.length > 500) fail('REASON_REQUIRED', '请填写 2 至 500 字的收款核实说明。');
        if (typeof input.transactionReference !== 'string' || input.transactionReference.trim().length < 3 || input.transactionReference.length > 120 || /[\x00-\x1f\x7f]/.test(input.transactionReference)) fail('PAYMENT_REFERENCE_REQUIRED', '请填写 3 至 120 字的真实收款流水号。');
        if (typeof input.paidAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(input.paidAt) || !validTime(input.paidAt) || Date.parse(input.paidAt) < Date.parse('2000-01-01T00:00:00Z') || Date.parse(input.paidAt) > time + 300_000) fail('INVALID_PAID_AT', '请选择带时区的有效实际收款时间，不能晚于当前时间。');
        dateValue(input.paidAt.slice(0, 10));
        const transactionReference = input.transactionReference.trim();
        const paymentKey = hash('order-payment', `${input.paymentMethod}:${transactionReference.toLowerCase()}`);
        if (Object.values(state.orders).some(order => order.paymentKey === paymentKey)) fail('ORDER_PAYMENT_DUPLICATE', '该渠道的收款流水号已经入账，请勿重复确认。', 409);
        let prior = null, codeId = input.codeId || null;
        if (input.orderId) {
          prior = own(state.orders, input.orderId) || ledger(state).find(order => order.id === input.orderId && order.status === 'legacy_unverified');
          if (!prior || prior.userId !== target.id || prior.planId !== plan.id) fail('ORDER_NOT_FOUND', '订单不存在或与所选用户、套餐不符。', 404);
          if (prior.status === 'confirmed') fail('ORDER_ALREADY_CONFIRMED', '该订单已经确认收款，不能再次修改。', 409);
          if (prior.codeId && codeId && prior.codeId !== codeId) fail('ORDER_CODE_MISMATCH', '激活码与历史记录不一致。', 409);
          codeId ||= prior.codeId;
        }
        if (codeId) {
          const code = own(state.codes, codeId);
          if (!code || code.status === 'void' || (code.recipientId && code.recipientId !== target.id) || (code.redeemedBy && code.redeemedBy !== target.id) || (code.planId && code.planId !== plan.id)) fail('ORDER_CODE_MISMATCH', '激活码不存在、已作废或与该用户及套餐不符。', 409);
          if (Object.values(state.orders).some(order => order.codeId === codeId)) fail('ORDER_CODE_DUPLICATE', '该激活码已经关联订单，不能重复入账。', 409);
        }
        const order = { id: prior?.status === 'pending' ? prior.id : id, userId: target.id, planId: plan.id, planName: prior?.planName || plan.name, priceCents: prior?.priceCents ?? plan.priceCents, amountCents: input.amountCents, status: 'confirmed', paymentMethod: input.paymentMethod, paidAt: iso(Date.parse(input.paidAt)), createdAt: prior?.createdAt || iso(time), confirmedAt: iso(time), confirmedBy: user.id, codeId, source: prior?.status === 'pending' ? prior.source : 'admin_record', transactionReference, paymentKey, reason: input.reason.trim() };
        state.orders[order.id] = order;
        audit(state, user, request.action, order.id, order.reason, prior ? orderView(prior, state, true) : null, orderView(order, state, true), time);
        return { order: orderView(order, state, true), replayed: false };
      });
      // A replay never overwrites a later nickname change and must display the
      // current profile instead of an old author label saved with the operation.
      if (['profile-update', 'review-submit'].includes(request.action)) result.value.profile = { nickname: accountNickname(user) };
      if (request.action === 'review-submit') result.value.review = reviewView(state, own(state.reviews, user.id));
      return result;
    });
  }
  return { execute: request => ['profile-update', 'review-submit', 'order-create', 'admin-record-order', 'admin-link-order-code'].includes(request.action) ? mutate(request) : read(request) };
}
