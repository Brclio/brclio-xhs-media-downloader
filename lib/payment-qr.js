import { qrcodegen } from './vendor/qrcodegen.js';

// Keep the scan payload in memory. The SVG contains only a local module matrix,
// never a URL, external image, title, or data attribute with payment information.
export function paymentQrSvg(value) {
  try {
    if (typeof value !== 'string' || !value || value.length > 2048) throw new Error();
    const qr = qrcodegen.QrCode.encodeText(value, qrcodegen.QrCode.Ecc.MEDIUM);
    const border = 4, size = qr.size + border * 2, paths = [];
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) paths.push(`M${x + border},${y + border}h1v1h-1z`);
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="微信付款二维码" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${paths.join('')}" fill="#000"/></svg>`;
  } catch {
    throw new Error('暂时无法显示付款二维码，请刷新原订单。');
  }
}

export function renderPaymentQr(container, value) {
  container.innerHTML = paymentQrSvg(value);
}
