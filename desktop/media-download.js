import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isXhsImageUrl, isXhsVideoUrl, normalizeImageUrl } from "../lib/xhs.js";
import { inspectMp4Tracks, requireVideoAudio } from "../lib/media-tracks.js";

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

export async function downloadMedia({ root, directory, asset, fetchImpl, signal, beforeRequest, onDiagnostic = () => {}, maxBytes = 2 * 1024 ** 3, timeoutMs = 10 * 60 * 1000 }) {
  const diagnostic = (event, fields) => { try { onDiagnostic(event, { kind: asset.kind, assetKey: asset.key, ...fields }); } catch { /* Diagnostics never interrupt saving. */ } };
  const validate = asset.kind === "image" ? isXhsImageUrl : isXhsVideoUrl;
  let url = normalizeImageUrl(asset.url);
  let timer;
  let requestSignal = signal;
  let response;
  let temporary;
  let handle;
  let reader;
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      throwIfAborted(signal);
      if (new URL(url).protocol !== "https:" || !validate(url)) throw new Error("媒体链接或重定向不属于受支持的小红书媒体域名。");
      await beforeRequest(signal);
      timer = AbortSignal.timeout(timeoutMs);
      requestSignal = AbortSignal.any([signal, timer].filter(Boolean));
      response = await fetchImpl(url, {
        redirect: "manual", signal: requestSignal,
        headers: { referer: "https://www.xiaohongshu.com/", "user-agent": "Mozilla/5.0", accept: asset.kind === "image" ? "image/*" : "video/mp4,application/octet-stream" }
      });
      diagnostic('media.response', { status: response.status, redirect });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirect === 5) throw new Error("媒体重定向次数过多或目标缺失。");
        url = new URL(location, url).href;
        continue;
      }
      if (response.status === 429 || response.status === 461 || response.status === 471) {
        throw Object.assign(new Error("小红书限制了请求频率，任务已暂停。请稍后恢复。"), { code: "RATE_LIMITED" });
      }
      if (!response.ok) throw new Error(`媒体下载失败（HTTP ${response.status}）。`);
      break;
    }
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const allowed = asset.kind === "image"
      ? /^image\/(?:jpeg|jpg|png|webp|gif|avif|heic|heif)$/.test(contentType)
      : ["video/mp4", "video/x-m4v", "video/quicktime", "application/octet-stream"].includes(contentType);
    if (!allowed) throw new Error(`媒体响应类型异常（${contentType || "未知"}），未保存。`);
    const lengthHeader = response.headers.get("content-length");
    const declared = lengthHeader === null ? null : Number(lengthHeader);
    if (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0 || declared > maxBytes)) throw new Error("媒体文件大小无效或超过 2 GiB 限制。");
    if (!response.body) throw new Error("媒体响应为空。");
    await assertSafeDirectory(root, directory);
    temporary = path.join(directory, `.${asset.key}.${randomUUID()}.part`);
    handle = await fs.open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    reader = response.body.getReader();
    const hash = createHash("sha256");
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    while (true) {
      throwIfAborted(requestSignal);
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("媒体文件超过 2 GiB 限制。");
      if (prefix.length < 64) prefix = Buffer.concat([prefix, Buffer.from(chunk.value).subarray(0, 64 - prefix.length)]);
      hash.update(chunk.value);
      await handle.writeFile(chunk.value);
    }
    if (!bytes || (declared !== null && bytes !== declared)) throw new Error("媒体文件未完整下载，请重试。");
    const extension = asset.kind === "image" ? detectImageType(prefix) : prefix.toString("ascii", 4, 8) === "ftyp" ? "mp4" : null;
    if (!extension) throw new Error("媒体文件内容不符合图片或 MP4 格式，未保存。");
    const mediaTracks = asset.kind === 'video' ? await inspectVideoHandle(handle, bytes, asset.requireAudio === true) : undefined;
    const name = `${asset.key}.${extension}`;
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfAborted(requestSignal);
    await assertSafeTarget(root, directory, name);
    await fs.rename(temporary, path.join(directory, name));
    diagnostic('media.saved', { bytes, hasAudio: mediaTracks?.hasAudio, hasVideo: mediaTracks?.hasVideo });
    return { key: asset.key, kind: asset.kind, name, bytes, sha256: hash.digest("hex"), url: asset.url, ...(mediaTracks ? { mediaTracks } : {}) };
  } catch (error) {
    diagnostic('media.error', { code: error.code || error.name || 'MEDIA_DOWNLOAD_FAILED' });
    if (signal?.aborted) throw abortError();
    if (timer?.aborted) throw new Error("媒体下载超时，请重试。");
    throw error;
  } finally {
    await reader?.cancel().catch(() => {});
    if (!reader) await response?.body?.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}
