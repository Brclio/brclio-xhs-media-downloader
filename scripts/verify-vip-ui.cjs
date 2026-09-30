// Exercise real Chromium and the desktop workspace using disposable data only.
// Run after npm run build:web: npx electron scripts/verify-vip-ui.cjs
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-vip-ui-'));
const screenshots = path.join(temporary, 'screenshots');
const widths = [390, 600, 701, 720, 760, 900, 1440];
fs.mkdirSync(screenshots);
app.setPath('userData', path.join(temporary, 'profile'));
app.commandLine.appendSwitch('force-prefers-reduced-motion');
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

let win;
let server;
let finished = false;
const checks = [];
const timeout = setTimeout(() => finish(1, new Error('VIP_UI_TIMEOUT')), 90_000);
async function finish(code, error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) { console.error(error); console.error(`Screenshots: ${screenshots}`); }
  if (win && !win.isDestroyed()) win.destroy();
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  app.exit(code);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, label, milliseconds = 5000) {
  const started = Date.now();
  while (!(await test())) {
    if (Date.now() - started > milliseconds) throw new Error(`Timed out: ${label}`);
    await pause(30);
  }
}

const anonymous = { configured: true, authenticated: false, verified: false, status: 'anonymous', account: null };
let account = anonymous;
const calls = [];
const preload = path.join(temporary, 'fixture-preload.cjs');
fs.writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron');
const invoke = method => ipcRenderer.invoke('vip-fixture:invoke', method);
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('xhsDesktop', {
  getInfo: () => invoke('getInfo'), getAccountState: () => invoke('getAccountState'),
  getProfileState: () => invoke('getProfileState'), getLoginState: () => invoke('getLoginState'),
  getUpdateState: () => invoke('getUpdateState'), getUpdateHistory: () => invoke('getUpdateHistory'),
  recordDiagnostic: () => invoke('recordDiagnostic'),
  onProfileUpdate: callback => subscribe('vip-fixture:profile', callback),
  onAccountUpdate: callback => subscribe('vip-fixture:account', callback),
  onNavigate: callback => subscribe('vip-fixture:navigate', callback),
});
`);

app.whenReady().then(async () => {
  assert.ok(fs.existsSync(path.join(root, 'dist-web/vip.html')), 'Run npm run build:web before this check');
  const { createProtocolHandler } = await import(pathToFileURL(path.join(root, 'desktop/protocol.js')).href);
  protocol.handle('xhs-app', createProtocolHandler({ rootDirectory: root }));
  ipcMain.handle('vip-fixture:invoke', (_event, method) => {
    calls.push(method);
    if (method === 'getInfo') return { version: 'vip-ui-fixture', platform: process.platform, arch: process.arch, pythonAvailable: true };
    if (method === 'getAccountState') return account;
    if (method === 'getProfileState') return { status: 'idle', items: [], discovered: 0, completed: 0, failed: 0, skipped: 0 };
    if (method === 'getLoginState') return { status: 'unknown', loggedIn: false };
    if (method === 'getUpdateState') return { status: 'idle', currentVersion: 'vip-ui-fixture' };
    if (method === 'getUpdateHistory') return null;
    if (method === 'recordDiagnostic') return true;
    throw new Error(`Unexpected account or product mutation: ${method}`);
  });
  const staticRoot = path.join(root, 'dist-web');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const filename = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!filename.startsWith(staticRoot + path.sep) || !mime[path.extname(filename)]) throw new Error('Not a public asset');
      const body = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': mime[path.extname(filename)], 'Cache-Control': 'no-store' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const webOrigin = `http://127.0.0.1:${server.address().port}`;
  const rendererErrors = [];
  const popups = [];
  const configureWindow = useBridge => {
    const previous = win;
    win = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { ...(useBridge ? { preload } : {}), contextIsolation: true,
        sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    // Keep one window alive while moving from standalone pages to the bridge
    // fixture, so Electron's default-app lifecycle does not quit between them.
    if (previous && !previous.isDestroyed()) previous.destroy();
    win.webContents.setWindowOpenHandler(({ url }) => { popups.push(url); return { action: 'deny' }; });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({
      cancel: ![webOrigin + '/', 'xhs-app://local/', 'data:', 'blob:'].some(prefix => details.url.startsWith(prefix)),
    }));
    win.webContents.on('console-message', (...args) => {
      const details = typeof args[0]?.message === 'string' ? args[0] : { level: args[1], message: args[2] };
      if ((details.level === 'error' || details.level >= 3) && !/ERR_BLOCKED_BY_CLIENT/.test(details.message)) rendererErrors.push(details.message);
    });
  };
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const capture = async name => {
    await settle();
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const press = keyCode => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const originalQr = fs.readFileSync(path.join(root, 'assets/support/wechat-personal-qr.png'));
  const assertQrSave = async (doc, label) => {
    const savedPath = path.join(temporary, `${label}-wechat-personal-qr.png`);
    let download;
    win.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(savedPath);
      download = new Promise((resolve, reject) => item.once('done', (_doneEvent, state) => {
        if (state === 'completed') resolve(); else reject(new Error(`${label}: QR download ${state}`));
      }));
    });
    await evaluate(`${doc}.querySelector('#qr-save').click()`);
    await waitFor(() => Boolean(download), `${label}: QR native download starts`);
    await download;
    assert.deepEqual(fs.readFileSync(savedPath), originalQr, `${label}: saves unchanged personal QR bytes`);
    assert.match(await evaluate(`${doc}.querySelector('#qr-status').textContent`), /已发起保存/);
  };
  const assertOffer = async doc => {
    const text = await evaluate(`${doc}.body.innerText`);
    assert.match(text, /VIP\s*交流群/);
    assert.match(text, /99\.99/);
    assert.match(text, /付费/);
    assert.match(text, /预算/);
    assert.match(text, /可行性/);
    assert.match(text, /优先|优选/);
    assert.match(text, /抢先体验/);
    assert.match(text, /微信/);
    assert.equal(await evaluate(`${doc}.querySelector('#qr-save').getAttribute('href').endsWith('assets/support/wechat-personal-qr.png')`), true);
  };

  configureWindow(false);
  for (const [surface, origin] of [['web', webOrigin], ['local-protocol', 'xhs-app://local']]) {
    await win.loadURL(`${origin}/vip.html`);
    await assertOffer('document');
    await waitFor(() => evaluate(`Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)`), `${surface}: QR image loaded`);
    for (const width of widths) {
      win.setContentSize(width, 1000);
      await evaluate('scrollTo(0, 0)');
      await settle();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${surface}: no horizontal overflow at ${width}px`);
      if (surface === 'web') {
        assert.equal(await evaluate(`(() => { const header = document.querySelector('.app-header');
          return Array.from(header.querySelectorAll('a')).every(link => { const rect = link.getBoundingClientRect();
            return rect.left >= -1 && rect.right <= innerWidth + 1; }); })()`), true, `${width}px: every public navigation link stays within the viewport`);
      }
      await capture(`${surface}-${width}-page`);
      await evaluate(`document.querySelector('#qr-open').scrollIntoView({ block: 'center', behavior: 'instant' }); document.querySelector('#qr-open').focus()`);
      await click('#qr-open');
      assert.equal(await evaluate(`document.querySelector('#qr-dialog').open`), true);
      assert.equal(await evaluate(`(() => { const dialog = document.querySelector('#qr-dialog'), rect = dialog.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1; })()`), true, `${surface}: QR dialog fits ${width}px`);
      await capture(`${surface}-${width}-qr-dialog`);
      press('Escape');
      await waitFor(() => evaluate(`!document.querySelector('#qr-dialog').open && document.activeElement.id === 'qr-open'`), `${surface}: Escape closes and restores focus`);
    }
    await click('#qr-open');
    await click('#qr-close');
    await waitFor(() => evaluate(`!document.querySelector('#qr-dialog').open && document.activeElement.id === 'qr-open'`), `${surface}: explicit close and focus`);
    await assertQrSave('document', surface);
    assert.equal(new URL(win.webContents.getURL()).pathname, '/vip.html', `${surface}: saving QR keeps the page open`);
    checks.push(`${surface}: public offer, loaded QR, ${widths.join('/')} layout, dialog Escape/close/focus, exact-byte save`);
  }

  configureWindow(true);
  await win.loadURL('xhs-app://local/');
  await waitFor(() => evaluate(`document.body.dataset.desktopReady === 'true' && document.querySelector('#account-badge').textContent.includes('未登录')`), 'anonymous desktop startup');
  assert.equal(await evaluate(`document.querySelector('#desktop-vip-frame').hasAttribute('src')`), false, 'VIP frame is lazy until first selection');
  const initialUrl = win.webContents.getURL();
  await evaluate(`window.vipFixture = { main: document.querySelector('main'), frame: document.querySelector('#desktop-vip-frame') };
    document.querySelector('#share-text').value = '待继续解析的单篇下载草稿';
    document.querySelector('#desktop-feedback-title').value = '待继续填写的反馈';`);
  await click('#desktop-vip-link');
  const vipDocument = `document.querySelector('#desktop-vip-frame').contentDocument`;
  const vipWindow = `document.querySelector('#desktop-vip-frame').contentWindow`;
  const selectedVip = `document.body.dataset.desktopPage === 'vip' && document.querySelector('#desktop-vip-link').getAttribute('aria-selected') === 'true'
    && !document.querySelector('#desktop-vip-page').hidden`;
  await waitFor(() => evaluate(`${selectedVip} && ${vipDocument}?.body?.classList.contains('vip-embedded') && ${vipDocument}?.querySelector('#qr-open img')?.naturalWidth > 0`), 'anonymous user opens embedded VIP page');
  await assertOffer(vipDocument);
  assert.equal(await evaluate(`document.querySelector('#membership-dialog').open`), false, 'VIP access does not open software membership checkout');
  await evaluate(`vipFixture.document = ${vipDocument}; vipFixture.frameLoads = 0;
    vipFixture.frame.addEventListener('load', () => vipFixture.frameLoads++);`);

  for (const width of widths) {
    win.setContentSize(width, 1000);
    await evaluate(`${vipWindow}.scrollTo(0, 0)`);
    await settle();
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1 && ${vipDocument}.documentElement.scrollWidth <= ${vipWindow}.innerWidth + 1`), true, `${width}px: parent and embedded VIP page fit`);
    await capture(`desktop-anonymous-${width}-page`);
    await evaluate(`${vipDocument}.querySelector('#qr-open').scrollIntoView({ block: 'center', behavior: 'instant' }); ${vipDocument}.querySelector('#qr-open').focus(); ${vipDocument}.querySelector('#qr-open').click()`);
    assert.equal(await evaluate(`(() => { const dialog = ${vipDocument}.querySelector('#qr-dialog'), rect = dialog.getBoundingClientRect();
      return dialog.open && rect.left >= -1 && rect.right <= ${vipWindow}.innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1; })()`), true, `${width}px: nested QR dialog fits`);
    await capture(`desktop-anonymous-${width}-qr-dialog`);
    press('Escape');
    await waitFor(() => evaluate(`!${vipDocument}.querySelector('#qr-dialog').open && ${vipDocument}.activeElement.id === 'qr-open'`), `${width}px: nested Escape close and focus`);
    assert.equal(await evaluate(selectedVip), true);
  }
  await evaluate(`${vipWindow}.scrollTo({ top: 220, behavior: 'instant' }); vipFixture.scrollY = ${vipWindow}.scrollY;`);
  await click('#single-note-tab');
  await click('#desktop-vip-link');
  await settle();
  assert.equal(await evaluate(`vipFixture.frame === document.querySelector('#desktop-vip-frame') && vipFixture.document === ${vipDocument}
    && vipFixture.frameLoads === 0 && Math.abs(vipFixture.scrollY - ${vipWindow}.scrollY) <= 1
    && vipFixture.main === document.querySelector('main') && document.querySelector('#share-text').value === '待继续解析的单篇下载草稿'
    && document.querySelector('#desktop-feedback-title').value === '待继续填写的反馈'`), true, 'VIP tab preserves downloader drafts, existing iframe and reading position');
  assert.equal(win.webContents.getURL(), initialUrl, 'Opening VIP retains the parent workspace URL');
  await evaluate(`${vipDocument}.querySelector('#qr-open').click(); ${vipDocument}.querySelector('#qr-close').click()`);
  await waitFor(() => evaluate(`!${vipDocument}.querySelector('#qr-dialog').open && ${vipDocument}.activeElement.id === 'qr-open'`), 'nested explicit close and focus');
  await assertQrSave(vipDocument, 'desktop-anonymous');
  assert.equal(await evaluate(selectedVip), true, 'Saving QR retains VIP page selection');

  for (const [name, nextAccount] of [
    ['ordinary', { configured: true, authenticated: true, verified: true, status: 'authenticated', account: {
      user: { id: 'vip-ui-ordinary', email: 'vip-ui@example.invalid', role: 'user' }, membership: { type: 'none', active: false }, device: { status: 'authorized' },
    } }],
    ['member', { configured: true, authenticated: true, verified: true, status: 'authenticated', account: {
      user: { id: 'vip-ui-member', email: 'vip-ui@example.invalid', role: 'user' }, membership: { type: 'permanent', active: true }, device: { status: 'authorized' },
    } }],
    ['unconfigured', { configured: false, authenticated: false, verified: false, status: 'unconfigured', account: null }],
  ]) {
    account = nextAccount;
    win.webContents.send('vip-fixture:account', account);
    await settle();
    await click('#single-note-tab');
    await click('#desktop-vip-link');
    assert.equal(await evaluate(selectedVip), true, `${name}: VIP information remains accessible`);
    await assertOffer(vipDocument);
    assert.equal(await evaluate(`document.querySelector('#membership-dialog').open`), false, `${name}: no membership gate`);
  }
  await evaluate(`${vipDocument}.querySelector('#back-to-tool').click()`);
  await waitFor(() => evaluate(`document.body.dataset.desktopPage === 'single' && document.activeElement.id === 'single-note-tab'`), 'return link restores the preceding downloader page');
  assert.equal(win.webContents.getURL(), initialUrl);
  assert.deepEqual(popups, [], 'VIP interactions create no popup window');
  assert.deepEqual(rendererErrors, [], 'No renderer errors');
  assert.ok(calls.every(method => ['getInfo', 'getAccountState', 'getProfileState', 'getLoginState', 'getUpdateState', 'getUpdateHistory', 'recordDiagnostic'].includes(method)), 'Viewing and saving VIP information makes no account or payment mutation');
  checks.push('desktop workspace: anonymous/ordinary/member/unconfigured access, no membership gate, lazy iframe, responsive parent and child, nested QR dialog and original-byte save, preserved drafts and frame/scroll, in-place return navigation');
  const evidence = { result: 'PASS', scope: 'real Chromium with built web, local desktop protocol and isolated account bridge; no live account or payment writes', widths, checks, screenshots };
  const evidencePath = path.join(temporary, 'verification.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, evidencePath }));
  await finish(0);
}).catch(error => finish(1, error));
