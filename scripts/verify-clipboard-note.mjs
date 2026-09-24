// Opt-in live acceptance: XHS_CLIPBOARD_TEST_NOTE='<share URL>' electron scripts/verify-clipboard-note.mjs
// Opens the real application with a disposable profile, clicks the real parse /
// copy controls, and pastes into a separate window without a preload or bridge.
// Never stores the supplied signed URL in the report; restores the clipboard.
import { app, BrowserWindow, clipboard, ClipboardItem } from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInputUrl, extractNoteId } from '../lib/xhs.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const note = process.env.XHS_CLIPBOARD_TEST_NOTE;
if (!note) throw new Error('Set XHS_CLIPBOARD_TEST_NOTE to the share URL to test.');
const noteId = extractNoteId(extractInputUrl(note));
if (!noteId) throw new Error('The live acceptance input must identify a note.');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const temporary = mkdtempSync(path.join(tmpdir(), 'brclio-live-clipboard-'));
const output = path.join(root, 'dist-desktop/native-clipboard-preview/acceptance');
app.setName(pkg.productName);
app.setPath('userData', temporary);
app.setPath('sessionData', temporary);
app.getAppPath = () => root;
app.getVersion = () => pkg.version;
let started = false;
let backup;
let modified = false;
let receiver;
let done = false;
let source;
let stage = 'startup';
let copyClicks = 0;

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
async function saveClipboard() {
  const result = [];
  for (const item of await clipboard.read()) {
    const data = {};
    for (const type of item.types) {
      const value = await item.getType(type);
      data[type] = type === 'electron application/bookmark'
        ? value : new Blob([await value.arrayBuffer()], { type });
    }
    if (Object.keys(data).length) result.push(new ClipboardItem(data));
  }
  return result;
}
async function copiedFiles() {
  for (const item of await clipboard.read()) {
    if (item.types.includes('text/uri-list')) {
      return (await (await item.getType('text/uri-list')).text()).split(/\r?\n/).filter(Boolean).map(fileURLToPath);
    }
  }
  return [];
}
async function until(read, ready, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (ready(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Live clipboard check timed out at ${stage}`);
}
async function finish(code, report, error) {
  if (done) return;
  done = true;
  clearTimeout(deadline);
  if (error) console.error('LIVE_CLIPBOARD_FAILED', stage, error.message);
  try {
    if (modified && backup) {
      if (backup.length) await clipboard.write(backup); else clipboard.clear();
    }
    if (report) {
      report.clipboardRestored = true;
      await fs.writeFile(path.join(output, 'live-note-report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
    }
  } catch (restoreError) { code = 1; console.error('LIVE_CLIPBOARD_RESTORE_FAILED', restoreError.message); }
  receiver?.destroy();
  if (code) app.exit(code); else app.quit();
}
const deadline = setTimeout(() => void finish(1, null, new Error('Live acceptance exceeded 150 seconds.')), 150000);

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    if (started || !win.webContents.getURL().startsWith('xhs-app://local/')) return;
    started = true;
    source = win;
    try {
      await fs.mkdir(output, { recursive: true });
      backup = await saveClipboard();
      stage = 'parse';
      await until(() => source.webContents.executeJavaScript(`({ready:typeof window.xhsDesktop?.copyImages==='function'&&!document.querySelector('#desktop-navigation').hidden})`), result => result.ready);
      await source.webContents.executeJavaScript(`(() => {
        document.querySelector('#share-text').value = ${JSON.stringify(note)};
        document.querySelector('#parse-form').requestSubmit();
      })()`);
      const parsed = await until(() => source.webContents.executeJavaScript(`({
        busy:document.querySelector('#parse-button').disabled,
        visible:!document.querySelector('#result-section').hidden,
        count:document.querySelectorAll('#image-grid .image-card').length,
        title:document.querySelector('#note-title').textContent,
        meta:document.querySelector('#result-meta').textContent,
        toast:document.querySelector('#toast').textContent
      })`), result => !result.busy);
      assert.ok(parsed.visible && parsed.count > 1, `Expected a multi-image note: ${parsed.toast}`);
      console.log(JSON.stringify({ stage: 'parsed', title: parsed.title, count: parsed.count }));
      stage = 'copy';
      modified = true;
      copyClicks++;
      await source.webContents.executeJavaScript(`(() => {
        if (document.querySelector('#copy-selected-images-button').disabled) throw new Error('Copy button is disabled');
        document.querySelector('#copy-selected-images-button').click();
      })()`);
      const copied = await until(() => source.webContents.executeJavaScript(`({
        busy:document.querySelector('#copy-selected-images-button').getAttribute('aria-busy')==='true',
        text:document.querySelector('#toast').textContent,
        browserFallback:!document.querySelector('#clipboard-fallback').hidden
      })`), result => !result.busy, 90000);
      assert.match(copied.text, new RegExp('已复制 '+parsed.count+' 个独立图片文件'));
      assert.equal(copied.browserFallback, false);
      const files = await copiedFiles();
      assert.equal(files.length, parsed.count);
      const originals = await Promise.all(files.map(async filename => {
        const bytes = await fs.readFile(filename);
        return { name: path.basename(filename), size: bytes.length, sha256: hash(bytes) };
      }));
      console.log(JSON.stringify({ stage: 'copied', count: files.length, copyClicks }));
      await source.webContents.executeJavaScript(`(() => {
        document.querySelector('#share-text').value = ${JSON.stringify(`https://www.xiaohongshu.com/discovery/item/${noteId}`)};
        document.querySelector('#result-section').scrollIntoView({block:'start'});
      })()`);
      await fs.writeFile(path.join(output, 'live-note-copied.png'), (await source.webContents.capturePage()).toPNG());

      stage = 'paste';
      const target = path.join(temporary, 'paste-target.html');
      await fs.writeFile(target, `<!doctype html><meta charset="utf-8"><title>独立粘贴验收</title>
        <style>body{font:16px system-ui;background:#faf8f1;color:#202032;margin:30px}h1{font-size:25px;margin-bottom:8px}textarea{width:98%;height:40px}#images{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-top:20px}figure{margin:0;padding:8px;background:white;border:1px solid #ddd}img{width:100%;height:245px;object-fit:contain}figcaption{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#status{font-weight:600}</style>
        <h1>${escapeHtml(parsed.title)} · 多图粘贴验收</h1><p id="status">等待系统粘贴</p><textarea id="target" placeholder="此窗口通过系统粘贴接收图片，没有下载器接口"></textarea><div id="images"></div>
        <script>window.pasted=null;document.addEventListener('paste',async event=>{
          event.preventDefault();const list=Array.from(event.clipboardData.files);
          try {
            const files=await Promise.all(list.map(async file=>({name:file.name,size:file.size,type:file.type,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('')})));
            document.querySelector('#status').textContent='一次粘贴收到 '+files.length+' 张独立原图';
            document.querySelector('#images').replaceChildren(...list.map((file,index)=>{const figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');img.src=URL.createObjectURL(file);caption.textContent=(index+1)+'. '+file.name;figure.append(img,caption);return figure}));
            await Promise.all(Array.from(document.images,image=>image.decode()));
            window.pasted={files,decoded:document.images.length};
          }catch(error){window.pasted={error:error.message};}
        });</script>`);
      receiver = new BrowserWindow({ width: 1400, height: 900, show: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await receiver.loadFile(target);
      assert.notEqual(receiver.webContents.id, source.webContents.id);
      assert.equal(await receiver.webContents.executeJavaScript('typeof window.xhsDesktop'), 'undefined');
      receiver.focus();
      await receiver.webContents.executeJavaScript('document.querySelector("#target").focus()');
      receiver.webContents.paste();
      const pasted = await until(() => receiver.webContents.executeJavaScript('window.pasted'), value => Boolean(value), 10000);
      assert.equal(pasted.error, undefined);
      assert.equal(pasted.decoded, parsed.count);
      assert.deepEqual(pasted.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })), originals);
      await fs.writeFile(path.join(output, 'live-note-pasted.png'), (await receiver.webContents.capturePage()).toPNG());
      await finish(0, { passed: true, noteId, title: parsed.title,
        platform: process.platform, electron: process.versions.electron, engine: parsed.meta,
        parsedImages: parsed.count, copyClicks, nativeFiles: files.length, pasteActions: 1,
        pastedImages: pasted.files.length, decodedImages: pasted.decoded, exactBytesAndOrder: true,
        independentReceiver: true, files: pasted.files,
        sourceScreenshot: path.join(output, 'live-note-copied.png'),
        pasteScreenshot: path.join(output, 'live-note-pasted.png') });
    } catch (error) { await finish(1, null, error); }
  });
});
await import('../desktop/main.js');
