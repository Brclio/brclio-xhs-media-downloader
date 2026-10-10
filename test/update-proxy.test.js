import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateProxyNetwork, coreConfig, isUpdateUrl, lowestLatency, subscriptionNodes, subscriptionUrl, subscriptionUrls, UPDATE_HOSTS } from '../desktop/update-proxy.js';
import { UpdateManager, LATEST_RELEASE_URL } from '../desktop/update-manager.js';

const endpoint = 'https://updates.example.com/api/account';
const url = 'https://subscription.example.com/sub?token=test-private-value';
const nodes = [1, 2, 3].map(index => ({ name: `private label ${index}`, type: 'vless', server: `node${index}.example.com`, port: 443,
  uuid: 'fixture-id', tls: true, 'skip-cert-verify': true, 'dialer-proxy': 'anything', ca: '/private/file' }));
const yaml = JSON.stringify({ proxies: nodes, tun: { enable: true }, 'allow-lan': true, 'mixed-port': 80,
  dns: { listen: '0.0.0.0:53' }, 'external-controller': '0.0.0.0:90', rules: ['MATCH,DIRECT'], 'proxy-providers': { dangerous: { path: '/private/file' } } });

function proxySelector(names) {
  return { name: 'BRCLIO_UPDATE', type: 'Selector', all: names };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'update-proxy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDirectory = path.join(directory, 'runtime'), cacheDirectory = path.join(directory, 'cache');
  await mkdir(runtimeDirectory); await mkdir(cacheDirectory);
  await writeFile(path.join(runtimeDirectory, 'subscription.json'), JSON.stringify({ subscriptionUrl: url }));
  const sessions = [], requests = [], events = [], configs = [], children = [], states = [];
  const session = { fromPartition(partition, settings) {
    const value = { partition, settings, proxies: [], closeCount: 0, cleared: false,
      async setProxy(config) { this.proxies.push(config); },
      async resolveProxy(target) { return typeof options.resolvedProxy === 'function' ? options.resolvedProxy(target) : options.resolvedProxy || 'DIRECT'; },
      async closeAllConnections() { this.closeCount++; }, async clearStorageData() { this.cleared = true; } };
    sessions.push(value); return value;
  } };
  const updateStatus = options.updateStatus;
  const net = { request(requestOptions) {
    requests.push(requestOptions); const request = new EventEmitter();
    request.abort = () => {};
    request.end = () => queueMicrotask(() => {
      const incoming = options.updateResponse ? options.updateResponse(requestOptions) : Readable.from([Buffer.from('fixture update metadata')]);
      incoming.statusCode ??= updateStatus ? updateStatus(requests.length) : 200; incoming.headers ??= {};
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
    if (parsed.pathname === '/proxies/BRCLIO_UPDATE' && init.method !== 'PUT') {
      const configuration = await configs.at(-1);
      const names = configuration.proxies.map(node => node.name);
      return options.inventory ? options.inventory(names, init) : Response.json(proxySelector(names));
    }
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
  const networkOptions = { net, session, endpoint, runtimeDirectory, cacheDirectory, fetchDirect: direct,
    launchCore, env: {}, platform: options.platform,
    ...(options.coreStartupTimeoutMs === undefined ? {} : { coreStartupTimeoutMs: options.coreStartupTimeoutMs }),
    configuredProxyDetector: async () => options.configuredProxy || false,
    onStateChange: state => states.push(state), onDiagnostic: (event, data) => events.push({ event, data }) };
  const network = new UpdateProxyNetwork(networkOptions);
  return { network, reloadNetwork: () => new UpdateProxyNetwork(networkOptions), cacheDirectory, runtimeDirectory,
    sessions, requests, events, configs, children, directRequests, states };
}

async function coldConfigurationDownload(t, options = {}) {
  const installer = Buffer.from('installer fixture for the first internal proxy configuration');
  const digest = createHash('sha256').update(installer).digest('hex');
  const name = 'Brclio-XHS-2.0.11-mac-arm64.dmg';
  const assetUrl = `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v2.0.11/${name}`;
  const release = { tag_name: 'v2.0.11', draft: false, prerelease: false,
    html_url: 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v2.0.11', body: '', published_at: '2026-10-09T00:00:00Z',
    assets: [{ name, size: installer.length, browser_download_url: assetUrl, digest: `sha256:${digest}` }] };
  let systemRoute = true;
  const states = [];
  const f = await fixture(t, { ...options, resolvedProxy: () => systemRoute ? 'PROXY localhost:7890' : 'DIRECT',
    updateResponse: request => {
      if (request.url === LATEST_RELEASE_URL) return Readable.from([Buffer.from(JSON.stringify(release))]);
      assert.equal(request.url, assetUrl);
      return options.updateResponse ? options.updateResponse(request) : Readable.from([installer]);
    } });
  const manager = new UpdateManager({ currentVersion: '2.0.10', platform: 'darwin', arch: 'arm64',
    directory: f.cacheDirectory, networkScope: f.network, fetchImpl: f.network.fetch, downloadRetryDelayMs: 0,
    onUpdate: state => { states.push(state); options.onUpdate?.(state); } });
  // A successful direct version check leaves no saved internal config.
  assert.equal((await manager.checkForUpdates()).status, 'available');
  assert.equal(f.directRequests.length, 0);
  systemRoute = false;
  return { ...f, manager, updateStates: states, installer, name, assetUrl };
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

for (const initialStatus of [404, 503]) test(`controller HTTP ${initialStatus} and partial selectors cannot race configured-node installation`, async t => {
  let inventories = 0, probes = 0;
  const f = await fixture(t, { inventory: names => {
    inventories++;
    if (inventories === 1) return new Response(null, { status: initialStatus });
    if (inventories === 2) return new Response('{incomplete JSON');
    const selector = proxySelector(names);
    if (inventories === 3) selector.name = 'GLOBAL';
    if (inventories === 4) selector.type = 'URLTest';
    if (inventories === 5) selector.all = names.slice(0, -1);
    if (inventories === 6) selector.all = names.map(() => names[0]);
    return Response.json(selector);
  }, probe: () => {
    probes++;
    assert.equal(inventories, 7, 'latency probes wait for every configured alias and exact selector membership');
    return Response.json({ delay: 1 });
  } });
  await f.network.run(new AbortController(), () => assert.equal(f.network.snapshot().mode, 'internal'));
  assert.equal(inventories, 7);
  assert.equal(probes, nodes.length);
  assert.equal(f.directRequests.some(url => new URL(url).pathname === '/version'), false,
    'a ready version endpoint does not establish loaded proxy configuration');
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.network.active.size, 0);
});

for (const stalled of ['responding', 'request', 'body']) {
  test(`incomplete ${stalled} controller inventory reaches the bounded startup deadline and cleans up`, { timeout: 2000 }, async t => {
    // The mocked core has no IO handles; retain one while unref'ed AbortSignal deadlines run.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    let requests = 0;
    const f = await fixture(t, { coreStartupTimeoutMs: 30, inventory: () => {
      requests++;
      if (stalled === 'request') return new Promise(() => {});
      if (stalled === 'body') return new Response(new ReadableStream({ start() {} }));
      return Response.json(proxySelector([]));
    }, probe: () => assert.fail('uninstalled nodes cannot be probed') });
    const started = Date.now();
    const controller = new AbortController();
    await assert.rejects(f.network.run(controller, () => assert.fail('unready core cannot run update work')),
      { code: 'PROXY_CORE_UNAVAILABLE' });
    assert.ok(Date.now() - started < 1000, 'the 30 ms startup budget does not wait for the normal seven-second controller timeout');
    assert.ok(requests > 0);
    assert.equal(controller.signal.aborted, false, 'core startup expiry is scoped to readiness requests');
    assert.equal(f.children[0].exitCode, 0);
    assert.equal(f.network.active.size, 0);
    assert.equal(f.sessions[0].cleared, true);
    assert.deepEqual((await readdir(f.cacheDirectory)).filter(name => name !== 'proxy-config.json'), []);
  });
}

test('manual stop aborts a stalled controller inventory before latency probes and removes the starting core', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { inventory: () => { entered(); return new Promise(() => {}); },
    probe: () => assert.fail('canceled core cannot probe nodes') });
  const controller = new AbortController();
  const operation = f.network.run(controller, () => assert.fail('canceled core cannot run update work'));
  const rejected = assert.rejects(operation, { code: 'CANCELED' });
  await ready;
  await f.network.stopInternalProxy();
  await rejected;
  assert.equal(controller.signal.reason.code, 'CANCELED');
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.network.active.size, 0);
  assert.equal(f.sessions[0].cleared, true);
  assert.deepEqual((await readdir(f.cacheDirectory)).filter(name => !['proxy-config.json', 'proxy-preference.json'].includes(name)), []);
});

test('internal selection is reported before preparation failures and only for an enabled internal route', async t => {
  let selected = 0;
  const failing = await fixture(t, { subscription: () => {
    assert.equal(selected, 1, 'download retry eligibility must be known before fetching subscriptions');
    return new Response(null, { status: 503 });
  } });
  await assert.rejects(failing.network.run(new AbortController(), () => assert.fail('failed preparation cannot run work'),
    { onInternalProxy: () => { selected++; } }), { code: 'PROXY_FETCH_FAILED' });
  assert.equal(selected, 1); assert.equal(failing.network.active.size, 0);
  assert.equal(failing.sessions[0].cleared, true);

  for (const route of ['system', 'disabled', 'manual']) {
    const f = await fixture(t, route === 'system' ? { resolvedProxy: 'PROXY localhost:7890' }
      : route === 'disabled' ? { registry: () => Response.json({ ok: true, proxyConfig: { enabled: false, revision: 1, subscriptionUrl: '' } }) } : {});
    if (route === 'manual') await f.network.stopInternalProxy();
    await f.network.run(new AbortController(), async () => {},
      { onInternalProxy: () => assert.fail(`${route} route must not enable automatic internal proxy retries`) });
    assert.equal(f.children.length, 0); assert.equal(f.network.active.size, 0);
  }
});

test('manual stop after internal selection cancels preparation and keeps the proxy disabled', async t => {
  const f = await fixture(t);
  let stopping, selections = 0;
  const controller = new AbortController();
  await assert.rejects(f.network.run(controller, () => assert.fail('manual stop cannot run work'), {
    onInternalProxy: () => { selections++; stopping = f.network.stopInternalProxy(); }
  }), { code: 'CANCELED' });
  await stopping;
  assert.equal(selections, 1); assert.equal(controller.signal.reason.code, 'CANCELED');
  assert.equal(f.children.length, 0); assert.equal(f.network.active.size, 0);
  assert.equal(f.sessions[0].cleared, true); assert.equal(f.network.snapshot().manuallyDisabled, true);
  await f.network.run(new AbortController(), async () => {},
    { onInternalProxy: () => assert.fail('automatic retry must respect the persisted manual stop') });
  assert.equal(f.children.length, 0);
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
  assert.ok(f.sessions.every(value => value.proxies.every(config => ['direct', 'system'].includes(config.mode))));
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
  let notified = 0;
  await assert.rejects(f.network.run(new AbortController(), () => assert.fail('unknown config cannot silently download directly'),
    { onInternalProxy: () => { notified++; } }), { code: 'PROXY_CONFIG_UNAVAILABLE' });
  assert.equal(notified, 1); assert.equal(f.network.snapshot().mode, 'error');
  assert.equal(f.children.length, 0); assert.equal(f.directRequests.includes(url), false);
  assert.ok(f.sessions[0].proxies.every(configuration => ['direct', 'system'].includes(configuration.mode)));
});

test('a first configuration outage retries until the real network and updater classes can download', async t => {
  let configurations = 0;
  const f = await coldConfigurationDownload(t, { registry: () => {
    if (++configurations <= 2) throw new Error('temporary first configuration outage');
    return Response.json({ ok: true, proxyConfig: { enabled: true, revision: 1, subscriptionUrl: url } });
  } });
  const state = await f.manager.downloadUpdate();
  assert.equal(state.status, 'downloaded'); assert.equal(state.retry, null);
  assert.equal(configurations, 3);
  const retries = f.updateStates.filter(value => value.retry?.active);
  assert.deepEqual([...new Set(retries.map(value => value.retry.consecutiveFailures))], [1, 2]);
  assert.ok(retries.every(value => value.retry.lastError.code === 'PROXY_CONFIG_UNAVAILABLE'));
  assert.equal(f.requests.filter(request => request.url === f.assetUrl).length, 1);
  assert.deepEqual(await readFile(path.join(f.cacheDirectory, f.name)), f.installer);
  assert.equal(f.network.active.size, 0); assert.ok(f.sessions.every(value => value.cleared));
  assert.ok(f.children.every(value => value.exitCode === 0));
  assert.equal(f.events.filter(value => value.event === 'update.proxy_manually_enabled').length, 2);
});

test('ten first-configuration failures wait for manual retry and the next round resets its counter', async t => {
  let offline = true, configurations = 0, failuresAfterManual = 0;
  const f = await coldConfigurationDownload(t, { registry: () => {
    configurations++;
    if (offline || failuresAfterManual-- > 0) throw new Error('configuration unavailable');
    return Response.json({ ok: true, proxyConfig: { enabled: true, revision: 1, subscriptionUrl: url } });
  } });
  const failed = await f.manager.downloadUpdate();
  assert.equal(configurations, 10); assert.equal(failed.status, 'error'); assert.equal(failed.canRetry, true);
  assert.equal(failed.error.code, 'PROXY_CONFIG_UNAVAILABLE'); assert.match(failed.error.message, /更新网络配置/);
  assert.equal(failed.retry.active, false); assert.equal(failed.retry.consecutiveFailures, 10);
  assert.equal(f.requests.filter(request => request.url === f.assetUrl).length, 0); assert.equal(f.children.length, 0);
  assert.equal(f.network.active.size, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(configurations, 10, 'configuration bootstrap must stay stopped until a user retry');
  offline = false; failuresAfterManual = 1; f.updateStates.length = 0;
  const resumed = await f.manager.downloadUpdate();
  assert.equal(resumed.status, 'downloaded'); assert.equal(resumed.retry, null); assert.equal(configurations, 12);
  assert.deepEqual([...new Set(f.updateStates.filter(value => value.retry?.active).map(value => value.retry.consecutiveFailures))], [1]);
  assert.equal(f.requests.filter(request => request.url === f.assetUrl).length, 1);
  assert.deepEqual(await readFile(path.join(f.cacheDirectory, f.name)), f.installer);
  assert.equal(f.events.filter(value => value.event === 'update.proxy_manually_enabled').length, 3);
  assert.equal(f.network.active.size, 0); assert.ok(f.sessions.every(value => value.cleared));
});

test('an actual unwritable proxy cache reports cache permissions without retrying setup', async t => {
  let configurations = 0;
  const f = await coldConfigurationDownload(t, { registry: () => {
    configurations++;
    return Response.json({ ok: true, proxyConfig: { enabled: true, revision: 1, subscriptionUrl: url } });
  } });
  await chmod(f.cacheDirectory, 0o500);
  try {
    let probe;
    try { probe = await mkdtemp(path.join(f.cacheDirectory, 'permission-probe-')); }
    catch (error) { assert.ok(['EACCES', 'EPERM'].includes(error.code)); }
    if (probe) {
      await rm(probe, { recursive: true });
      t.skip('this filesystem or user does not enforce the fixture directory permissions');
      return;
    }
    const failed = await f.manager.downloadUpdate();
    assert.equal(failed.status, 'error'); assert.equal(failed.error.code, 'CACHE_PERMISSION');
    assert.match(failed.error.message, /缓存.*权限/); assert.equal(failed.retry, null); assert.equal(failed.canRetry, true);
    assert.equal(configurations, 1); assert.equal(f.children.length, 0);
    assert.equal(f.requests.filter(request => request.url === f.assetUrl).length, 0);
    assert.equal(f.updateStates.some(value => value.retry?.active), false);
    assert.equal(f.network.active.size, 0); assert.ok(f.sessions.every(value => value.cleared));
  } finally { await chmod(f.cacheDirectory, 0o700); }
});

for (const [label, proxyConfig] of [
  ['unsafe subscription', { enabled: true, revision: 1, subscriptionUrl: 'https://127.0.0.1/sub' }],
  ['missing subscription', { enabled: true, revision: 1, subscriptionUrl: '' }],
  ['invalid revision', { enabled: true, revision: -1, subscriptionUrl: url }],
  ['invalid enabled flag', { enabled: 'true', revision: 1, subscriptionUrl: url }],
  ['missing fields', {}], ['missing configuration', null]
]) {
  test(`a first ${label} configuration retains its validation error without retrying`, async t => {
    let configurations = 0;
    const f = await coldConfigurationDownload(t, { registry: () => {
      configurations++;
      return Response.json({ ok: true, proxyConfig });
    } });
    const failed = await f.manager.downloadUpdate();
    assert.equal(failed.status, 'error'); assert.equal(failed.error.code, 'PROXY_CONFIG_INVALID');
    assert.equal(failed.retry, null); assert.equal(failed.canRetry, true); assert.equal(configurations, 1);
    assert.equal(f.requests.filter(request => request.url === f.assetUrl).length, 0);
    assert.equal(f.directRequests.includes(url), false); assert.equal(f.children.length, 0);
    assert.equal(f.updateStates.some(value => value.retry?.active), false);
    assert.equal(f.network.active.size, 0); assert.ok(f.sessions.every(value => value.cleared));
  });
}

test('an invalid fresh configuration still falls back to the previously validated administrator cache', async t => {
  let invalid = false;
  const f = await fixture(t, { registry: () => Response.json({ ok: true, proxyConfig: invalid
    ? { enabled: true, revision: 2, subscriptionUrl: 'https://127.0.0.1/sub' }
    : { enabled: true, revision: 1, subscriptionUrl: url } }) });
  const signal = new AbortController().signal;
  assert.equal((await f.network.getConfiguration(f.network.fetchDirect, signal)).revision, 1);
  invalid = true;
  const cached = await f.reloadNetwork().getConfiguration(f.network.fetchDirect, signal);
  assert.equal(cached.revision, 1); assert.equal(cached.enabled, true); assert.equal(cached.subscriptionUrl, url);
});

for (const revision of [0, 1]) {
  test(`an explicit disabled configuration at revision ${revision} never retries a failed direct download`, async t => {
    let configurations = 0;
    const f = await coldConfigurationDownload(t, { registry: () => {
      configurations++;
      return Response.json({ ok: true, proxyConfig: { enabled: false, revision, subscriptionUrl: '' } });
    }, updateResponse: () => Readable.from((async function* () { throw new Error('direct network unavailable'); })()) });
    const failed = await f.manager.downloadUpdate();
    assert.equal(failed.status, 'error'); assert.equal(failed.error.code, 'NETWORK_ERROR'); assert.equal(failed.retry, null);
    assert.equal(configurations, 1); assert.equal(f.requests.filter(request => request.url === f.assetUrl).length, 1);
    assert.equal(f.children.length, 0); assert.equal(f.network.active.size, 0);
    assert.ok(f.sessions.every(value => value.cleared));
  });
}

test('existing system proxy routes and configured PAC DIRECT skip config, subscriptions and built-in core on every desktop platform', async t => {
  for (const platform of ['darwin', 'win32', 'linux']) for (const configuredProxy of [false, true]) {
    const f = await fixture(t, { platform, configuredProxy, resolvedProxy: configuredProxy ? 'DIRECT' : 'PROXY 127.0.0.1:7890' });
    const controller = new AbortController();
    await f.network.run(controller, async () => {
      assert.equal(f.network.snapshot().mode, 'system');
      assert.equal(f.sessions[0].proxies.at(-1).mode, 'system');
      const response = await f.network.fetch('https://api.github.com/zen', { signal: controller.signal });
      assert.equal(await response.text(), 'fixture update metadata');
    });
    assert.equal(f.directRequests.length, 0); assert.equal(f.children.length, 0);
    assert.equal(f.network.snapshot().mode, 'off');
    assert.equal(f.sessions[0].cleared, true);
  }
});

test('manual stop cancels pending configuration even if a transport ignores abort, latches off and explicit resume permits internal proxy', async t => {
  let requested, blocked = true;
  const ready = new Promise(resolve => { requested = resolve; });
  const f = await fixture(t, { registry: () => {
    if (blocked) { requested(); return new Promise(() => {}); }
    return Response.json({ ok: true, proxyConfig: { enabled: true, revision: 1, subscriptionUrl: url } });
  } });
  const controller = new AbortController();
  const pending = f.network.run(controller, async () => assert.fail('canceled startup cannot run update work'));
  const canceled = assert.rejects(pending, { code: 'CANCELED' });
  await ready;
  assert.equal(f.network.snapshot().mode, 'starting'); assert.equal(f.network.active.size, 1);
  const stopped = await f.network.stopInternalProxy(); await canceled;
  assert.equal(controller.signal.reason.code, 'CANCELED');
  assert.deepEqual(stopped, { mode: 'off', manuallyDisabled: true, canStop: false, activeScopes: 0, internalScopes: 0 });
  assert.equal(f.children.length, 0); assert.equal(f.sessions[0].cleared, true);
  blocked = false;
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.directRequests.filter(value => value === endpoint).length, 1);
  assert.equal(f.children.length, 0);
  await f.network.resumeInternalProxy();
  await f.network.run(new AbortController(), async () => assert.equal(f.network.snapshot().mode, 'internal'));
  assert.equal(f.children.length, 1); assert.equal(f.children[0].exitCode, 0);
});

test('manual stop during subscription refresh and node probes cleans all starting scopes without running updater work', async t => {
  for (const phase of ['subscription', 'probe']) {
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const blocked = () => { entered(); return new Promise(() => {}); };
    const f = await fixture(t, phase === 'subscription' ? { subscription: blocked } : { probe: blocked });
    const controller = new AbortController();
    const pending = f.network.run(controller, async () => assert.fail('startup canceled'));
    const canceled = assert.rejects(pending, { code: 'CANCELED' });
    await ready;
    await f.network.stopInternalProxy(); await canceled;
    assert.equal(f.network.active.size, 0); assert.equal(f.sessions[0].cleared, true);
    assert.ok(f.children.every(child => child.exitCode === 0));
    assert.deepEqual((await readdir(f.cacheDirectory)).filter(value => !['proxy-config.json', 'proxy-preference.json'].includes(value)), []);
  }
});

test('manual stop cancels every internal scope while concurrent system-only work remains connected', async t => {
  let resolutions = 0;
  const f = await fixture(t, { resolvedProxy: () => ++resolutions <= UPDATE_HOSTS.length * 2 ? 'DIRECT' : 'PROXY localhost:7890' });
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const pending = [];
  for (let index = 0; index < 2; index++) {
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const run = f.network.run(controllers[index], () => new Promise((_, reject) => {
      entered(); controllers[index].signal.addEventListener('abort', () => reject(controllers[index].signal.reason), { once: true });
    }));
    pending.push(assert.rejects(run, { code: 'CANCELED' })); await ready;
  }
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const system = f.network.run(controllers[2], async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await ready;
  const systemConnections = f.sessions[2].closeCount;
  assert.equal(f.network.snapshot().internalScopes, 2);
  await f.network.stopInternalProxy(); await Promise.all(pending);
  assert.equal(controllers[2].signal.aborted, false);
  assert.equal(f.sessions[2].closeCount, systemConnections);
  assert.equal(f.sessions[2].proxies.at(-1).mode, 'system');
  assert.equal(f.network.snapshot().mode, 'system'); assert.equal(f.network.active.size, 1);
  release(); await system; assert.equal(f.network.active.size, 0);
});

test('startup error state remains available for manual stop after child and files are cleaned', async t => {
  const f = await fixture(t, { probe: async () => { throw new Error('offline'); } });
  await assert.rejects(f.network.run(new AbortController(), async () => {}), { code: 'PROXY_NODES_UNAVAILABLE' });
  assert.equal(f.network.snapshot().mode, 'error'); assert.equal(f.network.active.size, 0);
  assert.ok(f.children.every(child => child.exitCode === 0));
  assert.equal((await f.network.stopInternalProxy()).mode, 'off');
});

test('manual internal stop preserves updater partial bytes and waits for operation cleanup before another download', async t => {
  const installer = Buffer.from('fixture installer bytes for manual proxy stop');
  const digest = createHash('sha256').update(installer).digest('hex');
  const name = 'Brclio-XHS-2.0.4-mac-arm64.dmg';
  const prefix = 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v2.0.4/';
  const release = { tag_name: 'v2.0.4', draft: false, prerelease: false,
    html_url: 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v2.0.4', body: '', published_at: '2026-10-03T00:00:00Z',
    assets: [{ name, size: installer.length, browser_download_url: `${prefix}${name}`, digest: `sha256:${digest}` }] };
  const f = await fixture(t, { updateResponse: request => {
    if (request.url === LATEST_RELEASE_URL) return Readable.from([Buffer.from(JSON.stringify(release))]);
    const incoming = new Readable({ read() {} }); incoming.push(installer.subarray(0, 5));
    incoming.headers = { 'content-length': String(installer.length) };
    return incoming;
  } });
  let downloaded;
  const progress = new Promise(resolve => { downloaded = resolve; });
  const manager = new UpdateManager({ currentVersion: '2.0.3', platform: 'darwin', arch: 'arm64',
    directory: f.cacheDirectory, networkScope: f.network, fetchImpl: f.network.fetch,
    onUpdate: state => { if (state.download.receivedBytes === 5) downloaded(); } });
  assert.equal((await manager.checkForUpdates()).status, 'available');
  let cleaning, releaseCleanup;
  const cleanup = new Promise(resolve => { cleaning = resolve; });
  const gate = new Promise(resolve => { releaseCleanup = resolve; });
  const scopedRun = f.network.run.bind(f.network);
  f.network.run = (controller, work, options) => scopedRun(controller, async () => {
    try { return await work(); } finally { cleaning(); await gate; }
  }, options);
  const download = manager.downloadUpdate(); await progress;
  const stop = f.network.stopInternalProxy(); await cleanup;
  assert.ok(manager.operation); assert.ok(manager.controller); assert.equal(f.network.active.size, 1);
  const requests = f.requests.length;
  const repeated = manager.downloadUpdate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, requests); assert.equal(f.children.length, 1);
  releaseCleanup(); await stop; const state = await download; await repeated;
  assert.equal(state.status, 'available'); assert.equal(state.error, null);
  assert.equal(state.download.receivedBytes, 5); assert.equal(state.download.canResume, true);
  assert.deepEqual(await readFile(path.join(f.cacheDirectory, `${name}.${digest}.partial`)), installer.subarray(0, 5));
  assert.equal(manager.operation, null); assert.equal(manager.controller, null);
  assert.equal(f.network.active.size, 0); assert.ok(f.children.every(child => child.exitCode === 0));
});

test('updater resumes an interrupted internal proxy download in a fresh scope and honors a stop between attempts', async t => {
  const installer = Buffer.from('fixture installer bytes for internal proxy automatic retry');
  const digest = createHash('sha256').update(installer).digest('hex');
  const name = 'Brclio-XHS-2.0.4-mac-arm64.dmg';
  const prefix = 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v2.0.4/';
  const release = { tag_name: 'v2.0.4', draft: false, prerelease: false,
    html_url: 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v2.0.4', body: '', published_at: '2026-10-03T00:00:00Z',
    assets: [{ name, size: installer.length, browser_download_url: `${prefix}${name}`, digest: `sha256:${digest}` }] };
  for (const action of ['retry', 'stop']) {
    let firstStream, assetRequests = 0, stopping;
    const retryStates = [], retryCleanup = [];
    const f = await fixture(t, { updateResponse: request => {
      if (request.url === LATEST_RELEASE_URL) return Readable.from([Buffer.from(JSON.stringify(release))]);
      if (++assetRequests === 1) {
        firstStream = new Readable({ read() {} }); firstStream.push(installer.subarray(0, 5));
        firstStream.headers = { 'content-length': String(installer.length) };
        return firstStream;
      }
      assert.equal(action, 'retry', 'manual stop must prevent a fresh download scope');
      assert.equal(request.headers.range, 'bytes=5-');
      const resumed = Readable.from([installer.subarray(5)]);
      resumed.statusCode = 206;
      resumed.headers = { 'content-length': String(installer.length - 5), 'content-range': `bytes 5-${installer.length - 1}/${installer.length}` };
      return resumed;
    } });
    const manager = new UpdateManager({ currentVersion: '2.0.3', platform: 'darwin', arch: 'arm64',
      directory: f.cacheDirectory, networkScope: f.network, fetchImpl: f.network.fetch, downloadRetryDelayMs: 5,
      onUpdate: state => {
        if (state.download.receivedBytes === 5 && firstStream && !firstStream.destroyed) {
          firstStream.destroy(Object.assign(new Error('connection reset during installer download'), { code: 'ECONNRESET' }));
        }
        if (state.retry?.active && !retryStates.length) {
          retryStates.push(state);
          retryCleanup.push({ active: f.network.active.size, cleared: f.sessions[1].cleared, exitCode: f.children[0].exitCode });
          if (action === 'stop') stopping = f.network.stopInternalProxy();
        }
      } });
    assert.equal((await manager.checkForUpdates()).status, 'available');
    const state = await manager.downloadUpdate();
    await stopping;
    assert.equal(retryStates.length, 1); assert.equal(retryStates[0].retry.consecutiveFailures, 1);
    assert.deepEqual(retryCleanup, [{ active: 0, cleared: true, exitCode: 0 }], 'failed scope must finish cleanup before retry is published');
    assert.equal(retryStates[0].download.receivedBytes, 5); assert.equal(state.retry, null);
    if (action === 'retry') {
      assert.equal(state.status, 'downloaded'); assert.equal(assetRequests, 2);
      assert.deepEqual(await readFile(path.join(f.cacheDirectory, name)), installer);
      assert.equal(f.sessions.length, 3); assert.notEqual(f.sessions[1].partition, f.sessions[2].partition);
    } else {
      assert.equal(state.status, 'available'); assert.equal(state.download.receivedBytes, 5); assert.equal(assetRequests, 1);
      assert.equal(f.network.snapshot().manuallyDisabled, true); assert.equal(f.sessions.length, 2);
      assert.deepEqual(await readFile(path.join(f.cacheDirectory, `${name}.${digest}.partial`)), installer.subarray(0, 5));
    }
    assert.equal(manager.operation, null); assert.equal(f.network.active.size, 0);
    assert.ok(f.sessions.every(session => session.cleared)); assert.ok(f.children.every(child => child.exitCode === 0));
  }
});

test('manual off preference survives reload and background work, explicit user action clears it before a fresh scoped start', async t => {
  const f = await fixture(t);
  const configFile = path.join(f.cacheDirectory, 'proxy-config.json');
  await writeFile(configFile, JSON.stringify({ enabled: true, revision: 8, subscriptionUrl: url }));
  const configBytes = await readFile(configFile, 'utf8');
  await f.network.stopInternalProxy();
  const preference = path.join(f.cacheDirectory, 'proxy-preference.json');
  assert.deepEqual(JSON.parse(await readFile(preference, 'utf8')), { schemaVersion: 1, manuallyDisabled: true });
  const reloaded = f.reloadNetwork();
  await reloaded.run(new AbortController(), async () => assert.equal(reloaded.snapshot().mode, 'off'));
  assert.equal(reloaded.snapshot().manuallyDisabled, true);
  assert.equal(f.children.length, 0); assert.equal(f.directRequests.length, 0);
  assert.equal(await readFile(configFile, 'utf8'), configBytes, 'preference never overwrites admin subscription cache');
  await reloaded.requestInternalProxyForUserOperation();
  assert.equal(reloaded.snapshot().manuallyDisabled, false); assert.equal(f.children.length, 0, 'explicit enable does not start a standalone proxy');
  assert.deepEqual(JSON.parse(await readFile(preference, 'utf8')), { schemaVersion: 1, manuallyDisabled: false });
  await reloaded.run(new AbortController(), async () => assert.equal(reloaded.snapshot().mode, 'internal'));
  assert.equal(reloaded.snapshot().mode, 'off'); assert.equal(f.children.length, 1); assert.equal(f.children[0].exitCode, 0);
  const afterUserAction = f.reloadNetwork(); await afterUserAction.loadPreference();
  assert.equal(afterUserAction.snapshot().manuallyDisabled, false);
});

test('persisted manual off and explicit user enable both preserve existing system proxy priority', async t => {
  const f = await fixture(t, { configuredProxy: true });
  await f.network.stopInternalProxy();
  const reloaded = f.reloadNetwork();
  const controller = new AbortController();
  await reloaded.run(controller, async () => {
    assert.equal(reloaded.snapshot().mode, 'system'); assert.equal(reloaded.snapshot().manuallyDisabled, true);
    const response = await reloaded.fetch('https://api.github.com/zen', { signal: controller.signal });
    assert.equal(await response.text(), 'fixture update metadata');
  });
  await reloaded.requestInternalProxyForUserOperation();
  await reloaded.run(new AbortController(), async () => assert.equal(reloaded.snapshot().mode, 'system'));
  assert.equal(f.children.length, 0); assert.equal(f.directRequests.length, 0);
});

test('explicit enable waits canceled internal work cleanup, then starts fresh; a newer manual stop wins', async t => {
  const f = await fixture(t);
  let ready, cleaning, finish;
  const workReady = new Promise(resolve => { ready = resolve; });
  const cleanupReady = new Promise(resolve => { cleaning = resolve; });
  const cleanupGate = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const pending = f.network.run(controller, async () => {
    try {
      ready(); await new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    } finally { cleaning(); await cleanupGate; }
  });
  const canceled = assert.rejects(pending, { code: 'CANCELED' });
  await workReady;
  const stop = f.network.stopInternalProxy(); await cleanupReady;
  let enabled = false;
  const enable = f.network.requestInternalProxyForUserOperation().then(() => { enabled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(enabled, false); assert.equal(f.network.snapshot().manuallyDisabled, true);
  finish(); await stop; await enable; await canceled;
  assert.equal(f.network.active.size, 0); assert.equal(f.network.snapshot().manuallyDisabled, false);
  await f.network.run(new AbortController(), async () => assert.equal(f.network.snapshot().mode, 'internal'));
  assert.equal(f.children.length, 2); assert.ok(f.children.every(child => child.exitCode === 0));
  await f.network.stopInternalProxy();
  const earlierEnable = f.network.requestInternalProxyForUserOperation();
  const newerStop = f.network.stopInternalProxy();
  await earlierEnable; await newerStop;
  assert.equal(f.network.snapshot().manuallyDisabled, true);
  assert.equal(JSON.parse(await readFile(path.join(f.cacheDirectory, 'proxy-preference.json'), 'utf8')).manuallyDisabled, true);
});

test('manual stop before lazy preference loading completes cannot be undone by an older disk false flag', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cacheDirectory, 'proxy-preference.json'), JSON.stringify({ schemaVersion: 1, manuallyDisabled: false }));
  const loading = f.network.loadPreference();
  const stop = f.network.stopInternalProxy();
  await loading; await stop;
  assert.equal(f.network.snapshot().manuallyDisabled, true);
  await f.network.run(new AbortController(), async () => {});
  assert.equal(f.children.length, 0); assert.equal(f.directRequests.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(f.cacheDirectory, 'proxy-preference.json'), 'utf8')).manuallyDisabled, true);
});

test('exit flush waits a blocked manual-close persistence queue so the next process observes closed state', async t => {
  const f = await fixture(t);
  await f.network.requestInternalProxyForUserOperation();
  const preference = path.join(f.cacheDirectory, 'proxy-preference.json');
  assert.equal(JSON.parse(await readFile(preference, 'utf8')).manuallyDisabled, false);
  let releaseStorage;
  f.network.preferenceQueue = new Promise(resolve => { releaseStorage = resolve; });
  const stopping = f.network.stopInternalProxy();
  let flushed = false;
  const exit = f.network.flushPreferences().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.network.snapshot().manuallyDisabled, true);
  assert.equal(flushed, false, 'quit must wait rather than rely on unrelated task or diagnostic shutdown');
  assert.equal(JSON.parse(await readFile(preference, 'utf8')).manuallyDisabled, false, 'storage really remains blocked');
  releaseStorage(); await exit; await stopping;
  assert.equal(JSON.parse(await readFile(preference, 'utf8')).manuallyDisabled, true);
  const nextProcess = f.reloadNetwork(); await nextProcess.loadPreference();
  assert.equal(nextProcess.snapshot().manuallyDisabled, true);
});

test('normal exit flush drains a pending explicit-enable write without manufacturing manual-close state', async t => {
  const f = await fixture(t);
  await f.network.flushPreferences();
  await assert.rejects(readFile(path.join(f.cacheDirectory, 'proxy-preference.json')), { code: 'ENOENT' });
  assert.equal(f.network.snapshot().manuallyDisabled, false);
  await f.network.stopInternalProxy();
  let releaseStorage;
  f.network.preferenceQueue = new Promise(resolve => { releaseStorage = resolve; });
  const enabling = f.network.requestInternalProxyForUserOperation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.network.snapshot().manuallyDisabled, false);
  let flushed = false;
  const exit = f.network.flushPreferences().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  releaseStorage(); await enabling; await exit;
  assert.equal(f.network.snapshot().manuallyDisabled, false);
  assert.equal(JSON.parse(await readFile(path.join(f.cacheDirectory, 'proxy-preference.json'), 'utf8')).manuallyDisabled, false);
});
