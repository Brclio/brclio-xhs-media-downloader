import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_COOKIE, createAccountHandler } from '../api/account.js';
import { createStandaloneServer, createClientIp, createStandaloneMemberVideoHandler } from '../server/standalone/http.js';
import { createMediaRuntime } from '../server/standalone/media.js';
import { startStandalone } from '../server/standalone/start.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-server-'));
  const staticRoot = path.join(directory, 'dist-web');
  await mkdir(path.join(staticRoot, 'assets'), { recursive: true });
  await mkdir(path.join(staticRoot, 'admin'));
  await writeFile(path.join(staticRoot, 'index.html'), '<h1>Public website</h1>');
  await writeFile(path.join(staticRoot, 'feedback.html'), '<h1>Feedback</h1>');
  await writeFile(path.join(staticRoot, 'admin/index.html'), '<h1>Admin</h1>');
  await writeFile(path.join(staticRoot, 'assets/sample.svg'), '<svg/>');
  await writeFile(path.join(directory, 'private.svg'), 'PRIVATE ACCOUNT DATA');
  await writeFile(path.join(staticRoot, 'accounts.sqlite'), 'PRIVATE ACCOUNT DATA');
  await writeFile(path.join(staticRoot, 'assets/accounts.sqlite'), 'PRIVATE ACCOUNT DATA');
  await writeFile(path.join(staticRoot, 'assets/.env'), 'AUTH_SECRET=private');
  await symlink(path.join(directory, 'private.svg'), path.join(staticRoot, 'assets/link.svg'));
  await symlink(directory, path.join(staticRoot, 'assets/linked'));
  const runtime = await createStandaloneServer({ staticRoot, accountHandler: createAccountHandler({
    config: { siteOrigin: 'https://example.test' }, clientIp: req => req.clientIp,
    service: { async execute(input) { return { observed: input }; } },
  }), ...options });
  const address = await runtime.listen(0);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...runtime, directory, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

function rawRequest(port, target, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('standalone serves the public build, clean URLs, HEAD and secured admin page', async t => {
  const server = await fixture(t);
  for (const [target, expected] of [['/', 'Public website'], ['/feedback', 'Feedback'], ['/feedback.html', 'Feedback'], ['/assets/sample.svg', '<svg/>']]) {
    const response = await fetch(server.base + target);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(expected));
  }
  const admin = await fetch(server.base + '/admin/');
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('x-frame-options'), 'DENY');
  assert.equal(admin.headers.get('cache-control'), 'no-store');
  assert.match(admin.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const head = await fetch(server.base, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await fetch(server.base, { method: 'POST' })).status, 405);
});

test('standalone refuses private paths, traversal, dotfiles and all symlink components', async t => {
  const server = await fixture(t);
  for (const target of ['/server/auth/store.js', '/package.json', '/data/accounts.sqlite', '/accounts.sqlite', '/assets/accounts.sqlite', '/assets/.env', '/assets/%2eenv', '/assets/../private.svg', '/assets/%2e%2e/private.svg', '/assets%5c..%5cprivate.svg', '/assets/link.svg', '/assets/linked/private.svg', '/api/missing']) {
    const response = await rawRequest(server.port, target);
    assert.equal(response.status, 404, target);
    assert.doesNotMatch(response.text, /PRIVATE ACCOUNT DATA|AUTH_SECRET=private/);
  }
  assert.equal((await rawRequest(server.port, '/%ZZ')).status, 400);
  assert.equal((await rawRequest(server.port, '//example.test/')).status, 400);
});

test('HTTP account adapter preserves JSON validation, Origin checks and authoritative socket IP', async t => {
  const server = await fixture(t);
  const response = await fetch(server.base + '/api/account', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-forwarded-for': '198.51.100.3', 'x-vercel-forwarded-for': '198.51.100.4', 'cf-connecting-ip': '198.51.100.5',
  }, body: JSON.stringify({ action: 'feedback-list', input: { page: 1 } }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.observed.ip, '127.0.0.1');
  assert.equal(result.observed.action, 'feedback-list');
  assert.deepEqual(result.observed.input, { page: 1 });
  const forbidden = await fetch(server.base + '/api/account', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: JSON.stringify({ action: 'admin-status' }) });
  assert.equal(forbidden.status, 403);
  const admin = await fetch(server.base + '/api/account', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.test' }, body: JSON.stringify({ action: 'admin-status' }) });
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).observed.client, 'admin');
  const invalid = await fetch(server.base + '/api/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_JSON');
});

test('only configured reverse proxies may supply client IP, and trust stops at the nearest untrusted hop', () => {
  const request = (remote, forwarded) => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': forwarded } });
  const clientIp = createClientIp('127.0.0.1,10.0.0.0/8,::1');
  assert.equal(clientIp(request('203.0.113.1', '198.51.100.1')), '203.0.113.1');
  assert.equal(clientIp(request('::ffff:127.0.0.1', '198.51.100.1,10.0.0.7')), '198.51.100.1');
  assert.equal(clientIp(request('127.0.0.1', '192.0.2.99,198.51.100.1')), '198.51.100.1');
  assert.equal(clientIp(request('127.0.0.1', 'spoofed')), '127.0.0.1');
  assert.throws(() => createClientIp('true'), /SERVER_TRUST_PROXY/);
  assert.throws(() => createClientIp('127.0.0.1/33'), /SERVER_TRUST_PROXY/);
});

test('standalone enforces upload limits before dispatch and distinguishes liveness from storage readiness', async t => {
  const server = await fixture(t, { storageCheck: async () => { throw new Error('PRIVATE DB PATH'); } });
  assert.equal((await fetch(server.base + '/healthz')).status, 200);
  const readiness = await fetch(server.base + '/readyz');
  assert.equal(readiness.status, 503);
  assert.doesNotMatch(await readiness.text(), /PRIVATE DB PATH/);
  const oversized = await rawRequest(server.port, '/api/account', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1600001' } });
  assert.equal(oversized.status, 413);
  const parse = await fetch(server.base + '/api/parse', { method: 'POST', body: 'x'.repeat(16_385) });
  assert.equal(parse.status, 413);
});

test('slow request bodies time out and close the connection without consuming a request slot forever', async t => {
  const server = await fixture(t, { requestTimeoutMs: 50, maxRequests: 1 });
  const response = await rawRequest(server.port, '/api/account', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '100' } });
  assert.equal(response.status, 504);
  assert.equal(response.headers.connection, 'close');
  assert.equal((await fetch(server.base + '/healthz')).status, 200);
});

test('shutdown waits for an account transaction to settle after its HTTP response times out', async t => {
  let finishTransaction, committed = false;
  const pending = new Promise(resolve => { finishTransaction = resolve; });
  const server = await fixture(t, { requestTimeoutMs: 50,
    accountHandler: async (_request, response) => { await pending; committed = true; response.status(200).json({ ok: true }); } });
  const response = await fetch(server.base + '/api/account', { method: 'POST', body: '{}' });
  assert.equal(response.status, 504);
  await response.text();
  let stopped = false;
  const closing = server.close().then(() => { stopped = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(stopped, false, 'Closing the HTTP socket must not abandon an in-flight account mutation');
  } finally { finishTransaction(); await closing; }
  assert.equal(committed, true);
});

test('standalone startup rejects missing signing secrets and unknown storage drivers explicitly', async () => {
  await assert.rejects(startStandalone({ env: {} }), /AUTH_SECRET_PEPPER/);
  await assert.rejects(startStandalone({ env: { AUTH_SECRET_PEPPER: 'test-secret-'.repeat(4), AUTH_STORAGE_DRIVER: 'invalid' } }), /AUTH_STORAGE_DRIVER/);
});

test('invalid runtime settings are rejected before startup creates persistent storage', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-invalid-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const key of ['SERVER_MEDIA_TIMEOUT_MS', 'SERVER_NODE_CONCURRENCY', 'SERVER_PYTHON_CONCURRENCY', 'SERVER_REQUEST_TIMEOUT_MS', 'SERVER_MAX_REQUESTS', 'PORT']) {
    const sqlitePath = path.join(directory, `${key}.sqlite`);
    await assert.rejects(startStandalone({ env: { AUTH_SECRET_PEPPER: 'test-secret-'.repeat(4),
      AUTH_STORAGE_DRIVER: 'sqlite', AUTH_SQLITE_PATH: sqlitePath, [key]: 'invalid' } }), new RegExp(key));
    await assert.rejects(lstat(sqlitePath), error => error.code === 'ENOENT', `${key} must not create a database before validation`);
  }
});

test('startup refuses SQLite paths in public build sources and symlink aliases before creating data', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-private-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = path.join(directory, 'public-assets-alias');
  await symlink(path.join(root, 'assets'), alias);
  const filename = `standalone-private-test-${randomUUID()}.sqlite`;
  const paths = ['dist-web', 'public', 'assets', 'admin', 'cloudflare/pages/dist'].map(name => path.join(root, name, filename));
  paths.push(path.join(alias, filename));
  for (const sqlitePath of paths) {
    await assert.rejects(startStandalone({ env: {
      AUTH_SECRET_PEPPER: 'test-secret-'.repeat(4), AUTH_STORAGE_DRIVER: 'sqlite', AUTH_SQLITE_PATH: sqlitePath,
    } }), error => error.code === 'MIGRATION_PUBLIC_PATH', sqlitePath);
    await assert.rejects(lstat(sqlitePath), error => error.code === 'ENOENT', 'Startup must reject before creating a database');
  }
});

test('real Node and Python workers serve parse/image/video routes with existing handler semantics', async t => {
  const server = await fixture(t);
  for (const prefix of ['', 'python_']) {
    const parsed = await fetch(server.base + `/api/${prefix}parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'https://sns-webpic-qc.xhscdn.com/fixture-image-token' }) });
    assert.equal(parsed.status, 200);
    const result = await parsed.json();
    assert.equal(result.success, true);
    assert.equal(result.engine, prefix ? 'python' : 'node');
    assert.equal(result.images.length, 1);
    for (const route of ['image', 'video']) {
      const invalid = await fetch(server.base + `/api/${prefix}${route}?token=../secret&url=http://127.0.0.1/private`);
      assert.equal(invalid.status, 400, `${prefix}${route}`);
      assert.equal((await invalid.json()).success, false);
    }
  }
});

test('worker concurrency caps and hard timeouts stop stalled work', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pythonWorker = path.join(directory, 'slow.py');
  await writeFile(pythonWorker, 'import time\ntime.sleep(60)\n');
  const runtime = createMediaRuntime({ timeoutMs: 100, pythonConcurrency: 1, nodeConcurrency: 1, pythonWorker,
    nodeWorker: new URL('data:text/javascript,while(true){}') });
  t.after(() => runtime.close());
  const node = runtime.runNode('/api/parse', {});
  const python = runtime.runPython({ path: '/api/python_parse' });
  await assert.rejects(runtime.runNode('/api/parse', {}), error => error.code === 'SERVER_BUSY');
  await assert.rejects(runtime.runPython({ path: '/api/python_parse' }), error => error.code === 'SERVER_BUSY');
  await Promise.all([assert.rejects(node, error => error.status === 504), assert.rejects(python, error => error.status === 504)]);
});

test('real handlers preserve image/video bytes and range headers across both worker transports', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-binary-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodeWorker = path.join(directory, 'fixture.mjs');
  await writeFile(nodeWorker, `
    globalThis.fetch = async (url, options) => {
      const range = options.headers.range;
      const bytes = range === 'bytes=0-0' ? [0] : [0, 1, 254, 255];
      const response = new Response(new Uint8Array(bytes), { status: range ? 206 : 200, headers: {
        'content-type': range ? 'video/mp4' : 'image/jpeg', 'content-length': String(bytes.length),
        ...(range ? { 'content-range': range === 'bytes=0-0' ? 'bytes 0-0/4' : 'bytes 0-3/4' } : {})
      }});
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    await import(${JSON.stringify(new URL('../server/standalone/media-worker.mjs', import.meta.url).href)});
  `);
  const pythonWorker = path.join(directory, 'fixture.py');
  await writeFile(pythonWorker, `
import sys, io, runpy
from types import SimpleNamespace
from email.message import Message
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../', import.meta.url)))})
import api.python_image as image
import api.python_video as video
class Response(io.BytesIO):
    def __init__(self, request):
        self.url = request.full_url
        range = request.get_header('Range')
        data = bytes([0]) if range == 'bytes=0-0' else bytes([0,1,254,255])
        super().__init__(data)
        self.status = 206 if range else 200
        self.headers = Message()
        self.headers['Content-Type'] = 'video/mp4' if range else 'image/jpeg'
        self.headers['Content-Length'] = str(len(data))
        if range: self.headers['Content-Range'] = 'bytes 0-0/4' if range == 'bytes=0-0' else 'bytes 0-3/4'
    def geturl(self): return self.url
    def getcode(self): return self.status
image.urlopen = lambda request, **kwargs: Response(request)
video.build_opener = lambda *args: SimpleNamespace(open=lambda request, **kwargs: Response(request))
runpy.run_path(${JSON.stringify(fileURLToPath(new URL('../server/standalone/python-worker.py', import.meta.url)))}, run_name='__main__')
  `);
  const media = createMediaRuntime({ nodeWorker, pythonWorker });
  const server = await fixture(t, { media });
  for (const prefix of ['', 'python_']) {
    const image = await fetch(server.base + `/api/${prefix}image?token=fixture-image-token&name=image.jpg`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from([0, 1, 254, 255]));
    const target = `/api/${prefix}video?url=${encodeURIComponent('https://sns-video-bd.xhscdn.com/stream/fixture.mp4')}`;
    const meta = await fetch(server.base + target + '&action=meta');
    assert.equal(meta.status, 200);
    const metadata = await meta.json();
    assert.equal(metadata.size, 4);
    assert.equal(metadata.acceptRanges, true);
    const chunk = await fetch(server.base + target + '&action=chunk&start=0&end=3');
    assert.equal(chunk.status, 200);
    assert.equal(chunk.headers.get('content-range'), 'bytes 0-3/4');
    assert.deepEqual(Buffer.from(await chunk.arrayBuffer()), Buffer.from([0, 1, 254, 255]));
  }
});

test('Python subprocess receives no application credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-python-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pythonWorker = path.join(directory, 'environment.py');
  await writeFile(pythonWorker, 'import os,json,base64\nprint(json.dumps({"status":200,"headers":{},"body":base64.b64encode(json.dumps({"secret":os.environ.get("AUTH_SECRET_PEPPER")}).encode()).decode()}))\n');
  const before = process.env.AUTH_SECRET_PEPPER;
  process.env.AUTH_SECRET_PEPPER = 'PRIVATE_APPLICATION_SECRET';
  t.after(() => { if (before === undefined) delete process.env.AUTH_SECRET_PEPPER; else process.env.AUTH_SECRET_PEPPER = before; });
  const runtime = createMediaRuntime({ pythonWorker });
  t.after(() => runtime.close());
  const result = await runtime.runPython({ path: '/api/python_parse' });
  assert.deepEqual(JSON.parse(result.body.toString()), { secret: null });
});

async function memberMediaFixture(t, { requestTimeoutMs = 500, timeoutMs = 10_000, maxRequests = 1 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-member-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodeWorker = path.join(directory, 'member-worker.mjs');
  const noteId = '1234567890abcdef12345678';
  const original = 'https://sns-video-bd.xhscdn.com/spectrum/member-runtime-original';
  const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: {
    noteId, title: 'Member fixture', video: { consumer: { originVideoKey: original } }, imageList: []
  } } })}</script>`;
  await writeFile(nodeWorker, `
    globalThis.fetch = async (url, options) => {
      if (String(url) === ${JSON.stringify(noteUrl)}) return new Response(${JSON.stringify(html)});
      if (String(url) === ${JSON.stringify(noteUrl + '?xsec_token=stalled')}) {
        setInterval(() => {}, 1000);
        return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
      }
      if (String(url) !== ${JSON.stringify(original)}) throw new Error('Unexpected fixture destination');
      const metadata = options.headers.range === 'bytes=0-0';
      // A completed header response followed by a body that never produces bytes.
      // The interval keeps the stalled isolate alive until runtime termination.
      if (!metadata) setInterval(() => {}, 1000);
      return new Response(metadata ? new Uint8Array([0]) : new ReadableStream({ pull() { return new Promise(() => {}); } }), {
        status: 206, headers: { 'content-type': 'video/mp4', 'content-length': metadata ? '1' : '4',
          'content-range': metadata ? 'bytes 0-0/4' : 'bytes 0-3/4' }
      });
    };
    await import(${JSON.stringify(new URL('../server/standalone/media-worker.mjs', import.meta.url).href)});
  `);
  const media = createMediaRuntime({ nodeWorker, nodeConcurrency: 1, timeoutMs });
  let transportStarted, resolutionStarted;
  const runNode = media.runNode;
  media.runNode = (route, request, signal) => {
    if (route === '/internal/member-video-download') transportStarted?.();
    if (route === '/internal/member-video-resolve') resolutionStarted?.();
    return runNode(route, request, signal);
  };
  const env = { AUTH_SECRET_PEPPER: 'fixture-secret-'.repeat(4), AUTH_SITE_ORIGIN: 'https://example.test' };
  const accountHandler = createAccountHandler({ config: { siteOrigin: env.AUTH_SITE_ORIGIN }, clientIp: req => req.clientIp,
    service: { async execute(request) {
      assert.equal(request.action, 'authorize');
      assert.equal(request.input.feature, 'watermark-free-video');
      assert.equal(request.client, 'browser');
      return { authorized: true, account: { user: { id: 'fixture-member' } } };
    } } });
  const server = await fixture(t, { accountHandler, media,
    memberVideoHandler: createStandaloneMemberVideoHandler({ env, accountHandler, media }), requestTimeoutMs, maxRequests });
  const headers = { cookie: `${BROWSER_COOKIE}=fixture-browser-session`, 'content-type': 'application/json' };
  const parsed = await fetch(server.base + '/api/member_video', { method: 'POST', headers, body: JSON.stringify({ text: noteUrl }) });
  assert.equal(parsed.status, 200);
  const note = await parsed.json();
  assert.equal(JSON.stringify(note).includes(original), false, 'Worker resolution must still return encrypted, account-bound URLs');
  const ticket = note.videos[0].url.slice('member-video:'.length);
  return { ...server, headers, original, noteUrl,
    chunk: `/api/member_video?ticket=${ticket}&action=chunk&start=0&end=3`,
    metadata: `/api/member_video?ticket=${ticket}&action=meta`,
    nextTransport: () => new Promise(resolve => { transportStarted = resolve; }),
    nextResolution: () => new Promise(resolve => { resolutionStarted = resolve; }),
  };
}

async function waitForMediaCleanup(server, target) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await fetch(server.base + target, { headers: server.headers });
    if (response.status === 200) return response;
    assert.equal(response.status, 503, 'Only the temporary worker cleanup slot may remain busy');
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Cancelled media work did not release its request/worker slot');
}

test('member-video stalled bodies obey the HTTP deadline, release request slots and allow shutdown', async t => {
  const server = await memberMediaFixture(t);
  const stalled = await fetch(server.base + server.chunk, { headers: server.headers });
  assert.equal(stalled.status, 504);
  await stalled.text();
  assert.equal((await waitForMediaCleanup(server, '/healthz')).status, 200);
  const chunk = await fetch(server.base + server.chunk.replace('end=3', 'end=0'), { headers: server.headers });
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get('content-type'), 'video/mp4');
  assert.equal(chunk.headers.get('content-range'), 'bytes 0-0/4');
  assert.deepEqual(Buffer.from(await chunk.arrayBuffer()), Buffer.from([0]), 'Authorized original bytes survive worker transport unchanged');
  // A default raw-video request still cannot use the trusted internal gateway route.
  const unauthorized = await fetch(server.base + `/api/video?url=${encodeURIComponent(server.original)}&action=meta`);
  assert.equal(unauthorized.status, 403);
  assert.equal((await fetch(server.base + '/internal/member-video-download')).status, 404);
  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started < 1000, 'Shutdown must not wait for the stalled CDN stream');
});

test('member resolution and downloads share the Node concurrency cap and hard media deadline', async t => {
  const server = await memberMediaFixture(t, { timeoutMs: 500, requestTimeoutMs: 3000, maxRequests: 4 });
  const started = server.nextTransport();
  const stalled = fetch(server.base + server.chunk, { headers: server.headers });
  await started;
  const competing = await fetch(server.base + server.metadata, { headers: server.headers });
  assert.equal(competing.status, 503, 'A second member media request cannot bypass the shared Node pool');
  assert.equal((await fetch(server.base + '/healthz')).status, 200);
  const timedOut = await stalled;
  assert.equal(timedOut.status, 504);
  await timedOut.text();
  const metadata = await waitForMediaCleanup(server, server.metadata);
  assert.equal((await metadata.json()).size, 4, 'Successful reads resume after worker termination');
});

test('disconnecting a member-video client cancels upstream work before the configured deadline', async t => {
  const server = await memberMediaFixture(t, { requestTimeoutMs: 10_000, timeoutMs: 10_000 });
  const controller = new AbortController();
  const started = server.nextTransport();
  const pending = fetch(server.base + server.chunk, { headers: server.headers, signal: controller.signal }).catch(error => error);
  await started;
  controller.abort();
  assert.equal((await pending).name, 'AbortError');
  const before = Date.now();
  const metadata = await waitForMediaCleanup(server, server.metadata);
  assert.equal((await metadata.json()).size, 4);
  assert.ok(Date.now() - before < 1000, 'Client disconnect must release work before the ten-second deadline');
});

test('a stalled member note page is bounded by the same media deadline and concurrency pool', async t => {
  const server = await memberMediaFixture(t, { timeoutMs: 500, requestTimeoutMs: 3000, maxRequests: 4 });
  const started = server.nextResolution();
  const pending = fetch(server.base + '/api/member_video', { method: 'POST', headers: server.headers,
    body: JSON.stringify({ text: server.noteUrl + '?xsec_token=stalled' }) });
  await started;
  const competing = await fetch(server.base + server.metadata, { headers: server.headers });
  assert.equal(competing.status, 503);
  assert.equal((await pending).status, 504);
  assert.equal((await (await waitForMediaCleanup(server, server.metadata)).json()).size, 4);
});
