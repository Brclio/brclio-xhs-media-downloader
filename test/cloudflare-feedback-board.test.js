import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { emptyState } from '../server/auth/store.js';

test('production Worker and AccountRuntime carry browser board login, public comments and isolated private replies', async t => {
  const origin = 'https://board.example.test', createdAt = new Date().toISOString();
  const ownerId = randomUUID(), adminId = randomUUID(), feedbackId = randomUUID();
  let state = emptyState(), version = 1, writes = 0;
  state.users[ownerId] = { id: ownerId, email: 'owner@example.test', createdAt, membership: { type: 'none' } };
  state.users[adminId] = { id: adminId, email: 'admin@example.test', createdAt, membership: { type: 'none' } };
  state.feedback[feedbackId] = {
    id: feedbackId, userId: ownerId, title: '声音问题 owner@example.test', description: '  原始问题\nCookie: private-question-cookie\n下载后没有声音  ',
    category: 'audio', appVersion: 'test', platform: 'darwin', arch: 'arm64', status: 'in_progress',
    createdAt, updatedAt: createdAt, submittedAt: createdAt,
    requestKey: 'private-request-key', inputHash: 'private-input-hash',
    messages: [{ id: randomUUID(), authorId: adminId, authorRole: 'admin', content: 'PRIVATE_REPLY_SENTINEL 联系 admin@example.test', createdAt }],
    log: { partCount: 1, totalBytes: 80, sha256: 'f'.repeat(64), firstTimestamp: createdAt, lastTimestamp: createdAt, truncated: false, parts: [{ bytes: 80, sha256: 'f'.repeat(64) }] },
  };
  const deliveries = [], external = [];
  // Bundle the actual public Worker, not a test replacement for the account route.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url))], bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true } },
    bindings: {
      AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: 'isolated-board-runtime-fixture-'.repeat(2), AUTH_ADMIN_EMAILS: 'admin@example.test',
      AUTH_GITHUB_OWNER: 'fixture', AUTH_GITHUB_REPO: 'board', AUTH_GITHUB_TOKEN: 'local-github-fixture',
      AUTH_MAIL_PROVIDER: 'webhook', AUTH_MAIL_WEBHOOK_URL: 'https://mail.example.test/send', AUTH_MAIL_WEBHOOK_SECRET: 'local-mail-fixture',
    },
    outboundService: async request => {
      const url = new URL(request.url);
      external.push({ origin: url.origin, path: url.pathname, method: request.method });
      if (url.origin === 'https://mail.example.test') {
        assert.equal(request.headers.get('authorization'), 'Bearer local-mail-fixture');
        deliveries.push(await request.json());
        return Response.json({ accepted: true });
      }
      assert.equal(url.origin, 'https://api.github.com', 'all outbound traffic is intercepted by the local fixture');
      assert.equal(request.headers.get('authorization'), 'Bearer local-github-fixture');
      if (url.pathname === '/repos/fixture/board') return Response.json({ private: true });
      assert.equal(url.pathname, '/repos/fixture/board/contents/state/accounts.json');
      if (request.method === 'GET') return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
      assert.equal(request.method, 'PUT');
      const update = await request.json();
      if (update.sha !== String(version)) return Response.json({}, { status: 409 });
      state = JSON.parse(Buffer.from(update.content, 'base64').toString('utf8'));
      writes++; version++;
      return Response.json({ content: { sha: String(version) } });
    },
  }));
  t.after(() => runtime.dispose());
  async function call(action, input = {}, cookie = '', extraHeaders = {}) {
    const response = await runtime.dispatchFetch(`${origin}/api/account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, body: JSON.stringify({ action, input }),
    });
    const body = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    return { response, body };
  }
  async function login(email, client = 'browser') {
    const sent = await call('send-code', { email, client });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
    const delivery = deliveries.findLast(delivery => delivery.email === email);
    assert.equal(delivery.template, 'account-login');
    const verified = await call('verify-code', { email, client, code: delivery.code });
    assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.token, undefined, 'session tokens never enter browser JSON');
    const setCookie = verified.response.headers.get('set-cookie');
    assert.ok(setCookie.startsWith(`__Host-xhs-${client}=`));
    for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(setCookie.includes(flag));
    assert.ok(!setCookie.includes('Domain='));
    return { cookie: setCookie.split(';')[0], account: verified.body.account };
  }

  const anonymous = await call('feedback-public-list', { status: 'unresolved' });
  assert.equal(anonymous.response.status, 200); assert.equal(anonymous.body.total, 1);
  assert.equal(anonymous.body.feedbacks[0].title, '声音问题 [EMAIL]');
  assert.equal(anonymous.body.counts.in_progress, 1);
  const publicDetail = await call('feedback-public-detail', { feedbackId });
  assert.equal(publicDetail.response.status, 200); assert.deepEqual(publicDetail.body.comments, []);
  for (const privateValue of ['owner@example.test', 'private-question-cookie', 'PRIVATE_REPLY_SENTINEL', 'private-request-key', ownerId, adminId]) assert.ok(!JSON.stringify(publicDetail.body).includes(privateValue));
  assert.equal(publicDetail.body.messages, undefined); assert.equal(publicDetail.body.feedback.log, undefined);
  assert.equal(writes, 0, 'public reads leave legacy state untouched');

  const owner = await login('owner@example.test'), reader = await login('reader@example.test'), admin = await login('admin@example.test', 'admin');
  assert.equal(owner.account.user.id, ownerId); assert.equal(owner.account.membership.active, false);
  assert.equal(owner.account.device.status, 'unbound'); assert.equal(Object.keys(state.devices).length, 0);
  assert.equal(deliveries.length, 3, 'only the requested fixture OTP messages were delivered locally');

  const commentInput = { feedbackId, content: '  公开评论\nreader@example.test\n手机号：13812345678\n保留原文  ', requestId: randomUUID(), expectedUserId: reader.account.user.id };
  const beforeDenied = writes;
  const csrf = await call('feedback-public-comment', commentInput, reader.cookie, { Origin: 'https://untrusted.example.test' });
  assert.equal(csrf.response.status, 403); assert.equal(csrf.body.error.code, 'ORIGIN_FORBIDDEN');
  const changed = await call('feedback-public-comment', commentInput, owner.cookie);
  assert.equal(changed.response.status, 409); assert.equal(changed.body.error.code, 'ACCOUNT_CHANGED');
  const { expectedUserId: ignored, ...missingAssertion } = commentInput;
  const missing = await call('feedback-public-comment', missingAssertion, reader.cookie);
  assert.equal(missing.response.status, 409); assert.equal(missing.body.error.code, 'ACCOUNT_CHANGED');
  assert.equal(writes, beforeDenied);
  const comment = await call('feedback-public-comment', commentInput, reader.cookie);
  assert.equal(comment.response.status, 200, JSON.stringify(comment.body));
  assert.ok(!comment.body.comment.content.includes('reader@example.test')); assert.ok(!comment.body.comment.content.includes('13812345678'));
  assert.equal(comment.body.comment.authorId, undefined);
  assert.equal(state.feedback[feedbackId].comments[0].authorId, reader.account.user.id);
  assert.equal(state.feedback[feedbackId].comments[0].content, commentInput.content);
  const afterComment = writes, replay = await call('feedback-public-comment', commentInput, reader.cookie);
  assert.equal(replay.response.status, 200); assert.equal(replay.body.replayed, true); assert.equal(writes, afterComment);

  for (const action of ['feedback-owner-detail', 'feedback-owner-reply']) {
    const denied = await call(action, { feedbackId, content: '旁观者不能回复私密对话', requestId: randomUUID() }, reader.cookie);
    assert.equal(denied.response.status, 404); assert.equal(denied.body.error.code, 'FEEDBACK_NOT_FOUND');
  }
  const privateDetail = await call('feedback-owner-detail', { feedbackId }, owner.cookie);
  assert.equal(privateDetail.response.status, 200); assert.equal(privateDetail.body.messages[0].content, 'PRIVATE_REPLY_SENTINEL 联系 admin@example.test');
  const ownerReplyInput = { feedbackId, content: '  作者私密补充\nowner@example.test  ', requestId: randomUUID() };
  const ownerReply = await call('feedback-owner-reply', ownerReplyInput, owner.cookie);
  assert.equal(ownerReply.response.status, 200, JSON.stringify(ownerReply.body)); assert.equal(ownerReply.body.message.content, ownerReplyInput.content);

  const bothCookies = `${owner.cookie}; ${admin.cookie}`;
  assert.equal((await call('me', { client: 'browser' }, bothCookies)).body.account.user.id, ownerId);
  assert.equal((await call('me', {}, bothCookies)).body.account.user.id, adminId);
  const deniedAdmin = await call('admin-feedback-detail', { feedbackId }, owner.cookie);
  assert.equal(deniedAdmin.response.status, 401); assert.equal(deniedAdmin.body.error.code, 'ACCOUNT_REQUIRED');
  const adminDetail = await call('admin-feedback-detail', { feedbackId }, bothCookies);
  assert.equal(adminDetail.response.status, 200); assert.equal(adminDetail.body.messages.at(-1).content, ownerReplyInput.content);
  const adminReplyInput = { feedbackId, content: '管理员保留后台回复权限', requestId: randomUUID() };
  const adminReply = await call('admin-feedback-reply', adminReplyInput, bothCookies);
  assert.equal(adminReply.response.status, 200); assert.equal(adminReply.body.message.authorRole, 'admin'); assert.equal(adminReply.body.message.authorId, adminId);
  assert.equal((await call('feedback-owner-detail', { feedbackId }, bothCookies)).body.messages.at(-1).content, adminReplyInput.content);
  const status = await call('admin-feedback-status', { feedbackId, status: 'resolved', reason: '本地集成检查状态更新', requestId: randomUUID() }, bothCookies);
  assert.equal(status.response.status, 200); assert.equal(status.body.feedback.status, 'resolved');
  const finalPublic = await call('feedback-public-detail', { feedbackId });
  assert.equal(finalPublic.body.feedback.status, 'resolved'); assert.equal(finalPublic.body.comments.length, 1); assert.equal(finalPublic.body.messages, undefined);
  assert.equal(state.feedback[feedbackId].messages.length, 3); assert.equal(state.feedback[feedbackId].comments.length, 1);

  const logout = await call('logout', { client: 'browser' }, bothCookies);
  assert.equal(logout.response.status, 200); assert.match(logout.response.headers.get('set-cookie'), /^__Host-xhs-browser=;.*Max-Age=0/);
  assert.equal((await call('feedback-owner-detail', { feedbackId }, owner.cookie)).response.status, 401);
  assert.equal((await call('admin-feedback-detail', { feedbackId }, bothCookies)).response.status, 200, 'browser logout preserves the separate administrator session');
  assert.equal(deliveries.length, 3, 'comments, replies and status changes do not send email');
  assert.ok(external.every(call => ['https://api.github.com', 'https://mail.example.test'].includes(call.origin)));
});
