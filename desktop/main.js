import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { APP_URL, createProtocolHandler, isAppUrl } from './protocol.js';
import { PythonBackend } from './python-backend.js';
import { XhsBrowser } from './profile-browser.js';
import { ProfileManager } from './profile-manager.js';
import { UpdateManager, createElectronUpdateFetch } from './update-manager.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true
} }]);

let mainWindow;
let browser;
let manager;
let pythonBackend;
let updateManager;
let updateCheckTimer;
let quitting = false;
let shutdownComplete = false;
const selectedDirectories = new Set();

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
  ipcMain.handle(channel, async (event, ...args) => { trusted(event); return callback(...args); });
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
  handle('desktop:get-info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch,
    portable: process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_DIR), pythonAvailable: pythonBackend.available }));
  handle('desktop:get-update-state', () => updateManager.snapshot());
  handle('desktop:check-for-updates', () => updateManager.checkForUpdates());
  handle('desktop:download-update', () => updateManager.downloadUpdate());
  handle('desktop:cancel-update-download', () => updateManager.cancelUpdateDownload());
  handle('desktop:install-update', () => updateManager.installUpdate());
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
    title: '小红书媒体下载器', backgroundColor: '#f7f4ef', show: false,
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; if (!quitting) app.quit(); });
  await mainWindow.loadURL(`${APP_URL}/`);
}

async function boot() {
  pythonBackend = new PythonBackend({ appDirectory: app.getAppPath(), resourcesDirectory: process.resourcesPath, packaged: app.isPackaged });
  await pythonBackend.initialize();
  if (app.isPackaged && !pythonBackend.available) {
    throw new Error('安装包内置的 Python 后台无法启动，请重新安装完整版本。');
  }
  protocol.handle('xhs-app', createProtocolHandler({ rootDirectory: app.getAppPath(), pythonBackend }));
  const permissions = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === mainWindow?.webContents && isAppUrl(details.requestingUrl || contents.getURL()) && permissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) =>
    contents === mainWindow?.webContents && isAppUrl(origin) && permissions.has(permission));
  browser = new XhsBrowser({ BrowserWindow, session, onLoginState(state) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:login-update', state);
  } });
  manager = new ProfileManager({ stateDirectory: path.join(app.getPath('userData'), 'profile-jobs'), browser, onUpdate: sendUpdate });
  await manager.initialize();
  if (manager.snapshot().directory) {
    try { selectedDirectories.add(await validateDirectory(manager.snapshot().directory)); }
    catch { /* A moved/unmounted drive must be selected again before downloading. */ }
  }
  updateManager = new UpdateManager({ currentVersion: app.getVersion(),
    directory: path.join(app.getPath('userData'), 'updates'),
    portable: process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    fetchImpl: createElectronUpdateFetch(net),
    onUpdate(state) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:update-state', state);
    },
    async confirmInstall(state) {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: '安装更新', message: `准备安装 ${state.latestVersion}，是否继续？`,
        detail: state.installationHint,
        buttons: ['取消', '暂停任务并打开安装包'], defaultId: 0, cancelId: 0, noLink: true
      });
      return result.response === 1;
    },
    pauseDownloads: () => manager.pause(),
    openInstaller: file => shell.openPath(file),
    onInstalled: () => { app.quit(); }
  });
  registerIpc();
  await createWindow();
  if (app.isPackaged) {
    updateCheckTimer = setTimeout(() => { void updateManager.checkForUpdates(); }, 5000);
    updateCheckTimer.unref();
  }
}

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
    clearTimeout(updateCheckTimer);
    void (async () => {
      try { await updateManager?.shutdown(); await manager?.shutdown(); }
      catch { dialog.showErrorBox('保存任务失败', '本次下载进度未能完整保存，请检查磁盘剩余空间和文件夹权限。'); }
      finally {
        browser?.close();
        pythonBackend?.close();
        shutdownComplete = true;
        app.quit();
      }
    })();
  });
  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox('无法启动小红书下载器', error.message);
    app.quit();
  });
}
