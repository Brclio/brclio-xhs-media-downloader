import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

test('real workerd reads GitHub state and sends HTTP mail while refusing credential-bearing redirects', async t => {
  const calls = [];
  const state = { schemaVersion: 1, users: {}, sessions: {}, devices: {}, otps: {}, codes: {}, operations: {}, rateLimits: {}, audit: [] };
  const server = http.createServer((req, res) => {
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, userAgent: req.headers['user-agent'], cacheControl: req.headers['cache-control'] });
    if (req.url.includes('redirect')) {
      res.writeHead(302, { Location: '/credential-trap' });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.includes('/contents/')
      ? { sha: 'fixture-sha', encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') }
      : req.url.startsWith('/repos/') ? { private: true } : { id: 'fixture-delivery' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const upstream = `http://127.0.0.1:${server.address().port}`;
  // Production modules execute inside workerd. Only the upstream destination
  // changes to a local fixture; all fetch options still go through real fetch.
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
      import { GithubStateStore } from './server/auth/store.js';
      import { createMailer } from './server/auth/mailer.js';
      export default { async fetch(request) {
        const scenario = new URL(request.url).pathname.slice(1);
        const fetchImpl = (url, options) => fetch(${JSON.stringify(upstream)} + new URL(url).pathname + new URL(url).search, options);
        try {
          if (scenario.startsWith('store')) {
            const store = new GithubStateStore({ owner: 'fixture', repo: scenario, token: 'fixture-storage-token', fetchImpl });
            const result = await store.read();
            return Response.json({ ok: true, version: result.state.schemaVersion });
          }
          const mailer = createMailer({ AUTH_MAIL_PROVIDER: 'webhook', AUTH_MAIL_WEBHOOK_URL: 'https://mail.example.test/' + scenario, AUTH_MAIL_WEBHOOK_SECRET: 'fixture-mail-token' }, fetchImpl);
          await mailer.send({ email: 'test@example.test', code: '123456', expiresInMinutes: 5, deliveryId: 'fixture' });
          return Response.json({ ok: true });
        } catch (error) { return Response.json({ ok: false, code: error.code }); }
      } };
    ` },
    bundle: true, format: 'esm', write: false, platform: 'neutral', packages: 'external',
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
  }));
  t.after(() => runtime.dispose());
  const call = async scenario => (await runtime.dispatchFetch(`https://fixture.test/${scenario}`)).json();
  assert.deepEqual(await call('store'), { ok: true, version: 1 });
  assert.deepEqual(await call('mail'), { ok: true });
  assert.deepEqual(await call('store-redirect'), { ok: false, code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(await call('mail-redirect'), { ok: false, code: 'MAIL_SEND_FAILED' });
  assert.equal(calls.length, 5, 'redirect responses must not cause follow-up network requests');
  assert.ok(!calls.some(item => item.path === '/credential-trap'));
  const github = calls[0];
  assert.equal(github.authorization, 'Bearer fixture-storage-token');
  assert.equal(github.userAgent, 'Brclio-Account-Service');
  assert.equal(github.cacheControl, 'no-cache');
  const mail = calls.find(item => item.path === '/mail');
  assert.equal(mail.authorization, 'Bearer fixture-mail-token');
  assert.equal(mail.method, 'POST');
});
