import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import release from './release.json' with { type: 'json' };
import { confirmMacUpdateStartup } from '../mac-update-cleanup.js';

const downloadPage = 'https://tools.brclio.com/#downloads';
let window;

async function acknowledgeLegacyMacUpgrade() {
  // app.name/productName must retain the old value so this resolves to the
  // v2.0.36 cache. Its installer rolls back if this process exits before ACK.
  const options = { cacheDirectory: path.join(app.getPath('userData'), 'updates'),
    currentAppPath: path.resolve(process.execPath, '../../..'), currentVersion: app.getVersion() };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await confirmMacUpdateStartup(options);
    const busy = result.retained.some(item => item.code === 'MAC_UPDATE_LOCK_BUSY');
    if (busy && attempt < 2) {
      await delay(1000);
      continue;
    }
    if (result.retained.some(item => item.resultPath === result.resultPath)) {
      throw new Error('旧下载器的安装确认尚未完成，请稍后再试。');
    }
    return;
  }
}

async function migrate() {
  const asset = release.assets[`${process.platform}-${process.arch}`];
  if (!app.isPackaged || !asset) throw new Error('请下载适合当前系统的 Brclio 正式安装包。');
  const options = { installer: path.join(process.resourcesPath, 'migration', asset.name),
    asset, version: release.version, arch: process.arch };
  if (process.platform === 'darwin') {
    await acknowledgeLegacyMacUpgrade();
    const { migrateMac } = await import('./mac.js');
    await migrateMac(options);
  } else {
    const { migrateWindows } = await import('./windows.js');
    await migrateWindows(options);
  }
}

async function startMigration() {
  window = new BrowserWindow({ title: '迁移到 Brclio', width: 460, height: 230, show: false,
    resizable: false, minimizable: true, maximizable: false, autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(fileURLToPath(new URL('./progress.html', import.meta.url)));
  window.show();
  // Keep this process alive until the previous installer's startup handshake
  // and the current atomic install complete, even if the window is closed.
  for (;;) {
    try {
      await migrate();
      return;
    } catch (error) {
      const options = { type: 'warning', title: 'Brclio 安装', message: '暂时无法打开 Brclio',
        detail: error.message, buttons: ['重试', '从官网下载', '稍后再试'], defaultId: 0, cancelId: 2 };
      const { response } = window.isDestroyed() ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options);
      if (response === 0) continue;
      if (response === 1) await shell.openExternal(downloadPage);
      return;
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('window-all-closed', () => {});
  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) { window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(startMigration).catch(error => {
    dialog.showErrorBox('无法启动 Brclio 迁移程序', error.message);
  }).finally(() => app.quit());
}
