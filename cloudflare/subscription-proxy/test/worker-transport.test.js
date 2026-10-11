import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVlessRequest, createVlessResponseDecoder, workerWssEndpoint } from '../worker-transport.js';
import { proxyNode } from './fixtures.js';

test('VLESS TCP header precisely encodes UUID, destination port and hostname', () => {
  const header = buildVlessRequest('00112233-4455-6677-8899-aabbccddeeff', 'www.xiaohongshu.com');
  assert.deepEqual([...header.subarray(0, 23)], [0, 0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255, 0, 1, 1, 187, 2, 19]);
  assert.equal(new TextDecoder().decode(header.subarray(23)), 'www.xiaohongshu.com');
  assert.throws(() => buildVlessRequest('secret', 'www.xiaohongshu.com'), { code: 'VLESS_INPUT_REJECTED' });
  assert.throws(() => buildVlessRequest(proxyNode().uuid, '127.0.0.1'), { code: 'VLESS_INPUT_REJECTED' });
});

test('VLESS response header and addons can be fragmented at every byte', () => {
  const decoder = createVlessResponseDecoder();
  const outputs = [0, 3, 77, 78, 79, 22, 3, 3].map((byte) => decoder.push(Uint8Array.of(byte)));
  decoder.finish();
  assert.deepEqual(outputs.flatMap((value) => [...value]), [22, 3, 3]);
});

test('VLESS payload in first message, subsequent records, and truncation are distinguished', () => {
  const decoder = createVlessResponseDecoder();
  assert.deepEqual([...decoder.push(Uint8Array.of(0, 0, 22, 3, 3))], [22, 3, 3]);
  assert.deepEqual([...decoder.push(Uint8Array.of(4, 5))], [4, 5]);
  assert.throws(() => createVlessResponseDecoder().push(Uint8Array.of(1, 0)), { code: 'VLESS_VERSION_REJECTED' });
  const truncated = createVlessResponseDecoder(); truncated.push(Uint8Array.of(0, 3, 1));
  assert.throws(() => truncated.finish(), { code: 'VLESS_TRUNCATED_RESPONSE' });
});

test('verified WSS hostname route explicitly reports loss of preferred entry IP selection', () => {
  const node = proxyNode(); node.servername = 'ws.example.com';
  const endpoint = workerWssEndpoint(node);
  assert.equal(endpoint.url.hostname, 'ws.example.com');
  assert.equal(endpoint.entrySelectionPreserved, false);
  node.server = 'ws.example.com';
  assert.equal(workerWssEndpoint(node).entrySelectionPreserved, true);
  node.servername = 'another.example.com';
  assert.throws(() => workerWssEndpoint(node), { code: 'VLESS_WSS_ENDPOINT_REJECTED' });
});

test('WSS rejects unchecked TLS, Host injection and URL authority confusion', () => {
  assert.throws(() => workerWssEndpoint(proxyNode(1, { 'skip-cert-verify': true })), { code: 'VLESS_NODE_REJECTED' });
  const node = proxyNode(1, { servername: 'ws.example.com' });
  node['ws-opts'].headers.Host = 'ws.example.com\r\nSecret: x';
  assert.throws(() => workerWssEndpoint(node), { code: 'VLESS_WSS_ENDPOINT_REJECTED' });
  node['ws-opts'] = { path: '//evil.example/x', headers: { Host: 'ws.example.com' } };
  // A path beginning // stays a path because it is appended after a validated authority.
  assert.equal(workerWssEndpoint(node).url.hostname, 'ws.example.com');
});
