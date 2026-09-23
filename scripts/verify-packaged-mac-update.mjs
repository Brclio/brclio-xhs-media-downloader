// Isolated, real packaged main/preload/UI update acceptance.
// Usage: node scripts/verify-packaged-mac-update.mjs /absolute/path/Brclio.app
// The input is read-only. Only temporary clones gain a fixture bootstrap and a
// synthetic patch version. All original application source stays byte-identical.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const asar = createRequire(import.meta.url)('@electron/asar');
const command = (file, args) => run(file, args, { timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
async function until(check, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  let sequence = 0;
  const evaluate = (expression, awaitPromise = false) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const done = (error, value) => {
      clearTimeout(timer); socket.removeEventListener('message', message); socket.removeEventListener('close', closed);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('CDP evaluation timed out')), 30000);
    const closed = () => done(new Error('CDP closed'));
    const message = event => {
      const response = JSON.parse(event.data);
      if (response.id !== id) return;
      if (response.error || response.result?.exceptionDetails) done(new Error(JSON.stringify(response.error || response.result.exceptionDetails)));
      else done(null, response.result?.result?.value);
    };
    socket.addEventListener('message', message); socket.addEventListener('close', closed, { once: true });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
  });
  return { evaluate, close: () => socket.close() };
}

function bootstrap(configPath) {
  // Electron waits for the ESM entry's top-level await before app readiness.
  // A fire-and-forget CJS import could register the real custom scheme too late.
  return `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const __dirname = require('node:path').dirname(require('node:url').fileURLToPath(import.meta.url));
const { app, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'));
app.setPath('userData', config.profile); app.setPath('sessionData', config.profile);
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', '0');
const record = value => fs.appendFileSync(config.events, JSON.stringify(value) + '\\n');
record({ type: 'boot', pid: process.pid, version: app.getVersion(), packaged: app.isPackaged,
  nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null, profile: app.getPath('userData') });
globalThis.fetch = async () => { throw new Error('Packaged updater fixture blocks external fetch'); };
const blockNetwork = value => value.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
app.on('session-created', blockNetwork);
app.whenReady().then(() => blockNetwork(session.defaultSession));
net.request = options => {
  const request = new EventEmitter(); let incoming, aborted = false;
  request.abort = () => { aborted = true; incoming?.destroy(); };
  request.end = () => queueMicrotask(() => {
    if (aborted) return;
    try {
      if (options.method !== 'GET') throw new Error('Fixture only permits GET');
      const fixture = JSON.parse(fs.readFileSync(config.responses, 'utf8'));
      if (options.url === fixture.releaseUrl) {
        const body = Buffer.from(JSON.stringify(fixture.release));
        incoming = Readable.from([body]); incoming.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
      } else if (options.url === fixture.assetUrl) {
        incoming = fs.createReadStream(fixture.dmg); incoming.headers = { 'content-type': 'application/octet-stream', 'content-length': String(fixture.size) };
      } else throw new Error('Fixture refuses a non-fixture URL');
      incoming.statusCode = 200;
      record({ type: 'update-request', url: options.url }); request.emit('response', incoming);
    } catch (error) { request.emit('error', error); }
  });
  return request;
};
// This is the input archive's unmodified real main, including its UpdateManager,
// confirmation broker, preload, helper preparation and startup cleanup path.
await import(pathToFileURL(path.join(__dirname, config.originalMain)).href).catch(error => {
  record({ type: 'main-error', message: error.stack }); app.exit(1);
});
`;
}

export async function verifyPackagedMacUpdate(input) {
  assert.equal(process.platform, 'darwin', 'Packaged update acceptance requires macOS');
  const appPath = await realpath(input);
  assert.ok(appPath.endsWith('.app') && !(await lstat(input)).isSymbolicLink());
  const inputArchive = path.join(appPath, 'Contents/Resources/app.asar');
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const originalDigest = await digest(inputArchive);
  const packaged = JSON.parse(asar.extractFile(inputArchive, 'package.json'));
  assert.equal(packaged.main, 'desktop/main.js');
  assert.match(packaged.version, /^\d+\.\d+\.\d+$/);
  const parts = packaged.version.split('.').map(Number); parts[2]++;
  const targetVersion = parts.join('.');
  const updater = asar.extractFile(inputArchive, 'desktop/mac-update.js').toString();
  assert.equal(updater.match(/env: guiEnvironment\(\)/g)?.length, 2, 'Input must contain both fixed GUI launch paths');
  const expectedHelper = /const HELPER = String.raw`([\s\S]*?)`;\n\nconst RESULTS/.exec(updater)?.[1];
  assert.ok(expectedHelper);
  const files = asar.listPackage(inputArchive).map(name => name.replace(/^\//, ''))
    .filter(name => !asar.statFile(inputArchive, name).files && name !== 'package.json');
  assert.ok(!files.some(name => name.endsWith('.node')), 'Native modules need an explicit unpacking fixture');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'xhs-packaged-update-')));
  const profile = path.join(root, 'profile'); await mkdir(profile);
  const events = path.join(root, 'events.jsonl'), responses = path.join(root, 'responses.json');
  const configPath = path.join(root, 'fixture.json');
  await writeFile(configPath, JSON.stringify({ profile, events, responses, originalMain: packaged.main }));
  let child, connection, stderr = '';
  const fixtureSource = bootstrap(configPath);
  const readEvents = async () => (await readFile(events, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const inputInfo = JSON.parse((await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents/Info.plist')])).stdout);
  const executableName = inputInfo.CFBundleExecutable;
  assert.equal(executableName, path.basename(executableName));
  const current = path.join(root, path.basename(appPath));
  const payload = path.join(root, 'payload'); await mkdir(payload);
  async function clone(destination, version) {
    await command('/bin/cp', ['-cR', appPath, destination]);
    const tree = await mkdtemp(path.join(root, 'asar-tree-'));
    asar.extractAll(inputArchive, tree);
    await writeFile(path.join(tree, 'package.json'), JSON.stringify({ ...packaged, version, main: 'update-fixture-bootstrap.mjs' }));
    await writeFile(path.join(tree, 'update-fixture-bootstrap.mjs'), fixtureSource);
    const archive = path.join(destination, 'Contents/Resources/app.asar');
    await rm(archive); await asar.createPackage(tree, archive); asar.uncache(archive);
    for (const file of files) assert.ok(asar.extractFile(archive, file).equals(asar.extractFile(inputArchive, file)), `Fixture changed product source: ${file}`);
    const info = { ...inputInfo, CFBundleShortVersionString: version, CFBundleVersion: version };
    if (info.ElectronAsarIntegrity) info.ElectronAsarIntegrity = { ...info.ElectronAsarIntegrity,
      'Resources/app.asar': { algorithm: 'SHA256', hash: createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex') } };
    const plist = path.join(destination, 'Contents/Info.plist'); await writeFile(plist, JSON.stringify(info));
    await command('/usr/bin/plutil', ['-convert', 'xml1', plist]);
    await command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', destination]);
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
    await rm(tree, { recursive: true, force: true });
  }
  async function renderer(version, afterTimeOrigin = 0) {
    return until(async () => {
      try {
        const port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(r => r.json());
        const page = targets.find(item => item.type === 'page' && item.url.startsWith('xhs-app://local/'));
        if (!page) return false;
        const client = await cdp(page.webSocketDebuggerUrl);
        try {
          if (await client.evaluate(`document.body?.dataset.desktopReady === 'true' && !!window.xhsDesktop && performance.timeOrigin > ${afterTimeOrigin}`)
            && (await client.evaluate('window.xhsDesktop.getInfo()', true)).version === version) return client;
        } catch { /* Initial renderer navigation can replace its context. */ }
        client.close();
      } catch { /* DevTools port is rewritten on replacement app startup. */ }
      return false;
    }, `real packaged ${version} renderer`);
  }
  try {
    await clone(current, packaged.version);
    await clone(path.join(payload, path.basename(appPath)), targetVersion);
    // Seed an actual old receipt in the isolated user profile. Production main
    // must expose it as separately attributed history through its real preload,
    // and acknowledgement must not erase the recovery journal or its pointer.
    const updates = path.join(profile, 'updates');
    const historyDirectory = path.join(updates, 'mac-install-Hst123');
    await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
    const historyPath = path.join(historyDirectory, 'install-result.json');
    const historyPointer = path.join(updates, 'mac-last-install.json');
    const historyBackup = path.join(root, 'historical-backup', 'previous.app');
    await mkdir(historyBackup, { recursive: true });
    const historySentinel = path.join(historyBackup, 'keep.txt');
    await writeFile(historySentinel, 'Historical recovery backup must remain untouched');
    const historyReceipt = JSON.stringify({ appId: 'cn.bornforthis.xhs-downloader',
      currentAppPath: current, version: '1.8.3', backupVersion: '1.8.2', status: 'rolled_back',
      preparedAt: '2026-09-22T02:03:04.000Z', backupPath: historyBackup,
      message: 'Historical raw receipt must not become a current update message',
      startupToken: 'isolated-fixture-private-token' });
    const historyPointerContents = JSON.stringify({ resultPath: historyPath });
    await writeFile(historyPath, historyReceipt, { mode: 0o600 });
    await writeFile(historyPointer, historyPointerContents, { mode: 0o600 });
    const assetName = `Brclio-XHS-Downloader-${targetVersion}-mac-${process.arch}.dmg`;
    const dmg = path.join(root, assetName);
    await command('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Packaged Update Fixture', '-srcfolder', payload, '-format', 'UDZO', dmg]);
    const size = (await lstat(dmg)).size, sha256 = await digest(dmg);
    const repository = 'Brclio/brclio-xhs-media-downloader', tag = `v${targetVersion}`;
    const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
    await writeFile(responses, JSON.stringify({ dmg, size, assetUrl, releaseUrl: `https://api.github.com/repos/${repository}/releases/latest`,
      release: { draft: false, prerelease: false, tag_name: tag, html_url: `https://github.com/${repository}/releases/tag/${tag}`,
        body: 'Isolated packaged updater acceptance fixture.', assets: [{ name: assetName, size, browser_download_url: assetUrl, digest: `sha256:${sha256}` }] } }));
    const env = { ...process.env };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH']) delete env[name];
    child = spawn(path.join(current, 'Contents/MacOS', executableName), [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    connection = await renderer(packaged.version);
    const click = selector => connection.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const updateState = () => connection.evaluate('window.xhsDesktop.getUpdateState()', true);
    await click('#about-tab');
    const historical = await until(() => connection.evaluate('window.xhsDesktop.getUpdateHistory()', true),
      'real main/preload historical installation receipt');
    assert.equal(historical.status, 'rolled_back');
    assert.equal(historical.targetVersion, '1.8.3');
    assert.equal(historical.previousVersion, '1.8.2');
    assert.equal(historical.currentVersion, packaged.version);
    assert.equal(historical.recordedAt, '2026-09-22T02:03:04.000Z');
    assert.doesNotMatch(JSON.stringify(historical), /isolated-fixture-private-token|startupToken|backupPath|Historical raw receipt/);
    await until(() => connection.evaluate("!document.querySelector('#desktop-update-history').hidden"),
      'real UI nonmodal historical receipt');
    const historyText = await connection.evaluate("document.querySelector('#desktop-update-history').textContent");
    assert.match(historyText, /上次安装记录/);
    assert.match(historyText, /安装目标 v1\.8\.3/);
    assert.ok(historyText.includes(`当前版本 v${packaged.version}`));
    assert.match(historyText, /此前安装的记录/);
    await click('#desktop-update-history-dismiss');
    await until(async () => await connection.evaluate('window.xhsDesktop.getUpdateHistory()', true) === null
      && await connection.evaluate("document.querySelector('#desktop-update-history').hidden"),
    'real main persisted history acknowledgement');
    assert.equal(await readFile(historyPath, 'utf8'), historyReceipt);
    assert.equal(await readFile(historyPointer, 'utf8'), historyPointerContents);
    assert.ok(JSON.parse(await readFile(path.join(updates, 'mac-install-notices.json'), 'utf8')).ids.includes(historical.id),
      'The actual main process must persist acknowledgement before hiding history');
    assert.equal(await readFile(historySentinel, 'utf8'), 'Historical recovery backup must remain untouched');
    const timeOrigin = await connection.evaluate('performance.timeOrigin');
    await connection.evaluate('location.reload()');
    connection.close(); connection = await renderer(packaged.version, timeOrigin);
    assert.equal(await connection.evaluate('window.xhsDesktop.getUpdateHistory()', true), null);
    assert.equal(await connection.evaluate("document.querySelector('#desktop-update-history').hidden"), true);
    await click('#about-tab');
    await connection.evaluate('window.xhsDesktop.checkForUpdates()', true);
    assert.equal((await updateState()).latestVersion, targetVersion);
    await click('#desktop-update-dialog-action');
    await until(async () => (await updateState()).status === 'downloaded', 'real checksum-verified fixture download', 60000);
    await until(() => connection.evaluate("document.querySelector('#desktop-update-dialog-action').dataset.action === 'install' && !document.querySelector('#desktop-update-dialog-action').disabled"),
      'download invocation finished and install action enabled');
    await click('#desktop-update-dialog-action');
    await until(() => connection.evaluate("document.querySelector('#desktop-install-confirmation').open"), 'real main/preload installation confirmation');
    await click('#desktop-install-confirm');
    const resultPath = await until(async () => {
      try {
        const value = JSON.parse(await readFile(historyPointer, 'utf8')).resultPath;
        return value && value !== historyPath ? value : false;
      } catch { return false; }
    }, 'packaged main generated installation transaction', 120000);
    assert.equal(path.dirname(path.dirname(resultPath)), updates);
    assert.equal(await readFile(path.join(path.dirname(resultPath), 'install.cjs'), 'utf8'), expectedHelper,
      'The installed packaged main must generate the fixed helper from its own archive');
    connection.close(); connection = null;
    const receipt = await until(async () => {
      const value = JSON.parse(await readFile(resultPath, 'utf8'));
      if (['rolled_back', 'rollback_failed', 'helper_failed', 'candidate_invalid'].includes(value.status)) throw new Error(`Packaged update failed: ${value.status}; ${stderr}`);
      return value.status === 'installed' && value.backupRemoved === true ? value : false;
    }, 'replacement GUI startup acknowledgment and old-bundle cleanup', 150000);
    connection = await renderer(targetVersion);
    assert.equal((await connection.evaluate('window.xhsDesktop.getInfo()', true)).pythonAvailable, true);
    assert.equal(await connection.evaluate('window.xhsDesktop.getUpdateHistory()', true), null);
    assert.equal(await readFile(historyPath, 'utf8'), historyReceipt);
    assert.equal(await readFile(historySentinel, 'utf8'), 'Historical recovery backup must remain untouched');
    assert.equal(receipt.startupConfirmed, true);
    await assert.rejects(lstat(receipt.backupPath), { code: 'ENOENT' });
    const bootEvents = (await readEvents()).filter(value => value.type === 'boot');
    assert.deepEqual(bootEvents.map(value => value.version), [packaged.version, targetVersion]);
    assert.ok(bootEvents.every(value => value.packaged && value.nodeMode === null && value.profile === profile));
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', current]);
    assert.equal(await digest(inputArchive), originalDigest, 'Input application must remain unchanged');
    const evidence = { packagedMacUpdateVerified: true, currentVersion: packaged.version, targetVersion,
      originalApplicationFilesCompared: files.length, sourceUnchanged: true, realPackagedMainAndPreload: true,
      packagedUpdateHistoryVerified: true, historyAcknowledgementPersisted: true, historyRecoveryFilesPreserved: true,
      realConfirmation: true, generatedHelperMatchesPackage: true, automaticGuiRelaunch: true, backupRemoved: true,
      profile: 'temporary', keychain: 'mock', updateNetwork: 'fixture-only', fixtureResigned: true, gatekeeperApprovalTested: false };
    console.log(JSON.stringify(evidence)); return evidence;
  } catch (error) {
    const journalStates = [];
    for (const entry of await readdir(path.join(profile, 'updates')).catch(() => [])) {
      if (!/^mac-install-[a-zA-Z0-9]{6}$/.test(entry)) continue;
      try {
        const value = JSON.parse(await readFile(path.join(profile, 'updates', entry, 'install-result.json'), 'utf8'));
        journalStates.push({ status: value.status, version: value.version, failureCode: value.failureCode, message: value.message });
      } catch { /* An incomplete fixture journal is not a second error. */ }
    }
    throw new Error(`${error.message}; isolated fixture diagnostics: ${JSON.stringify({ events: await readEvents(), journalStates, stderr })}`, { cause: error });
  } finally {
    connection?.close();
    // Only stop processes whose executable is inside this unique temporary root.
    // Include the detached updater, Python and progress viewer by their known paths.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const rows = (await command('/bin/ps', ['-axo', 'pid=,command='])).stdout.split('\n');
      for (const row of rows) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(row);
        if (match && Number(match[1]) !== process.pid && match[2].includes(root + path.sep)) {
          try { process.kill(Number(match[1]), signal); } catch { /* Already exited. */ }
        }
      }
      await delay(signal === 'SIGTERM' ? 1500 : 200);
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Usage: node scripts/verify-packaged-mac-update.mjs /absolute/path/Application.app');
  await verifyPackagedMacUpdate(process.argv[2]);
}
