// Isolated UI integration smoke; never logs in, downloads or installs an update.
// Run: node_modules/.bin/electron scripts/verify-desktop-ui.mjs
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocolHandler } from '../desktop/protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'xhs-desktop-ui-smoke-'));
app.setPath('userData', temporary);
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true
} }]);
const timeout = setTimeout(() => { console.error('DESKTOP_UI_SMOKE_TIMEOUT'); app.exit(1); }, 60000);

const preload = path.join(temporary, 'fixture-preload.cjs');
writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron');
window.addEventListener('xhs-desktop-ready', () => ipcRenderer.send('ui-fixture:desktop-ready'));
const invoke = (method, value) => ipcRenderer.invoke('ui-fixture:invoke', method, value);
const subscribe = (channel, callback) => {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('xhsDesktop', {
  getInfo: () => invoke('getInfo'),
  recordDiagnostic: (event, fields) => invoke('recordDiagnostic', { event, fields }),
  getAccountState: () => invoke('getAccountState'),
  refreshAccount: () => invoke('refreshAccount'),
  sendAccountCode: email => invoke('sendAccountCode', email),
  verifyAccountCode: (email, code) => invoke('verifyAccountCode', { email, code }),
  redeemAccountCode: code => invoke('redeemAccountCode', code),
  logoutAccount: () => invoke('logoutAccount'),
  getDiagnosticsInfo: () => invoke('getDiagnosticsInfo'),
  copyDiagnostics: () => invoke('copyDiagnostics'),
  exportDiagnostics: () => invoke('exportDiagnostics'),
  submitFeedback: input => invoke('submitFeedback', input),
  onAccountUpdate: callback => subscribe('ui-fixture:account', callback),
  onFeedbackState: callback => subscribe('ui-fixture:feedback', callback),
  onNavigate: callback => subscribe('ui-fixture:navigate', callback),
  getProfileState: () => invoke('getProfileState'),
  getLoginState: () => invoke('getLoginState').then(state => {
    ipcRenderer.send('ui-fixture:login-read-delivered');
    return state;
  }),
  getUpdateState: () => invoke('getUpdateState'),
  getUpdateHistory: () => invoke('getUpdateHistory'),
  dismissUpdateHistory: id => invoke('dismissUpdateHistory', id),
  onUpdateHistory: callback => subscribe('ui-fixture:update-history', callback),
  checkForUpdates: () => invoke('checkForUpdates'),
  downloadUpdate: () => invoke('downloadUpdate'),
  cancelUpdateDownload: () => invoke('cancelUpdateDownload'),
  installUpdate: () => invoke('installUpdate'),
  openLatestInstaller: () => invoke('openLatestInstaller'),
  onInstallConfirmation: callback => subscribe('ui-fixture:install-confirmation', callback),
  respondInstallConfirmation: (id, confirmed) => invoke('respondInstallConfirmation', { id, confirmed }),
  chooseDirectory: () => invoke('chooseDirectory'),
  openLogin: value => invoke('openLogin', value),
  clearXhsLogin: () => invoke('clearXhsLogin'),
  openDirectory: () => invoke('openDirectory'),
  startProfile: value => invoke('startProfile', value),
  pauseProfile: () => invoke('pauseProfile'),
  resumeProfile: () => invoke('resumeProfile'),
  cancelProfile: () => invoke('cancelProfile'),
  retryFailed: () => invoke('retryFailed'),
  retryItem: id => invoke('retryItem', id),
  onProfileUpdate: callback => subscribe('ui-fixture:profile', callback),
  onLoginUpdate: callback => subscribe('ui-fixture:login', callback),
  onUpdateState: callback => subscribe('ui-fixture:update', callback)
});
`);

app.whenReady().then(async () => {
  // The fixture serves real renderer files but makes no external requests.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  protocol.handle('xhs-app', createProtocolHandler({ rootDirectory: root }));
  const calls = [];
  const readyEvents = new Map();
  const failedInitializationWindows = new Set();
  ipcMain.on('ui-fixture:desktop-ready', event => readyEvents.set(event.sender.id, (readyEvents.get(event.sender.id) || 0) + 1));
  let loginReadDeliveries = 0;
  ipcMain.on('ui-fixture:login-read-delivered', () => { loginReadDeliveries++; });
  const failedId = (126).toString(16).padStart(24, '0');
  const failedUrl = `https://www.xiaohongshu.com/explore/${failedId}?xsec_token=fixture%2Btoken%2Fsignature%3D&xsec_source=pc_user&source=web_profile`;
  const fixtureTitle = '测试笔记 <img src=x onerror=alert(1)>';
  let profile = {
    status: 'completed', profileUrl: 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c',
    directory: '/fixture/下载', intervalSeconds: 10, jitterSeconds: 3,
    discovered: 135, completed: 134, skipped: 0, failed: 1, discoveryComplete: true,
    items: Array.from({ length: 135 }, (_, index) => ({
      id: (index + 1).toString(16).padStart(24, '0'), sequence: index + 1,
      url: index === 125 ? failedUrl : `https://www.xiaohongshu.com/explore/${(index + 1).toString(16).padStart(24, '0')}`,
      title: index === 125 ? fixtureTitle : `测试笔记 ${index + 1}`,
      directoryName: `${String(index + 1).padStart(3, '0')}-测试笔记`,
      status: index === 125 ? 'failed' : 'completed', error: index === 125 ? '测试网络错误，请稍后重试。' : ''
    }))
  };
  let account = { configured: true, authenticated: true, verified: true, status: 'authenticated', account: {
    user: { id: 'fixture-user', email: 'ordinary@example.com', role: 'user' },
    membership: { type: 'none', active: false }, device: { status: 'authorized' }, serverTime: '2026-09-20T12:00:00Z'
  } };
  let update = { status: 'idle', currentVersion: '1.6.0' };
  let updateHistory = null;
  let historyReadPending = true;
  let resolveHistoryRead;
  let historyDismissMode = 'success';
  let resolveHistoryDismiss;
  let resolveFeedback;
  let feedbackMode = 'pending';
  let exportMode = 'cancel';
  const rendererErrors = [];
  let downloadMode = 'pending';
  let resolveDownload;
  let checkMode = 'success';
  let resolveUpdateCheck;
  let pendingInstall = null;
  let installSequence = 0;
  let acceptedInstallations = 0;
  let installReplyOrder = 'normal';
  let releaseInstallReply;
  let releaseConfirmationReply;
  let installationPlatform = 'darwin';
  let installationPortable = false;
  let installationMode = 'confirmation';
  let manualInstallerMode = 'pending';
  let resolveManualInstaller;
  let resolveDirectory;
  let xhsLogin = { status: 'unknown', loggedIn: false, nickname: '', userId: '' };
  let initialLoginPending = true;
  let resolveInitialLogin;
  let clearLoginMode = 'pending';
  let resolveClearLogin;
  let win;
  const publishProfile = value => { profile = value; win.webContents.send('ui-fixture:profile', value); return value; };
  const publishLogin = value => { xhsLogin = value; win.webContents.send('ui-fixture:login', value); return value; };
  const publishAccount = value => { account = value; win.webContents.send('ui-fixture:account', value); return value; };
  const publishUpdate = value => { update = value; win.webContents.send('ui-fixture:update', value); return value; };
  const publishHistory = value => { updateHistory = value; win.webContents.send('ui-fixture:update-history', value); return value; };
  const previousInstall = {
    id: 'fixture-previous-install', targetVersion: '1.5.9', previousVersion: '1.5.8', currentVersion: '1.6.0',
    recordedAt: '2026-09-20T12:34:00Z', status: 'cleanup_failed',
    outcome: '此前安装后留下的临时旧版尚未清理。',
    action: '记录已保留，软件会在下次启动时重试清理。'
  };
  const retainedCheckError = { code: 'RATE_LIMITED', phase: 'check', message: 'GitHub 暂时限制请求 <img src=x onerror=alert(1)>' };
  const available = () => ({
    status: 'available', currentVersion: '1.6.0', latestVersion: '1.6.1',
    releaseNotes: ['下载与更新，更顺畅了。', '', '### 下载可以接着来',
      '- 更新包下载中断后保留已有进度，重新打开软件也可以继续下载。',
      '- 支持暂停下载，在你准备好时再继续。', '', '### 安装过程看得见',
      '- 显示校验、复制和覆盖安装进度，随时了解当前步骤。',
      '- 安装成功后自动重新打开软件，保留原有账号和任务记录。', '',
      '### 使用体验', '- 更新说明集中展示，下载、暂停和继续都可以在这里完成。',
      '- 也可以收起弹窗，在后台下载更新。', '', '### 更多改进',
      ...Array.from({ length: 8 }, (_, i) => `- 稳定性验证 ${i + 1}：改进任务恢复和更新提示。`),
      '测试更新说明 <img src=x onerror=alert(1)>', '[不执行链接](javascript:alert(1))'].join('\n'),
    installationHint: 'Mac：确认后覆盖当前应用并重新启动，保留账号和任务记录。',
    download: { receivedBytes: 0, totalBytes: 0, canResume: false }, error: null, checkError: null, canRetry: true
  });
  ipcMain.handle('ui-fixture:invoke', (_event, method, value) => {
    calls.push({ method, value });
    if (method === 'getInfo') return { version: '1.6.0', platform: 'darwin', arch: 'arm64', pythonAvailable: true };
    if (method === 'getAccountState') return account;
    if (method === 'recordDiagnostic') return true;
    if (method === 'refreshAccount') return { ok: true, state: account, result: {} };
    if (method === 'getDiagnosticsInfo') return { fileCount: 4, totalBytes: 7340032, oldestAt: '2026-09-18T10:00:00Z', newestAt: '2026-09-20T12:00:00Z', truncated: true, maxBytes: 8388608, summary: '已移除 Cookie、凭据和下载文件内容。' };
    if (method === 'copyDiagnostics') return { ok: true, bytes: 1024, message: '诊断信息已复制。' };
    if (method === 'exportDiagnostics') return exportMode === 'cancel' ? { ok: false, cancelled: true } : { ok: true, bytes: 1024, message: '日志已导出。' };
    if (method === 'submitFeedback') {
      if (feedbackMode === 'error') return { ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: '测试服务暂时不可用 <img src=x>' } };
      win.webContents.send('ui-fixture:feedback', { status: 'uploading', progress: 50, uploadedBytes: 512, totalBytes: 1024 });
      return new Promise(resolve => { resolveFeedback = resolve; });
    }
    if (method === 'getLoginState') {
      if (initialLoginPending) {
        initialLoginPending = false;
        return new Promise(resolve => { resolveInitialLogin = resolve; });
      }
      return xhsLogin;
    }
    if (method === 'clearXhsLogin') {
      if (clearLoginMode === 'error') throw new Error('测试清除失败 <img src=x onerror=alert(1)>');
      if (clearLoginMode === 'invalid') return { loginState: { status: 'unknown', loggedIn: false } };
      return new Promise(resolve => { resolveClearLogin = resolve; });
    }
    if (method === 'getProfileState') {
      if (failedInitializationWindows.has(_event.sender.id)) throw new Error('fixture profile initialization failed');
      return profile;
    }
    if (method === 'getUpdateState') return update;
    if (method === 'getUpdateHistory') {
      if (historyReadPending) {
        historyReadPending = false;
        return new Promise(resolve => { resolveHistoryRead = resolve; });
      }
      return updateHistory;
    }
    if (method === 'dismissUpdateHistory') {
      if (historyDismissMode === 'error') throw new Error('fixture history persistence failure');
      if (historyDismissMode === 'pending') return new Promise(resolve => { resolveHistoryDismiss = resolve; });
      if (updateHistory?.id === value) return publishHistory(null);
      return updateHistory;
    }
    if (method === 'chooseDirectory') return new Promise(resolve => { resolveDirectory = resolve; });
    if (method === 'retryItem') return publishProfile({
      ...profile, status: 'downloading', failed: 0,
      items: profile.items.map(item => item.id === value ? { ...item, status: 'downloading', error: '' } : item)
    });
    if (method === 'checkForUpdates') {
      if (checkMode === 'retained-failure') {
        const previous = update;
        publishUpdate({ ...previous, status: 'checking', error: null, checkError: null, canRetry: false });
        return new Promise(resolve => { resolveUpdateCheck = () => resolve(publishUpdate({
          ...previous, status: 'available', error: null, checkError: retainedCheckError, canRetry: false
        })); });
      }
      return publishUpdate(available());
    }
    if (method === 'downloadUpdate') {
      if (downloadMode === 'downloaded') return publishUpdate({ ...available(), status: 'downloaded' });
      const receivedBytes = update.download?.canResume ? 768 : 512;
      publishUpdate({ ...available(), status: 'downloading', download: { receivedBytes, totalBytes: 1024, canResume: false } });
      return new Promise(resolve => { resolveDownload = resolve; });
    }
    if (method === 'cancelUpdateDownload') {
      const state = publishUpdate({ ...available(), download: { ...update.download, canResume: true } });
      resolveDownload?.(state);
      resolveDownload = null;
      return state;
    }
    if (method === 'installUpdate') {
      if (installationMode === 'failure') return publishUpdate({ ...available(), status: 'error', error: { phase: 'install', message: '测试安装失败' } });
      const id = `fixture-install-${++installSequence}`;
      publishUpdate({ ...available(), status: 'installing' });
      const result = new Promise(resolve => { pendingInstall = { id, resolve }; });
      win.webContents.send('ui-fixture:install-confirmation', {
        id, currentVersion: '1.6.0', latestVersion: '1.6.1', platform: installationPlatform,
        portable: installationPortable,
        installationHint: installationPortable ? '当前便携版将安装为正式版。旧便携文件不会被覆盖。'
          : 'Mac：请从可写文件夹启动；从 DMG 或只读位置运行时需手动安装。安装包通过完整性校验，系统仍可能要求确认。'
      });
      return result;
    }
    if (method === 'respondInstallConfirmation') {
      if (!pendingInstall || pendingInstall.id !== value?.id || typeof value.confirmed !== 'boolean') return false;
      const pending = pendingInstall;
      pendingInstall = null;
      if (value.confirmed) acceptedInstallations++;
      if (installReplyOrder === 'close-first') {
        const next = publishUpdate({ ...available(), status: 'downloaded' });
        releaseInstallReply = () => pending.resolve(next);
        return true;
      }
      if (installReplyOrder === 'result-first') {
        update = { ...available(), status: 'downloaded' };
        pending.resolve(update);
        return new Promise(resolve => { releaseConfirmationReply = () => resolve(true); });
      }
      pending.resolve(publishUpdate({ ...available(), status: value.confirmed ? 'installing' : 'downloaded' }));
      return true;
    }
    if (method === 'openLatestInstaller') {
      if (manualInstallerMode === 'throw') throw new Error('测试浏览器拒绝打开 <img src=x onerror=alert(1)>');
      return new Promise(resolve => { resolveManualInstaller = resolve; });
    }
    return profile;
  });
  win = new BrowserWindow({ show: false, width: 1180, height: 980, webPreferences: {
    preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true
  } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  const evaluate = async (expression, userGesture = false) => {
    try { return await win.webContents.executeJavaScript(expression, userGesture); }
    catch (error) {
      throw new Error(`Renderer evaluation failed: ${expression.slice(0, 700)}; error: ${error.message}; renderer: ${JSON.stringify(rendererErrors)}`, { cause: error });
    }
  };
  const check = async (expression, description) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const focus = await evaluate(`(() => {
      const button = document.querySelector('#desktop-update-install');
      return { active: document.activeElement?.id || document.activeElement?.tagName,
        viewport: { width: innerWidth, height: innerHeight },
        dialogs: Array.from(document.querySelectorAll('dialog[open]'), dialog => ({
          id: dialog.id, bounds: dialog.getBoundingClientRect().toJSON(),
          clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth,
          computedMaxHeight: getComputedStyle(dialog).maxHeight,
          actions: Array.from(dialog.querySelectorAll('button'), button => ({
            id: button.id, bounds: button.getBoundingClientRect().toJSON()
          }))
        })),
        buttonHidden: button?.hidden, buttonDisabled: button?.disabled,
        buttonRects: button?.getClientRects().length,
        confirmationOpen: document.querySelector('#desktop-install-confirmation')?.open,
        installCancelEvent: window.fixtureCancelEvent,
        cssViewportHeight: document.querySelector('#fixture-css-viewport-probe')?.getBoundingClientRect().height,
        shortScreenMedia: matchMedia('(max-height: 540px)').matches,
        resizeEvents: window.fixtureViewportResizeEvents || [],
        updateDialogOpen: document.querySelector('#desktop-update-dialog')?.open };
    })()`);
    throw new Error(`UI check failed: ${description}; focus: ${JSON.stringify(focus)}; renderer: ${JSON.stringify(rendererErrors)}; body: ${await evaluate("document.body.innerText.slice(0, 400)")}`);
  };
  // Give scripted clicks the user activation a real click supplies. Otherwise
  // repeated showModal/Escape cycles exhaust Chromium's CloseWatcher allowance:
  // cancel becomes non-cancelable and the browser bypasses dialog.close itself.
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
  const paint = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const resizeViewport = async (width, height) => {
    // Native resize and renderer viewport updates are asynchronous. In
    // particular, innerHeight can change before CSS viewport units and media
    // queries reach the same size. This fixed probe never participates in layout.
    await evaluate(`(() => {
      if (!document.querySelector('#fixture-css-viewport-probe')) {
        const probe = document.createElement('div');
        probe.id = 'fixture-css-viewport-probe';
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100dvh;visibility:hidden;pointer-events:none;margin:0;padding:0;border:0;';
        document.body.append(probe);
      }
      if (!window.fixtureViewportResizeEvents) {
        window.fixtureViewportResizeEvents = [];
        addEventListener('resize', () => {
          window.fixtureViewportResizeEvents.push({ at: performance.now(), width: innerWidth, height: innerHeight,
            cssHeight: document.querySelector('#fixture-css-viewport-probe')?.getBoundingClientRect().height,
            shortScreenMedia: matchMedia('(max-height: 540px)').matches });
          window.fixtureViewportResizeEvents = window.fixtureViewportResizeEvents.slice(-8);
        });
      }
    })()`);
    win.setContentSize(width, height);
    await check(`innerWidth === ${width} && innerHeight === ${height}`, `viewport reaches ${width}×${height}`);
    await check(`Math.abs(document.querySelector('#fixture-css-viewport-probe').getBoundingClientRect().height - ${height}) < 0.5
      && matchMedia('(max-height: 540px)').matches === ${height <= 540}`, `CSS viewport reaches ${width}×${height}`);
    await paint();
  };
  const captureFrame = async () => {
    const location = new Error('Offscreen frame requested here').stack;
    await paint();
    const viewport = await evaluate('({ width: innerWidth, height: innerHeight })');
    // invalidate() delivers a complete NativeImage through offscreen paint.
    // A second capturePage surface readback can fail with UnknownVizError even
    // after the DOM is ready. Wait for the actual matching frame instead.
    return new Promise((resolve, reject) => {
      const observed = [];
      const finish = (error, png) => {
        clearTimeout(timer);
        win.webContents.removeListener('paint', onPaint);
        if (error) reject(new Error(`Offscreen screenshot failed at ${viewport.width}×${viewport.height}: ${error.message}; observed frames: ${JSON.stringify(observed)}; ${location}`, { cause: error }));
        else resolve(png);
      };
      const onPaint = (_event, _dirty, image) => {
        try {
          const size = image.getSize();
          observed.push(size);
          if (observed.length > 8) observed.shift();
          if (size.width !== viewport.width || size.height !== viewport.height || image.isEmpty()) return;
          const png = image.toPNG();
          assert.ok(png.length > 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'offscreen frame contains a PNG');
          assert.equal(png.readUInt32BE(16), viewport.width, 'screenshot width matches the verified viewport');
          assert.equal(png.readUInt32BE(20), viewport.height, 'screenshot height matches the verified viewport');
          finish(null, png);
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error('No matching compositor paint arrived within 5 seconds.')), 5000);
      win.webContents.on('paint', onPaint);
      try { win.webContents.invalidate(); }
      catch (error) { finish(error); }
    });
  };
  const verifyShortcut = async target => {
    const evaluateShortcut = expression => target.webContents.executeJavaScript(expression, true);
    const expected = 'https://www.icloud.com/shortcuts/70ff1d35911f43c5be308e1f692ea530';
    assert.equal(await evaluateShortcut(`document.querySelector('[data-shortcut-link]').href`), expected);
    assert.equal(await evaluateShortcut(`getComputedStyle(document.querySelector('[data-ios-shortcut]')).display`), 'grid', 'shortcut stylesheet is served by the desktop protocol');
    const externalLinks = [];
    target.webContents.setWindowOpenHandler(({ url }) => { externalLinks.push(url); return { action: 'deny' }; });
    await evaluateShortcut(`document.querySelector('.ios-shortcut-action').click()`);
    assert.deepEqual(externalLinks, [expected], 'get shortcut opens the exact external share URL');
    await evaluateShortcut(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.shortcutCopied = text; } } }); document.querySelector('[data-shortcut-copy]').click();`);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await evaluateShortcut(`window.shortcutCopied`), expected, 'copy sends the whole shortcut URL');
    assert.match(await evaluateShortcut(`document.querySelector('[data-shortcut-status]').textContent`), /链接已复制/);
    await evaluateShortcut(`navigator.clipboard.writeText = async () => { throw new Error('Denied'); }; window.shortcutExecCommand = document.execCommand; document.execCommand = () => false; document.querySelector('[data-shortcut-copy]').click();`);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(await evaluateShortcut(`document.querySelector('[data-shortcut-status]').textContent`), /未能自动复制/);
    assert.equal(await evaluateShortcut(`document.querySelector('[data-shortcut-copy]').disabled`), false, 'failed copy can retry');
    await evaluateShortcut(`delete navigator.clipboard; document.execCommand = window.shortcutExecCommand; document.querySelector('[data-shortcut-status]').textContent = '';`);
  };
  await win.loadURL('xhs-app://local/');
  await check(`document.querySelector('#profile-items').children.length === 100`, 'initial list rendered');
  await check(`document.body.dataset.desktopReady === 'true'`, 'desktop readiness follows successful info and profile initialization');
  await verifyShortcut(win);
  assert.equal(readyEvents.get(win.webContents.id), 1, 'successful initialization emits exactly one desktop-ready event');
  // Use the real reset renderer with a delayed native confirmation/cleanup
  // response. The storage reset itself is verified separately with real data.
  const loginResetScreenshots = {};
  await click('#profile-tab');
  await check(`!document.querySelector('#profile-clear-login').disabled`, 'clear XHS login control is available after initialization');
  const originalLoginLabel = await evaluate(`document.querySelector('#profile-login-label').textContent`);
  const retainedProfile = structuredClone(profile);
  const retainedSoftwareAccount = structuredClone(account);
  await click('#profile-clear-login');
  await check(`document.querySelector('#profile-clear-login').disabled
    && document.querySelector('#profile-clear-login').textContent === '清除中……'
    && document.querySelector('#profile-clear-login').getAttribute('aria-busy') === 'true'
    && document.querySelector('#profile-login-clear-status').dataset.status === 'pending'`, 'pending reset shows progress and locks duplicate requests');
  assert.equal(await evaluate(`['profile-login', 'profile-start', 'profile-choose-directory', 'profile-retry']
    .every(id => document.getElementById(id).disabled)
    && [...document.querySelectorAll('#profile-items button[data-retry-id]')].every(button => button.disabled)`), true,
    'pending reset locks conflicting login and profile operations');
  await click('#profile-clear-login');
  assert.equal(calls.filter(call => call.method === 'clearXhsLogin').length, 1, 'disabled reset cannot duplicate bridge calls');
  resolveClearLogin({ cancelled: true });
  await check(`!document.querySelector('#profile-clear-login').disabled
    && document.querySelector('#profile-login-clear-status').hidden
    && document.querySelector('#profile-clear-login').getAttribute('aria-busy') === 'false'`, 'cancelled confirmation restores controls without a success message');
  assert.equal(await evaluate(`document.querySelector('#profile-login-label').textContent`), originalLoginLabel);
  assert.deepEqual(profile, retainedProfile, 'cancelled reset preserves the profile task');

  await click('#profile-clear-login');
  await check(`document.querySelector('#profile-clear-login').disabled`, 'confirmed reset remains pending until completion');
  const loggedOut = { status: 'logged-out', loggedIn: false, nickname: '', userId: '' };
  xhsLogin = loggedOut;
  resolveClearLogin({ loginState: loggedOut, profileState: profile,
    message: '小红书登录记录已清除，可重新登录其他账号。' });
  await check(`!document.querySelector('#profile-clear-login').disabled
    && document.querySelector('#profile-login').dataset.loginStatus === 'logged-out'
    && document.querySelector('#profile-login-clear-status').dataset.status === 'success'
    && document.querySelector('#profile-login-clear-status').textContent.includes('重新登录其他账号')`, 'confirmed cleanup shows a signed-out state and success feedback');
  assert.deepEqual(profile, retainedProfile, 'reset response retains task records');
  assert.deepEqual(account, retainedSoftwareAccount, 'reset does not sign out the software account');
  // An old initial snapshot arrives only after cleanup has succeeded. The
  // renderer must not restore the cleared account from that stale response.
  resolveInitialLogin({ status: 'logged-in', loggedIn: true, nickname: '旧账号', userId: 'stale-xhs-user' });
  for (let attempt = 0; attempt < 50 && loginReadDeliveries === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(loginReadDeliveries, 1, 'delayed initial login snapshot reached the preload');
  await paint();
  assert.equal(await evaluate(`document.querySelector('#profile-login').dataset.loginStatus`), 'logged-out',
    'delayed login discovery cannot restore a cleared account');

  clearLoginMode = 'error';
  await click('#profile-clear-login');
  await check(`!document.querySelector('#profile-clear-login').disabled
    && document.querySelector('#profile-login-clear-status').dataset.status === 'error'
    && document.querySelector('#profile-login-clear-status').getAttribute('role') === 'alert'`, 'cleanup errors are visible and retry remains available');
  assert.match(await evaluate(`document.querySelector('#profile-login-clear-status').textContent`), /测试清除失败.*<img/);
  assert.equal(await evaluate(`document.querySelector('#profile-login-clear-status').querySelectorAll('img, script').length`), 0,
    'cleanup failures render as text');
  clearLoginMode = 'invalid';
  await click('#profile-clear-login');
  await check(`document.querySelector('#profile-login-clear-status').textContent === '暂时无法确认登录记录已清除，请重试。'`,
    'an unconfirmed cleanup response cannot claim success');
  assert.equal(await evaluate(`document.querySelector('#profile-login').dataset.loginStatus`), 'logged-out');
  clearLoginMode = 'pending';
  await click('#profile-clear-login');
  await check(`document.querySelector('#profile-clear-login').disabled`, 'cleanup error can be retried');
  resolveClearLogin({ cancelled: true });
  await check(`!document.querySelector('#profile-clear-login').disabled && document.querySelector('#profile-login-clear-status').hidden`,
    'cancelled retry clears prior error feedback');

  const longNickname = '超长的小红书账号昵称'.repeat(30) + '<img src=x onerror=alert(1)>';
  publishLogin({ status: 'logged-in', loggedIn: true, nickname: longNickname, userId: 'fixture-long-name' });
  await check(`document.querySelector('#profile-login-label').textContent === ${JSON.stringify(`已登录 · ${longNickname}`)}`,
    'the login control retains the complete long nickname as text');
  assert.equal(await evaluate(`document.querySelector('#profile-login').querySelectorAll('img, script').length`), 0);
  assert.ok((await evaluate(`document.querySelector('#profile-login').title`)).includes(longNickname),
    'the complete nickname stays available in the title');
  for (const [width, height] of [[760, 900], [390, 844]]) {
    await resizeViewport(width, height);
    await evaluate(`document.querySelector('#profile-panel').scrollTop = 0`);
    const geometry = await evaluate(`(() => {
      const panel = document.querySelector('#profile-panel'), tools = document.querySelector('.profile-account-tools');
      const toolRect = tools.getBoundingClientRect();
      const buttons = ['profile-login', 'profile-clear-login'].map(id => {
        const element = document.getElementById(id), rect = element.getBoundingClientRect();
        return { id, visible: element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0,
          fits: rect.left >= toolRect.left - 1 && rect.right <= toolRect.right + 1
            && rect.top >= 0 && rect.bottom <= innerHeight, rect: rect.toJSON() };
      });
      return { fits: panel.scrollWidth <= panel.clientWidth && tools.scrollWidth <= tools.clientWidth
          && document.documentElement.scrollWidth <= document.documentElement.clientWidth
          && buttons.every(button => button.visible && button.fits), buttons,
        panel: { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth }, tools: toolRect.toJSON() };
    })()`);
    assert.equal(geometry.fits, true, `${width}px: reset and login buttons fit with a long nickname: ${JSON.stringify(geometry)}`);
    loginResetScreenshots[width] = path.join(temporary, `desktop-xhs-login-reset-${width}.png`);
    writeFileSync(loginResetScreenshots[width], await captureFrame());
  }
  publishLogin(loggedOut);
  await check(`document.querySelector('#profile-login').dataset.loginStatus === 'logged-out'`, 'login state returns to the reset result');
  await resizeViewport(1180, 980);
  // Exercise the real embedded page and its packaged resources, keeping the
  // downloader's renderer alive throughout navigation and QR saving.
  const learningScreenshots = {};
  const learningPopups = [];
  win.webContents.setWindowOpenHandler(({ url }) => { learningPopups.push(url); return { action: 'deny' }; });
  assert.equal(await evaluate(`document.querySelector('#desktop-learning-frame').hasAttribute('src')`), false, 'learning page loads only on first selection');
  assert.equal(await evaluate(`document.querySelectorAll('#desktop-navigation [role="tab"]').length`), 8, 'membership, VIP and learning pages join the eight-page tablist');
  const initialMainUrl = win.webContents.getURL();
  await evaluate(`(() => {
    window.fixtureLearning = {
      main: document.querySelector('main'), row: document.querySelector('#profile-items li'),
      frame: document.querySelector('#desktop-learning-frame'),
      original: Object.fromEntries(['share-text', 'profile-url', 'desktop-feedback-title', 'desktop-feedback-description']
        .map(id => [id, document.getElementById(id).value]))
    };
    document.querySelector('#share-text').value = '未解析的单篇下载草稿';
    document.querySelector('#desktop-feedback-title').value = '尚未提交的反馈';
    document.querySelector('#desktop-feedback-description').value = '查看书籍后继续填写这份反馈。';
    document.querySelector('#profile-tab').focus();
  })()`);
  const press = keyCode => {
    const nativeKey = keyCode.replace(/^Arrow/, '');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: nativeKey });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: nativeKey });
  };
  const learningDocument = `document.querySelector('#desktop-learning-frame').contentDocument`;
  const learningWindow = `document.querySelector('#desktop-learning-frame').contentWindow`;
  const clickLearning = selector => evaluate(`${learningDocument}.querySelector(${JSON.stringify(selector)}).click()`, true);
  const assertSelectedLearning = async description => assert.equal(await evaluate(`(() => {
    const tab = document.querySelector('#desktop-learning-link'), page = document.querySelector('#desktop-learning-page');
    return document.body.dataset.desktopPage === 'learning' && tab.getAttribute('aria-selected') === 'true'
      && tab.tabIndex === 0 && !page.hidden && page.getAttribute('aria-labelledby') === tab.id
      && Array.from(document.querySelectorAll('#desktop-navigation [role="tab"]')).filter(t => t.getAttribute('aria-selected') === 'true').length === 1
      && Array.from(document.querySelectorAll('main > .desktop-page')).filter(p => !p.hidden).length === 1;
  })()`), true, description);
  press('End');
  await check(`document.body.dataset.desktopPage === 'learning' && document.activeElement.id === 'desktop-learning-link'`, 'End selects and focuses the final learning tab');
  await check(`${learningDocument}?.body?.classList.contains('learning-embedded') && ${learningDocument}?.querySelector('.book-art')?.naturalWidth > 0`, 'embedded learning page and book image load from the packaged protocol');
  await assertSelectedLearning('learning page has consistent selected-tab and visible-panel state');
  await evaluate(`fixtureLearning.document = ${learningDocument}; fixtureLearning.frameLoads = 0;
    fixtureLearning.frame.addEventListener('load', () => fixtureLearning.frameLoads++);`);
  press('ArrowRight');
  await check(`document.body.dataset.desktopPage === 'single' && document.activeElement.id === 'single-note-tab'`, 'keyboard navigation wraps from learning to single download');
  press('ArrowLeft');
  await check(`document.body.dataset.desktopPage === 'learning' && document.activeElement.id === 'desktop-learning-link'`, 'keyboard navigation wraps back to learning');
  press('Home');
  await check(`document.body.dataset.desktopPage === 'single' && document.activeElement.id === 'single-note-tab'`, 'Home still selects the first download tab');
  for (const [tab, page, returnLink] of [
    ['#profile-tab', 'profile', '#back-to-tool'],
    ['#single-note-tab', 'single', '.site-header .brand'],
    ['#feedback-tab', 'feedback', '.footer-links a[href="./index.html"]']
  ]) {
    await click(tab);
    await click('#desktop-learning-link');
    await assertSelectedLearning(`${page}: selecting promotion remains in the workspace`);
    await clickLearning(returnLink);
    await check(`document.body.dataset.desktopPage === ${JSON.stringify(page)} && document.activeElement.id === ${JSON.stringify(tab.slice(1))}`, `${page}: return link restores the previous work page and focus`);
  }
  assert.equal(await evaluate(`document.querySelector('main') === fixtureLearning.main && document.querySelector('#profile-items li') === fixtureLearning.row
    && document.querySelector('#share-text').value === '未解析的单篇下载草稿'
    && document.querySelector('#profile-url').value === fixtureLearning.original['profile-url']
    && document.querySelector('#desktop-feedback-title').value === '尚未提交的反馈'
    && document.querySelector('#desktop-feedback-description').value === '查看书籍后继续填写这份反馈。'`), true, 'embedded navigation preserves download records and unsubmitted form drafts');
  await click('#desktop-learning-link');
  const learningFits = `(() => {
    const frame = document.querySelector('#desktop-learning-frame'), page = document.querySelector('#desktop-learning-page');
    const child = frame.contentDocument, view = frame.contentWindow, rect = frame.getBoundingClientRect();
    return {
      fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth
        && document.body.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight
        && page.scrollWidth <= page.clientWidth && page.scrollHeight <= page.clientHeight
        && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        && child.documentElement.scrollWidth <= child.documentElement.clientWidth && child.body.scrollWidth <= view.innerWidth,
      parent: { width: innerWidth, height: innerHeight }, frame: rect.toJSON(),
      child: { width: view.innerWidth, height: view.innerHeight, clientWidth: child.documentElement.clientWidth,
        scrollWidth: child.documentElement.scrollWidth, bodyWidth: child.body.scrollWidth }
    };
  })()`;
  const captureLearning = async name => {
    learningScreenshots[name] = path.join(temporary, `desktop-learning-${name}.png`);
    writeFileSync(learningScreenshots[name], await captureFrame());
  };
  for (const [width, height] of [[1320, 980], [900, 900], [760, 900], [390, 844], [320, 760]]) {
    await resizeViewport(width, height);
    await evaluate(`${learningDocument}.activeElement?.blur(); ${learningWindow}.scrollTo({ top: 0, behavior: 'instant' })`);
    await check(`${learningWindow}.scrollY === 0`, `${width}px: embedded page reaches the top before layout capture`);
    await paint();
    const geometry = await evaluate(learningFits);
    assert.equal(geometry.fits, true, `embedded page fits ${width}px without parent or child horizontal overflow: ${JSON.stringify(geometry)}`);
    assert.equal(await evaluate(`document.querySelector('#desktop-navigation [role="tablist"]').getAttribute('aria-orientation')`), width <= 600 ? 'horizontal' : 'vertical', 'tab orientation follows the compact navigation');
    if (width <= 600) await check(`(() => {
      const tabs = document.querySelector('#desktop-navigation [role="tablist"]').getBoundingClientRect();
      const selected = document.querySelector('#desktop-learning-link').getBoundingClientRect();
      return selected.left >= tabs.left - 1 && selected.right <= tabs.right + 1;
    })()`, `${width}px: resize keeps the selected learning tab visible in compact navigation`);
    await captureLearning(`${width}-top`);
    await clickLearning('a[href="#contact"]');
    await check(`${learningWindow}.location.hash === '#contact' && ${learningDocument}.querySelector('#contact').getBoundingClientRect().top >= 0
      && ${learningDocument}.querySelector('#contact').getBoundingClientRect().top < ${learningWindow}.innerHeight`, `${width}px: consultation anchor reaches the embedded contact section`);
    await check(`${learningDocument}.querySelector('#qr-open img').naturalWidth > 0`, `${width}px: packaged QR image loads`);
    if (width === 1320 || width === 320) await captureLearning(`${width}-contact`);
    await clickLearning('#qr-open');
    await check(`${learningDocument}.querySelector('#qr-dialog').open`, `${width}px: QR dialog opens inside the iframe`);
    const qrGeometry = await evaluate(`(() => {
      const view = ${learningWindow}, dialog = ${learningDocument}.querySelector('#qr-dialog'), rect = dialog.getBoundingClientRect();
      return { fits: rect.left >= 0 && rect.right <= view.innerWidth && rect.top >= 0 && rect.bottom <= view.innerHeight
        && dialog.scrollWidth <= dialog.clientWidth, rect: rect.toJSON(), width: view.innerWidth, height: view.innerHeight };
    })()`);
    assert.equal(qrGeometry.fits, true, `${width}px: nested QR dialog stays inside its frame: ${JSON.stringify(qrGeometry)}`);
    assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 0, 'embedded QR modal never opens a parent dialog');
    if (width === 1320 || width === 320) await captureLearning(`${width}-qr-dialog`);
    press('Escape');
    await check(`!${learningDocument}.querySelector('#qr-dialog').open && ${learningDocument}.activeElement.id === 'qr-open'`, `${width}px: Escape closes nested QR dialog and restores focus`);
    await assertSelectedLearning(`${width}px: QR dismissal preserves the learning tab`);
  }
  await resizeViewport(900, 900);
  await evaluate(`${learningWindow}.scrollTo({ top: 777, behavior: 'instant' }); fixtureLearning.scrollY = ${learningWindow}.scrollY;`);
  assert.ok(await evaluate('fixtureLearning.scrollY > 0'), 'scroll preservation starts from a nonzero reading position');
  await evaluate(`(() => {
    const pane = document.querySelector('#desktop-learning-page'), view = ${learningWindow};
    fixtureLearning.revealResets = [];
    fixtureLearning.resetObserver = new MutationObserver(() => {
      if (pane.hidden) return;
      // Some platforms synchronously recover their native remembered offset
      // when shown. Force the newly visible viewport to discard it as well,
      // before the application can restore it in animation frames.
      view.scrollTo({ top: 0, behavior: 'instant' });
      fixtureLearning.revealResets.push(view.scrollY);
    });
    fixtureLearning.resetObserver.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  })()`);
  await click('#profile-tab');
  // Reproduce Chromium discarding a hidden iframe's viewport even on systems
  // that normally preserve it, so macOS also exercises Windows' reset path.
  await evaluate(`${learningWindow}.scrollTo({ top: 0, behavior: 'instant' })`);
  assert.equal(await evaluate(`${learningWindow}.scrollY`), 0, 'fixture actually resets the hidden child scroll position');
  await click('#desktop-learning-link');
  await check(`fixtureLearning.revealResets.length === 1 && fixtureLearning.revealResets[0] === 0`, 'fixture discards native scroll memory before the newly visible frame restores');
  await check(`Math.abs(fixtureLearning.scrollY - ${learningWindow}.scrollY) <= 1`, 'reopening the learning page restores scroll after the hidden child resets');
  assert.equal(await evaluate(`fixtureLearning.frame === document.querySelector('#desktop-learning-frame')
    && fixtureLearning.document === ${learningDocument} && fixtureLearning.frameLoads === 0
    && Math.abs(fixtureLearning.scrollY - ${learningWindow}.scrollY) <= 1`), true, 'switching tabs preserves the existing frame DOM and restores its reading position');
  // Keep every switch in one task, ahead of the queued animation frames. A
  // second entry/exit must not save the reset offset over the original reading
  // position; activating an already-selected tab must not cancel restoration.
  await evaluate(`(() => {
    const frame = ${learningWindow}, profileTab = document.querySelector('#profile-tab');
    const learningTab = document.querySelector('#desktop-learning-link');
    fixtureLearning.rapidHiddenResets = [];
    profileTab.click(); frame.scrollTo({ top: 0, behavior: 'instant' });
    fixtureLearning.rapidHiddenResets.push(frame.scrollY);
    learningTab.click(); profileTab.click();
    frame.scrollTo({ top: 0, behavior: 'instant' });
    fixtureLearning.rapidHiddenResets.push(frame.scrollY);
    learningTab.click(); learningTab.click();
  })()`, true);
  assert.deepEqual(await evaluate('fixtureLearning.rapidHiddenResets'), [0, 0], 'rapid-switch fixture actually resets both hidden viewports');
  await check(`fixtureLearning.revealResets.length === 2 && fixtureLearning.revealResets[1] === 0`, 'rapid entry also discards native scroll memory before restoration');
  await check(`Math.abs(fixtureLearning.scrollY - ${learningWindow}.scrollY) <= 1`, 'rapid hidden resets and repeated learning selection preserve the original reading position');
  await evaluate('fixtureLearning.resetObserver.disconnect()');
  await assertSelectedLearning('scroll restoration leaves the correct page selected');
  await clickLearning('#qr-open');
  await clickLearning('#qr-close');
  await check(`!${learningDocument}.querySelector('#qr-dialog').open && ${learningDocument}.activeElement.id === 'qr-open'`, 'explicit nested QR close restores focus');
  await clickLearning('#qr-open');
  const backdropPoint = await evaluate(`(() => {
    const frame = document.querySelector('#desktop-learning-frame').getBoundingClientRect();
    return { x: Math.round(frame.left + 2), y: Math.round(frame.top + 2) };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...backdropPoint });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...backdropPoint });
  await check(`!${learningDocument}.querySelector('#qr-dialog').open`, 'nested QR backdrop closes the dialog');
  const savedLearningQr = path.join(temporary, 'embedded-learning-wechat-qr.png');
  let learningDownload;
  session.defaultSession.once('will-download', (_event, item) => {
    item.setSavePath(savedLearningQr);
    learningDownload = new Promise((resolve, reject) => item.once('done', (_doneEvent, state) => {
      if (state === 'completed') resolve(); else reject(new Error(`embedded QR download ${state}`));
    }));
  });
  await clickLearning('#qr-save');
  await check(`${learningDocument}.querySelector('#qr-status').textContent.includes('已发起保存')`, 'embedded QR save reports a download');
  assert.ok(learningDownload, 'embedded QR save reaches the native download event');
  await learningDownload;
  assert.deepEqual(readFileSync(savedLearningQr), readFileSync(path.join(root, 'assets/support/wechat-personal-qr.png')), 'saved embedded QR preserves the original source bytes');
  assert.equal(win.webContents.getURL(), initialMainUrl, 'promotion and QR saving never reload or navigate the downloader window');
  assert.equal(readyEvents.get(win.webContents.id), 1, 'embedded navigation does not reinitialize the downloader');
  assert.deepEqual(learningPopups, [], 'opening and using promotion creates no popup window');
  await assertSelectedLearning('QR saving keeps the embedded learning page selected');
  const membershipDocument = `document.querySelector('#desktop-membership-frame').contentDocument`;
  const membershipWindow = `document.querySelector('#desktop-membership-frame').contentWindow`;
  assert.equal(await evaluate(`document.querySelector('#desktop-membership-frame').hasAttribute('src')`), false, 'membership page loads only on first selection');
  await click('#account-tab');
  await click('#account-membership-details');
  await check(`document.body.dataset.desktopPage === 'membership' && ${membershipDocument}?.body?.classList.contains('membership-embedded')`, 'account details opens the trusted packaged membership page');
  await evaluate(`window.fixtureMembershipDocument = ${membershipDocument}; ${membershipWindow}.scrollTo({ top: 777, behavior: 'instant' }); window.fixtureMembershipScroll = ${membershipWindow}.scrollY`);
  await click('#feedback-tab');
  await click('#desktop-membership-link');
  await check(`fixtureMembershipDocument === ${membershipDocument} && Math.abs(fixtureMembershipScroll - ${membershipWindow}.scrollY) <= 1`, 'membership frame DOM and reading position survive tab switches');
  await evaluate(`${membershipDocument}.querySelector('a[href="./index.html?membership=open"]').click()`);
  await check(`document.body.dataset.desktopPage === 'account' && document.querySelector('#membership-dialog').open`, 'embedded membership CTA opens account and purchase dialog in the workspace');
  assert.equal(win.webContents.getURL(), initialMainUrl, 'membership CTA preserves the main renderer URL');
  await click('#membership-close');
  await click('#desktop-membership-link');
  await evaluate(`${membershipDocument}.querySelector('a[href="./index.html"]').click()`);
  await check(`document.body.dataset.desktopPage === 'account'`, 'membership return link restores the preceding workspace page');
  await click('#desktop-membership-link');
  await evaluate(`${membershipDocument}.querySelector('a[href="./vip.html"]').click()`);
  await check(`document.body.dataset.desktopPage === 'vip'`, 'membership community link selects the separately priced VIP page');
  assert.equal(win.webContents.getURL(), initialMainUrl, 'membership and community navigation preserve downloader drafts');
  assert.deepEqual(learningPopups, [], 'membership navigation creates no popup window');
  await evaluate(`for (const [id, value] of Object.entries(fixtureLearning.original)) document.getElementById(id).value = value`);
  await click('#profile-tab');
  await resizeViewport(1180, 980);
  assert.equal(calls.filter(call => call.method === 'checkForUpdates').length, 0, 'renderer must not automatically check for updates');
  assert.equal(await evaluate(`document.querySelector('#desktop-about-page').hidden && document.querySelector('#desktop-about-update-mount').contains(document.querySelector('#desktop-update-panel'))`), true, 'updater lives inside the independent about page');
  await check(`document.querySelector('#desktop-account-mount #software-account') !== null`, 'account mounted in its own page');
  await evaluate(`window.dispatchEvent(new ErrorEvent('error', { message: 'fixture renderer error', error: new Error('fixture renderer error') }))`);
  await check(`true`, 'renderer remains interactive after diagnostic event');
  assert.equal(calls.some(call => call.method === 'recordDiagnostic' && call.value.event === 'renderer.error' && call.value.fields.message === 'fixture renderer error'), true, 'uncaught renderer errors enter local diagnostics');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('main > .desktop-page')).filter(page => !page.hidden).length`), 1, 'only one page visible');
  assert.equal(await evaluate(`document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight`), true, 'desktop window does not become a long landing page');
  assert.equal(await evaluate(`document.querySelector('#profile-items-details').open`), true, 'new failures expand records');
  assert.equal(await evaluate(`document.querySelector('#profile-items li:first-child button').dataset.retryId`), failedId, 'failure beyond item 100 stays visible');
  assert.match(await evaluate(`document.querySelector('#profile-items li:first-child .profile-item-title').textContent`), /^126 · /);
  assert.equal(await evaluate(`document.querySelector('#profile-items').querySelectorAll('img').length`), 0, 'titles render as text');
  assert.match(await evaluate(`document.querySelector('#profile-items li:first-child .profile-item-directory').textContent`), /126-测试笔记/);
  await click('#profile-items-failed');
  await check(`document.querySelector('#profile-items').children.length === 1`, 'failure filter');
  const copyFailedLink = '#profile-items button[data-copy-note-url]';
  const openFailedLink = '#profile-items button[data-open-note-url]';
  assert.deepEqual(await evaluate(`({
    text: document.querySelector('#profile-items .profile-item-url').textContent,
    copy: document.querySelector(${JSON.stringify(copyFailedLink)}).dataset.copyNoteUrl,
    open: document.querySelector(${JSON.stringify(openFailedLink)}).dataset.openNoteUrl
  })`), { text: failedUrl, copy: failedUrl, open: failedUrl }, 'failed links preserve all signature parameters in visible text and actions');
  // Exercise the actual renderer copy and parse flows without touching the
  // system clipboard or issuing a network request.
  await evaluate(`(() => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const originalExecCommand = document.execCommand, originalFetch = window.fetch;
    window.fixtureRecovery = { mode: 'success', copied: [], fallback: [], parsed: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => {
        fixtureRecovery.copied.push(text);
        if (fixtureRecovery.mode !== 'success') throw new DOMException('Fixture clipboard denied', 'NotAllowedError');
      }
    } });
    document.execCommand = command => {
      if (command !== 'copy') throw new Error('Unexpected fixture command');
      fixtureRecovery.fallback.push(document.activeElement.value);
      return fixtureRecovery.mode === 'fallback';
    };
    window.fetch = (url, options) => {
      if (!['/api/parse', '/api/python_parse'].includes(url)) return originalFetch(url, options);
      fixtureRecovery.parsed.push(JSON.parse(options.body).text);
      return new Promise(resolve => { fixtureRecovery.resolveParse = () => resolve(new Response(JSON.stringify({
        success: true, title: '此前解析的笔记', content: '此前解析的正文', images: [], videos: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })); });
    };
    fixtureRecovery.restore = () => {
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      else delete navigator.clipboard;
      document.execCommand = originalExecCommand;
      window.fetch = originalFetch;
    };
  })()`);
  for (const mode of ['success', 'fallback', 'denied']) {
    await evaluate(`fixtureRecovery.mode = ${JSON.stringify(mode)}`);
    await click(copyFailedLink);
    await check(`!document.querySelector(${JSON.stringify(copyFailedLink)}).hasAttribute('aria-busy') &&
      document.querySelector(${JSON.stringify(mode === 'denied' ? '#alert-toast' : '#toast')}).textContent.includes(${JSON.stringify(mode === 'denied' ? '剪贴板权限' : '链接已复制')})`, `${mode}: failed-link copy reports its outcome`);
    assert.equal(await evaluate('fixtureRecovery.copied.at(-1)'), failedUrl, `${mode}: clipboard receives the complete signed URL`);
    if (mode !== 'success') assert.equal(await evaluate('fixtureRecovery.fallback.at(-1)'), failedUrl, `${mode}: fallback receives the complete signed URL`);
  }
  await click('#single-note-tab');
  await evaluate(`document.querySelector('#share-text').value = '此前输入的笔记链接'`);
  await click('#parse-button');
  await check(`typeof fixtureRecovery.resolveParse === 'function' && document.querySelector('#parse-button').disabled`, 'single-note parser is genuinely busy');
  await click('#profile-tab');
  await click(openFailedLink);
  assert.equal(await evaluate(`document.body.dataset.desktopPage === 'profile' && document.querySelector('#share-text').value === '此前输入的笔记链接'`), true, 'busy single-note work cannot be replaced or navigated away from');
  assert.match(await evaluate(`document.querySelector('#alert-toast').textContent`), /单篇下载正在处理/);
  const busyCopyCount = await evaluate('fixtureRecovery.copied.length');
  await click(copyFailedLink);
  assert.equal(await evaluate('fixtureRecovery.copied.length'), busyCopyCount, 'busy single-note work prevents a competing clipboard action');
  await evaluate('fixtureRecovery.resolveParse()');
  await check(`!document.querySelector('#parse-button').disabled && !document.querySelector('#result-section').hidden`, 'previous single-note result is available before recovery');
  await click(openFailedLink);
  assert.equal(await evaluate(`document.body.dataset.desktopPage === 'single' && document.activeElement.id === 'share-text' && document.querySelector('#result-section').hidden && !document.querySelector('#empty-state').hidden`), true, 'recovery focuses single-note input and hides stale results');
  assert.equal(await evaluate(`document.querySelector('#share-text').value`), failedUrl, 'single-note recovery receives the complete signed URL');
  assert.equal(await evaluate('fixtureRecovery.parsed.length'), 1, 'recovery waits for an explicit parse action');
  await click('#profile-tab');
  const refreshedFailedUrl = `${failedUrl}&refresh_token=renewed%2Bsignature%3D`;
  publishProfile({ ...profile, items: profile.items.map(item => item.id === failedId ? { ...item, url: refreshedFailedUrl } : item) });
  await check(`document.querySelector('#profile-items .profile-item-url').textContent === ${JSON.stringify(refreshedFailedUrl)}`, 'a URL-only profile update refreshes the visible link');
  assert.deepEqual(await evaluate(`[
    document.querySelector(${JSON.stringify(copyFailedLink)}).dataset.copyNoteUrl,
    document.querySelector(${JSON.stringify(openFailedLink)}).dataset.openNoteUrl
  ]`), [refreshedFailedUrl, refreshedFailedUrl], 'URL-only updates refresh both recovery actions');
  await evaluate(`for (const toast of document.querySelectorAll('#toast, #alert-toast')) toast.classList.remove('toast-visible')`);
  const failureScreenshots = {};
  for (const [name, width, height] of [['desktop', 1180, 980], ['narrow', 390, 760]]) {
    await resizeViewport(width, height);
    await paint();
    await evaluate(`document.querySelector('#profile-items-details').scrollIntoView({ block: 'end' })`);
    assert.equal(await evaluate(`(() => {
      const row = document.querySelector('#profile-items li');
      return row.scrollWidth <= row.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    })()`), true, `${name}: full signed failure links wrap without horizontal overflow`);
    const file = path.join(temporary, `desktop-failed-links-${name}.png`);
    writeFileSync(file, await captureFrame());
    failureScreenshots[name] = file;
  }
  await resizeViewport(1180, 980);
  await paint();
  await click('#profile-items button[data-retry-id]');
  await check(`document.querySelector('#profile-status').textContent === '正在下载'`, 'single retry enters active queue');
  assert.deepEqual(calls.find(call => call.method === 'retryItem'), { method: 'retryItem', value: failedId });
  publishProfile({ ...profile, status: 'waiting', failed: 1, nextRequestAt: Date.now() + 10000,
    items: profile.items.map(item => item.id === failedId ? { ...item, status: 'failed', error: '测试请求失败' } : item) });
  await check(`document.querySelector('#profile-items button[data-retry-id]')?.disabled === true`, 'retry disabled during active queue');
  assert.equal(await evaluate(`!document.querySelector(${JSON.stringify(copyFailedLink)}).disabled && !document.querySelector(${JSON.stringify(openFailedLink)}).disabled`), true, 'active batch queue keeps failure recovery actions available');
  await evaluate(`fixtureRecovery.mode = 'success'`);
  await click(copyFailedLink);
  await check(`!document.querySelector(${JSON.stringify(copyFailedLink)}).hasAttribute('aria-busy') && document.querySelector('#toast').textContent.includes('链接已复制')`, 'active batch queue permits signed-link copying');
  assert.equal(await evaluate('fixtureRecovery.copied.at(-1)'), refreshedFailedUrl);
  await click(openFailedLink);
  assert.equal(await evaluate(`document.body.dataset.desktopPage === 'single' && document.querySelector('#share-text').value === ${JSON.stringify(refreshedFailedUrl)} && document.activeElement.id === 'share-text'`), true, 'active batch queue permits single-note recovery');
  assert.equal(profile.status, 'waiting', 'single-note recovery leaves the background batch queue active');
  assert.equal(await evaluate('fixtureRecovery.parsed.length'), 1, 'background recovery also waits for explicit parsing');
  await evaluate('fixtureRecovery.restore()');
  await click('#profile-tab');
  assert.equal(await evaluate(`document.querySelector('#profile-retry').hidden`), false, 'bulk retry remains discoverable');
  assert.equal(await evaluate(`document.querySelector('#profile-retry').disabled`), true);
  assert.match(await evaluate(`document.querySelector('#profile-items-hint').textContent`), /先暂停/);
  await click('#profile-items-all');
  await check(`document.querySelector('#profile-items').children.length === 100`, 'active all filter');
  assert.equal(await evaluate(`document.querySelector('#profile-items button[data-retry-id]').disabled`), true);
  await click('#profile-show-more');
  await check(`document.querySelector('#profile-items').children.length === 135`, 'active show more');
  assert.equal(await evaluate(`document.querySelector('#profile-items button[data-retry-id]').disabled`), true);
  await click('#profile-items-failed');
  await check(`document.querySelector('#profile-items').children.length === 1`, 'active failed filter');
  assert.equal(await evaluate(`document.querySelector('#profile-items button[data-retry-id]').disabled`), true);
  await click('#profile-items button[data-retry-id]');
  assert.equal(calls.filter(call => call.method === 'retryItem').length, 1, 'disabled retry must not invoke bridge');
  publishProfile({ ...profile, status: 'completed', nextRequestAt: null });
  await check(`!document.querySelector('#profile-choose-directory').disabled`, 'idle queue directory control');
  await click('#profile-choose-directory');
  await check(`document.querySelector('#profile-items button[data-retry-id]').disabled`, 'pending operation locks retry');
  await click('#profile-items-all');
  await check(`document.querySelector('#profile-items').children.length === 100`, 'filter while operation pending');
  assert.equal(await evaluate(`document.querySelector('#profile-items button[data-retry-id]').disabled`), true);
  resolveDirectory('/fixture/下载');
  await check(`!document.querySelector('#profile-items button[data-retry-id]').disabled`, 'retry unlocks after operation');
  // Show the requested version modal once, without downloading or installing
  // until the user acts. Its body scrolls independently of the fixed actions.
  await evaluate(`document.querySelector('#profile-tab').focus()`);
  publishUpdate(available());
  await check(`!document.querySelector('#desktop-update-announcement').hidden && !document.querySelector('#desktop-update-badge').hidden`, 'automatic update notice');
  await check(`document.querySelector('#desktop-update-dialog').open`, 'automatic version dialog');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog').getAttribute('aria-labelledby')`), 'desktop-update-dialog-title');
  assert.match(await evaluate(`document.querySelector('#desktop-update-dialog-version').textContent`), /v1\.6\.1.*v1\.6\.0/);
  assert.equal(await evaluate(`document.querySelectorAll('#desktop-update-dialog-notes img, #desktop-update-dialog-notes a, #desktop-update-dialog-notes script').length`), 0, 'release HTML and links never execute');
  assert.equal(await evaluate(`document.querySelectorAll('#desktop-update-dialog-notes h3').length > 0 && document.querySelectorAll('#desktop-update-dialog-notes li').length > 0`), true, 'release sections and bullets are readable');
  assert.equal(calls.some(call => ['downloadUpdate', 'installUpdate'].includes(call.method)), false);
  const dialogFits = `(() => { const d = document.querySelector('#desktop-update-dialog'), n = document.querySelector('#desktop-update-dialog-notes'), a = document.querySelector('#desktop-update-dialog-action'); const b = d.getBoundingClientRect(), f = a.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && n.scrollHeight > n.clientHeight && n.scrollWidth <= n.clientWidth && f.bottom <= b.bottom && f.top >= b.top; })()`;
  assert.equal(await evaluate(dialogFits), true, 'long notes scroll while actions stay visible');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await check(`document.querySelector('#desktop-update-dialog').contains(document.activeElement)`, 'keyboard focus stays in modal');
  const updateDialogScreenshot = path.join(temporary, 'desktop-update-dialog.png');
  writeFileSync(updateDialogScreenshot, await captureFrame());
  for (const boundary of ['#', '##']) {
    publishUpdate({ ...available(), releaseNotes: [
      '## 下载安装', '| 系统 | 安装包 |', '| --- | --- |', '| macOS | [下载](https://example.com/setup.dmg) |',
      '', '## 本次更新', '### 下载与安装', '- 更新中断后可以继续下载。',
      '', `${boundary} 验证`, '- 此处是发布验证记录。'
    ].join('\n') });
    await check(`document.querySelector('#desktop-update-dialog-notes li')?.textContent === '更新中断后可以继续下载。'`, 'release dialog prefers the actual update section');
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#desktop-update-dialog-notes li'), item => item.textContent)`), ['更新中断后可以继续下载。']);
    const displayedNotes = await evaluate(`document.querySelector('#desktop-update-dialog-notes').textContent`);
    assert.match(displayedNotes, /下载与安装/, 'nested subsection remains visible');
    assert.doesNotMatch(displayedNotes, /下载安装|\||发布验证记录|验证/, 'download tables and following release sections stay outside the modal');
  }
  publishUpdate({ ...available(), releaseNotes: '完整发布附注。\n## 本次更新\n\n## 验证\n- 发布记录仍可阅读。' });
  await check(`document.querySelector('#desktop-update-dialog-notes').textContent.includes('完整发布附注。') && document.querySelector('#desktop-update-dialog-notes').textContent.includes('发布记录仍可阅读。')`, 'empty update section preserves the full release notes');
  publishUpdate(available());
  await check(`document.querySelector('#desktop-update-dialog-notes').textContent.includes('下载与更新，更顺畅了。')`, 'restore realistic dialog content after release-format checks');
  await click('#desktop-update-dialog-later');
  await check(`!document.querySelector('#desktop-update-dialog').open && document.activeElement.id === 'profile-tab'`, 'later closes and restores focus');
  await click('#desktop-announcement-dismiss');
  publishUpdate(available());
  await check(`document.querySelector('#desktop-update-announcement').hidden && !document.querySelector('#desktop-update-dialog').open`, 'dismissed version is not repeatedly announced');
  await click('#about-tab');
  assert.equal(await evaluate(`document.body.dataset.desktopPage`), 'about');
  await click('#desktop-check-updates');
  await check(`document.querySelector('#desktop-update-dialog').open`, 'manual check reopens dismissed version');
  await check(`!document.querySelector('#desktop-update-download').hidden && !document.querySelector('#desktop-update-download').disabled`, 'update available');
  assert.match(await evaluate(`document.querySelector('#desktop-update-title').textContent`), /1\.6\.1/);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-notes').querySelectorAll('img').length`), 0, 'release notes render as text');
  assert.equal(calls.filter(call => call.method === 'installUpdate').length, 0, 'no automatic installation');
  await click('#desktop-update-dialog-action');
  await check(`!document.querySelector('#desktop-update-cancel').hidden && !document.querySelector('#desktop-update-cancel').disabled`, 'pause works during pending download IPC');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-cancel').textContent`), '暂停下载');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress').value`), 50);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-progress').value`), 50);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-action').textContent`), '暂停下载');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-later').textContent`), '后台下载');
  assert.match(await evaluate(`document.querySelector('#desktop-update-progress-text').textContent`), /50%/);
  publishUpdate({ ...update, download: { receivedBytes: 46, totalBytes: 100, canResume: false } });
  await check(`document.querySelector('#desktop-update-progress').value === 46`, 'download at the reported 46 percent');
  await evaluate(`document.querySelector('#desktop-update-dialog-action').focus()`);
  const liveUpdateBeforeHistory = await evaluate(`({
    page: document.body.dataset.desktopPage, focus: document.activeElement.id,
    progress: document.querySelector('#desktop-update-progress').value,
    progressText: document.querySelector('#desktop-update-progress-text').textContent,
    title: document.querySelector('#desktop-update-title').textContent,
    dialogs: Array.from(document.querySelectorAll('dialog[open]'), dialog => dialog.id)
  })`);
  publishHistory(previousInstall);
  await check(`!document.querySelector('#desktop-update-history').hidden`, 'late historical receipt is recorded while downloading');
  assert.deepEqual(await evaluate(`({
    page: document.body.dataset.desktopPage, focus: document.activeElement.id,
    progress: document.querySelector('#desktop-update-progress').value,
    progressText: document.querySelector('#desktop-update-progress-text').textContent,
    title: document.querySelector('#desktop-update-title').textContent,
    dialogs: Array.from(document.querySelectorAll('dialog[open]'), dialog => dialog.id)
  })`), liveUpdateBeforeHistory, 'historical receipt never changes current download, navigation, modal or focus');
  resolveHistoryRead(null);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate(`document.querySelector('#desktop-update-history').hidden`), false, 'late initial history read cannot replace newer event');
  publishHistory(null);
  await check(`document.querySelector('#desktop-update-history').hidden`, 'background history removal is nonmodal');
  publishUpdate({ ...update, download: { receivedBytes: 512, totalBytes: 1024, canResume: false } });
  await check(`document.querySelector('#desktop-update-progress').value === 50`, 'restore fixture download for continuation checks');
  await paint();
  const screenshot = path.join(temporary, 'desktop-ui.png');
  writeFileSync(screenshot, await captureFrame());
  await click('#desktop-update-dialog-action');
  await check(`!document.querySelector('#desktop-update-download').hidden && !document.querySelector('#desktop-update-download').disabled`, 'pause returns to available');
  assert.equal(calls.filter(call => call.method === 'cancelUpdateDownload').length, 1);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-download').textContent`), '继续下载');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress-wrap').hidden`), false, 'paused progress remains visible');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress').value`), 50);
  assert.match(await evaluate(`document.querySelector('#desktop-update-message').textContent`), /已保存下载进度/);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-action').textContent`), '继续下载');
  await click('#desktop-update-dialog-action');
  await check(`document.querySelector('#desktop-update-progress').value === 75`, 'continued download progresses from retained bytes');
  const interrupted = publishUpdate({ ...available(), status: 'error', download: { receivedBytes: 768, totalBytes: 1024, canResume: true }, error: { phase: 'download', message: '测试连接中断' } });
  resolveDownload(interrupted);
  resolveDownload = null;
  await check(`document.querySelector('#desktop-update-download').textContent === '继续下载' && !document.querySelector('#desktop-update-download').disabled`, 'interrupted download can continue');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress-wrap').hidden`), false, 'failed resumable progress remains visible');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress').value`), 75);
  assert.match(await evaluate(`document.querySelector('#desktop-update-message').textContent`), /已保存下载进度/);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-action').textContent`), '继续下载');
  downloadMode = 'downloaded';
  await click('#desktop-update-dialog-action');
  await check(`!document.querySelector('#desktop-update-install').hidden && !document.querySelector('#desktop-update-install').disabled`, 'continued download reaches ready to install');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-action').textContent`), '安装并重启');
  assert.equal(calls.filter(call => call.method === 'installUpdate').length, 0, 'completed download still requires installation action');
  await evaluate(`document.querySelector('#desktop-update-dialog-action').focus()`);
  await click('#desktop-update-dialog-action');
  await check(`document.querySelector('#desktop-install-confirmation').open`, 'main-process approval request opens the installation dialog');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 1, 'version and installation dialogs never stack');
  assert.equal(await evaluate(`document.activeElement.id`), 'desktop-install-later', 'installation starts with the safe later action focused');
  assert.equal(await evaluate(`document.querySelector('#desktop-install-details').open`), false, 'platform restrictions are collapsed initially');
  assert.match(await evaluate(`document.querySelector('#desktop-install-confirmation-version').textContent`), /v1\.6\.0.*v1\.6\.1/);
  assert.match(await evaluate(`document.querySelector('#desktop-install-replacement-description').textContent`), /成功启动后.*清理旧客户端/);
  assert.equal(acceptedInstallations, 0, 'opening confirmation does not approve installation');
  const installDialogFits = `(() => { const d = document.querySelector('#desktop-install-confirmation'), a = document.querySelector('#desktop-install-confirm'), b = d.getBoundingClientRect(), f = a.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && b.height <= 600 && d.scrollWidth <= d.clientWidth && f.bottom <= b.bottom && b.bottom - f.bottom <= 32 && f.top >= b.top; })()`;
  const assertInstallationLayout = async description => {
    const geometry = await evaluate(`(() => {
      const dialog = document.querySelector('#desktop-install-confirmation');
      return { fits: ${installDialogFits}, viewport: { width: innerWidth, height: innerHeight },
        dialog: dialog.getBoundingClientRect().toJSON(), clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth,
        action: document.querySelector('#desktop-install-confirm').getBoundingClientRect().toJSON(),
        computedMaxHeight: getComputedStyle(dialog).maxHeight,
        cssViewportHeight: document.querySelector('#fixture-css-viewport-probe')?.getBoundingClientRect().height,
        shortScreenMedia: matchMedia('(max-height: 540px)').matches,
        resizeEvents: window.fixtureViewportResizeEvents || [],
        detailsOpen: document.querySelector('#desktop-install-details').open };
    })()`);
    assert.equal(geometry.fits, true, `${description}; geometry: ${JSON.stringify(geometry)}`);
  };
  await assertInstallationLayout('installation summary and actions fit on desktop');
  const installDialogScreenshot = path.join(temporary, 'desktop-install-confirmation.png');
  writeFileSync(installDialogScreenshot, await captureFrame());
  await resizeViewport(390, 760);
  await assertInstallationLayout('installation dialog fits at 390px');
  const installDialogNarrowScreenshot = path.join(temporary, 'desktop-install-confirmation-narrow.png');
  writeFileSync(installDialogNarrowScreenshot, await captureFrame());
  await click('#desktop-install-details summary');
  await resizeViewport(390, 480);
  await assertInstallationLayout('expanded platform details scroll without hiding approval actions on short screens');
  await resizeViewport(1180, 980);
  await click('#desktop-install-later');
  await check(`!document.querySelector('#desktop-install-confirmation').open && document.querySelector('#desktop-update-dialog').open && document.activeElement.id === 'desktop-update-dialog-action'`, 'later returns to the original version dialog and restores focus');
  await check(`!document.querySelector('#desktop-update-dialog-action').disabled`, 'cancelled installation confirmation keeps the modal usable');
  assert.equal(calls.filter(call => call.method === 'installUpdate').length, 1, 'modal install reaches the main-process approval broker');
  assert.equal(calls.filter(call => call.method === 'respondInstallConfirmation').at(-1).value.confirmed, false, 'later explicitly declines the pending broker request');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await check(`!document.querySelector('#desktop-update-dialog').open`, 'Escape closes dialog');
  publishUpdate({ ...available(), status: 'error', error: { phase: 'download', message: '测试下载失败' } });
  await check(`document.querySelector('#desktop-update-download').textContent === '重试下载'`, 'download without retained bytes offers retry');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress-wrap').hidden`), true, 'no partial download means no retained progress');
  await click('#desktop-update-download');
  await check(`!document.querySelector('#desktop-update-install').hidden && !document.querySelector('#desktop-update-install').disabled`, 'ready to install');
  assert.match(await evaluate(`document.querySelector('#desktop-update-installation-hint').textContent`), /覆盖当前应用/);
  await evaluate(`document.querySelector('#desktop-update-install').focus()`);
  assert.equal(await evaluate('document.activeElement.id'), 'desktop-update-install', 'installation source is focused before the request');
  await click('#desktop-update-install');
  await check(`document.querySelector('#desktop-install-confirmation').open`, 'about-page install also requires the same approval dialog');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await check(`!document.querySelector('#desktop-update-install').disabled`, 'cancelled main-process confirmation remains retryable');
  assert.equal(calls.filter(call => call.method === 'installUpdate').length, 2);
  await check(`!document.querySelector('#desktop-install-confirmation').open && document.activeElement.id === 'desktop-update-install'`, 'Escape cancels and restores the invoking control');
  await evaluate(`document.querySelector('#desktop-install-confirmation').addEventListener('close', () => {
    window.fixtureClosedWhileInstallDisabled = document.querySelector('#desktop-update-install').disabled;
  })`);
  const installationCloseOrders = [];
  for (const order of ['close-first', 'result-first']) {
    installReplyOrder = order;
    await evaluate(`window.fixtureClosedWhileInstallDisabled = null; window.fixtureCancelEvent = null;
      document.querySelector('#desktop-update-install').focus();
      document.querySelector('#desktop-install-confirmation').addEventListener('cancel', event => {
        window.fixtureCancelEvent = { cancelable: event.cancelable, defaultPrevented: event.defaultPrevented };
      }, { once: true });`);
    if (order === 'result-first') await evaluate(`(() => {
      // Native dialog close delivery differs between platforms. Hold the real
      // close call until the IPC result has enabled its invoking control, so
      // this case exercises that order instead of depending on a timing race.
      const dialog = document.querySelector('#desktop-install-confirmation');
      const nativeClose = dialog.close;
      const ownClose = Object.getOwnPropertyDescriptor(dialog, 'close');
      window.fixtureReleaseInstallClose = null;
      window.fixtureCloseAttempts = 0;
      dialog.close = function (...args) {
        window.fixtureCloseAttempts++;
        window.fixtureReleaseInstallClose = () => {
          if (ownClose) Object.defineProperty(dialog, 'close', ownClose);
          else delete dialog.close;
          nativeClose.apply(dialog, args);
          window.fixtureReleaseInstallClose = null;
        };
      };
    })()`);
    await click('#desktop-update-install');
    await check(`document.querySelector('#desktop-install-confirmation').open`, `${order}: confirmation opens`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await check(`window.fixtureCancelEvent?.cancelable === true && window.fixtureCancelEvent.defaultPrevented === true`, `${order}: Escape reaches the application's cancel handler`);
    if (order === 'result-first') {
      await check(`typeof window.fixtureReleaseInstallClose === 'function' && !document.querySelector('#desktop-update-install').disabled`, 'result-first: IPC completes before releasing native close');
      assert.equal(await evaluate('window.fixtureCloseAttempts'), 1, 'The fixture must intercept the actual application close call exactly once');
      assert.equal(await evaluate(`document.querySelector('#desktop-install-confirmation').open`), true, 'Native close remains pending until explicitly released');
      await evaluate(`window.fixtureReleaseInstallClose()`);
    }
    await check(`window.fixtureClosedWhileInstallDisabled === ${order === 'close-first'}`, `${order}: native close and IPC completion order is exercised`);
    if (order === 'close-first') releaseInstallReply();
    await check(`!document.querySelector('#desktop-install-confirmation').open && !document.querySelector('#desktop-update-install').disabled && document.activeElement.id === 'desktop-update-install'`, `${order}: focus returns after closure and installation response both finish`);
    if (order === 'result-first') releaseConfirmationReply();
    await paint();
    assert.equal(await evaluate('document.activeElement.id'), 'desktop-update-install', `${order}: late close/response cannot overwrite focus`);
    installationCloseOrders.push({ order, ...await evaluate(`({
      cancelable: window.fixtureCancelEvent.cancelable,
      closeWhileInstallDisabled: window.fixtureClosedWhileInstallDisabled,
      finalFocus: document.activeElement.id
    })`) });
  }
  installReplyOrder = 'normal';
  await click('#desktop-update-install');
  await check(`document.querySelector('#desktop-install-confirmation').open`, 'installation confirmation can retry after Escape');
  await evaluate(`document.querySelector('#desktop-install-confirmation').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }))`);
  await check(`!document.querySelector('#desktop-install-confirmation').open && !document.querySelector('#desktop-update-install').disabled`, 'backdrop declines installation without losing the download');
  await click('#desktop-update-install');
  await check(`document.querySelector('#desktop-install-confirmation').open`, 'pending approval can be invalidated by the main process');
  const expiredInstall = pendingInstall;
  pendingInstall = null;
  expiredInstall.resolve(publishUpdate({ ...available(), status: 'downloaded' }));
  await check(`!document.querySelector('#desktop-install-confirmation').open && !document.querySelector('#desktop-update-install').disabled`, 'expired main-process approval closes its obsolete dialog');
  installationPlatform = 'win32'; installationPortable = true;
  await click('#desktop-update-install');
  await check(`document.querySelector('#desktop-install-confirmation').open`, 'portable Windows installation explanation');
  assert.match(await evaluate(`document.querySelector('#desktop-install-replacement-description').textContent`), /安装正式版/);
  assert.doesNotMatch(await evaluate(`document.querySelector('#desktop-install-replacement-description').textContent`), /清理旧客户端/);
  assert.match(await evaluate(`document.querySelector('#desktop-install-technical-hint').textContent`), /旧便携文件不会被覆盖/);
  await click('#desktop-install-confirm');
  await check(`!document.querySelector('#desktop-install-confirmation').open`, 'explicit approval closes the dialog for installation');
  assert.equal(acceptedInstallations, 1, 'only the explicit install-and-restart action approves the broker request');
  assert.equal(calls.filter(call => call.method === 'respondInstallConfirmation').at(-1).value.confirmed, true);
  publishUpdate({ ...available(), status: 'error', error: { phase: 'install', message: '测试安装失败' } });
  await check(`document.querySelector('#desktop-update-install').textContent === '重试安装'`, 'installation error retry');
  installationMode = 'failure';
  await click('#desktop-update-install');
  await check(`document.querySelector('#desktop-update-dialog').open && !document.querySelector('#desktop-update-dialog-manual').hidden`, 'failed installation opens manual recovery in the actual update modal');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-manual').hidden`), false, 'about page also offers manual installation');
  assert.equal(calls.filter(call => call.method === 'openLatestInstaller').length, 0, 'installation failure alone never opens the browser');
  assert.match(await evaluate(`document.querySelector('#desktop-update-dialog-manual').textContent`), /退出旧版.*原位置并覆盖/s);
  assert.match(await evaluate(`document.querySelector('#desktop-update-manual').textContent`), /通常会保留账号、任务和已下载文件/);
  await evaluate(`document.querySelector('#desktop-update-dialog-manual-download').click(); document.querySelector('#desktop-update-dialog-manual-download').dispatchEvent(new MouseEvent('click')); document.querySelector('#desktop-update-manual-download').dispatchEvent(new MouseEvent('click'));`);
  await check(`document.querySelector('#desktop-update-dialog-manual-download').disabled && document.querySelector('#desktop-update-manual-download').disabled`, 'both manual buttons share the pending state');
  assert.equal(calls.filter(call => call.method === 'openLatestInstaller').length, 1, 'rapid clicks across both surfaces invoke the backend once');
  assert.equal(calls.filter(call => call.method === 'openLatestInstaller')[0].value, undefined, 'renderer submits no URL, platform or architecture');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-manual-download').textContent`), '正在获取安装包…');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-action').disabled`), false, 'manual loading keeps the existing retry action available');
  await click('#desktop-update-dialog-later');
  await check(`!document.querySelector('#desktop-update-dialog').open && document.querySelector('#desktop-update-manual-download').disabled`, 'later dismisses the modal without interrupting the independent request');
  resolveManualInstaller({ ok: false, error: { code: 'NETWORK', message: '测试网络错误 <img src=x onerror=alert(1)>' } });
  await check(`!document.querySelector('#desktop-update-manual-download').disabled && document.querySelector('#desktop-update-manual-status').dataset.status === 'error'`, 'manual fetch failure is visible and can retry');
  assert.match(await evaluate(`document.querySelector('#desktop-update-manual-status').textContent`), /未能打开安装包下载.*测试网络错误/);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-error').textContent`), '测试安装失败', 'network failure retains the original installation error');
  await click('#desktop-update-manual-download');
  await check(`document.querySelector('#desktop-update-manual-download').disabled`, 'about page can retry the manual download');
  resolveManualInstaller({ ok: true, version: '1.6.9', name: 'latest-mac-arm64.dmg' });
  await check(`!document.querySelector('#desktop-update-manual-download').disabled && document.querySelector('#desktop-update-manual-status').textContent.includes('v1.6.9')`, 'confirmed browser request reports the freshly fetched version');
  assert.match(await evaluate(`document.querySelector('#desktop-update-manual-status').textContent`), /请查看浏览器下载进度/);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-error').textContent`), '测试安装失败', 'opening a manual installer never claims installation success');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-install').textContent`), '重试安装');
  await click('#desktop-update-install');
  await check(`document.querySelector('#desktop-update-dialog').open && !document.querySelector('#desktop-update-dialog-action').disabled`, 'existing installation retry remains usable after manual download');
  manualInstallerMode = 'throw';
  await click('#desktop-update-dialog-manual-download');
  await check(`!document.querySelector('#desktop-update-dialog-manual-download').disabled && document.querySelector('#desktop-update-dialog-manual-status').textContent.includes('请检查网络和默认浏览器设置后重试')`, 'rejected browser IPC also reports failure and restores controls');
  assert.doesNotMatch(await evaluate(`document.querySelector('#desktop-update-dialog-manual-status').textContent`), /ui-fixture:invoke|Error invoking/, 'unexpected IPC internals do not enter the user guidance');
  for (const selector of ['#desktop-update-manual-status', '#desktop-update-dialog-manual-status']) {
    assert.equal(await evaluate(`document.querySelector('${selector}').querySelector('img') === null`), true, 'manual installer errors render as safe text');
  }
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-error').textContent`), '测试安装失败');
  publishUpdate({ ...update, canRetry: false });
  await check(`document.querySelector('#desktop-update-dialog-action').disabled && !document.querySelector('#desktop-update-dialog-manual-download').disabled && !document.querySelector('#desktop-update-manual').hidden`, 'manual recovery stays available when automatic installation cannot retry');
  publishUpdate({ ...update, canRetry: true });
  await check(`!document.querySelector('#desktop-update-dialog-action').disabled`, 'automatic retry availability follows the original update state');
  if (process.argv.includes('--classic-scrollbars')) {
    // Reproduce a CI desktop with scrollbars that consume layout width, even on
    // a development Mac configured to use overlay scrollbars.
    await win.webContents.insertCSS('.desktop-page { overflow-y: scroll !important; } .desktop-page::-webkit-scrollbar { width: 16px; }');
  }
  const manualInstallerScreenshots = {};
  const manualRecoveryFits = `(() => {
    const d = document.querySelector('#desktop-update-dialog'), b = d.getBoundingClientRect();
    const content = document.querySelector('#desktop-update-dialog-manual');
    return d.open && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && d.scrollWidth <= d.clientWidth
      && content.clientHeight > 0 && content.scrollWidth <= content.clientWidth
      && ['#desktop-update-dialog-manual-download', '#desktop-update-dialog-action', '#desktop-update-dialog-later'].every(selector => {
        const r = document.querySelector(selector).getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom && r.left >= b.left && r.right <= b.right && r.height >= 44;
      });
  })()`;
  for (const [width, height] of [[1180, 800], [390, 844], [390, 480], [320, 480]]) {
    await resizeViewport(width, height);
    await check(manualRecoveryFits, `manual recovery and all actions fit ${width}×${height}`);
    await evaluate(`document.querySelector('#desktop-update-dialog-manual').scrollTop = 9999`);
    assert.equal(await evaluate(manualRecoveryFits), true, 'scrolling manual guidance keeps all failure actions visible');
    await evaluate(`document.querySelector('#desktop-update-dialog-manual').scrollTop = 0`);
    const name = `${width}x${height}`;
    manualInstallerScreenshots[name] = path.join(temporary, `desktop-manual-installer-${name}.png`);
    writeFileSync(manualInstallerScreenshots[name], await captureFrame());
  }
  await click('#desktop-update-dialog-later');
  await click('#about-tab');
  await evaluate(`document.querySelector('#desktop-update-manual-download').scrollIntoView({ block: 'center' })`);
  assert.equal(await evaluate(`(() => { const p = document.querySelector('#desktop-about-page'), b = document.querySelector('#desktop-update-manual-download').getBoundingClientRect(); return p.scrollWidth <= p.clientWidth && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; })()`), true, 'about recovery remains reachable without narrow overflow');
  manualInstallerScreenshots.about = path.join(temporary, 'desktop-manual-installer-about-narrow.png');
  writeFileSync(manualInstallerScreenshots.about, await captureFrame());
  manualInstallerMode = 'pending';
  await click('#desktop-update-manual-download');
  await check(`document.querySelector('#desktop-update-manual-download').disabled`, 'a manual request can overlap a later update state');
  publishUpdate({ ...available(), status: 'downloaded' });
  await check(`document.querySelector('#desktop-update-manual').hidden && document.querySelector('#desktop-update-dialog-manual').hidden`, 'leaving installation failure hides both manual recovery views');
  resolveManualInstaller({ ok: true, version: '9.9.9' });
  await check(`!document.querySelector('#desktop-update-manual-download').disabled`, 'late manual reply releases busy state');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-manual-status').textContent`), '', 'stale manual result cannot replace a newer update state');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-panel').dataset.status`), 'downloaded');
  installationMode = 'confirmation';
  await resizeViewport(1180, 980);
  publishUpdate({ ...available(), status: 'error', error: { phase: 'check', message: '测试检查失败' } });
  await check(`!document.querySelector('#desktop-update-retry').hidden`, 'check error retry');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-download').hidden`), true, 'a raw latestVersion cannot authorize downloading after an ordinary check error');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-action').dataset.action`), 'check');
  await click('#desktop-update-retry');
  await check(`!document.querySelector('#desktop-update-download').hidden`, 'check retry result');
  await click('#desktop-update-dialog-later');
  assert.equal(calls.filter(call => call.method === 'checkForUpdates').length, 2);
  const checkFailureScreenshots = {};
  for (const receivedBytes of [0, 512]) {
    const retained = { ...available(), canRetry: false,
      download: { receivedBytes, totalBytes: 1024, canResume: receivedBytes > 0 } };
    publishUpdate(retained);
    await check(`!document.querySelector('#desktop-update-download').hidden && !document.querySelector('#desktop-update-download').disabled`, 'known release is available before a recheck');
    checkMode = 'retained-failure';
    await click('#desktop-check-updates');
    await check(`document.querySelector('#desktop-update-panel').dataset.status === 'checking' && document.querySelector('#desktop-update-download').disabled`, 'recheck enters a real pending checking state');
    resolveUpdateCheck();
    resolveUpdateCheck = null;
    await check(`document.querySelector('#desktop-update-dialog').open && document.querySelector('#desktop-update-dialog-action').dataset.action === 'download' && !document.querySelector('#desktop-update-dialog-action').disabled`, 'failed recheck preserves the known release download action');
    const expectedAction = receivedBytes ? '继续下载' : '立即更新';
    assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-action').textContent`), expectedAction);
    assert.equal(await evaluate(`document.querySelector('#desktop-update-download').textContent`), receivedBytes ? '继续下载' : '下载更新');
    assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-title').textContent`), '发现新版本');
    assert.match(await evaluate(`document.querySelector('#desktop-update-title').textContent`), /发现新版本 v1\.6\.1/);
    assert.match(await evaluate(`document.querySelector('#desktop-update-dialog-version').textContent`), /v1\.6\.1.*v1\.6\.0/);
    for (const selector of ['#desktop-update-check-note', '#desktop-update-dialog-check-note']) {
      assert.equal(await evaluate(`document.querySelector('${selector}').hidden`), false, 'both views explain that the known release remains downloadable');
      assert.equal(await evaluate(`document.querySelector('${selector}').textContent`), '暂时无法检查最新版本，仍可下载已发现的 v1.6.1。');
      assert.equal(await evaluate(`document.querySelector('${selector}').getAttribute('role')`), 'status', 'the retry notice is polite rather than an error alert');
      assert.equal(await evaluate(`document.querySelector('${selector}').querySelectorAll('img').length`), 0);
    }
    assert.equal(await evaluate(`document.querySelector('#desktop-update-error').hidden && document.querySelector('#desktop-update-dialog-error').hidden`), true, 'recheck failure does not turn into a blocking download error');
    assert.equal(await evaluate(`document.querySelector('#desktop-update-progress-wrap').hidden`), receivedBytes === 0);
    assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-progress-wrap').hidden`), receivedBytes === 0);
    if (receivedBytes) {
      assert.equal(await evaluate(`document.querySelector('#desktop-update-progress').value`), 50);
      assert.equal(await evaluate(`document.querySelector('#desktop-update-dialog-progress').value`), 50);
    }
    assert.equal(await evaluate(dialogFits), true, 'recheck notice keeps the dialog footer visible');
    const screenshotName = receivedBytes ? 'resume' : 'fresh';
    checkFailureScreenshots[screenshotName] = path.join(temporary, `desktop-update-recheck-${screenshotName}.png`);
    writeFileSync(checkFailureScreenshots[screenshotName], await captureFrame());
    const downloadsBefore = calls.filter(call => call.method === 'downloadUpdate').length;
    const checksBefore = calls.filter(call => call.method === 'checkForUpdates').length;
    downloadMode = 'pending';
    await click('#desktop-update-dialog-action');
    await check(`document.querySelector('#desktop-update-dialog-action').textContent === '暂停下载'`, 'the retained release starts downloading without another metadata check');
    assert.equal(calls.filter(call => call.method === 'downloadUpdate').length, downloadsBefore + 1);
    assert.equal(calls.filter(call => call.method === 'checkForUpdates').length, checksBefore);
    assert.equal(await evaluate(`document.querySelector('#desktop-update-check-note').hidden && document.querySelector('#desktop-update-dialog-check-note').hidden`), true, 'starting a download clears the recheck notice');
    await click('#desktop-update-dialog-action');
    await check(`document.querySelector('#desktop-update-dialog-action').textContent === '继续下载' && !document.querySelector('#desktop-update-dialog-action').disabled`, 'fixture download pauses with saved progress');
    await click('#desktop-update-dialog-later');
    await check(`!document.querySelector('#desktop-update-dialog').open`, 'finish retained-release download regression');
    checkMode = 'success';
  }
  publishUpdate({ ...available(), checkError: retainedCheckError });
  await check(`!document.querySelector('#desktop-update-check-note').hidden`, 'a subsequent successful check can clear a retained warning');
  await click('#desktop-check-updates');
  await check(`document.querySelector('#desktop-update-dialog').open && document.querySelector('#desktop-update-check-note').hidden && document.querySelector('#desktop-update-dialog-check-note').hidden`, 'successful recheck clears the nonblocking notice in both views');
  await click('#desktop-update-dialog-later');
  publishUpdate({ ...available(), status: 'downloaded', installationHint: '当前为 Windows 便携版；本次更新会运行安装程序，安装正式版。' });
  await check(`document.querySelector('#desktop-update-installation-hint').textContent.includes('便携版')`, 'Windows portable installation explanation');
  const pageScreenshots = {};
  const screenshotPage = async (name, tab) => {
    await click(tab);
    await paint();
    const file = path.join(temporary, `desktop-${name}.png`);
    writeFileSync(file, await captureFrame());
    pageScreenshots[name] = file;
  };
  await screenshotPage('profile', '#profile-tab');
  await screenshotPage('single', '#single-note-tab');
  await screenshotPage('account', '#account-tab');
  await click('#feedback-tab');
  await check(`document.querySelector('#desktop-diagnostics-files').textContent.includes('4 个文件')`, 'diagnostics metadata loaded');
  assert.match(await evaluate(`document.querySelector('#desktop-diagnostics-summary').textContent`), /轮转/);
  assert.match(await evaluate(`document.querySelector('#desktop-diagnostics-range').textContent`), /2026/);
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-submit').disabled`), false, 'ordinary user can submit without membership');
  publishAccount({ configured: true, authenticated: false, verified: false, status: 'signed_out' });
  await check(`document.querySelector('#desktop-feedback-submit').disabled && !document.querySelector('#desktop-feedback-account-hint').hidden`, 'feedback requires software login');
  await click('#desktop-feedback-login');
  assert.equal(await evaluate(`document.body.dataset.desktopPage`), 'account');
  await screenshotPage('account-login', '#account-tab');
  publishAccount({ configured: true, authenticated: true, verified: true, status: 'authenticated', account: { user: { id: 'fixture-user', email: 'ordinary@example.com' }, membership: { type: 'none', active: false }, device: { status: 'authorized' } } });
  await click('#feedback-tab');
  await check(`!document.querySelector('#desktop-feedback-submit').disabled`, 'feedback unlocked after login');
  await click('#desktop-diagnostics-copy');
  await check(`document.querySelector('#desktop-diagnostics-result').textContent.includes('已复制')`, 'copy diagnostics feedback');
  await click('#desktop-diagnostics-export');
  await check(`document.querySelector('#desktop-diagnostics-result').textContent === '已取消导出。'`, 'cancelled export is not success');
  exportMode = 'success';
  await click('#desktop-diagnostics-export');
  await check(`document.querySelector('#desktop-diagnostics-result').textContent === '日志已导出。'`, 'export diagnostics success');
  const feedbackInput = { title: '主页任务出现错误', description: '点击开始后第十二篇提示网络错误，重试仍出现同样的问题。', category: 'download' };
  await evaluate(`document.querySelector('#desktop-feedback-title').value = ${JSON.stringify(feedbackInput.title)}; document.querySelector('#desktop-feedback-description').value = ${JSON.stringify(feedbackInput.description)};`);
  await click('#desktop-feedback-submit');
  await check(`!document.querySelector('#desktop-feedback-progress-wrap').hidden && document.querySelector('#desktop-feedback-progress').value === 50`, 'feedback upload progress');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-submit').disabled && document.querySelector('#desktop-feedback-description').disabled`), true, 'pending submission cannot duplicate');
  assert.deepEqual(calls.find(call => call.method === 'submitFeedback').value, feedbackInput);
  await screenshotPage('feedback-upload', '#feedback-tab');
  resolveFeedback({ ok: true, feedbackId: 'fb_fixture_001' });
  await check(`document.querySelector('#desktop-feedback-result').textContent.includes('fb_fixture_001') && !document.querySelector('#desktop-feedback-submit').disabled`, 'feedback ID after confirmed success');
  feedbackMode = 'error';
  await click('#desktop-feedback-submit');
  await check(`document.querySelector('#desktop-feedback-result').dataset.status === 'error'`, 'feedback server failure surfaced');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-result').querySelector('img') === null`), true, 'feedback errors render as text');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-description').value`), feedbackInput.description, 'failure preserves description');
  await screenshotPage('feedback-error', '#feedback-tab');
  win.webContents.send('ui-fixture:navigate', { page: 'about' });
  await check(`document.body.dataset.desktopPage === 'about'`, 'main-process notification navigates to about');
  await screenshotPage('about', '#about-tab');
  await resizeViewport(390, 844);
  // clientWidth excludes a classic vertical scrollbar; innerWidth describes
  // the requested viewport consistently on macOS and Windows.
  await check(`window.innerWidth === 390`, 'narrow viewport');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'no horizontal overflow');
  for (const tab of ['#profile-tab', '#single-note-tab', '#account-tab', '#desktop-membership-link', '#feedback-tab', '#about-tab', '#desktop-learning-link']) {
    await click(tab);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, `${tab} has no narrow horizontal overflow`);
    assert.equal(await evaluate(`document.documentElement.scrollHeight <= window.innerHeight`), true, `${tab} preserves viewport height`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('main > .desktop-page')).filter(page => !page.hidden).length`), 1, `${tab} is a distinct page`);
    assert.equal(await evaluate(`document.querySelector('.desktop-page:not([hidden])').scrollWidth <= document.querySelector('.desktop-page:not([hidden])').clientWidth`), true, `${tab} content fits beside scrollbars`);
  }
  await click('#about-tab');
  const narrowViewport = await evaluate(`({ innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })`);
  await paint();
  const narrowScreenshot = path.join(temporary, 'desktop-ui-narrow.png');
  writeFileSync(narrowScreenshot, await captureFrame());
  publishUpdate({ ...available(), latestVersion: '1.6.2' });
  await check(`document.querySelector('#desktop-update-dialog').open`, 'a newer version may announce again');
  publishUpdate({ ...update, checkError: retainedCheckError });
  await check(`!document.querySelector('#desktop-update-dialog-check-note').hidden`, 'retained release notice is visible at 390px');
  assert.equal(await evaluate(dialogFits), true, '390px dialog keeps long notes inside and footer visible');
  await evaluate(`document.querySelector('#desktop-update-dialog-notes').scrollTop = 300`);
  assert.equal(await evaluate(dialogFits), true, 'scrolling notes does not move the action row out of view');
  await evaluate(`document.querySelector('#desktop-update-dialog-notes').scrollTop = 0`);
  const updateDialogNarrowScreenshot = path.join(temporary, 'desktop-update-dialog-narrow.png');
  writeFileSync(updateDialogNarrowScreenshot, await captureFrame());
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: 2, y: 2 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 2, y: 2 });
  await check(`!document.querySelector('#desktop-update-dialog').open`, 'backdrop dismisses modal');
  await click('#desktop-check-updates');
  await check(`document.querySelector('#desktop-update-dialog').open`, 'dialog can reopen for background download');
  downloadMode = 'pending';
  await click('#desktop-update-dialog-action');
  await check(`document.querySelector('#desktop-update-dialog-later').textContent === '后台下载'`, 'background download action available');
  const pausesBefore = calls.filter(call => call.method === 'cancelUpdateDownload').length;
  await click('#desktop-update-dialog-later');
  await check(`!document.querySelector('#desktop-update-dialog').open`, 'background action closes only the modal');
  assert.equal(calls.filter(call => call.method === 'cancelUpdateDownload').length, pausesBefore, 'background download never pauses');
  await click('#desktop-update-cancel');
  await check(`!document.querySelector('#desktop-update-download').disabled`, 'background download can still pause from about page');
  await click('#desktop-check-updates');
  await check(`document.querySelector('#desktop-update-dialog').open`, 'explicit recheck can reopen');
  publishUpdate({ ...available(), status: 'up-to-date', latestVersion: '1.6.0' });
  await check(`!document.querySelector('#desktop-update-dialog').open`, 'a newer check with no update closes the obsolete modal');
  // A prior install result must stay passive with and without a version dialog.
  await resizeViewport(1180, 980);
  publishUpdate({ ...available(), status: 'downloading', download: { receivedBytes: 46, totalBytes: 100, canResume: false } });
  await click('#profile-tab');
  await evaluate(`document.querySelector('#profile-url').focus()`);
  publishHistory(previousInstall);
  await check(`!document.querySelector('#desktop-update-history').hidden`, 'history notice arrives outside the about page');
  assert.equal(await evaluate(`document.body.dataset.desktopPage === 'profile' && document.activeElement.id === 'profile-url' && document.querySelectorAll('dialog[open]').length === 0`), true, 'history does not steal focus, open a modal or navigate');
  await click('#about-tab');
  assert.match(await evaluate(`document.querySelector('#desktop-update-history-meta').textContent`), /安装目标 v1\.5\.9.*当时版本 v1\.5\.8.*当前版本 v1\.6\.0.*2026/);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress').value`), 46);
  const historyScreenshot = path.join(temporary, 'desktop-update-history.png');
  writeFileSync(historyScreenshot, await captureFrame());
  await resizeViewport(390, 844);
  await check(`window.innerWidth === 390`, 'history notice narrow viewport');
  await evaluate(`document.querySelector('#desktop-update-history').scrollIntoView({ block: 'center' })`);
  assert.equal(await evaluate(`document.querySelector('#desktop-about-page').scrollWidth <= document.querySelector('#desktop-about-page').clientWidth`), true, 'history metadata fits at 390px');
  const historyNarrowScreenshot = path.join(temporary, 'desktop-update-history-narrow.png');
  writeFileSync(historyNarrowScreenshot, await captureFrame());
  historyDismissMode = 'error';
  await click('#desktop-update-history-dismiss');
  await check(`!document.querySelector('#desktop-update-history-error').hidden && !document.querySelector('#desktop-update-history-dismiss').disabled`, 'failed acknowledgement remains visible and can retry');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-history').hidden`), false, 'failed acknowledgement keeps the receipt');
  historyDismissMode = 'pending';
  await click('#desktop-update-history-dismiss');
  await check(`document.querySelector('#desktop-update-history-dismiss').disabled`, 'pending acknowledgement prevents duplicate writes');
  publishHistory({ ...previousInstall, id: 'fixture-newer-install', targetVersion: null, previousVersion: null, recordedAt: 'invalid',
    outcome: '历史结果 <img src=x onerror=alert(1)>', action: '保留说明 <script>alert(1)</script>' });
  await check(`document.querySelector('#desktop-update-history-meta').textContent.startsWith('安装版本未记录')`, 'legacy receipts tolerate missing version and time');
  resolveHistoryDismiss(null);
  await check(`!document.querySelector('#desktop-update-history-dismiss').disabled`, 'stale acknowledgement completes');
  assert.equal(await evaluate(`!document.querySelector('#desktop-update-history').hidden && document.querySelector('#desktop-update-history-outcome').textContent.includes('<img')`), true, 'old acknowledgement cannot dismiss a newer receipt');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-history').querySelectorAll('img, script').length`), 0, 'history values render as text');
  historyDismissMode = 'success';
  await click('#desktop-update-history-dismiss');
  await check(`document.querySelector('#desktop-update-history').hidden`, 'acknowledged receipt hides without changing updater');
  assert.equal(calls.filter(call => call.method === 'dismissUpdateHistory').at(-1).value, 'fixture-newer-install');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress').value`), 46, 'acknowledgement preserves live download progress');
  await win.loadURL('xhs-app://local/');
  await check(`document.body.dataset.desktopReady === 'true' && document.querySelector('#desktop-update-progress').value === 46`, 'renderer reload restores live update');
  await check(`document.querySelector('#desktop-update-history').hidden && document.querySelectorAll('dialog[open]').length === 0`, 'acknowledged history stays hidden after reload');
  const web = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await web.loadURL('xhs-app://local/');
  await verifyShortcut(web);
  await web.loadURL('xhs-app://local/download.html');
  await verifyShortcut(web);
  await web.loadURL('xhs-app://local/');
  assert.equal(await web.webContents.executeJavaScript(`document.querySelector('#desktop-navigation').hidden && document.querySelector('#desktop-update-panel').hidden && document.querySelector('#desktop-update-history').hidden && !document.querySelector('#single-note-panel').hidden && !document.querySelector('#desktop-update-dialog').open && !document.querySelector('#desktop-install-confirmation').open`), true, 'web interface remains unchanged without bridge');
  const failedInitialization = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const failedInitializationId = failedInitialization.webContents.id;
  failedInitializationWindows.add(failedInitializationId);
  await failedInitialization.loadURL('xhs-app://local/');
  let failureShown = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    failureShown = await failedInitialization.webContents.executeJavaScript(`document.body.innerText.includes('fixture profile initialization failed')`);
    if (failureShown) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(failureShown, true, 'profile initialization failure reaches the recoverable UI error');
  assert.equal(await failedInitialization.webContents.executeJavaScript(`document.body.dataset.desktopReady`), undefined, 'failed initialization cannot authorize backup cleanup');
  assert.equal(readyEvents.get(failedInitializationId) || 0, 0, 'failed initialization never emits desktop-ready');
  failedInitialization.destroy();
  assert.deepEqual(rendererErrors, [], 'no renderer console errors');
  web.destroy();
  win.destroy();
  console.log(JSON.stringify({ smoke: 'passed', checks: ['XHS login reset confirmation cancel, pending deduplication, success, retry and safe error rendering', 'XHS reset rejects unconfirmed cleanup and stale initial login discovery', '760px and 390px login/reset controls with long nickname', 'iPhone shortcut external link, copy success and failure on desktop, web and downloads', 'failure beyond 100 visible', 'failure filter and single retry', 'signed failed-link copy, fallback and denied feedback', 'single-note recovery preserves URL, focuses input and clears stale results', 'busy single-note guard and active batch recovery', 'URL-only updates refresh failed-link actions', 'active queue retry guard', 'no automatic update requests', 'update progress and pause', 'retained download progress and continuation', 'known release remains downloadable after failed recheck with and without partial bytes', 'recheck notice clears after download or successful check', 'download retry without retained bytes', 'phase-aware retries', 'manual latest-installer recovery, deduplication, error preservation and 320px layout', 'manual install only', 'broker-backed installation approval, cancellation and expiry', 'installation dialog desktop and 390px layout', 'desktop-ready emitted only after successful initialization', 'safe text rendering', 'release update-section selection and empty-section fallback', 'Mac and Windows installation hints', '390px all-page layout', 'eight independent pages', 'lazy packaged learning iframe, keyboard wrap and return navigation', 'membership iframe lazy loading, account entry, purchase CTA, community entry and reading-position persistence', 'download and feedback drafts survive embedded navigation', 'embedded 1320/900/760/390/320 layout with no parent or child overflow', 'nested QR dialog Escape, explicit close, backdrop and original-byte save', 'frame DOM and scroll survive tab switches without new windows', 'hidden child scroll resets restore reading position, including rapid switches and repeated selection', 'feedback login gate and ordinary member', 'diagnostics copy/export', 'feedback progress and failure', 'automatic update notice deduplication', 'version dialog focus and dismissal', 'dialog progress and background download', 'scrollable notes with fixed footer at 390px', 'native notification navigation', 'nonmodal history during a 46 percent download', 'history read and acknowledgement race guards', 'history acknowledgement errors and reload', 'history text safety and 390px layout', 'web-only regression'], loginResetScreenshots, learningScreenshots, savedLearningQr, failureScreenshots, narrowViewport, screenshot, narrowScreenshot, updateDialogScreenshot, updateDialogNarrowScreenshot, installDialogScreenshot, installDialogNarrowScreenshot, checkFailureScreenshots, pageScreenshots, historyScreenshot, historyNarrowScreenshot, installationCloseOrders, manualInstallerScreenshots }));
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => {
  console.error('DESKTOP_UI_SMOKE_FAILED', error);
  clearTimeout(timeout);
  app.exit(1);
});
