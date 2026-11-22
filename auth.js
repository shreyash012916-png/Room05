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
    accountChip.classList.add('visible');
    $('account-identity').textContent = `USER ID ${user.userId}`;
    $('account-identity').title = `${user.username} · ${user.userId}`;
    if ($('display-name')) $('display-name').value = user.username;
    document.dispatchEvent(new CustomEvent('room05:authenticated', { detail: user }));
  }

  function showAuth(message) {
    authOverlay.classList.remove('hidden');
    legalOverlay.classList.add('hidden');
    accountChip.classList.remove('visible');
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
        // The signed-in state is active; the message remains available in the account chip.
      }
    } catch (error) {
      authError.textContent = error.message || 'Could not sign in. Please try again.';
    } finally {
      busy = false;
      submitButton.disabled = false;
      $('auth-submit-label').textContent = mode === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
    }
  });

  $('account-logout').addEventListener('click', async () => {
    $('account-logout').disabled = true;
    try { await api('/api/logout', {}); } catch (_) {}
    try { localStorage.removeItem(CONSENT_KEY); } catch (_) {}
    currentUser = null;
    window.location.href = '/';
  });

  async function bootstrap() {
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
    logout: () => $('account-logout').click()
  };
  bootstrap();
})();
