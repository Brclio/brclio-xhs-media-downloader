import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_PHOTO_LIMITS, validateLivePhotoFiles, normalizeLivePhotoOptions, livePhotoDimensions,
  livePhotoCoverTime, checkLivePhotoSupport } from '../lib/live-photo-maker.js';

const file = (name, type, size = 10) => ({ name, type, size, arrayBuffer: async () => new ArrayBuffer(size) });

test('local maker accepts one video or an ordered image sequence and rejects ambiguous inputs', () => {
  assert.equal(validateLivePhotoFiles([file('clip.MOV', '')]), 'video');
  assert.equal(validateLivePhotoFiles([file('1.jpg', 'image/jpeg'), file('2.webp', 'image/webp')]), 'images');
  assert.throws(() => validateLivePhotoFiles([]), /请选择/);
  assert.throws(() => validateLivePhotoFiles([file('image.jpg', 'image/jpeg'), file('clip.mp4', 'video/mp4')]), /不能混合/);
  assert.throws(() => validateLivePhotoFiles([file('a.mp4', 'video/mp4'), file('b.mp4', 'video/mp4')]), /一个视频/);
  assert.throws(() => validateLivePhotoFiles([file('bad.pdf', 'application/pdf')]), /可读取/);
  assert.throws(() => validateLivePhotoFiles([file('empty.jpg', 'image/jpeg', 0)]), /为空/);
  assert.throws(() => validateLivePhotoFiles(Array.from({ length: 13 }, () => file('1.jpg', 'image/jpeg'))), /12/);
  assert.throws(() => validateLivePhotoFiles([file('huge.mp4', 'video/mp4', LIVE_PHOTO_LIMITS.maxBytes + 1)]), /150 MB/);
});

test('clip bounds and cover position are validated before encoding', () => {
  const options = { kind: 'video', sourceDuration: 5, start: 2, duration: 3, keyPhotoTime: 1.5 };
  assert.equal(normalizeLivePhotoOptions(options).start, 2);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, start: 2.01 }), /超出/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, start: -1 }), /起点/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, duration: 8.01 }), /0.5 至 8/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, duration: 0.49 }), /0.5 至 8/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, keyPhotoTime: 3 }), /封面/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, keyPhotoTime: -1 }), /封面/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, duration: NaN }), /时长/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, motion: 'other' }), /动效/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, sourceDuration: 0.3, start: 0 }), /超出/);
});

test('video speed selects a longer source interval while images keep their original timing', () => {
  for (const speed of [1, 1.5, 2, 3]) {
    const result = normalizeLivePhotoOptions({ kind: 'video', sourceDuration: 25, start: 1,
      duration: 8, keyPhotoTime: 7.999, speed });
    assert.equal(result.speed, speed);
    assert.equal(result.sourceSpan, 8 * speed);
    assert.equal(result.keyPhotoTime, 239 / 30);
  }
  const options = { kind: 'video', sourceDuration: 6, start: 0, duration: 3, speed: 2 };
  assert.equal(normalizeLivePhotoOptions(options).sourceSpan, 6);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, start: 0.01 }), /超出/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, speed: 3 }), /超出/);
  for (const speed of [0, 0.5, 1.25, 4, NaN, Infinity, '2'])
    assert.throws(() => normalizeLivePhotoOptions({ ...options, speed }), /倍速/);
  assert.equal(normalizeLivePhotoOptions({ kind: 'images', duration: 8 }).sourceSpan, 8);
  assert.throws(() => normalizeLivePhotoOptions({ kind: 'images', duration: 3, speed: 1.5 }), /图片制作不支持/);
});

test('cover time points at a real encoded frame including a fractional final frame', () => {
  assert.equal(livePhotoCoverTime(0.5, 0), 0);
  assert.equal(livePhotoCoverTime(0.5, 0.499999), 14 / 30);
  assert.equal(livePhotoCoverTime(0.5001, 0.500099), 0.5);
  assert.equal(livePhotoCoverTime(0.5000001, 0.50000009), 14 / 30);
  assert.equal(livePhotoCoverTime(2 / 3, 2 / 3 - 1e-10), 19 / 30);
  assert.equal(livePhotoCoverTime(1.5, 0.75), 23 / 30);
  assert.equal(livePhotoCoverTime(8, 7.999999), 239 / 30);
  assert.equal(normalizeLivePhotoOptions({ kind: 'images', duration: 0.5001,
    keyPhotoTime: 0.500099 }).keyPhotoTime, 0.5);
  assert.equal(normalizeLivePhotoOptions({ kind: 'images', duration: 0.5000001 }).duration, 0.5);
  for (const key of [-1, 0.5, Infinity, NaN])
    assert.throws(() => livePhotoCoverTime(0.5, key), /封面/);
  for (const duration of [0.49, 8.001, NaN])
    assert.throws(() => livePhotoCoverTime(duration, 0), /时长/);
});

test('a failed video or audio support probe does not suppress the other capability', async t => {
  const names = ['VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'AudioContext', 'MediaRecorder'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  for (const name of ['VideoFrame', 'AudioData', 'AudioContext']) set(name, class {});
  set('MediaRecorder', { isTypeSupported: () => true });
  set('VideoEncoder', { isConfigSupported: async () => { throw new Error('Video encoder unavailable'); } });
  set('AudioEncoder', { isConfigSupported: async () => ({ supported: true }) });
  let support = await checkLivePhotoSupport();
  assert.equal(support.supported, false);
  assert.equal(support.audioSupported, true);
  set('VideoEncoder', { isConfigSupported: async () => ({ supported: true }) });
  set('AudioEncoder', { isConfigSupported: async () => { throw new Error('Audio encoder unavailable'); } });
  support = await checkLivePhotoSupport();
  assert.equal(support.supported, true);
  assert.equal(support.audioSupported, false);
});

test('trusted desktop videos have no browser byte cap while web and image protections remain', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; });
  const large = file('large.mp4', 'video/mp4', 5 * 1024 ** 3);
  large.arrayBuffer = () => { throw new Error('Full source must not be read into memory'); };
  for (const origin of ['https://example.test/live.html?source=desktop', 'xhs-app://other/live.html']) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(origin) });
    assert.throws(() => validateLivePhotoFiles([large]), /150 MB/);
  }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('xhs-app://local/live.html?source=desktop') });
  assert.equal(validateLivePhotoFiles([large]), 'video');
  assert.throws(() => validateLivePhotoFiles([file('huge.jpg', 'image/jpeg', LIVE_PHOTO_LIMITS.maxBytes + 1)]), /150 MB/);
  assert.throws(() => validateLivePhotoFiles([large, file('another.mp4', 'video/mp4')]), /一个视频/);
});

test('encoding keeps portrait and landscape orientation, bounds dimensions and produces even pixel sizes', () => {
  assert.deepEqual(livePhotoDimensions(3840, 2160), { width: 1440, height: 810 });
  assert.deepEqual(livePhotoDimensions(1080, 1920), { width: 810, height: 1440 });
  assert.deepEqual(livePhotoDimensions(641, 479), { width: 640, height: 478 });
  assert.deepEqual(livePhotoDimensions(10, 10), { width: 10, height: 10 });
  assert.throws(() => livePhotoDimensions(0, 1080), /尺寸/);
  assert.throws(() => livePhotoDimensions(100, Infinity), /尺寸/);
});
