/* CALIBR8 appearance, workspace navigation and accessible interface controls. */
(function () {
  'use strict';
  const root = document.documentElement;
  const titles = {
    overview: ['Live monitoring', 'A clear view of your vehicle, route and braking safety.'],
    fleet: ['Your fleet', 'Find a vehicle and choose what to monitor.'],
    events: ['Safety events', 'Review braking events for the selected vehicle and trip.'],
    insights: ['Models & physics', 'Understand the calculations behind each braking assessment.']
  };
  const storage = {
    read(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } },
    write(key, value) { try { localStorage.setItem(key, value); } catch {} }
  };
  let preference = storage.read('calibr8-theme', 'system');
  if (!['dark', 'light', 'system'].includes(preference)) preference = 'system';
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let activeView = 'overview', initialized = false, toastTimer, previousFocus = null;
  const $ = id => document.getElementById(id);
  function applyTheme(value, persist = true) {
    preference = ['light', 'dark', 'system'].includes(value) ? value : 'system';
    const theme = preference === 'system' ? (media ? (media.matches ? 'dark' : 'light') : (root.dataset.theme || 'dark')) : preference;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (persist) storage.write('calibr8-theme', preference);
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference)));
    if ($('browserThemeColor')) $('browserThemeColor').content = theme === 'dark' ? '#10151e' : '#f4f6f8';
    document.dispatchEvent(new CustomEvent('calibr8:themechange', {detail: {theme, preference}}));
  }
  function setSidebar(open) {
    $('sidebar')?.classList.toggle('open', open);
    $('sidebarScrim')?.classList.toggle('hidden', !open);
    $('menuToggle')?.setAttribute('aria-expanded', String(open));
    $('menuToggle')?.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  }
  function setView(view) {
    if (!titles[view]) return;
    activeView = view;
    document.querySelectorAll('[data-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.panel !== view));
    document.querySelectorAll('.nav-item[data-view]').forEach(button => {
      const current = button.dataset.view === view;
      button.classList.toggle('active', current);
      if (current) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $('pageTitle').textContent = titles[view][0];
    $('breadcrumbTitle').textContent = titles[view][0];
    $('pageDescription').textContent = titles[view][1];
    setSidebar(false);
    document.dispatchEvent(new CustomEvent('calibr8:viewchange', {detail: {view}}));
  }
  function toast(message) {
    const region = $('toastRegion');
    if (!region) return;
    clearTimeout(toastTimer);region.textContent = message;region.classList.add('visible');
    toastTimer = setTimeout(() => region.classList.remove('visible'), 4000);
  }
  function openConnections() {
    previousFocus = document.activeElement;
    $('apiManager').classList.remove('hidden');
    document.body.classList.add('modal-open');
    setSidebar(false);$('closeApiManagerBtn')?.focus();
  }
  function closeConnections() {
    $('apiManager').classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  function updateConnectionStatus() {
    const pill = document.querySelector('.connection-pill');
    if (!pill) return;
    const value = $('liveText')?.textContent || '';
    pill.dataset.status = /RECONNECT|PAUSED/.test(value) ? 'warning' : /LIVE/.test(value) ? 'live' : 'waiting';
  }
  function init() {
    if (initialized || !$('pageTitle')) return;
    initialized = true;applyTheme(preference, false);
    document.addEventListener('click', event => {
      const themeButton = event.target.closest('[data-theme-choice]');
      if (themeButton) { applyTheme(themeButton.dataset.themeChoice);return; }
      const viewButton = event.target.closest('[data-view]');
      if (viewButton) { event.preventDefault();setView(viewButton.dataset.view);return; }
      if (event.target.closest('[data-open-connections]')) $('manageApisBtn')?.click();
    });
    $('menuToggle')?.addEventListener('click', () => setSidebar(!$('sidebar').classList.contains('open')));
    $('sidebarScrim')?.addEventListener('click', () => setSidebar(false));
    $('modelSettingsToggle')?.addEventListener('click', () => {
      const open = $('modelSettings').classList.contains('hidden');
      $('modelSettings').classList.toggle('hidden', !open);
      $('modelSettingsToggle').setAttribute('aria-expanded', String(open));
    });
    $('passwordToggle')?.addEventListener('click', () => {
      const show = $('authPassword').type === 'password';
      $('authPassword').type = show ? 'text' : 'password';
      $('passwordToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      $('passwordToggle').setAttribute('aria-pressed', String(show));
    });
    $('copyPayloadBtn')?.addEventListener('click', async () => {
      const text = $('apiOutput')?.textContent || '';
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);toast('API payload copied.');
      } catch { toast('Select the payload text and copy it with Ctrl+C.'); }
    });
    $('apiManager')?.addEventListener('click', event => { if (event.target === $('apiManager')) closeConnections(); });
    document.addEventListener('keydown', event => {
      const modalOpen = !$('apiManager').classList.contains('hidden');
      if (event.key === 'Escape') {
        if (modalOpen) closeConnections();
        else {setSidebar(false);$('menuToggle')?.focus();}
      }
      if (event.key !== 'Tab' || !modalOpen) return;
      const focusable = [...$('apiManager').querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]')].filter(el => !el.disabled && !el.closest('.hidden') && el.type !== 'hidden' && el.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
    });
    const updateClock = () => {
      if ($('workspaceClock')) $('workspaceClock').textContent = new Date().toLocaleDateString(undefined, {day:'2-digit', month:'short', year:'numeric'});
    };
    updateClock();
    if ($('liveText') && typeof MutationObserver === 'function') new MutationObserver(updateConnectionStatus).observe($('liveText'), {childList:true, characterData:true, subtree:true});
    updateConnectionStatus();
  }
  if (media?.addEventListener) media.addEventListener('change', () => { if (preference === 'system') applyTheme('system', false); });
  window.addEventListener('storage', event => { if (event.key === 'calibr8-theme') applyTheme(event.newValue || 'system', false); });
  window.CALIBR8_UI = {init, setView, applyTheme, openConnections, closeConnections, toast, get theme(){return root.dataset.theme;}, get preference(){return preference;}, get view(){return activeView;}};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});else init();
})();
