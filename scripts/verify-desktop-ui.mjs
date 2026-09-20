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
const timeout = setTimeout(() => { console.error('DESKTOP_UI_SMOKE_TIMEOUT'); app.exit(1); }, 35000);

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
  let update = { status: 'idle', currentVersion: '1.6.0' };
  let downloadMode = 'pending';
  let resolveDownload;
  let resolveDirectory;
  let win;
  const publishProfile = value => { profile = value; win.webContents.send('ui-fixture:profile', value); return value; };
  const publishUpdate = value => { update = value; win.webContents.send('ui-fixture:update', value); return value; };
  const available = () => ({
    status: 'available', currentVersion: '1.6.0', latestVersion: '1.6.1',
    releaseNotes: '测试更新说明 <img src=x onerror=alert(1)>\n改进任务恢复。',
    installationHint: 'Mac：将应用拖入 Applications 文件夹并替换旧版本。',
    download: { receivedBytes: 0, totalBytes: 0 }, error: null, canRetry: true
  });
  ipcMain.handle('ui-fixture:invoke', (_event, method, value) => {
    calls.push({ method, value });
    if (method === 'getInfo') return { version: '1.6.0', platform: 'darwin', arch: 'arm64', pythonAvailable: true };
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
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  const check = async (expression, description) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`UI check failed: ${description}`);
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
  assert.equal(await evaluate(`document.querySelector('#desktop-update-panel').hidden`), true);
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
  assert.match(await evaluate(`document.querySelector('#desktop-update-installation-hint').textContent`), /Applications/);
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
  win.setContentSize(390, 844);
  await check(`document.documentElement.clientWidth === 390`, 'narrow viewport');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'no horizontal overflow');
  await paint();
  const narrowScreenshot = path.join(temporary, 'desktop-ui-narrow.png');
  writeFileSync(narrowScreenshot, await captureFrame());
  const web = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await web.loadURL('xhs-app://local/');
  assert.equal(await web.webContents.executeJavaScript(`document.querySelector('#desktop-navigation').hidden && document.querySelector('#desktop-update-panel').hidden && !document.querySelector('#single-note-panel').hidden`), true, 'web interface remains unchanged without bridge');
  web.destroy();
  win.destroy();
  console.log(JSON.stringify({ smoke: 'passed', checks: ['failure beyond 100 visible', 'failure filter and single retry', 'active queue retry guard', 'no automatic update requests', 'update progress and cancellation', 'phase-aware retries', 'manual install only', 'safe text rendering', 'Mac and Windows installation hints', '390px layout', 'web-only regression'], screenshot, narrowScreenshot }));
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => {
  console.error('DESKTOP_UI_SMOKE_FAILED', error);
  clearTimeout(timeout);
  app.exit(1);
});
