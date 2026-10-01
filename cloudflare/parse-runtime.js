import parse from '../api/parse.js';
import { createHostedMemberVideoHandler } from '../api/member_video.js';
import { createAccountHandler } from '../api/account.js';
import { parseWithFallback } from './parse-fallback.js';
import { invokeHandler, readBoundedBody, MAX_API_BODY_BYTES, MAX_ACCOUNT_BODY_BYTES, RequestTooLargeError } from './http-adapter.js';

/** Keep HTML parsing and fallback orchestration within the DO CPU allowance. */
export class ParseRuntime {
  constructor(_state, env) {
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const python = path === '/api/python_parse';
    const json = (body, status) => Response.json(body, { status, headers: {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
    if (path !== '/api/parse' && path !== '/api/member_video' && !python) return json({ success: false, message: '接口不存在。' }, 404);
    try {
      if (path === '/api/member_video') {
        const accountFetch = this.env.ACCOUNT_RUNTIME
          ? nativeRequest => this.env.ACCOUNT_RUNTIME.get(this.env.ACCOUNT_RUNTIME.idFromName('accounts-v1')).fetch(nativeRequest)
          : nativeRequest => invokeHandler(createAccountHandler({ env: this.env }), nativeRequest, { maxBodyBytes: MAX_ACCOUNT_BODY_BYTES });
        return await invokeHandler(createHostedMemberVideoHandler({ env: this.env, accountFetch }), request);
      }
      return await parseWithFallback(request, this.env, async nativeRequest => {
        if (!python) return invokeHandler(parse, nativeRequest);
        if (!this.env.PYTHON_API?.fetch) {
          return json({ success: false, engine: 'python', message: 'Python 服务暂时不可用，请稍后重试。' }, 503);
        }
        const body = await readBoundedBody(nativeRequest, MAX_API_BODY_BYTES);
        return this.env.PYTHON_API.fetch(new Request(nativeRequest, {
          body: ['GET', 'HEAD'].includes(nativeRequest.method) ? undefined : body,
        }));
      });
    } catch (error) {
      const tooLarge = error instanceof RequestTooLargeError;
      return json({
        success: false, engine: python ? 'python' : 'node',
        message: tooLarge ? '请求内容过大。' : '服务暂时不可用，请稍后重试。',
      }, tooLarge ? 413 : 503);
    }
  }
}
