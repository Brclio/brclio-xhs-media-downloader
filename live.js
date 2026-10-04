import { inspectLivePhotoFiles, checkLivePhotoSupport, createLivePhoto, LIVE_PHOTO_LIMITS } from './lib/live-photo-maker.js';
import { makeZipBlob } from './lib/archive.js';

const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  'support-note', 'file-input', 'choose-files', 'drop-zone', 'source-count', 'source-details',
  'source-meta', 'source-list', 'clear-files', 'settings-fields', 'duration', 'duration-number',
  'video-settings', 'start', 'start-number', 'clip-range', 'key-photo', 'key-photo-label',
  'motion-settings', 'motion', 'audio-settings', 'include-audio', 'audio-hint', 'preview-button',
  'preview-empty', 'source-video', 'source-canvas', 'result-video', 'live-pill', 'preview-caption',
  'create-live', 'cancel-live', 'progress-panel', 'progress-label', 'progress-percent',
  'live-progress', 'live-status', 'live-error', 'result-panel', 'result-summary', 'download-live'
].map(id => [id, byId(id)]));

const state = {
  files: [], metadata: null, support: null, busy: null, controller: null, revision: 0,
  urls: new Map(), images: new Map(), resultUrls: [], playing: false, animation: 0, previewRevision: 0,
  duration: 3, start: 0, keyPhotoTime: 1.5
};

if (new URLSearchParams(location.search).get('source') === 'desktop') {
  document.body.classList.add('live-embedded');
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function hundredths(value) { return Math.floor((value + Number.EPSILON) * 100) / 100; }
function seconds(value) { return Number(value).toFixed(2); }
function bytesLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
function setStatus(message = '') { ui['live-status'].textContent = message; }
function clearError() { ui['live-error'].hidden = true; ui['live-error'].textContent = ''; }
function showError(error) {
  ui['live-error'].textContent = error?.message || String(error || '制作失败，请重试。');
  ui['live-error'].hidden = false;
}
function fileUrl(file) {
  if (!state.urls.has(file)) state.urls.set(file, URL.createObjectURL(file));
  return state.urls.get(file);
}
function releaseSources() {
  stopPreview();
  ui['source-video'].removeAttribute('src');
  ui['source-video'].load();
  for (const url of state.urls.values()) URL.revokeObjectURL(url);
  state.urls.clear();
  state.images.clear();
}
function resetResult() {
  ui['result-video'].pause();
  ui['result-video'].removeAttribute('src');
  ui['result-video'].load();
  for (const url of state.resultUrls) URL.revokeObjectURL(url);
  state.resultUrls = [];
  ui['result-panel'].hidden = true;
  ui['result-video'].hidden = true;
  ui['download-live'].removeAttribute('href');
  document.documentElement.dataset.liveResult = 'none';
}
function audioRequired() {
  return state.metadata?.kind === 'video' && state.metadata.hasAudio !== false && ui['include-audio'].checked;
}
function updateControls() {
  const busy = Boolean(state.busy);
  const loaded = Boolean(state.metadata);
  ui['settings-fields'].disabled = busy || !loaded;
  ui['choose-files'].disabled = busy;
  ui['file-input'].disabled = busy;
  ui['clear-files'].disabled = busy;
  ui['drop-zone'].classList.toggle('is-busy', busy);
  ui['preview-button'].disabled = busy || !loaded
    || (state.metadata?.kind === 'video' && ui['source-video'].readyState < 1);
  ui['create-live'].disabled = busy || !loaded || !state.support?.supported
    || (audioRequired() && !state.support.audioSupported);
  ui['create-live'].textContent = state.busy === 'generating' ? '正在制作…' : '制作实况照片 ↗';
  ui['cancel-live'].hidden = !busy;
  ui['progress-panel'].hidden = !busy;
  ui['source-list'].querySelectorAll('button').forEach(button => {
    button.disabled = busy || (button.dataset.action === 'up' && Number(button.dataset.index) === 0)
      || (button.dataset.action === 'down' && Number(button.dataset.index) === state.files.length - 1);
  });
  document.documentElement.dataset.liveState = state.busy || (loaded ? 'ready' : 'empty');
}
function setProgress({ progress = 0, message = '正在制作…' } = {}) {
  const value = clamp(Number(progress) || 0, 0, 1);
  ui['live-progress'].value = value;
  ui['progress-percent'].textContent = `${Math.round(value * 100)}%`;
  ui['progress-label'].textContent = message;
}
function resetSelection() {
  resetResult();
  releaseSources();
  state.files = [];
  state.metadata = null;
  ui['file-input'].value = '';
  ui['source-count'].textContent = '尚未选择';
  ui['source-details'].hidden = true;
  ui['source-list'].replaceChildren();
  ui['video-settings'].hidden = true;
  ui['motion-settings'].hidden = true;
  ui['audio-settings'].hidden = true;
  ui['source-video'].hidden = true;
  ui['source-canvas'].hidden = true;
  ui['preview-empty'].hidden = false;
  ui['live-pill'].hidden = true;
  ui['preview-caption'].textContent = '预览会展示你选中的内容。';
  updateControls();
}

function renderFileList() {
  const fragment = document.createDocumentFragment();
  state.files.forEach((file, index) => {
    const row = document.createElement('li');
    const thumb = document.createElement(state.metadata.kind === 'images' ? 'img' : 'span');
    thumb.className = 'file-thumbnail';
    if (state.metadata.kind === 'images') {
      thumb.src = fileUrl(file);
      thumb.alt = '';
    } else {
      thumb.classList.add('video-thumbnail');
      thumb.textContent = '▷';
      thumb.setAttribute('aria-hidden', 'true');
    }
    const copy = document.createElement('div');
    copy.className = 'file-copy';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = `${state.metadata.kind === 'images' ? `${index + 1}. ` : ''}${file.name}`;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = bytesLabel(file.size);
    copy.append(name, size);
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const options = state.metadata.kind === 'images'
      ? [['up', '↑', '前移'], ['down', '↓', '后移'], ['remove', '×', '移除']]
      : [['remove', '×', '移除']];
    for (const [action, text, label] of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-action';
      button.dataset.action = action;
      button.dataset.index = index;
      button.textContent = text;
      button.setAttribute('aria-label', `${label}素材 ${index + 1}：${file.name}`);
      actions.append(button);
    }
    row.append(thumb, copy, actions);
    fragment.append(row);
  });
  ui['source-list'].replaceChildren(fragment);
  ui['source-count'].textContent = state.metadata.kind === 'images' ? `${state.files.length} 张图片` : '1 段视频';
  ui['source-meta'].textContent = `${state.metadata.width} × ${state.metadata.height}`
    + (state.metadata.kind === 'video' ? ` · 原视频 ${seconds(state.metadata.duration)} 秒` : ' · 按当前顺序制作')
    + ` · 合计 ${bytesLabel(state.files.reduce((sum, file) => sum + file.size, 0))}`;
  ui['source-details'].hidden = false;
}

function syncSettings() {
  const maximum = state.metadata?.kind === 'video'
    ? Math.min(3, hundredths(state.metadata.duration)) : 3;
  state.duration = clamp(state.duration, 0.5, maximum);
  const maxStart = state.metadata?.kind === 'video'
    ? Math.max(0, hundredths(state.metadata.duration - state.duration)) : 0;
  state.start = clamp(state.start, 0, maxStart);
  // The cover must fall before the final frame, inside the selected interval.
  const maxCover = Math.max(0, hundredths(state.duration - 1 / 30));
  state.keyPhotoTime = clamp(state.keyPhotoTime, 0, maxCover);
  for (const id of ['duration', 'duration-number']) {
    ui[id].max = maximum;
    ui[id].value = state.duration;
  }
  for (const id of ['start', 'start-number']) {
    ui[id].max = maxStart;
    ui[id].value = state.start;
  }
  ui['key-photo'].max = maxCover;
  ui['key-photo'].value = state.keyPhotoTime;
  ui['key-photo-label'].textContent = `片段内 ${seconds(state.keyPhotoTime)} 秒`;
  ui['clip-range'].textContent = `选中的片段：${seconds(state.start)}–${seconds(state.start + state.duration)} 秒`;
  ui['video-settings'].hidden = state.metadata?.kind !== 'video';
  ui['motion-settings'].hidden = state.metadata?.kind !== 'images';
  ui['motion'].disabled = state.metadata?.kind === 'images' && state.files.length > 1;
  ui['audio-settings'].hidden = state.metadata?.kind !== 'video';
  ui['include-audio'].disabled = state.metadata?.hasAudio === false;
  ui['audio-hint'].textContent = state.metadata?.hasAudio === false ? '此视频未检测到音轨，将制作静音实况。'
    : !state.support?.audioSupported ? '当前浏览器只能制作静音实况，请关闭此选项；需要声音可使用桌面客户端。'
      : state.metadata?.hasAudio === null ? '关闭后制作静音实况；若原视频无声音，输出也会保持静音。'
        : '关闭后制作静音实况。';
  updateControls();
}

function loadImage(file, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    function clean() { image.onload = null; image.onerror = null; signal.removeEventListener('abort', aborted); }
    function aborted() { clean(); image.src = ''; reject(new DOMException('已取消', 'AbortError')); }
    image.onload = () => { clean(); resolve(image); };
    image.onerror = () => { clean(); reject(new Error(`无法预览图片：${file.name}`)); };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    image.src = fileUrl(file);
  });
}

async function selectFiles(files) {
  if (state.busy) return;
  clearError();
  setStatus();
  resetSelection();
  if (!files.length) return;
  const revision = ++state.revision;
  const controller = new AbortController();
  state.controller = controller;
  state.busy = 'loading';
  setProgress({ message: '正在读取本地素材…' });
  updateControls();
  try {
    const metadata = await inspectLivePhotoFiles(files, { signal: controller.signal });
    if (controller.signal.aborted || revision !== state.revision) return;
    if (metadata.kind === 'video' && (!Number.isFinite(metadata.duration) || metadata.duration < 0.5)) {
      throw new Error('视频至少需要 0.5 秒，请选择更长的片段。');
    }
    if (metadata.kind === 'images') {
      let pixels = 0;
      for (const file of files) {
        const image = await loadImage(file, controller.signal);
        if (controller.signal.aborted || revision !== state.revision) return;
        pixels += image.naturalWidth * image.naturalHeight;
        if (pixels > LIVE_PHOTO_LIMITS.maxDecodedPixels) {
          image.src = '';
          throw new Error('图片总像素不能超过 6400 万，请减少图片或先缩小尺寸。');
        }
        state.images.set(file, image);
      }
    }
    state.files = files;
    state.metadata = metadata;
    state.duration = metadata.kind === 'video' ? Math.min(3, hundredths(metadata.duration)) : 3;
    state.start = 0;
    state.keyPhotoTime = state.duration / 2;
    ui['motion'].value = 'zoom';
    ui['include-audio'].checked = metadata.hasAudio !== false;
    renderFileList();
    if (metadata.kind === 'video') {
      ui['source-video'].src = fileUrl(files[0]);
      ui['source-video'].load();
    }
    state.busy = null;
    state.controller = null;
    syncSettings();
    showCover();
    setStatus('素材已准备好。调整后点击「制作实况照片」。');
  } catch (error) {
    if (revision !== state.revision) return;
    controller.abort();
    state.busy = null;
    state.controller = null;
    resetSelection();
    if (error?.name !== 'AbortError') showError(error);
  } finally {
    if (revision === state.revision) updateControls();
  }
}

function stopPreview() {
  ++state.previewRevision;
  state.playing = false;
  cancelAnimationFrame(state.animation);
  state.animation = 0;
  ui['source-video'].pause();
  ui['preview-button'].textContent = '播放片段 ▷';
}

function drawImages(time) {
  const interval = state.duration / state.files.length;
  const index = Math.min(state.files.length - 1, Math.floor(time / interval));
  const image = state.images.get(state.files[index]);
  if (!image) return;
  const canvas = ui['source-canvas'];
  const scale = Math.min(1, 1440 / Math.max(state.metadata.width, state.metadata.height));
  const width = Math.max(2, Math.floor(state.metadata.width * scale / 2) * 2);
  const height = Math.max(2, Math.floor(state.metadata.height * scale / 2) * 2);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d');
  context.fillStyle = '#fefcf6';
  context.fillRect(0, 0, width, height);
  const motion = ui['motion'].value === 'zoom' ? 1 + 0.055 * (time % interval) / interval : 1;
  const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight) * motion;
  const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

function showCover() {
  if (!state.metadata || state.playing) return;
  ui['preview-empty'].hidden = true;
  ui['source-video'].hidden = state.metadata.kind !== 'video';
  ui['source-canvas'].hidden = state.metadata.kind !== 'images';
  ui['result-video'].hidden = true;
  ui['live-pill'].hidden = false;
  ui['preview-caption'].textContent = `封面预览 · 片段内 ${seconds(state.keyPhotoTime)} 秒`;
  if (state.metadata.kind === 'images') drawImages(state.keyPhotoTime);
  else {
    ui['source-video'].muted = !ui['include-audio'].checked;
    if (ui['source-video'].readyState >= 1) {
      ui['source-video'].currentTime = state.start + state.keyPhotoTime;
    }
  }
}

async function playPreview() {
  if (!state.metadata || state.busy) return;
  if (state.playing) { stopPreview(); showCover(); return; }
  ui['result-video'].pause();
  showCover();
  const previewRevision = ++state.previewRevision;
  const sourceFile = state.files[0];
  state.playing = true;
  ui['preview-button'].textContent = '停止预览 □';
  ui['preview-caption'].textContent = `片段预览 · ${seconds(state.duration)} 秒`;
  if (state.metadata.kind === 'video') {
    try {
      ui['source-video'].currentTime = state.start;
      ui['source-video'].muted = !ui['include-audio'].checked;
      await ui['source-video'].play();
      if (previewRevision !== state.previewRevision && !state.playing) ui['source-video'].pause();
    } catch (error) {
      if (previewRevision !== state.previewRevision || sourceFile !== state.files[0]) return;
      stopPreview();
      showCover();
      showError(new Error(`无法播放预览：${error.message}`));
    }
  } else {
    const began = performance.now();
    function frame(now) {
      if (!state.playing || previewRevision !== state.previewRevision) return;
      const time = (now - began) / 1000;
      if (time >= state.duration) { stopPreview(); showCover(); return; }
      drawImages(time);
      state.animation = requestAnimationFrame(frame);
    }
    state.animation = requestAnimationFrame(frame);
  }
}

function settingChanged(key, value) {
  if (!state.metadata || state.busy) return;
  stopPreview();
  resetResult();
  clearError();
  setStatus();
  if (key) {
    const number = Number(value);
    if (Number.isFinite(number)) state[key] = number;
  }
  syncSettings();
  showCover();
}

async function generate() {
  if (ui['create-live'].disabled || state.busy || !state.metadata) return;
  stopPreview();
  resetResult();
  clearError();
  setStatus();
  const revision = ++state.revision;
  const controller = new AbortController();
  state.controller = controller;
  state.busy = 'generating';
  setProgress({ message: '准备制作实况…' });
  updateControls();
  try {
    const result = await createLivePhoto({
      files: [...state.files], start: state.start, duration: state.duration,
      keyPhotoTime: state.keyPhotoTime, motion: ui['motion'].value,
      includeAudio: ui['include-audio'].checked, signal: controller.signal,
      onProgress: progress => { if (revision === state.revision && !controller.signal.aborted) setProgress(progress); }
    });
    if (controller.signal.aborted || revision !== state.revision) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const stem = `Brclio-Live-${stamp}`;
    const readme = new TextEncoder().encode('\uFEFF' + [
      'Brclio 实况照片 · 导入说明', '',
      `实况时长：${seconds(result.duration)} 秒`, `尺寸：${result.width} × ${result.height}`,
      `封面：片段内 ${seconds(result.keyPhotoTime)} 秒`, '',
      `1. 解压 ZIP，保留同名的 ${stem}.JPG 与 ${stem}.MOV。`,
      '2. 在 Mac「照片」选择「文件 → 导入」，同时选中这一对文件。',
      '3. 检查导入结果是否显示 LIVE，并长按或播放确认动态内容。',
      '4. 需要同步到 iPhone 时，在两台设备上开启同一账号的 iCloud 照片，并等待同步。', '',
      'ZIP 下载到手机的文件夹，不会自动存入相册或自动变成实况。',
      '导入与识别结果取决于系统和相册版本；请保留原始配对文件。', ''
    ].join('\n'));
    const zip = makeZipBlob([
      { name: `${stem}.JPG`, data: result.jpeg }, { name: `${stem}.MOV`, data: result.mov },
      { name: 'README.txt', data: readme }
    ]);
    const zipUrl = URL.createObjectURL(zip);
    const previewUrl = URL.createObjectURL(result.previewBlob);
    state.resultUrls = [zipUrl, previewUrl];
    ui['download-live'].href = zipUrl;
    ui['download-live'].download = `${stem}.zip`;
    ui['result-video'].src = previewUrl;
    ui['result-video'].load();
    ui['result-video'].hidden = false;
    ui['source-video'].hidden = true;
    ui['source-canvas'].hidden = true;
    ui['preview-empty'].hidden = true;
    ui['result-panel'].hidden = false;
    ui['preview-caption'].textContent = '制作完成 · 播放预览，或下载配对文件';
    ui['result-summary'].textContent = `${seconds(result.duration)} 秒 · ${result.width} × ${result.height} · ZIP ${bytesLabel(zip.size)}`;
    document.documentElement.dataset.liveResult = 'ready';
    setStatus('已生成 JPG 与 MOV 配对文件。下载后按下方说明导入相册。');
  } catch (error) {
    if (revision === state.revision && error?.name !== 'AbortError') { showError(error); showCover(); }
  } finally {
    if (revision === state.revision) {
      state.busy = null;
      state.controller = null;
      updateControls();
    }
  }
}

ui['choose-files'].addEventListener('click', () => ui['file-input'].click());
ui['file-input'].addEventListener('change', () => selectFiles(Array.from(ui['file-input'].files || [])));
ui['clear-files'].addEventListener('click', () => { if (!state.busy) { ++state.revision; resetSelection(); clearError(); setStatus('素材已清空。'); } });
ui['source-list'].addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled || state.busy) return;
  const index = Number(button.dataset.index), action = button.dataset.action;
  if (action === 'remove') {
    const remaining = state.files.filter((_, position) => position !== index);
    selectFiles(remaining);
    return;
  }
  const next = action === 'up' ? index - 1 : index + 1;
  if (next < 0 || next >= state.files.length) return;
  [state.files[index], state.files[next]] = [state.files[next], state.files[index]];
  const firstImage = state.images.get(state.files[0]);
  state.metadata = { ...state.metadata, width: firstImage.naturalWidth, height: firstImage.naturalHeight };
  settingChanged();
  renderFileList();
  updateControls();
  ui['source-list'].querySelector(`button[data-index="${next}"][data-action="${action}"]`)?.focus();
  setStatus(`已将素材移到第 ${next + 1} 位。`);
});
for (const id of ['duration', 'duration-number']) ui[id].addEventListener(id === 'duration' ? 'input' : 'change', event => settingChanged('duration', event.target.value));
for (const id of ['start', 'start-number']) ui[id].addEventListener(id === 'start' ? 'input' : 'change', event => settingChanged('start', event.target.value));
ui['key-photo'].addEventListener('input', event => settingChanged('keyPhotoTime', event.target.value));
ui['motion'].addEventListener('change', () => settingChanged());
ui['include-audio'].addEventListener('change', () => settingChanged());
ui['preview-button'].addEventListener('click', playPreview);
ui['source-video'].addEventListener('loadedmetadata', updateControls);
ui['source-video'].addEventListener('loadeddata', () => { if (!state.playing) showCover(); });
ui['source-video'].addEventListener('timeupdate', () => {
  if (state.playing && ui['source-video'].currentTime >= state.start + state.duration - 0.015) {
    stopPreview(); showCover();
  }
});
ui['source-video'].addEventListener('ended', () => { if (state.playing) { stopPreview(); showCover(); } });
ui['result-video'].addEventListener('error', () => {
  if (!ui['result-panel'].hidden) ui['preview-caption'].textContent = '当前设备无法播放 MOV 预览；配对文件仍可下载并按说明导入。';
});
ui['create-live'].addEventListener('click', generate);
ui['cancel-live'].addEventListener('click', () => {
  const wasLoading = state.busy === 'loading';
  ++state.revision;
  state.controller?.abort();
  state.controller = null;
  state.busy = null;
  if (wasLoading) resetSelection();
  else { resetResult(); stopPreview(); showCover(); updateControls(); }
  setStatus('已取消。可以调整素材后重新制作。');
});
for (const type of ['dragenter', 'dragover']) ui['drop-zone'].addEventListener(type, event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  if (!state.busy) ui['drop-zone'].classList.add('is-dragging');
});
ui['drop-zone'].addEventListener('dragleave', event => {
  if (!ui['drop-zone'].contains(event.relatedTarget)) ui['drop-zone'].classList.remove('is-dragging');
});
ui['drop-zone'].addEventListener('drop', event => {
  event.preventDefault();
  ui['drop-zone'].classList.remove('is-dragging');
  if (!state.busy) selectFiles(Array.from(event.dataTransfer?.files || []));
});
// Prevent a dropped file outside the picker from navigating away from unsaved work.
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('pagehide', () => {
  ++state.revision;
  state.controller?.abort();
  releaseSources();
  resetResult();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    state.controller = null;
    state.busy = null;
    resetSelection();
    setStatus('重新打开页面后，请再次选择本地素材。');
  }
});

async function initialize() {
  try {
    state.support = await checkLivePhotoSupport();
    ui['support-note'].textContent = state.support.message;
    ui['support-note'].dataset.supported = String(state.support.supported);
  } catch (error) {
    state.support = { supported: false, audioSupported: false };
    ui['support-note'].textContent = `无法检查制作能力：${error.message}`;
    ui['support-note'].dataset.supported = 'false';
  }
  syncSettings();
  document.documentElement.dataset.liveReady = 'true';
}
initialize();
