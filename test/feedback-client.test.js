import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FeedbackClient } from '../desktop/feedback-client.js';
import { DiagnosticLog } from '../desktop/diagnostic-log.js';
import { createFeedbackService } from '../server/auth/feedback.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-feedback-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-09-20T12:00:00Z');
  const diagnostics = await new DiagnosticLog({ directory: path.join(root, 'logs'), now: () => time }).initialize();
  let state = { users: { user: { id: 'user', email: 'test@example.test' } }, audit: [] };
  const chunks = new Map(), calls = [], statuses = [];
  const store = { async read() { return { state: structuredClone(state) }; },
    async transaction(fn) { const copy = structuredClone(state); const result = await fn(copy); if (result.changed !== false) state = copy; return result.value; },
    async writeFeedbackPart(id, index, content) { const key = `${id}/${index}`; if (chunks.has(key)) assert.equal(chunks.get(key), content); else chunks.set(key, content); return { received: true }; },
    async readFeedbackPart(id, index) { return { content: chunks.get(`${id}/${index}`) }; } };
  const service = createFeedbackService({ store, now: () => time,
    authenticate: () => ({ user: state.users.user, session: { client: 'desktop' } }),
    hash: (type, text) => createHash('sha256').update(`${type}:${text}`).digest('hex') });
  const accountClient = { async refresh() {}, snapshot: () => ({ authenticated: true, account: { user: { id: 'user' }, membership: { type: 'none' }, device: { status: 'blocked' } } }),
    async feedbackRequest(action, input, expectedUserId) {
      if (!this.snapshot().authenticated || this.snapshot().account?.user?.id !== expectedUserId) throw Object.assign(new Error('account changed'), { status: 401, code: 'SESSION_CHANGED' });
      return this._request(action, input);
    },
    async _request(action, input) { calls.push({ action, input: structuredClone(input) }); return service.execute({ action, input }); } };
  const create = (version = '1.8.0') => new FeedbackClient({ accountClient, diagnostics, directory: path.join(root, 'pending'),
    appInfo: { version, platform: 'darwin', arch: 'arm64' }, onUpdate: s => statuses.push(s), wait: async ms => { time += ms; } });
  return { create, diagnostics, accountClient, calls, statuses, chunks, root, get state() { return state; } };
}
const input = { title: '视频没有声音', description: '请查看视频保存的音轨状态。', category: 'audio' };

test('feedback sends the full retained sanitized UTF-8 log through real service validators for a nonmember blocked device', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) await f.diagnostics.record('media.response', { index: i, title: '中文'.repeat(1000), cookie: 'never-upload', url: 'https://cdn.example/video?token=secret' });
  const result = await f.create().submit(input); assert.equal(result.ok, true);
  const feedback = f.state.feedback[result.feedbackId]; assert.equal(feedback.status, 'new');
  assert.ok(feedback.log.partCount > 1); assert.equal(f.chunks.size, feedback.log.partCount);
  const text = [...f.chunks.values()].join(''); assert.ok(text.includes('"index":59')); assert.ok(!text.includes('never-upload')); assert.ok(!text.includes('?token='));
  assert.equal(Buffer.byteLength(text), feedback.log.totalBytes);
  assert.equal(createHash('sha256').update(text).digest('hex'), feedback.log.sha256);
  assert.equal(f.statuses.at(-1).progress, 100); assert.equal(f.statuses.at(-1).status, 'submitted');
  assert.equal((await readdir(path.join(f.root, 'pending'))).length, 0);
});

test('failed upload survives restart and application upgrade with the original snapshot and request id', async t => {
  const f = await fixture(t), original = f.accountClient._request;
  f.accountClient._request = async (action, data) => { if (action === 'feedback-upload-part') throw Object.assign(new Error('offline'), { status: 503 }); return original(action, data); };
  assert.equal((await f.create().submit(input)).ok, false);
  const first = f.calls.find(call => call.action === 'feedback-begin').input;
  await f.diagnostics.record('new.after.failure'); f.accountClient._request = original;
  const result = await f.create('1.9.0').submit(input); assert.equal(result.ok, true);
  const begins = f.calls.filter(call => call.action === 'feedback-begin'); assert.deepEqual(begins.at(-1).input, first);
  assert.equal(Object.keys(f.state.feedback).length, 1);
  assert.ok(![...f.chunks.values()].join('').includes('new.after.failure'));
});

test('lost finalize response retries idempotently and never reports success before durable finalization', async t => {
  const f = await fixture(t), original = f.accountClient._request; let lose = true;
  f.accountClient._request = async (action, data) => {
    const result = await original(action, data);
    if (action === 'feedback-finalize' && lose) { lose = false; assert.ok(!f.statuses.some(s => s.status === 'submitted')); throw Object.assign(new Error('response lost'), { status: 503 }); }
    return result;
  };
  assert.equal((await f.create().submit(input)).ok, true);
  assert.equal(Object.keys(f.state.feedback).length, 1);
  assert.equal(f.calls.filter(call => call.action === 'feedback-finalize').length, 2);
});

test('guest and invalid feedback do not upload; duplicate clicks share the same in-flight operation', async t => {
  const f = await fixture(t), client = f.create();
  assert.equal((await client.submit({ ...input, description: '短' })).ok, false);
  assert.equal(f.calls.length, 0);
  const snapshot = f.accountClient.snapshot;
  f.accountClient.snapshot = () => ({ authenticated: false });
  assert.equal((await client.submit(input)).error.code, 'UNAUTHENTICATED'); assert.equal(f.calls.length, 0);
  f.accountClient.snapshot = snapshot;
  const a = client.submit(input), b = client.submit(input); assert.equal(a, b); assert.equal((await a).ok, true);
});

test('partial finalization and permission loss stay failures with recoverable cached log', async t => {
  const f = await fixture(t), original = f.accountClient._request;
  f.accountClient._request = async (action, data) => action === 'feedback-finalize' ? { feedback: { status: 'uploading' } } : original(action, data);
  const result = await f.create().submit(input); assert.equal(result.error.code, 'FEEDBACK_NOT_COMMITTED');
  assert.equal((await readdir(path.join(f.root, 'pending'))).length, 1);
  assert.ok(!f.statuses.some(s => s.status === 'submitted'));
  f.accountClient._request = async () => { throw Object.assign(new Error('session revoked'), { status: 401, code: 'SESSION_REVOKED' }); };
  assert.equal((await f.create().submit(input)).error.code, 'SESSION_REVOKED');
});

test('switching accounts while collecting a log never submits it under the new user', async t => {
  const f = await fixture(t), capture = f.diagnostics.snapshot.bind(f.diagnostics);
  f.diagnostics.snapshot = async (...args) => {
    const result = await capture(...args);
    f.accountClient.snapshot = () => ({ authenticated: true, account: { user: { id: 'another-user' } } });
    return result;
  };
  assert.equal((await f.create().submit(input)).error.code, 'SESSION_CHANGED'); assert.equal(f.calls.length, 0);
});
