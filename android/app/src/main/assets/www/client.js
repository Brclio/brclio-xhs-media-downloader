import { safeFilename, normalizeNote, captionText, textEntry, imageEntry, videoEntry, selectedEntries } from './media.js';

const $ = id => document.getElementById(id);
const pending = new Map();
let sequence = 0;
let note = null;
let selected = new Set();
let busy = false;
let generation = 0;
let operation = 0;
let deferredShare = '';
const native = window.BrclioNative;
let updater = { status: 'idle', update: null, canInstallBuild: true };
let checkingUpdate = false;
let downloadingUpdate = false;
let installingUpdate = false;
let updateNotice = '';
let updateTone = '';

function message(text, tone = '') {
  $('status').hidden = !text;
  $('status').textContent = text;
  $('status').dataset.tone = tone;
}

function call(method, params = {}) {
  if (!native) return Promise.reject(new Error('请在 Brclio 安卓客户端中使用此功能。'));
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    // File picker and foreground transfers deliberately have no short UI timeout.
    const timer = ['save', 'copyImages', 'shareImages', 'downloadUpdate'].includes(method) ? null : setTimeout(() => {
      pending.delete(id);
      reject(new Error('请求超时，请检查网络后重试。'));
    }, 90_000);
    pending.set(id, { resolve, reject, timer });
    try { native.postMessage(JSON.stringify({ id, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

if (native) native.onmessage = event => {
  let response;
  try { response = JSON.parse(event.data); } catch { return; }
  const request = pending.get(String(response.id));
  if (!request) return;
  pending.delete(String(response.id));
  clearTimeout(request.timer);
  if (response.ok) request.resolve(response.result || {});
  else request.reject(new Error(response.error || '操作未完成，请重试。'));
};

function updateSelection() {
  $('selection-count').textContent = `已选 ${selected.size} / ${note?.images.length || 0} 张`;
  $('select-all').textContent = selected.size === note?.images.length ? '取消全选' : '全选';
  for (const id of ['save-zip', 'copy-images', 'share-images', 'copy-links']) $(id).disabled = busy || !selected.size;
}

function setBusy(value, transfer = false) {
  busy = value;
  document.querySelectorAll('main button, main select, main textarea, #images input').forEach(element => { element.disabled = value; });
  $('cancel').disabled = false;
  $('transfer').hidden = !transfer;
  $('parse').textContent = value && !transfer ? '正在解析…' : '开始解析 ↗';
  if (transfer) { $('progress').removeAttribute('value'); $('transfer-title').textContent = '正在准备文件'; $('transfer-detail').textContent = '请选择保存位置；处理期间请保持应用打开。'; }
  updateSelection();
  renderUpdater();
}

function resetResult() {
  note = null;
  selected.clear();
  $('results').hidden = true;
  $('images').replaceChildren();
  $('video-player').pause();
  $('video-player').removeAttribute('src');
  $('video-player').load();
  $('quality').replaceChildren();
  updateSelection();
}

function receiveShare(text) {
  if (!text) return;
  generation++;
  if (busy) { deferredShare = text; message('已收到新分享，当前操作结束后会填入。'); return; }
  resetResult();
  $('share-text').value = String(text).slice(0, 3000);
  message('已填入分享内容，点击「开始解析」继续。');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function finishOperation() {
  setBusy(false);
  if (deferredShare) { const text = deferredShare; deferredShare = ''; receiveShare(text); }
}

window.brclioEvent = event => {
  if (event.type === 'share') receiveShare(event.text);
  if (event.type === 'update') applyUpdateState(event);
  if (event.type === 'progress' && busy) {
    $('transfer').hidden = false;
    $('transfer-title').textContent = event.stage === 'write' ? '正在保存文件' : '正在读取原始素材';
    const count = Number(event.file || 0);
    const total = Number(event.total || 0);
    $('progress').max = total || 1;
    if (total) $('progress').value = Math.max(0, count - 1); else $('progress').removeAttribute('value');
    $('transfer-detail').textContent = `${total ? `文件 ${count} / ${total} · ` : ''}${event.filename || ''} · ${((event.bytes || 0) / 1048576).toFixed(1)} MB。请保持应用打开。`;
  }
};

function renderUpdater() {
  const update = updater.update;
  const verifying = updater.status === 'verifying';
  const downloading = downloadingUpdate || updater.status === 'downloading' || verifying;
  const downloaded = ['downloaded', 'permission_required', 'installer_opened'].includes(updater.status);
  const mayInstall = updater.canInstallBuild !== false;
  $('update-current').textContent = updater.currentVersion || $('version').textContent;
  $('update-banner').hidden = !update;
  $('show-update').textContent = update ? `发现新版本 ${update.versionName}，查看更新 ↓` : '查看软件更新 ↓';
  $('check-update').disabled = !native || checkingUpdate || downloading;
  $('check-update').textContent = checkingUpdate ? '正在检查…' : '检查更新';
  $('update-details').hidden = !update;
  $('update-version').textContent = update ? `Android ${update.versionName}${update.size ? ` · ${(update.size / 1048576).toFixed(1)} MB` : ''}` : '';
  $('update-notes').textContent = update?.notes || '';
  $('download-update').hidden = !update || downloaded || downloading;
  $('download-update').disabled = !mayInstall || checkingUpdate;
  $('install-update').hidden = !downloaded;
  $('install-update').disabled = busy || installingUpdate || !mayInstall;
  $('cancel-update').hidden = !downloading;
  $('cancel-update').disabled = false;
  $('update-progress').hidden = !downloading;
  const total = Number(updater.total || update?.size || 0);
  if (total > 0) { $('update-progress').max = total; $('update-progress').value = Math.min(total, Number(updater.bytes || 0)); }
  else $('update-progress').removeAttribute('value');
  const messages = {
    idle: '启动时自动检查新版本。', checking: '正在检查安卓正式版本…',
    latest: '当前已是最新正式版。', unpublished: '暂未找到可用的安卓正式版，请稍后再检查。',
    available: '发现新版本，可查看说明后下载。',
    downloaded: busy ? '安装包已校验。请先完成当前笔记操作，再安装更新。' : '安装包已校验，可以安装更新。',
    permission_required: '请在系统设置中允许 Brclio 安装应用，返回后再次点击「安装更新」。',
    installer_opened: '已打开系统安装界面，请按系统提示确认。',
    cancelled: '更新下载已取消，可重新下载。',
  };
  let text = updateNotice || messages[updater.status] || '可重新检查版本或重试下载。';
  if (downloading) text = `正在下载更新：${((updater.bytes || 0) / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB。`;
  if (verifying) text = '正在校验安装包的完整性、版本和签名…';
  if (!mayInstall && update) text = '当前是调试包，请先从官网下载并安装正式版；正式版支持后续在线更新。';
  $('update-status').textContent = text;
  $('update-status').dataset.tone = updateTone;
}

function applyUpdateState(next) {
  updater = { ...updater, ...next };
  updateNotice = next.error || '';
  updateTone = next.error ? 'error' : '';
  renderUpdater();
}

async function checkForUpdate() {
  if (!native || checkingUpdate || downloadingUpdate) return;
  checkingUpdate = true;
  updateNotice = '正在检查安卓正式版本…'; updateTone = '';
  renderUpdater();
  try { applyUpdateState(await call('checkUpdate')); }
  catch (error) { updateNotice = `检查失败：${error.message}`; updateTone = 'error'; }
  finally { checkingUpdate = false; renderUpdater(); }
}

$('check-update').addEventListener('click', checkForUpdate);
$('show-update').addEventListener('click', () => $('updates').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('download-update').addEventListener('click', async () => {
  if (!updater.update || downloadingUpdate) return;
  downloadingUpdate = true; updateNotice = ''; updateTone = ''; renderUpdater();
  try { applyUpdateState(await call('downloadUpdate')); }
  catch (error) { updater.status = 'available'; updateNotice = `下载失败：${error.message}`; updateTone = 'error'; }
  finally { downloadingUpdate = false; renderUpdater(); }
});
$('cancel-update').addEventListener('click', async () => {
  $('cancel-update').disabled = true;
  try { await call('cancelUpdate'); }
  catch (error) { updateNotice = error.message; updateTone = 'error'; }
  finally { renderUpdater(); }
});
$('install-update').addEventListener('click', async () => {
  if (busy || installingUpdate) return;
  installingUpdate = true; renderUpdater();
  try { applyUpdateState(await call('installUpdate')); }
  catch (error) { updateNotice = error.message; updateTone = 'error'; }
  finally { installingUpdate = false; renderUpdater(); }
});

async function action(work, transfer = false) {
  if (busy) return;
  operation++;
  setBusy(true, transfer);
  message('');
  try { await work(); }
  catch (error) { message(error.message || '操作失败，请重试。', 'error'); }
  finally { finishOperation(); }
}

function save(filename, mime, entries) {
  return action(async () => {
    const result = await call('save', { filename, mime, entries });
    message(result.cancelled ? '已取消保存。' : `已保存「${filename}」。可在系统文件应用中查看。`, result.cancelled ? '' : 'success');
  }, true);
}

function copy(text, success = '已复制。') {
  return action(async () => { await call('copy', { text }); message(success, 'success'); });
}

function processImages(images, method) {
  return action(async () => {
    const result = await call(method, { images: images.map(imageEntry) });
    if (result.cancelled) { message(method === 'shareImages' ? '已取消图片分享。' : '已取消图片复制。'); return; }
    message(method === 'shareImages' ? `已打开 ${result.count} 张原图的系统分享面板。` : `已复制 ${result.count} 张原图。接收应用可能只支持粘贴一张，可改用分享。`, 'success');
  }, true);
}

function button(text, handler, className = '') {
  const element = document.createElement('button');
  element.type = 'button'; element.textContent = text; element.className = className;
  element.addEventListener('click', handler);
  return element;
}

function renderImages() {
  $('image-section').hidden = !note.images.length;
  for (const image of note.images) {
    const card = document.createElement('article'); card.className = 'image-card';
    const preview = document.createElement('div'); preview.className = 'image-preview';
    const img = document.createElement('img'); img.src = image.url; img.alt = `第 ${image.index} 张原图`; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    const label = document.createElement('label');
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.setAttribute('aria-label', `选择第 ${image.index} 张图片`);
    check.addEventListener('change', () => { if (check.checked) selected.add(image.index); else selected.delete(image.index); updateSelection(); });
    const number = document.createElement('span'); number.className = 'media-number'; number.textContent = `${String(image.index).padStart(2, '0')}${image.livePhoto ? ' · 实况' : ''}`;
    label.append(check, number); preview.append(img, label);
    const hint = document.createElement('p'); hint.textContent = image.livePhoto && !image.liveVideo ? '实况片段缺失，请重新解析' : image.liveVideo ? '原图 + 动态 MP4' : '无水印原图';
    const buttons = document.createElement('div'); buttons.className = 'image-buttons';
    buttons.append(button('保存原图', () => save(`${safeFilename(note.title)}-${imageEntry(image).name}`, 'image/jpeg', [imageEntry(image)])), button('复制图片', () => processImages([image], 'copyImages')));
    if (image.liveVideo) {
      const live = videoEntry(image.liveVideo, `${String(image.index).padStart(2, '0')}-live.mp4`, false);
      buttons.append(button('实况 ZIP', () => save(`${safeFilename(note.title)}-${image.index}-live.zip`, 'application/zip', [imageEntry(image), live])), button('实况 MP4', () => save(`${safeFilename(note.title)}-${live.name}`, 'video/mp4', [live])));
    }
    card.append(preview, hint, buttons); $('images').append(card);
  }
  updateSelection();
}

function currentVideo() { return note?.videos[Number($('quality').value) || 0]; }
function updateVideo() {
  const video = currentVideo();
  if (!video) return;
  $('video-player').src = video.url;
  $('open-video').href = video.url;
  $('video-info').textContent = [video.width && video.height ? `${video.width} × ${video.height}` : '', video.codec || '', video.size > 0 ? `${(video.size / 1048576).toFixed(1)} MB` : '', video.hasAudio === false ? '此线路可能没有音轨，建议选择其他线路' : '保存时检查音轨完整性'].filter(Boolean).join(' · ');
}

$('parse-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  const text = $('share-text').value.trim();
  if (!text) { message('请粘贴分享链接或文案。', 'error'); return; }
  const requestGeneration = ++generation;
  resetResult();
  action(async () => {
    const result = await call('parse', { text, engine: $('engine').value });
    if (requestGeneration !== generation) return;
    note = normalizeNote(result, text);
    selected = new Set(note.images.map(image => image.index));
    $('note-title').textContent = note.title;
    $('caption').textContent = note.content || '这篇笔记没有正文，复制时将包含标题。';
    $('result-meta').textContent = `${note.images.length} 张图片 · ${note.videos.length} 条视频线路`;
    $('video-section').hidden = !note.videos.length;
    note.videos.forEach((video, index) => {
      const option = document.createElement('option'); option.value = String(index); option.textContent = video.label || `${video.width || '?'}×${video.height || '?'} · ${video.codec || '视频'} · 线路 ${index + 1}`; $('quality').append(option);
    });
    const preferred = note.videos.findIndex(video => video.isDefault && video.hasAudio !== false);
    $('quality').value = String(preferred >= 0 ? preferred : Math.max(0, note.videos.findIndex(video => video.hasAudio !== false)));
    updateVideo(); renderImages(); $('results').hidden = false;
    message(`已解析，可选择要保存的素材。`, 'success');
  });
});

$('paste').addEventListener('click', () => action(async () => {
  const result = await call('paste');
  if (!result.text) throw new Error('剪贴板中没有文字，请先复制分享链接。');
  resetResult(); $('share-text').value = String(result.text).slice(0, 3000); message('链接已填入，点击「开始解析」继续。');
}));
$('clear').addEventListener('click', () => { generation++; resetResult(); $('share-text').value = ''; message(''); $('share-text').focus(); });
$('quality').addEventListener('change', updateVideo);
$('copy-caption').addEventListener('click', () => copy(captionText(note), '完整文案已复制。'));
$('save-caption').addEventListener('click', () => save(`${safeFilename(note.title)}-文案.txt`, 'text/plain', [textEntry(note)]));
$('save-video').addEventListener('click', () => save(`${safeFilename(note.title)}.mp4`, 'video/mp4', [videoEntry(currentVideo(), 'video.mp4')]));
$('select-all').addEventListener('click', () => { selected = selected.size === note.images.length ? new Set() : new Set(note.images.map(image => image.index)); document.querySelectorAll('#images input').forEach((input, index) => { input.checked = selected.has(note.images[index].index); }); updateSelection(); });
$('copy-links').addEventListener('click', () => copy(note.images.filter(image => selected.has(image.index)).map(image => image.url).join('\n'), '所选原图链接已复制。'));
$('copy-images').addEventListener('click', () => processImages(note.images.filter(image => selected.has(image.index)), 'copyImages'));
$('share-images').addEventListener('click', () => processImages(note.images.filter(image => selected.has(image.index)), 'shareImages'));
$('save-zip').addEventListener('click', () => { try { save(`${safeFilename(note.title)}.zip`, 'application/zip', selectedEntries(note, selected)); } catch (error) { message(error.message, 'error'); } });
$('cancel').addEventListener('click', async () => {
  const cancellingOperation = operation;
  $('cancel').disabled = true;
  try {
    await call('cancel');
    if (busy && operation === cancellingOperation) message('正在取消，请稍候…');
  } catch (error) {
    if (busy && operation === cancellingOperation) message(error.message, 'error');
  } finally {
    if (operation === cancellingOperation) $('cancel').disabled = false;
  }
});

renderUpdater();
if (!native) message('当前为界面预览。解析、复制与保存请在安卓客户端中使用。');
else call('ready').then(result => {
  if (result.version) { $('version').textContent = result.version; updater.currentVersion = result.version; }
  if (result.sharedText) receiveShare(result.sharedText);
  void checkForUpdate();
}).catch(error => message(error.message, 'error'));
