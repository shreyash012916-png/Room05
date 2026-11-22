'use strict';
(() => {
  const TERMS_VERSION = '1.0';
  const PRIVACY_VERSION = '1.1';
  const CONSENT_KEY = 'room05-legal-consent';
  const $ = (id) => document.getElementById(id);
  const legalOverlay = $('legal-gate');
  const authOverlay = $('auth-gate');
  const legalCheck = $('legal-agree');
  const legalContinue = $('legal-continue');
  const authForm = $('auth-form');
  const authError = $('auth-error');
  const authMessage = $('auth-message');
  const confirmWrap = $('auth-confirm-wrap');
  const confirmInput = $('auth-confirm');
  const submitButton = $('auth-submit');
  const usernameInput = $('auth-username');
  const passwordInput = $('auth-password');
  const accountChip = $('account-chip');
  let mode = 'login';
  let currentUser = null;
  let busy = false;
  let controls;
  let profileButton;
  let profileMenu;
  let logoutButton;
  let fullscreenButton;
  let profileAvatar;
  let fullscreenIcon;

  function svgIcon(markup) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = markup;
    return svg;
  }

  function isVisible(element) {
    return !!(element && element.getClientRects && element.getClientRects().length);
  }

  function findCameraControl() {
    const clickableSelector = 'button, a, [role="button"], [tabindex]:not([tabindex="-1"])';
    const candidates = Array.from(document.querySelectorAll(
      `${clickableSelector}, [class*="camera" i], [id*="camera" i], [data-action*="camera" i], [data-icon*="camera" i]`
    ));
    const controlsFound = new Set();

    candidates.forEach((candidate) => {
      const description = [
        candidate.id,
        candidate.className && (typeof candidate.className === 'string' ? candidate.className : ''),
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('title'),
        candidate.getAttribute('data-action'),
        candidate.getAttribute('data-icon'),
        candidate.textContent
      ].join(' ').toLowerCase();
      if (!description.includes('camera')) return;
      const clickable = candidate.matches(clickableSelector)
        ? candidate
        : candidate.closest(clickableSelector);
      if (clickable && isVisible(clickable)) controlsFound.add(clickable);
    });

    return Array.from(controlsFound).sort((a, b) =>
      a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
      a.getBoundingClientRect().left - b.getBoundingClientRect().left
    )[0] || null;
  }

  function findToolbarHost(cameraControl) {
    if (cameraControl) {
      const namedToolbar = cameraControl.closest(
        '[role="toolbar"], [class*="toolbar" i], [id*="toolbar" i], [class*="tool-group" i], [class*="action-bar" i], [class*="control-group" i]'
      );
      if (namedToolbar) return { host: namedToolbar, cameraControl };

      let ancestor = cameraControl.parentElement;
      for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        const interactiveCount = ancestor.querySelectorAll('button, a, [role="button"]').length;
        if (interactiveCount >= 2 && (style.display === 'flex' || style.display === 'inline-flex' || style.display === 'grid')) {
          return { host: ancestor, cameraControl };
        }
      }

      if (cameraControl.parentElement) return { host: cameraControl.parentElement, cameraControl };
    }

    const fallbackSelectors = [
      '[role="toolbar"]',
      'header nav',
      'header',
      'nav',
      '[class*="toolbar" i]',
      '[class*="topbar" i]',
      '[class*="top-bar" i]',
      '[class*="action-bar" i]',
      '[class*="controls-bar" i]'
    ];
    const fallbacks = fallbackSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const host = fallbacks
      .filter((element) => isVisible(element) && element.querySelector('button, a, [role="button"]'))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (host) return { host, cameraControl: null };

    const appRoot = document.querySelector('main, #app, #root, .app, .site-shell');
    if (appRoot) return { host: appRoot, cameraControl: null, fallback: true };
    return { host: document.body, cameraControl: null, fallback: true };
  }

  function directChildWithin(ancestor, descendant) {
    let child = descendant;
    while (child && child.parentElement && child.parentElement !== ancestor) child = child.parentElement;
    return child && child.parentElement === ancestor ? child : null;
  }

  function insertControlsIntoToolbar() {
    const cameraControl = findCameraControl();
    const target = findToolbarHost(cameraControl);
    const host = target.host;
    if (!host) return;

    if (target.fallback) controls.classList.add('room05-controls-fallback');
    const reference = target.cameraControl ? directChildWithin(host, target.cameraControl) : null;
    host.insertBefore(controls, reference);
  }

  /* The two compact actions join the existing camera/tool control group; they are not fixed overlays. */
  function createTopControls() {
    controls = document.createElement('div');
    controls.id = 'room05-top-controls';
    controls.className = 'room05-top-controls';
    controls.setAttribute('aria-label', 'Page and account controls');

    const profile = document.createElement('div');
    profile.className = 'room05-profile';

    profileButton = document.createElement('button');
    profileButton.id = 'room05-profile-button';
    profileButton.className = 'room05-toolbar-action room05-profile-button';
    profileButton.type = 'button';
    profileButton.hidden = true;
    profileButton.setAttribute('aria-haspopup', 'dialog');
    profileButton.setAttribute('aria-expanded', 'false');
    profileButton.setAttribute('aria-label', 'Open profile menu');
    profileButton.title = 'Profile';

    profileAvatar = document.createElement('span');
    profileAvatar.className = 'room05-profile-avatar';
    profileAvatar.id = 'room05-profile-avatar';
    profileAvatar.setAttribute('aria-hidden', 'true');
    profileAvatar.textContent = 'U';
    profileButton.appendChild(profileAvatar);

    profileMenu = document.createElement('section');
    profileMenu.id = 'room05-profile-menu';
    profileMenu.className = 'room05-profile-menu';
    profileMenu.hidden = true;
    profileMenu.setAttribute('role', 'dialog');
    profileMenu.setAttribute('aria-label', 'Profile');

    const menuKicker = document.createElement('div');
    menuKicker.className = 'room05-profile-kicker';
    menuKicker.textContent = 'ACCOUNT';

    const username = document.createElement('div');
    username.id = 'room05-profile-username';
    username.className = 'room05-profile-username';

    const idBadge = document.createElement('div');
    idBadge.className = 'room05-id-badge';
    const idLabel = document.createElement('span');
    idLabel.textContent = 'ROOM/05 USER ID';
    const idValue = document.createElement('strong');
    idValue.id = 'room05-profile-user-id';
    idBadge.append(idLabel, idValue);

    logoutButton = document.createElement('button');
    logoutButton.id = 'room05-profile-logout';
    logoutButton.className = 'room05-profile-logout';
    logoutButton.type = 'button';
    logoutButton.textContent = 'LOG OUT';

    profileMenu.append(menuKicker, username, idBadge, logoutButton);
    profile.append(profileButton, profileMenu);

    fullscreenButton = document.createElement('button');
    fullscreenButton.id = 'room05-fullscreen-button';
    fullscreenButton.className = 'room05-toolbar-action room05-fullscreen-button';
    fullscreenButton.type = 'button';
    fullscreenButton.setAttribute('aria-label', 'Enter fullscreen');
    fullscreenButton.title = 'Enter fullscreen';
    fullscreenIcon = svgIcon(
      '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/>'
    );
    fullscreenButton.appendChild(fullscreenIcon);

    /* Profile is deliberately first (left); fullscreen is a small icon beside it. */
    controls.append(profile, fullscreenButton);
    insertControlsIntoToolbar();

    fullscreenButton.addEventListener('click', toggleFullscreen);
    profileButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setProfileMenuOpen(profileMenu.hidden);
    });
    logoutButton.addEventListener('click', logout);

    document.addEventListener('pointerdown', (event) => {
      if (!controls.contains(event.target)) setProfileMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setProfileMenuOpen(false);
    });
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
    updateFullscreenButton();
  }

  function setProfileMenuOpen(open) {
    if (!profileMenu || !profileButton) return;
    profileMenu.hidden = !open;
    profileButton.setAttribute('aria-expanded', String(open));
    profileButton.classList.toggle('is-open', open);
    if (open) {
      const bounds = profileButton.getBoundingClientRect();
      const shouldAlignRight = bounds.left + 290 > window.innerWidth - 12;
      profileMenu.classList.toggle('align-right', shouldAlignRight);
    }
  }

  function updateFullscreenButton() {
    if (!fullscreenButton || !fullscreenIcon) return;
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
    fullscreenButton.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    fullscreenButton.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
    fullscreenIcon.innerHTML = active
      ? '<path d="M8 3v5H3"/><path d="M3 8l6-5"/><path d="M16 3v5h5"/><path d="M21 8l-6-5"/><path d="M3 16l6 5"/><path d="M3 16h5v5"/><path d="M21 16l-6 5"/><path d="M21 16h-5v5"/>'
      : '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/>';
  }

  async function toggleFullscreen() {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
    try {
      if (active) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } else {
        const root = document.documentElement;
        const enter = root.requestFullscreen || root.webkitRequestFullscreen;
        if (enter) await enter.call(root);
        else fullscreenButton.title = 'Fullscreen is not supported by this browser';
      }
    } catch (error) {
      console.warn('Fullscreen could not be changed:', error);
    }
    updateFullscreenButton();
  }

  function consentIsCurrent() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
      return !!saved && saved.terms === TERMS_VERSION && saved.privacy === PRIVACY_VERSION;
    } catch (_) { return false; }
  }

  function setConsent() {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ terms: TERMS_VERSION, privacy: PRIVACY_VERSION, acceptedAt: new Date().toISOString() })); }
    catch (_) { /* The current visit can continue; the notice may reappear next time. */ }
  }

  function setMode(next) {
    mode = next === 'register' ? 'register' : 'login';
    $('auth-login-tab').setAttribute('aria-pressed', String(mode === 'login'));
    $('auth-register-tab').setAttribute('aria-pressed', String(mode === 'register'));
    $('auth-heading').textContent = mode === 'login' ? 'Welcome back.' : 'Make an account.';
    $('auth-description').textContent = mode === 'login'
      ? 'Sign in with your username and password to get back to your people.'
      : 'Choose a username and create a password. ROOM/05 will generate your permanent user ID.';
    $('auth-submit-label').textContent = mode === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
    confirmWrap.classList.toggle('hidden', mode !== 'register');
    confirmInput.required = mode === 'register';
    passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    authError.textContent = '';
    authMessage.textContent = mode === 'register'
      ? 'Use at least 8 characters. No email or external account is required.'
      : 'Your password is checked by ROOM/05. It is never shown to other users.';
    $('auth-success').classList.add('hidden');
  }

  function showAccount(user) {
    currentUser = user;
    authOverlay.classList.add('hidden');
    legalOverlay.classList.add('hidden');

    // Keep the legacy chip hidden; the new profile menu replaces its always-visible logout action.
    if (accountChip) accountChip.classList.remove('visible');
    if ($('account-identity')) {
      $('account-identity').textContent = `USER ID ${user.userId}`;
      $('account-identity').title = `${user.username} · ${user.userId}`;
    }
    if ($('display-name')) $('display-name').value = user.username;

    $('room05-profile-username').textContent = user.username;
    $('room05-profile-user-id').textContent = user.userId;
    $('room05-profile-avatar').textContent = String(user.username || 'U').trim().charAt(0).toUpperCase() || 'U';
    profileButton.hidden = false;
    profileButton.setAttribute('aria-label', `Open profile menu for ${user.username}`);
    setProfileMenuOpen(false);
    document.dispatchEvent(new CustomEvent('room05:authenticated', { detail: user }));
  }

  function showAuth(message) {
    authOverlay.classList.remove('hidden');
    legalOverlay.classList.add('hidden');
    if (accountChip) accountChip.classList.remove('visible');
    if (profileButton) profileButton.hidden = true;
    setProfileMenuOpen(false);
    authError.textContent = message || '';
    usernameInput.focus();
  }

  async function api(path, data) {
    const response = await fetch(path, {
      method: data ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: data ? { 'Content-Type': 'application/json' } : undefined,
      body: data ? JSON.stringify(data) : undefined
    });
    let result;
    try { result = await response.json(); } catch (_) { result = {}; }
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }

  async function finishConsentAndContinue() {
    legalOverlay.classList.add('hidden');
    authOverlay.classList.remove('hidden');
    authError.textContent = '';
    try {
      const result = await api('/api/me');
      if (result.user) {
        try { await api('/api/legal/accept', { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION }); }
        catch (error) { console.warn('Could not update legal acceptance:', error.message); }
        showAccount(result.user);
        return;
      }
    } catch (_) { /* No valid login yet; show sign-in. */ }
    showAuth('');
  }

  async function logout() {
    if (logoutButton) logoutButton.disabled = true;
    try { await api('/api/logout', {}); } catch (_) {}
    try { localStorage.removeItem(CONSENT_KEY); } catch (_) {}
    currentUser = null;
    window.location.href = '/';
  }

  legalCheck.addEventListener('change', () => { legalContinue.disabled = !legalCheck.checked; });
  legalContinue.addEventListener('click', async () => {
    if (!legalCheck.checked) return;
    legalContinue.disabled = true;
    setConsent();
    await finishConsentAndContinue();
  });

  $('auth-login-tab').addEventListener('click', () => setMode('login'));
  $('auth-register-tab').addEventListener('click', () => setMode('register'));

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    authError.textContent = '';
    $('auth-success').classList.add('hidden');
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (mode === 'register' && password !== confirmInput.value) {
      authError.textContent = 'Those passwords do not match.';
      confirmInput.focus();
      return;
    }
    busy = true;
    submitButton.disabled = true;
    $('auth-submit-label').textContent = mode === 'login' ? 'CHECKING…' : 'CREATING…';
    try {
      const payload = {
        username,
        password,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        termsAccepted: true,
        privacyAccepted: true
      };
      const result = await api(mode === 'register' ? '/api/register' : '/api/login', payload);
      passwordInput.value = '';
      confirmInput.value = '';
      showAccount(result.user);
      if (result.created) {
        const success = $('auth-success');
        success.textContent = `Your account is ready. Your permanent ROOM/05 ID is ${result.user.userId}. Keep your password safe; password recovery is not available.`;
        success.classList.remove('hidden');
      }
    } catch (error) {
      authError.textContent = error.message || 'Could not sign in. Please try again.';
    } finally {
      busy = false;
      submitButton.disabled = false;
      $('auth-submit-label').textContent = mode === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
    }
  });

  async function bootstrap() {
    createTopControls();
    setMode('login');
    if (!consentIsCurrent()) {
      legalOverlay.classList.remove('hidden');
      authOverlay.classList.add('hidden');
      return;
    }
    // A stored consent marker only belongs to the currently signed-in browser user.
    // If there is no valid account session, ask for consent before the next sign-in.
    try {
      const result = await api('/api/me');
      if (result.user) {
        try { await api('/api/legal/accept', { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION }); }
        catch (error) { console.warn('Could not refresh legal acceptance:', error.message); }
        showAccount(result.user);
        return;
      }
    } catch (_) { /* Fail closed and show the agreement before login. */ }
    try { localStorage.removeItem(CONSENT_KEY); } catch (_) {}
    legalOverlay.classList.remove('hidden');
    authOverlay.classList.add('hidden');
  }

  window.ROOM05_AUTH = {
    get user() { return currentUser; },
    logout
  };
  bootstrap();
})();
