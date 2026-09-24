import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  clipboardWriteFailureKind,
  clipboardWriteFailureMessageForKind,
  refineClipboardWriteFailureKind
} from "../lib/clipboard.js";
import { imageDimensionsFromHeader, validateImageDimensions } from "../lib/image-dimensions.js";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("shared image header preflight accepts byte views and enforces the existing pixel budget", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNocFD4DwAEBAHg8uuA+QAAAABJRU5ErkJggg==", "base64");
  const prefixed = Buffer.concat([Buffer.alloc(19), png]);
  assert.deepEqual(imageDimensionsFromHeader(prefixed.subarray(19)), { width: 1, height: 1 });
  assert.doesNotThrow(() => validateImageDimensions(4000, 5000));
  assert.throws(() => validateImageDimensions(4000, 5001), /像素过大/);
  assert.throws(() => validateImageDimensions(0, 100), /像素过大/);
  assert.throws(() => validateImageDimensions(100, 100, 9999), /像素过大/);
  assert.equal(imageDimensionsFromHeader(Buffer.from("unrecognized")), null);
});

function element() {
  const classes = new Set();
  return {
    attributes: {}, dataset: {}, style: {}, disabled: false, hidden: false, textContent: "",
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener() {},
    querySelectorAll: () => [],
    focus() { this.focused = true; }
  };
}

function images(count) {
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    url: `https://sns-webpic-qc.xhscdn.com/example-${index + 1}`,
    token: `proxy-only-token-${index + 1}`
  }));
}

function renderer({ desktop, secure = true, write, queryPermission, appSource = source } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], element()]));
  const calls = { writes: [], permissionQueries: 0, conversions: 0 };
  const timers = new Map();
  const context = vm.createContext({
    document: {
      querySelector: (selector) => nodes.get(selector.slice(1)) || null,
      querySelectorAll: () => []
    },
    window: {
      xhsDesktop: desktop,
      isSecureContext: secure,
      ClipboardItem: class {
        constructor(data) { this.data = data; }
        static supports() { return true; }
      }
    },
    navigator: {
      clipboard: {
        async write(items) {
          calls.writes.push(items);
          if (write) return write(items);
          await Promise.all(items.map((item) => item.data["image/png"]));
        }
      },
      permissions: {
        async query() {
          calls.permissionQueries += 1;
          return queryPermission ? queryPermission() : { state: "granted" };
        }
      }
    },
    localStorage: { getItem: () => null },
    initializeDesktopUI: async () => {},
    clipboardWriteFailureKind,
    clipboardWriteFailureMessageForKind,
    refineClipboardWriteFailureKind,
    imageDimensionsFromHeader,
    validateImageDimensions,
    AbortController,
    setTimeout: (callback) => { const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    pngFixture: async () => { calls.conversions += 1; return { size: 123 }; }
  });
  // Execute the actual page, including its selection UI and asynchronous write
  // queue. Stub only image conversion: network decoding is a separate concern.
  const normalizedSource = appSource.replace(/\r\n?/g, "\n");
  vm.runInContext(normalizedSource.replace(/^import[\s\S]*?;\n/gm, "") + `
    clipboardPngBlob = pngFixture;
    globalThis.renderer = { state, copyImages, updateSelectionUI };
  `, context, { filename: "app.js" });
  const api = context.renderer;
  return {
    ...api,
    calls,
    context,
    node: (id) => nodes.get(id),
    select(selectedImages) {
      api.state.images = selectedImages;
      api.state.selected = new Set(selectedImages.map((image) => image.index));
      api.updateSelectionUI();
    },
    copy(selectedImages) {
      this.select(selectedImages);
      return api.copyImages(selectedImages, nodes.get("copy-selected-images-button"));
    }
  };
}

test("Windows CRLF checkout executes the real desktop and browser copy paths", async () => {
  const appSource = source.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  assert.match(appSource, /\r\n/);
  let nativeCopies = 0;
  const desktopPage = renderer({
    appSource,
    desktop: { async copyImages(payload) {
      nativeCopies += 1;
      return { ok: true, count: payload.images.length, kind: "files" };
    } }
  });
  await desktopPage.copy(images(2));
  assert.equal(nativeCopies, 1);
  assert.equal(desktopPage.calls.writes.length, 0);
  assert.match(desktopPage.node("toast").textContent, /已复制 2 个独立图片文件/);

  const browserPage = renderer({ appSource });
  await browserPage.copy(images(2));
  assert.equal(browserPage.calls.writes.length, 1);
  assert.equal(browserPage.calls.conversions, 2);
  assert.match(browserPage.node("toast").textContent, /浏览器已接收/);
});

test("desktop copies original URLs natively even without browser clipboard support", async () => {
  let progress;
  let removed = 0;
  let payload;
  const page = renderer({
    secure: false,
    desktop: {
      onClipboardProgress(callback) { progress = callback; return () => { removed += 1; }; },
      async copyImages(value) {
        payload = value;
        assert.equal(page.node("progress-panel").hidden, false);
        assert.equal(page.node("copy-selected-images-button").disabled, true);
        progress({ completed: 1, total: 2, phase: "preparing" });
        assert.equal(page.node("progress-text").textContent, "1 / 2");
        progress({ completed: 2, total: 2, phase: "writing" });
        assert.match(page.node("progress-title").textContent, /系统剪贴板/);
        return { ok: true, count: value.images.length, kind: "files" };
      }
    }
  });
  delete page.context.window.ClipboardItem;
  delete page.context.navigator.clipboard;
  page.state.title = "原图标题";
  page.state.multipleClipboardItemsSupported = false;
  const selected = images(2);
  page.select(selected);
  assert.equal(page.node("copy-selected-images-button").disabled, false);
  assert.equal(page.node("clipboard-fallback").hidden, true);
  await page.copy(selected);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    title: "原图标题",
    images: selected.map(({ url, index }) => ({ url, index }))
  });
  assert.equal(page.calls.writes.length, 0);
  assert.equal(page.calls.conversions, 0);
  assert.equal(page.calls.permissionQueries, 0);
  assert.equal(removed, 1);
  assert.match(page.node("toast").textContent, /2 个独立图片文件.*支持多张图片或文件/);
  assert.equal(page.node("progress-panel").hidden, true);
  assert.equal(page.node("copy-selected-images-button").disabled, false);
  assert.equal(page.node("copy-selected-images-button").attributes["aria-busy"], undefined);
  assert.equal(page.state.busy, false);
});

test("desktop single-image copy uses native bridge and ordinary image paste message", async () => {
  const page = renderer({ desktop: { copyImages: async () => ({ ok: true, count: 1, kind: "image" }) } });
  await page.copy(images(1));
  assert.match(page.node("toast").textContent, /图片已写入剪贴板/);
  assert.equal(page.calls.writes.length, 0);
  assert.equal(page.calls.conversions, 0);
});

test("desktop single-file fallback accurately describes file paste compatibility", async () => {
  const page = renderer({ desktop: { copyImages: async () => ({ ok: true, count: 1, kind: "files" }) } });
  await page.copy(images(1));
  assert.equal(page.node("toast").textContent, "已复制 1 个独立图片文件，可粘贴到支持图片或文件的应用中。");
  assert.equal(page.calls.writes.length, 0);
  assert.equal(page.calls.conversions, 0);
});

test("native IPC errors hide only the known transport prefix", async () => {
  const page = renderer({ desktop: { copyImages: async () => {
    throw new Error("Error invoking remote method 'desktop:copy-images': Error: 原图下载超时，请重试。");
  } } });
  await page.copy(images(2));
  assert.equal(page.node("alert-toast").textContent, "图片未复制：原图下载超时，请重试。 可重试或下载原图。");
  assert.equal(page.state.busy, false);
  assert.equal(page.calls.permissionQueries, 0);
});

test("native failure stays retryable and never becomes a Chromium permission error", async () => {
  let removed = 0;
  let attempts = 0;
  const page = renderer({ desktop: {
    onClipboardProgress() { return () => { removed += 1; }; },
    async copyImages() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("第 2 张原图读取失败"), { name: "NotAllowedError" });
      return { ok: true, count: 2, kind: "files" };
    }
  } });
  await page.copy(images(2));
  assert.match(page.node("alert-toast").textContent, /第 2 张原图读取失败/);
  assert.doesNotMatch(page.node("alert-toast").textContent, /Chrome|浏览器|权限/);
  assert.equal(page.calls.permissionQueries, 0);
  assert.equal(page.calls.writes.length, 0);
  assert.equal(page.state.multipleClipboardItemsSupported, null);
  assert.equal(page.state.busy, false);
  assert.equal(page.node("clipboard-fallback").hidden, true);
  assert.equal(page.node("copy-selected-images-button").disabled, false);
  assert.equal(removed, 1);
  await page.copy(images(2));
  assert.equal(attempts, 2);
  assert.equal(removed, 2);
  assert.match(page.node("toast").textContent, /已复制 2/);
});

test("desktop does not report partial native results as success", async () => {
  const page = renderer({ desktop: { copyImages: async () => ({ ok: true, count: 1, kind: "files" }) } });
  await page.copy(images(2));
  assert.match(page.node("alert-toast").textContent, /未确认全部图片/);
  assert.equal(page.node("toast").textContent, "");
  assert.equal(page.state.busy, false);
});

test("desktop accepts 50 selected images and rejects 51 before calling the bridge", async () => {
  let count = 0;
  const page = renderer({ desktop: { async copyImages(payload) {
    count += 1;
    return { ok: true, count: payload.images.length, kind: "files" };
  } } });
  await page.copy(images(50));
  assert.equal(count, 1);
  assert.match(page.node("toast").textContent, /已复制 50/);
  await page.copy(images(51));
  assert.equal(count, 1);
  assert.match(page.node("alert-toast").textContent, /客户端一次最多复制 50/);
});

test("web keeps its 12-image and secure-context checks without the native bridge", async () => {
  const page = renderer();
  await page.copy(images(13));
  assert.equal(page.calls.writes.length, 0);
  assert.match(page.node("alert-toast").textContent, /浏览器内存.*12/);
  const insecure = renderer({ secure: false, desktop: {} });
  await insecure.copy(images(1));
  assert.equal(insecure.calls.writes.length, 0);
  assert.match(insecure.node("alert-toast").textContent, /HTTPS 或 localhost/);
});

test("web still converts selected images and writes browser ClipboardItems", async () => {
  const page = renderer();
  await page.copy(images(2));
  assert.equal(page.calls.writes.length, 1);
  assert.equal(page.calls.writes[0].length, 2);
  assert.equal(page.calls.conversions, 2);
  assert.equal(page.state.multipleClipboardItemsSupported, true);
  assert.match(page.node("toast").textContent, /浏览器已接收/);
});

test("web multiple-item rejection retains the browser fallback", async () => {
  const page = renderer({
    write: async () => { throw Object.assign(new Error("Write rejected"), { name: "NotAllowedError" }); }
  });
  await page.copy(images(2));
  assert.equal(page.calls.permissionQueries, 1);
  assert.equal(page.state.multipleClipboardItemsSupported, false);
  assert.equal(page.node("copy-selected-images-button").disabled, true);
  assert.equal(page.node("clipboard-fallback").hidden, false);
  assert.match(page.node("alert-toast").textContent, /Chrome \/ Chromium/);
});
