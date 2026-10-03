// Explicitly opt into the operator's private subscription. No token or node
// credentials appear in the validation report or console.
import { app, net, session } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { UpdateProxyNetwork, subscriptionUrls } from '../desktop/update-proxy.js';
import { UpdateManager } from '../desktop/update-manager.js';

const root = process.cwd();
const temporary = mkdtempSync(path.join(os.tmpdir(), 'brclio-update-proxy-live-'));
app.setPath('userData', path.join(temporary, 'profile'));
let controller, running, configurationServer;
let report = { platform: process.platform, arch: process.arch, checkedAt: new Date().toISOString(), events: [] };
async function verify() {
const download = process.argv.includes('--download');
const timer = setTimeout(() => controller?.abort(new Error('verification timeout')), download ? 900000 : 120000);
try {
  if (!process.argv.includes('--live')) throw new Error('Pass --live to verify the privately configured subscription.');
  const configuration = JSON.parse(await readFile(path.join(root, 'desktop/account-config.json'), 'utf8'));
  const runtimeDirectory = path.join(root, 'desktop-runtime', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`, 'proxy');
  let endpoint = configuration.endpoint;
  const selectedSource = process.argv.find(argument => argument.startsWith('--source='));
  if (selectedSource) {
    const fixtureArgument = process.argv.find(argument => argument.startsWith('--config-fixture='));
    if (!fixtureArgument) throw new Error('--source requires an explicit private --config-fixture JSON; production reads only the backend.');
    const index = Number(selectedSource.slice('--source='.length)) - 1;
    const sources = subscriptionUrls(JSON.parse(await readFile(path.resolve(fixtureArgument.slice('--config-fixture='.length)), 'utf8')));
    if (!Number.isInteger(index) || index < 0 || index >= sources.length) throw new Error('Invalid fixture source index.');
    // Explicit test fixture only; ordinary live verification reads the actual
    // administrator endpoint. Subscription/core/GitHub traffic is real.
    configurationServer = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, proxyConfig: { enabled: true, revision: 1,
        subscriptionUrls: [sources[index]], subscriptionUrl: sources[index] } }));
    });
    await new Promise(resolve => configurationServer.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${configurationServer.address().port}/api/account`;
    report.configurationFixture = { source: index + 1, totalFixtureSources: sources.length };
  }
  const network = new UpdateProxyNetwork({ net, session, endpoint, runtimeDirectory,
    cacheDirectory: path.join(temporary, 'updates'), onDiagnostic: (event, details) => report.events.push({ event, details }) });
  const scopedRun = network.run.bind(network);
  network.run = async (...arguments_) => {
    try { return await scopedRun(...arguments_); }
    catch (error) { report.networkFailure = { code: error.code || null, type: error.constructor.name }; throw error; }
  };
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const proxyBefore = await session.defaultSession.resolveProxy('https://api.github.com/zen');
  report.defaultSessionUnchanged = true;
  let progressMark = -1;
  const manager = new UpdateManager({ currentVersion: download ? '0.0.0' : pkg.version, directory: path.join(temporary, 'updates'),
    fetchImpl: async (url, options) => {
      report.defaultSessionUnchanged &&= await session.defaultSession.resolveProxy('https://api.github.com/zen') === proxyBefore;
      return network.fetch(url, options);
    }, networkScope: network, onUpdate(state) {
      if (state.status === 'downloading') {
        const mark = Math.floor(state.download.percent / 20);
        if (mark > progressMark) { progressMark = mark; console.log(`Installer download: ${state.download.percent}%`); }
      }
    } });
  running = manager.checkForUpdates();
  controller = manager.controller;
  let result = await running;
  if (download && result.status === 'available') {
    running = manager.downloadUpdate(); controller = manager.controller;
    result = await running;
    report.downloadVerified = result.status === 'downloaded';
    report.downloadBytes = result.download.receivedBytes;
  }
  report.status = result.status;
  report.latestVersion = result.latestVersion;
  report.error = result.error;
  report.activeScopesAfterCheck = network.active.size;
  report.proxySelected = report.events.some(value => value.event === 'update.proxy_selected');
  report.systemProxySelected = report.events.some(value => value.event === 'update.proxy_system_selected');
  report.networkRoute = report.systemProxySelected ? 'system' : report.proxySelected ? 'internal' : 'direct';
  report.proxyStopped = report.events.some(value => value.event === 'update.proxy_stopped');
  report.defaultSessionUnchanged &&= await session.defaultSession.resolveProxy('https://api.github.com/zen') === proxyBefore;
  const success = !result.error && (report.proxySelected || report.systemProxySelected) && report.proxyStopped && network.active.size === 0
    && report.defaultSessionUnchanged && (!download || report.downloadVerified);
  const output = path.join(root, 'dist-desktop/proxy-validation'); await mkdir(output, { recursive: true });
  const suffix = report.configurationFixture ? `-source-${report.configurationFixture.source}` : '';
  await writeFile(path.join(output, `${download ? 'live-download' : 'live-check'}${suffix}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!success) throw new Error('Live update proxy verification failed.');
  clearTimeout(timer);
  if (configurationServer) { configurationServer.closeAllConnections(); await new Promise(resolve => configurationServer.close(resolve)); }
  await rm(temporary, { recursive: true, force: true }); app.exit(0);
} catch (error) {
  clearTimeout(timer); controller?.abort(); await running?.catch(() => {});
  console.error(error.code || 'UPDATE_PROXY_VERIFICATION_FAILED');
  if (configurationServer) { configurationServer.closeAllConnections(); await new Promise(resolve => configurationServer.close(resolve)); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  app.exit(1);
}
}
// Electron readiness follows ESM evaluation, so awaiting readiness at module
// scope would prevent this verification app from starting.
app.whenReady().then(verify).catch(() => app.exit(1));
