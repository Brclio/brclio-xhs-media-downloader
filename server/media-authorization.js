import { createAccountHandler, BROWSER_COOKIE } from '../api/account.js';
import { XhsError } from '../lib/xhs.js';

/** Reuse the account boundary so expiry, logout and revocation are checked live. */
export function createMediaAuthorization({ accountHandler = createAccountHandler(), accountFetch, siteOrigin } = {}) {
  return async req => {
    const cookie = String(req.headers?.cookie || '');
    if (!cookie.split(';').some(part => part.trim().startsWith(`${BROWSER_COOKIE}=`))) {
      throw new XhsError('请先登录软件账号，再使用会员原视频下载。', 401);
    }
    const origin = typeof siteOrigin === 'function' ? siteOrigin() : siteOrigin;
    if (!origin) throw new XhsError('会员视频服务尚未配置。', 503);
    const headers = { ...req.headers, 'content-type': 'application/json', origin };
    delete headers.authorization; delete headers['content-length'];
    const body = JSON.stringify({ action: 'authorize', input: { client: 'browser', feature: 'watermark-free-video' } });
    let status = 200, payload;
    if (accountFetch) {
      const response = await accountFetch(new Request(`${origin}/api/account`, { method: 'POST', headers, body }));
      status = response.status; payload = await response.json();
    } else {
      await accountHandler({ ...req, method: 'POST', headers, body }, {
        setHeader() { return this; }, status(code) { status = code; return this; }, json(value) { payload = value; return this; },
      });
    }
    if (status !== 200 || payload?.authorized !== true || !payload.account?.user?.id) {
      const error = new XhsError(payload?.error?.message || '当前账号没有原视频下载权限。', status === 200 ? 403 : status);
      error.code = payload?.error?.code || 'MEMBERSHIP_REQUIRED'; throw error;
    }
    return { userId: payload.account.user.id };
  };
}
