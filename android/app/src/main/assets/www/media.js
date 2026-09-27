export function safeFilename(value) {
  return String(value || '小红书笔记').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '小红书笔记';
}

export function mediaUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443')) return '';
    if (!(url.hostname === 'xhscdn.com' || url.hostname.endsWith('.xhscdn.com') || url.hostname === 'ci.xiaohongshu.com')) return '';
    url.protocol = 'https:';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function normalizeVideo(raw, index) {
  const url = mediaUrl(raw?.url);
  if (!url) throw new Error('解析结果包含无效的视频地址，请重新解析。');
  return { ...raw, index, url, backupUrls: [...new Set((Array.isArray(raw.backupUrls) ? raw.backupUrls : []).map(mediaUrl).filter(Boolean))] };
}

export function normalizeNote(payload, input = '') {
  if (!payload?.success) throw new Error(payload?.message || '解析失败，请稍后重试。');
  const images = (Array.isArray(payload.images) ? payload.images : []).map((raw, index) => {
    const url = mediaUrl(raw?.url);
    if (!url) throw new Error('解析结果包含无效的图片地址，请重新解析。');
    return { index: index + 1, url, livePhoto: Boolean(raw.livePhoto || raw.liveVideo), liveVideo: raw.liveVideo ? normalizeVideo(raw.liveVideo, index + 1) : null };
  });
  const videos = (Array.isArray(payload.videos) ? payload.videos : []).map((raw, index) => normalizeVideo(raw, index + 1));
  if (!images.length && !videos.length) throw new Error('未找到可下载的图片或视频。');
  if (images.length > 50 || videos.length > 50) throw new Error('媒体数量过多，请使用网页版处理。');
  return {
    title: String(payload.title || '小红书笔记'), content: String(payload.content || ''),
    sourceUrl: String(input).match(/https?:\/\/[^\s<>"'”]+/)?.[0]?.replace(/[.,;!?\])}，。！？；）】》]+$/g, '') || '',
    noteId: String(payload.noteId || ''), engine: payload.engine === 'python' ? 'Python' : 'Node.js', images, videos,
  };
}

export function captionText(note) {
  const title = note.title.trim();
  const content = note.content.trim();
  return !content ? title : !title || content === title || content.startsWith(`${title}\n`) ? content : `${title}\n\n${content}`;
}

export function textEntry(note, now = new Date()) {
  return { name: '文案.txt', text: `\ufeff${captionText(note)}\n\n来源：${note.sourceUrl}\n解析引擎：${note.engine}\n生成时间：${now.toISOString()}\n` };
}

export function imageEntry(image) {
  return { name: `${String(image.index).padStart(2, '0')}.jpg`, url: image.url, kind: 'image' };
}

export function videoEntry(video, filename, requireAudio = true) {
  return { name: filename, url: video.url, backupUrls: video.backupUrls || [], kind: 'video', requireAudio };
}

export function selectedEntries(note, selected, now = new Date()) {
  const images = note.images.filter(image => selected.has(image.index));
  if (!images.length) throw new Error('请先选择至少一张图片。');
  const entries = [];
  for (const image of images) {
    if (image.livePhoto && !image.liveVideo) throw new Error(`第 ${image.index} 张实况的动态片段不完整，请重新解析，或单独保存原图。`);
    entries.push(imageEntry(image));
    if (image.liveVideo) entries.push(videoEntry(image.liveVideo, `${String(image.index).padStart(2, '0')}-live.mp4`, false));
  }
  return [...entries, textEntry(note, now)];
}
