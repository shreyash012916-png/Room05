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
  const profileControls = [];

  function consentIsCurrent() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
      return !!saved && saved.terms === TERMS_VERSION && saved.privacy === PRIVACY_VERSION;
    } catch (_) {
      return false;
    }
  }

  function setConsent() {
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify({
        terms: TERMS_VERSION,
        privacy: PRIVACY_VERSION,
        acceptedAt: new Date().toISOString()
      }));
    } catch (_) {
      // The current visit can continue; the notice may reappear next time.
    }
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function setProfileMenusOpen(open, except) {
    profileControls.forEach((control) => {
      const shouldOpen = !!open && control === except && !control.wrapper.hidden;
      control.menu.hidden = !shouldOpen;
      control.button.setAttribute('aria-expanded', String(shouldOpen));
      if (shouldOpen) control.button.classList.add('is-open');
      else control.button.classList.remove('is-open');
    });
  }

  function createProfileControl(host, beforeSelector, menuNumber) {
    if (!host) return;

    const wrapper = makeElement('div', 'room05-profile');
    wrapper.hidden = true;

    const button = makeElement('button', 'square-action room05-profile-button');
    button.type = 'button';
    button.title = 'Profile';
    button.setAttribute('aria-label', 'Open profile menu');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');

    const avatar = makeElement('span', 'room05-profile-avatar', 'U');
    avatar.setAttribute('aria-hidden', 'true');
    button.appendChild(avatar);

    const menu = makeElement('section', 'room05-profile-menu');
    menu.id = `room05-profile-menu-${menuNumber}`;
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'ROOM/05 account menu');
    button.setAttribute('aria-controls', menu.id);

    const kicker = makeElement('div', 'room05-profile-kicker', 'ACCOUNT');
    const name = makeElement('div', 'room05-profile-username');
    const idBadge = makeElement('div', 'room05-id-badge');
    const idLabel = makeElement('span', '', 'ROOM/05 USER ID');
    const idValue = makeElement('strong', '', '');
    idBadge.append(idLabel, idValue);

    const legalLinks = makeElement('div', 'room05-profile-links');
    const termsLink = makeElement('a', 'room05-profile-link', 'TERMS & CONDITIONS');
    termsLink.href = '/terms.html';
    termsLink.target = '_blank';
    termsLink.rel = 'noopener';
    termsLink.appendChild(makeElement('span', '', '↗'));
    const privacyLink = makeElement('a', 'room05-profile-link', 'PRIVACY POLICY');
    privacyLink.href = '/privacy.html';
    privacyLink.target = '_blank';
    privacyLink.rel = 'noopener';
    privacyLink.appendChild(makeElement('span', '', '↗'));
    legalLinks.append(termsLink, privacyLink);

    const logout = makeElement('button', 'room05-profile-logout', 'LOG OUT');
    logout.type = 'button';

    menu.append(kicker, name, idBadge, legalLinks, logout);
    wrapper.append(button, menu);

    const reference = host.querySelector(beforeSelector);
    if (reference) host.insertBefore(wrapper, reference);
    else host.appendChild(wrapper);

    const control = { wrapper, button, avatar, menu, name, idValue, logout };
    profileControls.push(control);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const shouldOpen = menu.hidden;
      setProfileMenusOpen(false);
      setProfileMenusOpen(shouldOpen, control);
    });
    logout.addEventListener('click', logoutFromProfile);
  }

  function createProfileControls() {
    // These are the real page toolbars. Do not search for camera controls: the
    // camera button lives in the bottom call dock and must never be used as a host.
    createProfileControl(document.querySelector('.header-tools'), '.mode-toggle', 1);
    createProfileControl(document.querySelector('.call-top-actions'), '#snap-photo', 2);

    document.addEventListener('pointerdown', (event) => {
      if (!profileControls.some((control) => control.wrapper.contains(event.target))) {
        setProfileMenusOpen(false);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setProfileMenusOpen(false);
    });
  }

  function updateProfileControls(user) {
    profileControls.forEach((control) => {
      control.name.textContent = user.username || 'ROOM/05 member';
      control.idValue.textContent = user.userId || '';
      control.avatar.textContent = String(user.username || 'U').trim().charAt(0).toUpperCase() || 'U';
      control.button.setAttribute('aria-label', `Open profile menu for ${user.username || 'your account'}`);
      control.wrapper.hidden = false;
    });
    setProfileMenusOpen(false);
  }

  function hideProfileControls() {
    profileControls.forEach((control) => {
      control.wrapper.hidden = true;
      control.menu.hidden = true;
      control.button.setAttribute('aria-expanded', 'false');
      control.button.classList.remove('is-open');
    });
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
    if (accountChip) accountChip.classList.remove('visible');
    if ($('account-identity')) {
      $('account-identity').textContent = `USER ID ${user.userId}`;
      $('account-identity').title = `${user.username} · ${user.userId}`;
    }
    if ($('display-name')) $('display-name').value = user.username;
    updateProfileControls(user);
    document.dispatchEvent(new CustomEvent('room05:authenticated', { detail: user }));
  }

  function showAuth(message) {
    authOverlay.classList.remove('hidden');
    legalOverlay.classList.add('hidden');
    if (accountChip) accountChip.classList.remove('visible');
    hideProfileControls();
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
        try {
          await api('/api/legal/accept', { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
        } catch (error) {
          console.warn('Could not update legal acceptance:', error.message);
        }
        showAccount(result.user);
        return;
      }
    } catch (_) {
      // No valid login yet; show sign-in.
    }
    showAuth('');
  }

  async function logoutFromProfile() {
    profileControls.forEach((control) => { control.logout.disabled = true; });
    try { await api('/api/logout', {}); } catch (_) { /* Continue clearing the local account UI. */ }
    try { localStorage.removeItem(CONSENT_KEY); } catch (_) {}
    currentUser = null;
    window.location.href = '/';
  }

  legalCheck.addEventListener('change', () => {
    legalContinue.disabled = !legalCheck.checked;
  });
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

  // Keep the legacy public API method working while the visible logout action
  // lives only inside the profile menu.
  if ($('account-logout')) $('account-logout').addEventListener('click', logoutFromProfile);

  async function bootstrap() {
    createProfileControls();
    setMode('login');
    if (!consentIsCurrent()) {
      legalOverlay.classList.remove('hidden');
      authOverlay.classList.add('hidden');
      hideProfileControls();
      return;
    }

    // A stored consent marker only belongs to the currently signed-in browser user.
    // If there is no valid account session, ask for consent before the next sign-in.
    try {
      const result = await api('/api/me');
      if (result.user) {
        try {
          await api('/api/legal/accept', { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
        } catch (error) {
          console.warn('Could not refresh legal acceptance:', error.message);
        }
        showAccount(result.user);
        return;
      }
    } catch (_) {
      // Fail closed and show the agreement before login.
    }
    try { localStorage.removeItem(CONSENT_KEY); } catch (_) {}
    legalOverlay.classList.remove('hidden');
    authOverlay.classList.add('hidden');
    hideProfileControls();
  }

  window.ROOM05_AUTH = {
    get user() { return currentUser; },
    logout: logoutFromProfile
  };

  bootstrap();
})();
