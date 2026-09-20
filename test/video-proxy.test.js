import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/video.js';

test('video chunks reject wrong ranges and short bodies instead of silently corrupting merged audio', async () => {
  const original = globalThis.fetch;
  const previousError = console.error;
  console.error = () => {};
  try {
    for (const [range, bytes, expected] of [
      ['bytes 3-5/10', 'abc', 200], ['bytes 0-2/10', 'abc', 502],
      [null, 'abc', 502], ['bytes 3-5/10', 'ab', 502], ['bytes 3-5/*', 'abc', 502]
    ]) {
      globalThis.fetch = async () => {
        const response = new Response(bytes, { status: 206, headers: range ? { 'content-range': range } : {} });
        Object.defineProperty(response, 'url', { value: 'https://sns-video-bd.xhscdn.com/fixture.mp4' });
        return response;
      };
      const result = { setHeader() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; }, send(value) { this.body = value; } };
      await handler({ method: 'GET', query: { action: 'chunk', url: 'https://sns-video-bd.xhscdn.com/fixture.mp4', start: '3', end: '5' } }, result);
      assert.equal(result.statusCode, expected);
      if (expected === 200) assert.equal(result.body.toString(), 'abc');
      else assert.equal(result.body.success, false);
    }
  } finally { globalThis.fetch = original; console.error = previousError; }
});
