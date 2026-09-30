import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function learningPage({ page = 'learn', bridge = true, failBridge = false } = {}) {
  const [html, source] = await Promise.all([
    readFile(new URL(`../${page}.html`, import.meta.url), 'utf8'),
    readFile(new URL(`../${page}.js`, import.meta.url), 'utf8'),
  ]);
  const element = () => ({
    listeners: new Map(), textContent: '', opened: false,
    addEventListener(type, callback) { this.listeners.set(type, callback); },
    click() { return this.listeners.get('click')?.({ preventDefault() {} }); },
    showModal() { this.opened = true; },
    close() { this.opened = false; },
    focus() {},
  });
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, element()]));
  const mobileNote = element();
  const events = new Map();
  const requests = [];
  const window = { addEventListener: (type, callback) => events.set(type, callback) };
  if (bridge) window.BrclioLearning = { postMessage(message) {
    requests.push(message);
    if (failBridge) throw new Error('Bridge unavailable');
  } };
  vm.runInNewContext(source, {
    window, location: { origin: 'https://appassets.androidplatform.net' },
    document: {
      getElementById(id) { assert.ok(elements.has(id)); return elements.get(id); },
      querySelector(selector) { assert.equal(selector, '.qr-mobile-note'); return mobileNote; },
    },
    fetch() { throw new Error('Android QR saves must not fetch or download a remote resource'); },
  });
  return {
    requests,
    save: () => elements.get('qr-save').click(),
    status: () => elements.get('qr-status').textContent,
    result: detail => events.get('brclio-qr-save-result')({ detail }),
    dialog: elements.get('qr-dialog'),
    saveLink: elements.get('qr-save'),
    mobileNote,
  };
}

for (const document of ['learn', 'vip']) {
test(`Android ${document} QR saving waits for native completion, prevents duplicate pickers, and retries after cancellation`, async () => {
  const page = await learningPage({ page: document });
  await page.save();
  await page.save();
  assert.deepEqual(page.requests, ['saveQr']);
  assert.match(page.status(), /选择.*保存位置/);
  page.result({ ok: false, message: '已取消保存二维码。' });
  assert.equal(page.status(), '已取消保存二维码。');
  await page.save();
  assert.deepEqual(page.requests, ['saveQr', 'saveQr']);
  page.result({ ok: true, message: '二维码已保存到所选位置。' });
  assert.equal(page.status(), '二维码已保存到所选位置。');
});

test(`Android ${document} without the native save bridge gives a working enlargement and screenshot path`, async () => {
  const page = await learningPage({ page: document, bridge: false });
  assert.equal(page.saveLink.textContent, '放大二维码并截图');
  assert.match(page.mobileNote.textContent, /截图/);
  await page.save();
  assert.equal(page.dialog.opened, true);
  assert.match(page.status(), /请截图保存/);
});

test(`Android ${document} native bridge failure shows a fallback and does not leave saving locked`, async () => {
  const page = await learningPage({ page: document, failBridge: true });
  await page.save();
  assert.match(page.status(), /放大后截图/);
  await page.save();
  assert.equal(page.requests.length, 2);
});
}
