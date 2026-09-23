import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isAppUrl } from './protocol.js';
import { confirmMacUpdateStartup } from './mac-update-cleanup.js';

// The helper can still hold its lock while Launch Services returns, even after
// this process has acknowledged startup. Retry only that transient condition;
// every attempt repeats all journal, identity and signature checks unchanged.
export async function confirmMacUpdateStartupWithRetry(options, { signal } = {}, dependencies = {}) {
  const confirm = dependencies.confirm || confirmMacUpdateStartup;
  let result;
  for (let attempt = 0; attempt < 3 && !signal?.aborted; attempt++) {
    result = await confirm(options);
    if (attempt === 2 || !result.retained.some(item => item.code === 'MAC_UPDATE_LOCK_BUSY')) break;
    try { await delay(dependencies.retryDelayMs ?? 1000, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
  return result;
}

// This is only a scheduling hint. confirmMacUpdateStartup still validates the
// private journal, bundle identity, signature and lock before acknowledging or
// removing anything. Completed update history must not keep a startup watcher.
export async function hasPendingMacUpdate({ cacheDirectory, currentAppPath, currentVersion }) {
  const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!versionPattern.test(currentVersion || '')) return false;
  try {
    const current = await realpath(currentAppPath);
    for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^mac-install-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
      const filename = path.join(cacheDirectory, entry.name, 'install-result.json');
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.size > 16000) continue;
        const record = JSON.parse(await readFile(filename, 'utf8'));
        if (record.appId !== 'cn.bornforthis.xhs-downloader' || record.currentAppPath !== current
          || record.backupRemoved === true || !versionPattern.test(record.version || '')) continue;
        const version = record.version.split('.').map(Number), running = currentVersion.split('.').map(Number);
        const difference = version.findIndex((part, index) => part !== running[index]);
        if (difference !== -1 && version[difference] > running[difference]) continue;
        const modern = record.schemaVersion >= 2;
        if ((record.status === 'installed' && (modern || record.launchRequested === true))
          || (record.version === currentVersion && (modern
            ? ['launching', 'awaiting_startup', 'startup_unconfirmed', 'cleanup_pending'].includes(record.status)
            : record.status === 'launching'))
          || (record.startupConfirmed === true && ['cleaning', 'cleanup_failed'].includes(record.status))) return true;
      } catch { /* Ignore an incomplete or inaccessible journal. */ }
    }
  } catch { /* No update cache or installed bundle yet. */ }
  return false;
}

/** Observe the actual trusted renderer, including late initialization/reloads.
 * Checks run in the main frame and never manufacture the desktopReady flag.
 * No injected renderer listener or promise survives cancellation/navigation.
 */
export function waitForDesktopReady(window, { signal, timeoutMs = 120000, retryMs = 250 } = {}) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || signal?.aborted) return Promise.resolve(false);
  const contents = window.webContents;
  return new Promise(resolve => {
    let finished = false, checking = false, timer, generation = 0;
    const finish = ready => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      window.removeListener('closed', cancel);
      contents.removeListener('destroyed', cancel);
      contents.removeListener('did-start-navigation', navigating);
      signal?.removeEventListener('abort', cancel);
      resolve(ready);
    };
    const cancel = () => finish(false);
    const navigating = (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) generation++; };
    const schedule = () => { if (!finished) timer = setTimeout(check, retryMs); };
    const check = async () => {
      if (finished || checking) return;
      if (window.isDestroyed() || contents.isDestroyed() || signal?.aborted) { cancel(); return; }
      checking = true;
      try {
        const frame = contents.mainFrame, observedGeneration = generation;
        if (!contents.isLoadingMainFrame() && isAppUrl(frame.url)) {
          const ready = await frame.executeJavaScript("document.readyState === 'complete' && document.body?.dataset.desktopReady === 'true'");
          if (!finished && !contents.isDestroyed() && observedGeneration === generation
            && frame === contents.mainFrame && isAppUrl(frame.url) && ready === true) finish(true);
        }
      } catch { /* A navigation/crashed renderer may recover before the deadline. */ }
      finally { checking = false; schedule(); }
    };
    const deadline = setTimeout(cancel, timeoutMs);
    window.once('closed', cancel);
    contents.once('destroyed', cancel);
    contents.on('did-start-navigation', navigating);
    signal?.addEventListener('abort', cancel, { once: true });
    void check();
  });
}
