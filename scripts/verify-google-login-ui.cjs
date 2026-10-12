// Isolated real-renderer verification; no Google account, email, or network call.
// Run: npx electron scripts/verify-google-login-ui.cjs
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-google-login-ui-'));
app.setPath('userData', path.join(temporary, 'profile'));
// Hosted Intel runners may lack an EGL display. Keep real rendering and all
// screenshot checks while using Chromium's software compositor.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let win, finished = false;
const timeout = setTimeout(() => finish(1, new Error('GOOGLE_LOGIN_UI_TIMEOUT')), 45_000);
function finish(code, error) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(code);
}
const fixture = `
window.fixtureCalls = [];
window.fixtureMode = new URL(location.href).searchParams.get('mode');
window.fixtureState = { configured: true, authenticated: false, verified: false, status: 'logged_out', account: null };
const fixtureAccount = { user: { id: 'google-user', email: 'member@gmail.com' }, membership: { type: 'none', active: false } };
window.fetch = async (url, options) => {
  const request = JSON.parse(options.body);
  window.fixtureCalls.push({ ...request, href: location.href });
  const ok = value => Response.json({ ok: true, ...value });
  if (request.action === 'me') return Response.json({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请登录软件账号。' } }, { status: 401 });
  if (request.action === 'google-config') return ok({ enabled: true });
  if (request.action === 'google-complete') return fixtureMode === 'confirm' || fixtureMode === 'decline'
    ? ok({ loginClient: 'desktop', status: 'confirmation_required', attemptId: 'attempt', confirmationToken: 'only-in-memory', email: 'member@gmail.com', deviceName: 'Test <Mac>' })
    : ok({ loginClient: 'browser', account: fixtureAccount });
  if (request.action === 'google-confirm') return ok({ loginClient: 'desktop', status: 'complete' });
  if (request.action === 'reviews-public') return ok({ reviews: [], total: 0, totalPages: 0 });
  return ok({});
};
if (window.fixtureMode === 'desktop') {
  window.xhsDesktop = {
    getAccountState: async () => fixtureState,
    onAccountUpdate: callback => { window.fixtureUpdate = callback; return () => {}; },
    getAccountGoogleConfig: async () => ({ ok: true, result: { enabled: true }, state: fixtureState }),
    loginAccountGoogle: () => new Promise(resolve => { fixtureCalls.push({ action: 'google-start' }); window.fixtureCancel = () => resolve({ ok: false, error: { code: 'GOOGLE_LOGIN_CANCELLED', message: '已取消 Google 登录。' }, state: fixtureState }); }),
    cancelAccountGoogleLogin: async () => { fixtureCalls.push({ action: 'google-cancel' }); window.fixtureCancel(); return { ok: true, state: fixtureState, result: { cancelled: true } }; },
  };
  document.body.classList.add('is-desktop');
  document.querySelectorAll('.desktop-page, #single-note-panel, #profile-panel').forEach(element => { element.hidden = true; });
  document.getElementById('desktop-navigation').hidden = false;
  document.getElementById('desktop-account-page').hidden = false;
}
`;
app.whenReady().then(async () => {
  const { createProtocolHandler } = await import(pathToFileURL(path.join(root, 'desktop/protocol.js')).href);
  const handler = createProtocolHandler({ rootDirectory: root });
  protocol.handle('xhs-app', async request => {
    const url = new URL(request.url);
    if (url.pathname === '/google-login-fixture.js') return new Response(fixture, { headers: { 'content-type': 'text/javascript' } });
    const response = await handler(request);
    if (url.pathname !== '/') return response;
    let html = await response.text();
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/google-login-fixture.js"></script><script type="module" src="/account-ui.js"></script></body>');
    return new Response(html, { headers: response.headers });
  });
  win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('xhs-app://local/') && !details.url.startsWith('data:') }));
  const rendererErrors = [];
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) rendererErrors.push(details.message); });
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const until = predicate => evaluate(`new Promise((resolve, reject) => {
    const start = performance.now(); const interval = setInterval(() => {
      if (${predicate}) { clearInterval(interval); resolve(); }
      else if (performance.now() - start > 5000) { clearInterval(interval); reject(new Error('UI condition timeout')); }
    }, 20);
  })`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const capture = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(temporary, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await win.loadURL('xhs-app://local/?mode=desktop');
  await until("document.getElementById('account-google-login-row')?.hidden === false");
  assert.equal(await evaluate("document.querySelectorAll('#account-google-login svg').length"), 1);
  await click('account-google-login');
  await until("document.getElementById('account-google-cancel')?.hidden === false");
  assert.equal(await evaluate("document.getElementById('account-google-login').disabled"), true);
  await capture('desktop-waiting');
  await click('account-google-cancel');
  await until("document.getElementById('account-notice')?.textContent.includes('已取消')");
  assert.equal(await evaluate("fixtureCalls.filter(item => item.action === 'google-cancel').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#account-google-login svg').length"), 1);

  await win.loadURL('xhs-app://local/?mode=denied&google_callback=1&error=access_denied&state=secret');
  await until("document.getElementById('account-notice')?.textContent.includes('Google 登录已取消')");
  assert.equal(await evaluate("location.search.includes('state=') || location.search.includes('error=')"), false);
  assert.equal(await evaluate("fixtureCalls.some(item => item.action === 'google-complete')"), false);

  await win.loadURL('xhs-app://local/?mode=browser&google_callback=1&code=secret-code&state=secret-state');
  await until("document.getElementById('account-identity')?.textContent === 'member@gmail.com'");
  assert.equal(await evaluate("document.getElementById('browser-account-dialog').open"), true);
  assert.equal(await evaluate("fixtureCalls.some(item => item.href.includes('secret'))"), false);
  await capture('browser-signed-in');

  await win.loadURL('xhs-app://local/?mode=confirm&google_callback=1&code=secret-code&state=secret-state');
  await until("document.getElementById('account-google-confirmation')?.hidden === false");
  assert.equal(await evaluate("document.getElementById('account-google-confirm-device').textContent"), 'Test <Mac>');
  assert.equal(await evaluate("document.getElementById('account-login-form').hidden"), true);
  assert.equal(await evaluate("fixtureCalls.some(item => item.action === 'google-confirm')"), false);
  await capture('desktop-confirmation');
  win.setContentSize(320, 800);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate("(() => { const panel = document.getElementById('software-account'); return panel.scrollWidth <= panel.clientWidth + 1; })()"), true, 'Account confirmation must fit a 320px viewport');
  await capture('desktop-confirmation-mobile');
  await click('account-google-confirm');
  await until("document.getElementById('account-notice')?.textContent.includes('已确认登录')");
  assert.deepEqual(await evaluate("fixtureCalls.find(item => item.action === 'google-confirm').input"), { attemptId: 'attempt', confirmationToken: 'only-in-memory', client: 'browser' });
  await until("document.getElementById('account-google-login-row')?.hidden === false");
  assert.equal(await evaluate("(() => { const panel = document.getElementById('software-account'); return panel.scrollWidth <= panel.clientWidth + 1; })()"), true, 'Google login controls must fit a 320px viewport');
  await capture('google-login-mobile');
  win.setContentSize(1280, 960);

  await win.loadURL('xhs-app://local/?mode=decline&google_callback=1&code=secret-code&state=secret-state');
  await until("document.getElementById('account-google-confirmation')?.hidden === false");
  await click('account-google-decline');
  assert.equal(await evaluate("fixtureCalls.some(item => item.action === 'google-confirm')"), false);
  assert.equal(await evaluate("document.getElementById('account-google-confirmation').hidden"), true);
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ ok: true, softwareRendering: true, scenarios: ['desktop-login-cancel', 'browser-denied', 'browser-cookie-login', 'explicit-device-confirmation', 'device-declined'], screenshots: temporary }));
  finish(0);
}).catch(error => finish(1, error));
