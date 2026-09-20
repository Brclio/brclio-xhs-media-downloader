const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xhsDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  cancelUpdateDownload: () => ipcRenderer.invoke('desktop:cancel-update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:update-state', listener);
    return () => ipcRenderer.removeListener('desktop:update-state', listener);
  },
  chooseDirectory: () => ipcRenderer.invoke('desktop:choose-directory'),
  openLogin: (profileUrl) => ipcRenderer.invoke('desktop:open-login', profileUrl),
  getLoginState: () => ipcRenderer.invoke('desktop:get-login-state'),
  onLoginUpdate: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:login-update', listener);
    return () => ipcRenderer.removeListener('desktop:login-update', listener);
  },
  startProfile: (options) => ipcRenderer.invoke('desktop:start-profile', options),
  pauseProfile: () => ipcRenderer.invoke('desktop:pause-profile'),
  resumeProfile: () => ipcRenderer.invoke('desktop:resume-profile'),
  cancelProfile: () => ipcRenderer.invoke('desktop:cancel-profile'),
  retryFailed: () => ipcRenderer.invoke('desktop:retry-failed'),
  retryItem: (noteId) => ipcRenderer.invoke('desktop:retry-item', noteId),
  getProfileState: () => ipcRenderer.invoke('desktop:get-profile-state'),
  openDirectory: () => ipcRenderer.invoke('desktop:open-directory'),
  onProfileUpdate: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:profile-update', listener);
    return () => ipcRenderer.removeListener('desktop:profile-update', listener);
  }
}));
