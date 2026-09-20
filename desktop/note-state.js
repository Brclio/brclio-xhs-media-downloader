/** Extract one exact note without serializing the reactive store or its comments. */
export function readNoteSnapshot(noteId) {
  const result = { challenge: false, login: false, serialized: '' };
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  try {
    const visible = element => Boolean(element && element.getClientRects().length);
    result.challenge = [...document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="verify-modal"], [class*="verifyModal"]')].some(visible);
    result.login = [...document.querySelectorAll('.login-container, .login-modal, .login-mask')].some(visible);
    if (!/^[a-f0-9]{24}$/i.test(String(noteId))) fail('NOTE_ID_MISMATCH', '笔记 ID 无效。');
    const unwrap = input => {
      let value = input;
      const visited = new Set();
      for (let depth = 0; depth < 16 && value && typeof value === 'object'; depth++) {
        if (visited.has(value)) fail('NOTE_STATE_INVALID', '笔记数据的引用结构异常。');
        visited.add(value);
        if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
        else if (Object.prototype.hasOwnProperty.call(value, 'value')
          && (value.__v_isRef === true || Object.keys(value).length === 1)) value = value.value;
        else return value;
      }
      if (value && typeof value === 'object') fail('NOTE_STATE_TOO_LARGE', '笔记数据引用层级过深，未读取完整媒体。');
      return value;
    };
    const state = unwrap(window.__INITIAL_STATE__) || {};
    const store = unwrap(state.note) || {};
    const data = unwrap(state.data) || {};
    const maps = [store.noteDetailMap, store.noteDetailMapV2, state.noteDetailMap, data.noteDetailMap];
    let note;
    const select = (raw, trustedMapEntry = false, depth = 0) => {
      if (depth > 6) return;
      const candidate = unwrap(raw);
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
      const ids = ['noteId', 'note_id', 'id'].map(key => unwrap(candidate[key])).filter(id => id != null && id !== '');
      const hasMedia = ['imageList', 'image_list', 'images', 'video'].some(key => Object.prototype.hasOwnProperty.call(candidate, key));
      if (hasMedia && (trustedMapEntry || ids.some(id => String(id) === noteId))) return candidate;
      // Mobile/newer pages put the exact note under noteData.data. Traverse only
      // known detail wrappers, never comments, recommendations or arbitrary IDs.
      for (const key of ['note', 'noteData', 'note_data', 'data', 'detail', 'details']) {
        const found = select(candidate[key], trustedMapEntry, depth + 1);
        if (found) return found;
      }
    };
    for (const raw of maps) {
      const map = unwrap(raw);
      if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, noteId)) continue;
      note = select(map[noteId], true);
      if (note) break;
    }
    note ||= select(state.noteData) || select(state.note_data) || select(store) || select(data);
    if (!note) return result;
    for (const key of ['noteId', 'note_id', 'id']) {
      const id = unwrap(note[key]);
      if (id != null && id !== '' && String(id) !== noteId) fail('NOTE_ID_MISMATCH', '详情数据与当前笔记 ID 不一致，未读取其他帖子。');
    }

    const noteKeys = new Set([
      'noteId', 'note_id', 'id', 'title', 'displayTitle', 'display_title', 'desc', 'description',
      'type', 'images', 'imageList', 'image_list', 'video'
    ]);
    // Only parser-used media data is traversed. Vue dep/effect/computed internals,
    // comments, recommendations, authors and tracking/session metadata are excluded.
    const mediaKeys = new Set([
      'urlDefault', 'url_default', 'defaultUrl', 'default_url', 'originUrl', 'origin_url',
      'original', 'originalUrl', 'original_url', 'url', 'imageUrl', 'image_url', 'fileUrl', 'file_url',
      'urlPre', 'url_pre', 'previewUrl', 'preview_url', 'thumbnail', 'thumbnailUrl', 'thumbnail_url',
      'infoList', 'info_list', 'imageInfo', 'image_info', 'urlInfo', 'url_info', 'urlList', 'url_list',
      'imageScene', 'image_scene', 'format', 'scene', 'imageId', 'image_id', 'fileId', 'file_id',
      'livePhoto', 'live_photo', 'isLivePhoto', 'is_live_photo',
      'stream', 'livePhotoStream', 'live_photo_stream', 'media', 'consumer',
      'h264', 'h265', 'h266', 'av1', 'masterUrl', 'master_url', 'masterUrls', 'master_urls',
      'backupUrls', 'backup_urls', 'videoCodec', 'video_codec', 'codec', 'width', 'height',
      'videoBitrate', 'video_bitrate', 'bitrate', 'size', 'fileSize', 'file_size',
      'videoDuration', 'video_duration', 'duration', 'qualityType', 'quality_type',
      'audioCodec', 'audio_codec', 'audioBitrate', 'audio_bitrate', 'audioChannels', 'audio_channels',
      'audioDuration', 'audio_duration', 'hasAudio', 'has_audio', 'format', 'streamType', 'stream_type',
      'originVideoKey', 'origin_video_key'
    ]);
    const MAX_BYTES = 8 * 1024 * 1024;
    let stringBytes = 0;
    let nodes = 0;
    const ancestors = new Set();
    const encoder = new TextEncoder();
    const clone = (raw, depth = 0, top = false) => {
      if (++nodes > 50000 || depth > 24) fail('NOTE_STATE_TOO_LARGE', '笔记媒体数据过大或层级过深，未截断保存。');
      const value = unwrap(raw);
      if (value === null) return null;
      if (typeof value === 'string') {
        if (value.length > MAX_BYTES) fail('NOTE_STATE_TOO_LARGE', '当前笔记数据超过 8 MiB，未截断保存。');
        stringBytes += encoder.encode(value).byteLength;
        if (stringBytes > MAX_BYTES) fail('NOTE_STATE_TOO_LARGE', '当前笔记数据超过 8 MiB，未截断保存。');
        return value;
      }
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (!value || typeof value !== 'object') return undefined;
      if (ancestors.has(value)) fail('NOTE_STATE_INVALID', '当前笔记媒体包含循环引用，未读取不完整数据。');
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          if (value.length > 2000) fail('NOTE_STATE_TOO_LARGE', '当前笔记媒体条目过多，未截断保存。');
          return value.map(item => clone(item, depth + 1));
        }
        const output = {};
        for (const key of top ? noteKeys : mediaKeys) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const copied = clone(value[key], depth + 1);
          if (copied !== undefined) output[key] = copied;
        }
        return output;
      } finally { ancestors.delete(value); }
    };
    const cleanNote = clone(note, 0, true);
    cleanNote.noteId = noteId;
    const serialized = JSON.stringify({ note: { noteDetailMap: { [noteId]: { note: cleanNote } } } });
    if (encoder.encode(serialized).byteLength > MAX_BYTES) fail('NOTE_STATE_TOO_LARGE', '当前笔记数据超过 8 MiB，未截断保存。');
    result.serialized = serialized;
    return result;
  } catch (error) {
    result.error = { code: error.code || 'NOTE_STATE_INVALID', message: error.code ? error.message : '无法读取当前笔记媒体数据，请稍后重试。' };
    return result;
  }
}
