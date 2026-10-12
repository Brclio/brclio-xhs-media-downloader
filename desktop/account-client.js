import { createHash, randomUUID, sign } from 'node:crypto';
import { accountError } from './account-storage.js';
import { KNOWN_FEATURES, PROTECTED_FEATURES } from '../lib/membership-policy.js';
import { verifyEntitlement } from '../lib/entitlement.js';

const EXPIRED_SESSION_CODES = new Set(['SESSION_REVOKED', 'INVALID_SESSION', 'SESSION_INVALID', 'UNAUTHENTICATED']);
const SKEW_CODES = new Set(['PROOF_EXPIRED', 'PROOF_TIMESTAMP_INVALID', 'TIMESTAMP_INVALID']);
const TEMPORARY_STORAGE_CODES = new Set(['STORAGE_UNAVAILABLE', 'STORAGE_RATE_LIMITED', 'STORAGE_CONFLICT', 'STORAGE_WRITE_UNCERTAIN']);
const TEMPORARY_AUTHORIZATION_CODES = new Set(['SERVICE_UNAVAILABLE', 'NETWORK_ERROR', 'RATE_LIMITED', 'TOO_MANY_REQUESTS', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT']);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const REQUEST_CONTEXT = Symbol('accountRequestContext');

function accountServiceMessage(code, message) {
  if (!code?.startsWith('STORAGE_')) return message;
  if (code === 'STORAGE_WRITE_UNCERTAIN') return '软件账号服务暂时无法确认本次操作结果，请保留原内容并稍后重试。';
  if (TEMPORARY_STORAGE_CODES.has(code)) return '软件账号服务暂时繁忙，请稍后重试；已下载文件会保留。';
  return '软件账号服务暂时不可用，请联系软件管理员；已下载文件会保留。';
}

function retryableAuthorizationError(error) {
  const code = error.code || '';
  // A storage/configuration fault or an explicit access denial is never made
  // retryable merely because the service happened to use HTTP 503.
  if (code.startsWith('STORAGE_')) return TEMPORARY_STORAGE_CODES.has(code);
  if (/^(?:ACCOUNT_|AUTHORIZATION_|CONFIGURATION_|DEVICE_|ENTITLEMENT_|FEATURE_|INVALID_|MEMBERSHIP_|PROOF_|SECURE_|SESSION_|TIMESTAMP_|USER_)/.test(code)
    || ['FORBIDDEN', 'DESKTOP_REQUIRED', 'UNKNOWN_FEATURE'].includes(code) || EXPIRED_SESSION_CODES.has(code)) return false;
  return TEMPORARY_AUTHORIZATION_CODES.has(code) || [429, 502, 503, 504].includes(error.status);
}

function retryableGooglePollError(error) {
  return TEMPORARY_STORAGE_CODES.has(error.code) || TEMPORARY_AUTHORIZATION_CODES.has(error.code);
}

function authoritativeAuthorizationError(error) {
  return EXPIRED_SESSION_CODES.has(error.code)
    || /^(?:ACCOUNT_|AUTHORIZATION_|DEVICE_|MEMBERSHIP_|SESSION_|ENTITLEMENT_)/.test(error.code || '');
}

function entitlementError(error) {
  return accountError(error.code === 'ENTITLEMENT_EXPIRED' ? 'ENTITLEMENT_EXPIRED' : 'ENTITLEMENT_INVALID',
    error.code === 'ENTITLEMENT_EXPIRED' ? '本机会员授权已到期，请联网刷新授权后继续；已下载文件会保留。'
      : '本机会员授权无效，请联网重新确认软件账号授权；已下载文件会保留。', 403);
}

export function validateAccountEndpoint(value, allowInsecureDevelopment = false) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw accountError('CONFIGURATION_REQUIRED', '软件账号服务地址无效。'); }
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(allowInsecureDevelopment && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw accountError('CONFIGURATION_REQUIRED', '软件账号服务地址必须使用 HTTPS。');
  }
  return url.href;
}

export function validateGoogleAuthorizationUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw accountError('GOOGLE_LOGIN_INVALID', 'Google 登录地址无效，请重试。'); }
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash) {
    throw accountError('GOOGLE_LOGIN_INVALID', 'Google 登录地址无效，请重试。');
  }
  return url.href;
}

export class AccountClient {
  constructor({ store, endpoint, fetchImpl = globalThis.fetch, now = Date.now, monotonicNow = () => performance.now(), sleep = wait,
    entitlementPublicKeys = {}, onUpdate = () => {}, onDiagnostic = () => {}, allowInsecureDevelopment = false }) {
    this.store = store; this.endpoint = validateAccountEndpoint(endpoint, allowInsecureDevelopment);
    this.fetchImpl = fetchImpl; this.now = now; this.onUpdate = onUpdate;
    this.credentials = null; this.account = null; this.error = null;
    this.status = this.endpoint ? 'initializing' : 'configuration_required';
    this.serverOffset = 0; this._commands = Promise.resolve();
    this.onDiagnostic = onDiagnostic;
    this.sleep = sleep; this._sessionGeneration = 0; this._authorizationRevision = 0; this._authorizations = new Map();
    this.entitlementPublicKeys = entitlementPublicKeys; this.monotonicNow = monotonicNow;
    this._hasEntitlementKeys = entitlementPublicKeys instanceof Map ? entitlementPublicKeys.size > 0 : Object.keys(entitlementPublicKeys || {}).length > 0;
    this._entitlementAnchors = new Map(); this._signedAuthorizationUsed = new Set();
    this._nicknameRevision = 0; this._nicknameRequest = 0; this._nicknameApplied = 0;
  }
  snapshot() {
    return structuredClone({ status: this.status, account: this.account, error: this.error,
      authenticated: Boolean(this.credentials?.token), verified: this.status === 'ready',
      pendingLogout: Boolean(this.credentials?.pendingLogoutTokens?.length), googleLoginPending: Boolean(this._googleAttempt),
      configured: Boolean(this.endpoint), protectedFeatures: PROTECTED_FEATURES });
  }
  _emit() { this.onUpdate(this.snapshot()); }
  _command(fn) {
    const result = this._commands.then(fn); this._commands = result.catch(() => {}); return result;
  }
  _recordError(error) {
    this.error = { code: error.code || 'SERVICE_UNAVAILABLE', message: error.message || '软件账号服务暂时不可用。' };
    if (error.status >= 500 || error.status === 429) this.status = 'service_unavailable';
    this._emit();
  }
  initialize() {
    if (this._initialization) return this._initialization;
    if (this.credentials) return Promise.resolve(this.snapshot());
    this.status = this.endpoint ? 'initializing' : 'configuration_required';
    this.error = null;
    this._emit();
    this._initialization = (async () => {
      try {
        this.credentials = await this.store.load();
        this._restoreEntitlements();
        this.status = !this.endpoint ? 'configuration_required' : this.credentials.token ? 'checking' : 'signed_out';
      } catch (error) { this.status = 'secure_storage_unavailable'; this.error = { code: error.code || 'SECURE_STORAGE_UNAVAILABLE', message: error.message }; }
      this._emit(); return this.snapshot();
    })().finally(() => { this._initialization = null; });
    return this._initialization;
  }
  _requireStorage() {
    if (!this.credentials) throw accountError(this.error?.code || 'SECURE_STORAGE_UNAVAILABLE', this.error?.message || '系统安全存储不可用。');
  }
  _restoreEntitlements() {
    for (const feature of Array.isArray(this.credentials.signedAuthorizationUsed) ? this.credentials.signedAuthorizationUsed : []) {
      if (PROTECTED_FEATURES.includes(feature)) this._signedAuthorizationUsed.add(feature);
    }
    for (const [feature, receipt] of Object.entries(this.credentials.entitlements || {})) {
      if (!PROTECTED_FEATURES.includes(feature)) continue;
      this._signedAuthorizationUsed.add(feature);
      const localNow = this.now();
      if (!Number.isFinite(receipt?.receivedAt) || !Number.isFinite(receipt?.trustedAt) || localNow < receipt.receivedAt) continue;
      this._entitlementAnchors.set(feature, { receivedAt: localNow, receivedMono: this.monotonicNow(),
        trustedAt: receipt.trustedAt + localNow - receipt.receivedAt });
    }
  }
  _entitlementNow(feature) {
    const localNow = this.now(), anchor = this._entitlementAnchors.get(feature);
    if (!anchor) return Math.floor(localNow);
    const trustedNow = anchor.trustedAt + Math.max(0, localNow - anchor.receivedAt, this.monotonicNow() - anchor.receivedMono);
    anchor.lastTrustedAt = Math.floor(Math.max(anchor.lastTrustedAt || anchor.trustedAt, trustedNow));
    return anchor.lastTrustedAt;
  }
  checkLocalAuthorization(feature) {
    if (!this._signedAuthorizationUsed.has(feature)) return null;
    const receipt = this.credentials?.entitlements?.[feature];
    if (!this.credentials?.token) throw accountError('ACCOUNT_AUTHORIZATION_REQUIRED', '软件账号已退出，请重新登录后继续。', 401);
    if (!receipt || !this._entitlementAnchors.has(feature)) throw entitlementError({ code: 'ENTITLEMENT_INVALID' });
    if (this._accountDeniesAuthorization(this.account)) throw accountError('ACCOUNT_AUTHORIZATION_REQUIRED', '当前账号或设备的会员授权已失效，请重新确认授权。', 403);
    try {
      const claims = verifyEntitlement(receipt.entitlement, { publicKeys: this.entitlementPublicKeys, now: this._entitlementNow(feature),
        token: this.credentials.token, publicKey: this.credentials.publicKey, feature, ...(this.account?.user?.id ? { userId: this.account.user.id } : {}) });
      if (this.account?.device?.id && claims.deviceId !== this.account.device.id) throw entitlementError({ code: 'ENTITLEMENT_INVALID' });
      return { authorized: true, userId: claims.userId };
    } catch (error) { throw entitlementError(error); }
  }
  _forgetEntitlements() {
    if (!this.credentials) return;
    this.credentials = { ...this.credentials, entitlements: {}, signedAuthorizationUsed: [...this._signedAuthorizationUsed] };
    this._entitlementAnchors.clear();
    this._authorizationRevision++;
  }
  _accountDeniesAuthorization(account) {
    return account?.membership?.active === false
      || (account?.device?.status && account.device.status !== 'authorized')
      || PROTECTED_FEATURES.some(feature => account?.features?.[feature]?.allowed === false);
  }
  async _rememberEntitlement(feature, entitlement, session, account, requestContext) {
    if (typeof requestContext?.nonce !== 'string' || !Number.isFinite(requestContext.startedAt) || !Number.isFinite(requestContext.startedMono)) {
      throw entitlementError({ code: 'ENTITLEMENT_INVALID' });
    }
    // issuedAt becomes a clock anchor only after the pinned signature verifies.
    let issuedAt;
    try { issuedAt = JSON.parse(Buffer.from(entitlement.payload, 'base64url').toString('utf8')).issuedAt; } catch {}
    const localNow = this.now();
    const receivedMono = this.monotonicNow();
    // Count the complete request flight conservatively. Anchoring issuedAt at
    // receipt would otherwise extend a grant that expired during a slow reply.
    const elapsed = Math.max(0, localNow - requestContext.startedAt, receivedMono - requestContext.startedMono);
    const trustedAt = issuedAt + Math.ceil(elapsed);
    try {
      const claims = verifyEntitlement(entitlement, { publicKeys: this.entitlementPublicKeys, now: trustedAt, token: session.token,
        publicKey: this.credentials.publicKey, feature, requestNonce: requestContext.nonce,
        ...((account?.user?.id || session.userId) ? { userId: account?.user?.id || session.userId } : {}) });
      if (account?.device?.id && claims.deviceId !== account.device.id) throw entitlementError({ code: 'ENTITLEMENT_INVALID' });
    } catch (error) { throw entitlementError(error); }
    await this._command(async () => {
      this._assertAuthorizationSession(session);
      const signedAuthorizationUsed = [...new Set([...this._signedAuthorizationUsed, feature])];
      const next = { ...this.credentials, signedAuthorizationUsed,
        entitlements: { ...this.credentials.entitlements, [feature]: { entitlement, receivedAt: localNow, trustedAt } } };
      await this.store.save(next);
      this._assertAuthorizationSession(session);
      this.credentials = next; this._signedAuthorizationUsed.add(feature);
      this._entitlementAnchors.set(feature, { receivedAt: localNow, trustedAt, receivedMono });
    });
  }
  async syncEntitlements() {
    if (!this.credentials?.token) return [];
    const features = PROTECTED_FEATURES.filter(feature => this.credentials.entitlements?.[feature]);
    return Promise.allSettled(features.map(feature => this.authorize(feature, { forceRemote: true })));
  }
  async _request(action, input = {}, { token = this.credentials?.token || '', unsigned = false, allowClockRetry = true, assertSession, signal } = {}) {
    assertSession?.();
    const started = this.now();
    const startedMono = this.monotonicNow();
    const nicknameRevision = this._nicknameRevision;
    if (!this.endpoint) throw accountError('CONFIGURATION_REQUIRED', '授权服务尚未配置，会员功能暂不可用。');
    const body = { action, input };
    if (!unsigned) {
      this._requireStorage();
      const timestamp = Math.round(this.now() + this.serverOffset), nonce = randomUUID();
      const payload = `${action}\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${token}`;
      body.proof = { timestamp, nonce, signature: sign(null, Buffer.from(payload), this.credentials.privateKey).toString('base64') };
    }
    let response, result;
    try {
      response = await this.fetchImpl(this.endpoint, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(action === 'feedback-finalize' ? 60_000 : 15_000) });
      result = await response.json();
    } catch {
      assertSession?.();
      this.onDiagnostic('account.request_failed', { action, durationMs: this.now() - started, code: 'NETWORK_ERROR' }, 'warn');
      throw accountError('SERVICE_UNAVAILABLE', '软件账号服务暂时不可用，请检查网络后重试；已下载文件会保留。');
    }
    assertSession?.();
    this.onDiagnostic('account.response', { action, status: response.status, code: result?.error?.code, durationMs: this.now() - started });
    const serverTime = Date.parse(result?.serverTime || result?.account?.serverTime);
    if (Number.isFinite(serverTime)) this.serverOffset = serverTime - this.now();
    if (!response.ok || result?.ok !== true) {
      if (allowClockRetry && Number.isFinite(serverTime) && SKEW_CODES.has(result?.error?.code)) {
        return this._request(action, input, { token, unsigned, allowClockRetry: false, assertSession, signal });
      }
      const code = result?.error?.code || 'SERVICE_UNAVAILABLE';
      throw accountError(code, accountServiceMessage(code, result?.error?.message || '软件账号服务暂时不可用。'), response.status || 503);
    }
    if (nicknameRevision !== this._nicknameRevision && this.credentials?.token === token
      && result.account?.user?.id === this.account?.user?.id && this.account?.user?.nickname) {
      result.account.user.nickname = this.account.user.nickname;
    }
    if (body.proof) Object.defineProperty(result, REQUEST_CONTEXT, { value: { nonce: body.proof.nonce, startedAt: started, startedMono } });
    return result;
  }
  async _flushPendingLogout() {
    if (!this.credentials?.pendingLogoutTokens.length || !this.endpoint) return;
    for (const token of [...this.credentials.pendingLogoutTokens]) {
      try { await this._request('logout', {}, { token }); }
      catch (error) { if (!EXPIRED_SESSION_CODES.has(error.code)) continue; }
      const next = { ...this.credentials, pendingLogoutTokens: this.credentials.pendingLogoutTokens.filter(value => value !== token) };
      await this.store.save(next); this.credentials = next;
    }
  }
  refresh() {
    return this._command(async () => {
      this._requireStorage(); await this._flushPendingLogout();
      if (!this.credentials.token) { this.status = this.endpoint ? 'signed_out' : 'configuration_required'; this._emit(); return this.snapshot(); }
      try {
        const result = await this._request('me');
        if (this._accountDeniesAuthorization(result.account)) {
          this._forgetEntitlements(); await this.store.save(this.credentials);
        }
        this.account = result.account; this.status = 'ready'; this.error = null; this._emit(); return this.snapshot();
      } catch (error) {
        if (EXPIRED_SESSION_CODES.has(error.code)) {
          this._forgetEntitlements();
          const next = { ...this.credentials, token: null }; await this.store.save(next);
          this._sessionGeneration++;
          this.credentials = next; this.account = null; this.status = 'signed_out';
        }
        this._recordError(error); throw error;
      }
    });
  }
  sendCode(email) {
    return this._command(async () => {
      this._requireStorage();
      try {
        await this._flushPendingLogout();
        const result = await this._request('send-code', { email: String(email).trim(), client: 'desktop' }, { token: '', unsigned: true });
        this.error = null; this._emit();
        return { expiresAt: result.expiresAt, expiresInSeconds: result.expiresInSeconds, retryAfter: result.retryAfterSeconds ?? result.retryAfter, message: result.message || '验证码已发送，请检查邮箱。' };
      } catch (error) { this._recordError(error); throw error; }
    });
  }
  verifyCode(email, code) {
    this.cancelGoogleLogin();
    return this._command(async () => {
      this._requireStorage();
      try {
        const result = await this._request('verify-code', { email: String(email).trim(), code: String(code).trim(), client: 'desktop', device: this.store.device(this.credentials) }, { token: '' });
        return await this._acceptLogin(result);
      } catch (error) { this._recordError(error); throw error; }
    });
  }
  async _acceptLogin(result, assertCurrent = () => {}, onAccepted = () => {}) {
    if (typeof result.token !== 'string' || !result.token || !result.account?.user?.id) throw accountError('SERVICE_UNAVAILABLE', '登录服务返回无效结果，请重试。');
    const previous = this.credentials, oldToken = previous.token;
    const next = { ...previous, token: result.token, entitlements: {}, signedAuthorizationUsed: [...this._signedAuthorizationUsed],
      pendingLogoutTokens: oldToken && oldToken !== result.token ? [...previous.pendingLogoutTokens, oldToken] : previous.pendingLogoutTokens };
    let saved = false;
    try {
      assertCurrent();
      await this.store.save(next); saved = true;
      assertCurrent();
    } catch (error) {
      try { await this._request('logout', {}, { token: result.token }); } catch {}
      if (saved) await this.store.save(previous);
      throw error;
    }
    this._sessionGeneration++;
    this._entitlementAnchors.clear();
    this.credentials = next; this.account = result.account; this.status = 'ready'; this.error = null;
    onAccepted();
    await this._flushPendingLogout(); this._emit(); return this.snapshot();
  }
  getGoogleConfig() {
    return this._request('google-config', { client: 'desktop' }, { token: '', unsigned: true });
  }
  async loginWithGoogle(openExternal) {
    if (this._googleAttempt) throw accountError('GOOGLE_LOGIN_PENDING', 'Google 登录正在进行，请先完成或取消。', 409);
    this._requireStorage();
    const attempt = { cancelled: false, controller: new AbortController(), generation: this._sessionGeneration };
    this._googleAttempt = attempt; this.error = null; this._emit();
    const assertCurrent = () => {
      if (attempt.cancelled || this._googleAttempt !== attempt) throw accountError('GOOGLE_LOGIN_CANCELLED', '已取消 Google 登录。', 400);
      if (this._sessionGeneration !== attempt.generation) throw accountError('SESSION_CHANGED', '软件账号已退出或切换，请重新登录。', 409);
    };
    try {
      const started = await this._command(async () => {
        assertCurrent(); await this._flushPendingLogout();
        return this._request('google-start', { client: 'desktop', device: this.store.device(this.credentials) },
          { token: '', assertSession: assertCurrent, signal: attempt.controller.signal });
      });
      attempt.id = started.attemptId; attempt.pollToken = started.pollToken;
      if (typeof attempt.id !== 'string' || !attempt.id || typeof attempt.pollToken !== 'string' || !attempt.pollToken) {
        throw accountError('GOOGLE_LOGIN_INVALID', 'Google 登录服务返回无效结果，请重试。');
      }
      assertCurrent();
      await openExternal(validateGoogleAuthorizationUrl(started.authorizationUrl));
      assertCurrent();
      const timeout = Math.min(600, Math.max(1, Number(started.expiresInSeconds) || 600)) * 1000;
      const deadline = this.monotonicNow() + timeout;
      while (this.monotonicNow() < deadline) {
        assertCurrent();
        let result;
        try {
          result = await this._request('google-poll', { client: 'desktop', attemptId: attempt.id, pollToken: attempt.pollToken },
            { token: '', assertSession: assertCurrent, signal: attempt.controller.signal });
        } catch (error) {
          assertCurrent();
          // Polling is idempotent: a lost reply may already have committed the
          // session. Keep this attempt and recover it with a fresh device proof.
          if (!retryableGooglePollError(error)) throw error;
        }
        if (result?.status === 'complete') {
          // Persist only in the main process after the browser explicitly
          // approved this device. A replacement login/logout invalidates it.
          return await this._command(() => this._acceptLogin(result, assertCurrent, () => {
            attempt.complete = true;
            if (this._googleAttempt === attempt) this._googleAttempt = null;
          }));
        }
        if (result && !['pending', 'confirmation_required'].includes(result.status)) throw accountError('GOOGLE_LOGIN_INVALID', 'Google 登录状态无效，请重试。');
        let onAbort;
        try {
          const delay = Math.min(4000, Math.max(0, deadline - this.monotonicNow()));
          await Promise.race([this.sleep(delay), new Promise(resolve => {
            onAbort = resolve;
            if (attempt.controller.signal.aborted) resolve();
            else attempt.controller.signal.addEventListener('abort', onAbort, { once: true });
          })]);
        } finally { attempt.controller.signal.removeEventListener('abort', onAbort); }
      }
      throw accountError('GOOGLE_LOGIN_EXPIRED', 'Google 登录已超时，请点击 Google 登录重试。', 410);
    } catch (error) {
      // Never log authorization codes, poll secrets, or session tokens.
      if (!['GOOGLE_LOGIN_CANCELLED', 'SESSION_CHANGED'].includes(error.code)) this._recordError(error);
      throw error;
    } finally {
      if (this._googleAttempt === attempt) { this._googleAttempt = null; this._emit(); }
      if (!attempt.complete) void this._cancelRemoteGoogleAttempt(attempt);
    }
  }
  async _cancelRemoteGoogleAttempt(attempt) {
    if (!attempt.id || !attempt.pollToken) return;
    return attempt.cancelRequest ||= (async () => {
      try { await this._request('google-cancel', { client: 'desktop', attemptId: attempt.id, pollToken: attempt.pollToken }, { token: '' }); } catch {}
    })();
  }
  cancelGoogleLogin() {
    const attempt = this._googleAttempt;
    if (!attempt) return { cancelled: false };
    attempt.cancelled = true; attempt.controller.abort();
    this._googleAttempt = null; this._emit();
    void this._cancelRemoteGoogleAttempt(attempt);
    return { cancelled: true, message: '已取消 Google 登录。' };
  }
  async authorize(feature, { forceRemote = false } = {}) {
    if (!KNOWN_FEATURES.includes(feature)) throw accountError('FEATURE_UNKNOWN', '未知的授权功能。', 403);
    if (!PROTECTED_FEATURES.includes(feature)) return { authorized: true, free: true };
    this._requireStorage();
    if (!this.endpoint) throw accountError('CONFIGURATION_REQUIRED', '授权服务尚未配置，会员功能暂不可用。');
    if (!this.credentials.token) throw accountError('ACCOUNT_REQUIRED', feature === 'watermark-free-video'
      ? '请先登录软件账号，再下载会员专享无水印视频。'
      : '请先登录软件账号，再使用主页批量下载。', 401);
    if (!forceRemote) {
      try { const local = this.checkLocalAuthorization(feature); if (local) return local; }
      catch { /* A missing or expired signed grant needs a fresh server grant. */ }
    }
    const session = { token: this.credentials.token, generation: this._sessionGeneration, revision: this._authorizationRevision, userId: this.account?.user?.id || '' };
    const pending = this._authorizations.get(feature);
    if (pending && pending.session.token === session.token && pending.session.generation === session.generation && pending.session.revision === session.revision
      && pending.session.userId === session.userId) return pending.promise;
    const entry = { session };
    entry.promise = this._authorize(feature, session).finally(() => {
      if (this._authorizations.get(feature) === entry) this._authorizations.delete(feature);
    });
    this._authorizations.set(feature, entry);
    return entry.promise;
  }
  _assertAuthorizationSession(session, { allowInvalidated = false } = {}) {
    if (this.credentials?.token !== session.token || this._sessionGeneration !== session.generation
      || (!allowInvalidated && this._authorizationRevision !== session.revision)
      || (session.userId && this.account?.user?.id !== session.userId)) {
      throw accountError('SESSION_CHANGED', '软件账号已退出或切换，请重新确认授权。', 401);
    }
  }
  async _authorize(feature, session) {
    const assertSession = () => this._assertAuthorizationSession(session);
    try {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        assertSession();
        try { result = await this._request('authorize', { feature }, { token: session.token, assertSession }); break; }
        catch (error) {
          assertSession();
          if (attempt === 2 || !retryableAuthorizationError(error)) throw error;
          const delayMs = (attempt + 1) * 1000;
          this.onDiagnostic('account.authorization_retry', { feature, attempt: attempt + 2, delayMs, code: error.code, status: error.status }, 'warn');
          await this.sleep(delayMs);
        }
      }
      assertSession();
      if (result.authorized !== true) throw accountError('AUTHORIZATION_DENIED', '当前账号或设备没有此功能的授权。', 403);
      if (result.entitlement && this._hasEntitlementKeys) await this._rememberEntitlement(feature, result.entitlement, session, result.account, result[REQUEST_CONTEXT]);
      else if (this._signedAuthorizationUsed.has(feature)) throw entitlementError({ code: 'ENTITLEMENT_INVALID' });
      assertSession();
      if (result.account) this.account = result.account;
      // Disk encryption or a queued account refresh can take time after the
      // HTTP reply. Never return authority that expired while it was saved.
      if (this._signedAuthorizationUsed.has(feature)) this.checkLocalAuthorization(feature);
      this.status = 'ready'; this.error = null; this._emit();
      return { authorized: true, ...(this.account?.user?.id ? { userId: this.account.user.id } : {}) };
    } catch (error) {
      // A delayed response must not overwrite the status of a replacement login.
      assertSession();
      if (retryableAuthorizationError(error)) {
        try {
          const local = this.checkLocalAuthorization(feature);
          if (local) {
            this.onDiagnostic('account.entitlement_fallback', { feature, code: error.code, status: error.status }, 'warn');
            this.status = 'ready'; this.error = null; this._emit(); return local;
          }
        } catch { /* Expired, revoked, or untrusted local grants never authorize. */ }
      } else if (authoritativeAuthorizationError(error)) {
        this._forgetEntitlements();
        await this._command(async () => { this._assertAuthorizationSession(session, { allowInvalidated: true }); await this.store.save(this.credentials); });
        this._assertAuthorizationSession(session, { allowInvalidated: true });
      }
      this.status = 'authorization_denied'; this._recordError(error); throw error;
    }
  }
  async feedbackRequest(action, input, expectedUserId) {
    if (!['feedback-begin', 'feedback-upload-part', 'feedback-finalize', 'feedback-mine', 'feedback-detail', 'feedback-reply'].includes(action)) throw accountError('UNKNOWN_ACTION', '无效反馈操作。', 400);
    return this._authenticatedRequest(action, input, expectedUserId);
  }
  commerceRequest(action, input = {}) {
    if (!['reviews-public', 'profile-update', 'review-mine', 'review-submit', 'orders-mine', 'order-create'].includes(action)) throw accountError('UNKNOWN_ACTION', '无效的评价或订单操作。', 400);
    if (action === 'reviews-public') return this._request(action, input, { token: '', unsigned: true });
    const token = this.credentials?.token;
    const serial = ['profile-update', 'review-submit'].includes(action) ? ++this._nicknameRequest : 0;
    return this._authenticatedRequest(action, input, input.expectedUserId).then(result => {
      if (serial > this._nicknameApplied && result.profile?.nickname
        && this.credentials?.token === token && this.account?.user?.id === input.expectedUserId) {
        this._nicknameApplied = serial;
        this._nicknameRevision++;
        this.account = { ...this.account, user: { ...this.account.user, nickname: result.profile.nickname } };
        this._emit();
      }
      return result;
    });
  }
  async _authenticatedRequest(action, input, expectedUserId) {
    const token = this.credentials?.token;
    if (!token || this.account?.user?.id !== expectedUserId) throw accountError('SESSION_CHANGED', '软件账号已退出或切换，请切回原账号再重试。', 401);
    let result;
    try { result = await this._request(action, input, { token }); }
    catch (error) {
      if (EXPIRED_SESSION_CODES.has(error.code)) {
        const invalidated = await this._command(async () => {
          // A delayed revoked response must never clear a replacement login.
          if (this.credentials?.token !== token || this.account?.user?.id !== expectedUserId) return false;
          const next = { ...this.credentials, token: null };
          this._sessionGeneration++;
          this._forgetEntitlements();
          next.entitlements = {};
          next.signedAuthorizationUsed = [...this._signedAuthorizationUsed];
          this.credentials = next; this.account = null; this.status = 'signed_out';
          this.error = { code: error.code, message: error.message }; this._emit();
          try { await this.store.save(next); }
          catch (storageError) {
            this.error = { code: storageError.code || 'SECURE_STORAGE_UNAVAILABLE', message: storageError.message || '无法保存退出状态，请重新登录。' };
            this._emit(); throw storageError;
          }
          return true;
        });
        if (!invalidated) throw accountError('SESSION_CHANGED', '反馈操作期间账号发生变化，请切回原账号重试。', 401);
      }
      throw error;
    }
    if (this.credentials?.token !== token || this.account?.user?.id !== expectedUserId) throw accountError('SESSION_CHANGED', '反馈操作期间账号发生变化，请切回原账号重试。', 401);
    return result;
  }
  redeem(code) {
    return this._command(async () => {
      this._requireStorage();
      if (!this.credentials.token) throw accountError('ACCOUNT_REQUIRED', '请先登录软件账号再兑换激活码。', 401);
      const normalized = String(code).trim();
      const digest = createHash('sha256').update(normalized).digest('hex');
      const requestId = this.credentials.pendingRedemptions?.[digest] || randomUUID();
      const next = { ...this.credentials, pendingRedemptions: { ...this.credentials.pendingRedemptions, [digest]: requestId } };
      await this.store.save(next); this.credentials = next;
      try {
        const result = await this._request('redeem', { code: normalized, requestId });
        this.account = result.account; this.status = 'ready'; this.error = null; this._emit();
        return { state: this.snapshot(), message: result.message || '兑换成功，会员权益已更新。', replayed: result.replayed === true };
      } catch (error) { this._recordError(error); throw error; }
    });
  }
  logout() {
    this.cancelGoogleLogin();
    return this._command(async () => {
      this._requireStorage();
      const next = { ...this.credentials, token: null, entitlements: {}, signedAuthorizationUsed: [...this._signedAuthorizationUsed],
        pendingLogoutTokens: [...new Set([...this.credentials.pendingLogoutTokens, this.credentials.token].filter(Boolean))] };
      await this.store.save(next); this.credentials = next;
      this._sessionGeneration++;
      this._entitlementAnchors.clear();
      this.account = null; this.status = 'signed_out'; this.error = null; this._emit();
      await this._flushPendingLogout(); this._emit();
      return { state: this.snapshot(), message: this.credentials.pendingLogoutTokens.length
        ? '已退出本机登录。服务器会话撤销尚未确认，应用下次联网时会自动重试。设备名额不会释放。'
        : '已退出登录，当前会话已撤销。设备名额不会释放。' };
    });
  }
}
