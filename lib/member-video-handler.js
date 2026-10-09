import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { XhsError, extractInputUrl, extractNoteId, fetchNotePage, isXhsVideoUrl, parseNoteHtml } from './xhs.js';
import { createVideoHandler } from '../api/video.js';

const TICKET_TTL_MS = 30 * 60_000;
const AAD = Buffer.from('brclio-member-video-v1');

export async function resolveOriginalVideos(text) {
  const input = extractInputUrl(text);
  const { finalUrl, html } = await fetchNotePage(input);
  const noteId = extractNoteId(finalUrl) || extractNoteId(input);
  if (!noteId) throw new XhsError('无法确认当前视频笔记。', 422);
  return { ...parseNoteHtml(html, { noteId }), noteId };
}

function keyFor(secret) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new XhsError('会员视频服务尚未配置。', 503);
  return createHash('sha256').update(AAD).update(secret).digest();
}
function seal(payload, key) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
}
function unseal(ticket, key) {
  try {
    if (typeof ticket !== 'string' || ticket.length > 12_000 || !/^[A-Za-z0-9_-]+$/.test(ticket)) throw new Error();
    const data = Buffer.from(ticket, 'base64url');
    if (data.length < 29) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    cipher.setAAD(AAD); cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  } catch { throw new XhsError('原视频下载凭据无效，请重新解析。', 403); }
}

/** Shared only by trusted server/main-process code; the key never leaves it. */
export function createMemberVideoTicketService({ authorize, secret = randomBytes(32), now = Date.now } = {}) {
  return {
    async session(req) {
      const principal = await authorize?.(req);
      if (!principal?.userId) throw new XhsError('请先登录并开通会员。', 401);
      const key = keyFor(typeof secret === 'function' ? secret() : secret);
      const subject = createHash('sha256').update(principal.userId).digest('hex');
      return {
        expiresAt: () => now() + TICKET_TTL_MS,
        seal: (url, expiresAt) => `member-video:${seal({ subject, url, expiresAt }, key)}`,
        resolve(value) {
          const ticket = unseal(String(value).replace(/^member-video:/, ''), key);
          if (ticket.subject !== subject) throw new XhsError('此下载凭据属于其他账号，请重新解析。', 403);
          if (!Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= now()) throw new XhsError('原视频下载凭据已过期，请重新解析。', 403);
          if (!isXhsVideoUrl(ticket.url)) throw new XhsError('原视频地址无效。', 403);
          return ticket;
        },
        async recheck(ticket) {
          const current = await authorize?.(req);
          if (!current?.userId || current.userId !== principal.userId) throw new XhsError('软件账号已退出或切换，请重新解析。', 401);
          if (ticket && ticket.expiresAt <= now()) throw new XhsError('原视频下载凭据已过期，请重新解析。', 403);
        },
      };
    },
  };
}

/** The source URL stays encrypted, including for authenticated renderers. */
export function createMemberVideoHandler({ authorize, secret, resolve = resolveOriginalVideos,
  video = createVideoHandler({ authorizeOriginal: async () => {} }), now = Date.now,
  ticketService = createMemberVideoTicketService({ authorize, secret, now }) } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Cookie, Authorization');
    try {
      if (!['POST', 'GET'].includes(req.method)) {
        res.setHeader('Allow', 'POST, GET'); throw new XhsError('只支持 POST 或 GET 请求。', 405);
      }
      // Recheck the live account before resolving, metadata, and every chunk.
      const tickets = await ticketService.session(req);
      if (req.method === 'POST') {
        let body;
        try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
        catch { throw new XhsError('请求 JSON 格式无效。'); }
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        if (!text || text.length > 3000) throw new XhsError('请提供有效的小红书视频分享链接。');
        const parsed = await resolve(text);
        const candidates = (parsed.originalVideos || []).filter(item => isXhsVideoUrl(item.url));
        if (!candidates.length) throw new XhsError('当前网页未提供原始视频地址，请使用普通视频下载或稍后重试。', 422);
        await tickets.recheck();
        const expiresAt = tickets.expiresAt();
        const videos = candidates.map((item, index) => ({
          index: index + 1, url: tickets.seal(item.url, expiresAt),
          backupUrls: (item.backupUrls || []).filter(isXhsVideoUrl).map(url => tickets.seal(url, expiresAt)),
          codec: item.codec || '', width: item.width || 0, height: item.height || 0, size: item.size || 0,
          bitrate: item.bitrate || 0, hasAudio: item.hasAudio ?? null,
          qualityType: 'origin', source: item.source, sourceField: item.sourceField,
          declaredMd5: item.declaredMd5 || '', metadataSource: item.metadataSource || '',
          sourceWatermark: item.sourceWatermark || 'unknown', requiresMembership: true,
          label: '原始视频 · 会员', isDefault: index === 0,
        }));
        return res.status(200).json({ success: true, title: parsed.title, noteId: parsed.noteId, videos,
          expiresAt: new Date(expiresAt).toISOString(), message: '下载网页提供的原始视频；作者写入画面的水印可能仍保留。' });
      }
      const ticket = tickets.resolve(req.query?.ticket);
      // The video handler already buffers at most one 3.5 MB chunk. Hold its
      // terminal response and headers until live authorization is checked again.
      const headers = new Map();
      let status = 200, body, terminal;
      const pending = {
        setHeader(name, value) { headers.set(String(name).toLowerCase(), value); return this; },
        getHeader(name) { return headers.get(String(name).toLowerCase()) ?? res.getHeader?.(name); },
        status(value) { status = value; return this; },
        json(value) { body = value; terminal = 'json'; return this; },
        send(value) { body = value; terminal = 'send'; return this; },
        end(value) { body = value; terminal = 'end'; return this; },
      };
      await video({ ...req, query: { ...req.query, url: ticket.url } }, pending);
      if (!terminal) throw new XhsError('会员视频响应不完整，请重试。', 502);
      if (status >= 200 && status < 300) await tickets.recheck(ticket);
      for (const [name, value] of headers) res.setHeader(name, value);
      return res.status(status)[terminal](body);
    } catch (error) {
      const status = error.statusCode || error.status || 503;
      return res.status(status).json({ success: false, code: error.code || 'MEMBER_VIDEO_ERROR',
        message: status === 503 && !(error instanceof XhsError) ? '会员视频服务暂时不可用，请稍后重试。' : error.message });
    }
  };
}
