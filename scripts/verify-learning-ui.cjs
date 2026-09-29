// Real Chromium smoke checks for the public build and packaged desktop protocol.
// Run after npm run build:web: npx electron scripts/verify-learning-ui.cjs
// Uses a disposable profile, local server and temporary downloads only.
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-learning-ui-'));
const screenshots = path.join(temporary, 'screenshots');
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
const timeout = setTimeout(() => finish(1, new Error('LEARNING_UI_TIMEOUT')), 75_000);
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

app.whenReady().then(async () => {
  assert.ok(fs.existsSync(path.join(root, 'dist-web/learn.html')), 'Run npm run build:web before this check');
  const { createProtocolHandler } = await import(pathToFileURL(path.join(root, 'desktop/protocol.js')).href);
  protocol.handle('xhs-app', createProtocolHandler({ rootDirectory: root }));
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
    } catch {
      response.writeHead(404); response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const webOrigin = `http://127.0.0.1:${address.port}`;

  win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: ![webOrigin + '/', 'xhs-app://local/', 'data:', 'blob:'].some(prefix => details.url.startsWith(prefix)),
  }));
  const rendererErrors = [];
  win.webContents.on('console-message', details => {
    if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) rendererErrors.push(details.message);
  });
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const capture = async name => {
    await settle();
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const snapshot = () => evaluate(`(() => ({
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    images: Array.from(document.images).map(image => ({ src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0 })),
    dialogOpen: document.querySelector('#qr-dialog').open,
    focused: document.activeElement.id,
  }))()`);

  for (const [surface, origin] of [['web', webOrigin], ['desktop', 'xhs-app://local']]) {
    const failedRequests = [];
    const onFailure = (_event, code, description, url) => failedRequests.push({ code, description, url });
    win.webContents.on('did-fail-load', onFailure);
    win.setContentSize(1440, 1000);
    await win.loadURL(`${origin}/learn.html`);
    assert.equal(await evaluate('document.title'), '书籍与编程私教 · Brclio');
    await evaluate(`document.querySelector('#contact').scrollIntoView({ block: 'start', behavior: 'instant' })`);
    await waitFor(async () => (await snapshot()).images.every(item => item.loaded), `${surface}: images loaded`);
    assert.ok((await snapshot()).images.length >= 2, `${surface}: book and QR images exist`);
    assert.equal(await evaluate(`document.querySelector('script[src$="learn.js"]') !== null`), true);
    for (const id of ['main', 'book', 'courses', 'contact']) {
      assert.equal(await evaluate(`Boolean(document.getElementById(${JSON.stringify(id)}))`), true, `${surface}: #${id}`);
    }

    for (const width of [1440, 900, 390, 320]) {
      win.setContentSize(width, 1000);
      await settle();
      await evaluate('scrollTo(0, 0)');
      const current = await snapshot();
      assert.ok(current.scrollWidth <= current.width + 1, `${surface}: no page overflow at ${width}px (${current.scrollWidth})`);
      await capture(`${surface}-${width}-hero`);
      if (width === 1440 || width === 390) {
        for (const section of ['book', 'courses']) {
          await evaluate(`document.getElementById(${JSON.stringify(section)}).scrollIntoView({ block: 'start', behavior: 'instant' })`);
          await capture(`${surface}-${width}-${section}`);
        }
      }
      await evaluate(`document.querySelector('#contact').scrollIntoView({ block: 'start', behavior: 'instant' })`);
      await capture(`${surface}-${width}-contact`);
      await evaluate(`document.querySelector('#qr-open').focus()`);
      await click('#qr-open');
      assert.equal((await snapshot()).dialogOpen, true, `${surface}: QR opens at ${width}px`);
      const dialog = await evaluate(`(() => { const d = document.querySelector('#qr-dialog'); const r = d.getBoundingClientRect();
        return { left: r.left, right: r.right, width: d.clientWidth, scroll: d.scrollWidth }; })()`);
      assert.ok(dialog.left >= -1 && dialog.right <= width + 1 && dialog.scroll <= dialog.width + 1,
        `${surface}: QR dialog fits ${width}px`);
      if (width === 1440 || width === 320) await capture(`${surface}-${width}-qr-dialog`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await waitFor(async () => !(await snapshot()).dialogOpen, `${surface}: Escape closes QR`);
      assert.equal((await snapshot()).focused, 'qr-open', `${surface}: dialog restores keyboard focus`);
    }
    checks.push(`${surface}: responsive 1440/900/390/320, loaded images, QR dialog and Escape/focus`);

    win.setContentSize(900, 1000);
    const anchor = await evaluate(`Array.from(document.querySelectorAll('a[href="#contact"]')).find(a => a.getBoundingClientRect().width > 0)?.outerHTML`);
    assert.ok(anchor, `${surface}: visible consultation link`);
    await click('a[href="#contact"]');
    await waitFor(() => evaluate(`location.hash === '#contact'`), `${surface}: consultation anchor`);
    await settle();
    assert.ok(await evaluate(`Math.abs(document.querySelector('#contact').getBoundingClientRect().top) < innerHeight`), `${surface}: consultation section reached`);
    await click('#qr-open');
    await click('#qr-close');
    assert.equal((await snapshot()).dialogOpen, false, `${surface}: explicit QR close`);

    const savedPath = path.join(temporary, `${surface}-wechat-qr.png`);
    let download;
    const onDownload = (_event, item) => {
      item.setSavePath(savedPath);
      download = new Promise((resolve, reject) => item.once('done', (_doneEvent, state) => {
        if (state === 'completed') resolve(); else reject(new Error(`${surface}: QR download ${state}`));
      }));
    };
    win.webContents.session.once('will-download', onDownload);
    await click('#qr-save');
    await waitFor(() => Boolean(download), `${surface}: QR download begins`);
    await download;
    assert.deepEqual(fs.readFileSync(savedPath), fs.readFileSync(path.join(root, 'assets/support/wechat-personal-qr.png')),
      `${surface}: saved QR is the unchanged source crop`);
    assert.equal(new URL(win.webContents.getURL()).pathname, '/learn.html', `${surface}: saving QR keeps the page open`);
    checks.push(`${surface}: consultation anchor, explicit dialog close, QR save exact bytes`);

    const returned = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await click('#back-to-tool');
    await returned;
    await waitFor(() => ['/index.html', '/'].includes(new URL(win.webContents.getURL()).pathname), `${surface}: return to tool`);
    assert.deepEqual(failedRequests, [], `${surface}: no failed navigation`);
    win.webContents.removeListener('did-fail-load', onFailure);
    checks.push(`${surface}: return to tool`);
  }

  assert.deepEqual(rendererErrors, [], 'no renderer errors');
  console.log(JSON.stringify({ result: 'PASS', scope: 'real Chromium, built public web via local HTTP fixture and desktop xhs-app protocol; local resources only', checks, screenshots }));
  await finish(0);
}).catch(error => finish(1, error));
