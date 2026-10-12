// Real renderer verification of avatar UI. All account writes stay in this fixture.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-avatar-ui-'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
let server, win, finished = false;
const fixture = `
window.fixtureErrors=[]; addEventListener('error',event=>window.fixtureErrors.push(event.message)); addEventListener('unhandledrejection',event=>window.fixtureErrors.push(String(event.reason)));
window.fixtureState={configured:true,authenticated:true,verified:true,status:'ready',account:{user:{id:'avatar-owner',email:'avatar@example.test',nickname:'收藏图片的小鹿'},membership:{type:'none',active:false},device:{status:'authorized'},serverTime:'2026-10-12T00:00:00Z'}};
window.fixtureListeners=[]; window.fixtureCalls=[]; window.fixtureFailSelect=false; window.fixtureHoldUpload=false; window.fixtureThumbnail=null;
window.fixturePublish=value=>{window.fixtureState=value;window.fixtureListeners.forEach(callback=>callback(structuredClone(value)));};
window.fixtureReply=result=>({ok:true,result,state:structuredClone(window.fixtureState)});
window.xhsDesktop={getInfo:async()=>({version:'avatar-fixture',platform:'darwin'}),getProfileState:async()=>({status:'idle',items:[]}),onProfileUpdate:()=>()=>{},
getAccountState:async()=>structuredClone(window.fixtureState),onAccountUpdate:callback=>{window.fixtureListeners.push(callback);return()=>{}},refreshAccount:async()=>window.fixtureReply({}),
selectAccountAvatar:async input=>{window.fixtureCalls.push({method:'select',...input});if(window.fixtureFailSelect){window.fixtureFailSelect=false;return {ok:false,state:structuredClone(window.fixtureState),error:{message:'头像保存失败，请重试。'}};}window.fixtureState.account.user.avatar={kind:'builtin',id:input.builtinId};window.fixturePublish(window.fixtureState);return window.fixtureReply({profile:{avatar:window.fixtureState.account.user.avatar}});},
uploadAccountAvatar:async input=>{window.fixtureCalls.push({method:'upload',expectedUserId:input.expectedUserId});window.fixtureLastUpload=input;if(window.fixtureHoldUpload)await new Promise(resolve=>window.fixtureReleaseUpload=resolve);if(input.expectedUserId!==window.fixtureState.account?.user?.id)return {ok:false,state:structuredClone(window.fixtureState),error:{message:'账号已切换'}};window.fixtureThumbnail=input.thumbnail;window.fixtureState.account.user.avatar={kind:'upload',id:'custom-1',url:'https://must-never-load.test/private-original'};window.fixturePublish(window.fixtureState);return window.fixtureReply({profile:{avatar:window.fixtureState.account.user.avatar}});},
getAccountAvatarThumbnail:async input=>{window.fixtureCalls.push({method:'thumbnail',...input});return window.fixtureReply({thumbnail:window.fixtureThumbnail,contentType:'image/webp'});}};
`;
const timeout = setTimeout(() => void finish(1, new Error('AVATAR_UI_TIMEOUT')), 60_000);
async function finish(code, error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  app.exit(code);
}
app.whenReady().then(async () => {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fixture); return; }
      if (url.pathname === '/assets/avatars/manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(fs.readFileSync(path.join(root, 'assets/avatars/manifest.json'))); return;
      }
      if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, count: 0 })); return; }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..')) throw new Error('Invalid fixture file');
      const file = path.join(root, name); let bytes = fs.readFileSync(file);
      if (name === 'index.html') bytes = Buffer.from(bytes.toString().replace('<head>', '<head><script src="/fixture.js"></script>'));
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 960, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const remoteRequests = [];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => { const local = details.url.startsWith(origin) || /^(?:data|blob):/.test(details.url); if (!local) remoteRequests.push(details.url); callback({ cancel: !local }); });
  const evaluate = value => win.webContents.executeJavaScript(value, true);
  const until = value => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(${value})resolve();else if(Date.now()-start>8000)reject(new Error('Timeout: '+${JSON.stringify(value)}));else setTimeout(check,20)};check()})`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await win.loadURL(origin);
  await until(`document.body.dataset.desktopReady==='true'&&document.getElementById('account-avatar-open')&&!document.getElementById('account-avatar-open').disabled`);
  await click('account-tab'); await click('account-avatar-open');
  await until(`document.querySelectorAll('.account-avatar-option').length===100`);
  await evaluate(`Promise.all(Array.from(document.querySelectorAll('.account-avatar-option img'), image => { image.loading='eager'; return image.decode(); }))`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.account-avatar-option img')).every(image=>image.complete&&image.naturalWidth===256&&image.naturalHeight===256)`), true, 'all100 actual generated assets decode at256px');
  assert.equal(await evaluate(`document.querySelectorAll('#account-avatar-grid button[tabindex="0"]').length`), 1);
  await evaluate(`document.querySelector('[data-avatar-id="avatar-003"]').click()`);
  await until(`document.getElementById('account-avatar-status').textContent==='头像已更新。'&&!document.querySelector('.desktop-user-avatar-image').hidden`);
  assert.match(await evaluate(`document.querySelector('.desktop-user-avatar-image').src`), /avatar-003\.webp$/);
  assert.equal(await evaluate(`document.querySelector('[data-avatar-id="avatar-003"]').getAttribute('aria-checked')`), 'true');
  await evaluate(`document.querySelector('[data-avatar-id="avatar-003"]').focus()`); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await until(`document.activeElement.dataset.avatarId==='avatar-004'`);
  assert.equal(await evaluate(`document.activeElement.dataset.avatarId`), 'avatar-004');
  await evaluate(`window.fixtureFailSelect=true;document.querySelector('[data-avatar-id="avatar-004"]').click()`);
  await until(`document.getElementById('account-avatar-status').classList.contains('is-error')&&!document.getElementById('account-avatar-upload').disabled`);
  assert.equal(await evaluate(`window.fixtureState.account.user.avatar.id`), 'avatar-003');
  await evaluate(`document.querySelector('[data-avatar-id="avatar-004"]').click()`);
  await until(`window.fixtureState.account.user.avatar.id==='avatar-004'&&!document.getElementById('account-avatar-upload').disabled`);
  assert.deepEqual(await evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=400;canvas.height=200;const context=canvas.getContext('2d');context.fillStyle='#2b7fd8';context.fillRect(0,0,200,200);context.fillStyle='#f4d758';context.fillRect(200,0,200,200);
    const jpeg=new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg'))).arrayBuffer());
    const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
    const file=new File([jpeg.slice(0,2),exif,jpeg.slice(2)],'rotated-original.jpg',{type:'image/jpeg'});let dimensions;
    const module=await import('/lib/avatar-client.js');const prepared=await module.prepareAvatarFile(file,{createImageBitmapImpl:async(...args)=>{const image=await createImageBitmap(...args);dimensions=[image.width,image.height];return image;}});
    return {dimensions,originalPreserved:new Uint8Array(await file.arrayBuffer()).every((byte,index)=>byte===new Uint8Array(prepared.original)[index])};
  })()`), { dimensions: [200, 400], originalPreserved: true }, 'EXIF6 photos retain their oriented aspect ratio and original bytes');
  const upload = `async()=>{const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=800;const ctx=canvas.getContext('2d');ctx.fillStyle='#2b7fd8';ctx.fillRect(0,0,800,800);ctx.fillStyle='#f4d758';ctx.fillRect(800,0,800,800);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const file=new File([blob],'收藏原图.png',{type:'image/png'});window.fixtureOriginal=await file.arrayBuffer();const data=new DataTransfer();data.items.add(file);const input=document.getElementById('account-avatar-file');input.files=data.files;input.dispatchEvent(new Event('change'));}`;
  await evaluate(`(${upload})()`);
  await until(`document.getElementById('account-avatar-status').textContent.includes('原图已私密保存')&&document.querySelector('.desktop-user-avatar-image').src.startsWith('blob:')`);
  assert.equal(await evaluate(`window.fixtureLastUpload.name==='收藏原图.png'&&window.fixtureLastUpload.contentType==='image/png'&&new Uint8Array(window.fixtureOriginal).every((byte,index)=>byte===new Uint8Array(window.fixtureLastUpload.original)[index])&&window.fixtureOriginal.byteLength===window.fixtureLastUpload.original.byteLength`), true, 'original upload preserves every byte');
  assert.equal(await evaluate(`new Promise(resolve=>{const image=new Image();image.onload=()=>{URL.revokeObjectURL(image.src);resolve(image.naturalWidth===256&&image.naturalHeight===256)};image.src=URL.createObjectURL(new Blob([window.fixtureLastUpload.thumbnail],{type:'image/webp'}))})`), true, 'real Chromium creates256px compressed derivative');
  assert.equal(await evaluate(`window.fixtureCalls.filter(call=>call.method==='thumbnail').length`), 1, 'account preview and header share only compressed-thumbnail retrieval');
  assert.equal(remoteRequests.some(value => value.includes('must-never-load')), false, 'private original metadata is never used as a display URL');
  await evaluate(`document.querySelector('.desktop-user-avatar-image').dispatchEvent(new Event('error'))`);
  assert.equal(await evaluate(`document.querySelector('.desktop-user-avatar-image').hidden&&!document.getElementById('desktop-user-initial').hidden`), true, 'failed images retain usable initial fallback');
  await evaluate(`const input=document.getElementById('account-avatar-file');const data=new DataTransfer();data.items.add(new File(['<svg/>'],'bad.svg',{type:'image/svg+xml'}));input.files=data.files;input.dispatchEvent(new Event('change'))`);
  await until(`document.getElementById('account-avatar-status').textContent.includes('暂不支持')&&!document.getElementById('account-avatar-upload').disabled`);
  assert.equal(await evaluate(`window.fixtureCalls.filter(call=>call.method==='upload').length`), 1, 'unsupported images never send original bytes');
  await evaluate(`window.fixtureHoldUpload=true;(${upload})()`);
  await until(`window.fixtureReleaseUpload&& !document.getElementById('account-avatar-progress').hidden`);
  await evaluate(`window.fixturePublish({configured:true,authenticated:false,verified:false,status:'logged_out',account:null});window.fixtureReleaseUpload()`);
  await until(`!document.getElementById('account-avatar-dialog').open&&document.getElementById('desktop-user-name').textContent==='登录账号'`);
  assert.equal(await evaluate(`document.querySelector('.desktop-user-avatar-image').hidden&&document.getElementById('account-details').hidden`), true, 'account switch removes prior custom avatar and invalidates pending upload');
  await evaluate(`window.fixtureHoldUpload=false;window.fixturePublish({configured:true,authenticated:true,verified:true,status:'ready',account:{user:{id:'avatar-owner-2',email:'other@example.test',avatar:{kind:'builtin',id:'avatar-003'}},membership:{type:'none',active:false},device:{status:'authorized'}}})`);
  await click('account-avatar-open');
  const screenshots = [];
  for (const width of [1280, 760, 390, 320]) {
    win.setContentSize(width, 960); await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`(()=>{const d=document.getElementById('account-avatar-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1})()`), true, `${width}px picker fits without horizontal overflow`);
    const screenshot = path.join(output, `avatar-picker-${width}.png`); fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG()); screenshots.push(screenshot);
    if (width === 1280) {
      await evaluate(`document.getElementById('account-avatar-grid').scrollTop=document.getElementById('account-avatar-grid').scrollHeight;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const end = path.join(output, 'avatar-picker-last-avatars.png'); fs.writeFileSync(end, (await win.webContents.capturePage()).toPNG()); screenshots.push(end);
      await evaluate(`document.getElementById('account-avatar-grid').scrollTop=0`);
    }
  }
  await click('account-avatar-close');
  await until(`document.activeElement.id==='account-avatar-open'`);
  assert.equal(await evaluate(`document.activeElement.id`), 'account-avatar-open');
  assert.deepEqual(await evaluate(`window.fixtureErrors`), []);
  console.log(JSON.stringify({ avatarUI: 'passed', checks: ['100 actual generated assets and keyboard navigation', 'selection persistence and retry', 'original byte preservation', 'real256px WebP compression', 'EXIF6 oriented-photo aspect ratio', 'shared compressed-only header display', 'unsupported-file guard', 'stale upload session isolation', 'image fallback', '1280/760/390/320 responsive dialog'], screenshots }));
  await finish(0);
}).catch(error => void finish(1, error));
