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
  const webPages = ['index.html', 'download.html', 'changelog.html', 'feedback.html', 'product.html',
    'live.html', 'learn.html', 'vip.html', 'membership.html'];
  for (const name of PUBLIC_FILES) {
    const target = path.join(root, name);
    if (['admin', 'assets'].includes(name)) {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'index.html'), 'public');
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, webPages.includes(name)
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
  for (const name of ['assets/.DS_Store', 'admin/.DS_Store', 'assets/downloads/.DS_Store', 'assets/downloads/._hero.webp']) {
    await writeFile(path.join(root, name), 'private-macOS-metadata');
  }
  await mkdir(path.join(root, 'assets/membership'), { recursive: true });
  for (const name of ['wechat-pay', 'alipay', 'wechat-contact']) {
    await writeFile(path.join(root, `assets/membership/${name}.png`), 'public-qr');
  }
  const out = await buildWeb(root);
  const files = (await readdir(out, { recursive: true })).map(name => name.replaceAll('\\', '/'));
  assert.ok(!files.some(name => path.basename(name) === '.DS_Store' || path.basename(name).startsWith('._')), 'macOS directory metadata and resource forks never become static URLs');
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
  const links = html => [...header(html).matchAll(/<a\b(?![^>]*class="header-account")[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([, href, label]) => ({ href, label }));
  assert.deepEqual(links(learningWeb), links(homepage).map(link => ({ ...link, href: link.href === '#support' ? '/#support' : link.href })), 'public learning navigation follows the homepage');
  assert.match(learningWeb, /class="learning-web"/);
  assert.match(header(learningWeb), /class="nav-link is-current" href="\/learn\.html" aria-current="page"/);
  assert.equal([...header(learningWeb).matchAll(/aria-current="page"/g)].length, 1);
  assert.ok(learningWeb.indexOf('href="./site-header.css"') > learningWeb.indexOf('href="./learn.css"'), 'shared navigation styles load after learning styles');
  assert.ok(files.includes('site-header.css'));
  assert.ok(files.includes('site-header.js'), 'responsive navigation behavior is deployed');
  for (const name of webPages) {
    const published = await readFile(path.join(out, name), 'utf8');
    const publishedHeader = header(published);
    assert.match(publishedHeader, /class="app-header"/, `${name} uses shared public navigation`);
    assert.deepEqual(links(published), links(homepage), `${name} retains every shared navigation destination`);
    const current = [...publishedHeader.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
    assert.equal(current.length, 1, `${name} has one current page link`);
    assert.match(current[0][0], new RegExp(`href="${name === 'index.html' ? '/' : `/${name.replace('.', '\\.')}`}"`));
    if (name === 'index.html') {
      assert.match(publishedHeader, /<button\b[^>]*id="browser-account-open"/, 'homepage keeps its account dialog trigger');
    } else {
      const accountLink = publishedHeader.match(/<a class="header-account" href="\/\?account=open">([\s\S]*?)<\/a>/);
      assert.ok(accountLink, `${name} opens the homepage account dialog`);
      const accountButton = header(homepage).match(/<button\b[^>]*id="browser-account-open"[^>]*>([\s\S]*?)<\/button>/);
      assert.equal(accountLink[1], accountButton[1], `${name} preserves the account icon and label`);
      assert.doesNotMatch(publishedHeader, /id="browser-account-open"/, `${name} has no unbound account button`);
    }
    assert.equal((published.match(/<link\b[^>]*href="(?:\.\/|\/)?site-header\.css"[^>]*>/g) || []).length, 1, `${name} loads shared styles once`);
    assert.equal((published.match(/<script\b[^>]*src="(?:\.\/|\/)?site-header\.js"[^>]*>/g) || []).length, 1, `${name} loads menu behavior once`);
    assert.match(published, /<script src="\.\/site-header\.js" defer><\/script>/, `${name} defers navigation behavior`);
    const styles = [...published.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    assert.match(styles.at(-1)[0], /site-header\.css/, `${name} loads shared styles after its page theme`);
    assert.equal(await readFile(path.join(root, name), 'utf8'), await readFile(new URL(`../${name}`, import.meta.url), 'utf8'), `${name} source remains unchanged`);
  }
  const productWeb = await readFile(path.join(out, 'product.html'), 'utf8');
  assert.match(header(productWeb), /class="presentation-toggle"/, 'public product navigation preserves presentation mode');
  assert.match(header(productWeb), /class="reading-progress"/, 'public product navigation preserves reading progress');
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
