import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GithubAvatarStorage } from '../server/auth/github-avatar-storage.js';
import { GithubAvatarFixture } from './helpers/github-avatar-fixture.js';

const condition = { onlyIf: { etagDoesNotMatch: '*' } };
function setup(files = {}) {
  const github = new GithubAvatarFixture({ files });
  const storage = new GithubAvatarStorage({ owner: github.owner, repo: github.repo, token: github.token,
    fetchImpl: github.fetch.bind(github), delay: async () => {} });
  return { github, storage };
}
const manifest = () => ({ id: randomUUID(), userId: randomUUID(), partCount: 1, bytes: 3,
  expiresAt: Date.now() + 3_600_000, sessionHash: 'isolated-session', name: 'review.png', contentType: 'image/png' });

test('a completion losing its GitHub CAS to cleanup cannot create a dangling original collection', async () => {
  const { github, storage } = setup(), item = manifest();
  await storage.beginUpload(item);
  await storage.put(`originals/${item.id}/part-000`, Buffer.from('new'), condition);
  let race = true;
  github.beforeRequest = async ({ request, route }) => {
    if (!race || request.method !== 'PATCH' || !route.startsWith('/git/refs/')) return;
    race = false; await storage.deleteIncomplete(item);
  };
  await assert.rejects(storage.completeUpload({ ...item, sha256: 'f'.repeat(64) }), { code: 'AVATAR_UPLOAD_EXPIRED' });
  assert.equal([...github.files.keys()].filter(path => path.includes(item.id)).length, 0);
});

test('a public GitHub repository cannot receive or expose avatar object requests', async () => {
  const denied = setup(); denied.github.private = false;
  await assert.rejects(denied.storage.get(`thumbnails/${randomUUID()}`), { code: 'STORAGE_NOT_PRIVATE' });
  assert.equal(denied.github.calls.length, 1, 'no object request is made to a public repository');
});

test('GitHub raw reads never follow download redirects or disclose repository credentials to another host', async () => {
  const { github, storage } = setup();
  github.beforeRequest = ({ request, route }) => {
    assert.equal(request.redirect, 'manual');
    if (route.startsWith('/contents/')) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/original' } });
  };
  await assert.rejects(storage.get(`thumbnails/${randomUUID()}`), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(github.calls.length, 2);
});
