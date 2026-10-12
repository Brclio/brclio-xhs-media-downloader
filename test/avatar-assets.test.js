import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createProtocolHandler } from '../desktop/protocol.js';
import { imageDimensionsFromHeader } from '../lib/image-dimensions.js';
import { validateAvatarCatalog } from '../lib/avatar-client.js';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const handler = createProtocolHandler({ rootDirectory, authorize: async () => assert.fail('Local avatar assets must not require membership') });

test('desktop protocol serves the avatar UI dependency graph and the complete 100-image catalog', async () => {
  for (const name of ['avatar-ui.js', 'lib/avatar-client.js', 'lib/account-avatar-transfer.js']) {
    const response = await handler(new Request(`xhs-app://local/${name}`, { referrer: 'xhs-app://local/index.html' }));
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  }
  const manifest = await handler(new Request('xhs-app://local/assets/avatars/manifest.json'));
  assert.equal(manifest.status, 200); assert.match(manifest.headers.get('content-type'), /application\/json/);
  const items = await manifest.json(); validateAvatarCatalog(items);
  const contents = new Set();
  for (const item of items) {
    assert.equal(item.url, `/assets/avatars/${item.id}.webp`);
    const response = await handler(new Request(`xhs-app://local${item.url}`));
    assert.equal(response.status, 200, item.id); assert.equal(response.headers.get('content-type'), 'image/webp');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024, item.id);
    assert.deepEqual(imageDimensionsFromHeader(bytes), { width: 256, height: 256 }, item.id);
    contents.add(Buffer.from(bytes).toString('base64'));
  }
  assert.equal(contents.size, 100, 'All 100 requested avatars must be distinct assets');
});
