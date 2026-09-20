// Isolated UI integration smoke; never logs in, downloads or installs an update.
// Run: node_modules/.bin/electron scripts/verify-desktop-ui.mjs
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  getLoginState: () => invoke('getLoginState'),
  getUpdateState: () => invoke('getUpdateState'),
  checkForUpdates: () => invoke('checkForUpdates'),
  downloadUpdate: () => invoke('downloadUpdate'),
  cancelUpdateDownload: () => invoke('cancelUpdateDownload'),
  installUpdate: () => invoke('installUpdate'),
  chooseDirectory: () => invoke('chooseDirectory'),
  openLogin: value => invoke('openLogin', value),
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
  const failedId = (126).toString(16).padStart(24, '0');
  const fixtureTitle = '测试笔记 <img src=x onerror=alert(1)>';
  let profile = {
    status: 'completed', profileUrl: 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c',
    directory: '/fixture/下载', intervalSeconds: 10, jitterSeconds: 3,
    discovered: 135, completed: 134, skipped: 0, failed: 1, discoveryComplete: true,
    items: Array.from({ length: 135 }, (_, index) => ({
      id: (index + 1).toString(16).padStart(24, '0'), sequence: index + 1,
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
  let resolveFeedback;
  let feedbackMode = 'pending';
  let exportMode = 'cancel';
  const rendererErrors = [];
  let downloadMode = 'pending';
  let resolveDownload;
  let resolveDirectory;
  let win;
  const publishProfile = value => { profile = value; win.webContents.send('ui-fixture:profile', value); return value; };
  const publishAccount = value => { account = value; win.webContents.send('ui-fixture:account', value); return value; };
  const publishUpdate = value => { update = value; win.webContents.send('ui-fixture:update', value); return value; };
  const available = () => ({
    status: 'available', currentVersion: '1.6.0', latestVersion: '1.6.1',
    releaseNotes: '测试更新说明 <img src=x onerror=alert(1)>\n改进任务恢复。',
    installationHint: 'Mac：确认后覆盖当前应用并重新启动，保留账号和任务记录。',
    download: { receivedBytes: 0, totalBytes: 0 }, error: null, canRetry: true
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
    if (method === 'getLoginState') return { status: 'unknown', loggedIn: false, nickname: '' };
    if (method === 'getProfileState') return profile;
    if (method === 'getUpdateState') return update;
    if (method === 'chooseDirectory') return new Promise(resolve => { resolveDirectory = resolve; });
    if (method === 'retryItem') return publishProfile({
      ...profile, status: 'downloading', failed: 0,
      items: profile.items.map(item => item.id === value ? { ...item, status: 'downloading', error: '' } : item)
    });
    if (method === 'checkForUpdates') return publishUpdate(available());
    if (method === 'downloadUpdate') {
      if (downloadMode === 'downloaded') return publishUpdate({ ...available(), status: 'downloaded' });
      publishUpdate({ ...available(), status: 'downloading', download: { receivedBytes: 512, totalBytes: 1024 } });
      return new Promise(resolve => { resolveDownload = resolve; });
    }
    if (method === 'cancelUpdateDownload') {
      const state = publishUpdate(available());
      resolveDownload?.(state);
      resolveDownload = null;
      return state;
    }
    if (method === 'installUpdate') return publishUpdate({ ...available(), status: 'downloaded' });
    return profile;
  });
  win = new BrowserWindow({ show: false, width: 1180, height: 980, webPreferences: {
    preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true
  } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  const check = async (expression, description) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`UI check failed: ${description}; renderer: ${JSON.stringify(rendererErrors)}; body: ${await evaluate("document.body.innerText.slice(0, 400)")}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const paint = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const captureFrame = async () => {
    // Chromium may still be rasterizing an earlier frame after DOM assertions.
    // Let the offscreen compositor publish the changed layout before capture.
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 350));
    return (await win.webContents.capturePage()).toPNG();
  };
  await win.loadURL('xhs-app://local/');
  await check(`document.querySelector('#profile-items').children.length === 100`, 'initial list rendered');
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
  await click('#profile-items button[data-retry-id]');
  await check(`document.querySelector('#profile-status').textContent === '正在下载'`, 'single retry enters active queue');
  assert.deepEqual(calls.find(call => call.method === 'retryItem'), { method: 'retryItem', value: failedId });
  publishProfile({ ...profile, status: 'waiting', failed: 1, nextRequestAt: Date.now() + 10000,
    items: profile.items.map(item => item.id === failedId ? { ...item, status: 'failed', error: '测试请求失败' } : item) });
  await check(`document.querySelector('#profile-items button[data-retry-id]')?.disabled === true`, 'retry disabled during active queue');
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
  // A main-process background check announces a new version once, without
  // initiating another request from this renderer or interrupting work.
  publishUpdate(available());
  await check(`!document.querySelector('#desktop-update-announcement').hidden && !document.querySelector('#desktop-update-badge').hidden`, 'automatic update notice');
  await click('#desktop-announcement-dismiss');
  publishUpdate(available());
  await check(`document.querySelector('#desktop-update-announcement').hidden`, 'dismissed version is not repeatedly announced');
  await click('#about-tab');
  assert.equal(await evaluate(`document.body.dataset.desktopPage`), 'about');
  await click('#desktop-check-updates');
  await check(`!document.querySelector('#desktop-update-download').hidden && !document.querySelector('#desktop-update-download').disabled`, 'update available');
  assert.match(await evaluate(`document.querySelector('#desktop-update-title').textContent`), /1\.6\.1/);
  assert.equal(await evaluate(`document.querySelector('#desktop-update-notes').querySelectorAll('img').length`), 0, 'release notes render as text');
  assert.equal(calls.filter(call => call.method === 'installUpdate').length, 0, 'no automatic installation');
  await click('#desktop-update-download');
  await check(`!document.querySelector('#desktop-update-cancel').hidden && !document.querySelector('#desktop-update-cancel').disabled`, 'cancel works during pending download IPC');
  assert.equal(await evaluate(`document.querySelector('#desktop-update-progress').value`), 50);
  assert.match(await evaluate(`document.querySelector('#desktop-update-progress-text').textContent`), /50%/);
  await paint();
  const screenshot = path.join(temporary, 'desktop-ui.png');
  writeFileSync(screenshot, await captureFrame());
  await click('#desktop-update-cancel');
  await check(`!document.querySelector('#desktop-update-download').hidden && !document.querySelector('#desktop-update-download').disabled`, 'cancel returns to available');
  assert.equal(calls.filter(call => call.method === 'cancelUpdateDownload').length, 1);
  publishUpdate({ ...available(), status: 'error', error: { phase: 'download', message: '测试下载失败' } });
  await check(`document.querySelector('#desktop-update-download').textContent === '重试下载'`, 'download error retry');
  downloadMode = 'downloaded';
  await click('#desktop-update-download');
  await check(`!document.querySelector('#desktop-update-install').hidden && !document.querySelector('#desktop-update-install').disabled`, 'ready to install');
  assert.match(await evaluate(`document.querySelector('#desktop-update-installation-hint').textContent`), /覆盖当前应用/);
  await click('#desktop-update-install');
  await check(`!document.querySelector('#desktop-update-install').disabled`, 'cancelled main-process confirmation remains retryable');
  assert.equal(calls.filter(call => call.method === 'installUpdate').length, 1);
  publishUpdate({ ...available(), status: 'error', error: { phase: 'install', message: '测试安装失败' } });
  await check(`document.querySelector('#desktop-update-install').textContent === '重试安装'`, 'installation error retry');
  publishUpdate({ ...available(), status: 'error', error: { phase: 'check', message: '测试检查失败' } });
  await check(`!document.querySelector('#desktop-update-retry').hidden`, 'check error retry');
  await click('#desktop-update-retry');
  await check(`!document.querySelector('#desktop-update-download').hidden`, 'check retry result');
  assert.equal(calls.filter(call => call.method === 'checkForUpdates').length, 2);
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
  publishAccount({ configured: true, authenticated: true, verified: true, status: 'authenticated', account: { user: { email: 'ordinary@example.com' }, membership: { type: 'none', active: false }, device: { status: 'authorized' } } });
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
  if (process.argv.includes('--classic-scrollbars')) {
    // Reproduce a CI desktop with scrollbars that consume layout width, even on
    // a development Mac configured to use overlay scrollbars.
    await win.webContents.insertCSS('.desktop-page { overflow-y: scroll !important; } .desktop-page::-webkit-scrollbar { width: 16px; }');
  }
  win.setContentSize(390, 844);
  // clientWidth excludes a classic vertical scrollbar; innerWidth describes
  // the requested viewport consistently on macOS and Windows.
  await check(`window.innerWidth === 390`, 'narrow viewport');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'no horizontal overflow');
  for (const tab of ['#profile-tab', '#single-note-tab', '#account-tab', '#feedback-tab', '#about-tab']) {
    await click(tab);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, `${tab} has no narrow horizontal overflow`);
    assert.equal(await evaluate(`document.documentElement.scrollHeight <= window.innerHeight`), true, `${tab} preserves viewport height`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('main > .desktop-page')).filter(page => !page.hidden).length`), 1, `${tab} is a distinct page`);
    assert.equal(await evaluate(`document.querySelector('.desktop-page:not([hidden])').scrollWidth <= document.querySelector('.desktop-page:not([hidden])').clientWidth`), true, `${tab} content fits beside scrollbars`);
  }
  const narrowViewport = await evaluate(`({ innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })`);
  await paint();
  const narrowScreenshot = path.join(temporary, 'desktop-ui-narrow.png');
  writeFileSync(narrowScreenshot, await captureFrame());
  const web = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await web.loadURL('xhs-app://local/');
  assert.equal(await web.webContents.executeJavaScript(`document.querySelector('#desktop-navigation').hidden && document.querySelector('#desktop-update-panel').hidden && !document.querySelector('#single-note-panel').hidden`), true, 'web interface remains unchanged without bridge');
  assert.deepEqual(rendererErrors, [], 'no renderer console errors');
  web.destroy();
  win.destroy();
  console.log(JSON.stringify({ smoke: 'passed', checks: ['failure beyond 100 visible', 'failure filter and single retry', 'active queue retry guard', 'no automatic update requests', 'update progress and cancellation', 'phase-aware retries', 'manual install only', 'safe text rendering', 'Mac and Windows installation hints', '390px all-page layout', 'five independent pages', 'feedback login gate and ordinary member', 'diagnostics copy/export', 'feedback progress and failure', 'automatic update notice deduplication', 'native notification navigation', 'web-only regression'], narrowViewport, screenshot, narrowScreenshot, pageScreenshots }));
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => {
  console.error('DESKTOP_UI_SMOKE_FAILED', error);
  clearTimeout(timeout);
  app.exit(1);
});
