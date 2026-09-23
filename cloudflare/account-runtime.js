import { createAccountHandler } from '../api/account.js';
import { createCloudflareMailer } from './mailer.js';
import { invokeHandler, MAX_ACCOUNT_BODY_BYTES, RequestTooLargeError } from './http-adapter.js';

/**
 * Private SQLite-backed Durable Object, using its larger CPU allowance for
 * account state and full feedback verification. GitHub remains the only data
 * store; this class never writes to Durable Object storage.
 */
export class AccountRuntime {
  constructor(_state, env) {
    this.env = env;
  }

  async fetch(request) {
    try {
      return await invokeHandler(createAccountHandler({
        env: this.env,
        mailerFactory: createCloudflareMailer,
        // The public Worker preserves the platform-supplied header when calling
        // this private namespace; caller-controlled forwarding headers are ignored.
        clientIp: req => String(req.headers?.['cf-connecting-ip'] || '').trim() || 'unknown',
      }), request, { maxBodyBytes: MAX_ACCOUNT_BODY_BYTES });
    } catch (error) {
      const tooLarge = error instanceof RequestTooLargeError;
      return Response.json({
        ok: false,
        error: { code: tooLarge ? 'REQUEST_TOO_LARGE' : 'SERVICE_UNAVAILABLE', message: tooLarge ? '请求内容过大。' : '授权服务暂时不可用，请稍后重试。' },
        serverTime: new Date().toISOString(),
      }, { status: tooLarge ? 413 : 503, headers: {
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin, Cookie, Authorization',
      } });
    }
  }
}
