import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChecks, parseArgs, runSmoke } from '../scripts/verify-cloudflare.mjs';
import { createAccountHandler } from '../api/account.js';

const baseUrl = 'https://deployment.example.test';

test('all account smoke cases are rejected before reading configuration or invoking account service', async () => {
  const accountChecks = buildChecks().filter(check => check.path === '/api/account');
  assert.equal(accountChecks.length, 5);
  const handler = createAccountHandler({
    env: new Proxy({}, { get() { assert.fail('Smoke request reached account configuration'); } }),
    service: { execute() { assert.fail('Smoke request reached account service'); } },
  });
  for (const check of accountChecks) {
    let body;
    const headers = new Headers();
    const res = { statusCode: 200, setHeader(key, value) { headers.set(key, value); }, status(code) { this.statusCode = code; return this; }, json(value) { body = value; return this; } };
    await handler({ method: check.init.method || 'GET', headers: check.init.headers || {}, body: check.init.body }, res);
    check.verify({ status: res.statusCode, headers, text: JSON.stringify(body) });
  }
});

test('the default plan has no authorization, cookies, mail or successful account actions', () => {
  const checks = buildChecks();
  for (const check of checks) {
    assert.match(check.path, /^\/(?!\/)/);
    const headers = new Headers(check.init.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.doesNotMatch(check.init.body || '', /send-code|verify-code|admin-|feedback-|redeem|logout/);
    assert.ok(!check.name.includes('/upstream/'));
  }
});

test('rejects credential-bearing origins and unsafe optional media arguments without echoing input', () => {
  for (const args of [
    ['https://user:DO_NOT_PRINT@example.test'],
    ['https://example.test?token=DO_NOT_PRINT'],
    ['--note-url', 'https://example.test/DO_NOT_PRINT'],
    ['--image-token', '../DO_NOT_PRINT'],
    ['--video-url', 'https://xhscdn.com.evil.test/DO_NOT_PRINT'],
  ]) {
    assert.throws(() => parseArgs(args), error => !error.message.includes('DO_NOT_PRINT'));
  }
  assert.equal(parseArgs(['http://127.0.0.1:8787']).baseUrl, 'http://127.0.0.1:8787');
});

test('only explicitly supplied real media is requested and video chunks are bounded', () => {
  const options = parseArgs([baseUrl, '--video-url', 'https://sns-video-bd.xhscdn.com/example.mp4']);
  const upstream = buildChecks(options).filter(check => check.name.includes('/upstream/'));
  assert.equal(upstream.length, 4);
  for (const check of upstream.filter(check => check.name.endsWith('video-chunk'))) {
    const url = new URL(check.path, baseUrl);
    assert.equal(url.searchParams.get('start'), '0');
    assert.equal(url.searchParams.get('end'), '4095');
    assert.equal(check.maxBytes, 4096);
  }
});

test('foreign redirects are never followed and thrown fetch messages are redacted', async () => {
  const seen = [];
  const checks = [
    { name: 'redirect', path: '/', init: {}, allowRedirect: true, verify() { assert.fail('Should reject redirect'); } },
    { name: 'network', path: '/api/parse', init: {}, verify() { assert.fail('Should reject network failure'); } },
  ];
  const report = await runSmoke({ baseUrl }, { checks, fetchImpl: async (url, init) => {
    seen.push(url.href);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    if (url.pathname === '/') return new Response(null, { status: 302, headers: { location: 'https://DO_NOT_PRINT.example.test/token' } });
    throw new Error('DO_NOT_PRINT secret request details');
  } });
  assert.equal(seen.length, 2);
  assert.equal(report.passed, 0);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT|secret request/);
  assert.match(report.results[0].reason, /origin/);
});

test('oversized streaming responses are canceled and omitted from reports', async () => {
  let canceled = false;
  const report = await runSmoke({ baseUrl }, {
    checks: [{ name: 'bounded-media', path: '/', init: {}, maxBytes: 16, verify() { assert.fail('Oversize reached validator'); } }],
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('DO_NOT_PRINT_RESPONSE_BODY')); },
      cancel() { canceled = true; },
    })),
  });
  assert.equal(canceled, true);
  assert.equal(report.passed, 0);
  assert.equal(report.results[0].reason, 'Response exceeded byte limit.');
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT_RESPONSE_BODY/);
});

test('timeouts include a bounded failure and execution continues to the next check', async () => {
  const report = await runSmoke({ baseUrl }, {
    timeoutMs: 10,
    checks: [
      { name: 'timeout', path: '/slow', init: {}, verify() { assert.fail('Timeout reached validator'); } },
      { name: 'next', path: '/next', init: {}, verify(response) { assert.equal(response.status, 200); } },
    ],
    fetchImpl: (url, { signal }) => url.pathname === '/slow'
      ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('internal details')), { once: true }))
      : Promise.resolve(new Response('ok')),
  });
  assert.equal(report.passed, 1);
  assert.equal(report.results[0].reason, 'Request failed or timed out.');
  assert.equal(report.results[1].ok, true);
});
