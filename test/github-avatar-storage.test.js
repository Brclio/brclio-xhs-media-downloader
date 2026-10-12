import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { GithubAvatarStorage, avatarRequestFetch } from '../server/auth/github-avatar-storage.js';
import { GithubStateStore, emptyState } from '../server/auth/store.js';
import { GithubAvatarFixture } from './helpers/github-avatar-fixture.js';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const shard = id => `${id.slice(0, 2)}/${id.slice(2, 4)}`;
const pendingPath = m => `avatars/uploads/${shard(m.id)}/${m.userId}_${m.id}.json`;
const collectionPath = id => `avatars/collection/${shard(id)}/${id}.json`;
const originalPath = id => `avatars/originals/${id}/part-000`;
const originalKey = id => `originals/${id}/part-000`;
const conditional = { onlyIf: { etagDoesNotMatch: '*' } };
function fixture(options = {}) {
  const github = new GithubAvatarFixture();
  const storage = new GithubAvatarStorage({ owner: 'fixture', repo: 'avatars', token: 'isolated-fixture', fetchImpl: (...args) => github.fetch(...args), delay: async () => {}, ...options });
  return { github, storage };
}
function manifest(overrides = {}) {
  return { id: randomUUID(), userId: owner, sessionHash: 'session-hash', bytes: 8, partCount: 1, expiresAt: Date.now() + 3_600_000, ...overrides };
}

test('3 MiB GitHub files use raw bytes while object metadata may omit base64 content', async () => {
  const { github, storage } = fixture(), upload = manifest({ bytes: 3 * 1024 * 1024 });
  const bytes = Buffer.alloc(upload.bytes, 37); bytes[bytes.length - 1] = 251;
  await storage.beginUpload(upload);
  await storage.put(originalKey(upload.id), bytes, conditional);
  const metadata = await storage.readFile(originalPath(upload.id), { raw: false });
  assert.equal(metadata.encoding, 'none'); assert.equal(metadata.content, ''); assert.equal(metadata.size, bytes.length);
  const object = await storage.get(originalKey(upload.id));
  assert.deepEqual(Buffer.from(await object.arrayBuffer()), bytes);
  assert.ok(github.calls.some(call => call.route === `/contents/${originalPath(upload.id)}` && call.accept === 'application/vnd.github.raw+json'));
});

test('reserved blobs accept one value; competing 409 writes cannot replace the winner', async () => {
  const { github, storage } = fixture(), upload = manifest(), winner = Buffer.from('winner!!'), loser = Buffer.from('loser!!!');
  await storage.beginUpload(upload);
  let conflicted = false;
  github.beforeRequest = ({ call, fixture: repo }) => {
    if (!conflicted && call.method === 'PUT' && call.route === `/contents/${originalPath(upload.id)}`) {
      conflicted = true; repo.seed({ [originalPath(upload.id)]: winner });
      return Response.json({ message: 'sha mismatch' }, { status: 409 });
    }
  };
  assert.equal(await storage.put(originalKey(upload.id), loser, conditional), null);
  assert.equal(conflicted, true); assert.deepEqual(github.files.get(originalPath(upload.id)), winner);
  assert.equal(await storage.put(originalKey(upload.id), winner, conditional), null);
  assert.equal((await storage.head(originalKey(upload.id))).customMetadata.sha256, sha256(winner));
  assert.deepEqual(github.files.get(originalPath(upload.id)), winner);
});

test('exhausted pending-marker DELETE conflicts fail explicitly and retain the marker', async () => {
  const { github, storage } = fixture({ maxAttempts: 2 }), upload = manifest();
  await storage.beginUpload(upload);
  let deletes = 0;
  github.beforeRequest = ({ call }) => {
    if (call.method === 'DELETE') { deletes++; return Response.json({}, { status: 409 }); }
  };
  await assert.rejects(storage.delete(`uploads/${owner}/${upload.id}.json`), { code: 'AVATAR_STORAGE_CONFLICT', status: 503 });
  assert.equal(deletes, 2); assert.ok(github.files.has(pendingPath(upload)));
});

test('secondary GitHub rate limits preserve pending uploads and expose only a sanitized error', async () => {
  const { github, storage } = fixture(), upload = manifest();
  await storage.beginUpload(upload);
  github.beforeRequest = ({ call }) => call.method === 'PUT'
    ? Response.json({ message: 'You have exceeded a secondary rate limit. PRIVATE_UPSTREAM_DETAIL' }, { status: 403 }) : undefined;
  await assert.rejects(storage.put(originalKey(upload.id), Buffer.from('original'), conditional), error => {
    assert.equal(error.code, 'AVATAR_STORAGE_RATE_LIMITED'); assert.equal(error.status, 503);
    assert.ok(!error.message.includes('PRIVATE_UPSTREAM_DETAIL')); return true;
  });
  assert.ok(github.files.has(pendingPath(upload))); assert.equal(github.files.get(originalPath(upload.id)).length, 0);
});

test('cleanup ref CAS revalidates a concurrent collection and retains all original bytes', async () => {
  const { github, storage } = fixture(), upload = manifest(), bytes = Buffer.from('original');
  await storage.beginUpload(upload); await storage.put(originalKey(upload.id), bytes, conditional);
  let raced = false;
  github.beforeRequest = async ({ call }) => {
    if (!raced && call.method === 'PATCH') {
      raced = true;
      await storage.completeUpload({ ...upload, sha256: sha256(bytes) });
    }
  };
  assert.deepEqual(await storage.deleteIncomplete(upload), { retained: true });
  assert.equal(raced, true); assert.ok(github.files.has(collectionPath(upload.id)));
  assert.deepEqual(github.files.get(originalPath(upload.id)), bytes);
});

test('an in-flight part PUT cannot recreate its reserved file after cleanup removes it', async () => {
  const { github, storage } = fixture(), upload = manifest();
  await storage.beginUpload(upload);
  let raced = false;
  github.beforeRequest = async ({ call }) => {
    if (!raced && call.method === 'PUT' && call.route === `/contents/${originalPath(upload.id)}`) {
      raced = true; await storage.deleteIncomplete(upload);
    }
  };
  await assert.rejects(storage.put(originalKey(upload.id), Buffer.from('original'), conditional), { code: 'AVATAR_UPLOAD_EXPIRED', status: 409 });
  assert.equal(raced, true); assert.ok(!github.files.has(originalPath(upload.id))); assert.ok(!github.files.has(pendingPath(upload)));
});

test('a completion racing a cancellation cannot publish a collection or lose its cleanup marker', async () => {
  const { github, storage } = fixture(), upload = manifest();
  await storage.beginUpload(upload);
  let raced = false;
  github.beforeRequest = ({ call, fixture: repo }) => {
    if (!raced && call.method === 'PATCH') {
      raced = true; repo.seed({ [pendingPath(upload)]: JSON.stringify({ ...upload, expiresAt: Date.now() - 1, cancelledAt: new Date().toISOString() }) });
    }
  };
  await assert.rejects(storage.completeUpload({ ...upload, sha256: sha256(Buffer.from('original')) }), { code: 'AVATAR_UPLOAD_EXPIRED', status: 409 });
  assert.ok(!github.files.has(collectionPath(upload.id))); assert.ok(github.files.has(pendingPath(upload)));
});

test('two-level collection pagination and budget-empty user pages advance without omissions', async () => {
  const { github, storage } = fixture(), ids = Array.from({ length: 7 }, (_, i) => `${i.toString(16).padStart(2, '0')}000000-0000-4000-8000-000000000001`);
  github.seed(Object.fromEntries(ids.flatMap(id => [[collectionPath(id), '{}'], [pendingPath({ id, userId: other }), '{}']])));
  let cursor, found = [], pages = 0;
  do {
    const page = await storage.list({ prefix: 'collection/', limit: 2, ...(cursor ? { cursor } : {}) });
    found.push(...page.objects.map(object => object.key)); cursor = page.truncated ? page.cursor : undefined; pages++;
    assert.ok(pages < 10);
  } while (cursor);
  assert.deepEqual(found.sort(), ids.map(id => `collection/${id}.json`).sort());
  cursor = undefined; pages = 0; let emptyBudgetPage = false;
  do {
    const before = github.calls.length;
    const page = await storage.list({ prefix: `uploads/${owner}/`, limit: 100, ...(cursor ? { cursor } : {}) });
    assert.equal(page.objects.length, 0); assert.ok(github.calls.length - before <= 8);
    if (page.truncated) emptyBudgetPage = true;
    assert.notEqual(page.cursor, cursor); cursor = page.truncated ? page.cursor : undefined; pages++;
    assert.ok(pages < 10);
  } while (cursor);
  assert.equal(emptyBudgetPage, true);
});

test('a GitHub directory at the 1000-entry ceiling fails closed', async () => {
  const { github, storage } = fixture();
  github.beforeRequest = ({ call }) => call.route === '/contents/avatars/collection'
    ? Response.json(Array.from({ length: 1000 }, (_, index) => ({ type: 'dir', name: index.toString(16) }))) : undefined;
  await assert.rejects(storage.list({ prefix: 'collection/' }), { code: 'AVATAR_STORAGE_DIRECTORY_LIMIT', status: 503 });
});

test('account-state and avatar calls share one budget and never send external request 49', async () => {
  const github = new GithubAvatarFixture({ files: { 'state/accounts.json': JSON.stringify(emptyState()) } });
  const fetchImpl = avatarRequestFetch((...args) => github.fetch(...args));
  const options = { owner: 'fixture', repo: 'avatars', token: 'isolated-fixture', fetchImpl, delay: async () => {} };
  const account = new GithubStateStore(options), avatars = new GithubAvatarStorage(options), absent = manifest().id;
  for (let index = 0; index < 23; index++) {
    await account.read();
    assert.equal(await avatars.get(originalKey(absent)), null);
  }
  assert.equal(github.calls.length, 48);
  await assert.rejects(avatars.get(originalKey(absent)), { code: 'AVATAR_STORAGE_BUSY', status: 503 });
  assert.equal(github.calls.length, 48);
});
