// Browser/Android accounts use an HttpOnly same-origin cookie, never localStorage.
export function createBrowserAccountBridge({ fetchImpl = globalThis.fetch } = {}) {
  let state = { configured: true, authenticated: false, verified: false, status: 'logged_out', account: null };
  let revision = 0;
  let nicknameRevision = 0, nicknameRequest = 0, nicknameApplied = 0;
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
    if (logoutPending && ['me', 'redeem', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create'].includes(action)) {
      return { ok: false, state: snapshot(), error: { message: '退出登录尚未完成，请刷新重试。' } };
    }
    const nicknameEpoch = nicknameRevision;
    const nicknameSerial = ['profile-update', 'review-submit'].includes(action) ? ++nicknameRequest : 0;
    try {
      const response = await fetchImpl('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input: { ...input, client: 'browser' } }) });
      const result = await response.json();
      if (epoch !== revision) return changed();
      if (!response.ok || !result.ok) {
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
      } else if (['me', 'verify-code', 'redeem'].includes(action) && result.account?.user?.id) {
        if (nicknameEpoch !== nicknameRevision && state.account?.user?.id === result.account.user.id && state.account.user.nickname) {
          result.account.user.nickname = state.account.user.nickname;
        }
        state = { configured: true, authenticated: true, verified: true, status: 'ready', account: result.account };
      }
      else if (action === 'me' || action === 'verify-code') {
        state = { ...state, verified: false, status: 'service_unavailable', error: { message: '账号服务返回了不完整的登录状态，请稍后重试。' } };
        emit(); return { ok: false, error: state.error, state: snapshot() };
      }
      if (nicknameSerial > nicknameApplied && result.profile?.nickname
        && state.account?.user?.id === input.expectedUserId) {
        nicknameApplied = nicknameSerial;
        nicknameRevision++;
        state = { ...state, account: { ...state.account, user: { ...state.account.user, nickname: result.profile.nickname } } };
      }
      emit(); return { ok: true, result, state: snapshot() };
    } catch {
      if (['reviews-public', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create'].includes(action)) {
        return { ok: false, state: snapshot(), error: { code: 'SERVICE_UNAVAILABLE', message: '暂时无法连接，请保留原内容重试。' } };
      }
      if (epoch === revision) { state = { ...state, verified: false, status: 'service_unavailable', error: { message: '账号服务暂时不可用，请稍后重试。' } }; emit(); }
      return { ok: false, state: snapshot(), error: { message: '账号服务暂时不可用，请稍后重试。' } };
    }
  }
  function changeSession(action, input = {}) {
    const epoch = ++revision;
    logoutPending = action === 'logout';
    redemptionIds.clear();
    state = { configured: true, authenticated: false, verified: false, account: null,
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
  return {
    getAccountState: async () => { await refresh(); return snapshot(); },
    onAccountUpdate: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    sendAccountCode: email => request('send-code', { email }),
    verifyAccountCode: (email, code) => changeSession('verify-code', { email, code }),
    refreshAccount: refresh, redeemAccountCode: code => {
      const normalized = String(code || '').trim().toUpperCase();
      if (!redemptionIds.has(normalized)) redemptionIds.set(normalized, crypto.randomUUID());
      return request('redeem', { code: normalized, requestId: redemptionIds.get(normalized) });
    },
    logoutAccount: () => changeSession('logout'),
    commerceRequest: (action, input = {}) => {
      if (!['reviews-public', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create'].includes(action)) {
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
