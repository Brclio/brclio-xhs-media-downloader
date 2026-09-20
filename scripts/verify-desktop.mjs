// Developer smoke: run with node_modules/.bin/electron scripts/verify-desktop.mjs.
// Uses a disposable application profile and the real main/preload/protocol code.
import { app } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'xhs-desktop-smoke-'));
app.setPath('userData', temporary);
app.getAppPath = () => root;
let done = false;
const timer = setTimeout(() => { console.error('DESKTOP_SMOKE_TIMEOUT'); app.exit(1); }, 40000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    if (done || !win.webContents.getURL().startsWith('xhs-app://local/')) return;
    done = true;
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const info = await window.xhsDesktop.getInfo();
        const state = await window.xhsDesktop.getProfileState();
        const payloads = [];
        for (const route of ['/api/parse', '/api/python_parse']) {
          const response = await fetch(route, {method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({text:'https://sns-img-bd.xhscdn.com/smoke-original-image'})});
          const data = await response.json();
          payloads.push({route,status:response.status,success:data.success,engine:data.engine,images:data.images?.length});
        }
        // Module initialization awaits the bridge; drain promises before inspecting.
        await new Promise(resolve=>setTimeout(resolve,100));
        return {info,status:state.status,payloads,profileVisible:!document.querySelector('#profile-panel').hidden,
          tabsVisible:!document.querySelector('#desktop-navigation').hidden,
          nodeAvailable:typeof require === 'function',
          secureContext:window.isSecureContext};
      })()`);
      if (!result.info.pythonAvailable || result.status !== 'idle' || !result.profileVisible
          || !result.tabsVisible || result.nodeAvailable || !result.secureContext
          || result.payloads.some(value => !value.success || value.images !== 1 || value.status !== 200)) {
        throw new Error(JSON.stringify(result));
      }
      const screenshot = path.join(temporary, 'desktop.png');
      writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ smoke: 'passed', ...result, screenshot }));
      clearTimeout(timer);
      app.quit();
    } catch (error) {
      console.error('DESKTOP_SMOKE_FAILED', error);
      clearTimeout(timer);
      app.exit(1);
    }
  });
});
await import('../desktop/main.js');
