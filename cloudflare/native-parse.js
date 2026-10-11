import { createParseHandler } from '../api/parse.js';
import { XhsError, extractNoteId, fetchNotePage } from '../lib/xhs.js';

const HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com',
  'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
const STRATEGIES = new Set(['missing-note-id', 'exact-initial-state', 'note-id-local-media',
  'note-id-local-image-list', 'note-id-local-video', 'primary-meta-media',
  'primary-meta-cover', 'primary-meta-video', 'not-found']);
const CAPTCHA_TITLES = new Set(['小红书安全验证', '小红书 - 安全验证', '安全验证 - 小红书']);
const LOGIN_TITLES = new Set(['小红书登录', '小红书 - 登录', '登录 - 小红书']);

function locationSummary(value) {
  let url;
  try { url = new URL(value); } catch { return { host: 'other', pathClass: 'other' }; }
  if (!HOSTS.has(url.hostname) || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    return { host: 'other', pathClass: 'other' };
  }
  const path = url.pathname;
  const pathClass = /(?:^|\/)captcha(?:\/|$)/i.test(path) ? 'captcha'
    : /(?:^|\/)(?:login|signin|website-login)(?:\/|$)/i.test(path) ? 'login'
      : /^(?:\/explore\/|\/discovery\/item\/)[a-f\d]{24}(?:\/|$)/i.test(path) ? 'note'
        : /(?:^|\.)xhslink\.(?:com|cn)$/.test(url.hostname) ? 'shortlink' : 'other';
  return { host: url.hostname, pathClass };
}

function pageSummary({ finalUrl, html }, noteId) {
  const { host: finalHost, pathClass: finalPathClass } = locationSummary(finalUrl);
  const title = /<title\b[^>]*>([^<]{0,160})<\/title\s*>/i.exec(html)?.[1]?.trim() || '';
  const trusted = finalHost !== 'other';
  return { finalHost, finalPathClass, htmlBytes: new TextEncoder().encode(html).byteLength,
    initialStatePresent: /(?:window\.)?__INITIAL_STATE__\s*=/.test(html),
    currentNotePresent: Boolean(noteId && new RegExp(
      `["']${noteId}["']\\s*:|["'](?:noteId|note_id|id|itemId|item_id)["']\\s*:\\s*["']${noteId}["']`
    ).test(html)),
    challengeDetected: trusted && (finalPathClass === 'captcha' || CAPTCHA_TITLES.has(title)),
    loginDetected: trusted && (finalPathClass === 'login' || LOGIN_TITLES.has(title)) };
}

function gateError(summary) {
  return new XhsError(summary.challengeDetected
    ? '小红书要求服务器完成安全验证，暂时无法解析这篇笔记。请稍后重试，或使用桌面客户端正常登录与验证。'
    : '小红书要求登录后查看这篇笔记，服务器暂时无法解析。请使用桌面客户端正常登录后重试。', 422);
}

/** Each request owns its trace; diagnostics never change fetch options or add requests. */
export function createCloudflareParseHandler({ fetchImpl, fetchPage = fetchNotePage,
  log = summary => console.warn('CF_NATIVE_PARSE_FAILURE', JSON.stringify(summary)) } = {}) {
  return async (req, res) => {
    const upstream = [];
    let page;
    let parsed;
    let phase = 'fetch';
    let noteIdPresent = false;
    let emitted = false;
    const failure = failureClass => {
      if (emitted) return;
      emitted = true;
      const summary = {
        event: 'xhs_native_parse_failure', engine: 'node', phase, failureClass,
        upstream: upstream.map(item => ({ ...item })),
        finalHost: page?.finalHost || upstream.at(-1)?.host || 'other',
        finalPathClass: page?.finalPathClass || upstream.at(-1)?.pathClass || 'other',
        htmlBytes: page?.htmlBytes || 0, noteIdPresent,
        initialStatePresent: page?.initialStatePresent || false,
        currentNotePresent: page?.currentNotePresent || false,
        challengeDetected: page?.challengeDetected || false, loginDetected: page?.loginDetected || false,
        strategy: parsed?.strategy || 'unknown', imageCount: parsed?.imageCount || 0,
        videoCount: parsed?.videoCount || 0, originalVideoCount: parsed?.originalVideoCount || 0,
      };
      try { log(summary); } catch { /* Diagnostics must not replace the native response. */ }
    };
    const handler = createParseHandler({
      fetchPage: async inputUrl => {
        noteIdPresent = Boolean(extractNoteId(inputUrl));
        const result = await fetchPage(inputUrl, { fetchImpl: async (url, options) => {
          const location = locationSummary(url);
          try {
            const response = await (fetchImpl || globalThis.fetch)(url, options);
            if (upstream.length < 6) upstream.push({ ...location,
              status: Number.isInteger(response.status) && response.status >= 0 && response.status <= 599 ? response.status : 0 });
            return response;
          } catch (error) {
            if (upstream.length < 6) upstream.push({ ...location, status: 0 });
            throw error;
          }
        } });
        const noteId = extractNoteId(result.finalUrl) || extractNoteId(inputUrl);
        page = pageSummary(result, noteId);
        phase = 'parse';
        noteIdPresent = Boolean(noteId);
        if (!noteIdPresent && (page.challengeDetected || page.loginDetected)) throw gateError(page);
        return result;
      },
      onParsed: summary => {
        parsed = { ...summary, strategy: STRATEGIES.has(summary.strategy) ? summary.strategy : 'unknown' };
        if (summary.imageCount || summary.videoCount || summary.originalVideoCount) return;
        if (page?.challengeDetected || page?.loginDetected) throw gateError(page);
        failure('no-media');
      },
      onError: () => {
        if (!upstream.length && !page) return;
        failure(page?.challengeDetected ? 'captcha' : page?.loginDetected ? 'login'
          : page && !noteIdPresent ? 'note-id-missing' : 'fetch-failed');
      },
    });
    return handler(req, res);
  };
}

export default createCloudflareParseHandler();
