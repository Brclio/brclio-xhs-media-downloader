// Real renderer smoke test for the desktop membership flow. Uses only a fake
// account bridge and a disposable profile; no email, payment or account request
// leaves this process. Run: npx electron scripts/verify-membership-ui.cjs
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-membership-ui-'));
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
app.setPath('userData', path.join(temporary, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let win;
let finished = false;
const timeout = setTimeout(() => finish(1, new Error('MEMBERSHIP_UI_TIMEOUT')), 45_000);
async function finish(code, error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(code);
}

const fixture = `
window.fixtureCalls = [];
window.fixtureCopied = [];
window.fixtureState = { configured: true, authenticated: false, verified: false, status: 'logged_out', account: null };
window.fixtureSetState = value => { window.fixtureState = value; window.fixtureUpdate?.(value); };
window.xhsDesktop = {
  getAccountState: async () => window.fixtureState,
  onAccountUpdate: callback => { window.fixtureUpdate = callback; return () => {}; },
  refreshAccount: async () => { window.fixtureCalls.push(['refresh']); return { ok: true, state: window.fixtureState, result: {} }; },
  sendAccountCode: async email => { window.fixtureCalls.push(['sendCode', email]); return { ok: true, state: window.fixtureState, result: { retryAfter: 60 } }; },
  verifyAccountCode: async (email, code) => { window.fixtureCalls.push(['login', email, code]); return { ok: false, state: window.fixtureState, error: { message: '测试验证码不正确' } }; },
  redeemAccountCode: async code => {
    window.fixtureCalls.push(['redeem', code]);
    if (code === 'INVALID') return { ok: false, state: window.fixtureState, error: { message: '激活码无效' } };
    const next = structuredClone(window.fixtureState);
    next.account.membership = { type: 'duration', active: true, startsAt: '2026-09-23T00:00:00Z', expiresAt: '2026-10-23T00:00:00Z' };
    window.fixtureSetState(next);
    return { ok: true, state: next, result: { message: '会员兑换成功。' } };
  },
  logoutAccount: async () => { window.fixtureCalls.push(['logout']); return { ok: true, state: { configured: true, authenticated: false, verified: false, status: 'logged_out', account: null }, result: {} }; },
};
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
  if (window.fixtureClipboardFails) throw new Error('Clipboard unavailable');
  window.fixtureCopied.push(text);
} } });
document.body.classList.add('is-desktop');
document.querySelectorAll('.desktop-page, #single-note-panel, #profile-panel').forEach(element => { element.hidden = true; });
document.querySelectorAll('.desktop-tab').forEach(element => { element.setAttribute('aria-selected', String(element.id === 'account-tab')); });
document.getElementById('desktop-navigation').hidden = false;
document.getElementById('desktop-account-page').hidden = false;
document.getElementById('desktop-account-summary').textContent = 'member@example.test';
document.getElementById('desktop-account-summary-status').textContent = '账号与会员';
`;

app.whenReady().then(async () => {
  const { createProtocolHandler } = await import(pathToFileURL(path.join(root, 'desktop/protocol.js')).href);
  const handler = createProtocolHandler({ rootDirectory: root });
  protocol.handle('xhs-app', async request => {
    const url = new URL(request.url);
    if (url.pathname === '/membership-fixture.js') return new Response(fixture, { headers: { 'content-type': 'text/javascript' } });
    const response = await handler(request);
    if (url.pathname !== '/') return response;
    let html = await response.text();
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/membership-fixture.js"></script><script type="module" src="/account-ui.js"></script></body>');
    return new Response(html, { headers: response.headers });
  });
  win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('xhs-app://local/') && !details.url.startsWith('data:') }));
  const rendererErrors = [];
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) rendererErrors.push(details.message); });
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const snapshot = () => evaluate(`(() => {
    const d = document.getElementById('membership-dialog');
    return { open: d.open, focus: document.activeElement.id, paymentHidden: document.getElementById('membership-payment').hidden,
      guidanceHidden: document.getElementById('membership-login-guidance').hidden,
      email: document.getElementById('membership-email').textContent,
      amount: document.getElementById('membership-amount').textContent,
      src: document.getElementById('membership-payment-image').getAttribute('src'),
      help: document.getElementById('membership-payment-help').textContent,
      notice: document.getElementById('account-notice').textContent,
      overflow: d.scrollWidth > d.clientWidth + 1,
      width: d.getBoundingClientRect().width, viewport: innerWidth };
  })()`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const setState = state => evaluate(`window.fixtureSetState(${JSON.stringify(state)})`);
  const capture = async name => {
    await settle();
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await win.loadURL('xhs-app://local/');
  await evaluate(`new Promise((resolve, reject) => {
    const started = Date.now(); const check = () => {
      if (document.getElementById('account-open-membership')) resolve();
      else if (Date.now() - started > 5000) reject(new Error('Account UI not mounted'));
      else setTimeout(check, 20);
    }; check();
  })`);
  await evaluate(`document.getElementById('account-open-membership').focus(); document.getElementById('account-open-membership').click()`);
  let current = await snapshot();
  assert.equal(current.open, true);
  assert.equal(current.focus, 'membership-close');
  assert.equal(current.paymentHidden, true, 'Logged-out users must be guided to confirm their software account before paying');
  assert.equal(current.guidanceHidden, false);
  assert.equal(current.amount, '¥9.9');
  await capture('logged-out-desktop');
  await click('membership-go-login');
  assert.equal((await snapshot()).focus, 'account-email');
  assert.equal((await snapshot()).open, false);

  const signedIn = { configured: true, authenticated: true, verified: true, status: 'ready', account: { user: { email: 'member@example.test' }, membership: { type: 'none', active: false }, device: { status: 'authorized' }, serverTime: '2026-09-23T00:00:00Z' } };
  await setState(signedIn);
  await evaluate(`document.getElementById('account-open-membership').focus(); document.getElementById('account-open-membership').click()`);
  current = await snapshot();
  assert.equal(current.paymentHidden, false);
  assert.equal(current.email, signedIn.account.user.email);
  await click('membership-copy-email');
  assert.deepEqual(await evaluate('window.fixtureCopied'), [signedIn.account.user.email]);
  assert.match(await evaluate(`document.getElementById('membership-email-status').textContent`), /已复制/);
  await evaluate('window.fixtureClipboardFails = true');
  await click('membership-copy-email');
  assert.match(await evaluate(`document.getElementById('membership-email-status').textContent`), /手动复制/);
  await evaluate('window.fixtureClipboardFails = false');
  for (const [id, amount, days] of [['daily', '2', 1], ['monthly', '9.9', 30], ['yearly', '39.9', 365]]) {
    await evaluate(`document.querySelector('input[name="membership-plan"][value="${id}"]').click()`);
    assert.equal((await snapshot()).amount, `¥${amount}`);
    assert.match(await evaluate(`document.getElementById('membership-purchase-summary').textContent`), new RegExp(`${days} 天`));
    assert.match((await snapshot()).help, new RegExp(`${amount.replace('.', '\\.')} 元`));
  }
  await evaluate(`document.querySelector('input[name="membership-method"][value="alipay"]').click()`);
  assert.equal((await snapshot()).src, './assets/membership/alipay.png');
  assert.match((await snapshot()).help, /支付宝/);
  await evaluate(`document.querySelector('input[name="membership-plan"][value="monthly"]').click()`);
  await evaluate(`document.querySelector('input[name="membership-method"][value="wechat"]').click()`);
  await evaluate(`Promise.all([...document.querySelectorAll('#membership-dialog img')].map(image => image.decode()))`);
  assert.deepEqual(await evaluate(`window.fixtureCalls`), [], 'Browsing plans, copying the email and showing payment codes cannot invoke purchase or grant actions');
  await setState({ ...signedIn, account: { ...signedIn.account, user: { email: 'another@example.test' } } });
  await setState(signedIn);
  await capture('membership-desktop');

  // Native dialog contains keyboard focus and restores the trigger after Escape.
  await evaluate(`document.getElementById('membership-close').focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
  await settle();
  assert.equal(await evaluate(`document.getElementById('membership-dialog').contains(document.activeElement)`), true, 'Backward Tab remains in the modal (Chromium can focus its scroll container)');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await settle();
  assert.equal((await snapshot()).focus, 'membership-close');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await settle();
  assert.equal((await snapshot()).open, false);
  assert.equal((await snapshot()).focus, 'account-open-membership');

  await click('account-open-membership');
  await setState({ ...signedIn, verified: false, status: 'service_unavailable', error: { message: '网络连接不可用，请稍后刷新。' } });
  assert.equal((await snapshot()).paymentHidden, true);
  assert.match((await snapshot()).notice, /网络连接不可用/);
  await click('membership-go-login');
  assert.equal((await snapshot()).focus, 'account-refresh');
  await setState({ ...signedIn, authenticated: false, verified: false, status: 'secure_storage_unavailable', account: null, error: { message: '安全存储不可用' } });
  await click('account-open-membership');
  assert.equal((await snapshot()).open, true, 'Pricing remains viewable during account errors');
  assert.equal((await snapshot()).paymentHidden, true);
  assert.equal((await snapshot()).email, '', 'Previous identity cannot remain visible after logout or storage failure');
  await setState(signedIn);
  assert.equal((await snapshot()).paymentHidden, false);
  await setState({ ...signedIn, account: { ...signedIn.account, membership: { type: 'permanent', active: true } } });
  assert.equal((await snapshot()).paymentHidden, true, 'Permanent members must not be invited to pay for duration codes they cannot redeem');
  assert.match(await evaluate(`document.getElementById('membership-login-message').textContent`), /无需购买/);
  assert.equal(await evaluate(`document.getElementById('membership-go-redeem').hidden`), true);
  await evaluate(`document.getElementById('membership-dialog').scrollTop = 0`);
  await capture('membership-permanent');
  await setState({ ...signedIn, account: { ...signedIn.account, user: { email: 'another@example.test' } } });
  assert.equal((await snapshot()).email, 'another@example.test');
  assert.equal(await evaluate(`document.getElementById('membership-email-status').textContent`), '');
  await setState(signedIn);

  // Narrow viewport retains every price, warning and QR; the modal scrolls.
  win.setContentSize(390, 844);
  await evaluate(`document.getElementById('membership-dialog').scrollTop = 0`);
  await settle();
  current = await snapshot();
  assert.equal(current.overflow, false);
  assert.ok(current.width <= current.viewport);
  await capture('membership-mobile-top');
  await evaluate(`document.getElementById('membership-payment').scrollIntoView({ block: 'center' })`);
  await capture('membership-mobile-payment');
  await evaluate(`document.querySelector('.membership-contact').open = true; document.querySelector('.membership-contact').scrollIntoView({ block: 'center' })`);
  await capture('membership-mobile-contact');
  await evaluate(`document.querySelector('.membership-contact').open = false`);
  assert.equal((await snapshot()).overflow, false);
  win.setContentSize(1280, 960);
  await click('membership-go-redeem');
  assert.equal((await snapshot()).focus, 'account-activation');
  await evaluate(`document.getElementById('account-activation').value = 'INVALID'; document.getElementById('account-redeem-form').requestSubmit()`);
  await settle();
  assert.match((await snapshot()).notice, /激活码无效/);
  assert.equal(await evaluate(`document.getElementById('account-activation').value`), 'INVALID', 'A failed redeem keeps the pasted code for retry');
  await evaluate(`document.getElementById('account-activation').value = 'Brclio-TEST-ONLY'; document.getElementById('account-redeem-form').requestSubmit()`);
  await settle();
  assert.match((await snapshot()).notice, /兑换成功/);
  assert.equal(await evaluate(`document.getElementById('account-activation').value`), '');
  assert.equal(await evaluate(`document.getElementById('account-membership').textContent`), '有效期会员');
  assert.deepEqual(await evaluate('window.fixtureCalls'), [['redeem', 'INVALID'], ['redeem', 'Brclio-TEST-ONLY']]);
  await capture('membership-redeemed');

  // The same module loaded on the free web surface must remain inert.
  await evaluate(`document.getElementById('software-account').remove(); delete window.xhsDesktop; import('/account-ui.js').then(module => module.initializeAccountUI())`);
  assert.equal(await evaluate(`Boolean(document.getElementById('software-account'))`), false);
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ ok: true, checks: ['logged-out guidance', 'plan prices and durations', 'payment method switching', 'all QR images load and decode as images', 'copy success/failure', 'no implicit purchase requests', 'native focus trap and Escape', 'offline/storage errors', 'permanent member guard', 'account switch', 'mobile layout', 'redeem failure/success', 'free web guard'], screenshots }, null, 2));
  await finish(0);
}).catch(error => finish(1, error));
