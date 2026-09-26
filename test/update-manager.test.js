import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateManager, LATEST_RELEASE_URL, allowedAssetRedirect, checksumFromManifest,
  compareVersions, createElectronUpdateFetch, installerName, parseRelease } from '../desktop/update-manager.js';

const content = Buffer.from('fake installer bytes for network and integrity tests');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const defaults = { currentVersion: '1.6.0', platform: 'darwin', arch: 'arm64' };

function mockElectronNet(onEnd) {
  const requests = [];
  return { requests, request(options) {
    const request = new EventEmitter();
    request.options = options;
    request.abortCount = 0;
    request.abort = () => { request.abortCount++; request.emit('error', new Error('Redirect was cancelled')); };
    request.end = () => queueMicrotask(() => onEnd(request));
    requests.push(request);
    return request;
  } };
}

test('Electron transport exposes a manual redirect without following it or rejecting on cancellation', async () => {
  const net = mockElectronNet(request => request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/file', {}));
  const response = await createElectronUpdateFetch(net)('https://github.com/file', { headers: { Accept: 'application/octet-stream' } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://release-assets.githubusercontent.com/file');
  assert.equal(net.requests.length, 1);
  assert.equal(net.requests[0].abortCount, 1);
  assert.equal(net.requests[0].options.redirect, 'manual');
  assert.equal(net.requests[0].options.credentials, 'omit');
  assert.equal(net.requests[0].options.useSessionCookies, false);
});

test('Electron transport streams response bytes even when request close occurs before headers', async () => {
  const net = mockElectronNet(request => {
    request.emit('close');
    const incoming = Readable.from([Buffer.from('one'), Buffer.from('two')]);
    incoming.statusCode = 200;
    incoming.headers = { 'content-length': ['6'] };
    request.emit('response', incoming);
  });
  const response = await createElectronUpdateFetch(net)('https://github.com/file');
  assert.equal(response.headers.get('content-length'), '6');
  assert.equal(await response.text(), 'onetwo');
});

test('Electron transport cancellation aborts both pending headers and an active body', async () => {
  const pending = mockElectronNet(() => {});
  const beforeHeaders = new AbortController();
  const fetch = createElectronUpdateFetch(pending)('https://github.com/file', { signal: beforeHeaders.signal });
  beforeHeaders.abort(new Error('canceled before headers'));
  await assert.rejects(fetch, /canceled before headers/);
  assert.equal(pending.requests[0].abortCount, 1);

  const streaming = mockElectronNet(request => {
    const incoming = new Readable({ read() {} });
    incoming.statusCode = 200;
    incoming.headers = {};
    request.emit('response', incoming);
    incoming.push(Buffer.from('chunk'));
  });
  const controller = new AbortController();
  const response = await createElectronUpdateFetch(streaming)('https://github.com/file', { signal: controller.signal });
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'chunk');
  controller.abort(new Error('canceled body'));
  await assert.rejects(reader.read(), /canceled body/);
  assert.equal(streaming.requests[0].abortCount, 1);
});

test('Electron transport handles bodyless status responses without an uncaught callback error', async () => {
  const net = mockElectronNet(request => {
    const incoming = Readable.from([]);
    incoming.statusCode = 204;
    incoming.headers = {};
    request.emit('response', incoming);
  });
  const response = await createElectronUpdateFetch(net)('https://github.com/file');
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
});

function release({ version = '1.7.0', platform = 'darwin', arch = 'arm64', digest = `sha256:${sha256(content)}`, filenamePrefix = 'Brclio-XHS-' } = {}) {
  const preferredName = installerName(version, platform, arch);
  const name = preferredName.replace(/^Brclio-XHS-/, filenamePrefix);
  const prefix = `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v${version}/`;
  const checksum = `${sha256(content)}  ${name}\n`;
  return { tag_name: `v${version}`, draft: false, prerelease: false,
    html_url: `https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v${version}`,
    body: 'Release notes', published_at: '2026-09-20T00:00:00Z',
    assets: [{ name, size: content.length, browser_download_url: `${prefix}${name}`, digest },
      { name: 'SHA256SUMS.txt', size: Buffer.byteLength(checksum), browser_download_url: `${prefix}SHA256SUMS.txt` }] };
}

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'xhs-update-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const releases = options.release || release();
  const manager = new UpdateManager({ ...defaults, directory, ...options,
    fetchImpl: async (url, init) => {
      requests.push(url);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.method, 'GET');
      if (options.fetchImpl) return options.fetchImpl(url, init);
      if (url === LATEST_RELEASE_URL) return Response.json(releases);
      if (url.endsWith('SHA256SUMS.txt')) return new Response(`${sha256(content)}  ${releases.assets[0].name}\n`);
      return new Response(content, { headers: { 'content-length': String(content.length) } });
    }
  });
  return { manager, directory, requests, release: releases };
}

function partialFile(f, latest = f.release) {
  const asset = latest.assets[0];
  return path.join(f.directory, `${asset.name}.${asset.digest.slice('sha256:'.length)}.partial`);
}

function rangedResponse(offset, bytes = content) {
  return new Response(bytes.subarray(offset), { status: 206, headers: {
    'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
    'content-length': String(bytes.length - offset)
  } });
}

test('semantic versions and platform asset selection reject unsupported or nonstable values', () => {
  assert.equal(compareVersions('1.10.0', '1.9.20'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.5.0', '1.6.0'), -1);
  for (const version of ['1.6.0-beta', '01.6.0', 'v1.6.0', '1.6', '../1.0.0']) {
    assert.throws(() => compareVersions(version, '1.6.0'));
  }
  assert.equal(installerName('1.7.0', 'darwin', 'arm64'), 'Brclio-XHS-1.7.0-mac-arm64.dmg');
  assert.equal(installerName('1.7.0', 'darwin', 'x64'), 'Brclio-XHS-1.7.0-mac-x64.dmg');
  assert.equal(installerName('1.7.0', 'win32', 'x64'), 'Brclio-XHS-1.7.0-windows-x64-setup.exe');
  assert.throws(() => installerName('1.7.0', 'win32', 'arm64'));
});

test('only stable releases and exact project installer URLs are accepted', () => {
  const mutations = [
    value => { value.draft = true; }, value => { value.prerelease = true; },
    value => { value.tag_name = 'v1.7.0-beta'; },
    value => { value.html_url = 'https://github.com/other/project/releases/tag/v1.7.0'; },
    value => { value.assets[0].browser_download_url = 'http://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v1.7.0/test.dmg'; },
    value => { value.assets[0].browser_download_url = value.assets[0].browser_download_url.replace('github.com/', 'github.com.evil.test/'); },
    value => { value.assets[0].browser_download_url += '?redirect=evil'; },
    value => { value.assets[0].browser_download_url = value.assets[0].browser_download_url.replace('https://', 'https://user@'); },
    value => { value.assets[0].size = 0; }, value => { value.assets[0].size = 3 * 1024 ** 3; },
    value => { value.assets[0].digest = 'sha1:123'; },
    value => { value.assets.push(value.assets[0]); },
    value => { value.assets[0].name = '../fake.dmg'; }
  ];
  for (const mutate of mutations) { const value = release(); mutate(value); assert.throws(() => parseRelease(value, defaults)); }
  assert.equal(parseRelease(release(), defaults).candidate.sha256, sha256(content));
});

test('current installers take priority over both historical filenames regardless of asset order', () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    const value = release({ platform, arch });
    const preferred = value.assets[0];
    for (const filenamePrefix of ['Brclio-XHS-Downloader-', 'XHS-Downloader-']) {
      value.assets.unshift(release({ platform, arch, filenamePrefix, digest: `sha256:${'a'.repeat(64)}` }).assets[0]);
    }
    for (const assets of [value.assets, [...value.assets].reverse()]) {
      const { candidate } = parseRelease({ ...value, assets }, { ...defaults, platform, arch });
      assert.equal(candidate.name, preferred.name);
      assert.equal(candidate.url, preferred.browser_download_url);
      assert.equal(candidate.sha256, sha256(content));
    }
  }
});

test('both historical filenames remain available on every supported platform when current names are absent', () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    for (const filenamePrefix of ['Brclio-XHS-Downloader-', 'XHS-Downloader-']) {
      const value = release({ platform, arch, filenamePrefix });
      const { candidate } = parseRelease(value, { ...defaults, platform, arch });
      assert.equal(candidate.name, value.assets[0].name);
      assert.equal(candidate.url, value.assets[0].browser_download_url);
      assert.equal(candidate.sha256, sha256(content));
    }
  }
});

test('previous branded filenames take priority over original filenames when current names are absent', () => {
  const value = release({ filenamePrefix: 'Brclio-XHS-Downloader-' });
  const preferred = value.assets[0];
  value.assets.unshift(release({ filenamePrefix: 'XHS-Downloader-', digest: `sha256:${'a'.repeat(64)}` }).assets[0]);
  for (const assets of [value.assets, [...value.assets].reverse()]) {
    assert.equal(parseRelease({ ...value, assets }, defaults).candidate.name, preferred.name);
  }
});

test('invalid or duplicate preferred assets never fall back to a valid historical installer', () => {
  for (const [mutate, code] of [
    [value => { value.assets[0].browser_download_url = 'https://evil.example/installer.dmg'; }, 'UNTRUSTED_URL'],
    [value => { value.assets[0].browser_download_url = value.assets.at(-1).browser_download_url; }, 'UNTRUSTED_URL'],
    [value => { value.assets[0].size = 0; }, 'INVALID_ASSET'],
    [value => { value.assets[0].digest = 'sha256:invalid'; }, 'INVALID_CHECKSUM'],
    [value => { value.assets.push({ ...value.assets[0] }); }, 'ASSET_NOT_FOUND'],
    [value => { value.assets[0].digest = null; value.assets = value.assets.filter(asset => asset.name !== 'SHA256SUMS.txt'); }, 'ASSET_NOT_FOUND'],
    [value => { value.assets[0].digest = null; value.assets.push({ ...value.assets[1] }); }, 'ASSET_NOT_FOUND']
  ]) {
    for (const filenamePrefix of ['Brclio-XHS-', 'Brclio-XHS-Downloader-']) {
      const value = release({ filenamePrefix });
      if (filenamePrefix === 'Brclio-XHS-') value.assets.push(release({ filenamePrefix: 'Brclio-XHS-Downloader-' }).assets[0]);
      value.assets.push(release({ filenamePrefix: 'XHS-Downloader-' }).assets[0]);
      mutate(value);
      assert.throws(() => parseRelease(value, defaults), { code });
    }
  }
});

test('legacy fallback still rejects malicious URLs, invalid checksums and duplicate installers', () => {
  for (const [mutate, code] of [
    [value => { value.assets[0].browser_download_url += '?redirect=evil'; }, 'UNTRUSTED_URL'],
    [value => { value.assets[0].browser_download_url = value.assets[0].browser_download_url.replace('Brclio/', 'other/'); }, 'UNTRUSTED_URL'],
    [value => { value.assets[0].digest = 'sha1:123'; }, 'INVALID_CHECKSUM'],
    [value => { value.assets.push({ ...value.assets[0] }); }, 'ASSET_NOT_FOUND']
  ]) {
    const value = release({ filenamePrefix: 'XHS-Downloader-' });
    mutate(value);
    assert.throws(() => parseRelease(value, defaults), { code });
  }
});

test('asset redirects only permit HTTPS GitHub release CDNs, never arbitrary hosts or another repository', () => {
  const initial = release().assets[0].browser_download_url;
  assert.equal(allowedAssetRedirect('https://release-assets.githubusercontent.com/file?token=opaque', initial), 'https://release-assets.githubusercontent.com/file?token=opaque');
  for (const url of ['http://release-assets.githubusercontent.com/file', 'https://release-assets.githubusercontent.com.evil.test/file',
    'https://127.0.0.1/file', 'file:///tmp/fake.dmg', 'https://github.com/other/repo/releases/download/v1.7.0/fake.dmg',
    'https://user:password@objects.githubusercontent.com/file']) assert.throws(() => allowedAssetRedirect(url, initial));
});

test('checksum manifests require exactly one exact basename match', () => {
  const name = release().assets[0].name;
  assert.equal(checksumFromManifest(`\uFEFF${sha256(content)} *${name}\r\n`, name), sha256(content));
  assert.throws(() => checksumFromManifest(`${sha256(content)}  ../${name}\n`, name));
  assert.throws(() => checksumFromManifest(`${sha256(content)}  ${name}\n${sha256(content)}  ${name}\n`, name));
  assert.throws(() => checksumFromManifest('invalid', name));
});

test('checking only fetches metadata, publishes no local path, and selects the platform installer', async t => {
  const f = await fixture(t, { platform: 'win32', arch: 'x64', portable: true, release: release({ platform: 'win32', arch: 'x64' }) });
  assert.equal(f.manager.snapshot().status, 'idle');
  const state = await f.manager.checkForUpdates();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, '1.7.0');
  assert.match(state.installationHint, /便携版.*安装版/);
  assert.deepEqual(f.requests, [LATEST_RELEASE_URL]);
  assert.ok(!JSON.stringify(state).includes(f.directory));
  assert.ok(!JSON.stringify(state).includes('browser_download_url'));
  assert.equal(state.error, null);
});

test('equal and older releases never offer a downgrade or require installer assets', async t => {
  for (const version of ['1.6.0', '1.5.0']) {
    const latest = release({ version }); latest.assets = [];
    const { manager } = await fixture(t, { release: latest });
    assert.equal((await manager.checkForUpdates()).status, 'up-to-date');
    assert.equal((await manager.downloadUpdate()).error.code, 'CHECK_REQUIRED');
  }
});

test('metadata failures are retryable without leaking network errors', async t => {
  let response = () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  const { manager } = await fixture(t, { fetchImpl: () => response() });
  assert.equal((await manager.checkForUpdates()).error.code, 'RATE_LIMITED');
  response = () => { throw new Error('secret URL and personal path'); };
  assert.equal((await manager.checkForUpdates()).error.code, 'NETWORK_ERROR');
  assert.ok(!JSON.stringify(manager.snapshot()).includes('secret'));
  response = () => new Response('{bad json');
  assert.equal((await manager.checkForUpdates()).error.code, 'INVALID_RELEASE');
  response = () => Response.json(release());
  assert.equal((await manager.checkForUpdates()).status, 'available');
});

test('a failed metadata refresh keeps the known installer directly downloadable', async t => {
  for (const failure of [
    () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    () => new Response('', { status: 429 }),
    () => { throw new Error('offline'); },
    () => new Response('{invalid json')
  ]) {
    let failCheck = false;
    const latest = release();
    const f = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL
      ? failCheck ? failure() : Response.json(latest) : new Response(content) });
    const found = await f.manager.checkForUpdates();
    failCheck = true;
    const refreshed = await f.manager.checkForUpdates();
    assert.equal(refreshed.status, 'available');
    assert.equal(refreshed.error, null);
    assert.equal(refreshed.checkError.phase, 'check');
    assert.equal(refreshed.latestVersion, found.latestVersion);
    assert.equal(refreshed.releaseNotes, found.releaseNotes);
    assert.deepEqual(refreshed.download, found.download);
    const beforeDownload = f.requests.length;
    const downloaded = await f.manager.downloadUpdate();
    assert.equal(downloaded.status, 'downloaded');
    assert.equal(downloaded.checkError, null);
    assert.deepEqual(f.requests.slice(beforeDownload), [latest.assets[0].browser_download_url]);
    assert.deepEqual(await readFile(path.join(f.directory, latest.assets[0].name)), content);
  }
});

test('a limited version query cannot discard partial bytes or force another query before resume', async t => {
  const offset = 11;
  const latest = release();
  let checks = 0, downloads = 0;
  const f = await fixture(t, { fetchImpl: (url, init) => {
    if (url === LATEST_RELEASE_URL) return ++checks === 1 ? Response.json(latest) : new Response('', { status: 429 });
    assert.equal(url, latest.assets[0].browser_download_url);
    if (++downloads === 1) return new Response(content.subarray(0, offset));
    assert.equal(new Headers(init.headers).get('range'), `bytes=${offset}-`);
    return rangedResponse(offset);
  } });
  await f.manager.checkForUpdates();
  const interrupted = await f.manager.downloadUpdate();
  assert.equal(interrupted.error.phase, 'download');
  assert.equal(interrupted.download.receivedBytes, offset);
  const limited = await f.manager.checkForUpdates();
  assert.equal(limited.status, 'available');
  assert.equal(limited.checkError.code, 'RATE_LIMITED');
  assert.deepEqual(limited.download, interrupted.download);
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.equal(checks, 2);
  assert.equal(downloads, 2);
  assert.deepEqual(await readFile(path.join(f.directory, latest.assets[0].name)), content);
});

test('manifest-only known releases download their checksum attachment without querying latest again', async t => {
  const latest = release({ digest: null });
  let checks = 0;
  const f = await fixture(t, { fetchImpl: url => {
    if (url === LATEST_RELEASE_URL) return ++checks === 1 ? Response.json(latest) : new Response('', { status: 429 });
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${sha256(content)}  ${latest.assets[0].name}\n`);
    return new Response(content);
  } });
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.checkForUpdates()).status, 'available');
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(f.requests.slice(2), [latest.assets[1].browser_download_url, latest.assets[0].browser_download_url]);
});

test('an incomplete refresh never pairs old release metadata with a new candidate', async t => {
  const original = release();
  const newer = release({ version: '1.8.0', digest: null });
  let checks = 0;
  const f = await fixture(t, { fetchImpl: url => {
    if (url === LATEST_RELEASE_URL) return Response.json(++checks === 1 ? original : newer);
    if (url.endsWith('SHA256SUMS.txt')) return new Response('', { status: 429 });
    assert.equal(url, original.assets[0].browser_download_url);
    return new Response(content);
  } });
  await f.manager.checkForUpdates();
  const candidate = f.manager.candidate;
  await writeFile(path.join(f.directory, `${newer.assets[0].name}.${sha256(content)}.partial`), content.subarray(0, 5));
  const failed = await f.manager.checkForUpdates();
  assert.equal(failed.status, 'available');
  assert.equal(failed.latestVersion, '1.7.0');
  assert.equal(f.manager.candidate, candidate);
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
});

test('a successful refresh clears its previous warning and adopts the newer release', async t => {
  let checks = 0;
  const f = await fixture(t, { fetchImpl: () => ++checks === 2
    ? new Response('', { status: 429 }) : Response.json(release({ version: checks === 1 ? '1.7.0' : '1.8.0' })) });
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.checkForUpdates()).checkError.code, 'RATE_LIMITED');
  const refreshed = await f.manager.checkForUpdates();
  assert.equal(refreshed.latestVersion, '1.8.0');
  assert.equal(refreshed.checkError, null);
  assert.equal(f.manager.candidate.version, '1.8.0');
});

test('forbidden responses are not all rate limits and file errors ask for a download retry', async t => {
  const f = await fixture(t, { fetchImpl: () => new Response('', { status: 403 }) });
  const denied = await f.manager.checkForUpdates();
  assert.equal(denied.status, 'error');
  assert.equal(denied.error.code, 'ACCESS_DENIED');
  assert.equal(denied.checkError, null);
  for (const [status, headers, code] of [
    [403, {}, 'ACCESS_DENIED'], [429, {}, 'RATE_LIMITED'],
    [403, { 'retry-after': '60' }, 'RATE_LIMITED']
  ]) {
    const g = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL
      ? Response.json(release()) : new Response('', { status, headers }) });
    await g.manager.checkForUpdates();
    const failed = await g.manager.downloadUpdate();
    assert.equal(failed.status, 'error');
    assert.equal(failed.error.phase, 'download');
    assert.equal(failed.error.code, code);
    assert.match(failed.error.message, /重试下载/);
    assert.doesNotMatch(failed.error.message, /检查更新/);
  }
});

test('metadata timeouts and redirects fail closed', async t => {
  const f = await fixture(t, { networkTimeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  assert.equal((await f.manager.checkForUpdates()).error.code, 'TIMEOUT');
  const g = await fixture(t, { fetchImpl: () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }) });
  assert.equal((await g.manager.checkForUpdates()).error.code, 'UNTRUSTED_REDIRECT');
});

test('download follows a checked redirect, streams progress, and atomically retains only verified bytes', async t => {
  const updates = [];
  const f = await fixture(t, { onUpdate: state => updates.push(state), fetchImpl: url => {
    if (url === LATEST_RELEASE_URL) return Response.json(release());
    if (url.includes('github.com/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset?token=opaque' } });
    return new Response(content, { headers: { 'content-length': String(content.length) } });
  } });
  await f.manager.checkForUpdates();
  const state = await f.manager.downloadUpdate();
  assert.equal(state.status, 'downloaded');
  assert.equal(state.download.percent, 100);
  assert.ok(updates.some(value => value.status === 'downloading' && value.download.receivedBytes > 0));
  const files = await readdir(f.directory);
  assert.deepEqual(files, [release().assets[0].name]);
  assert.deepEqual(await readFile(path.join(f.directory, files[0])), content);
  assert.ok(!JSON.stringify(state).includes('token=opaque'));
});

test('missing asset digest uses the release SHA256SUMS, and absent trust data is rejected', async t => {
  const f = await fixture(t, { release: release({ digest: null }) });
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.ok(f.requests.some(url => url.endsWith('SHA256SUMS.txt')));
  const invalid = release({ digest: null }); invalid.assets.pop();
  assert.throws(() => parseRelease(invalid, defaults), /校验文件/);
});

test('each historical filename downloads only when verified by its exact manifest entry', async t => {
  for (const filenamePrefix of ['Brclio-XHS-Downloader-', 'XHS-Downloader-']) {
    const latest = release({ filenamePrefix, digest: null });
    const f = await fixture(t, { release: latest });
    assert.equal((await f.manager.checkForUpdates()).status, 'available');
    assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
    assert.deepEqual(await readdir(f.directory), [latest.assets[0].name]);
    assert.deepEqual(await readFile(path.join(f.directory, latest.assets[0].name)), content);
    assert.ok(f.requests.includes(latest.assets[0].browser_download_url));
  }
});

test('a historical checksum cannot authorize a current installer or trigger a download fallback', async t => {
  const latest = release({ digest: null });
  const legacy = release({ filenamePrefix: 'XHS-Downloader-' }).assets[0];
  latest.assets.push(legacy);
  const checksum = `${sha256(content)}  ${legacy.name}\n`;
  latest.assets[1].size = Buffer.byteLength(checksum);
  const f = await fixture(t, { release: latest, fetchImpl: url => url === LATEST_RELEASE_URL
    ? Response.json(latest) : new Response(checksum) });
  assert.equal((await f.manager.checkForUpdates()).status, 'available');
  const result = await f.manager.downloadUpdate();
  assert.equal(result.error.code, 'INVALID_CHECKSUM');
  assert.deepEqual(f.requests, [LATEST_RELEASE_URL, latest.assets[1].browser_download_url]);
  assert.deepEqual(await readdir(f.directory), []);
});

test('invalid manifest stops before requesting the installer', async t => {
  const latest = release({ digest: null });
  const f = await fixture(t, { release: latest, fetchImpl: url => url === LATEST_RELEASE_URL
    ? Response.json(latest) : new Response('bad checksum') });
  await f.manager.checkForUpdates();
  const state = await f.manager.downloadUpdate();
  assert.equal(state.status, 'error');
  assert.equal(state.error.phase, 'download');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await readdir(f.directory), []);
});

test('hash failures delete partial data and allow a full retry', async t => {
  let bad = true;
  const f = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL ? Response.json(release())
    : new Response(bad ? Buffer.alloc(content.length, 33) : content) });
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).error.code, 'HASH_MISMATCH');
  assert.deepEqual(await readdir(f.directory), []);
  bad = false;
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
});

test('declared and overflowing download lengths reject the file', async t => {
  for (const body of [new Response(content, { headers: { 'content-length': String(content.length + 1) } }),
    new Response(Buffer.concat([content, Buffer.from('extra')]))]) {
    const f = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL ? Response.json(release()) : body });
    await f.manager.checkForUpdates();
    assert.equal((await f.manager.downloadUpdate()).error.code, 'SIZE_MISMATCH');
    assert.deepEqual(await readdir(f.directory), []);
  }
});

test('an early end of the response retains the prefix and reports a resumable incomplete download', async t => {
  const f = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL ? Response.json(release())
    : new Response(content.subarray(0, 3), { headers: { 'content-length': String(content.length) } }) });
  await f.manager.checkForUpdates();
  const state = await f.manager.downloadUpdate();
  assert.equal(state.error.code, 'DOWNLOAD_INCOMPLETE');
  assert.equal(state.error.phase, 'download');
  assert.equal(state.canRetry, true);
  assert.equal(state.download.receivedBytes, 3);
  assert.equal(state.download.canResume, true);
  assert.deepEqual(await readdir(f.directory), [path.basename(partialFile(f))]);
  assert.deepEqual(await readFile(partialFile(f)), content.subarray(0, 3));
});

test('unexpected asset redirection never downloads from the foreign destination', async t => {
  const f = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL ? Response.json(release())
    : new Response(null, { status: 302, headers: { location: 'https://evil.test/fake.exe' } }) });
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).error.code, 'UNTRUSTED_REDIRECT');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await readdir(f.directory), []);
});

test('canceling an in-flight stream retains its partial file and preserves release metadata', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { onUpdate: state => { if (state.download.receivedBytes > 0) started(); }, fetchImpl: url => {
    if (url === LATEST_RELEASE_URL) return Response.json(release());
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(content.subarray(0, 5)); } }));
  } });
  await f.manager.checkForUpdates();
  const work = f.manager.downloadUpdate();
  await ready;
  const state = await f.manager.cancelUpdateDownload();
  await work;
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, '1.7.0');
  assert.equal(state.download.receivedBytes, 5);
  assert.equal(state.download.canResume, true);
  assert.deepEqual(await readdir(f.directory), [path.basename(partialFile(f))]);
  assert.deepEqual(await readFile(partialFile(f)), content.subarray(0, 5));
});

test('stalled body download times out and retains partial bytes', async t => {
  const f = await fixture(t, { networkTimeoutMs: 20, fetchImpl: url => url === LATEST_RELEASE_URL
    ? Response.json(release()) : new Response(new ReadableStream({ start(controller) { controller.enqueue(content.subarray(0, 5)); } })) });
  await f.manager.checkForUpdates();
  const state = await f.manager.downloadUpdate();
  assert.equal(state.error.code, 'TIMEOUT');
  assert.equal(state.download.receivedBytes, 5);
  assert.equal(state.download.canResume, true);
  assert.deepEqual(await readdir(f.directory), [path.basename(partialFile(f))]);
  assert.deepEqual(await readFile(partialFile(f)), content.subarray(0, 5));
});

test('a network interruption retries from the persisted byte offset and verifies the complete installer', async t => {
  const offset = 11;
  const ranges = [];
  let streamController;
  let interrupted = false;
  const f = await fixture(t, { onUpdate: state => {
    if (!interrupted && streamController && state.download.receivedBytes === offset) {
      interrupted = true;
      streamController.error(new Error('network connection reset'));
    }
  }, fetchImpl: (url, init) => {
    if (url === LATEST_RELEASE_URL) return Response.json(release());
    ranges.push(new Headers(init.headers).get('range'));
    if (ranges.length > 1) return rangedResponse(offset);
    return new Response(new ReadableStream({ start(controller) {
      streamController = controller;
      controller.enqueue(content.subarray(0, offset));
    } }));
  } });
  await f.manager.checkForUpdates();
  const failed = await f.manager.downloadUpdate();
  assert.equal(failed.error.code, 'NETWORK_ERROR');
  assert.equal(failed.download.receivedBytes, offset);
  assert.equal(failed.download.canResume, true);
  assert.deepEqual(await readFile(partialFile(f)), content.subarray(0, offset));
  const completed = await f.manager.downloadUpdate();
  assert.equal(completed.status, 'downloaded');
  assert.equal(completed.download.canResume, false);
  assert.deepEqual(ranges, [null, `bytes=${offset}-`]);
  assert.deepEqual(await readdir(f.directory), [f.release.assets[0].name]);
  assert.deepEqual(await readFile(path.join(f.directory, f.release.assets[0].name)), content);
});

test('shutdown keeps progress that a fresh manager discovers and resumes after checking release metadata', async t => {
  const offset = 9;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const ranges = [];
  const f = await fixture(t, { onUpdate: state => { if (state.download.receivedBytes === offset) started(); },
    fetchImpl: (url, init) => {
      if (url === LATEST_RELEASE_URL) return Response.json(release());
      ranges.push(new Headers(init.headers).get('range'));
      return ranges.length === 1 ? new Response(new ReadableStream({ start(controller) {
        controller.enqueue(content.subarray(0, offset));
      } })) : rangedResponse(offset);
    }
  });
  await f.manager.checkForUpdates();
  const work = f.manager.downloadUpdate();
  await ready;
  await f.manager.shutdown();
  await work;
  const restarted = new UpdateManager({ ...defaults, directory: f.directory, fetchImpl: f.manager.fetchImpl });
  const available = await restarted.checkForUpdates();
  assert.equal(available.status, 'available');
  assert.equal(available.download.receivedBytes, offset);
  assert.equal(available.download.canResume, true);
  assert.equal((await restarted.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(ranges, [null, `bytes=${offset}-`]);
  assert.deepEqual(await readFile(path.join(f.directory, f.release.assets[0].name)), content);
});

test('manifest-only releases restore resumable progress on recheck and after a process restart', async t => {
  const latest = release({ digest: null });
  const offset = 9;
  const ranges = [];
  const f = await fixture(t, { release: latest, fetchImpl: (url, init) => {
    if (url === LATEST_RELEASE_URL) return Response.json(latest);
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${sha256(content)}  ${latest.assets[0].name}\n`);
    ranges.push(new Headers(init.headers).get('range'));
    return ranges.length === 1 ? new Response(content.subarray(0, offset)) : rangedResponse(offset);
  } });
  await f.manager.checkForUpdates();
  assert.deepEqual(f.requests, [LATEST_RELEASE_URL], 'a fresh check does not need to download a manifest');
  assert.equal((await f.manager.downloadUpdate()).error.code, 'DOWNLOAD_INCOMPLETE');
  const rechecked = await f.manager.checkForUpdates();
  assert.equal(rechecked.download.receivedBytes, offset);
  assert.equal(rechecked.download.canResume, true);
  const restarted = new UpdateManager({ ...defaults, directory: f.directory, fetchImpl: f.manager.fetchImpl });
  const restored = await restarted.checkForUpdates();
  assert.equal(restored.status, 'available');
  assert.equal(restored.download.receivedBytes, offset);
  assert.equal(restored.download.canResume, true);
  assert.equal((await restarted.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(ranges, [null, `bytes=${offset}-`]);
  assert.deepEqual(await readFile(path.join(f.directory, latest.assets[0].name)), content);
});

test('a changed manifest checksum cannot authorize old partial bytes for the same installer name and size', async t => {
  const latest = release({ digest: null });
  const offset = 9;
  let bytes = content;
  const ranges = [];
  const f = await fixture(t, { release: latest, fetchImpl: (url, init) => {
    if (url === LATEST_RELEASE_URL) return Response.json(latest);
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${sha256(bytes)}  ${latest.assets[0].name}\n`);
    ranges.push(new Headers(init.headers).get('range'));
    return new Response(ranges.length === 1 ? bytes.subarray(0, offset) : bytes);
  } });
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).error.code, 'DOWNLOAD_INCOMPLETE');
  bytes = Buffer.alloc(content.length, 65);
  const restarted = new UpdateManager({ ...defaults, directory: f.directory, fetchImpl: f.manager.fetchImpl });
  const available = await restarted.checkForUpdates();
  assert.equal(available.status, 'available');
  assert.equal(available.download.receivedBytes, 0);
  assert.equal(available.download.canResume, false);
  assert.equal((await restarted.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(ranges, [null, null]);
  assert.deepEqual(await readFile(partialFile(f, release())), content.subarray(0, offset));
  assert.deepEqual(await readFile(path.join(f.directory, latest.assets[0].name)), bytes);
});

test('saved progress is never reused for a different checksum, version, or installer asset', async t => {
  for (const change of ['checksum', 'version', 'asset']) {
    const oldRelease = release();
    const nextBytes = change === 'checksum' ? Buffer.alloc(content.length, 65) : content;
    const nextRelease = release({ version: change === 'version' ? '1.8.0' : '1.7.0',
      filenamePrefix: change === 'asset' ? 'XHS-Downloader-' : 'Brclio-XHS-', digest: `sha256:${sha256(nextBytes)}` });
    const ranges = [];
    const f = await fixture(t, { release: nextRelease, fetchImpl: (url, init) => {
      if (url === LATEST_RELEASE_URL) return Response.json(nextRelease);
      ranges.push(new Headers(init.headers).get('range'));
      return new Response(nextBytes);
    } });
    await writeFile(partialFile(f, oldRelease), content.subarray(0, 7));
    const available = await f.manager.checkForUpdates();
    assert.equal(available.download.receivedBytes, 0, change);
    assert.equal(available.download.canResume, false, change);
    assert.equal((await f.manager.downloadUpdate()).status, 'downloaded', change);
    assert.deepEqual(ranges, [null], change);
    assert.deepEqual(await readFile(partialFile(f, oldRelease)), content.subarray(0, 7), change);
    assert.deepEqual(await readFile(path.join(f.directory, nextRelease.assets[0].name)), nextBytes, change);
  }
});

test('a server that ignores Range replaces the saved prefix with its complete 200 response', async t => {
  const offset = 8;
  const ranges = [];
  const f = await fixture(t, { fetchImpl: (url, init) => {
    if (url === LATEST_RELEASE_URL) return Response.json(release());
    ranges.push(new Headers(init.headers).get('range'));
    return new Response(content, { headers: { 'content-length': String(content.length) } });
  } });
  await writeFile(partialFile(f), Buffer.alloc(offset, 90));
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(ranges, [`bytes=${offset}-`]);
  assert.deepEqual(await readFile(path.join(f.directory, f.release.assets[0].name)), content);
  assert.deepEqual(await readdir(f.directory), [f.release.assets[0].name]);
});

test('a 416 response retries a full request without Range and replaces the saved prefix', async t => {
  const offset = 8;
  const ranges = [];
  const f = await fixture(t, { fetchImpl: (url, init) => {
    if (url === LATEST_RELEASE_URL) return Response.json(release());
    ranges.push(new Headers(init.headers).get('range'));
    return ranges.length === 1 ? new Response(null, { status: 416, headers: { 'content-range': `bytes */${content.length}` } })
      : new Response(content, { headers: { 'content-length': String(content.length) } });
  } });
  await writeFile(partialFile(f), Buffer.alloc(offset, 90));
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(ranges, [`bytes=${offset}-`, null]);
  assert.deepEqual(await readFile(path.join(f.directory, f.release.assets[0].name)), content);
});

test('short file writes preserve the complete installer after a full restart or a ranged continuation', async t => {
  for (const responseMode of ['200', '416', '206']) {
    const offset = 8;
    let requests = 0, writes = 0;
    const f = await fixture(t, { fetchImpl: url => {
      if (url === LATEST_RELEASE_URL) return Response.json(release());
      requests++;
      if (responseMode === '416' && requests === 1) return new Response(null, { status: 416 });
      return responseMode === '206' ? rangedResponse(offset) : new Response(content);
    } });
    await writeFile(partialFile(f), responseMode === '206' ? content.subarray(0, offset) : Buffer.alloc(offset, 90));
    const probe = await open(partialFile(f), 'r');
    const prototype = Object.getPrototypeOf(probe);
    const originalWrite = prototype.write;
    await probe.close();
    await f.manager.checkForUpdates();
    const write = t.mock.method(prototype, 'write', function (buffer, start, length, position) {
      writes++;
      assert.equal(Number.isSafeInteger(position), true, 'download writes cannot depend on a platform-specific append cursor');
      return originalWrite.call(this, buffer, start, Math.min(length, 3), position);
    });
    try {
      const state = await f.manager.downloadUpdate();
      assert.equal(state.status, 'downloaded', JSON.stringify({ responseMode, error: state.error }));
      assert.ok(writes > 1, 'a short OS write must not drop the rest of its chunk');
      assert.deepEqual(await readFile(path.join(f.directory, f.release.assets[0].name)), content, responseMode);
    } finally { write.mock.restore(); }
  }
});

test('invalid partial-response ranges never append to or discard previously saved bytes', async t => {
  const offset = 8;
  const cases = [null, 'invalid', `bytes 0-${content.length - 1}/${content.length}`,
    `bytes ${offset}-${content.length - 2}/${content.length}`, `bytes ${offset}-${content.length - 1}/${content.length + 1}`,
    `bytes ${offset}-${content.length - 1}/*`];
  for (const range of cases) {
    const f = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL ? Response.json(release())
      : new Response(content.subarray(offset), { status: 206, headers: range ? { 'content-range': range } : {} }) });
    await writeFile(partialFile(f), content.subarray(0, offset));
    await f.manager.checkForUpdates();
    const state = await f.manager.downloadUpdate();
    assert.equal(state.error.code, 'INVALID_RANGE', range);
    assert.equal(state.download.receivedBytes, offset, range);
    assert.equal(state.download.canResume, true, range);
    assert.deepEqual(await readFile(partialFile(f)), content.subarray(0, offset), range);
    assert.deepEqual(await readdir(f.directory), [path.basename(partialFile(f))], range);
  }
});

test('checksum verification includes the resumed prefix and deletes corrupt assembled bytes', async t => {
  const offset = 8;
  const f = await fixture(t, { fetchImpl: url => url === LATEST_RELEASE_URL ? Response.json(release()) : rangedResponse(offset) });
  await writeFile(partialFile(f), Buffer.alloc(offset, 90));
  await f.manager.checkForUpdates();
  const state = await f.manager.downloadUpdate();
  assert.equal(state.error.code, 'HASH_MISMATCH');
  assert.equal(state.download.receivedBytes, 0);
  assert.equal(state.download.canResume, false);
  assert.equal(f.manager.verifiedFile, null);
  assert.deepEqual(await readdir(f.directory), []);
});

test('a complete partial file is verified and promoted without another installer request', async t => {
  const f = await fixture(t);
  await writeFile(partialFile(f), content);
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(f.requests, [LATEST_RELEASE_URL]);
  assert.deepEqual(await readdir(f.directory), [f.release.assets[0].name]);
  assert.deepEqual(await readFile(path.join(f.directory, f.release.assets[0].name)), content);
});

test('a symlink partial file cannot be used as resumable data or written through', async t => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'untouched-target');
  await writeFile(target, content.subarray(0, 8));
  try { await symlink(target, partialFile(f)); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  const available = await f.manager.checkForUpdates();
  assert.equal(available.download.canResume, false);
  const state = await f.manager.downloadUpdate();
  assert.equal(state.error.code, 'INVALID_CACHE');
  assert.equal(state.download.receivedBytes, 0);
  assert.deepEqual(f.requests, [LATEST_RELEASE_URL]);
  assert.deepEqual(await readFile(target), content.subarray(0, 8));
  assert.equal(f.manager.verifiedFile, null);
});

test('Range and identity encoding are preserved through a validated CDN redirect', async t => {
  const offset = 8;
  const headers = [];
  const cdn = 'https://release-assets.githubusercontent.com/installer?token=fresh';
  const f = await fixture(t, { fetchImpl: (url, init) => {
    if (url === LATEST_RELEASE_URL) return Response.json(release());
    const requestHeaders = new Headers(init.headers);
    headers.push({ range: requestHeaders.get('range'), encoding: requestHeaders.get('accept-encoding') });
    return url === cdn ? rangedResponse(offset)
      : new Response(null, { status: 302, headers: { location: cdn } });
  } });
  await writeFile(partialFile(f), content.subarray(0, offset));
  await f.manager.checkForUpdates();
  const state = await f.manager.downloadUpdate();
  assert.equal(state.status, 'downloaded');
  assert.deepEqual(headers, [{ range: `bytes=${offset}-`, encoding: 'identity' }, { range: `bytes=${offset}-`, encoding: 'identity' }]);
  assert.ok(!JSON.stringify(state).includes('token=fresh'));
  assert.deepEqual(await readFile(path.join(f.directory, f.release.assets[0].name)), content);
});

test('write failure removes partial bytes and never leaves an installable file', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const probe = path.join(f.directory, 'probe');
  const handle = await open(probe, 'w');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  await rm(probe);
  const write = t.mock.method(prototype, 'write', async () => { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; });
  try {
    const state = await f.manager.downloadUpdate();
    assert.equal(state.error.code, 'DISK_FULL');
    assert.deepEqual(await readdir(f.directory), []);
  } finally { write.mock.restore(); }
});

test('a new process reuses a complete cache only after hashing it against fresh release metadata', async t => {
  const f = await fixture(t);
  const name = release().assets[0].name;
  await writeFile(path.join(f.directory, name), content);
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(f.requests, [LATEST_RELEASE_URL]);
});

test('a symlink cannot supply an installer or redirect the cache directory', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'outside'), content);
  try { await symlink(path.join(f.directory, 'outside'), path.join(f.directory, release().assets[0].name)); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  assert.equal(f.requests.length, 2, 'symlink bytes must not be reused as a verified cache');
});

test('a symlink cannot redirect the update cache directory', async t => {
  const f = await fixture(t);
  const actual = path.join(f.directory, 'actual');
  const redirected = path.join(f.directory, 'redirected');
  await mkdir(actual);
  try { await symlink(actual, redirected, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  f.manager.directory = redirected;
  await f.manager.checkForUpdates();
  assert.equal((await f.manager.downloadUpdate()).error.code, 'INVALID_CACHE');
  assert.deepEqual(await readdir(actual), []);
});

test('install cancellation does not pause tasks or open a file', async t => {
  const calls = [];
  const f = await fixture(t, { confirmInstall: async () => { calls.push('confirm'); return false; },
    pauseDownloads: async () => calls.push('pause'), openInstaller: async () => calls.push('open') });
  await f.manager.checkForUpdates(); await f.manager.downloadUpdate();
  assert.equal((await f.manager.installUpdate()).status, 'downloaded');
  assert.deepEqual(calls, ['confirm']);
});

test('install confirms, pauses, rehashes and opens only the private verified path; failures retry safely', async t => {
  const calls = [];
  let openFailure = true;
  const f = await fixture(t, { confirmInstall: async () => { calls.push('confirm'); return true; },
    pauseDownloads: async () => calls.push('pause'),
    openInstaller: async (file, candidate) => { calls.push('open'); assert.equal(file, path.join(f.directory, release().assets[0].name)); assert.equal(candidate.version, '1.7.0'); assert.equal(candidate.sha256, sha256(content)); return openFailure ? 'OS error' : ''; },
    onInstalled: () => calls.push('quit') });
  await f.manager.checkForUpdates(); await f.manager.downloadUpdate();
  const failed = await f.manager.installUpdate();
  assert.equal(failed.error.phase, 'install');
  assert.deepEqual(calls, ['confirm', 'pause', 'open']);
  openFailure = false;
  assert.equal((await f.manager.installUpdate()).status, 'installing');
  assert.deepEqual(calls, ['confirm', 'pause', 'open', 'confirm', 'pause', 'open', 'quit']);
});

test('post-download tampering is detected before installation and requires a new download', async t => {
  let opened = false;
  const f = await fixture(t, { confirmInstall: async () => true, openInstaller: async () => { opened = true; return ''; } });
  await f.manager.checkForUpdates(); await f.manager.downloadUpdate();
  await writeFile(path.join(f.directory, release().assets[0].name), Buffer.alloc(content.length, 42));
  const state = await f.manager.installUpdate();
  assert.equal(state.error.code, 'HASH_MISMATCH');
  assert.equal(state.error.phase, 'download');
  assert.equal(opened, false);
});

test('Mac preparation refusal preserves the verified download and explains recovery without exiting', async t => {
  let exited = false;
  const f = await fixture(t, { confirmInstall: async () => true,
    openInstaller: async () => { throw Object.assign(new Error('请先将应用移到可写文件夹。'), { code: 'MAC_UPDATE_PERMISSION' }); },
    onInstalled: () => { exited = true; } });
  await f.manager.checkForUpdates(); await f.manager.downloadUpdate();
  const result = await f.manager.installUpdate();
  assert.equal(result.error.code, 'MAC_UPDATE_PERMISSION'); assert.equal(result.error.message, '请先将应用移到可写文件夹。');
  assert.equal(result.error.phase, 'install'); assert.ok(f.manager.verifiedFile); assert.equal(exited, false);
});

test('task-save failure prevents installer launch and application exit', async t => {
  let opened = false;
  const f = await fixture(t, { confirmInstall: async () => true, pauseDownloads: async () => { throw new Error('disk'); },
    openInstaller: async () => { opened = true; }, onInstalled: () => { opened = true; } });
  await f.manager.checkForUpdates(); await f.manager.downloadUpdate();
  assert.equal((await f.manager.installUpdate()).error.phase, 'install');
  assert.equal(opened, false);
});

test('ordinary shutdown waits for installer preparation and its successful handoff', { timeout: 2000 }, async t => {
  let entered, finishPreparation;
  const preparing = new Promise(resolve => { entered = resolve; });
  const prepared = new Promise(resolve => { finishPreparation = resolve; });
  const calls = [];
  const f = await fixture(t, { confirmInstall: async () => true,
    openInstaller: async () => {
      calls.push('preparing');
      entered();
      await prepared;
      calls.push('handed off');
      return '';
    }, onInstalled: () => { calls.push('quit requested'); }
  });
  await f.manager.checkForUpdates();
  await f.manager.downloadUpdate();
  const installing = f.manager.installUpdate();
  await preparing;
  let shutdownFinished = false;
  const shuttingDown = f.manager.shutdown().then(() => { shutdownFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownFinished, false, 'quitting must not orphan preparation or the native progress window');
  assert.deepEqual(calls, ['preparing']);
  finishPreparation();
  const [state] = await Promise.all([installing, shuttingDown]);
  assert.equal(state.status, 'installing');
  assert.equal(shutdownFinished, true);
  assert.deepEqual(calls, ['preparing', 'handed off', 'quit requested']);
});

test('the successful handoff can synchronously request shutdown without deadlocking the install operation', { timeout: 2000 }, async t => {
  let shuttingDown;
  const calls = [];
  const f = await fixture(t, { confirmInstall: async () => true,
    openInstaller: async () => { calls.push('handed off'); return ''; },
    onInstalled: () => {
      calls.push('quit requested');
      // Electron app.quit() emits before-quit synchronously. That handler starts
      // async shutdown but must not return its promise to the installation hook.
      shuttingDown = f.manager.shutdown().then(() => { calls.push('shutdown complete'); });
    }
  });
  await f.manager.checkForUpdates();
  await f.manager.downloadUpdate();
  const state = await f.manager.installUpdate();
  assert.ok(shuttingDown);
  await shuttingDown;
  assert.equal(state.status, 'installing');
  assert.deepEqual(calls, ['handed off', 'quit requested', 'shutdown complete']);
});

test('shutdown cancels a pending check and concurrent checks share one request', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { fetchImpl: () => { started(); return new Promise(() => {}); } });
  const a = f.manager.checkForUpdates();
  const b = f.manager.checkForUpdates();
  await ready;
  await f.manager.shutdown();
  await Promise.all([a, b]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.manager.snapshot().status, 'idle');
});
