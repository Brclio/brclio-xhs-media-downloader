import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocolHandler, isAppUrl } from '../desktop/protocol.js';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const handler = createProtocolHandler({ rootDirectory });

test('desktop protocol serves the real web entry and all first-party JS imports', async () => {
  for (const name of ['index.html', 'app.js', 'lib/archive.js', 'lib/clipboard.js', 'style.css', 'favicon.svg']) {
    const response = await handler(new Request(`xhs-app://local/${name}`));
    assert.equal(response.status, 200, name);
    assert.ok((await response.text()).length > 0, name);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

test('desktop protocol hides source/backend files and rejects foreign origins', async () => {
  for (const name of ['package.json', 'desktop/main.js', 'api/python_parse.py', 'lib/xhs.js', '.git/config', 'assets/%2e%2e/package.json']) {
    assert.notEqual((await handler(new Request(`xhs-app://local/${name}`))).status, 200, name);
  }
  assert.equal((await handler(new Request('xhs-app://evil/index.html'))).status, 403);
  assert.equal((await handler(new Request('xhs-app://local/index.html', { referrer: 'https://evil.test/' }))).status, 403);
  assert.equal(isAppUrl('xhs-app://user@local/'), false);
  assert.equal(isAppUrl('xhs-app://local:8080/'), false);
});

test('desktop protocol cannot read static symlinks outside its root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'xhs-protocol-'));
  try {
    await mkdir(path.join(temporary, 'web'));
    await writeFile(path.join(temporary, 'private.html'), 'private');
    try { await symlink(path.join(temporary, 'private.html'), path.join(temporary, 'web/index.html')); }
    catch (error) { if (error.code === 'EPERM') return; throw error; }
    const response = await createProtocolHandler({ rootDirectory: path.join(temporary, 'web') })(new Request('xhs-app://local/'));
    assert.equal(response.status, 404);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('desktop API adapter preserves existing node parse behavior and limits request size', async () => {
  const direct = await handler(new Request('xhs-app://local/api/parse', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'https://ci.xiaohongshu.com/abc123?imageView2/format/jpg' }) }));
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).engine, 'node');
  assert.equal((await handler(new Request('xhs-app://local/api/parse'))).status, 405);
  const large = await handler(new Request('xhs-app://local/api/parse', { method: 'POST', body: 'a'.repeat(17000) }));
  assert.equal(large.status, 413);
  assert.equal((await handler(new Request('xhs-app://local/api/python_parse', { method: 'POST', body: '{}' }))).status, 503);
});

test('desktop python routing preserves body, query, bytes, and HTTP status', async () => {
  const handle = createProtocolHandler({ rootDirectory, pythonBackend: { available: true,
    async request(request) {
      assert.equal(request.path, '/api/python_image?token=example');
      assert.equal(request.method, 'GET');
      return new Response(new Uint8Array([0, 255, 127]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
  } });
  const response = await handle(new Request('xhs-app://local/api/python_image?token=example'));
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 127]);
});
