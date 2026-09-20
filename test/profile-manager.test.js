import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProfileManager } from "../desktop/profile-manager.js";
import { downloadMedia, safeFilename } from "../desktop/media-download.js";

const PROFILE = "https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c";
const A = "111111111111111111111111";
const B = "222222222222222222222222";
const note = (id = A) => ({ id, url: `https://www.xiaohongshu.com/explore/${id}`, title: `标题 ${id}` });
const imageUrl = (key = "image") => `https://ci.xiaohongshu.com/${key}?imageView2/format/jpg`;
const videoUrl = (key = "video") => `https://sns-video-bd.xhscdn.com/${key}.mp4`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 4, 5, 6, 0xff, 0xd9]);
const MP4 = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isomiso2", "binary");
function noteFolder(fixture, id = A) {
  return path.join(fixture.directory, fixture.manager.snapshot().items.find(item => item.id === id)?.directoryName || id);
}
function parsed(overrides = {}) {
  return { title: "测试标题：/路径", content: "第一行\n第二行", strategy: "exact-initial-state", images: [{ url: imageUrl() }], videos: [], ...overrides };
}
function mediaResponse(url) {
  const video = String(url).includes(".mp4");
  const body = video ? MP4 : JPEG;
  return new Response(body, { headers: { "content-type": video ? "video/mp4" : "image/jpeg", "content-length": String(body.length) } });
}
async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xhs-profile-test-")));
  const directory = path.join(base, "downloads");
  const stateDirectory = path.join(base, "state");
  await fs.mkdir(directory);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let clock = 100000;
  const requests = [];
  const waits = [];
  const browser = options.browser || {
    async *discover() { yield { notes: [note()], done: true }; },
    async resolveNote(item) { requests.push({ type: "note", id: item.id, at: clock }); return parsed(); }
  };
  const fetchImpl = options.fetchImpl || (async (url, options) => {
    requests.push({ type: "media", url, at: clock, redirect: options.redirect });
    return mediaResponse(url);
  });
  const config = {
    stateDirectory, browser, fetchImpl, authorize: async () => ({ authorized: true }), now: () => clock, random: () => 0.5,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); clock += ms; },
    ...options
  };
  const manager = new ProfileManager(config);
  await manager.initialize();
  const start = async (extra = {}) => manager.start({ profileUrl: PROFILE, directory, intervalSeconds: 3, jitterSeconds: 3, ...extra });
  const settle = async () => { await manager._runTask; return manager.snapshot(); };
  return { base, directory, stateDirectory, requests, waits, manager, config, start, settle };
}

test("profile queue deduplicates notes and saves images, paired live MP4, default video and metadata sequentially", async (t) => {
  const f = await fixture(t);
  f.manager.browser = {
    async *discover() {
      yield { notes: [note(A), note(A)], done: false, profileName: "作者" };
      yield { notes: [note(B)], done: true };
    },
    async resolveNote(item) {
      f.requests.push({ type: "note", at: f.manager.now(), id: item.id });
      return parsed({
        images: [{ url: imageUrl(item.id), livePhoto: true, liveVideo: { url: videoUrl("live") } }],
        videos: [{ url: videoUrl("low") }, { url: videoUrl("high"), isDefault: true }]
      });
    }
  };
  await f.start();
  const result = await f.settle();
  assert.equal(result.status, "completed");
  assert.equal(result.discoveryComplete, true);
  assert.equal(result.discovered, 2);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.profileName, "作者");
  const names = await fs.readdir(noteFolder(f, A));
  assert.deepEqual(names.sort(), [".xhs-download.json", "image-001.jpg", "live-001.mp4", "video.mp4", "笔记.json", "笔记.txt"].sort());
  assert.match(await fs.readFile(path.join(noteFolder(f, A), "笔记.txt"), "utf8"), /^\uFEFF小红书笔记/);
  assert.match(await fs.readFile(path.join(noteFolder(f, A), "笔记.txt"), "utf8"), /第一行\n第二行/);
  assert.equal(f.requests.some((item) => item.url === videoUrl("low")), false);
  for (let index = 1; index < f.requests.length; index++) assert.ok(f.requests[index].at - f.requests[index - 1].at >= 4500);
  assert.ok(f.requests.filter((item) => item.type === "media").every((item) => item.redirect === "manual"));
});

test("restart performs no network and skips only files whose size and SHA-256 both verify", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.settle();
  f.requests.length = 0;
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).status, "completed");
  assert.equal(f.requests.length, 0);
  await restored.resume();
  await restored._runTask;
  assert.equal(restored.snapshot().skipped, 1);
  assert.equal(f.requests.length, 0);
  const imagePath = path.join(noteFolder(f, A), "image-001.jpg");
  await fs.writeFile(imagePath, Buffer.alloc(JPEG.length, 42));
  await restored.resume();
  await restored._runTask;
  assert.equal(restored.snapshot().completed, 1);
  assert.deepEqual(await fs.readFile(imagePath), JPEG);
  assert.equal(f.requests.filter((item) => item.type === "media").length, 1);
});

test("incomplete discovery is persisted and pauses without claiming completion; resume merges and finishes", async (t) => {
  let run = 0;
  const f = await fixture(t, { browser: {
    async *discover() { run++; yield { notes: [note(A)], done: run > 1 }; },
    async resolveNote() { return parsed(); }
  } });
  await f.start();
  let result = await f.settle();
  assert.equal(result.status, "paused");
  assert.equal(result.discoveryComplete, false);
  assert.equal(result.discovered, 1);
  assert.equal(result.completed, 0);
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).status, "paused");
  assert.equal(run, 1);
  await restored.resume();
  await restored._runTask;
  result = restored.snapshot();
  assert.equal(result.status, "completed");
  assert.equal(result.discoveryComplete, true);
  assert.equal(result.discovered, 1);
  assert.equal(result.completed, 1);
});

test("pause aborts detail parsing, flushes pending state, and resumes successfully", async (t) => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let block = true;
  const f = await fixture(t, { browser: {
    async *discover() { yield { notes: [note()], done: true }; },
    async resolveNote(_note, { signal }) {
      if (!block) return parsed();
      began();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })), { once: true }));
    }
  } });
  await f.start();
  await started;
  await f.manager.pause();
  assert.equal(f.manager.snapshot().status, "paused");
  const state = JSON.parse(await fs.readFile(path.join(f.stateDirectory, "profile-job.json"), "utf8"));
  assert.equal(state.items[0].status, "pending");
  assert.equal(state.status, "paused");
  block = false;
  await f.manager.resume();
  assert.equal((await f.settle()).completed, 1);
});

test("cancel interrupts scheduled requests and preserves the resumable queue", async (t) => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const f = await fixture(t, { sleep: (_ms, signal) => {
    began();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })), { once: true }));
  } });
  await f.start();
  await started;
  await f.manager.cancel();
  assert.equal(f.manager.snapshot().status, "cancelled");
  assert.equal(f.manager.snapshot().discovered, 1);
  assert.equal(f.requests.length, 0);
});

test("transient media failure retries at most three times, removes partials, and supports retry failed", async (t) => {
  let attempts = 0;
  let good = false;
  const f = await fixture(t, { fetchImpl: async (url) => {
    attempts++;
    if (good) return mediaResponse(url);
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(JPEG.subarray(0, 4)); }
      else controller.error(new Error("connection closed"));
    } }), { headers: { "content-type": "image/jpeg" } });
  } });
  await f.start();
  assert.equal((await f.settle()).failed, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(await fs.readdir(noteFolder(f, A)), [".xhs-download.json"]);
  good = true;
  await f.manager.retryFailed();
  assert.equal((await f.settle()).completed, 1);
  assert.equal(attempts, 4);
});

test("rate limiting pauses immediately without retries or a false completed item", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { fetchImpl: async () => { attempts++; return new Response("too many", { status: 429 }); } });
  await f.start();
  const result = await f.settle();
  assert.equal(result.status, "paused");
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.equal(attempts, 1);
  assert.equal(result.items[0].status, "pending");
});

test("video backup URLs are attempted with pacing when the selected stream fails", async (t) => {
  const f = await fixture(t);
  f.manager.browser.resolveNote = async () => parsed({ images: [], videos: [{ isDefault: true, url: videoUrl("broken"), backupUrls: [videoUrl("working")] }] });
  const urls = [];
  f.manager.fetchImpl = async (url) => {
    urls.push({ url, at: f.manager.now() });
    return url === videoUrl("broken") ? new Response("missing", { status: 404 }) : mediaResponse(url);
  };
  await f.start();
  assert.equal((await f.settle()).completed, 1);
  assert.deepEqual(urls.map(({ url }) => url), [videoUrl("broken"), videoUrl("working")]);
  assert.ok(urls[1].at - urls[0].at >= 4500);
});

test("primary-meta covers and live photos missing paired videos are never marked complete", async (t) => {
  for (const detail of [parsed({ strategy: "primary-meta-cover" }), parsed({ images: [{ url: imageUrl(), livePhoto: true }] })]) {
    const f = await fixture(t);
    f.manager.browser.resolveNote = async () => detail;
    await f.start();
    assert.equal((await f.settle()).failed, 1);
    assert.equal(f.requests.some((item) => item.type === "media"), false);
  }
});

test("profile, timing, and discovery note URLs are validated before downloading", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.start({ intervalSeconds: 2 }), /3–3600/);
  await assert.rejects(f.start({ intervalSeconds: 3.1 }), /3–3600/);
  await assert.rejects(f.start({ jitterSeconds: 301 }), /0–300/);
  await assert.rejects(f.start({ profileUrl: "https://evil.example/user/profile/5e413a430000000001000f4c" }), /主页链接/);
  f.manager.browser.discover = async function* () { yield { notes: [{ ...note(), url: "https://evil.example/explore/" + A }], done: true }; };
  await f.start();
  assert.equal((await f.settle()).status, "error");
  assert.equal(f.requests.length, 0);
});

test("redirects are checked individually and cannot downgrade HTTPS or reach foreign hosts", async (t) => {
  const f = await fixture(t);
  for (const location of ["https://evil.example/file.jpg", "http://ci.xiaohongshu.com/file.jpg", "https://ci.xiaohongshu.com:8443/file.jpg", "https://user:pass@ci.xiaohongshu.com/file.jpg"]) {
    const calls = [];
    await assert.rejects(downloadMedia({ root: f.directory, directory: f.directory, asset: { key: "test", kind: "image", url: imageUrl() }, beforeRequest: async () => {}, fetchImpl: async (url) => { calls.push(url); return new Response(null, { status: 302, headers: { location } }); } }), /重定向/);
    assert.equal(calls.length, 1);
  }
});

test("streamed media enforces size, MIME and signature and leaves no .part files on failure", async (t) => {
  const f = await fixture(t);
  for (const [response, maxBytes] of [
    [new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), 512],
    [new Response("<html>login</html>", { headers: { "content-type": "image/jpeg" } }), 512],
    [new Response(JPEG, { headers: { "content-type": "image/jpeg", "content-length": "500" } }), 512],
    [new Response(JPEG, { headers: { "content-type": "image/jpeg" } }), 8]
  ]) {
    await assert.rejects(downloadMedia({ root: f.directory, directory: f.directory, asset: { key: "test", kind: "image", url: imageUrl() }, maxBytes, beforeRequest: async () => {}, fetchImpl: async () => response }));
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test("a note-directory symlink cannot redirect writes outside the chosen folder", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, noteFolder(f, A), process.platform === "win32" ? "junction" : "dir");
  await f.start();
  assert.equal((await f.settle()).failed, 1);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.requests.length, 0);
});

test("Windows reserved filenames and path separators are sanitized", () => {
  assert.equal(safeFilename("CON"), "_CON");
  assert.equal(safeFilename("A/B\\C:*? ."), "A_B_C___");
  assert.equal(safeFilename(".."), "untitled");
  assert.equal(safeFilename("小红书视频"), "小红书视频");
});

test("state persistence failure becomes a visible error without an unhandled background rejection", async (t) => {
  const f = await fixture(t);
  const original = f.manager._save.bind(f.manager);
  let saves = 0;
  f.manager._save = async () => { if (++saves > 1) throw new Error("ENOSPC fixture"); return original(); };
  await f.start();
  await f.settle();
  assert.equal(f.manager.snapshot().status, "error");
  assert.match(f.manager.snapshot().message, /ENOSPC fixture/);
});

test("a partially completed note keeps verified media across a failed retry and restart", async (t) => {
  const f = await fixture(t);
  const first = imageUrl("first");
  const second = imageUrl("second");
  f.manager.browser.resolveNote = async () => parsed({ images: [{ url: first }, { url: second }] });
  let failing = true;
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url === second && failing ? new Response("missing", { status: 404 }) : mediaResponse(url);
  };
  f.manager.fetchImpl = fetchImpl;
  await f.start();
  assert.equal((await f.settle()).failed, 1);
  assert.equal(urls.filter((url) => url === first).length, 1);
  failing = false;
  const restored = new ProfileManager({ ...f.config, fetchImpl });
  restored.browser = f.manager.browser;
  await restored.initialize();
  await restored.retryFailed();
  await restored._runTask;
  assert.equal(restored.snapshot().completed, 1);
  assert.equal(urls.filter((url) => url === first).length, 1);
  assert.deepEqual(await fs.readFile(path.join(noteFolder(f, A), "image-001.jpg")), JPEG);
});

test("media is streamed over multiple chunks and atomically published with the exact bytes", async (t) => {
  const f = await fixture(t);
  const chunks = [JPEG.subarray(0, 2), JPEG.subarray(2, 6), JPEG.subarray(6)];
  const record = await downloadMedia({ root: f.directory, directory: f.directory,
    asset: { key: "stream", kind: "image", url: imageUrl() }, beforeRequest: async () => {},
    fetchImpl: async () => new Response(new ReadableStream({
      async pull(controller) {
        assert.equal((await fs.readdir(f.directory)).includes("stream.jpg"), false);
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      }
    }), { headers: { "content-type": "image/jpeg", "content-length": String(JPEG.length) } })
  });
  assert.equal(record.bytes, JPEG.length);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "stream.jpg")), JPEG);
  assert.deepEqual(await fs.readdir(f.directory), ["stream.jpg"]);
});

test("an existing media symlink cannot overwrite a file outside the download directory", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.base, "outside.jpg");
  await fs.writeFile(target, "keep this file");
  await fs.symlink(target, path.join(f.directory, "stream.jpg"));
  await assert.rejects(downloadMedia({ root: f.directory, directory: f.directory,
    asset: { key: "stream", kind: "image", url: imageUrl() }, beforeRequest: async () => {}, fetchImpl: async () => mediaResponse(imageUrl())
  }), /不是普通文件/);
  assert.equal(await fs.readFile(target, "utf8"), "keep this file");
  assert.deepEqual(await fs.readdir(f.directory), ["stream.jpg"]);
});

test("note directories use stable discovery order and the resolved, cross-platform safe title", async (t) => {
  const f = await fixture(t);
  f.manager.browser = {
    async *discover() { yield { notes: [{ ...note(A), title: "截断标题…" }, { ...note(B), title: "" }], done: true }; },
    async resolveNote(item) { return parsed({ title: item.id === A ? "完整/标题?" : "" }); }
  };
  await f.start();
  const result = await f.settle();
  assert.deepEqual(result.items.map(item => [item.sequence, item.directoryName]), [[1, "001-完整_标题_"], [2, "002-未命名帖子"]]);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ["001-完整_标题_", "002-未命名帖子"]);
  for (const item of result.items) {
    const manifest = JSON.parse(await fs.readFile(path.join(f.directory, item.directoryName, ".xhs-download.json"), "utf8"));
    assert.equal(manifest.id, item.id);
    assert.equal(manifest.sequence, item.sequence);
    assert.equal(manifest.directoryName, item.directoryName);
    assert.equal(manifest.complete, true);
  }
  const restored = new ProfileManager(f.config);
  assert.deepEqual((await restored.initialize()).items.map(item => [item.sequence, item.directoryName]), result.items.map(item => [item.sequence, item.directoryName]));
});

test("legacy v1.5 note-ID directories migrate without downloading verified files again", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.settle();
  const legacy = path.join(f.directory, A);
  await fs.rename(noteFolder(f), legacy);
  const manifestPath = path.join(legacy, ".xhs-download.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.sequence; delete manifest.directoryName; delete manifest.titleResolved;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const statePath = path.join(f.stateDirectory, "profile-job.json");
  const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
  for (const item of saved.items) { delete item.sequence; delete item.directoryName; delete item.titleResolved; }
  await fs.writeFile(statePath, JSON.stringify(saved));
  f.requests.length = 0;
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).items[0].sequence, 1);
  await restored.resume(); await restored._runTask;
  const result = restored.snapshot();
  assert.equal(result.skipped, 1);
  assert.equal(result.items[0].directoryName, "001-测试标题__路径");
  assert.equal(f.requests.length, 0);
  await assert.rejects(fs.access(legacy), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.directory, result.items[0].directoryName, "image-001.jpg")), JPEG);
});

test("a renamed directory is recovered by manifest ID after interruption before state was saved", async (t) => {
  const f = await fixture(t);
  await f.start(); await f.settle();
  await fs.rename(noteFolder(f), path.join(f.directory, "001-中断时的目录名"));
  f.requests.length = 0;
  const restored = new ProfileManager(f.config);
  await restored.initialize(); await restored.resume(); await restored._runTask;
  assert.equal(restored.snapshot().skipped, 1);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await fs.readdir(f.directory), ["001-测试标题__路径"]);
});

test("directory-name conflicts preserve unrelated content and use a deterministic note-ID suffix", async (t) => {
  const f = await fixture(t);
  const occupied = path.join(f.directory, "001-测试标题__路径");
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, "do-not-touch.txt"), "保留其他文件");
  await fs.writeFile(path.join(occupied, ".xhs-download.json"), JSON.stringify({ version: 1, id: B, files: [], complete: false }));
  await f.start();
  const result = await f.settle();
  assert.equal(result.completed, 1);
  assert.equal(result.items[0].directoryName, `001-测试标题__路径-${A}`);
  assert.equal(await fs.readFile(path.join(occupied, "do-not-touch.txt"), "utf8"), "保留其他文件");
  f.requests.length = 0;
  await f.manager.resume(); await f.settle();
  assert.equal(f.manager.snapshot().items[0].directoryName, result.items[0].directoryName);
  assert.equal(f.requests.length, 0);
});

test("title-based directory collisions cannot traverse a symlink or overwrite its destination", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, "untouched");
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  await fs.symlink(outside, path.join(f.directory, "001-测试标题__路径"), process.platform === "win32" ? "junction" : "dir");
  await f.start();
  assert.equal((await f.settle()).completed, 1);
  assert.deepEqual(await fs.readdir(outside), ["keep.txt"]);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
});

test("single-item and retry-all preserve sequence and never re-request successful posts", async (t) => {
  const C = "333333333333333333333333";
  const f = await fixture(t);
  const failures = new Set([B, C]);
  const resolved = [];
  f.manager.browser = {
    async *discover() { yield { notes: [note(A), note(B), note(C)], done: true }; },
    async resolveNote(item) { resolved.push(item.id); if (failures.has(item.id)) throw new Error("temporary fixture failure"); return parsed({ title: `帖子-${item.id}` }); }
  };
  await f.start(); await f.settle();
  assert.equal(f.manager.snapshot().failed, 2);
  const original = f.manager.snapshot().items.map(item => ({ id: item.id, sequence: item.sequence, directoryName: item.directoryName }));
  const firstImage = await fs.readFile(path.join(noteFolder(f, A), "image-001.jpg"));
  resolved.length = 0; f.requests.length = 0; failures.delete(B);
  await f.manager.retryItem(B); await f.settle();
  assert.deepEqual(resolved, [B]);
  assert.equal(f.manager.snapshot().items[0].status, "completed");
  assert.equal(f.manager.snapshot().items[2].status, "failed");
  assert.deepEqual(await fs.readFile(path.join(noteFolder(f, A), "image-001.jpg")), firstImage);
  assert.deepEqual(f.manager.snapshot().items.map(item => item.sequence), [1, 2, 3]);
  assert.equal(f.manager.snapshot().items[0].directoryName, original[0].directoryName);
  resolved.length = 0; failures.delete(C);
  await f.manager.retryFailed(); await f.settle();
  assert.deepEqual(resolved, [C]);
  assert.equal(f.manager.snapshot().completed, 3);
  await assert.rejects(f.manager.retryItem(A), /只有失败/);
  await assert.rejects(f.manager.retryItem("../outside"), /ID 无效/);
});

test("retrying one failed item leaves pending discovery and other queue items paused", async (t) => {
  const f = await fixture(t);
  const saved = { ...f.manager.state, profileUrl: PROFILE, directory: f.directory, status: "paused", discoveryComplete: false,
    items: [{ ...note(A), status: "failed", error: "old error", files: [], complete: false }, { ...note(B), status: "pending", files: [], complete: false }] };
  await fs.writeFile(path.join(f.stateDirectory, "profile-job.json"), JSON.stringify(saved));
  const calls = [];
  const restored = new ProfileManager({ ...f.config, browser: {
    async *discover() { throw new Error("single retry must not discover"); },
    async resolveNote(item) { calls.push(item.id); return parsed(); }
  } });
  await restored.initialize(); await restored.retryItem(A); await restored._runTask;
  assert.deepEqual(calls, [A]);
  const result = restored.snapshot();
  assert.equal(result.status, "paused");
  assert.equal(result.discoveryComplete, false);
  assert.equal(result.items[1].status, "pending");
  assert.deepEqual(result.items.map(item => item.sequence), [1, 2]);
});

test("active tasks clearly reject item retries without altering failed queue entries", async (t) => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { sleep: async (_ms, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("stop"), { name: "AbortError" })), { once: true }));
  } });
  await f.start(); await waiting;
  await assert.rejects(f.manager.retryItem(A), /请先暂停/);
  await assert.rejects(f.manager.retryFailed(), /请先暂停/);
  await f.manager.pause();
});

test("persisted path traversal is rejected and long Unicode titles remain safe filename components", async (t) => {
  const f = await fixture(t);
  f.manager.browser.resolveNote = async () => parsed({ title: "😀".repeat(100) + "/.." });
  await f.start(); await f.settle();
  const item = f.manager.snapshot().items[0];
  assert.ok(Buffer.byteLength(item.directoryName, "utf8") <= 240);
  assert.equal(path.basename(item.directoryName), item.directoryName);
  const file = path.join(f.stateDirectory, "profile-job.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.items[0].directoryName = "../outside";
  await fs.writeFile(file, JSON.stringify(saved));
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).status, "error");
});

test("rediscovery keeps existing sequence and resolved titles while new posts receive the next number", async (t) => {
  const C = "333333333333333333333333";
  const f = await fixture(t);
  let round = 0;
  const resolved = [];
  f.manager.browser = {
    async *discover() {
      round++;
      yield { notes: (round === 1 ? [A, B] : [C, B, A]).map(id => ({ ...note(id), title: "短标题…" })), done: true };
    },
    async resolveNote(item) { resolved.push(item.id); return parsed({ title: `完整标题-${item.id}` }); }
  };
  await f.start(); await f.settle();
  const first = f.manager.snapshot().items.map(item => ({ id: item.id, sequence: item.sequence, directoryName: item.directoryName }));
  resolved.length = 0;
  await f.start(); await f.settle();
  assert.deepEqual(resolved, [C]);
  assert.deepEqual(f.manager.snapshot().items.slice(0, 2).map(item => ({ id: item.id, sequence: item.sequence, directoryName: item.directoryName })), first);
  assert.equal(f.manager.snapshot().items[2].sequence, 3);
  assert.match(f.manager.snapshot().items[2].directoryName, /^003-完整标题/);
});
