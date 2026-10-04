import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../download.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../download.js', import.meta.url), 'utf8');
const repository = 'Brclio/brclio-xhs-media-downloader';
const base = `https://github.com/${repository}/releases`;
const suffixes = {
  'mac-arm64': 'mac-arm64.dmg',
  'mac-x64': 'mac-x64.dmg',
  'windows-setup': 'windows-x64-setup.exe',
  'windows-portable': 'windows-x64-portable.exe',
};

function node(tagName, attributes = {}, textContent = '') {
  const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
  return {
    tagName: tagName.toUpperCase(), attributes, textContent, href: attributes.href || '',
    open: Object.hasOwn(attributes, 'open'), children: [],
    classList: { add: value => classes.add(value), contains: value => classes.has(value) },
    replaceChildren(...children) {
      this.children = children;
      this.textContent = children.map(child => child.textContent).join('');
    },
  };
}

function documentFixture() {
  // Read the actual HTML anchors and metadata so a missing selector or stale
  // fallback package cannot be hidden by a separate hand-written DOM fixture.
  const nodes = [...html.matchAll(/<([a-z][\w-]*)\b([^<>]*)>([^<]*)/gi)].map(match => {
    const attributes = Object.fromEntries([...match[2].matchAll(/([^\s=]+)(?:="([^"]*)"|'([^']*)'|([^\s]+))?/g)]
      .map(attribute => [attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '']));
    return node(match[1], attributes, match[3]);
  });
  function select(selector) {
    if (selector.startsWith('#')) return nodes.filter(item => item.attributes.id === selector.slice(1));
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    assert.ok(match, `Unsupported selector in test DOM: ${selector}`);
    return nodes.filter(item => Object.hasOwn(item.attributes, match[1]) && (match[2] == null || item.attributes[match[1]] === match[2]));
  }
  return {
    querySelector: selector => select(selector)[0] || null,
    querySelectorAll: select,
    getElementById: id => nodes.find(item => item.attributes.id === id) || null,
    createElement: tagName => node(tagName),
    createTextNode: textContent => ({ textContent }),
  };
}

function release(version = '2.1.0') {
  const tag = `v${version}`;
  return {
    draft: false, prerelease: false, tag_name: tag, html_url: `${base}/tag/${tag}`,
    published_at: '2026-09-24T01:02:03Z',
    assets: Object.values(suffixes).map((suffix, index) => {
      const name = `Brclio-XHS-${version}-${suffix}`;
      return { name, state: 'uploaded', size: 140000000 + index * 1000000, browser_download_url: `${base}/download/${tag}/${name}` };
    }),
  };
}

function androidRelease(version = '1.1.0') {
  const tag = `android-v${version}`;
  const apk = `Brclio-XHS-Android-${version}-release.apk`;
  return {
    draft: false, prerelease: false, tag_name: tag, html_url: `${base}/tag/${tag}`,
    published_at: '2026-09-28T01:02:03Z',
    assets: [apk, `${apk}.sha256`].map((name, index) => ({
      name, state: 'uploaded', size: index ? 112 : 7500000,
      browser_download_url: `${base}/download/${tag}/${name}`,
    })),
  };
}

function snapshot(document) {
  return {
    links: Object.fromEntries(Object.keys(suffixes).map(key => [key, document.querySelector(`[data-asset="${key}"]`).href])),
    sizes: Object.fromEntries(Object.keys(suffixes).map(key => [key, document.querySelector(`[data-size="${key}"]`).textContent])),
    versions: document.querySelectorAll('[data-release-version]').map(item => item.textContent),
    releaseLinks: document.querySelectorAll('[data-release-link]').map(item => item.href),
    date: document.querySelector('[data-release-date]').textContent,
  };
}

function androidSnapshot(document) {
  return {
    apk: document.querySelector('[data-android-asset]').href,
    checksum: document.querySelector('[data-android-checksum]').href,
    size: document.querySelector('[data-android-size]').textContent,
    versions: document.querySelectorAll('[data-android-version]').map(item => item.textContent),
    releaseLinks: document.querySelectorAll('[data-android-release-link]').map(item => item.href),
    date: document.querySelector('[data-android-release-date]').textContent,
  };
}

async function runPage({ payload = release(), fetchError, status = 200, navigator = {}, protocol = 'https:', hash = '', hang = false,
  androidPayload = [androidRelease()], androidFetchError, androidHttpStatus = 200, androidHang = false } = {}) {
  const document = documentFixture();
  const initial = snapshot(document);
  const initialAndroid = androidSnapshot(document);
  const requests = [];
  const timers = new Map();
  const listeners = new Map();
  const location = { protocol, hash };
  const context = vm.createContext({
    document, location, navigator, AbortController, Intl,
    window: { addEventListener: (event, callback) => listeners.set(event, callback) },
    setTimeout: callback => { const id = Symbol('timer'); timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fetchError) throw fetchError;
      const android = url.endsWith('/releases?per_page=100');
      if (android && androidFetchError) throw androidFetchError;
      if (hang || (android && androidHang)) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))));
      const effectiveStatus = android ? androidHttpStatus : status;
      return { ok: effectiveStatus >= 200 && effectiveStatus < 300, json: async () => structuredClone(android ? androidPayload : payload) };
    },
  });
  vm.runInContext(script, context, { filename: 'download.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { document, initial, initialAndroid, requests, timers, listeners, location };
}

test('static download anchors point to one complete branded release', () => {
  const current = snapshot(documentFixture());
  const tag = current.versions[0];
  assert.equal(tag, 'v2.0.6');
  for (const [key, suffix] of Object.entries(suffixes)) {
    assert.equal(current.links[key], `${base}/download/${tag}/Brclio-XHS-${tag.slice(1)}-${suffix}`);
    assert.match(current.sizes[key], /^(?:\d+\.\d MB|大小以发布附件为准|发布后同步)$/);
  }
  assert.ok(current.releaseLinks.every(url => url === `${base}/tag/${tag}`));
});

test('verified latest release updates every asset, size, version and release link together', async () => {
  const page = await runPage();
  const current = snapshot(page.document);
  for (const [index, [key, suffix]] of Object.entries(suffixes).entries()) {
    assert.equal(current.links[key], `${base}/download/v2.1.0/Brclio-XHS-2.1.0-${suffix}`);
    assert.equal(current.sizes[key], `${(140 + index).toFixed(1)} MB`);
  }
  assert.ok(current.versions.every(version => version === 'v2.1.0'));
  assert.ok(current.releaseLinks.every(url => url === `${base}/tag/v2.1.0`));
  assert.equal(current.date, '发布于 2026.09.24');
  assert.match(page.document.querySelector('#release-status').textContent, /已核对最新正式版 v2.1.0/);
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[0].url, `https://api.github.com/repos/${repository}/releases/latest`);
  assert.equal(page.requests[0].options.credentials, 'omit');
  assert.equal(page.timers.size, 0);
});

const rejectedCases = {
  'API HTTP error': () => ({ status: 503 }),
  'network failure': () => ({ fetchError: new Error('Offline') }),
  'missing final platform asset does not partially promote': value => { value.assets.pop(); },
  'draft release': value => { value.draft = true; },
  'prerelease': value => { value.prerelease = true; },
  'missing draft flag': value => { delete value.draft; },
  'missing prerelease flag': value => { delete value.prerelease; },
  'pre-release version string': value => { value.tag_name = 'v2.1.0-beta.1'; },
  'older release': () => ({ payload: release('1.8.7') }),
  'untrusted release page': value => { value.html_url = 'https://evil.invalid/releases/tag/v2.1.0'; },
  'untrusted installer URL': value => { value.assets[3].browser_download_url = 'https://evil.invalid/installer.exe'; },
  'unexpected installer query string': value => { value.assets[0].browser_download_url += '?redirect=evil'; },
  'duplicate named asset': value => { value.assets.push({ ...value.assets[0] }); },
  'pending upload': value => { value.assets[3].state = 'open'; },
  'zero-byte installer': value => { value.assets[3].size = 0; },
  'invalid file size': value => { value.assets[0].size = 1.5; },
  'invalid publication date': value => { value.published_at = 'not-a-date'; },
  'non-array asset list': value => { value.assets = {}; },
};

for (const [name, change] of Object.entries(rejectedCases)) {
  test(`fallback retains all original downloads on ${name}`, async () => {
    const payload = release();
    const options = change(payload) || {};
    const page = await runPage({ payload, ...options });
    assert.deepEqual(snapshot(page.document), page.initial);
    assert.match(page.document.querySelector('#release-status').textContent, /版本信息暂未刷新，仍可下载已发布的/);
    const external = page.document.querySelector('#release-status').children[1];
    assert.equal(external.href, `${base}/latest`);
    assert.equal(external.rel, 'noopener noreferrer');
    assert.equal(page.timers.size, 0);
  });
}

test('timeout aborts the metadata request while keeping fallback downloads usable', async () => {
  const page = await runPage({ hang: true });
  assert.equal(page.timers.size, 2);
  for (const timer of page.timers.values()) timer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.requests[0].options.signal.aborted, true);
  assert.deepEqual(snapshot(page.document), page.initial);
  assert.deepEqual(androidSnapshot(page.document), page.initialAndroid);
  assert.match(page.document.querySelector('#release-status').textContent, /版本信息暂未刷新/);
  assert.equal(page.timers.size, 0);
});

for (const navigator of [
  { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 },
  { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 },
]) {
  test(`mobile browser receives no desktop platform recommendation: ${navigator.platform}`, async () => {
    const page = await runPage({ navigator });
    assert.match(page.document.querySelector('#platform-hint').textContent, /移动设备/);
    assert.doesNotMatch(page.document.querySelector('#platform-hint').textContent, /快捷指令/);
    assert.equal(page.document.querySelector('#hero-download').href, '#downloads');
    assert.ok(page.document.querySelectorAll('[data-platform]').every(card => !card.classList.contains('is-platform')));
  });
}

for (const [platform, family] of [['MacIntel', 'mac'], ['Win32', 'windows']]) {
  test(`desktop ${platform} recommends the platform without guessing CPU architecture`, async () => {
    const page = await runPage({ navigator: { platform, maxTouchPoints: 0 } });
    assert.ok(page.document.querySelectorAll(`[data-platform="${family}"]`).every(card => card.classList.contains('is-platform')));
    assert.ok(page.document.querySelectorAll('[data-platform]').filter(card => card.attributes['data-platform'] !== family)
      .every(card => !card.classList.contains('is-platform')));
    if (family === 'mac') assert.match(page.document.querySelector('#platform-hint').textContent, /无法可靠判断芯片/);
  });
}

test('file and packaged protocols never request remote metadata', async () => {
  for (const protocol of ['file:', 'xhs:']) {
    const page = await runPage({ protocol });
    assert.equal(page.requests.length, 0);
    assert.deepEqual(snapshot(page.document), page.initial);
    assert.deepEqual(androidSnapshot(page.document), page.initialAndroid);
    assert.equal(page.timers.size, 0);
  }
});

test('FAQ hash links open the question on initial load and later navigation', async () => {
  const page = await runPage({ hash: '#faq-membership' });
  assert.equal(page.document.getElementById('faq-membership').open, true);
  page.location.hash = '#faq-install';
  page.listeners.get('hashchange')();
  assert.equal(page.document.getElementById('faq-install').open, true);
  page.location.hash = '#faq-android';
  page.listeners.get('hashchange')();
  assert.equal(page.document.getElementById('faq-android').open, true);
});

test('static Android APK, checksum and release links remain available without JavaScript', () => {
  const document = documentFixture();
  const android = androidSnapshot(document);
  assert.deepEqual(android.versions, ['v1.0.11']);
  assert.equal(android.apk, `${base}/download/android-v1.0.11/Brclio-XHS-Android-1.0.11-release.apk`);
  assert.equal(android.checksum, `${android.apk}.sha256`);
  assert.ok(android.releaseLinks.every(url => url === `${base}/tag/android-v1.0.11`));
  assert.equal(document.querySelector('[data-platform="android"]').attributes.id, 'android-download');
  assert.match(html, /Android 8\.0 或更新版本/);
  assert.match(html, /安卓当前提供单篇功能/);
  assert.match(html, /未知来源应用/);
  assert.doesNotMatch(html, /关闭.*(?:安全|防护)|禁用.*(?:安全|防护)/);
});

test('Android listing independently selects the highest stable semantic version, not the first published tag', async () => {
  const page = await runPage({ androidPayload: [
    androidRelease('1.2.0'), release('9.9.9'), { ...androidRelease('2.0.0'), draft: true },
    { ...androidRelease('3.0.0'), prerelease: true }, androidRelease('1.10.0'), androidRelease('1.9.0'),
  ] });
  const android = androidSnapshot(page.document);
  assert.equal(android.apk, `${base}/download/android-v1.10.0/Brclio-XHS-Android-1.10.0-release.apk`);
  assert.equal(android.checksum, `${android.apk}.sha256`);
  assert.equal(android.size, '7.5 MB');
  assert.deepEqual(android.versions, ['v1.10.0']);
  assert.ok(android.releaseLinks.every(url => url === `${base}/tag/android-v1.10.0`));
  assert.equal(android.date, '安卓发布于 2026.09.28');
  assert.match(page.document.querySelector('#android-release-status').textContent, /已核对安卓正式版 v1\.10\.0/);
  assert.ok(snapshot(page.document).versions.every(version => version === 'v2.1.0'));
  assert.equal(page.requests[1].url, `https://api.github.com/repos/${repository}/releases?per_page=100`);
  assert.equal(page.requests[1].options.credentials, 'omit');
  assert.equal(page.timers.size, 0);
});

const rejectedAndroidCases = {
  'HTTP failure': () => ({ androidHttpStatus: 503 }),
  'network failure': () => ({ androidFetchError: new Error('Offline') }),
  'non-list response': () => ({ androidPayload: androidRelease() }),
  'no Android release': () => ({ androidPayload: [release()] }),
  'draft': value => { value.draft = true; },
  'prerelease': value => { value.prerelease = true; },
  'missing stability flag': value => { delete value.prerelease; },
  'invalid semantic version': value => { value.tag_name = 'android-v1.2.3-beta.1'; },
  'leading-zero version': value => { value.tag_name = 'android-v01.2.3'; },
  'unsafe version number': value => { value.tag_name = 'android-v99999999999999999.0.0'; },
  'older version': () => ({ androidPayload: [androidRelease('0.9.0')] }),
  'unexpected release page': value => { value.html_url = 'https://evil.invalid/android'; },
  'duplicate release tag': value => ({ androidPayload: [value, structuredClone(value)] }),
  'missing APK': value => { value.assets.shift(); },
  'missing checksum': value => { value.assets.pop(); },
  'APK still uploading': value => { value.assets[0].state = 'open'; },
  'checksum still uploading': value => { value.assets[1].state = 'open'; },
  'untrusted APK URL': value => { value.assets[0].browser_download_url = 'https://evil.invalid/app.apk'; },
  'checksum redirect query': value => { value.assets[1].browser_download_url += '?redirect=evil'; },
  'mismatched APK name': value => { value.assets[0].name = 'app-debug.apk'; },
  'duplicate APK': value => { value.assets.push({ ...value.assets[0] }); },
  'duplicate checksum': value => { value.assets.push({ ...value.assets[1] }); },
  'zero-byte APK': value => { value.assets[0].size = 0; },
  'zero-byte checksum': value => { value.assets[1].size = 0; },
  'non-integer size': value => { value.assets[0].size = 1.5; },
  'invalid date': value => { value.published_at = 'invalid'; },
  'missing publication date': value => { value.published_at = null; },
  'non-array assets': value => { value.assets = {}; },
};

for (const [name, change] of Object.entries(rejectedAndroidCases)) {
  test(`Android preserves its complete static release on ${name}, while desktop refresh succeeds`, async () => {
    const payload = androidRelease();
    const options = change(payload) || {};
    const page = await runPage({ androidPayload: [payload], ...options });
    assert.deepEqual(androidSnapshot(page.document), page.initialAndroid);
    assert.match(page.document.querySelector('#android-release-status').textContent, /安卓版本信息暂未刷新/);
    assert.ok(snapshot(page.document).versions.every(version => version === 'v2.1.0'));
    assert.equal(page.timers.size, 0);
  });
}

test('an incomplete newest Android release cannot mix an older APK with a newer checksum', async () => {
  const latest = androidRelease('1.2.0');
  latest.assets.shift();
  const page = await runPage({ androidPayload: [androidRelease('1.1.0'), latest] });
  assert.deepEqual(androidSnapshot(page.document), page.initialAndroid);
});

test('an Android tag returned by desktop latest never changes the desktop version or download set', async () => {
  const page = await runPage({ payload: androidRelease() });
  assert.deepEqual(snapshot(page.document), page.initial);
  assert.deepEqual(androidSnapshot(page.document).versions, ['v1.1.0']);
});

test('a timeout in Android metadata does not block the independently refreshed desktop release', async () => {
  const page = await runPage({ androidHang: true });
  assert.ok(snapshot(page.document).versions.every(version => version === 'v2.1.0'));
  assert.equal(page.timers.size, 1);
  for (const timer of page.timers.values()) timer();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(androidSnapshot(page.document), page.initialAndroid);
  assert.equal(page.requests[1].options.signal.aborted, true);
  assert.equal(page.timers.size, 0);
});

for (const navigator of [
  { userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l', maxTouchPoints: 5 },
  { userAgent: 'Mozilla/5.0', userAgentData: { platform: 'Android' }, platform: 'Linux armv8l' },
]) test('Android browsers recommend only the Android card and link the primary CTA directly to it', async () => {
  const page = await runPage({ navigator });
  assert.match(page.document.querySelector('#platform-hint').textContent, /Android.*APK/);
  assert.equal(page.document.querySelector('#hero-download').href, '#android-download');
  assert.equal(page.document.querySelector('[data-platform="android"]').classList.contains('is-platform'), true);
  assert.ok(page.document.querySelectorAll('[data-platform]').filter(card => card.attributes['data-platform'] !== 'android')
    .every(card => !card.classList.contains('is-platform')));
});
