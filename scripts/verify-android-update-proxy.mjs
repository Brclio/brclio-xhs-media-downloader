// Debug-only device acceptance for the packaged updater core, routing and lifecycle.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serial = process.argv[2] || 'emulator-5558';
assert.match(serial, /^emulator-\d+$/, 'Use a disposable Android emulator for this debug acceptance.');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const adb = sdk ? path.join(sdk, 'platform-tools/adb') : 'adb';
const apk = process.env.ANDROID_UPDATE_PROXY_TEST_APK || path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
const app = 'com.brclio.xhs.debug';
const expectedMode = process.env.ANDROID_UPDATE_PROXY_EXPECT_MODE || 'direct';
const sourceOrBinaryFixture = process.env.ANDROID_UPDATE_PROXY_SOURCE_FIXTURE === 'true';
assert.ok(['proxy', 'direct'].includes(expectedMode), 'Expected mode must be proxy or direct.');
const exec = promisify(execFile);
const device = async (...args) => (await exec(adb, ['-s', serial, ...args], { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const shell = (...args) => device('shell', ...args);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(operation, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let value;
    try { value = await operation(); } catch { value = null; }
    if (value) return value;
    await pause(120);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function corePid() {
  // Android ps truncates long argv paths; NAME is the kernel executable name (16-byte limit).
  const process = (await shell('ps', '-A', '-o', 'PID,PPID,NAME')).split('\n')
    .find(line => line.includes('libbrclio_updat'));
  return process ? Number(process.trim().split(/\s+/)[0]) : null;
}
async function connectStatus(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'github.com:443' });
    request.setTimeout(3000, () => request.destroy(new Error('Proxy authentication probe timed out')));
    request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    request.on('error', () => reject(new Error('Proxy authentication probe failed')));
    request.end();
  });
}
async function openInspector() {
  const pid = await until(async () => (await shell('pidof', app)).trim(), 'debug app process');
  const port = await device('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  const page = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.endsWith('/assets/www/index.html')); }
    catch { return null; }
  }, 'debug WebView inspector');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Debug inspector connection failed')), { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error || message.result?.exceptionDetails) {
      const description = message.result?.exceptionDetails?.exception?.description?.split('\n')[0] || 'Debug evaluation failed';
      request.reject(new Error(description));
    }
    else request.resolve(message.result?.result?.value);
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Debug evaluation timed out')); }, 120000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  await until(() => evaluate(`Boolean(window.BrclioNative && document.readyState === 'complete' && document.getElementById('check-update'))`), 'native WebView bridge');
  await evaluate(`(() => {
    const previous = BrclioNative.onmessage;
    const waiting = new Map(); let id = 0;
    BrclioNative.onmessage = event => {
      const response = JSON.parse(event.data); const resolve = waiting.get(response.id);
      if (resolve) { waiting.delete(response.id); resolve(response); } else if (previous) previous(event);
    };
    window.proxyAcceptanceCall = method => new Promise(resolve => {
      const key = 'proxy-acceptance-' + (++id); waiting.set(key, resolve);
      BrclioNative.postMessage(JSON.stringify({ id: key, method, params: {} }));
    }); return true;
  })()`);
  return { evaluate, close() { socket.close(); for (const item of pending.values()) clearTimeout(item.timer); } };
}

let inspector;
let phase = 'installation';
const forwards = [];
let backend;
let stopMonitoring = false, sawDirectCore = false, directMonitor, directMonitorFailed = false;
async function report(check, details) {
  const output = path.join(root, `dist-android/update-${expectedMode === 'direct' ? 'direct' : 'proxy'}-emulator-verification.json`);
  await mkdir(path.dirname(output), { recursive: true });
  const result = { verifiedAt: new Date().toISOString(), serial, api: await shell('getprop', 'ro.build.version.sdk'),
    bootstrapTransportFixture: false, sourceOrBinaryFixture, backendOnlySubscriptions: true, backendRevision: backend.revision,
    configuredSubscriptionCount: backend.subscriptionUrls.length, expectedMode,
    abi: await shell('getprop', 'ro.product.cpu.abi'), apkSha256: createHash('sha256').update(await readFile(apk)).digest('hex'),
    checkedVersion: check.result.update?.versionName || check.result.currentVersion, status: check.result.status,
    ...details,
    limitations: ['Debug API35 emulator acceptance; no claim of signed production installation or physical device verification.'] };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
try {
  assert.equal(await shell('getprop', 'sys.boot_completed'), '1', 'Boot the emulator before acceptance.');
  phase = 'live backend configuration';
  const response = await fetch('https://xhs.download.brclio.com/api/account', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update-proxy-config' }),
    signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, 'Live administration configuration is unavailable.');
  backend = (await response.json()).proxyConfig;
  assert.ok(backend && Number.isSafeInteger(backend.revision) && backend.revision >= 0, 'Live proxy config is invalid.');
  backend.subscriptionUrls = backend.subscriptionUrls || (backend.subscriptionUrl ? [backend.subscriptionUrl] : []);
  assert.ok(Array.isArray(backend.subscriptionUrls) && backend.subscriptionUrls.length <= 8);
  if (expectedMode === 'proxy') assert.ok(backend.enabled && backend.revision > 0, 'Live fallback acceptance requires an enabled backend.');
  const embedded = JSON.parse((await exec('unzip', ['-p', apk, 'assets/update-proxy/subscription.json'])).stdout);
  assert.equal((embedded.subscriptionUrls || []).length, 0, 'The APK must not contain preset subscriptions.');
  assert.equal(Boolean(embedded.subscriptionUrl), false, 'The APK must not contain a preset subscription.');
  const beforeProxy = await shell('settings', 'get', 'global', 'http_proxy');
  const beforeLinks = (await shell('ip', 'link')).split('\n').filter(line => /: (tun|vpn)/.test(line));
  if (expectedMode === 'direct') {
    assert.ok(['null', ':0', ''].includes(beforeProxy), 'Direct acceptance requires a disposable emulator without a system HTTP proxy.');
    assert.equal(beforeLinks.length, 0, 'Direct acceptance requires a disposable emulator without a VPN interface.');
  }
  await device('install', '-r', apk);
  // A fresh disposable debug app proves the live backend rather than a previous offline cache.
  assert.equal(await shell('pm', 'clear', app), 'Success');
  if (expectedMode === 'direct') directMonitor = (async () => {
    while (!stopMonitoring) {
      if (await corePid()) sawDirectCore = true;
      await pause(120);
    }
  })().catch(() => { directMonitorFailed = true; });
  await shell('am', 'start', '-n', `${app}/com.brclio.xhs.MainActivity`);
  phase = 'startup check';
  inspector = await openInspector();
  await until(() => inspector.evaluate(`!document.getElementById('check-update').disabled`), 'startup check completion', 120000);
  if (expectedMode === 'proxy') {
    const cached = JSON.parse(await shell('run-as', app, 'cat', 'no_backup/update-proxy-config.json'));
    assert.equal(cached.revision, backend.revision, 'Fallback startup must fetch the current live backend revision.');
    assert.equal(JSON.stringify(cached.subscriptionUrls) === JSON.stringify(backend.revision > 0 ? backend.subscriptionUrls : []), true,
      'Fallback startup must use the live administrator sources.');
  }
  const operation = inspector.evaluate(`proxyAcceptanceCall('checkUpdate')`);
  if (expectedMode === 'direct') {
    phase = 'direct native metadata check';
    let finished = false;
    operation.finally(() => { finished = true; });
    while (!finished) {
      assert.equal(await corePid(), null, 'Successful direct checks must never start the proxy.');
      await pause(120);
    }
    const check = await operation;
    assert.equal(check.ok, true, `Native direct check failed: ${check.error || 'unknown'}`);
    assert.ok(['latest', 'available', 'downloaded', 'unpublished'].includes(check.result.status));
    assert.equal(await corePid(), null);
    stopMonitoring = true;
    await directMonitor;
    assert.equal(directMonitorFailed, false, 'Core monitoring must complete without an ADB failure.');
    assert.equal(sawDirectCore, false, 'Startup and manual direct checks must never start the proxy.');
    let cached = false;
    try { await shell('run-as', app, 'test', '-e', 'no_backup/update-proxy-config.json'); cached = true; }
    catch { /* A successful direct request does not fetch administrator proxy configuration. */ }
    assert.equal(cached, false, 'Successful direct checks must not fetch or cache update proxy configuration.');
    assert.equal(await shell('settings', 'get', 'global', 'http_proxy'), beforeProxy);
    assert.deepEqual((await shell('ip', 'link')).split('\n').filter(line => /: (tun|vpn)/.test(line)), beforeLinks);
    await inspector.evaluate(`document.getElementById('check-update').scrollIntoView({block: 'center'})`);
    const capture = await exec(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    await writeFile(path.join(root, 'dist-android/update-direct-emulator-verification.png'), capture.stdout);
    await report(check, { nodesProbed: 0, availableNodes: 0, normalCleanup: true, proxyNeverStarted: true, proxyConfigurationNotFetched: true,
      systemProxyUnchanged: true, noVpnInterfaceAdded: true });
    process.exitCode = 0;
  } else {
  phase = 'native core startup';
  await Promise.race([until(corePid, 'packaged native core', 120000), operation.then(check => {
    throw new Error(`Native check ended before proxy startup: ${check.ok ? check.result.status : check.error || 'unknown'}`);
  })]);
  const configPath = await until(async () => {
    const files = (await shell('run-as', app, 'find', 'cache/update-proxy', '-name', 'config.yaml')).split('\n').filter(Boolean);
    const dated = await Promise.all(files.map(async file => ({ file, modified: Number(await shell('run-as', app, 'stat', '-c', '%Y', file)) })));
    return dated.sort((left, right) => right.modified - left.modified)[0]?.file;
  }, 'private core config');
  const config = YAML.parse(await shell('run-as', app, 'cat', configPath));
  assert.equal(config['allow-lan'], false);
  assert.equal(config['bind-address'], '127.0.0.1');
  assert.equal(config.tun.enable, false);
  assert.equal(config.dns.enable, false);
  assert.equal(config.rules.at(-1), 'MATCH,REJECT');
  assert.deepEqual(config['skip-auth-prefixes'], []);
  const port = await device('forward', 'tcp:0', `tcp:${Number(config['external-controller'].split(':').at(-1))}`);
  forwards.push(port);
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/version`, { headers: { Authorization: `Bearer ${config.secret}` } })).ok; }
    catch { return false; }
  }, 'authenticated controller startup');
  assert.equal((await fetch(`http://127.0.0.1:${port}/version`)).status, 401, 'Controller must reject missing authentication.');
  const proxyPort = await device('forward', 'tcp:0', `tcp:${config['mixed-port']}`);
  forwards.push(proxyPort);
  assert.equal(await connectStatus(Number(proxyPort)), 407, 'Local proxy must reject missing authentication.');
  const controller = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/proxies`, { headers: { Authorization: `Bearer ${config.secret}` } });
      return response.ok ? (await response.json()).proxies : null;
    } catch { return null; }
  };
  const observed = await until(async () => {
    const proxies = await controller();
    if (!proxies) return null;
    const measured = Object.values(proxies).filter(item => /^brclio-node-\d+$/.test(item.name) && item.history?.length);
    return measured.length === config.proxies.length ? proxies : null;
  }, 'all node latency probes');
  phase = 'native metadata check';
  const ranked = Object.values(observed).filter(item => /^brclio-node-\d+$/.test(item.name) && item.history?.at(-1)?.delay > 0)
    .map(item => ({ name: item.name, delayMs: item.history.at(-1).delay })).sort((left, right) => left.delayMs - right.delayMs);
  assert.ok(ranked.length, 'At least one subscription node must be available.');
  const check = await operation;
  assert.equal(check.ok, true, `Native update check failed: ${check.error || 'unknown'}`);
  assert.ok(['latest', 'available', 'downloaded', 'unpublished'].includes(check.result.status));
  await until(async () => !(await corePid()), 'normal check cleanup');
  const cancellation = inspector.evaluate(`proxyAcceptanceCall('checkUpdate')`);
  phase = 'cancellation';
  await until(corePid, 'core for cancellation');
  assert.equal((await inspector.evaluate(`proxyAcceptanceCall('cancelUpdate')`)).result.cancelled, true);
  assert.equal((await cancellation).result.cancelled, true);
  await until(async () => !(await corePid()), 'cancelled core cleanup');
  const dying = inspector.evaluate(`proxyAcceptanceCall('checkUpdate')`).catch(() => null);
  phase = 'owner process death';
  await until(corePid, 'core for owner death');
  const parentPid = (await shell('pidof', app)).trim();
  await shell('run-as', app, 'kill', '-9', parentPid);
  await until(async () => !(await corePid()), 'core exit after owner SIGKILL');
  inspector.close();
  inspector = null;
  void dying;
  const afterProxy = await shell('settings', 'get', 'global', 'http_proxy');
  const afterLinks = (await shell('ip', 'link')).split('\n').filter(line => /: (tun|vpn)/.test(line));
  assert.equal(afterProxy, beforeProxy, 'The app must not modify Android system proxy settings.');
  assert.deepEqual(afterLinks, beforeLinks, 'The updater must not create a system VPN/TUN interface.');
  await report(check, {
    nodesProbed: config.proxies.length, availableNodes: ranked.length,
    normalCleanup: true, cancellationCleanup: true, ownerDeathCleanup: true, systemProxyUnchanged: true, noVpnInterfaceAdded: true });
  }
} catch (error) {
  console.error(error instanceof Error && !error.message.includes('Command failed:') ? error.message : `Android proxy acceptance failed during ${phase}.`);
  process.exitCode = 1;
} finally {
  stopMonitoring = true;
  await directMonitor?.catch(() => {});
  if (inspector) inspector.close();
  for (const port of forwards) await device('forward', '--remove', `tcp:${port}`).catch(() => {});
  await shell('am', 'force-stop', app).catch(() => {});
}
