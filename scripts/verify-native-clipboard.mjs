// Run: node_modules/.bin/electron scripts/verify-native-clipboard.mjs
// Real OS clipboard, production preload, native writer and download service;
// all image responses use local fixtures. Existing clipboard is restored.
import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeImageClipboard } from '../desktop/image-clipboard.js';
import { writeImageFiles, writeSingleImage } from '../desktop/native-clipboard.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'xhs-native-clipboard-smoke-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.setPath('sessionData', path.join(temporary, 'session'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let win;
let backup;
let clipboardModified = false;
let restored = false;
let exitCode = 1;
let summary;
let stage = 'startup';

async function snapshotClipboard() {
  const saved = [];
  for (const item of await clipboard.read()) {
    const data = {};
    for (const type of item.types) {
      const value = await item.getType(type);
      // Materialize now: read-side ClipboardItems are lazy OS readers.
      data[type] = type === 'electron application/bookmark'
        ? { title: value.title, url: value.url }
        : new Blob([await value.arrayBuffer()], { type });
    }
    if (Object.keys(data).length) saved.push(new ClipboardItem(data));
  }
  return saved;
}

async function restoreClipboard() {
  if (!clipboardModified || !backup || restored) return;
  if (backup.length) await clipboard.write(backup);
  else clipboard.clear();
  restored = true;
}

async function readCopiedFiles() {
  for (const item of await clipboard.read()) {
    if (item.types.includes('text/uri-list')) {
      const value = await item.getType('text/uri-list');
      return (await value.text()).split(/\r?\n/).filter(Boolean).map(uri => fileURLToPath(uri));
    }
  }
  return [];
}

async function waitForPaste(previousCount) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript('window.pasteState');
    if (state.count > previousCount && !state.pending) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Native paste event did not complete in five seconds');
}

async function paste() {
  const previousCount = await win.webContents.executeJavaScript('window.pasteState.count');
  await win.webContents.executeJavaScript('document.querySelector("#target").focus()');
  win.webContents.paste();
  return waitForPaste(previousCount);
}

async function invokeCopy(input) {
  return win.webContents.executeJavaScript(`window.xhsDesktop.copyImages(${JSON.stringify(input)})`);
}

const deadline = setTimeout(async () => {
  console.error('NATIVE_CLIPBOARD_SMOKE_TIMEOUT', stage);
  try { await restoreClipboard(); } finally { win?.destroy(); app.exit(1); }
}, 45000);

async function main() {
  try {
    await app.whenReady();
    stage = 'backup';
    assert.ok(['darwin', 'win32'].includes(process.platform), 'Run on macOS or Windows');
    backup = await snapshotClipboard();
    stage = 'fixtures';

    const fixtures = Array.from({ length: 10 }, (_, index) => {
      const pixels = Buffer.alloc(24 * 24 * 4);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        pixels[offset] = 30 + index * 20;
        pixels[offset + 1] = 220 - index * 17;
        pixels[offset + 2] = 50 + index * 13;
        pixels[offset + 3] = 255;
      }
      const bytes = nativeImage.createFromBitmap(pixels, { width: 24, height: 24 }).toPNG();
      return { url: `https://sns-img-bd.xhscdn.com/clipboard-fixture-${index + 1}`, index: index + 1, bytes };
    });
    assert.equal(new Set(fixtures.map(item => digest(item.bytes))).size, 10);
    const jpeg = { url: 'https://sns-img-bd.xhscdn.com/clipboard-jpeg', index: 11,
      type: 'image/jpeg', bytes: nativeImage.createFromBuffer(fixtures[2].bytes).toJPEG(90) };
    const webp = { url: 'https://sns-img-bd.xhscdn.com/clipboard-webp', index: 12,
      type: 'image/webp', bytes: await fs.readFile(path.join(root, 'assets/downloads/desktop-scrapbook.webp')) };
    const oversized = { url: 'https://sns-img-bd.xhscdn.com/clipboard-oversized', index: 13,
      type: 'image/png', bytes: Buffer.from(fixtures[0].bytes) };
    // Deliberately inconsistent image: the header guard must preserve as a file
    // before any native bitmap allocation, without attempting to decode it.
    oversized.bytes.writeUInt32BE(100000, 16);
    oversized.bytes.writeUInt32BE(100000, 20);
    const allFixtures = [...fixtures, jpeg, webp, oversized];
    let fetchCount = 0;
    const fetchImpl = async url => {
      fetchCount++;
      const fixture = allFixtures.find(item => item.url === url);
      if (url.endsWith('/clipboard-failure')) return new Response('fixture unavailable', { status: 503 });
      assert.ok(fixture, 'No network access: only known fixture URLs are accepted');
      return new Response(fixture.bytes, {
        headers: { 'content-type': fixture.type || 'image/png', 'content-length': String(fixture.bytes.length) }
      });
    };
    let authorizationChecks = 0;
    const options = {
      directory: path.join(temporary, 'clipboard cache 中文'), fetchImpl,
      writeFiles: async files => { clipboardModified = true; return writeImageFiles(files); },
      writeImage: async file => { clipboardModified = true; return writeSingleImage(file); },
      authorize: async action => { assert.equal(action, 'single-download'); authorizationChecks++; },
      onProgress: progress => win.webContents.send('desktop:clipboard-progress', progress)
    };
    let service = new NativeImageClipboard(options);
    ipcMain.handle('desktop:copy-images', (event, input) => {
      assert.equal(event.sender, win.webContents);
      assert.equal(event.senderFrame, win.webContents.mainFrame);
      return service.copy(input);
    });
    const html = path.join(temporary, 'native-clipboard.html');
    await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
      <title>Native clipboard verification</title><style>
      body{font:16px system-ui;background:#faf8f1;color:#242436;padding:32px}
      h1{font-size:26px}textarea{width:92%;padding:16px}#images{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
      figure{margin:0;padding:12px;background:white;border:1px solid #ddd}img{width:64px;height:64px}figcaption{max-width:150px;font-size:11px;overflow-wrap:anywhere}
      </style><h1>系统剪贴板 · 10 张独立图片</h1><p id="result">准备原生复制与粘贴验证</p>
      <textarea id="target" placeholder="Native paste target"></textarea><div id="images"></div><script>
      window.pasteState={count:0,pending:false,files:[]};window.progress=[];
      window.xhsDesktop.onClipboardProgress(value=>window.progress.push(value));
      document.addEventListener('paste',async event=>{
        event.preventDefault();const count=window.pasteState.count+1;
        window.pasteState={count,pending:true,files:[]};
        try {
          const files=await Promise.all(Array.from(event.clipboardData.files,async file=>({
            name:file.name,type:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))
          })));
          window.pasteState={count,pending:false,files};
          document.querySelector('#result').textContent='已接收 '+files.length+' 张独立图片';
          document.querySelector('#images').replaceChildren(...files.map(file=>{
            const figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');
            image.src=URL.createObjectURL(new Blob([new Uint8Array(file.bytes)],{type:file.type}));
            caption.textContent=file.name;figure.append(image,caption);return figure;
          }));
        }catch(error){window.pasteState={count,pending:false,error:String(error),files:[]};}
      });</script></html>`);
    win = new BrowserWindow({ width: 1100, height: 700, show: true,
      webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true } });
    await win.loadFile(html);
    stage = 'multi-copy';
    win.focus();
    const bridge = await win.webContents.executeJavaScript('({copy:typeof xhsDesktop.copyImages, node:typeof require})');
    assert.deepEqual(bridge, { copy: 'function', node: 'undefined' });
    const selection = { title: '中文 标题 空格', images: fixtures.map(({ url, index }) => ({ url, index })) };
    assert.deepEqual(await invokeCopy(selection), { ok: true, count: 10, kind: 'files' });
    const files = await readCopiedFiles();
    stage = 'native-files';
    assert.equal(files.length, 10);
    for (let index = 0; index < files.length; index++) {
      assert.equal(path.basename(files[index]), `${String(index + 1).padStart(3, '0')}-中文 标题 空格.png`);
      assert.deepEqual(await fs.readFile(files[index]), fixtures[index].bytes);
    }
    let nativeItems;
    if (process.platform === 'darwin') {
      const script = `ObjC.import('AppKit');JSON.stringify(Array.from({length:$.NSPasteboard.generalPasteboard.pasteboardItems.count},(_,i)=>ObjC.unwrap($.NSPasteboard.generalPasteboard.pasteboardItems.objectAtIndex(i).stringForType('public.file-url'))));`;
      const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 });
      const nativeFiles = JSON.parse(stdout).map(uri => fileURLToPath(uri));
      assert.deepEqual(nativeFiles, files);
      nativeItems = nativeFiles.length;
    }
    const pasted = await paste();
    stage = 'multi-paste';
    assert.equal(pasted.error, undefined);
    assert.equal(pasted.files.length, 10);
    assert.deepEqual(pasted.files.map(file => file.name), files.map(file => path.basename(file)));
    assert.ok(pasted.files.every(file => file.type === 'image/png'));
    assert.deepEqual(pasted.files.map(file => digest(Buffer.from(file.bytes))), fixtures.map(file => digest(file.bytes)));
    const screenshot = path.join(temporary, 'native-clipboard-10-images.png');
    await fs.writeFile(screenshot, (await win.webContents.capturePage()).toPNG());

    // A fresh service must retain files currently referenced by the OS clipboard.
    service = new NativeImageClipboard(options);
    for (const filename of files) await fs.access(filename);
    assert.deepEqual(await readCopiedFiles(), files);
    const fetchBeforeInvalid = fetchCount;
    await assert.rejects(invokeCopy({ title: 'invalid', images: [{ url: 'file:///private/test.png', index: 1 }] }));
    assert.equal(fetchCount, fetchBeforeInvalid);
    assert.deepEqual(await readCopiedFiles(), files);
    await assert.rejects(invokeCopy({ title: 'failure', images: [selection.images[0],
      { url: 'https://sns-img-bd.xhscdn.com/clipboard-failure', index: 2 }] }));
    assert.deepEqual(await readCopiedFiles(), files);
    assert.equal((await fs.readdir(options.directory)).length, 1, 'Failed batch is removed');
    assert.equal((await paste()).files.length, 10, 'Original images still paste after failed copy');

    assert.deepEqual(await invokeCopy({ title: '单张 中文', images: [selection.images[3]] }),
      { ok: true, count: 1, kind: 'image' });
    const single = await paste();
    assert.equal(single.files.length, 1);
    assert.equal(single.files[0].type, 'image/png');
    assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(single.files[0].bytes)).toBitmap(),
      nativeImage.createFromBuffer(fixtures[3].bytes).toBitmap());

    stage = 'jpeg-single-copy';
    assert.deepEqual(await invokeCopy({ title: 'JPEG 中文标题@2x', images: [{ url: jpeg.url, index: jpeg.index }] }),
      { ok: true, count: 1, kind: 'image' });
    const pastedJpeg = await paste();
    assert.equal(pastedJpeg.files.length, 1);
    const pastedJpegImage = nativeImage.createFromBuffer(Buffer.from(pastedJpeg.files[0].bytes));
    assert.deepEqual(pastedJpegImage.getSize(), { width: 24, height: 24 }, '@2x titles must not change image dimensions');
    assert.deepEqual(pastedJpegImage.toBitmap(), nativeImage.createFromBuffer(jpeg.bytes).toBitmap());

    stage = 'webp-single-copy';
    assert.deepEqual(await invokeCopy({ title: 'WebP 中文 原图', images: [{ url: webp.url, index: webp.index }] }),
      { ok: true, count: 1, kind: 'files' });
    const pastedWebp = await paste();
    assert.equal(pastedWebp.files.length, 1);
    assert.equal(pastedWebp.files[0].type, 'image/webp');
    assert.equal(pastedWebp.files[0].name, '012-WebP 中文 原图.webp');
    assert.deepEqual(Buffer.from(pastedWebp.files[0].bytes), webp.bytes);

    stage = 'oversized-header';
    assert.deepEqual(await invokeCopy({ title: '大尺寸头部', images: [{ url: oversized.url, index: oversized.index }] }),
      { ok: true, count: 1, kind: 'files' });
    const oversizedFiles = await readCopiedFiles();
    assert.equal(oversizedFiles.length, 1);
    assert.deepEqual(await fs.readFile(oversizedFiles[0]), oversized.bytes);
    const progress = await win.webContents.executeJavaScript('window.progress');
    assert.ok(progress.some(item => item.total === 10 && item.completed === 10 && item.phase === 'writing'));
    assert.equal(authorizationChecks, 11);
    summary = { smoke: 'passed', platform: process.platform, electron: process.versions.electron,
      preload: true, nativeItems, pastedImages: 10, distinctImageBytes: true, orderedUnicodeNames: true,
      singleImagePaste: true, failedCopyPreserved: true, recreatedServicePreserved: true,
      jpegRetinaNamePreserved: true, webpOriginalPaste: true, oversizedHeaderFileFallback: true,
      networkRequests: 0, screenshot };
    exitCode = 0;
  } catch (error) {
    console.error('NATIVE_CLIPBOARD_SMOKE_FAILED', error.stack || String(error));
  } finally {
    clearTimeout(deadline);
    try { await restoreClipboard(); }
    catch (error) { exitCode = 1; console.error('NATIVE_CLIPBOARD_RESTORE_FAILED', error.message); }
    ipcMain.removeHandler('desktop:copy-images');
    win?.destroy();
    // Preserve the screenshot and disposable profile, but remove cached media after
    // restoring the previous clipboard so no clipboard references become stale.
    if (restored || !clipboardModified) {
      await fs.rm(path.join(temporary, 'clipboard cache 中文'), { recursive: true, force: true });
    }
    if (summary) console.log(JSON.stringify({ ...summary, clipboardRestored: restored }));
    app.exit(exitCode);
  }
}

// Do not top-level await app.whenReady(): Electron waits for its entry module
// evaluation to finish before emitting ready.
main().catch(error => {
  console.error('NATIVE_CLIPBOARD_SMOKE_CLEANUP_FAILED', error.message);
  app.exit(1);
});
