import { createHash, randomUUID, sign } from 'node:crypto';
import { accountError } from './account-storage.js';
import { KNOWN_FEATURES, PROTECTED_FEATURES } from '../lib/membership-policy.js';

const EXPIRED_SESSION_CODES = new Set(['SESSION_REVOKED', 'INVALID_SESSION', 'SESSION_INVALID', 'UNAUTHENTICATED']);
const SKEW_CODES = new Set(['PROOF_EXPIRED', 'PROOF_TIMESTAMP_INVALID', 'TIMESTAMP_INVALID']);

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

export class AccountClient {
  constructor({ store, endpoint, fetchImpl = globalThis.fetch, now = Date.now, onUpdate = () => {}, allowInsecureDevelopment = false }) {
    this.store = store; this.endpoint = validateAccountEndpoint(endpoint, allowInsecureDevelopment);
    this.fetchImpl = fetchImpl; this.now = now; this.onUpdate = onUpdate;
    this.credentials = null; this.account = null; this.error = null;
    this.status = this.endpoint ? 'signed_out' : 'configuration_required';
    this.serverOffset = 0; this._commands = Promise.resolve();
  }
  snapshot() {
    return structuredClone({ status: this.status, account: this.account, error: this.error,
      authenticated: Boolean(this.credentials?.token), verified: this.status === 'ready',
      pendingLogout: Boolean(this.credentials?.pendingLogoutTokens?.length), configured: Boolean(this.endpoint), protectedFeatures: PROTECTED_FEATURES });
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
  async initialize() {
    try {
      this.credentials = await this.store.load();
      this.status = !this.endpoint ? 'configuration_required' : this.credentials.token ? 'checking' : 'signed_out';
    } catch (error) { this.status = 'secure_storage_unavailable'; this.error = { code: error.code, message: error.message }; }
    this._emit(); return this.snapshot();
  }
  _requireStorage() {
    if (!this.credentials) throw accountError(this.error?.code || 'SECURE_STORAGE_UNAVAILABLE', this.error?.message || '系统安全存储不可用。');
  }
  async _request(action, input = {}, { token = this.credentials?.token || '', unsigned = false, allowClockRetry = true } = {}) {
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
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      result = await response.json();
    } catch { throw accountError('SERVICE_UNAVAILABLE', '软件账号服务暂时不可用，请检查网络后重试；已下载文件会保留。'); }
    const serverTime = Date.parse(result?.serverTime || result?.account?.serverTime);
    if (Number.isFinite(serverTime)) this.serverOffset = serverTime - this.now();
    if (!response.ok || result?.ok !== true) {
      if (allowClockRetry && Number.isFinite(serverTime) && SKEW_CODES.has(result?.error?.code)) {
        return this._request(action, input, { token, unsigned, allowClockRetry: false });
      }
      throw accountError(result?.error?.code || 'SERVICE_UNAVAILABLE', result?.error?.message || '软件账号服务暂时不可用。', response.status || 503);
    }
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
        this.account = result.account; this.status = 'ready'; this.error = null; this._emit(); return this.snapshot();
      } catch (error) {
        if (EXPIRED_SESSION_CODES.has(error.code)) {
          const next = { ...this.credentials, token: null }; await this.store.save(next);
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
    return this._command(async () => {
      this._requireStorage();
      try {
        const result = await this._request('verify-code', { email: String(email).trim(), code: String(code).trim(), client: 'desktop', device: this.store.device(this.credentials) }, { token: '' });
        if (typeof result.token !== 'string' || !result.token || !result.account) throw accountError('SERVICE_UNAVAILABLE', '登录服务返回无效结果，请重试。');
        const oldToken = this.credentials.token;
        const next = { ...this.credentials, token: result.token, pendingLogoutTokens: oldToken && oldToken !== result.token ? [...this.credentials.pendingLogoutTokens, oldToken] : this.credentials.pendingLogoutTokens };
        try { await this.store.save(next); }
        catch (error) { try { await this._request('logout', {}, { token: result.token }); } catch {} throw error; }
        this.credentials = next; this.account = result.account; this.status = 'ready'; this.error = null;
        await this._flushPendingLogout(); this._emit(); return this.snapshot();
      } catch (error) { this._recordError(error); throw error; }
    });
  }
  async authorize(feature) {
    if (!KNOWN_FEATURES.includes(feature)) throw accountError('FEATURE_UNKNOWN', '未知的授权功能。', 403);
    if (!PROTECTED_FEATURES.includes(feature)) return { authorized: true, free: true };
    this._requireStorage();
    if (!this.endpoint) throw accountError('CONFIGURATION_REQUIRED', '授权服务尚未配置，会员功能暂不可用。');
    if (!this.credentials.token) throw accountError('ACCOUNT_REQUIRED', '请先登录软件账号，再使用主页批量下载。', 401);
    const token = this.credentials.token;
    try {
      const result = await this._request('authorize', { feature }, { token });
      if (this.credentials.token !== token) throw accountError('SESSION_CHANGED', '软件账号已退出或切换，请重新确认授权。', 401);
      if (result.authorized !== true) throw accountError('AUTHORIZATION_DENIED', '当前账号或设备没有此功能的授权。', 403);
      if (result.account) this.account = result.account;
      this.status = 'ready'; this.error = null; this._emit(); return { authorized: true };
    } catch (error) { this.status = 'authorization_denied'; this._recordError(error); throw error; }
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
    return this._command(async () => {
      this._requireStorage();
      const next = { ...this.credentials, token: null, pendingLogoutTokens: [...new Set([...this.credentials.pendingLogoutTokens, this.credentials.token].filter(Boolean))] };
      await this.store.save(next); this.credentials = next;
      this.account = null; this.status = 'signed_out'; this.error = null; this._emit();
      await this._flushPendingLogout(); this._emit();
      return { state: this.snapshot(), message: this.credentials.pendingLogoutTokens.length
        ? '已退出本机登录。服务器会话撤销尚未确认，应用下次联网时会自动重试。设备名额不会释放。'
        : '已退出登录，当前会话已撤销。设备名额不会释放。' };
    });
  }
}
