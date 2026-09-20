import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { AccountError, fail } from './errors.js';
import { digest, equalDigest, normalizeDevice, verifyProof } from './crypto.js';
import { KNOWN_FEATURES } from '../../lib/membership-policy.js';
import { createFeedbackService } from './feedback.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const owns = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const clone = value => structuredClone(value);
const iso = timestamp => new Date(timestamp).toISOString();
const noMembership = () => ({ type: 'none', startsAt: null, expiresAt: null });
const expected = (code, message, status = 400) => ({ error: { code, message, status } });

function emailValue(value) {
  // Accept one bare ASCII addr-spec only. Never let a mail parser interpret display
  // names, comments, quoted recipients or recipient lists differently from our key.
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_EMAIL', '请输入单个有效的邮箱地址，不要包含姓名或其他格式。');
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  const local = parts[0], domain = parts[1];
  const localAtom = /^[a-z0-9!#$%&*+/=?^_`{|}~-]+$/;
  const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (parts.length !== 2 || email.length > 254 || !local || local.length > 64 || !domain || domain.length > 253 ||
      !local.split('.').every(atom => localAtom.test(atom)) || domain.split('.').length < 2 || !domain.split('.').every(label => domainLabel.test(label))) {
    fail('INVALID_EMAIL', '请输入单个有效的邮箱地址，不要包含姓名或其他格式。');
  }
  return email;
}
function mailboxRateKey(email) {
  const [local, domain] = email.split('@');
  // Gmail aliases share one inbox. Normalize only the abuse-control bucket; never
  // silently rewrite the account's verified address or administrator allowlist.
  return ['gmail.com', 'googlemail.com'].includes(domain) ? `${local.split('+')[0].replaceAll('.', '')}@gmail.com` : email;
}
function requestIdValue(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) fail('INVALID_REQUEST_ID', '请使用有效且唯一的操作请求 ID。');
  return value;
}
function reasonValue(value) {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 500) fail('REASON_REQUIRED', '请填写 2 至 500 字的操作原因。');
  return value.trim();
}
function daysValue(value, signed = false) {
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days === 0 || Math.abs(days) > 36_500 || (!signed && days < 0)) fail('INVALID_DURATION', '会员天数必须为 1 至 36500 的整数。');
  return days;
}
function futureDate(value, time) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= time || parsed > time + 36_500 * DAY) fail('INVALID_EXPIRY', '请选择未来 100 年内的有效日期。');
  return iso(parsed);
}
function publicCode(code) {
  const { digest: ignored, ...result } = code;
  return clone(result);
}

export function createAccountService({ store, mailer, config, now = Date.now }) {
  const hash = (purpose, value) => digest(config.pepper, purpose, value);
  const isAdmin = user => config.adminEmails.includes(user.email);
  const role = user => isAdmin(user) ? 'admin' : 'user';
  const otpKey = (email, client) => hash('otp-key', `${client}:${email}`);

  function membership(user, time) {
    const member = user.membership || noMembership();
    const active = member.type === 'permanent' || (member.type === 'duration' && Date.parse(member.startsAt) <= time && Date.parse(member.expiresAt) > time);
    return { ...clone(member), active };
  }
  function deviceView(state, session) {
    if (session.client !== 'desktop') return { status: 'unbound' };
    const device = session.deviceId ? owns(state.devices, session.deviceId) : null;
    if (!device) return { status: session.deviceStatus || 'device_limit', message: session.deviceStatus === 'revoked' ? '此设备授权已被管理员撤销，请联系管理员。' : '账号已绑定其他设备，请联系管理员解绑' };
    return { id: device.id, name: device.name, platform: device.platform, status: device.status === 'active' ? 'authorized' : 'revoked', boundAt: device.boundAt, lastCheckedAt: device.lastCheckedAt, revokedAt: device.revokedAt || null };
  }
  function account(state, user, session, time) {
    const member = membership(user, time);
    const device = deviceView(state, session);
    const features = Object.fromEntries(KNOWN_FEATURES.map(feature => [feature, { requiresMembership: config.protectedFeatures.includes(feature), requiresDevice: config.protectedFeatures.includes(feature), allowed: !config.protectedFeatures.includes(feature) || (member.active && device.status === 'authorized' && session.client === 'desktop') }]));
    return { user: { id: user.id, email: user.email, role: role(user), createdAt: user.createdAt }, membership: member, device, features, serverTime: iso(time) };
  }
  function userView(state, user, time) {
    return { id: user.id, email: user.email, role: role(user), createdAt: user.createdAt, membership: membership(user, time), devices: Object.values(state.devices).filter(d => d.userId === user.id).map(d => ({ id: d.id, name: d.name, platform: d.platform, status: d.status, boundAt: d.boundAt, lastCheckedAt: d.lastCheckedAt, revokedAt: d.revokedAt || null })) };
  }
  function authenticate(state, request, time, adminRequired = false) {
    if (typeof request.token !== 'string' || request.token.length < 32 || request.token.length > 200) fail('ACCOUNT_REQUIRED', '请先登录软件账号。', 401);
    const session = owns(state.sessions, hash('session', request.token));
    if (!session || session.revokedAt) fail('SESSION_REVOKED', '登录已失效，请重新登录。', 401);
    const user = owns(state.users, session.userId);
    if (!user) fail('SESSION_REVOKED', '账号不存在，请联系管理员。', 401);
    if (session.client === 'desktop') verifyProof({ ...request, publicKey: session.publicKey, now: time });
    if (adminRequired && (session.client !== 'admin' || !isAdmin(user))) fail('FORBIDDEN', '只有管理员可以执行此操作。', 403);
    return { session, user };
  }
  function requireUser(state, id) {
    const user = owns(state.users, id);
    if (!user) fail('USER_NOT_FOUND', '没有找到该用户。', 404);
    return user;
  }
  function audit(state, admin, action, targetId, reason, before, after, time) {
    state.audit.push({ id: randomUUID(), action, actorId: admin.id, actorEmail: admin.email, at: iso(time), targetId, reason, before: clone(before), after: clone(after) });
  }
  function operation(state, actor, request, calculate) {
    const requestId = requestIdValue(request.input.requestId);
    const key = hash('operation', `${actor.id}:${requestId}`);
    const inputHash = hash('operation-input', `${request.action}:${JSON.stringify(request.input)}`);
    const prior = owns(state.operations, key);
    if (prior) {
      if (prior.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该请求 ID 已用于其他操作，请重新发起。', 409);
      return { value: { ...clone(prior.result), replayed: true }, changed: false };
    }
    const result = calculate();
    state.operations[key] = { actorId: actor.id, action: request.action, inputHash, at: iso(now()), result: clone(result.persisted ?? result) };
    return { value: result.response ?? result };
  }

  async function sendCode(request) {
    const email = emailValue(request.input.email);
    const client = request.input.client;
    if (!['desktop', 'admin'].includes(client)) fail('INVALID_CLIENT', '登录类型无效。');
    if (client === 'admin' && !config.adminEmails.includes(email)) fail('FORBIDDEN', '此邮箱未配置为管理员。', 403);
    if (mailer.configured === false) fail('MAIL_NOT_CONFIGURED', '邮件服务尚未配置，请联系管理员。', 503);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const deliveryId = randomUUID();
    const key = otpKey(email, client);
    await store.transaction(state => {
      const time = now();
      for (const [rateKey, times] of Object.entries(state.rateLimits)) {
        state.rateLimits[rateKey] = times.filter(t => t > time - HOUR);
        if (!state.rateLimits[rateKey].length) delete state.rateLimits[rateKey];
      }
      const prior = owns(state.otps, key);
      if (prior && time - Date.parse(prior.createdAt) < config.otpIntervalMs) fail('SEND_TOO_SOON', '验证码发送太频繁，请 60 秒后重试。', 429);
      const limits = [[hash('email-rate', mailboxRateKey(email)), config.otpEmailHourlyLimit], [hash('ip-rate', request.ip || 'unknown'), config.otpIpHourlyLimit], ['global', config.otpGlobalHourlyLimit]];
      for (const [rateKey, limit] of limits) if ((state.rateLimits[rateKey] || []).length >= limit) fail('SEND_LIMIT', '验证码发送次数已达上限，请稍后再试。', 429);
      if ((state.rateLimits[limits[0][0]] || []).some(sentAt => time - sentAt < config.otpIntervalMs)) fail('SEND_TOO_SOON', '验证码发送太频繁，请 60 秒后重试。', 429);
      for (const [rateKey] of limits) (state.rateLimits[rateKey] ||= []).push(time);
      if (prior) (state.otpHistory ||= []).push({ ...clone(prior), emailKey: key });
      state.otps[key] = { id: deliveryId, codeDigest: hash('otp', `${key}:${deliveryId}:${code}`), createdAt: iso(time), expiresAt: iso(time + config.otpTtlMs), attempts: 0, checks: [], status: 'pending', consumedAt: null };
      return { value: true };
    });
    try {
      await mailer.send({ email, code, expiresInMinutes: config.otpTtlMs / 60_000, deliveryId });
    } catch (error) {
      await store.transaction(state => {
        if (state.otps[key]?.id === deliveryId) state.otps[key].status = 'failed';
        state.mailStatus = { status: 'failed', at: iso(now()) };
        return { value: true };
      });
      if (error instanceof AccountError) throw error;
      fail('MAIL_SEND_FAILED', '验证码邮件发送失败，请稍后重试。', 503);
    }
    await store.transaction(state => {
      if (state.otps[key]?.id === deliveryId) state.otps[key].status = 'sent';
      state.mailStatus = { status: 'sent', at: iso(now()) };
      return { value: true };
    });
    return { message: '验证码已发送，首次验证将自动创建账号。', expiresInSeconds: config.otpTtlMs / 1000, retryAfterSeconds: config.otpIntervalMs / 1000 };
  }

  async function verifyCode(request) {
    const email = emailValue(request.input.email);
    const client = request.input.client;
    if (!['desktop', 'admin'].includes(client)) fail('INVALID_CLIENT', '登录类型无效。');
    if (client === 'admin' && !config.adminEmails.includes(email)) fail('FORBIDDEN', '此邮箱未配置为管理员。', 403);
    const deviceInput = client === 'desktop' ? normalizeDevice(request.input.device) : null;
    if (deviceInput) verifyProof({ ...request, token: '', publicKey: deviceInput.publicKey, now: now() });
    const token = randomBytes(32).toString('base64url');
    const sessionKey = hash('session', token);
    const result = await store.transaction(state => {
      const time = now();
      const key = otpKey(email, client);
      const otp = owns(state.otps, key);
      if (!otp) return { value: expected('CODE_INVALID', '验证码错误或尚未发送。'), changed: false };
      if (otp.consumedAt) return { value: expected('CODE_USED', '验证码已使用，请重新获取。'), changed: false };
      if (otp.status !== 'sent') return { value: expected('CODE_NOT_READY', '邮件发送尚未确认，请重新获取验证码。'), changed: false };
      if (Date.parse(otp.expiresAt) <= time) return { value: expected('CODE_EXPIRED', '验证码已过期，请重新获取。'), changed: false };
      if (otp.attempts >= config.otpMaxAttempts) return { value: expected('CODE_ATTEMPTS_EXCEEDED', '验证码错误次数过多，请重新获取。', 429), changed: false };
      if (!equalDigest(otp.codeDigest, hash('otp', `${key}:${otp.id}:${String(request.input.code || '')}`))) {
        otp.attempts += 1;
        (otp.checks ||= []).push({ at: iso(time), result: otp.attempts >= config.otpMaxAttempts ? 'locked' : 'invalid' });
        return { value: expected(otp.attempts >= config.otpMaxAttempts ? 'CODE_ATTEMPTS_EXCEEDED' : 'CODE_INVALID', otp.attempts >= config.otpMaxAttempts ? '验证码错误次数过多，请重新获取。' : '验证码错误，请重试。', otp.attempts >= config.otpMaxAttempts ? 429 : 400) };
      }
      let user = Object.values(state.users).find(item => item.email === email);
      if (!user) {
        const id = randomUUID();
        user = { id, email, role: config.adminEmails.includes(email) ? 'admin' : 'user', createdAt: iso(time), membership: noMembership() };
        state.users[id] = user;
      }
      otp.consumedAt = iso(time);
      otp.status = 'consumed';
      (otp.checks ||= []).push({ at: iso(time), result: 'consumed' });
      const session = { id: randomUUID(), userId: user.id, client, createdAt: iso(time), revokedAt: null, deviceId: null, deviceStatus: 'unbound' };
      if (deviceInput) {
        const userDevices = Object.values(state.devices).filter(d => d.userId === user.id);
        const stableHash = hash('device-stable', deviceInput.stableIdHash);
        const revoked = userDevices.find(d => d.status === 'revoked' && (d.stableHash === stableHash || d.keyFingerprint === deviceInput.keyFingerprint));
        const active = userDevices.find(d => d.status === 'active' && d.stableHash === stableHash && d.keyFingerprint === deviceInput.keyFingerprint);
        session.publicKey = deviceInput.publicKey;
        // A specific admin-approved replacement key is allowed; old stable-ID
        // tombstones must not override that exact active stable+key record.
        if (active) { session.deviceId = active.id; session.deviceStatus = 'authorized'; }
        else if (revoked) { session.deviceId = revoked.id; session.deviceStatus = 'revoked'; }
        else if (userDevices.filter(d => d.status === 'active').length < config.deviceLimit) {
          // Only an explicit OTP login can claim a slot. Read-only session refresh never binds.
          const id = randomUUID();
          state.devices[id] = { id, userId: user.id, stableHash, keyFingerprint: deviceInput.keyFingerprint, publicKey: deviceInput.publicKey, name: deviceInput.name, platform: deviceInput.platform, status: 'active', boundAt: iso(time), lastCheckedAt: iso(time), revokedAt: null };
          session.deviceId = id;
          session.deviceStatus = 'authorized';
        } else session.deviceStatus = 'device_limit';
        if (session.deviceStatus !== 'authorized' && !userDevices.some(d => d.keyFingerprint === deviceInput.keyFingerprint)) {
          session.pendingDevice = { stableHash, keyFingerprint: deviceInput.keyFingerprint, publicKey: deviceInput.publicKey, name: deviceInput.name, platform: deviceInput.platform };
        }
      }
      state.sessions[sessionKey] = session;
      return { value: { token, account: account(state, user, session, time) } };
    });
    if (result.error) fail(result.error.code, result.error.message, result.error.status);
    return result;
  }

  async function readAction(request) {
    const { state } = await store.read();
    const time = now();
    const { user, session } = authenticate(state, request, time, request.action.startsWith('admin-'));
    if (request.action === 'me') return { account: account(state, user, session, time) };
    if (request.action === 'authorize') {
      const feature = request.input.feature;
      if (!KNOWN_FEATURES.includes(feature)) fail('UNKNOWN_FEATURE', '未知功能。');
      if (session.client !== 'desktop') fail('DESKTOP_REQUIRED', '此权限仅适用于桌面客户端。', 403);
      if (config.protectedFeatures.includes(feature)) {
        const device = deviceView(state, session);
        if (device.status !== 'authorized') fail(device.status === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_LIMIT', device.status === 'revoked' ? '此设备授权已被管理员撤销，请联系管理员。' : '账号已绑定其他设备，请联系管理员解绑', 403);
        const member = membership(user, time);
        if (!member.active) fail(member.type === 'duration' ? 'MEMBERSHIP_EXPIRED' : 'MEMBERSHIP_REQUIRED', member.type === 'duration' ? '会员已到期，请续期后继续。' : '此功能需要开通会员。', 403);
        if (time - Date.parse(state.devices[session.deviceId].lastCheckedAt) >= config.deviceCheckWriteMs) {
          return store.transaction(latest => {
            const checkedTime = now();
            const current = authenticate(latest, request, checkedTime);
            const liveDevice = latest.devices[current.session.deviceId];
            if (!liveDevice || liveDevice.status !== 'active') fail('DEVICE_REVOKED', '此设备授权已撤销。', 403);
            if (!membership(current.user, checkedTime).active) fail('MEMBERSHIP_EXPIRED', '会员授权已失效。', 403);
            const changed = checkedTime - Date.parse(liveDevice.lastCheckedAt) >= config.deviceCheckWriteMs;
            if (changed) liveDevice.lastCheckedAt = iso(checkedTime);
            return { changed, value: { authorized: true, feature, account: account(latest, current.user, current.session, checkedTime) } };
          });
        }
      }
      return { authorized: true, feature, account: account(state, user, session, time) };
    }
    if (request.action === 'admin-users') {
      const query = String(request.input.query || '').trim().toLowerCase();
      const users = Object.values(state.users).filter(item => !query || item.email.includes(query) || item.id.toLowerCase().includes(query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { users: users.slice(0, 1000).map(item => userView(state, item, time)), total: users.length };
    }
    if (request.action === 'admin-user') {
      const target = requireUser(state, request.input.userId);
      const knownKeys = new Set(Object.values(state.devices).filter(d => d.userId === target.id).map(d => d.keyFingerprint));
      const pendingDevices = Object.values(state.sessions).filter(s => s.userId === target.id && s.client === 'desktop' && !s.revokedAt && s.pendingDevice && !knownKeys.has(s.pendingDevice.keyFingerprint)).map(s => ({ sessionId: s.id, name: s.pendingDevice.name, platform: s.pendingDevice.platform, createdAt: s.createdAt, status: s.deviceStatus })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { user: userView(state, target, time), pendingDevices, history: state.audit.filter(entry => entry.targetId === target.id).reverse().slice(0, 1000) };
    }
    if (request.action === 'admin-codes') {
      const query = String(request.input.query || '').trim().toLowerCase();
      const status = String(request.input.status || '');
      const codes = Object.values(state.codes).map(item => ({ ...publicCode(item), redeemedEmail: item.redeemedBy ? state.users[item.redeemedBy]?.email || null : null })).filter(item => {
        const derivedStatus = item.status === 'unused' && item.redeemBy && Date.parse(item.redeemBy) <= time ? 'expired' : item.status;
        return (!status || derivedStatus === status) && (!query || [item.id, item.redeemedBy, item.redeemedEmail].some(value => String(value || '').toLowerCase().includes(query)));
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { codes: codes.slice(0, 1000), total: codes.length };
    }
    if (request.action === 'admin-audit') return { audit: state.audit.slice(-1000).reverse(), total: state.audit.length };
    if (request.action === 'admin-status') return { github: { status: 'ok', checkedAt: iso(time) }, mail: { provider: mailer.provider || 'custom', configured: mailer.configured !== false, lastDelivery: state.mailStatus, ...(mailer.check ? await mailer.check() : {}) } };
    fail('UNKNOWN_ACTION', '未知操作。', 404);
  }

  async function mutateAction(request) {
    // Plaintext is returned only for the first successful generation and is never persisted.
    const generated = request.action === 'admin-generate-codes' ? Array.from({ length: Math.min(Math.max(Number(request.input.count) || 1, 1), 100) }, () => ({ id: randomUUID(), raw: `XHS-${randomBytes(20).toString('hex').toUpperCase()}` })) : [];
    return store.transaction(state => {
      const time = now();
      const { user, session } = authenticate(state, request, time, request.action.startsWith('admin-'));
      if (request.action === 'logout') { session.revokedAt = iso(time); return { value: { loggedOut: true } }; }
      if (request.action === 'redeem') {
        if (session.client !== 'desktop') fail('DESKTOP_REQUIRED', '请在桌面客户端兑换。', 403);
        const requestId = requestIdValue(request.input.requestId);
        const raw = String(request.input.code || '').trim().toUpperCase();
        if (!/^XHS-[A-F0-9]{40}$/.test(raw)) fail('ACTIVATION_INVALID', '激活码无效。');
        const codeHash = hash('activation', raw);
        const code = Object.values(state.codes).find(item => equalDigest(item.digest, codeHash));
        if (!code) fail('ACTIVATION_INVALID', '激活码无效。');
        if (code.status === 'used') {
          if (code.redeemedBy === user.id && code.requestId === requestId) return { changed: false, value: { account: account(state, user, session, time), redeemed: true, replayed: true, codeId: code.id } };
          fail('ACTIVATION_USED', '激活码已使用，不能重复兑换。', 409);
        }
        if (code.status === 'void') fail('ACTIVATION_VOID', '此激活码已作废。');
        if (code.redeemBy && Date.parse(code.redeemBy) <= time) fail('ACTIVATION_EXPIRED', '激活码已超过兑换截止时间。');
        if (user.membership.type === 'permanent' && code.type === 'duration') fail('ALREADY_PERMANENT', '您已是永久会员，此时长码未消耗。', 409);
        const before = clone(user.membership);
        if (code.type === 'permanent') user.membership = { type: 'permanent', startsAt: iso(time), expiresAt: null };
        else {
          const base = Math.max(time, Date.parse(user.membership.expiresAt) || 0);
          user.membership = { type: 'duration', startsAt: membership(user, time).active ? user.membership.startsAt : iso(time), expiresAt: iso(base + code.days * DAY) };
        }
        code.status = 'used'; code.redeemedBy = user.id; code.redeemedAt = iso(time); code.requestId = requestId;
        state.audit.push({ id: randomUUID(), action: 'redeem', actorId: user.id, actorEmail: user.email, targetId: user.id, at: iso(time), reason: `兑换激活码 ${code.id}`, before, after: clone(user.membership) });
        return { value: { account: account(state, user, session, time), redeemed: true, codeId: code.id, replayed: false } };
      }
      if (request.action === 'admin-membership') return operation(state, user, request, () => {
        const reason = reasonValue(request.input.reason);
        const target = requireUser(state, request.input.userId);
        const before = clone(target.membership);
        const op = request.input.operation;
        if (op === 'permanent') target.membership = { type: 'permanent', startsAt: iso(time), expiresAt: null };
        else if (op === 'cancel') target.membership = noMembership();
        else if (op === 'until') target.membership = { type: 'duration', startsAt: membership(target, time).active && target.membership.type === 'duration' ? target.membership.startsAt : iso(time), expiresAt: futureDate(request.input.expiresAt, time) };
        else if (op === 'days') {
          if (target.membership.type === 'permanent') fail('ALREADY_PERMANENT', '永久会员无需续期；如需改为限时会员，请指定到期时间。');
          target.membership = { type: 'duration', startsAt: membership(target, time).active ? target.membership.startsAt : iso(time), expiresAt: iso(Math.max(time, Date.parse(target.membership.expiresAt) || 0) + daysValue(request.input.days) * DAY) };
        } else if (op === 'adjust') {
          if (target.membership.type !== 'duration') fail('DURATION_REQUIRED', '仅有效期会员可以增减天数。');
          target.membership.expiresAt = iso(Date.parse(target.membership.expiresAt) + daysValue(request.input.days, true) * DAY);
        } else fail('INVALID_OPERATION', '会员操作类型无效。');
        audit(state, user, request.action, target.id, reason, before, target.membership, time);
        return { user: userView(state, target, time) };
      });
      if (request.action === 'admin-unbind') return operation(state, user, request, () => {
        const reason = reasonValue(request.input.reason);
        const target = requireUser(state, request.input.userId);
        const device = owns(state.devices, request.input.deviceId);
        if (!device || device.userId !== target.id) fail('DEVICE_NOT_FOUND', '未找到该设备。', 404);
        if (device.status !== 'active') fail('DEVICE_ALREADY_REVOKED', '该设备已解绑。', 409);
        const before = { id: device.id, status: device.status, revokedAt: device.revokedAt };
        device.status = 'revoked'; device.revokedAt = iso(time);
        // Identity remains signed in. The tombstone permanently blocks this device identity.
        audit(state, user, request.action, target.id, reason, before, { id: device.id, status: device.status, revokedAt: device.revokedAt }, time);
        return { user: userView(state, target, time) };
      });
      if (request.action === 'admin-restore-device') return operation(state, user, request, () => {
        const reason = reasonValue(request.input.reason);
        const target = requireUser(state, request.input.userId);
        const pendingSession = Object.values(state.sessions).find(s => s.id === request.input.sessionId && s.userId === target.id && s.client === 'desktop' && !s.revokedAt);
        if (!pendingSession?.pendingDevice) fail('PENDING_DEVICE_NOT_FOUND', '未找到待授权的新密钥设备，请让用户重新进行邮箱验证登录。', 404);
        const pending = pendingSession.pendingDevice;
        const userDevices = Object.values(state.devices).filter(d => d.userId === target.id);
        if (userDevices.some(d => d.keyFingerprint === pending.keyFingerprint)) fail('DEVICE_KEY_ALREADY_REGISTERED', '此设备密钥已经绑定或已撤销，不能通过恢复操作再次使用。', 409);
        if (userDevices.filter(d => d.status === 'active').length >= config.deviceLimit) fail('DEVICE_LIMIT', '该账号设备名额已满，请先确认并解绑旧设备。', 409);
        const before = { sessionId: pendingSession.id, deviceId: pendingSession.deviceId, status: pendingSession.deviceStatus };
        const id = randomUUID();
        state.devices[id] = { id, userId: target.id, ...clone(pending), status: 'active', boundAt: iso(time), lastCheckedAt: iso(time), revokedAt: null, restoredBy: user.id };
        pendingSession.deviceId = id;
        pendingSession.deviceStatus = 'authorized';
        delete pendingSession.pendingDevice;
        audit(state, user, request.action, target.id, reason, before, { sessionId: pendingSession.id, deviceId: id, status: 'authorized', keyFingerprint: pending.keyFingerprint }, time);
        return { user: userView(state, target, time) };
      });
      if (request.action === 'admin-generate-codes') return operation(state, user, request, () => {
        const reason = reasonValue(request.input.reason);
        const count = request.input.count === undefined ? 1 : Number(request.input.count);
        if (!Number.isSafeInteger(count) || count < 1 || count > 100) fail('INVALID_COUNT', '每次可生成 1 至 100 个激活码。');
        const type = request.input.type;
        if (!['permanent', 'duration'].includes(type)) fail('INVALID_CODE_TYPE', '激活码类型无效。');
        const days = type === 'duration' ? daysValue(request.input.days) : null;
        const redeemBy = request.input.redeemBy ? futureDate(request.input.redeemBy, time) : null;
        const codes = generated.map(({ id, raw }) => {
          const code = { id, digest: hash('activation', raw), type, days, redeemBy, createdAt: iso(time), createdBy: user.id, status: 'unused', redeemedBy: null, redeemedAt: null };
          state.codes[id] = code;
          return { ...publicCode(code), code: raw };
        });
        const metadata = codes.map(({ code: ignored, ...item }) => item);
        audit(state, user, request.action, null, reason, null, { count, type, days, redeemBy, codeIds: codes.map(c => c.id) }, time);
        return { response: { codes, replayed: false }, persisted: { codes: metadata, replayed: true, message: '本次生成已保存。原码只展示一次，无法重新读取；若未保存，请作废后重新生成。' } };
      });
      if (request.action === 'admin-void-code') return operation(state, user, request, () => {
        const reason = reasonValue(request.input.reason);
        const code = owns(state.codes, request.input.codeId);
        if (!code) fail('ACTIVATION_INVALID', '激活码不存在。', 404);
        if (code.status !== 'unused') fail('ACTIVATION_NOT_UNUSED', '只有尚未使用的激活码可以作废。', 409);
        const before = publicCode(code);
        code.status = 'void'; code.voidedAt = iso(time);
        audit(state, user, request.action, code.id, reason, before, publicCode(code), time);
        return { code: publicCode(code) };
      });
      fail('UNKNOWN_ACTION', '未知操作。', 404);
    });
  }

  const feedbackService = createFeedbackService({ store, now, authenticate, hash, operation, audit });
  return {
    async execute({ action, input = {}, token = '', proof, ip = '', client }) {
      if (typeof action !== 'string' || action.length > 80 || !input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', '请求格式无效。');
      const request = { action, input, token, proof, ip, client };
      let result;
      if (action.startsWith('feedback-') || action.startsWith('admin-feedback')) result = await feedbackService.execute(request);
      else if (action === 'send-code') result = await sendCode(request);
      else if (action === 'verify-code') result = await verifyCode(request);
      else if (['logout', 'redeem', 'admin-membership', 'admin-unbind', 'admin-restore-device', 'admin-generate-codes', 'admin-void-code'].includes(action)) result = await mutateAction(request);
      else result = await readAction(request);
      return { ...result, serverTime: iso(now()) };
    },
  };
}
