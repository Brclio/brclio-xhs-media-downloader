import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { equalDigest, normalizeDevice, verifyProof } from './crypto.js';

const TTL = 600_000, HOUR = 3_600_000;
const iso = time => new Date(time).toISOString();
const owns = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const attemptInvalid = () => fail('GOOGLE_ATTEMPT_INVALID', 'Google 登录已过期或已取消，请重新发起。', 401);

/** OAuth state is durable across serverless instances; only hashes and public
 * device data are persisted. Google tokens and the PKCE verifier never enter it. */
export function createGoogleLoginService({ store, now, hash, google, loginSession, emailValue, noMembership, isAdmin }) {
  const stateKey = state => hash('google-state', state);
  const verifier = id => hash('google-pkce', id);
  const nonce = id => hash('google-nonce', id);
  const byId = (state, id) => typeof id === 'string' && Object.values(state.googleAttempts || {}).find(item => item.id === id);
  function validAttempt(attempt) {
    if (!attempt || Date.parse(attempt.expiresAt) <= now() || ['cancelled', 'failed'].includes(attempt.status)) attemptInvalid();
    return attempt;
  }
  function browser(request) {
    if (request.input.client !== 'browser' || request.client !== 'browser') fail('BROWSER_REQUIRED', '请通过 Google 返回的网页完成登录。', 403);
  }
  function binding(attempt, value) {
    if (typeof value !== 'string' || !equalDigest(attempt.browserBindingDigest, hash('google-browser-binding', value))) fail('GOOGLE_BROWSER_MISMATCH', '请在发起 Google 登录的同一浏览器中完成登录。', 403);
  }
  function native(request, attempt) {
    validAttempt(attempt);
    if (request.input.client !== 'desktop' || request.client === 'browser' || attempt.client !== 'desktop') fail('INVALID_CLIENT', '请通过原客户端完成 Google 登录。', 403);
    if (typeof request.input.pollToken !== 'string' || !equalDigest(attempt.pollDigest, hash('google-poll', request.input.pollToken))) attemptInvalid();
    verifyProof({ ...request, token: '', publicKey: attempt.device.publicKey, now: now() });
  }
  function resolveUser(state, identity, time) {
    let user = Object.values(state.users).find(item => item.googleSubjectDigest === identity.subjectDigest);
    if (user) return user; // Google's stable sub survives mailbox renames.
    if (!identity.authoritativeEmail) fail('GOOGLE_EMAIL_VERIFICATION_REQUIRED', '此 Google 账号使用第三方邮箱，请使用邮箱验证码登录以验证当前邮箱所有权。', 403);
    user = Object.values(state.users).find(item => item.email === identity.email);
    if (user?.googleSubjectDigest && user.googleSubjectDigest !== identity.subjectDigest) fail('GOOGLE_ACCOUNT_CONFLICT', '该邮箱已关联其他 Google 身份，请使用邮箱验证码登录。', 409);
    if (!user) {
      user = { id: randomUUID(), email: identity.email, createdAt: iso(time), membership: noMembership() };
      user.role = isAdmin(user) ? 'admin' : 'user';
      state.users[user.id] = user;
    }
    user.googleSubjectDigest = identity.subjectDigest;
    user.googleLinkedAt = iso(time);
    return user;
  }
  function browserResult(state, attempt, rawState, request) {
    binding(attempt, request.googleBinding);
    const token = hash('google-browser-session', `${rawState}:${request.googleBinding}`);
    const session = owns(state.sessions, hash('session', token));
    if (!session || session.revokedAt) fail('GOOGLE_ATTEMPT_USED', '本次 Google 登录已使用，请重新发起。', 401);
    // Reusing the existing session does not bind a device or revive a logout.
    return { loginClient: 'browser', ...loginSessionView(state, session, token) };
  }
  // The shared session helper supplies the same account view for OTP and Google.
  // A read-only view is injected through its optional existing-session argument.
  function loginSessionView(state, session, token) {
    return loginSession(state, state.users[session.userId], session.client, null, token, now(), session);
  }
  function desktopConfirmation(attempt, rawState) {
    return { loginClient: 'desktop', status: 'confirmation_required', attemptId: attempt.id,
      confirmationToken: hash('google-confirmation', rawState), browserBinding: hash('google-desktop-browser', rawState),
      email: attempt.identity.email, deviceName: attempt.device.name };
  }
  async function start(request) {
    if (!google.enabled) fail('GOOGLE_NOT_CONFIGURED', 'Google 登录尚未启用，请使用邮箱验证码登录。', 503);
    const client = request.input.client;
    if (!['browser', 'desktop'].includes(client)) fail('INVALID_CLIENT', '登录类型无效。');
    if (client === 'browser') browser(request);
    let device;
    if (client === 'desktop') {
      if (request.client === 'browser') fail('INVALID_CLIENT', '请通过客户端发起 Google 登录。', 403);
      const normalized = normalizeDevice(request.input.device);
      verifyProof({ ...request, token: '', publicKey: normalized.publicKey, now: now() });
      const { stableIdHash, ...publicDevice } = normalized;
      device = { ...publicDevice, stableHash: hash('device-stable', stableIdHash) };
    }
    const id = randomUUID(), rawState = randomBytes(32).toString('base64url');
    const pollToken = client === 'desktop' ? randomBytes(32).toString('base64url') : null;
    const browserBinding = client === 'browser' ? randomBytes(32).toString('base64url') : null;
    await store.transaction(state => {
      const time = now();
      state.googleAttempts ||= {};
      for (const [key, attempt] of Object.entries(state.googleAttempts)) if (Date.parse(attempt.expiresAt) <= time) delete state.googleAttempts[key];
      for (const [key, times] of Object.entries(state.rateLimits)) {
        state.rateLimits[key] = times.filter(at => at > time - HOUR);
        if (!state.rateLimits[key].length) delete state.rateLimits[key];
      }
      const ipKey = hash('google-rate-ip', request.ip || 'unknown');
      for (const key of [ipKey, 'google-global']) state.rateLimits[key] ||= [];
      if (state.rateLimits[ipKey].length >= 20 || state.rateLimits['google-global'].length >= 200 || Object.keys(state.googleAttempts).length >= 200) fail('GOOGLE_LOGIN_LIMIT', 'Google 登录请求较多，请稍后再试。', 429);
      state.rateLimits[ipKey].push(time); state.rateLimits['google-global'].push(time);
      state.googleAttempts[stateKey(rawState)] = { id, client, status: 'pending', createdAt: iso(time), expiresAt: iso(time + TTL),
        nonceDigest: hash('google-nonce-check', nonce(id)), ...(pollToken ? { pollDigest: hash('google-poll', pollToken), device } : {}),
        ...(browserBinding ? { browserBindingDigest: hash('google-browser-binding', browserBinding) } : {}) };
      return { value: true };
    });
    return { attemptId: id, authorizationUrl: google.authorizationUrl({ state: rawState, nonce: nonce(id), codeVerifier: verifier(id) }), expiresInSeconds: TTL / 1000,
      ...(pollToken ? { pollToken } : {}), ...(browserBinding ? { browserBinding } : {}) };
  }
  async function complete(request) {
    browser(request);
    const rawState = request.input.state, code = request.input.code;
    if (typeof rawState !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawState) || typeof code !== 'string' || !code || code.length > 4096 || /[\x00-\x20\x7f]/.test(code)) attemptInvalid();
    const key = stateKey(rawState), codeDigest = hash('google-code', code);
    const initial = await store.transaction(state => {
      const attempt = validAttempt(owns(state.googleAttempts || {}, key));
      if (attempt.client === 'browser') binding(attempt, request.googleBinding);
      if (attempt.codeDigest && !equalDigest(attempt.codeDigest, codeDigest)) attemptInvalid();
      if (attempt.status === 'complete' && attempt.client === 'browser') return { changed: false, value: { replay: browserResult(state, attempt, rawState, request) } };
      if (['confirmation_required', 'ready', 'complete'].includes(attempt.status) && attempt.client === 'desktop') return { changed: false, value: { replay: desktopConfirmation(attempt, rawState) } };
      if (attempt.status !== 'pending') fail('GOOGLE_LOGIN_IN_PROGRESS', 'Google 登录正在处理，请稍后重试。', 409);
      attempt.codeDigest = codeDigest; attempt.status = 'exchanging';
      return { value: structuredClone(attempt) };
    });
    if (initial.replay) return initial.replay;
    let claims;
    try { claims = await google.exchange({ code, codeVerifier: verifier(initial.id), nonce: nonce(initial.id) }); }
    catch (error) {
      await store.transaction(state => {
        const attempt = owns(state.googleAttempts || {}, key);
        if (attempt?.status === 'exchanging' && attempt.codeDigest === codeDigest) attempt.status = 'failed';
        return { value: true };
      });
      throw error;
    }
    const identity = { subjectDigest: hash('google-subject', claims.subject), email: emailValue(claims.email), authoritativeEmail: claims.authoritativeEmail };
    return store.transaction(state => {
      const attempt = validAttempt(owns(state.googleAttempts || {}, key)), time = now();
      if (attempt.status !== 'exchanging' || attempt.codeDigest !== codeDigest) attemptInvalid();
      attempt.identity = identity;
      if (attempt.client === 'desktop') {
        attempt.status = 'confirmation_required';
        const result = desktopConfirmation(attempt, rawState);
        attempt.confirmationDigest = hash('google-confirmation-check', result.confirmationToken);
        attempt.browserBindingDigest = hash('google-browser-binding', result.browserBinding);
        return { value: result };
      }
      const user = resolveUser(state, identity, time);
      const token = hash('google-browser-session', `${rawState}:${request.googleBinding}`);
      const result = loginSession(state, user, 'browser', null, token, time);
      attempt.status = 'complete'; attempt.completedAt = iso(time); attempt.sessionDigest = hash('session', token);
      return { value: { loginClient: 'browser', ...result } };
    });
  }
  async function confirm(request) {
    browser(request);
    return store.transaction(state => {
      const attempt = validAttempt(byId(state, request.input.attemptId));
      if (attempt.client !== 'desktop') attemptInvalid();
      binding(attempt, request.googleBinding);
      if (typeof request.input.confirmationToken !== 'string' || !equalDigest(attempt.confirmationDigest, hash('google-confirmation-check', request.input.confirmationToken))) attemptInvalid();
      if (['ready', 'complete'].includes(attempt.status)) return { changed: false, value: { loginClient: 'desktop', status: 'complete' } };
      if (attempt.status !== 'confirmation_required') attemptInvalid();
      attempt.userId = resolveUser(state, attempt.identity, now()).id;
      attempt.status = 'ready'; attempt.confirmedAt = iso(now());
      return { value: { loginClient: 'desktop', status: 'complete' } };
    });
  }
  async function poll(request) {
    const { state } = await store.read();
    const attempt = byId(state, request.input.attemptId);
    native(request, attempt);
    if (!['ready', 'complete'].includes(attempt.status)) return { status: attempt.status === 'confirmation_required' ? 'confirmation_required' : 'pending' };
    return store.transaction(latest => {
      const current = byId(latest, request.input.attemptId);
      native(request, current);
      const token = hash('google-desktop-session', `${current.id}:${request.input.pollToken}`);
      if (current.status === 'complete') {
        const session = owns(latest.sessions, hash('session', token));
        if (!session || session.revokedAt) fail('GOOGLE_ATTEMPT_USED', '本次 Google 登录已使用，请重新发起。', 401);
        return { changed: false, value: { status: 'complete', ...loginSessionView(latest, session, token) } };
      }
      if (current.status !== 'ready') attemptInvalid();
      const result = loginSession(latest, latest.users[current.userId], 'desktop', current.device, token, now());
      current.status = 'complete'; current.completedAt = iso(now()); current.sessionDigest = hash('session', token);
      return { value: { status: 'complete', ...result } };
    });
  }
  async function cancel(request) {
    return store.transaction(state => {
      const attempt = byId(state, request.input.attemptId);
      // A repeated cancel still requires possession of both the private key and
      // poll secret, but can safely report success after its first commit.
      if (attempt?.status === 'cancelled') {
        const active = { ...attempt, status: 'pending' }; native(request, active);
        return { changed: false, value: { status: 'cancelled' } };
      }
      native(request, attempt);
      if (attempt.sessionDigest && state.sessions[attempt.sessionDigest]) state.sessions[attempt.sessionDigest].revokedAt = iso(now());
      attempt.status = 'cancelled'; attempt.cancelledAt = iso(now());
      return { value: { status: 'cancelled' } };
    });
  }
  return { async execute(request) {
    if (request.action === 'google-config') return { enabled: google.enabled };
    if (request.action === 'google-start') return start(request);
    if (request.action === 'google-complete') return complete(request);
    if (request.action === 'google-confirm') return confirm(request);
    if (request.action === 'google-poll') return poll(request);
    if (request.action === 'google-cancel') return cancel(request);
    fail('UNKNOWN_ACTION', '未知操作。', 404);
  } };
}
