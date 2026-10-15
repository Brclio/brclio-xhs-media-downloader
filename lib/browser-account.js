import { uploadAccountAvatarTransfer, fetchAccountAvatarThumbnail } from './account-avatar-transfer.js';
// Browser/Android accounts use an HttpOnly same-origin cookie, never localStorage.
export function createBrowserAccountBridge({ fetchImpl = globalThis.fetch, avatarEndpoint = new URL('/api/account', globalThis.location?.href || 'https://localhost').href } = {}) {
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
      const response = await fetchImpl('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
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
    selectAccountAvatar: input => avatarWork(input, (_assertCurrent, request) => request('avatar-select', { builtinId: input?.builtinId, expectedUserId: input?.expectedUserId })),
    uploadAccountAvatar: input => avatarWork(input, (assertCurrent, request) => uploadAccountAvatarTransfer({ input, endpoint: avatarEndpoint, request, fetchImpl, assertCurrent })),
    getAccountAvatarThumbnail: input => avatarWork(input, assertCurrent => state.account?.user?.avatar?.kind === 'upload'
      ? fetchAccountAvatarThumbnail({ url: state.account.user.avatar.url, endpoint: avatarEndpoint, fetchImpl, assertCurrent }) : { thumbnail: null, contentType: null }),
    getAccountAvatarOriginal: input => avatarWork(input, (_assertCurrent, request) => request('avatar-original', { expectedUserId: input?.expectedUserId })),
    commerceRequest: (action, input = {}) => {
      if (!['reviews-public', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create', 'payment-catalog', 'payment-create', 'payment-status'].includes(action)) {
        return Promise.resolve({ ok: false, state: snapshot(), error: { message: '无效的评价或订单操作。' } });
      }
      return request(action, input);
    },
  };
}
let browserBridge;
export function getAccountBridge() {
  if (typeof window === 'undefined') return null;
  if (window.xhsDesktop?.getAccountState) return window.xhsDesktop;
  return browserBridge ||= createBrowserAccountBridge();
}
