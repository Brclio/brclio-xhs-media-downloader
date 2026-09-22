import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { InstallConfirmation } from '../desktop/install-confirmation.js';

const state = { currentVersion: '1.8.2', latestVersion: '1.8.3', platform: 'darwin', portable: false,
  installationHint: '安装成功后自动清理旧客户端。', verifiedFile: '/private/cache/installer' };

test('only an explicit response to the pending request approves installation', async () => {
  const confirmation = new InstallConfirmation();
  let payload;
  const pending = confirmation.request(state, value => { payload = value; });
  assert.equal(payload.latestVersion, '1.8.3');
  assert.equal(payload.verifiedFile, undefined);
  assert.equal(confirmation.respond('unrelated-request', true), false);
  assert.equal(confirmation.respond(payload.id, 'true'), false);
  assert.equal(confirmation.respond(payload.id, true), true);
  assert.equal(await pending, true);
  assert.equal(confirmation.respond(payload.id, true), false);
});

test('window cancellation and stale replies cannot approve a later installation', async () => {
  const confirmation = new InstallConfirmation();
  let first, second;
  const previous = confirmation.request(state, payload => { first = payload; });
  confirmation.cancel();
  assert.equal(await previous, false);
  const next = confirmation.request({ ...state, latestVersion: '1.8.4' }, payload => { second = payload; });
  assert.notEqual(first.id, second.id);
  assert.equal(confirmation.respond(first.id, true), false);
  assert.equal(confirmation.respond(second.id, false), true);
  assert.equal(await next, false);
});

test('concurrent requests share one prompt and send failure cancels', async () => {
  const confirmation = new InstallConfirmation();
  let sends = 0;
  const first = confirmation.request(state, () => { sends++; });
  const second = confirmation.request(state, () => { sends++; });
  assert.equal(first, second);
  assert.equal(sends, 1);
  confirmation.cancel();
  assert.equal(await first, false);
  assert.equal(await confirmation.request(state, () => { throw new Error('window destroyed'); }), false);
});

test('an unanswered confirmation expires without installing', async () => {
  const confirmation = new InstallConfirmation({ timeoutMs: 10 });
  let payload;
  const pending = confirmation.request(state, value => { payload = value; });
  await delay(25);
  assert.equal(await pending, false);
  assert.equal(confirmation.respond(payload.id, true), false);
});
