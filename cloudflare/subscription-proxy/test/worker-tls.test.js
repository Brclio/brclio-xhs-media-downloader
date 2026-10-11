import test from 'node:test';
import assert from 'node:assert/strict';
import { workerFetchThroughVless } from '../worker-transport.js';
import { exactDNSMatch, verifyStrictCertificateChain } from '../src/worker-certificates.js';
import { NOTE, proxyNode } from './fixtures.js';

function harness(verifyChain) {
  const websocket = new EventTarget();
  const writes = [];
  websocket.closed = false; websocket.close = () => { websocket.closed = true; }; websocket.send = () => {};
  let options;
  const makeClient = (opts) => {
    options = opts;
    return {
      async startHandshake() { opts.write({ header: Uint8Array.of(22), content: Uint8Array.of(0) }); opts.onRecvCertificates({ certificates: [] }); opts.onHandshake(); },
      async write(data) {
        writes.push(new TextDecoder().decode(data));
        const body = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
        const frame = new Uint8Array(body.length + 2); frame.set(body, 2);
        websocket.dispatchEvent(new MessageEvent('message', { data: frame.buffer }));
      },
      async handleReceivedBytes(data) { opts.onApplicationData(data); },
    };
  };
  const node = proxyNode(1, { servername: 'ws.example.com' });
  const call = (extra = {}) => workerFetchThroughVless(node, NOTE, { openWebSocket: async () => websocket, makeClient, verifyChain, ...extra });
  return { websocket, writes, call, get options() { return options; } };
}

test('HTTP request waits for independent certificate validation while library verification remains true', async () => {
  let accept;
  const proof = new Promise((resolve) => { accept = resolve; });
  const h = harness(() => proof);
  const pending = h.call();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.writes.length, 0); assert.equal(h.options.verifyServerCertificate, true);
  assert.deepEqual(h.options.namedCurves, ['SECP256R1', 'SECP384R1']);
  accept(); const result = await pending;
  assert.equal(result.status, 200); assert.equal(new TextDecoder().decode(result.body), 'ok');
  assert.match(h.writes[0], /^GET \/explore\//); assert.match(h.writes[0], /Host: www.xiaohongshu.com\r\n/);
  assert.equal(h.websocket.closed, true);
});

test('certificate rejection closes WSS and sends no HTTP bytes or secrets', async () => {
  const h = harness(async () => { throw new Error('private-certificate-or-host'); });
  await assert.rejects(h.call(), { code: 'PROXY_TLS_CERTIFICATE_REJECTED' });
  assert.equal(h.writes.length, 0); assert.equal(h.websocket.closed, true);
  await assert.rejects(h.options.fetchCertificateBytes('http://169.254.169.254/secret'), /PROXY_TLS_INCOMPLETE_CHAIN/);
});

test('abort closes a verified-but-pending TLS connection without HTTP', async () => {
  const h = harness(() => new Promise(() => {}));
  const controller = new AbortController(), pending = h.call({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { code: 'PROXY_TIMEOUT' });
  assert.equal(h.websocket.closed, true); assert.equal(h.writes.length, 0);
});

test('TLS constructor failure immediately closes WSS and sanitizes the error', async () => {
  const h = harness(async () => {});
  await assert.rejects(h.call({ makeClient() { throw new Error('private-endpoint'); } }), { code: 'PROXY_TLS_FAILED' });
  assert.equal(h.websocket.closed, true);
});

test('strict DNS SAN match excludes CN fallback, wildcard apex and multi-label wildcard', async () => {
  assert.equal(exactDNSMatch('www.example.com', '*.example.com'), true);
  assert.equal(exactDNSMatch('example.com', '*.example.com'), false);
  assert.equal(exactDNSMatch('www.a.example.com', '*.example.com'), false);
  assert.equal(exactDNSMatch('www.example.com', 'www.*.com'), false);
  await assert.rejects(verifyStrictCertificateChain([{ internal: { rawData: new Uint8Array() }, getAlternativeDNSNames: () => ['other.example.com'], getSubjectField: () => ['www.example.com'] }], 'www.example.com'), /PROXY_TLS_CERTIFICATE_REJECTED/);
});

test('arbitrary targets and cookie/auth headers fail before opening a network connection', async () => {
  const node = proxyNode(1, { servername: 'ws.example.com' });
  let opens = 0;
  const options = { openWebSocket: async () => { opens++; throw new Error('must not open'); } };
  await assert.rejects(workerFetchThroughVless(node, 'https://private.example.com/', options), { code: 'PROXY_TARGET_REJECTED' });
  for (const headers of [{ Cookie: 'private' }, { Authorization: 'private' }, { Host: 'private.example.com' }, { Range: 'bytes=0-' }]) await assert.rejects(workerFetchThroughVless(node, NOTE, { ...options, headers }), { code: 'PROXY_HEADER_REJECTED' });
  assert.equal(opens, 0);
});
