// Launch the extracted, signed executable (not the development Electron binary).
// This tests packaging/JIT/renderer/Python, not Gatekeeper approval or notarization.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyPackagedMacLaunch(appPath, { version, productName }) {
  const profile = await mkdtemp(path.join(tmpdir(), 'xhs-packaged-launch-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(appPath, 'Contents/MacOS', productName), [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--use-mock-keychain' // Do not read or change the user's real Keychain during this isolated smoke test.
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', launchError;
  let socket;
  child.on('error', error => { launchError = error; });
  child.stdout.on('data', data => { output = (output + data).slice(-16000); });
  child.stderr.on('data', data => { output = (output + data).slice(-16000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  const deadline = Date.now() + 45000;
  try {
    let page;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, `Packaged app exited before its renderer was ready: ${output}`);
      assert.equal(child.signalCode, null, `Packaged app was terminated before its renderer was ready: ${output}`);
      const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
      if (port) {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
        page = targets.find(item => item.type === 'page' && item.url.startsWith('xhs-app://local/'));
        if (page?.webSocketDebuggerUrl) break;
      }
      await delay(200);
    }
    assert.ok(page?.webSocketDebuggerUrl, `Packaged app did not open its renderer: ${output}`);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged renderer connection timed out')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Packaged renderer connection failed')); }, { once: true });
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Packaged renderer smoke timed out: ${output}`)), 20000);
      socket.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)));
        else resolve(response.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true,
        expression: `(async () => {
          for (let i = 0; i < 100 && !window.xhsDesktop; i++) await new Promise(r => setTimeout(r, 50));
          const info = await window.xhsDesktop.getInfo();
          const payloads = [];
          for (const route of ['/api/parse', '/api/python_parse']) {
            const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: 'https://sns-img-bd.xhscdn.com/packaged-signature-smoke' }) });
            const body = await response.json();
            payloads.push({ status: response.status, success: body.success, images: body.images?.length });
          }
          return { info, payloads, secureContext: window.isSecureContext, nodeAvailable: typeof require === 'function' };
        })()` } }));
    });
    assert.equal(result.info.version, version);
    assert.equal(result.info.name, productName);
    assert.equal(result.info.pythonAvailable, true);
    assert.equal(result.secureContext, true);
    assert.equal(result.nodeAvailable, false);
    assert.deepEqual(result.payloads, [{ status: 200, success: true, images: 1 }, { status: 200, success: true, images: 1 }]);
    console.log(JSON.stringify({ packagedMacLaunchVerified: true, version, renderer: true, nodeAndPythonParse: true,
      profile: 'temporary', keychain: 'mock', gatekeeperApprovalTested: false }));
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    const stopped = await Promise.race([closed.then(() => true), delay(5000).then(() => false)]);
    if (!stopped) { child.kill('SIGKILL'); await closed; }
    await rm(profile, { recursive: true, force: true });
  }
}
