// Developer smoke: run with node_modules/.bin/electron scripts/verify-desktop.mjs.
// Uses a disposable application profile and the real main/preload/protocol code.
import { app, BrowserWindow, Menu, net, session, shell } from 'electron';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createElectronUpdateFetch, installerName, LATEST_RELEASE_URL } from '../desktop/update-manager.js';

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
const timer = setTimeout(() => { console.error('DESKTOP_SMOKE_TIMEOUT'); app.exit(1); }, 60000);

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function verifyEmbeddedLearning(win) {
  const evaluate = code => win.webContents.executeJavaScript(code);
  const mainUrl = win.webContents.getURL();
  const initialWindowCount = BrowserWindow.getAllWindows().length;
  const initialState = await evaluate('window.xhsDesktop.getProfileState()');
  const originalSize = win.getContentSize();
  const openExternal = shell.openExternal;
  const opened = [];
  let createdWindows = 0;
  const onWindow = () => { createdWindows++; };
  const failures = [];
  const onFailure = (_event, code, message, url) => failures.push({ code, message, url });
  const screenshots = [];
  shell.openExternal = async url => { opened.push(url); };
  app.on('browser-window-created', onWindow);
  win.webContents.on('did-fail-load', onFailure);
  try {
    assert.equal(await evaluate("!document.querySelector('#desktop-learning-frame').hasAttribute('src')"), true,
      'Promotion stays unloaded until it is selected');
    const draftFields = {
      'share-text': 'https://www.xiaohongshu.com/explore/64e84442000000001700b569',
      'profile-url': 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c',
      'profile-directory': '/tmp/keep-my-download-folder',
      'profile-interval': '12',
      'profile-jitter': '2',
      'desktop-feedback-title': '保留当前反馈草稿',
      'desktop-feedback-description': '打开编程私教页面时，下载器中的表单内容应完整保留。',
      'account-email': 'embedded-learning@example.test'
    };
    await waitFor(() => evaluate("Boolean(document.querySelector('#account-email'))"), 'Account form did not initialize');
    await evaluate(`(() => {
      window.__learningSmokeDocument = document;
      for (const [id, value] of Object.entries(${JSON.stringify(draftFields)})) document.getElementById(id).value = value;
      document.getElementById('desktop-learning-link').click();
    })()`);
    await waitFor(() => evaluate(`document.body.dataset.desktopPage === 'learning'
      && document.querySelector('#desktop-learning-frame').contentDocument?.readyState === 'complete'
      && document.querySelector('#desktop-learning-frame').contentDocument?.body.classList.contains('learning-embedded')`),
    'Embedded learning page did not finish loading');
    const frame = win.webContents.mainFrame.frames.find(candidate => new URL(candidate.url).pathname === '/learn.html');
    assert.ok(frame, 'The actual main window owns the packaged learning frame');
    const evaluateLearning = code => frame.executeJavaScript(code);
    await evaluateLearning("document.getElementById('contact').scrollIntoView({ behavior: 'instant', block: 'start' })");
    await waitFor(() => evaluateLearning(`Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)`),
      'Bundled book artwork and QR code did not load');
    const frameState = await evaluateLearning(`({ url: location.href, desktopBridge: typeof window.xhsDesktop,
      node: typeof require, resources: Array.from(document.querySelectorAll('img[src], script[src], link[rel="stylesheet"]'))
        .map(item => item.src || item.href) })`);
    assert.equal(new URL(frameState.url).protocol, 'xhs-app:');
    assert.equal(new URL(frameState.url).hostname, 'local');
    assert.equal(new URL(frameState.url).pathname, '/learn.html');
    assert.equal(frameState.desktopBridge, 'undefined', 'Promotion does not get a downloader preload bridge');
    assert.equal(frameState.node, 'undefined', 'Promotion has no Node runtime');
    assert.ok(frameState.resources.some(url => new URL(url).pathname === '/assets/learning/book-promo.png'));
    assert.ok(frameState.resources.every(url => url.startsWith('xhs-app://local/')), 'Promotion works from packaged assets only');
    const learningScrollY = await evaluateLearning('scrollY');
    assert.ok(learningScrollY > 0, 'The contact section has a real scroll position to preserve');
    assert.equal(await evaluate(`document.getElementById('desktop-learning-link').getAttribute('aria-selected')`), 'true');
    assert.equal(await evaluate(`document.getElementById('profile-panel').hidden && !document.getElementById('desktop-learning-page').hidden`), true);

    // Exercise real main-process delivery while the downloader panel is hidden.
    win.webContents.send('desktop:profile-update', { ...initialState, status: 'paused', discovered: 4, completed: 2, skipped: 1, failed: 1, items: [] });
    await waitFor(() => evaluate(`document.getElementById('profile-completed').textContent === '2'
      && document.getElementById('desktop-task-badge').textContent === '已暂停'`), 'Hidden downloader did not receive profile progress');
    assert.equal(await evaluate('document.body.dataset.desktopPage'), 'learning', 'Task progress leaves promotion selected');

    await evaluateLearning("document.getElementById('back-to-tool').click()");
    await waitFor(() => evaluate("document.body.dataset.desktopPage === 'profile'"), 'Return link did not restore the previous tool');
    assert.equal(win.webContents.getURL(), mainUrl);
    assert.equal(await evaluate('window.__learningSmokeDocument === document'), true, 'Returning preserves the existing downloader document');
    assert.deepEqual(await evaluate(`Object.fromEntries(Object.keys(${JSON.stringify(draftFields)}).map(id => [id, document.getElementById(id).value]))`), draftFields,
      'Single-note, batch, account and feedback drafts survive the embedded page');

    // Each entry point, including stale target=_blank links, stays in one window.
    await evaluate("document.getElementById('single-note-tab').click(); window.open('/learn.html?source=legacy', '_blank')");
    await waitFor(() => evaluate("document.body.dataset.desktopPage === 'learning'"), 'Legacy popup did not select the embedded page');
    await evaluateLearning("document.getElementById('back-to-tool').click()");
    await waitFor(() => evaluate("document.body.dataset.desktopPage === 'single'"), 'Return link did not restore single-note tab');
    await evaluate("location.assign('/learn.html?source=legacy-navigation')");
    await waitFor(() => evaluate("document.body.dataset.desktopPage === 'learning'"), 'Legacy top-level navigation did not select the embedded page');
    assert.equal(win.webContents.getURL(), mainUrl, 'Main-process routing avoids reloading the tool');
    assert.equal(await evaluate('window.__learningSmokeDocument === document'), true);
    try {
      await waitFor(async () => Math.abs(await evaluateLearning('scrollY') - learningScrollY) <= 1,
        'Leaving and reopening promotion did not preserve its scroll position');
    } catch (error) {
      const actual = await evaluateLearning(`({ scrollY, innerWidth, innerHeight, documentHeight: document.documentElement.scrollHeight,
        url: location.href, contactTop: document.getElementById('contact').getBoundingClientRect().top })`);
      throw new Error(`${error.message}: expected scrollY ${learningScrollY}, actual ${JSON.stringify(actual)}`);
    }

    for (const [tab, page] of [['account-tab', 'account'], ['feedback-tab', 'feedback'], ['about-tab', 'about'], ['profile-tab', 'profile']]) {
      await evaluate(`document.getElementById(${JSON.stringify(tab)}).click()`);
      assert.equal(await evaluate('document.body.dataset.desktopPage'), page);
      await evaluate("document.getElementById('desktop-learning-link').click()");
      assert.equal(await evaluate('document.body.dataset.desktopPage'), 'learning');
      assert.equal(win.webContents.mainFrame.frames.find(candidate => candidate.url.startsWith('xhs-app://local/learn.html')), frame,
        'Switching tabs reuses the loaded promotion document');
    }

    for (const [start, key, expected] of [['profile-tab', 'End', 'learning'], ['desktop-learning-link', 'Home', 'single'],
      ['single-note-tab', 'ArrowLeft', 'learning'], ['desktop-learning-link', 'ArrowDown', 'single']]) {
      await evaluate(`document.getElementById(${JSON.stringify(start)}).click(); document.getElementById(${JSON.stringify(start)}).focus()`);
      const keyCode = key.replace(/^Arrow/, '');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await waitFor(() => evaluate(`document.body.dataset.desktopPage === ${JSON.stringify(expected)}`), `Keyboard ${key} did not reach ${expected}`);
      assert.equal(await evaluate(`document.querySelectorAll('#desktop-navigation [role="tab"][aria-selected="true"]').length`), 1,
        'Keyboard navigation keeps one selected tab');
      assert.equal(await evaluate(`document.activeElement.getAttribute('aria-selected')`), 'true', 'Keyboard navigation moves focus into the selected tab');
    }
    await evaluate("document.getElementById('desktop-learning-link').click()");

    for (const width of [1320, 900, 760]) {
      win.setContentSize(width, 940);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(await evaluateLearning('document.documentElement.scrollWidth <= innerWidth + 1'), true,
        `Embedded promotion has no horizontal overflow at ${width}px`);
      await evaluateLearning("document.getElementById('qr-open').focus(); document.getElementById('qr-open').click()");
      assert.equal(await evaluateLearning("document.getElementById('qr-dialog').open"), true);
      assert.equal(await evaluateLearning(`(() => { const bounds = document.getElementById('qr-dialog').getBoundingClientRect();
        return bounds.left >= -1 && bounds.right <= innerWidth + 1; })()`), true, `QR overlay fits the embedded frame at ${width}px`);
      await evaluateLearning('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 100));
      const screenshot = path.join(temporary, `embedded-learning-${width}.png`);
      writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      screenshots.push(screenshot);
      await evaluateLearning("document.getElementById('qr-close').click()");
      assert.equal(await evaluateLearning("!document.getElementById('qr-dialog').open && document.activeElement.id === 'qr-open'"), true,
        'QR close restores focus in the embedded page');
    }
    await evaluateLearning("document.getElementById('qr-open').click()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(() => evaluateLearning("!document.getElementById('qr-dialog').open && document.activeElement.id === 'qr-open'"),
      'Escape did not close the embedded QR overlay and restore focus');

    const savedPath = path.join(temporary, 'embedded-wechat-qr.png');
    let downloaded;
    const onDownload = (_event, item) => {
      item.setSavePath(savedPath);
      downloaded = new Promise((resolve, reject) => item.once('done', (_doneEvent, state) => {
        if (state === 'completed') resolve(); else reject(new Error(`Embedded QR download ${state}`));
      }));
    };
    win.webContents.session.once('will-download', onDownload);
    try {
      await evaluateLearning("document.getElementById('qr-save').click()");
      await waitFor(() => Boolean(downloaded), 'Embedded QR save did not start');
      await downloaded;
      assert.deepEqual(readFileSync(savedPath), readFileSync(path.join(root, 'assets/support/wechat-personal-qr.png')),
        'Saving from the embedded page preserves the original QR crop exactly');
    } finally { win.webContents.session.removeListener('will-download', onDownload); }
    assert.equal(win.webContents.getURL(), mainUrl);
    assert.equal(await evaluate('document.body.dataset.desktopPage'), 'learning');
    assert.deepEqual(opened, [], 'Opening, returning, and saving promotion do not open the system browser');
    assert.equal(createdWindows, 0, 'All promotion interactions create no additional BrowserWindow');
    assert.equal(BrowserWindow.getAllWindows().length, initialWindowCount, 'Promotion does not add to the existing hidden login helper');
    assert.equal(BrowserWindow.getAllWindows().filter(window => window.isVisible()).length, 1, 'Only the main software window is visible');
    assert.deepEqual(failures, [], 'Packaged iframe navigation and assets have no load failures');
    return { localFrame: true, lazyLoad: true, noAdditionalWindow: true, legacyRouting: true,
      draftsPreserved: true, scrollPreserved: true, keyboardNavigation: true, backgroundProgress: true, qrEscapeFocus: true, qrSaveExactBytes: true, screenshots };
  } finally {
    shell.openExternal = openExternal;
    app.removeListener('browser-window-created', onWindow);
    win.webContents.removeListener('did-fail-load', onFailure);
    win.setContentSize(...originalSize);
    win.webContents.send('desktop:profile-update', initialState);
    await evaluate("document.getElementById('profile-tab').click(); delete window.__learningSmokeDocument");
  }
}

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

async function verifyManualInstallerBridge(win) {
  const name = installerName(pkg.version, process.platform, process.arch);
  const url = `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v${pkg.version}/${name}`;
  const release = { tag_name: `v${pkg.version}`, draft: false, prerelease: false,
    html_url: `https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v${pkg.version}`,
    assets: [{ name, browser_download_url: url, size: 32, digest: `sha256:${'0'.repeat(64)}` }] };
  const request = net.request, openExternal = shell.openExternal;
  const opened = [];
  let requests = 0;
  // Intercept only OS/network effects. Exercise the real main constructor,
  // trusted IPC handler, preload, release selection and browser callback.
  net.request = options => {
    if (options.url !== LATEST_RELEASE_URL) return request.call(net, options);
    requests++;
    const connection = new EventEmitter();
    connection.abort = () => {};
    connection.end = () => queueMicrotask(() => {
      const incoming = Readable.from([Buffer.from(JSON.stringify(release))]);
      incoming.statusCode = 200;
      incoming.headers = {};
      connection.emit('response', incoming);
    });
    return connection;
  };
  shell.openExternal = async value => { opened.push(value); };
  try {
    const before = await win.webContents.executeJavaScript('window.xhsDesktop.getUpdateState()');
    for (let index = 0; index < 2; index++) {
      const result = await win.webContents.executeJavaScript("window.xhsDesktop.openLatestInstaller('https://attacker.example/installer.exe')");
      assert.deepEqual(result, { ok: true, version: pkg.version, name });
    }
    assert.equal(requests, 2, 'Each completed recovery action refreshes official release metadata');
    assert.deepEqual(opened, [url, url], 'The real UpdateManager must be wired to shell.openExternal with a validated asset');
    assert.deepEqual(await win.webContents.executeJavaScript('window.xhsDesktop.getUpdateState()'), before);
    return true;
  } finally {
    net.request = request;
    shell.openExternal = openExternal;
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
      const manualInstallerBridgeVerified = await verifyManualInstallerBridge(win);
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
        const updateMethods = ['checkForUpdates', 'downloadUpdate', 'cancelUpdateDownload', 'installUpdate', 'openLatestInstaller', 'onUpdateState', 'onInstallConfirmation', 'respondInstallConfirmation', 'retryItem']
          .every(name => typeof window.xhsDesktop[name] === 'function');
        const unsubscribeClipboard = window.xhsDesktop.onClipboardProgress(() => {});
        unsubscribeClipboard();
        let clipboardBridgeVerified = false;
        try { await window.xhsDesktop.copyImages({ images: [] }); }
        catch (error) { clipboardBridgeVerified = /请选择 1/.test(error.message); }
        const payloads = [];
        for (const route of ['/api/parse', '/api/python_parse']) {
          const response = await fetch(route, {method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({text:'https://sns-img-bd.xhscdn.com/smoke-original-image'})});
          const data = await response.json();
          payloads.push({route,status:response.status,success:data.success,engine:data.engine,images:data.images?.length});
        }
        // Module initialization awaits the bridge; drain promises before inspecting.
        await new Promise(resolve=>setTimeout(resolve,100));
        return {info,status:state.status,updateStatus:update.status,updateMethods,clipboardBridgeVerified,payloads,
          diagnosticsVerified: diagnostics.totalBytes > 0 && !('text' in diagnostics), feedbackGuestRejected: !feedback.ok && feedback.error?.code === 'UNAUTHENTICATED',
          profileVisible:!document.querySelector('#profile-panel').hidden,
          tabsVisible:!document.querySelector('#desktop-navigation').hidden,
          nodeAvailable:typeof require === 'function',
          secureContext:window.isSecureContext};
      })()`);
      if (result.info.name !== 'Brclio 小红书下载器' || !result.info.pythonAvailable || result.status !== 'idle' || !result.profileVisible
          || !result.tabsVisible || result.nodeAvailable || !result.secureContext || !result.updateMethods || !result.clipboardBridgeVerified || result.updateStatus !== 'idle' || !result.diagnosticsVerified || !result.feedbackGuestRejected
          || result.payloads.some(value => !value.success || value.images !== 1 || value.status !== 200)) {
        throw new Error(JSON.stringify(result));
      }
      const embeddedLearningVerified = await verifyEmbeddedLearning(win);
      const screenshot = path.join(temporary, 'desktop.png');
      writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ smoke: 'passed', ...result, updateTransportVerified, manualInstallerBridgeVerified, embeddedLearningVerified, screenshot }));
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
