import { isXhsVideoUrl, normalizeImageUrl } from './xhs.js';

// Public playback renditions use /stream/. Other CDN paths can contain original
// uploads, so they must go through the member gateway. Never trust a UI flag.
export function isMemberVideoUrl(value) {
  if (!isXhsVideoUrl(value)) return false;
  try {
    const path = decodeURIComponent(new URL(normalizeImageUrl(value)).pathname);
    return !path.startsWith('/stream/') || path.includes('\\') || path.split('/').includes('..');
  } catch { return true; }
}

/** Public APIs expose only playback paths, even when a page omits its origin key. */
export function publicPlaybackVideo(video) {
  if (!video || typeof video !== 'object') return null;
  const urls = [video.url, ...(Array.isArray(video.backupUrls) ? video.backupUrls : [])]
    .filter(url => typeof url === 'string' && isXhsVideoUrl(url) && !isMemberVideoUrl(url));
  return urls.length ? { ...video, url: urls[0], backupUrls: urls.slice(1) } : null;
}
