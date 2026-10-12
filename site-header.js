/* Progressive enhancement for the shared Brclio web navigation. */
(() => {
  const { document, window } = globalThis.brclioPageContext?.() ?? globalThis;
  const header = document.querySelector('.app-header');
  const toggle = header?.querySelector('#site-menu-toggle');
  const navigation = header?.querySelector('#site-navigation');
  if (!toggle || !navigation || window.xhsDesktop) return;

  const compact = window.matchMedia('(max-width: 1040px)');
  const groups = [...navigation.querySelectorAll('.nav-group')];
  const closeGroups = () => groups.forEach(group => { group.open = false; });
  const setMenu = (open, restoreFocus = false) => {
    header.classList.toggle('is-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '收起导航菜单' : '展开导航菜单');
    toggle.querySelector('.menu-label').textContent = open ? '收起' : '菜单';
    groups.forEach(group => { group.open = open && compact.matches; });
    if (restoreFocus) toggle.focus({ preventScroll: true });
  };

  groups.forEach(group => {
    const trigger = group.querySelector('summary');
    if (group.querySelector('[aria-current="page"]')) trigger.classList.add('is-current');
    group.addEventListener('toggle', () => {
      if (!group.open || compact.matches) return;
      groups.forEach(other => { if (other !== group) other.open = false; });
    });
    group.addEventListener('focusout', event => {
      if (!compact.matches && !group.contains(event.relatedTarget)) group.open = false;
    });
  });
  toggle.hidden = false;
  header.classList.add('navigation-ready');
  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  navigation.addEventListener('click', event => {
    if (event.target.closest('a')) setMenu(false);
  });
  document.addEventListener('click', event => {
    if (!header.contains(event.target)) setMenu(false);
    else if (!event.target.closest('.nav-group') && !compact.matches) closeGroups();
  });
  header.addEventListener('focusout', event => {
    if (!header.contains(event.relatedTarget)) setMenu(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const openGroup = groups.find(group => group.open);
    if (compact.matches && header.classList.contains('is-menu-open')) {
      event.preventDefault();
      setMenu(false, true);
    } else if (openGroup) {
      event.preventDefault();
      openGroup.open = false;
      openGroup.querySelector('summary').focus({ preventScroll: true });
    }
  });
  compact.addEventListener('change', () => setMenu(false));
  window.addEventListener('brclio-page-leave', () => setMenu(false));
})();
