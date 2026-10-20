import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { paymentReturnContext, initializePaymentReturn } from '../payment-return.js';

const ORDER = '12345678-1234-1234-1234-123456789abc';
const ORIGIN = 'https://xhs.download.brclio.com';
const href = `${ORIGIN}/payment-return?payment_order=${ORDER}&client=desktop`;

function page(url = href, framed = false) {
  const elements = new Map();
  for (const id of ['return-open-client', 'return-view-web', 'return-title', 'return-description', 'return-status']) elements.set(id, { textContent: '', hidden: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } });
  const win = { location: { href: url } }; win.self = win; win.top = framed ? {} : win;
  const timers = [], navigations = [];
  initializePaymentReturn({ windowImpl: win, documentImpl: { getElementById: id => elements.get(id) }, navigate: url => navigations.push(url), setTimer: (fn, delay) => timers.push({ fn, delay }) });
  return { elements, timers, navigations };
}

test('payment return builds only an order-reference scheme and explicit website fallback, never propagating query credentials', () => {
  const result = paymentReturnContext(`${href}&token=never-forward-this&paid=true#session=never-forward-this`);
  assert.deepEqual(result, { orderId: ORDER, desktopUrl: `brclio-xhs://payment-return?order_id=${ORDER}`, webUrl: `${ORIGIN}/?payment_order=${ORDER}&account=open`, autoOpen: true });
  assert.ok(!JSON.stringify(result).includes('never-forward-this'));
  for (const url of [ORIGIN, `${ORIGIN}/payment-return?payment_order=bad`, `${href}&payment_order=${ORDER}`, `${ORIGIN}/payment-return?payment_order=__proto__`]) assert.equal(paymentReturnContext(url), null);
});

test('only a trusted HTTPS desktop hint can trigger one automatic app attempt', () => {
  const p = page();
  assert.equal(p.elements.get('return-open-client').hidden, false);
  assert.equal(p.elements.get('return-view-web').href, `${ORIGIN}/?payment_order=${ORDER}&account=open`);
  assert.equal(p.timers.length, 1); p.timers[0].fn();
  assert.deepEqual(p.navigations, [`brclio-xhs://payment-return?order_id=${ORDER}`]);
  for (const url of [href.replace('https:', 'http:'), href.replace('xhs.download.brclio.com', 'attacker.example'), href.replace('&client=desktop', ''), `${href}&client=desktop`, href.replace('/payment-return?', '/other-page?'), href.replace('https://', 'https://user:password@')]) {
    assert.equal(page(url).timers.length, 0, url);
  }
  assert.equal(page(href, true).timers.length, 0, 'embedded pages cannot wake the desktop app automatically');
});

test('invalid returns offer ordinary account navigation and never a deep link or payment assertion', () => {
  const p = page(`${ORIGIN}/payment-return?payment_order=not-a-real-order&client=desktop`);
  assert.equal(p.timers.length, 0); assert.equal(p.elements.get('return-open-client').hidden, true);
  assert.equal(p.elements.get('return-view-web').href, `${ORIGIN}/?account=open`);
  for (const element of p.elements.values()) assert.doesNotMatch(element.textContent, /付款成功|已支付|已开通/);
});

test('return HTML blocks account connections and third-party resources before its module loads', async () => {
  const source = await readFile(new URL('../payment-return.html', import.meta.url), 'utf8');
  assert.match(source, /name="referrer" content="no-referrer"/);
  assert.match(source, /connect-src 'none'/);
  assert.match(source, /script-src 'self'/);
  assert.ok(source.indexOf('name="referrer"') < source.indexOf('href="./payment-return.css"'));
  assert.doesNotMatch(source, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(source, /account-ui\.js|browser-account\.js|付款成功|已支付|已开通/);
});

test('Vercel applies private navigation headers to both return page URL forms', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const source of ['/payment-return', '/payment-return.html']) {
    const values = new Map(config.headers.find(route => route.source === source)?.headers.map(header => [header.key, header.value]));
    assert.equal(values.get('Cache-Control'), 'no-store'); assert.equal(values.get('Referrer-Policy'), 'no-referrer');
    assert.equal(values.get('X-Frame-Options'), 'DENY'); assert.equal(values.get('X-Content-Type-Options'), 'nosniff');
  }
});
