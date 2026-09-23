import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell } from 'electron';
import { access, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { APP_URL, createProtocolHandler, isAppUrl } from './protocol.js';
import { PythonBackend } from './python-backend.js';
import { XhsBrowser } from './profile-browser.js';
import { ProfileManager } from './profile-manager.js';
import { UpdateManager, createElectronUpdateFetch } from './update-manager.js';
import { SecureAccountStore } from './account-storage.js';
import { AccountClient } from './account-client.js';
import { DiagnosticLog } from './diagnostic-log.js';
import { FeedbackClient } from './feedback-client.js';
import { prepareMacUpdate } from './mac-update.js';
import { launchWindowsUpdate } from './windows-update.js';
import { InstallConfirmation } from './install-confirmation.js';
import { confirmMacUpdateStartup } from './mac-update-cleanup.js';

const APP_NAME = 'Brclio 小红书下载器';
// Keep package.productName / app.name stable: Electron uses it for the data
// directory and macOS Keychain cookie key. build.productName and UI use APP_NAME.
// Do not call app.setName(APP_NAME), which would strand existing login sessions.

protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true
} }]);

let mainWindow;
let browser;
let manager;
let pythonBackend;
let updateManager;
let updateCheckTimer;
let updatePeriodicTimer;
let accountClient;
let diagnostics;
let feedbackClient;
let accountRefreshTimer;
let quitting = false;
let shutdownComplete = false;
const installConfirmation = new InstallConfirmation();
const selectedDirectories = new Set();
const diagnostic = (event, details, level = 'info') => { void diagnostics?.record(event, details, level); };
const appInfo = () => ({ name: APP_NAME, version: app.getVersion(), platform: process.platform, arch: process.arch,
  osRelease: os.release(), portable: process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_DIR), pythonAvailable: pythonBackend?.available === true });
const diagnosticContext = () => ({ application: appInfo(), task: (() => {
  const state = manager?.snapshot();
  return state ? { status: state.status, discovered: state.notes?.length || state.items?.length || 0, error: state.error,
    completed: state.completed, skipped: state.skipped, failed: state.failed,
    intervalSeconds: state.intervalSeconds, jitterSeconds: state.jitterSeconds } : null;
})() });

function sendUpdate(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:profile-update', state);
}

function trusted(event) {
  if (!mainWindow || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || !isAppUrl(event.senderFrame.url)) throw new Error('不受信任的应用请求。');
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    trusted(event);
    const trace = !/get-|account-state|diagnostics-info|record-diagnostic|feedback-state/.test(channel);
    const started = Date.now();
    if (trace) diagnostic('ipc.started', { channel });
    try {
      const result = await callback(...args);
      if (trace) diagnostic('ipc.completed', { channel, durationMs: Date.now() - started, ok: result?.ok !== false });
      return result;
    } catch (error) { diagnostic('ipc.failed', { channel, durationMs: Date.now() - started, error }, 'error'); throw error; }
  });
}

async function validateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请先选择保存文件夹。');
  const resolved = await realpath(directory);
  if (!(await stat(resolved)).isDirectory()) throw new Error('保存路径不是文件夹。');
  await access(resolved, constants.W_OK);
  return resolved;
}

async function approvedDirectory(directory) {
  const resolved = await validateDirectory(directory);
  if (!selectedDirectories.has(resolved)) throw new Error('请使用“选择文件夹”选择下载目录。');
  return resolved;
}

function external(url) {
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
      void shell.openExternal(parsed.href).catch(() => {});
    }
  } catch { /* Ignore invalid external links. */ }
}

function openLocalPreview(url) {
  const preview = new BrowserWindow({ parent: mainWindow, width: 720, height: 820,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  preview.removeMenu();
  preview.webContents.setWindowOpenHandler(({ url: target }) => { external(target); return { action: 'deny' }; });
  preview.webContents.on('will-navigate', (event, target) => {
    if (!isAppUrl(target)) { event.preventDefault(); external(target); }
  });
  void preview.loadURL(url).catch(() => preview.close());
}

function registerIpc() {
  const accountAction = (callback) => async (...args) => {
    try { return { ok: true, result: await callback(...args), state: accountClient.snapshot() }; }
    catch (error) { return { ok: false, error: { code: error.code || 'SERVICE_UNAVAILABLE', message: error.message }, state: accountClient.snapshot() }; }
  };
  handle('desktop:account-state', () => accountClient.snapshot());
  handle('desktop:account-refresh', accountAction(async () => {
    // Only an explicit user action retries denied Keychain access. Background
    // entitlement checks must never keep reopening the system password dialog.
    if (!accountClient.credentials) await accountClient.initialize();
    return accountClient.refresh();
  }));
  handle('desktop:account-send-code', accountAction((email) => {
    if (typeof email !== 'string' || email.length > 254) throw new Error('请输入有效邮箱。');
    return accountClient.sendCode(email);
  }));
  handle('desktop:account-verify-code', accountAction((email, code) => {
    if (typeof email !== 'string' || email.length > 254 || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) throw new Error('请输入邮箱及六位验证码。');
    return accountClient.verifyCode(email, code);
  }));
  handle('desktop:account-redeem', accountAction((code) => {
    if (typeof code !== 'string' || !code.trim() || code.length > 256) throw new Error('请输入有效激活码。');
    return accountClient.redeem(code);
  }));
  handle('desktop:account-logout', accountAction(async () => {
    await manager.pause();
    return accountClient.logout();
  }));
  handle('desktop:get-info', appInfo);
  handle('desktop:diagnostics-info', async () => {
    const { text, ...info } = await diagnostics.snapshot(diagnosticContext()); return info;
  });
  handle('desktop:copy-diagnostics', async () => {
    const log = await diagnostics.snapshot(diagnosticContext()); clipboard.writeText(log.text);
    return { ok: true, bytes: log.totalBytes, message: '已复制当前完整诊断日志。' };
  });
  handle('desktop:export-diagnostics', async () => {
    const log = await diagnostics.snapshot(diagnosticContext());
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出完整诊断日志',
      defaultPath: path.join(app.getPath('downloads'), `Brclio-diagnostics-${new Date().toISOString().slice(0, 10)}.ndjson`),
      filters: [{ name: '诊断日志', extensions: ['ndjson', 'txt'] }] });
    if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
    await writeFile(result.filePath, log.text, { mode: 0o600 });
    return { ok: true, bytes: log.totalBytes, message: '诊断日志已导出。' };
  });
  handle('desktop:submit-feedback', input => feedbackClient.submit(input));
  handle('desktop:feedback-state', () => feedbackClient.snapshot());
  handle('desktop:record-diagnostic', (event, fields) => {
    if (typeof event !== 'string' || !/^(renderer|single|navigation)\.[a-z0-9_.-]{1,100}$/i.test(event)
      || Buffer.byteLength(JSON.stringify(fields || {})) > 24000) return false;
    diagnostic(event, fields); return true;
  });
  handle('desktop:get-update-state', () => updateManager.snapshot());
  handle('desktop:check-for-updates', () => updateManager.checkForUpdates());
  handle('desktop:download-update', () => updateManager.downloadUpdate());
  handle('desktop:cancel-update-download', () => updateManager.cancelUpdateDownload());
  handle('desktop:install-update', () => updateManager.installUpdate());
  handle('desktop:respond-install-confirmation', (id, confirmed) => installConfirmation.respond(id, confirmed));
  handle('desktop:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择小红书主页下载文件夹', properties: ['openDirectory', 'createDirectory'],
      defaultPath: manager.snapshot().directory || app.getPath('downloads')
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = await validateDirectory(result.filePaths[0]);
    selectedDirectories.add(directory);
    return directory;
  });
  handle('desktop:open-login', (url) => {
    if (url != null && typeof url !== 'string') throw new Error('主页地址无效。');
    return browser.openLogin(url || undefined);
  });
  handle('desktop:get-login-state', () => browser.getLoginState());
  handle('desktop:start-profile', async (options) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('下载参数无效。');
    const directory = await approvedDirectory(options.directory);
    return manager.start({ profileUrl: options.profileUrl, directory,
      intervalSeconds: options.intervalSeconds, jitterSeconds: options.jitterSeconds });
  });
  handle('desktop:pause-profile', () => manager.pause());
  handle('desktop:resume-profile', async () => {
    await approvedDirectory(manager.snapshot().directory);
    return manager.resume();
  });
  handle('desktop:cancel-profile', () => manager.cancel());
  handle('desktop:retry-failed', async () => {
    await approvedDirectory(manager.snapshot().directory);
    return manager.retryFailed();
  });
  handle('desktop:retry-item', async (noteId) => {
    if (typeof noteId !== 'string' || !/^[a-f\d]{24}$/i.test(noteId)) throw new Error('帖子编号无效。');
    await approvedDirectory(manager.snapshot().directory);
    return manager.retryItem(noteId);
  });
  handle('desktop:get-profile-state', () => manager.snapshot());
  handle('desktop:open-directory', async () => {
    const directory = await approvedDirectory(manager.snapshot().directory);
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return true;
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({ width: 1320, height: 940, minWidth: 760, minHeight: 600,
    title: APP_NAME, backgroundColor: '#f7f4ef', show: false,
    webPreferences: { preload: path.join(app.getAppPath(), 'desktop/preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) openLocalPreview(url); else external(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); external(url); }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    installConfirmation.cancel();
    diagnostic('renderer.process_gone', details, 'error');
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) installConfirmation.cancel();
  });
  mainWindow.webContents.on('unresponsive', () => diagnostic('renderer.unresponsive', {}, 'warn'));
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => diagnostic('renderer.load_failed', { code, description, url, isMainFrame }, 'error'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { installConfirmation.cancel(); mainWindow = null; if (!quitting) app.quit(); });
  await mainWindow.loadURL(`${APP_URL}/`);
}

async function boot() {
  diagnostics = new DiagnosticLog({ directory: path.join(app.getPath('userData'), 'diagnostics') });
  try { await diagnostics.initialize(); } catch (error) { diagnostics.lastError = error.code || 'LOG_INITIALIZE_FAILED'; }
  diagnostic('app.started', appInfo());
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [
        { label: `关于 ${APP_NAME}`, click: () => navigateDesktop('about') },
        { label: '检查更新…', click: () => { navigateDesktop('about'); void updateManager?.checkForUpdates(); } },
        { type: 'separator' }, { role: 'services', label: '服务' }, { type: 'separator' },
        { role: 'hide', label: `隐藏 ${APP_NAME}` },
        { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' },
        { type: 'separator' }, { role: 'quit', label: `退出 ${APP_NAME}` }
      ] },
      { role: 'editMenu', label: '编辑' }, { role: 'windowMenu', label: '窗口' }
    ]));
  }
  pythonBackend = new PythonBackend({ appDirectory: app.getAppPath(), resourcesDirectory: process.resourcesPath, packaged: app.isPackaged, onDiagnostic: diagnostic });
  await pythonBackend.initialize();
  diagnostic('python.initialized', { available: pythonBackend.available });
  if (app.isPackaged && !pythonBackend.available) {
    throw new Error('安装包内置的 Python 后台无法启动，请重新安装完整版本。');
  }
  const accountConfig = JSON.parse(await readFile(path.join(app.getAppPath(), 'desktop/account-config.json'), 'utf8'));
  accountClient = new AccountClient({
    store: new SecureAccountStore({ directory: path.join(app.getPath('userData'), 'account'), safeStorage }),
    endpoint: !app.isPackaged && process.env.XHS_ACCOUNT_ENDPOINT !== undefined ? process.env.XHS_ACCOUNT_ENDPOINT : accountConfig.endpoint,
    allowInsecureDevelopment: !app.isPackaged,
    onDiagnostic: diagnostic,
    onUpdate(state) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:account-update', state);
    }
  });
  protocol.handle('xhs-app', createProtocolHandler({ rootDirectory: app.getAppPath(), pythonBackend,
    onDiagnostic: diagnostic,
    authorize: feature => accountClient.authorize(feature) }));
  const permissions = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === mainWindow?.webContents && isAppUrl(details.requestingUrl || contents.getURL()) && permissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) =>
    contents === mainWindow?.webContents && isAppUrl(origin) && permissions.has(permission));
  browser = new XhsBrowser({ BrowserWindow, session, onDiagnostic: diagnostic, onLoginState(state) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:login-update', state);
  } });
  manager = new ProfileManager({ stateDirectory: path.join(app.getPath('userData'), 'profile-jobs'), browser, onUpdate: sendUpdate,
    onDiagnostic: diagnostic,
    authorize: feature => accountClient.authorize(feature) });
  await manager.initialize();
  diagnostic('task.restored', diagnosticContext().task);
  for (const item of manager.snapshot().items || []) {
    if (item.status === 'failed') diagnostic('note.restored_failure', { noteId: item.id, sequence: item.sequence, error: item.error }, 'warn');
  }
  if (manager.snapshot().directory) {
    try { selectedDirectories.add(await validateDirectory(manager.snapshot().directory)); }
    catch { /* A moved/unmounted drive must be selected again before downloading. */ }
  }
  updateManager = new UpdateManager({ currentVersion: app.getVersion(),
    directory: path.join(app.getPath('userData'), 'updates'),
    portable: process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    fetchImpl: createElectronUpdateFetch(net),
    onUpdate(state) {
      if (state.status !== lastUpdateStatus) { diagnostic('update.state', { status: state.status, latestVersion: state.latestVersion, error: state.error }); lastUpdateStatus = state.status; }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:update-state', state);
    },
    async confirmInstall(state) {
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return false;
      return installConfirmation.request({ ...state, portable: appInfo().portable }, payload => {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show(); mainWindow.focus();
        mainWindow.webContents.send('desktop:install-confirmation', payload);
      });
    },
    pauseDownloads: () => manager.pause(),
    async openInstaller(file, candidate) {
      if (process.platform === 'win32') {
        await launchWindowsUpdate(file);
        return '';
      }
      if (process.platform !== 'darwin') return shell.openPath(file);
      if (!app.isPackaged) throw Object.assign(new Error('开发环境不能覆盖安装，请使用完整客户端。'), { code: 'MAC_UPDATE_DEVELOPMENT' });
      const cacheDirectory = path.join(app.getPath('userData'), 'updates');
      const prepared = await prepareMacUpdate({ installerPath: file,
        currentAppPath: path.resolve(process.execPath, '../../..'), expectedVersion: candidate.version,
        expectedArch: process.arch, cacheDirectory, parentPid: process.pid });
      try {
        await writeFile(path.join(cacheDirectory, 'mac-last-install.json'), JSON.stringify({ resultPath: prepared.resultPath }), { mode: 0o600 });
        await prepared.launch();
        diagnostic('update.install_prepared', { version: candidate.version, mode: prepared.mode });
      } catch (error) { await prepared.dispose(); throw error; }
      return '';
    },
    onInstalled: () => { app.quit(); }
  });
  feedbackClient = new FeedbackClient({ accountClient, diagnostics, directory: path.join(app.getPath('userData'), 'feedback-pending'),
    appInfo: appInfo(), context: diagnosticContext, onUpdate(state) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:feedback-state', state);
    } });
  registerIpc();
  await createWindow();
  // Show the usable shell before asking the OS to unlock saved credentials.
  // A pending system permission is not a failed application startup: the
  // renderer, free downloads and navigation work while account actions wait.
  // Never make the update helper time out just because the user is away.
  void accountClient.initialize().then(() => {
    if (quitting) return;
    void accountClient.refresh().catch(() => {});
    accountRefreshTimer = setInterval(() => { void accountClient.refresh().catch(() => {}); }, 60_000);
    accountRefreshTimer.unref();
  }).catch(error => diagnostic('account.initialize_failed', { error }, 'warn'));
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
  if (process.platform === 'darwin' && app.isPackaged) {
    try {
      const rendererReady = mainWindow && !mainWindow.isDestroyed() && await mainWindow.webContents.executeJavaScript(
        `new Promise(resolve => {
          const ready = () => document.readyState === 'complete' && document.body.dataset.desktopReady === 'true';
          if (ready()) { resolve(true); return; }
          const done = value => { clearTimeout(timer); window.removeEventListener('xhs-desktop-ready', onReady); resolve(value); };
          const onReady = () => { if (ready()) done(true); };
          const timer = setTimeout(() => done(false), 10000);
          window.addEventListener('xhs-desktop-ready', onReady);
        })`);
      if (rendererReady && !quitting) {
        const result = await confirmMacUpdateStartup({ cacheDirectory: path.join(app.getPath('userData'), 'updates'),
          currentAppPath: path.resolve(process.execPath, '../../..'), currentVersion: app.getVersion() });
        if (result.status !== 'none') diagnostic('update.startup_confirmed', result, result.cleaned ? 'info' : 'warn');
      }
    } catch (error) { diagnostic('update.backup_cleanup_failed', { error }, 'warn'); }
  }
  await reportPreviousMacUpdate();
  if (app.isPackaged) {
    updateCheckTimer = setTimeout(automaticUpdateCheck, 5000);
    updateCheckTimer.unref();
    updatePeriodicTimer = setInterval(automaticUpdateCheck, 4 * 60 * 60 * 1000);
    updatePeriodicTimer.unref();
    mainWindow.on('focus', () => { if (Date.now() - lastAutomaticCheck > 60 * 60 * 1000) automaticUpdateCheck(); });
  }
}

let lastUpdateStatus;
let lastAutomaticCheck = 0;
async function reportPreviousMacUpdate() {
  if (process.platform !== 'darwin') return;
  const directory = path.join(app.getPath('userData'), 'updates');
  const pointer = path.join(directory, 'mac-last-install.json');
  try {
    const { resultPath } = JSON.parse(await readFile(pointer, 'utf8'));
    if (typeof resultPath !== 'string' || !path.resolve(resultPath).startsWith(`${directory}${path.sep}`)
      || path.basename(resultPath) !== 'install-result.json' || (await stat(resultPath)).size > 16000) return;
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    diagnostic('update.install_result', result, result.status === 'installed' ? 'info' : 'warn');
    if (!['preparing', 'opening', 'verifying', 'copying', 'checking', 'prepared', 'ready', 'waiting', 'validating', 'replacing', 'launching', 'awaiting_startup', 'rolling_back', 'cleanup_pending', 'cleaning'].includes(result.status)) {
      await rm(pointer, { force: true });
      if (result.status !== 'installed') await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: '上次更新未完成', message: result.message || '请重新检查更新或手动安装。',
        detail: `更新结果与备份信息保存在：${resultPath}`, buttons: ['知道了']
      });
    }
  } catch (error) { if (error.code !== 'ENOENT') diagnostic('update.result_unavailable', { code: error.code }, 'warn'); }
}
function automaticUpdateCheck() {
  if (!updateManager || ['checking', 'downloading', 'downloaded', 'installing'].includes(updateManager.snapshot().status)) return;
  lastAutomaticCheck = Date.now(); void updateManager.checkForUpdates();
}
function navigateDesktop(page) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('desktop:navigate', { page });
}
process.on('uncaughtExceptionMonitor', error => diagnostic('app.uncaught_exception', { error }, 'error'));
app.on('child-process-gone', (_event, details) => diagnostic('app.child_process_gone', details, 'error'));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    installConfirmation.cancel();
    clearTimeout(updateCheckTimer);
    clearInterval(updatePeriodicTimer);
    clearInterval(accountRefreshTimer);
    void (async () => {
      try { await feedbackClient?.shutdown(); await updateManager?.shutdown(); await manager?.shutdown(); }
      catch { dialog.showErrorBox('保存任务失败', '本次下载进度未能完整保存，请检查磁盘剩余空间和文件夹权限。'); }
      finally {
        browser?.close();
        pythonBackend?.close();
        await diagnostics?.record('app.stopped', {}); await diagnostics?.flush();
        shutdownComplete = true;
        app.quit();
      }
    })();
  });
  app.whenReady().then(boot).catch((error) => {
    diagnostic('app.start_failed', { error }, 'error');
    dialog.showErrorBox(`无法启动 ${APP_NAME}`, error.message);
    app.quit();
  });
}
