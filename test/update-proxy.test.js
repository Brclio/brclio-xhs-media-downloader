import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateProxyNetwork, coreConfig, isUpdateUrl, lowestLatency, subscriptionNodes, subscriptionUrl, subscriptionUrls, UPDATE_HOSTS } from '../desktop/update-proxy.js';

const endpoint = 'https://updates.example.com/api/account';
const url = 'https://subscription.example.com/sub?token=test-private-value';
const nodes = [1, 2, 3].map(index => ({ name: `private label ${index}`, type: 'vless', server: `node${index}.example.com`, port: 443,
  uuid: 'fixture-id', tls: true, 'skip-cert-verify': true, 'dialer-proxy': 'anything', ca: '/private/file' }));
const yaml = JSON.stringify({ proxies: nodes, tun: { enable: true }, 'allow-lan': true, 'mixed-port': 80,
  dns: { listen: '0.0.0.0:53' }, 'external-controller': '0.0.0.0:90', rules: ['MATCH,DIRECT'], 'proxy-providers': { dangerous: { path: '/private/file' } } });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'update-proxy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDirectory = path.join(directory, 'runtime'), cacheDirectory = path.join(directory, 'cache');
  await mkdir(runtimeDirectory); await mkdir(cacheDirectory);
  await writeFile(path.join(runtimeDirectory, 'subscription.json'), JSON.stringify({ subscriptionUrl: url }));
  const sessions = [], requests = [], events = [], configs = [], children = [];
  const session = { fromPartition(partition, settings) {
    const value = { partition, settings, proxies: [], closeCount: 0, cleared: false,
      async setProxy(config) { this.proxies.push(config); },
      async closeAllConnections() { this.closeCount++; }, async clearStorageData() { this.cleared = true; } };
    sessions.push(value); return value;
  } };
  const updateStatus = options.updateStatus;
  const net = { request(options) {
    requests.push(options); const request = new EventEmitter();
    request.abort = () => {};
    request.end = () => queueMicrotask(() => {
      const incoming = Readable.from([Buffer.from('fixture update metadata')]);
      incoming.statusCode = updateStatus ? updateStatus(requests.length) : 200; incoming.headers = {};
      request.emit('response', incoming);
    }); return request;
  } };
  const directRequests = [];
  const direct = async (requestUrl, init) => {
    directRequests.push(requestUrl);
    if (requestUrl === endpoint) {
      if (options.registry) return options.registry(init);
      return Response.json({ ok: true, proxyConfig: { enabled: true, revision: 1, subscriptionUrl: url } });
    }
    if (new URL(requestUrl).hostname === 'subscription.example.com') return typeof options.subscription === 'function' ? options.subscription(requestUrl, init) : new Response(options.subscription ?? yaml);
    const parsed = new URL(requestUrl);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.match(init.headers.Authorization, /^Bearer [a-f\d]{64}$/);
    if (parsed.pathname === '/version') return Response.json({ version: 'fixture' });
    if (parsed.pathname.endsWith('/delay')) {
      if (options.probe) return options.probe(parsed.pathname, init);
      const latency = { 'node-001': 45, 'node-002': 12, 'node-003': 30 }[parsed.pathname.split('/')[2]];
      return Response.json({ delay: latency });
    }
    assert.equal(parsed.pathname, '/proxies/BRCLIO_UPDATE');
    assert.equal(init.method, 'PUT');
    events.push({ selected: JSON.parse(init.body).name });
    return new Response(null, { status: 204 });
  };
  const launchCore = (binary, directory, file) => {
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    child.stdin = { end() { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); } };
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
    children.push(child); configs.push(readFile(file, 'utf8').then(JSON.parse)); return child;
  };
  const network = new UpdateProxyNetwork({ net, session, endpoint, runtimeDirectory, cacheDirectory, fetchDirect: direct,
    launchCore, onDiagnostic: (event, data) => events.push({ event, data }) });
  return { network, cacheDirectory, runtimeDirectory, sessions, requests, events, configs, children, directRequests };
}

test('subscriptions yield only standalone nodes with TLS verification and no local file or chained dialer', () => {
  const parsed = subscriptionNodes(yaml);
  assert.deepEqual(parsed.map(node => node.name), ['node-001', 'node-002', 'node-003']);
  assert.ok(parsed.every(node => node['skip-cert-verify'] === false && !node.ca && !node['dialer-proxy']));
  const config = coreConfig(parsed, { proxyPort: 1234, controllerPort: 1235, secret: 'test' });
  assert.equal(config['allow-lan'], false); assert.equal(config['bind-address'], '127.0.0.1');
  assert.deepEqual(config.tun, { enable: false }); assert.deepEqual(config.dns, { enable: false });
  assert.equal(config['proxy-providers'], undefined);
  assert.equal(config.rules.at(-1), 'MATCH,REJECT');
  assert.ok(config.rules.slice(0, -1).every(rule => rule.includes('(DST-PORT,443)')));
  for (const malformed of ['proxies: [', 'proxies: &x [*x]', 'proxies: []', JSON.stringify({ proxies: [{ ...nodes[0], server: '127.0.0.1' }] }),
    JSON.stringify({ proxies: [{ ...nodes[0], type: 'direct' }] }), JSON.stringify({ proxies: [{ ...nodes[0], port: 65536 }] })]) {
    assert.throws(() => subscriptionNodes(malformed), { code: 'PROXY_SUBSCRIPTION_INVALID' });
  }
});

test('subscription and update URLs reject local, credentialed and foreign destinations', () => {
  assert.equal(subscriptionUrl(url), url);
  for (const value of ['http://public.example.com', 'https://localhost', 'https://10.0.0.1', 'https://2130706433', 'https://[::1]',
    'https://169.254.1.1', 'https://username:password@public.example.com', 'https://public.example.com/#fragment']) assert.throws(() => subscriptionUrl(value));
  for (const host of UPDATE_HOSTS) assert.ok(isUpdateUrl(`https://${host}/resource`));
  for (const value of ['https://github.com.evil.com', 'https://github.com:444', 'http://github.com', 'https://user@github.com', 'https://xiaohongshu.com']) assert.equal(isUpdateUrl(value), false);
});

test('plural subscriptions normalize and deduplicate, remain compatible with legacy and enforce the source limit', () => {
  assert.deepEqual(subscriptionUrls({ subscriptionUrl: url }), [url]);
  assert.deepEqual(subscriptionUrls({ subscriptionUrls: [` ${url} `, url], subscriptionUrl: 'https://ignored.example.com' }), [url]);
  assert.deepEqual(subscriptionUrls({ subscriptionUrls: [], subscriptionUrl: url }), []);
  for (const values of [null, url, [null], ['http://example.com'], Array(9).fill(url)]) {
    assert.throws(() => subscriptionUrls({ subscriptionUrls: values }), { code: 'PROXY_CONFIG_INVALID' });
  }
});

test('latency selection probes every node, excludes failures, caps concurrency and uses minimum successful latency', async () => {
  let active = 0, maximum = 0; const visited = [];
  const best = await lowestLatency(['a', 'b', 'c', 'd'], async name => {
    visited.push(name); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (name === 'b') throw new Error('offline');
    return { a: 30, c: 5, d: 50 }[name];
  }, { concurrency: 2 });
  assert.equal(best.name, 'c'); assert.equal(best.latency, 5); assert.equal(visited.length, 4); assert.equal(maximum, 2);
  await assert.rejects(lowestLatency(['a', 'b'], async () => NaN), { code: 'PROXY_NODES_UNAVAILABLE' });
  const controller = new AbortController();
  await assert.rejects(lowestLatency(['a', 'b'], async () => { controller.abort(new Error('stop')); return 1; }, { signal: controller.signal }), /stop/);
});

test('each update gets fresh config and subscription, the fastest proxy and complete cleanup', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const controller = new AbortController();
    await f.network.run(controller, async () => {
      const response = await f.network.fetch('https://api.github.com/zen', { signal: controller.signal });
      assert.equal(await response.text(), 'fixture update metadata');
      await assert.rejects(f.network.fetch('https://xiaohongshu.com', { signal: controller.signal }), { code: 'PROXY_DESTINATION_BLOCKED' });
      assert.equal(f.requests.at(-1).session, f.sessions[index]);
      assert.equal(f.sessions[index].proxies.at(-1).mode, 'fixed_servers');
    });
    assert.equal(f.network.active.size, 0); assert.equal(f.children[index].exitCode, 0);
    assert.equal(f.sessions[index].proxies.at(-1).mode, 'direct'); assert.equal(f.sessions[index].cleared, true);
    await assert.rejects(f.network.fetch('https://api.github.com/zen', { signal: controller.signal }), { code: 'PROXY_SCOPE_REQUIRED' });
  }
  assert.notEqual(f.sessions[0].partition, f.sessions[1].partition);
  assert.equal(f.directRequests.filter(value => value === endpoint).length, 2);
  assert.equal(f.directRequests.filter(value => value === url).length, 2);
  assert.equal(f.events.filter(value => value.selected === 'node-002').length, 2);
  assert.equal((await readdir(f.cacheDirectory)).filter(name => name.startsWith('proxy-')).length, 1, 'only proxy-config.json remains');
  assert.ok(!JSON.stringify(f.events).includes('test-private-value'));
});

test('admin disable overrides built-in and cached subscriptions, and persists across config outage', async t => {
  let offline = false;
  const f = await fixture(t, { registry: async () => {
    if (offline) throw new Error('offline');
    return Response.json({ ok: true, proxyConfig: { enabled: false, revision: 9, subscriptionUrl: '' } });
  } });
  await writeFile(path.join(f.cacheDirectory, 'proxy-config.json'), JSON.stringify({ enabled: true, revision: 8, subscriptionUrl: url }));
  await f.network.run(new AbortController(), async () => {});
  offline = true;
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.children.length, 0); assert.equal(f.directRequests.includes(url), false);
  assert.ok(f.sessions.every(value => value.proxies.every(config => config.mode === 'direct')));
});

test('unconfigured service ignores embedded URLs, unavailable service uses only administrator configuration', async t => {
  let unavailable = false;
  const f = await fixture(t, { registry: async () => {
    if (unavailable) throw new Error('offline');
    return Response.json({ ok: true, proxyConfig: { enabled: false, revision: 0, subscriptionUrl: '' } });
  } });
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.children.length, 0);
  assert.equal(f.directRequests.includes(url), false);
  await writeFile(path.join(f.cacheDirectory, 'proxy-config.json'), JSON.stringify({ enabled: true, revision: 4, subscriptionUrl: url }));
  unavailable = true;
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.children.length, 1);
});

test('failed nodes and canceled setup cannot run update work or leave a core or proxy session active', async t => {
  const f = await fixture(t, { probe: async () => { throw new Error('all offline'); } });
  await assert.rejects(f.network.run(new AbortController(), async () => assert.fail('work must not run')), { code: 'PROXY_NODES_UNAVAILABLE' });
  assert.equal(f.children[0].exitCode, 0); assert.equal(f.sessions[0].proxies.at(-1).mode, 'direct');
  const controller = new AbortController();
  const g = await fixture(t, { registry: init => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    queueMicrotask(() => controller.abort(new Error('canceled setup')));
  }) });
  await assert.rejects(g.network.run(controller, async () => assert.fail('work must not run')), /canceled setup/);
  assert.equal(g.network.active.size, 0); assert.equal(g.sessions[0].cleared, true);
});

test('parallel update/recovery operations have isolated sessions and work errors retain their original identity', async t => {
  const f = await fixture(t);
  const a = new AbortController(), b = new AbortController();
  let releaseA; const pending = new Promise(resolve => { releaseA = resolve; });
  let readyA; const ready = new Promise(resolve => { readyA = resolve; });
  const first = f.network.run(a, async () => { readyA(); await pending; });
  await ready;
  const original = Object.assign(new Error('checksum rejected'), { code: 'INVALID_CHECKSUM' });
  await assert.rejects(f.network.run(b, async () => { assert.equal(f.network.active.size, 2); throw original; }), error => error === original);
  assert.equal(f.network.active.size, 1); assert.equal(f.sessions[0].proxies.at(-1).mode, 'fixed_servers');
  releaseA(); await first; assert.equal(f.network.active.size, 0);
});

test('a late old response cannot overwrite an administrator disable during concurrent lookups or later outage', async t => {
  let firstResponse, count = 0, offline = false;
  const f = await fixture(t, { registry: () => {
    if (offline) throw new Error('outage');
    if (++count === 1) return new Promise(resolve => { firstResponse = resolve; });
    return Response.json({ ok: true, proxyConfig: { enabled: false, revision: 2, subscriptionUrl: '' } });
  } });
  const first = f.network.getConfiguration(f.network.fetchDirect, new AbortController().signal);
  while (!firstResponse) await new Promise(resolve => setImmediate(resolve));
  const latest = await f.network.getConfiguration(f.network.fetchDirect, new AbortController().signal);
  firstResponse(Response.json({ ok: true, proxyConfig: { enabled: true, revision: 1, subscriptionUrl: url } }));
  assert.equal(latest.enabled, false);
  assert.equal((await first).revision, 2);
  offline = true;
  const fallback = await f.network.getConfiguration(f.network.fetchDirect, new AbortController().signal);
  assert.equal(fallback.revision, 2); assert.equal(fallback.enabled, false);
  const disk = JSON.parse(await readFile(path.join(f.cacheDirectory, 'proxy-config.json'), 'utf8'));
  assert.equal(disk.revision, 2); assert.equal(disk.enabled, false);
});

test('a cache write failure still honors the freshly fetched disabled config and retains it in memory', async t => {
  const f = await fixture(t, { registry: () => Response.json({ ok: true, proxyConfig: { enabled: false, revision: 3, subscriptionUrl: '' } }) });
  await mkdir(path.join(f.cacheDirectory, 'proxy-config.json'));
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.children.length, 0);
  assert.equal(f.network.lastConfig.revision, 3);
  assert.ok(f.events.some(value => value.event === 'update.proxy_config_cache_failed'));
});

test('subscription redirects are bounded and independently validate HTTPS targets before fetching them', async t => {
  const f = await fixture(t, { subscription: requestUrl => new URL(requestUrl).pathname === '/sub'
    ? new Response(null, { status: 302, headers: { location: '/latest.yaml' } }) : new Response(yaml) });
  await f.network.run(new AbortController(), async () => {});
  assert.ok(f.directRequests.includes('https://subscription.example.com/latest.yaml'));
  const g = await fixture(t, { subscription: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }) });
  await assert.rejects(g.network.run(new AbortController(), async () => {}), { code: 'PROXY_FETCH_FAILED' });
  assert.equal(g.directRequests.some(value => value.includes('/secret')), false);
});

test('a rate limited fastest node retries through the remaining measured latency order', async t => {
  const f = await fixture(t, { updateStatus: count => count < 3 ? 403 : 200 });
  const controller = new AbortController();
  await f.network.run(controller, async () => {
    const response = await f.network.fetch('https://api.github.com/zen', { signal: controller.signal });
    assert.equal(response.status, 200); assert.equal(await response.text(), 'fixture update metadata');
  });
  assert.deepEqual(f.events.filter(value => value.selected).map(value => value.selected), ['node-002', 'node-003', 'node-001']);
  assert.equal(f.requests.length, 3); assert.equal(f.network.active.size, 0);
});

test('fresh plural sources merge and deduplicate nodes before choosing the fastest across providers', async t => {
  const second = 'https://subscription.example.com/second?token=second-private-value';
  const f = await fixture(t, { registry: () => Response.json({ ok: true, proxyConfig: {
    enabled: true, revision: 7, subscriptionUrls: [url, second], subscriptionUrl: url } }),
  subscription: requestUrl => new Response(requestUrl === second ? JSON.stringify({ proxies: [nodes[1], { ...nodes[0], server: 'new.example.com' }] }) : yaml),
  probe: pathname => Response.json({ delay: pathname.includes('node-004') ? 1 : 20 }) });
  for (let attempt = 0; attempt < 2; attempt++) await f.network.run(new AbortController(), async () => {});
  const configs = await Promise.all(f.configs);
  assert.ok(configs.every(config => config.proxies.length === 4));
  assert.deepEqual(configs[0].proxies.map(node => node.name), ['node-001', 'node-002', 'node-003', 'node-004']);
  assert.equal(f.events.filter(event => event.selected === 'node-004').length, 2);
  for (const source of [url, second]) assert.equal(f.directRequests.filter(request => request === source).length, 2);
  assert.equal(f.network.active.size, 0);
  assert.ok(!JSON.stringify(f.events).includes('private-value'));
});

test('one failed plural source cannot discard healthy nodes; all failed sources stop before updater work', async t => {
  const second = 'https://subscription.example.com/second';
  const registry = () => Response.json({ ok: true, proxyConfig: { enabled: true, revision: 1, subscriptionUrls: [url, second] } });
  const f = await fixture(t, { registry, subscription: requestUrl => requestUrl === url
    ? new Response(null, { status: 503 }) : new Response(yaml) });
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.children.length, 1);
  assert.ok(f.events.some(event => event.event === 'update.proxy_subscriptions_refreshed'
    && event.data.sources === 2 && event.data.available === 1 && event.data.nodes === 3));
  const g = await fixture(t, { registry, subscription: () => new Response('invalid document') });
  await assert.rejects(g.network.run(new AbortController(), async () => assert.fail('unavailable subscriptions cannot start work')),
    { code: 'PROXY_SUBSCRIPTION_INVALID' });
  assert.equal(g.children.length, 0); assert.equal(g.network.active.size, 0);
  assert.equal(g.sessions[0].proxies.at(-1).mode, 'direct');
});

test('a subscription timeout with a numeric DOMException code is safely classified and cleaned up', async t => {
  const f = await fixture(t, { subscription: () => { throw new DOMException('private transport detail', 'TimeoutError'); } });
  await assert.rejects(f.network.run(new AbortController(), async () => assert.fail('timed-out setup cannot start work')),
    { code: 'PROXY_START_FAILED' });
  assert.equal(f.network.active.size, 0); assert.equal(f.children.length, 0);
  assert.equal(f.sessions[0].proxies.at(-1).mode, 'direct');
  assert.ok(!JSON.stringify(f.events).includes('private transport detail'));
});

test('plural embedded URLs are ignored, and the saved administrator replacement persists through an outage', async t => {
  const second = 'https://subscription.example.com/second';
  let config = { enabled: false, revision: 0, subscriptionUrls: [] }, offline = false;
  const f = await fixture(t, { registry: () => {
    if (offline) throw new Error('offline');
    return Response.json({ ok: true, proxyConfig: config });
  } });
  await writeFile(path.join(f.runtimeDirectory, 'subscription.json'), JSON.stringify({ subscriptionUrls: [url, second] }));
  assert.deepEqual((await f.network.getConfiguration(f.network.fetchDirect, new AbortController().signal)).subscriptionUrls, []);
  config = { enabled: true, revision: 2, subscriptionUrls: [second] };
  await f.network.getConfiguration(f.network.fetchDirect, new AbortController().signal);
  offline = true;
  assert.deepEqual((await f.network.getConfiguration(f.network.fetchDirect, new AbortController().signal)).subscriptionUrls, [second]);
});

test('a fresh installation with an unavailable backend never activates an old bundled subscription', async t => {
  const f = await fixture(t, { registry: () => { throw new Error('backend unavailable'); } });
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.children.length, 0); assert.equal(f.directRequests.includes(url), false);
  assert.ok(f.sessions[0].proxies.every(configuration => configuration.mode === 'direct'));
});
