// Real Chromium payment UI against isolated in-memory fixtures. No payment,
// email, production account or external browser navigation occurs.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const jsQR = require('jsqr');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-pay-ui-'));
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
let server, win, finished = false;
const orderId = '12345678-1234-1234-1234-123456789abc';
const replacementOrderId = '12345678-1234-1234-1234-123456789abd';
const errors = [];
const fixture = `
window.fixtureBrowser=new URL(location.href).searchParams.has('browser-offline')||new URL(location.href).searchParams.has('browser-qr');
if(!window.fixtureBrowser){
document.body.classList.add('is-desktop');
document.querySelectorAll('.desktop-page, #single-note-panel, #profile-panel').forEach(element=>{element.hidden=true;});
if(document.getElementById('desktop-navigation'))document.getElementById('desktop-navigation').hidden=false;
if(document.getElementById('desktop-account-page'))document.getElementById('desktop-account-page').hidden=false;
}
window.fixtureCalls=[]; window.fixtureOpened=[];window.fixtureOpenCalls=[];window.fixtureCopied=[];window.fixtureOpenFails=false; window.fixtureRefreshes=0;window.fixturePermissionRefreshes=0;window.fixtureClears=0;
window.fixtureMode='quote'; window.fixtureConfirmed=new URL(location.href).searchParams.has('cold-handoff');window.fixtureStatus=window.fixtureConfirmed?'PAID':'PENDING';
window.fixtureOrderId='${orderId}';window.fixtureResumeMode='success';window.fixtureStatusFailure=false;
window.fixturePendingDelay=new URL(location.href).searchParams.has('delayed-restore');window.fixturePendingFailure=false;
window.fixtureQrEnabled=new URL(location.href).searchParams.has('native-qr');
window.fixtureQrCode='weixin://wxpay/bizpayurl?pr=fixture_native_current_order';window.fixtureQrExpiresAt=new Date(Date.now()+60000).toISOString();
window.fixtureQrFields=(order,paymentStatus=window.fixtureStatus)=>window.fixtureQrEnabled&&order.provider==='wechat'?{
  qrCodeUrl:order.status==='pending'&&paymentStatus==='PENDING'&&Date.parse(window.fixtureQrExpiresAt)>Date.now()?window.fixtureQrCode:null,
  qrCodeExpiresAt:order.status==='pending'&&paymentStatus==='PENDING'&&Date.parse(window.fixtureQrExpiresAt)>Date.now()?window.fixtureQrExpiresAt:null}:{};
window.fixtureCatalog={enabled:true,acceptingPayments:!new URL(location.href).searchParams.has('paused'),mode:'live',currency:'CNY',version:'fixture-1',plans:[{id:'monthly',name:'月付',days:30,priceCents:1990,amount:'19.90'}]};
window.fixtureWechatCatalog={enabled:true,mode:'live',currency:'CNY',provider:'wechat',channels:['native'],version:'wechat-fixture-1',plans:[{id:'daily',name:'日付',days:1,priceCents:300,amount:'3.00'},{id:'monthly',name:'月付',days:30,priceCents:1990,amount:'19.90'},{id:'yearly',name:'年付',days:365,priceCents:6990,amount:'69.90'}]};
window.fixtureState={configured:true,authenticated:true,verified:true,status:'ready',account:{user:{id:'a',email:'a@example.test',nickname:'测试账号'},membership:{type:'none',active:false},device:{status:'authorized'},features:{'profile-download':{allowed:false},'watermark-free-video':{allowed:false}},serverTime:'2026-10-15T00:00:00Z'}};
window.fixtureListeners=[];
window.fixtureSetState=value=>{window.fixtureState=value;window.fixtureListeners.forEach(fn=>fn(value));};
window.fixtureAccountEvents=[];window.addEventListener('brclio-account-update',event=>window.fixtureAccountEvents.push(structuredClone(event.detail)));
window.fixtureFocusListeners=[];window.fixtureFocus=()=>window.fixtureFocusListeners.forEach(fn=>fn());
window.fixtureReturnListeners=[];window.fixtureReturn=hint=>Promise.all(window.fixtureReturnListeners.map(fn=>fn(hint)));
window.fixturePersist=(id,userId=window.fixtureState.account.user.id,quote)=>{sessionStorage.setItem('fixture-pending-payment',JSON.stringify({userId,orderId:id}));if(quote)sessionStorage.setItem('fixture-order-quote',JSON.stringify({planId:quote.planId,priceCents:Number(quote.amount.replace('.','')),planName:(quote.provider==='wechat'?window.fixtureWechatCatalog:window.fixtureCatalog).plans.find(plan=>plan.id===quote.planId)?.name||'月付',...(quote.provider==='wechat'?{source:'brclio_wechat',paymentMethod:'brclio_wechat',provider:'wechat'}:{})}));};
window.open=url=>{window.fixtureOpened.push(url);return null;};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.fixtureCopied.push(value);}}});
window.xhsDesktop={
getAccountState:async()=>{if(new URL(location.href).searchParams.has('cold-handoff'))await new Promise(resolve=>window.fixtureReleaseState=resolve);return window.fixtureState;},onAccountUpdate:fn=>{window.fixtureListeners.push(fn);return()=>{};},
onAppFocus:fn=>{window.fixtureFocusListeners.push(fn);return()=>{window.fixtureFocusListeners=window.fixtureFocusListeners.filter(value=>value!==fn);};},
onPaymentReturn:fn=>{window.fixtureReturnListeners.push(fn);if(new URL(location.href).searchParams.has('cold-handoff'))queueMicrotask(()=>{void fn({orderId:'${orderId}'});});return()=>{window.fixtureReturnListeners=window.fixtureReturnListeners.filter(value=>value!==fn);};},
openPaymentCheckout:async input=>{window.fixtureOpenCalls.push(structuredClone(input));if(window.fixtureOpenHoldOnce){window.fixtureOpenHoldOnce=false;await new Promise(resolve=>window.fixtureReleaseOpen=resolve);}if(window.fixtureOpenFails)return {ok:false,error:{code:'OPEN_FAILED',message:'系统默认浏览器尚未打开，请重试原订单或复制付款链接。'}};window.fixtureOpened.push(input.checkoutUrl);return {ok:true};},
getPendingPayment:async()=>{const reply={ok:true,result:JSON.parse(sessionStorage.getItem('fixture-pending-payment')||'null'),state:structuredClone(window.fixtureState)};if(window.fixturePendingDelay)await new Promise(resolve=>window.fixtureReleasePending=resolve);return window.fixturePendingFailure?{ok:false,error:{code:'SERVICE_UNAVAILABLE',message:'fixture pending record unavailable'}}:reply;},
clearPendingPayment:async input=>{const saved=JSON.parse(sessionStorage.getItem('fixture-pending-payment')||'null');const cleared=saved?.userId===input.expectedUserId&&saved?.orderId===input.orderId;if(cleared){window.fixtureClears++;sessionStorage.removeItem('fixture-pending-payment');}return {ok:true,result:{cleared},state:window.fixtureState};},
getAccountGoogleConfig:async()=>({ok:true,result:{enabled:false}}),
refreshAccount:async()=>{window.fixtureRefreshes++;if(window.fixtureConfirmed){const next=structuredClone(window.fixtureState);next.account.membership={type:'duration',active:true,startsAt:'2026-10-15T00:00:00Z',expiresAt:'2026-11-14T00:00:00Z'};next.account.features={'profile-download':{allowed:true},'watermark-free-video':{allowed:true}};window.fixtureSetState(next);}return {ok:true,state:window.fixtureState};},
refreshAccountPermissions:async()=>{window.fixturePermissionRefreshes++;if(window.fixturePermissionHold)await new Promise(resolve=>window.fixtureReleasePermissions=resolve);if(window.fixturePermissionFailure)return {ok:false,state:window.fixtureState,error:{code:'PERMISSION_UNAVAILABLE',message:'fixture permissions unavailable'}};const reply=await window.xhsDesktop.refreshAccount();return {...reply,result:{complete:true,permissions:[{feature:'profile-download',authorized:true},{feature:'watermark-free-video',authorized:true}]}};},
commerceRequest:async(action,input={})=>{
window.fixtureCalls.push({action,input:structuredClone(input),at:Date.now()});
if(action==='payment-catalog')return {ok:true,result:{catalog:structuredClone(input.provider==='wechat'?window.fixtureWechatCatalog:window.fixtureCatalog)}};
if(action==='payment-create'){
if(window.fixtureMode==='quote'){window.fixtureCatalog.version='fixture-2';window.fixtureCatalog.plans[0].amount='24.90';window.fixtureCatalog.plans[0].priceCents=2490;return {ok:false,error:{code:'QUOTE_CHANGED',message:'报价变化'}};}
if(window.fixtureMode==='network')return {ok:false,error:{code:'PAYMENT_UNAVAILABLE',message:'网络结果未确认，请重试原订单'}};
if(window.fixtureMode==='paused'){window.fixtureCatalog.acceptingPayments=false;return {ok:false,error:{code:'PAYMENT_SERVICE_DISABLED',message:'支付中心尚未启用在线收款，请稍后刷新报价。'}};}
if(window.fixtureMode==='confirmed'){window.fixturePersist(window.fixtureOrderId,input.expectedUserId,input);return {ok:true,result:{order:{id:window.fixtureOrderId,status:'confirmed',paymentStatus:'PAID'}}};}
if(window.fixtureMode==='paid'){window.fixturePersist(window.fixtureOrderId,input.expectedUserId,input);return {ok:true,result:{order:{id:window.fixtureOrderId,status:'pending',paymentStatus:'PAID'}}};}
if(window.fixtureMode==='delayed')await new Promise(resolve=>window.fixtureRelease=resolve);
window.fixturePersist(window.fixtureOrderId,input.expectedUserId,input);
const order={id:window.fixtureOrderId,userId:input.expectedUserId,status:'pending',...JSON.parse(sessionStorage.getItem('fixture-order-quote')||'{}')};
window.fixtureCreateCompletions=(window.fixtureCreateCompletions||0)+1;
return {ok:true,result:{order,paymentStatus:'PENDING',...window.fixtureQrFields(order,'PENDING'),checkoutUrl:(input.provider==='wechat'?'https://paywc.bornforthis.cn':'https://pay.bornforthis.cn')+'/checkout/fixture#token=fixture-single-order-token'}};
}
if(action==='payment-resume'){
if(window.fixtureResumeMode==='delayed')await new Promise(resolve=>window.fixtureReleaseResume=resolve);
if(window.fixtureResumeMode==='network')return {ok:false,error:{code:'PAYMENT_UNAVAILABLE',message:'原订单支付页暂时无法获取，请稍后重试。'}};
if(['paid','paid-unavailable'].includes(window.fixtureResumeMode))window.fixtureStatus='PAID';
if(window.fixtureResumeMode==='paid-unavailable')window.fixtureStatusFailure=true;
if(window.fixtureResumeMode==='confirmed'){window.fixtureStatus='PAID';window.fixtureConfirmed=true;}
const quote=JSON.parse(sessionStorage.getItem('fixture-order-quote')||'{}');
const order={id:input.orderId,userId:input.expectedUserId,status:window.fixtureConfirmed?'confirmed':'pending',...quote};
return {ok:true,result:{order,paymentStatus:window.fixtureStatus,...window.fixtureQrFields(order),checkoutUrl:(quote.provider==='wechat'?'https://paywc.bornforthis.cn':'https://pay.bornforthis.cn')+'/checkout/fixture-resumed#token=fixture-fresh-single-order-token'}};
}
if(action==='payment-status'){
if(window.fixtureStatusFailure)return {ok:false,error:{code:'PAYMENT_UNAVAILABLE',message:'暂时无法核实订单，原订单已保留。'}};
const order={id:input.orderId,userId:'a',status:window.fixtureConfirmed?'confirmed':'pending',...JSON.parse(sessionStorage.getItem('fixture-order-quote')||'{"planId":"monthly","planName":"月付","priceCents":1990}')};
const result={ok:true,result:{order,paymentStatus:window.fixtureStatus,...window.fixtureQrFields(order)}};
if(window.fixtureStatusHoldOnce){window.fixtureStatusHoldOnce=false;await new Promise(resolve=>window.fixtureReleaseStatus=resolve);}
return result;
}
if(action==='orders-mine')return {ok:true,result:{orders:[],page:1,total:0,totalPages:1}};
if(action==='reviews-public')return {ok:true,result:{reviews:[],page:1,total:0,totalPages:1,summary:{count:0,averageRating:null}}};
if(action==='review-mine')return {ok:true,result:{review:null}};
throw new Error('Unexpected fixture operation');
}};
if(window.fixtureBrowser){
const transport=window.xhsDesktop;delete window.xhsDesktop;
window.fixtureOffline=new URL(location.href).searchParams.has('browser-offline');
window.fixturePendingKey='xhs.pending-payment.v1:'+encodeURIComponent(location.origin+'/api/account')+':a';
if(window.fixtureOffline)localStorage.setItem(window.fixturePendingKey,JSON.stringify({userId:'a',orderId:'${orderId}'}));
window.fetch=async(_url,init)=>{
const {action,input={}}=JSON.parse(init.body);
if(['me','logout','google-config'].includes(action)){
window.fixtureCalls.push({action,input:structuredClone(input),at:Date.now()});
if(action==='me'){window.fixtureRefreshes++;if(window.fixtureOffline)throw new Error('fixture identity offline');return Response.json({ok:true,account:structuredClone(window.fixtureState.account)});}
if(action==='logout')return Response.json({ok:true,revoked:true});
return Response.json({ok:true,enabled:false});
}
const reply=await transport.commerceRequest(action,input);
return Response.json(reply.ok?{ok:true,...reply.result}:{ok:false,error:reply.error},{status:reply.ok?200:503});
};
}`;
async function finish(code, error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  app.exit(code);
}
const timeout = setTimeout(() => void finish(1, new Error('BRCLIO_PAY_UI_TIMEOUT')), 120_000);
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
  win = new BrowserWindow({ show: true, width: 1280, height: 960, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: true } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith('data:') }));
  win.webContents.on('console-message', (event, details = event) => { if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(details.message); });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const wait = (condition, timeoutMs = 5000) => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(${condition})resolve();else if(Date.now()-start>${timeoutMs})reject(new Error(${JSON.stringify(`Fixture condition timed out (${timeoutMs}ms): ${condition}`)}+' '+JSON.stringify({url:location.href,hidden:document.hidden,visibilityState:document.visibilityState,qrHidden:document.getElementById('membership-wechat-qr')?.hidden,qrSvgCount:document.querySelectorAll('#membership-qr-image svg').length,status:document.getElementById('membership-online-status')?.textContent,quote:document.getElementById('membership-online-quote')?.textContent,calls:window.fixtureCalls?.map(item=>item.action)})));else setTimeout(check,10)};check();})`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const screenshotStates = [], visibilityEvidence = [];
  const captureState = async (name, width) => {
    win.setContentSize(width, width === 375 ? 812 : 960);
    if (name.startsWith('payment-selection-')) {
      await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='selection'&&!document.getElementById('membership-online-pay').disabled&&!document.getElementById('membership-online-method').disabled&&!document.getElementById('membership-online-refresh').disabled&&document.getElementById('membership-online-status').textContent===''&&Number(getComputedStyle(document.getElementById('membership-online-pay')).opacity)>=0.999`);
    }
    await evaluate(`document.getElementById('membership-dialog').scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`(()=>{const d=document.getElementById('membership-dialog');return d.scrollWidth>d.clientWidth+1})()`), false, `${name} has no horizontal overflow`);
    screenshotStates.push({ name, width, ...await evaluate(`({phase:document.getElementById('membership-dialog').dataset.paymentPhase,payDisabled:document.getElementById('membership-online-pay').disabled,payActuallyDisabled:document.getElementById('membership-online-pay').matches(':disabled'),payBackground:getComputedStyle(document.getElementById('membership-online-pay')).backgroundColor,methodDisabled:document.getElementById('membership-online-method').disabled,refreshDisabled:document.getElementById('membership-online-refresh').disabled,payOpacity:getComputedStyle(document.getElementById('membership-online-pay')).opacity,amount:document.getElementById('membership-summary-amount').textContent,quote:document.getElementById('membership-online-quote').textContent})`) });
    fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const qrVisible = `!document.getElementById('membership-wechat-qr').hidden&&Boolean(document.querySelector('#membership-qr-image svg'))`;
  const qrEmpty = `document.getElementById('membership-wechat-qr').hidden&&document.getElementById('membership-qr-image').childElementCount===0`;
  const assertDecodableQr = async () => {
    const pixels = await evaluate(`(async()=>{
      const svg=document.querySelector('#membership-qr-image svg');if(!svg)throw new Error('Missing Native payment SVG');
      const width=svg.viewBox.baseVal.width,scale=Math.max(4,Math.ceil(320/width));
      const canvas=document.createElement('canvas');canvas.width=canvas.height=width*scale;
      const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg));
      await image.decode();const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      return {width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};
    })()`);
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
    assert.ok(decoded, 'The displayed SVG must decode from actual canvas pixels using independent jsQR');
    assert.equal(decoded.data, await evaluate('window.fixtureQrCode'), 'The scanned value is exactly the current server-provided code');
    assert.equal(await evaluate(`document.querySelectorAll('#membership-qr-image img, #membership-qr-image iframe, #membership-qr-image a').length`), 0, 'QR rendering does not load a remote image or navigate to a code URL');
  };
  const prepareNativeQr = async (extra = '') => {
    await evaluate(`sessionStorage.removeItem('fixture-pending-payment');sessionStorage.removeItem('fixture-order-quote')`);
    await win.loadURL(`${origin}/?native-qr=1${extra}`);
    win.setContentSize(1280, 960); win.showInactive();
    await wait(`document.getElementById('account-badge')?.textContent.includes('普通用户')`);
    await click('account-open-membership');
    await wait(`!document.getElementById('membership-online-method').disabled`);
    await evaluate(`document.querySelector('input[name="membership-online-method"][value="wechat"]').click()`);
    await wait(`window.fixtureCalls.some(item=>item.action==='payment-catalog'&&item.input.provider==='wechat')&&!document.getElementById('membership-online-pay').disabled`);
  };
  const startNativeQr = async (extra = '') => {
    await prepareNativeQr(extra);
    await evaluate(`window.fixtureMode='success'`); await click('membership-online-pay');
    await wait(`${qrVisible}&&!document.getElementById('membership-online-check').disabled`);
    assert.equal(await evaluate('window.fixtureOpened.length'), 0, 'An available Native code must stay in the client instead of opening a browser');
    assert.equal(await evaluate('window.fixtureOpenCalls.length'), 0, 'No native external-browser IPC runs while presenting the code');
    assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1);
    assert.deepEqual(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment'))`), { userId: 'a', orderId });
  };
  const openWechatFallback = async () => {
    await wait(`!document.getElementById('membership-open-checkout').hidden&&!document.getElementById('membership-open-checkout').disabled`);
    await click('membership-open-checkout');
  };
  const acknowledgeAndReopen = async () => {
    await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='confirmed'&&!document.getElementById('membership-online-check').disabled`);
    await click('membership-success-done'); await click('account-open-membership');
    await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='selection'&&!document.getElementById('membership-online-pay').disabled`);
  };
  await win.loadURL(`${origin}/?payment_order=${orderId}&payment_order_id=forged&product_order_id=forged&status=PAID`);
  await wait(`document.getElementById('membership-online-status')?.textContent.includes('尚未完成付款') && document.getElementById('membership-online-quote')?.textContent.includes('19.90') && !document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate(`new URL(location.href).searchParams.has('payment_order')`), false);
  assert.equal(await evaluate(`new URL(location.href).searchParams.has('payment_order_id')`), false);
  assert.equal(await evaluate('window.fixtureRefreshes'), 0);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate(`Boolean(document.querySelector('#membership-dialog #membership-payment, #membership-dialog #membership-copy-email, #membership-dialog #membership-report-paid, #membership-dialog input[name="membership-plan"], #membership-dialog input[name="membership-method"], #membership-dialog img'))`), false, 'the purchase dialog exposes only online payment, with no original manual QR, plans, email copy or report entry');
  assert.doesNotMatch(await evaluate(`document.getElementById('membership-dialog').textContent`), /人工扫码|付款备注|24 小时|邮件发码/);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').textContent`), '继续支付原订单', 'an unpaid returned order offers its original checkout');
  assert.equal(await evaluate(`document.getElementById('membership-online-restart').disabled`), false, 'verified unpaid orders allow the user to return to plan selection');
  assert.equal(await evaluate(`document.getElementById('membership-online-plan').disabled`), true, 'an unpaid order keeps its accepted plan until restart');
  await evaluate(`window.fixtureStatus='CLOSED'`); await click('membership-online-check');
  await wait(`document.getElementById('membership-online-status').textContent.includes('已关闭')&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate('window.fixtureRefreshes'), 0, 'closed returned order cannot grant membership');
  await click('membership-close'); await click('account-open-membership');
  await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='selection'&&!document.getElementById('membership-online-pay').disabled`);
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
  assert.equal(await evaluate(`window.fixtureOpenCalls.length`), 1, 'desktop checkout uses the verified native shell adapter');
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
  assert.equal(await evaluate(`document.getElementById('membership-online-restart').hidden`), false, 'mobile layout includes the unpaid-order restart control');
  fs.writeFileSync(path.join(directory, 'online-mobile.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1280, 960);
  await evaluate(`window.fixtureBeforeCacheReturn=window.fixtureCalls.filter(item=>item.action==='payment-status').length;window.fixtureCacheStatusInFlight=document.getElementById('membership-online-check').disabled;window.fixtureCreatesBeforeCacheReturn=window.fixtureCalls.filter(item=>item.action==='payment-create').length;window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));window.fixtureImmediateCacheCheck=window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureBeforeCacheReturn||window.fixtureCacheStatusInFlight;`);
  assert.equal(await evaluate('window.fixtureImmediateCacheCheck'), true, 'return from back-forward cache immediately starts a check or joins the in-flight check');
  await wait(`!document.getElementById('membership-online-check').disabled&&document.getElementById('membership-online-status').textContent.includes('尚未完成付款')`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length===window.fixtureCreatesBeforeCacheReturn`), true, 'back-forward cache return cannot create another order');
  assert.equal(await evaluate('window.fixtureRefreshes'), 0, 'back-forward cache return cannot grant unconfirmed rights');
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate(`Boolean(sessionStorage.getItem('fixture-pending-payment'))`), true);
  await evaluate(`window.fixtureStatus='PAID';window.fixtureBeforeAutomaticCheck=window.fixtureCalls.filter(item=>item.action==='payment-status').length`);
  await wait(`window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureBeforeAutomaticCheck`, 15_000);
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益确认中')`);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true, 'paid orders cannot reopen checkout while membership is being committed');
  assert.equal(await evaluate(`document.getElementById('membership-online-restart').disabled`), true, 'paid orders cannot release recovery to create another purchase');
  assert.equal(await evaluate('window.fixtureRefreshes'), 0);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate(`window.fixtureState.account.features['profile-download'].allowed`), false);
  assert.equal(await evaluate(`Boolean(sessionStorage.getItem('fixture-pending-payment'))`), true);
  await evaluate(`window.fixtureConfirmed=true;window.fixtureBeforeFocus=window.fixtureCalls.filter(item=>item.action==='payment-status').length;window.fixtureFocusStatusInFlight=document.getElementById('membership-online-check').disabled;window.fixtureFocus();window.fixtureImmediateFocusCheck=window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureBeforeFocus||window.fixtureFocusStatusInFlight;`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益已由服务端确认')`);
  assert.equal(await evaluate('window.fixtureImmediateFocusCheck'), true, 'native app focus immediately starts a check or joins the in-flight check');
  assert.equal(await evaluate('window.fixtureRefreshes'), 1);
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 1);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), true);
  assert.equal(await evaluate(`window.fixtureState.account.features['profile-download'].allowed`), true);
  assert.equal(await evaluate(`window.fixtureState.account.features['watermark-free-video'].allowed`), true);
  assert.equal(await evaluate(`window.fixtureAccountEvents.some(value=>value.account?.membership?.active&&value.account?.features?.['profile-download']?.allowed)`), true, 'fresh account and feature rights reach app listeners');
  assert.equal(await evaluate(`document.getElementById('account-badge').classList.contains('is-member')`), true);
  assert.equal(await evaluate('window.fixtureClears'), 1);
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-pending-payment')`), null);
  assert.equal(await evaluate(`document.getElementById('membership-dialog').open`), true, 'success appears in the existing open payment dialog');
  assert.equal(await evaluate(`document.getElementById('membership-dialog').dataset.paymentPhase`), 'confirmed');
  assert.equal(await evaluate(`document.getElementById('membership-progress-title').textContent`), '会员已开通');
  assert.equal(await evaluate(`document.getElementById('membership-completed-expiry').hidden`), false);
  assert.match(await evaluate(`document.getElementById('membership-completed-expiry').textContent`), /2026/);
  assert.equal(await evaluate(`document.getElementById('membership-choices').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('membership-summary-amount').textContent`), '24.90', 'the successful receipt shows its accepted order amount');
  assert.match(await evaluate(`document.getElementById('membership-online-quote').textContent`), /¥24\.90.*原订单报价/, 'the successful detail keeps the accepted order quote');
  assert.doesNotMatch(await evaluate(`document.getElementById('membership-online-quote').textContent`), /¥29\.90/, 'a newer catalog cannot replace the successful order amount');
  await captureState('payment-success-desktop', 1280); await captureState('payment-success-mobile', 375); win.setContentSize(1280,960);
  await acknowledgeAndReopen();
  await evaluate(`window.fixtureMode='confirmed'`); await click('membership-online-pay');
  await wait('window.fixtureRefreshes===2');
  assert.equal(await evaluate('window.fixtureOpened.length'), 1, 'confirmed retry without URL goes to status query');
  await acknowledgeAndReopen();
  await evaluate(`window.fixtureMode='paid';window.fixtureConfirmed=false`); await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益确认中')`);
  assert.equal(await evaluate('window.fixtureRefreshes'), 2);
  assert.equal(await evaluate('window.fixtureOpened.length'), 1, 'paid retry without URL does not open a stale checkout');
  await win.loadURL(`${origin}/?restored=1`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-status')&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'renderer restart resumes the saved order without creating another purchase');
  assert.equal(await evaluate('window.fixtureOpened.length'), 0, 'recovery never reopens checkout or needs a payment webpage return');
  assert.equal(await evaluate('window.fixtureRefreshes'), 0, 'pending recovery cannot grant membership');
  assert.equal(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-status').input.orderId`), orderId);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').textContent`), '继续支付原订单', 'restored unpaid orders can reopen their original checkout');
  await click('account-open-membership');
  await wait(`!document.getElementById('membership-online-pay').disabled`);
  await click('membership-online-pay');
  await wait('window.fixtureOpened.length===1&&!document.getElementById("membership-online-pay").disabled');
  assert.deepEqual(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-resume').input`), { orderId, expectedUserId: 'a' });
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'continuing after renderer restart reuses the existing order');
  assert.equal(await evaluate(`new URL(window.fixtureOpened[0]).hash`), '#token=fixture-fresh-single-order-token', 'continuing fetches a fresh checkout token');
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId);

  await evaluate(`window.fixtureStatusFailure=true;window.fixtureChecksBeforeRestart=window.fixtureCalls.filter(item=>item.action==='payment-status').length;`);
  await click('membership-online-restart');
  await wait(`document.getElementById('membership-online-status').textContent.includes('原订单已保留')&&!document.getElementById('membership-online-restart').disabled`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureChecksBeforeRestart`), true, 'restart verifies status again before releasing the existing order');
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId, 'failed restart verification preserves saved recovery');
  assert.equal(await evaluate('window.fixtureClears'), 0, 'network failures cannot clear an unpaid order');
  assert.equal(await evaluate(`document.getElementById('membership-online-plan').disabled`), true);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);

  await evaluate(`window.fixtureStatusFailure=false;window.fixtureResumeMode='network'`); await click('membership-online-check');
  await wait(`!document.getElementById('membership-online-pay').disabled`);
  await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-status').textContent.includes('原订单支付页暂时无法获取')&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate('window.fixtureOpened.length'), 1, 'failed checkout resume cannot open an old URL');
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId, 'checkout resume failures preserve the original order');
  await evaluate(`window.fixtureResumeMode='success'`); await click('membership-online-check');
  await wait(`!document.getElementById('membership-online-restart').disabled`);
  await evaluate(`window.fixtureChecksBeforeRestart=window.fixtureCalls.filter(item=>item.action==='payment-status').length`);
  await click('membership-online-restart');
  await wait(`document.getElementById('membership-online-status').textContent.includes('旧订单未关闭')&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureChecksBeforeRestart`), true);
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-pending-payment')`), null);
  assert.equal(await evaluate('window.fixtureClears'), 1);
  assert.equal(await evaluate(`document.getElementById('membership-online-plan').disabled`), false, 'restart returns to current plan selection');
  assert.equal(await evaluate(`document.getElementById('membership-online-restart').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').textContent`), '前往 Brclio Pay 付款');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'restart itself never creates a replacement purchase');
  assert.match(await evaluate(`document.getElementById('membership-online-status').textContent`), /请勿.*重复付款/);
  await evaluate(`window.fixtureMode='success';window.fixtureOrderId='${replacementOrderId}'`); await click('membership-online-pay');
  await wait('window.fixtureOpened.length===2&&!document.getElementById("membership-online-pay").disabled');
  const replacementRequest = await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-create').input`);
  assert.notEqual(replacementRequest.requestId, requests[1].requestId, 'a new purchase after restart has a fresh request ID');
  assert.equal(replacementRequest.amount, '19.90', 'replacement purchase uses the current catalog quote');
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), replacementOrderId);

  await evaluate(`window.fixtureResumeMode='delayed'`); await click('membership-online-pay');
  await wait('Boolean(window.fixtureReleaseResume)');
  await evaluate(`const next=structuredClone(window.fixtureState);next.account.user={id:'b',email:'b@example.test'};window.fixtureSetState(next);window.fixtureReleaseResume();`);
  await wait(`document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate('window.fixtureOpened.length'), 2, 'late resumed checkout cannot open after account changes');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1, 'late resumed checkout cannot create another order');

  await win.loadURL(`${origin}/?paid-restart=1`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('尚未完成付款')&&!document.getElementById('membership-online-restart').disabled`); await click('account-open-membership');
  await wait(`!document.getElementById('membership-online-restart').disabled`);
  await evaluate(`window.fixtureStatus='PAID'`); await click('membership-online-restart');
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益确认中')&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true);
  assert.equal(await evaluate(`document.getElementById('membership-online-restart').disabled`), true, 'fresh PAID status prevents starting a replacement order');
  assert.equal(await evaluate('window.fixtureClears'), 0);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), replacementOrderId);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);

  await win.loadURL(`${origin}/?paid-resume-failure=1`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('尚未完成付款')&&!document.getElementById('membership-online-pay').disabled`); await click('account-open-membership');
  await wait(`!document.getElementById('membership-online-pay').disabled`);
  await evaluate(`window.fixtureResumeMode='paid-unavailable'`); await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-status').textContent.includes('原订单已保留')&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0, 'a PAID resume response cannot reopen its checkout when the following query fails');
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true, 'known PAID status remains blocked across status failures');
  assert.equal(await evaluate(`document.getElementById('membership-online-restart').disabled`), true, 'status failures cannot release an order already observed as PAID');
  assert.equal(await evaluate('window.fixtureClears'), 0);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), replacementOrderId);
  await evaluate(`window.fixtureStatusFailure=false;window.fixtureConfirmed=true`); await click('membership-online-check');
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益已由服务端确认')`);
  assert.equal(await evaluate('window.fixtureRefreshes'), 1);
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 1);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0, 'confirmed recovery refreshes rights without opening another checkout');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-pending-payment')`), null);

  await win.loadURL(`${origin}/?late-create=1`);
  await wait(`Boolean(document.getElementById('account-open-membership'))`); await click('account-open-membership');
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
  await evaluate(`sessionStorage.removeItem('fixture-pending-payment');sessionStorage.removeItem('fixture-order-quote')`);
  await win.loadURL(`${origin}/`);
  await wait(`document.getElementById('account-badge')?.textContent.includes('普通用户')`);
  await click('account-open-membership');
  await wait(`document.getElementById('membership-online-quote').textContent.includes('19.90')&&!document.getElementById('membership-online-method').disabled`);
  assert.equal(await evaluate(`document.querySelector('input[name="membership-online-method"]:checked').value`), 'alipay', 'the existing Alipay channel stays the default');
  assert.equal(await evaluate(`document.getElementById('membership-online-status').textContent`), '', 'a successful empty lookup clears the temporary restoration message');
  assert.equal(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-catalog').input.provider`), undefined, 'legacy catalog requests preserve their input contract');
  await evaluate(`document.querySelector('input[name="membership-online-method"][value="wechat"]').click()`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-catalog'&&item.input.provider==='wechat')&&!document.getElementById('membership-online-method').disabled`);
  assert.equal(await evaluate(`document.querySelectorAll('#membership-online-plan option').length`), 3, 'Wechat loads its own registered catalog');
  assert.match(await evaluate(`document.getElementById('membership-online-price-note').textContent`), /人民币.*核对金额/);
  assert.match(await evaluate(`document.getElementById('membership-online-method-help').textContent`), /二维码.*手机微信/);
  assert.doesNotMatch(await evaluate(`document.getElementById('membership-online-method-help').textContent`), /长按|H5|App/);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('input[name="membership-online-plan-choice"]')).map(input=>input.value)`), ['daily','monthly','yearly']);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.membership-plan-choice .membership-plan-price')).map(element=>element.textContent)`), ['¥3.00','¥19.90','¥69.90']);
  await captureState('payment-selection-wechat-desktop',1280); await captureState('payment-selection-wechat-mobile',375); win.setContentSize(1280,960);
  await evaluate(`window.fixtureMode='network'`); await click('membership-online-pay');
  await wait(`document.getElementById('membership-online-status').textContent.includes('网络结果未确认')`);
  assert.equal(await evaluate(`document.getElementById('membership-online-method').disabled`), true, 'uncertain creation freezes the channel to preserve the original request');
  await evaluate(`const radio=document.querySelector('input[name="membership-online-method"][value="alipay"]');radio.checked=true;radio.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.equal(await evaluate(`document.querySelector('input[name="membership-online-method"]:checked').value`), 'wechat', 'programmatic change cannot bypass an uncertain original request');
  await evaluate(`window.fixtureMode='success'`); await click('membership-online-pay');
  assert.equal(await evaluate('window.fixtureOpenCalls.length'), 0, 'even a legacy WeChat response requires an explicit browser fallback');
  await openWechatFallback();
  await wait(`window.fixtureOpened.length===1`);
  const wechatCreates = await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').map(item=>item.input)`);
  assert.equal(wechatCreates.length, 2); assert.deepEqual(wechatCreates[0], wechatCreates[1]);
  assert.equal(wechatCreates[0].provider, 'wechat'); assert.equal(wechatCreates[0].amount, '19.90');
  assert.equal(await evaluate(`new URL(window.fixtureOpened[0]).origin`), 'https://paywc.bornforthis.cn');
  assert.equal(await evaluate(`document.getElementById('membership-online-method').disabled`), true, 'pending orders freeze the accepted payment channel');
  win.setContentSize(375, 812);
  await evaluate(`document.getElementById('membership-online-payment').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`(()=>{const d=document.getElementById('membership-dialog');return d.scrollWidth>d.clientWidth+1})()`), false, 'Wechat payment choices and Native guidance fit a mobile viewport');
  assert.match(await evaluate(`document.getElementById('membership-online-method-help').textContent`), /二维码.*手机微信/);
  fs.writeFileSync(path.join(directory, 'wechat-online-mobile.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1280, 960);
  await win.loadURL(`${origin}/`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-status')&&document.querySelector('input[name="membership-online-method"]:checked').value==='wechat'&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-online-method').disabled`), true, 'a recovered Wechat order selects and locks its saved provider');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  await click('account-open-membership'); await click('membership-online-pay');
  await openWechatFallback();
  await wait(`window.fixtureOpened.length===1`);
  assert.equal(await evaluate(`new URL(window.fixtureOpened[0]).origin`), 'https://paywc.bornforthis.cn', 'recovery resumes the saved Wechat order through its original center');
  assert.equal(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-resume').input.provider`), undefined, 'recovery lets the backend choose the saved order provider');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  assert.equal(await evaluate(`window.fixtureState.account.membership.active`), false);
  await win.loadURL(`${origin}/?native-open-error=1`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-status')&&!document.getElementById('membership-online-pay').disabled`);
  await click('account-open-membership');
  await wait(`!document.getElementById('membership-online-pay').disabled`);
  await evaluate(`window.fixtureOpenFails=true`); await click('membership-online-pay');
  await openWechatFallback();
  await wait(`!document.getElementById('membership-open-error').hidden&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-progress-title').textContent`), '收银台尚未打开');
  assert.match(await evaluate(`document.getElementById('membership-open-error').textContent`), /重试原订单.*复制付款链接/);
  assert.equal(await evaluate(`document.getElementById('membership-copy-checkout').hidden`), false);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'native open failure cannot create a replacement order');
  assert.equal(await evaluate(`window.fixtureOpened.length`), 0);
  await captureState('payment-open-error-desktop',1280); await captureState('payment-open-error-mobile',375); win.setContentSize(1280,960);
  await click('membership-copy-checkout');
  await wait(`document.getElementById('membership-open-error').textContent.includes('付款链接已复制')`);
  assert.equal(await evaluate(`window.fixtureCopied.length`), 1);
  assert.equal(await evaluate(`new URL(window.fixtureCopied[0]).origin`), 'https://paywc.bornforthis.cn');
  await evaluate(`window.fixtureOpenFails=false`); await click('membership-online-pay');
  await openWechatFallback();
  await wait(`window.fixtureOpened.length===1&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  assert.equal(await evaluate(`window.fixtureOpenCalls.every(input=>input.orderId==='${orderId}'&&input.expectedUserId==='a')`), true, 'OS retry retains the same owner and business order');
  const beforeForeignHint = await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status').length`);
  await evaluate(`window.fixtureReturn({orderId:'${replacementOrderId}'})`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status').length`), beforeForeignHint, 'a return for an unsaved order cannot query or replace the active purchase');
  await evaluate(`window.dispatchEvent(new Event('blur'));window.fixtureStatusHoldOnce=true`); await click('membership-online-check');
  await wait(`Boolean(window.fixtureReleaseStatus)`);
  await evaluate(`window.fixtureConfirmed=true;window.fixtureStatus='PAID';window.fixtureReturned=window.fixtureReturn({orderId:'${orderId}'});window.fixtureReleaseStatus();`);
  await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='confirmed'&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-dialog').open`), true);
  assert.equal(await evaluate(`document.getElementById('membership-progress-title').textContent`), '会员已开通');
  assert.match(await evaluate(`document.getElementById('membership-completed-expiry').textContent`), /2026/);
  assert.equal(await evaluate(`document.getElementById('account-badge').classList.contains('is-member')`), true, 'fresh account membership is rendered while the success dialog remains open');
  assert.equal(await evaluate(`window.fixtureState.account.features['profile-download'].allowed`), true);
  assert.equal(await evaluate(`window.fixtureOpened.length`), 1, 'a paid deep return rechecks rights without reopening checkout');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-pending-payment')`), null);
  await evaluate(`window.fixtureReturn({orderId:'${orderId}'})`);
  assert.equal(await evaluate(`document.getElementById('membership-dialog').dataset.paymentPhase`), 'confirmed', 'duplicate verified return keeps the successful result visible');
  assert.equal(await evaluate(`window.fixtureClears`), 1);
  await captureState('payment-return-success-desktop',1280); await captureState('payment-return-success-mobile',375); win.setContentSize(1280,960);
  await evaluate(`window.fixturePersist('${orderId}','a',{planId:'monthly',amount:'19.90',provider:'wechat'})`);
  await win.loadURL(`${origin}/?cold-handoff=1`);
  await wait(`Boolean(window.fixtureReleaseState)`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status').length`), 0, 'a cold-start hint waits for the initial verified account state');
  await evaluate(`window.fixtureReleaseState()`);
  await wait(`document.getElementById('membership-dialog').open&&document.getElementById('membership-dialog').dataset.paymentPhase==='confirmed'&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-progress-title').textContent`), '会员已开通', 'an immediately delivered cold-start hint is replayed after identity initializes');
  assert.equal(await evaluate(`window.fixtureOpened.length`), 0);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  assert.equal(await evaluate(`window.fixtureClears`), 1);
  await captureState('payment-cold-handoff-success-mobile',375); win.setContentSize(1280,960);
  await evaluate(`window.fixturePersist('${orderId}','a',{planId:'monthly',amount:'19.90',provider:'wechat'})`);
  await win.loadURL(`${origin}/?late-open-failure=1`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-status')&&!document.getElementById('membership-online-pay').disabled`);
  await click('account-open-membership'); await wait(`!document.getElementById('membership-online-pay').disabled`);
  await evaluate(`window.fixtureOpenFails=true;window.fixtureOpenHoldOnce=true`); await click('membership-online-pay');
  await openWechatFallback();
  await wait(`Boolean(window.fixtureReleaseOpen)`);
  await evaluate(`window.fixtureConfirmed=true;window.fixtureStatus='PAID';window.fixtureReturned=window.fixtureReturn({orderId:'${orderId}'})`);
  await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='confirmed'`);
  await evaluate(`window.fixtureReleaseOpen()`);
  await wait(`!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-progress-title').textContent`), '会员已开通');
  assert.equal(await evaluate(`document.getElementById('membership-open-error').hidden`), true, 'a late OS open failure cannot overwrite a verified successful result');
  assert.equal(await evaluate(`document.getElementById('membership-copy-checkout').hidden`), true);
  assert.equal(await evaluate(`window.fixtureOpened.length`), 0);
  assert.equal(await evaluate(`window.fixtureClears`), 1);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  await evaluate(`window.fixturePersist('${orderId}','a',{planId:'monthly',amount:'19.90',provider:'wechat'})`);
  await win.loadURL(`${origin}/?delayed-restore=1`);
  await wait(`Boolean(window.fixtureReleasePending)`); await click('account-open-membership');
  await wait(`document.getElementById('membership-online-quote').textContent.includes('19.90')&&!document.getElementById('membership-online-refresh').disabled`);
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true, 'a current quote cannot enable a purchase before pending storage has replied');
  assert.equal(await evaluate(`document.getElementById('membership-online-method').disabled`), true, 'pending lookup locks the channel before its original provider is known');
  assert.equal(await evaluate(`document.getElementById('membership-online-plan').disabled`), true);
  await evaluate(`document.getElementById('membership-online-pay').dispatchEvent(new Event('click'));document.querySelector('input[name="membership-online-method"][value="wechat"]').checked=true;document.querySelector('input[name="membership-online-method"][value="wechat"]').dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'a dispatched click cannot bypass the pending lookup guard');
  assert.equal(await evaluate(`document.querySelector('input[name="membership-online-method"]:checked').value`), 'alipay', 'provider changes remain rejected while restoring');
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId);
  await evaluate(`window.fixturePendingFailure=true;window.fixtureReleasePending()`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('fixture pending record unavailable')`);
  await evaluate(`document.getElementById('membership-online-pay').dispatchEvent(new Event('click'))`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'lookup failure retains the no-new-purchase guard');
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').disabled`), true);
  assert.equal(await evaluate(`document.getElementById('membership-online-method').disabled`), true);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId, 'lookup failure preserves the original persisted reference');
  await evaluate(`window.fixturePendingFailure=false;window.fixturePendingDelay=false`); await click('membership-online-refresh');
  await wait(`document.querySelector('input[name="membership-online-method"]:checked').value==='wechat'&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'refresh restores the original purchase without replacing it');
  assert.equal(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-status').input.orderId`), orderId);
  await win.loadURL(`${origin}/?delayed-restore=1`);
  await wait(`Boolean(window.fixtureReleasePending)`); await click('account-open-membership');
  await wait(`document.getElementById('membership-online-quote').textContent.includes('19.90')&&!document.getElementById('membership-online-refresh').disabled`);
  await evaluate(`window.fixturePendingDelay=false;const next=structuredClone(window.fixtureState);next.account.user={id:'b',email:'b@example.test'};window.fixtureSetState(next);`);
  await click('account-open-membership');
  await wait(`document.getElementById('membership-online-account').textContent.includes('b@example.test')&&!document.getElementById('membership-online-pay').disabled`);
  await evaluate(`window.fixtureReleasePending();new Promise(resolve=>setTimeout(resolve,30))`);
  assert.equal(await evaluate(`document.querySelector('input[name="membership-online-method"]:checked').value`), 'alipay', 'a stale old-owner lookup cannot select its saved provider in the new account');
  assert.equal(await evaluate(`document.getElementById('membership-online-pay').textContent`), '前往 Brclio Pay 付款');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status').length`), 0, 'old-owner lookup cannot query its order after an account switch');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0);
  await evaluate(`sessionStorage.removeItem('fixture-pending-payment');sessionStorage.removeItem('fixture-order-quote')`);
  await win.loadURL(`${origin}/?old-hint-new-order=1`);
  await wait(`document.getElementById('account-badge')?.textContent.includes('普通用户')`); await click('account-open-membership');
  await wait(`!document.getElementById('membership-online-pay').disabled`);
  await evaluate(`window.fixturePersist('${orderId}','a',{planId:'monthly',amount:'19.90'});window.fixturePendingDelay=true;void window.fixtureReturn({orderId:'${orderId}'});`);
  await wait(`Boolean(window.fixtureReleasePending)`);
  await evaluate(`window.fixturePendingDelay=false;window.fixtureMode='success';window.fixtureOrderId='${replacementOrderId}'`);
  await click('membership-online-pay'); await wait(`window.fixtureOpened.length===1&&!document.getElementById('membership-online-pay').disabled`);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), replacementOrderId);
  await evaluate(`window.fixtureReleasePending();new Promise(resolve=>setTimeout(resolve,30))`);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), replacementOrderId, 'a delayed old-hint lookup cannot replace the newer purchase reference');
  assert.equal(await evaluate(`window.fixtureCalls.some(item=>item.action==='payment-status'&&item.input.orderId==='${orderId}')`), false, 'the obsolete hint cannot start an old-order status check after a newer order is active');
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1);
  assert.equal(await evaluate(`window.fixtureOpened.length`), 1);
  await evaluate(`sessionStorage.removeItem('fixture-pending-payment');sessionStorage.removeItem('fixture-order-quote')`);
  await evaluate(`window.fixturePersist('${orderId}','a',{planId:'monthly',amount:'19.90',provider:'wechat'})`);
  await win.loadURL(`${origin}/?legacy-paid-after-fallback-error=1`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-status')&&!document.getElementById('membership-online-pay').disabled`);
  await click('account-open-membership'); await evaluate(`window.fixtureOpenFails=true`);
  await click('membership-online-pay'); await openWechatFallback();
  await wait(`!document.getElementById('membership-open-error').hidden`);
  await evaluate(`window.fixtureStatus='PAID'`); await click('membership-online-check');
  await wait(`document.getElementById('membership-online-status').textContent.includes('权益确认中')&&!document.getElementById('membership-online-check').disabled`);
  const assertPaidPresentation = async () => {
    assert.equal(await evaluate(qrEmpty), true);
    assert.equal(await evaluate(`document.getElementById('membership-copy-checkout').hidden&&document.getElementById('membership-open-checkout').hidden&&document.getElementById('membership-open-error').hidden`), true, 'PAID removes all stale unpaid QR, URL copy, fallback and OS error presentation');
    assert.equal(await evaluate(`document.getElementById('membership-progress-title').textContent`), '正在确认会员权益');
    await click('membership-copy-checkout');
    assert.equal(await evaluate('window.fixtureCopied.length'), 0, 'programmatic copy cannot bypass PAID guards');
  };
  await assertPaidPresentation();
  await evaluate(`window.fixtureConfirmed=true;window.fixturePermissionHold=true;window.fixturePermissionFailure=true`); await click('membership-online-check');
  await wait(`Boolean(window.fixtureReleasePermissions)`); await assertPaidPresentation();
  await evaluate(`window.fixturePermissionHold=false;window.fixtureReleasePermissions()`);
  await wait(`document.getElementById('membership-online-status').textContent.includes('账号或功能权限仍待刷新')&&!document.getElementById('membership-online-check').disabled`);
  await assertPaidPresentation();
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate('window.fixtureClears'), 0);
  await evaluate(`window.fixturePermissionFailure=false`); await click('membership-online-check');
  await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='confirmed'&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate('window.fixtureClears'), 1);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);

  // Current Native responses render their code locally and never trigger an
  // OS browser. The earlier cases deliberately omit QR fields to retain the
  // legacy explicit-fallback, deep-return and Alipay regression coverage.
  await startNativeQr();
  await assertDecodableQr();
  assert.equal(await evaluate(`document.getElementById('membership-open-checkout').hidden`), true, 'a valid local code does not compete with an external checkout action');
  assert.match(await evaluate(`document.getElementById('membership-qr-countdown').textContent`), /付款码剩余 \d+:\d{2}/);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 0);
  await captureState('payment-native-qr-desktop',1280); await captureState('payment-native-qr-mobile',375); win.setContentSize(1280,960);
  await evaluate(`window.fixtureStatus='PAID';window.fixtureBeforeQrPaid=window.fixtureCalls.filter(item=>item.action==='payment-status').length`);
  await wait(`${qrEmpty}&&document.getElementById('membership-online-status').textContent.includes('权益确认中')`, 15_000);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-status').length>window.fixtureBeforeQrPaid`), true, 'automatic status polling observes payment without a browser return or manual query');
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false, 'provider PAID alone does not announce or grant membership');
  assert.equal(await evaluate('window.fixtureClears'), 0);
  assert.equal(await evaluate('window.fixtureOpened.length'), 0);
  await captureState('payment-native-paid-confirming-desktop',1280);
  await evaluate(`window.fixtureConfirmed=true;window.fixturePermissionHold=true`);
  await wait(`Boolean(window.fixtureReleasePermissions)`, 10_000);
  assert.equal(await evaluate(qrEmpty), true, 'the code stays removed while fresh permission refresh is still pending');
  assert.equal(await evaluate(`document.getElementById('membership-dialog').dataset.paymentPhase`), 'refreshing');
  assert.equal(await evaluate(`document.getElementById('account-badge').classList.contains('is-member')`), false);
  await evaluate(`window.fixtureFocus();window.fixtureReturn({orderId:'${orderId}'});window.fixtureReturn({orderId:'${orderId}'})`);
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 1, 'duplicate paid returns share the permission refresh');
  await evaluate(`window.fixturePermissionHold=false;window.fixtureReleasePermissions()`);
  await wait(`document.getElementById('membership-dialog').dataset.paymentPhase==='confirmed'&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(qrEmpty), true);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), true);
  assert.equal(await evaluate(`window.fixtureState.account.features['profile-download'].allowed&&window.fixtureState.account.features['watermark-free-video'].allowed`), true);
  assert.equal(await evaluate(`document.getElementById('account-badge').classList.contains('is-member')`), true);
  assert.equal(await evaluate('window.fixtureClears'), 1);
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-pending-payment')`), null);
  await evaluate(`window.fixtureFocus();window.fixtureReturn({orderId:'${orderId}'})`);
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 1);
  assert.equal(await evaluate('window.fixtureClears'), 1);
  assert.equal(await evaluate('window.fixtureOpenCalls.length'), 0);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1);
  await captureState('payment-native-success-desktop',1280); await captureState('payment-native-success-mobile',375); win.setContentSize(1280,960);

  await startNativeQr('&expiry=1');
  await evaluate(`window.fixtureQrExpiresAt=new Date(Date.now()+1000).toISOString()`); await click('membership-online-check');
  await wait(`${qrVisible}&&!document.getElementById('membership-online-check').disabled`);
  await wait(`${qrEmpty}&&document.getElementById('membership-progress-title').textContent.includes('待刷新')`);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId, 'expiry retains the same recoverable business order');
  assert.equal(await evaluate('window.fixtureOpenCalls.length'), 0, 'expiry never automatically opens a browser');
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 0);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1);
  await captureState('payment-native-expired-mobile',375); win.setContentSize(1280,960);
  await evaluate(`window.fixtureQrCode='weixin://wxpay/bizpayurl?pr=fixture_same_order_refreshed';window.fixtureQrExpiresAt=new Date(Date.now()+60000).toISOString()`);
  await click('membership-online-pay');
  await wait(`${qrVisible}&&!document.getElementById('membership-online-pay').disabled`);
  assert.deepEqual(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-resume').input`), { orderId, expectedUserId: 'a' });
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1, 'refreshing an expired code resumes the original order');
  await assertDecodableQr();
  await click('membership-close');
  await wait(`!document.getElementById('membership-dialog').open&&${qrEmpty}`);
  await click('account-open-membership'); await wait(qrVisible);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1, 'close and reopen preserve the current order');
  await assertDecodableQr();
  await evaluate(`window.fixtureStatusFailure=true`); await click('membership-online-check');
  await wait(`document.getElementById('membership-online-status').textContent.includes('暂时无法核实订单')&&!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('fixture-pending-payment')).orderId`), orderId);
  assert.equal(await evaluate('window.fixtureState.account.membership.active'), false);
  assert.equal(await evaluate('window.fixtureOpenCalls.length'), 0);
  await captureState('payment-native-network-retry-mobile',375); win.setContentSize(1280,960);
  await evaluate(`window.fixtureStatusFailure=false`); await click('membership-online-check'); await wait(qrVisible);

  await evaluate(`window.fixtureStatusHoldOnce=true;window.fixtureQrCode='weixin://wxpay/bizpayurl?pr=fixture_visible_fresh_code'`);
  visibilityEvidence.push(await evaluate(`({stage:'before-hide',hidden:document.hidden,state:document.visibilityState})`));
  win.hide(); await wait(`document.hidden&&${qrEmpty}`);
  visibilityEvidence.push(await evaluate(`({stage:'native-hidden',hidden:document.hidden,state:document.visibilityState,qrEmpty:${qrEmpty}})`));
  win.showInactive(); await wait(`Boolean(window.fixtureReleaseStatus)`);
  visibilityEvidence.push(await evaluate(`({stage:'reshown-status-pending',hidden:document.hidden,state:document.visibilityState,qrEmpty:${qrEmpty}})`));
  assert.equal(await evaluate(qrEmpty), true, 'a visibility return cannot show the previous code before its fresh status read settles');
  await evaluate(`window.fixtureReleaseStatus()`); await wait(qrVisible); await assertDecodableQr();
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 1);

  await evaluate(`window.fixtureStatusHoldOnce=true;window.fixtureReleaseStatus=null`); await click('membership-online-check');
  await wait(`Boolean(window.fixtureReleaseStatus)`);
  await evaluate(`const unverified=structuredClone(window.fixtureState);unverified.verified=false;unverified.status='offline';window.fixtureSetState(unverified)`);
  assert.equal(await evaluate(qrEmpty), true);
  await evaluate(`const verified=structuredClone(window.fixtureState);verified.verified=true;verified.status='ready';window.fixtureSetState(verified);window.fixtureReleaseStatus()`);
  await wait(`!document.getElementById('membership-online-check').disabled`);
  assert.equal(await evaluate(qrEmpty), true, 'reverification cannot revive a status response started before verification was lost');
  await click('membership-online-check'); await wait(qrVisible);
  await evaluate(`window.fixtureStatusHoldOnce=true;window.fixtureReleaseStatus=null`); await click('membership-online-check');
  await wait(`Boolean(window.fixtureReleaseStatus)`);
  await evaluate(`const other=structuredClone(window.fixtureState);other.account.user={id:'b',email:'b@example.test'};window.fixtureSetState(other);window.fixtureReleaseStatus()`);
  await wait(`document.getElementById('membership-online-account').textContent.includes('b@example.test')`);
  assert.equal(await evaluate(qrEmpty), true, 'late previous-owner status cannot expose that owner payment code');
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 0);
  assert.equal(await evaluate('window.fixtureClears'), 0, 'account switch does not delete another owner durable order');

  await prepareNativeQr('&late-native-create=1');
  await evaluate(`window.fixtureMode='delayed'`); await click('membership-online-pay'); await wait('Boolean(window.fixtureRelease)');
  await evaluate(`const other=structuredClone(window.fixtureState);other.account.user={id:'b',email:'b@example.test'};window.fixtureSetState(other);window.fixtureRelease()`);
  await wait(`document.getElementById('membership-online-account').textContent.includes('b@example.test')&&window.fixtureCreateCompletions===1`);
  assert.equal(await evaluate(qrEmpty), true, 'a delayed Native create cannot display the previous account code');
  assert.equal(await evaluate('window.fixtureOpenCalls.length'), 0);
  assert.equal(await evaluate('window.fixturePermissionRefreshes'), 0);
  await evaluate(`sessionStorage.removeItem('fixture-pending-payment');sessionStorage.removeItem('fixture-order-quote')`);
  await startNativeQr('&browser-qr=1');
  assert.equal(await evaluate('Boolean(window.xhsDesktop)'), false, 'browser QR uses the actual cookie account bridge');
  assert.match(await evaluate(`document.getElementById('membership-qr-device-note').textContent`), /另一台设备.*微信扫码/);
  await assertDecodableQr();
  await captureState('payment-native-browser-mobile',375); win.setContentSize(1280,960);
  await click('account-logout');
  await wait(`window.fixtureCalls.some(item=>item.action==='logout')&&${qrEmpty}`);
  assert.equal(await evaluate('window.fixtureOpenCalls.length'), 0);
  assert.equal(await evaluate(`Boolean(localStorage.getItem(window.fixturePendingKey))`), true, 'logout hides the code without deleting the previous owner recovery reference');
  await evaluate(`sessionStorage.removeItem('fixture-pending-payment');sessionStorage.removeItem('fixture-order-quote');localStorage.removeItem(window.fixturePendingKey)`);
  await win.loadURL(`${origin}/?browser-offline=1`);
  await wait(`window.fixtureAccountEvents.at(-1)?.status==='service_unavailable'&&!window.fixtureAccountEvents.at(-1)?.authenticated`);
  assert.equal(await evaluate(`Boolean(window.xhsDesktop)`), false, 'offline identity recovery uses the actual browser account bridge');
  assert.equal(await evaluate(`window.fixtureCalls.some(item=>item.action==='payment-status')`), false, 'unknown cookie identity cannot inspect saved orders');
  assert.equal(await evaluate(`Boolean(localStorage.getItem(window.fixturePendingKey))`), true);
  await evaluate(`window.fixtureOffline=false;window.dispatchEvent(new Event('online'))`);
  await wait(`window.fixtureCalls.some(item=>item.action==='payment-status')&&window.fixtureAccountEvents.at(-1)?.authenticated&&window.fixtureAccountEvents.at(-1)?.verified`);
  assert.equal(await evaluate(`window.fixtureCalls.findIndex(item=>item.action==='payment-status')>window.fixtureCalls.map(item=>item.action).lastIndexOf('me')`), true, 'online recovery verifies the cookie identity before querying the saved order');
  assert.equal(await evaluate(`window.fixtureCalls.find(item=>item.action==='payment-status').input.orderId`), orderId);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='payment-create').length`), 0, 'identity recovery cannot create another order');
  assert.equal(await evaluate(`window.fixtureAccountEvents.at(-1).account.membership.active`), false);
  assert.equal(await evaluate(`window.fixtureAccountEvents.at(-1).account.features['profile-download'].allowed`), false, 'identity recovery cannot grant unconfirmed feature rights');
  assert.equal(await evaluate(`Boolean(localStorage.getItem(window.fixturePendingKey))`), true, 'unconfirmed order stays available after identity recovery');
  await click('account-logout');
  await wait(`window.fixtureAccountEvents.at(-1)?.status==='logged_out'&&window.fixtureCalls.some(item=>item.action==='logout')`);
  await evaluate(`new Promise(resolve=>setTimeout(resolve,300))`);
  await evaluate(`window.fixtureMeBeforeLoggedOutWake=window.fixtureCalls.filter(item=>item.action==='me').length;window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'))`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(item=>item.action==='me').length`), await evaluate('window.fixtureMeBeforeLoggedOutWake'), 'explicit logout cannot be silently reversed by online or focus');
  assert.equal(await evaluate(`window.fixtureAccountEvents.at(-1).authenticated`), false);
  await win.loadURL(`${origin}/membership.html`);
  await wait(`document.querySelector('[data-plan="monthly"] [data-plan-price]').textContent==='19.90'`);
  assert.doesNotMatch(await evaluate(`document.querySelector('main').textContent`), /人工扫码|付款备注|人工付款|邮件发码|24 小时/);
  assert.match(await evaluate(`document.querySelector('.opening-steps').textContent`), /支付宝或微信.*服务端核实后自动开通/);
  assert.equal(await evaluate(`document.querySelector('[data-plan="daily"] [data-plan-price]').textContent`), '停售');
  assert.equal(await evaluate(`document.querySelector('[data-starting-price]').textContent`), '¥19.90');
  await win.loadURL(`${origin}/membership.html?paused=1`);
  await wait(`document.getElementById('membership-catalog-status').textContent.includes('尚未启用在线收款')`);
  assert.equal(await evaluate(`document.querySelector('[data-plan="monthly"] [data-plan-price]').textContent`), '19.90', 'payment pause does not erase current pricing');
  assert.deepEqual(errors, []);
  const qrChecks = [
    'Native QR is a local SVG whose actual canvas pixels independently decode to the current server code',
    'Native QR fits 1280 and 375 pixels with browser guidance requiring another device',
    'automatic PAID polling removes the QR without browser return or uncommitted membership grants',
    'duplicate paid returns share the fresh permission refresh and clear the saved order once',
    'expired QR stays on the original order and refresh never creates another purchase',
    'closing and reopening the payment dialog preserves the same valid order',
    'status network errors retain the original order without granting or opening a browser',
    'real Electron page visibility removes the QR and awaits fresh status before redisplay',
    'same-owner loss and restoration of verification rejects a late old QR response',
    'late status and Native create responses never show the previous account code',
    'browser logout clears QR presentation while retaining the owner recovery reference',
    'legacy WeChat browser fallback requires an explicit action while Alipay retains its flow',
    'PAID clears stale fallback errors and copy actions through held or failed permission refresh',
  ];
  fs.writeFileSync(path.join(directory, 'screenshot-states.json'), JSON.stringify(screenshotStates, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'visibility-evidence.json'), JSON.stringify(visibilityEvidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks: ['confirmed receipt and detail preserve the accepted order price after catalog changes', 'delayed old handoff lookup cannot overwrite a newer active purchase', 'native open failure preserves the same order and supports retry plus copy', 'verified deep return tails old PENDING without reopening checkout', 'open success panel immediately renders member status and expiry', 'daily monthly yearly and Wechat selection fits desktop and 375px', 'cold-start handoff waits for verified initial account state', 'late native open failure cannot replace a confirmed success', 'delayed pending lookup remains guarded when quote returns first', 'lookup failure retains original record and guarded retry', 'old-owner pending lookup cannot unlock or query after account switch', 'Alipay default with separate Wechat registered catalog', 'uncertain Wechat create freezes method and reuses request ID', 'pending Wechat order restores and resumes its saved provider without another create', '375px Native guidance remains visible in the client', 'online-only purchase with manual QR plans email-copy and report removed', 'quote change requires second click', 'PAYMENT_UNAVAILABLE create reuses request ID', 'payment pause blocks checkout and allows readiness refresh', 'removed draft SKU keeps its original plan name', 'recovery preserves original request and quoted amount', 'disabled catalog never creates an order', 'single-order checkout fragment preserved', 'return parameters never grant rights', 'back-forward cache return immediately checks and preserves automatic recovery without duplicate create or grant', 'paid without committed webhook stays pending and automatically polls', 'native app focus immediately checks pending order', 'confirmed order refreshes account and feature rights before clearing recovery', 'fresh account rights reach app listeners and member badge', 'renderer restart restores saved pending order without another create or checkout', 'unpaid recovery resumes the original order with a fresh checkout token', 'restart verifies PENDING before releasing recovery and requires a separate purchase click with a new request ID', 'status and checkout failures retain the original order', 'PAID restart and PAID resume followed by network failure block both purchase actions', 'confirmed recovery after a failed PAID check refreshes rights without another checkout or create', 'confirmed or paid retry without checkout URL queries status', 'late created or resumed checkout discarded on account switch', 'browser online recovery verifies unknown cookie identity before restoring the same pending order and preserves explicit logout', 'marketing page uses enabled live catalog and shows payment pause', '375px online layout including unpaid restart control', ...qrChecks], visibilityEvidence, screenshots: directory }));
  await finish(0);
}).catch(error => void finish(1, error));
