import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { paymentQrSvg } from '../lib/payment-qr.js';

// Read the actual SVG module paths into pixels; an independent decoder must
// recover the exact Native payload. This catches unreadable or truncated codes.
function pixels(svg, scale = 5) {
  const [, size] = svg.match(/viewBox="0 0 (\d+) \d+"/);
  const width = Number(size) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  const modules = [...svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)];
  assert.ok(modules.length > 0);
  for (const [, x, y] of modules) {
    assert.ok(Number(x) >= 4 && Number(y) >= 4 && Number(x) < Number(size) - 4 && Number(y) < Number(size) - 4);
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = ((Number(y) * scale + dy) * width + Number(x) * scale + dx) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
  }
  return { rgba, width };
}

test('locally rendered payment SVG decodes exactly with a separate QR reader', () => {
  for (const token of ['isolated_fixture_12345678', 'aB09_-'.repeat(18), 'Long_0123456789'.repeat(64)]) {
    const codeUrl = `weixin://wxpay/bizpayurl?pr=${token}`;
    const svg = paymentQrSvg(codeUrl), { rgba, width } = pixels(svg);
    assert.equal(jsQR(rgba, width, width, { inversionAttempts: 'dontInvert' })?.data, codeUrl);
    assert.doesNotMatch(svg, /weixin:|bizpayurl|href=|src=|<script|foreignObject|data:/i);
    assert.equal(svg.includes(token), false, 'scan payload is not written as SVG metadata');
  }
});

test('QR rendering rejects unusable inputs with a fixed error that does not echo payload', () => {
  for (const value of [undefined, null, '', {}, 'private-fixture-'.repeat(200)]) {
    assert.throws(() => paymentQrSvg(value), { message: '暂时无法显示付款二维码，请刷新原订单。' });
  }
});
