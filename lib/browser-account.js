import { uploadAccountAvatarTransfer, fetchAccountAvatarThumbnail } from './account-avatar-transfer.js';
// Browser/Android authentication stays in its HttpOnly same-origin cookie.
// Only non-authenticating product order references may use localStorage.
export function createBrowserAccountBridge({ fetchImpl = globalThis.fetch, endpoint = '/api/account', storage,
  avatarEndpoint = new URL(endpoint, globalThis.location?.href || 'https://localhost').href } = {}) {
  const service = new URL(endpoint, globalThis.location?.href || 'https://localhost');
  const paymentStoragePrefix = `xhs.pending-payment.v1:${encodeURIComponent(`${service.origin}${service.pathname}`)}:`;
  const validUserId = value => typeof value === 'string' && /^[A-Za-z\d_-]{1,128}$/.test(value);
  const validOrderId = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
  const pendingPayments = new Map(), dirtyPayments = new Set(), persistedPayments = new Set(), pendingRevisions = new Map();
  let paymentCreateRevision = 0;
  const storageError = () => ({ persistent: false, error: { code: 'PAYMENT_RECOVERY_STORAGE_UNAVAILABLE',
    message: '浏览器无法保存待核实订单，本次仅能在当前页面继续查询；关闭页面后请登录原账号从订单页继续核实。' } });
  const localPaymentStorage = () => {
    const local = storage === undefined ? globalThis.localStorage : storage;
    if (!local || !['getItem', 'setItem', 'removeItem'].every(method => typeof local[method] === 'function')) throw new Error('Payment recovery storage unavailable');
    return local;
  };
  const paymentKey = userId => `${paymentStoragePrefix}${userId}`;
  function readPendingPayment(userId) {
    const key = paymentKey(userId);
    try {
      const local = localPaymentStorage();
      let value;
      try { value = JSON.parse(local.getItem(key) || 'null'); } catch {}
      const saved = value?.userId === userId && validOrderId(value?.orderId) ? { userId, orderId: value.orderId } : null;
      if (dirtyPayments.has(key) && pendingPayments.has(key)) {
        local.setItem(key, JSON.stringify(pendingPayments.get(key)));
        dirtyPayments.delete(key); persistedPayments.add(key);
      } else if (saved) {
        pendingPayments.set(key, saved); persistedPayments.add(key);
      } else {
        pendingPayments.delete(key); persistedPayments.delete(key);
      }
      return { pending: pendingPayments.get(key) || null, recovery: { persistent: true } };
    } catch { return { pending: pendingPayments.get(key) || null, recovery: storageError() }; }
  }
  function rememberPayment(userId, orderId, { onlyIfAbsent = false, pendingRevision = 0, createRevision } = {}) {
    const key = paymentKey(userId), current = readPendingPayment(userId);
    if (onlyIfAbsent && (current.pending || pendingRevision !== (pendingRevisions.get(key) || 0) || createRevision !== paymentCreateRevision)) return current.recovery;
    pendingPayments.set(key, { userId, orderId }); dirtyPayments.add(key);
    pendingRevisions.set(key, (pendingRevisions.get(key) || 0) + 1);
    try {
      localPaymentStorage().setItem(key, JSON.stringify({ userId, orderId }));
      dirtyPayments.delete(key); persistedPayments.add(key);
      return { persistent: true };
    } catch { return storageError(); }
  }
  let state = { configured: true, authenticated: false, verified: false, status: 'logged_out', account: null };
  let revision = 0;
  let nicknameRevision = 0, nicknameRequest = 0, nicknameApplied = 0;
  let avatarRevision = 0, avatarRequest = 0, avatarApplied = 0;
  // Serialize requests that write the HttpOnly cookie. Ignoring an old JSON
  // result does not prevent its Set-Cookie header from replacing a newer login.
  let sessionTail = Promise.resolve();
  let logoutPending = false;
  const listeners = new Set();
  const redemptionIds = new Map();
  const snapshot = () => structuredClone(state);
  const emit = () => { for (const callback of listeners) callback(snapshot()); };
  const changed = () => ({ ok: false, state: snapshot(), error: { message: '账号已切换，请重试。' } });
  async function request(action, input = {}, { epoch = revision, waitForSession = true } = {}) {
    if (waitForSession) await sessionTail;
    if (epoch !== revision) return changed();
    if (logoutPending && (action.startsWith('avatar-') || ['payment-create', 'payment-status', 'me', 'redeem', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create'].includes(action))) {
      return { ok: false, state: snapshot(), error: { message: '退出登录尚未完成，请刷新重试。' } };
    }
    const nicknameEpoch = nicknameRevision;
    const avatarEpoch = avatarRevision;
    const nicknameSerial = ['profile-update', 'review-submit'].includes(action) ? ++nicknameRequest : 0;
    const avatarSerial = ['avatar-select', 'avatar-complete'].includes(action) ? ++avatarRequest : 0;
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input: { ...input, client: 'browser' } }) });
      const result = await response.json();
      if (epoch !== revision) return changed();
      if (!response.ok || !result.ok) {
        // Public sign-in discovery is independent of the current cookie's
        // account/membership. Its failure only hides the Google entry point.
        if (action === 'google-config') return { ok: false, result: { enabled: false },
          error: result.error || { message: '暂时无法读取 Google 登录配置，请稍后重试。' }, state: snapshot() };
        if (action === 'logout' && response.status === 401) {
          logoutPending = false;
          state = { configured: true, authenticated: false, verified: false, status: 'logged_out', account: null };
          emit(); return { ok: true, result: { revoked: true }, state: snapshot() };
        }
        if (response.status === 401) state = { ...state, authenticated: false, verified: false, status: 'logged_out', account: null };
        else if (action === 'me') state = { ...state, verified: false, status: 'service_unavailable' };
        state.error = result.error || { message: '账号服务暂时不可用。' }; emit();
        return { ok: false, error: state.error, state: snapshot() };
      }
      if (action === 'logout') {
        logoutPending = false;
        state = { configured: true, authenticated: false, verified: false, status: 'logged_out', account: null };
      } else if (['me', 'verify-code', 'google-complete', 'redeem'].includes(action) && result.account?.user?.id) {
        if (action === 'google-complete') logoutPending = false;
        if (nicknameEpoch !== nicknameRevision && state.account?.user?.id === result.account.user.id && state.account.user.nickname) {
          result.account.user.nickname = state.account.user.nickname;
        }
        if (avatarEpoch !== avatarRevision && state.account?.user?.id === result.account.user.id) result.account.user.avatar = state.account.user.avatar;
        state = { configured: true, authenticated: true, verified: true, status: 'ready', account: result.account };
      }
      else if (action === 'me' || action === 'verify-code'
        || (action === 'google-complete' && result.loginClient !== 'desktop')) {
        state = { ...state, verified: false, status: 'service_unavailable', error: { message: '账号服务返回了不完整的登录状态，请稍后重试。' } };
        emit(); return { ok: false, error: state.error, state: snapshot() };
      }
      if (nicknameSerial > nicknameApplied && result.profile?.nickname
        && state.account?.user?.id === input.expectedUserId) {
        nicknameApplied = nicknameSerial;
        nicknameRevision++;
        state = { ...state, account: { ...state.account, user: { ...state.account.user, nickname: result.profile.nickname } } };
      }
      if (avatarSerial > avatarApplied && result.profile?.avatar && state.account?.user?.id === input.expectedUserId) {
        avatarApplied = avatarSerial; avatarRevision++;
        state = { ...state, account: { ...state.account, user: { ...state.account.user, avatar: result.profile.avatar } } };
      }
      emit(); return { ok: true, result, state: snapshot() };
    } catch {
      if (action === 'google-config') return { ok: false, result: { enabled: false }, state: snapshot(),
        error: { code: 'SERVICE_UNAVAILABLE', message: '暂时无法读取 Google 登录配置，请稍后重试。' } };
      if (action.startsWith('avatar-') || action.startsWith('payment-') || ['reviews-public', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create'].includes(action)) {
        return { ok: false, state: snapshot(), error: { code: 'SERVICE_UNAVAILABLE', message: '暂时无法连接，请保留原内容重试。' } };
      }
      if (epoch === revision) { state = { ...state, verified: false, status: 'service_unavailable', error: { message: '账号服务暂时不可用，请稍后重试。' } }; emit(); }
      return { ok: false, state: snapshot(), error: { message: '账号服务暂时不可用，请稍后重试。' } };
    }
  }
  function changeSession(action, input = {}, { preserveAccount = false } = {}) {
    const epoch = ++revision;
    if (!['google-start', 'google-complete'].includes(action)) logoutPending = action === 'logout';
    redemptionIds.clear();
    if (!preserveAccount) state = { configured: true, authenticated: false, verified: false, account: null,
      status: action === 'logout' ? 'logged_out' : 'checking', ...(logoutPending ? { pendingLogout: true } : {}) };
    emit();
    const work = sessionTail.then(() => request(action, input, { epoch, waitForSession: false }));
    sessionTail = work.catch(() => {});
    return work;
  }
  async function refresh() {
    const epoch = revision;
    await sessionTail;
    if (epoch !== revision) return changed();
    // A failed remote logout leaves the cookie in the browser. Retry revocation
    // instead of silently restoring that account via "me" on the next refresh.
    return logoutPending ? changeSession('logout') : request('me', {}, { epoch });
  }
  const validPaymentAccount = expectedUserId => !logoutPending && state.authenticated && state.verified
    && validUserId(expectedUserId) && state.account?.user?.id === expectedUserId;
  async function getPendingPayment() {
    const epoch = revision;
    await sessionTail;
    if (epoch !== revision) return changed();
    const userId = state.account?.user?.id;
    if (logoutPending || !state.authenticated || !validUserId(userId)) return { ok: true, result: null, state: snapshot(), recovery: { persistent: false } };
    if (!state.verified) return { ok: false, error: { code: 'ACCOUNT_UNVERIFIED', message: '待核实订单仍已保留，请联网刷新当前账号后继续恢复。' }, state: snapshot() };
    const { pending, recovery } = readPendingPayment(userId);
    return { ok: true, result: pending ? { ...pending } : null, state: snapshot(), recovery };
  }
  async function clearPendingPayment({ orderId, expectedUserId } = {}) {
    const epoch = revision;
    await sessionTail;
    if (epoch !== revision || !validPaymentAccount(expectedUserId)) return { ...changed(), error: { code: 'SESSION_CHANGED', message: '账号已退出或切换，请切回原账号再重试。' } };
    const key = paymentKey(expectedUserId), { pending, recovery } = readPendingPayment(expectedUserId);
    if (!validOrderId(orderId) || pending?.orderId !== orderId) return { ok: true, result: { cleared: false }, state: snapshot(), recovery };
    try { localPaymentStorage().removeItem(key); }
    catch {
      if (persistedPayments.has(key)) return { ok: false, error: storageError().error, state: snapshot(), recovery: storageError() };
      // A record that never reached durable storage can still complete in this
      // page. The explicit capability flag tells callers it cannot resume later.
      pendingPayments.delete(key); dirtyPayments.delete(key);
      pendingRevisions.set(key, (pendingRevisions.get(key) || 0) + 1);
      return { ok: true, result: { cleared: true }, state: snapshot(), recovery: storageError() };
    }
    pendingPayments.delete(key); dirtyPayments.delete(key); persistedPayments.delete(key);
    pendingRevisions.set(key, (pendingRevisions.get(key) || 0) + 1);
    return { ok: true, result: { cleared: true }, state: snapshot(), recovery: { persistent: true } };
  }
  async function commerceRequest(action, input = {}) {
    if (!['reviews-public', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create', 'payment-catalog', 'payment-create', 'payment-status'].includes(action)) {
      return { ok: false, state: snapshot(), error: { message: '无效的评价或订单操作。' } };
    }
    if (!['payment-create', 'payment-status'].includes(action)) return request(action, input);
    const epoch = revision, userId = input.expectedUserId;
    await sessionTail;
    if (epoch !== revision || !validPaymentAccount(userId)) return { ...changed(), error: { code: 'SESSION_CHANGED', message: '请先核实当前软件账号，再继续查询或创建支付订单。' } };
    if (action === 'payment-create') paymentCreateRevision++;
    const createRevision = paymentCreateRevision, pendingRevision = pendingRevisions.get(paymentKey(userId)) || 0;
    const reply = await request(action, input, { epoch });
    if (!reply.ok) return reply;
    if (epoch !== revision || !validPaymentAccount(userId)) return changed();
    if (action === 'payment-create' && createRevision !== paymentCreateRevision) {
      return { ok: false, state: snapshot(), error: { code: 'PAYMENT_REQUEST_SUPERSEDED', message: '已有更新的支付订单请求，请使用最新订单继续核实。' } };
    }
    const order = reply.result?.order;
    if (!validOrderId(order?.id) || !['pending', 'confirmed'].includes(order?.status)
      || (order.userId && order.userId !== userId)
      || (action === 'payment-status' && (order.userId !== userId || order.id !== input.orderId))) return reply;
    const recovery = rememberPayment(userId, order.id, { onlyIfAbsent: action === 'payment-status', pendingRevision, createRevision });
    return { ...reply, recovery };
  }
  async function avatarWork(input, work) {
    const epoch = revision, expectedUserId = input?.expectedUserId;
    const assertCurrent = () => {
      if (epoch !== revision || logoutPending || !state.authenticated || state.account?.user?.id !== expectedUserId) {
        throw Object.assign(new Error('软件账号已退出或切换，请重试。'), { code: 'SESSION_CHANGED' });
      }
    };
    try {
      await sessionTail; assertCurrent();
      const result = await work(assertCurrent, async (action, values) => {
        assertCurrent();
        const response = await request(action, values, { epoch });
        assertCurrent();
        if (!response.ok) throw Object.assign(new Error(response.error?.message || '头像操作失败，请重试。'), { code: response.error?.code || 'AVATAR_REQUEST_FAILED' });
        return response.result;
      });
      assertCurrent(); return { ok: true, result, state: snapshot() };
    } catch (error) { return { ok: false, error: { code: error.code || 'AVATAR_REQUEST_FAILED', message: error.message || '头像操作失败，请重试。' }, state: snapshot() }; }
  }
  return {
    getAccountState: async () => { await refresh(); return snapshot(); },
    onAccountUpdate: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    sendAccountCode: email => request('send-code', { email }),
    verifyAccountCode: (email, code) => changeSession('verify-code', { email, code }),
    getAccountGoogleConfig: () => request('google-config'),
    loginAccountGoogle: () => changeSession('google-start', {}, { preserveAccount: true }),
    completeAccountGoogleLogin: input => changeSession('google-complete', { code: input?.code, state: input?.state }, { preserveAccount: true }),
    confirmAccountGoogleLogin: input => request('google-confirm', { attemptId: input?.attemptId, confirmationToken: input?.confirmationToken }),
    refreshAccount: refresh, redeemAccountCode: code => {
      const normalized = String(code || '').trim().toUpperCase();
      if (!redemptionIds.has(normalized)) redemptionIds.set(normalized, crypto.randomUUID());
      return request('redeem', { code: normalized, requestId: redemptionIds.get(normalized) });
    },
    logoutAccount: () => changeSession('logout'),
    getPendingPayment,
    clearPendingPayment,
    selectAccountAvatar: input => avatarWork(input, (_assertCurrent, request) => request('avatar-select', { builtinId: input?.builtinId, expectedUserId: input?.expectedUserId })),
    uploadAccountAvatar: input => avatarWork(input, (assertCurrent, request) => uploadAccountAvatarTransfer({ input, endpoint: avatarEndpoint, request, fetchImpl, assertCurrent })),
    getAccountAvatarThumbnail: input => avatarWork(input, assertCurrent => state.account?.user?.avatar?.kind === 'upload'
      ? fetchAccountAvatarThumbnail({ url: state.account.user.avatar.url, endpoint: avatarEndpoint, fetchImpl, assertCurrent }) : { thumbnail: null, contentType: null }),
    getAccountAvatarOriginal: input => avatarWork(input, (_assertCurrent, request) => request('avatar-original', { expectedUserId: input?.expectedUserId })),
    commerceRequest,
  };
}
let browserBridge;
export function getAccountBridge() {
  if (typeof window === 'undefined') return null;
  if (window.xhsDesktop?.getAccountState) return window.xhsDesktop;
  return browserBridge ||= createBrowserAccountBridge();
}
