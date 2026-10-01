// Real browser renderer acceptance with disposable local fixtures.
// No email, payment, login credentials or remote media leave this process.
// Run: npx electron scripts/verify-member-video-ui.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-member-video-ui-'));
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
app.setPath('userData', path.join(temporary, 'profile'));
let win, server, finished = false;
const deadline = setTimeout(() => void finish(1, new Error('MEMBER_VIDEO_UI_TIMEOUT')), 120_000);
async function finish(code, error) {
  if (finished) return;
  finished = true; clearTimeout(deadline);
  if (error) console.error(error);
  win?.destroy(); server?.close();
  app.exit(code);
}

app.whenReady().then(async () => {
  const { mp4Fixture } = await import(pathToFileURL(path.join(root, 'test/fixtures/mp4.js')).href);
  const bytes = mp4Fixture();
  const fixture = `
window.fixtureRole = 'guest'; window.fixtureOriginalAvailable = true;
window.fixtureRequests = []; window.fixtureDownloads = []; window.fixtureBlobs = new Map();
window.fixtureDenyChunks = false; window.fixtureDenyFinalMeta = false; window.fixtureCorruptMp4 = false; window.fixtureChangeDuringFinalMeta = ''; window.fixtureMetaCalls = 0; window.fixtureOpened = [];
window.fixtureSlow = false; window.fixturePending = []; window.fixtureDeliveredBytes = 0; window.fixtureAccountChecks = 0; window.fixtureInspectionCalls = 0;
window.fixtureRelease = stage => {
  const pending = window.fixturePending.find(item => item.stage === stage);
  if (!pending) throw new Error('No paused fixture response: ' + stage);
  window.fixturePending.splice(window.fixturePending.indexOf(pending), 1); pending.release();
};
const pause = stage => window.fixtureSlow ? new Promise(release => window.fixturePending.push({ stage, release })) : Promise.resolve();
window.open = (...args) => { window.fixtureOpened.push(args); };
const realFetch = window.fetch.bind(window);
const fixtureAccount = () => ({ user: { id: 'fixture-user', email: 'member@example.test' },
  membership: { type: window.fixtureRole === 'member' ? 'duration' : 'none', active: window.fixtureRole === 'member', startsAt: '2026-09-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' },
  device: null, serverTime: '2026-10-01T00:00:00Z' });
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chunkReply = (part, prefix, start) => new Response(new ReadableStream({
  async start(controller) {
    const split = Math.ceil(part.length / 2);
    controller.enqueue(part.slice(0, split)); window.fixtureDeliveredBytes += split;
    await pause(prefix + '-tail-' + start);
    if (split < part.length) { controller.enqueue(part.slice(split)); window.fixtureDeliveredBytes += part.length - split; }
    controller.close();
  }
}), { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': String(part.length) } });
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, options);
  const body = options.body ? JSON.parse(options.body) : {};
  window.fixtureRequests.push({ path: url.pathname, query: url.search, body, credentials: options.credentials });
  if (url.pathname === '/api/account') {
    if (body.action === 'me') await pause(++window.fixtureAccountChecks === 1 ? 'account' : 'final-account');
    if (body.action === 'logout') { window.fixtureRole = 'guest'; return reply({ ok: true }); }
    if (body.action === 'send-code') return reply({ ok: true, retryAfter: 60 });
    if (body.action === 'verify-code') window.fixtureRole = 'member';
    if (window.fixtureRole === 'guest') return reply({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请登录软件账号。' } }, 401);
    return reply({ ok: true, account: fixtureAccount() });
  }
  if (url.pathname === '/api/parse' || url.pathname === '/api/python_parse') return reply({ success: true, title: '原视频会员下载验收', noteId: 'fixture-note', images: [],
    videos: [{ index: 1, url: location.origin + '/playback.mp4', label: '1080P · 播放视频', isDefault: true, hasAudio: true }],
    hasOriginalVideo: window.fixtureOriginalAvailable });
  if (url.pathname === '/api/member_video') {
    if (options.method === 'POST') {
      await pause('resolve');
      if (window.fixtureRole !== 'member') return reply({ success: false, error: { code: 'MEMBERSHIP_REQUIRED', message: '仅限会员下载原视频。' } }, 403);
      window.fixtureMetaCalls = 0; window.fixtureDeliveredBytes = 0; window.fixtureInspectionCalls = 0;
      return reply({ success: true, videos: [{ index: 1, url: 'member-video:fixture-ticket', label: '原视频', isDefault: true, hasAudio: true, size: ${bytes.length} }] });
    }
    if (url.searchParams.get('action') === 'meta') {
      window.fixtureMetaCalls++;
      await pause(window.fixtureMetaCalls === 1 ? 'meta' : 'final-meta');
      if (window.fixtureDenyFinalMeta && window.fixtureMetaCalls === 2) return reply({ success: false, error: { code: 'MEMBERSHIP_EXPIRED', message: '会员在保存前已到期，请刷新权益。' } }, 403);
      if (window.fixtureChangeDuringFinalMeta && window.fixtureMetaCalls === 2) {
        const { getAccountBridge } = await import('/lib/browser-account.js');
        const bridge = getAccountBridge();
        await bridge.logoutAccount();
        if (window.fixtureChangeDuringFinalMeta === 'relogin') await bridge.verifyAccountCode('member@example.test', '123456');
      }
      return reply({ size: ${bytes.length}, contentType: 'video/mp4', chunkSize: 50 });
    }
    await pause('chunk-' + url.searchParams.get('start'));
    if (window.fixtureDenyChunks) return reply({ success: false, error: { code: 'MEMBERSHIP_REQUIRED', message: '会员已到期，请刷新权益。' } }, 403);
    const raw = Uint8Array.from(${JSON.stringify(Array.from(bytes))});
    if (window.fixtureCorruptMp4) raw.fill(255, 0, 4);
    const part = raw.slice(Number(url.searchParams.get('start')), Number(url.searchParams.get('end')) + 1);
    return chunkReply(part, 'chunk', url.searchParams.get('start'));
  }
  if (url.pathname === '/api/video' || url.pathname === '/api/python_video') {
    if (url.searchParams.get('action') === 'meta') {
      window.fixtureDeliveredBytes = 0; window.fixtureInspectionCalls = 0; await pause('playback-meta');
      return reply({ size: ${bytes.length}, contentType: 'video/mp4', chunkSize: 50 });
    }
    await pause('playback-chunk-' + url.searchParams.get('start'));
    const raw = Uint8Array.from(${JSON.stringify(Array.from(bytes))});
    const part = raw.slice(Number(url.searchParams.get('start')), Number(url.searchParams.get('end')) + 1);
    return chunkReply(part, 'playback-chunk', url.searchParams.get('start'));
  }
  return reply({ message: 'Unexpected public video request' }, 500);
};
const blobArrayBuffer = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = async function() {
  if (++window.fixtureInspectionCalls === 1) await pause('inspection');
  return blobArrayBuffer.call(this);
};
const createBlobURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = createBlobURL(blob); window.fixtureBlobs.set(url, blob); return url; };
const anchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function() { if (this.download) { window.fixtureDownloads.push({ filename: this.download, bytes: window.fixtureBlobs.get(this.href)?.size }); return; } anchorClick.call(this); };
if (new URL(location.href).searchParams.get('fixtureDesktop') === '1') {
  const state = () => ({ configured: true, authenticated: window.fixtureRole !== 'guest', verified: window.fixtureRole !== 'guest', status: window.fixtureRole === 'guest' ? 'logged_out' : 'ready', account: window.fixtureRole === 'guest' ? null : fixtureAccount() });
  window.xhsDesktop = {
    getAccountState: async () => { await pause(++window.fixtureAccountChecks === 1 ? 'account' : 'final-account'); return state(); }, onAccountUpdate: callback => { window.fixtureDesktopUpdate = callback; return () => {}; },
    refreshAccount: async () => { window.fixtureDesktopUpdate?.(state()); return { ok: true, state: state(), result: {} }; },
    sendAccountCode: async () => ({ ok: true, state: state(), result: { retryAfter: 60 } }),
    verifyAccountCode: async () => { window.fixtureRole = 'member'; return { ok: true, state: state(), result: {} }; },
    redeemAccountCode: async () => ({ ok: true, state: state(), result: {} }),
    logoutAccount: async () => { window.fixtureRole = 'guest'; return { ok: true, state: state(), result: {} }; },
  };
  document.body.classList.add('is-desktop'); document.getElementById('desktop-navigation').hidden = false;
  document.getElementById('account-tab').onclick = () => { document.getElementById('desktop-account-page').hidden = false; document.getElementById('single-note-panel').hidden = true; };
  document.getElementById('single-note-tab').onclick = () => { document.getElementById('desktop-account-page').hidden = true; document.getElementById('single-note-panel').hidden = false; };
}
`;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4' };
  server = http.createServer((req, res) => {
    try {
      const requested = new URL(req.url, 'http://localhost').pathname;
      if (requested === '/member-video-fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fixture); return; }
      if (requested === '/desktop-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('export async function initializeDesktopUI() {}'); return; }
      if (requested === '/playback.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(bytes); return; }
      const file = path.resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
      if (!file.startsWith(root + path.sep)) throw new Error('Outside fixture root');
      let body = fs.readFileSync(file);
      if (requested === '/') {
        body = body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        body = body.replace('</body>', '<script src="/member-video-fixture.js"></script><script type="module" src="/app.js"></script></body>');
      }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('blob:') && !details.url.startsWith('data:') }));
  const rendererErrors = [];
  win.webContents.on('console-message', details => {
    if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT') && !details.message.includes('playback.mp4')) rendererErrors.push(details.message);
  });
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const setViewport = async (width, height) => {
    let gutter = 0, measured;
    for (let attempt = 0; attempt < 3; attempt++) {
      win.setContentSize(width + gutter, height);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      measured = await evaluate('({ width: document.documentElement.clientWidth, gutter: innerWidth - document.documentElement.clientWidth })');
      if (measured.width === width) break;
      gutter = measured.gutter;
    }
    assert.equal(measured.width, width, `Expected ${width}px layout viewport: ${JSON.stringify(measured)}`);
  };
  const until = condition => evaluate(`new Promise((resolve, reject) => {
    const started = Date.now(); const check = () => {
      if (${condition}) resolve(); else if (Date.now() - started > 5000) reject(new Error('Fixture condition timed out: ' + ${JSON.stringify(condition)})); else setTimeout(check, 20);
    }; check();
  })`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const progressEvidence = [];
  const progressSnapshotScript = `(() => {
    const panel = document.getElementById('video-download-progress');
    if (!panel) throw new Error('Nearby video download progress is missing');
    const stage = document.getElementById('video-download-stage');
    const detail = document.getElementById('video-download-detail');
    const percent = document.getElementById('video-download-percent');
    const bar = document.getElementById('video-download-bar');
    const rect = panel.getBoundingClientRect(), style = getComputedStyle(panel);
    const trigger = document.getElementById('download-original-video-button');
    return { phase: panel.dataset.phase, hidden: panel.hidden, stage: stage?.textContent,
      detail: detail?.textContent, percent: percent?.textContent, width: bar?.style.width,
      busy: panel.getAttribute('aria-busy'),
      visible: !panel.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      inViewport: rect.bottom > 0 && rect.top < innerHeight,
      nearControls: document.getElementById('video-section').contains(panel),
      buttonDisabled: trigger.disabled, deliveredBytes: window.fixtureDeliveredBytes,
      controlsDisabled: Object.fromEntries(['parse-button', 'video-quality', 'download-video-button'].map(id => [id, document.getElementById(id).disabled])),
      totalBytes: ${bytes.length}, downloads: window.fixtureDownloads.length,
      rect: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } };
  })()`;
  const progressSnapshot = () => evaluate(progressSnapshotScript);
  const assertProgress = async (phase, { active = true, transferred = null, inViewport = true } = {}) => {
    const current = await progressSnapshot();
    assert.equal(current.phase, phase, `Wrong video phase: ${JSON.stringify(current)}`);
    assert.equal(current.visible, true, `Progress must remain visible: ${JSON.stringify(current)}`);
    assert.equal(current.nearControls, true, 'Progress belongs beside the video download controls');
    if (inViewport) assert.equal(current.inViewport, true, `Progress is outside the current view: ${JSON.stringify(current)}`);
    assert.equal(current.buttonDisabled, active, `Download button state must match phase ${phase}`);
    for (const [id, disabled] of Object.entries(current.controlsDisabled)) assert.equal(disabled, active, `${id} must restore after phase ${phase}`);
    assert.equal(current.busy, String(active), `Progress accessibility state must match phase ${phase}`);
    if (active) assert.doesNotMatch(`${current.stage} ${current.detail}`, /已保存|保存成功|已开始保存|已完成并开始保存/, 'An active transfer/check cannot announce that saving succeeded');
    if (phase === 'complete') assert.doesNotMatch(`${current.stage} ${current.detail}`, /保存成功|已保存到/, 'A browser download request cannot confirm that the operating system saved the file');
    if (transferred !== null) {
      assert.equal(current.deliveredBytes, transferred);
      const expected = Math.round(transferred / bytes.length * 100);
      assert.equal(Number.parseFloat(current.percent), expected, `Percentage must reflect received bytes: ${JSON.stringify(current)}`);
      assert.equal(Number.parseFloat(current.width), expected, 'Visible bar must agree with actual byte percentage');
    }
    progressEvidence.push(current);
    return current;
  };
  const paused = stage => until(`window.fixturePending.some(item => item.stage === ${JSON.stringify(stage)})`);
  const release = stage => evaluate(`window.fixtureRelease(${JSON.stringify(stage)})`);
  const capture = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const assertNoOverflow = async width => {
    const overflow = await evaluate(`({ viewport: document.documentElement.clientWidth, width: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('body *')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.right > document.documentElement.clientWidth + 1; }).slice(0, 10).map(element => ({ tag: element.tagName, id: element.id, className: element.className, width: element.getBoundingClientRect().width })) })`);
    assert.equal(overflow.viewport, width, `Layout viewport changed before ${width}px screenshot`);
    assert.ok(overflow.width <= overflow.viewport, `Page overflow at ${width}px: ${JSON.stringify(overflow)}`);
  };
  const entryNote = 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa?xsec_token=fixture-share-token&xsec_source=app_share';
  const entry = new URL(origin + '/'); entry.searchParams.set('note', entryNote); entry.searchParams.set('memberVideo', '1');
  await win.loadURL(entry.href);
  await until(`document.getElementById('account-email') && document.getElementById('account-badge').textContent.includes('未登录')`);
  assert.equal(await evaluate(`document.getElementById('share-text').value`), entryNote);
  assert.equal(await evaluate(`document.getElementById('member-video-entry-hint').hidden`), false);
  assert.equal(await evaluate(`location.search`), '', 'Signed note query is removed from browser navigation after safe prefill');
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path !== '/api/account').length`), 0, 'Entry never parses or downloads before a user action');
  await evaluate(`document.getElementById('share-text').value = 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa'; document.getElementById('parse-form').requestSubmit()`);
  await until(`!document.getElementById('video-section').hidden && !document.getElementById('parse-button').disabled`);
  assert.match(await evaluate(`document.getElementById('download-video-button').textContent`), /免费/);
  await click('download-original-video-button');
  await until(`document.getElementById('browser-account-dialog').open`);
  assert.equal(await evaluate(`document.activeElement.id`), 'account-email');
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/member_video').length`), 0);
  await evaluate(`document.getElementById('account-email').value = 'member@example.test'; document.getElementById('account-otp').value = '123456'; document.getElementById('account-login-form').requestSubmit()`);
  await until(`document.getElementById('account-badge').textContent.includes('有效期会员')`);
  const login = await evaluate(`window.fixtureRequests.find(request => request.body.action === 'verify-code')`);
  assert.equal(login.body.input.client, 'browser');
  assert.equal(login.credentials, 'same-origin');
  await click('browser-account-close');
  await evaluate(`document.getElementById('download-original-video-button').scrollIntoView({ block: 'center', behavior: 'instant' });
    window.fixtureSlow = true; window.fixtureAccountChecks = 0; window.fixtureDeliveredBytes = 0`);
  const immediate = await evaluate(`document.getElementById('download-original-video-button').click(); ${progressSnapshotScript}`);
  assert.equal(immediate.phase, 'verifying', 'Click must synchronously show progress before awaiting the account request');
  assert.equal(immediate.visible, true);
  assert.equal(immediate.inViewport, true);
  assert.equal(immediate.buttonDisabled, true);
  progressEvidence.push({ ...immediate, immediateClick: true });
  await paused('account');
  await assertProgress('verifying'); await capture('progress-verifying');
  await release('account'); await paused('resolve');
  await assertProgress('resolving'); await capture('progress-resolving');
  await release('resolve'); await paused('meta');
  await assertProgress('preparing'); await capture('progress-preparing');
  await release('meta');
  const percentages = [];
  for (let start = 0; start < bytes.length; start += 50) {
    await paused(`chunk-${start}`);
    const current = await assertProgress('downloading', { transferred: start });
    percentages.push(Number.parseFloat(current.percent));
    if (start === 50) {
      for (const width of [1440, 768, 390, 320]) {
        await setViewport(width, 960);
        await evaluate(`document.getElementById('video-download-progress').scrollIntoView({ block: 'center', behavior: 'instant' })`);
        await assertProgress('downloading', { transferred: start });
        await assertNoOverflow(width);
        await capture(`progress-downloading-${width}`);
      }
      await setViewport(1440, 1000);
      await evaluate(`document.getElementById('video-download-progress').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    }
    await release(`chunk-${start}`);
    await paused(`chunk-tail-${start}`);
    const insideChunk = start + Math.ceil(Math.min(50, bytes.length - start) / 2);
    await until(`Number.parseFloat(document.getElementById('video-download-percent').textContent) === ${Math.round(insideChunk / bytes.length * 100)}`);
    const withinResponse = await assertProgress('downloading', { transferred: insideChunk });
    percentages.push(Number.parseFloat(withinResponse.percent));
    if (start === 50) await capture('progress-within-chunk');
    await release(`chunk-tail-${start}`);
  }
  assert.ok(percentages.length > 2 && percentages.every((value, index) => index === 0 || value > percentages[index - 1]), `Progress must actually increase: ${JSON.stringify(percentages)}`);
  await paused('inspection');
  await assertProgress('checking', { transferred: bytes.length });
  assert.equal(await evaluate('window.fixtureDownloads.length'), 0, 'Complete byte transfer is not a validated MP4 yet');
  await capture('progress-mp4-inspection');
  await release('inspection');
  await paused('final-meta');
  await assertProgress('checking', { transferred: bytes.length });
  assert.equal(await evaluate('window.fixtureDownloads.length'), 0, 'Received 100% still requires MP4 inspection and final authorization');
  await capture('progress-final-authorization');
  await release('final-meta'); await paused('final-account');
  await assertProgress('checking', { transferred: bytes.length });
  assert.equal(await evaluate('window.fixtureDownloads.length'), 0, 'An unanswered final account check must not save');
  await evaluate(`window.fixtureSlow = false; window.fixtureRelease('final-account')`);
  await until(`window.fixtureDownloads.length === 1 && !document.getElementById('download-original-video-button').disabled`);
  await assertProgress('complete', { active: false, transferred: bytes.length });
  await capture('progress-complete');
  assert.deepEqual(await evaluate('window.fixtureDownloads'), [{ filename: '原视频会员下载验收-原视频.mp4', bytes: bytes.length }]);
  const requests = await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/member_video')`);
  assert.equal(requests[0].body.text, 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(requests.slice(1).every(request => request.query.includes('ticket=fixture-ticket') && !request.query.includes('url=')));
  assert.equal(requests.filter(request => request.query.includes('action=meta')).length, 2, 'Member download rechecks authorization after MP4 inspection and before saving');
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);
  await evaluate('window.fixtureDenyChunks = true');
  await click('download-original-video-button');
  await until(`document.getElementById('alert-toast').textContent.includes('会员已到期') && !document.getElementById('download-original-video-button').disabled`);
  const chunkFailure = await assertProgress('error', { active: false });
  assert.match(`${chunkFailure.stage} ${chunkFailure.detail}`, /会员已到期/, 'Failure explanation must remain beside the controls');
  await capture('progress-error');
  assert.equal(await evaluate('window.fixtureDownloads.length'), 1);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/video' || request.path === '/api/python_video').length`), 0);
  await click('membership-close'); await click('browser-account-close');
  await evaluate('window.fixtureDenyChunks = false; window.fixtureDenyFinalMeta = true');
  const preSaveStart = await evaluate('window.fixtureRequests.length');
  await click('download-original-video-button');
  await until(`document.getElementById('alert-toast').textContent.includes('保存前已到期') && !document.getElementById('download-original-video-button').disabled`);
  const finalFailure = await assertProgress('error', { active: false });
  assert.match(`${finalFailure.stage} ${finalFailure.detail}`, /保存前已到期/, 'Final authorization failure must remain visible');
  const preSaveRequests = await evaluate(`window.fixtureRequests.slice(${preSaveStart}).filter(request => request.path === '/api/member_video')`);
  assert.equal(preSaveRequests.filter(request => request.query.includes('action=chunk')).length, Math.ceil(bytes.length / 50), 'Final rejection must occur after every chunk completed');
  assert.equal(preSaveRequests.filter(request => request.query.includes('action=meta')).length, 2);
  assert.equal(await evaluate('window.fixtureDownloads.length'), 1, 'A rejected final authorization must not save a combined MP4');
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/video' || request.path === '/api/python_video').length`), 0);
  await click('membership-close'); await click('browser-account-close');
  await evaluate('window.fixtureDenyFinalMeta = false');
  for (const change of ['logout', 'relogin']) {
    await evaluate(`window.fixtureRole = 'member'; window.fixtureChangeDuringFinalMeta = ${JSON.stringify(change)}`);
    await click('download-original-video-button');
    await until(`document.getElementById('alert-toast').textContent.includes('账号已退出或切换') && !document.getElementById('download-original-video-button').disabled`);
    await assertProgress('error', { active: false });
    assert.equal(await evaluate('window.fixtureRole'), change === 'logout' ? 'guest' : 'member');
    assert.equal(await evaluate('window.fixtureDownloads.length'), 1, 'Logout or a replacement login during an authorized final metadata response must not save');
    assert.equal(await evaluate('window.fixtureOpened.length'), 0);
    await until(`document.getElementById('browser-account-dialog').open`);
    await click('browser-account-close');
  }
  await evaluate("window.fixtureChangeDuringFinalMeta = ''");
  await click('download-original-video-button');
  await until(`window.fixtureDownloads.length === 2 && !document.getElementById('download-original-video-button').disabled`);
  await assertProgress('complete', { active: false, transferred: bytes.length });
  await capture('progress-retry-complete');
  await evaluate('window.fixtureCorruptMp4 = true');
  const corruptStart = await evaluate('window.fixtureRequests.length');
  await click('download-original-video-button');
  await until(`document.getElementById('alert-toast').textContent.includes('结构不完整') && !document.getElementById('download-original-video-button').disabled`);
  const invalidMedia = await assertProgress('error', { active: false });
  assert.match(`${invalidMedia.stage} ${invalidMedia.detail}`, /结构不完整/, 'Media verification failure must explain why no file was saved');
  assert.equal(await evaluate('window.fixtureDownloads.length'), 2);
  assert.equal(await evaluate(`window.fixtureRequests.slice(${corruptStart}).filter(request => request.path === '/api/member_video' && request.query.includes('action=meta')).length`), 1, 'Invalid MP4 must stop before final authorization and saving');
  await capture('progress-invalid-media');
  await evaluate('window.fixtureCorruptMp4 = false; window.fixtureSlow = true; window.fixtureAccountChecks = 0');
  await click('download-original-video-button');
  await paused('account'); await release('account');
  await paused('resolve'); await release('resolve');
  await paused('meta'); await release('meta');
  await paused('chunk-0');
  await assertProgress('downloading', { transferred: 0 });
  await release('chunk-0'); await paused('chunk-tail-0');
  await until(`Number.parseFloat(document.getElementById('video-download-percent').textContent) === ${Math.round(25 / bytes.length * 100)}`);
  await assertProgress('downloading', { transferred: 25 });
  await capture('progress-retry-reset');
  await evaluate(`window.fixtureSlow = false; window.fixtureRelease('chunk-tail-0')`);
  await until(`window.fixtureDownloads.length === 3 && !document.getElementById('download-original-video-button').disabled`);
  await assertProgress('complete', { active: false, transferred: bytes.length });
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/video' || request.path === '/api/python_video').length`), 0, 'Member failure/retry cannot use an unprotected playback route');
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);
  await evaluate('window.fixtureDenyFinalMeta = false; window.fixtureRole = "ordinary"');
  await click('browser-account-open'); await click('account-refresh');
  await until(`document.getElementById('account-badge').textContent.includes('普通用户')`);
  await click('browser-account-close');
  const requestsBefore = await evaluate('window.fixtureRequests.length');
  await click('download-original-video-button');
  await until(`document.getElementById('membership-dialog').open`);
  assert.equal(await evaluate(`window.fixtureRequests.slice(${requestsBefore}).filter(request => request.path === '/api/member_video').length`), 0);
  await click('membership-close'); await click('browser-account-close');
  for (const width of [1440, 768, 390, 320]) {
    await setViewport(width, 960);
    await evaluate(`document.querySelectorAll('.toast').forEach(element => element.classList.remove('toast-visible')); document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo({ top: document.getElementById('video-section').getBoundingClientRect().top + scrollY - document.querySelector('.app-header').offsetHeight - 16, behavior: 'instant' });
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await assertNoOverflow(width);
    await capture(`video-${width}`);
  }
  await click('browser-account-open');
  await setViewport(320, 960);
  assert.equal(await evaluate(`(() => { const dialog = document.getElementById('browser-account-dialog'); return dialog.scrollWidth > dialog.clientWidth + 1; })()`), false, 'Account dialog overflow at 320px');
  fs.writeFileSync(path.join(screenshots, 'account-320.png'), (await win.webContents.capturePage()).toPNG());
  await click('browser-account-close');
  await evaluate(`window.fixtureOriginalAvailable = false; document.getElementById('parse-form').requestSubmit()`);
  await until(`document.getElementById('download-original-video-button').disabled && !document.getElementById('parse-button').disabled`);
  assert.match(await evaluate(`document.getElementById('original-video-hint').textContent`), /未提供原视频/);
  for (const unsafe of ['javascript:alert(1)', 'https://www.xiaohongshu.com.attacker.test/explore/abc', 'https://user@www.xiaohongshu.com/explore/abc']) {
    const rejected = new URL(origin + '/'); rejected.searchParams.set('note', unsafe); rejected.searchParams.set('memberVideo', '1');
    await win.loadURL(rejected.href);
    await until(`document.getElementById('account-email') && document.getElementById('account-badge').textContent.includes('未登录')`);
    assert.equal(await evaluate(`document.getElementById('share-text').value`), '', 'Unsafe note entry must not prefill');
    assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path !== '/api/account').length`), 0);
  }
  // The desktop bridge uses the same opaque ticket flow; account entry switches
  // its existing account tab instead of opening the browser account dialog.
  await win.loadURL(origin + '/?fixtureDesktop=1');
  await until(`document.getElementById('account-email') && document.getElementById('account-badge').textContent.includes('未登录')`);
  await setViewport(1440, 1000);
  await evaluate(`document.getElementById('share-text').value = 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa'; document.getElementById('parse-form').requestSubmit()`);
  await until(`!document.getElementById('video-section').hidden && !document.getElementById('parse-button').disabled`);
  await click('download-original-video-button');
  await until(`!document.getElementById('desktop-account-page').hidden`);
  assert.equal(await evaluate(`document.getElementById('browser-account-dialog').open`), false);
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/member_video').length`), 0);
  await evaluate(`window.fixtureRole = 'member'`); await click('account-refresh');
  await until(`document.getElementById('account-badge').textContent.includes('有效期会员')`);
  await click('single-note-tab'); await click('download-original-video-button');
  await until(`window.fixtureDownloads.length === 1 && !document.getElementById('download-original-video-button').disabled`);
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/video' || request.path === '/api/python_video').length`), 0);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);
  // Free playback uses the same nearby byte progress without a member request.
  const protectedBeforePlayback = await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/member_video').length`);
  await evaluate(`window.fixtureSlow = true; window.fixtureDeliveredBytes = 0;
    document.getElementById('download-video-button').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  const playbackImmediate = await evaluate(`document.getElementById('download-video-button').click(); ${progressSnapshotScript}`);
  assert.equal(playbackImmediate.phase, 'preparing');
  assert.equal(playbackImmediate.visible, true);
  assert.equal(playbackImmediate.buttonDisabled, true);
  progressEvidence.push({ ...playbackImmediate, immediateClick: true, freePlayback: true });
  await paused('playback-meta'); await assertProgress('preparing');
  await capture('playback-progress-preparing');
  await release('playback-meta');
  for (let start = 0; start < bytes.length; start += 50) {
    await paused(`playback-chunk-${start}`);
    await assertProgress('downloading', { transferred: start });
    await release(`playback-chunk-${start}`);
    await paused(`playback-chunk-tail-${start}`);
    const insideChunk = start + Math.ceil(Math.min(50, bytes.length - start) / 2);
    await until(`Number.parseFloat(document.getElementById('video-download-percent').textContent) === ${Math.round(insideChunk / bytes.length * 100)}`);
    await assertProgress('downloading', { transferred: insideChunk });
    await release(`playback-chunk-tail-${start}`);
  }
  await paused('inspection'); await assertProgress('checking', { transferred: bytes.length });
  assert.equal(await evaluate('window.fixtureDownloads.length'), 1, 'Free playback must inspect the MP4 before requesting its save');
  await release('inspection');
  await evaluate('window.fixtureSlow = false');
  await until(`window.fixtureDownloads.length === 2 && !document.getElementById('download-video-button').disabled`);
  await assertProgress('complete', { active: false, transferred: bytes.length });
  assert.equal(await evaluate(`window.fixtureRequests.filter(request => request.path === '/api/member_video').length`), protectedBeforePlayback, 'Free playback must remain independent of protected download routes');
  await capture('playback-progress-complete');
  assert.equal(await evaluate('window.fixturePending.length'), 0, 'All delayed body and account operations must finish');
  assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'));
  const report = path.join(temporary, 'verification.json');
  const result = { ok: true, verifiedAt: new Date().toISOString(), version: require(path.join(root, 'package.json')).version, platform: process.platform, arch: process.arch, electronVersion: process.versions.electron, safeExternalEntry: true, noAutomaticPaidAction: true, guestLogin: true, browserAccountLogin: true, memberDownload: true, desktopAccountEntryAndDownload: true, finalAuthorizationBeforeSave: true, accountChangeDuringFinalResponse: true, noProtectedFallback: true, ordinaryPurchase: true, noOriginal: true, immediateProgress: true, delayedAccountResolveMetadataChunks: true, delayedMp4Inspection: true, realBytePercentage: true, progressWithinChunkBody: true, noSaveBeforeFinalChecks: true, retainedCompletionAndFailure: true, invalidMediaNoSave: true, retryRestoresButtons: true, retryResetsReceivedBytes: true, freePlaybackProgress: true, fixtureBytes: bytes.length, widths: [1440, 768, 390, 320], screenshots, report };
  fs.writeFileSync(report, JSON.stringify({ ...result, progressEvidence }, null, 2));
  console.log(JSON.stringify(result));
  await finish(0);
}).catch(error => void finish(1, error));
