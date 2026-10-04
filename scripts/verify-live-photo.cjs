// Actual renderer and Apple Photos recognition checks with disposable local files.
// Run: npx electron scripts/verify-live-photo.cjs [--built]
// Requires ffmpeg/ffprobe; macOS also verifies PHLivePhoto.request without importing.
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const staticRoot = process.argv.includes('--built') ? path.join(root, 'dist-web') : root;
const engineOnly = process.argv.includes('--engine-only');
const uiOnly = process.argv.includes('--ui-only');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-live-photo-'));
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
app.setPath('userData', path.join(temporary, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);
app.commandLine.appendSwitch('force-prefers-reduced-motion');
let win, server, finished = false;
const evidence = { artifacts: [], checks: [], screenshots, temporary };
const timeout = setTimeout(() => void finish(1, new Error('LIVE_PHOTO_VERIFICATION_TIMEOUT')), 240_000);
async function finish(code, error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) { evidence.error = error.stack; console.error(error); }
  const report = path.join(temporary, 'verification.json');
  fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ result: code ? 'FAIL' : 'PASS', checks: evidence.checks, report,
    artifacts: evidence.artifacts.map(item => ({ name: item.name, jpg: item.jpg, mov: item.mov,
      nativeRecognition: item.nativeRecognition, audioPayload: item.audioPayload })), rendererErrors: evidence.rendererErrors }));
  win?.destroy();
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(code);
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(test, label, milliseconds = 15_000) {
  const start = Date.now();
  while (!(await test())) {
    if (Date.now() - start > milliseconds) throw new Error(`Timed out: ${label}`);
    await pause(35);
  }
}
const run = (program, args, options = {}) => execFileSync(program, args, {
  encoding: 'utf8', timeout: 45_000, maxBuffer: 8 * 1024 * 1024, ...options,
});
function createFixtures() {
  const make = (name, args, type) => {
    const filename = path.join(temporary, name);
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, filename]);
    return { name, type, base64: fs.readFileSync(filename).toString('base64') };
  };
  const image = (name, color) => make(name, ['-f', 'lavfi', '-i', `color=c=${color}:s=640x360`, '-frames:v', '1'], 'image/png');
  const video = (name, size, duration, audio) => make(name, [
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${duration}`,
    ...(audio ? ['-f', 'lavfi', '-i', `aevalsrc=0.18*sin(2*PI*if(lt(t\\,1)\\,220\\,if(lt(t\\,2)\\,440\\,if(lt(t\\,3)\\,880\\,1320)))*t):s=48000:d=${duration}`] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    ...(audio ? ['-c:a', 'aac'] : ['-an']), '-movflags', '+faststart',
  ], 'video/mp4');
  return {
    red: image('red.png', 'red'), green: image('green.png', 'green'), blue: image('blue.png', 'blue'),
    audio: video('landscape-audio.mp4', '640x360', 5, true),
    portrait: video('portrait.mp4', '360x640', 2, false),
    silent: video('landscape-silent.mp4', '640x360', 2, false),
  };
}
function nativeVerifier() {
  if (process.platform !== 'darwin') return null;
  const source = path.join(temporary, 'verify-phlivephoto.swift');
  fs.writeFileSync(source, `import Foundation
import Photos
import AppKit
let urls = CommandLine.arguments.dropFirst().map { URL(fileURLWithPath: $0) }
var finished = false
var success = false
PHLivePhoto.request(withResourceFileURLs: urls, placeholderImage: nil, targetSize: NSSize(width: 320, height: 320), contentMode: .aspectFit) { photo, info in
    let degraded = info[PHLivePhotoInfoIsDegradedKey] as? Bool ?? false
    print("callback degraded=\\(degraded) photo=\\(photo != nil) info=\\(info)")
    if !degraded { success = photo != nil; finished = true }
}
let deadline = Date().addingTimeInterval(20)
while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
print("recognized=\\(success)")
exit(success ? 0 : 1)
`);
  const executable = path.join(temporary, 'verify-phlivephoto');
  run('swiftc', [source, '-o', executable]);
  return executable;
}

app.whenReady().then(async () => {
  const fixtures = createFixtures();
  const native = nativeVerifier();
  const { createProtocolHandler } = await import(pathToFileURL(path.join(root, 'desktop/protocol.js')).href);
  const nativeHandler = createProtocolHandler({ rootDirectory: root });
  protocol.handle('xhs-app', request => {
    const url = new URL(request.url);
    if (url.pathname === '/index.html' && url.searchParams.get('liveFixture') === '1') {
      const fixture = `<script>window.liveVerifyDesktopCalls = []; window.xhsDesktop = {
        getInfo: async () => ({ version: '2.0.4', platform: 'darwin', pythonAvailable: false }),
        getProfileState: async () => ({ status: 'idle', items: [] }), onProfileUpdate: () => () => {}, onAccountUpdate: () => () => {},
        getAccountState: async () => ({ configured: false, authenticated: false, status: 'logged_out', account: null }),
        getLoginState: async () => ({ authenticated: false }),
        recordDiagnostic: async (event, fields) => { window.liveVerifyDesktopCalls.push({event, fields}); }
      };</script>`;
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
        .replace(/<script[^>]*src="\/visit-counter\.js"[^>]*><\/script>/, '')
        .replace(/<script type="module" src="\/app\.js"><\/script>/, fixture + '<script type="module" src="/app.js"></script>');
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }
    return nativeHandler(request);
  });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/__engine__.html') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Local Live Photo renderer verification</title>'); return;
    }
    const filename = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
    if (!filename.startsWith(staticRoot + path.sep) || !mime[path.extname(filename)] || !fs.existsSync(filename)) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)], 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(filename));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: ![origin + '/', 'xhs-app://local/', 'data:', 'blob:'].some(prefix => details.url.startsWith(prefix)),
  }));
  const errors = [];
  evidence.rendererErrors = errors;
  win.webContents.on('console-message', details => {
    if (details.level === 'error' && !details.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(details.message);
  });
  const evaluate = script => win.webContents.executeJavaScript(script, true);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(screenshots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  await win.loadURL(origin + (engineOnly ? '/__engine__.html' : '/live.html'));
  await evaluate(`(async () => { window.liveVerifyModule = await import('/lib/live-photo-maker.js');
    window.liveVerifyFixtures = ${JSON.stringify(fixtures)};
    window.liveVerifyFiles = names => names.map(name => { const f = window.liveVerifyFixtures[name];
      return new File([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))], f.name, { type: f.type }); });
    window.liveVerifyBlob = value => value instanceof Blob ? value : new Blob([value]);
    window.liveVerifyBase64 = async value => { const data = new Uint8Array(await window.liveVerifyBlob(value).arrayBuffer()); let str = '';
      for (let i = 0; i < data.length; i += 8192) str += String.fromCharCode(...data.subarray(i, i + 8192)); return btoa(str); }; })()`);
  evidence.support = await evaluate('window.liveVerifyModule.checkLivePhotoSupport({ audio: true })');
  const create = async (name, files, options, expectations) => {
    const output = await evaluate(`(async () => {
      const progress = [];
      const result = await window.liveVerifyModule.createLivePhoto({ files: window.liveVerifyFiles(${JSON.stringify(files)}),
        ...${JSON.stringify(options)}, onProgress: value => progress.push(value) });
      window.liveVerifyLastResult = result;
      const video = document.createElement('video'); video.muted = true;
      const url = URL.createObjectURL(window.liveVerifyBlob(result.mov)); video.src = url;
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('MOV is not playable in Chromium')); });
      await video.play();
      const began = performance.now();
      while (video.currentTime < 0.025 && performance.now() - began < 5000) await new Promise(resolve => setTimeout(resolve, 25));
      video.pause();
      const decoded = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, currentTime: video.currentTime };
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
      return { jpeg: await window.liveVerifyBase64(result.jpeg), mov: await window.liveVerifyBase64(result.mov),
        preview: await window.liveVerifyBase64(result.previewBlob), assetIdentifier: result.assetIdentifier,
        width: result.width, height: result.height, duration: result.duration, keyPhotoTime: result.keyPhotoTime, progress, decoded };
    })()`);
    const jpg = path.join(temporary, name + '.jpg');
    const mov = path.join(temporary, name + '.mov');
    fs.writeFileSync(jpg, Buffer.from(output.jpeg, 'base64'));
    fs.writeFileSync(mov, Buffer.from(output.mov, 'base64'));
    fs.writeFileSync(path.join(temporary, name + '-preview.mov'), Buffer.from(output.preview, 'base64'));
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mov]));
    const artifact = { name, jpg, mov, options, width: output.width, height: output.height,
      duration: output.duration, keyPhotoTime: output.keyPhotoTime, assetIdentifier: output.assetIdentifier,
      decoded: output.decoded, progress: output.progress, probe };
    evidence.artifacts.push(artifact);
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video?.codec_name, 'h264', name + ': actual H264 video');
    assert.ok(Math.abs(Number(probe.format.duration) - options.duration) < 0.15, name + ': duration matches requested trim');
    assert.ok(output.decoded.currentTime > 0, name + ': actual decoder advances');
    assert.ok(Math.abs(output.decoded.duration - options.duration) < 0.15, name + ': renderer duration');
    assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), expectations.audio, name + ': audio track');
    const timed = probe.streams.find(stream => stream.codec_type === 'data' && stream.codec_tag_string === 'mebx');
    assert.ok(timed, name + ': still-image-time metadata track');
    const packets = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'd', '-show_packets', '-of', 'json', mov])).packets;
    assert.ok(packets.some(packet => Math.abs(Number(packet.pts_time) - output.keyPhotoTime) < 0.04), name + ': timed metadata coincides with cover');
    artifact.timedMetadataPackets = packets;
    assert.ok(fs.readFileSync(jpg).includes(Buffer.from(output.assetIdentifier)), name + ': JPEG contains shared identifier');
    assert.ok(fs.readFileSync(mov).includes(Buffer.from(output.assetIdentifier)), name + ': MOV contains shared identifier');
    assert.equal(probe.format.tags?.['com.apple.quicktime.content.identifier'], output.assetIdentifier,
      name + ': QuickTime content identifier is parser-readable');
    assert.ok(output.progress.length > 2, name + ': progress callbacks');
    if (expectations.portrait) assert.ok(output.height > output.width, name + ': portrait stays portrait');
    if (expectations.audio) {
      const pcm = run('ffmpeg', ['-v', 'error', '-i', mov, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: null });
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
      const window = (start, end) => {
        const part = samples.subarray(Math.round(start * 48000), Math.round(end * 48000));
        let square = 0, crossings = 0;
        for (let index = 0; index < part.length; index++) {
          square += part[index] * part[index];
          if (index > 0 && part[index - 1] <= 0 && part[index] > 0) crossings++;
        }
        return { rms: Math.sqrt(square / part.length), frequency: crossings / (part.length / 48000) };
      };
      artifact.audioPayload = { duration: samples.length / 48000, first: window(0.2, 0.7), second: window(1.2, 1.7) };
      assert.ok(artifact.audioPayload.first.rms > 0.08 && artifact.audioPayload.second.rms > 0.08, name + ': audible PCM is retained');
      assert.ok(Math.abs(artifact.audioPayload.first.frequency - 440) < 8, name + ': first audio second is from source trim 1–2 s');
      assert.ok(Math.abs(artifact.audioPayload.second.frequency - 880) < 8, name + ': second audio second is from source trim 2–3 s');
    }
    if (native) {
      artifact.nativeRecognition = run(native, [jpg, mov], { timeout: 25_000 });
      assert.match(artifact.nativeRecognition, /recognized=true/, name + ': native Apple Photos recognizes the pair');
    }
    evidence.checks.push(name + ': actual H264 decoder, ffprobe timing/audio/metadata, shared identifier' + (native ? ', native Apple Photos recognition' : ''));
    return artifact;
  };
  if (!uiOnly) {
  await create('single-image', ['red'], { start: 0, duration: 1.5, keyPhotoTime: 0.75, motion: 'zoom', includeAudio: false }, { audio: false });
  await create('multi-images', ['red', 'green', 'blue'], { start: 0, duration: 3, keyPhotoTime: 1.5, motion: 'still', includeAudio: false }, { audio: false });
  await create('trimmed-audio-video', ['audio'], { start: 1, duration: 2, keyPhotoTime: 0.7, motion: 'still', includeAudio: true }, { audio: true });
  await create('portrait-video', ['portrait'], { start: 0.2, duration: 1.2, keyPhotoTime: 0.4, motion: 'still', includeAudio: false }, { audio: false, portrait: true });
  await create('silent-video', ['silent'], { start: 0.1, duration: 1.4, keyPhotoTime: 0.8, motion: 'still', includeAudio: false }, { audio: false });

  for (const [name, files, options] of [
    ['duration-over-limit', ['red'], { duration: 3.2, start: 0 }],
    ['trim-past-end', ['portrait'], { duration: 1, start: 1.8 }],
    ['mixed-image-and-video', ['red', 'portrait'], { duration: 1, start: 0 }],
  ]) {
    const rejected = await evaluate(`(async () => { try {
      await window.liveVerifyModule.createLivePhoto({ files: window.liveVerifyFiles(${JSON.stringify(files)}), ...${JSON.stringify(options)} });
      return { rejected: false };
    } catch (error) { return { rejected: true, name: error.name, message: error.message }; } })()`);
    assert.equal(rejected.rejected, true, name + ': invalid request rejects');
    evidence.checks.push({ case: name, ...rejected });
  }
  const cancellation = await evaluate(`(async () => {
    const controller = new AbortController(); let callbacks = 0;
    try { await window.liveVerifyModule.createLivePhoto({ files: window.liveVerifyFiles(['red', 'green', 'blue']),
      start: 0, duration: 3, keyPhotoTime: 1.5, signal: controller.signal,
      onProgress: () => { if (++callbacks === 3) controller.abort(); } }); return { rejected: false, callbacks }; }
    catch (error) { return { rejected: true, name: error.name, message: error.message, callbacks }; }
  })()`);
  assert.equal(cancellation.rejected, true, 'active conversion cancellation rejects');
  assert.equal(cancellation.name, 'AbortError', 'cancellation retains AbortError');
  evidence.checks.push({ case: 'active-cancellation', ...cancellation });
  if (engineOnly) { await finish(0); return; }
  }

  // UI assertions are intentionally performed against the actual page module.
  // No encoder, inspection, or Blob API is stubbed.
  for (const [surface, pageOrigin] of [['web', origin], ['desktop', 'xhs-app://local']]) {
    await win.loadURL(pageOrigin + '/live.html');
    await until(() => evaluate("document.documentElement.dataset.liveReady === 'true'"), surface + ': UI initialized');
    await evaluate(`window.liveVerifyFixtures = ${JSON.stringify(fixtures)};
      window.liveVerifyUpload = names => { const transfer = new DataTransfer(); for (const name of names) {
        const f = window.liveVerifyFixtures[name]; transfer.items.add(new File([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))], f.name, { type: f.type })); }
        const input = document.querySelector('#file-input'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); }; undefined`);
    for (const width of [1440, 768, 390]) {
      win.setContentSize(width, 1000);
      await evaluate('scrollTo(0, 0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const dimensions = await evaluate('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
      assert.ok(dimensions.scrollWidth <= dimensions.width + 1, `${surface}: no overflow at ${width}px`);
      await capture(`${surface}-${width}-empty`);
    }
    await evaluate("window.liveVerifyUpload(['red', 'green', 'blue'])");
    await until(() => evaluate("document.querySelectorAll('#source-list li').length === 3"), surface + ': image upload');
    const names = "Array.from(document.querySelectorAll('#source-list .file-name')).map(element => element.textContent.replace(/^\\d+\\. /, ''))";
    const before = await evaluate(names);
    await click('#source-list button[data-index="1"][data-action="up"]');
    const after = await evaluate(names);
    assert.deepEqual(after, [before[1], before[0], before[2]], surface + ': image reorder');
    await capture(surface + '-390-selected');
    await click('#clear-files');
    await until(() => evaluate("document.querySelectorAll('#source-list li').length === 0"), surface + ': reset files');
    await evaluate("window.liveVerifyUpload(['audio'])");
    await until(() => evaluate("!document.querySelector('#create-live').disabled"), surface + ': inspected video');
    await click('#create-live');
    await until(() => evaluate("!document.querySelector('#cancel-live').hidden && document.querySelector('#live-progress').value >= 0.06"), surface + ': conversion active');
    await click('#cancel-live');
    await until(() => evaluate("!document.querySelector('#create-live').disabled && document.querySelector('#cancel-live').hidden"), surface + ': cancellation finishes');
    assert.equal(await evaluate("document.querySelector('#result-panel').hidden"), true, surface + ': cancelled conversion has no result');
    await click('#create-live');
    await until(() => evaluate("!document.querySelector('#result-panel').hidden && !document.querySelector('#create-live').disabled"), surface + ': real output', 30_000);
    await evaluate("document.querySelector('#result-panel').scrollIntoView({ block: 'center', behavior: 'instant' })");
    await capture(surface + '-390-complete');
    const exported = path.join(temporary, surface + '-ui.zip');
    let downloaded;
    win.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(exported);
      downloaded = new Promise((resolve, reject) => item.once('done', (_done, status) => {
        if (status === 'completed') resolve(); else reject(new Error(surface + ': ZIP download ' + status));
      }));
    });
    await click('#download-live');
    await until(() => Boolean(downloaded), surface + ': ZIP download begins');
    await downloaded;
    const entries = run('unzip', ['-Z1', exported]).trim().split('\n');
    assert.equal(entries.length, 3, surface + ': export contains pair and instructions');
    const jpegName = entries.find(name => /\.JPG$/.test(name));
    const movName = entries.find(name => /\.MOV$/.test(name));
    assert.ok(jpegName && movName && jpegName.slice(0, -4) === movName.slice(0, -4), surface + ': same-name JPG/MOV pair');
    assert.ok(entries.some(name => /README.*\.txt$/.test(name)), surface + ': import instructions');
    const extracted = path.join(temporary, surface + '-ui-export');
    fs.mkdirSync(extracted);
    run('unzip', ['-q', exported, '-d', extracted]);
    const zipEvidence = { surface, exported, entries };
    if (native) zipEvidence.nativeRecognition = run(native, [path.join(extracted, jpegName), path.join(extracted, movName)]);
    evidence.checks.push({ name: surface + ': actual ZIP download and native recognition', ...zipEvidence });
    await click('#clear-files');
    assert.equal(await evaluate("document.querySelector('#result-panel').hidden"), true, surface + ': reset removes prior output');
    evidence.checks.push(surface + ': actual File upload/reorder/reset/cancel/retry/result, responsive 1440/768/390');
  }

  // The real desktop shell is loaded with an in-memory bridge. Every bridge
  // function is a disposable fixture; no main process, keychain or login runs.
  win.setContentSize(1440, 1000);
  await win.loadURL('xhs-app://local/index.html?liveFixture=1');
  await until(() => evaluate("document.body.dataset.desktopReady === 'true'"), 'desktop sidebar ready');
  await click('#live-photo-tab');
  await until(() => evaluate("document.querySelector('#desktop-live-photo-frame').contentDocument?.documentElement.dataset.liveReady === 'true'"), 'desktop embedded live page');
  const embedded = await evaluate(`(() => {
    const frame = document.querySelector('#desktop-live-photo-frame'); const doc = frame.contentDocument;
    return { url: frame.contentWindow.location.href, compact: doc.body.classList.contains('live-embedded'),
      selected: document.querySelector('#live-photo-tab').getAttribute('aria-selected'), bridgeAbsent: !frame.contentWindow.xhsDesktop,
      topOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      frameOverflow: doc.documentElement.scrollWidth > frame.contentWindow.innerWidth + 1 };
  })()`);
  assert.match(embedded.url, /^xhs-app:\/\/local\/live\.html\?source=desktop$/);
  assert.equal(embedded.compact, true, 'desktop iframe uses compact styles');
  assert.equal(embedded.selected, 'true', 'desktop live sidebar selected');
  assert.equal(embedded.bridgeAbsent, true, 'iframe has no privileged native bridge');
  assert.equal(embedded.topOverflow || embedded.frameOverflow, false, 'desktop shell and live iframe fit');
  const subtitle = await evaluate(`(() => { const small = document.querySelector('#live-photo-tab small');
    const label = small.getBoundingClientRect(); const button = small.closest('button').getBoundingClientRect();
    return { display: getComputedStyle(small).display, right: label.right, buttonRight: button.right, bottom: label.bottom, buttonBottom: button.bottom }; })()`);
  assert.equal(subtitle.display, 'block', 'desktop live sidebar subtitle has a separate line');
  assert.ok(subtitle.right <= subtitle.buttonRight && subtitle.bottom <= subtitle.buttonBottom, 'desktop live sidebar subtitle fits its button');
  for (const width of [1440, 768, 390]) {
    win.setContentSize(width, 1000);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const fits = await evaluate(`(() => { const frame = document.querySelector('#desktop-live-photo-frame');
      return { topWidth: innerWidth, topScrollWidth: document.documentElement.scrollWidth,
        frameWidth: frame.contentWindow.innerWidth, frameScrollWidth: frame.contentDocument.documentElement.scrollWidth }; })()`);
    assert.ok(fits.topScrollWidth <= fits.topWidth + 1 && fits.frameScrollWidth <= fits.frameWidth + 1, 'desktop shell and embedded page fit at ' + width);
    await capture('desktop-sidebar-live-' + width);
  }
  win.setContentSize(1440, 1000);
  await evaluate(`(() => { const frame = document.querySelector('#desktop-live-photo-frame'); const doc = frame.contentDocument;
    const f = ${JSON.stringify(fixtures.red)}; const transfer = new frame.contentWindow.DataTransfer();
    transfer.items.add(new frame.contentWindow.File([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))], f.name, { type: f.type }));
    const input = doc.querySelector('#file-input'); input.files = transfer.files; input.dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
  })()`);
  await until(() => evaluate("!document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('#create-live').disabled"), 'desktop iframe source ready');
  await evaluate("document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('#create-live').click()");
  await until(() => evaluate("!document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('#result-panel').hidden"), 'desktop iframe creates actual pair');
  const retained = await evaluate("document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('#download-live').href");
  await click('#single-note-tab');
  await click('#live-photo-tab');
  assert.equal(await evaluate("document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('#download-live').href"), retained,
    'desktop switching tabs preserves generated result');
  assert.equal(await evaluate("document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('#result-panel').hidden"), false,
    'desktop switching tabs keeps result visible');
  assert.deepEqual(await evaluate('window.liveVerifyDesktopCalls'), [], 'desktop fixture reports no uncaught renderer failures');
  await capture('desktop-sidebar-live-result-1440');
  await evaluate("document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('.back-link').click()");
  await until(() => evaluate("document.querySelector('#single-note-tab').getAttribute('aria-selected') === 'true'"), 'iframe return link returns to desktop single-note tab');
  assert.equal(new URL(win.webContents.getURL()).pathname, '/index.html', 'iframe return keeps desktop shell page');
  await click('#live-photo-tab');
  assert.equal(await evaluate("document.querySelector('#desktop-live-photo-frame').contentDocument.querySelector('#download-live').href"), retained,
    'iframe return link keeps generated files when returning to live tab');
  evidence.checks.push({ name: 'actual desktop sidebar/iframe with isolated mocked native bridge; selected tab, compact view, no privileged iframe bridge, generated result preserved across tabs', ...embedded });
  assert.deepEqual(errors, [], 'no renderer errors');
  evidence.finishedAt = new Date().toISOString();
  await finish(0);
}).catch(error => void finish(1, error));
