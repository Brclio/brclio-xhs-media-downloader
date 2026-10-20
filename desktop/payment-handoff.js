// Native payment navigation carries only an order hint. It never confirms payment.
export const PAYMENT_RETURN_SCHEME = 'brclio-xhs';
export const PAYMENT_RETURN_EVENT = 'desktop:payment-return';
const orderIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const checkoutOrigins = new Set(['https://pay.bornforthis.cn', 'https://paywc.bornforthis.cn']);
const replyError = (code, message) => ({ ok: false, error: { code, message } });

export function parsePaymentReturnUrl(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  try {
    const url = new URL(value), orderId = url.searchParams.get('order_id');
    if (!orderIdPattern.test(orderId || '') || value !== `${PAYMENT_RETURN_SCHEME}://payment-return?order_id=${orderId}`) return null;
    return { orderId };
  } catch { return null; }
}

export function paymentCheckoutUrl(value) {
  if (typeof value !== 'string' || value.length > 2081 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value), fragment = new URLSearchParams(url.hash.slice(1));
    if (!checkoutOrigins.has(url.origin) || url.username || url.password || url.search
      || !/^\/checkout\/[a-zA-Z0-9_-]+$/.test(url.pathname) || fragment.size !== 1
      || !fragment.get('token') || /[\s\u0000-\u001f\u007f]/u.test(fragment.get('token'))) return null;
    return url.href;
  } catch { return null; }
}

/** Await native OS acceptance and keep the original durable account/order binding. */
export function createPaymentCheckoutOpener({ openExternal, getAccountState, getPendingPayment, getSessionGeneration = () => undefined, timeoutMs = 15_000 }) {
  const opening = new Map();
  return function openPaymentCheckout(input) {
    const checkoutUrl = paymentCheckoutUrl(input?.checkoutUrl);
    const orderId = input?.orderId, expectedUserId = input?.expectedUserId;
    if (!checkoutUrl || !orderIdPattern.test(orderId || '') || typeof expectedUserId !== 'string' || !expectedUserId || expectedUserId.length > 256) {
      return Promise.resolve(replyError('PAYMENT_INVALID_CHECKOUT', '收银台地址或订单无效，请重新打开原订单。'));
    }
    const key = `${expectedUserId}:${orderId}`;
    if (opening.has(key)) return opening.get(key);
    let generation;
    const currentAccount = () => {
      const state = getAccountState();
      return state?.authenticated === true && state?.verified === true && state.account?.user?.id === expectedUserId && getSessionGeneration() === generation;
    };
    const work = (async () => {
      let browserRequested = false;
      try {
        generation = getSessionGeneration();
        if (!currentAccount()) return replyError('SESSION_CHANGED', '软件账号尚未核实或已切换，请切回原账号再继续付款。');
        const pending = await getPendingPayment();
        if (!currentAccount() || pending?.userId !== expectedUserId || pending.orderId !== orderId) {
          return replyError('SESSION_CHANGED', '原付款订单或软件账号已变化，请重新核实后继续。');
        }
        let timer;
        try {
          browserRequested = true;
          await Promise.race([
            Promise.resolve().then(() => openExternal(checkoutUrl, { activate: true })),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PAYMENT_BROWSER_TIMEOUT')), timeoutMs); }),
          ]);
        } finally { clearTimeout(timer); }
        return { ok: true };
      } catch {
        // OS errors can contain the full fragment credential. Never log or return them.
        return browserRequested
          ? replyError('PAYMENT_BROWSER_OPEN_FAILED', '无法确认浏览器已打开，请重试原订单，或复制收银台链接后打开。')
          : replyError('PAYMENT_ACCOUNT_UNVERIFIED', '无法读取原付款记录，请刷新软件账号后重试原订单。');
      }
    })();
    opening.set(key, work);
    void work.finally(() => { if (opening.get(key) === work) opening.delete(key); });
    return work;
  };
}

/** Queue launch hints until a trusted renderer has installed its listener. */
export function createPaymentReturnHandoff({ getWindow, now = Date.now }) {
  const pending = [], recent = new Map(), sent = new Set();
  let listening = false, disposed = false;
  function focus() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } catch { /* Window closed during handoff. */ }
  }
  function flush() {
    const win = getWindow();
    if (disposed || !listening || !win || win.isDestroyed()) return;
    for (const orderId of pending) {
      if (sent.has(orderId)) continue;
      try { win.webContents.send(PAYMENT_RETURN_EVENT, { orderId }); sent.add(orderId); }
      catch { listening = false; return; }
    }
  }
  function receiveUrl(value) {
    const hint = parsePaymentReturnUrl(value);
    if (disposed || !hint) return false;
    focus();
    const at = now(), prior = recent.get(hint.orderId);
    if (prior !== undefined && at - prior >= 0 && at - prior < 1500) return true;
    recent.delete(hint.orderId); recent.set(hint.orderId, at);
    if (recent.size > 64) recent.delete(recent.keys().next().value);
    if (!pending.includes(hint.orderId)) pending.push(hint.orderId);
    if (pending.length > 16) sent.delete(pending.shift());
    flush();
    return true;
  }
  return {
    receiveUrl,
    receiveArguments: argv => Array.isArray(argv) ? argv.reduce((count, value) => count + Number(receiveUrl(value)), 0) : 0,
    rendererReady() { if (!disposed) { listening = true; if (pending.length) focus(); flush(); } },
    rendererLoading() { listening = false; sent.clear(); },
    acknowledge(orderId) {
      if (disposed || !sent.has(orderId)) return false;
      sent.delete(orderId);
      const index = pending.indexOf(orderId);
      if (index !== -1) pending.splice(index, 1);
      return true;
    },
    dispose() { disposed = true; listening = false; pending.length = 0; recent.clear(); sent.clear(); },
  };
}

export function registerPaymentReturnProtocol(app) {
  // Development/test Electron must not replace the installed app's OS handler.
  if (!app.isPackaged) return false;
  try { return app.setAsDefaultProtocolClient(PAYMENT_RETURN_SCHEME); }
  catch { return false; }
}
