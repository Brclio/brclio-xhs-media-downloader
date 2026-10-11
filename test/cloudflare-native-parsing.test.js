import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../cloudflare/worker.js';
import { ParseRuntime } from '../cloudflare/parse-runtime.js';

const legacyEnvironment = { XHS_PARSE_FALLBACK_ORIGIN: 'https://xhs-images-video-vercel-downloader.vercel.app' };
const request = path => new Request(`https://fixture.example.test${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'https://xhslink.cn/o/fixture' }),
});

test('gateway preserves native parse failures without retrying an external backend', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('parse failure reached an external backend'));
  for (const status of [400, 403, 408, 422, 429, 500, 502, 503, 504]) {
    const nativeBody = { success: false, engine: 'node', message: 'native error fixture' };
    let nodeCalls = 0;
    const gateway = createWorker({ nodeRoutes: { '/api/parse': (_req, res) => {
      nodeCalls++;
      return res.status(status).json(nativeBody);
    } } });
    const node = await gateway.fetch(request('/api/parse'), legacyEnvironment);
    assert.equal(node.status, status);
    assert.deepEqual(await node.json(), nativeBody);
    assert.equal(nodeCalls, 1);
    assert.equal(node.headers.get('x-xhs-parse-backend'), null);

    const pythonBody = { ...nativeBody, engine: 'python' };
    let pythonCalls = 0;
    const python = await gateway.fetch(request('/api/python_parse'), {
      ...legacyEnvironment,
      PYTHON_API: { fetch() { pythonCalls++; return Response.json(pythonBody, { status }); } },
    });
    assert.equal(python.status, status);
    assert.deepEqual(await python.json(), pythonBody);
    assert.equal(pythonCalls, 1);
    assert.equal(python.headers.get('x-xhs-parse-backend'), null);
  }
});

test('gateway and ParseRuntime report missing or failed Python bindings without an external retry', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Python binding failure reached an external backend'));
  for (const pythonBinding of [undefined, { fetch: async () => { throw new Error('private binding failure'); } }]) {
    const env = { ...legacyEnvironment, PYTHON_API: pythonBinding };
    for (const runtime of [createWorker(), new ParseRuntime({}, env)]) {
      const response = await runtime.fetch(request('/api/python_parse'), env);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.engine, 'python');
      assert.equal(body.success, false);
      assert.ok(!JSON.stringify(body).includes('private binding failure'));
      assert.equal(response.headers.get('x-xhs-parse-backend'), null);
    }
  }
});
