/* Public web navigation. Native clients keep their own navigation lifecycle. */
(() => {
  'use strict';
  if (!['http:', 'https:'].includes(location.protocol) || window.xhsDesktop || window.brclioPageContext) return;

  const pages = new Set(['index', 'live', 'download', 'product', 'membership', 'vip', 'learn', 'changelog', 'feedback']);
  const route = url => {
    if (url.origin !== location.origin) return null;
    const name = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.html$/, '') || 'index';
    return pages.has(name) ? name : null;
  };
  if (!route(new URL(location.href))) return;

  const cache = new Map(), pending = new Map(), sheets = new Map(), positions = new Map();
  const nativePush = history.pushState.bind(history), nativeReplace = history.replaceState.bind(history);
  const stateKey = '__brclioNavigation';
  const makeId = () => crypto.randomUUID();
  let active, initializing, sequence = 0, commitTail = Promise.resolve(), transition;
  let entryId = history.state?.[stateKey]?.id || makeId();
  const withState = (state, id) => ({ ...(state && typeof state === 'object' ? state : {}), [stateKey]: { id } });
  nativeReplace(withState(history.state, entryId), '', location.href);
  history.scrollRestoration = 'manual';
  const savePosition = () => {
    if (!active) return;
    const point = { x: scrollX, y: scrollY };
    active.scroll = point;
    positions.set(entryId, point);
  };
  // Page-specific filters and account links also update the URL. Keep their
  // state while retaining the entry identity needed for scroll restoration.
  history.replaceState = (state, unused, url) => {
    const id = history.state?.[stateKey]?.id || entryId;
    nativeReplace(withState(state, id), unused, url);
    if (active && route(new URL(location.href)) === active.name) active.url = location.href;
  };
  history.pushState = (state, unused, url) => {
    savePosition();
    entryId = makeId();
    nativePush(withState(state, entryId), unused, url);
    positions.set(entryId, { x: scrollX, y: scrollY });
    if (active && route(new URL(location.href)) === active.name) active.url = location.href;
  };

  function copyHtml(from, to) {
    for (const attr of [...to.attributes]) {
      if (attr.name !== 'data-site-navigating') to.removeAttribute(attr.name);
    }
    for (const attr of from.attributes) {
      if (attr.name !== 'data-site-navigating') to.setAttribute(attr.name, attr.value);
    }
  }

  function describe(doc, url) {
    const name = route(url), body = doc.body;
    body.dataset.sitePage = name;
    return {
      name, body, html: doc.documentElement.cloneNode(false), url: url.href,
      title: doc.title, description: doc.querySelector('meta[name="description"]')?.content || '',
      theme: doc.querySelector('meta[name="theme-color"]')?.content || '#fefcf6',
      styles: [], scripts: [], scriptIndex: 0, active: false, initialized: false, scroll: { x: 0, y: 0 },
    };
  }

  // A cached page owns its DOM even while detached. Async downloads and
  // dialogs must update that DOM, rather than an unrelated page with the same
  // IDs. Only the active page receives shared UI events.
  function context(page) {
    if (page.context) return page.context;
    const listeners = new WeakMap();
    const always = new Set(['pagehide', 'pageshow', 'brclio-account-update', 'brclio-orders-changed', 'bftcounter:update']);
    const listen = target => (type, callback, options) => {
      if (!callback) return;
      let registrations = listeners.get(callback);
      if (!registrations) listeners.set(callback, registrations = []);
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      let item = registrations.find(item => item.target === target && item.type === type && item.capture === capture);
      if (!item) {
        const wrapped = event => {
          if (!always.has(type) && (!page.active || (['popstate', 'hashchange'].includes(type) && route(new URL(location.href)) !== page.name))) return;
          if (typeof callback === 'function') callback.call(target === window ? page.context.window : page.context.document, event);
          else callback.handleEvent(event);
        };
        item = { target, type, capture, wrapped };
        registrations.push(item);
      }
      target.addEventListener(type, item.wrapped, options);
    };
    const unlisten = target => (type, callback, options) => {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const item = listeners.get(callback)?.find(item => item.target === target && item.type === type && item.capture === capture);
      if (item) target.removeEventListener(type, item.wrapped, options);
    };
    const bind = (target, key) => {
      const value = Reflect.get(target, key, target);
      // Keep native constructors intact, including their static methods such
      // as ClipboardItem.supports and URL.createObjectURL.
      if (typeof key === 'string' && /^[A-Z]/.test(key)) return value;
      return typeof value === 'function' ? value.bind(target) : value;
    };
    const scopedDocument = new Proxy(document, { get(target, key) {
      if (key === 'body') return page.body;
      if (key === 'documentElement') return page.active ? target.documentElement : page.html;
      if (key === 'defaultView') return page.context.window;
      if (key === 'activeElement' && !page.active) return null;
      if (key === 'querySelector' || key === 'querySelectorAll') return selector => page.body[key](selector);
      if (key === 'getElementById') return id => String(id) ? page.body.querySelector(`#${CSS.escape(String(id))}`) : null;
      if (key === 'addEventListener') return listen(target);
      if (key === 'removeEventListener') return unlisten(target);
      return bind(target, key);
    } });
    const scopedWindow = new Proxy(window, { get(target, key) {
      if (key === 'document') return scopedDocument;
      if (key === 'window' || key === 'self') return page.context.window;
      if (['scroll', 'scrollTo', 'scrollBy', 'focus'].includes(key)) return (...args) => { if (page.active) target[key](...args); };
      if (key === 'addEventListener') return listen(target);
      if (key === 'removeEventListener') return unlisten(target);
      return bind(target, key);
    } });
    page.context = { document: scopedDocument, window: scopedWindow };
    return page.context;
  }

  function initialPage() {
    if (active) return active;
    active = describe(document, new URL(location.href));
    active.active = true;
    cache.set(active.name, active);
    return active;
  }
  window.brclioPageContext = () => context(initializing || initialPage());

  function rememberStyles(page, doc, base, initial = false) {
    const ready = [];
    for (const original of doc.head.querySelectorAll('link[rel="stylesheet"], style')) {
      const href = original.tagName === 'LINK' ? new URL(original.getAttribute('href'), base).href : null;
      const media = original.getAttribute('media') || '';
      const key = href ? `${href}|${media}` : `${page.name}:${page.styles.length}`;
      let sheet = sheets.get(key);
      if (!sheet) {
        const node = initial ? original : document.importNode(original, true);
        sheet = { node, media };
        sheets.set(key, sheet);
        if (initial || !href) sheet.ready = Promise.resolve();
        else {
          node.href = href;
          node.media = 'not all';
          sheet.ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { sheet.failed = true; reject(new Error('页面样式加载超时')); }, 12000);
            node.onload = () => { clearTimeout(timer); resolve(); };
            node.onerror = () => { clearTimeout(timer); sheet.failed = true; reject(new Error('页面样式暂时无法加载')); };
          });
          // Font services are optional; a failed font request must not block
          // the local page or replace a readable system font with a blank view.
          if (new URL(href).origin !== location.origin) {
            void sheet.ready.catch(() => {});
            sheet.ready = Promise.resolve();
          }
          // Page themes precede the shared navigation in every public build.
          // Insert only new sheets there; moving a loaded <link> can reload it
          // and briefly remove its rules on a cache-control: no-store host.
          const shared = document.head.querySelector('link[href$="/site-navigation.css"], link[href$="/site-header.css"]');
          if (shared) shared.before(node);
          else document.head.append(node);
        }
        if (!initial && !href) {
          node.media = 'not all';
          const shared = document.head.querySelector('link[href$="/site-navigation.css"], link[href$="/site-header.css"]');
          if (shared) shared.before(node);
          else document.head.append(node);
        }
      }
      page.styles.push(sheet);
      ready.push(sheet.ready);
    }
    return Promise.all(ready);
  }

  function applyStyles(page) {
    const selected = new Set(page.styles);
    for (const sheet of sheets.values()) {
      sheet.node.media = selected.has(sheet) ? sheet.media : 'not all';
    }
  }

  async function prepare(url) {
    const name = route(url);
    if (cache.has(name)) return cache.get(name);
    if (pending.has(name)) return pending.get(name);
    const work = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const endpoint = new URL(name === 'index' ? '/' : `/${name}.html`, location.origin);
        const response = await fetch(endpoint, { signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || route(new URL(response.url)) !== name) throw new Error('页面暂时无法加载');
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (!doc.querySelector('.app-header') || !doc.querySelector('main')) throw new Error('页面内容不完整');
        const page = describe(doc, url);
        page.body = document.adoptNode(page.body);
        // Resolve relative resources before a clean URL or trailing slash can
        // change their meaning. Hash links remain local to the requested page.
        for (const node of page.body.querySelectorAll('[src], [href], [poster]')) {
          for (const attr of ['src', 'href', 'poster']) {
            const value = node.getAttribute(attr);
            if (value && !value.startsWith('#')) node.setAttribute(attr, new URL(value, response.url).href);
          }
        }
        page.scripts = [...doc.head.querySelectorAll('script'), ...page.body.querySelectorAll('script')]
          .filter(script => !script.src?.endsWith('/site-navigation.js') && (!script.type || ['module', 'text/javascript', 'application/javascript'].includes(script.type)))
          .map(script => ({ original: script, src: script.getAttribute('src') ? new URL(script.getAttribute('src'), response.url).href : '' }));
        // Warm the browser cache before committing a new DOM. Network errors
        // leave the current page usable and can be retried without a reload.
        await Promise.all([
          rememberStyles(page, doc, response.url),
          ...page.scripts.filter(script => script.src).map(async script => {
            const result = await fetch(script.src, { signal: controller.signal, credentials: 'same-origin' });
            if (!result.ok) throw new Error('页面交互暂时无法加载');
            await result.arrayBuffer();
          }),
        ]);
        cache.set(name, page);
        return page;
      } finally { clearTimeout(timer); }
    })();
    pending.set(name, work);
    try { return await work; }
    catch (error) {
      // Failed sheets must get a fresh request on retry.
      for (const [key, sheet] of sheets) if (sheet.failed) { sheet.node.remove(); sheets.delete(key); }
      throw error;
    } finally { pending.delete(name); }
  }

  async function initialize(page) {
    if (page.initialized) return;
    initializing = page;
    try {
      for (; page.scriptIndex < page.scripts.length; page.scriptIndex += 1) {
        const { original, src } = page.scripts[page.scriptIndex];
        const script = document.createElement('script');
        for (const attr of original.attributes) if (!['src', 'async', 'defer'].includes(attr.name)) script.setAttribute(attr.name, attr.value);
        script.async = false;
        const loaded = src ? new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = () => { script.remove(); reject(new Error('页面交互暂时无法加载')); };
        }) : Promise.resolve();
        if (src) script.src = src;
        else script.textContent = original.textContent;
        if (page.body.contains(original)) original.replaceWith(script);
        else document.head.append(script);
        await loaded;
      }
      page.initialized = true;
    } finally { initializing = null; }
  }

  function metadata(page) {
    document.title = page.title;
    for (const [name, value] of [['description', page.description], ['theme-color', page.theme]]) {
      let node = document.head.querySelector(`meta[name="${name}"]`);
      if (!node) { node = document.createElement('meta'); node.name = name; document.head.append(node); }
      node.content = value;
    }
  }
  function focusContent(url, point, focus, restoreScroll = false) {
    let target;
    try { target = url.hash && document.getElementById(decodeURIComponent(url.hash.slice(1))); } catch { /* Invalid anchors leave the page readable. */ }
    if (target && !restoreScroll) {
      const details = target.closest('details');
      if (details) details.open = true;
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
    } else window.scrollTo({ left: point?.x || 0, top: point?.y || 0, behavior: 'instant' });
    if (focus) {
      const content = target || document.querySelector('main');
      if (content) { if (!content.hasAttribute('tabindex')) content.tabIndex = -1; content.focus({ preventScroll: true }); }
    }
  }
  function showError(url) {
    document.querySelector('.site-navigation-error')?.remove();
    const message = document.createElement('div');
    message.className = 'site-navigation-error';
    message.setAttribute('role', 'status');
    message.append('页面暂时无法加载，当前内容已保留。');
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = '重试';
    retry.addEventListener('click', () => void navigate(url));
    message.append(retry);
    document.querySelector('.app-header').after(message);
  }

  async function navigate(url, options = {}) {
    const token = ++sequence;
    document.documentElement.dataset.siteNavigating = 'true';
    try {
      const page = await prepare(url);
      // A navigation tab resumes its cached filters/detail URL. Explicit query
      // links and history entries always use their own requested URL.
      if (!options.history && page !== active && !url.search && !url.hash && page.initialized) {
        url = new URL(url.href);
        url.search = new URL(page.url).search;
      }
      const commit = async () => {
        if (token !== sequence) return;
        const previous = active;
        const previousEntry = entryId, previousState = history.state, previousUrl = previous.url;
        savePosition();
        const restored = page.initialized;
        const point = options.history ? positions.get(options.entryId) : url.hash ? null : page.scroll;
        const update = async () => {
          document.querySelector('.site-navigation-error')?.remove();
          if (page !== previous) {
            window.dispatchEvent(new CustomEvent('brclio-page-leave'));
            for (const dialog of previous.body.querySelectorAll('dialog[open]')) dialog.close();
            for (const media of previous.body.querySelectorAll('video, audio')) media.pause();
            copyHtml(document.documentElement, previous.html);
            previous.active = false;
            active = page; page.active = true;
            copyHtml(page.html, document.documentElement);
            document.body.replaceWith(page.body);
            applyStyles(page);
          }
          if (options.history) entryId = options.entryId;
          else if (url.href !== location.href) {
            entryId = makeId();
            nativePush(withState(null, entryId), '', url.href);
          }
          metadata(page);
          page.url = url.href;
          await initialize(page);
          if (token !== sequence) return;
          page.url = location.href;
          window.dispatchEvent(new CustomEvent('brclio-page-enter', { detail: { url: url.href, restored, history: Boolean(options.history) } }));
          // Hooks can reveal a filtered release or open an account dialog.
          focusContent(new URL(location.href), point, !document.querySelector('dialog[open]'), Boolean(options.history && point));
          page.url = location.href;
          savePosition();
        };
        try {
          transition?.skipTransition();
          if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            transition = document.startViewTransition(update);
            // A failed script load is handled below; avoid an unhandled
            // rejection from the animation's separate completion promise.
            void transition.finished.catch(() => {});
            await transition.updateCallbackDone;
          } else await update();
        } catch (error) {
          transition?.skipTransition();
          copyHtml(document.documentElement, page.html);
          page.active = false;
          active = previous; previous.active = true;
          copyHtml(previous.html, document.documentElement);
          if (document.body !== previous.body) document.body.replaceWith(previous.body);
          applyStyles(previous); metadata(previous);
          entryId = previousEntry;
          nativeReplace(withState(previousState, entryId), '', previousUrl);
          focusContent(new URL(previousUrl), previous.scroll, false, true);
          window.dispatchEvent(new CustomEvent('brclio-page-enter', { detail: { url: previousUrl, restored: true, history: true } }));
          throw error;
        }
      };
      const work = commitTail.then(commit);
      commitTail = work.catch(() => {});
      await work;
    } catch {
      if (token === sequence) {
        // A failed back/forward fetch must not leave the address bar describing
        // content that never loaded. A retry still targets the requested URL.
        if (options.history) nativeReplace(withState(null, entryId), '', active.url);
        showError(url);
      }
    } finally {
      if (token === sequence) delete document.documentElement.dataset.siteNavigating;
    }
  }

  function eligible(event) {
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download') || link.hasAttribute('data-no-navigation') || (link.target && link.target !== '_self') || link.relList.contains('external')) return null;
    const url = new URL(link.href, location.href);
    return route(url) ? url : null;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const page = initialPage();
    page.initialized = true;
    void rememberStyles(page, document, location.href, true);
    savePosition();
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = eligible(event);
      if (!url) return;
      event.preventDefault();
      void navigate(url);
    });
    const prefetch = event => {
      if (navigator.connection?.saveData || ['slow-2g', '2g'].includes(navigator.connection?.effectiveType)) return;
      const url = eligible(event);
      if (url) void prepare(url).catch(() => {});
    };
    document.addEventListener('pointerover', prefetch, { passive: true });
    document.addEventListener('focusin', prefetch);
    window.addEventListener('scroll', savePosition, { passive: true });
    window.addEventListener('popstate', event => {
      const url = new URL(location.href);
      if (!route(url)) { location.reload(); return; }
      void navigate(url, { history: true, entryId: event.state?.[stateKey]?.id || makeId() });
    });
  }, { once: true });
})();
