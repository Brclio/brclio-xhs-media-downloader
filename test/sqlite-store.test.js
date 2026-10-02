import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore, createSqliteStore } from '../server/auth/sqlite-store.js';
import { emptyState } from '../server/auth/store.js';

const feedbackId = '12345678-1234-1234-1234-123456789012';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'brclio-sqlite-'));
  const path = join(directory, 'private', 'accounts.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = extra => {
    const store = new SqliteStateStore({ path, delay: async () => {}, ...options, ...extra });
    stores.push(store);
    return store;
  };
  return { directory, path, open };
}

test('SQLite creates private storage automatically and persists every account field across restarts', async t => {
  const db = fixture(t), store = db.open();
  assert.equal(store.kind, 'sqlite');
  assert.deepEqual(await store.read(), { state: emptyState(), sha: '0', revision: 0 });
  const data = emptyState();
  for (const field of ['users', 'sessions', 'devices', 'otps', 'codes', 'operations', 'rateLimits', 'feedbackRateLimits', 'feedbackReplyRateLimits', 'feedbackCommentRateLimits']) data[field].example = { retained: field };
  data.audit.push({ type: 'test' });
  data.otpHistory.push({ email: 'private@example.invalid' });
  data.mailStatus = { ok: true };
  data.feedback[feedbackId] = { id: feedbackId, messages: [], comments: [] };
  data.futureField = { value: '保留未知扩展字段' };
  assert.equal(await store.transaction(state => { Object.assign(state, data); return { value: 'saved' }; }), 'saved');
  assert.deepEqual(await store.health(), { provider: 'sqlite', ok: true });
  if (process.platform !== 'win32') {
    assert.equal(statSync(db.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(db.directory, 'private')).mode & 0o777, 0o700);
    for (const file of readdirSync(join(db.directory, 'private'))) assert.equal(statSync(join(db.directory, 'private', file)).mode & 0o777, 0o600);
  }
  store.close();
  const reopened = db.open();
  assert.deepEqual((await reopened.read()).state, data);
  assert.equal((await reopened.read()).revision, 1);
});

test('independent SQLite connections retry stale revisions without losing updates', async t => {
  const db = fixture(t), first = db.open(), second = db.open();
  let runs = 0;
  await Promise.all([first.transaction(state => { runs++; state.users.first = { id: 'first' }; }), second.transaction(state => { runs++; state.users.second = { id: 'second' }; })]);
  assert.deepEqual(Object.keys((await first.read()).state.users).sort(), ['first', 'second']);
  assert.equal(runs, 3);
  assert.equal((await first.read()).revision, 2);
});

test('async mutators hold no SQLite lock and revalidate after awaited work', async t => {
  const db = fixture(t), first = db.open(), second = db.open();
  let continueFirst, startedFirst;
  const gate = new Promise(resolve => { continueFirst = resolve; });
  const started = new Promise(resolve => { startedFirst = resolve; });
  let runs = 0;
  const pending = first.transaction(async state => {
    if (++runs === 1) { startedFirst(); await gate; }
    assert.equal(runs === 1 ? state.users.second : state.users.second.id, runs === 1 ? undefined : 'second');
    state.users.first = { id: 'first' };
  });
  await started;
  await second.transaction(state => { state.users.second = { id: 'second' }; });
  continueFirst();
  await pending;
  assert.equal(runs, 2);
  assert.deepEqual(Object.keys((await first.read()).state.users).sort(), ['first', 'second']);
});

test('stale transactions rerun business validation instead of overwriting the winning claim', async t => {
  const db = fixture(t), first = db.open(), second = db.open();
  const claim = store => store.transaction(state => {
    if (state.users.slot) throw new Error('already claimed');
    state.users.slot = { id: 'winner' };
    return { value: true };
  });
  const results = await Promise.allSettled([claim(first), claim(second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.message, 'already claimed');
  assert.equal((await first.read()).revision, 1);
});

test('no-change and failed mutations do not persist state or advance revisions', async t => {
  const store = fixture(t).open();
  assert.equal(await store.transaction(state => { state.users.discard = {}; return { changed: false, value: 'read' }; }), 'read');
  await assert.rejects(store.transaction(state => { state.users.discard = {}; throw new Error('mutator failed'); }), /mutator failed/);
  await assert.rejects(store.transaction(state => { state.schemaVersion = 999; }), { code: 'STORAGE_INVALID' });
  await assert.rejects(store.transaction(state => { state.circular = state; }), { code: 'STORAGE_INVALID' });
  assert.deepEqual(await store.read(), { state: emptyState(), sha: '0', revision: 0 });
});

test('concurrent conflicts have bounded retries and preserve the latest state', async t => {
  const db = fixture(t), store = db.open({ maxAttempts: 2 }), other = db.open();
  let runs = 0;
  await assert.rejects(store.transaction(async state => {
    runs++;
    state.users.loser = {};
    await other.transaction(latest => { latest.users[`winner${runs}`] = {}; });
  }), { code: 'STORAGE_CONFLICT' });
  assert.equal(runs, 2);
  assert.deepEqual(Object.keys((await store.read()).state.users), ['winner1', 'winner2']);
});

test('a busy independent connection is retried after releasing its write lock', async t => {
  const db = fixture(t);
  let external, retries = 0;
  const store = db.open({ delay: async () => { retries++; external.exec('ROLLBACK'); } });
  external = new DatabaseSync(db.path);
  try {
    external.exec('BEGIN IMMEDIATE');
    await store.transaction(state => { state.users.saved = {}; });
    assert.equal(retries, 1);
    assert.deepEqual((await store.read()).state.users, { saved: {} });
  } finally { external.close(); }
});

test('an unreleased independent write lock fails safely after bounded retries', async t => {
  const db = fixture(t), store = db.open({ maxAttempts: 2 });
  const external = new DatabaseSync(db.path);
  try {
    external.exec('BEGIN IMMEDIATE');
    await assert.rejects(store.transaction(state => { state.users.discard = {}; }), { code: 'STORAGE_CONFLICT' });
  } finally { external.exec('ROLLBACK'); external.close(); }
  assert.equal((await store.read()).revision, 0);
  assert.deepEqual((await store.read()).state.users, {});
});

test('SQLite capacity failure leaves the prior state unchanged', async t => {
  const store = fixture(t, { maxBytes: 600 }).open();
  await assert.rejects(store.transaction(state => { state.users.huge = { text: 'x'.repeat(1000) }; }), { code: 'STORAGE_CAPACITY' });
  assert.deepEqual((await store.read()).state, emptyState());
  assert.equal((await store.read()).revision, 0);
});

test('feedback log chunks persist byte-exactly, are immutable, and replay without revision changes', async t => {
  const db = fixture(t), store = db.open();
  const chunks = ['{"message":"中文日志"}\n', '{"index":1}\n'];
  assert.equal(await store.readFeedbackPart(feedbackId, 0, { allowMissing: true }), null);
  await assert.rejects(store.readFeedbackPart(feedbackId, 0), { code: 'FEEDBACK_LOG_INCOMPLETE' });
  for (const [index, content] of chunks.entries()) assert.deepEqual(await store.writeFeedbackPart(feedbackId, index, content), { received: true, replayed: false });
  assert.deepEqual(await store.writeFeedbackPart(feedbackId, 0, chunks[0]), { received: true, replayed: true });
  await assert.rejects(store.writeFeedbackPart(feedbackId, 0, 'different\n'), { code: 'FEEDBACK_PART_CONFLICT' });
  assert.equal((await store.read()).revision, 2);
  store.close();
  const parts = await db.open().readFeedbackParts(feedbackId, 2);
  assert.deepEqual(parts.map(part => part.content), chunks);
  for (const [index, part] of parts.entries()) {
    assert.equal(part.bytes, Buffer.byteLength(chunks[index]));
    assert.match(part.blobSha, /^[0-9a-f]{40}$/);
  }
  await assert.rejects(db.open().readFeedbackParts(feedbackId, 3), { code: 'FEEDBACK_LOG_INCOMPLETE' });
});

test('log writes participate in the snapshot revision and cannot be lost by an awaited state transaction', async t => {
  const db = fixture(t), stateStore = db.open(), logStore = db.open();
  let runs = 0;
  await stateStore.transaction(async state => {
    if (++runs === 1) await logStore.writeFeedbackPart(feedbackId, 0, 'log\n');
    state.users.owner = {};
  });
  assert.equal(runs, 2);
  assert.equal((await stateStore.read()).revision, 2);
  assert.equal((await stateStore.readFeedbackPart(feedbackId, 0)).content, 'log\n');
});

test('feedback validation rejects unsafe identifiers, counts and content before writing', async t => {
  const store = fixture(t).open();
  for (const id of ['../../state/accounts.json', '', 'g'.repeat(36)]) await assert.rejects(store.writeFeedbackPart(id, 0, 'test'), { code: 'INVALID_FEEDBACK_PART' });
  for (const index of [-1, 64, '0', 0.5]) await assert.rejects(store.writeFeedbackPart(feedbackId, index, 'test'), { code: 'INVALID_FEEDBACK_PART' });
  for (const content of ['', null, 'x'.repeat(262145)]) await assert.rejects(store.writeFeedbackPart(feedbackId, 0, content), { code: 'INVALID_FEEDBACK_PART' });
  for (const count of [0, 65, '1', 0.5]) await assert.rejects(store.readFeedbackParts(feedbackId, count), { code: 'INVALID_FEEDBACK_PART' });
  assert.deepEqual((await store.exportSnapshot()).parts, []);
  assert.equal((await store.read()).revision, 0);
});

test('snapshots roundtrip all fields and orphan/in-progress logs without mutating the supplied snapshot', async t => {
  const source = fixture(t).open(), destination = fixture(t).open();
  await source.transaction(state => {
    state.users.owner = { id: 'owner', membership: { type: 'permanent' } };
    state.sessions.active = { tokenHash: 'preserve-existing-token-hash' };
    state.feedback[feedbackId] = { log: { status: 'uploading' }, messages: [], comments: [] };
    state.custom = { future: ['保留'] };
  });
  await source.writeFeedbackPart(feedbackId, 2, 'partial log\n');
  await source.writeFeedbackPart('87654321-4321-4321-4321-210987654321', 0, 'orphan log\n');
  const snapshot = await source.exportSnapshot(), before = structuredClone(snapshot);
  assert.deepEqual(await destination.importSnapshot(snapshot, { expectedRevision: 0 }), { revision: 1 });
  const exported = await destination.exportSnapshot();
  assert.deepEqual(exported.state, snapshot.state);
  assert.deepEqual(exported.parts, snapshot.parts);
  assert.deepEqual(snapshot, before);
  await assert.rejects(destination.importSnapshot(snapshot), { code: 'STORAGE_NOT_EMPTY' });
  await assert.rejects(destination.importSnapshot(snapshot, { replace: true }), { code: 'STORAGE_CONFLICT' });
  await assert.rejects(destination.importSnapshot(snapshot, { replace: true, expectedRevision: 0 }), { code: 'STORAGE_CONFLICT' });
  assert.deepEqual(await destination.importSnapshot({ state: emptyState(), parts: [] }, { replace: true, expectedRevision: 1 }), { revision: 2 });
  assert.deepEqual(await destination.exportSnapshot(), { state: emptyState(), parts: [], revision: 2 });
});

test('snapshot CAS includes concurrent log writes even when account JSON is still empty', async t => {
  const db = fixture(t), first = db.open(), second = db.open();
  const baseline = await first.exportSnapshot();
  await second.writeFeedbackPart(feedbackId, 0, 'keep me\n');
  await assert.rejects(first.importSnapshot({ state: emptyState(), parts: [] }, { replace: true, expectedRevision: baseline.revision }), { code: 'STORAGE_CONFLICT' });
  await assert.rejects(first.importSnapshot({ state: emptyState(), parts: [] }), { code: 'STORAGE_NOT_EMPTY' });
  assert.equal((await first.readFeedbackPart(feedbackId, 0)).content, 'keep me\n');
});

test('invalid snapshots and duplicate log chunks fail before modifying the destination', async t => {
  const store = fixture(t).open();
  await store.transaction(state => { state.users.keep = {}; });
  const before = await store.exportSnapshot();
  const part = { feedbackId, index: 0, content: 'example\n' };
  for (const snapshot of [null, { state: emptyState() }, { state: { schemaVersion: 999 }, parts: [] }, { state: emptyState(), parts: [part, part] }, { state: emptyState(), parts: [{ ...part, index: 64 }] }]) {
    await assert.rejects(store.importSnapshot(snapshot, { replace: true, expectedRevision: before.revision }));
    assert.deepEqual(await store.exportSnapshot(), before);
  }
});

test('an SQLite failure midway through import rolls back both logs and account JSON', async t => {
  const db = fixture(t), store = db.open();
  await store.transaction(state => { state.users.keep = {}; });
  await store.writeFeedbackPart(feedbackId, 5, 'prior log\n');
  const before = await store.exportSnapshot();
  const external = new DatabaseSync(db.path);
  external.exec("CREATE TRIGGER fail_second_part BEFORE INSERT ON feedback_parts WHEN NEW.part_index = 1 BEGIN SELECT RAISE(ABORT, 'private-sentinel-path'); END");
  external.close();
  const state = emptyState(); state.users.replace = {};
  await assert.rejects(store.importSnapshot({ state, parts: [{ feedbackId, index: 0, content: 'first\n' }, { feedbackId, index: 1, content: 'second\n' }] }, { replace: true, expectedRevision: before.revision }), error => error.code === 'STORAGE_UNAVAILABLE' && !error.message.includes('private-sentinel-path') && !error.message.includes(db.path));
  assert.deepEqual(await store.exportSnapshot(), before);
});

test('read-only and open-existing inspection never create a missing database or parent directory', async t => {
  const db = fixture(t);
  for (const options of [{ readOnly: true }, { openExisting: true }, { readOnly: true, openExisting: true }]) assert.throws(() => db.open(options), { code: 'STORAGE_NOT_FOUND' });
  assert.deepEqual(readdirSync(db.directory), []);
  const writer = db.open();
  await writer.writeFeedbackPart(feedbackId, 0, 'persisted\n');
  writer.close();
  const bytes = readFileSync(db.path), reader = db.open({ readOnly: true, openExisting: true });
  assert.equal((await reader.exportSnapshot()).parts.length, 1);
  await assert.rejects(reader.transaction(state => { state.users.no = {}; }), { code: 'STORAGE_READ_ONLY' });
  await assert.rejects(reader.writeFeedbackPart(feedbackId, 1, 'no\n'), { code: 'STORAGE_READ_ONLY' });
  await assert.rejects(reader.importSnapshot({ state: emptyState(), parts: [] }), { code: 'STORAGE_READ_ONLY' });
  reader.close();
  assert.deepEqual(readFileSync(db.path), bytes);
});

test('damaged, empty and foreign databases are refused and never silently reset', async t => {
  for (const kind of ['garbage', 'empty', 'foreign', 'invalid-state', 'newer-version']) {
    const db = fixture(t);
    mkdirSync(join(db.directory, 'private'));
    if (kind === 'garbage' || kind === 'empty') writeFileSync(db.path, kind === 'garbage' ? 'private-path-sentinel: this is not a database' : '');
    else if (kind === 'foreign') {
      const external = new DatabaseSync(db.path);
      external.exec('CREATE TABLE unrelated (data TEXT); INSERT INTO unrelated VALUES (\'retain this database\')');
      external.close();
    } else {
      db.open().close();
      const external = new DatabaseSync(db.path);
      external.exec(kind === 'invalid-state' ? "UPDATE account_state SET content = 'broken-json'" : 'PRAGMA user_version = 999');
      external.close();
    }
    const bytes = readFileSync(db.path);
    assert.throws(() => db.open(), error => error.code === 'STORAGE_INVALID' && !error.message.includes(db.path) && !error.message.includes('private-path-sentinel'));
    assert.deepEqual(readFileSync(db.path), bytes, kind);
  }
});

test('corrupt log content is detected, and closed connections return sanitized errors', async t => {
  const db = fixture(t), store = db.open();
  await store.writeFeedbackPart(feedbackId, 0, 'valid\n');
  const external = new DatabaseSync(db.path);
  external.exec("UPDATE feedback_parts SET content = 'tampered'");
  external.close();
  await assert.rejects(store.readFeedbackPart(feedbackId, 0), { code: 'STORAGE_INVALID' });
  await assert.rejects(store.exportSnapshot(), { code: 'STORAGE_INVALID' });
  store.close();
  store.close();
  await assert.rejects(store.read(), error => error.code === 'STORAGE_UNAVAILABLE' && !error.message.includes(db.path));
});

test('symbolic database paths are refused without touching the target', { skip: process.platform === 'win32' }, async t => {
  const db = fixture(t);
  mkdirSync(join(db.directory, 'private'));
  const target = join(db.directory, 'sensitive.txt');
  writeFileSync(target, 'untouched');
  symlinkSync(target, db.path);
  assert.throws(() => db.open(), { code: 'SERVICE_NOT_CONFIGURED' });
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

test('createSqliteStore respects the explicit environment path', async t => {
  const db = fixture(t);
  const store = createSqliteStore({ AUTH_SQLITE_PATH: db.path });
  assert.equal((await store.read()).revision, 0);
  store.close();
});
