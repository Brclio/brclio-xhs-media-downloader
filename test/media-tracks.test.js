import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMp4Tracks, inspectVideoBlob } from '../lib/media-tracks.js';
import { mp4Box, mp4Fixture } from './fixtures/mp4.js';

test('MP4 inspection finds video and audio tracks without reading the media payload', async () => {
  const bytes = mp4Fixture({ payloadBytes: 2 * 1024 * 1024 });
  let readBytes = 0;
  const result = await inspectMp4Tracks(async (start, length) => { readBytes += length; return bytes.subarray(start, start + length); }, bytes.length);
  assert.equal(result.hasAudio, true);
  assert.equal(result.hasVideo, true);
  assert.deepEqual(result.tracks.map(t => t.codecs), [['avc1'], ['mp4a']]);
  assert.ok(readBytes < 1024);
});

test('ordinary video requires audio while a valid Live Photo video can be silent', async () => {
  const silent = new Blob([mp4Fixture({ audio: false })]);
  await assert.rejects(inspectVideoBlob(silent), { code: 'VIDEO_AUDIO_MISSING' });
  assert.equal((await inspectVideoBlob(silent, { requireAudio: false })).hasAudio, false);
  assert.equal((await inspectVideoBlob(new Blob([mp4Fixture()]))).hasAudio, true);
});

test('truncated, audio-only and oversized MP4 indexes cannot be reported as valid videos', async () => {
  for (const bytes of [
    mp4Fixture().subarray(0, 30),
    mp4Fixture({ video: false }),
    mp4Fixture({ payloadBytes: 0 }),
    mp4Box('ftyp', Buffer.from('isom')),
    Buffer.from([0, 0, 0, 1, 109, 111, 111, 118, 255, 255, 255, 255, 0, 0, 0, 0])
  ]) await assert.rejects(inspectVideoBlob(new Blob([bytes])), { code: 'VIDEO_INVALID' });
});
