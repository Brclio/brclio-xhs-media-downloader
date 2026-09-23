import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubStateStore, emptyState } from '../server/auth/store.js';

function fakeGithub(initial = emptyState()) {
  let state = structuredClone(initial), version = 1;
  const calls = [], faults = [];
  let privateRepo = true, exists = true, malformed = false;
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (!url.includes('/contents/')) return Response.json({ private: privateRepo });
    if (options.method === 'GET') {
      if (!exists) return Response.json({}, { status: 404 });
      if (malformed) return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from('bad-json').toString('base64') });
      return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    }
    const fault = faults.shift();
    if (fault?.throw) throw Error('simulated transport timeout');
    if (fault?.status) return Response.json({}, { status: fault.status, headers: fault.headers });
    const body = JSON.parse(options.body);
    if (exists ? body.sha !== String(version) : Boolean(body.sha)) return Response.json({}, { status: 409 });
    state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    version += 1; exists = true;
    if (fault?.commitThenThrow) throw Error('simulated lost response');
    return Response.json({ content: { sha: String(version) } }, { status: 200 });
  };
  const store = options => new GithubStateStore({ owner: 'test-owner', repo: 'private-data', token: 'fake-private-token', fetchImpl, delay: async () => {}, ...options });
  return { store, calls, faults, get state() { return state; }, set private(value) { privateRepo = value; }, set exists(value) { exists = value; }, set malformed(value) { malformed = value; } };
}

test('two independent GitHub store instances retry SHA conflict without losing either update', async () => {
  const github = fakeGithub();
  const first = github.store(), second = github.store();
  let runs = 0;
  await Promise.all([first.transaction(state => { runs += 1; state.users.a = { id: 'a' }; return { value: 'a' }; }), second.transaction(state => { runs += 1; state.users.b = { id: 'b' }; return { value: 'b' }; })]);
  assert.deepEqual(Object.keys(github.state.users).sort(), ['a', 'b']);
  assert.ok(runs >= 3, 'the losing request must execute its validation again');
  assert.ok(github.calls.filter(call => call.method === 'PUT').every(call => JSON.parse(call.body).sha));
  assert.ok(github.calls.every(call => call.cache === 'no-store'));
});

test('conflicting update is revalidated and can be rejected instead of overwriting', async () => {
  const github = fakeGithub();
  const claim = store => store.transaction(state => {
    if (state.users.slot) throw Error('already claimed');
    state.users.slot = { id: 'winner' };
    return { value: true };
  });
  const results = await Promise.allSettled([claim(github.store()), claim(github.store())]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.message, 'already claimed');
});

test('conflicts have a bounded retry count', async () => {
  const github = fakeGithub();
  github.faults.push(...Array.from({ length: 10 }, () => ({ status: 409 })));
  await assert.rejects(github.store({ maxAttempts: 3 }).transaction(state => { state.users.a = {}; return { value: true }; }), { code: 'STORAGE_CONFLICT' });
  assert.equal(github.calls.filter(call => call.method === 'PUT').length, 3);
  assert.deepEqual(github.state.users, {});
});

for (const scenario of [
  { fault: { status: 403 }, error: 'STORAGE_UNAVAILABLE' },
  { fault: { status: 403, headers: { 'x-ratelimit-remaining': '0' } }, error: 'STORAGE_RATE_LIMITED' },
  { fault: { status: 429 }, error: 'STORAGE_RATE_LIMITED' },
  { fault: { status: 500 }, error: 'STORAGE_UNAVAILABLE' },
  { fault: { status: 422 }, error: 'STORAGE_UNAVAILABLE' },
  { fault: { throw: true }, error: 'STORAGE_WRITE_UNCERTAIN' },
]) test(`write failure ${JSON.stringify(scenario.fault)} never returns success`, async () => {
  const github = fakeGithub(); github.faults.push(scenario.fault);
  await assert.rejects(github.store().transaction(state => { state.users.a = {}; return { value: { success: true } }; }), { code: scenario.error });
  assert.deepEqual(github.state.users, {});
});

test('a committed write with a lost response is reported as uncertain', async () => {
  const github = fakeGithub(); github.faults.push({ commitThenThrow: true });
  await assert.rejects(github.store().transaction(state => { state.users.a = {}; return { value: true }; }), { code: 'STORAGE_WRITE_UNCERTAIN' });
  assert.ok(github.state.users.a);
});

test('read-only transaction never commits', async () => {
  const github = fakeGithub();
  assert.equal(await github.store().transaction(() => ({ changed: false, value: 'read' })), 'read');
  assert.equal(github.calls.filter(call => call.method === 'PUT').length, 0);
});

test('public repository is refused before any business data access', async () => {
  const github = fakeGithub(); github.private = false;
  await assert.rejects(github.store().read(), { code: 'STORAGE_NOT_PRIVATE' });
  assert.equal(github.calls.length, 1);
});

test('missing file requires explicit initialization and concurrent creation is safe', async () => {
  const github = fakeGithub(); github.exists = false;
  await assert.rejects(github.store().read(), { code: 'STORAGE_UNAVAILABLE' });
  await Promise.all(['a', 'b'].map(id => github.store({ allowInitialize: true }).transaction(state => { state.users[id] = { id }; return { value: true }; })));
  assert.deepEqual(Object.keys(github.state.users).sort(), ['a', 'b']);
});

test('invalid state and capacity failures cannot reset or silently overwrite data', async () => {
  const github = fakeGithub(); github.malformed = true;
  await assert.rejects(github.store().read(), { code: 'STORAGE_INVALID' });
  github.malformed = false;
  await assert.rejects(github.store({ maxBytes: 10 }).read(), { code: 'STORAGE_CAPACITY' });
  await assert.rejects(github.store({ maxBytes: 500 }).transaction(state => { state.users.huge = { text: 'x'.repeat(1000) }; return { value: true }; }), { code: 'STORAGE_CAPACITY' });
  assert.deepEqual(github.state.users, {});
});

test('network read failure is an explicit unavailable error', async () => {
  const store = new GithubStateStore({ owner: 'owner', repo: 'data', token: 'test', fetchImpl: async () => { throw Error('offline'); } });
  await assert.rejects(store.read(), { code: 'STORAGE_UNAVAILABLE' });
});

test('default fetch does not receive the store as its native function receiver', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async function (url, options) {
    assert.equal(this, undefined, 'native Workers fetch rejects a GithubStateStore receiver');
    assert.equal(options.redirect, 'manual');
    calls++;
    return url.includes('/contents/')
      ? Response.json({ sha: 'fixture', encoding: 'base64', content: Buffer.from(JSON.stringify(emptyState())).toString('base64') })
      : Response.json({ private: true });
  });
  const store = new GithubStateStore({ owner: 'owner', repo: 'data', token: 'fake' });
  assert.equal((await store.read()).state.schemaVersion, 1);
  assert.equal(calls, 2);
});

test('an unexpected success response without a committed blob SHA is uncertain, never confirmed', async () => {
  for (const status of [200, 202]) {
    const fetchImpl = async (url, options) => {
      if (!url.includes('/contents/')) return Response.json({ private: true });
      if (options.method === 'GET') return Response.json({ sha: 'old-sha', encoding: 'base64', content: Buffer.from(JSON.stringify(emptyState())).toString('base64') });
      return Response.json({}, { status });
    };
    const store = new GithubStateStore({ owner: 'owner', repo: 'data', token: 'fake', fetchImpl });
    await assert.rejects(store.transaction(state => { state.users.a = {}; return { value: true }; }), { code: 'STORAGE_WRITE_UNCERTAIN' });
  }
});

test('deployed schema version one gains feedback fields without resetting accounts or writing on read', async () => {
  const initial = emptyState(); delete initial.feedback; delete initial.feedbackRateLimits;
  initial.users.existing = { id: 'existing', membership: { type: 'permanent' } };
  const github = fakeGithub(initial);
  const { state } = await github.store().read();
  assert.deepEqual(state.feedback, {}); assert.deepEqual(state.feedbackRateLimits, {});
  assert.deepEqual(state.users.existing, initial.users.existing);
  assert.equal(github.calls.filter(call => call.method === 'PUT').length, 0);
  await github.store().transaction(latest => { latest.feedback.example = { id: 'example' }; return { value: true }; });
  assert.deepEqual(github.state.users.existing, initial.users.existing);
  assert.equal(github.state.feedback.example.id, 'example');
  for (const value of [null, [], false]) {
    const invalid = { ...initial, feedback: value };
    await assert.rejects(fakeGithub(invalid).store().read(), { code: 'STORAGE_INVALID' });
  }
});

test('feedback log paths cannot escape their private immutable namespace', async () => {
  const store = fakeGithub().store();
  for (const id of ['../../state/accounts.json', '../'.repeat(12), 'a'.repeat(35), `x${'a'.repeat(35)}`]) {
    assert.throws(() => store.feedbackPartUrl(id, 0), { code: 'INVALID_FEEDBACK_PART' });
  }
  const id = '12345678-1234-1234-1234-123456789012';
  assert.match(store.feedbackPartUrl(id, 63), /\/contents\/feedback\/[a-f0-9-]+\/part-063\.ndjson$/);
  for (const index of [-1, 64, '0', 0.5]) assert.throws(() => store.feedbackPartUrl(id, index), { code: 'INVALID_FEEDBACK_PART' });
});

function feedbackGraphqlFixture({ change = () => {}, branch = 'main', status = 200, invalidJson = false } = {}) {
  const calls = [];
  const store = new GithubStateStore({ owner: 'test-owner', repo: 'private-data', token: 'fake-private-token', branch,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (url !== 'https://api.github.com/graphql') return Response.json({ private: true });
      if (invalidJson) return new Response('{', { status });
      const { variables } = JSON.parse(options.body), repository = { isPrivate: true };
      for (const name of Object.keys(variables).filter(name => name.startsWith('path'))) {
        const index = Number(name.slice(4)), content = `第 ${index} 块\n`;
        repository[`part${index}`] = { oid: `sha-${index}`, byteSize: Buffer.byteLength(content), isBinary: false, isTruncated: false, text: content };
      }
      const result = { data: { repository } };
      change(result);
      return Response.json(result, { status });
    } });
  return { store, calls };
}

const feedbackId = '12345678-1234-1234-1234-123456789012';

test('all 64 feedback parts are read in four GraphQL batches with exact ordered bytes and safe variables', async () => {
  const branch = 'branch-with-"quotes"';
  const { store, calls } = feedbackGraphqlFixture({ branch });
  const parts = await store.readFeedbackParts(feedbackId, 64);
  assert.equal(parts.length, 64);
  assert.equal(calls.length, 5, 'one privacy check plus four batches leaves room for state reads, writes and conflicts');
  for (let index = 0; index < 64; index++) {
    assert.deepEqual(parts[index], { content: `第 ${index} 块\n`, bytes: Buffer.byteLength(`第 ${index} 块\n`), blobSha: `sha-${index}` });
  }
  for (const call of calls.slice(1)) {
    assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'manual');
    const { query, variables } = JSON.parse(call.body);
    assert.equal(variables.owner, 'test-owner');
    assert.equal(variables.repo, 'private-data');
    assert.equal(Object.keys(variables).filter(name => name.startsWith('path')).length, 16);
    assert.ok(!query.includes(branch), 'branch and path values are variables, never interpolated into GraphQL source');
    assert.ok(Object.entries(variables).filter(([name]) => name.startsWith('path')).every(([, value]) => value.startsWith(`${branch}:feedback/${feedbackId}/part-`)));
  }
});

test('batched feedback rejects missing, binary, truncated, oversized and mismatched blobs', async () => {
  for (const [change, code] of [
    [result => { result.data.repository.part0 = null; }, 'FEEDBACK_LOG_INCOMPLETE'],
    [result => { delete result.data.repository.part0; }, 'STORAGE_INVALID'],
    [result => { result.data.repository.part0.isBinary = true; }, 'STORAGE_INVALID'],
    [result => { result.data.repository.part0.isTruncated = true; }, 'STORAGE_INVALID'],
    [result => { result.data.repository.part0.byteSize = 262145; }, 'STORAGE_INVALID'],
    [result => { result.data.repository.part0.byteSize++; }, 'STORAGE_INVALID'],
    [result => { result.data.repository.part0.oid = ''; }, 'STORAGE_INVALID'],
    [result => { result.data.repository.isPrivate = false; }, 'STORAGE_NOT_PRIVATE'],
    [result => { result.data.repository = null; }, 'STORAGE_UNAVAILABLE'],
    [result => { result.errors = [{ type: 'FORBIDDEN', message: 'private-error-sentinel' }]; }, 'STORAGE_UNAVAILABLE'],
    [result => { result.errors = [{ type: 'RATE_LIMITED', message: 'private-error-sentinel' }]; }, 'STORAGE_RATE_LIMITED'],
  ]) {
    const { store, calls } = feedbackGraphqlFixture({ change });
    await assert.rejects(store.readFeedbackParts(feedbackId, 64), error => error.code === code && !error.message.includes('private-error-sentinel'));
    assert.equal(calls.length, 2, 'failed batch must prevent later batches');
  }
  for (const options of [{ invalidJson: true }, { status: 503 }]) {
    await assert.rejects(feedbackGraphqlFixture(options).store.readFeedbackParts(feedbackId, 1), { code: 'STORAGE_UNAVAILABLE' });
  }
});

test('invalid batch identifiers and counts cannot make network requests', async () => {
  const { store, calls } = feedbackGraphqlFixture();
  for (const count of [0, 65, -1, '16', 1.5]) await assert.rejects(store.readFeedbackParts(feedbackId, count), { code: 'INVALID_FEEDBACK_PART' });
  await assert.rejects(store.readFeedbackParts('../../state/accounts.json', 1), { code: 'INVALID_FEEDBACK_PART' });
  assert.equal(calls.length, 0);
});
