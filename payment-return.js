const PRODUCT_ORIGIN = 'https://xhs.download.brclio.com';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** This is an untrusted order reference, never evidence of payment or a session. */
export function paymentReturnContext(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  const values = url.searchParams.getAll('payment_order');
  if (values.length !== 1 || !UUID.test(values[0])) return null;
  const orderId = values[0], web = new URL('/', PRODUCT_ORIGIN);
  web.searchParams.set('payment_order', orderId);
  web.searchParams.set('account', 'open');
  return { orderId, desktopUrl: `brclio-xhs://payment-return?order_id=${orderId}`, webUrl: web.href,
    autoOpen: url.origin === PRODUCT_ORIGIN && !url.username && !url.password && ['/payment-return', '/payment-return.html'].includes(url.pathname)
      && url.searchParams.getAll('client').length === 1 && url.searchParams.get('client') === 'desktop' };
}

export function initializePaymentReturn({ windowImpl = globalThis.window, documentImpl = globalThis.document,
  navigate, setTimer = setTimeout } = {}) {
  const context = paymentReturnContext(windowImpl.location.href);
  const open = documentImpl.getElementById('return-open-client'), web = documentImpl.getElementById('return-view-web');
  const title = documentImpl.getElementById('return-title'), description = documentImpl.getElementById('return-description');
  const status = documentImpl.getElementById('return-status');
  if (!context) {
    title.textContent = '返回账号，核实订单';
    description.textContent = '暂时无法识别这个订单。请切回下单时的客户端，或在网页登录原账号查看。';
    open.hidden = true;
    web.href = `${PRODUCT_ORIGIN}/?account=open`;
    return;
  }
  open.href = context.desktopUrl; open.hidden = false;
  web.href = context.webUrl;
  open.addEventListener('click', () => { status.textContent = '请在客户端核实订单与会员状态。若未打开，也可以手动切回客户端。'; });
  if (context.autoOpen && windowImpl.top === windowImpl.self) {
    title.textContent = '回到客户端，核实付款';
    description.textContent = '无需在浏览器登录，客户端会用原账号核实付款与会员状态。';
    status.textContent = '正在尝试打开客户端。若未打开，请点击上方按钮，或手动切回客户端。';
    setTimer(() => {
      try { (navigate || (url => windowImpl.location.assign(url)))(context.desktopUrl); }
      catch { status.textContent = '浏览器未能打开客户端，请点击上方按钮，或手动切回客户端查看。'; }
    }, 150);
  } else {
    title.textContent = '返回原账号，查看订单';
    description.textContent = '请在下单时使用的客户端或网页账号中，核实付款与会员状态。';
  }
}

if (globalThis.window?.document) initializePaymentReturn();
