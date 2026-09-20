import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { GithubStateStore, emptyState } from '../server/auth/store.js';
import { createAccountService } from '../server/auth/service.js';
import { createMailer } from '../server/auth/mailer.js';
import { readConfig } from '../server/auth/config.js';

const DAY = 86_400_000;
const device = (label = randomUUID()) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, input: { publicKey: publicKey.export({ format: 'pem', type: 'spki' }), stableIdHash: createHash('sha256').update(label).digest('hex'), name: `Test ${label}`, platform: 'darwin' } };
};

/** Shared fake GitHub Contents HTTP service, independent real GithubStateStore instances. */
function fixture(overrides = {}) {
  let state = emptyState(), version = 1, clock = Date.parse('2026-09-20T00:00:00Z');
  let writes = 0, conflicts = 0;
  const faults = [], deliveries = [];
  const config = { ...readConfig({ AUTH_SECRET_PEPPER: 'unit-test-pepper-only-'.repeat(3), AUTH_ADMIN_EMAILS: 'admin@example.test' }), ...overrides };
  const fetchImpl = async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const body = JSON.parse(options.body);
    if (body.sha !== String(version)) { conflicts += 1; return Response.json({}, { status: 409 }); }
    const fault = faults.shift();
    if (fault?.throw) throw Error('unavailable');
    if (fault?.status) return Response.json({}, { status: fault.status });
    state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); version += 1; writes += 1;
    if (fault?.commitThenThrow) throw Error('committed response lost');
    return Response.json({ content: { sha: String(version) } });
  };
  const mailer = { provider: 'fake', configured: true, failNext: false, async send(delivery) { deliveries.push(delivery); if (this.failNext) { this.failNext = false; throw Error('mail offline'); } } };
  const instance = () => createAccountService({ config, mailer, now: () => clock, store: new GithubStateStore({ owner: 'fake', repo: 'private', token: 'fake', fetchImpl, delay: async () => {} }) });
  const execute = (service, action, input = {}, session, dev) => {
    const token = session?.token || '';
    let proof;
    if (dev) {
      const timestamp = clock, nonce = randomUUID();
      proof = { timestamp, nonce, signature: sign(null, Buffer.from(`${action}\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${token}`), dev.privateKey).toString('base64') };
    }
    return service.execute({ action, input, token, proof, ip: '192.0.2.100' });
  };
  const issue = async (email, client = 'desktop', service = instance()) => {
    await execute(service, 'send-code', { email, client });
    return deliveries.findLast(d => d.email === email).code;
  };
  const login = async (email = 'user@example.test', dev = device(), client = 'desktop') => {
    const service = instance(), code = await issue(email, client, service);
    const input = { email, code, client, ...(client === 'desktop' ? { device: dev.input } : {}) };
    const result = await execute(service, 'verify-code', input, null, client === 'desktop' ? dev : null);
    return { ...result, dev, service };
  };
  const admin = () => login('admin@example.test', null, 'admin');
  const adminCall = (session, action, input = {}, service = instance()) => execute(service, action, { ...input, ...(['admin-membership', 'admin-unbind', 'admin-restore-device', 'admin-generate-codes', 'admin-void-code'].includes(action) ? { reason: input.reason || '测试操作原因', requestId: input.requestId || randomUUID() } : {}) }, session);
  const grant = (adminSession, userSession, days = 10) => adminCall(adminSession, 'admin-membership', { userId: userSession.account.user.id, operation: 'days', days });
  const generate = async (adminSession, input = {}) => (await adminCall(adminSession, 'admin-generate-codes', { type: 'duration', days: 10, count: 1, ...input })).codes;
  return { instance, execute, login, issue, admin, adminCall, grant, generate, deliveries, mailer, config, faults, advance: ms => { clock += ms; }, get clock() { return clock; }, get state() { return state; }, get writes() { return writes; }, get conflicts() { return conflicts; } };
}

test('first email verification creates user, repeated login keeps user and device identity', async () => {
  const f = fixture(), d = device('stable-mac');
  const first = await f.login('user@example.test', d);
  assert.equal(first.account.membership.type, 'none');
  assert.equal(first.account.device.status, 'authorized');
  f.advance(60_001);
  const second = await f.login('user@example.test', d);
  assert.equal(second.account.user.id, first.account.user.id);
  assert.equal(second.account.device.id, first.account.device.id);
  assert.equal(Object.keys(f.state.users).length, 1);
  assert.equal(Object.keys(f.state.devices).length, 1);
  const saved = JSON.stringify(f.state);
  assert.ok(!saved.includes(first.token));
  assert.ok(!saved.includes(d.input.stableIdHash));
  assert.ok(!saved.includes(d.privateKey.export({ format: 'pem', type: 'pkcs8' })));
});

test('OTP wrong attempts persist, lock out after five, expiry and repeated consumption are rejected', async () => {
  const f = fixture(), d = device(), service = f.instance();
  const code = await f.issue('wrong@example.test');
  const input = { email: 'wrong@example.test', client: 'desktop', device: d.input, code: code === '000000' ? '111111' : '000000' };
  for (let i = 0; i < 5; i += 1) await assert.rejects(f.execute(service, 'verify-code', input, null, d), { code: i === 4 ? 'CODE_ATTEMPTS_EXCEEDED' : 'CODE_INVALID' });
  await assert.rejects(f.execute(service, 'verify-code', { ...input, code }, null, d), { code: 'CODE_ATTEMPTS_EXCEEDED' });
  assert.equal(Object.values(f.state.otps)[0].attempts, 5);
  const expired = await f.issue('expired@example.test');
  f.advance(300_000);
  await assert.rejects(f.execute(service, 'verify-code', { ...input, email: 'expired@example.test', code: expired }, null, d), { code: 'CODE_EXPIRED' });
  const once = await f.issue('once@example.test');
  const good = { ...input, email: 'once@example.test', code: once };
  await f.execute(service, 'verify-code', good, null, d);
  await assert.rejects(f.execute(service, 'verify-code', good, null, d), { code: 'CODE_USED' });
});

test('two independent backend instances cannot consume the same OTP twice', async () => {
  const f = fixture(), d1 = device(), d2 = device();
  const code = await f.issue('race@example.test');
  const results = await Promise.allSettled([d1, d2].map(d => f.execute(f.instance(), 'verify-code', { email: 'race@example.test', client: 'desktop', code, device: d.input }, null, d)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CODE_USED');
  assert.equal(Object.keys(f.state.sessions).length, 1);
  assert.equal(Object.keys(f.state.devices).length, 1);
  assert.ok(f.conflicts > 0);
});

test('OTP rate limits are persisted across instances and no email is sent beyond the limit', async () => {
  const f = fixture({ otpEmailHourlyLimit: 2, otpIpHourlyLimit: 20 });
  await f.issue('limited@example.test');
  await assert.rejects(f.issue('limited@example.test'), { code: 'SEND_TOO_SOON' });
  f.advance(60_001); await f.issue('limited@example.test');
  f.advance(60_001); await assert.rejects(f.issue('limited@example.test'), { code: 'SEND_LIMIT' });
  assert.equal(f.deliveries.length, 2);
  const g = fixture({ otpIpHourlyLimit: 1 });
  await g.issue('one@example.test');
  await assert.rejects(g.issue('two@example.test'), { code: 'SEND_LIMIT' });
  const h = fixture({ otpGlobalHourlyLimit: 1 });
  await h.issue('one@example.test');
  await assert.rejects(h.issue('two@example.test'), { code: 'SEND_LIMIT' });
});

test('mail failure does not advertise successful delivery and its OTP is unusable', async () => {
  const f = fixture(), d = device(); f.mailer.failNext = true;
  await assert.rejects(f.issue('mail@example.test'), { code: 'MAIL_SEND_FAILED' });
  assert.equal(f.state.mailStatus.status, 'failed');
  await assert.rejects(f.execute(f.instance(), 'verify-code', { email: 'mail@example.test', client: 'desktop', code: f.deliveries[0].code, device: d.input }, null, d), { code: 'CODE_NOT_READY' });
});

test('permanent identity session survives elapsed time and backend restart, membership expiry does not log out', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login();
  await f.grant(admin, user, 1);
  f.advance(366 * DAY);
  const result = await f.execute(f.instance(), 'me', {}, user, user.dev);
  assert.equal(result.account.user.id, user.account.user.id);
  assert.equal(result.account.membership.active, false);
  await assert.rejects(f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, user, user.dev), { code: 'MEMBERSHIP_EXPIRED' });
  await f.execute(f.instance(), 'logout', {}, user, user.dev);
  await assert.rejects(f.execute(f.instance(), 'me', {}, user, user.dev), { code: 'SESSION_REVOKED' });
  assert.equal(Object.values(f.state.devices).filter(d => d.status === 'active').length, 1);
});

test('admin grant, renew, shorten, exact expiry, permanent, cancel are audited and server-timed', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login(), userId = user.account.user.id;
  let result = await f.grant(admin, user, 10);
  assert.equal(Date.parse(result.user.membership.expiresAt), f.clock + 10 * DAY);
  result = await f.grant(admin, user, 5);
  assert.equal(Date.parse(result.user.membership.expiresAt), f.clock + 15 * DAY);
  result = await f.adminCall(admin, 'admin-membership', { userId, operation: 'adjust', days: -3 });
  assert.equal(Date.parse(result.user.membership.expiresAt), f.clock + 12 * DAY);
  const expiresAt = new Date(f.clock + 2 * DAY).toISOString();
  result = await f.adminCall(admin, 'admin-membership', { userId, operation: 'until', expiresAt });
  assert.equal(result.user.membership.expiresAt, expiresAt);
  result = await f.adminCall(admin, 'admin-membership', { userId, operation: 'permanent' });
  assert.equal(result.user.membership.type, 'permanent'); assert.equal(result.user.membership.expiresAt, null);
  result = await f.adminCall(admin, 'admin-membership', { userId, operation: 'cancel' });
  assert.equal(result.user.membership.active, false);
  const history = (await f.adminCall(admin, 'admin-user', { userId })).history;
  assert.equal(history.length, 6);
  assert.ok(history.every(entry => entry.actorId === admin.account.user.id && entry.reason && entry.before && entry.after && entry.at));
});

test('ordinary users cannot gain roles through input, create admin login, or call admin routes', async () => {
  const f = fixture(), user = await f.login();
  await assert.rejects(f.issue('user@example.test', 'admin'), { code: 'FORBIDDEN' });
  for (const action of ['admin-users', 'admin-membership', 'admin-unbind', 'admin-restore-device', 'admin-generate-codes', 'admin-void-code', 'admin-status', 'admin-audit']) {
    await assert.rejects(f.execute(f.instance(), action, { role: 'admin', userId: user.account.user.id, operation: 'permanent' }, user, user.dev), { code: 'FORBIDDEN' });
  }
  const admin = await f.admin();
  f.config.adminEmails = [];
  await assert.rejects(f.adminCall(admin, 'admin-users'), { code: 'FORBIDDEN' });
});

test('two users race the same activation code across backend instances: one atomic winner', async () => {
  const f = fixture(), admin = await f.admin(), first = await f.login('one@example.test'), second = await f.login('two@example.test');
  const [code] = await f.generate(admin);
  const results = await Promise.allSettled([first, second].map(user => f.execute(f.instance(), 'redeem', { code: code.code, requestId: randomUUID() }, user, user.dev)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'ACTIVATION_USED');
  const used = f.state.codes[code.id];
  assert.equal(used.status, 'used');
  assert.equal(f.state.users[used.redeemedBy].membership.type, 'duration');
  const loser = [first, second].find(u => u.account.user.id !== used.redeemedBy);
  assert.equal(f.state.users[loser.account.user.id].membership.type, 'none');
  assert.ok(f.conflicts > 0);
  assert.ok(!JSON.stringify(f.state).includes(code.code));
});

test('redeem retry is idempotent, extends current expiry, and duplicate new requests cannot consume twice', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login();
  await f.grant(admin, user, 5);
  const [code] = await f.generate(admin, { days: 10 });
  const input = { code: code.code, requestId: randomUUID() };
  const first = await f.execute(f.instance(), 'redeem', input, user, user.dev);
  assert.equal(Date.parse(first.account.membership.expiresAt), f.clock + 15 * DAY);
  const second = await f.execute(f.instance(), 'redeem', input, user, user.dev);
  assert.equal(second.replayed, true);
  assert.equal(second.account.membership.expiresAt, first.account.membership.expiresAt);
  await assert.rejects(f.execute(f.instance(), 'redeem', { ...input, requestId: randomUUID() }, user, user.dev), { code: 'ACTIVATION_USED' });
});

test('committed redeem whose response is lost recovers without duplicate membership time', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login(), [code] = await f.generate(admin);
  const input = { code: code.code, requestId: randomUUID() };
  f.faults.push({ commitThenThrow: true });
  await assert.rejects(f.execute(f.instance(), 'redeem', input, user, user.dev), { code: 'STORAGE_WRITE_UNCERTAIN' });
  const recovery = await f.execute(f.instance(), 'redeem', input, user, user.dev);
  assert.equal(recovery.replayed, true);
  assert.equal(Date.parse(recovery.account.membership.expiresAt), f.clock + 10 * DAY);
});

test('activation expiry, voiding, permanent preservation and used-code immutability', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login();
  const [expired] = await f.generate(admin, { redeemBy: new Date(f.clock + 1000).toISOString() });
  f.advance(1001);
  await assert.rejects(f.execute(f.instance(), 'redeem', { code: expired.code, requestId: randomUUID() }, user, user.dev), { code: 'ACTIVATION_EXPIRED' });
  const [voided] = await f.generate(admin);
  await f.adminCall(admin, 'admin-void-code', { codeId: voided.id });
  await assert.rejects(f.execute(f.instance(), 'redeem', { code: voided.code, requestId: randomUUID() }, user, user.dev), { code: 'ACTIVATION_VOID' });
  const [permanent] = await f.generate(admin, { type: 'permanent' });
  await f.execute(f.instance(), 'redeem', { code: permanent.code, requestId: randomUUID() }, user, user.dev);
  await assert.rejects(f.adminCall(admin, 'admin-void-code', { codeId: permanent.id }), { code: 'ACTIVATION_NOT_UNUSED' });
  const [duration] = await f.generate(admin);
  await assert.rejects(f.execute(f.instance(), 'redeem', { code: duration.code, requestId: randomUUID() }, user, user.dev), { code: 'ALREADY_PERMANENT' });
  assert.equal(f.state.codes[duration.id].status, 'unused');
  assert.equal(f.state.users[user.account.user.id].membership.type, 'permanent');
});

test('new devices cannot claim an occupied slot, and logout does not release the slot', async () => {
  const f = fixture(), admin = await f.admin(), first = await f.login('device@example.test', device('original'));
  await f.grant(admin, first);
  f.advance(60_001);
  const second = await f.login('device@example.test', device('new'));
  assert.equal(second.account.device.status, 'device_limit');
  assert.equal(second.account.membership.active, true);
  await assert.rejects(f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, second, second.dev), { code: 'DEVICE_LIMIT' });
  await f.execute(f.instance(), 'logout', {}, first, first.dev);
  f.advance(60_001);
  const third = await f.login('device@example.test', device('reinstall-new-key'));
  assert.equal(third.account.device.status, 'device_limit');
  assert.equal(Object.values(f.state.devices).filter(d => d.status === 'active').length, 1);
});

test('admin unbind preserves identity but old online device, new key on old stable id and old key on altered id cannot reclaim', async () => {
  const f = fixture(), admin = await f.admin(), old = await f.login('switch@example.test', device('old'));
  await f.grant(admin, old);
  await f.adminCall(admin, 'admin-unbind', { userId: old.account.user.id, deviceId: old.account.device.id });
  assert.equal((await f.execute(f.instance(), 'me', {}, old, old.dev)).account.device.status, 'revoked');
  await assert.rejects(f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, old, old.dev), { code: 'DEVICE_REVOKED' });
  f.advance(60_001);
  const oldLogin = await f.login('switch@example.test', old.dev);
  assert.equal(oldLogin.account.device.status, 'revoked');
  f.advance(60_001);
  const keyRotated = device('old');
  assert.equal((await f.login('switch@example.test', keyRotated)).account.device.status, 'revoked');
  f.advance(60_001);
  const identityChanged = { ...old.dev, input: { ...old.dev.input, stableIdHash: device('changed').input.stableIdHash } };
  assert.equal((await f.login('switch@example.test', identityChanged)).account.device.status, 'revoked');
  f.advance(60_001);
  const replacement = await f.login('switch@example.test', device('replacement'));
  assert.equal(replacement.account.device.status, 'authorized');
  assert.equal(Object.values(f.state.devices).filter(d => d.status === 'active').length, 1);
});

test('simultaneous OTP device claim commits only one slot and keeps account consistent', async () => {
  const f = fixture(), admin = await f.admin(), first = await f.login('slot@example.test', device('first'));
  await f.adminCall(admin, 'admin-unbind', { userId: first.account.user.id, deviceId: first.account.device.id });
  f.advance(60_001);
  const code = await f.issue('slot@example.test');
  const devices = [device('replacement-a'), device('replacement-b')];
  const results = await Promise.allSettled(devices.map(d => f.execute(f.instance(), 'verify-code', { email: 'slot@example.test', code, client: 'desktop', device: d.input }, null, d)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(Object.values(f.state.devices).filter(d => d.status === 'active').length, 1);
  assert.equal(Object.keys(f.state.users).length, 2);
  assert.ok(f.conflicts > 0);
});

test('concurrent admin renewals on independent instances do not lose updates and replay is durable', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login(), userId = user.account.user.id;
  const inputs = [2, 3, 5].map(days => ({ userId, operation: 'days', days, reason: '并发续期测试', requestId: randomUUID() }));
  await Promise.all(inputs.map(input => f.adminCall(admin, 'admin-membership', input)));
  assert.equal(Date.parse(f.state.users[userId].membership.expiresAt), f.clock + 10 * DAY);
  assert.ok(f.conflicts >= 2);
  const retry = await f.adminCall(admin, 'admin-membership', inputs[0]);
  assert.equal(retry.replayed, true);
  assert.equal(Date.parse(f.state.users[userId].membership.expiresAt), f.clock + 10 * DAY);
  await assert.rejects(f.adminCall(admin, 'admin-membership', { ...inputs[0], days: 20 }), { code: 'REQUEST_ID_REUSED' });
});

test('lost admin response can be retried safely and generated codes never redisplay plaintext', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login();
  const input = { userId: user.account.user.id, operation: 'days', days: 7, reason: '网络恢复测试', requestId: randomUUID() };
  f.faults.push({ commitThenThrow: true });
  await assert.rejects(f.adminCall(admin, 'admin-membership', input), { code: 'STORAGE_WRITE_UNCERTAIN' });
  assert.equal((await f.adminCall(admin, 'admin-membership', input)).replayed, true);
  assert.equal(Date.parse(f.state.users[user.account.user.id].membership.expiresAt), f.clock + 7 * DAY);
  const generate = { type: 'permanent', count: 3, requestId: randomUUID() };
  const first = await f.adminCall(admin, 'admin-generate-codes', generate);
  const replay = await f.adminCall(admin, 'admin-generate-codes', generate);
  assert.equal(first.codes.length, 3);
  assert.equal(new Set(first.codes.map(c => c.code)).size, 3);
  assert.ok(replay.codes.every(c => !c.code && !c.digest));
  assert.equal(replay.replayed, true);
  assert.ok(first.codes.every(c => !JSON.stringify(f.state).includes(c.code)));
});

test('high-frequency authorization reads cause no Git writes and daily last-check update revalidates', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login();
  await f.grant(admin, user, 10);
  const writes = f.writes;
  for (let i = 0; i < 5; i += 1) assert.equal((await f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, user, user.dev)).authorized, true);
  assert.equal(f.writes, writes);
  f.advance(DAY);
  await f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, user, user.dev);
  assert.equal(f.writes, writes + 1);
  await f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, user, user.dev);
  assert.equal(f.writes, writes + 1);
});

test('forged or stale device proof cannot use a permanent session and admin sessions cannot authorize desktop', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login();
  await assert.rejects(f.execute(f.instance(), 'me', {}, user, device('attacker')), { code: 'INVALID_DEVICE_PROOF' });
  const input = {}, timestamp = f.clock - 121_000, nonce = randomUUID();
  const proof = { timestamp, nonce, signature: sign(null, Buffer.from(`me\n${timestamp}\n${nonce}\n{}\n${user.token}`), user.dev.privateKey).toString('base64') };
  await assert.rejects(f.instance().execute({ action: 'me', input, token: user.token, proof }), { code: 'PROOF_EXPIRED' });
  await assert.rejects(f.adminCall(admin, 'authorize', { feature: 'profile-download' }), { code: 'DESKTOP_REQUIRED' });
});

test('storage write failures cannot produce false redemption or administrator success', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login(), [code] = await f.generate(admin);
  const before = JSON.stringify(f.state);
  f.faults.push({ status: 429 });
  await assert.rejects(f.execute(f.instance(), 'redeem', { code: code.code, requestId: randomUUID() }, user, user.dev), { code: 'STORAGE_RATE_LIMITED' });
  assert.equal(JSON.stringify(f.state), before);
  f.faults.push({ throw: true });
  await assert.rejects(f.grant(admin, user), { code: 'STORAGE_WRITE_UNCERTAIN' });
  assert.equal(JSON.stringify(f.state), before);
});

test('mailer adapters enforce HTTPS, do not expose provider failures, and identify SMTP configuration', async () => {
  const deliveries = [];
  const resend = createMailer({ AUTH_MAIL_PROVIDER: 'resend', AUTH_MAIL_API_KEY: 'fake', AUTH_MAIL_FROM: 'test@example.test' }, async (url, options) => { deliveries.push({ url, options }); return Response.json({ id: 'fake' }); });
  await resend.send({ email: 'recipient@example.test', code: '123456', expiresInMinutes: 5, deliveryId: 'test-mail' });
  assert.equal(deliveries[0].url, 'https://api.resend.com/emails');
  assert.equal(deliveries[0].options.headers['Idempotency-Key'], 'test-mail');
  const insecure = createMailer({ AUTH_MAIL_PROVIDER: 'webhook', AUTH_MAIL_WEBHOOK_URL: 'http://example.test', AUTH_MAIL_WEBHOOK_SECRET: 'fake' });
  await assert.rejects(insecure.send({}), { code: 'MAIL_NOT_CONFIGURED' });
  const failure = createMailer({ AUTH_MAIL_PROVIDER: 'webhook', AUTH_MAIL_WEBHOOK_URL: 'https://example.test', AUTH_MAIL_WEBHOOK_SECRET: 'fake' }, async () => Response.json({ secret: 'never forward' }, { status: 403 }));
  await assert.rejects(failure.send({}), error => error.code === 'MAIL_SEND_FAILED' && !error.message.includes('never forward'));
  const smtp = createMailer({ AUTH_MAIL_PROVIDER: 'smtp', AUTH_SMTP_HOST: 'smtp.gmail.com', AUTH_SMTP_USER: 'example', AUTH_SMTP_PASS: 'fake', AUTH_MAIL_FROM: 'example@example.test' });
  assert.equal(smtp.configured, true); assert.equal(smtp.provider, 'smtp');
});

test('SMTP verifies the current service, uses authenticated TLS, and closes each connection', async () => {
  let captured, sent, closed = 0, reject = false;
  const smtp = createMailer({ AUTH_MAIL_PROVIDER: 'smtp', AUTH_SMTP_HOST: 'smtp.example.test', AUTH_SMTP_PORT: '465', AUTH_SMTP_USER: 'fake-user', AUTH_SMTP_PASS: 'fake-test-password', AUTH_MAIL_FROM: 'test@example.test' }, undefined, {
    createSmtpTransport(options) {
      captured = options;
      return { async verify() { if (reject) throw Error('sensitive provider error'); }, async sendMail(message) { sent = message; if (reject) throw Error('sensitive provider error'); return { accepted: [message.to], rejected: [] }; }, close() { closed += 1; } };
    },
  });
  assert.equal((await smtp.check()).status, 'ok');
  await smtp.send({ email: 'recipient@example.test', code: '987654', expiresInMinutes: 5, deliveryId: 'delivery-fixture' });
  assert.equal(captured.secure, true); assert.equal(captured.requireTLS, true); assert.equal(captured.tls.rejectUnauthorized, true); assert.equal(captured.debug, false);
  assert.deepEqual(sent.to, { address: 'recipient@example.test' }); assert.match(sent.text, /987654/); assert.equal(closed, 2);
  reject = true;
  const check = await smtp.check();
  assert.equal(check.status, 'unavailable'); assert.ok(!check.message.includes('sensitive'));
  await assert.rejects(smtp.send({ email: 'recipient@example.test', code: '123456' }), { code: 'MAIL_SEND_FAILED' });
  assert.equal(closed, 4);
});

test('OTP replacement archives prior verification records without plaintext codes', async () => {
  const f = fixture(), user = await f.login();
  const previous = Object.values(f.state.otps)[0];
  assert.deepEqual(previous.checks.map(check => check.result), ['consumed']);
  f.advance(60_001);
  await f.issue('user@example.test');
  assert.equal(f.state.otpHistory.length, 1);
  assert.equal(f.state.otpHistory[0].id, previous.id);
  assert.equal(f.state.otpHistory[0].status, 'consumed');
  assert.ok(!JSON.stringify(f.state).includes(user.token));
});

test('new device that signed in before unbind cannot silently claim a freed slot on refresh', async () => {
  const f = fixture(), admin = await f.admin(), original = await f.login();
  await f.grant(admin, original);
  f.advance(60_001);
  const blocked = await f.login('user@example.test', device('blocked-before-unbind'));
  assert.equal(blocked.account.device.status, 'device_limit');
  await f.adminCall(admin, 'admin-unbind', { userId: original.account.user.id, deviceId: original.account.device.id });
  const [oldRefresh, newRefresh] = await Promise.all([
    f.execute(f.instance(), 'me', {}, original, original.dev),
    f.execute(f.instance(), 'me', {}, blocked, blocked.dev),
  ]);
  assert.equal(oldRefresh.account.device.status, 'revoked');
  assert.equal(newRefresh.account.device.status, 'device_limit');
  assert.equal(Object.values(f.state.devices).filter(d => d.status === 'active').length, 0);
  f.advance(60_001);
  const explicit = await f.login('user@example.test', blocked.dev);
  assert.equal(explicit.account.device.status, 'authorized');
});

test('configured device capacity is applied atomically and activation never bypasses capacity', async () => {
  const f = fixture({ deviceLimit: 2 }), admin = await f.admin(), original = await f.login();
  f.advance(60_001);
  const second = await f.login('user@example.test');
  assert.equal(second.account.device.status, 'authorized');
  f.advance(60_001);
  const third = await f.login('user@example.test');
  assert.equal(third.account.device.status, 'device_limit');
  const [code] = await f.generate(admin, { type: 'permanent' });
  const redeemed = await f.execute(f.instance(), 'redeem', { code: code.code, requestId: randomUUID() }, third, third.dev);
  assert.equal(redeemed.account.membership.active, true);
  assert.equal(redeemed.account.device.status, 'device_limit');
  await assert.rejects(f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, third, third.dev), { code: 'DEVICE_LIMIT' });
  assert.equal((await f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, original, original.dev)).authorized, true);
  assert.equal(Object.values(f.state.devices).filter(d => d.status === 'active').length, 2);
});

test('code query/filter uses server time and admin status reports a current mail check', async () => {
  const f = fixture(), admin = await f.admin(), user = await f.login();
  const [code] = await f.generate(admin);
  await f.execute(f.instance(), 'redeem', { code: code.code, requestId: randomUUID() }, user, user.dev);
  const filtered = await f.adminCall(admin, 'admin-codes', { query: user.account.user.email, status: 'used' });
  assert.equal(filtered.codes.length, 1);
  assert.equal(filtered.codes[0].redeemedEmail, user.account.user.email);
  const [expired] = await f.generate(admin, { redeemBy: new Date(f.clock + 1000).toISOString() });
  f.advance(1001);
  assert.equal((await f.adminCall(admin, 'admin-codes', { status: 'expired' })).codes[0].id, expired.id);
  f.mailer.check = async () => ({ status: 'unavailable', message: 'SMTP test unavailable' });
  const status = await f.adminCall(admin, 'admin-status');
  assert.equal(status.github.status, 'ok'); assert.equal(status.mail.status, 'unavailable');
});

test('recipient display syntax, lists, comments, controls and malformed addr-spec never reach storage or mail', async () => {
  const f = fixture(), initial = JSON.stringify(f.state), service = f.instance();
  const malformed = [
    'one<victim@example.com>', 'two<victim@example.com>', 'Name <victim@example.com>',
    'a@example.com,b@example.com', 'a@example.com; b@example.com', 'victim(comment)@example.com',
    '"victim"@example.com', "'victim'@example.com", 'a\\b@example.com', 'a@exa mple.com',
    'a\r\n@example.com', '\nvictim@example.com', 'victim@example.com\t', 'a\0@example.com',
    '.a@example.com', 'a.@example.com', 'a..b@example.com', 'a@@example.com',
    `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(64)}.com`, 'a@-example.com',
    'a@example-.com', 'a@example..com', 'a@example.com.', 'a@example', 'a@exa_mple.com',
    '名字@example.com', 'a@示例.com', ['a@example.com'], { address: 'a@example.com' },
  ];
  for (const email of malformed) {
    await assert.rejects(f.execute(service, 'send-code', { email, client: 'desktop' }), { code: 'INVALID_EMAIL' });
    await assert.rejects(f.execute(service, 'verify-code', { email, client: 'desktop', code: '123456' }), { code: 'INVALID_EMAIL' });
  }
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.writes, 0);
  assert.equal(JSON.stringify(f.state), initial);
});

test('bare email case and surrounding spaces canonicalize while plus aliases stay valid', async () => {
  const f = fixture();
  await f.execute(f.instance(), 'send-code', { email: '  User.Name+Course@Example.TEST  ', client: 'desktop' });
  assert.equal(f.deliveries[0].email, 'user.name+course@example.test');
  await assert.rejects(f.execute(f.instance(), 'send-code', { email: 'user.name+course@example.test', client: 'desktop' }), { code: 'SEND_TOO_SOON' });
  const d = device();
  const result = await f.execute(f.instance(), 'verify-code', { email: 'USER.NAME+COURSE@EXAMPLE.TEST', client: 'desktop', code: f.deliveries[0].code, device: d.input }, null, d);
  assert.equal(result.account.user.email, 'user.name+course@example.test');
});

test('Gmail dotted and plus aliases share the persisted mailbox send limit across instances', async () => {
  const f = fixture({ otpEmailHourlyLimit: 1 });
  await f.issue('victim.name+first@gmail.com');
  await assert.rejects(f.issue('victimname+second@gmail.com'), { code: 'SEND_LIMIT' });
  await assert.rejects(f.issue('v.i.c.t.i.m.n.a.m.e@googlemail.com'), { code: 'SEND_LIMIT' });
  assert.equal(f.deliveries.length, 1);
});

test('only targeted admin approval restores a lost key on the same hardware; old keys and sessions stay revoked', async () => {
  const f = fixture(), admin = await f.admin(), original = await f.login('recovery@example.test', device('same-hardware'));
  const userId = original.account.user.id;
  await f.grant(admin, original);
  const replacementKey = device('same-hardware');
  f.advance(60_001);
  const replacement = await f.login('recovery@example.test', replacementKey);
  assert.equal(replacement.account.device.status, 'device_limit');
  const firstPending = (await f.adminCall(admin, 'admin-user', { userId })).pendingDevices[0];
  assert.ok(firstPending.sessionId); assert.equal(firstPending.name, replacementKey.input.name);
  assert.equal(firstPending.publicKey, undefined); assert.equal(firstPending.stableHash, undefined);
  await assert.rejects(f.adminCall(admin, 'admin-restore-device', { userId, sessionId: firstPending.sessionId }), { code: 'DEVICE_LIMIT' });
  await f.adminCall(admin, 'admin-unbind', { userId, deviceId: original.account.device.id });
  f.advance(60_001);
  const unchosen = await f.login('recovery@example.test', replacementKey);
  assert.equal(unchosen.account.device.status, 'revoked', 'new key on revoked stable identity does not auto-claim a free slot');
  const pendingList = (await f.adminCall(admin, 'admin-user', { userId })).pendingDevices;
  const unchosenPending = pendingList.find(p => p.sessionId !== firstPending.sessionId);
  const input = { userId, sessionId: firstPending.sessionId, reason: '验证重装后的设备密钥丢失', requestId: randomUUID() };
  const restored = await f.adminCall(admin, 'admin-restore-device', input);
  const active = restored.user.devices.find(d => d.status === 'active');
  assert.ok(active); assert.notEqual(active.id, original.account.device.id);
  assert.equal((await f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, replacement, replacement.dev)).authorized, true);
  assert.equal((await f.execute(f.instance(), 'me', {}, original, original.dev)).account.device.status, 'revoked');
  assert.equal((await f.execute(f.instance(), 'me', {}, unchosen, unchosen.dev)).account.device.status, 'revoked', 'only the explicitly selected session was linked');
  await assert.rejects(f.execute(f.instance(), 'authorize', { feature: 'profile-download' }, original, original.dev), { code: 'DEVICE_REVOKED' });
  assert.equal((await f.adminCall(admin, 'admin-restore-device', input)).replayed, true);
  assert.equal(Object.values(f.state.devices).filter(d => d.userId === userId && d.status === 'active').length, 1);
  f.advance(60_001);
  assert.equal((await f.login('recovery@example.test', replacementKey)).account.device.status, 'authorized', 'exact admin-approved active key wins over the old stable tombstone');
  f.advance(60_001);
  assert.equal((await f.login('recovery@example.test', original.dev)).account.device.status, 'revoked', 'old key is never revived');
  await f.adminCall(admin, 'admin-unbind', { userId, deviceId: active.id });
  await assert.rejects(f.adminCall(admin, 'admin-restore-device', { userId, sessionId: unchosenPending.sessionId }), { code: 'DEVICE_KEY_ALREADY_REGISTERED' });
  const audit = f.state.audit.find(entry => entry.action === 'admin-restore-device');
  assert.equal(audit.actorId, admin.account.user.id); assert.equal(audit.reason, input.reason);
});

test('parallel administrator device restorations compete atomically for one freed slot', async () => {
  const f = fixture(), admin = await f.admin(), original = await f.login('restore-race@example.test', device('restore-machine'));
  const userId = original.account.user.id;
  f.advance(60_001); await f.login('restore-race@example.test', device('restore-machine'));
  f.advance(60_001); await f.login('restore-race@example.test', device('restore-machine'));
  const pending = (await f.adminCall(admin, 'admin-user', { userId })).pendingDevices;
  assert.equal(pending.length, 2);
  await f.adminCall(admin, 'admin-unbind', { userId, deviceId: original.account.device.id });
  const results = await Promise.allSettled(pending.map(p => f.adminCall(admin, 'admin-restore-device', { userId, sessionId: p.sessionId })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'DEVICE_LIMIT');
  assert.equal(Object.values(f.state.devices).filter(d => d.userId === userId && d.status === 'active').length, 1);
  assert.ok(f.conflicts > 0);
});

test('administrator cannot restore an unrelated or logged-out pending session and lost response is recoverable', async () => {
  const f = fixture(), admin = await f.admin(), original = await f.login('restore-auth@example.test', device('restore-auth'));
  const userId = original.account.user.id;
  f.advance(60_001);
  const pendingLogin = await f.login('restore-auth@example.test', device('restore-auth'));
  const pending = (await f.adminCall(admin, 'admin-user', { userId })).pendingDevices[0];
  await assert.rejects(f.adminCall(admin, 'admin-restore-device', { userId: admin.account.user.id, sessionId: pending.sessionId }), { code: 'PENDING_DEVICE_NOT_FOUND' });
  await f.execute(f.instance(), 'logout', {}, pendingLogin, pendingLogin.dev);
  await assert.rejects(f.adminCall(admin, 'admin-restore-device', { userId, sessionId: pending.sessionId }), { code: 'PENDING_DEVICE_NOT_FOUND' });
  f.advance(60_001); const replacement = await f.login('restore-auth@example.test', device('restore-auth'));
  const chosen = (await f.adminCall(admin, 'admin-user', { userId })).pendingDevices[0];
  await f.adminCall(admin, 'admin-unbind', { userId, deviceId: original.account.device.id });
  const input = { userId, sessionId: chosen.sessionId, reason: '网络异常恢复', requestId: randomUUID() };
  f.faults.push({ commitThenThrow: true });
  await assert.rejects(f.adminCall(admin, 'admin-restore-device', input), { code: 'STORAGE_WRITE_UNCERTAIN' });
  assert.equal((await f.adminCall(admin, 'admin-restore-device', input)).replayed, true);
  assert.equal((await f.execute(f.instance(), 'me', {}, replacement, replacement.dev)).account.device.status, 'authorized');
  assert.equal(Object.values(f.state.devices).filter(d => d.userId === userId && d.status === 'active').length, 1);
});
