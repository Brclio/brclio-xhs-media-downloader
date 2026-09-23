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
  getLoginState: () => invoke('getLoginState'),
  getUpdateState: () => invoke('getUpdateState'),
  getUpdateHistory: () => invoke('getUpdateHistory'),
  dismissUpdateHistory: id => invoke('dismissUpdateHistory', id),
  onUpdateHistory: callback => subscribe('ui-fixture:update-history', callback),
  checkForUpdates: () => invoke('checkForUpdates'),
  downloadUpdate: () => invoke('downloadUpdate'),
  cancelUpdateDownload: () => invoke('cancelUpdateDownload'),
  installUpdate: () => invoke('installUpdate'),
  onInstallConfirmation: callback => subscribe('ui-fixture:install-confirmation', callback),
  respondInstallConfirmation: (id, confirmed) => invoke('respondInstallConfirmation', { id, confirmed }),
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
  const readyEvents = new Map();
  const failedInitializationWindows = new Set();
  ipcMain.on('ui-fixture:desktop-ready', event => readyEvents.set(event.sender.id, (readyEvents.get(event.sender.id) || 0) + 1));
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
  let resolveDirectory;
  let win;
  const publishProfile = value => { profile = value; win.webContents.send('ui-fixture:profile', value); return value; };
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
    if (method === 'getLoginState') return { status: 'unknown', loggedIn: false, nickname: '' };
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
    return profile;
  });
  win = new BrowserWindow({ show: false, width: 1180, height: 980, webPreferences: {
    preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true
  } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  const evaluate = (expression, userGesture = false) => win.webContents.executeJavaScript(expression, userGesture);
  const check = async (expression, description) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const focus = await evaluate(`(() => {
      const button = document.querySelector('#desktop-update-install');
      return { active: document.activeElement?.id || document.activeElement?.tagName,
        buttonHidden: button?.hidden, buttonDisabled: button?.disabled,
        buttonRects: button?.getClientRects().length,
        confirmationOpen: document.querySelector('#desktop-install-confirmation')?.open,
        installCancelEvent: window.fixtureCancelEvent,
        updateDialogOpen: document.querySelector('#desktop-update-dialog')?.open };
    })()`);
    throw new Error(`UI check failed: ${description}; focus: ${JSON.stringify(focus)}; renderer: ${JSON.stringify(rendererErrors)}; body: ${await evaluate("document.body.innerText.slice(0, 400)")}`);
  };
  // Give scripted clicks the user activation a real click supplies. Otherwise
  // repeated showModal/Escape cycles exhaust Chromium's CloseWatcher allowance:
  // cancel becomes non-cancelable and the browser bypasses dialog.close itself.
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
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
  await check(`document.body.dataset.desktopReady === 'true'`, 'desktop readiness follows successful info and profile initialization');
  assert.equal(readyEvents.get(win.webContents.id), 1, 'successful initialization emits exactly one desktop-ready event');
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
  assert.equal(await evaluate(installDialogFits), true, 'installation summary and actions fit on desktop');
  const installDialogScreenshot = path.join(temporary, 'desktop-install-confirmation.png');
  writeFileSync(installDialogScreenshot, await captureFrame());
  win.setSize(390, 760);
  await check(`innerWidth === 390`, 'installation dialog narrow viewport');
  await paint();
  assert.equal(await evaluate(installDialogFits), true, 'installation dialog fits at 390px');
  const installDialogNarrowScreenshot = path.join(temporary, 'desktop-install-confirmation-narrow.png');
  writeFileSync(installDialogNarrowScreenshot, await captureFrame());
  await click('#desktop-install-details summary');
  win.setSize(390, 480);
  await paint();
  assert.equal(await evaluate(installDialogFits), true, 'expanded platform details scroll without hiding approval actions on short screens');
  win.setSize(1180, 980);
  await paint();
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
  win.setContentSize(1180, 980);
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
  win.setContentSize(390, 844);
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
  console.log(JSON.stringify({ smoke: 'passed', checks: ['failure beyond 100 visible', 'failure filter and single retry', 'active queue retry guard', 'no automatic update requests', 'update progress and pause', 'retained download progress and continuation', 'known release remains downloadable after failed recheck with and without partial bytes', 'recheck notice clears after download or successful check', 'download retry without retained bytes', 'phase-aware retries', 'manual install only', 'broker-backed installation approval, cancellation and expiry', 'installation dialog desktop and 390px layout', 'desktop-ready emitted only after successful initialization', 'safe text rendering', 'release update-section selection and empty-section fallback', 'Mac and Windows installation hints', '390px all-page layout', 'five independent pages', 'feedback login gate and ordinary member', 'diagnostics copy/export', 'feedback progress and failure', 'automatic update notice deduplication', 'version dialog focus and dismissal', 'dialog progress and background download', 'scrollable notes with fixed footer at 390px', 'native notification navigation', 'nonmodal history during a 46 percent download', 'history read and acknowledgement race guards', 'history acknowledgement errors and reload', 'history text safety and 390px layout', 'web-only regression'], narrowViewport, screenshot, narrowScreenshot, updateDialogScreenshot, updateDialogNarrowScreenshot, installDialogScreenshot, installDialogNarrowScreenshot, checkFailureScreenshots, pageScreenshots, historyScreenshot, historyNarrowScreenshot, installationCloseOrders }));
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => {
  console.error('DESKTOP_UI_SMOKE_FAILED', error);
  clearTimeout(timeout);
  app.exit(1);
});
