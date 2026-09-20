import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const REPOSITORY = 'Brclio/brclio-xhs-media-downloader';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const CDN_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const MAX_INSTALLER_BYTES = 2 * 1024 ** 3;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_RELEASE_BYTES = 1024 * 1024;

// Electron net.fetch rejects manual redirects instead of exposing their response.
// Adapt net.request so the manager can validate every Location before following it.
export function createElectronUpdateFetch(net) {
  return (url, options = {}) => new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    let request, bodyController;
    let settled = false, finished = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const failure = error => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!settled) { settled = true; reject(error); }
      else bodyController?.error(error);
    };
    const abort = () => {
      failure(signal.reason || new Error('Update request aborted'));
      request?.abort();
    };
    try {
      request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit',
        useSessionCookies: false, bypassCustomProtocolHandlers: true,
        headers: Object.fromEntries(new Headers(options.headers)) });
      request.on('error', failure);
      request.once('redirect', (status, _method, location) => {
        if (settled) return;
        try {
          const response = new Response(null, { status, headers: { location } });
          settled = true;
          finished = true;
          cleanup();
          resolve(response);
          request.abort();
        } catch (error) { failure(error); request.abort(); }
      });
      request.once('response', incoming => {
        if (settled) { request.abort(); return; }
        try {
        incoming.pause();
        const headers = new Headers();
        for (const [name, values] of Object.entries(incoming.headers)) {
          for (const value of Array.isArray(values) ? values : [values]) {
            if (value != null) headers.append(name, String(value));
          }
        }
        if ([204, 205, 304].includes(incoming.statusCode)) {
          const response = new Response(null, { status: incoming.statusCode, headers });
          settled = true;
          finished = true;
          cleanup();
          resolve(response);
          request.abort();
          return;
        }
        const body = new ReadableStream({
          start(controller) {
            bodyController = controller;
            incoming.on('data', chunk => {
              if (finished) return;
              controller.enqueue(chunk);
              if (controller.desiredSize <= 0) incoming.pause();
            });
            incoming.once('end', () => {
              if (finished) return;
              finished = true;
              cleanup();
              controller.close();
            });
            incoming.on('error', failure);
            incoming.once('aborted', () => failure(new Error('Update response aborted')));
          },
          pull() { incoming.resume(); },
          cancel() { finished = true; cleanup(); request.abort(); }
        });
        const response = new Response(body, { status: incoming.statusCode, headers });
        settled = true;
        resolve(response);
        } catch (error) { failure(error); request.abort(); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      request.end();
    } catch (error) { failure(error); request?.abort(); }
  });
}

class UpdateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(code, message) { throw new UpdateError(code, message); }

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    fail('INVALID_VERSION', '发布版本号无效，只支持正式版本。');
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) fail('INVALID_VERSION', '发布版本号无效。');
  return parts;
}

export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function installerName(version, platform, arch) {
  versionParts(version);
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `XHS-Downloader-${version}-mac-${arch}.dmg`;
  if (platform === 'win32' && arch === 'x64') return `XHS-Downloader-${version}-windows-x64-setup.exe`;
  fail('UNSUPPORTED_PLATFORM', '当前系统或处理器没有可用的更新安装包。');
}

function trustedUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('UNTRUSTED_URL', '更新地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    fail('UNTRUSTED_URL', '更新地址不符合安全要求。');
  }
  return url;
}

function releaseAsset(asset, name, tag, maximum) {
  if (!asset || asset.name !== name || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximum) {
    fail('INVALID_ASSET', '发布附件的信息不完整或大小无效。');
  }
  const url = trustedUrl(asset.browser_download_url);
  const expected = `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`;
  if (url.href !== expected) fail('UNTRUSTED_URL', '安装包必须来自本项目的 GitHub 发布页面。');
  return { name, size: asset.size, url: url.href, digest: asset.digest };
}

function uniqueAsset(assets, name) {
  const matches = assets.filter(asset => asset?.name === name);
  if (matches.length !== 1) fail('ASSET_NOT_FOUND', '此版本缺少当前系统的完整安装包或校验文件，请稍后重试。');
  return matches[0];
}

export function parseRelease(release, { currentVersion, platform, arch }) {
  if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {
    fail('INVALID_RELEASE', '更新信息不是正式发布版本。');
  }
  const match = /^(?:desktop-)?v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name);
  if (!match) fail('INVALID_VERSION', '更新信息不是正式版本号。');
  const version = match[1];
  const releaseUrl = `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`;
  if (trustedUrl(release.html_url).href !== releaseUrl) fail('UNTRUSTED_URL', '更新信息不是来自本项目。');
  const metadata = { latestVersion: version, releaseUrl,
    releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 32000) : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at.slice(0, 40) : '' };
  if (compareVersions(version, currentVersion) <= 0) return { metadata, candidate: null };
  if (!Array.isArray(release.assets) || release.assets.length > 1000) fail('INVALID_ASSET', '发布附件列表无效。');
  const name = installerName(version, platform, arch);
  const asset = releaseAsset(uniqueAsset(release.assets, name), name, release.tag_name, MAX_INSTALLER_BYTES);
  let sha256 = null;
  let manifest = null;
  if (asset.digest != null) {
    const digestMatch = typeof asset.digest === 'string' && /^sha256:([a-f\d]{64})$/i.exec(asset.digest);
    if (!digestMatch) fail('INVALID_CHECKSUM', '安装包的 SHA256 校验信息无效。');
    sha256 = digestMatch[1].toLowerCase();
  } else {
    manifest = releaseAsset(uniqueAsset(release.assets, 'SHA256SUMS.txt'), 'SHA256SUMS.txt', release.tag_name, MAX_MANIFEST_BYTES);
  }
  return { metadata, candidate: { ...asset, version, sha256, manifest } };
}

export function checksumFromManifest(text, name) {
  const matches = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^([a-f\d]{64})[ \t]+\*?([^\r\n]+)$/i.exec(line);
    if (match && match[2] === name) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) fail('INVALID_CHECKSUM', '校验文件没有此安装包的唯一 SHA256，已停止下载。');
  return matches[0];
}

export function allowedAssetRedirect(value, initialUrl) {
  const url = trustedUrl(value);
  if (url.href === initialUrl || CDN_HOSTS.has(url.hostname)) return url.href;
  fail('UNTRUSTED_REDIRECT', '安装包被重定向到非 GitHub 下载地址，已停止。');
}

function installationHint(platform, portable) {
  if (platform === 'darwin') return '安装时会暂停并保存下载任务，校验新版应用后退出并在原位置替换，再重新打开。旧版本保留为备份。请从可写文件夹中的应用启动；从 DMG 或只读位置运行时需手动安装。此版本没有 Apple Developer ID 签名或公证，系统可能仍需确认。';
  if (portable) return '当前为 Windows 便携版；更新包是安装版。安装时会暂停并保存任务、退出应用并打开安装向导，完成后请从新版快捷方式启动。系统可能提示未签名。';
  return '安装时会暂停并保存下载任务、退出应用并打开 Windows 安装向导。完成后重新打开应用；系统可能提示未签名。';
}

export class UpdateManager {
  constructor({ currentVersion, platform = process.platform, arch = process.arch, portable = false,
    directory, fetchImpl = globalThis.fetch, onUpdate = () => {}, networkTimeoutMs = 30000,
    confirmInstall = async () => false, pauseDownloads = async () => {},
    openInstaller = async () => fail('INSTALL_UNAVAILABLE', '当前环境无法打开安装程序。'), onInstalled = () => {} }) {
    versionParts(currentVersion);
    if (!directory || !path.isAbsolute(directory)) throw new TypeError('Update cache must be an absolute path');
    this.directory = directory;
    this.fetchImpl = fetchImpl;
    this.onUpdate = onUpdate;
    this.networkTimeoutMs = networkTimeoutMs;
    this.confirmInstall = confirmInstall;
    this.pauseDownloads = pauseDownloads;
    this.openInstaller = openInstaller;
    this.onInstalled = onInstalled;
    this.candidate = null;
    this.verifiedFile = null;
    this.operation = null;
    this.controller = null;
    this.lastProgressAt = 0;
    this.state = { status: 'idle', currentVersion, latestVersion: null, platform, arch,
      releaseUrl: null, releaseNotes: '', publishedAt: '',
      download: { receivedBytes: 0, totalBytes: 0, percent: 0 },
      error: null, canRetry: false, installationHint: installationHint(platform, portable) };
  }

  snapshot() { return structuredClone(this.state); }

  emit(patch = {}) {
    Object.assign(this.state, patch);
    try { this.onUpdate(this.snapshot()); } catch { /* A closed window cannot interrupt an update. */ }
  }

  async run(phase, work) {
    if (this.operation) return this.operation;
    const controller = new AbortController();
    this.controller = controller;
    this.operation = (async () => {
      try { await work(controller); }
      catch (error) {
        if (controller.signal.aborted && controller.signal.reason?.code === 'CANCELED') {
          this.emit({ status: this.candidate ? 'available' : 'idle', error: null, canRetry: false,
            download: { receivedBytes: 0, totalBytes: this.candidate?.size || 0, percent: 0 } });
        } else {
          const reason = controller.signal.aborted ? controller.signal.reason : error;
          const failure = reason instanceof UpdateError ? reason : /^MAC_UPDATE_[A-Z_]+$/.test(error?.code || '') ? new UpdateError(error.code, error.message) : new UpdateError(
            error?.code === 'ENOSPC' ? 'DISK_FULL' : phase === 'install' ? 'INSTALL_FAILED' : 'NETWORK_ERROR',
            error?.code === 'ENOSPC' ? '磁盘空间不足，请清理后重试。' : phase === 'install'
              ? '无法完成安装前准备或打开安装程序，请重试。' : '更新请求失败，请检查网络连接后重试。');
          const retryPhase = phase === 'install' && !this.verifiedFile && this.candidate ? 'download' : phase;
          this.emit({ status: 'error', error: { code: failure.code, message: failure.message, phase: retryPhase }, canRetry: true });
        }
      }
      return this.snapshot();
    })();
    try { return await this.operation; }
    finally { this.operation = null; this.controller = null; }
  }

  async bounded(promise, controller) {
    const signal = controller.signal;
    if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); throw signal.reason; }
    let timer, abort;
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(new UpdateError('TIMEOUT', '更新服务器响应超时，请重试。')), this.networkTimeoutMs);
      })]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  async request(url, controller, asset = false) {
    let current = url;
    for (let redirects = 0; redirects <= 4; redirects++) {
      controller.signal.throwIfAborted();
      const response = await this.bounded(this.fetchImpl(current, {
        method: 'GET', redirect: 'manual', signal: controller.signal, credentials: 'omit',
        headers: { Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
          'User-Agent': 'Brclio-XHS-Downloader', 'Accept-Encoding': 'identity' }
      }), controller);
      if (response.redirected) fail('UNTRUSTED_REDIRECT', '更新请求未按要求检查重定向。');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (!asset || redirects === 4) fail('UNTRUSTED_REDIRECT', '更新下载重定向次数或目标异常。');
        const location = response.headers.get('location');
        if (!location) fail('UNTRUSTED_REDIRECT', '更新下载重定向缺少地址。');
        let target;
        try { target = new URL(location, current).href; } catch { fail('UNTRUSTED_REDIRECT', '更新下载重定向地址无效。'); }
        current = allowedAssetRedirect(target, url);
        continue;
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 403 || response.status === 429) fail('RATE_LIMITED', 'GitHub 暂时限制请求，请稍后再检查更新。');
        if (response.status === 404) fail('RELEASE_NOT_FOUND', '正式版本或安装包暂不可用，请稍后重试。');
        fail('HTTP_ERROR', `更新服务器返回错误（${response.status}），请稍后重试。`);
      }
      return response;
    }
  }

  async read(response, maximum, controller, onChunk) {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) fail('SIZE_MISMATCH', '更新文件大小与发布信息不一致。');
    if (!response.body) fail('EMPTY_RESPONSE', '更新服务器没有返回文件内容。');
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const { value, done } = await this.bounded(reader.read(), controller);
        if (done) break;
        received += value.byteLength;
        if (received > maximum) fail('SIZE_MISMATCH', '更新文件超过声明的大小，已停止下载。');
        await onChunk(value, received);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return received;
  }

  async text(response, maximum, controller) {
    const chunks = [];
    await this.read(response, maximum, controller, chunk => chunks.push(Buffer.from(chunk)));
    return Buffer.concat(chunks).toString('utf8');
  }

  checkForUpdates() {
    return this.run('check', async controller => {
      if (this.state.status === 'downloaded') return;
      this.emit({ status: 'checking', error: null, canRetry: false });
      const response = await this.request(LATEST_RELEASE_URL, controller);
      let release;
      try { release = JSON.parse(await this.text(response, MAX_RELEASE_BYTES, controller)); }
      catch (error) { if (error instanceof UpdateError) throw error; fail('INVALID_RELEASE', '无法读取更新信息，请稍后重试。'); }
      const { metadata, candidate } = parseRelease(release, this.state);
      this.candidate = candidate;
      this.verifiedFile = null;
      this.emit({ ...metadata, status: candidate ? 'available' : 'up-to-date', error: null, canRetry: false,
        download: { receivedBytes: 0, totalBytes: candidate?.size || 0, percent: 0 } });
    });
  }

  async cacheDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) fail('INVALID_CACHE', '更新缓存目录无效。');
    return realpath(this.directory);
  }

  async verifyFile(file, candidate) {
    const info = await lstat(file);
    if (!info.isFile() || info.size !== candidate.size || await realpath(file) !== file) fail('SIZE_MISMATCH', '安装包已更改，请重新下载更新。');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const hash = createHash('sha256');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
    if (hash.digest('hex') !== candidate.sha256) fail('HASH_MISMATCH', '安装包 SHA256 校验失败，请重新下载。');
  }

  downloadUpdate() {
    return this.run('download', async controller => {
      const candidate = this.candidate;
      if (!candidate) fail('CHECK_REQUIRED', '请先检查更新。');
      if (this.state.status === 'downloaded') return;
      this.emit({ status: 'downloading', error: null, canRetry: false,
        download: { receivedBytes: 0, totalBytes: candidate.size, percent: 0 } });
      if (!candidate.sha256) {
        const response = await this.request(candidate.manifest.url, controller, true);
        const contents = await this.text(response, candidate.manifest.size, controller);
        if (Buffer.byteLength(contents) !== candidate.manifest.size) fail('SIZE_MISMATCH', '更新校验文件没有下载完整。');
        candidate.sha256 = checksumFromManifest(contents, candidate.name);
      }
      const directory = await this.cacheDirectory();
      const final = path.join(directory, candidate.name);
      const partial = `${final}.partial`;
      await rm(partial, { force: true });
      try {
        await this.verifyFile(final, candidate);
        controller.signal.throwIfAborted();
        this.verifiedFile = final;
        this.emit({ status: 'downloaded', download: { receivedBytes: candidate.size, totalBytes: candidate.size, percent: 100 } });
        return;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error?.code !== 'ENOENT' && !(error instanceof UpdateError)) throw error;
      }
      let handle;
      try {
        const response = await this.request(candidate.url, controller, true);
        const length = response.headers.get('content-length');
        if (length && Number(length) !== candidate.size) fail('SIZE_MISMATCH', '安装包大小与发布信息不一致。');
        handle = await open(partial, 'wx', 0o600);
        const hash = createHash('sha256');
        const received = await this.read(response, candidate.size, controller, async (chunk, count) => {
          await handle.writeFile(chunk);
          hash.update(chunk);
          this.state.download = { receivedBytes: count, totalBytes: candidate.size,
            percent: Math.floor(count * 100 / candidate.size) };
          if (Date.now() - this.lastProgressAt >= 100 || count === candidate.size) {
            this.lastProgressAt = Date.now();
            this.emit();
          }
        });
        if (received !== candidate.size) fail('SIZE_MISMATCH', '安装包没有下载完整，请重试。');
        if (hash.digest('hex') !== candidate.sha256) fail('HASH_MISMATCH', '安装包 SHA256 校验失败，已删除未验证的文件。');
        controller.signal.throwIfAborted();
        await handle.sync();
        await handle.close(); handle = null;
        controller.signal.throwIfAborted();
        await rm(final, { force: true });
        await rename(partial, final);
        this.verifiedFile = final;
        this.emit({ status: 'downloaded', download: { receivedBytes: received, totalBytes: candidate.size, percent: 100 } });
      } finally {
        await handle?.close();
        await rm(partial, { force: true });
      }
    });
  }

  async cancelUpdateDownload() {
    if (this.state.status === 'downloading') {
      this.controller?.abort(new UpdateError('CANCELED', '已取消下载。'));
      await this.operation;
    }
    return this.snapshot();
  }

  installUpdate() {
    return this.run('install', async () => {
      if (!this.candidate || !this.verifiedFile) fail('DOWNLOAD_REQUIRED', '请先下载并校验安装包。');
      this.emit({ status: 'installing', error: null, canRetry: false });
      if (!await this.confirmInstall(this.snapshot())) { this.emit({ status: 'downloaded' }); return; }
      await this.pauseDownloads();
      try { await this.verifyFile(this.verifiedFile, this.candidate); }
      catch (error) {
        this.verifiedFile = null;
        if (error instanceof UpdateError) throw error;
        fail('INSTALLER_MISSING', '安装包不存在或无法读取，请重新下载。');
      }
      const error = await this.openInstaller(this.verifiedFile, this.candidate);
      if (error) fail('INSTALL_FAILED', '系统无法打开安装程序，请重试。');
      await this.onInstalled();
    });
  }

  async shutdown() {
    if (['checking', 'downloading'].includes(this.state.status)) {
      this.controller?.abort(new UpdateError('CANCELED', '应用即将关闭。'));
      await this.operation;
    }
  }
}
