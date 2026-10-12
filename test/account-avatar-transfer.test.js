import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAccountBridge } from '../lib/browser-account.js';
import { uploadAccountAvatarTransfer, fetchAccountAvatarThumbnail, avatarTransferUrl, ACCOUNT_AVATAR_MAX_BYTES } from '../lib/account-avatar-transfer.js';

const origin = 'https://avatars.example.test';
const endpoint = `${origin}/api/account`;
const avatar = { kind: 'upload', id: '12345678-1234-1234-1234-123456789abc', url: `${origin}/api/account_avatar?action=thumbnail&id=12345678-1234-1234-1234-123456789abc` };

test('browser avatar bridges preserve original slices and update the authenticated profile using a separate derivative', async () => {
  const original = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0, 3, 16]);
  const thumbnail = Uint8Array.from([1, 3, 5, 7]); const puts = [], actions = [];
  const bridge = createBrowserAccountBridge({ avatarEndpoint: endpoint, fetchImpl: async (url, init) => {
    if (init.method === 'PUT') {
      assert.equal(init.credentials, 'omit'); assert.equal(init.headers.Authorization, undefined);
      puts.push({ part: new URL(url).searchParams.get('part'), bytes: Array.from(init.body) });
      return Response.json({ ok: true });
    }
    if (init.method === 'GET') return new Response(thumbnail, { headers: { 'Content-Type': 'image/webp' } });
    const { action, input } = JSON.parse(init.body); actions.push(action);
    assert.equal(input.client, 'browser');
    if (action === 'me') return Response.json({ ok: true, account: { user: { id: 'owner', nickname: '昵称' } } });
    assert.equal(input.expectedUserId, 'owner');
    if (action === 'avatar-begin') {
      assert.equal(input.bytes, original.length); assert.equal(input.name, '原图.png');
      return Response.json({ ok: true, upload: { id: avatar.id, url: `${origin}/api/account_avatar?action=upload&token=capability`, partBytes: 5, partCount: 3 } });
    }
    if (action === 'avatar-complete') return Response.json({ ok: true, profile: { avatar } });
    if (action === 'avatar-select') return Response.json({ ok: true, profile: { avatar: { kind: 'builtin', id: input.builtinId } } });
    throw new Error(`Unexpected action ${action}`);
  } });
  await bridge.getAccountState();
  const uploaded = await bridge.uploadAccountAvatar({ original: original.buffer, thumbnail: thumbnail.buffer, name: '原图.png', contentType: 'image/png', expectedUserId: 'owner' });
  assert.equal(uploaded.ok, true); assert.deepEqual(uploaded.state.account.user.avatar, avatar);
  assert.equal(uploaded.state.account.user.nickname, '昵称');
  assert.deepEqual(puts.filter(item => item.part !== 'thumbnail').flatMap(item => item.bytes), [...original]);
  assert.deepEqual(puts.at(-1), { part: 'thumbnail', bytes: [...thumbnail] });
  const image = await bridge.getAccountAvatarThumbnail({ expectedUserId: 'owner' });
  assert.deepEqual([...new Uint8Array(image.result.thumbnail)], [...thumbnail]);
  assert.ok(!actions.includes('avatar-original'), 'displaying avatars never requests originals');
  const selected = await bridge.selectAccountAvatar({ builtinId: 'avatar-021', expectedUserId: 'owner' });
  assert.equal(selected.state.account.user.avatar.id, 'avatar-021');
});

test('switching accounts while a binary upload is pending prevents finalization and stale profile updates', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  let beganPut; const started = new Promise(resolve => { beganPut = resolve; }); const actions = [];
  const bridge = createBrowserAccountBridge({ avatarEndpoint: endpoint, fetchImpl: async (_url, init) => {
    if (init.method === 'PUT') { beganPut(); await pending; return Response.json({ ok: true }); }
    const { action } = JSON.parse(init.body); actions.push(action);
    if (action === 'me') return Response.json({ ok: true, account: { user: { id: 'owner' } } });
    if (action === 'avatar-begin') return Response.json({ ok: true, upload: { id: avatar.id, url: `${origin}/api/account_avatar?action=upload&token=capability`, partBytes: 4, partCount: 1 } });
    if (action === 'logout') return Response.json({ ok: true, revoked: true });
    throw new Error(`Unexpected action ${action}`);
  } });
  await bridge.getAccountState();
  const uploading = bridge.uploadAccountAvatar({ original: new Uint8Array(4), thumbnail: new Uint8Array(4), name: 'x.png', contentType: 'image/png', expectedUserId: 'owner' });
  await started; await bridge.logoutAccount(); release();
  const stale = await uploading;
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'SESSION_CHANGED');
  assert.equal(stale.state.authenticated, false); assert.ok(!actions.includes('avatar-complete'));
});

test('transfer boundaries reject oversized originals, cross-origin service URLs and oversized streamed thumbnails', async () => {
  let sent = false;
  await assert.rejects(uploadAccountAvatarTransfer({ input: { original: new Uint8Array(ACCOUNT_AVATAR_MAX_BYTES + 1), thumbnail: new Uint8Array(1) }, endpoint,
    request: async () => { sent = true; }, fetchImpl: async () => { sent = true; } }), { code: 'AVATAR_TOO_LARGE' });
  assert.equal(sent, false);
  for (const value of ['https://untrusted.example/api/account_avatar', `${origin}/api/account`, `${origin}/api/account_avatar#secret`, 'https://owner:secret@avatars.example.test/api/account_avatar']) assert.throws(() => avatarTransferUrl(value, endpoint), { code: 'INVALID_AVATAR_URL' });
  await assert.rejects(fetchAccountAvatarThumbnail({ url: avatar.url, endpoint,
    fetchImpl: async () => new Response(new Uint8Array(256 * 1024 + 1), { headers: { 'Content-Type': 'image/webp' } }) }), { code: 'INVALID_AVATAR_THUMBNAIL' });
});

test('relative avatar URLs resolve only against the selected trusted account endpoint', () => {
  const relative = '/api/account_avatar?action=thumbnail&id=12345678-1234-1234-1234-123456789abc';
  assert.equal(avatarTransferUrl(relative, endpoint).href, `${origin}${relative}`);
  const aliasEndpoint = 'https://existing-site-alias.example.test/api/account';
  assert.equal(avatarTransferUrl(relative, aliasEndpoint).href, `https://existing-site-alias.example.test${relative}`);
  assert.throws(() => avatarTransferUrl('//untrusted.example/api/account_avatar?action=thumbnail', aliasEndpoint), { code: 'INVALID_AVATAR_URL' });
  assert.throws(() => avatarTransferUrl(`${origin}${relative}`, aliasEndpoint), { code: 'INVALID_AVATAR_URL' });
});
