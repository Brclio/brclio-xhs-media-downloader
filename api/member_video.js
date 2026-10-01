import { createMemberVideoHandler } from '../lib/member-video-handler.js';
import { createMediaAuthorization } from '../server/media-authorization.js';

export function createHostedMemberVideoHandler({ env = process.env, accountHandler, accountFetch, resolve, now } = {}) {
  return createMemberVideoHandler({
    authorize: createMediaAuthorization({ accountHandler, accountFetch, siteOrigin: () => env.AUTH_SITE_ORIGIN }),
    secret: () => env.AUTH_SECRET_PEPPER, resolve, now,
  });
}
export default createHostedMemberVideoHandler();
