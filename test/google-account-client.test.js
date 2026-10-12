import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AccountClient, validateGoogleAuthorizationUrl } from '../desktop/account-client.js';
import { createBrowserAccountBridge } from '../lib/browser-account.js';
import { consumeGoogleCallback } from '../account-ui.js';

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=opaque';
const account = { user: { id: 'google-user', email: 'member@gmail.com' }, membership: { type: 'none', active: false }, device: { status: 'authorized' } };
const success = value => Response.json({ ok: true, ...value });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function desktopFixture(handler, overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let saved = { version: 1, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }), stableIdHash: 'a'.repeat(64), token: null, pendingLogoutTokens: [] };
  const calls = [], updates = [], opened = [], delays = [];
  let clock = 0;
  const store = {
    load: async () => structuredClone(saved),
    save: async value => { saved = structuredClone(value); },
    device: value => ({ publicKey: value.publicKey, stableIdHash: value.stableIdHash, platform: 'darwin', name: 'Test Mac' }),
  };
  const client = new AccountClient({ store, endpoint: 'https://accounts.example/api/account',
    monotonicNow: () => clock, sleep: async milliseconds => { delays.push(milliseconds); clock += milliseconds; },
    onUpdate: value => updates.push(value), fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body), token = options.headers.Authorization?.replace('Bearer ', '') || '';
      calls.push(request);
      if (request.action !== 'google-config') {
        const payload = `${request.action}\n${request.proof.timestamp}\n${request.proof.nonce}\n${JSON.stringify(request.input)}\n${token}`;
        assert.equal(verify(null, Buffer.from(payload), saved.publicKey, Buffer.from(request.proof.signature, 'base64')), true);
      }
      if (request.action === 'google-cancel' || request.action === 'logout') return success({ cancelled: true, revoked: true });
      return handler(request, options);
    }, ...overrides });
  await client.initialize();
  return { client, store, calls, updates, delays, opened, saved: () => saved, open: async url => opened.push(url) };
}

test('Google callback consumes only marked OAuth queries and immediately strips all sensitive values', () => {
  const replaced = [];
  const callback = consumeGoogleCallback({ href: 'https://xhs.example/?account=orders&google_callback=1&code=secret-code&state=secret-state&scope=email&authuser=0&prompt=consent&hd=example.com#software-reviews', replace: value => replaced.push(value) });
  assert.deepEqual(callback, { code: 'secret-code', state: 'secret-state', error: '' });
  assert.deepEqual(replaced, ['https://xhs.example/?account=orders#software-reviews']);
  assert.equal(consumeGoogleCallback({ href: 'https://xhs.example/?code=activation-code', replace: () => assert.fail('Unmarked query must stay untouched') }), null);
});

test('browser Google login uses same-origin cookie session and desktop confirmation preserves its existing account', async () => {
  const calls = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    assert.equal(options.credentials, 'same-origin');
    const request = JSON.parse(options.body); calls.push(request);
    assert.equal(request.input.client, 'browser');
    if (request.action === 'google-config') return success({ enabled: true });
    if (request.action === 'google-start') return success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'browser-attempt' });
    if (request.action === 'google-complete' && request.input.state === 'desktop-state') return success({ loginClient: 'desktop', status: 'confirmation_required', attemptId: 'desktop-attempt', confirmationToken: 'memory-only', email: account.user.email, deviceName: 'Test Mac' });
    if (request.action === 'google-confirm') return success({ loginClient: 'desktop', status: 'complete' });
    return success({ account, loginClient: 'browser' });
  } });
  assert.equal((await bridge.getAccountGoogleConfig()).result.enabled, true);
  assert.equal((await bridge.loginAccountGoogle()).result.authorizationUrl, AUTHORIZATION_URL);
  const loggedIn = await bridge.completeAccountGoogleLogin({ code: 'browser-code', state: 'browser-state' });
  assert.equal(loggedIn.state.verified, true); assert.equal(loggedIn.state.account.user.id, account.user.id);
  const desktop = await bridge.completeAccountGoogleLogin({ code: 'desktop-code', state: 'desktop-state' });
  assert.equal(desktop.result.status, 'confirmation_required'); assert.equal(desktop.state.account.user.id, account.user.id);
  assert.equal((await bridge.confirmAccountGoogleLogin({ attemptId: 'desktop-attempt', confirmationToken: 'memory-only' })).result.status, 'complete');
  assert.equal(JSON.stringify(desktop.state).includes('memory-only'), false);
  assert.deepEqual(calls.at(-1).input, { client: 'browser', attemptId: 'desktop-attempt', confirmationToken: 'memory-only' });
});

test('browser callback cookie write completes before a following logout revokes it', async () => {
  const pending = deferred(), calls = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    const { action } = JSON.parse(options.body); calls.push(action);
    if (action === 'google-complete') { await pending.promise; return success({ loginClient: 'browser', account }); }
    assert.equal(action, 'logout'); return success({ revoked: true });
  } });
  const completion = bridge.completeAccountGoogleLogin({ code: 'code', state: 'state' }); await tick();
  const logout = bridge.logoutAccount(); await tick();
  assert.deepEqual(calls, ['google-complete']); pending.resolve();
  assert.equal((await completion).ok, false); assert.equal((await logout).state.authenticated, false);
  assert.deepEqual(calls, ['google-complete', 'logout']);
});

test('starting a Google redirect cannot undo a previously failed browser logout', async () => {
  const calls = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    const { action } = JSON.parse(options.body); calls.push(action);
    if (action === 'me') return success({ account });
    if (action === 'logout') throw new Error('Offline');
    if (action === 'google-start') return success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt' });
    if (action === 'google-complete') return success({ loginClient: 'desktop', status: 'confirmation_required' });
    assert.fail(`Unexpected action ${action}`);
  } });
  await bridge.getAccountState(); await bridge.logoutAccount(); await bridge.loginAccountGoogle();
  await bridge.completeAccountGoogleLogin({ code: 'code', state: 'desktop-state' });
  assert.equal((await bridge.refreshAccount()).state.authenticated, false);
  assert.deepEqual(calls, ['me', 'logout', 'google-start', 'google-complete', 'logout']);
});

test('desktop opens Google in system browser, proves the bound device, polls conservatively, and stores only the own-session token', async () => {
  let polls = 0;
  const f = await desktopFixture(async request => {
    if (request.action === 'google-config') return success({ enabled: true });
    if (request.action === 'google-start') { assert.equal(request.input.device.name, 'Test Mac'); return success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'private-poll-token', expiresInSeconds: 600 }); }
    assert.equal(request.action, 'google-poll');
    assert.deepEqual(request.input, { client: 'desktop', attemptId: 'attempt', pollToken: 'private-poll-token' });
    if (++polls < 3) return success({ status: polls === 1 ? 'pending' : 'confirmation_required' });
    return success({ status: 'complete', token: 'own-session-token', account });
  });
  assert.equal((await f.client.getGoogleConfig()).enabled, true);
  const state = await f.client.loginWithGoogle(f.open);
  assert.deepEqual(f.opened, [AUTHORIZATION_URL]); assert.deepEqual(f.delays, [4000, 4000]);
  assert.equal(state.authenticated, true); assert.equal(state.googleLoginPending, false);
  assert.equal(f.saved().token, 'own-session-token');
  assert.equal(JSON.stringify(f.updates).includes('own-session-token'), false);
  assert.equal(JSON.stringify(f.updates).includes('private-poll-token'), false);
  assert.equal(JSON.stringify(f.updates).includes('PRIVATE KEY'), false);
  assert.equal(f.calls.some(value => value.action === 'google-cancel'), false);
});

test('desktop recovers transient polling failures and a lost completed-session reply without restarting Google', async () => {
  let polls = 0;
  const completed = { status: 'complete', token: 'recovered-session', account };
  const f = await desktopFixture(async request => {
    if (request.action === 'google-start') return success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'poll-secret', expiresInSeconds: 600 });
    assert.equal(request.action, 'google-poll');
    polls++;
    if (polls === 1) throw new TypeError('Temporary connection failure');
    if (polls === 2) return Response.json({ ok: false, error: { code: 'STORAGE_RATE_LIMITED', message: 'Retry later' } }, { status: 503 });
    // The backend has committed the completed session; its response was lost.
    if (polls === 3) return Response.json({ ok: false, error: { code: 'STORAGE_WRITE_UNCERTAIN', message: 'Response lost' } }, { status: 503 });
    return success(completed);
  });
  const state = await f.client.loginWithGoogle(f.open);
  assert.equal(state.authenticated, true); assert.equal(f.saved().token, completed.token);
  assert.deepEqual(f.delays, [4000, 4000, 4000]);
  assert.equal(f.calls.filter(value => value.action === 'google-start').length, 1);
  assert.equal(f.calls.some(value => value.action === 'google-cancel'), false);
  const requests = f.calls.filter(value => value.action === 'google-poll');
  assert.equal(new Set(requests.map(value => value.proof.nonce)).size, requests.length, 'every retry has a fresh proof');
  assert.ok(requests.every(value => value.input.attemptId === 'attempt' && value.input.pollToken === 'poll-secret'));
});

test('desktop polling retry keeps the original deadline and stops on cancellation or terminal denial', async () => {
  const unavailable = () => Response.json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Retry later' } }, { status: 503 });
  const expired = await desktopFixture(async request => request.action === 'google-start'
    ? success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'poll-secret', expiresInSeconds: 5 }) : unavailable());
  await assert.rejects(expired.client.loginWithGoogle(expired.open), { code: 'GOOGLE_LOGIN_EXPIRED' });
  assert.equal(expired.calls.filter(value => value.action === 'google-poll').length, 2);
  assert.deepEqual(expired.delays, [4000, 1000]);
  assert.equal(expired.saved().token, null);

  const waiting = deferred();
  const cancelled = await desktopFixture(async request => request.action === 'google-start'
    ? success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'poll-secret' }) : unavailable(),
  { sleep: async () => { waiting.resolve(); return new Promise(() => {}); } });
  const login = cancelled.client.loginWithGoogle(cancelled.open); await waiting.promise;
  cancelled.client.cancelGoogleLogin();
  await assert.rejects(login, { code: 'GOOGLE_LOGIN_CANCELLED' });
  assert.equal(cancelled.calls.filter(value => value.action === 'google-poll').length, 1);

  const denied = await desktopFixture(async request => request.action === 'google-start'
    ? success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'poll-secret' })
    : Response.json({ ok: false, error: { code: 'GOOGLE_ATTEMPT_INVALID', message: 'Expired' } }, { status: 401 }));
  await assert.rejects(denied.client.loginWithGoogle(denied.open), { code: 'GOOGLE_ATTEMPT_INVALID' });
  assert.equal(denied.calls.filter(value => value.action === 'google-poll').length, 1);
  assert.deepEqual(denied.delays, []);
});

test('cancelling desktop Google login discards a late completed poll and requests remote revocation', async () => {
  const pending = deferred(), polling = deferred();
  const f = await desktopFixture(async request => {
    if (request.action === 'google-start') return success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'poll-secret' });
    polling.resolve(); await pending.promise; return success({ status: 'complete', token: 'stale-session', account });
  });
  const login = f.client.loginWithGoogle(f.open); await polling.promise;
  assert.equal(f.client.cancelGoogleLogin().cancelled, true);
  pending.resolve(); await assert.rejects(login, { code: 'GOOGLE_LOGIN_CANCELLED' }); await tick();
  assert.equal(f.saved().token, null); assert.equal(f.client.snapshot().authenticated, false);
  assert.ok(f.calls.some(value => value.action === 'google-cancel' && value.input.pollToken === 'poll-secret'));
});

test('cancellation while secure persistence is pending rolls the session back before returning', async () => {
  const saving = deferred(), releaseSave = deferred();
  const f = await desktopFixture(async request => request.action === 'google-start'
    ? success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'poll-secret' })
    : success({ status: 'complete', token: 'cancelled-session', account }));
  const save = f.store.save;
  f.store.save = async value => { if (value.token === 'cancelled-session') { saving.resolve(); await releaseSave.promise; } await save(value); };
  const login = f.client.loginWithGoogle(f.open); await saving.promise;
  f.client.cancelGoogleLogin(); releaseSave.resolve();
  await assert.rejects(login, { code: 'GOOGLE_LOGIN_CANCELLED' });
  assert.equal(f.saved().token, null); assert.equal(f.client.snapshot().authenticated, false);
  assert.ok(f.calls.some(value => value.action === 'logout'));
});

test('desktop Google timeout and forged URLs never produce a saved session', async () => {
  const timeout = await desktopFixture(async request => request.action === 'google-start'
    ? success({ authorizationUrl: AUTHORIZATION_URL, attemptId: 'attempt', pollToken: 'poll-secret', expiresInSeconds: 2 })
    : success({ status: 'pending' }));
  await assert.rejects(timeout.client.loginWithGoogle(timeout.open), { code: 'GOOGLE_LOGIN_EXPIRED' });
  assert.equal(timeout.saved().token, null);
  for (const url of ['https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'https://accounts.google.com/logout', 'http://accounts.google.com/o/oauth2/v2/auth', 'https://user@accounts.google.com/o/oauth2/v2/auth']) {
    assert.throws(() => validateGoogleAuthorizationUrl(url), { code: 'GOOGLE_LOGIN_INVALID' });
  }
  assert.equal(validateGoogleAuthorizationUrl(AUTHORIZATION_URL), AUTHORIZATION_URL);
});
