import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildWeb, PUBLIC_FILES } from '../deploy/build-web.mjs';

test('public build only copies allowed assets, excluding backend, desktop, tests and secrets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-web-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of PUBLIC_FILES) {
    const target = path.join(root, name);
    if (['admin', 'assets'].includes(name)) {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'index.html'), 'public');
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'public');
    }
  }
  for (const name of ['.env', 'server/auth/config.js', 'server/auth/feedback.js', 'lib/diagnostic-sanitize.js', 'desktop/main.js', 'desktop/diagnostic-log.js', 'desktop/feedback-client.js', 'feedback/private-user/part-000.ndjson', 'state/accounts.json', 'test/example.js', 'README.md']) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'private');
  }
  await mkdir(path.join(root, 'assets/downloads'), { recursive: true });
  await writeFile(path.join(root, 'assets/downloads/hero.webp'), 'public-image');
  await mkdir(path.join(root, 'assets/membership'), { recursive: true });
  for (const name of ['wechat-pay', 'alipay', 'wechat-contact']) {
    await writeFile(path.join(root, `assets/membership/${name}.png`), 'public-qr');
  }
  const out = await buildWeb(root);
  const files = (await readdir(out, { recursive: true })).map(name => name.replaceAll('\\', '/'));
  assert.ok(files.includes('admin/index.html'));
  assert.ok(files.includes('lib/archive.js'));
  assert.ok(files.includes('lib/membership-plans.js'), 'client and admin share the public plan catalog');
  for (const name of ['wechat-pay', 'alipay', 'wechat-contact']) {
    assert.ok(files.includes(`assets/membership/${name}.png`), `membership QR is included: ${name}`);
  }
  for (const name of ['download.html', 'download.css', 'download.js', 'assets/downloads/hero.webp']) {
    assert.ok(files.includes(name), `download page asset is public: ${name}`);
  }
  assert.ok(!files.some(name => /server|desktop\/|\.env|README|test\//.test(name)));
  assert.ok(!files.some(name => /feedback\/|state\/|diagnostic-sanitize/.test(name)), 'private business files and server privacy logic never become static URLs');
  assert.equal(await readFile(path.join(out, 'app.js'), 'utf8'), 'public');
});

test('desktop package excludes account backend and admin source', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('api/parse.js'));
  assert.ok(!pkg.build.files.includes('api/*.js'));
  assert.ok(!pkg.build.files.some(name => /server|admin|\.env/.test(name)));
  assert.ok(pkg.build.files.includes('desktop/account-config.json'));
  assert.ok(!pkg.build.files.includes('api/account.js'), 'feedback API stays server-only');
  assert.ok(pkg.build.files.includes('lib/**/*.js'), 'shared diagnostic sanitization is packaged with the desktop logger');
  assert.ok(pkg.build.files.includes('download.html'), 'local changelog navigation can open the download page');
  assert.ok(pkg.build.files.includes('download.js'));
});
