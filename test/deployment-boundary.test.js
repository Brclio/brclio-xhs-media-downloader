import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildWeb, PUBLIC_FILES } from '../deploy/build-web.mjs';
import { build } from 'esbuild';

test('Docker and Vercel ignore configuration excludes nested private files and preserves required source', async () => {
  // This checks the glob configuration without requiring Docker or Vercel.
  // Include parent paths because ignored directories exclude all descendants.
  const excluded = (filename, patterns) => {
    const components = filename.split('/');
    const candidates = components.map((_, index) => components.slice(0, index + 1).join('/'));
    let result = false;
    for (const raw of patterns) {
      const negated = raw.startsWith('!');
      const pattern = (negated ? raw.slice(1) : raw).replace(/^\/+|\/+$/g, '');
      if (candidates.some(candidate => path.posix.matchesGlob(candidate, pattern))) result = !negated;
    }
    return result;
  };
  const privateFiles = [
    '.env', 'private/.env.production', 'server/private/runtime/.dev.vars.production',
    'server/private/credentials.local.json', 'accounts.sqlite', 'server/auth/accounts.sqlite',
    'server/auth/accounts.sqlite-wal', 'server/auth/accounts.sqlite-shm', 'server/auth/accounts.sqlite-journal',
    'server/private/accounts.sqlite3', 'server/standalone/state/live.db', 'server/private/live.db-wal',
    'server/standalone/data/snapshot.json', 'server/auth/backups/snapshot.json',
    'data/migration-backups/snapshot.json',
  ];
  for (const name of ['.dockerignore', '.vercelignore']) {
    const patterns = (await readFile(new URL(`../${name}`, import.meta.url), 'utf8')).split(/\r?\n/)
      .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    for (const filename of privateFiles) assert.ok(excluded(filename, patterns), `${name} excludes ${filename}`);
    for (const filename of ['package.json', 'api/account.js', 'server/auth/service.js', 'membership.html', 'membership.css', 'membership.js', 'lib/membership-plans.js', 'assets/membership/alipay.png']) {
      assert.equal(excluded(filename, patterns), false, `${name} preserves ${filename}`);
    }
    assert.equal(excluded('.env.example', patterns), name === '.vercelignore', 'only the Docker context retains the placeholder example');
    assert.equal(excluded('scripts/migrate-account-storage.mjs', patterns), name === '.vercelignore', 'Vercel excludes migration tooling; Docker needs the CLI');
  }
});

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
      await writeFile(target, ['index.html', 'download.html', 'learn.html'].includes(name)
        ? await readFile(new URL(`../${name}`, import.meta.url), 'utf8')
        : 'public');
    }
  }
  for (const name of ['.env', 'server/auth/config.js', 'server/auth/feedback.js', 'server/auth/sqlite-store.js', 'server/standalone/start.mjs', 'data/accounts.sqlite', 'data/accounts.sqlite-wal', 'data/migration-backups/private.json', 'backups/accounts.json', 'lib/diagnostic-sanitize.js', 'desktop/main.js', 'desktop/diagnostic-log.js', 'desktop/feedback-client.js', 'feedback/private-user/part-000.ndjson', 'state/accounts.json', 'test/example.js', 'README.md']) {
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
  for (const name of ['product.html', 'product.css', 'product.js']) {
    assert.ok(files.includes(name), `product introduction asset is public: ${name}`);
  }
  for (const name of ['live.html', 'live.css', 'live.js', 'lib/live-photo-maker.js', 'lib/live-photo-format.js',
    'lib/live-photo-heic.js', 'lib/live-photo-heic-encoder.js', 'lib/live-photo-heic-worker.js']) {
    assert.ok(files.includes(name), `Live Photo maker asset is public: ${name}`);
  }
  for (const name of ['feedback.html', 'feedback.css', 'feedback.js']) {
    assert.ok(files.includes(name), `public feedback board asset is included: ${name}`);
  }
  assert.ok(!files.some(name => /server|desktop\/|\.env|README|test\//.test(name)));
  assert.ok(!files.some(name => /feedback\/|state\/|diagnostic-sanitize/.test(name)), 'private business files and server privacy logic never become static URLs');
  assert.ok(!files.some(name => /data\/|backups\/|\.sqlite(?:-|$)/.test(name)), 'SQLite databases, WAL and migration snapshots are never public');
  assert.ok(!files.some(name => name.startsWith('ios-shortcut.')), 'shortcut resources are client-only');
  for (const name of ['index.html', 'download.html']) {
    const published = await readFile(path.join(out, name), 'utf8');
    const desktop = await readFile(path.join(root, name), 'utf8');
    assert.doesNotMatch(published, /data-ios-shortcut|ios-shortcut\.(?:css|js)|icloud\.com\/shortcuts\//, `${name} must not publish the client benefit`);
    assert.match(desktop, /data-ios-shortcut/, `${name} retains the packaged client benefit`);
    assert.match(desktop, /icloud\.com\/shortcuts\//, `${name} retains the client shortcut URL`);
  }
  assert.equal(await readFile(path.join(out, 'app.js'), 'utf8'), 'public');
  const learningSource = await readFile(path.join(root, 'learn.html'), 'utf8');
  const learningWeb = await readFile(path.join(out, 'learn.html'), 'utf8');
  const homepage = await readFile(path.join(out, 'index.html'), 'utf8');
  const header = html => html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
  const links = html => [...header(html).matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([, href, label]) => ({ href, label }));
  assert.deepEqual(links(learningWeb), links(homepage).map(link => ({ ...link, href: link.href === '#support' ? '/#support' : link.href })), 'public learning navigation follows the homepage');
  assert.match(learningWeb, /class="learning-web"/);
  assert.match(header(learningWeb), /class="nav-link is-current" href="\/learn\.html" aria-current="page"/);
  assert.equal([...header(learningWeb).matchAll(/aria-current="page"/g)].length, 1);
  assert.ok(learningWeb.indexOf('href="./site-header.css"') > learningWeb.indexOf('href="./learn.css"'), 'shared navigation styles load after learning styles');
  assert.ok(files.includes('site-header.css'));
  for (const font of homepage.match(/<link\b[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com\/[^>]*>/g) || []) {
    assert.ok(learningWeb.includes(font), 'public learning page uses the same homepage font resources');
  }
  assert.match(learningSource, /class="site-header"/);
  assert.match(learningSource, /id="back-to-tool"/);
  assert.doesNotMatch(learningSource, /learning-web|site-header\.css|class="app-header"/, 'native learning navigation remains in the source');
  assert.equal(await readFile(path.join(root, 'learn.html'), 'utf8'), learningSource, 'public build never overwrites native source');
});

test('Vercel and Cloudflare import graphs remain independent of standalone SQLite and migration tools', async () => {
  for (const entry of ['api/account.js', 'cloudflare/worker.js']) {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
      bundle: true, write: false, metafile: true, platform: 'node', format: 'esm',
      external: ['node:*', 'cloudflare:*'],
    });
    assert.ok(!Object.keys(bundle.metafile.inputs).some(name => /sqlite-store|storage-migration|server\/standalone/.test(name)), entry);
    assert.ok(bundle.outputFiles.every(file => !file.text.includes('node:sqlite')), entry);
  }
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
  assert.ok(pkg.build.files.includes('product.html'), 'product introduction is available in the local application');
  assert.ok(pkg.build.files.includes('product.js'));
});
