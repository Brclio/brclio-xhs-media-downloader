import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isXhsImageUrl, isXhsVideoUrl, normalizeImageUrl } from "../lib/xhs.js";
import { inspectMp4Tracks, requireVideoAudio } from "../lib/media-tracks.js";
import { isMemberVideoUrl } from "../lib/video-policy.js";

async function inspectVideoHandle(handle, bytes, requireAudio) {
  const tracks = await inspectMp4Tracks(async (start, length) => {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead);
  }, bytes);
  requireVideoAudio(tracks, requireAudio);
  return tracks;
}

export function safeFilename(value, maxLength = 80, maxBytes = 240) {
  let name = String(value ?? "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "").trim();
  name = Array.from(name).slice(0, maxLength).join("").replace(/[. ]+$/g, "");
  while (Buffer.byteLength(name, "utf8") > maxBytes) name = Array.from(name).slice(0, -1).join("");
  name = name.replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") name = "untitled";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

export function abortError() {
  return Object.assign(new Error("任务已暂停或取消。"), { name: "AbortError" });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function assertSafeDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("保存路径超出了下载目录。");
  }
  let current = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("下载目录不能包含符号链接或非目录文件。");
  }
  if (await fs.realpath(directory) !== directory) throw new Error("下载目录已被替换，请重新选择目录。");
}

export async function ensureNoteDirectory(root, noteId) {
  const directory = path.join(root, isSafeDirectoryName(noteId) ? noteId : safeFilename(noteId));
  await assertSafeDirectory(root, root);
  try { await fs.mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
  await assertSafeDirectory(root, directory);
  return directory;
}

export function noteDirectoryName(sequence, title) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("笔记序号无效。");
  return `${String(sequence).padStart(3, "0")}-${safeFilename(String(title || "").trim() || "未命名帖子", 60, 180)}`;
}

export function isSafeDirectoryName(name) {
  return typeof name === "string" && Boolean(name) && name !== "." && name !== ".."
    && path.basename(name) === name && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name)
    && !/[. ]$/.test(name) && Buffer.byteLength(name, "utf8") <= 240;
}

export async function renameNoteDirectory(root, fromName, toName) {
  if (!isSafeDirectoryName(fromName) || !isSafeDirectoryName(toName)) throw new Error("笔记文件夹名称无效。");
  const source = path.join(root, fromName);
  const target = path.join(root, toName);
  await assertSafeDirectory(root, source);
  if (source === target) return target;
  try {
    await fs.lstat(target);
    throw new Error("目标文件夹已经存在，已保留原文件夹，未覆盖文件。");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.rename(source, target);
  await assertSafeDirectory(root, target);
  return target;
}

export async function assertSafeTarget(root, directory, name) {
  if (!name || path.basename(name) !== name || name.includes("\\")) throw new Error("下载文件名无效。");
  await assertSafeDirectory(root, directory);
  try {
    const stat = await fs.lstat(path.join(directory, name));
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new Error("下载目标不是普通文件，已停止写入。");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function atomicWrite(root, directory, name, data) {
  await assertSafeTarget(root, directory, name);
  const temporary = path.join(directory, `.${name}.${randomUUID()}.part`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertSafeTarget(root, directory, name);
    await fs.rename(temporary, path.join(directory, name));
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function verifyFile(root, directory, file, signal) {
  throwIfAborted(signal);
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256 || "") || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) return false;
  await assertSafeTarget(root, directory, file.name);
  let handle;
  try {
    handle = await fs.open(path.join(directory, file.name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.bytes || stat.nlink > 1) return false;
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
    if (hash.digest("hex") !== file.sha256) return false;
    if (file.kind === 'video') {
      try { await inspectVideoHandle(handle, stat.size, file.key === 'video'); }
      catch (error) { if (['VIDEO_INVALID', 'VIDEO_AUDIO_MISSING'].includes(error.code)) return false; throw error; }
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally { await handle?.close(); }
}

function detectImageType(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.toString("ascii", 0, 3) === "GIF") return "gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(bytes.toString("ascii", 8, 32))) return "avif";
  if (bytes.toString("ascii", 4, 8) === "ftyp" && /heic|heix|hevc|mif1/.test(bytes.toString("ascii", 8, 32))) return "heic";
  return null;
}

function cancelQuietly(stream) {
  // A misbehaving stream can leave cancel() pending, so cleanup must not await it.
  try { Promise.resolve(stream?.cancel()).catch(() => {}); } catch { /* Already locked or closed. */ }
}

function abortableOperation(operation, signal, onLateResult = () => {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason || abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => {
      if (settled) { onLateResult(value); return; }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export async function downloadMedia({ root, directory, asset, fetchImpl, signal, beforeRequest = async () => {}, authorize, onDiagnostic = () => {}, onProgress = () => {}, maxBytes, timeoutMs }) {
  if (!asset || !['image', 'video'].includes(asset.kind)) throw new Error('媒体类型无效。');
  if (typeof asset.key !== 'string' || !asset.key || safeFilename(asset.key) !== asset.key) throw new Error('下载文件名无效。');
  // Video files are written incrementally to disk. A zero limit means unlimited;
  // callers can still explicitly cap a transfer, and image safety stays intact.
  maxBytes ??= asset.kind === 'video' ? 0 : 2 * 1024 ** 3;
  timeoutMs ??= asset.kind === 'video' ? 60 * 1000 : 10 * 60 * 1000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('媒体大小限制无效。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) throw new Error('媒体超时设置无效。');
  const sizeLimit = maxBytes === 2 * 1024 ** 3 ? '2 GiB' : `${Math.round(maxBytes / 1024 ** 2 * 10) / 10} MiB`;
  const diagnostic = (event, fields) => { try { onDiagnostic(event, { kind: asset.kind, assetKey: asset.key, ...fields }); } catch { /* Diagnostics never interrupt saving. */ } };
  const progress = (loadedBytes, totalBytes, phase) => {
    try { Promise.resolve(onProgress({ loadedBytes, totalBytes, phase })).catch(() => {}); }
    catch { /* UI callbacks never interrupt saving. */ }
  };
  const validate = asset.kind === "image" ? isXhsImageUrl : isXhsVideoUrl;
  let url = normalizeImageUrl(asset.url);
  const watchdog = new AbortController();
  const requestSignal = AbortSignal.any([signal, watchdog.signal].filter(Boolean));
  const timeoutError = Object.assign(new Error('媒体下载长时间无响应，请重试。'), { code: 'MEDIA_DOWNLOAD_TIMEOUT' });
  // Bound each wait for network data, not the total transfer duration. Disk
  // writes and validation do not consume a network inactivity allowance.
  const networkOperation = async (operation, onLateResult, allowance = timeoutMs) => {
    if (allowance <= 0) { watchdog.abort(timeoutError); throw timeoutError; }
    const timer = setTimeout(() => watchdog.abort(timeoutError), allowance);
    try { return await abortableOperation(operation, requestSignal, onLateResult); }
    finally { clearTimeout(timer); }
  };
  let response;
  let temporary;
  let handle;
  let reader;
  let memberVideo = asset.kind === 'video' && asset.watermarkFree === true;
  const requireOriginalAuthorization = async () => {
    try {
      if (!authorize) throw new Error('软件账号授权服务不可用。');
      await authorize('watermark-free-video');
    } catch (error) {
      throw Object.assign(new Error(error.message || '无水印视频仅限有效会员下载。'), { code: 'ACCOUNT_AUTHORIZATION_REQUIRED', status: error.status || error.statusCode || 403, cause: error });
    }
  };
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      throwIfAborted(signal);
      if (new URL(url).protocol !== "https:" || !validate(url)) throw new Error("媒体链接或重定向不属于受支持的小红书媒体域名。");
      await beforeRequest(signal);
      memberVideo ||= asset.kind === 'video' && isMemberVideoUrl(url);
      if (memberVideo) await requireOriginalAuthorization();
      throwIfAborted(signal);
      response = await networkOperation(() => fetchImpl(url, {
        redirect: "manual", signal: requestSignal,
        headers: { referer: "https://www.xiaohongshu.com/", "user-agent": "Mozilla/5.0", accept: asset.kind === "image" ? "image/*" : "video/mp4,application/octet-stream" }
      }), lateResponse => cancelQuietly(lateResponse?.body));
      diagnostic('media.response', { status: response.status, redirect });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        cancelQuietly(response.body);
        if (!location || redirect === 5) throw new Error("媒体重定向次数过多或目标缺失。");
        url = new URL(location, url).href;
        continue;
      }
      if (response.status === 429 || response.status === 461 || response.status === 471) {
        throw Object.assign(new Error("小红书限制了请求频率，任务已暂停。请稍后恢复。"), { code: "RATE_LIMITED" });
      }
      if (!response.ok) throw new Error(`媒体下载失败（HTTP ${response.status}）。`);
      if (response.status === 206 || response.headers.get('content-range') !== null) throw new Error('媒体服务器只返回了部分内容，未保存不完整文件。');
      break;
    }
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const allowed = asset.kind === "image"
      ? /^image\/(?:jpeg|jpg|png|webp|gif|avif|heic|heif)$/.test(contentType)
      : ["video/mp4", "video/x-m4v", "video/quicktime", "application/octet-stream"].includes(contentType);
    if (!allowed) throw new Error(`媒体响应类型异常（${contentType || "未知"}），未保存。`);
    const lengthHeader = response.headers.get("content-length");
    const declared = lengthHeader === null ? null : Number(lengthHeader);
    if (declared !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(declared) || declared <= 0)) throw new Error('媒体文件大小无效。');
    if (declared !== null && maxBytes > 0 && declared > maxBytes) throw new Error(`媒体文件大小超过 ${sizeLimit} 限制。`);
    if (!response.body) throw new Error("媒体响应为空。");
    await assertSafeDirectory(root, directory);
    temporary = path.join(directory, `.${asset.key}.${randomUUID()}.part`);
    handle = await fs.open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    reader = response.body.getReader();
    const hash = createHash("sha256");
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    let lastDataAt = performance.now();
    progress(0, declared, 'downloading');
    while (true) {
      throwIfAborted(requestSignal);
      const chunk = await networkOperation(() => reader.read(), undefined, timeoutMs - (performance.now() - lastDataAt));
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('媒体响应数据无效。');
      if (chunk.value.byteLength === 0) continue;
      const nextBytes = bytes + chunk.value.byteLength;
      if (!Number.isSafeInteger(nextBytes)) throw new Error('媒体文件大小超出了可安全处理的范围。');
      if (maxBytes > 0 && nextBytes > maxBytes) throw new Error(`媒体文件超过 ${sizeLimit} 限制。`);
      if (declared !== null && nextBytes > declared) throw new Error('媒体文件实际大小超过声明大小，未保存。');
      bytes = nextBytes;
      if (prefix.length < 64) prefix = Buffer.concat([prefix, Buffer.from(chunk.value.buffer, chunk.value.byteOffset, Math.min(chunk.value.byteLength, 64 - prefix.length))]);
      hash.update(chunk.value);
      await handle.writeFile(chunk.value);
      lastDataAt = performance.now();
      throwIfAborted(requestSignal);
      progress(bytes, declared, 'downloading');
    }
    if (!bytes || (declared !== null && bytes !== declared)) throw new Error("媒体文件未完整下载，请重试。");
    const extension = asset.kind === "image" ? detectImageType(prefix) : prefix.toString("ascii", 4, 8) === "ftyp" ? "mp4" : null;
    if (!extension) throw new Error("媒体文件内容不符合图片或 MP4 格式，未保存。");
    progress(bytes, declared, 'checking');
    const mediaTracks = asset.kind === 'video' ? await inspectVideoHandle(handle, bytes, asset.requireAudio === true) : undefined;
    const name = `${asset.key}.${extension}`;
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfAborted(requestSignal);
    if (memberVideo) await requireOriginalAuthorization();
    throwIfAborted(requestSignal);
    await assertSafeTarget(root, directory, name);
    progress(bytes, declared, 'saving');
    throwIfAborted(requestSignal);
    await fs.rename(temporary, path.join(directory, name));
    diagnostic('media.saved', { bytes, hasAudio: mediaTracks?.hasAudio, hasVideo: mediaTracks?.hasVideo });
    return { key: asset.key, kind: asset.kind, name, bytes, sha256: hash.digest("hex"), url: asset.url, ...(memberVideo ? { watermarkFree: true } : {}), ...(mediaTracks ? { mediaTracks } : {}) };
  } catch (error) {
    diagnostic('media.error', { code: error.code || error.name || 'MEDIA_DOWNLOAD_FAILED' });
    if (signal?.aborted) throw abortError();
    if (watchdog.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    cancelQuietly(reader || response?.body);
    try { reader?.releaseLock(); } catch { /* Pending read already aborted. */ }
    await handle?.close().catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}
