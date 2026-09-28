// Real public-page renderer against a local HTTP fixture. No production API,
// GitHub, email, or browser profile is used. Run: electron scripts/verify-public-feedback-ui.cjs
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-public-feedback-ui-'));
const profile = path.join(temporary, 'profile');
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
app.setPath('userData', profile);
let win, server, origin;
let finished = false;
const timeout = setTimeout(() => void finish(1, new Error('PUBLIC_FEEDBACK_UI_TIMEOUT')), 90_000);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function finish(code, error) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) {
    await win.webContents.session.clearStorageData().catch(() => {});
    win.destroy();
  }
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { console.warn(`Fixture profile cleanup incomplete: ${profile}`); }
  app.exit(code);
}

const id = number => `12345678-1234-1234-1234-${String(number).padStart(12, '0')}`;
const firstId = id(1), secondId = id(2);
const at = '2026-09-28T12:00:00.000Z';
const originalComment = '  我也遇到了这个问题。\n<img src=x onerror="window.fixtureXss=true">  ';
const privateReply = 'PRIVATE-OWNER-ONLY：\n请用账号 owner@example.test 再试。<img src=x onerror="window.fixtureXss=true">';
const comments = new Map([[firstId, [{ id: 'comment-initial', authorRole: 'user', content: originalComment, createdAt: at }]]]);
const messages = new Map([[firstId, [{ id: 'private-initial', authorRole: 'admin', authorId: 'admin-fixture', content: privateReply, createdAt: at }]]]);
const issues = Array.from({ length: 26 }, (_, index) => ({
  id: id(index + 1), title: index === 0 ? '<img src=x onerror="window.fixtureXss=true"> 视频没有声音' : `问题记录 ${index + 1}`,
  description: index === 0 ? '公开问题说明：视频没有声音。\n<script>window.fixtureXss=true</script>' : `公开问题说明 ${index + 1}`,
  category: index % 2 === 0 ? 'audio' : 'download', status: index === 25 ? 'closed' : index % 3 === 0 ? 'resolved' : index % 3 === 1 ? 'new' : 'in_progress',
  createdAt: at, updatedAt: new Date(Date.parse(at) - index * 1000).toISOString(), submittedAt: at, commentCount: index === 0 ? 1 : 0,
}));
const calls = [];
const sessions = new Map();
const commentRequests = new Map(), replyRequests = new Map();
const failures = new Map();
const gates = [];
const checks = [];
const failNext = (action, afterCommit = false) => failures.set(action, { afterCommit });
function gateNext(action, feedbackId) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const gate = { action, feedbackId, promise, release, started: false };
  gates.push(gate); return gate;
}
const fixtureError = (message, status = 503, code = 'FIXTURE_UNAVAILABLE') => ({ status, body: { ok: false, error: { code, message }, serverTime: at } });
const success = value => ({ status: 200, body: { ok: true, ...value, serverTime: at } });
function account(userId) {
  return { user: { id: userId, email: userId === 'owner' ? 'owner@example.test' : 'viewer@example.test', role: 'user' }, membership: { type: 'none', active: false }, device: { status: 'unbound' }, features: {}, serverTime: at };
}
function privateFeedback(issue) {
  return { ...issue, title: 'PRIVATE-TITLE-OWNER-ONLY', userId: 'owner', email: 'owner@example.test', description: 'PRIVATE-ORIGINAL-OWNER-ONLY', log: { totalBytes: 10 } };
}
function page(items, input) {
  const number = input.page || 1, pageSize = input.pageSize || 20;
  return { items: items.slice((number - 1) * pageSize, number * pageSize), total: items.length, page: number, pageSize, totalPages: Math.ceil(items.length / pageSize) };
}
function route({ action, input = {} }, request) {
  const sessionKey = request.headers.cookie?.match(/(?:^|;\s*)fixture-browser=([^;]+)/)?.[1];
  const userId = sessions.get(sessionKey);
  const issue = issues.find(item => item.id === input.feedbackId);
  if (['send-code', 'verify-code', 'me', 'logout'].includes(action)) assert.equal(input.client, 'browser', 'public page always selects browser authentication');
  if (action === 'send-code') return success({ retryAfterSeconds: 1, expiresInSeconds: 300, message: '验证码已发送。' });
  if (action === 'verify-code') {
    assert.equal(input.code, '123456');
    const loginUser = input.email === 'owner@example.test' ? 'owner' : 'viewer';
    const key = `session-${sessions.size + 1}-${loginUser}`; sessions.set(key, loginUser);
    return { ...success({ account: account(loginUser) }), cookie: `fixture-browser=${key}; Path=/; HttpOnly; SameSite=Strict` };
  }
  if (action === 'me') return userId ? success({ account: account(userId) }) : fixtureError('请先登录。', 401, 'ACCOUNT_REQUIRED');
  if (action === 'logout') { sessions.delete(sessionKey); return { ...success({ loggedOut: true }), cookie: 'fixture-browser=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' }; }
  if (action === 'feedback-public-list') {
    const filtered = issues.filter(item => (!input.status || input.status === 'all' || (input.status === 'unresolved' ? ['new', 'in_progress'].includes(item.status) : item.status === input.status)) && (!input.category || item.category === input.category) && (!input.query || `${item.title}\n${item.description}`.includes(input.query)));
    const { items, ...meta } = page(filtered, input);
    const counts = { all: issues.length, new: 0, in_progress: 0, resolved: 0, closed: 0 };
    for (const item of issues) counts[item.status] += 1;
    counts.unresolved = counts.new + counts.in_progress;
    return success({ feedbacks: items, ...meta, counts });
  }
  if (!issue) return fixtureError('没有找到该反馈。', 404, 'FEEDBACK_NOT_FOUND');
  if (action === 'feedback-public-detail') {
    const { items, ...meta } = page(comments.get(issue.id) || [], input);
    return success({ feedback: issue, comments: items, ...meta });
  }
  if (action === 'feedback-owner-detail') {
    if (!userId) return fixtureError('请先登录。', 401, 'ACCOUNT_REQUIRED');
    if (userId !== 'owner' || issue.id !== firstId) return fixtureError('没有找到该反馈。', 404, 'FEEDBACK_NOT_FOUND');
    return success({ feedback: privateFeedback(issue), messages: messages.get(issue.id) || [] });
  }
  if (action === 'feedback-public-comment' || action === 'feedback-owner-reply') {
    const isPrivate = action === 'feedback-owner-reply';
    assert.deepEqual(Object.keys(input).sort(), isPrivate ? ['content', 'feedbackId', 'requestId'] : ['content', 'expectedUserId', 'feedbackId', 'requestId'], 'only authored content, request identity, and public account precondition travel in the message');
    if (!userId) return fixtureError('请先登录。', 401, 'ACCOUNT_REQUIRED');
    if (!isPrivate && input.expectedUserId !== userId) return fixtureError('当前登录账号已变化，请确认账号后重试。', 409, 'ACCOUNT_CHANGED');
    if (isPrivate && (userId !== 'owner' || issue.id !== firstId)) return fixtureError('没有找到该反馈。', 404, 'FEEDBACK_NOT_FOUND');
    const requests = isPrivate ? replyRequests : commentRequests;
    const key = `${userId}:${input.requestId}`;
    const prior = requests.get(key);
    if (prior) {
      assert.equal(prior.feedbackId, input.feedbackId); assert.equal(prior.content, input.content);
      return success({ feedback: isPrivate ? privateFeedback(issue) : issue, [isPrivate ? 'message' : 'comment']: prior.message, replayed: true });
    }
    const message = { id: `${isPrivate ? 'reply' : 'comment'}-${requests.size + 1}`, authorRole: 'user', content: input.content, createdAt: at, ...(isPrivate ? { authorId: userId } : {}) };
    requests.set(key, { feedbackId: input.feedbackId, content: input.content, message });
    const collection = isPrivate ? messages : comments;
    if (!collection.has(issue.id)) collection.set(issue.id, []);
    collection.get(issue.id).push(message);
    if (!isPrivate) issue.commentCount = collection.get(issue.id).length;
    return success({ feedback: isPrivate ? privateFeedback(issue) : issue, [isPrivate ? 'message' : 'comment']: message, replayed: false });
  }
  return fixtureError(`Unexpected fixture action: ${action}`, 400, 'UNKNOWN_ACTION');
}

app.whenReady().then(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/api/account') {
      let text = '';
      request.on('data', chunk => { text += chunk; });
      request.on('end', async () => {
        try {
          const body = JSON.parse(text); calls.push(structuredClone(body));
          const failure = failures.get(body.action);
          if (failure) failures.delete(body.action);
          let result = failure && !failure.afterCommit ? fixtureError('读取暂时不可用，请重试。') : route(body, request);
          // Capture the response before delaying it, to reproduce stale authorized reads.
          if (failure?.afterCommit) result = fixtureError('写入结果尚未确认，请保留原文重试。', 503, 'STORAGE_WRITE_UNCERTAIN');
          const serialized = JSON.stringify(result.body);
          const gateIndex = gates.findIndex(gate => gate.action === body.action && (!gate.feedbackId || gate.feedbackId === body.input?.feedbackId));
          if (gateIndex !== -1) { const [gate] = gates.splice(gateIndex, 1); gate.started = true; await gate.promise; }
          if (response.destroyed) return;
          response.statusCode = result.status; response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
          if (result.cookie) response.setHeader('Set-Cookie', result.cookie);
          response.end(serialized);
        } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
      }); return;
    }
    const relative = url.pathname === '/' ? 'feedback.html' : url.pathname.replace(/^\//, '');
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`) || !/\.(?:html|css|js|svg|png|woff2?)$/.test(file) || !fs.existsSync(file)) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { partition: `public-feedback-fixture-${process.pid}`, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith('data:') }));
  const rendererErrors = [];
  win.webContents.on('console-message', event => {
    if (['error', 3].includes(event.level) && !/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(event.message)) rendererErrors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`Renderer exited: ${details.reason}`));
  const evaluate = expression => win.webContents.executeJavaScript(expression, true);
  async function check(expression, label) {
    for (let attempt = 0; attempt < 250; attempt += 1) { if (await evaluate(`Boolean(${expression})`)) return; await pause(20); }
    throw new Error(`Public feedback UI check failed: ${label}; body: ${(await evaluate('document.body.innerText')).slice(-4500)}`);
  }
  async function waitFor(predicate, label) {
    for (let attempt = 0; attempt < 250; attempt += 1) { if (predicate()) return; await pause(20); }
    assert.ok(predicate(), label);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const submit = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  async function capture(name) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  async function openIssue(feedbackId) {
    await click(`.feedback-issue-link[data-feedback-id="${feedbackId}"]`);
    await check(`!document.querySelector('#feedback-detail').hidden && document.querySelector('#feedback-detail-title').textContent === ${JSON.stringify(issues.find(item => item.id === feedbackId).title)}`, `open ${feedbackId}`);
  }
  async function login(email) {
    await click('#feedback-login-open');
    await check(`document.querySelector('#feedback-login-dialog').open`, 'login dialog opens');
    await fill('#feedback-login-email', email);
    await check(`!document.querySelector('#feedback-send-code').disabled`, 'code request available');
    const requested = calls.filter(call => call.action === 'send-code').length;
    await click('#feedback-send-code');
    await waitFor(() => calls.filter(call => call.action === 'send-code').length > requested && calls.filter(call => call.action === 'send-code').at(-1).input.email === email, 'fixture login code requested');
    await fill('#feedback-login-code', '123456'); await submit('#feedback-login-form');
    await check(`!document.querySelector('#feedback-login-dialog').open && !document.querySelector('#feedback-logout').hidden`, 'login completed');
  }

  await win.loadURL(`${origin}/feedback.html`);
  await check(`document.querySelectorAll('.feedback-issue-link').length === 20`, 'anonymous first page');
  assert.equal(await evaluate(`document.body.innerText.includes('PRIVATE-OWNER-ONLY')`), false, 'anonymous page never receives private messages');
  await click('[data-status-filter="unresolved"]');
  await waitFor(() => calls.filter(call => call.action === 'feedback-public-list').at(-1)?.input.status === 'unresolved', 'unresolved status sent');
  await check(`document.querySelectorAll('.feedback-issue-link').length === ${issues.filter(item => ['new', 'in_progress'].includes(item.status)).length}`, 'unresolved list filtered');
  await click('[data-status-filter="resolved"]');
  await check(`document.querySelectorAll('.feedback-issue-link').length === ${issues.filter(item => item.status === 'resolved').length}`, 'resolved list filtered');
  await click('[data-status-filter=""]');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 20`, 'all status restored');
  await click('#feedback-next');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 6`, 'next page');
  await click('#feedback-prev');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 20`, 'previous page');
  await fill('#feedback-search', '没有匹配的反馈'); await submit('#feedback-search-form');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 0`, 'empty search state');
  await fill('#feedback-search', ''); await submit('#feedback-search-form');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 20`, 'search reset');
  await fill('#feedback-category', 'audio'); await submit('#feedback-search-form');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 13`, 'category filter');
  await fill('#feedback-category', ''); await submit('#feedback-search-form');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 20`, 'category reset');
  failNext('feedback-public-list');
  await submit('#feedback-search-form');
  await check(`document.querySelector('#feedback-list-status').dataset.tone === 'error' && !document.querySelector('#feedback-list-retry').disabled`, 'list failure has retry');
  await click('#feedback-list-retry');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 20 && document.querySelector('#feedback-list-status').dataset.tone !== 'error'`, 'list retry recovers');
  checks.push('anonymous-list', 'status-filters', 'pagination', 'search-empty', 'category', 'error-retry');

  await openIssue(firstId);
  await check(`document.querySelectorAll('#feedback-public-comments .feedback-comment-content').length === 1`, 'public comments load');
  assert.equal(await evaluate(`document.querySelector('#feedback-detail-description').textContent`), issues[0].description);
  assert.equal(await evaluate(`document.querySelector('#feedback-public-comments .feedback-comment-content').textContent`), originalComment);
  assert.equal(await evaluate(`Boolean(document.querySelector('#feedback-detail img, #feedback-detail script')) || window.fixtureXss === true`), false, 'public content is rendered as text');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-section').hidden`), true, 'anonymous private section hidden');
  const deepLink = await evaluate('location.href');
  assert.notEqual(deepLink, `${origin}/feedback.html`, 'selected issue has shareable URL');
  await win.loadURL(deepLink);
  await check(`document.querySelector('#feedback-detail-title').textContent === ${JSON.stringify(issues[0].title)}`, 'deep link loads directly');
  checks.push('deep-link', 'safe-public-html');

  await login('viewer@example.test');
  await check(`!document.querySelector('#feedback-comment-submit').disabled`, 'nonmember can comment');
  await waitFor(() => calls.some(call => call.action === 'feedback-owner-detail'), 'owner permission checked separately');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-section').hidden`), true, 'nonowner cannot privately reply');
  await check(`!document.querySelector('#feedback-detail-refresh').disabled`, 'nonowner permission denial leaves public refresh available');
  const content = '  公开评论原文\n<script>window.fixtureXss=true</script>\n  ';
  await fill('#feedback-comment-content', content); failNext('feedback-public-comment', true);
  await submit('#feedback-comment-form');
  await check(`!document.querySelector('#feedback-comment-submit').disabled && document.querySelector('#feedback-comment-content').readOnly`, 'uncertain comment remains retryable');
  assert.equal(await evaluate(`document.querySelector('#feedback-comment-content').value`), content, 'uncertain comment retains draft');
  await submit('#feedback-comment-form');
  await check(`!document.querySelector('#feedback-comment-submit').disabled && document.querySelector('#feedback-comment-content').value === '' && document.querySelector('#feedback-public-comments').textContent.includes('公开评论原文')`, 'comment retry confirms saved text');
  const attempts = calls.filter(call => call.action === 'feedback-public-comment');
  assert.equal(attempts.length, 2); assert.equal(attempts[0].input.requestId, attempts[1].input.requestId); assert.equal(attempts[0].input.content, content);
  assert.equal(attempts[0].input.expectedUserId, 'viewer', 'public comment locks the account shown in the composer');
  assert.equal(commentRequests.size, 1, 'response loss never duplicates comment');
  assert.equal(messages.get(firstId).length, 1, 'comment never appends a private reply');
  await fill('#feedback-comment-content', '公开评论保存成功，随后刷新失败'); failNext('feedback-public-detail');
  await submit('#feedback-comment-form');
  await check(`!document.querySelector('#feedback-comment-submit').disabled && document.querySelector('#feedback-comment-content').value === '' && document.querySelector('#feedback-public-comments').textContent.includes('公开评论保存成功，随后刷新失败')`, 'confirmed comment survives failed refresh');
  await check(`document.querySelector('#feedback-comment-status').textContent.includes('已保存')`, 'confirmed comment remains explicitly saved after refresh failure');
  checks.push('nonmember-comment', 'nonowner-private-denied', 'comment-idempotency', 'comment-confirmed-refresh-failed');
  await click('#feedback-logout');
  await check(`document.querySelector('#feedback-logout').hidden`, 'viewer logout');

  await login('owner@example.test');
  await check(`!document.querySelector('#feedback-owner-section').hidden && document.querySelector('#feedback-owner-messages').textContent.includes('PRIVATE-OWNER-ONLY')`, 'owner sees private conversation');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-original-title').textContent`), 'PRIVATE-TITLE-OWNER-ONLY');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-original-description').textContent`), 'PRIVATE-ORIGINAL-OWNER-ONLY');
  assert.equal(await evaluate(`document.querySelector('#feedback-public-comments').textContent.includes('PRIVATE-OWNER-ONLY')`), false);
  const reply = '  PRIVATE-REPLY-EXACT\n<img src=x onerror="window.fixtureXss=true">  ';
  await fill('#feedback-owner-reply', reply); failNext('feedback-owner-reply', true);
  await submit('#feedback-owner-reply-form');
  await check(`!document.querySelector('#feedback-owner-reply-submit').disabled && document.querySelector('#feedback-owner-reply').readOnly`, 'uncertain owner reply remains retryable');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-reply').value`), reply);
  await submit('#feedback-owner-reply-form');
  await check(`!document.querySelector('#feedback-owner-reply-submit').disabled && document.querySelector('#feedback-owner-reply').value === '' && document.querySelector('#feedback-owner-messages').textContent.includes('PRIVATE-REPLY-EXACT')`, 'owner retry confirms reply');
  const replyAttempts = calls.filter(call => call.action === 'feedback-owner-reply');
  assert.equal(replyAttempts.length, 2); assert.equal(replyAttempts[0].input.requestId, replyAttempts[1].input.requestId); assert.equal(replyAttempts[0].input.content, reply);
  assert.equal(replyRequests.size, 1); assert.equal(commentRequests.size, 2);
  assert.equal(await evaluate(`Boolean(document.querySelector('#feedback-owner-messages img, #feedback-owner-messages script')) || window.fixtureXss === true`), false, 'private messages remain inert text');
  await fill('#feedback-owner-reply', 'PRIVATE-CONFIRMED-REFRESH-FAILED'); failNext('feedback-owner-detail');
  await submit('#feedback-owner-reply-form');
  await check(`!document.querySelector('#feedback-owner-reply-submit').disabled && document.querySelector('#feedback-owner-reply').value === '' && document.querySelector('#feedback-owner-messages').textContent.includes('PRIVATE-CONFIRMED-REFRESH-FAILED')`, 'confirmed private reply survives failed refresh');
  await check(`document.querySelector('#feedback-owner-reply-status').textContent.includes('已保存')`, 'confirmed private reply remains explicitly saved after refresh failure');
  checks.push('owner-private-thread', 'owner-reply-idempotency', 'comments-replies-separated', 'owner-confirmed-refresh-failed');

  await evaluate(`document.querySelector('#feedback-detail').scrollIntoView({ block: 'start' })`); await capture('public-feedback-desktop');
  win.setContentSize(390, 1000); await pause(70);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'public feedback fits 390px');
  await evaluate(`document.querySelector('#feedback-detail').scrollIntoView({ block: 'start' })`);
  await capture('public-feedback-phone');
  await evaluate(`document.querySelector('#feedback-owner-section').scrollIntoView({ block: 'start' })`); await capture('public-feedback-owner-phone');
  checks.push('desktop-phone-layout');
  win.setContentSize(1280, 1000);

  // An authorized private response must not reappear after changing the selected issue.
  await openIssue(secondId);
  await check(`document.querySelector('#feedback-owner-section').hidden`, 'other issue has no private content');
  const switchGate = gateNext('feedback-owner-detail', firstId);
  await click(`.feedback-issue-link[data-feedback-id="${firstId}"]`);
  await waitFor(() => switchGate.started, 'private request in flight before switching issue');
  await openIssue(secondId); switchGate.release(); await pause(100);
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-section').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-messages').textContent.includes('PRIVATE-OWNER-ONLY')`), false, 'stale private response cannot cross issue boundary');
  assert.equal(await evaluate(`document.body.textContent.includes('PRIVATE-ORIGINAL-OWNER-ONLY') || document.body.textContent.includes('PRIVATE-TITLE-OWNER-ONLY')`), false, 'switching issue removes private original title and description from DOM');
  const logoutGate = gateNext('feedback-owner-detail', firstId);
  await click(`.feedback-issue-link[data-feedback-id="${firstId}"]`);
  await waitFor(() => logoutGate.started, 'private request in flight before logout');
  await click('#feedback-logout');
  await check(`document.querySelector('#feedback-logout').hidden`, 'owner logout');
  logoutGate.release(); await pause(100);
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-section').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-messages').textContent.includes('PRIVATE-OWNER-ONLY')`), false, 'logout discards private in-flight response');
  assert.equal(await evaluate(`document.body.textContent.includes('PRIVATE-ORIGINAL-OWNER-ONLY') || document.body.textContent.includes('PRIVATE-TITLE-OWNER-ONLY')`), false, 'logout removes private original title and description from DOM');
  await login('viewer@example.test');
  await check(`document.querySelector('#feedback-owner-section').hidden`, 'new account cannot see old private thread');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-reply').value`), '', 'new account never inherits private reply draft');
  await click('#feedback-logout'); await check(`document.querySelector('#feedback-logout').hidden`, 'viewer leaves before owner session-expiry check');
  await login('owner@example.test');
  await check(`!document.querySelector('#feedback-owner-section').hidden`, 'owner private composer restored');
  const retainedDraft = 'SESSION-BOUND-PRIVATE-DRAFT，登录过期后保留原文';
  await fill('#feedback-owner-reply', retainedDraft);
  const sentBeforeExpiry = calls.filter(call => call.action === 'feedback-owner-reply').length;
  sessions.clear();
  await submit('#feedback-owner-reply-form');
  await check(`document.querySelector('#feedback-logout').hidden && document.querySelector('#feedback-owner-section').hidden`, 'expired browser session clears private view');
  assert.equal(calls.filter(call => call.action === 'feedback-owner-reply').length, sentBeforeExpiry, 'expired preflight prevents private mutation');
  await login('owner@example.test');
  await check(`!document.querySelector('#feedback-owner-section').hidden && document.querySelector('#feedback-owner-reply').value === ${JSON.stringify(retainedDraft)}`, 'same account can recover its unsent draft after expiry');
  // Simulate another browser tab changing the HttpOnly cookie while this page
  // still displays the old principal. The preflight must stop the old draft.
  const switchedSession = 'cross-tab-viewer-session'; sessions.set(switchedSession, 'viewer');
  await win.webContents.session.cookies.set({ url: origin, name: 'fixture-browser', value: switchedSession, path: '/', httpOnly: true, sameSite: 'strict' });
  await submit('#feedback-owner-reply-form');
  await check(`document.querySelector('#feedback-owner-section').hidden && document.querySelector('#feedback-account-label').textContent.includes('viewer@example.test')`, 'cookie account change is detected before sending');
  assert.equal(calls.filter(call => call.action === 'feedback-owner-reply').length, sentBeforeExpiry, 'old account private draft is never sent as the new account');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-reply').value`), '', 'cross-tab account change clears old composer');

  // A successful preflight is insufficient when a different tab changes the
  // cookie before POST. The backend must compare the captured expectedUserId.
  await click('#feedback-logout'); await check(`document.querySelector('#feedback-logout').hidden`, 'viewer leaves before post-preflight race');
  await login('owner@example.test');
  await check(`!document.querySelector('#feedback-owner-section').hidden`, 'owner loaded before post-preflight race');
  const accountBoundComment = 'CROSS-TAB-BETWEEN-ME-AND-POST-DRAFT';
  await fill('#feedback-comment-content', accountBoundComment);
  const commentsBeforeSwitch = commentRequests.size;
  const postsBeforeSwitch = calls.filter(call => call.action === 'feedback-public-comment').length;
  const preflightGate = gateNext('me');
  await submit('#feedback-comment-form');
  await waitFor(() => preflightGate.started, 'owner preflight response captured before cookie changes');
  sessions.set('cross-gap-viewer-session', 'viewer');
  await win.webContents.session.cookies.set({ url: origin, name: 'fixture-browser', value: 'cross-gap-viewer-session', path: '/', httpOnly: true, sameSite: 'strict' });
  preflightGate.release();
  await check(`document.querySelector('#feedback-account-label').textContent.includes('viewer@example.test') && document.querySelector('#feedback-owner-section').hidden`, 'POST account mismatch adopts the current account without exposing private content');
  const switchedPosts = calls.filter(call => call.action === 'feedback-public-comment').slice(postsBeforeSwitch);
  assert.equal(switchedPosts.length, 1, 'account mismatch never automatically resends a comment');
  assert.equal(switchedPosts[0].input.expectedUserId, 'owner', 'POST preserves the principal shown when the draft was sent');
  assert.equal(switchedPosts[0].input.content, accountBoundComment);
  assert.equal(commentRequests.size, commentsBeforeSwitch, 'account mismatch does not persist a comment as the wrong user');
  assert.equal(await evaluate(`document.querySelector('#feedback-comment-content').value`), '', 'new account never inherits the old public draft');
  assert.equal(await evaluate(`document.body.textContent.includes('PRIVATE-ORIGINAL-OWNER-ONLY') || document.body.textContent.includes('PRIVATE-TITLE-OWNER-ONLY')`), false, 'account mismatch removes original private title and description');
  assert.equal(await evaluate(`document.querySelector('#feedback-public-comments').textContent.includes(${JSON.stringify(accountBoundComment)})`), false);
  await click('#feedback-logout'); await check(`document.querySelector('#feedback-logout').hidden`, 'viewer leaves after account mismatch');
  await login('owner@example.test');
  await check(`document.querySelector('#feedback-comment-content').value === ${JSON.stringify(accountBoundComment)} && !document.querySelector('#feedback-comment-content').readOnly`, 'original account recovers the explicitly rejected public draft');
  assert.equal(commentRequests.size, commentsBeforeSwitch, 'recovering the draft does not send it automatically');

  // A private POST rejects another account with 404. Already rendered private
  // content must disappear immediately, before the follow-up identity read.
  await check(`!document.querySelector('#feedback-owner-section').hidden`, 'owner private thread restored before 404 race');
  // The earlier interrupted send remains locked to its original retry payload.
  const accountBoundReply = retainedDraft;
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-reply').value`), accountBoundReply);
  const privateWritesBeforeSwitch = replyRequests.size;
  const privatePostsBeforeSwitch = calls.filter(call => call.action === 'feedback-owner-reply').length;
  const privatePreflightGate = gateNext('me');
  await submit('#feedback-owner-reply-form');
  await waitFor(() => privatePreflightGate.started, 'private preflight captures the original owner');
  sessions.set('cross-private-viewer-session', 'viewer');
  await win.webContents.session.cookies.set({ url: origin, name: 'fixture-browser', value: 'cross-private-viewer-session', path: '/', httpOnly: true, sameSite: 'strict' });
  const privateIdentityGate = gateNext('me');
  privatePreflightGate.release();
  await waitFor(() => privateIdentityGate.started, 'private 404 triggers a fresh identity read');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-section').hidden`), true, 'private 404 immediately hides the owner view');
  assert.equal(await evaluate(`document.body.textContent.includes('PRIVATE-OWNER-ONLY') || document.body.textContent.includes('PRIVATE-ORIGINAL-OWNER-ONLY') || document.body.textContent.includes('PRIVATE-TITLE-OWNER-ONLY')`), false, 'private 404 clears private messages and original text before identity sync');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-reply').value`), '', 'private 404 clears the visible private draft');
  assert.equal(calls.filter(call => call.action === 'feedback-owner-reply').length, privatePostsBeforeSwitch + 1, 'private 404 never retries without the user');
  assert.equal(replyRequests.size, privateWritesBeforeSwitch, 'private 404 never writes for the wrong account');
  privateIdentityGate.release();
  await check(`document.querySelector('#feedback-account-label').textContent.includes('viewer@example.test')`, 'private 404 adopts the current cookie account');
  await click('#feedback-logout'); await check(`document.querySelector('#feedback-logout').hidden`, 'viewer leaves after private 404');
  await login('owner@example.test');
  await check(`!document.querySelector('#feedback-owner-section').hidden && document.querySelector('#feedback-owner-reply').value === ${JSON.stringify(accountBoundReply)}`, 'private 404 preserves the draft for its original owner');

  // Returning to this window refreshes identity after a different tab logs in.
  sessions.set('focus-viewer-session', 'viewer');
  await win.webContents.session.cookies.set({ url: origin, name: 'fixture-browser', value: 'focus-viewer-session', path: '/', httpOnly: true, sameSite: 'strict' });
  const identityCallsBeforeFocus = calls.filter(call => call.action === 'me').length;
  const focusGate = gateNext('me');
  await evaluate(`window.dispatchEvent(new Event('focus'))`);
  await waitFor(() => focusGate.started, 'window focus starts identity verification');
  await evaluate(`window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus'))`);
  await pause(50);
  assert.equal(calls.filter(call => call.action === 'me').length, identityCallsBeforeFocus + 1, 'concurrent focus events share one identity request');
  focusGate.release();
  await check(`document.querySelector('#feedback-account-label').textContent.includes('viewer@example.test') && document.querySelector('#feedback-owner-section').hidden`, 'window focus replaces a stale identity');
  assert.equal(await evaluate(`document.body.textContent.includes('PRIVATE-OWNER-ONLY') || document.body.textContent.includes('PRIVATE-ORIGINAL-OWNER-ONLY') || document.body.textContent.includes('PRIVATE-TITLE-OWNER-ONLY')`), false, 'window focus removes stale private content');
  assert.equal(await evaluate(`document.querySelector('#feedback-owner-reply').value`), '', 'window focus never transfers the owner private draft');
  assert.equal(replyRequests.size, privateWritesBeforeSwitch, 'session refresh never sends the retained private draft');
  assert.equal(await evaluate('localStorage.length'), 0, 'page never persists browser credentials or private messages in localStorage');
  assert.deepEqual(rendererErrors, [], 'no unhandled renderer errors');
  checks.push('issue-switch-race', 'logout-race', 'private-original-dom-cleared', 'account-switch', 'session-expiry-draft-recovery', 'cross-tab-principal-check', 'post-preflight-account-switch', 'private-post-account-switch', 'focus-session-sync');
  console.log(JSON.stringify({ result: 'PASS', scope: 'real Electron page + local API fixture; no production data or email', checks, apiCalls: calls.length, screenshots }));
  await finish(0);
}).catch(error => finish(1, error));
