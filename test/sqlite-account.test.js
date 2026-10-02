import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { SqliteStateStore } from '../server/auth/sqlite-store.js';
import { createAccountService } from '../server/auth/service.js';
import { readConfig } from '../server/auth/config.js';

test('SQLite accounts preserve login, device binding, single redemption and complete feedback after restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brclio-sqlite-account-'));
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(dir, { recursive: true, force: true }); });
  const deliveries = [];
  const config = readConfig({ AUTH_SECRET_PEPPER: 'isolated-sqlite-service-fixture-'.repeat(2), AUTH_ADMIN_EMAILS: 'admin@example.test' });
  const clock = Date.parse('2026-09-29T00:00:00Z');
  const newService = () => {
    const store = new SqliteStateStore({ path: path.join(dir, 'accounts.sqlite') });
    stores.push(store);
    return createAccountService({ store, config, now: () => clock, mailer: {
      provider: 'fixture', configured: true, send: async delivery => { deliveries.push(delivery); },
    } });
  };
  const a = newService(), b = newService();
  const keys = generateKeyPairSync('ed25519');
  const call = (service, action, input = {}, session, desktop = false) => {
    const token = session?.token || '';
    const nonce = randomUUID();
    return service.execute({ action, input, token, ip: '192.0.2.50', ...(desktop ? { proof: {
      timestamp: clock, nonce,
      signature: sign(null, Buffer.from(`${action}\n${clock}\n${nonce}\n${JSON.stringify(input)}\n${token}`), keys.privateKey).toString('base64'),
    } } : {}) });
  };
  async function login(email, client) {
    await call(a, 'send-code', { email, client });
    return call(b, 'verify-code', { email, client, code: deliveries.at(-1).code, ...(client === 'desktop' ? { device: {
      publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }),
      stableIdHash: createHash('sha256').update('sqlite-device').digest('hex'), name: 'Fixture device', platform: 'darwin',
    } } : {}) }, undefined, client === 'desktop');
  }
  const admin = await login('admin@example.test', 'admin');
  const user = await login('user@example.test', 'desktop');
  const status = await call(a, 'admin-status', {}, admin);
  assert.equal(status.storage.provider, 'sqlite');
  assert.equal(status.storage.status, 'ok');
  assert.equal(status.github, undefined, 'SQLite must not report GitHub as checked');
  const { codes: [code] } = await call(a, 'admin-generate-codes', {
    type: 'duration', days: 10, count: 1, reason: 'SQLite integration verification', requestId: randomUUID(),
  }, admin);
  const redemption = { code: code.code, requestId: randomUUID() };
  await Promise.all([a, b].map(service => call(service, 'redeem', redemption, user, true)));
  const account = await call(b, 'authorize', { feature: 'profile-download' }, user, true);
  assert.equal(account.authorized, true);
  assert.equal(Date.parse(account.account.membership.expiresAt), clock + 10 * 86_400_000);

  const content = JSON.stringify({ at: new Date(clock).toISOString(), level: 'info', event: 'fixture.saved', message: '完整日志' }) + '\n';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const bytes = Buffer.byteLength(content);
  const begun = await call(a, 'feedback-begin', {
    requestId: randomUUID(), title: '服务器持久化测试', description: '检查日志、回复与账号在重启后是否保留。', category: 'other', appVersion: 'fixture', platform: 'darwin',
    log: { partCount: 1, totalBytes: bytes, sha256, firstTimestamp: new Date(clock).toISOString(), lastTimestamp: new Date(clock).toISOString(), truncated: false, parts: [{ bytes, sha256 }] },
  }, user, true);
  const feedbackId = begun.feedback.id;
  await call(b, 'feedback-upload-part', { feedbackId, index: 0, content, sha256 }, user, true);
  await call(a, 'feedback-finalize', { feedbackId, requestId: randomUUID() }, user, true);
  await call(b, 'admin-feedback-reply', { feedbackId, requestId: randomUUID(), content: '管理员回复完整原文。' }, admin);
  await call(a, 'feedback-reply', { feedbackId, requestId: randomUUID(), content: '用户补充完整原文。' }, user, true);
  for (const store of stores.splice(0)) store.close();
  const restarted = newService();
  assert.equal((await call(restarted, 'me', {}, user, true)).account.user.id, user.account.user.id);
  const detail = await call(restarted, 'admin-feedback-detail', { feedbackId }, admin);
  assert.deepEqual(detail.messages.map(message => message.content), ['管理员回复完整原文。', '用户补充完整原文。']);
  assert.equal((await stores[0].readFeedbackPart(feedbackId, 0)).content, content);
  const state = (await stores[0].read()).state;
  assert.ok(!JSON.stringify(state).includes(user.token));
  assert.ok(!JSON.stringify(state).includes(code.code));
  assert.equal(Object.values(state.codes).filter(value => value.status === 'used').length, 1);
});
