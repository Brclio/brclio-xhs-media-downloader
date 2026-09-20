const ID = /^[a-f0-9]{24}$/i;

export function profileError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseProfileUrl(value) {
  const match = String(value ?? '').match(/https:\/\/[^\s<>"'）)]+/);
  let url;
  try { url = new URL(match?.[0] || String(value)); } catch { /* validated below */ }
  const id = url?.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/?$/i)?.[1];
  if (!url || !id || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)
      || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw profileError('INVALID_PROFILE', '请粘贴完整的小红书个人主页链接（/user/profile/用户 ID）。');
  }
  url.hostname = 'www.xiaohongshu.com';
  url.hash = '';
  return { id, url: url.href };
}

export function normalizeProfileNote(raw, profileId) {
  if (!raw || typeof raw !== 'object') return null;
  const card = raw.note_card || raw.noteCard || raw;
  const id = String(raw.note_id || raw.noteId || raw.id || card.note_id || card.noteId || card.id || '');
  const author = card.user?.user_id || card.user?.userId || raw.user?.user_id || raw.user?.userId;
  if (!ID.test(id) || (author && author !== profileId)) return null;
  let url = new URL(`https://www.xiaohongshu.com/explore/${id}`);
  if (raw.url) {
    try {
      const link = new URL(raw.url, 'https://www.xiaohongshu.com');
      if (link.origin !== 'https://www.xiaohongshu.com' || link.username || link.password) return null;
      const pathId = link.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1]
        || link.pathname.match(new RegExp(`^/user/profile/${profileId}/([a-f0-9]{24})/?$`, 'i'))?.[1];
      if (pathId !== id) return null;
      url.search = link.search;
    } catch { return null; }
  }
  const token = raw.xsec_token || raw.xsecToken || card.xsec_token || card.xsecToken;
  if (token) url.searchParams.set('xsec_token', String(token));
  if (!url.searchParams.has('xsec_source')) url.searchParams.set('xsec_source', 'pc_user');
  return { id, url: url.href, title: String(card.display_title || card.displayTitle || card.title || '').slice(0, 160) };
}

// A successful API response with an explicit has_more=false is authoritative.
// An empty page, timeout, or repeated scroll is never proof of completion.
export function parsePostedResponse(payload, profileId) {
  if (payload?.success === false || (payload?.code !== undefined && payload.code !== 0)) {
    const message = String(payload?.msg || payload?.message || '小红书要求登录或验证。');
    throw profileError(/频繁|风控|安全|验证|risk|captcha/i.test(message) ? 'RATE_LIMITED' : 'AUTH_REQUIRED', message);
  }
  const data = payload?.data;
  if (!data || !Array.isArray(data.notes)) return null;
  const normalized = data.notes.map(note => normalizeProfileNote(note, profileId)).filter(Boolean);
  if (normalized.length !== data.notes.length) {
    throw profileError('DISCOVERY_INCOMPLETE', '主页列表包含无法确认归属的帖子，已暂停，未标记全部完成。');
  }
  return { notes: normalized, done: data.has_more === false || data.hasMore === false };
}

// Executed only in the isolated, unprivileged Xiaohongshu browser. No Node API.
export function readProfileSnapshot(profileId) {
  const unwrap = value => value?._value ?? value?.value ?? value;
  const state = window.__INITIAL_STATE__ || {};
  const user = unwrap(state.user) || {};
  const visible = element => Boolean(element && element.getClientRects().length);
  const challenge = [...document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="verify-modal"], [class*="verifyModal"]')].some(visible);
  const login = [...document.querySelectorAll('.login-container, .login-modal, .login-mask, [class*="login-modal"]')].some(visible)
    || unwrap(state.login?.showLogin) === true;
  const active = unwrap(user.activeTab);
  const wrongTab = active && active.query && active.query !== 'note';
  const notes = unwrap(user.notes);
  const list = Array.isArray(notes?.[0]) ? notes[0] : [];
  const cards = [];
  if (location.pathname.replace(/\/$/, '') === `/user/profile/${profileId}` && !wrongTab) {
    for (const a of document.querySelectorAll('.note-item a[href], .feeds-tab-container a[href]')) {
      const href = a.getAttribute('href') || '';
      const id = href.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:[/?#]|$)/i)?.[1]
        || href.match(new RegExp(`/user/profile/${profileId}/([a-f0-9]{24})(?:[/?#]|$)`, 'i'))?.[1];
      if (id) cards.push({ id, url: a.href, title: a.closest('.note-item')?.querySelector('.title')?.textContent || '' });
    }
  }
  const query = unwrap(unwrap(user.noteQueries)?.[0]);
  const page = unwrap(user.userPageData) || {};
  const basic = unwrap(page.basicInfo) || {};
  // Query must explicitly identify the requested author, avoiding initial defaults.
  const done = query?.userId === profileId && query?.hasMore === false && !unwrap(user.isFetchingNotes)?.[0];
  return {
    list: JSON.parse(JSON.stringify(list)), cards, done, challenge, login, wrongTab,
    profileName: basic.nickname || '',
    pageText: cards.length || list.length ? '' : (document.body?.innerText || '').slice(0, 2500)
  };
}
