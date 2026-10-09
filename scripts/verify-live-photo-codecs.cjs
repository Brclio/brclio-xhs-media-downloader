// Native codec gate for macOS and Windows CI; no ffmpeg, Swift, or extra packages.
// Run: electron scripts/verify-live-photo-codecs.cjs
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true
} }]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-live-codecs-'));
app.setPath('userData', path.join(temporary, 'profile'));
let window, server, finished = false;
const timeout = setTimeout(() => finish(new Error('Live Photo codec verification timed out.')), 120000);
function finish(error, result) {
  if (finished) return;
  finished = true; clearTimeout(timeout); window?.destroy();
  server?.closeAllConnections(); server?.close();
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* Windows may release profile handles on exit. */ }
  if (error) console.error(error.stack || error);
  else console.log(JSON.stringify({ result: 'PASS', platform: process.platform, ...result }));
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  const allowed = new Set(['/lib/live-photo-maker.js', '/lib/live-photo-format.js',
    '/lib/live-photo-heic.js', '/lib/live-photo-heic-encoder.js', '/lib/live-photo-heic-worker.js',
    '/assets/vendor/heic/heic-encoder.js', '/assets/vendor/heic/heic-encoder.wasm']);
  server = http.createServer((request, response) => {
    if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Native Live Photo codecs</title>'); return; }
    if (!allowed.has(request.url)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': request.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(path.join(root, request.url.slice(1))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false } });
  const rendererErrors = [];
  window.webContents.on('console-message', details => { if (details.level === 'error') rendererErrors.push(details.message); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: ![origin + '/', 'blob:'].some(prefix => details.url.startsWith(prefix))
  }));
  await window.loadURL(origin + '/');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const maker = await import('/lib/live-photo-maker.js'), format = await import('/lib/live-photo-format.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const support = await maker.checkLivePhotoSupport();
    check(support.supported && support.audioSupported, 'Native H264 and AAC encoding must both be available: ' + JSON.stringify(support));
    check(support.heicSupported, 'Local HEIC worker encoding must be available.');
    const urls = new Set(), encoders = new Set(), contexts = new Set(), workers = new Set();
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); workers.add(this); }
      terminate() { workers.delete(this); return super.terminate(); }
    };
    const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = createURL(value); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revokeURL(url); };
    for (const name of ['VideoEncoder', 'AudioEncoder']) {
      const Native = window[name];
      window[name] = class extends Native { constructor(options) { super(options); encoders.add(this); } };
    }
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options) { super(options); contexts.add(this); } };
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96;
    const context = canvas.getContext('2d');
    const image = async color => { context.fillStyle = color; context.fillRect(0, 0, 160, 96);
      return new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], color + '.png', { type: 'image/png' }); };
    const red = await image('red'), blue = await image('blue');
    const play = async result => {
      const video = document.createElement('video'), url = URL.createObjectURL(result.previewBlob);
      video.muted = true; video.playsInline = true;
      try {
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Generated MOV cannot play.')); video.src = url; video.load(); });
        check(Math.abs(video.duration - result.duration) < 0.03, 'MOV duration must match the selected clip.');
        await video.play();
        const deadline = Date.now() + 5000;
        while (video.currentTime === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 35));
        check(video.currentTime > 0 && video.videoWidth === 160 && video.videoHeight === 96, 'Native video decoder must produce frames.');
      } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
    };
    const options = { duration: 1, keyPhotoTime: 0.5, includeAudio: false };
    await play(await maker.createLivePhoto({ files: [red], ...options }));
    await play(await maker.createLivePhoto({ files: [red, blue], ...options, motion: 'still' }));
    const heicPair = async result => {
      check(result.photoFormat === 'heic' && result.photoExtension === 'HEIC' && result.photoMimeType === 'image/heic', 'HEIC output must declare its actual format.');
      check(result.heic === result.photo && !result.jpeg, 'HEIC must not silently return JPEG.');
      const data = result.photo, view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      check(String.fromCharCode(...data.subarray(4, 8)) === 'ftyp', 'HEIC must be an ISO image container.');
      const brands = String.fromCharCode(...data.subarray(8, view.getUint32(0)));
      check(/heic|heix|hevc|hevx/.test(brands), 'HEIC must declare HEVC image compatibility.');
      // The formatter validates HEVC image items, property associations and
      // extents again while replacing Exif, so a renamed JPEG cannot pass.
      const pair = await import('/lib/live-photo-heic.js');
      pair.pairLivePhotoHeic(data, result.assetIdentifier);
      check(new TextDecoder().decode(data).includes(result.assetIdentifier), 'HEIC Exif must carry the pairing UUID.');
      check(new TextDecoder().decode(result.mov).includes(result.assetIdentifier), 'MOV must carry the same pairing UUID.');
      await play(result);
    };
    await heicPair(await maker.createLivePhoto({ files: [red, blue], ...options, photoFormat: 'heic' }));
    // Generate a real native H264 + sine-wave AAC input instead of relying on a
    // platform fixture decoder or a prebuilt stream of unknown provenance.
    const videoSamples = [], audioSamples = []; let videoConfig, audioConfig, failure;
    const output = samples => (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, keyFrame: chunk.type === 'key' });
      if (metadata?.decoderConfig?.description) {
        if (samples === videoSamples) videoConfig = new Uint8Array(metadata.decoderConfig.description);
        else audioConfig = new Uint8Array(metadata.decoderConfig.description);
      }
    };
    const videoEncoder = new VideoEncoder({ output: output(videoSamples), error: error => { failure = error; } });
    const audioEncoder = new AudioEncoder({ output: output(audioSamples), error: error => { failure = error; } });
    try {
      videoEncoder.configure({ codec: 'avc1.420033', width: 160, height: 96, framerate: 30, bitrate: 1000000, latencyMode: 'realtime', avc: { format: 'avc' } });
      audioEncoder.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      for (let index = 0; index < 60; index++) {
        context.fillStyle = index < 30 ? 'red' : 'blue'; context.fillRect(0, 0, 160, 96);
        const timestamp = Math.round(index / 30 * 1e6), frame = new VideoFrame(canvas, { timestamp, duration: Math.round((index + 1) / 30 * 1e6) - timestamp });
        try { videoEncoder.encode(frame, { keyFrame: index % 30 === 0 }); } finally { frame.close(); }
        if (videoEncoder.encodeQueueSize > 8) await new Promise(resolve => videoEncoder.addEventListener('dequeue', resolve, { once: true }));
      }
      for (let first = 0; first < 96000; first += 1024) {
        const count = Math.min(1024, 96000 - first), pcm = new Float32Array(count * 2);
        for (let index = 0; index < count; index++) pcm[index] = pcm[count + index] = 0.3 * Math.sin(2 * Math.PI * 440 * (first + index) / 48000);
        const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfChannels: 2, numberOfFrames: count, timestamp: Math.round(first / 48000 * 1e6), data: pcm });
        try { audioEncoder.encode(data); } finally { data.close(); }
        if (audioEncoder.encodeQueueSize > 12) await new Promise(resolve => audioEncoder.addEventListener('dequeue', resolve, { once: true }));
      }
      await Promise.all([videoEncoder.flush(), audioEncoder.flush()]); if (failure) throw failure;
    } finally { if (videoEncoder.state !== 'closed') videoEncoder.close(); if (audioEncoder.state !== 'closed') audioEncoder.close(); }
    const audioOrigin = audioSamples[0].timestamp; audioSamples.forEach(sample => { sample.timestamp -= audioOrigin; });
    const mov = format.muxLivePhotoMov({ width: 160, height: 96, duration: 2, keyPhotoTime: 1,
      assetIdentifier: crypto.randomUUID(), samples: videoSamples, decoderConfig: videoConfig,
      audio: { samples: audioSamples, decoderConfig: audioConfig, sampleRate: 48000, channels: 2 } });
    window.largeVideoFixture = Array.from(mov);
    const source = new File([mov], 'native-audio.mov', { type: 'video/quicktime' });
    const metadata = await maker.inspectLivePhotoFiles([source]);
    check(metadata.kind === 'video' && Math.abs(metadata.duration - 2) < 0.03, 'Native input must load.');
    const result = await maker.createLivePhoto({ files: [source], start: 0.25, duration: 1, keyPhotoTime: 0.5, includeAudio: true, photoFormat: 'heic' });
    await heicPair(result);
    // Read the produced AAC samples and use the native AAC decoder to prove the
    // selected-audio path retained sound, rather than merely adding an empty track.
    const data = result.mov, view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const atoms = (start, end) => { const items = []; for (let at = start; at < end;) {
      const size = view.getUint32(at); check(size >= 8 && at + size <= end, 'Invalid output atom');
      items.push({ type: String.fromCharCode(...data.subarray(at + 4, at + 8)), start: at + 8, end: at + size }); at += size;
    } return items; };
    const child = (box, type) => atoms(box.start, box.end).find(item => item.type === type);
    const moov = atoms(0, data.length).find(item => item.type === 'moov');
    const track = atoms(moov.start, moov.end).filter(item => item.type === 'trak').find(item => {
      const handler = child(child(item, 'mdia'), 'hdlr'); return String.fromCharCode(...data.subarray(handler.start + 8, handler.start + 12)) === 'soun';
    });
    check(track, 'Produced video must retain AAC');
    const table = child(child(child(track, 'mdia'), 'minf'), 'stbl'), sizes = child(table, 'stsz'), offsets = child(table, 'stco');
    let at = view.getUint32(offsets.start + 8), square = 0, frames = 0, decoderFailure;
    const decoder = new AudioDecoder({ output: pcm => { try {
      const plane = new Float32Array(pcm.numberOfFrames); pcm.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
      for (const sample of plane) square += sample * sample; frames += plane.length;
    } finally { pcm.close(); } }, error: error => { decoderFailure = error; } });
    try {
      decoder.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: audioConfig });
      const count = view.getUint32(sizes.start + 8);
      for (let index = 0; index < count; index++) { const size = view.getUint32(sizes.start + 12 + index * 4);
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(index * 1024 / 48000 * 1e6), data: data.subarray(at, at + size) })); at += size; }
      await decoder.flush(); if (decoderFailure) throw decoderFailure;
    } finally { if (decoder.state !== 'closed') decoder.close(); }
    const rms = Math.sqrt(square / frames); check(frames >= 48000 && rms > 0.05, 'Recorded output must contain audible PCM.');
    const cancel = async (files, withAudio) => {
      const controller = new AbortController(); let timer;
      try { await maker.createLivePhoto({ files, duration: 1, keyPhotoTime: 0.5, includeAudio: withAudio,
        signal: controller.signal, onProgress: progress => { if (!timer && progress.progress >= (withAudio ? 0.06 : 0.2)) timer = setTimeout(() => controller.abort(), withAudio ? 150 : 0); } });
        throw new Error('Cancellation unexpectedly completed.');
      } catch (error) { check(error.name === 'AbortError', 'Cancellation must reject with AbortError: ' + error.message); }
      finally { clearTimeout(timer); }
    };
    await cancel([red], false); await cancel([source], true);
    const heicCancel = new AbortController(); let heicAborted = false;
    try {
      await maker.createLivePhoto({ files: [red], ...options, photoFormat: 'heic', signal: heicCancel.signal,
        onProgress: state => { if (state.progress >= 0.92 && !heicAborted) { heicAborted = true; setTimeout(() => heicCancel.abort(), 0); } } });
      throw new Error('HEIC cancellation unexpectedly completed.');
    } catch (error) { check(error.name === 'AbortError' && heicAborted, 'HEIC stage must cancel with AbortError.'); }
    check(urls.size === 0, 'Every object URL must be released after success and cancellation.');
    check([...encoders].every(encoder => encoder.state === 'closed'), 'Every native encoder must close.');
    check([...contexts].every(context => context.state === 'closed'), 'Every audio context must close.');
    check(workers.size === 0, 'Every HEIC worker must terminate after success and cancellation.');
    return { support, checks: ['JPEG image playback', 'JPEG slideshow playback', 'HEIC slideshow pair', 'native H264/AAC fixture', 'HEIC trimmed audio-video pair and playback', 'decoded audible PCM', 'image/audio/HEIC cancellation cleanup'], audioRms: rms };
  })()`, true);
  assert.deepEqual(rendererErrors, [], 'Renderer must have no console errors');
  // A real disk-backed File with a trailing sparse ISO free box proves that
  // desktop inspection and clip encoding do not read the whole source into RAM.
  const source = Buffer.from(await window.webContents.executeJavaScript('window.largeVideoFixture'));
  const filename = path.join(temporary, 'large-native-video.mov');
  const sourceBytes = 2 * 1024 ** 3 + 1;
  const free = Buffer.alloc(8);
  free.writeUInt32BE(sourceBytes - source.length); free.write('free', 4, 4, 'ascii');
  fs.writeFileSync(filename, Buffer.concat([source, free])); fs.truncateSync(filename, sourceBytes);
  const { createProtocolHandler } = await import(require('node:url').pathToFileURL(path.join(root, 'desktop/protocol.js')).href);
  protocol.handle('xhs-app', createProtocolHandler({ rootDirectory: root }));
  window.webContents.session.webRequest.onBeforeRequest(null);
  await window.loadURL('xhs-app://local/live.html?source=desktop');
  await window.webContents.executeJavaScript(`document.addEventListener('change', event => {
    if (event.target.id === 'file-input') window.largeDiskFile = event.target.files[0];
  }, { capture: true, once: true });`);
  window.webContents.debugger.attach('1.3');
  try {
    const { root: documentNode } = await window.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '#file-input' });
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filename] });
  } finally { window.webContents.debugger.detach(); }
  const largeVideo = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 25000;
    while (document.documentElement.dataset.liveState !== 'ready' && Date.now() < deadline) {
      if (!document.getElementById('live-error').hidden) throw new Error(document.getElementById('live-error').textContent);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (document.documentElement.dataset.liveState !== 'ready') throw new Error('Large disk File was not inspected.');
    const file = window.largeDiskFile;
    if (file.size !== ${sourceBytes}) throw new Error('Large native File size changed.');
    file.arrayBuffer = () => { throw new Error('Whole input must never become an ArrayBuffer.'); };
    const maker = await import('/lib/live-photo-maker.js');
    const metadata = await maker.inspectLivePhotoFiles([file]);
    const result = await maker.createLivePhoto({ files: [file], start: 0.25, duration: 1, keyPhotoTime: 0.5,
      includeAudio: true, photoFormat: 'heic' });
    const { inspectVideoBlob } = await import('/lib/media-tracks.js');
    const tracks = await inspectVideoBlob(new Blob([result.mov]), { requireAudio: true });
    if (!tracks.hasAudio || !tracks.hasVideo || result.photoFormat !== 'heic'
      || !new TextDecoder().decode(result.photo).includes(result.assetIdentifier)
      || !new TextDecoder().decode(result.mov).includes(result.assetIdentifier)) throw new Error('Large input output or pairing failed.');
    return { sourceBytes: file.size, sourceDuration: metadata.duration, outputBytes: result.mov.byteLength,
      photoBytes: result.photo.byteLength, hasAudio: tracks.hasAudio, hasVideo: tracks.hasVideo, format: result.photoFormat };
  })()`, true);
  result.checks.push('desktop real disk File >2GiB inspection and HEIC/audio clip encoding');
  result.largeVideo = largeVideo;
  assert.deepEqual(rendererErrors, [], 'Large desktop video conversion must have no console errors');
  finish(null, result);
}).catch(error => finish(error));
