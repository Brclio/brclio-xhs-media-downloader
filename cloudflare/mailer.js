import { createMailer } from '../server/auth/mailer.js';
import { createNativeSmtpTransport } from './smtp.js';

/** Keep provider configuration and message templates shared with Vercel. */
export function createCloudflareMailer(env, fetchImpl = (...args) => fetch(...args), transportOptions = {}) {
  return createMailer(env, fetchImpl, {
    createSmtpTransport: options => createNativeSmtpTransport(options, transportOptions),
  });
}
