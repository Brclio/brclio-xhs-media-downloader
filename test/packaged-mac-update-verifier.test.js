import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { createFixtureArchive, createPackagedMacBootstrap } from '../scripts/verify-packaged-mac-update.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const wrappedFs = require(path.join(path.dirname(require.resolve('@electron/asar')), 'wrapped-fs.js')).default;

test('packaged Mac bootstrap serves only explicit disabled updater configuration and trusted fixture assets', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'brclio-packaged-network-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = 'https://account-fixture.example/api/account';
  const installer = Buffer.from('packaged updater fixture installer');
  const name = 'Brclio-XHS-1.0.1-mac-arm64.dmg';
  const assetUrl = `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v1.0.1/${name}`;
  const releaseUrl = 'https://api.github.com/repos/Brclio/brclio-xhs-media-downloader/releases/latest';
  const release = { tag_name: 'v1.0.1', draft: false, prerelease: false,
    html_url: 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v1.0.1',
    assets: [{ name, size: installer.length, browser_download_url: assetUrl,
      digest: `sha256:${createHash('sha256').update(installer).digest('hex')}` }] };
  await mkdir(path.join(root, 'desktop'));
  await writeFile(path.join(root, 'desktop/account-config.json'), JSON.stringify({ endpoint }));
  const dmg = path.join(root, name); await writeFile(dmg, installer);
  const profile = path.join(root, 'profile'); await mkdir(profile);
  const events = path.join(root, 'events.jsonl'), responses = path.join(root, 'responses.json');
  await writeFile(responses, JSON.stringify({ dmg, size: installer.length, assetUrl, releaseUrl, release }));
  const configPath = path.join(root, 'fixture.json');
  await writeFile(configPath, JSON.stringify({ profile, events, responses, originalMain: 'original-main.mjs' }));
  // Execute the generated ESM bootstrap in a separate Node process. Only the
  // Electron surface is stubbed; network, updater and transport classes are real.
  const electronDirectory = path.join(root, 'node_modules/electron'); await mkdir(electronDirectory, { recursive: true });
  await writeFile(path.join(electronDirectory, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  await writeFile(path.join(electronDirectory, 'index.cjs'), `
const { EventEmitter } = require('node:events');
const app = new EventEmitter(), paths = {}, guards = [];
app.setPath = (name, value) => { paths[name] = value; };
app.getPath = name => paths[name]; app.getVersion = () => '1.0.0'; app.isPackaged = true;
app.commandLine = { appendSwitch() {} }; app.whenReady = () => Promise.resolve();
app.exit = code => { process.exitCode = code; };
const makeSession = () => ({ webRequest: { onBeforeRequest(filter, callback) { guards.push({ filter, callback }); } },
  async setProxy() {}, async resolveProxy() { return 'DIRECT'; }, async closeAllConnections() {}, async clearStorageData() {} });
const session = { defaultSession: makeSession(), fromPartition() {
  const value = makeSession(); app.emit('session-created', value); return value;
} };
module.exports = { app, net: {}, session, guards };
`);
  const networkModule = new URL('../desktop/update-proxy.js', import.meta.url).href;
  const updaterModule = new URL('../desktop/update-manager.js', import.meta.url).href;
  await writeFile(path.join(root, 'original-main.mjs'), `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { UpdateProxyNetwork } from ${JSON.stringify(networkModule)};
import { UpdateManager, createElectronUpdateFetch } from ${JSON.stringify(updaterModule)};
const { net, session, guards } = createRequire(import.meta.url)('electron');
const endpoint = ${JSON.stringify(endpoint)}, assetUrl = ${JSON.stringify(assetUrl)};
const directory = ${JSON.stringify(path.join(profile, 'updates'))};
const network = new UpdateProxyNetwork({ net, session, endpoint, cacheDirectory: directory,
  runtimeDirectory: ${JSON.stringify(path.join(root, 'absent-runtime'))}, platform: 'linux', env: {},
  configuredProxyDetector: async () => false,
  launchCore() { assert.fail('explicitly disabled fixture configuration cannot launch a core'); } });
const manager = new UpdateManager({ currentVersion: '1.0.0', platform: 'darwin', arch: 'arm64', directory,
  networkScope: network, fetchImpl: network.fetch, downloadRetryDelayMs: 0 });
assert.equal((await manager.checkForUpdates()).status, 'available');
assert.equal((await manager.downloadUpdate()).status, 'downloaded');
assert.deepEqual(await readFile(manager.verifiedFile), Buffer.from(${JSON.stringify([...installer])}));
assert.equal(network.active.size, 0);
assert.ok(guards.length >= 3, 'default and per-update sessions retain the external network guard');
for (const guard of guards) {
  assert.deepEqual(guard.filter.urls, ['http://*/*', 'https://*/*']);
  let blocked; guard.callback({}, value => { blocked = value.cancel; }); assert.equal(blocked, true);
}
const transport = createElectronUpdateFetch(net);
for (const [url, method, body] of [
  [endpoint, 'GET'], [endpoint, 'POST', JSON.stringify({ action: 'login', input: {} })],
  [endpoint, 'POST', JSON.stringify({ action: 'update-proxy-config', input: { extra: true } })],
  [endpoint, 'POST', JSON.stringify({ action: 'update-proxy-config', input: {}, proof: {} })],
  ['https://attacker.example/api/account', 'POST', JSON.stringify({ action: 'update-proxy-config', input: {} })],
  [assetUrl, 'POST', '{}'], ['https://attacker.example/installer.dmg', 'GET']
]) await assert.rejects(transport(url, { method, body, headers: { 'Content-Type': 'application/json' } }));
await assert.rejects(globalThis.fetch(endpoint), /blocks external fetch/);
await manager.shutdown();
console.log(JSON.stringify({ status: 'passed', activeScopes: network.active.size }));
`);
  const bootstrapPath = path.join(root, 'bootstrap.mjs');
  await writeFile(bootstrapPath, createPackagedMacBootstrap(configPath));
  const result = await promisify(execFile)(process.execPath, [bootstrapPath], { timeout: 9000 }).catch(error => {
    error.message += `\nFixture events: ${fs.readFileSync(events, 'utf8')}`;
    throw error;
  });
  assert.deepEqual(JSON.parse(result.stdout), { status: 'passed', activeScopes: 0 });
  const requests = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type === 'update-request');
  assert.equal(requests.filter(event => event.url === endpoint).length, 2);
  assert.ok(requests.filter(event => event.url === endpoint).every(event => event.method === 'POST'));
  assert.equal(requests.filter(event => event.url === releaseUrl).length, 1);
  assert.equal(requests.filter(event => event.url === assetUrl).length, 1);
});

test('packaged Mac fixture waits for real ASAR payload writes before byte verification', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'brclio-asar-finish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source);
  const marker = 'support-fixture-delayed-payload';
  const bytes = Buffer.from(`/* ${marker} */\n.support { display: flex; }\n`.repeat(16));
  await writeFile(path.join(source, 'support.css'), bytes);

  const gates = [], secondGate = Promise.withResolvers();
  t.mock.method(wrappedFs, 'createWriteStream', (destination, options) => {
    // Delay only the payload's real disk write; ASAR's header is already on disk.
    // This reproduces a slow final write without timers or changing ASAR bytes.
    const pending = Promise.withResolvers(), blocked = Promise.withResolvers();
    const gate = { release: pending.resolve, blocked: blocked.promise };
    gates.push(gate);
    if (gates.length === 2) secondGate.resolve(gate);
    const deferPayload = (buffers, write) => {
      if (buffers.some(buffer => buffer.includes(marker))) {
        blocked.resolve(); void pending.promise.then(write);
      } else write();
    };
    return fs.createWriteStream(destination, { ...options, fs: {
      open: fs.open, close: fs.close,
      write(fd, buffer, ...args) { deferPayload([buffer], () => fs.write(fd, buffer, ...args)); },
      writev(fd, buffers, ...args) { deferPayload(buffers, () => fs.writev(fd, buffers, ...args)); }
    } });
  });

  const earlyArchive = path.join(root, 'early.asar');
  const earlyOutput = await asar.createPackage(source, earlyArchive);
  try {
    await gates[0].blocked;
    assert.equal(earlyOutput.writableFinished, false, 'the dependency resolves before its output finishes');
    assert.equal(asar.extractFile(earlyArchive, 'support.css').equals(bytes), false, 'an immediate reader sees the incomplete tail');
  } finally { gates[0].release(); await finished(earlyOutput); }
  assert.deepEqual(asar.extractFile(earlyArchive, 'support.css'), bytes);

  const completeArchive = path.join(root, 'complete.asar');
  let completed = false;
  const completion = createFixtureArchive(source, completeArchive).then(() => { completed = true; });
  const finalGate = await secondGate.promise;
  try {
    await finalGate.blocked;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'the fixture must keep waiting while its payload write is blocked');
  } finally { finalGate.release(); await completion; }
  assert.deepEqual(asar.extractFile(completeArchive, 'support.css'), bytes);
});
