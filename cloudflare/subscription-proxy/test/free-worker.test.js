import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { SubscriptionTransport } from '../free-worker.js';
import { LIMITS, ProxyError } from '../src/policy.js';
import { NOTE, MEDIA, SUBSCRIPTION } from './fixtures.js';

const request = (body, { path = '/fetch-note', headers = {}, ...options } = {}) => new Request(`https://proxy.example.com${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), ...options,
});
const noteBody = () => ({ url: NOTE, subscriptionUrl: SUBSCRIPTION });
function objectWith(service) { const object = new SubscriptionTransport({}); object.service = service; return object; }

test('worker accepts only its two POST routes and delegates to one fixed Durable Object', async () => {
  let forwarded, name, id;
  const env = { SUBSCRIPTION_TRANSPORT: { idFromName(value) { name = value; return 'fixed-id'; }, get(value) { id = value;
    return { fetch: async req => { forwarded = req; return new Response('ok'); } }; } } };
  const req = request(noteBody()); assert.equal(await (await worker.fetch(req, env)).text(), 'ok');
  assert.equal(forwarded, req); assert.equal(name, 'subscription-transport-v1'); assert.equal(id, 'fixed-id');
  for (const req of [new Request('https://proxy.example.com/fetch-note'), request({}, { path: '/fetch-anything' })]) {
    assert.equal((await worker.fetch(req, {})).status, 404);
  }
});

test('JSON content type, syntax, shape and 16KiB streamed body are checked before service calls', async () => {
  let calls = 0;
  const object = objectWith({ note: async () => { calls++; return { html: '<title>笔记</title>' }; } });
  for (const [req, status, error] of [
    [request('{}', { headers: { 'Content-Type': 'text/plain' } }), 415, 'JSON_REQUIRED'],
    [request('{invalid'), 400, 'INVALID_JSON'], [request('null'), 400, 'INVALID_JSON'],
    [request('[]'), 400, 'INVALID_JSON'], [request('1'), 400, 'INVALID_JSON'],
  ]) { const res = await object.fetch(req); assert.equal(res.status, status); assert.deepEqual(await res.json(), { code: error }); }
  const serialized = JSON.stringify({ ...noteBody(), padding: '' });
  const atLimit = JSON.stringify({ ...noteBody(), padding: 'x'.repeat(LIMITS.requestBytes - new TextEncoder().encode(serialized).length) });
  assert.equal(new TextEncoder().encode(atLimit).length, 16_384);
  assert.equal((await object.fetch(request(atLimit))).status, 200); assert.equal(calls, 1);
  const tooLarge = await object.fetch(request(atLimit + ' '));
  assert.equal(tooLarge.status, 413); assert.deepEqual(await tooLarge.json(), { code: 'REQUEST_TOO_LARGE' });
  assert.equal(calls, 1);
});

test('note and media envelopes use no-store and preserve only service result media headers', async () => {
  let noteInput, mediaInput;
  const object = objectWith({ note: async (body, options) => { noteInput = body; assert.ok(options.signal instanceof AbortSignal);
    return { html: '<title>笔记</title>', finalUrl: NOTE, nodeId: 'anonymous', latencyMs: 5 }; },
  media: async body => { mediaInput = body; return { status: 206, headers: new Headers({ 'Content-Type': 'video/mp4',
    'Content-Range': 'bytes 0-4/100', 'Cache-Control': 'no-store' }), body: new TextEncoder().encode('video') }; } });
  const note = await object.fetch(request(noteBody()));
  assert.equal(note.status, 200); assert.equal(note.headers.get('Cache-Control'), 'no-store');
  assert.equal(note.headers.get('X-Content-Type-Options'), 'nosniff'); assert.equal((await note.json()).nodeId, 'anonymous');
  assert.deepEqual(noteInput, noteBody());
  const media = await object.fetch(request({ ...noteBody(), url: MEDIA, range: 'bytes=0-4' }, { path: '/fetch-media' }));
  assert.equal(media.status, 206); assert.equal(media.headers.get('Content-Range'), 'bytes 0-4/100');
  assert.equal(media.headers.get('Cache-Control'), 'no-store'); assert.equal(await media.text(), 'video');
  assert.equal(mediaInput.range, 'bytes=0-4');
});

test('unknown exceptions and credentials are projected to fixed codes without raw details', async () => {
  const secret = 'https://user:private-password@node.example.com/private?token=private-token';
  for (const [exception, status, code] of [
    [new Error(secret), 502, 'PROXY_UNAVAILABLE'],
    [new DOMException(secret, 'TimeoutError'), 504, 'PROXY_TIMEOUT'],
    [new ProxyError('UPSTREAM_VERIFICATION_REQUIRED', 422), 422, 'UPSTREAM_VERIFICATION_REQUIRED'],
  ]) {
    const object = objectWith({ note: async () => { throw exception; } });
    const res = await object.fetch(request(noteBody())); const body = await res.text();
    assert.equal(res.status, status); assert.deepEqual(JSON.parse(body), { code });
    assert.ok(!body.includes('private-')); assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
});
