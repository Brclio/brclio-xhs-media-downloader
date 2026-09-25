(() => {
  const controls = document.querySelector('.release-controls');
  const query = document.getElementById('release-query');
  const reset = document.getElementById('release-reset');
  const count = document.getElementById('release-result-count');
  const empty = document.querySelector('.release-empty');
  const feed = document.querySelector('.release-feed');
  const filters = [...document.querySelectorAll('[data-release-filter]')];
  const normalize = value => value.normalize('NFKC').toLowerCase();
  const entries = [...document.querySelectorAll('.release-entry')].map(element => ({
    element,
    platforms: element.dataset.releasePlatforms.split(' '),
    text: normalize(element.textContent),
    link: document.querySelector(`.release-index-nav a[href="#${element.id}"]`),
  }));
  if (!controls || !entries.length) return;
  let scope = 'all';

  function syncURL() {
    // Filtering also works in a packaged client or a local file preview.
    if (!['http:', 'https:'].includes(location.protocol)) return;
    const url = new URL(location.href);
    if (scope === 'all') url.searchParams.delete('scope');
    else url.searchParams.set('scope', scope);
    if (query.value.trim()) url.searchParams.set('q', query.value.trim());
    else url.searchParams.delete('q');
    // A previous anchor must not undo a newly chosen filter on reload.
    try {
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (target?.closest('.release-entry')?.hidden) url.hash = '';
    } catch { /* Malformed anchors do not affect filtering. */ }
    history.replaceState(null, '', url);
  }

  function matches(text, term) {
    // An exact version query must not confuse v1.8.1 with v1.8.13.
    if (/^v?\d+\.\d+(?:\.\d+)?$/.test(term)) {
      const version = term.replace(/^v/, '').replaceAll('.', '\\.');
      return new RegExp(`(?:^|[^\\d.])v?${version}(?![\\d.])`).test(text);
    }
    return text.includes(term);
  }

  function render(updateURL = true) {
    const terms = normalize(query.value.trim()).split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const entry of entries) {
      const shown = (scope === 'all' || entry.platforms.includes(scope))
        && terms.every(term => matches(entry.text, term));
      entry.element.hidden = !shown;
      if (entry.link) entry.link.hidden = !shown;
      visible += Number(shown);
    }
    for (const button of filters) {
      button.setAttribute('aria-pressed', String(button.dataset.releaseFilter === scope));
    }
    const label = { all: '全部更新', web: '网页版', desktop: '客户端' }[scope];
    count.textContent = `${label} · 显示 ${visible} / ${entries.length} 条记录${terms.length ? ' · 已应用搜索' : ''}`;
    empty.hidden = visible !== 0;
    feed.classList.toggle('is-empty', visible === 0);
    reset.disabled = scope === 'all' && !query.value;
    if (updateURL) syncURL();
  }

  function revealHash() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    const entry = target?.closest('.release-entry');
    if (!entry) return;
    if (entry.hidden) {
      scope = 'all';
      query.value = '';
      render();
    }
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'instant' }));
  }

  function readURL() {
    const params = new URLSearchParams(location.search);
    scope = ['web', 'desktop'].includes(params.get('scope')) ? params.get('scope') : 'all';
    query.value = params.get('q') || '';
    render(false);
    revealHash();
  }

  for (const button of filters) {
    button.addEventListener('click', () => {
      scope = button.dataset.releaseFilter;
      render();
    });
  }
  query.addEventListener('input', () => render());
  reset.addEventListener('click', () => {
    scope = 'all';
    query.value = '';
    render();
    query.focus();
  });
  window.addEventListener('hashchange', revealHash);
  document.addEventListener('click', event => {
    // Reopening the same anchor does not fire hashchange in packaged pages.
    const link = event.target.closest('a[href^="#"]');
    if (link?.getAttribute('href') === location.hash) revealHash();
  });
  window.addEventListener('popstate', readURL);
  controls.hidden = false;
  readURL();
})();
