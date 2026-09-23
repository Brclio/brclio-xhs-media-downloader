// Developer smoke: run with node_modules/.bin/electron scripts/verify-desktop.mjs.
// Uses a disposable application profile and the real main/preload/protocol code.
import { app, Menu, net, session } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectronUpdateFetch } from '../desktop/update-manager.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// Match Electron's packaged init while keeping every session in a throwaway path.
app.setName(pkg.productName);
const temporary = mkdtempSync(path.join(tmpdir(), 'xhs-desktop-smoke-'));
app.setPath('userData', temporary);
app.setPath('sessionData', temporary);
app.getAppPath = () => root;
app.getVersion = () => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
let done = false;
const timer = setTimeout(() => { console.error('DESKTOP_SMOKE_TIMEOUT'); app.exit(1); }, 40000);

async function verifyUpdateTransport() {
  let payloadRequests = 0;
  const installer = Buffer.from('verified installer fixture');
  let requestedRange;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/payload' }); response.end(); }
    else if (request.url === '/slow') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff' }); response.write('begin'); }
    else if (request.url === '/range') {
      requestedRange = request.headers.range;
      response.writeHead(206, { 'content-type': 'application/octet-stream',
        'content-range': `bytes 9-${installer.length - 1}/${installer.length}`, 'content-length': installer.length - 9 });
      response.end(installer.subarray(9));
    }
    else { payloadRequests++; response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end('verified installer fixture'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const fetch = createElectronUpdateFetch(net);
    const redirect = await fetch(`${base}/redirect`, { method: 'GET', redirect: 'manual', headers: {} });
    assert.equal(redirect.status, 302);
    assert.equal(new URL(redirect.headers.get('location'), base).href, `${base}/payload`);
    assert.equal(payloadRequests, 0, 'The transport must not follow an unchecked redirect');
    const payload = await fetch(`${base}/payload`, { method: 'GET', redirect: 'manual', headers: {} });
    assert.equal(await payload.text(), 'verified installer fixture');
    const resumed = await fetch(`${base}/range`, { headers: { Range: 'bytes=9-', 'Accept-Encoding': 'identity' } });
    assert.equal(requestedRange, 'bytes=9-', 'The actual Electron transport forwards the persisted byte offset');
    assert.equal(resumed.status, 206);
    assert.equal(resumed.headers.get('content-range'), `bytes 9-${installer.length - 1}/${installer.length}`);
    assert.deepEqual(Buffer.concat([installer.subarray(0, 9), Buffer.from(await resumed.arrayBuffer())]), installer);
    const controller = new AbortController();
    const slow = await fetch(`${base}/slow`, { method: 'GET', redirect: 'manual', headers: {}, signal: controller.signal });
    const body = slow.text();
    controller.abort();
    await assert.rejects(body);
    return true;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    if (done || !win.webContents.getURL().startsWith('xhs-app://local/')) return;
    done = true;
    try {
      assert.equal(app.getName(), '小红书媒体下载器', 'Keep the existing profile and macOS cookie encryption identity');
      assert.equal(pkg.build.appId, 'cn.bornforthis.xhs-downloader', 'Keep the installation and upgrade identity');
      assert.equal(app.getPath('userData'), temporary);
      assert.equal(app.getPath('sessionData'), temporary);
      assert.equal(session.fromPartition('persist:xhs-account').getStoragePath(), path.join(temporary, 'Partitions', 'xhs-account'));
      assert.equal(win.getTitle(), 'Brclio 小红书下载器');
      if (process.platform === 'darwin') assert.equal(Menu.getApplicationMenu().items[0].label, 'Brclio 小红书下载器');
      const updateTransportVerified = await verifyUpdateTransport();
      const result = await win.webContents.executeJavaScript(`(async () => {
        const info = await window.xhsDesktop.getInfo();
        const state = await window.xhsDesktop.getProfileState();
        const update = await window.xhsDesktop.getUpdateState();
        await window.xhsDesktop.recordDiagnostic('renderer.smoke', { message: 'bridge verified' });
        const diagnostics = await window.xhsDesktop.getDiagnosticsInfo();
        // The window now opens before the OS finishes unlocking credentials.
        const storageDeadline = Date.now() + 10000;
        while ((await window.xhsDesktop.getAccountState()).status === 'initializing' && Date.now() < storageDeadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const feedback = await window.xhsDesktop.submitFeedback({ title: '验证未登录反馈', description: '本地主进程接口验证，无远端上传。', category: 'other' });
        const updateMethods = ['checkForUpdates', 'downloadUpdate', 'cancelUpdateDownload', 'installUpdate', 'onUpdateState', 'onInstallConfirmation', 'respondInstallConfirmation', 'retryItem']
          .every(name => typeof window.xhsDesktop[name] === 'function');
        const payloads = [];
        for (const route of ['/api/parse', '/api/python_parse']) {
          const response = await fetch(route, {method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({text:'https://sns-img-bd.xhscdn.com/smoke-original-image'})});
          const data = await response.json();
          payloads.push({route,status:response.status,success:data.success,engine:data.engine,images:data.images?.length});
        }
        // Module initialization awaits the bridge; drain promises before inspecting.
        await new Promise(resolve=>setTimeout(resolve,100));
        return {info,status:state.status,updateStatus:update.status,updateMethods,payloads,
          diagnosticsVerified: diagnostics.totalBytes > 0 && !('text' in diagnostics), feedbackGuestRejected: !feedback.ok && feedback.error?.code === 'UNAUTHENTICATED',
          profileVisible:!document.querySelector('#profile-panel').hidden,
          tabsVisible:!document.querySelector('#desktop-navigation').hidden,
          nodeAvailable:typeof require === 'function',
          secureContext:window.isSecureContext};
      })()`);
      if (result.info.name !== 'Brclio 小红书下载器' || !result.info.pythonAvailable || result.status !== 'idle' || !result.profileVisible
          || !result.tabsVisible || result.nodeAvailable || !result.secureContext || !result.updateMethods || result.updateStatus !== 'idle' || !result.diagnosticsVerified || !result.feedbackGuestRejected
          || result.payloads.some(value => !value.success || value.images !== 1 || value.status !== 200)) {
        throw new Error(JSON.stringify(result));
      }
      const screenshot = path.join(temporary, 'desktop.png');
      writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ smoke: 'passed', ...result, updateTransportVerified, screenshot }));
      clearTimeout(timer);
      app.quit();
    } catch (error) {
      console.error('DESKTOP_SMOKE_FAILED', error);
      clearTimeout(timer);
      app.exit(1);
    }
  });
});
await import('../desktop/main.js');
