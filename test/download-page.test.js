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

function release(version = '1.9.0') {
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

function snapshot(document) {
  return {
    links: Object.fromEntries(Object.keys(suffixes).map(key => [key, document.querySelector(`[data-asset="${key}"]`).href])),
    sizes: Object.fromEntries(Object.keys(suffixes).map(key => [key, document.querySelector(`[data-size="${key}"]`).textContent])),
    versions: document.querySelectorAll('[data-release-version]').map(item => item.textContent),
    releaseLinks: document.querySelectorAll('[data-release-link]').map(item => item.href),
    date: document.querySelector('[data-release-date]').textContent,
  };
}

async function runPage({ payload = release(), fetchError, status = 200, navigator = {}, protocol = 'https:', hash = '', hang = false } = {}) {
  const document = documentFixture();
  const initial = snapshot(document);
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
      if (hang) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))));
      return { ok: status >= 200 && status < 300, json: async () => structuredClone(payload) };
    },
  });
  vm.runInContext(script, context, { filename: 'download.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { document, initial, requests, timers, listeners, location };
}

test('static download anchors point to one complete branded release', () => {
  const current = snapshot(documentFixture());
  const tag = current.versions[0];
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  for (const [key, suffix] of Object.entries(suffixes)) {
    assert.equal(current.links[key], `${base}/download/${tag}/Brclio-XHS-${tag.slice(1)}-${suffix}`);
    assert.match(current.sizes[key], /^(?:\d+\.\d MB|大小以发布附件为准)$/);
  }
  assert.ok(current.releaseLinks.every(url => url === `${base}/tag/${tag}`));
});

test('verified latest release updates every asset, size, version and release link together', async () => {
  const page = await runPage();
  const current = snapshot(page.document);
  for (const [index, [key, suffix]] of Object.entries(suffixes).entries()) {
    assert.equal(current.links[key], `${base}/download/v1.9.0/Brclio-XHS-1.9.0-${suffix}`);
    assert.equal(current.sizes[key], `${(140 + index).toFixed(1)} MB`);
  }
  assert.ok(current.versions.every(version => version === 'v1.9.0'));
  assert.ok(current.releaseLinks.every(url => url === `${base}/tag/v1.9.0`));
  assert.equal(current.date, '发布于 2026.09.24');
  assert.match(page.document.querySelector('#release-status').textContent, /已核对最新正式版 v1.9.0/);
  assert.equal(page.requests.length, 1);
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
  'pre-release version string': value => { value.tag_name = 'v1.9.0-beta.1'; },
  'older release': () => ({ payload: release('1.8.7') }),
  'untrusted release page': value => { value.html_url = 'https://evil.invalid/releases/tag/v1.9.0'; },
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
  assert.equal(page.timers.size, 1);
  [...page.timers.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.requests[0].options.signal.aborted, true);
  assert.deepEqual(snapshot(page.document), page.initial);
  assert.match(page.document.querySelector('#release-status').textContent, /版本信息暂未刷新/);
  assert.equal(page.timers.size, 0);
});

for (const navigator of [
  { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 },
  { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 },
  { userAgent: 'Mozilla/5.0 (Linux; Android 15)', userAgentData: { platform: 'Android' }, platform: 'Linux armv8l', maxTouchPoints: 5 },
]) {
  test(`mobile browser receives no desktop platform recommendation: ${navigator.platform}`, async () => {
    const page = await runPage({ navigator });
    assert.match(page.document.querySelector('#platform-hint').textContent, /移动设备/);
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
    assert.equal(page.timers.size, 0);
  }
});

test('FAQ hash links open the question on initial load and later navigation', async () => {
  const page = await runPage({ hash: '#faq-membership' });
  assert.equal(page.document.getElementById('faq-membership').open, true);
  page.location.hash = '#faq-install';
  page.listeners.get('hashchange')();
  assert.equal(page.document.getElementById('faq-install').open, true);
});
