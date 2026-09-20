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
