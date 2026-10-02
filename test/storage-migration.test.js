import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile, rm, access, mkdir, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { emptyState } from '../server/auth/store.js';
import { SqliteStateStore } from '../server/auth/sqlite-store.js';
import { GithubMigrationStore, migrateStorage, validateMigrationSnapshot } from '../server/storage-migration.js';
import { main as migrationCli } from '../scripts/migrate-account-storage.mjs';

const COMPLETE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPLOADING = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ORPHAN = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OLD = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const hash = content => createHash('sha256').update(content).digest('hex');
const pathFor = (id, index) => `feedback/${id}/part-${String(index).padStart(3, '0')}.ndjson`;
const config = { owner: 'test-owner', repo: 'private-test-data', token: 'test-only-not-a-real-token' };
const env = { AUTH_GITHUB_OWNER: config.owner, AUTH_GITHUB_REPO: config.repo, AUTH_GITHUB_TOKEN: config.token };

function fixture() {
  const chunks = ['{"message":"first log"}\n', '{"message":"second log"}\n'];
  const makeFeedback = (id, status) => ({ id, userId: 'u1', status, submittedAt: status === 'uploading' ? null : '2026-01-01T00:00:00Z',
    messages: [{ content: 'private reply', futureMessageField: 123 }], comments: [{ content: 'public comment', futureCommentField: ['kept'] }], futureFeedbackField: ['kept'],
    log: { partCount: chunks.length, totalBytes: Buffer.byteLength(chunks.join('')), sha256: hash(chunks.join('')),
      futureLogField: { source: 'kept' }, parts: chunks.map(content => ({ bytes: Buffer.byteLength(content), sha256: hash(content), futureManifestField: true })) } });
  const state = emptyState();
  state.users.u1 = { email: 'private@example.invalid', passwordHash: 'not-a-real-hash', futureUserField: { a: 1 } };
  state.sessions.s1 = { userId: 'u1' }; state.codes.c1 = { value: 'private-code' };
  state.devices.d1 = { userId: 'u1', futureDeviceField: { kept: true } };
  state.feedback[COMPLETE] = makeFeedback(COMPLETE, 'new');
  state.feedback[UPLOADING] = makeFeedback(UPLOADING, 'uploading');
  state.futureSchemaField = { unchanged: [1, 2, 3] };
  const parts = [
    { feedbackId: COMPLETE, index: 0, content: chunks[0] }, { feedbackId: COMPLETE, index: 1, content: chunks[1] },
    { feedbackId: UPLOADING, index: 0, content: chunks[0] }, { feedbackId: ORPHAN, index: 3, content: 'orphan log\n' },
  ];
  return { state, parts, revision: 0 };
}

function filesFor(snapshot) {
  return { 'state/accounts.json': JSON.stringify(snapshot.state), ...Object.fromEntries(snapshot.parts.map(part => [pathFor(part.feedbackId, part.index), part.content])) };
}

/** A local Git Data API model; never uses network or production credentials. */
function fakeGithub(initial = {}, { privateRepo = true } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
  let sequence = 0, head, before = () => {};
  function addBlob(content) {
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
    blobs.set(sha, content); return sha;
  }
  function addCommit(files, parents = []) {
    const entries = new Map(Object.entries(files).map(([path, content]) => [path, addBlob(content)]));
    const tree = `tree${++sequence}`, sha = `commit${++sequence}`;
    trees.set(tree, entries); commits.set(sha, { tree: { sha: tree }, parents: parents.map(sha => ({ sha })) }); return sha;
  }
  head = addCommit(initial);
  const api = {
    calls, blobs, trees, commits,
    get head() { return head; },
    get files() { return Object.fromEntries([...trees.get(commits.get(head).tree.sha)].map(([path, sha]) => [path, blobs.get(sha)])); },
    set before(fn) { before = fn; },
    advance(changes) { head = addCommit({ ...api.files, ...changes }, [head]); return head; },
    async fetch(url, options = {}) {
      const parsed = new URL(url), method = options.method || 'GET', path = parsed.pathname.replace('/repos/test-owner/private-test-data', '');
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
      const body = options.body ? JSON.parse(options.body) : undefined;
      const call = { path, method, body }; calls.push(call);
      const override = await before(call, api);
      if (override) return override;
      if (path === '' && method === 'GET') return Response.json({ private: privateRepo });
      if (path === '/git/ref/heads/main' && method === 'GET') return Response.json({ object: { type: 'commit', sha: head } });
      if (path.startsWith('/git/commits/') && method === 'GET') return Response.json(commits.get(path.split('/').at(-1)));
      if (path.startsWith('/git/trees/') && method === 'GET') {
        const tree = trees.get(path.split('/').at(-1));
        return Response.json({ truncated: false, tree: [...tree].map(([path, sha]) => ({ path, type: 'blob', mode: '100644', sha, size: Buffer.byteLength(blobs.get(sha)) })) });
      }
      if (path.startsWith('/git/blobs/') && method === 'GET') {
        const sha = path.split('/').at(-1), content = blobs.get(sha);
        return Response.json({ sha, content: Buffer.from(content).toString('base64'), encoding: 'base64' });
      }
      if (path === '/git/blobs' && method === 'POST') return Response.json({ sha: addBlob(Buffer.from(body.content, 'base64').toString('utf8')) }, { status: 201 });
      if (path === '/git/trees' && method === 'POST') {
        const tree = new Map(trees.get(body.base_tree));
        for (const entry of body.tree) { if (entry.sha === null) tree.delete(entry.path); else tree.set(entry.path, entry.sha); }
        const sha = `tree${++sequence}`; trees.set(sha, tree); return Response.json({ sha }, { status: 201 });
      }
      if (path === '/git/commits' && method === 'POST') {
        const sha = `commit${++sequence}`; commits.set(sha, { tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) });
        return Response.json({ sha }, { status: 201 });
      }
      if (path === '/git/refs/heads/main' && method === 'PATCH') {
        assert.equal(body.force, false);
        const commit = commits.get(body.sha);
        if (commit.parents[0]?.sha !== head) return Response.json({ message: 'Not a fast forward' }, { status: 409 });
        head = body.sha; return Response.json({ object: { sha: head } });
      }
      throw new Error(`Unexpected mocked GitHub route ${method} ${path}`);
    },
  };
  return api;
}
const githubStore = api => new GithubMigrationStore({ ...config, fetchImpl: api.fetch });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'brclio-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const snapshotSource = snapshot => ({ exportSnapshot: async () => snapshot });

test('GitHub export reads immutable commit blobs and includes partial and orphan uploads', async () => {
  const original = fixture(), api = fakeGithub(filesFor(original)), originalHead = api.head;
  let changed = false;
  api.before = call => {
    if (!changed && call.path.startsWith('/git/blobs/') && call.method === 'GET') {
      changed = true; api.advance({ 'state/accounts.json': JSON.stringify(emptyState()), [pathFor(COMPLETE, 0)]: 'changed after snapshot\n' });
    }
  };
  const result = await githubStore(api).exportSnapshot();
  assert.equal(result.revision, originalHead);
  assert.notEqual(api.head, originalHead);
  assert.deepEqual(result.state, original.state);
  assert.deepEqual(result.parts, original.parts);
  assert.equal(api.calls.some(call => call.method !== 'GET'), false);
});

test('GitHub snapshot reuses verified immutable blobs without dropping repeated log paths', async () => {
  const original = fixture(), api = fakeGithub(filesFor(original));
  const result = await githubStore(api).exportSnapshot();
  assert.deepEqual(result.state, original.state);
  assert.deepEqual(result.parts, original.parts);
  const uniqueContents = new Set(Object.values(filesFor(original))).size;
  assert.equal(api.calls.filter(call => call.path.startsWith('/git/blobs/') && call.method === 'GET').length, uniqueContents);
  assert.equal(result.parts.length, original.parts.length);
});

test('real SQLite and mocked GitHub round-trip all state fields, conversations and logs atomically', async t => {
  const directory = await temporary(t), sourceApi = fakeGithub(filesFor(fixture()));
  const sqlite = new SqliteStateStore({ path: join(directory, 'accounts.sqlite') });
  t.after(() => sqlite.close());
  const first = await migrateStorage({ source: githubStore(sourceApi), target: sqlite, from: 'github', to: 'sqlite', apply: true });
  assert.equal(first.applied, true); assert.equal(first.source.logParts, 4);
  const local = await sqlite.exportSnapshot();
  assert.deepEqual(local.state, fixture().state); assert.deepEqual(local.parts, fixture().parts);
  const targetApi = fakeGithub({ 'README.md': 'keep repository readme', '.github/workflows/ci.yml': 'keep workflow' });
  const second = await migrateStorage({ source: sqlite, target: githubStore(targetApi), from: 'sqlite', to: 'github', apply: true });
  assert.equal(second.applied, true);
  const restored = await githubStore(targetApi).exportSnapshot();
  assert.deepEqual(restored.state, local.state); assert.deepEqual(restored.parts, local.parts);
  assert.equal(targetApi.files['README.md'], 'keep repository readme');
  assert.equal(targetApi.files['.github/workflows/ci.yml'], 'keep workflow');
  assert.equal(targetApi.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(targetApi.calls.filter(call => call.method === 'POST' && call.path === '/git/commits').length, 1);
});

test('CLI default dry-run neither creates SQLite nor writes GitHub and prints counts only', async t => {
  const directory = await temporary(t), path = join(directory, 'never-created', 'accounts.sqlite'), lines = [];
  const api = fakeGithub(filesFor(fixture()));
  const result = await migrationCli(['--from', 'github', '--to', 'sqlite', '--sqlite-path', path], env, { fetchImpl: api.fetch, output: line => lines.push(line) });
  assert.equal(result.applied, false);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await assert.rejects(access(join(directory, 'never-created')), { code: 'ENOENT' });
  assert.equal(api.calls.every(call => call.method === 'GET'), true);
  assert.match(lines.join('\n'), /github -> sqlite/);
  assert.match(lines.join('\n'), /"logParts": 4/);
  for (const secret of ['private@example.invalid', 'private-code', 'private reply', config.token]) assert.equal(lines.join('\n').includes(secret), false);
});

test('CLI --apply creates SQLite and can preview the reverse direction read-only', async t => {
  const directory = await temporary(t), path = join(directory, 'data', 'accounts.sqlite');
  const sourceApi = fakeGithub(filesFor(fixture()));
  const applied = await migrationCli(['--from', 'github', '--to', 'sqlite', '--sqlite-path', path, '--apply'], env, { fetchImpl: sourceApi.fetch, output: () => {} });
  assert.equal(applied.applied, true);
  const targetApi = fakeGithub({ 'README.md': 'preserved' });
  const before = await readFile(path);
  const preview = await migrationCli(['--from', 'sqlite', '--to', 'github', '--sqlite-path', path], env, { fetchImpl: targetApi.fetch, output: () => {} });
  assert.equal(preview.applied, false); assert.equal(preview.source.logParts, 4);
  assert.deepEqual(await readFile(path), before);
  assert.equal(targetApi.calls.every(call => call.method === 'GET'), true);
});

test('default apply refuses populated targets, including only unknown state fields', async () => {
  const targetState = emptyState(); targetState.futureOnly = { data: true };
  const api = fakeGithub({ 'state/accounts.json': JSON.stringify(targetState) }), prior = api.head;
  await assert.rejects(migrateStorage({ source: snapshotSource(fixture()), target: githubStore(api), from: 'sqlite', to: 'github', apply: true }), { code: 'MIGRATION_TARGET_NOT_EMPTY' });
  assert.equal(api.head, prior); assert.equal(api.calls.every(call => call.method === 'GET'), true);
});

test('replacement persists private backup before atomic GitHub replacement and removes only old managed logs', async t => {
  const directory = await temporary(t), oldState = emptyState(); oldState.users.old = { email: 'old@example.invalid' };
  const oldSnapshot = { state: oldState, parts: [{ feedbackId: OLD, index: 0, content: 'old standalone log\n' }] };
  const api = fakeGithub({ ...filesFor(oldSnapshot), 'README.md': 'keep', 'feedback/README.md': 'keep feedback docs' });
  const result = await migrateStorage({ source: snapshotSource(fixture()), target: githubStore(api), from: 'sqlite', to: 'github', apply: true, replace: true, backupDirectory: directory });
  const backup = JSON.parse(await readFile(result.backup, 'utf8'));
  assert.deepEqual(backup.snapshot.state, oldState); assert.deepEqual(backup.snapshot.parts, oldSnapshot.parts);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(backup).includes(config.token), false);
  assert.equal(api.files[pathFor(OLD, 0)], undefined);
  assert.equal(api.files['README.md'], 'keep'); assert.equal(api.files['feedback/README.md'], 'keep feedback docs');
  assert.deepEqual(JSON.parse(api.files['state/accounts.json']), fixture().state);
});

test('backup failure prevents target writes', async t => {
  const directory = await temporary(t), backupDirectory = join(directory, 'not-a-directory');
  await writeFile(backupDirectory, 'exists');
  const api = fakeGithub(filesFor(fixture())), prior = api.head;
  await assert.rejects(migrateStorage({ source: snapshotSource(fixture()), target: githubStore(api), from: 'sqlite', to: 'github', apply: true, replace: true, backupDirectory }));
  assert.equal(api.head, prior); assert.equal(api.calls.every(call => call.method === 'GET'), true);
});

test('SQLite concurrent writes after preview prevent replacement without partial imports', async t => {
  const directory = await temporary(t), sqlite = new SqliteStateStore({ path: join(directory, 'racing.sqlite') });
  t.after(() => sqlite.close());
  const target = {
    exportSnapshot: () => sqlite.exportSnapshot(),
    async importSnapshot(snapshot, options) {
      await sqlite.transaction(state => { state.users.concurrent = { email: 'writer@example.invalid' }; });
      return sqlite.importSnapshot(snapshot, options);
    },
  };
  await assert.rejects(migrateStorage({ source: snapshotSource(fixture()), target, from: 'github', to: 'sqlite', apply: true }), { code: 'STORAGE_CONFLICT' });
  const result = await sqlite.exportSnapshot();
  assert.deepEqual(Object.keys(result.state.users), ['concurrent']);
  assert.deepEqual(result.parts, []);
});

test('source movement during preview refuses migration before touching the destination', async t => {
  const directory = await temporary(t), sourceApi = fakeGithub(filesFor(fixture()));
  const sqlite = new SqliteStateStore({ path: join(directory, 'target.sqlite') });
  t.after(() => sqlite.close());
  const before = await sqlite.exportSnapshot();
  await assert.rejects(migrateStorage({ source: githubStore(sourceApi), target: sqlite, from: 'github', to: 'sqlite', apply: true,
    onPreview: () => sourceApi.advance({ 'new-write.txt': 'source moved' }) }), { code: 'STORAGE_CONFLICT' });
  assert.deepEqual(await sqlite.exportSnapshot(), before);
  assert.equal(sourceApi.calls.every(call => call.method === 'GET'), true);
  assert.equal(sourceApi.calls.filter(call => call.path === '/git/ref/heads/main').length, 2);
});

test('SQLite source movement while reading target preview leaves GitHub untouched without re-exporting logs', async t => {
  const directory = await temporary(t), sqlite = new SqliteStateStore({ path: join(directory, 'source.sqlite') });
  t.after(() => sqlite.close());
  await sqlite.importSnapshot(fixture());
  const originalExport = sqlite.exportSnapshot.bind(sqlite);
  let exports = 0, moved = false;
  sqlite.exportSnapshot = async () => { exports += 1; return originalExport(); };
  const targetApi = fakeGithub({ 'README.md': 'unchanged' }), targetHead = targetApi.head;
  targetApi.before = async call => {
    if (!moved && call.method === 'GET' && call.path === '') {
      moved = true;
      await sqlite.transaction(state => { state.users.later = { email: 'later@example.invalid' }; });
    }
  };
  await assert.rejects(migrateStorage({ source: sqlite, target: githubStore(targetApi), from: 'sqlite', to: 'github', apply: true }), { code: 'STORAGE_CONFLICT' });
  assert.equal(moved, true);
  assert.equal(exports, 1);
  assert.equal((await sqlite.read()).state.users.later.email, 'later@example.invalid');
  assert.equal(targetApi.head, targetHead);
  assert.equal(targetApi.calls.every(call => call.method === 'GET'), true);
});

test('source movement while backing up retains the backup and leaves SQLite untouched', async t => {
  const directory = await temporary(t), sqlite = new SqliteStateStore({ path: join(directory, 'target.sqlite') });
  t.after(() => sqlite.close());
  await sqlite.transaction(state => { state.users.old = { email: 'old@example.invalid' }; });
  const before = await sqlite.exportSnapshot();
  const current = fixture();
  let backupPath, sourceReads = 0;
  const source = { exportSnapshot: async () => { sourceReads += 1; return structuredClone(current); } };
  await assert.rejects(migrateStorage({ source, target: sqlite, from: 'github', to: 'sqlite', apply: true, replace: true,
    backupDirectory: join(directory, 'new', 'nested', 'backups'), onBackup: path => {
      backupPath = path;
      current.revision += 1;
      current.state.users.later = { email: 'later@example.invalid' };
    } }), { code: 'STORAGE_CONFLICT' });
  assert.equal(sourceReads, 2);
  assert.deepEqual(await sqlite.exportSnapshot(), before);
  assert.deepEqual(JSON.parse(await readFile(backupPath, 'utf8')).snapshot, before);
});

test('applying a snapshot with no source revision is rejected before destination writes', async () => {
  const snapshot = fixture(); delete snapshot.revision;
  const api = fakeGithub({ 'README.md': 'unchanged' }), before = api.head;
  await assert.rejects(migrateStorage({ source: snapshotSource(snapshot), target: githubStore(api), from: 'sqlite', to: 'github', apply: true }), { code: 'MIGRATION_REVISION_REQUIRED' });
  assert.equal(api.head, before);
  assert.equal(api.calls.every(call => call.method === 'GET'), true);
});

test('completed missing logs and mismatched checksums are rejected but unfinished missing parts are retained', async () => {
  const missing = fixture(); missing.parts = missing.parts.filter(part => !(part.feedbackId === COMPLETE && part.index === 1));
  await assert.rejects(githubStore(fakeGithub(filesFor(missing))).exportSnapshot(), { code: 'FEEDBACK_LOG_INCOMPLETE' });
  const corrupted = fixture(); corrupted.parts[0].content = 'invalid log\n';
  assert.throws(() => validateMigrationSnapshot(corrupted), { code: 'FEEDBACK_LOG_MISMATCH' });
  assert.equal(validateMigrationSnapshot(fixture()).parts.filter(part => part.feedbackId === UPLOADING).length, 1);
});

test('completed manifest counts, aggregate bytes and combined checksums are verified', () => {
  const cases = [
    ['MIGRATION_INVALID', snapshot => snapshot.state.feedback[COMPLETE].log.parts.pop()],
    ['MIGRATION_INVALID', snapshot => snapshot.parts.push({ feedbackId: COMPLETE, index: 2, content: 'unexpected part\n' })],
    ['FEEDBACK_LOG_MISMATCH', snapshot => snapshot.state.feedback[COMPLETE].log.totalBytes += 1],
    ['FEEDBACK_LOG_MISMATCH', snapshot => { snapshot.state.feedback[COMPLETE].log.sha256 = '0'.repeat(64); }],
  ];
  for (const [code, mutate] of cases) {
    const snapshot = fixture(); mutate(snapshot);
    assert.throws(() => validateMigrationSnapshot(snapshot), { code });
  }
});

test('limits and malformed paths are rejected before migration writes', async () => {
  const large = fixture(); large.state.largeFutureField = 'x'.repeat(16 * 1024 * 1024);
  assert.throws(() => validateMigrationSnapshot(large), { code: 'STORAGE_CAPACITY' });
  const count = fixture(); count.state.feedback[COMPLETE].log.partCount = 65;
  assert.throws(() => validateMigrationSnapshot(count), { code: 'MIGRATION_INVALID' });
  const part = fixture(); part.parts.push({ feedbackId: ORPHAN, index: 64, content: 'too far\n' });
  assert.throws(() => validateMigrationSnapshot(part), { code: 'MIGRATION_INVALID' });
  const duplicate = fixture(); duplicate.parts.push(duplicate.parts[0]);
  assert.throws(() => validateMigrationSnapshot(duplicate), { code: 'MIGRATION_INVALID' });
  const api = fakeGithub({ ...filesFor(fixture()), [`feedback/${ORPHAN}/part-064.ndjson`]: 'too far\n' });
  await assert.rejects(githubStore(api).exportSnapshot(), { code: 'MIGRATION_INVALID' });
  assert.equal(api.calls.every(call => call.method === 'GET'), true);
});

test('large SQLite targets can be backed up and replaced while writes to GitHub enforce 900KB', async t => {
  const directory = await temporary(t), sqlite = new SqliteStateStore({ path: join(directory, 'large.sqlite') });
  t.after(() => sqlite.close());
  const large = fixture(); large.state.largeFutureField = 'x'.repeat(950_000);
  await sqlite.importSnapshot(large);
  const preview = await migrateStorage({ source: snapshotSource(fixture()), target: sqlite, from: 'github', to: 'sqlite' });
  assert.equal(preview.applied, false); assert.ok(preview.target.stateBytes > 900_000);
  const result = await migrateStorage({ source: snapshotSource(fixture()), target: sqlite, from: 'github', to: 'sqlite', apply: true, replace: true, backupDirectory: directory });
  assert.equal(JSON.parse(await readFile(result.backup, 'utf8')).snapshot.state.largeFutureField.length, 950_000);
  assert.deepEqual((await sqlite.exportSnapshot()).state, fixture().state);
  const api = fakeGithub({ 'README.md': 'keep' }), previews = [];
  await assert.rejects(migrateStorage({ source: snapshotSource(large), target: githubStore(api), from: 'sqlite', to: 'github', apply: true, onPreview: value => previews.push(value) }), { code: 'STORAGE_CAPACITY' });
  assert.ok(previews[0].source.stateBytes > 900_000);
  assert.equal(api.calls.every(call => call.method === 'GET'), true);
});

test('unsafe backup permissions and public paths are rejected before writes', async t => {
  const directory = await temporary(t), insecureDirectory = join(directory, 'insecure');
  await mkdir(insecureDirectory); await chmod(insecureDirectory, 0o755);
  const api = fakeGithub(filesFor(fixture()));
  await assert.rejects(migrateStorage({ source: snapshotSource(fixture()), target: githubStore(api), from: 'sqlite', to: 'github', apply: true, replace: true, backupDirectory: insecureDirectory }), { code: 'MIGRATION_BACKUP_FAILED' });
  assert.equal(api.calls.every(call => call.method === 'GET'), true);
  const project = fileURLToPath(new URL('../', import.meta.url));
  for (const path of [join(project, 'dist-web', 'accounts.sqlite'), join(project, 'public', 'accounts.sqlite'), join(project, 'admin', 'accounts.sqlite')]) {
    await assert.rejects(migrationCli(['--from', 'github', '--to', 'sqlite', '--sqlite-path', path], env, { fetchImpl: api.fetch, output: () => {} }), { code: 'MIGRATION_PUBLIC_PATH' });
  }
  await assert.rejects(migrationCli(['--from', 'github', '--to', 'sqlite', '--sqlite-path', join(directory, 'accounts.sqlite'), '--backup-dir', join(project, 'dist-web', 'admin')], env, { fetchImpl: api.fetch, output: () => {} }), { code: 'MIGRATION_PUBLIC_PATH' });
  const alias = join(directory, 'public-alias'); await symlink(join(project, 'admin'), alias);
  await assert.rejects(migrationCli(['--from', 'github', '--to', 'sqlite', '--sqlite-path', join(alias, 'accounts.sqlite')], env, { fetchImpl: api.fetch, output: () => {} }), { code: 'MIGRATION_PUBLIC_PATH' });
});

test('GitHub branch movement before commit is rejected without moving the branch', async () => {
  const api = fakeGithub({ 'README.md': 'keep' }), store = githubStore(api), target = await store.exportSnapshot();
  let advanced;
  api.before = call => {
    if (!advanced && call.method === 'POST' && call.path === '/git/trees') advanced = api.advance({ 'external.txt': 'concurrent writer' });
  };
  await assert.rejects(store.importSnapshot(fixture(), { expectedRevision: target.revision }), { code: 'STORAGE_CONFLICT' });
  assert.equal(api.head, advanced); assert.equal(api.files['state/accounts.json'], undefined);
  assert.equal(api.calls.some(call => call.method === 'PATCH'), false);
});

test('GitHub race after commit creation fails fast-forward update instead of overwriting', async () => {
  const api = fakeGithub({ 'README.md': 'keep' }), store = githubStore(api), target = await store.exportSnapshot();
  let advanced;
  api.before = call => {
    if (call.method === 'PATCH') advanced = api.advance({ 'external.txt': 'writer won the race' });
  };
  await assert.rejects(store.importSnapshot(fixture(), { expectedRevision: target.revision }), { code: 'STORAGE_CONFLICT' });
  assert.equal(api.head, advanced); assert.equal(api.files['state/accounts.json'], undefined);
  assert.equal(api.files['external.txt'], 'writer won the race');
});

test('failed blob upload cannot leave a half-migrated branch', async () => {
  const api = fakeGithub({ 'README.md': 'unchanged' }), store = githubStore(api), target = await store.exportSnapshot();
  let uploads = 0;
  api.before = call => { if (call.method === 'POST' && call.path === '/git/blobs' && ++uploads === 2) return Response.json({ message: 'simulated failure' }, { status: 500 }); };
  await assert.rejects(store.importSnapshot(fixture(), { expectedRevision: target.revision }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(api.head, target.revision); assert.deepEqual(api.files, { 'README.md': 'unchanged' });
  assert.equal(api.calls.some(call => call.method === 'PATCH'), false);
});

test('unconfirmed GitHub ref update is reported as uncertain and never retried', async () => {
  const api = fakeGithub({ 'README.md': 'keep' }), store = githubStore(api), target = await store.exportSnapshot();
  api.before = call => { if (call.method === 'PATCH') throw new Error('simulated timeout'); };
  await assert.rejects(store.importSnapshot(fixture(), { expectedRevision: target.revision }), { code: 'MIGRATION_WRITE_UNCERTAIN' });
  assert.equal(api.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('migration rejects public repositories and missing account sources without local writes', async t => {
  const publicApi = fakeGithub(filesFor(fixture()), { privateRepo: false });
  await assert.rejects(githubStore(publicApi).exportSnapshot(), { code: 'STORAGE_NOT_PRIVATE' });
  assert.equal(publicApi.calls.length, 1);
  const directory = await temporary(t), path = join(directory, 'not-created.sqlite'), noDataApi = fakeGithub({ 'README.md': 'exists' });
  await assert.rejects(migrationCli(['--from', 'github', '--to', 'sqlite', '--sqlite-path', path, '--apply'], env, { fetchImpl: noDataApi.fetch, output: () => {} }), { code: 'MIGRATION_SOURCE_MISSING' });
  await assert.rejects(access(path), { code: 'ENOENT' });
});
