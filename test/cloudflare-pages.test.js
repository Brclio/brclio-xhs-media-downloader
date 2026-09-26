import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import gateway from '../cloudflare/pages/_worker.js';
import { buildPages } from '../deploy/build-pages.mjs';
import { PUBLIC_FILES } from '../deploy/build-web.mjs';

test('gateway preserves original request body, credentials, URL, IP and response cookies', async () => {
  const raw = '{"action":"authorize","input":{"label":"原始内容"},"proof":{"signature":"fixture"}}';
  const request = new Request('https://xhs.example.test/api/account?keep=1', {
    method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', Origin: 'https://xhs.example.test', Cookie: '__Host-xhs-admin=fixture', Authorization: 'Bearer fixture', 'CF-Connecting-IP': '203.0.113.1' },
  });
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin, Cookie, Authorization' });
  headers.append('Set-Cookie', '__Host-xhs-admin=fixture; Path=/; Secure; HttpOnly; SameSite=Strict');
  headers.append('Set-Cookie', 'other=fixture; Path=/; Secure');
  const downstream = new Response('{}', { status: 201, headers });
  const response = await gateway.fetch(request, {
    APP: { async fetch(forwarded) {
      assert.equal(forwarded, request);
      assert.equal(await forwarded.text(), raw);
      assert.equal(forwarded.headers.get('cf-connecting-ip'), '203.0.113.1');
      return downstream;
    } },
    ASSETS: { fetch() { assert.fail('API must not reach Pages static assets'); } },
  });
  assert.equal(response, downstream);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.status, 201);
});

test('gateway leaves binary ranges, admin redirects and security headers untouched', async () => {
  const bytes = Uint8Array.from([0, 255, 128, 42]);
  const range = new Response(bytes, { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/10', 'X-Video-Total': '10' } });
  const received = await gateway.fetch(new Request('https://xhs.example.test/api/python_video'), { APP: { fetch: () => range } });
  assert.equal(received, range);
  assert.deepEqual(new Uint8Array(await received.arrayBuffer()), bytes);
  for (const urlPath of ['/admin', '/admin/', '/admin/admin.js']) {
    const redirect = new Response(null, { status: 307, headers: { Location: '/admin/', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } });
    const result = await gateway.fetch(new Request(`https://xhs.example.test${urlPath}`), { APP: { fetch: () => redirect } });
    assert.equal(result, redirect);
    assert.equal(result.headers.get('x-frame-options'), 'DENY');
  }
});

test('route manifest invokes only API and admin paths and static fallback never calls APP', async () => {
  const routes = JSON.parse(await readFile(new URL('../cloudflare/pages/_routes.json', import.meta.url), 'utf8'));
  assert.deepEqual(routes, { version: 1, include: ['/api/*', '/admin*'], exclude: [] });
  for (const urlPath of ['/', '/app.js', '/style.css', '/changelog', '/download', '/download.html', '/download.css', '/download.js', '/product', '/product.html', '/product.css', '/product.js', '/assets/downloads/hero.webp', '/assets/example.png']) {
    const request = new Request(`https://xhs.example.test${urlPath}`);
    const result = new Response('static');
    assert.equal(await gateway.fetch(request, {
      APP: { fetch() { assert.fail('Static fallback called APP'); } },
      ASSETS: { fetch(req) { assert.equal(req, request); return result; } },
    }), result);
  }
});

test('Pages build uses the public allowlist, removes stale files and includes only gateway runtime files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brclio-pages-test-'));
  try {
    for (const name of PUBLIC_FILES) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      if (['assets', 'admin'].includes(name)) {
        await mkdir(path.join(root, name));
        await writeFile(path.join(root, name, 'public.txt'), 'public');
      } else await writeFile(path.join(root, name), 'public');
    }
    await mkdir(path.join(root, 'assets/downloads'), { recursive: true });
    await writeFile(path.join(root, 'assets/downloads/hero.webp'), 'public-image');
    await mkdir(path.join(root, 'cloudflare/pages/dist'), { recursive: true });
    for (const name of ['_worker.js', '_routes.json', 'wrangler.jsonc']) {
      await cp(new URL(`../cloudflare/pages/${name}`, import.meta.url), path.join(root, 'cloudflare/pages', name));
    }
    await writeFile(path.join(root, '.env'), 'DO_NOT_PUBLISH');
    await writeFile(path.join(root, 'cloudflare/pages/dist/stale-secret.txt'), 'DO_NOT_PUBLISH');
    const output = await buildPages(root);
    const entries = await readdir(output);
    assert.ok(entries.includes('_worker.js'));
    assert.ok(entries.includes('_routes.json'));
    assert.ok(entries.includes('index.html'));
    for (const name of ['download.html', 'download.css', 'download.js']) assert.ok(entries.includes(name));
    for (const name of ['product.html', 'product.css', 'product.js']) assert.ok(entries.includes(name));
    assert.equal(await readFile(path.join(output, 'assets/downloads/hero.webp'), 'utf8'), 'public-image');
    for (const forbidden of ['.env', 'wrangler.jsonc', 'stale-secret.txt', 'api', 'server', 'desktop']) assert.ok(!entries.includes(forbidden));
    assert.equal(await readFile(path.join(output, '_worker.js'), 'utf8'), await readFile(new URL('../cloudflare/pages/_worker.js', import.meta.url), 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
