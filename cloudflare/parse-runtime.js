import parse from './native-parse.js';
import { createParseHandler } from '../api/parse.js';
import { BrowserSessionManager } from './browser-session.js';
import { maybeParseWithBrowser } from './browser-parse.js';
import { createHostedMemberVideoHandler } from '../api/member_video.js';
import { createAccountHandler } from '../api/account.js';
import { invokeHandler, readBoundedBody, MAX_API_BODY_BYTES, MAX_ACCOUNT_BODY_BYTES, RequestTooLargeError } from './http-adapter.js';

/** Keep native HTML parsing within the DO CPU allowance. */
export class ParseRuntime {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.browser = new BrowserSessionManager(state, env.BROWSER, {
      authorizeToken: token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
        && state.id?.equals?.(env.PARSE_RUNTIME.idFromName(`browser:${token}`)),
    });
  }

  async alarm() { await this.browser.alarm(); }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const python = path === '/api/python_parse';
    const json = (body, status) => Response.json(body, { status, headers: {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
    if (path.startsWith('/__internal/browser/')) {
      if (request.method !== 'POST') return json({ success: false }, 405);
      const started = Date.now();
      try {
        const body = JSON.parse(await readBoundedBody(request, MAX_API_BODY_BYTES));
        const operation = path.slice('/__internal/browser/'.length);
        if (!['start', 'resume', 'cancel'].includes(operation)) return json({ success: false }, 404);
        const result = await this.browser[operation](body);
        if (result.kind === 'verification') return json({
          success: false, engine: result.engine, code: 'VERIFICATION_REQUIRED',
          message: '小红书要求安全验证。请打开验证窗口完成验证，再继续解析。',
          verificationUrl: result.verificationUrl, expiresAt: result.expiresAt,
        }, 422);
        let response;
        if (operation === 'cancel') response = json({ success: true, cancelled: true }, 200);
        else if (result.kind === 'page' && result.engine === 'python') {
          response = await this.env.PYTHON_API.fetch(new Request('https://python.internal/__internal/parse-rendered-note', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ finalUrl: result.finalUrl, html: result.html, noteId: result.noteId }),
          }));
        } else if (result.kind === 'page') {
          response = await invokeHandler(createParseHandler({
            fetchPage: async () => ({ finalUrl: result.finalUrl, html: result.html }),
            onError: () => {},
          }), new Request('https://node.internal/api/parse', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: result.finalUrl }),
          }));
        } else return json({ success: false, code: 'BROWSER_UNAVAILABLE', message: '页面读取暂时不可用，请稍后重试。' }, 503);
        if (result.closed) {
          response = new Response(response.body, response);
          response.headers.set('X-Browser-Closed', '1');
          response.headers.set('X-Browser-Elapsed-Ms', String(Math.min(180000, Date.now() - started)));
        }
        return response;
      } catch (error) {
        const codes = new Set(['BROWSER_EXPIRED', 'BROWSER_NOT_FOUND', 'BROWSER_NOT_READY', 'BROWSER_TIMEOUT',
          'BROWSER_ACQUIRE_FAILED', 'BROWSER_TARGET_FAILED', 'BROWSER_CONNECT_FAILED', 'BROWSER_CDP_FAILED',
          'BROWSER_CDP_PROTOCOL', 'BROWSER_HTML_TOO_LARGE', 'BROWSER_LIVE_VIEW_FAILED', 'BROWSER_LIVE_VIEW_INVALID',
          'BROWSER_PAGE_REJECTED', 'BROWSER_NOTE_MISMATCH', 'BROWSER_PAGE_UNAVAILABLE', 'BROWSER_CANCELLED',
          'BROWSER_STORAGE', 'BROWSER_CLOSE_FAILED', 'BROWSER_INPUT_REJECTED', 'BROWSER_OWNER_REJECTED']);
        const diagnostic = error?.diagnostic;
        const location = diagnostic?.finalLocation;
        const page = location && ['apex', 'www', 'shortlink', 'other'].includes(location.hostname)
          && ['note', 'captcha', 'login', 'shortlink', 'root', 'error', 'other', 'blank'].includes(location.pathClass)
          && Number.isInteger(diagnostic.htmlBytes) && diagnostic.htmlBytes >= 0 && diagnostic.htmlBytes <= 6291457
          ? { finalLocation: { hostname: location.hostname, pathClass: location.pathClass },
            htmlBytes: diagnostic.htmlBytes, brandedCaptcha: diagnostic.brandedCaptcha === true,
            brandedLogin: diagnostic.brandedLogin === true } : null;
        console.warn('CF_BROWSER_PARSE_FAILURE', JSON.stringify({
          operation: path.endsWith('/resume') ? 'resume' : path.endsWith('/cancel') ? 'cancel' : 'start',
          code: codes.has(error?.code) ? error.code : 'BROWSER_FAILED', closed: error?.closed === true,
          ...(page ? { page } : {}),
        }));
        const expired = error?.code === 'BROWSER_EXPIRED';
        const response = json({ success: false, code: expired ? 'VERIFICATION_EXPIRED' : 'BROWSER_UNAVAILABLE',
          message: expired ? '验证已过期，请重新解析。' : '页面读取暂时不可用，请稍后重试。' }, expired ? 410 : 503);
        if (error?.closed === true) {
          response.headers.set('X-Browser-Closed', '1');
          response.headers.set('X-Browser-Elapsed-Ms', String(Math.min(180000, Date.now() - started)));
        }
        return response;
      }
    }
    if (path !== '/api/parse' && path !== '/api/member_video' && !python) return json({ success: false, message: '接口不存在。' }, 404);
    try {
      if (path === '/api/member_video') {
        const accountFetch = this.env.ACCOUNT_RUNTIME
          ? nativeRequest => this.env.ACCOUNT_RUNTIME.get(this.env.ACCOUNT_RUNTIME.idFromName('accounts-v1')).fetch(nativeRequest)
          : nativeRequest => invokeHandler(createAccountHandler({ env: this.env }), nativeRequest, { maxBodyBytes: MAX_ACCOUNT_BODY_BYTES });
        return await invokeHandler(createHostedMemberVideoHandler({ env: this.env, accountFetch }), request);
      }
      const retained = request.clone();
      if (!python) return await maybeParseWithBrowser(retained, await invokeHandler(parse, request), { env: this.env, state: this.state });
      if (!this.env.PYTHON_API?.fetch) {
        return json({ success: false, engine: 'python', message: 'Python 服务暂时不可用，请稍后重试。' }, 503);
      }
      const body = await readBoundedBody(request, MAX_API_BODY_BYTES);
      const response = await this.env.PYTHON_API.fetch(new Request(request, {
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
      }));
      return await maybeParseWithBrowser(retained, response, { env: this.env, state: this.state });
    } catch (error) {
      const tooLarge = error instanceof RequestTooLargeError;
      return json({
        success: false, engine: python ? 'python' : 'node',
        message: tooLarge ? '请求内容过大。' : '服务暂时不可用，请稍后重试。',
      }, tooLarge ? 413 : 503);
    }
  }
}
