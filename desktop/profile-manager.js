import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractNoteId } from "../lib/xhs.js";
import { makeNoteTextFileData } from "../lib/archive.js";
import { parseProfileUrl } from "./profile-source.js";
import {
  atomicWrite, ensureNoteDirectory, verifyFile, downloadMedia, assertSafeDirectory,
  noteDirectoryName, isSafeDirectoryName, renameNoteDirectory,
  abortError, throwIfAborted, sleep as defaultSleep
} from "./media-download.js";

const ACTIVE = new Set(["discovering", "downloading", "waiting"]);
const FINISHED = new Set(["completed", "skipped"]);
const PAUSE_CODES = new Set(["AUTH_REQUIRED", "RATE_LIMITED", "DISCOVERY_INCOMPLETE", "ACCOUNT_AUTHORIZATION_REQUIRED"]);
const ITEM_ID = /^[a-f0-9]{24}$/i;
const STATE_FILENAME = "profile-job.json";

function restoreItems(items) {
  const used = new Set();
  const reserved = new Set(items.map(item => item.sequence).filter(value => Number.isSafeInteger(value) && value > 0));
  let next = 1;
  return items.map(item => {
    let sequence = item.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || used.has(sequence)) {
      while (used.has(next) || reserved.has(next)) next++;
      sequence = next++;
    }
    used.add(sequence);
    const descriptor = noteDescriptor(item);
    const prefix = `${String(sequence).padStart(3, "0")}-`;
    if (item.directoryName && (!isSafeDirectoryName(item.directoryName)
      || (item.directoryName !== descriptor.id && !item.directoryName.startsWith(prefix)))) {
      throw new Error("任务记录中的笔记文件夹名称无效。");
    }
    return {
      ...descriptor, sequence, directoryName: item.directoryName || "",
      titleResolved: item.titleResolved === true || Boolean(item.complete) || Boolean(item.files?.length),
      status: ["pending", "completed", "skipped", "failed"].includes(item.status) ? item.status : "pending",
      error: String(item.error || ""), files: Array.isArray(item.files) ? item.files : [],
      complete: Boolean(item.complete), strategy: String(item.strategy || "")
    };
  });
}

function initialState(now) {
  return {
    version: 1, status: "idle", phase: "idle", profileUrl: "", profileName: "", directory: "",
    intervalSeconds: 10, jitterSeconds: 3, discoveryComplete: false, currentTitle: "",
    nextRequestAt: null, message: "选择保存目录并输入小红书主页链接。", items: [], updatedAt: now
  };
}

function interval(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name}须为 ${minimum}–${maximum} 秒。`);
  return number;
}

function noteDescriptor(note) {
  const id = String(note?.id || "");
  if (!ITEM_ID.test(id)) throw new Error("主页返回了无效的笔记 ID，任务已停止。");
  const url = new URL(String(note.url || `https://www.xiaohongshu.com/explore/${id}`));
  if (url.protocol !== "https:" || url.hostname !== "www.xiaohongshu.com" || url.username || url.password || (url.port && url.port !== "443") || extractNoteId(url.href) !== id) {
    throw new Error("主页返回了不属于当前笔记的小红书链接。");
  }
  return { id, url: url.href, title: String(note.title || "").slice(0, 200) };
}

function mediaAssets(note) {
  const assets = [];
  for (const [index, image] of (note.images || []).entries()) {
    const number = String(index + 1).padStart(3, "0");
    assets.push({ key: `image-${number}`, kind: "image", url: image.url });
    if (image.liveVideo?.url) assets.push({ key: `live-${number}`, kind: "video", url: image.liveVideo.url, backupUrls: image.liveVideo.backupUrls });
  }
  const video = (note.videos || []).find((item) => item.isDefault) || (note.videos || [])[0];
  if (video?.url) assets.push({ key: "video", kind: "video", url: video.url, backupUrls: video.backupUrls });
  return assets;
}

function fileRecord(name, bytes) {
  return { key: name, name, kind: "metadata", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** One persistent, sequential queue. No network request is made by initialize(). */
export class ProfileManager {
  constructor({ stateDirectory, browser, fetchImpl = globalThis.fetch, onUpdate = () => {}, now = Date.now, sleep = defaultSleep, random = Math.random, mediaOptions = {}, authorize, authorizationIntervalMs = 30_000 }) {
    if (!stateDirectory || !browser) throw new Error("ProfileManager requires stateDirectory and browser.");
    this.stateDirectory = path.resolve(stateDirectory);
    this.browser = browser;
    this.fetchImpl = fetchImpl;
    this.onUpdate = onUpdate;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.mediaOptions = mediaOptions;
    this.authorize = authorize || (async () => { throw new Error('软件账号授权服务不可用。'); });
    this.authorizationIntervalMs = authorizationIntervalMs;
    this.state = initialState(this.now());
    this._lastRequestAt = null;
    this._saveChain = Promise.resolve();
    this._commands = Promise.resolve();
    this._runTask = null;
    this._controller = null;
  }

  async initialize() {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    this.stateDirectory = await fs.realpath(this.stateDirectory);
    try {
      const savedPath = path.join(this.stateDirectory, STATE_FILENAME);
      const stat = await fs.lstat(savedPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("任务记录文件无效或过大。");
      const saved = JSON.parse(await fs.readFile(savedPath, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error("任务记录版本不兼容。");
      if (saved.profileUrl) parseProfileUrl(saved.profileUrl);
      if (saved.directory && !path.isAbsolute(saved.directory)) throw new Error("任务目录无效。");
      saved.intervalSeconds = interval(saved.intervalSeconds, 10, 3, 3600, "请求间隔");
      saved.jitterSeconds = interval(saved.jitterSeconds, 3, 0, 300, "随机延迟");
      saved.items = restoreItems(saved.items);
      this.state = { ...initialState(this.now()), ...saved, nextRequestAt: null, currentTitle: "" };
      if (ACTIVE.has(saved.status) || saved.status === "paused") {
        this.state.status = "paused";
        this.state.message = "已恢复上次任务；点击继续后会验证已下载文件，并接着处理。";
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.state.status = "error";
        this.state.message = `无法读取上次任务：${error.message}。原记录已保留。`;
      }
    }
    this._emit();
    return this.snapshot();
  }

  snapshot() {
    const items = this.state.items.map(({ id, url, title, status, error, sequence, directoryName }) => ({ id, url, title, status, error, sequence, directoryName }));
    return {
      ...this.state, items,
      discovered: items.length,
      completed: items.filter((item) => item.status === "completed").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      failed: items.filter((item) => item.status === "failed").length
    };
  }

  _command(callback) {
    const result = this._commands.then(callback);
    this._commands = result.catch(() => {});
    return result;
  }

  start(options = {}) {
    return this._command(async () => {
      await this._authorize();
      const parsed = parseProfileUrl(options.profileUrl);
      const profileUrl = typeof parsed === "string" ? parsed : parsed.url || parsed.profileUrl;
      if (!profileUrl) throw new Error("小红书主页链接无效。");
      const intervalSeconds = interval(options.intervalSeconds, 10, 3, 3600, "请求间隔");
      const jitterSeconds = interval(options.jitterSeconds, 3, 0, 300, "随机延迟");
      if (typeof options.directory !== "string" || !path.isAbsolute(options.directory)) throw new Error("请先选择下载目录。");
      const directory = await fs.realpath(options.directory);
      if (!(await fs.stat(directory)).isDirectory()) throw new Error("保存位置不是目录。");
      await this._stop("paused", "任务已暂停。");
      const sameJob = this.state.profileUrl === profileUrl && this.state.directory === directory;
      const items = sameJob ? this.state.items.map((item) => ({ ...item, status: FINISHED.has(item.status) ? item.status : "pending", error: "" })) : [];
      this.state = { ...initialState(this.now()), profileUrl, directory, intervalSeconds, jitterSeconds, items, status: "discovering", phase: "discovery", message: "正在读取主页帖子列表…" };
      this._lastRequestAt = null;
      await this._save();
      this._launch();
      return this.snapshot();
    });
  }

  pause() { return this._command(() => this._stop("paused", "任务已暂停；已完成的文件会保留。")); }
  cancel() { return this._command(() => this._stop("cancelled", "任务已取消；已下载文件保留，可继续任务。")); }
  shutdown() { return this.pause(); }

  async _stop(status, message) {
    if (this._controller) {
      this._controller.abort();
      await this._runTask;
    }
    if (this.state.profileUrl && (this.state.status !== "completed" || status === "cancelled")) {
      this.state.status = status;
      this.state.message = message;
      this.state.nextRequestAt = null;
      this.state.currentTitle = "";
      for (const item of this.state.items) if (item.status === "downloading") item.status = "pending";
      await this._save();
      this._emit();
    }
    return this.snapshot();
  }

  resume() { return this._command(() => this._resume()); }

  async _resume(retryIds = null) {
    await this._authorize();
    if (this._runTask) return this.snapshot();
    if (!this.state.profileUrl || !this.state.directory) throw new Error("没有可以继续的主页下载任务。");
    await fs.access(this.state.directory);
    this.state.status = retryIds || this.state.discoveryComplete ? "downloading" : "discovering";
    this.state.message = retryIds ? `正在重试 ${retryIds.size} 篇失败的帖子…`
      : this.state.discoveryComplete ? "正在验证文件并继续下载…" : "正在重新读取主页并合并已发现的帖子…";
    await this._save();
    this._launch(retryIds);
    return this.snapshot();
  }

  retryFailed() {
    return this._command(async () => {
      if (this._runTask) throw new Error("请先暂停任务，再重试失败的帖子。");
      const failed = this.state.items.filter(item => item.status === "failed");
      if (!failed.length) return this.snapshot();
      await this._authorize();
      for (const item of failed) { item.status = "pending"; item.error = ""; }
      return this._resume(new Set(failed.map(item => item.id)));
    });
  }

  retryItem(noteId) {
    return this._command(async () => {
      if (this._runTask) throw new Error("请先暂停任务，再重试失败的帖子。");
      if (typeof noteId !== "string" || !ITEM_ID.test(noteId)) throw new Error("笔记 ID 无效。");
      const item = this.state.items.find(item => item.id === noteId);
      if (!item) throw new Error("未找到这篇帖子。");
      if (item.status !== "failed") throw new Error("只有失败的帖子可以单项重试。");
      await this._authorize();
      item.status = "pending";
      item.error = "";
      return this._resume(new Set([noteId]));
    });
  }

  _launch(retryIds = null) {
    this._directoryIndex = null;
    this._controller = new AbortController();
    const controller = this._controller;
    const signal = controller.signal;
    let authorizationError = null, checkingAuthorization = false;
    // A revoked device stops even during a long download/discovery request.
    const authorizationTimer = setInterval(async () => {
      if (checkingAuthorization || signal.aborted) return;
      checkingAuthorization = true;
      try { await this._authorize(); }
      catch (error) { authorizationError = error; controller.abort(error); }
      finally { checkingAuthorization = false; }
    }, this.authorizationIntervalMs);
    authorizationTimer.unref?.();
    this._emit();
    this._runTask = this._run(signal, retryIds).catch(async (error) => {
      if (authorizationError) error = authorizationError;
      else if (signal.aborted || error.name === "AbortError") return;
      this.state.status = PAUSE_CODES.has(error.code) ? "paused" : "error";
      this.state.message = error.message || "主页下载中断，请重试。";
      this.state.nextRequestAt = null;
      for (const item of this.state.items) if (item.status === "downloading") item.status = "pending";
      await this._save();
      this._emit();
    }).catch((error) => {
      this.state.status = "error";
      this.state.message = `无法保存任务记录：${error.message}。请检查磁盘空间及目录权限。`;
      this.state.nextRequestAt = null;
      this._emit();
    }).finally(() => { clearInterval(authorizationTimer); this._runTask = null; this._controller = null; });
  }

  async _authorize() {
    try { await this.authorize('profile-download'); }
    catch (error) {
      throw Object.assign(new Error(error.message || '软件账号授权不可用，任务已暂停。'), { code: 'ACCOUNT_AUTHORIZATION_REQUIRED', cause: error });
    }
  }

  async _run(signal, retryIds = null) {
    await this._authorize();
    if (!retryIds && !this.state.discoveryComplete) {
      this.state.phase = "discovery";
      this.state.status = "discovering";
      this._emit();
      for await (const page of this.browser.discover(this.state.profileUrl, {
        signal, intervalSeconds: this.state.intervalSeconds, jitterSeconds: this.state.jitterSeconds
      })) {
        throwIfAborted(signal);
        await this._authorize();
        this._lastRequestAt = this.now();
        const indexed = new Map(this.state.items.map((item) => [item.id, item]));
        let nextSequence = this.state.items.reduce((highest, item) => Math.max(highest, item.sequence || 0), 0) + 1;
        for (const raw of page.notes || []) {
          const note = noteDescriptor(raw);
          const existing = indexed.get(note.id);
          if (existing) { existing.url = note.url; if (note.title && !existing.titleResolved) existing.title = note.title; }
          else {
            const sequence = nextSequence++;
            const item = { ...note, sequence, directoryName: "", titleResolved: false, status: "pending", error: "", complete: false, files: [] };
            this.state.items.push(item);
            indexed.set(note.id, item);
          }
        }
        if (page.profileName) this.state.profileName = String(page.profileName).slice(0, 200);
        this.state.discoveryComplete = page.done === true;
        this.state.message = `已发现 ${this.state.items.length} 篇帖子${page.done ? "，开始保存媒体。" : "，继续加载主页…"}`;
        await this._save();
        this._emit();
        if (page.done) break;
      }
      if (!this.state.discoveryComplete) throw Object.assign(new Error("主页尚未确认加载到底，任务已暂停。继续后会重新检查并补全列表。"), { code: "DISCOVERY_INCOMPLETE" });
    }
    this.state.phase = "download";
    for (const item of this.state.items) {
      throwIfAborted(signal);
      if (item.status === "failed" || (retryIds && !retryIds.has(item.id))) continue;
      await this._authorize();
      this.state.status = "downloading";
      this.state.currentTitle = item.title || item.id;
      item.status = "downloading";
      item.error = "";
      await this._save();
      this._emit();
      try { await this._downloadNote(item, signal); }
      catch (error) {
        if (signal.aborted || error.name === "AbortError") { item.status = "pending"; throw abortError(); }
        if (PAUSE_CODES.has(error.code)) { item.status = "pending"; throw error; }
        item.status = "failed";
        item.error = error.message || "下载失败";
      }
      await this._save();
      this._emit();
    }
    throwIfAborted(signal);
    const failed = this.state.items.filter((item) => item.status === "failed").length;
    const unfinished = !this.state.discoveryComplete || this.state.items.some(item => item.status === "pending");
    this.state.status = unfinished ? "paused" : "completed";
    this.state.phase = unfinished ? "download" : "done";
    this.state.currentTitle = "";
    this.state.nextRequestAt = null;
    this.state.message = unfinished ? "重试已结束，其余任务已保留。点击继续任务可处理剩余帖子。"
      : failed ? `任务结束，${failed} 篇帖子失败，可点击重试失败项。` : `主页加载完成，已处理 ${this.state.items.length} 篇帖子。`;
    await this._save();
    this._emit();
  }

  async _pace(signal) {
    throwIfAborted(signal);
    const delay = this.state.intervalSeconds * 1000 + Math.max(0, Math.min(1, this.random())) * this.state.jitterSeconds * 1000;
    if (this._lastRequestAt !== null) {
      const next = this._lastRequestAt + delay;
      const remaining = next - this.now();
      if (remaining > 0) {
        this.state.status = "waiting";
        this.state.nextRequestAt = next;
        this.state.message = "按设定间隔等待下一次请求…";
        this._emit();
        await this.sleep(remaining, signal);
      }
    }
    throwIfAborted(signal);
    await this._authorize();
    throwIfAborted(signal);
    this._lastRequestAt = this.now();
    this.state.status = "downloading";
    this.state.nextRequestAt = null;
    this.state.message = `正在保存：${this.state.currentTitle}`;
    this._emit();
  }

  async _retry(operation, signal) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await operation(attempt); }
      catch (error) {
        if (signal.aborted || error.name === "AbortError" || PAUSE_CODES.has(error.code) || attempt === 2) throw error;
        // Every retry goes through _pace too, so failures cannot increase request frequency.
        this.state.message = `请求失败，准备第 ${attempt + 1} 次重试：${error.message}`;
        this._emit();
      }
    }
  }

  async _readManifest(directory) {
    await assertSafeDirectory(this.state.directory, directory);
    const filename = path.join(directory, ".xhs-download.json");
    let stat;
    try { stat = await fs.lstat(filename); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 2 * 1024 * 1024) {
      throw new Error("已有下载记录不是有效普通文件。");
    }
    let saved;
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const current = await handle.stat();
      if (!current.isFile() || current.nlink > 1 || current.size > 2 * 1024 * 1024) throw new Error("已有下载记录不是有效普通文件。");
      saved = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("已有下载记录损坏，未覆盖原文件。");
      throw error;
    } finally { await handle?.close(); }
    if (saved.version !== 1 || !ITEM_ID.test(saved.id || "") || !Array.isArray(saved.files)) {
      throw new Error("已有下载记录无效，未覆盖原文件。");
    }
    return saved;
  }

  async _indexDirectories(signal) {
    if (this._directoryIndex) return this._directoryIndex;
    const index = new Map();
    const root = this.state.directory;
    await assertSafeDirectory(root, root);
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      throwIfAborted(signal);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (!ITEM_ID.test(entry.name) && !/^\d{3,}-/.test(entry.name))) continue;
      try {
        const manifest = await this._readManifest(path.join(root, entry.name));
        if (!manifest) continue;
        const candidates = index.get(manifest.id) || [];
        candidates.push({ name: entry.name, manifest });
        index.set(manifest.id, candidates);
      } catch { /* Unrelated or damaged folders never authorize an overwrite. */ }
    }
    this._directoryIndex = index;
    return index;
  }

  async _prepareDirectory(item, signal) {
    throwIfAborted(signal);
    const root = this.state.directory;
    const index = await this._indexDirectories(signal);
    const candidates = [...new Set([
      item.directoryName, item.id, ...(index.get(item.id) || []).map(entry => entry.name)
    ].filter(Boolean))];
    let source;
    for (const name of candidates) {
      throwIfAborted(signal);
      if (!isSafeDirectoryName(name)) throw new Error("任务记录中的笔记文件夹名称无效。");
      const directory = path.join(root, name);
      let stat;
      try { stat = await fs.lstat(directory); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("笔记文件夹不能是符号链接或普通文件。");
      const manifest = await this._readManifest(directory);
      if (manifest && manifest.id !== item.id) throw new Error("笔记文件夹属于另一篇帖子，未覆盖原文件。");
      if (!manifest && !item.files.length && (await fs.readdir(directory)).length) {
        if (name === item.directoryName) throw new Error("无法确认已有文件夹属于这篇帖子，未覆盖原文件。");
        continue;
      }
      source = { name, directory, manifest };
      break;
    }
    if (source?.manifest) {
      const saved = source.manifest;
      item.files = saved.files;
      item.complete = saved.complete === true;
      if (!item.titleResolved && (saved.titleResolved || saved.complete || saved.files.length)) {
        if (saved.title) item.title = String(saved.title);
        item.titleResolved = true;
      }
    }
    const preferred = noteDirectoryName(item.sequence, item.title);
    let name;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      const candidate = attempt === 0 ? preferred : `${preferred}-${item.id}${attempt > 1 ? `-${attempt}` : ""}`;
      if (source?.name === candidate) { name = candidate; break; }
      try { await fs.lstat(path.join(root, candidate)); }
      catch (error) { if (error.code === "ENOENT") { name = candidate; break; } throw error; }
    }
    throwIfAborted(signal);
    let directory;
    if (source) directory = await renameNoteDirectory(root, source.name, name);
    else directory = await ensureNoteDirectory(root, name);
    item.directoryName = name;
    await this._writeManifest(directory, item);
    index.set(item.id, [{ name }]);
    await this._save();
    return directory;
  }

  async _downloadNote(item, signal) {
    const root = this.state.directory;
    let directory = await this._prepareDirectory(item, signal);
    if (item.complete && item.files.length && item.files.some((file) => file.kind !== "metadata")) {
      let verified = true;
      for (const file of item.files) if (!await verifyFile(root, directory, file, signal)) { verified = false; break; }
      if (verified) { item.status = "skipped"; this.state.message = `已验证并跳过：${item.title || item.id}`; return; }
    }
    const note = await this._retry(async () => {
      await this._pace(signal);
      return this.browser.resolveNote(item, { signal });
    }, signal);
    throwIfAborted(signal);
    if (!note || !["exact-initial-state", "note-id-local-media", "note-id-local-image-list", "note-id-local-video"].includes(note.strategy)) {
      throw new Error("未取得完整且属于当前帖子的媒体信息，未将此帖标为完成；请登录后重试。");
    }
    const assets = mediaAssets(note);
    if (!assets.length) throw new Error("此帖未解析到可下载的媒体，请登录后重试。");
    if ((note.images || []).some((image) => image.livePhoto && !image.liveVideo?.url)) throw new Error("实况照片缺少配对视频，未将此帖标为完整下载。请稍后重试。");
    item.title = String(note.title || item.title || "未命名帖子");
    item.titleResolved = true;
    directory = await this._prepareDirectory(item, signal);
    item.strategy = String(note.strategy || "");
    item.complete = false;
    this.state.currentTitle = item.title;
    const existingFiles = item.files;
    item.files = [];
    for (const asset of assets) {
      throwIfAborted(signal);
      const existing = existingFiles.find((file) => file.key === asset.key && file.url === asset.url);
      if (existing && await verifyFile(root, directory, existing, signal)) item.files.push(existing);
      else item.files.push(await this._retry(async (attempt) => {
        const urls = [...new Set([asset.url, ...(Array.isArray(asset.backupUrls) ? asset.backupUrls : [])])];
        const result = await downloadMedia({
          ...this.mediaOptions, root, directory, asset: { ...asset, url: urls[attempt % urls.length] }, signal,
          fetchImpl: this.fetchImpl, beforeRequest: (requestSignal) => this._pace(requestSignal)
        });
        return { ...result, url: asset.url, downloadedUrl: result.url };
      }, signal));
      await this._writeManifest(directory, item);
      await this._save();
    }
    const noteText = Buffer.from(makeNoteTextFileData({ title: item.title, content: note.content, sourceUrl: item.url, engine: "desktop", generatedAt: new Date(this.now()) }));
    const metadata = Buffer.from(JSON.stringify({
      id: item.id, title: item.title, content: note.content || "", sourceUrl: item.url,
      profileUrl: this.state.profileUrl, strategy: item.strategy, downloadedAt: new Date(this.now()).toISOString(),
      images: note.images || [], videos: note.videos || [], files: item.files
    }, null, 2));
    for (const [name, data] of [["笔记.txt", noteText], ["笔记.json", metadata]]) {
      await atomicWrite(root, directory, name, data);
      item.files.push(fileRecord(name, data));
    }
    item.complete = true;
    await this._writeManifest(directory, item);
    item.status = "completed";
    this.state.message = `已保存：${item.title}`;
  }

  async _writeManifest(directory, item) {
    await atomicWrite(this.state.directory, directory, ".xhs-download.json", JSON.stringify({
      version: 1, id: item.id, sequence: item.sequence, directoryName: item.directoryName,
      title: item.title, titleResolved: item.titleResolved, complete: item.complete, files: item.files
    }, null, 2));
  }

  _save() {
    this.state.updatedAt = this.now();
    const serialized = JSON.stringify(this.state, null, 2);
    const save = this._saveChain.then(() => atomicWrite(this.stateDirectory, this.stateDirectory, STATE_FILENAME, serialized));
    this._saveChain = save.catch(() => {});
    return save;
  }

  _emit() {
    this.state.updatedAt = this.now();
    try { this.onUpdate(this.snapshot()); } catch { /* Renderer lifecycle must not interrupt disk work. */ }
  }
}
