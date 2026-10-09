// Real Chromium renderers over local fixtures; no production writes or messages.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-commerce-ui-'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
let server, win, origin, finished = false;
const errors = [], calls = [], reviews = [], orderIds = new Map();
let user = 'a', failReviewOnce = true, failMineOnce = true, delayOrders = false, releaseOrders, delayPayment = false, releasePayment;
const at = '2026-10-09T00:00:00.000Z';
const account = () => ({ user: { id: user, email: `${user}@example.test` }, membership: { type: 'none', active: false }, device: { status: 'authorized' }, serverTime: at });
const result = data => ({ ok: true, ...data, serverTime: at });
const state = () => ({ configured: true, authenticated: Boolean(user), verified: Boolean(user), status: user ? 'ready' : 'logged_out', account: user ? account() : null });
function route(action, input = {}) {
  calls.push({ action, input: structuredClone(input) });
  if (action === 'me' || action === 'verify-code') return result({ account: account() });
  if (action === 'send-code') return result({ retryAfterSeconds: 60 });
  if (action === 'logout') { user = null; return result({}); }
  if (action === 'reviews-public') {
    const all = [...reviews, ...Array.from({ length: 8 }, (_, i) => ({ id: `public-${i}`, rating: 4, authorLabel: `用户 ${i}`, content: i ? '这个工具使用起来很方便' : '<img src=x onerror="window.fixtureXss=true">', createdAt: at }))];
    const page = input.page || 1, pageSize = input.pageSize || 6;
    return result({ reviews: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize, totalPages: Math.ceil(all.length / pageSize), summary: { count: all.length, averageRating: 4 } });
  }
  if (action === 'review-mine') { if(failMineOnce) {failMineOnce=false;return {ok:false,error:{code:'SERVICE_UNAVAILABLE',message:'我的评价暂不可读，请重试。'}}} return result({ review: reviews.find(item => item.owner === user) || null }); }
  if (action === 'review-submit') {
    assert.equal(input.expectedUserId, user);
    if (failReviewOnce) { failReviewOnce = false; return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '网络未确认，请重试原评价。' } }; }
    assert.equal(reviews.some(item => item.owner === user), false);
    const review = { id: 'review-1', owner: user, rating: input.rating, content: input.content, authorLabel: '匿名用户', createdAt: at };
    reviews.unshift(review); return result({ review });
  }
  if (action === 'orders-mine') {
    const owner = user, page = input.page || 1, pageSize = input.pageSize || 10;
    const body = result({ orders: Array.from({ length: page === 3 ? 3 : 10 }, (_, i) => ({ id: `${owner}-order-${(page - 1) * pageSize + i}`, status: 'confirmed', planName: '月会员', priceCents: 1990, amountCents: 1990, paymentMethod: 'wechat', paidAt: at, createdAt: at })), total: 23, page, pageSize, totalPages: 3 });
    if (delayOrders) { delayOrders = false; return new Promise(resolve => { releaseOrders = () => resolve(body); }); }
    return body;
  }
  if (action === 'order-create') {
    assert.equal(input.expectedUserId, user); assert.equal(input.planId, 'monthly');
    if (!orderIds.has(input.requestId)) orderIds.set(input.requestId, `purchase-${orderIds.size + 1}`);
    const response=result({ order: { id: orderIds.get(input.requestId), status: 'pending' } });
    if(delayPayment){delayPayment=false;return new Promise(resolve=>{releasePayment=()=>resolve(response)})} return response;
  }
  throw new Error(`Unexpected action ${action}`);
}
async function finish(code, error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  app.exit(code);
}
const timeout = setTimeout(() => void finish(1, new Error('COMMERCE_UI_TIMEOUT')), 90_000);
app.whenReady().then(async () => {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/api/account') {
        const parts = []; for await (const part of req) parts.push(part);
        const { action, input } = JSON.parse(Buffer.concat(parts));
        assert.equal(input.client, 'browser');
        const body = await route(action, input);
        res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
      }
      if (url.pathname === '/fixture.js') {
        const code = `document.body.classList.add('is-desktop'); document.getElementById('desktop-reviews-page').hidden=false; document.getElementById('desktop-navigation').hidden=false; document.querySelectorAll('#single-note-panel,#profile-panel,.hero,#desktop-account-page').forEach(el=>el.hidden=true);
window.fixtureListeners=[];
window.fixtureUpdate = value => window.fixtureListeners.forEach(fn=>fn(value));
window.xhsDesktop={getAccountState:async()=>window.fixtureState,onAccountUpdate:fn=>{window.fixtureListeners.push(fn);return()=>{}},refreshAccount:async()=>({ok:true,state:window.fixtureState}),commerceRequest:async(action,input)=>{const result=await fetch('/desktop-fixture',{method:'POST',body:JSON.stringify({action,input})}).then(r=>r.json());return {ok:result.ok,result,error:result.error,state:window.fixtureState}}};
window.fixtureState=${JSON.stringify(state())};`;
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(code); return;
      }
      if (url.pathname === '/desktop-fixture') {
        const parts = []; for await (const part of req) parts.push(part);
        const { action, input } = JSON.parse(Buffer.concat(parts));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(await route(action, input))); return;
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.includes('..')) { res.writeHead(404); res.end(); return; }
      const file = path.join(root, name);
      let bytes = fs.readFileSync(file);
      if (name === 'index.html') {
        let html = bytes.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        html = html.replace('</body>', `${url.searchParams.has('desktop') ? '<script src="/fixture.js"></script>' : ''}<script type="module" src="/account-ui.js"></script></body>`);
        bytes = Buffer.from(html);
      }
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' }); res.end(bytes);
    } catch (error) { if (error.code !== 'ENOENT') errors.push(error.message); res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 960, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin) && !details.url.startsWith('data:') }));
  win.webContents.on('console-message', (_event, details)=>{if(details.level==='error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) console.error('Renderer:',details.message)});
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const until = script => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(${script})resolve();else if(Date.now()-start>8000)reject(new Error('Timeout: '+${JSON.stringify(script)}));else setTimeout(check,20)};check()})`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const capture = async name => { fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  await win.loadURL(`${origin}/`);
  await until(`document.querySelectorAll('.review-item').length===6 && document.querySelectorAll('.order-item').length===10 && document.getElementById('review-mine-retry').querySelector('button')`);
  assert.equal(await evaluate(`document.getElementById('review-form').hidden`),true);
  await evaluate(`document.getElementById('review-mine-retry').querySelector('button').click()`);
  await until(`!document.getElementById('review-form').hidden`);
  assert.equal(await evaluate('Boolean(window.fixtureXss)'), false);
  assert.equal(await evaluate(`document.getElementById('review-list').querySelectorAll('img').length`), 0);
  await click('browser-account-open');
  await evaluate(`document.getElementById('orders-pagination').querySelectorAll('button')[1].click()`);
  await until(`document.getElementById('orders-list').textContent.includes('a-order-10')`);
  await evaluate(`document.getElementById('orders-pagination').querySelectorAll('button')[1].click()`);
  await until(`document.querySelectorAll('.order-item').length===3`);
  await click('account-open-membership'); await click('membership-report-paid');
  await until(`document.getElementById('membership-order-status').textContent.includes('purchase-1')`);
  assert.equal(orderIds.size, 1);
  await click('membership-close'); await click('browser-account-close');
  await evaluate(`document.getElementById('review-content').value='真实的使用体验，下载很方便';document.getElementById('review-form').requestSubmit()`);
  await until(`document.getElementById('review-account-notice').textContent.includes('网络未确认') && !document.getElementById('review-submit').disabled`);
  await evaluate(`document.getElementById('review-form').requestSubmit()`);
  await until(`document.getElementById('review-form').hidden && document.getElementById('review-list').textContent.includes('真实的使用体验')`);
  const submissions = calls.filter(item => item.action === 'review-submit');
  assert.equal(submissions.length, 2); assert.equal(submissions[0].input.requestId, submissions[1].input.requestId); assert.equal(reviews.length, 1);
  await evaluate(`document.getElementById('software-reviews').scrollIntoView()`); await capture('web-reviews');
  for (const width of [900, 375]) {
    win.setSize(width, 960);
    await evaluate(`document.getElementById('software-reviews').scrollIntoView({behavior:'instant',block:'start'})`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth + 1`), false, `No page overflow at ${width}px`);
    await capture(`web-reviews-${width}`);
  }
  win.setSize(1280, 960); await click('browser-account-open');
  delayOrders = true; await click('orders-refresh');
  await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(releaseOrders){clearInterval(timer);resolve()}else if(Date.now()-start>8000){clearInterval(timer);reject(new Error('Delayed order request did not start'))}},10)});
  // Logout must clear already-rendered orders and reject any old pending response.
  await click('account-logout');
  await until(`document.getElementById('account-details').hidden`);
  releaseOrders();
  await until(`document.getElementById('account-notice').textContent==='操作完成。'`);
  await until(`document.getElementById('orders-list').children.length===0`);
  assert.equal(await evaluate(`document.getElementById('review-form').hidden`), true);
  user = 'b';
  await win.loadURL(`${origin}/?desktop=1`);
  await until(`document.querySelectorAll('.review-item').length===6 && !document.getElementById('review-form').hidden && document.getElementById('orders-list').textContent.includes('b-order-0')`);
  assert.equal(await evaluate(`document.getElementById('orders-list').textContent.includes('a-order')`), false);
  await evaluate(`document.getElementById('software-reviews').scrollIntoView()`); await capture('desktop-reviews');
  delayPayment=true; await click('account-open-membership'); await click('membership-report-paid');
  await new Promise(resolve=>{const timer=setInterval(()=>{if(releasePayment){clearInterval(timer);resolve()}},10)});
  const signedIn=state();
  await evaluate(`window.fixtureUpdate({configured:true,authenticated:false,verified:false,status:'logged_out',account:null});window.fixtureUpdate(${JSON.stringify(signedIn)})`);
  await click('membership-report-paid');
  await until(`document.getElementById('membership-order-status').textContent.includes('purchase-3')`);
  releasePayment();
  await evaluate(`new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await evaluate(`document.getElementById('membership-order-status').textContent.includes('purchase-3')`),true,'Old payment completion cannot overwrite a fresh login to the same account');
  await click('membership-close');
  await evaluate(`window.fixtureUpdate({configured:true,authenticated:false,verified:false,status:'logged_out',account:null})`);
  assert.equal(await evaluate(`document.getElementById('orders-list').children.length`), 0);
  assert.equal(await evaluate(`document.getElementById('review-form').hidden`), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['public pagination and rating', 'XSS rendered as text', 'all personal order pages', 'payment report creates pending order', 'uncertain evaluation retries same requestId', 'single evaluation locks composer', '375px and 900px layout', 'late private response after logout discarded', 'desktop bridge and account switching', 'private evaluation read failure retains retry', 'old payment result after re-login cannot overwrite new request'], screenshots: directory }, null, 2));
  await finish(0);
}).catch(error => void finish(1,error));
