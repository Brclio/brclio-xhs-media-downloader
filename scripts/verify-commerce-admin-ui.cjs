// Real Electron renderer + HTTPS account handler/service. In-memory accounts and
// mail only; outbound requests are blocked. Run: npx electron scripts/verify-commerce-admin-ui.cjs
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:https');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'xhs-commerce-admin-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
let win, server, finishing = false;
const timer = setTimeout(() => finish(1, new Error('COMMERCE_ADMIN_TIMEOUT')), 60_000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finish(code, error) {
  if (finishing) return;
  finishing = true; clearTimeout(timer);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) { await win.webContents.session.clearStorageData().catch(() => {}); win.destroy(); }
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(path.join(temporary, 'profile'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  app.exit(code);
}
app.whenReady().then(async () => {
  const keyFile = path.join(temporary, 'key.pem'), certFile = path.join(temporary, 'cert.pem');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' }).status, 0);
  const source = relative => pathToFileURL(path.join(root, relative)).href;
  const { emptyState, validateState } = await import(source('server/auth/store.js'));
  const { createAccountService } = await import(source('server/auth/service.js'));
  const { readConfig } = await import(source('server/auth/config.js'));
  const { createAccountHandler } = await import(source('api/account.js'));
  let state = emptyState();
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  const date = '2026-10-08T10:00:00.000Z';
  state.users.customer = { id: 'customer', email: 'customer@example.test', createdAt: date, membership: { type: 'none', startsAt: null, expiresAt: null } };
  for (let index = 0; index < 45; index++) {
    const id = randomUUID();
    state.orders[id] = { id, userId: 'customer', planId: 'monthly', planName: '月付', priceCents: 1990, amountCents: null, status: 'pending', paymentMethod: 'wechat', paidAt: null, confirmedAt: null, codeId: null, createdAt: new Date(Date.parse(date) - index * 1000).toISOString(), source: 'user_report' };
  }
  const confirmedId = randomUUID();
  state.orders[confirmedId] = { id: confirmedId, userId: 'customer', planId: 'monthly', planName: '月付', priceCents: 1990, amountCents: 1234, status: 'confirmed', paymentMethod: 'wechat', paidAt: '2026-10-08T16:30:00.000Z', confirmedAt: date, codeId: null, createdAt: date, source: 'admin_record', paymentKey: 'a'.repeat(64), confirmedBy: 'fixture-admin', transactionReference: 'fixture-existing-payment', reason: '核对 <img src=x onerror="window.commerceXss=true"> 凭证' };
  const legacyCodeId = randomUUID();
  state.codes[legacyCodeId] = { id: legacyCodeId, recipientId: 'customer', recipientEmail: 'customer@example.test', planId: 'daily', planName: '日付', priceCents: 200, type: 'duration', days: 1, status: 'unused', createdAt: date };
  const store = {
    async read() { return { state: validateState(structuredClone(state)), sha: 'fixture' }; },
    async transaction(mutate) { const draft = structuredClone(state); const result = await mutate(draft); if (result?.changed !== false) state = validateState(draft); return result?.value; },
  };
  const deliveries = [];
  const config = readConfig({ AUTH_SECRET_PEPPER: 'commerce-admin-fixture-'.repeat(3), AUTH_ADMIN_EMAILS: 'admin@example.test' });
  const service = createAccountService({ store, config, now: () => now, mailer: { configured: true, provider: 'fixture', async send(message) { deliveries.push(message); } } });
  let handler, failNextRecord = false, failNextLink = false;
  const calls = [];
  const tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  fs.rmSync(keyFile); fs.rmSync(certFile);
  server = createServer(tls, (req, res) => {
    if (req.url === '/api/account') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          req.body = JSON.parse(body); calls.push(req.body);
          res.status = code => { res.statusCode = code; return res; };
          res.json = payload => {
            if (payload.ok && req.body.action === 'admin-record-order' && failNextRecord) { failNextRecord = false; res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: { message: 'Fixture response lost after commit' } })); }
            if (payload.ok && req.body.action === 'admin-link-order-code' && failNextLink) { failNextLink = false; res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: { message: 'Fixture link response lost after commit' } })); }
            res.end(JSON.stringify(payload));
          };
          await handler(req, res);
        } catch (error) { console.error(error); res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: { message: 'Fixture failed' } })); }
      }); return;
    }
    const file = req.url === '/admin/' ? 'admin/index.html' : req.url.replace(/^\//, '');
    if (!['admin/index.html', 'admin/admin.js', 'admin/admin.css', 'lib/membership-plans.js'].includes(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.siteOrigin = `https://127.0.0.1:${server.address().port}`;
  handler = createAccountHandler({ service, config, now: () => now });
  win = new BrowserWindow({ show: false, width: 1400, height: 1100, webPreferences: { partition: `commerce-fixture-${process.pid}`, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  win.webContents.session.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).origin !== config.siteOrigin }));
  const errors = []; win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = async expression => {
    try { return await win.webContents.executeJavaScript(expression); }
    catch (error) { console.error({ expression, rendererErrors: errors, notice: await win.webContents.executeJavaScript("document.querySelector('#notice')?.textContent") }); throw error; }
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
  const submit = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  async function check(expression, label) {
    for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate(`!!(${expression})`)) return; await pause(20); }
    throw new Error(`${label}: ${await evaluate("document.querySelector('#notice').textContent")}`);
  }
  await win.loadURL(`${config.siteOrigin}/admin/`);
  await fill('#login-email', 'admin@example.test'); await click('#send-code');
  for (let attempt = 0; attempt < 250 && !deliveries.length; attempt++) await pause(20);
  assert.equal(deliveries.length, 1, `login code fixture: ${await evaluate("document.querySelector('#notice').textContent")} ${JSON.stringify(errors)}`); await fill('#login-code', deliveries[0].code); await click('#login-submit');
  await check("!document.querySelector('#workspace').hidden", 'administrator login');
  await click('#tab-orders');
  await check("document.querySelector('#orders-count').textContent.includes('47') && document.querySelector('#revenue-summary').textContent.includes('¥14.34')", 'complete ledger including automatic historic activation receipts');
  assert.equal(await evaluate("document.querySelectorAll('#orders-list tbody tr').length"), 20);
  await click('#orders-pagination > button:last-of-type');
  await check("document.querySelector('#orders-pagination').textContent.includes('第 2 / 3')", 'server-side next page');
  await fill('#orders-pagination input', '3'); await submit('#orders-pagination form');
  await check("document.querySelector('#orders-pagination').textContent.includes('第 3 / 3') && document.querySelectorAll('#orders-list tbody tr').length === 7", 'last page reached with no record truncation');

  await fill('#order-status', 'confirmed'); await submit('#orders-filter-form');
  await check("document.querySelector('#orders-count').textContent.includes('2 笔') && document.querySelector('#orders-list').textContent.includes('实收 ¥12.34') && document.querySelector('#orders-list').textContent.includes('套餐发码 · 已入账')", 'confirmed filter includes automatic historic activation receipts');
  assert.equal(await evaluate("document.querySelector('#orders-list img')"), null, 'stored HTML never executes');
  await fill('#order-start-date', '2026-10-09'); await fill('#order-end-date', '2026-10-09'); await submit('#orders-filter-form');
  await check("!document.querySelector('#orders-list').hasAttribute('aria-busy')", 'Shanghai date filter complete');
  assert.ok(await evaluate("document.querySelector('#orders-list').textContent.includes('2026/10/09')"), 'confirmed date is displayed in Beijing time');
  await fill('#revenue-start-date', '2026-10-08'); await fill('#revenue-end-date', '2026-10-08'); await submit('#revenue-filter-form');
  await check("document.querySelector('#revenue-summary').textContent.includes('¥2.00')", 'manual receipt excluded before Shanghai midnight; historic activation counted at its saved price');
  await fill('#revenue-start-date', '2026-10-09'); await fill('#revenue-end-date', '2026-10-09'); await submit('#revenue-filter-form');
  await check("document.querySelector('#revenue-summary').textContent.includes('¥12.34')", 'receipt included after Shanghai midnight');
  await fill('#revenue-start-date', ''); await fill('#revenue-end-date', ''); await submit('#revenue-filter-form');
  await fill('#order-start-date', ''); await fill('#order-end-date', ''); await fill('#order-status', 'pending'); await submit('#orders-filter-form');
  await check("document.querySelector('#orders-count').textContent.includes('45 笔')", 'pending-only filter');
  await click('#orders-list tbody tr button');
  await check("!document.querySelector('#order-record-target').hidden && document.querySelector('#order-user').disabled", 'pending order identity locked');
  await fill('#order-amount', '9.87'); await fill('#order-paid-at', '2026-10-09T12:30:00'); await fill('#order-transaction-reference', 'fixture-payment-retry'); await fill('#order-record-reason', '已核对实际收款，金额为折扣实收');
  failNextRecord = true;
  await submit('#order-record-form'); await check("document.querySelector('#action-dialog').open", 'concrete receipt confirmation'); await click('#dialog-confirm');
  await check("document.querySelector('#notice').textContent.includes('Fixture response lost') && document.querySelector('#notice button')", 'uncertain receipt exposes retry');
  assert.equal(Object.values(state.orders).filter(order => order.status === 'confirmed').length, 2, 'original receipt was committed');
  await click('#notice button');
  await check("document.querySelector('#revenue-summary').textContent.includes('¥24.21') && document.querySelector('#order-record-result').textContent.includes('收款已确认')", 'same receipt retry recovers result');
  const receiptCalls = calls.filter(call => call.action === 'admin-record-order');
  assert.equal(receiptCalls.length, 2); assert.equal(receiptCalls[0].input.requestId, receiptCalls[1].input.requestId);
  assert.equal(state.audit.filter(entry => entry.action === 'admin-record-order').length, 1, 'one receipt produces one audit record');
  assert.equal(receiptCalls[0].input.paidAt, '2026-10-09T04:30:00.000Z', 'form interprets input as Beijing time');
  assert.equal(state.users.customer.membership.type, 'none', 'recording receipt does not grant membership');

  // A selected-plan issue is an actual sale immediately. If it belongs to an
  // existing manually confirmed receipt, linking merges its automatic entry.
  const paidOrderId = receiptCalls[0].input.orderId;
  const receiptBeforeLink = structuredClone(state.orders[paidOrderId]);
  await click('#tab-codes'); await fill('#issue-query', 'customer@example.test'); await submit('#issue-search-form');
  await check("document.querySelector('#issue-recipient').value === 'customer'", 'find paid customer before issuing');
  await fill('#issue-plan', 'monthly'); await fill('#issue-reason', '已确认收款，发放对应月付激活码'); await click('#issue-generate');
  await check("document.querySelector('#issue-code') && !document.querySelector('#issue-generate').disabled", 'issue a real code after confirming payment');
  assert.equal(await evaluate("document.querySelector('#action-dialog').open"), false, 'selected-plan issue does not request receipt reconfirmation');
  const issuedCodeId = Object.values(state.codes).find(code => code.planId === 'monthly').id;
  await click('#tab-orders'); await click('#refresh-commerce');
  await check("document.querySelector('#revenue-summary').textContent.includes('¥44.11') && document.querySelector('#revenue-summary').textContent.includes('2 笔 · 已计收入')", 'selected-plan issue automatically adds actual plan amount');
  await fill('#order-query', paidOrderId); await fill('#order-status', 'confirmed'); await submit('#orders-filter-form');
  await check("document.querySelector('#orders-count').textContent.includes('1 笔') && document.querySelector('#orders-list button')?.textContent === '关联激活码'", 'paid receipt can attach subsequently issued code');
  await click('#orders-list tbody tr button');
  await check("document.querySelector('#order-link-dialog').open && document.querySelector('#order-link-summary').textContent.includes('¥9.87')", 'concrete linking form identifies receipt and amount');
  await fill('#order-link-code-id', issuedCodeId); await fill('#order-link-reason', '已核对发码记录与已确认收款订单');
  failNextLink = true; await submit('#order-link-form');
  await check("!document.querySelector('#order-link-dialog').open && document.querySelector('#notice').textContent.includes('Fixture link response lost')", 'uncertain code link stays recoverable');
  await click('#notice button');
  await check("document.querySelector('#orders-list').textContent.includes('已关联激活码') && document.querySelector('#revenue-summary').textContent.includes('¥24.21')", 'recovered attachment merges the automatic issue receipt');
  const linkCalls = calls.filter(call => call.action === 'admin-link-order-code');
  assert.equal(linkCalls.length, 2); assert.equal(linkCalls[0].input.requestId, linkCalls[1].input.requestId);
  assert.equal(state.audit.filter(entry => entry.action === 'admin-link-order-code').length, 1, 'one link produces one audit record');
  assert.equal(state.orders[paidOrderId].codeId, issuedCodeId);
  for (const key of ['amountCents', 'paidAt', 'confirmedAt', 'transactionReference']) assert.equal(state.orders[paidOrderId][key], receiptBeforeLink[key], `${key} is immutable when linking`);
  await fill('#order-query', '');

  await fill('#order-query', `legacy-${legacyCodeId}`); await submit('#orders-filter-form');
  await check("document.querySelector('#orders-count').textContent.includes('1 笔') && document.querySelector('#orders-list').textContent.includes('套餐发码 · 已入账') && document.querySelector('#orders-list').textContent.includes('实收 ¥2.00') && !document.querySelector('#orders-list').hasAttribute('aria-busy')", 'historic selected-plan code is already a receipt at its saved price');
  assert.equal(await evaluate("document.querySelectorAll('#orders-list button').length"), 0, 'automatic activation receipt has no confirmation or linking action');
  assert.ok(await evaluate("document.querySelector('#orders-list').textContent.includes('按所选套餐金额自动入账') && !document.querySelector('#orders-list').textContent.includes('未录入收款流水')"), 'automatic receipt does not fabricate a bank transaction');
  assert.equal(Object.values(state.orders).filter(order => order.codeId === legacyCodeId).length, 0, 'historic receipt is derived without a duplicate stored order');

  await click('#tab-codes');
  await evaluate(`Array.from(document.querySelectorAll('#codes-list tbody tr')).find(row => row.textContent.includes(${JSON.stringify(legacyCodeId)})).querySelector('button').click()`);
  await check("document.querySelector('#issue-preview').textContent.includes('日付 · ¥2')", 'historic activation preview preserves the saved amount');
  assert.equal(await evaluate("document.querySelector('#issue-preview').textContent.includes('¥3')"), false, 'current catalog price does not replace historical actual amount');

  await click('#tab-users');
  await evaluate("Array.from(document.querySelectorAll('.user-item')).find(item => item.textContent.includes('customer@example.test')).click()");
  await check("document.querySelector('#membership-operation') && document.querySelector('#user-detail').textContent.includes('手动确认实际金额')", 'direct membership help distinguishes manual receipt');
  await fill('#membership-days', '30'); await fill('#membership-reason', '直接开通会员，收款需另行手动核实'); await click('.membership-form button');
  await check("document.querySelector('#action-dialog').open", 'direct membership still requires confirmation'); await click('#dialog-confirm');
  await check("document.querySelector('#notice').textContent.includes('会员权益已更新') && document.querySelector('#membership-reason').value === ''", 'direct membership saved');
  await click('#tab-orders'); await click('#refresh-commerce');
  await check("document.querySelector('#revenue-summary').textContent.includes('¥24.21') && !document.querySelector('#revenue-summary').hasAttribute('aria-busy')", 'direct membership does not infer received amount');

  await fill('#order-user-query', 'customer@example.test'); await submit('#order-user-search-form');
  await check("document.querySelector('#order-user').value === 'customer'", 'new receipt customer search');
  await fill('#order-amount', '9.87'); await fill('#order-paid-at', '2026-10-09T12:30:00'); await fill('#order-transaction-reference', 'fixture-payment-retry'); await fill('#order-payment-method', 'wechat'); await fill('#order-record-reason', '重复流水验证');
  await submit('#order-record-form'); await check("document.querySelector('#action-dialog').open", 'duplicate receipt confirmation'); await click('#dialog-confirm');
  await check("document.querySelector('#notice').textContent.includes('已经入账')", 'duplicate external payment rejected');
  assert.equal(Object.values(state.orders).filter(order => order.status === 'confirmed').length, 2);

  await fill('#order-query', confirmedId); await fill('#order-status', ''); await submit('#orders-filter-form');
  await check("document.querySelector('#orders-count').textContent.includes('1 笔') && document.querySelector('#orders-list').textContent.includes('已确认，收款只读')", 'query finds immutable confirmed receipt');
  assert.equal(await evaluate('window.commerceXss'), undefined);
  await evaluate("document.querySelector('#notice').hidden = true; window.scrollTo(0, 0)"); await pause(100);
  await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(temporary, 'commerce-desktop.png'), image.toPNG()));
  win.setSize(390, 844); await pause(100);
  await evaluate('window.scrollTo(0, 0)'); await pause(100);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'mobile page has no horizontal overflow');
  assert.equal(await evaluate("document.querySelectorAll('#panel-orders [hidden]').length > 0"), true);
  await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(temporary, 'commerce-mobile.png'), image.toPNG()));
  await click('#logout'); await check("document.querySelector('#workspace').hidden", 'logout');
  assert.equal(await evaluate("document.querySelector('#orders-list').textContent"), '', 'logout clears receipt data');
  assert.equal(await evaluate("document.querySelector('#revenue-summary').textContent"), '', 'logout clears revenue data');
  assert.deepEqual(errors, [], 'renderer has no console errors');
  console.log(JSON.stringify({ ok: true, checks: ['server pagination and page jump', 'query/status/date filters', 'Shanghai receipt dates', 'actual receipt revenue', 'selected-plan issue automatically adds income without reconfirmation', 'historic selected-plan receipts automatically counted', 'direct membership still requires confirmation and manual receipt', 'link merges automatic receipt without duplicate income', 'durable code-link retry and audit once', 'durable uncertain-write retry', 'duplicate payment rejection', 'audit once', 'receipt does not change membership', 'escaped text', 'mobile layout', 'session cleanup'], screenshots: temporary }, null, 2));
  await finish(0);
}).catch(error => finish(1, error));
