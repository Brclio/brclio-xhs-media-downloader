import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

const origin = 'https://oauth.example.test';
const timestamp = Date.parse('2026-10-12T00:00:00Z');
const clientId = 'runtime-fixture.apps.googleusercontent.com';
const clientSecret = 'runtime-only-google-secret';
const cookiePair = response => response.headers.get('set-cookie')?.split(';')[0] || '';

function desktopDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const device = { publicKey: publicKey.export({ format: 'pem', type: 'spki' }),
    stableIdHash: createHash('sha256').update(randomUUID()).digest('hex'), name: 'Runtime Mac', platform: 'darwin' };
  return { device, proof(action, input, token = '') {
    const nonce = randomUUID();
    return { timestamp, nonce, signature: sign(null, Buffer.from(`${action}\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${token}`), privateKey).toString('base64') };
  } };
}

async function runtimeFixture(t) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'runtime-google-key', alg: 'RS256', use: 'sig' };
  const tokens = new Map(), upstreamCalls = [];
  const issueCode = (nonce, overrides = {}) => {
    const claims = { iss: 'https://accounts.google.com', aud: clientId, sub: 'runtime-google-sub',
      email: 'google-user@gmail.com', email_verified: true, iat: timestamp / 1000, exp: timestamp / 1000 + 3600, nonce, ...overrides };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const value = `${header}.${payload}`;
    const token = `${value}.${sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url')}`;
    const code = `runtime-code-${randomUUID()}`;
    tokens.set(code, token);
    return { code, token };
  };
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamCalls.push({ path: req.url, method: req.method, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') {
      const input = new URLSearchParams(body);
      if (input.get('client_id') !== clientId || input.get('client_secret') !== clientSecret ||
        input.get('redirect_uri') !== `${origin}/?google_callback=1` || !input.get('code_verifier')) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_request' })); return;
      }
      if (input.get('code') === 'runtime-redirect-code') {
        res.writeHead(302, { Location: '/credential-trap' }); res.end(); return;
      }
      const id_token = tokens.get(input.get('code'));
      if (!id_token) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      res.end(JSON.stringify({ id_token, access_token: 'runtime-access-token', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    if (req.url === '/oauth2/v3/certs') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
      import { createAccountHandler } from './api/account.js';
      import { createAccountService } from './server/auth/service.js';
      import { readConfig } from './server/auth/config.js';
      import { emptyState, validateState } from './server/auth/store.js';
      import { createGoogleOAuth } from './server/auth/google-oauth.js';
      import { invokeHandler } from './cloudflare/http-adapter.js';
      let state = emptyState();
      const store = { async read() { return { state: structuredClone(state) }; }, async transaction(mutate) {
        const next = structuredClone(state); const result = await mutate(next);
        if (result?.changed !== false) state = validateState(next);
        return result?.value;
      } };
      const config = readConfig({ AUTH_SECRET_PEPPER: 'runtime-only-pepper-'.repeat(3), AUTH_SITE_ORIGIN: ${JSON.stringify(origin)},
        AUTH_GOOGLE_CLIENT_ID: ${JSON.stringify(clientId)}, AUTH_GOOGLE_CLIENT_SECRET: ${JSON.stringify(clientSecret)} });
      const fetchImpl = (url, options) => fetch(${JSON.stringify(upstreamOrigin)} + new URL(url).pathname, options);
      const google = createGoogleOAuth({ config, fetchImpl, now: () => ${timestamp} });
      const service = createAccountService({ config, store, mailer: { configured: false }, now: () => ${timestamp}, fetchImpl });
      const handler = createAccountHandler({ config, service, now: () => ${timestamp} });
      export default { async fetch(request) {
        if (new URL(request.url).pathname === '/__fixture/state') return Response.json(state);
        if (new URL(request.url).pathname === '/__fixture/exchange') {
          try { return Response.json({ ok: true, identity: await google.exchange({ ...(await request.json()), codeVerifier: 'runtime-only-verifier' }) }); }
          catch (error) { return Response.json({ ok: false, code: error.code }); }
        }
        return invokeHandler(handler, request);
      } };
    ` },
    bundle: true, format: 'esm', write: false, platform: 'neutral', packages: 'external',
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'] }));
  t.after(() => runtime.dispose());
  const call = async (action, input, { cookie = '', proof, originHeader = origin, token = '' } = {}) => {
    const response = await runtime.dispatchFetch(`${origin}/api/account`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(originHeader ? { Origin: originHeader } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action, input, ...(proof ? { proof } : {}) }) });
    return { response, body: await response.json() };
  };
  const exchange = async (code, nonce) => (await runtime.dispatchFetch(`${origin}/__fixture/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, nonce }),
  })).json();
  return { call, issueCode, upstreamCalls, exchange, state: async () => (await runtime.dispatchFetch(`${origin}/__fixture/state`)).json() };
}

test('OAuth callback disables referrer leakage before loading homepage resources', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const position = html.search(/<meta\b[^>]*name=["']referrer["'][^>]*content=["']no-referrer["']/i);
  assert.ok(position >= 0, 'Google code/state must not enter resource referrers');
  assert.ok(position < html.search(/<(?:link|script)\b/i), 'referrer policy must precede any resource request');
});

test('real workerd rejects invalid Google claims and credential-bearing token redirects', async t => {
  const f = await runtimeFixture(t), nonce = 'a'.repeat(64);
  const valid = f.issueCode(nonce);
  assert.deepEqual(await f.exchange(valid.code, nonce), { ok: true, identity: {
    subject: 'runtime-google-sub', email: 'google-user@gmail.com', authoritativeEmail: true,
  } });
  for (const overrides of [{ aud: 'other.apps.googleusercontent.com' }, { iss: 'https://evil.example.test' },
    { nonce: 'b'.repeat(64) }, { email_verified: false }, { exp: timestamp / 1000 - 1 },
    { iat: timestamp / 1000 + 3600 }, { aud: [clientId, 'other-client'], azp: 'other-client' }]) {
    const invalid = f.issueCode(nonce, overrides);
    assert.deepEqual(await f.exchange(invalid.code, nonce), { ok: false, code: 'GOOGLE_IDENTITY_INVALID' });
  }
  assert.deepEqual(await f.exchange('runtime-redirect-code', nonce), { ok: false, code: 'GOOGLE_UNAVAILABLE' });
  assert.ok(!f.upstreamCalls.some(item => item.path === '/credential-trap'), 'OAuth client secrets stay at the configured token endpoint');
  assert.ok(f.upstreamCalls.every(item => !new URL(`http://fixture${item.path}`).searchParams.has('client_secret')), 'OAuth secrets never enter URL query strings');
});

test('real workerd verifies Google RSA identities and preserves browser/device OAuth boundaries', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.call('google-config', { client: 'browser' })).body.enabled, true);
  const crossSite = await f.call('google-start', { client: 'browser' }, { originHeader: 'https://evil.example.test' });
  assert.equal(crossSite.response.status, 403);
  const browser = await f.call('google-start', { client: 'browser' });
  assert.equal(browser.body.ok, true);
  const browserBinding = cookiePair(browser.response);
  assert.match(browserBinding, /^__Host-xhs-google=/);
  assert.match(browser.response.headers.get('set-cookie'), /Secure; HttpOnly/);
  const authorization = new URL(browser.body.authorizationUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const issued = f.issueCode(authorization.searchParams.get('nonce'));
  const callbackInput = { client: 'browser', code: issued.code, state: authorization.searchParams.get('state') };
  const unbound = await f.call('google-complete', callbackInput);
  assert.equal(unbound.response.status, 403);
  assert.equal(f.upstreamCalls.filter(item => item.path === '/token').length, 0, 'unbound callbacks must not exchange a code');
  const completed = await f.call('google-complete', callbackInput, { cookie: browserBinding });
  assert.equal(completed.body.ok, true, JSON.stringify(completed.body));
  assert.equal(completed.body.loginClient, 'browser');
  assert.equal(completed.body.account.user.email, 'google-user@gmail.com');
  assert.equal(completed.body.token, undefined);
  const browserSession = cookiePair(completed.response);
  assert.match(browserSession, /^__Host-xhs-browser=/);
  const repeated = await f.call('google-complete', callbackInput, { cookie: browserBinding });
  assert.equal(repeated.body.ok, true, JSON.stringify(repeated.body));
  assert.equal(cookiePair(repeated.response), browserSession, 'retry must recover the committed session');
  assert.equal(Object.keys((await f.state()).sessions).length, 1);

  const dev = desktopDevice();
  const startInput = { client: 'desktop', device: dev.device };
  assert.equal((await f.call('google-start', startInput)).response.status, 401);
  const desktop = await f.call('google-start', startInput, { proof: dev.proof('google-start', startInput), originHeader: '' });
  assert.equal(desktop.body.ok, true, JSON.stringify(desktop.body));
  const desktopUrl = new URL(desktop.body.authorizationUrl);
  const desktopIssued = f.issueCode(desktopUrl.searchParams.get('nonce'));
  const desktopCallback = await f.call('google-complete', { client: 'browser', code: desktopIssued.code, state: desktopUrl.searchParams.get('state') });
  assert.equal(desktopCallback.body.status, 'confirmation_required', JSON.stringify(desktopCallback.body));
  assert.equal(desktopCallback.body.token, undefined);
  const confirmationCookie = cookiePair(desktopCallback.response);
  const pollInput = { client: 'desktop', attemptId: desktop.body.attemptId, pollToken: desktop.body.pollToken };
  const pending = await f.call('google-poll', pollInput, { proof: dev.proof('google-poll', pollInput), originHeader: '' });
  assert.equal(pending.body.status, 'confirmation_required');
  assert.equal(pending.body.token, undefined);
  const confirmInput = { client: 'browser', attemptId: desktopCallback.body.attemptId, confirmationToken: desktopCallback.body.confirmationToken };
  assert.equal((await f.call('google-confirm', confirmInput)).response.status, 403);
  const wrongBinding = await f.call('google-confirm', confirmInput, { cookie: browserBinding });
  assert.equal(wrongBinding.response.status, 403, 'a different OAuth browser binding cannot approve the desktop');
  const confirmed = await f.call('google-confirm', confirmInput, { cookie: confirmationCookie });
  assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.token, undefined);
  assert.equal((await f.call('google-poll', pollInput, { originHeader: '' })).response.status, 401);
  const attacker = desktopDevice();
  assert.equal((await f.call('google-poll', pollInput, { proof: attacker.proof('google-poll', pollInput), originHeader: '' })).response.status, 401);
  const wrongPollInput = { ...pollInput, pollToken: 'a'.repeat(43) };
  assert.equal((await f.call('google-poll', wrongPollInput, { proof: dev.proof('google-poll', wrongPollInput), originHeader: '' })).response.status, 401);
  const signedIn = await f.call('google-poll', pollInput, { proof: dev.proof('google-poll', pollInput), originHeader: '' });
  assert.equal(signedIn.body.status, 'complete', JSON.stringify(signedIn.body));
  assert.equal(typeof signedIn.body.token, 'string');
  assert.equal(signedIn.body.account.user.id, completed.body.account.user.id, 'Google uses the same software account');
  assert.equal(signedIn.body.account.device.status, 'authorized');
  const replayPoll = await f.call('google-poll', pollInput, { proof: dev.proof('google-poll', pollInput), originHeader: '' });
  assert.equal(replayPoll.body.token, signedIn.body.token);
  const meInput = {};
  const me = await f.call('me', meInput, { token: signedIn.body.token, proof: dev.proof('me', meInput, signedIn.body.token), originHeader: '' });
  assert.equal(me.body.account.user.id, completed.body.account.user.id);

  const persisted = JSON.stringify(await f.state());
  const tokenExchange = f.upstreamCalls.find(item => item.path === '/token');
  const verifier = new URLSearchParams(tokenExchange.body).get('code_verifier');
  for (const secret of [clientSecret, issued.code, issued.token, desktopIssued.code, desktopIssued.token,
    desktop.body.pollToken, desktopCallback.body.confirmationToken, signedIn.body.token,
    browserSession.split('=')[1], browserBinding.split('=')[1], verifier, 'runtime-access-token']) {
    assert.ok(secret && !persisted.includes(secret), 'Git history must not contain recoverable login credentials');
  }
  assert.equal(Object.keys((await f.state()).sessions).length, 2, 'callback and poll retries create exactly one session each');

  const cancel = await f.call('google-cancel', pollInput, { proof: dev.proof('google-cancel', pollInput), originHeader: '' });
  assert.equal(cancel.body.status, 'cancelled');
  const repeatCancel = await f.call('google-cancel', pollInput, { proof: dev.proof('google-cancel', pollInput), originHeader: '' });
  assert.equal(repeatCancel.body.status, 'cancelled');
  const revoked = await f.call('me', meInput, { token: signedIn.body.token, proof: dev.proof('me', meInput, signedIn.body.token), originHeader: '' });
  assert.equal(revoked.body.error.code, 'SESSION_REVOKED', 'cancel revokes a session even if poll completion raced cancellation');
  assert.equal((await f.call('google-poll', pollInput, { proof: dev.proof('google-poll', pollInput), originHeader: '' })).response.status, 401);
  assert.equal(Object.values((await f.state()).devices).filter(device => device.status === 'active').length, 1, 'ordinary login cancellation never releases the account device slot');
  assert.equal((await f.call('logout', { client: 'browser' }, { cookie: browserSession })).body.ok, true);
  const loggedOutReplay = await f.call('google-complete', callbackInput, { cookie: browserBinding });
  assert.equal(loggedOutReplay.body.error.code, 'GOOGLE_ATTEMPT_USED', 'callback replay must not revive a logged-out browser session');
});
