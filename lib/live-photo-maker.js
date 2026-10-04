import { muxLivePhotoMov, pairLivePhotoJpeg } from './live-photo-format.js';

export const LIVE_PHOTO_LIMITS = Object.freeze({ minDuration: 0.5, maxDuration: 3, maxFiles: 12,
  maxBytes: 150 * 1024 * 1024, maxDecodedPixels: 64_000_000, maxDimension: 1440, fps: 30 });
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif|bmp)$/i;
const VIDEO_EXT = /\.(?:mp4|mov|m4v|webm)$/i;
const AUDIO_CONFIG = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 };

function abort(signal) { signal?.throwIfAborted(); }
function abortedError() { return new DOMException('制作已取消。', 'AbortError'); }
export function validateLivePhotoFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('请选择图片或视频。');
  if (files.length > LIVE_PHOTO_LIMITS.maxFiles) throw new Error('一次最多选择 12 张图片。');
  let bytes = 0;
  const kinds = files.map(file => {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0)
      throw new Error('素材为空或不可读取，请重新选择。');
    bytes += file.size;
    if (IMAGE_EXT.test(file.name) || /^image\//.test(file.type)) return 'images';
    if (VIDEO_EXT.test(file.name) || /^video\//.test(file.type)) return 'video';
    throw new Error('请选择浏览器可读取的图片或 MP4、MOV、WebM 视频。');
  });
  if (bytes > LIVE_PHOTO_LIMITS.maxBytes) throw new Error('素材总大小不能超过 150 MB，请先缩小文件。');
  if (kinds.some(kind => kind !== kinds[0]) || (kinds[0] === 'video' && files.length !== 1))
    throw new Error('请选择一个视频，或一组图片；图片和视频不能混合制作。');
  return kinds[0];
}

function eventPromise(target, success, { signal, timeout = 20000, message = '素材读取失败，请使用其他格式。' } = {}) {
  abort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer); target.removeEventListener(success, done);
      target.removeEventListener('error', fail); signal?.removeEventListener('abort', cancel);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error(message)); };
    const cancel = () => { cleanup(); reject(signal.reason || abortedError()); };
    target.addEventListener(success, done, { once: true }); target.addEventListener('error', fail, { once: true });
    signal?.addEventListener('abort', cancel, { once: true }); timer = setTimeout(fail, timeout);
  });
}

async function loadImage(file, signal) {
  const url = URL.createObjectURL(file), image = new Image();
  try {
    const loaded = eventPromise(image, 'load', { signal }); image.src = url; await loaded;
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片没有可读取的尺寸。');
    return image;
  } catch (error) { image.src = ''; throw error; }
  finally { URL.revokeObjectURL(url); }
}

async function loadVideo(file, signal) {
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  video.preload = 'auto'; video.playsInline = true; video.muted = true;
  const dispose = () => { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
  try {
    const loaded = eventPromise(video, 'loadeddata', { signal }); video.src = url; video.load(); await loaded;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight)
      throw new Error('无法读取视频时长或画面，请选择完整的视频文件。');
    return { video, dispose };
  } catch (error) { dispose(); throw error; }
}

function hasVideoAudio(video) {
  if (typeof video.mozHasAudio === 'boolean') return video.mozHasAudio;
  if (video.audioTracks) return video.audioTracks.length > 0;
  // Zero may mean the browser has not decoded audio yet; it does not prove the
  // source is silent. Never discard the user's audio on an undecoded counter.
  if (video.webkitAudioDecodedByteCount > 0) return true;
  return null;
}

export async function inspectLivePhotoFiles(files, { signal } = {}) {
  const kind = validateLivePhotoFiles(files); abort(signal);
  if (kind === 'video') {
    const source = await loadVideo(files[0], signal);
    try { return { kind, duration: source.video.duration, width: source.video.videoWidth,
      height: source.video.videoHeight, hasAudio: hasVideoAudio(source.video) }; }
    finally { source.dispose(); }
  }
  let first, pixels = 0;
  for (const file of files) {
    const image = await loadImage(file, signal);
    pixels += image.naturalWidth * image.naturalHeight;
    first ??= { width: image.naturalWidth, height: image.naturalHeight };
    image.src = '';
    if (pixels > LIVE_PHOTO_LIMITS.maxDecodedPixels) throw new Error('图片总像素超过 6400 万，请缩小图片或减少张数后制作。');
  }
  return { kind, duration: null, ...first, hasAudio: false };
}

function videoConfig(width, height) {
  return { codec: 'avc1.420033', width, height, bitrate: 6000000, framerate: LIVE_PHOTO_LIMITS.fps,
    latencyMode: 'realtime', avc: { format: 'avc' }, hardwareAcceleration: 'no-preference' };
}
function recorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || null;
}

export async function checkLivePhotoSupport() {
  let supported = false, audioSupported = false;
  try {
    supported = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
      && (await VideoEncoder.isConfigSupported(videoConfig(640, 480))).supported;
    audioSupported = typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'
      && typeof AudioContext !== 'undefined' && Boolean(recorderType())
      && (await AudioEncoder.isConfigSupported(AUDIO_CONFIG)).supported;
  } catch { /* Capability failures are displayed before starting work. */ }
  return { supported, audioSupported,
    message: supported ? (audioSupported ? '本地制作已就绪。' : '当前浏览器可制作无声实况；保留声音请使用桌面客户端或新版 Chrome。')
      : '当前浏览器不支持 H.264 本地编码。请使用新版 Chrome、Edge 或 Brclio 桌面客户端。' };
}

export function normalizeLivePhotoOptions({ kind, sourceDuration, start = 0, duration = 3, keyPhotoTime = duration / 2, motion = 'zoom' }) {
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 3) throw new Error('实况时长请选择 0.5 至 3 秒。');
  if (!Number.isFinite(start) || start < 0) throw new Error('片段起点不能小于 0 秒。');
  if (kind === 'video' && (!Number.isFinite(sourceDuration) || start + duration > sourceDuration + 0.001))
    throw new Error('所选片段超出视频时长，请调整起点或缩短片段。');
  if (!Number.isFinite(keyPhotoTime) || keyPhotoTime < 0 || keyPhotoTime >= duration)
    throw new Error('封面位置必须在所选片段内。');
  if (!['zoom', 'still'].includes(motion)) throw new Error('请选择有效的图片动效。');
  return { start, duration, keyPhotoTime, motion };
}

export function livePhotoDimensions(width, height) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('素材尺寸无效。');
  const scale = Math.min(1, LIVE_PHOTO_LIMITS.maxDimension / Math.max(width, height));
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}

async function seek(video, time, signal) {
  abort(signal);
  if (Math.abs(video.currentTime - time) < 0.0001 && video.readyState >= 2) return;
  const pending = eventPromise(video, 'seeked', { signal, message: '视频片段定位失败，请重试或更换格式。' });
  video.currentTime = time; await pending;
}

async function encodingBackpressure(encoder, limit, signal) {
  while (encoder.encodeQueueSize > limit) {
    abort(signal);
    await eventPromise(encoder, 'dequeue', { signal, message: '本地编码响应超时，请重试。' });
  }
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error('封面生成失败。')), 'image/jpeg', 0.94));
}

function drawImage(context, image, width, height, time, duration, motion) {
  context.fillStyle = '#fefcf6'; context.fillRect(0, 0, width, height);
  const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const scale = fit * (motion === 'zoom' ? 1 + 0.055 * time / duration : 1);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

// Record only the selected audio interval. Decoding this small recording avoids
// allocating PCM for an entire long input video. The audio never reaches speakers.
async function selectedAudio(video, start, duration, signal) {
  const context = new AudioContext({ sampleRate: 48000 });
  let recorder, source, destination;
  try {
    await seek(video, start, signal); abort(signal);
    source = context.createMediaElementSource(video); destination = context.createMediaStreamDestination();
    source.connect(destination); await context.resume(); abort(signal);
    if (context.state !== 'running') throw new Error('音频处理未启动，请重新点击制作或关闭保留声音。');
    recorder = new MediaRecorder(destination.stream, { mimeType: recorderType() });
    const chunks = [];
    const recorded = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.addEventListener('error', () => reject(new Error('音频截取失败，请重试或关闭保留声音。')), { once: true });
    });
    video.muted = false;
    const recordingOrigin = context.currentTime; recorder.start();
    await video.play(); abort(signal);
    const playbackOrigin = context.currentTime - Math.max(0, video.currentTime - start);
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); reject(signal.reason || abortedError()); };
      const started = performance.now();
      const tick = () => {
        if (video.currentTime >= start + duration || video.ended) { cleanup(); resolve(); }
        else if (performance.now() - started > duration * 1000 + 10000) { cleanup(); reject(new Error('视频声音截取超时，请重试。')); }
        else timer = setTimeout(tick, 10);
      };
      signal?.addEventListener('abort', cancel, { once: true }); tick();
    });
    video.pause(); recorder.stop(); await recorded; abort(signal);
    const buffer = await context.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()); abort(signal);
    const offset = Math.max(0, Math.round((playbackOrigin - recordingOrigin) * buffer.sampleRate));
    return { buffer, offset };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(`无法保留视频声音：${error.message} 可以关闭“保留声音”后制作。`);
  } finally {
    video.pause(); video.muted = true;
    if (recorder?.state === 'recording') recorder.stop();
    source?.disconnect(); destination?.stream.getTracks().forEach(track => track.stop());
    await context.close();
  }
}

async function encodeAudio({ buffer, offset }, duration, signal) {
  const samples = []; let decoderConfig, failed;
  const encoder = new AudioEncoder({ output(chunk, metadata) {
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, keyFrame: true });
    if (metadata?.decoderConfig?.description) decoderConfig = new Uint8Array(metadata.decoderConfig.description);
  }, error(error) { failed = error; } });
  try {
    encoder.configure(AUDIO_CONFIG);
    const count = Math.ceil(duration * buffer.sampleRate);
    for (let first = 0; first < count; first += 1024) {
      abort(signal); if (failed) throw failed;
      const frames = Math.min(1024, count - first), pcm = new Float32Array(frames * 2);
      for (let channel = 0; channel < 2; channel++) {
        const plane = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
        const slice = plane.subarray(offset + first, Math.min(offset + first + frames, plane.length));
        pcm.set(slice, channel * frames);
      }
      const data = new AudioData({ format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfChannels: 2,
        numberOfFrames: frames, timestamp: Math.round(first / buffer.sampleRate * 1e6), data: pcm });
      try { encoder.encode(data); } finally { data.close(); }
      await encodingBackpressure(encoder, 12, signal);
    }
    await encoder.flush(); abort(signal); if (failed) throw failed;
    if (!decoderConfig || !samples.length) throw new Error('音频编码没有产生有效数据。');
    const origin = samples[0].timestamp;
    samples.forEach(sample => { sample.timestamp -= origin; sample.duration ||= Math.round(1024 / buffer.sampleRate * 1e6); });
    return { samples, decoderConfig, sampleRate: buffer.sampleRate, channels: 2 };
  } finally { if (encoder.state !== 'closed') encoder.close(); }
}

export async function createLivePhoto({ files, start = 0, duration = 3, keyPhotoTime = duration / 2,
  motion = 'zoom', includeAudio = true, signal, onProgress = () => {} }) {
  const kind = validateLivePhotoFiles(files), support = await checkLivePhotoSupport(); abort(signal);
  if (!support.supported) throw new Error(support.message);
  let source, encoder;
  const images = [];
  try {
    onProgress({ progress: 0.02, message: '正在读取本地素材…' });
    if (kind === 'video') source = await loadVideo(files[0], signal);
    else {
      let pixels = 0;
      for (const file of files) {
        const image = await loadImage(file, signal); images.push(image);
        pixels += image.naturalWidth * image.naturalHeight;
        if (pixels > LIVE_PHOTO_LIMITS.maxDecodedPixels) throw new Error('图片总像素超过 6400 万，请缩小图片或减少张数后制作。');
      }
    }
    const options = normalizeLivePhotoOptions({ kind, sourceDuration: source?.video.duration, start, duration, keyPhotoTime, motion });
    const size = kind === 'video' ? livePhotoDimensions(source.video.videoWidth, source.video.videoHeight)
      : livePhotoDimensions(images[0].naturalWidth, images[0].naturalHeight);
    const config = videoConfig(size.width, size.height);
    if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('当前浏览器无法编码此画面尺寸，请换用桌面客户端。');
    abort(signal);
    let audio;
    if (kind === 'video' && includeAudio && hasVideoAudio(source.video) !== false) {
      if (!support.audioSupported) throw new Error('当前浏览器不支持保留声音，请关闭“保留声音”或使用桌面客户端。');
      onProgress({ progress: 0.06, message: '正在截取所选片段的声音…' });
      audio = await encodeAudio(await selectedAudio(source.video, options.start, options.duration, signal), options.duration, signal);
    }
    abort(signal);
    const canvas = document.createElement('canvas'); Object.assign(canvas, size);
    const context = canvas.getContext('2d', { alpha: false });
    const samples = []; let decoderConfig, failed;
    encoder = new VideoEncoder({ output(chunk, metadata) {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, keyFrame: chunk.type === 'key' });
      if (metadata?.decoderConfig?.description) decoderConfig = new Uint8Array(metadata.decoderConfig.description);
    }, error(error) { failed = error; } });
    encoder.configure(config);
    const frameCount = Math.ceil(options.duration * LIVE_PHOTO_LIMITS.fps);
    const draw = async time => {
      if (kind === 'video') {
        await seek(source.video, Math.min(options.start + time, source.video.duration - 0.001), signal);
        context.drawImage(source.video, 0, 0, size.width, size.height);
      } else {
        const index = Math.min(images.length - 1, Math.floor(time / options.duration * images.length));
        const interval = options.duration / images.length;
        drawImage(context, images[index], size.width, size.height, time % interval, interval, options.motion);
      }
    };
    for (let index = 0; index < frameCount; index++) {
      abort(signal); if (failed) throw failed;
      const timestamp = Math.round(index / LIVE_PHOTO_LIMITS.fps * 1e6);
      const end = Math.min(Math.round(options.duration * 1e6), Math.round((index + 1) / LIVE_PHOTO_LIMITS.fps * 1e6));
      await draw(index / LIVE_PHOTO_LIMITS.fps); abort(signal);
      const frame = new VideoFrame(canvas, { timestamp, duration: end - timestamp });
      try { encoder.encode(frame, { keyFrame: index === 0 || index % 30 === 0 }); } finally { frame.close(); }
      onProgress({ progress: 0.2 + 0.7 * (index + 1) / frameCount, message: `正在制作画面 ${index + 1} / ${frameCount}…` });
      await encodingBackpressure(encoder, 8, signal);
      if (index % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    await encoder.flush(); abort(signal); if (failed) throw failed;
    if (!decoderConfig || samples.length !== frameCount) throw new Error('视频编码不完整，请重试。');
    // Cover and metadata refer to the same encoded frame, including image cuts.
    const coverFrame = Math.min(frameCount - 1, Math.round(options.keyPhotoTime * LIVE_PHOTO_LIMITS.fps));
    const coverTime = coverFrame / LIVE_PHOTO_LIMITS.fps;
    await draw(coverTime); abort(signal);
    const identifier = crypto.randomUUID();
    const jpeg = pairLivePhotoJpeg(new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer()), identifier);
    abort(signal); onProgress({ progress: 0.96, message: '正在写入实况配对信息…' });
    const mov = muxLivePhotoMov({ samples, decoderConfig, ...size, duration: options.duration,
      keyPhotoTime: coverTime, assetIdentifier: identifier, audio });
    abort(signal); onProgress({ progress: 1, message: '实况已制作完成。' });
    return { jpeg, mov, previewBlob: new Blob([mov], { type: 'video/quicktime' }), ...size,
      duration: options.duration, keyPhotoTime: coverTime, assetIdentifier: identifier };
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close(); source?.dispose();
    images.forEach(image => { image.src = ''; });
  }
}
