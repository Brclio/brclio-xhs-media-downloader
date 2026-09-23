const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xhsDesktop', Object.freeze({
  getDiagnosticsInfo: () => ipcRenderer.invoke('desktop:diagnostics-info'),
  copyDiagnostics: () => ipcRenderer.invoke('desktop:copy-diagnostics'),
  exportDiagnostics: () => ipcRenderer.invoke('desktop:export-diagnostics'),
  submitFeedback: (input) => ipcRenderer.invoke('desktop:submit-feedback', input),
  getFeedbackState: () => ipcRenderer.invoke('desktop:feedback-state'),
  recordDiagnostic: (event, fields) => ipcRenderer.invoke('desktop:record-diagnostic', event, fields),
  onNavigate: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state); ipcRenderer.on('desktop:navigate', listener);
    return () => ipcRenderer.removeListener('desktop:navigate', listener);
  },
  onFeedbackState: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state); ipcRenderer.on('desktop:feedback-state', listener);
    return () => ipcRenderer.removeListener('desktop:feedback-state', listener);
  },
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  getAccountState: () => ipcRenderer.invoke('desktop:account-state'),
  refreshAccount: () => ipcRenderer.invoke('desktop:account-refresh'),
  sendAccountCode: (email) => ipcRenderer.invoke('desktop:account-send-code', email),
  verifyAccountCode: (email, code) => ipcRenderer.invoke('desktop:account-verify-code', email, code),
  redeemAccountCode: (code) => ipcRenderer.invoke('desktop:account-redeem', code),
  logoutAccount: () => ipcRenderer.invoke('desktop:account-logout'),
  onAccountUpdate: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:account-update', listener);
    return () => ipcRenderer.removeListener('desktop:account-update', listener);
  },
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  getUpdateHistory: () => ipcRenderer.invoke('desktop:get-update-history'),
  dismissUpdateHistory: (id) => ipcRenderer.invoke('desktop:dismiss-update-history', id),
  onUpdateHistory: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, notice) => callback(notice);
    ipcRenderer.on('desktop:update-history', listener);
    return () => ipcRenderer.removeListener('desktop:update-history', listener);
  },
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  cancelUpdateDownload: () => ipcRenderer.invoke('desktop:cancel-update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  respondInstallConfirmation: (id, confirmed) => ipcRenderer.invoke('desktop:respond-install-confirmation', id, confirmed),
  onInstallConfirmation: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:install-confirmation', listener);
    return () => ipcRenderer.removeListener('desktop:install-confirmation', listener);
  },
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
