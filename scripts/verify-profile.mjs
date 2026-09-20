// Real website observation; no authentication is supplied or bypassed.
// node_modules/.bin/electron scripts/verify-profile.mjs [profile URL]
import { app, BrowserWindow, session } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XhsBrowser } from '../desktop/profile-browser.js';

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'xhs-profile-smoke-')));
const report = value => console.log(JSON.stringify(value));
report({ stage: 'starting', ready: app.isReady() });
// Start before ready, so startup, renderer and debugger stalls are all bounded.
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ result: 'timeout', stage: 'profile-observation' }));
  app.exit(1);
}, 105000);

app.whenReady().then(async () => {
  report({ stage: 'ready' });
  const browser = new XhsBrowser({
    BrowserWindow, session,
    onStatus(message) { report({ stage: 'status', message }); }
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let exitCode = 0;
  try {
    const win = await browser.window();
    report({ stage: 'window-created', id: win.id });
    win.webContents.on('dom-ready', () => report({ stage: 'dom-ready' }));
    win.webContents.on('did-fail-load', (_event, code, message) => report({ stage: 'load-error', code, message }));
    let count = 0;
    for await (const page of browser.discover(process.argv[2] || 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c', {
      signal: controller.signal, intervalSeconds: 10, jitterSeconds: 0
    })) {
      count += page.notes.length;
      report({ discovered: count, done: page.done });
    }
  } catch (error) {
    const expectedBarrier = ['AUTH_REQUIRED', 'RATE_LIMITED', 'DISCOVERY_INCOMPLETE'].includes(error.code);
    exitCode = expectedBarrier ? 0 : 1;
    report({ result: expectedBarrier ? 'blocked' : 'failed', code: error.code || error.name, message: error.message });
  } finally {
    clearTimeout(timer);
    clearTimeout(watchdog);
    browser.close();
    app.exit(exitCode);
  }
}).catch(error => {
  console.error(JSON.stringify({ result: 'failed', code: error.code || error.name, message: error.message }));
  clearTimeout(watchdog);
  app.exit(1);
});
