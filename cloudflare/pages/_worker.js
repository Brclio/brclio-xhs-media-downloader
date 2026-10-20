// Pages accepts an external subdomain CNAME. All business logic stays in APP.
// _routes.json keeps ordinary static requests outside Functions invocation.
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/__internal/') || pathname === '/assets/membership/alipay.png' || pathname === '/assets/membership/wechat-pay.png') {
      return new Response(request.method === 'HEAD' ? null : 'Not Found', { status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/admin')) {
      // Forward the original Request and Response unchanged: signed JSON bytes,
      // host/origin, trusted IP, cookies, redirects and binary ranges must survive.
      return env.APP.fetch(request);
    }
    if (pathname === '/payment-return' || pathname === '/payment-return.html') {
      const response = await env.ASSETS.fetch(request), headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Referrer-Policy', 'no-referrer');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return env.ASSETS.fetch(request);
  },
};
