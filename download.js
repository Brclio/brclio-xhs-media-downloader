// Static links remain usable without JavaScript or when GitHub is unavailable.
(() => {
  'use strict';

  const repository = 'Brclio/brclio-xhs-media-downloader';
  const releaseBase = `https://github.com/${repository}/releases`;
  const status = document.querySelector('#release-status');
  const fallbackVersion = document.querySelector('[data-release-version]').textContent;
  const assetSuffixes = {
    'mac-arm64': 'mac-arm64.dmg',
    'mac-x64': 'mac-x64.dmg',
    'windows-setup': 'windows-x64-setup.exe',
    'windows-portable': 'windows-x64-portable.exe',
  };

  const agent = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const mobile = /Android|iPhone|iPad|iPod/i.test(agent) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1);
  const family = mobile ? '' : /Mac/i.test(platform) ? 'mac' : /Win/i.test(platform) ? 'windows' : '';
  const platformHint = document.querySelector('#platform-hint');
  if (mobile) {
    platformHint.textContent = '你正在使用移动设备。请在 Mac 或 Windows 电脑上安装；手机可先使用网页版。';
  } else if (family === 'mac') {
    platformHint.textContent = '你正在使用 Mac。请在「关于本机」确认 Apple 或 Intel 芯片后选择，浏览器无法可靠判断芯片。';
  } else if (family === 'windows') {
    platformHint.textContent = '你正在使用 Windows，请确认是 64 位系统；也可选择下方便携版。';
  }
  if (family) {
    document.querySelectorAll(`[data-platform="${family}"]`).forEach(card => card.classList.add('is-platform'));
  }

  // Native details work without JS; deep links also open their target question.
  function openLinkedQuestion() {
    const question = document.getElementById(location.hash.slice(1));
    if (question?.tagName === 'DETAILS') question.open = true;
  }
  openLinkedQuestion();
  window.addEventListener('hashchange', openLinkedQuestion);

  function setStatus(message) {
    const link = document.createElement('a');
    link.href = `${releaseBase}/latest`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '查看最新发布 ↗';
    status.replaceChildren(document.createTextNode(message), link);
  }

  function compareVersions(left, right) {
    const a = left.replace(/^v/, '').split('.').map(Number);
    const b = right.replace(/^v/, '').split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }

  async function refreshRelease() {
    // Packaged desktop pages have a private protocol and restrictive CSP.
    if (!['http:', 'https:'].includes(location.protocol)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error('Release service unavailable');
      const release = await response.json();
      if (release.draft !== false || release.prerelease !== false || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
        throw new Error('Not a stable release');
      }
      const tag = release.tag_name;
      const version = tag.slice(1);
      if (compareVersions(tag, fallbackVersion) < 0) throw new Error('Outdated release response');
      const releaseURL = `${releaseBase}/tag/${tag}`;
      if (release.html_url !== releaseURL || !Array.isArray(release.assets)) throw new Error('Unexpected release');
      const published = new Date(release.published_at);
      if (!Number.isFinite(published.getTime())) throw new Error('Missing release date');

      // Promote a complete set atomically, never mixing versions or guessing URLs.
      const assets = Object.entries(assetSuffixes).map(([key, suffix]) => {
        const name = `Brclio-XHS-${version}-${suffix}`;
        const expectedURL = `${releaseBase}/download/${tag}/${name}`;
        const matches = release.assets.filter(item => item.name === name);
        const asset = matches[0];
        if (matches.length !== 1 || asset.state !== 'uploaded' || asset.browser_download_url !== expectedURL || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
          throw new Error('Incomplete release assets');
        }
        return { key, url: expectedURL, size: `${(asset.size / 1e6).toFixed(1)} MB` };
      });
      for (const asset of assets) {
        document.querySelector(`[data-asset="${asset.key}"]`).href = asset.url;
        document.querySelector(`[data-size="${asset.key}"]`).textContent = asset.size;
      }
      document.querySelectorAll('[data-release-version]').forEach(node => { node.textContent = tag; });
      document.querySelectorAll('[data-release-link]').forEach(node => { node.href = releaseURL; });
      const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(published).replaceAll('/', '.');
      document.querySelector('[data-release-date]').textContent = `发布于 ${date}`;
      setStatus(`已核对最新正式版 ${tag}，安装包由 GitHub Releases 提供。`);
    } catch {
      setStatus(`版本信息暂未刷新，仍可下载已发布的 ${fallbackVersion}。`);
    } finally {
      clearTimeout(timeout);
    }
  }

  void refreshRelease();
})();
