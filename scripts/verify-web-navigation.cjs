// Exercise the built public site's navigation in real Chromium. All API data,
// uploaded files and failures are local fixtures; external network is blocked.
// Run: npm run build:web && npm run web:verify:navigation
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const staticRoot = path.join(root, 'dist-web');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-web-navigation-'));
const profile = path.join(temporary, 'profile');
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
app.setPath('userData', profile);
const reducedMotion = process.env.WEB_NAVIGATION_REDUCED_MOTION !== '0';
if (reducedMotion) app.commandLine.appendSwitch('force-prefers-reduced-motion');

const checks = [], rendererErrors = [], apiCalls = [], requests = [], blockedRequests = [];
const failures = new Set(), delays = new Map([['/live.html', 450]]);
const windows = new Set();
let server, origin, win, finished = false;
const timeout = setTimeout(() => void finish(1, new Error('WEB_NAVIGATION_TIMEOUT')), 120_000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finish(code, error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) { console.error(error); console.error(`Screenshots: ${screenshots}`); }
  for (const current of windows) if (!current.isDestroyed()) current.destroy();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { console.warn(`Fixture profile cleanup incomplete: ${profile}`); }
  app.exit(code);
}

const at = '2026-10-12T03:00:00.000Z';
const issues = [
  { id: '12345678-1234-1234-1234-000000000001', title: '导航验证：视频声音', description: '本地公开反馈夹具，包含 <script> 文本。', category: 'audio', status: 'new', createdAt: at, updatedAt: at, commentCount: 0 },
  { id: '12345678-1234-1234-1234-000000000002', title: '导航验证：已解决下载', description: '第二条本地反馈。', category: 'download', status: 'resolved', createdAt: at, updatedAt: at, commentCount: 0 },
];
const success = value => ({ status: 200, body: { ok: true, ...value, serverTime: at } });
function apiFixture({ action, input = {}, proof }, headers) {
  apiCalls.push({ action, input });
  if (action === 'google-config') {
    assert.equal(headers.authorization, undefined, 'Public Google configuration must not send an account token');
    assert.equal(proof, undefined, 'Public Google configuration must not send a device proof');
    assert.deepEqual(input, { client: 'browser' });
    return success({ enabled: true });
  }
  if (action === 'me') return { status: 401, body: { ok: false, error: { code: 'ACCOUNT_REQUIRED', message: '请先登录。' }, serverTime: at } };
  if (action === 'reviews-public') return success({ reviews: [], summary: { count: 0, averageRating: 0 }, page: 1, pageSize: 6, total: 0, totalPages: 1 });
  if (action === 'feedback-public-list') {
    const filtered = issues.filter(item => (!input.status || input.status === 'all' || (input.status === 'unresolved' ? item.status === 'new' : item.status === input.status))
      && (!input.category || item.category === input.category) && (!input.query || `${item.title}\n${item.description}`.includes(input.query)));
    return success({ feedbacks: filtered, total: filtered.length, page: 1, pageSize: 20, totalPages: 1, counts: { all: 2, new: 1, in_progress: 0, resolved: 1, closed: 0, unresolved: 1 } });
  }
  if (action === 'feedback-public-detail') return success({ feedback: issues.find(item => item.id === input.feedbackId), comments: [], total: 0, page: 1, pageSize: 20, totalPages: 1 });
  // No login, payment, account mutation, feedback write, or mail is authorized.
  throw new Error(`Unexpected API operation in navigation fixture: ${action}`);
}

async function createWindow() {
  const current = new BrowserWindow({ show: true, width: 1440, height: 1000,
    webPreferences: { partition: `web-navigation-${process.pid}-${windows.size}`, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  windows.add(current);
  current.webContents.debugger.attach('1.3');
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const cancel = ![`${origin}/`, 'data:', 'blob:'].some(prefix => details.url.startsWith(prefix));
    if (cancel) blockedRequests.push(details.url);
    callback({ cancel });
  });
  current.webContents.on('console-message', (...args) => {
    const event = typeof args[0]?.message === 'string' ? args[0] : { level: args[1], message: args[2] };
    // HTTP 401/503 are intentionally exercised below. Chromium reports their
    // failed resources to console independently of the application's handlers.
    if ((event.level === 'error' || event.level >= 3) && !/ERR_BLOCKED_BY_CLIENT|Failed to load resource: the server responded with a status of (?:401|503)/.test(event.message)) rendererErrors.push(event.message);
  });
  current.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`Renderer exited: ${details.reason}`));
  return current;
}
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
const configureMotion = () => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
async function waitFor(predicate, label, milliseconds = 8000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > milliseconds) {
      const state = await evaluate(`({ url: location.href, page: document.body.dataset.sitePage, focused: document.activeElement.outerHTML?.slice(0,300), fixtureErrors: window.__navigationFixture?.errors, text: document.body.innerText.slice(-2200) })`).catch(() => ({}));
      state.recentRequests = requests.slice(-15).map(request => request.pathname);
      state.rendererErrors = rendererErrors;
      throw new Error(`${label}: timed out; ${JSON.stringify(state)}`);
    }
    await pause(25);
  }
}
const check = (expression, label) => waitFor(() => evaluate(`Boolean(${expression})`), label);
const click = selector => evaluate(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target) throw new Error(${JSON.stringify(`Missing click target: ${selector}`)}); target.click(); })()`);
const navTarget = href => `Array.from(document.querySelectorAll('.app-header a[href]')).find(link => { const url = new URL(link.href); return url.pathname + url.search === ${JSON.stringify(href)}; })`;
const clickNav = href => evaluate(`(() => { const target = ${navTarget(href)}; if (!target) throw new Error(${JSON.stringify(`Missing navigation link: ${href}`)}); target.click(); })()`);
const focusNav = href => evaluate(`(() => { const link = ${navTarget(href)}; const group = link.closest('details'); if (group) group.open = true; link.focus(); })()`);
const fill = (selector, value) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const press = async key => {
  win.focus();
  win.webContents.focus();
  const virtualKey = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }[key];
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
};
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function capture(name) {
  await settle();
  fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function installBaseline() {
  await evaluate(`(() => {
    window.__navigationFixture = { document, window, timeOrigin: performance.timeOrigin,
      entries: performance.getEntriesByType('navigation').length, errors: [], entered: [], viewTransitions: 0 };
    if (typeof document.startViewTransition === 'function') {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (...args) => { window.__navigationFixture.viewTransitions++; return start(...args); };
    }
    window.addEventListener('error', event => window.__navigationFixture.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.__navigationFixture.errors.push(String(event.reason?.stack || event.reason)));
    window.addEventListener('brclio-page-enter', event => window.__navigationFixture.entered.push(event.detail));
  })()`);
}
async function assertSameDocument(label) {
  assert.equal(await evaluate(`Boolean(window.__navigationFixture && window.__navigationFixture.document === document && window.__navigationFixture.window === window
    && window.__navigationFixture.timeOrigin === performance.timeOrigin && window.__navigationFixture.entries === performance.getEntriesByType('navigation').length)`), true, `${label}: keeps document/window and browser navigation entry`);
  assert.deepEqual(await evaluate('window.__navigationFixture.errors'), [], `${label}: no uncaught errors/rejections`);
}
async function assertPage(page) {
  await check(`document.body.dataset.sitePage === ${JSON.stringify(page)} && !document.documentElement.dataset.siteNavigating`, `enter ${page}`);
  await settle();
  await assertSameDocument(page);
  assert.equal(await evaluate('document.querySelectorAll(".app-header").length'), 1, `${page}: one shared header`);
  const expected = page === 'index' ? '/' : `/${page}.html`;
  assert.equal(await evaluate(`new URL(document.querySelector('.app-header a[aria-current="page"]').href).pathname`), expected, `${page}: current navigation item`);
  const overflow = await evaluate(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: Array.from(document.body.querySelectorAll('*')).filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0,8).map(node => ({ tag: node.tagName, id: node.id, className: node.className?.baseVal ?? node.className, right: node.getBoundingClientRect().right })) })`);
  if (overflow.scrollWidth > overflow.width + 1) {
    overflow.styles = await evaluate(`Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter(link => !link.disabled && link.media !== 'not all').map(link => ({ href: link.href, hasSheet: Boolean(link.sheet), sheetDisabled: link.sheet?.disabled, media: link.sheet?.media.mediaText }))`);
    overflow.qrStyle = await evaluate(`(() => { const image = document.querySelector('.creator-qr-image'); if (!image) return null; const styles = getComputedStyle(image); return { width: styles.width, display: styles.display, parent: image.parentElement.outerHTML.slice(0,300) }; })()`);
    await capture(`overflow-${page}`);
  }
  assert.ok(overflow.scrollWidth <= overflow.width + 1, `${page}: no horizontal overflow; ${JSON.stringify(overflow)}`);
  // A complete local stylesheet allowlist is derived from the built destination.
  // This catches generic body, main, nav, and dialog rules leaking from a page
  // visited earlier, including when returning to a cached body.
  const html = fs.readFileSync(path.join(staticRoot, `${page}.html`), 'utf8');
  const expectedStyles = [...html.matchAll(/<link\b[^>]*>/g)].map(match => match[0]).filter(tag => /rel=["']stylesheet["']/.test(tag))
    .map(tag => tag.match(/href=["']([^"']+)/)?.[1]).filter(Boolean).map(href => new URL(href, `${origin}/${page}.html`).pathname).filter(href => href.endsWith('.css')).sort();
  const activeStyles = await evaluate(`Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter(link => !link.disabled && link.media !== 'not all')
    .map(link => new URL(link.href).pathname).filter(href => href.endsWith('.css')).sort()`);
  assert.deepEqual(activeStyles, expectedStyles, `${page}: only destination CSS is active`);
}
async function navigate(page) {
  await clickNav(page === 'index' ? '/' : `/${page}.html`);
  await assertPage(page);
}

app.whenReady().then(async () => {
  assert.ok(fs.existsSync(path.join(staticRoot, 'site-navigation.js')), 'Run npm run build:web with the public navigation before this check');
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    requests.push({ pathname: url.pathname, at: Date.now() });
    if (url.pathname === '/api/parse') {
      request.resume();
      request.on('end', () => setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ success: true, engine: 'node', title: '切离页面后的异步解析结果', content: '此文案由本地延迟夹具返回。', noteId: '1234567890abcdef12345678', images: [], videos: [] }));
      }, 750));
      return;
    }
    if (url.pathname === '/api/account') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try { const reply = apiFixture(JSON.parse(body), request.headers); response.writeHead(reply.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(reply.body)); }
        catch (error) { rendererErrors.push(error.message); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
      });
      return;
    }
    const send = () => {
      if (response.destroyed) return;
      if (failures.has(url.pathname)) { response.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Navigation fixture temporarily unavailable'); return; }
      try {
        const filename = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
        if (!filename.startsWith(`${staticRoot}${path.sep}`)) throw new Error('Outside fixture');
        const body = fs.readFileSync(filename);
        response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(body);
      } catch { response.writeHead(404); response.end(); }
    };
    if (delays.has(url.pathname)) setTimeout(send, delays.get(url.pathname)); else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  win = await createWindow();
  await win.loadURL(`${origin}/`);
  await configureMotion();
  await check(`document.body.dataset.sitePage === 'index' && document.querySelector('#site-menu-toggle')?.hidden === false`, 'initial public route ready');
  await installBaseline();
  await assertPage('index');
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), reducedMotion, 'configured motion preference applies');
  const homeDraft = '导航往返后保留的下载草稿\nhttps://www.xiaohongshu.com/explore/navigation-fixture';
  await fill('#share-text', homeDraft);
  await evaluate('window.__homeDraftNode = document.querySelector("#share-text")');
  const beforePrefetch = requests.filter(request => request.pathname === '/product.html').length;
  await focusNav('/product.html');
  await evaluate(`${navTarget('/product.html')}.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  await waitFor(() => requests.filter(request => request.pathname === '/product.html').length > beforePrefetch, 'focus prefetch requests destination HTML before click');
  await assertPage('index');
  assert.equal(await evaluate('location.pathname'), '/', 'prefetch retains current route');
  checks.push('navigation hover/focus prefetches first destination without running it or leaving home');

  // Slow first destination followed immediately by another click. The final
  // user's choice must win even when the first response arrives afterwards.
  await evaluate(`${navTarget('/live.html')}.click(); ${navTarget('/download.html')}.click()`);
  await assertPage('download');
  await pause(550);
  await assertPage('download');
  await check(`document.querySelector('#platform-hint').textContent !== ''`, 'download page script runs on first dynamic entry');
  await click('#hero-download');
  await check(`location.hash === '#downloads' && Math.abs(document.getElementById('downloads').getBoundingClientRect().top) < innerHeight`, 'download in-page anchor scroll');
  await assertSameDocument('download anchor');
  checks.push('latest rapid navigation wins; destination script and in-page anchor');

  await navigate('index');
  assert.equal(await evaluate('document.querySelector("#share-text").value'), homeDraft, 'download input draft retained');
  assert.equal(await evaluate('document.querySelector("#share-text") === window.__homeDraftNode'), true, 'download draft retains its actual input node');
  await capture('01-home-returned');
  checks.push('home input and DOM retained across route changes');
  const beforeParse = requests.filter(request => request.pathname === '/api/parse').length;
  await click('#parse-button');
  await waitFor(() => requests.filter(request => request.pathname === '/api/parse').length > beforeParse, 'local parse starts');
  await navigate('download');
  await pause(850);
  assert.equal(await evaluate('document.querySelector("#note-title") === null'), true, 'late parse does not alter another active page');
  await navigate('index');
  await check(`!document.querySelector('#result-section').hidden && document.querySelector('#note-title').textContent === '切离页面后的异步解析结果' && document.querySelector('#note-caption').textContent === '此文案由本地延迟夹具返回。'`, 'in-flight parse completes on cached homepage');
  assert.equal(await evaluate('document.querySelector("#share-text").value'), homeDraft);
  checks.push('in-flight local parse updates its detached page and retains results on return');

  await navigate('live');
  await check(`document.querySelector('#support-note').dataset.supported !== undefined`, 'live capability check completes');
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#287fa3'; context.fillRect(0, 0, 96, 64); context.fillStyle = '#ffee60'; context.fillRect(12, 8, 30, 24);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], '本地素材 fixture.png', { type: 'image/png', lastModified: 1720000000000 }));
    const input = document.getElementById('file-input'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await check(`!document.querySelector('#settings-fields').disabled && document.querySelector('#source-list').textContent.includes('本地素材 fixture.png')`, 'local File and DataTransfer image is decoded');
  await fill('#duration-number', '5');
  await fill('#motion', 'still');
  await fill('#photo-format', 'jpeg');
  await check(`document.querySelector('#photo-format-badge').textContent === 'JPG'`, 'live settings script reacts');
  await evaluate('window.__liveCanvas = document.querySelector("#source-canvas"); window.__livePixel = window.__liveCanvas.toDataURL()');
  await navigate('product');
  await click('[data-media="video"]');
  await check(`document.querySelector('#tab-video').getAttribute('aria-selected') === 'true' && document.querySelector('#art-format').textContent === 'MP4'`, 'product media tabs work');
  await click('.presentation-toggle');
  await check(`document.body.classList.contains('is-presenting')`, 'product presentation opens');
  await press('ArrowRight');
  await check(`document.querySelector('#scene-number').textContent === '02'`, 'product presentation keyboard advances');
  await navigate('live');
  assert.equal(await evaluate(`document.querySelector('#source-canvas') === window.__liveCanvas && document.querySelector('#source-canvas').toDataURL() === window.__livePixel`), true, 'live decoded source DOM and pixels survive return');
  assert.equal(await evaluate('document.querySelector("#duration-number").value'), '5');
  assert.equal(await evaluate('document.querySelector("#motion").value'), 'still');
  assert.equal(await evaluate('document.querySelector("#photo-format").value'), 'jpeg');
  assert.equal(await evaluate('document.querySelector("#settings-fields").disabled'), false);
  assert.equal(await evaluate('document.body.classList.contains("is-presenting")'), false, 'presentation state does not leak into live');
  await capture('02-live-returned');
  await click('a[href="#import-help"]');
  await check(`location.hash === '#import-help'`, 'live import anchor');
  await navigate('index');
  await evaluate('history.back()');
  await assertPage('live');
  await check(`location.hash === '#import-help'`, 'history back restores route hash');
  await evaluate('history.forward()');
  await assertPage('index');
  checks.push('live File, decoded image and settings retained; product tabs/presentation; Back/Forward and hash');

  for (const page of ['learn', 'vip']) {
    await navigate(page);
    await click('#qr-open');
    await check(`document.querySelector('#qr-dialog').open`, `${page} QR opens after dynamic entry`);
    await press('Escape');
    await check(`!document.querySelector('#qr-dialog').open && document.activeElement.id === 'qr-open'`, `${page} QR Escape restores focus`);
    await navigate('product');
    await click('[data-media="text"]');
    await check(`document.querySelector('#art-format').textContent === 'TXT'`, 'cached product handler still works');
    await navigate(page);
    await click('#qr-open'); await click('#qr-close');
    await check(`!document.querySelector('#qr-dialog').open`, `${page} cached QR explicit close`);
  }
  await navigate('membership');
  await check(`document.querySelector('[data-starting-price]').textContent.includes('¥') && document.querySelectorAll('[data-plan]').length >= 3`, 'membership module initializes');
  checks.push('first and cached classic/module initialization; independent QR dialogs; membership plans');

  await navigate('changelog');
  await fill('#release-query', 'fixture-no-release-zz');
  await check(`!document.querySelector('.release-empty').hidden && new URLSearchParams(location.search).get('q') === 'fixture-no-release-zz'`, 'changelog input filters and writes URL');
  await navigate('learn');
  await evaluate('history.back()');
  await assertPage('changelog');
  await check(`document.querySelector('#release-query').value === 'fixture-no-release-zz' && !document.querySelector('.release-empty').hidden`, 'changelog back reads URL and restores filters');
  await click('#release-reset');
  await check(`document.querySelector('#release-query').value === '' && document.querySelector('.release-empty').hidden`, 'cached changelog reset works');
  await click('[data-release-filter="web"]');
  await check(`document.querySelector('[data-release-filter="web"]').getAttribute('aria-pressed') === 'true'`, 'cached changelog platform filter');
  await navigate('learn');
  await navigate('changelog');
  await check(`new URLSearchParams(location.search).get('scope') === 'web' && document.querySelector('[data-release-filter="web"]').getAttribute('aria-pressed') === 'true'`, 'plain navigation resumes cached changelog filters');
  await click('#release-reset');
  const releaseAnchor = await evaluate(`Array.from(document.querySelectorAll('.release-index-nav a[href^="#"]')).find(link => !link.hidden).getAttribute('href')`);
  await click(`.release-index-nav a[href="${releaseAnchor}"]`);
  await check(`location.hash === ${JSON.stringify(releaseAnchor)} && !document.documentElement.dataset.siteNavigating`, 'release anchor route settled');
  await evaluate(`scrollBy({ top: 240, behavior: 'instant' })`);
  await settle();
  const releaseScroll = await evaluate('scrollY');
  await navigate('learn');
  await evaluate('history.back()');
  await assertPage('changelog');
  await settle();
  assert.ok(Math.abs((await evaluate('scrollY')) - releaseScroll) <= 2, 'history returns to saved reading position after manually scrolling away from an anchor');
  checks.push('changelog filters/query, cached reset/resume, history and saved reading position after anchor');

  await navigate('feedback');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 2`, 'anonymous feedback list renders');
  await click('[data-status-filter="resolved"]');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 1 && document.querySelector('.feedback-issue-link').textContent.includes('已解决下载')`, 'feedback status handler works');
  await click('[data-status-filter=""]');
  await check(`document.querySelectorAll('.feedback-issue-link').length === 2`, 'feedback all restored');
  await click(`.feedback-issue-link[data-feedback-id="${issues[0].id}"]`);
  await check(`!document.querySelector('#feedback-detail').hidden && document.querySelector('#feedback-detail-title').textContent === ${JSON.stringify(issues[0].title)}`, 'feedback issue query handled locally');
  await fill('#feedback-comment-content', '导航返回后保留的公开评论草稿');
  await navigate('learn');
  await evaluate('history.back()');
  await assertPage('feedback');
  await check(`document.querySelector('#feedback-comment-content').value === '导航返回后保留的公开评论草稿' && new URLSearchParams(location.search).get('issue') === ${JSON.stringify(issues[0].id)}`, 'feedback detail URL and draft survive history');
  await click('#feedback-login-open');
  await check(`document.querySelector('#feedback-login-dialog').open`, 'feedback login dialog initialized independently');
  await click('#feedback-login-close');
  await clickNav('/?account=open');
  await assertPage('index');
  await check(`document.querySelector('#browser-account-dialog').open`, 'cached homepage account entry query opens account UI');
  await check(`document.querySelector('#account-google-login-row').hidden === false && !document.querySelector('#account-google-login').disabled`, 'Google sign-in remains available in the cached homepage account dialog');
  await click('#browser-account-close');
  assert.equal(await evaluate('document.querySelector("#share-text").value'), homeDraft);
  checks.push('anonymous feedback filters/detail/draft; account query opens cached homepage dialog');

  win.setContentSize(390, 844);
  await settle();
  await evaluate('document.querySelector("#site-menu-toggle").focus()');
  await press('Enter');
  await check(`document.querySelector('#site-menu-toggle').getAttribute('aria-expanded') === 'true'`, 'mobile keyboard menu opens');
  await press('Escape');
  await check(`document.querySelector('#site-menu-toggle').getAttribute('aria-expanded') === 'false' && document.activeElement.id === 'site-menu-toggle'`, 'mobile Escape closes and restores focus');
  await press('Enter');
  await check(`document.querySelector('#site-menu-toggle').getAttribute('aria-expanded') === 'true'`, 'mobile keyboard menu reopens');
  await focusNav('/learn.html');
  await press('Enter');
  await assertPage('learn');
  await check(`document.querySelector('#site-menu-toggle').getAttribute('aria-expanded') === 'false'`, 'mobile keyboard route entry closes menu');
  await click('a[href="#contact"]');
  await check(`location.hash === '#contact' && Math.abs(document.querySelector('#contact').getBoundingClientRect().top) < innerHeight`, 'mobile anchor remains accessible under reduced motion');
  await capture('03-mobile-learning');
  const viewTransitions = await evaluate('window.__navigationFixture.viewTransitions');
  assert.ok(reducedMotion ? viewTransitions === 0 : viewTransitions > 0, 'normal motion uses view transitions; reduced motion skips them');
  checks.push('mobile Enter/Escape/menu focus/navigation; reduced-motion anchors; no overflow');

  // A fresh window ensures this destination is not in the body cache. Failure
  // remains active during any speculative prefetch, then a normal retry works.
  failures.add('/membership.html');
  const previousWindow = win;
  win = await createWindow();
  await win.loadURL(`${origin}/learn.html`);
  await configureMotion();
  await check(`document.body.dataset.sitePage === 'learn' && document.querySelector('#site-menu-toggle')?.hidden === false`, 'direct non-home initial route ready');
  await installBaseline();
  await assertPage('learn');
  await navigate('index');
  await check(`Boolean(document.querySelector('#browser-account-mount .software-account'))`, 'homepage module first initializes after direct non-home entry');
  checks.push('direct learning URL can enter homepage and initialize its module/account UI without reload');
  await fill('#share-text', '失败时保留的下载草稿');
  const beforeFailure = requests.filter(request => request.pathname === '/membership.html').length;
  await clickNav('/membership.html');
  await waitFor(() => requests.filter(request => request.pathname === '/membership.html').length > beforeFailure, 'failed route request observed');
  await check(`Boolean(document.querySelector('.site-navigation-error[role="status"] button')) && !document.documentElement.dataset.siteNavigating`, 'failure reports retry while preserving current route');
  await assertPage('index');
  assert.equal(await evaluate('location.pathname'), '/', 'failed route leaves existing URL');
  assert.equal(await evaluate('document.querySelector("#share-text").value'), '失败时保留的下载草稿');
  failures.delete('/membership.html');
  await click('.site-navigation-error button');
  await assertPage('membership');
  await capture('04-failure-retried');
  await assertSameDocument('failure recovery');
  for (const [page, asset, currentPage] of [['vip', '/vip.css', 'membership'], ['product', '/product.js', 'vip']]) {
    failures.add(asset);
    await clickNav(`/${page}.html`);
    await check(`Boolean(document.querySelector('.site-navigation-error[role="status"] button')) && !document.documentElement.dataset.siteNavigating`, `${asset} failure reports retry`);
    await assertPage(currentPage);
    assert.equal(await evaluate('location.pathname'), `/${currentPage}.html`, `${asset} failure preserves old URL`);
    failures.delete(asset);
    await click('.site-navigation-error button');
    await assertPage(page);
  }
  await click('[data-media="text"]');
  await check(`document.querySelector('#art-format').textContent === 'TXT'`, 'script asset retry initializes destination interaction');
  previousWindow.destroy();
  checks.push('failed first page load preserves old document, URL and draft; retry recovers');
  checks.push('failed stylesheet and script fetches preserve old route; independent retries initialize destination');

  assert.deepEqual(rendererErrors, [], 'no application console errors');
  assert.ok(apiCalls.some(call => call.action === 'me'), 'anonymous account fixture exercised');
  assert.ok(apiCalls.some(call => call.action === 'google-config'), 'public Google configuration fixture exercised');
  assert.ok(apiCalls.every(call => ['me', 'google-config', 'reviews-public', 'feedback-public-list', 'feedback-public-detail'].includes(call.action)), 'only read-only local API operations occur');
  console.log(JSON.stringify({ result: 'PASS', scope: 'real Chromium, dist-web via local HTTP fixture; external network blocked; disposable profile', reducedMotion, viewTransitions, checks, screenshots, blockedRequestCount: blockedRequests.length, apiActions: [...new Set(apiCalls.map(call => call.action))] }));
  await finish(0);
}).catch(error => finish(1, error));
