import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractNoteId } from "../lib/xhs.js";
import { makeNoteTextFileData } from "../lib/archive.js";
import { parseProfileUrl } from "./profile-source.js";
import {
  atomicWrite, ensureNoteDirectory, verifyFile, downloadMedia,
  abortError, throwIfAborted, sleep as defaultSleep
} from "./media-download.js";

const ACTIVE = new Set(["discovering", "downloading", "waiting"]);
const FINISHED = new Set(["completed", "skipped"]);
const PAUSE_CODES = new Set(["AUTH_REQUIRED", "RATE_LIMITED", "DISCOVERY_INCOMPLETE"]);
const ITEM_ID = /^[a-f0-9]{24}$/i;
const STATE_FILENAME = "profile-job.json";

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
  constructor({ stateDirectory, browser, fetchImpl = globalThis.fetch, onUpdate = () => {}, now = Date.now, sleep = defaultSleep, random = Math.random, mediaOptions = {} }) {
    if (!stateDirectory || !browser) throw new Error("ProfileManager requires stateDirectory and browser.");
    this.stateDirectory = path.resolve(stateDirectory);
    this.browser = browser;
    this.fetchImpl = fetchImpl;
    this.onUpdate = onUpdate;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.mediaOptions = mediaOptions;
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
      saved.items = saved.items.map((item) => ({
        ...noteDescriptor(item), status: ["pending", "completed", "skipped", "failed"].includes(item.status) ? item.status : "pending",
        error: String(item.error || ""), files: Array.isArray(item.files) ? item.files : [],
        complete: Boolean(item.complete), strategy: String(item.strategy || "")
      }));
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
    const items = this.state.items.map(({ id, url, title, status, error }) => ({ id, url, title, status, error }));
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

  async _resume() {
    if (this._runTask) return this.snapshot();
    if (!this.state.profileUrl || !this.state.directory) throw new Error("没有可以继续的主页下载任务。");
    await fs.access(this.state.directory);
    this.state.status = this.state.discoveryComplete ? "downloading" : "discovering";
    this.state.message = this.state.discoveryComplete ? "正在验证文件并继续下载…" : "正在重新读取主页并合并已发现的帖子…";
    await this._save();
    this._launch();
    return this.snapshot();
  }

  retryFailed() {
    return this._command(async () => {
      if (this._runTask) throw new Error("请先暂停任务，再重试失败的帖子。");
      for (const item of this.state.items) if (item.status === "failed") { item.status = "pending"; item.error = ""; }
      return this._resume();
    });
  }

  _launch() {
    this._controller = new AbortController();
    const signal = this._controller.signal;
    this._emit();
    this._runTask = this._run(signal).catch(async (error) => {
      if (signal.aborted || error.name === "AbortError") return;
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
    }).finally(() => { this._runTask = null; this._controller = null; });
  }

  async _run(signal) {
    if (!this.state.discoveryComplete) {
      this.state.phase = "discovery";
      this.state.status = "discovering";
      this._emit();
      for await (const page of this.browser.discover(this.state.profileUrl, {
        signal, intervalSeconds: this.state.intervalSeconds, jitterSeconds: this.state.jitterSeconds
      })) {
        throwIfAborted(signal);
        this._lastRequestAt = this.now();
        const indexed = new Map(this.state.items.map((item) => [item.id, item]));
        for (const raw of page.notes || []) {
          const note = noteDescriptor(raw);
          const existing = indexed.get(note.id);
          if (existing) { existing.url = note.url; if (note.title) existing.title = note.title; }
          else {
            const item = { ...note, status: "pending", error: "", complete: false, files: [] };
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
      if (item.status === "failed") continue;
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
    this.state.status = "completed";
    this.state.phase = "done";
    this.state.currentTitle = "";
    this.state.nextRequestAt = null;
    this.state.message = failed ? `任务结束，${failed} 篇帖子失败，可点击重试失败项。` : `主页加载完成，已处理 ${this.state.items.length} 篇帖子。`;
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

  async _downloadNote(item, signal) {
    const root = this.state.directory;
    const directory = await ensureNoteDirectory(root, item.id);
    if (!item.files.length) {
      try {
        const manifestPath = path.join(directory, ".xhs-download.json");
        const stat = await fs.lstat(manifestPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("已有下载记录不是有效普通文件。");
        const saved = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        if (saved.id === item.id && saved.version === 1 && Array.isArray(saved.files)) {
          item.files = saved.files;
          item.complete = saved.complete === true;
          if (saved.title) item.title = String(saved.title);
        }
      } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    }
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
    item.title = String(note.title || item.title || item.id);
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
      version: 1, id: item.id, title: item.title, complete: item.complete, files: item.files
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
