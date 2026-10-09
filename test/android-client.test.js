import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as mediaHelpers from '../android/app/src/main/assets/www/media.js';
import {
  safeFilename, mediaUrl, normalizeNote, captionText, textEntry,
  imageEntry, videoEntry, selectedEntries, memberVideoPageUrl, playbackVideoUrl,
} from '../android/app/src/main/assets/www/media.js';

const imageUrl = n => `https://sns-webpic-qc.xhscdn.com/20260927/signature/image${n}!nd_dft_wlteh_jpg_3`;
const videoUrl = n => `https://sns-video-v28.xhscdn.com/stream/${n}.mp4`;
const sourceUrl = 'https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=abc%2B123%3D&xsec_source=pc_share';
const createdAt = new Date('2026-09-27T12:34:56.000Z');
const fixture = () => ({
  success: true,
  title: '给夏天的备忘录',
  content: '第一行文案\n第二行，保留中文和 emoji 🌻。',
  noteId: '1234567890abcdef12345678',
  engine: 'node',
  images: [
    { index: 1, url: imageUrl(1), livePhoto: false, liveVideo: null },
    { index: 2, url: imageUrl(2), livePhoto: true, liveVideo: {
      url: videoUrl('live'), backupUrls: [videoUrl('live-backup')], codec: 'h264', hasAudio: false,
    } },
    { index: 3, url: imageUrl(3), livePhoto: false, liveVideo: null },
  ],
  videos: [
    { index: 1, url: videoUrl('1080p'), backupUrls: [videoUrl('1080p-backup')], width: 1080,
      height: 1920, codec: 'h264', hasAudio: true, isDefault: true, label: '1080p · H264' },
    { index: 2, url: videoUrl('4k'), codec: 'h265', hasAudio: null, isDefault: false, label: '4K · H265' },
  ],
});

test('Android accepts both parser engines without dropping captions, live media or video quality metadata', () => {
  for (const [engine, label] of [['node', 'Node.js'], ['python', 'Python']]) {
    const payload = { ...fixture(), engine };
    const before = structuredClone(payload);
    const note = normalizeNote(payload, `这是分享文案 ${sourceUrl} 直达小红书`);
    assert.equal(note.engine, label);
    assert.equal(note.title, payload.title);
    assert.equal(note.content, payload.content);
    assert.equal(note.sourceUrl, sourceUrl);
    assert.equal(note.noteId, payload.noteId);
    assert.equal(note.images[1].liveVideo.url, videoUrl('live'));
    assert.deepEqual(note.images[1].liveVideo.backupUrls, [videoUrl('live-backup')]);
    assert.equal(note.videos[0].isDefault, true);
    assert.equal(note.videos[0].hasAudio, true);
    assert.equal(note.videos[1].hasAudio, null, 'Unknown audio is not asserted to be present');
    assert.equal(note.videos[1].label, '4K · H265');
    assert.deepEqual(payload, before, 'Normalization must not mutate the API response');
  }
});

test('Android accepts video-only and direct-image results without inventing other media', () => {
  const video = normalizeNote({ ...fixture(), images: [] }, sourceUrl);
  assert.equal(video.images.length, 0);
  assert.equal(video.videos.length, 2);
  assert.throws(() => selectedEntries(video, new Set(), createdAt), /至少一张/);
  const image = normalizeNote({ success: true, images: [{ url: imageUrl(1) }] });
  assert.equal(image.images.length, 1);
  assert.equal(image.videos.length, 0);
  assert.equal(image.content, '');
  assert.equal(image.images[0].liveVideo, null);
});

test('Android original-only results keep availability without exposing a native video download URL', () => {
  const original = 'https://sns-video-bd.xhscdn.com/spectrum/original';
  const note = normalizeNote({ success: true, hasOriginalVideo: true, originalVideoCount: 1, images: [], videos: [] }, sourceUrl);
  assert.equal(note.hasOriginalVideo, true);
  assert.deepEqual(note.videos, []);
  const legacy = normalizeNote({ success: true, images: [], videos: [{ url: original }] }, sourceUrl);
  assert.equal(legacy.hasOriginalVideo, true);
  assert.equal(JSON.stringify(legacy).includes(original), false);
  const withBackup = normalizeNote({ ...fixture(), videos: [{ url: videoUrl('ordinary'), backupUrls: [original, videoUrl('backup')] }] }, sourceUrl);
  assert.deepEqual(withBackup.videos[0].backupUrls, [videoUrl('backup')]);
});

test('Android member entry preserves signed note parameters and targets the hosted account gate', () => {
  const destination = new URL(memberVideoPageUrl(sourceUrl));
  assert.equal(destination.origin, 'https://xhs.download.brclio.com');
  assert.equal(destination.searchParams.get('note'), sourceUrl);
  assert.equal(destination.searchParams.get('memberVideo'), '1');
  assert.equal(playbackVideoUrl(videoUrl('ordinary')), videoUrl('ordinary'));
  for (const value of ['https://sns-video-bd.xhscdn.com/spectrum/original',
    'https://sns-video-bd.xhscdn.com/stream/%2e%2e/original', 'https://sns-video-bd.xhscdn.com/stream/%5Coriginal']) assert.equal(playbackVideoUrl(value), '');
  for (const value of ['javascript:alert(1)', 'https://evilxiaohongshu.com/explore/abc', 'https://www.xiaohongshu.com:8443/explore/abc',
    'https://user:password@www.xiaohongshu.com/explore/abc', 'https://attacker.test/', '']) assert.equal(memberVideoPageUrl(value), '');
});

test('Android normalizes image ordering so repeated upstream indices cannot corrupt selection or ZIP names', () => {
  const payload = fixture();
  payload.images.forEach(image => { image.index = 42; });
  const note = normalizeNote(payload);
  assert.deepEqual(note.images.map(image => image.index), [1, 2, 3]);
  const entries = selectedEntries(note, new Set([3, 1]), createdAt);
  assert.deepEqual(entries.map(entry => entry.name), ['01.jpg', '03.jpg', '文案.txt']);
  assert.deepEqual(entries.filter(entry => entry.url).map(entry => entry.url), [imageUrl(1), imageUrl(3)]);
});

test('Android media URLs preserve signed queries and upgrade legacy HTTP without allowing arbitrary destinations', () => {
  const signed = `${imageUrl(1)}?sign=ab%2Bcd%3D&expires=123`;
  assert.equal(mediaUrl(`${signed}#preview`), signed);
  assert.equal(mediaUrl(signed.replace('https:', 'http:')), signed);
  assert.equal(mediaUrl('https://ci.xiaohongshu.com/image.jpg'), 'https://ci.xiaohongshu.com/image.jpg');
  assert.equal(mediaUrl('https://sns-video-v28.xhscdn.com:443/clip.mp4'), 'https://sns-video-v28.xhscdn.com/clip.mp4');
  for (const value of [
    'javascript:alert(1)', 'file:///etc/passwd', 'content://private/file',
    'https://localhost/media.jpg', 'https://127.0.0.1/media.jpg',
    'https://evilxhscdn.com/image.jpg', 'https://xhscdn.com.attacker.test/image.jpg',
    'https://ci.xiaohongshu.com.attacker.test/image.jpg', 'https://www.xiaohongshu.com/image.jpg',
    'https://user:password@sns-webpic-qc.xhscdn.com/image.jpg',
    'https://sns-webpic-qc.xhscdn.com:8443/image.jpg', 'http://sns-webpic-qc.xhscdn.com:8080/image.jpg',
    '//sns-webpic-qc.xhscdn.com/image.jpg', undefined,
  ]) assert.equal(mediaUrl(value), '', `Unexpectedly accepted ${String(value)}`);
});

test('Android rejects one unsafe primary URL instead of presenting an incomplete successful note', () => {
  for (const mutate of [
    payload => { payload.images[1].url = 'https://attacker.test/image.jpg'; },
    payload => { payload.images[1].liveVideo.url = 'file:///private/live.mp4'; },
    payload => { payload.videos[1].url = 'http://localhost/video.mp4'; },
  ]) {
    const payload = fixture();
    mutate(payload);
    assert.throws(() => normalizeNote(payload), /无效.*地址/);
  }
});

test('Android removes unsafe and duplicate backup routes while preserving usable signed alternatives', () => {
  const payload = fixture();
  payload.videos[0].backupUrls = [videoUrl('backup'), 'https://attacker.test/video.mp4', videoUrl('backup'), null];
  assert.deepEqual(normalizeNote(payload).videos[0].backupUrls, [videoUrl('backup')]);
  payload.videos[0].backupUrls = 'not-an-array';
  assert.deepEqual(normalizeNote(payload).videos[0].backupUrls, []);
});

test('Android keeps failed, empty and oversized parse results out of the downloadable state', () => {
  assert.throws(() => normalizeNote({ success: false, message: '需要重新获取公开链接' }), /需要重新获取公开链接/);
  assert.throws(() => normalizeNote({ success: true, images: [], videos: [] }), /未找到/);
  assert.throws(() => normalizeNote({ success: true, images: {}, videos: 'invalid' }), /未找到/);
  for (const key of ['images', 'videos']) {
    const payload = fixture();
    payload[key] = Array.from({ length: 51 }, (_, i) => ({ url: key === 'images' ? imageUrl(i) : videoUrl(i) }));
    assert.throws(() => normalizeNote(payload), /媒体数量过多/);
  }
});

test('Android selected ZIP contains only selected originals, their Live Photo clips, and one UTF-8 caption', () => {
  const note = normalizeNote(fixture(), sourceUrl);
  const entries = selectedEntries(note, new Set([2, 3]), createdAt);
  assert.deepEqual(entries.map(entry => entry.name), ['02.jpg', '02-live.mp4', '03.jpg', '文案.txt']);
  assert.equal(entries[0].url, imageUrl(2));
  assert.equal(entries[1].url, videoUrl('live'));
  assert.equal(entries[1].kind, 'video');
  assert.equal(entries[1].requireAudio, false, 'Silent live-photo clips are valid');
  assert.deepEqual(entries[1].backupUrls, [videoUrl('live-backup')]);
  assert.ok(!entries.some(entry => entry.url === videoUrl('1080p')), 'A separate ordinary video is not duplicated into an image ZIP');
  assert.equal(entries.at(-1).text.charCodeAt(0), 0xfeff);
  assert.ok(entries.at(-1).text.includes(note.content));
  assert.ok(entries.at(-1).text.includes(sourceUrl));
  assert.ok(entries.at(-1).text.includes('2026-09-27T12:34:56.000Z'));
});

test('Android missing Live Photo video blocks a full archive but preserves independent original-image saving', () => {
  const payload = fixture();
  payload.images[1].liveVideo = null;
  const note = normalizeNote(payload);
  assert.equal(note.images[1].livePhoto, true);
  assert.throws(() => selectedEntries(note, new Set([1, 2]), createdAt), /第 2 张.*动态片段不完整/);
  assert.deepEqual(imageEntry(note.images[1]), { name: '02.jpg', url: imageUrl(2), kind: 'image' });
  assert.deepEqual(selectedEntries(note, new Set([1]), createdAt).map(entry => entry.name), ['01.jpg', '文案.txt']);
});

test('Android treats a present live stream as Live Photo even when the upstream flag is absent', () => {
  const payload = fixture();
  delete payload.images[1].livePhoto;
  const note = normalizeNote(payload);
  assert.equal(note.images[1].livePhoto, true);
  assert.deepEqual(selectedEntries(note, new Set([2]), createdAt).map(entry => entry.name), ['02.jpg', '02-live.mp4', '文案.txt']);
});

test('Android ordinary-video saving requires audio independently of unreliable upstream audio flags', () => {
  const note = normalizeNote(fixture());
  for (const video of note.videos) {
    const entry = videoEntry(video, 'video.mp4');
    assert.equal(entry.requireAudio, true);
    assert.equal(entry.kind, 'video');
    assert.equal(entry.url, video.url);
  }
  assert.equal(videoEntry({ ...note.videos[0], hasAudio: false }, 'video.mp4').requireAudio, true);
  assert.equal(videoEntry(note.images[1].liveVideo, 'live.mp4', false).requireAudio, false);
});

test('Android caption copying includes title and complete body without duplicating a title already in the body', () => {
  assert.equal(captionText({ title: '标题', content: '第一行\n第二行' }), '标题\n\n第一行\n第二行');
  assert.equal(captionText({ title: ' 标题 ', content: '标题\n第一行\n第二行' }), '标题\n第一行\n第二行');
  assert.equal(captionText({ title: '标题', content: ' 标题 ' }), '标题');
  assert.equal(captionText({ title: '', content: '正文' }), '正文');
  assert.equal(captionText({ title: '只有标题', content: '' }), '只有标题');
});

test('Android download titles cannot introduce path separators or raw control characters', () => {
  const name = safeFilename('../旅行\\夏天:照片\u0000\n<>|?*"');
  assert.ok(name.length <= 60);
  assert.doesNotMatch(name, /[\\/:*?"<>|\u0000-\u001f]/);
  assert.equal(safeFilename('  夏天   的  旅行  '), '夏天 的 旅行');
  assert.equal(safeFilename(''), '小红书笔记');
  assert.equal(safeFilename(' '.repeat(10)), '小红书笔记');
  assert.equal(safeFilename('夏'.repeat(100)).length, 60);
});

test('Android caption documents use the requested current note, preserving signed source URLs', () => {
  const first = normalizeNote(fixture(), sourceUrl);
  const next = normalizeNote({ ...fixture(), title: '下一篇标题', content: '下一篇正文', engine: 'python' }, 'https://xhslink.cn/o/new-note');
  const document = textEntry(next, createdAt);
  assert.ok(document.text.includes('下一篇标题\n\n下一篇正文'));
  assert.ok(!document.text.includes(first.title));
  assert.ok(!document.text.includes(first.content));
  assert.ok(document.text.includes('https://xhslink.cn/o/new-note'));
  assert.ok(document.text.includes('Python'));
});

// Run the shipped client against the observable DOM/Android message boundaries.
// Network, request completion order and Android share delivery stay under test control.
async function clientFixture(t) {
  const [html, client] = await Promise.all([
    readFile(new URL('../android/app/src/main/assets/www/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/assets/www/client.js', import.meta.url), 'utf8'),
  ]);
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.value = '';
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.textContent = '';
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
    }
    set innerHTML(_value) { throw new Error('Remote client content must not be inserted as HTML'); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type) { return this.listeners.get(type)?.({ preventDefault() {}, currentTarget: this }); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    focus() {}
    pause() {}
    load() {}
  }
  const elements = new Map([...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)]
    .map(([, tag, id]) => [id, new Element(tag)]));
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const allElements = () => [...new Set([...elements.values()].flatMap(flatten))];
  const document = {
    getElementById: id => {
      assert.ok(elements.has(id), `Missing real DOM element #${id}`);
      return elements.get(id);
    },
    createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '#images input'
      ? flatten(elements.get('images')).filter(node => node.tagName === 'input')
      : allElements().filter(node => ['button', 'select', 'textarea', 'input'].includes(node.tagName)),
  };
  const requests = [];
  const replies = new Set();
  const native = { postMessage: value => requests.push(JSON.parse(value)) };
  const window = { BrclioNative: native, scrollTo() {} };
  const timers = new Set();
  const context = vm.createContext({
    ...mediaHelpers, document, window,
    setTimeout: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timers.add(timer); return timer; },
    clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  vm.runInContext(client.replace(/^import\s[^;]+;\s*/, ''), context, { filename: 'android/client.js' });
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const respond = async (request, result = {}, error = '') => {
    assert.ok(request, 'Expected an Android bridge request');
    assert.ok(!replies.has(request.id), 'A bridge call must complete only once');
    replies.add(request.id);
    native.onmessage({ data: JSON.stringify({ id: request.id, ok: !error, result, error }) });
    await flush();
  };
  const next = method => requests.find(request => request.method === method && !replies.has(request.id));
  const element = id => elements.get(id);
  const click = id => {
    assert.equal(element(id).disabled, false, `User control #${id} must be enabled`);
    void element(id).emit('click');
  };
  const parse = text => {
    element('share-text').value = text;
    element('parse-form').emit('submit');
    return next('parse');
  };
  await respond(next('ready'), { version: 'test' });
  element('engine').value = 'node';
  return { element, requests, next, respond, click, parse, flush,
    share: text => window.brclioEvent({ type: 'share', text }),
    proxy: data => window.brclioEvent({ type: 'update-proxy', ...data }),
    update: data => window.brclioEvent({ type: 'update', ...data }) };
}

test('Android reviews and full order history open fixed browser pages without transferring native credentials', async t => {
  const ui = await clientFixture(t);
  for (const [button, page, label] of [
    ['software-reviews-open', 'reviews', '软件评价'],
    ['software-orders-open', 'orders', '我的订单'],
  ]) {
    ui.click(button);
    assert.equal(ui.element(button).disabled, true);
    assert.deepEqual(ui.next('openSoftwarePage').params, { page });
    await ui.respond(ui.next('openSoftwarePage'), { opened: true });
    assert.equal(ui.element(button).disabled, false);
    assert.equal(ui.element('software-account-status').dataset.tone, 'success');
    assert.match(ui.element('software-account-status').textContent, new RegExp(`系统浏览器.*${label}`));
    assert.doesNotMatch(ui.element('software-account-status').textContent, /登录成功|评价成功|订单已载入/);
  }
  for (const method of ['login', 'submitReview', 'orders', 'copy', 'save']) {
    assert.equal(ui.next(method), undefined, 'Account operations stay in the browser');
  }
});

test('Android account browser launch failures remain visible and can be retried after active downloads finish', async t => {
  const ui = await clientFixture(t);
  ui.click('software-orders-open');
  await ui.respond(ui.next('openSoftwarePage'), {}, '未找到可用的浏览器');
  assert.match(ui.element('software-account-status').textContent, /无法打开我的订单.*未找到可用的浏览器/);
  assert.equal(ui.element('software-account-status').dataset.tone, 'error');
  assert.equal(ui.element('software-orders-open').disabled, false);
  const request = ui.parse(sourceUrl);
  assert.equal(ui.element('software-reviews-open').disabled, true);
  assert.equal(ui.element('software-orders-open').disabled, true);
  await ui.respond(request, fixture());
  assert.equal(ui.element('software-orders-open').disabled, false);
  ui.click('software-orders-open');
  await ui.respond(ui.next('openSoftwarePage'), { opened: true });
  assert.equal(ui.element('software-account-status').dataset.tone, 'success');
});

test('Android startup stays automatic and emergency proxy close lasts until the next explicit update click', async t => {
  const ui = await clientFixture(t);
  assert.deepEqual(ui.next('checkUpdate').params, { manual: false });
  ui.proxy({ mode: 'starting', manuallyDisabled: false, canStop: true });
  assert.match(ui.element('update-proxy-status').textContent, /正在准备/);
  assert.equal(ui.element('check-update').disabled, true);
  ui.click('stop-update-proxy');
  assert.equal(ui.element('stop-update-proxy').disabled, true);
  assert.deepEqual(ui.next('stopUpdateProxy').params, {});
  assert.equal(ui.next('cancelUpdate'), undefined, 'Emergency close delegates cancellation ownership to native code');
  await ui.respond(ui.next('stopUpdateProxy'), { mode: 'off', manuallyDisabled: true, canStop: false });
  assert.equal(ui.element('stop-update-proxy').disabled, true);
  assert.match(ui.element('update-proxy-status').textContent, /下次点击检查更新或下载更新.*自动启用/);
  await ui.respond(ui.next('checkUpdate'), { status: 'cancelled' });
  ui.click('check-update');
  assert.deepEqual(ui.next('checkUpdate').params, { manual: true });
  ui.proxy({ mode: 'starting', manuallyDisabled: false, canStop: true });
  assert.equal(ui.element('stop-update-proxy').disabled, false);
  await ui.respond(ui.next('checkUpdate'), { status: 'latest', update: null });
  ui.proxy({ mode: 'off', manuallyDisabled: false, canStop: true });
  assert.match(ui.element('update-proxy-status').textContent, /已关闭/);
  assert.equal(ui.next('resumeUpdateProxy'), undefined, 'The next explicit update click supplies recovery without a resume control');
});

test('Android displays system proxy use and can disable built-in fallback without cancelling system updates', async t => {
  const ui = await clientFixture(t);
  ui.proxy({ mode: 'system', manuallyDisabled: false, canStop: true });
  assert.match(ui.element('update-proxy-status').textContent, /系统代理或 VPN/);
  ui.click('stop-update-proxy');
  await ui.respond(ui.next('stopUpdateProxy'), { mode: 'system', manuallyDisabled: true, canStop: false, stopped: false });
  assert.equal(ui.next('cancelUpdate'), undefined);
  await ui.respond(ui.next('checkUpdate'), { status: 'latest', update: null });
  assert.match(ui.element('update-status').textContent, /最新/);
  assert.equal(ui.element('stop-update-proxy').disabled, true);
});

test('Android proxy close remains usable during downloads and reports native failures for retry', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), newAndroidRelease());
  ui.click('download-update');
  ui.proxy({ mode: 'internal', manuallyDisabled: false, canStop: true });
  assert.equal(ui.element('stop-update-proxy').disabled, false);
  ui.click('stop-update-proxy');
  await ui.respond(ui.next('stopUpdateProxy'), {}, '关闭失败，请重试');
  assert.match(ui.element('update-proxy-status').textContent, /关闭失败/);
  assert.equal(ui.element('stop-update-proxy').disabled, false);
  ui.click('stop-update-proxy');
  await ui.respond(ui.next('stopUpdateProxy'), { mode: 'off', manuallyDisabled: true, canStop: false });
  await ui.respond(ui.next('downloadUpdate'), { status: 'cancelled' });
  assert.equal(ui.element('stop-update-proxy').disabled, true);
  ui.click('download-update');
  ui.proxy({ mode: 'starting', manuallyDisabled: false, canStop: true });
  assert.equal(ui.element('stop-update-proxy').disabled, false, 'An accepted explicit download starts a new internal-proxy opportunity');
  await ui.respond(ui.next('downloadUpdate'), { status: 'cancelled' });
  ui.proxy({ mode: 'off', manuallyDisabled: false, canStop: true });
});

test('Android late proxy state and command replies cannot overwrite newer native events', async t => {
  const ui = await clientFixture(t);
  ui.proxy({ mode: 'internal', manuallyDisabled: false, canStop: true });
  await ui.respond(ui.next('updateProxyState'), { mode: 'off', manuallyDisabled: false, canStop: true });
  assert.match(ui.element('update-proxy-status').textContent, /正在使用/);
  ui.click('stop-update-proxy');
  ui.proxy({ mode: 'system', manuallyDisabled: true, canStop: false });
  await ui.respond(ui.next('stopUpdateProxy'), { mode: 'internal', manuallyDisabled: false, canStop: true });
  assert.equal(ui.element('stop-update-proxy').disabled, true);
  assert.match(ui.element('update-proxy-status').textContent, /下次点击/);
});

test('Android shows the hosted member entry for original-only videos and clears it with the next parse', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.parse(sourceUrl), { success: true, title: '原视频笔记', images: [], videos: [], hasOriginalVideo: true, originalVideoCount: 1 });
  assert.equal(ui.element('results').hidden, false);
  assert.equal(ui.element('video-section').hidden, true);
  assert.equal(ui.element('member-video-section').hidden, false);
  const destination = new URL(ui.element('member-video-download').href);
  assert.equal(destination.searchParams.get('note'), sourceUrl);
  assert.equal(destination.searchParams.get('memberVideo'), '1');
  assert.equal(ui.next('save'), undefined, 'Membership and saving continue in the system browser');
  const next = ui.parse('https://xhslink.cn/o/image-note');
  assert.equal(ui.element('member-video-section').hidden, true);
  assert.equal(ui.element('member-video-download').href, undefined);
  await ui.respond(next, { success: true, images: [{ url: imageUrl(1) }], videos: [] });
  assert.equal(ui.element('member-video-section').hidden, true);
});

test('Android new parse clears a previous success immediately and retains no stale media after failure', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.parse(sourceUrl), fixture());
  assert.equal(ui.element('results').hidden, false);
  assert.equal(ui.element('images').children.length, 3);
  const second = ui.parse('https://xhslink.cn/o/next-note');
  assert.equal(ui.element('results').hidden, true);
  assert.equal(ui.element('images').children.length, 0);
  assert.equal(ui.element('video-player').src, undefined);
  assert.equal(ui.element('parse').disabled, true);
  await ui.respond(second, {}, '该笔记已不可用');
  assert.equal(ui.element('results').hidden, true);
  assert.equal(ui.element('status').textContent, '该笔记已不可用');
  assert.equal(ui.element('parse').disabled, false);
});

test('Android incoming share invalidates an in-flight parse and only the new note can later be saved', async t => {
  const ui = await clientFixture(t);
  const previous = ui.parse(sourceUrl);
  const sharedUrl = 'https://xhslink.cn/o/shared-note';
  ui.share(sharedUrl);
  await ui.respond(previous, fixture());
  assert.equal(ui.element('share-text').value, sharedUrl);
  assert.equal(ui.element('results').hidden, true, 'Late old parser response must not appear as the shared note');
  const nextPayload = { ...fixture(), title: '新分享标题', content: '新分享的文案' };
  await ui.respond(ui.parse(sharedUrl), nextPayload);
  assert.equal(ui.element('note-title').textContent, nextPayload.title);
  ui.click('save-caption');
  const saveRequest = ui.next('save');
  assert.ok(saveRequest.params.entries[0].text.includes('新分享标题\n\n新分享的文案'));
  assert.ok(saveRequest.params.entries[0].text.includes(sharedUrl));
  assert.ok(!saveRequest.params.entries[0].text.includes(fixture().title));
  await ui.respond(saveRequest, { cancelled: true });
});

test('Android shares arriving during a save leave that transfer intact and fill only the newest share afterward', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.parse(sourceUrl), fixture());
  ui.click('save-zip');
  const saving = ui.next('save');
  ui.share('https://xhslink.cn/o/first-share');
  ui.share('https://xhslink.cn/o/latest-share');
  assert.ok(saving.params.entries.at(-1).text.includes(fixture().title));
  assert.equal(ui.element('parse').disabled, true);
  await ui.respond(saving, { cancelled: false, filename: saving.params.filename, files: 5 });
  assert.equal(ui.element('share-text').value, 'https://xhslink.cn/o/latest-share');
  assert.equal(ui.element('results').hidden, true);
  assert.equal(ui.element('parse').disabled, false);
});

test('Android a late cancel acknowledgement cannot overwrite a finished save status', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.parse(sourceUrl), fixture());
  ui.click('save-zip');
  const saving = ui.next('save');
  ui.click('cancel');
  const cancel = ui.next('cancel');
  await ui.respond(saving, { cancelled: true });
  assert.equal(ui.element('status').textContent, '已取消保存。');
  await ui.respond(cancel);
  assert.equal(ui.element('status').textContent, '已取消保存。');
  assert.equal(ui.element('transfer').hidden, true);
});

test('Android an old cancel reply cannot overwrite a newer operation or re-disable its controls', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.parse(sourceUrl), fixture());
  ui.click('save-zip');
  const saving = ui.next('save');
  ui.click('cancel');
  const cancel = ui.next('cancel');
  await ui.respond(saving, { cancelled: true });
  const parsing = ui.parse('https://xhslink.cn/o/next-note');
  await ui.respond(cancel, {}, '取消请求未生效');
  assert.equal(ui.element('status').textContent, '');
  assert.equal(ui.element('parse').disabled, true);
  await ui.respond(parsing, { ...fixture(), title: '新笔记' });
  assert.equal(ui.element('note-title').textContent, '新笔记');
  assert.equal(ui.element('parse').disabled, false);
});

for (const [button, method, message] of [
  ['copy-images', 'copyImages', '已取消图片复制。'],
  ['share-images', 'shareImages', '已取消图片分享。'],
]) test(`Android cancelled ${method} never reports copied files or an opened chooser`, async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.parse(sourceUrl), fixture());
  ui.click(button);
  await ui.respond(ui.next(method), { cancelled: true });
  assert.equal(ui.element('status').textContent, message);
  assert.notEqual(ui.element('status').dataset.tone, 'success');
  assert.equal(ui.element('transfer').hidden, true);
});

test('Android displays untrusted caption and video labels as literal text', async t => {
  const ui = await clientFixture(t);
  const payload = fixture();
  payload.title = '<img src=x onerror=alert(1)>';
  payload.content = '<script>BrclioNative.postMessage("bad")</script>';
  payload.videos[0].label = '<svg onload=alert(1)>1080p';
  await ui.respond(ui.parse(sourceUrl), payload);
  assert.equal(ui.element('note-title').textContent, payload.title);
  assert.equal(ui.element('caption').textContent, payload.content);
  assert.equal(ui.element('quality').children[0].textContent, payload.videos[0].label);
  assert.deepEqual(ui.requests.map(request => request.method), ['ready', 'updateProxyState', 'checkUpdate', 'parse']);
});

const newAndroidRelease = () => ({
  currentVersion: '1.0.0', status: 'available', canInstallBuild: true,
  update: { versionName: '1.0.1', size: 3000000, notes: '修复下载问题\n支持更多手机', tag: 'android-v1.0.1' },
});

test('Android startup checks updates without downloading or installing and renders remote notes as text', async t => {
  const ui = await clientFixture(t);
  const release = newAndroidRelease();
  release.update.notes = '<img onerror=steal() src=x>\n版本说明';
  await ui.respond(ui.next('checkUpdate'), release);
  assert.equal(ui.element('update-banner').hidden, false);
  assert.equal(ui.element('update-notes').textContent, release.update.notes);
  assert.equal(ui.next('downloadUpdate'), undefined);
  assert.equal(ui.next('installUpdate'), undefined);
  assert.equal(ui.element('download-update').disabled, false);
  assert.equal(ui.element('install-update').hidden, true);
});

test('Android failed recheck preserves an already discovered update and leaves parsing usable', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), newAndroidRelease());
  ui.click('check-update');
  await ui.respond(ui.next('checkUpdate'), {}, '网络不可达');
  assert.equal(ui.element('update-banner').hidden, false);
  assert.equal(ui.element('download-update').disabled, false);
  assert.match(ui.element('update-status').textContent, /网络不可达/);
  assert.equal(ui.element('parse').disabled, false);
});

test('Android only exposes installation after native verification, blocks it during media work, and does not auto-install', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), newAndroidRelease());
  ui.click('download-update');
  ui.update({ status: 'downloading', bytes: 1000000, total: 3000000 });
  assert.equal(ui.element('install-update').hidden, true);
  ui.update({ status: 'verifying', bytes: 3000000, total: 3000000 });
  assert.match(ui.element('update-status').textContent, /正在校验/);
  assert.equal(ui.element('check-update').disabled, true);
  assert.equal(ui.element('cancel-update').hidden, false);
  assert.equal(ui.element('install-update').hidden, true);
  await ui.respond(ui.next('downloadUpdate'), { status: 'downloaded', versionName: '1.0.1', versionCode: 10001 });
  assert.equal(ui.element('install-update').hidden, false);
  assert.equal(ui.next('installUpdate'), undefined);
  const parsing = ui.parse(sourceUrl);
  assert.equal(ui.element('install-update').disabled, true);
  await ui.respond(parsing, fixture());
  assert.equal(ui.element('install-update').disabled, false);
  ui.click('install-update');
  await ui.respond(ui.next('installUpdate'), { status: 'permission_required' });
  assert.match(ui.element('update-status').textContent, /系统设置/);
  assert.equal(ui.element('install-update').hidden, false);
});

test('Android update cancellation and retry do not alter the current parsed note', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), newAndroidRelease());
  await ui.respond(ui.parse(sourceUrl), fixture());
  ui.click('download-update');
  ui.click('cancel-update');
  await ui.respond(ui.next('cancelUpdate'), { cancelled: true });
  await ui.respond(ui.next('downloadUpdate'), { status: 'cancelled', cancelled: true });
  assert.equal(ui.element('results').hidden, false);
  assert.equal(ui.element('note-title').textContent, fixture().title);
  assert.equal(ui.element('download-update').disabled, false);
  assert.equal(ui.element('install-update').hidden, true);
});

test('Android retains a verified cached installer after recheck or installer-launch failure and allows retry', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), { ...newAndroidRelease(), status: 'downloaded', downloadReady: true });
  assert.equal(ui.element('install-update').hidden, false);
  ui.click('check-update');
  ui.update({ status: 'checking', downloadReady: true });
  assert.equal(ui.element('install-update').hidden, true, 'Do not offer installation during another update task');
  ui.update({ status: 'error', downloadReady: true, error: '网络不可达' });
  await ui.respond(ui.next('checkUpdate'), {}, '网络不可达');
  assert.equal(ui.element('install-update').hidden, false, 'A failed metadata request must not hide the verified APK');
  assert.equal(ui.element('download-update').hidden, true);
  ui.click('install-update');
  ui.update({ status: 'error', downloadReady: true, error: '系统安装器暂不可用' });
  await ui.respond(ui.next('installUpdate'), {}, '系统安装器暂不可用');
  assert.equal(ui.element('install-update').hidden, false);
  assert.equal(ui.element('install-update').disabled, false);
  assert.match(ui.element('update-status').textContent, /系统安装器暂不可用/);
  ui.update({ status: 'available', downloadReady: false });
  assert.equal(ui.element('install-update').hidden, true, 'Native invalidation of a missing or damaged cache must remove Install');
  assert.equal(ui.element('download-update').hidden, false);
});

test('Android distinguishes unavailable releases and debug builds from a confirmed latest version', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), { currentVersion: '1.0.0', status: 'unpublished', update: null });
  assert.match(ui.element('update-status').textContent, /暂未找到/);
  ui.click('check-update');
  await ui.respond(ui.next('checkUpdate'), { ...newAndroidRelease(), canInstallBuild: false });
  assert.equal(ui.element('download-update').disabled, true);
  assert.match(ui.element('update-status').textContent, /调试包/);
});

test('Android installation failure offers a fresh native browser download while retaining cached installation retry', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), { ...newAndroidRelease(), status: 'downloaded', downloadReady: true });
  ui.click('install-update');
  ui.update({ status: 'error', downloadReady: true, error: '系统安装器暂不可用' });
  await ui.respond(ui.next('installUpdate'), {}, '系统安装器暂不可用');
  assert.equal(ui.element('manual-update-help').hidden, false);
  assert.match(ui.element('update-status').textContent, /手动下载最新版覆盖安装/);
  assert.equal(ui.element('install-update').hidden, false);
  ui.click('manual-update');
  assert.equal(ui.element('manual-update').disabled, true);
  assert.equal(ui.element('install-update').disabled, true);
  const request = ui.next('openManualUpdate');
  assert.deepEqual(request.params, {}, 'The renderer cannot choose a URL, tag or asset');
  assert.equal(ui.next('downloadUpdate'), undefined, 'Fallback delegates downloading to the browser');
  await ui.respond(request, { status: 'error', downloadReady: true, manualDownloadOpened: true, manualDownloadVersion: '1.0.9' });
  assert.match(ui.element('manual-update-status').textContent, /Android 1\.0\.9/);
  assert.match(ui.element('manual-update-status').textContent, /覆盖安装.*不要卸载/);
  assert.equal(ui.element('install-update').hidden, false);
  assert.equal(ui.element('install-update').disabled, false);
  assert.equal(ui.element('download-update').hidden, true, 'A manually opened newer release must not discard the existing verified cache');
});

test('Android keeps retry available when manual release lookup or browser opening fails', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), { ...newAndroidRelease(), status: 'downloaded', downloadReady: true });
  for (const error of ['无法连接 GitHub 版本服务', '未找到可用浏览器']) {
    ui.click('manual-update');
    ui.update({ status: 'error', downloadReady: true, error });
    await ui.respond(ui.next('openManualUpdate'), {}, error);
    assert.match(ui.element('manual-update-status').textContent, /手动下载链接未打开/);
    assert.equal(ui.element('install-update').hidden, false);
    assert.equal(ui.element('install-update').disabled, false);
    assert.equal(ui.element('manual-update').disabled, false);
  }
});

test('Android distinguishes returned installer failure, cancellation and unknown results without assuming success', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), { ...newAndroidRelease(), status: 'downloaded', downloadReady: true });
  for (const [installerResult, expected] of [['failed', /系统返回安装失败/], ['cancelled', /取消或未完成/], ['unknown', /未收到明确安装结果/]]) {
    ui.update({ status: 'downloaded', downloadReady: true, installerClosed: true, installerResult });
    assert.match(ui.element('update-status').textContent, expected);
    assert.equal(ui.element('update-status').dataset.tone, installerResult === 'failed' ? 'error' : '');
    assert.equal(ui.element('manual-update-help').hidden, false);
    assert.equal(ui.element('install-update').hidden, false);
  }
  ui.update({ status: 'downloaded', installerClosed: true, installerResult: 'success' });
  assert.match(ui.element('update-status').textContent, /系统已返回安装成功.*确认版本/);
});

test('Android browser fallback remains available when the installer never returns a result', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), { ...newAndroidRelease(), status: 'installer_opened', downloadReady: true });
  assert.doesNotMatch(ui.element('update-status').textContent, /安装失败/);
  assert.equal(ui.element('manual-update-help').hidden, false);
  ui.click('manual-update');
  await ui.respond(ui.next('openManualUpdate'), { status: 'installer_opened', downloadReady: true, manualDownloadOpened: true, manualDownloadVersion: '1.0.2' });
  assert.match(ui.element('manual-update-status').textContent, /已打开.*下载链接/);
  assert.doesNotMatch(ui.element('manual-update-status').textContent, /下载成功|安装成功/);
});


test('Android a late manual download response cannot erase a newly returned installer failure', async t => {
  const ui = await clientFixture(t);
  await ui.respond(ui.next('checkUpdate'), { ...newAndroidRelease(), status: 'installer_opened', downloadReady: true });
  ui.click('manual-update');
  ui.update({ status: 'downloaded', downloadReady: true, installerClosed: true, installerResult: 'failed' });
  await ui.respond(ui.next('openManualUpdate'), { status: 'installer_opened', manualDownloadOpened: true, manualDownloadVersion: '1.0.2' });
  assert.match(ui.element('update-status').textContent, /系统返回安装失败/);
  assert.equal(ui.element('manual-update-status').hidden, true);
  assert.equal(ui.element('install-update').hidden, false);
});
