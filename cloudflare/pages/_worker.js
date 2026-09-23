// Pages accepts an external subdomain CNAME. All business logic stays in APP.
// _routes.json keeps ordinary static requests outside Functions invocation.
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/') || pathname.startsWith('/admin')) {
      // Forward the original Request and Response unchanged: signed JSON bytes,
      // host/origin, trusted IP, cookies, redirects and binary ranges must survive.
      return env.APP.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
