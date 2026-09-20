/**
 * Read only the signed-in account, never the author of the profile being viewed.
 * Self-contained because XhsBrowser executes this function's source in its page.
 * No cookies, storage, requests, tokens, or arbitrary account object are returned.
 */
export function readLoginSnapshot() {
  const empty = status => ({ status, loggedIn: status === 'logged-in', nickname: '', userId: '' });
  try {
    const unwrap = input => {
      let value = input;
      const visited = new Set();
      for (let depth = 0; depth < 5 && value && typeof value === 'object'; depth++) {
        if (visited.has(value)) break;
        visited.add(value);
        if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
        else if (Object.prototype.hasOwnProperty.call(value, 'value')
          && (value.__v_isRef === true || Object.keys(value).length === 1)) value = value.value;
        else break;
      }
      return value;
    };
    const state = unwrap(window.__INITIAL_STATE__) || {};
    const user = unwrap(state.user) || {};
    const account = unwrap(state.account) || {};
    const auth = unwrap(state.auth) || {};
    const boolean = (...values) => values.map(unwrap).find(value => typeof value === 'boolean');
    // The user store is authoritative; do not let a stale secondary store undo logout.
    const flag = boolean(user.loggedIn, user.isLoggedIn)
      ?? boolean(account.loggedIn, account.isLoggedIn, auth.loggedIn, auth.isLoggedIn, auth.isAuthenticated);
    if (flag === false) return empty('logged-out');
    if (flag !== true) return empty('unknown');

    const idOf = candidate => {
      for (const key of ['userId', 'user_id', 'uid', 'id']) {
        const value = unwrap(candidate?.[key]);
        if (typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value.trim())) return value.trim();
      }
      return '';
    };
    const clean = input => {
      const value = unwrap(input);
      if (typeof value !== 'string') return '';
      return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 120).join('');
    };
    const nicknameOf = candidate => {
      for (const key of ['nickname', 'nickName', 'nick_name', 'name']) {
        const value = clean(candidate?.[key]);
        if (value) return value;
      }
      return '';
    };
    // These stores describe the current session. In particular, userPageData,
    // note authors, feeds, search results, and DOM profile headers are excluded.
    const candidates = [
      user.userInfo, user.currentUser, user.accountInfo,
      account.userInfo, account.currentUser, account.accountInfo,
      auth.userInfo, auth.currentUser, auth.user, state.currentUser
    ].map(unwrap).filter(value => value && typeof value === 'object');
    const userId = candidates.map(idOf).find(Boolean) || '';
    let nickname = '';
    for (const candidate of candidates) {
      const candidateId = idOf(candidate);
      if (userId && candidateId && candidateId !== userId) continue;
      nickname = nicknameOf(candidate);
      if (nickname) break;
    }

    if (!nickname && userId && typeof document?.querySelectorAll === 'function') {
      const selectors = [
        'nav a[href]', '[role="navigation"] a[href]', '.side-bar a[href]', '.sidebar a[href]',
        '.navigation a[href]', '.user-menu a[href]', '.account-menu a[href]', '[data-account-menu] a[href]'
      ].join(', ');
      const generic = /^(?:我|我的|我的主页|个人主页|我的账户|我的账号|账号|账户|用户|头像|用户头像|个人头像|登录|退出登录|my profile|profile|account|avatar|me)$/i;
      const domName = value => {
        const name = clean(value);
        return name && !generic.test(name) ? name : '';
      };
      for (const link of document.querySelectorAll(selectors)) {
        let url;
        try { url = new URL(link.getAttribute('href') || link.href, 'https://www.xiaohongshu.com'); }
        catch { continue; }
        if (url.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)
          || url.username || url.password || url.port
          || url.pathname.replace(/\/$/, '') !== `/user/profile/${userId}`) continue;
        const ownName = link.querySelector?.('[data-nickname], [data-user-name], .nickname, .user-name, .user_name');
        const avatar = link.querySelector?.('img[alt]');
        const values = [
          link.getAttribute('data-nickname'), link.getAttribute('data-user-name'),
          ownName?.getAttribute?.('data-nickname'), ownName?.getAttribute?.('data-user-name'),
          ownName?.textContent, link.getAttribute('title'), avatar?.getAttribute?.('alt'),
          link.getAttribute('aria-label'), link.textContent
        ];
        nickname = values.map(domName).find(Boolean) || '';
        if (nickname) break;
      }
    }
    return { status: 'logged-in', loggedIn: true, nickname, userId };
  } catch {
    return empty('unknown');
  }
}
