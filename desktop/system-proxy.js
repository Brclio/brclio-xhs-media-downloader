import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const WINDOWS_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// Chromium resolves native manual proxies and PAC rules on all supported
// platforms. The native read also catches an enabled PAC whose update routes
// intentionally return DIRECT: the user's proxy choice still takes priority.
export function hasProxyRoute(route) {
  return typeof route === 'string' && route.split(';').some(value =>
    /^(?:PROXY|HTTPS|HTTP|SOCKS|SOCKS4|SOCKS5)\s+\S+/i.test(value.trim()));
}

export function macProxyConfigured(text) {
  return /(?:^|\n)\s*(?:HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable)\s*:\s*1\s*(?:\n|$)/.test(text);
}

export function windowsProxyConfigured(text) {
  const bytes = /\bDefaultConnectionSettings\s+REG_BINARY\s+([a-f\d]+)/i.exec(text)?.[1];
  // WinINET's connection flags are the little-endian DWORD at offset 8:
  // PROXY=2, AUTO_PROXY_URL=4, AUTO_DETECT=8, DIRECT=1. Discovery alone
  // is commonly enabled by default without a discovered proxy; Chromium's
  // resolved route detects an actually functioning WPAD proxy instead.
  if (bytes && bytes.length >= 24) return (Number.parseInt(bytes.slice(16, 18), 16) & 6) !== 0;
  return /\bProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(text)
    || /\bAutoConfigURL\s+REG_(?:SZ|EXPAND_SZ)\s+\S+/i.test(text);
}

export async function configuredSystemProxy({ platform = process.platform, exec = execute } = {}) {
  const read = async (file, args) => {
    try { return String((await exec(file, args, { windowsHide: true, timeout: 2500, maxBuffer: 65536 })).stdout || ''); }
    catch { return ''; } // An unavailable optional OS query is not an enabled proxy.
  };
  if (platform === 'darwin') return macProxyConfigured(await read('/usr/sbin/scutil', ['--proxy']));
  if (platform === 'win32') {
    const outputs = await Promise.all(['ProxyEnable', 'AutoConfigURL'].map(name =>
      read('reg.exe', ['query', WINDOWS_SETTINGS, '/v', name])));
    outputs.push(await read('reg.exe', ['query', `${WINDOWS_SETTINGS}\\Connections`, '/v', 'DefaultConnectionSettings']));
    return windowsProxyConfigured(outputs.join('\n'));
  }
  if (platform === 'linux') {
    const mode = (await read('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])).trim().replace(/^['"]|['"]$/g, '');
    return mode === 'manual' || mode === 'auto';
  }
  return false;
}

export function environmentProxy(env = process.env) {
  const value = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  const configured = !!(value || env.http_proxy || env.HTTP_PROXY);
  if (!value) return { configured, configuration: null };
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      return { configured, configuration: null };
    }
    const protocol = url.protocol === 'socks5h:' ? 'socks5:' : url.protocol;
    const port = url.port || (protocol === 'https:' ? '443' : protocol.startsWith('socks') ? '1080' : '80');
    const bypass = String(env.no_proxy || env.NO_PROXY || '').split(',').map(item => item.trim()).filter(Boolean).join(';');
    return { configured, configuration: { mode: 'fixed_servers', proxyRules: `${protocol}//${url.hostname}:${port}`,
      proxyBypassRules: ['127.0.0.1', '[::1]', 'localhost', bypass].filter(Boolean).join(';') } };
  } catch { return { configured, configuration: null }; }
}

export async function detectSystemProxy(session, origins, { platform = process.platform, env = process.env,
  configured = configuredSystemProxy, signal, timeoutMs = 5000 } = {}) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  const pendingSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const pending = promise => new Promise((resolve, reject) => {
    const abort = () => reject(pendingSignal.reason);
    if (pendingSignal.aborted) {
      void Promise.resolve(promise).catch(() => {});
      reject(pendingSignal.reason); return;
    }
    pendingSignal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => pendingSignal.removeEventListener('abort', abort));
  });
  try {
    await pending(session.setProxy({ mode: 'system' }));
    await pending(session.closeAllConnections());
    const results = await pending(Promise.allSettled([
      configured({ platform }),
      ...origins.map(origin => session.resolveProxy(origin))
    ]));
    signal?.throwIfAborted();
    const native = results[0].status === 'fulfilled' && results[0].value === true;
    const routes = results.slice(1);
    const routed = routes.some(result => result.status === 'fulfilled' && hasProxyRoute(result.value));
    // Unknown resolution keeps the OS transport; a failed PAC lookup must never
    // cause a second built-in proxy to start behind the user's existing proxy.
    const unknown = results.some(result => result.status === 'rejected');
    if (native || routed || unknown) return { enabled: true, source: unknown ? 'system-unknown' : 'system' };
    const environment = environmentProxy(env);
    if (environment.configured) {
      if (environment.configuration) {
        await pending(session.setProxy(environment.configuration));
        await pending(session.closeAllConnections());
      }
      return { enabled: true, source: 'environment' };
    }
    return { enabled: false, source: 'none' };
  } catch {
    signal?.throwIfAborted();
    return { enabled: true, source: 'system-unknown' };
  }
}
