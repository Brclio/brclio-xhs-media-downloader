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
const errors = [], calls = [], reviews = [];
let user = 'a', failReviewOnce = true, failMineOnce = true, failProfileOnce = true, delayOrders = false, releaseOrders, delayProfile = false, releaseProfile;
const nicknames = new Map([['a', '听风的小鹿'], ['b', '追光的小熊']]);
const at = '2026-10-09T00:00:00.000Z';
const account = () => ({ user: { id: user, email: `${user}@example.test`, nickname: nicknames.get(user) }, membership: { type: 'none', active: false }, device: { status: 'authorized' }, serverTime: at });
const result = data => ({ ok: true, ...data, serverTime: at });
const state = () => ({ configured: true, authenticated: Boolean(user), verified: Boolean(user), status: user ? 'ready' : 'logged_out', account: user ? account() : null });
function route(action, input = {}) {
  calls.push({ action, input: structuredClone(input) });
  if (action === 'google-config') return result({ enabled: true });
  if (action === 'payment-catalog') return result({ catalog: { enabled: true, mode: 'live', currency: 'CNY', version: 'fixture', ...(input.provider === 'wechat' ? { provider: 'wechat', channels: ['native'] } : {}), plans: [{ id: 'monthly', name: '月付', days: 30, priceCents: 1990, amount: '19.90' }] } });
  if (action === 'me' || action === 'verify-code') return result({ account: account() });
  if (action === 'send-code') return result({ retryAfterSeconds: 60 });
  if (action === 'logout') { user = null; return result({}); }
  if (action === 'profile-update') {
    assert.equal(input.expectedUserId, user);
    if (failProfileOnce) { failProfileOnce = false; return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '昵称保存未确认，请保留原昵称重试。' } }; }
    nicknames.set(user, input.nickname);
    for (const review of reviews.filter(item => item.owner === user)) review.authorLabel = input.nickname;
    const response = result({ profile: { nickname: input.nickname } });
    if (delayProfile) { delayProfile = false; return new Promise(resolve => { releaseProfile = () => resolve(response); }); }
    return response;
  }
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
    nicknames.set(user, input.nickname);
    const review = { id: 'review-1', owner: user, rating: input.rating, content: input.content.replace('me@example.test', '[EMAIL]'), authorLabel: input.nickname, createdAt: at };
    reviews.unshift(review); return result({ review, profile: { nickname: input.nickname } });
  }
  if (action === 'orders-mine') {
    const owner = user, page = input.page || 1, pageSize = input.pageSize || 10;
    const body = result({ orders: Array.from({ length: page === 3 ? 3 : 10 }, (_, i) => ({ id: `${owner}-order-${(page - 1) * pageSize + i}`, status: 'confirmed', planName: '月会员', priceCents: 1990, amountCents: 1990, paymentMethod: 'wechat', paidAt: at, createdAt: at })), total: 23, page, pageSize, totalPages: 3 });
    if (delayOrders) { delayOrders = false; return new Promise(resolve => { releaseOrders = () => resolve(body); }); }
    return body;
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
        const { action, input, proof } = JSON.parse(Buffer.concat(parts));
        assert.equal(input.client, 'browser');
        if (action === 'google-config') {
          assert.equal(req.headers.authorization, undefined, 'Public Google configuration must not send an account token');
          assert.equal(proof, undefined, 'Public Google configuration must not send a device proof');
        }
        const body = await route(action, input);
        res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
      }
      if (url.pathname === '/fixture.js') {
        const code = `document.body.classList.add('is-desktop'); document.getElementById('desktop-reviews-page').hidden=false; document.getElementById('desktop-navigation').hidden=false; document.querySelectorAll('#single-note-panel,#profile-panel,.hero,#desktop-account-page').forEach(el=>el.hidden=true);
window.fixtureListeners=[];
window.fixtureUpdate = value => window.fixtureListeners.forEach(fn=>fn(value));
window.xhsDesktop={getInfo:async()=>({version:'fixture',platform:'darwin'}),getProfileState:async()=>({status:'idle',items:[]}),onProfileUpdate:()=>()=>{},getAccountState:async()=>window.fixtureState,onAccountUpdate:fn=>{window.fixtureListeners.push(fn);return()=>{}},refreshAccount:async()=>({ok:true,state:window.fixtureState}),commerceRequest:async(action,input)=>{const result=await fetch('/desktop-fixture',{method:'POST',body:JSON.stringify({action,input})}).then(r=>r.json());return {ok:result.ok,result,error:result.error,state:window.fixtureState}}};
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
  const assertOnlineMembership = async () => {
    assert.equal(await evaluate(`document.querySelector('#membership-report-paid, #membership-payment, #membership-payment-image, input[name="membership-plan"], input[name="membership-method"], .membership-order-report, .membership-payment-qr')===null`), true, 'Manual purchase, payment report and static collection QR controls are removed');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('#membership-dialog img')).some(image=>/assets\\/membership\\/(?:wechat-pay\\.png|alipay\\.png)/.test(image.getAttribute('src')||''))`), false, 'The membership dialog has no original static Alipay or WeChat collection QR');
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('input[name="membership-online-method"]')).map(input=>input.value).sort()`), ['alipay', 'wechat']);
    assert.equal(await evaluate(`Boolean(document.getElementById('account-redeem-form')&&document.getElementById('membership-go-redeem'))`), true, 'Existing activation codes remain redeemable');
    assert.equal(await evaluate(`document.getElementById('orders-list').textContent.includes('-order-')`), true, 'Historical manual orders remain visible');
    await click('account-open-membership');
    await until(`!document.getElementById('membership-online-payment').hidden && !document.getElementById('membership-online-pay').disabled`);
    await evaluate(`document.querySelector('input[name="membership-online-method"][value="wechat"]').click()`);
    await until(`document.getElementById('membership-online-method-help').textContent.includes('Native') && !document.getElementById('membership-online-pay').disabled`);
    assert.equal(await evaluate(`document.getElementById('membership-online-quote').textContent.includes('19.90')`), true);
    assert.equal(calls.some(call => call.action === 'payment-catalog' && call.input.provider === 'wechat'), true);
    await click('membership-close');
  };
  const capture = async name => { fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const showReviews = async () => {
    await evaluate(`document.getElementById('software-reviews').scrollIntoView({behavior:'instant',block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`(()=>{const rect=document.getElementById('software-reviews').getBoundingClientRect();return rect.top<innerHeight&&rect.bottom>0})()`), true, 'Review evidence must show the review section');
  };
  await win.loadURL(`${origin}/`);
  await until(`document.querySelectorAll('.review-item').length===6 && document.querySelectorAll('.order-item').length===10 && document.getElementById('review-mine-retry').querySelector('button')`);
  assert.equal(await evaluate(`document.getElementById('review-form').hidden`),true);
  await evaluate(`document.getElementById('review-mine-retry').querySelector('button').click()`);
  await until(`!document.getElementById('review-form').hidden`);
  const oldNickname = await evaluate(`document.getElementById('review-nickname').value`);
  await click('review-nickname-random');
  const randomNickname = await evaluate(`document.getElementById('review-nickname').value`);
  assert.notEqual(randomNickname, oldNickname);
  assert.equal(await evaluate(`import('/lib/review-nicknames.js').then(module=>module.REVIEW_NICKNAMES.length===1000&&module.REVIEW_NICKNAMES.includes(document.getElementById('review-nickname').value))`), true);
  await evaluate(`document.getElementById('review-nickname').value='<b>星河下载客</b>';document.getElementById('review-nickname').dispatchEvent(new Event('input'));document.getElementById('review-profile-form').requestSubmit()`);
  await until(`document.getElementById('review-profile-notice').textContent.includes('昵称保存未确认') && !document.getElementById('review-nickname-save').disabled`);
  assert.equal(await evaluate(`document.getElementById('review-nickname').readOnly`), true);
  await click('review-nickname-save');
  await until(`document.getElementById('review-profile-notice').textContent.includes('昵称已保存') && !document.getElementById('review-nickname').readOnly`);
  const nicknameRetries = calls.filter(call => call.action === 'profile-update');
  assert.equal(nicknameRetries.length, 2); assert.equal(nicknameRetries[0].input.requestId, nicknameRetries[1].input.requestId);
  assert.equal(await evaluate(`document.getElementById('account-nickname').textContent`), '<b>星河下载客</b>');
  assert.equal(await evaluate('Boolean(window.fixtureXss)'), false);
  assert.equal(await evaluate(`document.getElementById('review-list').querySelectorAll('img').length`), 0);
  await click('browser-account-open');
  await until(`document.getElementById('browser-account-dialog').open`);
  await click('account-nickname-settings');
  await until(`!document.getElementById('browser-account-dialog').open && document.activeElement.id==='review-nickname'`);
  await until(`(()=>{const rect=document.getElementById('review-nickname').getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight})()`);
  assert.equal(await evaluate(`document.getElementById('review-profile-form').hidden`), false, 'Web nickname link opens the editable form outside the closed account dialog');
  await click('browser-account-open');
  await evaluate(`document.getElementById('orders-pagination').querySelectorAll('button')[1].click()`);
  await until(`document.getElementById('orders-list').textContent.includes('a-order-10')`);
  await evaluate(`document.getElementById('orders-pagination').querySelectorAll('button')[1].click()`);
  await until(`document.querySelectorAll('.order-item').length===3`);
  await assertOnlineMembership();
  await click('browser-account-close');
  const originalContent = '  真实的使用体验，下载很方便；电话13800138000；订单ABC-123；链接https://example.test/?token=public-value；邮箱me@example.test  ';
  await evaluate(`document.getElementById('review-content').value=${JSON.stringify(originalContent)};document.getElementById('review-form').requestSubmit()`);
  await until(`document.getElementById('review-account-notice').textContent.includes('网络未确认') && !document.getElementById('review-submit').disabled`);
  await evaluate(`document.getElementById('review-form').requestSubmit()`);
  await until(`document.getElementById('review-form').hidden && document.getElementById('review-list').textContent.includes('真实的使用体验')`);
  const submissions = calls.filter(item => item.action === 'review-submit');
  assert.equal(submissions.length, 2); assert.equal(submissions[0].input.requestId, submissions[1].input.requestId); assert.equal(reviews.length, 1);
  assert.equal(submissions[1].input.content, originalContent); assert.equal(submissions[1].input.nickname, '<b>星河下载客</b>');
  assert.equal(await evaluate(`document.querySelector('.review-item-heading strong').textContent`), '<b>星河下载客</b>');
  assert.equal(await evaluate(`document.querySelector('.review-item-heading strong b')`), null);
  assert.equal(await evaluate(`document.querySelector('.review-content').textContent`), originalContent.replace('me@example.test', '[EMAIL]'));
  assert.equal(await evaluate(`document.getElementById('review-profile-form').hidden`), false);
  await evaluate(`document.getElementById('review-nickname').value='星河下载客';document.getElementById('review-nickname').dispatchEvent(new Event('input'));document.getElementById('review-profile-form').requestSubmit()`);
  await until(`document.querySelector('.review-item-heading strong').textContent==='星河下载客' && !document.getElementById('review-nickname').readOnly`);
  assert.equal(reviews.length, 1); assert.equal(reviews[0].rating, 5); assert.equal(reviews[0].createdAt, at);
  await evaluate(`document.getElementById('review-profile-form').scrollIntoView({behavior:'instant',block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await capture('web-nickname-settings');
  await showReviews(); await capture('web-reviews');
  for (const width of [900, 375]) {
    win.setSize(width, 960);
    await showReviews();
    assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth + 1`), false, `No page overflow at ${width}px`);
    await capture(`web-reviews-${width}`);
    await evaluate(`document.getElementById('review-profile-form').scrollIntoView({behavior:'instant',block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await capture(`web-nickname-settings-${width}`);
  }
  win.setSize(1280, 960);
  delayProfile = true;
  await evaluate(`document.getElementById('review-nickname').value='旧账号迟到昵称';document.getElementById('review-nickname').dispatchEvent(new Event('input'));document.getElementById('review-profile-form').requestSubmit()`);
  await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(releaseProfile){clearInterval(timer);resolve()}else if(Date.now()-start>8000){clearInterval(timer);reject(new Error('Delayed nickname save did not start'))}},10)});
  await click('browser-account-open');
  delayOrders = true; await click('orders-refresh');
  await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(releaseOrders){clearInterval(timer);resolve()}else if(Date.now()-start>8000){clearInterval(timer);reject(new Error('Delayed order request did not start'))}},10)});
  // Logout must clear already-rendered orders and reject any old pending response.
  await click('account-logout');
  await until(`document.getElementById('account-details').hidden`);
  releaseOrders();
  releaseProfile();
  await until(`document.getElementById('account-notice').textContent==='操作完成。'`);
  await until(`document.getElementById('orders-list').children.length===0`);
  assert.equal(await evaluate(`document.getElementById('review-form').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('review-profile-form').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('review-nickname').value`), '');
  user = 'b';
  await win.loadURL(`${origin}/?desktop=1`);
  await until(`document.querySelectorAll('.review-item').length===6 && !document.getElementById('review-form').hidden && document.getElementById('orders-list').textContent.includes('b-order-0')`);
  assert.equal(await evaluate(`document.getElementById('orders-list').textContent.includes('a-order')`), false);
  assert.equal(await evaluate(`document.getElementById('review-nickname').value`), nicknames.get('b'));
  await evaluate(`import('/desktop-ui.js').then(module=>module.initializeDesktopUI())`);
  await until(`document.body.dataset.desktopReady==='true'`);
  await click('account-tab');
  await until(`document.getElementById('account-tab').getAttribute('aria-current')==='page' && !document.getElementById('desktop-account-page').hidden && document.getElementById('desktop-reviews-page').hidden`);
  await click('account-nickname-settings');
  await until(`document.getElementById('reviews-tab').getAttribute('aria-current')==='page' && document.getElementById('desktop-account-page').hidden && !document.getElementById('desktop-reviews-page').hidden && document.activeElement.id==='review-nickname'`);
  await until(`(()=>{const rect=document.getElementById('review-nickname').getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight})()`);
  assert.equal(await evaluate(`document.getElementById('review-profile-form').hidden`), false, 'Desktop nickname link navigates using the real tab controller and focuses the editable form');
  await showReviews(); await capture('desktop-reviews');
  await assertOnlineMembership();
  await evaluate(`window.fixtureUpdate({configured:true,authenticated:false,verified:false,status:'logged_out',account:null})`);
  assert.equal(await evaluate(`document.getElementById('orders-list').children.length`), 0);
  assert.equal(await evaluate(`document.getElementById('review-form').hidden`), true);
  assert.ok(calls.some(call => call.action === 'google-config'), 'The browser fixture must exercise public Google configuration');
  assert.equal(calls.some(call => call.action === 'order-create'), false, 'The membership flow never sends a new manual payment report');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['public pagination and rating', 'XSS rendered as text', '1000 built-in random nicknames and custom nickname', 'uncertain nickname save retries same requestId', 'nickname change updates existing review without another comment', 'review body preserves phone URL order and whitespace with email masked', 'web account nickname link closes dialog and focuses visible form', 'desktop account nickname link switches real reviews tab and focuses visible form', 'all historical personal order pages', 'online Alipay and WeChat remain available without manual controls or collection QR', 'existing activation code redemption retained', 'uncertain evaluation retries same requestId', 'single evaluation locks composer', '375px and 900px layout', 'late private response and nickname save after logout discarded', 'desktop bridge and account switching', 'private evaluation read failure retains retry'], screenshots: directory }, null, 2));
  await finish(0);
}).catch(error => void finish(1,error));
