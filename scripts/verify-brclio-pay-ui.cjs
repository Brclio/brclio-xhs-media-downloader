// Real Chromium payment UI against isolated in-memory fixtures. No payment,
// email, production account or external browser navigation occurs.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-pay-ui-'));
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
let server, win, finished = false;
const orderId = '12345678-1234-1234-1234-123456789abc';
const errors = [];
const fixture = `
document.body.classList.add('is-desktop');
document.querySelectorAll('.desktop-page, #single-note-panel, #profile-panel').forEach(element=>{element.hidden=true;});
if(document.getElementById('desktop-navigation'))document.getElementById('desktop-navigation').hidden=false;
if(document.getElementById('desktop-account-page'))document.getElementById('desktop-account-page').hidden=false;
window.fixtureCalls=[]; window.fixtureOpened=[]; window.fixtureRefreshes=0;window.fixturePermissionRefreshes=0;window.fixtureClears=0;
window.fixtureMode='quote'; window.fixtureStatus='PENDING'; window.fixtureConfirmed=false;
window.fixtureCatalog={enabled:true,acceptingPayments:!new URL(location.href).searchParams.has('paused'),mode:'live',currency:'CNY',version:'fixture-1',plans:[{id:'monthly',name:'月付',days:30,priceCents:1990,amount:'19.90'}]};
window.fixtureState={configured:true,authenticated:true,verified:true,status:'ready',account:{user:{id:'a',email:'a@example.test',nickname:'测试账号'},membership:{type:'none',active:false},device:{status:'authorized'},features:{'profile-download':{allowed:false},'watermark-free-video':{allowed:false}},serverTime:'2026-10-15T00:00:00Z'}};
window.fixtureListeners=[];
window.fixtureSetState=value=>{window.fixtureState=value;window.fixtureListeners.forEach(fn=>fn(value));};
window.fixtureAccountEvents=[];window.addEventListener('brclio-account-update',event=>window.fixtureAccountEvents.push(structuredClone(event.detail)));
window.fixtureFocusListeners=[];window.fixtureFocus=()=>window.fixtureFocusListeners.forEach(fn=>fn());
window.fixturePersist=(id,userId=window.fixtureState.account.user.id,quote)=>{sessionStorage.setItem('fixture-pending-payment',JSON.stringify({userId,orderId:id}));if(quote)sessionStorage.setItem('fixture-order-quote',JSON.stringify({planId:quote.planId,priceCents:Number(quote.amount.replace('.','')),planName:window.fixtureCatalog.plans.find(plan=>plan.id===quote.planId)?.name||'月付'}));};
window.open=url=>{window.fixtureOpened.push(url);return null;};
window.xhsDesktop={
getAccountState:async()=>window.fixtureState,onAccountUpdate:fn=>{window.fixtureListeners.push(fn);return()=>{};},
onAppFocus:fn=>{window.fixtureFocusListeners.push(fn);return()=>{window.fixtureFocusListeners=window.fixtureFocusListeners.filter(value=>value!==fn);};},
getPendingPayment:async()=>({ok:true,result:JSON.parse(sessionStorage.getItem('fixture-pending-payment')||'null'),state:window.fixtureState}),
clearPendingPayment:async input=>{const saved=JSON.parse(sessionStorage.getItem('fixture-pending-payment')||'null');const cleared=saved?.userId===input.expectedUserId&&saved?.orderId===input.orderId;if(cleared){window.fixtureClears++;sessionStorage.removeItem('fixture-pending-payment');}return {ok:true,result:{cleared},state:window.fixtureState};},
getAccountGoogleConfig:async()=>({ok:true,result:{enabled:false}}),
refreshAccount:async()=>{window.fixtureRefreshes++;if(window.fixtureConfirmed){const next=structuredClone(window.fixtureState);next.account.membership={type:'duration',active:true,startsAt:'2026-10-15T00:00:00Z',expiresAt:'2026-11-14T00:00:00Z'};next.account.features={'profile-download':{allowed:true},'watermark-free-video':{allowed:true}};window.fixtureSetState(next);}return {ok:true,state:window.fixtureState};},
refreshAccountPermissions:async()=>{window.fixturePermissionRefreshes++;const reply=await window.xhsDesktop.refreshAccount();return {...reply,result:{complete:true,permissions:[{feature:'profile-download',authorized:true},{feature:'watermark-free-video',authorized:true}]}};},
commerceRequest:async(action,input={})=>{
window.fixtureCalls.push({action,input:structuredClone(input),at:Date.now()});
if(action==='payment-catalog')return {ok:true,result:{catalog:structuredClone(window.fixtureCatalog)}};
if(action==='payment-create'){
if(window.fixtureMode==='quote'){window.fixtureCatalog.version='fixture-2';window.fixtureCatalog.plans[0].amount='24.90';window.fixtureCatalog.plans[0].priceCents=2490;return {ok:false,error:{code:'QUOTE_CHANGED',message:'报价变化'}};}
if(window.fixtureMode==='network')return {ok:false,error:{code:'PAYMENT_UNAVAILABLE',message:'网络结果未确认，请重试原订单'}};
if(window.fixtureMode==='paused'){window.fixtureCatalog.acceptingPayments=false;return {ok:false,error:{code:'PAYMENT_SERVICE_DISABLED',message:'支付中心尚未启用在线收款，请稍后刷新报价或使用人工扫码。'}};}
if(window.fixtureMode==='confirmed'){window.fixturePersist('${orderId}',input.expectedUserId,input);return {ok:true,result:{order:{id:'${orderId}',status:'confirmed',paymentStatus:'PAID'}}};}
if(window.fixtureMode==='paid'){window.fixturePersist('${orderId}',input.expectedUserId,input);return {ok:true,result:{order:{id:'${orderId}',status:'pending',paymentStatus:'PAID'}}};}
if(window.fixtureMode==='delayed')await new Promise(resolve=>window.fixtureRelease=resolve);
window.fixturePersist('${orderId}',input.expectedUserId,input);
return {ok:true,result:{order:{id:'${orderId}',status:'pending'},checkoutUrl:'https://pay.bornforthis.cn/checkout/fixture#token=fixture-single-order-token'}};
}
if(action==='payment-status')return {ok:true,result:{order:{id:input.orderId,status:window.fixtureConfirmed?'confirmed':'pending',...JSON.parse(sessionStorage.getItem('fixture-order-quote')||'{"planId":"monthly","planName":"月付","priceCents":1990}')},paymentStatus:window.fixtureStatus}};
if(action==='orders-mine')return {ok:true,result:{orders:[],page:1,total:0,totalPages:1}};
if(action==='reviews-public')return {ok:true,result:{reviews:[],page:1,total:0,totalPages:1,summary:{count:0,averageRating:null}}};
if(action==='review-mine')return {ok:true,result:{review:null}};
throw new Error('Unexpected fixture operation');
}};`;
async function finish(code, error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  app.exit(code);
}
const timeout = setTimeout(() => void finish(1, new Error('BRCLIO_PAY_UI_TIMEOUT')), 45_000);
app.whenReady().then(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (url.pathname === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fixture); return; }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.includes('..')) { res.writeHead(404); res.end(); return; }
    try {
      let bytes = fs.readFileSync(path.join(root, name));
      if (name === 'index.html' || name === 'membership.html') {
        let html = bytes.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        html = html.replace('</body>', `<script src="/fixture.js"></script><script type="module" src="/${name === 'index.html' ? 'account-ui.js' : 'membership.js'}"></script></body>`);
        bytes = Buffer.from(html);
      }
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(name)] || 'application/octet-stream' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 960, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith('data:') }));
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(details.message); });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const wait = condition => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(${condition})resolve();else if(Date.now()-start>5000)reject(new Error(${JSON.stringify(`Fixture condition timed out: ${condition}`)}+' '+JSON.stringify({url:location.href,status:document.getElementById('membership-online-status')?.textContent,quote:document.getElementById('membership-online-quote')?.textContent,calls:window.fixtureCalls?.map(item=>item.action)})));else setTimeout(check,10)};check();})`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await win.loadURL(`${origin}/?payment_order=${orderId}&payment_order_id=forged&product_order_id=forged&status=PAID`);
  await wait(`document.getElementById('membership-online-status')?.textContent.includes('尚未完成付款') && document.getElementById('membership-online-quote')?.textContent.includes('19.90')`);
  assert.equal(await evaluate(`new URL(location.href).searchParams.has('payment_order')`), false);
  assert.equal(await evaluate(`new URL(location.href).searchParams.has('payment_order_id')`), false);
  assert.equal(await evaluate('window.fixtureRefreshes'), 0);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate(`document.getElementById('membership-amount').textContent`), '¥19.9');
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true, 'an unresolved returned order cannot create a duplicate purchase');
  await evaluate(`window.fixtureStatus='CLOSED'`); await click('membership-online-check');
  await wait(`document.getElementById('membership-online-status').textContent.includes('已关闭')&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate('window.fixtureRefreshes'), 0, 'closed returned order cannot grant membership');
  await evaluate(`window.fixtureStatus='PENDING'`);
  await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-status').textContent.includes('核对新价格')`);
  assert.match(await evaluate(`document.getElementById('membership-online-quote').textContent`), /24.90/);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);
  await evaluate(`window.fixtureMode='network'`); await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-status').textContent.includes('网络结果未确认')`);
  await evaluate(`window.fixtureMode='paused'`); await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-pay').disabled && document.getElementById('membership-online-status').textContent.includes('尚未启用在线收款')`);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').textContent`), '在线付款暂未开放');
  assert.equal(await evaluate(`document.getElementById('membership-online-refresh').disabled`), false);
  assert.equal(await evaluate(`document.getElementById('membership-online-plan').disabled`), true, 'original request must retain its plan');
  await click('membership-online-refresh');
  await wait(`!document.getElementById('membership-online-refresh').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true, 'refresh cannot bypass payment pause');
  await evaluate(`window.fixtureCatalog.plans=[{id:'daily',name:'临时日付',days:1,priceCents:300,amount:'3.00'}]`);
  await click('membership-online-refresh');
  await wait(`!document.getElementById('membership-online-refresh').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-online-plan').value`), 'daily');
  assert.match(await evaluate(`document.getElementById('membership-online-quote').textContent`), /^月付 · ¥24\.90 · 30 天会员（原订单报价）/,
    'a missing original SKU cannot borrow another SKU name for the retained draft quote');
  await evaluate(`window.fixtureMode='success';window.fixtureCatalog.acceptingPayments=true;window.fixtureCatalog.version='fixture-3';window.fixtureCatalog.plans=[{id:'monthly',name:'更新月付',days:30,priceCents:2990,amount:'29.90'}];`);
  await click('membership-online-refresh');
  await wait(`!document.getElementById('membership-online-pay').disabled && document.getElementById('membership-online-status').textContent.includes('在线付款已恢复')`);
  assert.match(await evaluate(`document.getElementById('membership-online-quote').textContent`), /^更新月付 · ¥24\.90 · 30 天会员（原订单报价）/);
  await click('membership-online-pay');
  await wait('window.fixtureOpened.length===1');
  assert.equal(await evaluate(`new URL(window.fixtureOpened[0]).hash.startsWith('#token=')`), true);
  assert.match(await evaluate(`document.getElementById('membership-online-quote').textContent`), /¥24\.90.*原订单报价/, 'waiting checkout retains its accepted order quote');
  assert.doesNotMatch(await evaluate(`document.getElementById('membership-online-quote').textContent`), /¥29\.90/, 'current catalog cannot replace a pending order price');
  const requests = await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').map(item=>item.input)`);
  assert.equal(requests.length, 4); assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests[1], requests[2]); assert.deepEqual(requests[1], requests[3]); assert.equal(requests[1].amount, '24.90');
  await evaluate(`document.getElementById('membership-online-payment').scrollIntoView({block:'start'})`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.join(directory, 'online-desktop.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(375, 812);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`(()=>{const d=document.getElementById('membership-dialog');return d.scrollWidth>d.clientWidth+1})()`), false, 'online checkout controls fit a 375px viewport');
  fs.writeFileSync(path.join(directory, 'online-mobile.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1280, 960);
  await evaluate(`window.fixtureBeforeCacheReturn=window.fixtureCalls.filter(item=>item.action==='payment-status').length;window.fixtureCreatesBeforeCacheReturn=window.fixtureCalls.filter(item=>item.action==='payment-create').length;window.fixtureCacheReturnAt=Date.now();window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));`);
  await wait(`window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureBeforeCacheReturn`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status')[window.fixtureBeforeCacheReturn].at-window.fixtureCacheReturnAt<1000`), true, 'return from back-forward cache immediately checks the retained order');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length===window.fixtureCreatesBeforeCacheReturn`), true, 'back-forward cache return cannot create another order');
  assert.equal(await evaluate('window.fixtureRefreshes'), 0, 'back-forward cache return cannot grant unconfirmed rights');
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate(`Boolean(sessionStorage.getItem('fixture-pending-payment'))`), true);
  await evaluate(`window.fixtureStatus='PAID';window.fixtureBeforeAutomaticCheck=window.fixtureCalls.filter(item=>item.action==='payment-status').length`);
  await wait(`window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureBeforeAutomaticCheck`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益确认中')`);
  assert.equal(await evaluate('window.fixtureRefreshes'), 0);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate(`window.fixtureState.account.features['profile-download'].allowed`), false);
  assert.equal(await evaluate(`Boolean(sessionStorage.getItem('fixture-pending-payment'))`), true);
  await evaluate(`window.fixtureConfirmed=true;window.fixtureBeforeFocus=window.fixtureCalls.filter(item=>item.action==='payment-status').length;window.fixtureFocusAt=Date.now();window.fixtureFocus()`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益已由服务端确认')`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status')[window.fixtureBeforeFocus].at-window.fixtureFocusAt<1000`), true, 'native app focus immediately checks the saved order');
  assert.equal(await evaluate('window.fixtureRefreshes'), 1);
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 1);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), true);
  assert.equal(await evaluate(`window.fixtureState.account.features['profile-download'].allowed`), true);
  assert.equal(await evaluate(`window.fixtureState.account.features['watermark-free-video'].allowed`), true);
  assert.equal(await evaluate(`window.fixtureAccountEvents.some(value=>value.account?.membership?.active&&value.account?.features?.['profile-download']?.allowed)`), true, 'fresh account and feature rights reach app listeners');
  assert.equal(await evaluate(`document.getElementById('account-badge').classList.contains('is-member')`), true);
  assert.equal(await evaluate('window.fixtureClears'), 1);
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-pending-payment')`), null);
  await evaluate(`window.fixtureMode='confirmed'`); await click('membership-online-pay');
  await wait('window.fixtureRefreshes===2');
  assert.equal(await evaluate('window.fixtureOpened.length'), 1, 'confirmed retry without URL goes to status query');
  await evaluate(`window.fixtureMode='paid';window.fixtureConfirmed=false`); await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益确认中')`);
  assert.equal(await evaluate('window.fixtureRefreshes'), 2);
  assert.equal(await evaluate('window.fixtureOpened.length'), 1, 'paid retry without URL does not open a stale checkout');
  await win.loadURL(`${origin}/?restored=1`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-status')`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'renderer restart resumes the saved order without creating another purchase');
  assert.equal(await evaluate('window.fixtureOpened.length'), 0, 'recovery never reopens checkout or needs a payment webpage return');
  assert.equal(await evaluate('window.fixtureRefreshes'), 0, 'pending recovery cannot grant membership');
  assert.equal(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-status').input.orderId`), orderId);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true, 'restored pending order prevents duplicate checkout');
  await click('account-open-membership');
  await evaluate(`window.fixtureStatus='CLOSED';window.fixtureFocus()`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('已关闭')`);
  await wait(`!document.getElementById('membership-online-pay').disabled`);
  await evaluate(`window.fixtureMode='delayed'`); await click('membership-online-pay');
  await wait('Boolean(window.fixtureRelease)');
  await evaluate(`const next=structuredClone(window.fixtureState);next.account.user={id:'b',email:'b@example.test'};window.fixtureSetState(next);window.fixtureRelease();`);
  await wait(`document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0, 'late response cannot open a checkout after account changes');
  await evaluate(`sessionStorage.removeItem('fixture-pending-payment')`);
  await win.loadURL(`${origin}/?paused=1`);
  await wait(`Boolean(document.getElementById('account-open-membership'))`);
  await click('account-open-membership');
  await wait(`document.getElementById('membership-online-quote')?.textContent.includes('尚未启用在线收款')`);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'known disabled catalog never attempts an order');
  await evaluate(`document.getElementById('membership-online-payment').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.join(directory, 'online-paused.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate(`window.fixtureCatalog.acceptingPayments=true`); await click('membership-online-refresh');
  await wait(`!document.getElementById('membership-online-pay').disabled`);
  await win.loadURL(`${origin}/membership.html`);
  await wait(`document.querySelector('[data-plan="monthly"] [data-plan-price]').textContent==='19.90'`);
  assert.equal(await evaluate(`document.querySelector('[data-plan="daily"] [data-plan-price]').textContent`), '停售');
  assert.equal(await evaluate(`document.querySelector('[data-starting-price]').textContent`), '¥19.90');
  await win.loadURL(`${origin}/membership.html?paused=1`);
  await wait(`document.getElementById('membership-catalog-status').textContent.includes('尚未启用在线收款')`);
  assert.equal(await evaluate(`document.querySelector('[data-plan="monthly"] [data-plan-price]').textContent`), '19.90', 'payment pause does not erase current pricing');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['current online quote with manual QR preserved', 'quote change requires second click', 'PAYMENT_UNAVAILABLE create reuses request ID', 'payment pause blocks checkout and allows readiness refresh', 'removed draft SKU keeps its original plan name', 'recovery preserves original request and quoted amount', 'disabled catalog never creates an order', 'single-order checkout fragment preserved', 'return parameters never grant rights', 'back-forward cache return immediately checks and preserves automatic recovery without duplicate create or grant', 'paid without committed webhook stays pending and automatically polls', 'native app focus immediately checks pending order', 'confirmed order refreshes account and feature rights before clearing recovery', 'fresh account rights reach app listeners and member badge', 'renderer restart restores saved pending order without another create or checkout', 'confirmed or paid retry without checkout URL queries status', 'late checkout discarded on account switch', 'marketing page uses enabled live catalog and shows payment pause', '375px online layout'], screenshots: directory }));
  await finish(0);
}).catch(error => void finish(1, error));
