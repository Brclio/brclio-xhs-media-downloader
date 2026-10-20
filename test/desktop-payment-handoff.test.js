import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPaymentCheckoutOpener, createPaymentReturnHandoff, parsePaymentReturnUrl, paymentCheckoutUrl, registerPaymentReturnProtocol } from '../desktop/payment-handoff.js';

const orderId = '12345678-1234-1234-1234-123456789abc';
const otherId = '12345678-1234-1234-1234-123456789abd';
const link = `brclio-xhs://payment-return?order_id=${orderId}`;
const checkoutUrl = 'https://paywc.bornforthis.cn/checkout/center-fixture#token=isolated-checkout-token';
const expectedUserId = 'fixture-account';
const input = { checkoutUrl, orderId, expectedUserId };
const state = () => ({ authenticated: true, verified: true, account: { user: { id: expectedUserId } } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('return scheme accepts only the canonical product order hint without token, status, URL or ambiguous query', () => {
  assert.deepEqual(parsePaymentReturnUrl(link), { orderId });
  for (const value of [undefined, '', checkoutUrl, link.replace('brclio-xhs:', 'https:'), link.replace('payment-return', 'other'), `${link}&paid=true`, `${link}#token=private`, `${link}&order_id=${otherId}`, link.replace('order_id=', 'order_id=%20'), link.replace(orderId, 'not-a-uuid'), link.replace('://', ':///'), link.replace('payment-return?', 'payment-return/?'), `${link}\n`]) {
    assert.equal(parsePaymentReturnUrl(value), null, String(value));
  }
});

test('checkout opener validates both centers and a single checkout credential, never arbitrary external schemes', () => {
  assert.equal(paymentCheckoutUrl(checkoutUrl), checkoutUrl);
  const alipay = checkoutUrl.replace('paywc.', 'pay.');
  assert.equal(paymentCheckoutUrl(alipay), alipay);
  for (const value of [undefined, '', 'file:///tmp/private', link, checkoutUrl.replace('https:', 'http:'), checkoutUrl.replace('paywc.bornforthis.cn', 'paywc.bornforthis.cn.evil.test'), checkoutUrl.replace('/checkout/', '/admin/'), checkoutUrl.replace('/checkout/', '/checkout/../'), checkoutUrl.replace('#token=', '?paid=true#token='), checkoutUrl.replace('#token=', '#paid='), `${checkoutUrl}&token=other`, `${checkoutUrl}&paid=true`, checkoutUrl.replace('https://', 'https://user:password@'), checkoutUrl.replace('isolated-checkout-token', '%0Aprivate'), checkoutUrl.replace('/checkout/', '\\checkout\\'), `${checkoutUrl}${'a'.repeat(2081)}`]) {
    assert.equal(paymentCheckoutUrl(value), null, String(value));
  }
});

test('native opening awaits OS acceptance, preserves the exact fragment and deduplicates concurrent clicks', async () => {
  const opened = [], accepted = deferred();
  const open = createPaymentCheckoutOpener({ getAccountState: state, getPendingPayment: async () => ({ userId: expectedUserId, orderId }), openExternal: (url, options) => { opened.push({ url, options }); return accepted.promise; } });
  const first = open(input), duplicate = open(input);
  assert.equal(first, duplicate);
  let finished = false; void first.then(() => { finished = true; });
  await tick(); assert.equal(finished, false); assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], { url: checkoutUrl, options: { activate: true } });
  accepted.resolve(); assert.deepEqual(await first, { ok: true });
  assert.equal(finished, true);
  await open(input); assert.equal(opened.length, 2, 'A later explicit retry can reopen the same durable order');
});

test('invalid or switched account/order cannot open a checkout from a late response', async () => {
  let calls = 0, current = state();
  const held = deferred();
  const open = createPaymentCheckoutOpener({ getAccountState: () => current, getPendingPayment: () => held.promise, openExternal: () => { calls++; } });
  const pending = open(input); current = { ...state(), account: { user: { id: 'other-account' } } };
  held.resolve({ userId: expectedUserId, orderId });
  assert.equal((await pending).error.code, 'SESSION_CHANGED'); assert.equal(calls, 0);
  for (const saved of [null, { userId: expectedUserId, orderId: otherId }, { userId: 'other-account', orderId }]) {
    const rejected = createPaymentCheckoutOpener({ getAccountState: state, getPendingPayment: () => saved, openExternal: () => { calls++; } });
    assert.equal((await rejected(input)).error.code, 'SESSION_CHANGED');
  }
  const unverified = createPaymentCheckoutOpener({ getAccountState: () => ({ ...state(), verified: false }), getPendingPayment: () => assert.fail('Unverified account must not inspect pending storage'), openExternal: () => { calls++; } });
  assert.equal((await unverified(input)).error.code, 'SESSION_CHANGED');
  for (const patch of [{ checkoutUrl: link }, { orderId: 'invalid' }, { expectedUserId: '' }]) assert.equal((await open({ ...input, ...patch })).error.code, 'PAYMENT_INVALID_CHECKOUT');
  assert.equal(calls, 0);
});

test('replacement login to the same account and unavailable pending storage also suppress native launch', async () => {
  let generation = 1, calls = 0;
  const pending = deferred();
  const open = createPaymentCheckoutOpener({ getAccountState: state, getSessionGeneration: () => generation, getPendingPayment: () => pending.promise, openExternal: () => { calls++; } });
  const original = open(input); generation++;
  pending.resolve({ userId: expectedUserId, orderId });
  assert.equal((await original).error.code, 'SESSION_CHANGED');
  const unavailable = createPaymentCheckoutOpener({ getAccountState: state, getPendingPayment: () => { throw Error('isolated-storage-secret'); }, openExternal: () => { calls++; } });
  const result = await unavailable(input);
  assert.equal(result.error.code, 'PAYMENT_ACCOUNT_UNVERIFIED'); assert.doesNotMatch(JSON.stringify(result), /isolated/);
  assert.equal(calls, 0);
});

test('OS rejection and timeout return fixed actionable errors without credential-bearing diagnostics', async () => {
  for (const openExternal of [() => { throw Error(`OS launch failed: ${checkoutUrl}`); }, () => Promise.reject(Error('isolated-private-error')), () => new Promise(() => {})]) {
    const open = createPaymentCheckoutOpener({ getAccountState: state, getPendingPayment: () => ({ userId: expectedUserId, orderId }), openExternal, timeoutMs: 10 });
    const result = await open(input);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'PAYMENT_BROWSER_OPEN_FAILED');
    assert.match(result.error.message, /原订单/); assert.doesNotMatch(JSON.stringify(result), /isolated|#token|https:/);
  }
});

function nativeWindow() {
  const sent = [], actions = [];
  return { sent, actions, isDestroyed: () => false, isMinimized: () => true, restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus'), webContents: { send: (channel, hint) => sent.push({ channel, hint }) } };
}

test('cold argv, mac open-url and Windows second-instance hints wait for the renderer and survive reload', () => {
  let win = null, clock = 1000;
  const handoff = createPaymentReturnHandoff({ getWindow: () => win, now: () => clock });
  assert.equal(handoff.receiveArguments(['program.exe', '--unrelated', link, 'invalid']), 1);
  assert.equal(handoff.receiveUrl(link), true);
  win = nativeWindow(); assert.equal(win.sent.length, 0);
  handoff.rendererReady();
  assert.deepEqual(win.sent, [{ channel: 'desktop:payment-return', hint: { orderId } }]);
  assert.ok(win.actions.includes('restore')); assert.ok(win.actions.includes('show')); assert.ok(win.actions.includes('focus'));
  handoff.receiveUrl(link); assert.equal(win.sent.length, 1, 'A duplicate OS delivery in the same burst is harmless');
  assert.equal(handoff.acknowledge(otherId), false);
  assert.equal(handoff.acknowledge(orderId), true);
  clock += 2000; handoff.receiveUrl(link); assert.equal(win.sent.length, 2, 'Returning after another payment attempt can check the same order again');
  assert.equal(handoff.acknowledge(orderId), true);
  handoff.rendererLoading(); clock += 2000;
  handoff.receiveUrl(`brclio-xhs://payment-return?order_id=${otherId}`); assert.equal(win.sent.length, 2);
  handoff.rendererReady(); assert.equal(win.sent.at(-1).hint.orderId, otherId);
  const actions = win.actions.length;
  assert.equal(handoff.receiveUrl(`${link}&paid=true`), false); assert.equal(win.actions.length, actions);
  handoff.dispose(); clock += 2000; assert.equal(handoff.receiveUrl(link), false);
});

test('a hint is replayed after document replacement until a renderer confirms receipt', () => {
  const win = nativeWindow(), handoff = createPaymentReturnHandoff({ getWindow: () => win });
  handoff.receiveUrl(link); handoff.rendererReady(); assert.equal(win.sent.length, 1);
  handoff.rendererReady(); assert.equal(win.sent.length, 1, 'No duplicate send while awaiting acknowledgement in the same document');
  handoff.rendererLoading(); handoff.rendererReady(); assert.equal(win.sent.length, 2, 'A reload before receipt cannot lose the hint');
  assert.equal(handoff.acknowledge(orderId), true);
  handoff.rendererLoading(); handoff.rendererReady(); assert.equal(win.sent.length, 2, 'Acknowledged hints are not replayed on future documents');
});

test('hint queue remains bounded and retains a hint when sending races renderer destruction', () => {
  let win = nativeWindow();
  const handoff = createPaymentReturnHandoff({ getWindow: () => win });
  for (let index = 0; index < 20; index++) handoff.receiveUrl(`brclio-xhs://payment-return?order_id=12345678-1234-1234-1234-${index.toString(16).padStart(12, '0')}`);
  win.webContents.send = () => { throw Error('renderer gone'); };
  handoff.rendererReady();
  win = nativeWindow(); handoff.rendererReady();
  assert.equal(win.sent.length, 16); assert.equal(win.sent[0].hint.orderId.endsWith('000000000004'), true);
  assert.deepEqual(Object.keys(win.sent[0].hint), ['orderId']);
});

test('development registration never replaces an installed protocol handler; packaged apps declare it', async () => {
  const registrations = [];
  assert.equal(registerPaymentReturnProtocol({ isPackaged: false, setAsDefaultProtocolClient: () => assert.fail('No OS writes from development fixtures') }), false);
  assert.equal(registerPaymentReturnProtocol({ isPackaged: true, setAsDefaultProtocolClient: scheme => { registrations.push(scheme); return true; } }), true);
  assert.deepEqual(registrations, ['brclio-xhs']);
  assert.equal(registerPaymentReturnProtocol({ isPackaged: true, setAsDefaultProtocolClient: () => { throw Error('OS refused'); } }), false);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.protocols.some(protocol => protocol.schemes.includes('brclio-xhs')));
  const main = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.ok(main.indexOf("app.on('open-url'") < main.indexOf('app.whenReady().then(boot)'));
  assert.match(main, /paymentReturnHandoff\.receiveArguments\(process\.argv\)/);
  assert.match(main, /paymentReturnHandoff\.receiveArguments\(commandLine\)/);
  assert.match(main, /handle\('desktop:open-payment-checkout'/);
});

test('Windows portable protocol registration uses the verified stable launcher with spaces, never its extracted runtime', () => {
  const launcher = 'C:\\Users\\Example User\\Downloads\\Brclio XHS Portable.exe';
  const runtime = 'C:\\Users\\Example User\\AppData\\Local\\Temp\\brclio-extracted\\Brclio XHS.exe';
  const calls = [], checked = [];
  const app = { isPackaged: true, setAsDefaultProtocolClient: (...args) => { calls.push(args); return true; } };
  const options = { platform: 'win32', execPath: runtime, env: { PORTABLE_EXECUTABLE_FILE: launcher,
    PORTABLE_EXECUTABLE_DIR: 'C:\\Users\\Example User\\Downloads' }, isFile: file => { checked.push(file); return true; } };
  assert.equal(registerPaymentReturnProtocol(app, options), true);
  assert.deepEqual(checked, [launcher]);
  assert.deepEqual(calls, [['brclio-xhs', launcher, []]]);
  assert.equal(registerPaymentReturnProtocol({ isPackaged: false, setAsDefaultProtocolClient: () => assert.fail('Development cannot register a portable launcher') }, options), false);
});

test('invalid or absent portable launcher refuses registration without falling back to the temporary runtime', () => {
  const runtime = 'C:\\Temp\\brclio-extracted\\Brclio XHS.exe';
  const app = { isPackaged: true, setAsDefaultProtocolClient: () => assert.fail('Invalid portable metadata must never register a handler') };
  for (const env of [
    { PORTABLE_EXECUTABLE_DIR: 'C:\\Downloads' }, { PORTABLE_EXECUTABLE_FILE: '' },
    { PORTABLE_EXECUTABLE_FILE: 'Brclio.exe' }, { PORTABLE_EXECUTABLE_FILE: '\\Downloads\\Brclio.exe' },
    { PORTABLE_EXECUTABLE_FILE: 'https://example.test/Brclio.exe' },
    { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Brclio.exe --argument' },
    { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Brclio.exe\n' },
    { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\"Brclio".exe' },
    { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Brclio.cmd' },
    { PORTABLE_EXECUTABLE_FILE: runtime },
    { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Brclio.exe', PORTABLE_EXECUTABLE_DIR: 'C:\\Temp' },
  ]) assert.equal(registerPaymentReturnProtocol(app, { platform: 'win32', execPath: runtime, env, isFile: () => true }), false);
  for (const isFile of [() => false, () => { throw Error('not accessible'); }]) {
    assert.equal(registerPaymentReturnProtocol(app, { platform: 'win32', execPath: runtime,
      env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Brclio.exe' }, isFile }), false);
  }
});

test('normal Windows installation and Mac registration preserve the default executable registration', () => {
  const calls = [], app = { isPackaged: true, setAsDefaultProtocolClient: (...args) => { calls.push(args); return true; } };
  assert.equal(registerPaymentReturnProtocol(app, { platform: 'win32', env: {} }), true);
  assert.equal(registerPaymentReturnProtocol(app, { platform: 'darwin', env: { PORTABLE_EXECUTABLE_FILE: 'unrelated' } }), true);
  assert.deepEqual(calls, [['brclio-xhs'], ['brclio-xhs']]);
});

test('preload exposes narrow native checkout and detachable hint listeners without leaking the IPC event', async () => {
  const source = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  const calls = [], listeners = new Set(); let bridge;
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: {
      invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
      on: (channel, listener) => { assert.equal(channel, 'desktop:payment-return'); listeners.add(listener); },
      removeListener: (_channel, listener) => listeners.delete(listener),
    } };
  } });
  await bridge.openPaymentCheckout(input);
  const hints = [], stop = bridge.onPaymentReturn(hint => hints.push(hint));
  const otherStop = bridge.onPaymentReturn(() => {});
  assert.equal(calls.filter(call => call[0] === 'desktop:payment-return-ready').length, 1);
  [...listeners][0]({ privateElectronEvent: true }, { orderId, paid: true, token: 'isolated-secret' });
  assert.equal(hints[0].orderId, orderId); assert.deepEqual(Object.keys(hints[0]), ['orderId']);
  assert.equal(calls.filter(call => call[0] === 'desktop:payment-return-ack').length, 1);
  stop(); stop(); assert.equal(listeners.size, 1);
  assert.equal(calls.some(call => call[0] === 'desktop:payment-return-unsubscribe'), false);
  otherStop(); assert.equal(listeners.size, 0);
  assert.equal(calls.filter(call => call[0] === 'desktop:payment-return-unsubscribe').length, 1);
  assert.deepEqual(calls[0], ['desktop:open-payment-checkout', input]);
  assert.throws(() => bridge.onPaymentReturn(null), { name: 'TypeError' });
});
