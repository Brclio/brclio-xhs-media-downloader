(() => {
  'use strict';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scenes = [...document.querySelectorAll('.story-scene')];
  const toggle = document.querySelector('.presentation-toggle');
  const controls = document.querySelector('.presentation-controls');
  const hint = document.querySelector('.presentation-hint');
  const status = document.querySelector('#presentation-status');
  const previous = document.querySelector('#scene-prev');
  const next = document.querySelector('#scene-next');
  const fullscreen = document.querySelector('#presentation-fullscreen');
  let presenting = false;
  let sceneIndex = 0;
  let scrollBeforePresentation = 0;
  let ownedFullscreen = false;

  // Keep content readable if JavaScript or IntersectionObserver is unavailable.
  if ('IntersectionObserver' in window && !reducedMotion.matches) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.remove('is-pending');
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.06 });
    document.querySelectorAll('.reveal').forEach(element => {
      element.classList.add('is-pending');
      observer.observe(element);
    });
    document.body.classList.add('js-ready');
  }

  const media = {
    photo: { index: '01 / ORIGINAL PHOTOS', title: ['清晰，', '本来就该如此。'], description: '保存无水印原图。单张下载，或勾选喜欢的图片一次打包，让每一处细节都经得起放大。', chips: ['无水印原图', '多图 ZIP 打包'], footnote: '桌面版还支持一次复制多张独立原图，粘贴到支持多文件的应用。', image: 'coast', alt: '蓝色海岸图片下载示意', label: '原图画质', icon: 'photo', caption: '让细节，留在画面里。', format: 'ORIGINAL' },
    video: { index: '02 / VIDEO DOWNLOAD', title: ['好风景，', '值得反复播放。'], description: '选择原笔记提供的可用清晰度，将视频保存为 MP4。喜欢的片段，留给下一次打开。', chips: ['可选清晰度', 'MP4 保存'], footnote: '具体清晰度由原笔记提供，下载器不会将低清视频提升为更高清晰度。', image: 'mountains', alt: '山野视频封面示意，无实际视频播放', label: '视频素材', icon: 'play', caption: '把这一刻，按下保存。', format: 'MP4' },
    live: { index: '03 / LIVE MOMENTS', title: ['一张照片，', '不止一个瞬间。'], description: '静态原图与配对动态片段，一起留下。下载 JPG + MP4 素材包，也可以单独保存实况视频。', chips: ['JPG + MP4', '配对素材 ZIP'], footnote: '保存的是实况配对素材，不会自动转为 Apple Photos 原生 Live Photo。', image: 'sunset', alt: '橙色日落实况素材示意，无实际视频播放', label: '实况素材', icon: 'live', caption: '风吹过的瞬间，也在。', format: 'JPG + MP4' },
    text: { index: '04 / WORDS THAT STAY', title: ['好看的画面，', '还有动人的文字。'], description: '标题和正文，一并收好。复制笔记文案，或在批量 ZIP 中附带文案.txt，让灵感有图，也有故事。', chips: ['标题与正文', '文案.txt'], footnote: '示例文字仅用于功能展示；保存内容以实际解析到的笔记为准。', image: 'coast', alt: '', label: '笔记文案', icon: 'text', caption: '图和故事，一起留下。', format: 'TXT' }
  };
  const tabs = [...document.querySelectorAll('[data-media]')];
  document.querySelector('.media-tabs').hidden = false;
  function selectMedia(key, focus = false) {
    const item = media[key];
    if (!item) return;
    tabs.forEach(tab => {
      const selected = tab.dataset.media === key;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    document.querySelector('#media-panel').setAttribute('aria-labelledby', `tab-${key}`);
    document.querySelector('#feature-index').textContent = item.index;
    document.querySelector('#feature-title').replaceChildren(document.createTextNode(item.title[0]), document.createElement('br'), document.createTextNode(item.title[1]));
    document.querySelector('#feature-description').textContent = item.description;
    document.querySelector('#feature-footnote').textContent = item.footnote;
    document.querySelector('#feature-chips').replaceChildren(...item.chips.map(text => {
      const chip = document.createElement('span');
      chip.textContent = text;
      return chip;
    }));
    const art = document.querySelector('.media-art');
    art.dataset.mediaArt = key;
    const image = document.querySelector('#feature-image');
    image.src = `./assets/product/${item.image}.svg`;
    image.alt = item.alt;
    const label = document.querySelector('#art-label');
    label.lastChild.textContent = ` ${item.label}`;
    label.querySelector('use').setAttribute('href', `#i-${item.icon}`);
    art.querySelector('.media-play use').setAttribute('href', key === 'live' ? '#i-live' : '#i-play');
    document.querySelector('#art-caption').textContent = item.caption;
    document.querySelector('#art-format').textContent = item.format;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectMedia(tab.dataset.media));
    tab.addEventListener('keydown', event => {
      let target;
      if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = tabs.length - 1;
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      selectMedia(tabs[target].dataset.media, true);
    });
  });

  let scrollScheduled = false;
  const updateProgress = () => {
    const range = document.documentElement.scrollHeight - window.innerHeight;
    document.querySelector('.reading-progress').style.transform = `scaleX(${range > 0 ? Math.min(1, Math.max(0, window.scrollY / range)) : 0})`;
    scrollScheduled = false;
  };
  window.addEventListener('scroll', () => {
    if (!scrollScheduled) {
      scrollScheduled = true;
      window.requestAnimationFrame(updateProgress);
    }
  }, { passive: true });
  window.addEventListener('resize', updateProgress);
  updateProgress();

  function showScene(index) {
    sceneIndex = Math.max(0, Math.min(scenes.length - 1, index));
    scenes.forEach((scene, i) => scene.classList.toggle('is-current-scene', i === sceneIndex));
    document.querySelector('#scene-number').textContent = String(sceneIndex + 1).padStart(2, '0');
    document.querySelector('#scene-label').textContent = scenes[sceneIndex].dataset.scene;
    previous.disabled = sceneIndex === 0;
    next.disabled = sceneIndex === scenes.length - 1;
    // Move focus out of the hidden scene. Space then advances consistently,
    // including at the final scene, rather than activating a previous button.
    const heading = scenes[sceneIndex].querySelector('h1, h2');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    status.textContent = `第 ${sceneIndex + 1} 幕，共 ${scenes.length} 幕：${scenes[sceneIndex].dataset.scene}`;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function setPresentation(enabled) {
    if (enabled === presenting) return;
    presenting = enabled;
    if (enabled) scrollBeforePresentation = window.scrollY;
    document.body.classList.toggle('is-presenting', enabled);
    controls.hidden = !enabled;
    hint.hidden = !enabled;
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.querySelector('span').textContent = enabled ? '退出演示' : '演示模式';
    if (enabled) {
      showScene(0);
    } else {
      scenes.forEach(scene => scene.classList.remove('is-current-scene'));
      status.textContent = '已退出演示模式';
      toggle.focus({ preventScroll: true });
      window.scrollTo({ top: scrollBeforePresentation, behavior: 'instant' });
      if (ownedFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      ownedFullscreen = false;
    }
    updateProgress();
  }
  toggle.hidden = false;
  toggle.setAttribute('aria-pressed', 'false');
  toggle.addEventListener('click', () => setPresentation(!presenting));
  previous.addEventListener('click', () => showScene(sceneIndex - 1));
  next.addEventListener('click', () => showScene(sceneIndex + 1));
  document.querySelector('#presentation-exit').addEventListener('click', () => setPresentation(false));
  fullscreen.hidden = !document.fullscreenEnabled;
  fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        ownedFullscreen = false;
      } else {
        await document.documentElement.requestFullscreen();
        ownedFullscreen = true;
      }
    } catch {
      status.textContent = '浏览器暂不支持全屏，你仍可继续使用演示模式。';
    }
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreen.setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '进入全屏');
  });
  document.addEventListener('keydown', event => {
    if (!presenting || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setPresentation(false);
      return;
    }
    const target = event.target instanceof Element ? event.target : document.body;
    if (target.closest('input,textarea,select,[contenteditable="true"],[role="tablist"]')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || (event.key === ' ' && !target.closest('a,button'))) {
      event.preventDefault();
      showScene(sceneIndex + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      showScene(sceneIndex - 1);
    }
  });
  if (new URLSearchParams(window.location.search).get('present') === '1') setPresentation(true);
})();
