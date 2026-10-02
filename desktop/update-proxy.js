import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDocument } from 'yaml';
import { createElectronUpdateFetch } from './update-manager.js';

export const UPDATE_HOSTS = Object.freeze(['api.github.com', 'github.com',
  'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const GROUP = 'BRCLIO_UPDATE';
const PROTOCOLS = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'http', 'socks5', 'snell', 'anytls']);
const NODE_FIELDS = new Set(['type', 'server', 'port', 'password', 'cipher', 'uuid', 'alterId', 'network', 'tls', 'servername',
  'sni', 'client-fingerprint', 'fingerprint', 'alpn', 'flow', 'reality-opts', 'ws-opts', 'grpc-opts', 'h2-opts', 'http-opts',
  'tfo', 'udp-over-tcp', 'up', 'down', 'obfs', 'obfs-password', 'protocol', 'protocol-param', 'obfs-param', 'plugin',
  'plugin-opts', 'token', 'username', 'version', 'ip', 'reduce-rtt', 'request-timeout', 'udp-relay-mode', 'congestion-controller',
  'heartbeat-interval', 'disable-sni', 'fast-open', 'recv-window-conn', 'recv-window', 'hop-interval', 'ports']);
const MAX_SUBSCRIPTION = 4 * 1024 * 1024;
const MAX_NODES = 256;
const PROBE_URL = 'https://api.github.com/zen';

function proxyError(code, message) { return Object.assign(new Error(message), { code }); }
function privateHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return !value || value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')
    || value === '::' || value === '::1' || /^(?:fc|fd|fe[89ab])[a-f\d]*:/i.test(value)
    || /^::ffff:/i.test(value) || /^(?:0|10|127)\./.test(value)
    || /^169\.254\./.test(value) || /^192\.168\./.test(value)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value) || /^(?:22[4-9]|23\d|24\d|25[0-5])\./.test(value);
}
export function subscriptionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw proxyError('PROXY_CONFIG_INVALID', '更新代理订阅地址无效。'); }
  if (typeof value !== 'string' || value.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.hash || privateHost(url.hostname)) {
    throw proxyError('PROXY_CONFIG_INVALID', '更新代理订阅必须使用公开 HTTPS 地址。');
  }
  return url.href;
}
export function subscriptionUrls(config) {
  const values = config.subscriptionUrls === undefined
    ? (config.subscriptionUrl ? [config.subscriptionUrl] : []) : config.subscriptionUrls;
  if (!Array.isArray(values) || values.length > 8) throw proxyError('PROXY_CONFIG_INVALID', '更新代理最多支持 8 条订阅地址。');
  return [...new Set(values.map(value => subscriptionUrl(typeof value === 'string' ? value.trim() : value)))];
}
export function isUpdateUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && UPDATE_HOSTS.includes(url.hostname);
  } catch { return false; }
}

// Only node definitions survive parsing. Inbound ports, providers, DNS, TUN,
// scripts and routes in a downloaded subscription never become executable config.
export function subscriptionNodes(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SUBSCRIPTION) throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理订阅过大或格式无效。');
  let value;
  try {
    const document = parseDocument(text, { uniqueKeys: true, maxAliasCount: 0 });
    if (document.errors.length) throw document.errors[0];
    value = document.toJS({ maxAliasCount: 0 });
  } catch { throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理需要 Clash / Mihomo YAML 或 JSON 节点订阅。'); }
  if (!Array.isArray(value?.proxies) || !value.proxies.length || value.proxies.length > MAX_NODES) throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理订阅缺少节点或节点数量过多。');
  return value.proxies.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !PROTOCOLS.has(source.type)
      || typeof source.server !== 'string' || source.server.length > 253 || !/^[a-zA-Z0-9.\[\]:-]+$/.test(source.server) || privateHost(source.server)
      || !Number.isInteger(source.port) || source.port < 1 || source.port > 65535) {
      throw proxyError('PROXY_SUBSCRIPTION_INVALID', '订阅包含无效或不支持的代理节点。');
    }
    // Stable private names avoid reserved names, duplicate labels and putting
    // subscription labels (which can contain account details) into diagnostics.
    const node = Object.fromEntries(Object.entries(source).filter(([key]) => NODE_FIELDS.has(key)).map(([key, value]) => [key, nodeValue(value)]));
    Object.assign(node, { name: `node-${String(index + 1).padStart(3, '0')}`, udp: false, 'skip-cert-verify': false });
    return node;
  });
}

function nodeValue(value, depth = 0) {
  if (depth > 8 || typeof value === 'string' && value.length > 8192) throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理节点参数过长或层级过深。');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 128) throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理节点参数过多。');
    return value.map(item => nodeValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const items = Object.entries(value);
    if (items.length > 128 || items.some(([key]) => key.length > 128)) throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理节点参数过多。');
    return Object.fromEntries(items.map(([key, item]) => [key, nodeValue(item, depth + 1)]));
  }
  throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理节点参数无效。');
}

export function coreConfig(nodes, { proxyPort, controllerPort, secret }) {
  return { 'mixed-port': proxyPort, 'bind-address': '127.0.0.1', 'allow-lan': false,
    mode: 'rule', 'log-level': 'silent', ipv6: false, 'external-controller': `127.0.0.1:${controllerPort}`, secret,
    'unified-delay': true, 'tcp-concurrent': true, 'find-process-mode': 'off',
    profile: { 'store-selected': false, 'store-fake-ip': false }, dns: { enable: false }, tun: { enable: false },
    proxies: nodes, 'proxy-groups': [{ name: GROUP, type: 'select', proxies: nodes.map(node => node.name) }],
    rules: [...UPDATE_HOSTS.map(host => `AND,((DOMAIN,${host}),(DST-PORT,443)),${GROUP}`), 'MATCH,REJECT'] };
}

export async function lowestLatency(names, probe, { concurrency = 8, signal, ranked = false } = {}) {
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    while (next < names.length) {
      signal?.throwIfAborted();
      const index = next++, name = names[index];
      try {
        const latency = await probe(name);
        if (Number.isFinite(latency) && latency >= 0 && latency < 60000) results.push({ name, latency, index });
      } catch { signal?.throwIfAborted(); }
    }
  }));
  signal?.throwIfAborted();
  results.sort((a, b) => a.latency - b.latency || a.index - b.index);
  if (!results.length) throw proxyError('PROXY_NODES_UNAVAILABLE', '更新代理节点均不可用，请稍后重试或在管理后台更新订阅。');
  return ranked ? results : results[0];
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function boundedText(response, maximum, signal) {
  if (!response.ok || response.redirected || !response.body) throw proxyError('PROXY_FETCH_FAILED', '无法获取最新更新代理配置或订阅。');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理响应超过大小限制。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class UpdateProxyNetwork {
  constructor({ net, session, endpoint, runtimeDirectory, cacheDirectory, fetchDirect = null, launchCore = null, onDiagnostic = () => {} }) {
    this.net = net; this.sessions = session; this.endpoint = endpoint;
    this.runtimeDirectory = runtimeDirectory; this.cacheDirectory = cacheDirectory;
    this.fetchDirect = fetchDirect; this.launchCore = launchCore; this.onDiagnostic = onDiagnostic;
    this.active = new Map();
    this.configQueue = Promise.resolve();
    this.lastConfig = null;
    this.fetch = (url, options) => {
      if (!isUpdateUrl(url)) return Promise.reject(proxyError('PROXY_DESTINATION_BLOCKED', '更新代理仅允许本软件的更新服务器。'));
      const scope = this.active.get(options.signal);
      if (!scope) return Promise.reject(proxyError('PROXY_SCOPE_REQUIRED', '更新网络会话已关闭，请重试。'));
      return scope.fetch(url, options);
    };
  }
  diagnostic(event, data = {}) { try { this.onDiagnostic(event, data); } catch { /* diagnostics cannot interrupt cleanup */ } }

  validateConfiguration(config) {
    if (!Number.isSafeInteger(config?.revision) || config.revision < 0 || typeof config.enabled !== 'boolean') throw new Error('Invalid configuration');
    const urls = subscriptionUrls(config);
    if (config.enabled && !urls.length) throw proxyError('PROXY_CONFIG_INVALID', '更新代理缺少订阅地址。');
    return { ...config, subscriptionUrls: urls, subscriptionUrl: urls[0] || '' };
  }

  async cachedConfiguration() {
    let cached = this.lastConfig;
    try {
      const disk = this.validateConfiguration(JSON.parse(await readFile(path.join(this.cacheDirectory, 'proxy-config.json'), 'utf8')));
      if (disk.revision > 0 && (!cached || disk.revision > cached.revision)) cached = disk;
    } catch { /* a first installation has no administrator config */ }
    // Another response may publish a newer in-memory revision while the disk
    // read is pending, including when that response cannot be persisted.
    if (this.lastConfig && (!cached || this.lastConfig.revision > cached.revision)) cached = this.lastConfig;
    if (cached && (!this.lastConfig || cached.revision > this.lastConfig.revision)) this.lastConfig = cached;
    return this.lastConfig || cached;
  }

  rememberConfiguration(config) {
    const update = async () => {
      const cached = await this.cachedConfiguration();
      // A concurrent recovery lookup can finish later with older metadata.
      // It must never re-enable a subscription a newer admin revision disabled.
      const latest = cached && cached.revision > config.revision ? cached : config;
      this.lastConfig = latest;
      const file = path.join(this.cacheDirectory, 'proxy-config.json');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(latest), { mode: 0o600 });
        await rename(temporary, file);
      } catch { this.diagnostic('update.proxy_config_cache_failed'); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      return latest;
    };
    const result = this.configQueue.then(update, update);
    this.configQueue = result.catch(() => {});
    return result;
  }

  async getConfiguration(direct, signal) {
    let config;
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
      const response = await direct(this.endpoint, { method: 'POST', redirect: 'error', cache: 'no-store', signal: requestSignal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update-proxy-config', input: {} }) });
      const body = JSON.parse(await boundedText(response, 65536, requestSignal));
      if (body.ok !== true) throw new Error();
      config = this.validateConfiguration(body.proxyConfig);
      if (config.revision > 0) {
        return await this.rememberConfiguration(config);
      }
      // An available, unconfigured administrator service is authoritative.
      // Software never substitutes a bundled subscription for that choice.
      return config;
    } catch { signal.throwIfAborted(); this.diagnostic('update.proxy_config_fallback'); }
    const cached = await this.cachedConfiguration();
    if (cached?.revision > 0) return cached;
    return { enabled: false, revision: 0, subscriptionUrls: [], subscriptionUrl: '' };
  }

  async run(controller, work) {
    const signal = controller.signal;
    signal.throwIfAborted();
    const scope = { session: this.sessions.fromPartition(`brclio-update-${randomUUID()}`, { cache: false }), child: null, directory: null, workStarted: false };
    try {
      await scope.session.setProxy({ mode: 'direct' });
      const direct = this.fetchDirect || createElectronUpdateFetch(this.net, { session: scope.session });
      const config = await this.getConfiguration(direct, signal);
      if (config.enabled) await this.prepare(scope, direct, config, signal);
      signal.throwIfAborted();
      const transport = createElectronUpdateFetch(this.net, { session: scope.session });
      scope.fetch = async (url, options) => {
        while (true) {
          signal.throwIfAborted();
          let response;
          try { response = await transport(url, options); }
          catch (error) {
            signal.throwIfAborted();
            if (scope.selectNext && await scope.selectNext()) continue;
            throw error;
          }
          // A node can answer the latency probe while its egress IP is rate
          // limited by GitHub. Continue through the measured latency order.
          if ([403, 429, 502, 503, 504].includes(response.status) && scope.selectNext && scope.hasNext()) {
            await response.body?.cancel().catch(() => {});
            if (await scope.selectNext()) continue;
          }
          return response;
        }
      };
      this.active.set(signal, scope);
      scope.workStarted = true;
      return await work();
    } catch (error) {
      if (scope.workStarted) throw error;
      signal.throwIfAborted();
      if (typeof error?.code === 'string' && error.code.startsWith('PROXY_')) throw error;
      throw proxyError('PROXY_START_FAILED', '更新代理启动失败，请稍后重试或在管理后台检查订阅。');
    } finally {
      this.active.delete(signal);
      await scope.session.setProxy({ mode: 'direct' }).catch(() => {});
      await scope.session.closeAllConnections().catch(() => {});
      if (scope.child) {
        scope.child.stdin?.end();
        if (scope.child.exitCode === null && scope.child.signalCode === null) {
          await Promise.race([new Promise(resolve => scope.child.once('exit', resolve)), delay(3000)]);
          if (scope.child.exitCode === null && scope.child.signalCode === null) scope.child.kill();
        }
      }
      await scope.session.clearStorageData().catch(() => {});
      if (scope.directory) await rm(scope.directory, { recursive: true, force: true }).catch(() => {});
      this.diagnostic('update.proxy_stopped');
    }
  }

  async fetchSubscription(direct, url, signal) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    let target = subscriptionUrl(url), response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      requestSignal.throwIfAborted();
      response = await direct(target, { method: 'GET', redirect: 'manual', signal: requestSignal,
        cache: 'no-store', headers: { 'User-Agent': 'clash.meta', Accept: 'application/yaml, text/yaml, application/json, text/plain' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw proxyError('PROXY_FETCH_FAILED', '更新订阅跳转次数或目标异常。');
      try { target = subscriptionUrl(new URL(location, target).href); }
      catch { throw proxyError('PROXY_FETCH_FAILED', '更新订阅跳转地址无效。'); }
    }
    return subscriptionNodes(await boundedText(response, MAX_SUBSCRIPTION, requestSignal));
  }

  async prepare(scope, direct, config, signal) {
    const sources = subscriptionUrls(config);
    const results = await Promise.allSettled(sources.map(url => this.fetchSubscription(direct, url, signal)));
    signal.throwIfAborted();
    const available = results.filter(result => result.status === 'fulfilled');
    if (!available.length) throw results[0]?.reason || proxyError('PROXY_SUBSCRIPTION_INVALID', '更新代理缺少可用订阅。');
    // A provider failure does not discard healthy sources. Identical nodes are
    // measured once; all aliases are reassigned without provider account labels.
    const seen = new Set(), nodes = [];
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    for (const result of available) for (const source of result.value) {
      const { name, ...fields } = source;
      const fingerprint = JSON.stringify(stable(fields));
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      nodes.push({ ...fields, name: `node-${String(nodes.length + 1).padStart(3, '0')}` });
    }
    this.diagnostic('update.proxy_subscriptions_refreshed', { sources: sources.length, available: available.length, nodes: nodes.length });
    const proxyPort = await freePort();
    let controllerPort = await freePort();
    while (controllerPort === proxyPort) controllerPort = await freePort();
    const secret = randomBytes(32).toString('hex');
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    scope.directory = await mkdtemp(path.join(this.cacheDirectory, 'proxy-'));
    const file = path.join(scope.directory, 'config.json');
    await writeFile(file, JSON.stringify(coreConfig(nodes, { proxyPort, controllerPort, secret })), { mode: 0o600 });
    const executable = path.join(this.runtimeDirectory, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
    const launch = this.launchCore || ((binary, directory, configFile) => spawn(process.execPath,
      [fileURLToPath(new URL('./proxy-core-supervisor.cjs', import.meta.url)), binary, directory, configFile],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }));
    scope.child = launch(executable, scope.directory, file);
    let launchFailed = false;
    scope.child.on('error', () => { launchFailed = true; });
    const api = async (pathname, options = {}) => {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(7000)]);
      const response = await direct(`http://127.0.0.1:${controllerPort}${pathname}`, { redirect: 'error', signal: requestSignal,
        ...options, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Controller failed'); }
      if (response.status === 204) return null;
      return JSON.parse(await boundedText(response, MAX_SUBSCRIPTION, requestSignal));
    };
    const deadline = Date.now() + 10000;
    while (true) {
      signal.throwIfAborted();
      if (launchFailed || scope.child.exitCode !== null || scope.child.signalCode !== null) throw proxyError('PROXY_CORE_UNAVAILABLE', '内置更新代理无法启动，请重新安装完整客户端。');
      try { await api('/version'); break; } catch { signal.throwIfAborted(); }
      if (Date.now() > deadline) throw proxyError('PROXY_CORE_UNAVAILABLE', '内置更新代理启动超时，请重试。');
      await delay(100, undefined, { signal });
    }
    const ranking = await lowestLatency(nodes.map(node => node.name), async name => {
      const result = await api(`/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(PROBE_URL)}&timeout=5000&expected=200`);
      return result.delay;
    }, { signal, ranked: true });
    let selected = 0;
    const select = async best => {
      await api(`/proxies/${GROUP}`, { method: 'PUT', body: JSON.stringify({ name: best.name }) });
      await scope.session.closeAllConnections();
      this.diagnostic('update.proxy_selected', { node: best.name, latencyMs: best.latency, nodes: nodes.length, revision: config.revision });
    };
    scope.hasNext = () => selected + 1 < ranking.length;
    scope.selectNext = async () => {
      if (!scope.hasNext()) return false;
      await select(ranking[++selected]);
      return true;
    };
    await select(ranking[0]);
    // Controller traffic remains direct on loopback even while this private
    // session sends allowed GitHub update requests through the selected node.
    await scope.session.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}`, proxyBypassRules: '127.0.0.1;[::1];localhost' });
    await scope.session.closeAllConnections();
  }
}
