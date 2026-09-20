// Local integration check: real renderer, HTTPS boundary, account service and GitHub
// adapter. GitHub HTTP and SMTP are fixtures; no real accounts or services are used.
// Run from the repository root: npx electron scripts/verify-admin-ui.cjs
// Requires OpenSSL on PATH. Certificate trust is overridden only for 127.0.0.1 here.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:https');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'xhs-admin-integration-'));
const profile = path.join(temporary, 'profile');
const screenshots = path.join(temporary, 'screenshots');
const keyFile = path.join(temporary, 'fixture-key.pem');
const certificateFile = path.join(temporary, 'fixture-cert.pem');
fs.mkdirSync(screenshots);
app.setPath('userData', profile);
let win;
let server;
let finishing = false;
const timer = setTimeout(() => finish(1, new Error('ADMIN_UI_INTEGRATION_TIMEOUT')), 45_000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = relative => pathToFileURL(path.join(root, relative)).href;

async function finish(code, error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) {
    // The browser partition is in memory; clearing it also removes fixture cookies.
    await win.webContents.session.clearStorageData().catch(() => {});
    win.destroy();
  }
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  for (const file of [keyFile, certificateFile]) fs.rmSync(file, { force: true });
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { console.warn(`Fixture profile cleanup was incomplete: ${profile}`); }
  app.exit(code);
}

app.whenReady().then(async () => {
  const certificate = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certificateFile,
    '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  assert.equal(certificate.status, 0, 'OpenSSL must be installed and available on PATH');
  const { GithubStateStore, emptyState } = await import(source('server/auth/store.js'));
  const { createAccountService } = await import(source('server/auth/service.js'));
  const { readConfig } = await import(source('server/auth/config.js'));
  const { createAccountHandler, ADMIN_COOKIE } = await import(source('api/account.js'));
  let state = emptyState();
  let version = 1;
  const now = Date.parse('2026-09-20T10:00:00.000Z');
  const date = new Date(now).toISOString();
  const digest = value => createHash('sha256').update(value).digest('hex');
  const feedbackId = '12345678-1234-1234-1234-123456789012';
  const logParts = [0, 1].map(part => Array.from({ length: 100 }, (_, index) => JSON.stringify({ at: date, level: 'info', event: 'download.fixture', details: { sequence: part * 100 + index, message: '保留完整诊断记录' } })).join('\n') + '\n');
  const logContent = logParts.join('');
  const logFiles = new Map(logParts.map((content, index) => [`feedback/${feedbackId}/part-${String(index).padStart(3, '0')}.ndjson`, content]));
  state.feedback[feedbackId] = {
    id: feedbackId, userId: 'u1', title: '<img src=x onerror=alert(1)> 下载问题', description: '完整问题说明：视频下载后检查本地播放。', category: 'audio', appVersion: '1.7.3', platform: 'darwin', arch: 'arm64',
    status: 'new', createdAt: date, updatedAt: date, submittedAt: date,
    log: { partCount: 2, totalBytes: Buffer.byteLength(logContent), sha256: digest(logContent), firstTimestamp: date, lastTimestamp: date, truncated: true, parts: logParts.map(content => ({ bytes: Buffer.byteLength(content), sha256: digest(content) })) },
  };
  const incompleteId = '12345678-1234-1234-1234-123456789013';
  state.feedback[incompleteId] = { ...state.feedback[feedbackId], id: incompleteId, title: '尚未上传完的反馈', status: 'uploading', submittedAt: null };
  state.users.u1 = {
    id: 'u1', email: 'student@example.test', role: 'user', createdAt: date,
    membership: { type: 'none', startsAt: null, expiresAt: null },
  };
  state.devices.d1 = {
    id: 'd1', userId: 'u1', keyFingerprint: 'old-key-fingerprint',
    name: 'MacBook Air', platform: 'darwin', status: 'active', boundAt: date, lastCheckedAt: date,
  };
  state.sessions.pending = {
    id: 'pending-session-id', userId: 'u1', client: 'desktop', createdAt: date,
    revokedAt: null, deviceId: null, deviceStatus: 'revoked',
    publicKey: 'fixture-public-key-must-not-render',
    pendingDevice: {
      keyFingerprint: 'new-key-fingerprint', stableIdHash: 'fixture-hardware-digest',
      publicKey: 'fixture-public-key-must-not-render', name: 'MacBook Air reinstall', platform: 'darwin',
    },
  };
  const deliveries = [];
  const mailer = {
    provider: 'smtp', configured: true,
    async send(message) { deliveries.push(message); },
    async check() { return { status: 'unavailable', message: 'Fixture SMTP unavailable' }; },
  };
  const store = new GithubStateStore({
    owner: 'fixture', repo: 'private', token: 'fixture', delay: async () => {},
    fetchImpl: async (url, options) => {
      if (!url.includes('/contents/')) return Response.json({ private: true });
      if (url.includes('/contents/feedback/')) {
        const pathname = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
        const content = logFiles.get(pathname);
        assert.equal(options.method, 'GET', 'admin reads cannot write diagnostic blobs');
        if (content === undefined) return Response.json({}, { status: 404 });
        return Response.json({ sha: digest(content), encoding: 'base64', content: Buffer.from(content).toString('base64') });
      }
      if (options.method === 'GET') return Response.json({
        sha: String(version), encoding: 'base64',
        content: Buffer.from(JSON.stringify(state)).toString('base64'),
      });
      const body = JSON.parse(options.body);
      if (body.sha !== String(version)) return Response.json({}, { status: 409 });
      state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      version += 1;
      return Response.json({ content: { sha: String(version) } });
    },
  });
  const config = readConfig({
    AUTH_SECRET_PEPPER: 'integration-fixture-only-'.repeat(3),
    AUTH_ADMIN_EMAILS: 'admin@example.test',
  });
  const service = createAccountService({ store, mailer, config, now: () => now });
  let handler;
  const calls = [];
  const tlsOptions = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certificateFile) };
  // Delete test TLS material as soon as Node has loaded it into memory.
  fs.rmSync(keyFile);
  fs.rmSync(certificateFile);
  server = createServer(tlsOptions, (req, res) => {
    if (req.url === '/api/account') {
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', async () => {
        try {
          req.body = JSON.parse(text);
          calls.push(req.body);
          res.status = code => { res.statusCode = code; return res; };
          res.json = body => res.end(JSON.stringify(body));
          await handler(req, res);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: { message: 'Fixture HTTP failure' } }));
        }
      });
      return;
    }
    const file = req.url === '/admin/' ? 'admin/index.html' : req.url.replace(/^\//, '');
    if (!['admin/index.html', 'admin/admin.js', 'admin/admin.css'].includes(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.siteOrigin = `https://127.0.0.1:${server.address().port}`;
  handler = createAccountHandler({ service, config, now: () => now });
  win = new BrowserWindow({
    show: false, width: 1280, height: 1000,
    webPreferences: {
      partition: `admin-ui-fixture-${process.pid}`, // No persist: prefix; fixture cookies stay in memory.
      sandbox: true, nodeIntegration: false, contextIsolation: true,
      backgroundThrottling: false, offscreen: true,
    },
  });
  win.webContents.session.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === '127.0.0.1' ? 0 : -3);
  });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    callback({ cancel: new URL(details.url).origin !== config.siteOrigin });
  });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  async function check(expression, label) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(`!!(${expression})`)) return;
      await pause(20);
    }
    const notice = await evaluate(`document.querySelector('#notice')?.textContent || ''`);
    throw new Error(`Admin UI check failed: ${label}; notice: ${notice}`);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
  const change = (selector, value) => evaluate(`
    document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};
    document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }));
  `);
  async function member(operation, reason, days) {
    await change('#membership-operation', operation);
    if (days !== undefined) await fill('#membership-days', String(days));
    await fill('#membership-reason', reason);
    await click('.membership-form button');
    await check(`document.querySelector('#action-dialog').open`, 'membership confirmation');
    await click('#dialog-confirm');
    await check(`!document.querySelector('#action-dialog').open && document.querySelector('#notice').textContent.includes('会员权益已更新')`, 'membership saved');
    // Wait for the new detail form to replace the submitting form.
    await check(`document.querySelector('#membership-reason').value === ''`, 'membership detail refreshed');
  }

  await win.loadURL(`${config.siteOrigin}/admin/`);
  await check(`document.querySelector('#notice').hidden`, 'expected initial account-required error stays quiet');
  await fill('#login-email', 'admin@example.test');
  await click('#send-code');
  await check(`document.querySelector('#send-code').disabled`, 'sending disables the button');
  for (let attempt = 0; attempt < 100 && !deliveries.length; attempt += 1) await pause(20);
  assert.equal(deliveries.length, 1);
  await fill('#login-code', deliveries[0].code);
  await click('#login-submit');
  await check(`!document.querySelector('#workspace').hidden && document.querySelectorAll('.user-item').length === 2`, 'actual admin login');
  const cookies = await win.webContents.session.cookies.get({ url: config.siteOrigin, name: ADMIN_COOKIE });
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].secure, true);
  assert.equal(await evaluate('document.cookie'), '', 'JavaScript cannot read the session cookie');
  await new Promise(resolve => {
    win.webContents.once('did-finish-load', resolve);
    win.reload();
  });
  await check(`!document.querySelector('#workspace').hidden && document.querySelectorAll('.user-item').length === 2`, 'cookie persists across page reload');
  await evaluate(`Array.from(document.querySelectorAll('.user-item')).find(item => item.textContent.includes('student@example.test')).click()`);
  await check(`document.querySelector('#membership-operation')`, 'actual user details');
  await member('days', '测试开通三十天', 30);
  assert.equal(state.users.u1.membership.expiresAt, '2026-10-20T10:00:00.000Z');
  await member('adjust', '测试缩短五天', -5);
  assert.equal(state.users.u1.membership.expiresAt, '2026-10-15T10:00:00.000Z');
  await member('permanent', '测试开通永久');
  assert.equal(state.users.u1.membership.type, 'permanent');
  await member('cancel', '测试取消会员');
  assert.equal(state.users.u1.membership.type, 'none');
  await check(`document.querySelector('.pending-device-table button')`, 'pending new key is listed');
  assert.equal(await evaluate(`document.body.textContent.includes('fixture-public-key-must-not-render')`), false, 'public key is not rendered');
  await click('.pending-device-table button');
  await fill('#dialog-reason', '测试满额拒绝恢复');
  await click('#dialog-confirm');
  await check(`document.querySelector('#notice').textContent.includes('设备名额已满')`, 'restore cannot bypass device limit');
  assert.equal(Object.keys(state.devices).length, 1);
  await click('.device-table button');
  await fill('#dialog-reason', '测试管理员换机解绑');
  await click('#dialog-confirm');
  await check(`document.querySelector('.device-table').textContent.includes('已撤销')`, 'actual unbind');
  assert.equal(state.devices.d1.status, 'revoked');
  await click('.pending-device-table button');
  await fill('#dialog-reason', '核对用户后恢复所选新密钥');
  await click('#dialog-confirm');
  await check(`document.querySelector('.pending-device-section').textContent.includes('暂无可恢复')`, 'restored new key leaves pending list');
  assert.equal(state.devices.d1.status, 'revoked', 'old key tombstone survives restoration');
  assert.equal(Object.values(state.devices).filter(device => device.status === 'active').length, 1);
  assert.equal(state.sessions.pending.deviceStatus, 'authorized');
  assert.equal(state.sessions.pending.pendingDevice, undefined);
  await click('#tab-codes');
  await fill('#code-reason', '测试生成三枚时长码');
  await fill('#code-count', '3');
  await click('#generate-form button');
  await check(`document.querySelector('#generated-raw').value.split('\\n').length === 3`, 'three actual activation codes generated');
  const raw = await evaluate(`document.querySelector('#generated-raw').value.split('\\n')[0]`);
  assert.match(raw, /^XHS-[A-F0-9]{40}$/);
  assert.equal(JSON.stringify(state).includes(raw), false, 'persistent state never contains raw activation code');
  await click('.codes-table button');
  await fill('#dialog-reason', '测试作废未兑换激活码');
  await click('#dialog-confirm');
  await check(`document.querySelector('.codes-table').textContent.includes('已作废')`, 'actual code invalidation');
  assert.equal(Object.values(state.codes).filter(code => code.status === 'void').length, 1);
  await change('#code-status', 'void');
  await click('#codes-filter-form button');
  await check(`document.querySelectorAll('.codes-table tbody tr').length === 1`, 'server filters code status');
  await click('#tab-audit');
  await check(`document.querySelectorAll('.audit-table tbody tr').length === 8`, 'eight successful mutations have audit entries');
  await click('#tab-feedback');
  await check(`document.querySelectorAll('.feedback-list-item').length === 2`, 'complete and incomplete feedback visible');
  await evaluate(`Array.from(document.querySelectorAll('.feedback-list-item')).find(item => item.textContent.includes('尚未上传')).click()`);
  await check(`document.querySelector('.feedback-log-section button')?.disabled`, 'incomplete feedback cannot be copied or downloaded');
  await evaluate(`Array.from(document.querySelectorAll('.feedback-list-item')).find(item => item.textContent.includes('下载问题')).click()`);
  await check(`document.querySelector('#feedback-detail h2')?.textContent.includes('下载问题') && document.querySelector('.feedback-log-section button')?.disabled === false`, 'feedback description loaded');
  assert.equal(await evaluate(`document.querySelector('#feedback-detail img') !== null`), false, 'feedback renders user text safely');
  await click('.feedback-log-section button');
  await check(`document.querySelector('.feedback-log-preview')?.hidden === false`, 'complete log preview loaded');
  assert.equal(await evaluate(`document.querySelector('.feedback-log-preview').textContent`), logContent, 'every retained row is visible');
  await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.fixtureCopiedReport = text; } })`);
  await click('.feedback-log-section button:nth-child(2)');
  await check(`window.fixtureCopiedReport?.includes('完整脱敏日志')`, 'one action copies report');
  const copied = await evaluate('window.fixtureCopiedReport');
  assert.ok(copied.includes(state.feedback[feedbackId].description));
  assert.ok(copied.endsWith(logContent), 'copied report includes entire NDJSON, not a preview');
  for (const [position, extension] of [[3, 'ndjson'], [4, 'txt']]) {
    const download = new Promise((resolve, reject) => win.webContents.session.once('will-download', (event, item) => {
      const filename = path.join(temporary, item.getFilename()); item.setSavePath(filename);
      item.once('done', (ignored, status) => status === 'completed' ? resolve(filename) : reject(new Error(`Log download ${status}`)));
    }));
    await click(`.feedback-log-section button:nth-child(${position})`);
    const file = await download;
    assert.ok(file.endsWith(`.${extension}`));
    const output = fs.readFileSync(file, 'utf8');
    if (extension === 'ndjson') assert.equal(output, logContent);
    else { assert.ok(output.includes('"sequence":0')); assert.ok(output.includes('"sequence":199')); }
  }
  await change('.feedback-status-form select', 'resolved'); await click('.feedback-status-form button');
  await check(`document.querySelector('#action-dialog').open`, 'feedback status requires reason');
  await fill('#dialog-reason', '复核日志并完成问题修复'); await click('#dialog-confirm');
  await check(`document.querySelector('#notice').textContent.includes('反馈处理状态已保存')`, 'feedback state mutation confirmed');
  assert.equal(state.feedback[feedbackId].status, 'resolved');
  assert.equal(state.audit.at(-1).action, 'admin-feedback-status');
  assert.equal(state.audit.at(-1).reason, '复核日志并完成问题修复');
  await change('#feedback-status-filter', 'resolved'); await click('#feedback-filter-form button');
  await check(`document.querySelectorAll('.feedback-list-item').length === 1`, 'feedback server status filter');
  fs.writeFileSync(path.join(screenshots, 'feedback.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(560, 1000); await pause(80);
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), 'feedback page fits narrow display');
  fs.writeFileSync(path.join(screenshots, 'feedback-narrow.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1280, 1000);
  await click('#tab-status');
  await check(`document.querySelector('#status-content').textContent.includes('连接或认证失败')`, 'configured but unavailable SMTP is visibly unsuccessful');
  fs.writeFileSync(path.join(screenshots, 'status.png'), (await win.webContents.capturePage()).toPNG());
  await click('#tab-codes');
  await click('#dismiss-codes');
  await click('#dialog-confirm');
  await click('#logout');
  await check(`document.querySelector('#workspace').hidden`, 'actual logout');
  assert.equal(await evaluate(`document.querySelector('#feedback-detail').textContent`), '', 'logout clears retained feedback and logs from the document');
  assert.equal(Object.values(state.sessions).filter(session => session.client === 'admin').every(session => session.revokedAt), true);
  assert.equal((await win.webContents.session.cookies.get({ url: config.siteOrigin, name: ADMIN_COOKIE })).length, 0);
  assert.equal(await evaluate('localStorage.length'), 0, 'no credential localStorage');
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log(JSON.stringify({
    result: 'PASS',
    scope: 'real renderer + HTTPS handler + account service + GithubStateStore; mock GitHub HTTP and SMTP',
    calls: calls.length, stateWrites: version - 1, screenshots,
  }));
  await finish(0);
}).catch(error => finish(1, error));
