import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredSystemProxy, detectSystemProxy, environmentProxy, hasProxyRoute,
  macProxyConfigured, windowsProxyConfigured } from '../desktop/system-proxy.js';

const origins = ['https://api.github.com/', 'https://github.com/', 'https://release-assets.githubusercontent.com/'];
function session(route = 'DIRECT') {
  return { configurations: [], closed: 0,
    async setProxy(config) { this.configurations.push(config); },
    async closeAllConnections() { this.closed++; },
    async resolveProxy(url) { return typeof route === 'function' ? route(url) : route; } };
}

test('Chromium manual, SOCKS and PAC fallback routes are recognized without logging credentials', () => {
  for (const value of ['PROXY 127.0.0.1:7890', 'HTTPS proxy.example.com:443', 'SOCKS5 [::1]:7891; DIRECT',
    'DIRECT; PROXY proxy.example.com:8080']) assert.equal(hasProxyRoute(value), true);
  for (const value of ['', null, 'DIRECT', 'DIRECT; DIRECT', 'PROXY', 'invalid']) assert.equal(hasProxyRoute(value), false);
});

test('macOS native manual proxy, SOCKS and PAC flags detect configured proxy including PAC DIRECT', async () => {
  for (const flag of ['HTTPEnable', 'HTTPSEnable', 'SOCKSEnable', 'ProxyAutoConfigEnable']) {
    const output = `<dictionary> {\n  ${flag} : 1\n}\n`;
    assert.equal(macProxyConfigured(output), true);
    let call;
    assert.equal(await configuredSystemProxy({ platform: 'darwin', exec: async (...args) => { call = args; return { stdout: output }; } }), true);
    assert.equal(call[0], '/usr/sbin/scutil'); assert.deepEqual(call[1], ['--proxy']);
    assert.equal(call[2].timeout, 2500);
  }
  assert.equal(macProxyConfigured('HTTPEnable : 0\nHTTPProxy : proxy.example.com\n'), false);
  assert.equal(macProxyConfigured('ProxyAutoDiscoveryEnable : 1\n'), false);
});

test('Windows native proxy reads recognize manual and enabled PAC flags but ignore stale disabled PAC URL', async () => {
  assert.equal(windowsProxyConfigured('ProxyEnable REG_DWORD 0x1'), true);
  assert.equal(windowsProxyConfigured('AutoConfigURL REG_SZ https://example.com/proxy.pac'), true);
  for (const flag of ['02', '04', '0f']) assert.equal(windowsProxyConfigured(`DefaultConnectionSettings REG_BINARY 4600000000000000${flag}000000`), true);
  for (const flag of ['01', '08', '09']) assert.equal(windowsProxyConfigured(`DefaultConnectionSettings REG_BINARY 4600000000000000${flag}000000`), false);
  assert.equal(windowsProxyConfigured('AutoConfigURL REG_SZ https://example.com/stale.pac\nDefaultConnectionSettings REG_BINARY 460000000000000001000000'), false);
  const calls = [];
  const enabled = await configuredSystemProxy({ platform: 'win32', exec: async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: args.at(-1) === 'DefaultConnectionSettings' ? 'DefaultConnectionSettings REG_BINARY 460000000000000005000000' : '' };
  } });
  assert.equal(enabled, true); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.file === 'reg.exe' && call.args[0] === 'query' && !call.options.shell && call.options.windowsHide));
});

test('Linux native configured desktop mode is recognized; unavailable optional readers remain direct', async () => {
  for (const mode of ['manual', 'auto']) assert.equal(await configuredSystemProxy({ platform: 'linux', exec: async (file, args) => {
    assert.equal(file, 'gsettings'); assert.deepEqual(args, ['get', 'org.gnome.system.proxy', 'mode']);
    return { stdout: `'${mode}'\n` };
  } }), true);
  assert.equal(await configuredSystemProxy({ platform: 'linux', exec: async () => ({ stdout: "'none'\n" }) }), false);
  assert.equal(await configuredSystemProxy({ platform: 'linux', exec: async () => { throw new Error('not installed'); } }), false);
});

test('environment proxies preserve bypass rules and safely classify unsupported credentialed addresses', () => {
  assert.deepEqual(environmentProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,.example.com' }), {
    configured: true, configuration: { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '127.0.0.1;[::1];localhost;localhost;.example.com' }
  });
  assert.equal(environmentProxy({ ALL_PROXY: 'socks5h://[::1]:1081' }).configuration.proxyRules, 'socks5://[::1]:1081');
  assert.equal(environmentProxy({ HTTPS_PROXY: 'http://user:private@127.0.0.1:7890' }).configuration, null);
  assert.equal(environmentProxy({ HTTP_PROXY: 'http://127.0.0.1:7890' }).configured, true);
  assert.deepEqual(environmentProxy({}), { configured: false, configuration: null });
});

test('configured native proxies win even when all PAC update rules return DIRECT', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const s = session();
    const result = await detectSystemProxy(s, origins, { platform, env: {}, configured: async ({ platform: passed }) => {
      assert.equal(passed, platform); return true;
    } });
    assert.deepEqual(result, { enabled: true, source: 'system' });
    assert.deepEqual(s.configurations, [{ mode: 'system' }]);
  }
});

test('resolved proxy on any update CDN suppresses built-in proxy; environment fallback is scoped', async () => {
  const s = session(url => url.includes('release-assets') ? 'PROXY localhost:7890' : 'DIRECT');
  assert.deepEqual(await detectSystemProxy(s, origins, { env: {}, configured: async () => false }), { enabled: true, source: 'system' });
  const e = session();
  assert.deepEqual(await detectSystemProxy(e, origins, { env: { HTTPS_PROXY: '127.0.0.1:7890' }, configured: async () => false }), { enabled: true, source: 'environment' });
  assert.equal(e.configurations.at(-1).proxyRules, 'http://127.0.0.1:7890');
  assert.deepEqual(await detectSystemProxy(session(), origins, { env: {}, configured: async () => false }), { enabled: false, source: 'none' });
});

test('automatic discovery alone permits built-in proxy when DIRECT but a resolved WPAD route keeps system transport', async () => {
  for (const platform of ['darwin', 'win32']) {
    const output = platform === 'darwin' ? 'ProxyAutoDiscoveryEnable : 1\n'
      : 'DefaultConnectionSettings REG_BINARY 460000000000000009000000';
    const configured = options => configuredSystemProxy({ ...options, exec: async () => ({ stdout: output }) });
    assert.deepEqual(await detectSystemProxy(session(), origins, { platform, env: {}, configured }), { enabled: false, source: 'none' });
    assert.deepEqual(await detectSystemProxy(session('PROXY localhost:8080'), origins,
      { platform, env: {}, configured }), { enabled: true, source: 'system' });
  }
});

test('failed or stalled PAC resolution is bounded and keeps system transport; application abort wins', async () => {
  assert.deepEqual(await detectSystemProxy(session(() => { throw new Error('PAC failed'); }), origins,
    { env: {}, configured: async () => false }), { enabled: true, source: 'system-unknown' });
  // AbortSignal.timeout is unref'ed. Keep this deterministic fixture alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.deepEqual(await detectSystemProxy(session(() => new Promise(() => {})), origins,
      { env: {}, configured: async () => false, timeoutMs: 20 }), { enabled: true, source: 'system-unknown' });
    const controller = new AbortController();
    const pending = detectSystemProxy(session(() => new Promise(() => {})), origins,
      { env: {}, configured: async () => false, signal: controller.signal });
    controller.abort(new Error('application closing'));
    await assert.rejects(pending, /application closing/);
  } finally { clearTimeout(keepAlive); }
});
