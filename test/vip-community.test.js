import assert from 'node:assert/strict';
import { copyFile, glob, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProtocolHandler } from '../desktop/protocol.js';
import { verifyAsar } from '../scripts/verify-promoted-installer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const vipFiles = ['vip.html', 'vip.css', 'vip.js'];
const qrFile = 'assets/support/wechat-personal-qr.png';

test('VIP information and contact QR remain available without account authorization', async () => {
  const requests = [];
  const handler = createProtocolHandler({ rootDirectory: root, authorize: async feature => {
    requests.push(feature);
    throw Object.assign(new Error('Not logged in'), { status: 401 });
  } });
  for (const name of [...vipFiles, qrFile]) {
    const response = await handler(new Request(`xhs-app://local/${name}`, { referrer: 'xhs-app://local/' }));
    assert.equal(response.status, 200, `${name} must be accessible while logged out`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(root, name)), name);
    assert.match(response.headers.get('content-security-policy'), /frame-src 'none';/);
  }
  assert.deepEqual(requests, [], 'Viewing community information must not request a software membership');
  for (const name of ['.env', 'server/auth/config.js', 'desktop/account-config.json']) {
    assert.notEqual((await handler(new Request(`xhs-app://local/${name}`))).status, 200);
  }
});

test('community fee does not change the existing free single-note parser', async () => {
  // A direct CDN image is deterministic and requires no live service or account.
  const handler = createProtocolHandler({ rootDirectory: root });
  const response = await handler(new Request('xhs-app://local/api/parse', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'https://ci.xiaohongshu.com/vip-regression-image?imageView2/format/jpg' }),
  }));
  assert.equal(response.status, 200, 'Single downloads remain usable with the default anonymous authorization policy');
  const parsed = await response.json();
  assert.equal(parsed.success, true);
  assert.equal(parsed.engine, 'node');
});

test('release ASAR contains complete reviewed VIP content and the exact personal contact QR', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'brclio-vip-asar-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const archive = path.join(temporary, 'app.asar');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const include = pkg.build.files.filter(pattern => !pattern.startsWith('!'));
  const exclude = pkg.build.files.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));
  for await (const name of glob(include, { cwd: root, exclude })) {
    if (!(await stat(path.join(root, name))).isFile()) continue;
    const destination = path.join(source, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, name), destination);
  }
  const asar = createRequire(import.meta.url)('@electron/asar');
  const verify = async () => {
    asar.uncache(archive);
    await asar.createPackage(source, archive);
    return verifyAsar(archive, root, pkg.version);
  };
  await verify();
  for (const name of vipFiles) {
    await t.test(`rejects missing or changed ${name}`, async () => {
      const destination = path.join(source, name);
      const original = await readFile(destination);
      await rm(destination);
      await assert.rejects(verify(), /exactly the reviewed application files/);
      await writeFile(destination, Buffer.concat([original, Buffer.from('\nchanged after review\n')]));
      await assert.rejects(verify(), /Packaged source differs.*vip/);
      await writeFile(destination, original);
    });
  }
  await t.test('rejects missing or changed personal contact QR', async () => {
    const destination = path.join(source, qrFile);
    const original = await readFile(destination);
    await rm(destination);
    await assert.rejects(verify(), /not found|Unable to find/i);
    const altered = Buffer.from(original);
    altered[altered.length - 1] ^= 1;
    await writeFile(destination, altered);
    await assert.rejects(verify(), /Packaged (?:learning asset|VIP contact QR) differs/);
    await writeFile(destination, original);
  });
});
