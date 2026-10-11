import test from 'node:test';
import assert from 'node:assert/strict';
import { HTTPResponseDecoder } from '../src/worker-http.js';

const bytes = (value) => new TextEncoder().encode(value);
test('content-length response supports every-byte fragmentation and strips private headers', () => {
  const decoder = new HTTPResponseDecoder(10);
  for (const byte of bytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/html\r\nSet-Cookie: secret\r\nServer: private\r\n\r\nhello')) decoder.push(Uint8Array.of(byte));
  const result = decoder.finish();
  assert.equal(result.status, 200); assert.equal(new TextDecoder().decode(result.body), 'hello');
  assert.equal(result.headers.get('set-cookie'), null); assert.equal(result.headers.get('server'), null);
});
test('chunked response handles split size/data/CRLF/trailers and leaves only decoded bytes', () => {
  const decoder = new HTTPResponseDecoder(20);
  for (const byte of bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;foo=bar\r\nabc\r\n2\r\nde\r\n0\r\nX-Trace: private\r\n\r\n')) decoder.push(Uint8Array.of(byte));
  assert.equal(new TextDecoder().decode(decoder.finish().body), 'abcde');
});
test('EOF framing and bodyless 204 use bounded unambiguous lengths', () => {
  const eof = new HTTPResponseDecoder(3); eof.push(bytes('HTTP/1.1 403 Forbidden\r\n\r\nabc'));
  assert.equal(eof.done, false); assert.equal(eof.finish().body.length, 3);
  const empty = new HTTPResponseDecoder(0); assert.equal(empty.push(bytes('HTTP/1.1 204 No Content\r\n\r\n')), true);
  assert.equal(empty.finish().body.length, 0);
});
for (const [label, response] of [
  ['CL+TE smuggling', 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n'],
  ['duplicate CL', 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na'],
  ['folded header', 'HTTP/1.1 200 OK\r\n x: private\r\n\r\n'],
  ['too large declared CL', 'HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n'],
  ['too large chunk', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\n'],
  ['wrong chunk CRLF', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX'],
  ['extra bytes', 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nab'],
  ['unsupported TE', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n'],
  ['header control', 'HTTP/1.1 200 OK\r\nX-A: \u0001\r\n\r\n'],
  ['204 body', 'HTTP/1.1 204 OK\r\nContent-Length: 1\r\n\r\na'],
]) test(`HTTP rejects ${label}`, () => assert.throws(() => new HTTPResponseDecoder(10).push(bytes(response)), { code: 'PROXY_HTTP_REJECTED' }));
test('truncated framed body or unfinished chunk is rejected at EOF', () => {
  for (const response of ['HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nab', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n']) {
    const decoder = new HTTPResponseDecoder(10); decoder.push(bytes(response));
    assert.throws(() => decoder.finish(), { code: 'PROXY_HTTP_REJECTED' });
  }
});
