// Real desktop renderer with an isolated bridge fixture; never contacts accounts,
// GitHub or email services. Run: npm run desktop:verify:feedback
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-feedback-ui-'));
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
app.setPath('userData', path.join(temporary, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let win;
let finished = false;
const timeout = setTimeout(() => finish(1, new Error('FEEDBACK_UI_TIMEOUT')), 45_000);
function finish(code, error) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(code);
}

const fixture = `
const at = '2026-09-28T08:00:00.000Z';
window.fixtureAccount = { authenticated: true, verified: true, status: 'ready', account: { user: { id: 'user-a', email: 'member@example.test' }, membership: { type: 'none', active: false }, device: { status: 'revoked' } } };
window.fixtureCalls = [];
window.fixtureMessages = [{ id: 'message-admin', authorRole: 'admin', authorId: 'admin', content: '  已查看问题。\\n请重试 <img src=x onerror=alert(1)> 并告诉我们结果。  ', createdAt: at }];
window.fixtureFeedback = { id: 'feedback-a', userId: 'user-a', title: '视频下载后没有声音', description: '  操作步骤：下载后播放。\\n提示：<script>alert(1)</script>，邮箱 member@example.test。  ', status: 'in_progress', category: 'audio', createdAt: at, updatedAt: at, submittedAt: at, replyCount: 1, lastMessageAt: at, lastMessageRole: 'admin', appVersion: '1.8.16', platform: 'darwin', arch: 'arm64' };
window.fixtureSetAccount = value => { window.fixtureAccount = value; window.fixtureAccountUpdate?.(value); };
window.fixtureGate = null;
window.fixtureFailReply = false;
window.fixtureReplies = new Map();
window.xhsDesktop = {
  getInfo: async () => ({ version: '1.8.16', platform: 'darwin', arch: 'arm64' }),
  getProfileState: async () => ({ status: 'idle', items: [] }),
  onProfileUpdate: () => () => {},
  getAccountState: async () => structuredClone(window.fixtureAccount),
  onAccountUpdate: callback => { window.fixtureAccountUpdate = callback; return () => {}; },
  getDiagnosticsInfo: async () => ({ fileCount: 1, totalBytes: 120, oldestAt: at, newestAt: at }),
  getFeedbackState: async () => ({ status: 'idle' }),
  onFeedbackState: () => () => {},
  submitFeedback: async input => { window.fixtureCalls.push(['submit', input]); return { ok: true, feedbackId: 'feedback-a' }; },
  listFeedback: async () => {
    window.fixtureCalls.push(['list']);
    const result = { ok: true, feedbacks: window.fixtureAccount.account?.user?.id === 'user-a' ? [structuredClone(window.fixtureFeedback)] : [], total: window.fixtureAccount.account?.user?.id === 'user-a' ? 1 : 0 };
    if (window.fixtureGate === 'list') { window.fixtureGate = null; await new Promise(resolve => { window.fixtureRelease = resolve; }); }
    return result;
  },
  getFeedbackDetail: async feedbackId => {
    window.fixtureCalls.push(['detail', feedbackId]);
    if (window.fixtureFailDetail) { window.fixtureFailDetail = false; return { ok: false, error: { message: '对话读取暂时不可用。' } }; }
    const result = { ok: true, feedback: structuredClone(window.fixtureFeedback), messages: structuredClone(window.fixtureMessages) };
    if (window.fixtureGate === 'detail') { window.fixtureGate = null; await new Promise(resolve => { window.fixtureRelease = resolve; }); }
    return result;
  },
  replyFeedback: async input => {
    window.fixtureCalls.push(['reply', structuredClone(input)]);
    let message = window.fixtureReplies.get(input.requestId);
    const replayed = Boolean(message);
    if (!message) {
      message = { id: input.requestId, authorRole: 'user', authorId: 'user-a', content: input.content, createdAt: at };
      window.fixtureReplies.set(input.requestId, message); window.fixtureMessages.push(message);
    }
    window.fixtureFeedback.replyCount = window.fixtureMessages.length;
    window.fixtureFeedback.lastMessageRole = 'user';
    if (window.fixtureFailReply) { window.fixtureFailReply = false; return { ok: false, error: { code: 'STORAGE_WRITE_UNCERTAIN', message: '写入结果尚未确认，请重试。' } }; }
    return { ok: true, feedback: structuredClone(window.fixtureFeedback), message, replayed };
  }
};
`;

app.whenReady().then(async () => {
  const { createProtocolHandler } = await import(pathToFileURL(path.join(root, 'desktop/protocol.js')).href);
  const handler = createProtocolHandler({ rootDirectory: root });
  protocol.handle('xhs-app', async request => {
    const url = new URL(request.url);
    if (url.pathname === '/feedback-fixture.js') return new Response(fixture, { headers: { 'content-type': 'text/javascript' } });
    if (url.pathname === '/feedback-init.js') return new Response(`import { initializeDesktopUI } from '/desktop-ui.js'; await initializeDesktopUI();`, { headers: { 'content-type': 'text/javascript' } });
    const response = await handler(request);
    if (url.pathname !== '/') return response;
    let html = await response.text();
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/feedback-fixture.js"></script><script type="module" src="/feedback-init.js"></script></body>');
    return new Response(html, { headers: response.headers });
  });
  win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('xhs-app://local/') && !details.url.startsWith('data:') }));
  const rendererErrors = [];
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) rendererErrors.push(details.message); });
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const check = (condition, label) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { if (${condition}) resolve(); else if (Date.now() - start > 5000) reject(new Error(${JSON.stringify(label)})); else setTimeout(tick, 20); }; tick(); })`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const capture = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await win.loadURL('xhs-app://local/');
  await check(`document.body.dataset.desktopReady === 'true'`, 'desktop UI initialized');
  await click('#feedback-tab');
  await check(`document.querySelectorAll('.desktop-feedback-list-item').length === 1`, 'own feedback loads without membership');
  await click('.desktop-feedback-list-item');
  await check(`document.querySelector('#desktop-feedback-detail').textContent.includes('已查看问题')`, 'administrator reply is visible');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-detail').textContent.includes(window.fixtureFeedback.description)`), true, 'initial question keeps all text');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-detail').textContent.includes(window.fixtureMessages[0].content)`), true, 'administrator reply keeps all text');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-detail img, #desktop-feedback-detail script') !== null`), false, 'conversation text is never HTML');

  const content = '  回复原文：已经再次尝试。\n仍出现相同提示 <img src=x onerror=alert(1)>。\n  ';
  await fill('#desktop-feedback-reply', content);
  await evaluate('window.fixtureFailReply = true');
  await click('#desktop-feedback-reply-submit');
  await check(`!document.querySelector('#desktop-feedback-reply-submit').disabled`, 'failed reply can be retried');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-reply').value`), content, 'uncertain send retains the entire draft');
  await click('#desktop-feedback-reply-submit');
  await check(`document.querySelector('#desktop-feedback-reply').value === ''`, 'confirmed send clears composer');
  const replies = await evaluate(`window.fixtureCalls.filter(call => call[0] === 'reply')`);
  assert.equal(replies.length, 2);
  assert.equal(replies[0][1].requestId, replies[1][1].requestId, 'retry reuses the original request id');
  assert.equal(replies[1][1].content, content, 'reply sends exact content');
  assert.equal(await evaluate('window.fixtureReplies.size'), 1, 'uncertain retry never creates another message');
  await click('#desktop-feedback-thread-refresh');
  await check(`document.querySelector('#desktop-feedback-detail').textContent.includes('回复原文')`, 'reloaded thread contains both sides');
  await fill('#desktop-feedback-reply', '已确认保存但随后刷新失败的回复');
  await evaluate('window.fixtureFailDetail = true');
  await click('#desktop-feedback-reply-submit');
  await check(`document.querySelector('#desktop-feedback-thread-status').textContent.includes('回复已保存')`, 'saved reply remains explicitly confirmed when refreshing fails');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-messages').textContent.includes('已确认保存但随后刷新失败的回复')`), true, 'confirmed reply remains visible despite read failure');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-reply').value`), '');
  await click('#desktop-feedback-thread-refresh');
  await check(`document.querySelectorAll('[data-message-id]').length === 3`, 'thread refresh deduplicates the confirmed message');
  await evaluate(`document.querySelector('#desktop-feedback-detail').scrollIntoView({ block: 'start' })`);
  await capture('feedback-desktop');
  win.setSize(560, 900);
  await capture('feedback-narrow');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'feedback fits narrow viewport');

  await fill('#desktop-feedback-reply', '不得保留到另一个账号的草稿');
  await evaluate(`window.fixtureGate = 'detail'`);
  await click('#desktop-feedback-thread-refresh');
  await check(`typeof window.fixtureRelease === 'function'`, 'detail request in flight');
  await evaluate(`window.fixtureSetAccount({ authenticated: false, verified: false, status: 'logged_out', account: null }); window.fixtureRelease(); window.fixtureRelease = null;`);
  await check(`!document.querySelector('#desktop-feedback-detail').textContent.includes('已查看问题')`, 'logout clears private conversation');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-list').textContent.includes('视频下载后没有声音')`), false, 'logout clears prior list');
  await evaluate(`window.fixtureSetAccount({ authenticated: true, verified: true, account: { user: { id: 'user-b', email: 'other@example.test' }, membership: { active: false } } });`);
  await check(`document.querySelectorAll('.desktop-feedback-list-item').length === 0`, 'other account cannot see previous feedback');
  assert.equal(await evaluate(`document.querySelector('#desktop-feedback-page').textContent.includes('不得保留到另一个账号的草稿')`), false);
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ ok: true, checks: ['owner-list', 'admin-reply', 'raw-text', 'safe-html', 'reply-retry', 'saved-with-refresh-failure', 'reload', 'narrow-layout', 'logout-race', 'account-switch'], screenshots }));
  finish(0);
}).catch(error => finish(1, error));
