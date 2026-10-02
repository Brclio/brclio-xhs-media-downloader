import { createMemberVideoHandler } from '../lib/member-video-handler.js';
import { createMediaAuthorization } from '../server/media-authorization.js';

export function createHostedMemberVideoHandler({ env = process.env, accountHandler, accountFetch, resolve, video, now } = {}) {
  return createMemberVideoHandler({
    authorize: createMediaAuthorization({ accountHandler, accountFetch, siteOrigin: () => env.AUTH_SITE_ORIGIN }),
    secret: () => env.AUTH_SECRET_PEPPER, resolve, video, now,
  });
}
export default createHostedMemberVideoHandler();
