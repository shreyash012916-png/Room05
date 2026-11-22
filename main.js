'use strict';

/* ROOM/05 — free peer-to-peer video rooms (WebRTC mesh).
   Media goes directly browser-to-browser. The server only relays signaling. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
  const CLIENT_SESSION_ID = (() => {
    const key = 'room05-client-session-v1';
    const make = () => {
      const bytes = new Uint8Array(18);
      if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    };
    try {
      const saved = sessionStorage.getItem(key);
      if (saved && /^[a-f0-9]{36}$/.test(saved)) return saved;
      const created = make();
      sessionStorage.setItem(key, created);
      return created;
    } catch (_) { return make(); }
  })();
  // A page-local owner token prevents the same browser profile from joining
  // the same room in two tabs (the second tab would otherwise appear as a
  // duplicate attendee and may have no camera because the first tab owns it).
  const TAB_OWNER = (() => {
    try { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }
    catch (_) { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  })();
  let activeRoomLockKey = '';
  let activeRoomLockTimer = null;
  let activeRoomLockRelease = null;

  function claimRoomTabWithStorage(code) {
    const key = 'room05-active-room-' + code;
    if (activeRoomLockKey === key) return true;
    const now = Date.now();
    try {
      const existing = JSON.parse(localStorage.getItem(key) || 'null');
      if (existing && existing.owner !== TAB_OWNER && Number(existing.expires) > now) return false;
      localStorage.setItem(key, JSON.stringify({ owner: TAB_OWNER, expires: now + 90000 }));
      const verified = JSON.parse(localStorage.getItem(key) || 'null');
      if (!verified || verified.owner !== TAB_OWNER) return false;
      activeRoomLockKey = key;
      clearInterval(activeRoomLockTimer);
      activeRoomLockTimer = setInterval(() => {
        try {
          const current = JSON.parse(localStorage.getItem(key) || 'null');
          if (!current || current.owner !== TAB_OWNER) {
            clearInterval(activeRoomLockTimer); activeRoomLockTimer = null; activeRoomLockKey = '';
            if (inRoom && !leaving) { toast('This room is active in another tab.'); leaveRoom(); }
            return;
          }
          localStorage.setItem(key, JSON.stringify({ owner: TAB_OWNER, expires: Date.now() + 90000 }));
        } catch (_) {}
      }, 25000);
      return true;
    } catch (_) {
      // Continue normally when browser storage is disabled or unavailable.
      return true;
    }
  }

  async function claimRoomTab(code) {
    const key = 'room05-active-room-' + code;
    if (activeRoomLockKey === key) return true;
    // Web Locks are atomic across tabs and remain held even when a mobile
    // browser throttles background-tab timers.
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      let outcome = 'pending';
      let resolveAcquired;
      let releaseHold = null;
      const acquired = new Promise((resolve) => { resolveAcquired = resolve; });
      const lockTask = navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) { outcome = 'busy'; resolveAcquired(false); return; }
        outcome = 'held';
        resolveAcquired(true);
        await new Promise((resolve) => { releaseHold = resolve; });
      });
      lockTask.catch(() => {
        if (outcome === 'pending') { outcome = 'failed'; resolveAcquired(false); }
      });
      const acquiredLock = await acquired;
      if (acquiredLock) {
        activeRoomLockKey = key;
        activeRoomLockRelease = () => {
          if (releaseHold) { const release = releaseHold; releaseHold = null; release(); }
        };
        return true;
      }
      if (outcome === 'busy') return false;
    }
    return claimRoomTabWithStorage(code);
  }

  function releaseRoomTab() {
    clearInterval(activeRoomLockTimer); activeRoomLockTimer = null;
    if (activeRoomLockRelease) {
      const release = activeRoomLockRelease;
      activeRoomLockRelease = null;
      activeRoomLockKey = '';
      release();
      return;
    }
    if (!activeRoomLockKey) return;
    try {
      const current = JSON.parse(localStorage.getItem(activeRoomLockKey) || 'null');
      if (current && current.owner === TAB_OWNER) localStorage.removeItem(activeRoomLockKey);
    } catch (_) {}
    activeRoomLockKey = '';
  }

  const landing = $('landing-screen');
  const callScreen = $('call-screen');
  const videoGrid = $('video-grid');
  const reactionFloats = $('reaction-floats');
  const errorBox = $('landing-error');

  // The call screen is also the fullscreen root. Effects placed elsewhere in
  // <body> are excluded by the Fullscreen API, so keep every call effect inside
  // this element in both normal and fullscreen layouts.
  if (reactionFloats && callScreen && reactionFloats.parentElement !== callScreen) {
    callScreen.appendChild(reactionFloats);
  }
  const createButton = $('create-room');
  const joinButton = $('join-room');

  let config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxPeople: 5 };
  let ws = null;
  let myId = '';
  let currentCode = '';
  let localName = '';
  let localStream = null;      // camera + mic
  let screenStream = null;     // local screen capture or theatre media capture
  let activeRoomMode = 'normal';
  let requestedRoomMode = 'normal';
  let theaterMediaActive = false;
  let theaterMediaUrl = '';
  let presentationAudioDestination = null;
  let presentationAudioSources = [];
  let presentationSharedTrack = null;
  let theaterMediaElementSource = null;
  let roomMusicTimer = null;
  let roomMusicOn = false;
  let aartiTimer = null;
  let peers = new Map();       // id -> {id, name, pc, polite, makingOffer, ignoreOffer, stream, state, vsender, asender, tile}
  let state = { mic: true, cam: true, screen: false, hand: false };
  let inRoom = false;
  let entering = false;
  let leaving = false;
  let retryCount = 0;
  let reconnectTask = null;
  let toastTimer = null;
  let partyTimer = null;
  let audioCtx = null;
  let wakeLock = null;
  let pinnedId = null;
  let hbTimer = null, lastPong = 0, statsTimer = null;

  // ---------- preferences ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('room05-' + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('room05-' + k, v); } catch (_) {} }
  };
  const prefs = { quality: store.get('quality', 'auto'), mirror: store.get('mirror', '1') === '1', sound: store.get('sound', '1') === '1' };

  const THEMES = [
    ['auto', 'Auto'], ['cream', 'Cream'], ['midnight', 'Midnight'], ['cyber', 'Cyber'], ['terminal', 'Terminal'], ['vapor', 'Vapor'],
    ['aurora', 'Aurora'], ['grape', 'Grape'], ['sunset', 'Sunset'], ['bubblegum', 'Bubblegum'], ['matcha', 'Matcha'], ['gameboy', 'Gameboy']
  ];
  const THEME_COLORS = { cream: ['#e9e6dc', '#d9ff00'], midnight: ['#0f110e', '#d9ff00'], cyber: ['#07060d', '#ff2bd6'], terminal: ['#020a04', '#39ff6a'], vapor: ['#3b1170', '#ff71ce'], aurora: ['#0a3a3c', '#5cffd2'], grape: ['#130e1f', '#c59bff'], sunset: ['#1a0e12', '#ffb347'], bubblegum: ['#ffe0ed', '#ff8bd1'], matcha: ['#dce9d2', '#9dff6a'], gameboy: ['#c4cfa1', '#8bac0f'] };
  const DARK_THEMES = new Set(['midnight', 'cyber', 'terminal', 'vapor', 'aurora', 'grape', 'sunset']);
  function resolveTheme(choice) { return choice === 'auto' ? (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'midnight' : 'cream') : (THEME_COLORS[choice] ? choice : 'cream'); }
  function applyTheme(choice, animate) {
    const t = resolveTheme(choice);
    const root = document.documentElement;
    if (animate !== false) { root.classList.add('theme-anim'); clearTimeout(applyTheme.tm); applyTheme.tm = setTimeout(() => root.classList.remove('theme-anim'), 600); }
    root.dataset.theme = t;
    root.dataset.mode = DARK_THEMES.has(t) ? 'dark' : 'light';
    const meta = $('meta-theme'); if (meta) meta.content = THEME_COLORS[t][0];
    store.set('theme', choice);
    if (choice !== 'auto') store.set(DARK_THEMES.has(t) ? 'last-dark' : 'last-light', choice);
    document.querySelectorAll('.theme-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.theme === choice)));
  }
  function toggleMode() {
    const t = resolveTheme(store.get('theme', 'auto'));
    applyTheme(DARK_THEMES.has(t) ? store.get('last-light', 'cream') : store.get('last-dark', 'midnight'));
    buzz();
  }
  function buildThemePickers() {
    document.querySelectorAll('.theme-swatches').forEach((box) => {
      box.innerHTML = '';
      THEMES.forEach(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'theme-chip' + (id === 'auto' ? ' auto' : ''); b.dataset.theme = id;
        b.title = label; b.setAttribute('aria-label', label + ' theme');
        if (THEME_COLORS[id]) { b.style.setProperty('--c1', THEME_COLORS[id][0]); b.style.setProperty('--c2', THEME_COLORS[id][1]); }
        b.addEventListener('click', () => { applyTheme(id); buzz(); });
        box.appendChild(b);
      });
    });
    applyTheme(store.get('theme', 'auto'), false);
    document.querySelectorAll('.mode-toggle').forEach((b) => b.addEventListener('click', toggleMode));
    document.querySelectorAll('.theme-wrap').forEach((wrap) => {
      const btn = wrap.querySelector('.theme-toggle'); const pop = wrap.querySelector('.theme-pop');
      btn.addEventListener('click', (e) => { e.stopPropagation(); const open = pop.classList.toggle('hidden') === false; btn.setAttribute('aria-expanded', String(open)); });
    });
    document.addEventListener('click', (e) => { document.querySelectorAll('.theme-pop').forEach((p) => { if (!p.contains(e.target)) p.classList.add('hidden'); }); });
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (store.get('theme', 'auto') === 'auto') applyTheme('auto'); });
  }

  // tiny haptics + sound blips (with a bundled local meme horn asset)
  function unlockRoomAudio() {
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch (_) {}
  }
  // Unlock once on the first real tap/key interaction, before media events arrive.
  document.addEventListener('pointerdown', unlockRoomAudio, { once: true, capture: true, passive: true });
  document.addEventListener('keydown', unlockRoomAudio, { once: true, capture: true });
  function buzz(ms) { if (prefs.sound && navigator.vibrate) { try { navigator.vibrate(ms || 8); } catch (_) {} } }
  function blip(kind) {
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const notes = kind === 'join' ? [660, 880] : kind === 'leave' ? [660, 440] : [880];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t0 = audioCtx.currentTime + i * 0.11;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
        o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.16);
      });
    } catch (_) {}
  }
  document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('button')) buzz(6); }, { passive: true });

  // ---------- quality presets ----------
  function qualityFor(peerCount) {
    const q = prefs.quality;
    // High presets are capped automatically for larger mesh rooms so a
    // phone never has to encode several 720p/1080p copies at once.
    if (q === 'max' && peerCount <= 1) return { w: 1920, h: 1080, fps: 30, bitrate: 4500000 };
    if (q === 'hd' && peerCount <= 2) return { w: 1280, h: 720, fps: 24, bitrate: 1200000 };
    if (q === 'data' && peerCount <= 2) return { w: 640, h: 360, fps: 18, bitrate: 280000 };
    // Mesh mode sends one copy to every other person. Keep the combined
    // outbound budget phone-friendly as the room fills up.
    if (peerCount <= 1) return { w: 1280, h: 720, fps: 24, bitrate: 1000000 };
    if (peerCount === 2) return { w: 800, h: 450, fps: 18, bitrate: 420000 };
    if (peerCount === 3) return { w: 480, h: 270, fps: 15, bitrate: 230000 };
    return { w: 426, h: 240, fps: 12, bitrate: 160000 };
  }
  function retuneAll() {
    const q = qualityFor(peers.size);
    peers.forEach((p) => { if (p.vsender) tuneVideoSender(p.vsender, p); if (p.screenSender) tuneVideoSender(p.screenSender, p, true); });
    const t = cameraTrack();
    if (t && t.applyConstraints) t.applyConstraints({ width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } }).catch(() => {});
  }

  // ---------- helpers ----------
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3600);
  }
  const setError = (m) => { errorBox.textContent = m || ''; };
  const cleanName = (v) => String(v || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 28);
  const pad = (n) => String(n).padStart(2, '0');

  function makeCode() {
    if (!window.crypto || !crypto.getRandomValues) throw new Error('This browser cannot create a secure room code. Use an up-to-date browser over HTTPS.');
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  }

  function setBusy(busy) {
    entering = busy;
    createButton.disabled = busy;
    joinButton.disabled = busy;
    createButton.querySelector('span').textContent = busy ? 'CONNECTING…' : 'CREATE A ROOM';
    joinButton.querySelector('span').textContent = busy ? '…' : 'JOIN';
    $('display-name').disabled = busy;
    $('room-code').disabled = busy;
  }

  function setStatus(text, kind) {
    const el = $('connection-status');
    el.querySelector('span').textContent = text;
    el.classList.toggle('is-connected', kind === 'ok');
    el.classList.toggle('is-warning', kind === 'warn');
  }

  function setButton(id, active, onLabel, offLabel) {
    const b = $(id);
    b.setAttribute('aria-pressed', String(active));
    b.classList.toggle('is-active', active);
    const l = b.querySelector('.control-label');
    if (l && onLabel) l.textContent = active ? onLabel : offLabel;
  }

  // ---------- local media ----------
  const gUM = (c) => navigator.mediaDevices.getUserMedia(c);
  async function getLocalMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera and microphone need HTTPS and an up-to-date browser.');
    }
    const qq = qualityFor(1);
    const audioHi = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const videoHi = { width: { ideal: qq.w }, height: { ideal: qq.h }, frameRate: { ideal: qq.fps }, facingMode: 'user' };
    // 1) both at once (best), 2) both with plain constraints
    for (const c of [{ audio: audioHi, video: videoHi }, { audio: true, video: true }]) {
      try { return await gUM(c); } catch (_) { /* try next */ }
    }
    // 3) get each device on its own so one failing never costs us the other
    const stream = new MediaStream();
    let gotV = false, gotA = false;
    for (const c of [{ video: videoHi }, { video: true }]) { if (gotV) break; try { (await gUM(c)).getTracks().forEach((t) => { stream.addTrack(t); gotV = true; }); } catch (_) {} }
    for (const c of [{ audio: audioHi }, { audio: true }]) { if (gotA) break; try { (await gUM(c)).getTracks().forEach((t) => { stream.addTrack(t); gotA = true; }); } catch (_) {} }
    if (!gotV && !gotA) toast('No camera or microphone access — joining as a viewer. Tap the camera button to try again.');
    else if (!gotV) toast('Camera unavailable (blocked or in use) — tap the camera button to retry.');
    else if (!gotA) toast('Microphone unavailable — tap the mic button to retry.');
    return stream;
  }

  // Try to get a missing camera/mic later (permission granted, other app released it, ...)
  async function acquireTrack(kind) {
    try {
      const q = qualityFor(peers.size || 1);
      const s2 = await gUM(kind === 'video'
        ? { video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps }, facingMode: 'user' } }
        : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const t = s2.getTracks()[0];
      if (!t) return null;
      if (kind === 'video') { try { t.contentHint = 'motion'; } catch (_) {} }
      localStream.addTrack(t);
      return t;
    } catch (_) { return null; }
  }

  const audioTrack = () => (localStream && localStream.getAudioTracks()[0]) || null;
  const outgoingAudioTrack = () => (presentationAudioDestination && presentationAudioDestination.stream.getAudioTracks()[0]) || audioTrack();
  const cameraTrack = () => (localStream && localStream.getVideoTracks()[0]) || null;
  const outgoingVideoTrack = () => (screenStream && screenStream.getVideoTracks()[0]) || cameraTrack();

  function applyInitialPrefs() {
    const a = audioTrack(); const v = cameraTrack();
    if (v) { try { v.contentHint = 'motion'; } catch (_) {} }
    state.mic = !!a && $('start-mic').checked;
    state.cam = !!v && $('start-camera').checked;
    if (a) a.enabled = state.mic;
    if (v) v.enabled = state.cam;
    state.screen = false; state.hand = false;
    syncButtons();
  }

  function syncButtons() {
    setButton('toggle-mic', !state.mic, 'UNMUTE', 'MUTE');
    setButton('toggle-camera', !state.cam, 'CAMERA ON', 'CAMERA');
    setButton('toggle-screen', state.screen, 'STOP SHARE', 'SHARE');
    setButton('toggle-hand', state.hand, 'LOWER HAND', 'RAISE HAND');
  }

  function broadcastState() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state }));
    renderLocalTile();
    renderPeople();
    syncTheaterStage();
  }

  // ---------- speaking indicator ----------
  function watchSpeaking(stream, tile) {
    try {
      if (!stream.getAudioTracks().length) return;
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      const timer = setInterval(() => {
        if (!tile.isConnected) { clearInterval(timer); try { src.disconnect(); } catch (_) {} return; }
        an.getByteFrequencyData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
        const speaking = sum / data.length > 18;
        tile.classList.toggle('is-speaking', speaking);
        const ring = tile.querySelector('.speaking-ring');
        if (ring) ring.classList.toggle('speaking', speaking);
      }, 200);
    } catch (_) { /* optional feature */ }
  }

  // ---------- tiles ----------
  function buildTile(id, name, isLocal) {
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.id = id;
    const stage = document.createElement('div');
    stage.className = 'video-stage';
    const ph = document.createElement('div');
    ph.className = 'video-placeholder';
    const av = document.createElement('div');
    av.className = 'avatar-initials';
    av.textContent = (name || '?').slice(0, 1).toUpperCase();
    const cap = document.createElement('span');
    cap.className = 'placeholder-caption';
    cap.textContent = 'CAMERA OFF';
    ph.append(av, cap);
    const layer = document.createElement('div');
    layer.className = 'media-layer';
    const video = document.createElement('video');
    video.className = 'track-video' + (isLocal ? ' self-video' : '');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.muted = isLocal;
    layer.appendChild(video);
    const ring = document.createElement('div');
    ring.className = 'speaking-ring';
    const flags = document.createElement('div');
    flags.className = 'tile-top-flags';
    const role = document.createElement('span');
    role.className = 'tile-role';
    role.textContent = isLocal ? 'YOU' : 'LIVE';
    const hand = document.createElement('span');
    hand.className = 'hand-flag hidden';
    hand.textContent = '✋ HAND UP';
    flags.append(role, hand);
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    const pin = document.createElement('button'); pin.type = 'button'; pin.textContent = '📌'; pin.title = 'Pin / spotlight'; pin.setAttribute('aria-label', 'Pin tile');
    pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(id); });
    const fs = document.createElement('button'); fs.type = 'button'; fs.textContent = '⛶'; fs.title = 'Fullscreen'; fs.setAttribute('aria-label', 'Fullscreen tile');
    fs.addEventListener('click', (e) => { e.stopPropagation(); tileFullscreen(tile); });
    const fl = document.createElement('button'); fl.type = 'button'; fl.textContent = '✦'; fl.title = 'Filter (only you see it)'; fl.setAttribute('aria-label', 'Cycle video filter');
    fl.addEventListener('click', (e) => { e.stopPropagation(); window.__room05Filter(tile); });
    actions.append(pin, fl, fs);
    stage.append(ph, layer, ring, flags, actions);
    tile.addEventListener('dblclick', () => tileFullscreen(tile));
    const footer = document.createElement('div');
    footer.className = 'tile-footer';
    const person = document.createElement('div');
    person.className = 'tile-person';
    const nm = document.createElement('span');
    nm.className = 'tile-name';
    nm.textContent = name;
    person.appendChild(nm);
    if (isLocal) { const you = document.createElement('span'); you.className = 'tile-you'; you.textContent = '(YOU)'; person.appendChild(you); }
    const status = document.createElement('span');
    status.className = 'tile-status';
    footer.append(person, status);
    tile.append(stage, footer);
    return tile;
  }

  function paintTile(tile, st, stream, extra) {
    const hasTrack = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
    const hasVideo = hasTrack && (st.cam || st.screen);
    tile.classList.toggle('no-video', !hasVideo);
    const cap = tile.querySelector('.placeholder-caption');
    if (cap) cap.textContent = hasTrack || st.cam === false ? 'CAMERA OFF' : (extra === 'CONNECTED' || !extra ? 'LOADING VIDEO…' : 'CONNECTING…');
    tile.querySelector('.hand-flag').classList.toggle('hidden', !st.hand);
    const v = tile.querySelector('video');
    v.classList.toggle('screen-track', !!st.screen);
    if (stream && v.srcObject !== stream) v.srcObject = stream;
    // A remote track can recover after a network or app-switch interruption
    // while its video element remains paused. Retry playback on every render.
    if (hasVideo && v.paused) {
      try { const playback = v.play(); if (playback && playback.catch) playback.catch(() => {}); } catch (_) {}
    }
    const parts = [];
    if (st.screen) parts.push('SHARING');
    parts.push(st.mic ? 'MIC ON' : 'MUTED');
    if (extra) parts.unshift(extra);
    const s = tile.querySelector('.tile-status');
    s.textContent = parts.join(' · ');
    s.classList.toggle('tile-mic', true);
    s.classList.toggle('muted', !st.mic);
  }

  function togglePin(id) {
    pinnedId = pinnedId === id ? null : id;
    layoutGrid();
    toast(pinnedId ? 'Spotlight on.' : 'Spotlight off.');
  }
  function tileFullscreen(tile) {
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      const fn = tile.requestFullscreen || tile.webkitRequestFullscreen;
      if (fn) fn.call(tile); else { const v = tile.querySelector('video'); if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen(); }
    } catch (_) {}
  }

  let localTile = null;
  function renderLocalTile() {
    if (!localTile) return;
    const display = new MediaStream();
    const vt = (activeRoomMode === 'theater' && state.screen) ? cameraTrack() : outgoingVideoTrack();
    if (vt) display.addTrack(vt);
    const v = localTile.querySelector('video');
    if (!v.srcObject || v.dataset.vt !== (vt ? vt.id : '')) { v.srcObject = display; v.dataset.vt = vt ? vt.id : ''; }
    v.classList.toggle('self-video', (!state.screen || activeRoomMode === 'theater') && prefs.mirror);
    const hasVideo = !!vt && vt.readyState === 'live' && (activeRoomMode === 'theater' ? state.cam : (state.cam || state.screen));
    localTile.classList.toggle('no-video', !hasVideo);
    localTile.querySelector('.hand-flag').classList.toggle('hidden', !state.hand);
    v.classList.toggle('screen-track', state.screen && activeRoomMode !== 'theater');
    const s = localTile.querySelector('.tile-status');
    s.textContent = (state.screen ? 'SHARING · ' : '') + (state.mic ? 'MIC ON' : 'MUTED');
    s.classList.toggle('muted', !state.mic);
  }

  function renderPeerTile(p) {
    if (!p.tile) return;
    const screenVideo = p.screenStream && p.screenStream.getVideoTracks().some((t) => t.readyState === 'live');
    const displayStream = activeRoomMode !== 'theater' && p.state.screen && screenVideo ? p.screenStream : p.stream;
    const displayState = activeRoomMode === 'theater' ? { ...p.state, screen: false } : p.state;
    paintTile(p.tile, displayState, displayStream, p.connState && p.connState !== 'connected' ? p.connState.toUpperCase() : '');
  }

  function layoutGrid() {
    const count = peers.size + 1;
    videoGrid.dataset.count = String(Math.min(count, 5));
    videoGrid.style.setProperty('--n', count);
    $('participant-count').textContent = pad(count);
    $('people-badge').textContent = String(count);
    $('panel-count').textContent = pad(count);
    videoGrid.classList.toggle('has-pin', !!pinnedId && count > 1);
    videoGrid.querySelectorAll('.video-tile').forEach((t) => t.classList.toggle('pinned', !!pinnedId && count > 1 && t.dataset.id === pinnedId));
    const note = videoGrid.querySelector('.loading-note');
    if (note) note.remove();
  }

  function renderPeople() {
    const list = $('participants-list');
    list.innerHTML = '';
    const all = [{ name: localName, st: state, local: true }, ...Array.from(peers.values(), (p) => ({ name: p.name, st: p.state, local: false }))];
    all.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'participant-row';
      const avatar = document.createElement('span');
      avatar.className = 'participant-avatar';
      avatar.textContent = (person.name || '?').slice(0, 1).toUpperCase();
      const d = document.createElement('div');
      d.className = 'participant-details';
      const label = document.createElement('strong');
      label.textContent = person.name + (person.local ? ' (YOU)' : '');
      const sm = document.createElement('small');
      sm.textContent = [person.st.mic ? 'Mic on' : 'Muted', person.st.cam ? 'Camera on' : 'Camera off', person.st.hand ? '✋' : '', person.st.screen ? 'Sharing' : ''].filter(Boolean).join(' · ');
      d.append(label, sm);
      row.append(avatar, d);
      list.appendChild(row);
    });
  }

  // ---------- peer connections (perfect negotiation) ----------
  // Attach our camera/mic to a peer's audio+video transceivers (never needs renegotiation later: we just swap tracks).
  async function attachSenders(p, at, vt, st) {
    p.asender = at ? at.sender : null;
    p.vsender = vt ? vt.sender : null;
    p.cameraTransceiver = vt || p.cameraTransceiver || null;
    p.screenSender = st ? st.sender : null;
    p.screenTransceiver = st || p.screenTransceiver || null;
    p.attached = true;
    const jobs = [];
    const atTrack = outgoingAudioTrack();
    const vtTrack = cameraTrack();
    const stTrack = screenStream && screenStream.getVideoTracks()[0];
    if (p.asender && atTrack && p.asender.track !== atTrack) jobs.push(p.asender.replaceTrack(atTrack));
    if (p.vsender && vtTrack && p.vsender.track !== vtTrack) jobs.push(p.vsender.replaceTrack(vtTrack));
    if (p.screenSender && p.screenSender.track !== (stTrack || null)) jobs.push(p.screenSender.replaceTrack(stTrack || null));
    try { await Promise.all(jobs); } catch (e) { console.warn('attach failed', e); }
    if (p.asender) tuneAudioSender(p.asender);
    if (p.vsender) tuneVideoSender(p.vsender, p);
    if (p.screenSender) tuneVideoSender(p.screenSender, p, true);
  }

  // Each connection has separate camera and presentation video transceivers.
  // This lets a movie/screen occupy the big stage without taking away the camera tile.
  async function attachFromOffer(p) {
    const ts = p.pc.getTransceivers();
    const live = ts.filter((t) => t.receiver && t.receiver.track && !t.stopped);
    const at = live.find((t) => t.receiver.track.kind === 'audio');
    const videos = live.filter((t) => t.receiver.track.kind === 'video');
    const vt = videos[0] || null;
    const st = videos[1] || null;
    p.cameraTransceiver = vt;
    p.screenTransceiver = st;
    [at, vt, st].forEach((t) => { if (t) { try { t.direction = 'sendrecv'; } catch (_) {} } });
    await attachSenders(p, at, vt, st);
  }

  function watchPeer(p, attempt) {
    clearTimeout(p.watchdog);
    p.watchdog = setTimeout(() => {
      if (peers.get(p.id) !== p || !inRoom) return;
      const pc = p.pc;
      const hasTrack = p.stream.getVideoTracks().some((t) => t.readyState === 'live');
      const healthy = pc.connectionState === 'connected' && (hasTrack || p.state.cam === false);
      if (healthy) { renderPeerTile(p); return; }
      if (attempt >= 4) { toast(p.name + ': still linking — a strict network may need a TURN relay.'); return; }
      try { pc.restartIce(); } catch (_) {}
      sendMyStateTo();
      watchPeer(p, attempt + 1);
    }, attempt === 0 ? 7000 : 9000);
  }

  function createPeer(id, name, initiator) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 10, iceTransportPolicy: 'all' });
    const p = { id, name, pc, polite: myId > id, initiator: !!initiator, makingOffer: false, ignoreOffer: false, stream: new MediaStream(), screenStream: new MediaStream(), cameraTransceiver: null, state: { mic: true, cam: true, screen: false, hand: false }, vsender: null, asender: null, screenSender: null, screenTransceiver: null, tile: null, connState: 'connecting', queue: Promise.resolve(), pendingCandidates: [], attached: false, watchdog: null, bitrateScale: 1, lossHighCount: 0, lossGoodCount: 0 };
    peers.set(id, p);

    if (initiator) {
      const at = outgoingAudioTrack(), vt = cameraTrack(), st = screenStream && screenStream.getVideoTracks()[0];
      const ta = at ? pc.addTransceiver(at, { direction: 'sendrecv', streams: [localStream] }) : pc.addTransceiver('audio', { direction: 'sendrecv' });
      const tv = vt ? pc.addTransceiver(vt, { direction: 'sendrecv', streams: [localStream] }) : pc.addTransceiver('video', { direction: 'sendrecv' });
      const ts = st ? pc.addTransceiver(st, { direction: 'sendrecv' }) : pc.addTransceiver('video', { direction: 'sendrecv' });
      p.asender = ta.sender; p.vsender = tv.sender; p.cameraTransceiver = tv; p.screenSender = ts.sender; p.screenTransceiver = ts; p.attached = true;
    }

    pc.ontrack = ({ track, transceiver }) => {
      const videoTransceivers = pc.getTransceivers().filter((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'video' && !t.stopped);
      const isPresentationTrack = track.kind === 'video' && (
        transceiver === p.screenTransceiver ||
        (!p.cameraTransceiver && videoTransceivers.indexOf(transceiver) > 0)
      );
      const receivingStream = isPresentationTrack ? p.screenStream : p.stream;
      if (!receivingStream.getTracks().some((existing) => existing.id === track.id)) receivingStream.addTrack(track);
      // The presentation stream also carries the peer's mixed microphone/media audio
      // so normal-mode screen-share tiles remain audible.
      if (track.kind === 'audio' && !p.screenStream.getTracks().some((existing) => existing.id === track.id)) p.screenStream.addTrack(track);
      track.onended = () => {
        try { receivingStream.removeTrack(track); } catch (_) {}
        renderPeerTile(p);
        syncTheaterStage();
      };
      track.onmute = () => { renderPeerTile(p); syncTheaterStage(); };
      track.onunmute = () => { renderPeerTile(p); syncTheaterStage(); };
      if (!p.tile) {
        p.tile = buildTile(id, p.name, false);
        videoGrid.appendChild(p.tile);
        watchSpeaking(p.stream, p.tile);
        layoutGrid();
        renderPeople();
      }
      if (!isPresentationTrack) {
        const v = p.tile.querySelector('video');
        v.onloadedmetadata = v.onresize = v.onplaying = () => renderPeerTile(p);
        v.srcObject = p.stream;
        const sink = $('audio-output-select').value;
        if (sink && v.setSinkId) v.setSinkId(sink).catch(() => {});
        const playing = v.play(); if (playing && playing.catch) playing.catch(() => {});
      }
      renderPeerTile(p);
      syncTheaterStage();
    };

    pc.onicecandidate = ({ candidate }) => { if (candidate) sendSignal(id, { candidate }); };

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(id, { description: pc.localDescription });
      } catch (e) { console.warn('negotiation failed', e); } finally { p.makingOffer = false; }
    };

    pc.onconnectionstatechange = () => {
      p.connState = pc.connectionState;
      renderPeerTile(p);
      if (pc.connectionState === 'connected') {
        syncPeerSenders(p);
        if (p.vsender) tuneVideoSender(p.vsender, p);
        if (p.screenSender) tuneVideoSender(p.screenSender, p, true);
        if (p.asender) tuneAudioSender(p.asender);
        sendMyStateTo(); // make sure they know our camera/mic state the moment media can flow
      }
      if (pc.connectionState === 'disconnected') { setTimeout(() => { if (peers.get(id) === p && pc.connectionState === 'disconnected') { try { pc.restartIce(); } catch (_) {} } }, 3000); }
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (_) {}
        toast(p.name + ': connection is struggling — retrying. Strict networks may need a TURN relay.');
      }
    };

    // Show a tile right away, even before media arrives
    p.tile = buildTile(id, name, false);
    videoGrid.appendChild(p.tile);
    renderPeerTile(p);
    layoutGrid();
    renderPeople();
    retuneAll();
    syncTheaterStage();
    watchPeer(p, 0);
    return p;
  }

  async function syncPeerSenders(p) {
    if (!p || !p.pc || p.pc.connectionState === 'closed') return;
    const jobs = [];
    const audio = outgoingAudioTrack();
    const video = cameraTrack();
    const presentation = screenStream && screenStream.getVideoTracks()[0] || null;
    if (p.asender && p.asender.track !== (audio || null)) jobs.push(p.asender.replaceTrack(audio || null));
    if (p.vsender && p.vsender.track !== (video || null)) jobs.push(p.vsender.replaceTrack(video || null));
    if (p.screenSender && p.screenSender.track !== presentation) jobs.push(p.screenSender.replaceTrack(presentation));
    const results = await Promise.allSettled(jobs);
    results.forEach((result) => { if (result.status === 'rejected') console.warn('Peer track recovery failed:', result.reason); });
  }

  function tuneVideoSender(sender, peer, presentation) {
    try {
      const q = qualityFor(peers.size);
      const scale = peer && Number.isFinite(peer.bitrateScale) ? peer.bitrateScale : 1;
      const presentationBitrate = peers.size >= 3 ? 480000 : (peers.size === 2 ? 720000 : 1100000);
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = Math.max(90000, Math.round((presentation ? presentationBitrate : q.bitrate) * (presentation ? 1 : scale)));
      params.encodings[0].maxFramerate = presentation ? (peers.size >= 3 ? 15 : 20) : Math.max(8, Math.round(q.fps * Math.sqrt(scale)));
      params.encodings[0].networkPriority = 'high';
      params.degradationPreference = 'balanced';
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }
  function tuneAudioSender(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 64000;
      params.encodings[0].priority = 'high';
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }

  function sendSignal(to, data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  function handleSignal(from, data) {
    const p = peers.get(from);
    if (!p || !data) return;
    p.queue = p.queue.then(() => processSignal(p, data)).catch(() => {});
  }

  async function processSignal(p, data) {
    const pc = p.pc;
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        for (const c of p.pendingCandidates.splice(0)) { try { await pc.addIceCandidate(c); } catch (_) {} }
        if (d.type === 'offer') {
          if (!p.attached) await attachFromOffer(p);
          await pc.setLocalDescription();
          sendSignal(p.id, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        if (!pc.remoteDescription) { p.pendingCandidates.push(data.candidate); return; }
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) console.warn('ICE candidate error', e); }
      }
    } catch (e) { console.warn('signal handling failed', e); }
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    clearTimeout(p.watchdog);
    try { p.pc.close(); } catch (_) {}
    if (p.tile) p.tile.remove();
    peers.delete(id);
    if (pinnedId === id) pinnedId = null;
    layoutGrid();
    renderPeople();
    retuneAll();
    syncTheaterStage();
    blip('leave');
    toast(p.name + ' left the room.');
  }

  function closeAllPeers() {
    peers.forEach((p) => { clearTimeout(p.watchdog); try { p.pc.close(); } catch (_) {} if (p.tile) p.tile.remove(); });
    peers.clear();
  }

  // ---------- signaling socket ----------
  function openSocket() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${location.host}/ws`);
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { sock.close(); } catch (_) {} reject(new Error('The room server did not respond. If this site was idle, it may be waking up — wait 30 seconds and try again.')); } }, 45000);
      sock.onopen = () => {
        sock.send(JSON.stringify({ type: 'join', room: currentCode, name: localName, sessionId: CLIENT_SESSION_ID, roomMode: requestedRoomMode }));
      };
      sock.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (!settled && m.type === 'joined') { settled = true; clearTimeout(timer); resolve({ sock, joined: m }); return; }
        if (!settled && m.type === 'full') { settled = true; clearTimeout(timer); try { sock.close(); } catch (_) {} reject(new Error('This room is full (' + m.max + ' people max).')); return; }
        if (!settled && m.type === 'error') {
          settled = true; clearTimeout(timer);
          reject(new Error(m.reason === 'bad-session' ? 'Refresh ROOM/05 to update the room connection, then try again.' : 'Invalid room code.'));
          return;
        }
        if (settled) onServerMessage(m);
      };
      sock.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not reach the room server.')); } };
      sock.onclose = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not reach the room server.')); } else onSocketClosed(sock); };
    });
  }

  function onServerMessage(m) {
    switch (m.type) {
      case 'peer-joined': {
        if (m.roomMode) applyRoomMode(m.roomMode);
        const p = createPeer(m.id, m.name, false);
        p.state = { mic: true, cam: true, screen: false, hand: false };
        blip('join');
        toast(m.name + ' joined.');
        sendMyStateTo();
        break;
      }
      case 'peer-left': removePeer(m.id); break;
      case 'pong': lastPong = Date.now(); break;
      case 'signal': handleSignal(m.from, m.data); break;
      case 'presentation-denied': {
        toast((m.name || 'Someone else') + ' is already presenting. Your share was stopped.');
        if (state.screen) { if (theaterMediaActive) stopTheaterMedia(); else stopScreenShare(); }
        break;
      }
      case 'state': {
        const p = peers.get(m.id);
        if (p) { p.state = m.state; renderPeerTile(p); renderPeople(); syncTheaterStage(); }
        break;
      }
      case 'chat': appendChat(m.name, m.text); notifyChat(); blip('ping'); break;
      case 'reaction': activateReaction(m.emoji, m.name); break;
      default: break;
    }
  }

  function sendMyStateTo() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state })); }

  function onSocketClosed(sock) {
    if (sock !== ws || leaving || !inRoom) return;
    ws = null;
    setStatus('RECONNECTING', 'warn');
    closeAllPeers();
    layoutGrid();
    if (!reconnectTask) {
      reconnectTask = attemptReconnect().finally(() => { reconnectTask = null; });
    }
  }

  async function attemptReconnect() {
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (leaving || !inRoom) return;
      retryCount = attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 6000)));
      if (leaving || !inRoom) return;
      let candidate = null;
      try {
        const opened = await openSocket();
        candidate = opened.sock;
        if (leaving || !inRoom) { try { candidate.close(); } catch (_) {} return; }
        if (candidate.readyState !== WebSocket.OPEN) throw new Error('Socket closed while reconnecting.');
        ws = candidate;
        myId = opened.joined.id;
        retryCount = 0;
        setStatus('CONNECTED', 'ok');
        closeAllPeers();
        applyRoomMode(opened.joined.roomMode || requestedRoomMode);
        opened.joined.peers.forEach((pr) => {
          const peer = createPeer(pr.id, pr.name, true);
          if (pr.state && Object.keys(pr.state).length) peer.state = pr.state;
        });
        syncTheaterStage();
        sendMyStateTo();
        startHeartbeat();
        layoutGrid();
        renderPeople();
        toast('Connection restored.');
        return;
      } catch (error) {
        if (candidate && candidate === ws && candidate.readyState !== WebSocket.OPEN) ws = null;
      }
    }
    if (!leaving && inRoom) {
      toast('Connection lost. Please rejoin the room.');
      leaveRoom();
    }
  }

  // ---------- robustness: heartbeat, wake lock, stats ----------
  function startHeartbeat() {
    stopHeartbeat(); lastPong = Date.now();
    hbTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - lastPong > 50000) { try { ws.close(); } catch (_) {} return; }
      ws.send(JSON.stringify({ type: 'ping' }));
      sendMyStateTo();
    }, 15000);
  }
  function stopHeartbeat() { clearInterval(hbTimer); hbTimer = null; }
  async function acquireWakeLock() { try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (_) {} }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (_) {} wakeLock = null; }
  // Mobile browsers can suspend camera capture and pause video playback while
  // the page is backgrounded. Resume visible videos first, then restore the
  // camera track if the browser ended, muted, or stopped delivering frames.
  let cameraResumeTimer = null;
  let cameraRestoreTask = null;

  function resumeVisibleVideoElements() {
    document.querySelectorAll('#video-grid video, #theater-stage-video').forEach((video) => {
      const stream = video.srcObject;
      if (!stream || !stream.getVideoTracks || !stream.getVideoTracks().some((track) => track.readyState === 'live')) return;
      if (video.paused || video.readyState < 2) {
        try {
          const playTask = video.play();
          if (playTask && playTask.catch) playTask.catch(() => {});
        } catch (_) {}
      }
    });
  }

  function restoreCameraAfterResume() {
    if (cameraRestoreTask) return cameraRestoreTask;
    cameraRestoreTask = (async () => {
      if (!inRoom || !state.cam || !localStream) return;
      let current = cameraTrack();
      let needsRestore = !current || current.readyState !== 'live' || current.muted;
      const preview = localTile && localTile.querySelector('video');

      if (!needsRestore && preview && !state.screen) {
        // Reattach the current camera track if the browser discarded the
        // preview's media element state while the page was away.
        const previewStream = preview.srcObject;
        const previewTracks = previewStream && previewStream.getVideoTracks ? previewStream.getVideoTracks() : [];
        if (!previewTracks.some((track) => track.id === current.id)) {
          preview.srcObject = new MediaStream([current]);
          preview.dataset.vt = current.id;
        }
        if (preview.paused) { try { await preview.play(); } catch (_) {} }

        const before = preview.currentTime;
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (!inRoom || !state.cam || !localStream || current !== cameraTrack()) return;
        needsRestore = current.readyState !== 'live' || current.muted || preview.readyState < 2 || preview.currentTime <= before + 0.02;

        // A live camera can outlast its preview decoder. Reset the preview
        // once before asking the browser to open the camera device again.
        if (needsRestore && current.readyState === 'live' && !current.muted) {
          preview.srcObject = new MediaStream([current]);
          preview.dataset.vt = current.id;
          try { await preview.play(); } catch (_) {}
          await new Promise((resolve) => setTimeout(resolve, 550));
          if (!inRoom || !state.cam || !localStream || current !== cameraTrack()) return;
          needsRestore = current.readyState !== 'live' || current.muted || preview.readyState < 2 || preview.currentTime <= before + 0.02;
        }
      }

      if (!needsRestore) {
        renderLocalTile();
        resumeVisibleVideoElements();
        return;
      }

      try {
        const q = qualityFor(peers.size || 1);
        const fresh = await gUM({ video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps }, facingMode: 'user' } });
        const replacement = fresh.getVideoTracks()[0];
        if (!replacement) {
          fresh.getTracks().forEach((track) => { try { track.stop(); } catch (_) {} });
          throw new Error('No camera track was returned.');
        }
        if (!inRoom || !state.cam || !localStream) {
          fresh.getTracks().forEach((track) => { try { track.stop(); } catch (_) {} });
          return;
        }
        current = cameraTrack();
        replacement.enabled = state.cam;
        try { replacement.contentHint = 'motion'; } catch (_) {}
        if (current) localStream.removeTrack(current);
        localStream.addTrack(replacement);
        if (current && current.readyState !== 'ended') { try { current.stop(); } catch (_) {} }
        await setOutgoingVideo(replacement);
        renderLocalTile();
        resumeVisibleVideoElements();
        broadcastState();
        toast('Camera reconnected.');
      } catch (_) {
        if (inRoom && state.cam) toast('Camera paused while you were away. Tap CAMERA to retry.');
      }
    })().finally(() => { cameraRestoreTask = null; });
    return cameraRestoreTask;
  }

  function handleRoomForeground() {
    if (document.visibilityState !== 'visible' || !inRoom) return;
    acquireWakeLock();
    resumeVisibleVideoElements();
    if (ws && ws.readyState !== 1) { try { ws.close(); } catch (_) {} }
    clearTimeout(cameraResumeTimer);
    cameraResumeTimer = setTimeout(() => {
      if (document.visibilityState === 'visible' && inRoom) {
        resumeVisibleVideoElements();
        restoreCameraAfterResume();
      }
    }, 900);
  }
  document.addEventListener('visibilitychange', handleRoomForeground);
  window.addEventListener('pageshow', handleRoomForeground);
  window.addEventListener('focus', handleRoomForeground);
  window.addEventListener('online', () => { if (inRoom) { toast('Back online — reconnecting…'); if (ws && ws.readyState !== 1) { try { ws.close(); } catch (_) {} } } });
  window.addEventListener('offline', () => { if (inRoom) { setStatus('OFFLINE', 'warn'); toast('You are offline.'); } });

  function startStats() {
    stopStats();
    statsTimer = setInterval(async () => {
      let worstRtt = 0, any = false, lossHigh = false;
      for (const p of peers.values()) {
        try {
          const stats = await p.pc.getStats();
          let remoteLoss = null;
          stats.forEach((r) => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && typeof r.currentRoundTripTime === 'number') { any = true; worstRtt = Math.max(worstRtt, r.currentRoundTripTime * 1000); }
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.packetsReceived > 100 && r.packetsLost / (r.packetsReceived + r.packetsLost) > 0.08) lossHigh = true;
            if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && typeof r.fractionLost === 'number') remoteLoss = Math.max(remoteLoss || 0, r.fractionLost);
          });
          if (remoteLoss !== null && p.vsender) {
            if (remoteLoss > 0.08) { p.lossHighCount++; p.lossGoodCount = 0; }
            else if (remoteLoss < 0.025) { p.lossGoodCount++; p.lossHighCount = 0; }
            if (p.lossHighCount >= 2) { p.bitrateScale = Math.max(0.35, (p.bitrateScale || 1) * 0.72); p.lossHighCount = 0; tuneVideoSender(p.vsender, p); }
            else if (p.lossGoodCount >= 5) { p.bitrateScale = Math.min(1, (p.bitrateScale || 1) + 0.12); p.lossGoodCount = 0; tuneVideoSender(p.vsender, p); }
          }
        } catch (_) {}
      }
      if (!inRoom || ws == null || ws.readyState !== 1) return;
      if (!peers.size) { setStatus('CONNECTED', 'ok'); return; }
      if (!any) { setStatus('LINKING', ''); return; }
      const ms = Math.round(worstRtt);
      setStatus((lossHigh ? 'WEAK ' : ms < 120 ? 'GREAT ' : 'OK ') + ms + 'ms', lossHigh || ms > 300 ? 'warn' : 'ok');
    }, 3000);
  }
  function stopStats() { clearInterval(statsTimer); statsTimer = null; }

  // ---------- enter / leave ----------
  function showCall(code) {
    landing.classList.add('hidden');
    callScreen.classList.remove('hidden');
    document.body.classList.add('in-call');
    $('active-room-code').textContent = code;
    $('footer-room-code').textContent = code;
    videoGrid.innerHTML = '';
    videoGrid.dataset.count = '1';
    setStatus('CONNECTING', '');
  }

  async function enterRoom(code, roomMode) {
    unlockRoomAudio();
    if (entering || inRoom) return;
    setError('');
    const name = cleanName($('display-name').value);
    if (!name) { setError('Add your name first.'); $('display-name').focus(); return; }
    code = String(code || '').toUpperCase();
    if (!CODE_RE.test(code)) { setError('Enter a valid 8-character room code (no I, O, 0 or 1).'); $('room-code').focus(); return; }

    // Lock synchronously before the first await. This prevents rapid double taps
    // from starting two independent room joins in the same page.
    setBusy(true);
    let roomTabClaimed = false;
    try {
      if (!(await claimRoomTab(code))) {
        setError('This room is already open in another tab of this browser. Use the existing tab, or leave that room first.');
        setBusy(false);
        return;
      }
      roomTabClaimed = true;
      localName = name;
      currentCode = code;
      requestedRoomMode = roomMode === 'theater' ? 'theater' : 'normal';
      leaving = false;
      retryCount = 0;

      try {
        const r = await fetch('/config', { cache: 'no-store' });
        if (r.ok) config = await r.json();
      } catch (_) { /* fall back to defaults */ }

      localStream = await getLocalMedia();
      applyInitialPrefs();

      showCall(code);
      localTile = buildTile('local', localName, true);
      videoGrid.appendChild(localTile);
      watchSpeaking(localStream, localTile);
      renderLocalTile();
      layoutGrid();

      const { sock, joined } = await openSocket();
      if (sock.readyState !== WebSocket.OPEN) throw new Error('The room connection closed while joining. Please try again.');
      ws = sock;
      myId = joined.id;
      inRoom = true;
      applyRoomMode(joined.roomMode || requestedRoomMode);
      setStatus('CONNECTED', 'ok');
      startHeartbeat(); startStats(); acquireWakeLock();
      joined.peers.forEach((pr) => {
        const p = createPeer(pr.id, pr.name, true);
        if (pr.state && Object.keys(pr.state).length) p.state = pr.state;
      });
      syncTheaterStage();
      sendMyStateTo();
      renderPeople();
      layoutGrid();

      try {
        const u = new URL(location.href); u.searchParams.set('room', code);
        history.replaceState({}, '', u.pathname + u.search + u.hash);
      } catch (_) {}
      toast('You are in. Send your room code to your friends.');
      setBusy(false);
      refreshDevices();
    } catch (error) {
      console.error('ROOM/05 startup:', error);
      inRoom = false;
      stopHeartbeat(); stopStats(); releaseWakeLock();
      if (ws) { const active = ws; ws = null; try { active.close(); } catch (_) {} }
      cleanupMedia();
      if (roomTabClaimed) releaseRoomTab();
      callScreen.classList.add('hidden');
      landing.classList.remove('hidden');
      document.body.classList.remove('in-call');
      videoGrid.innerHTML = '';
      myId = '';
      setBusy(false);
      setError(error && error.message ? error.message : 'Could not start the room. Please try again.');
    }
  }

  function cleanupMedia() {
    clearInterval(roomMusicTimer); roomMusicTimer = null; roomMusicOn = false;
    presentationAudioSources.forEach((source) => { try { source.disconnect(); } catch (_) {} }); presentationAudioSources = []; presentationAudioDestination = null; presentationSharedTrack = null;
    if (theaterMediaUrl) { try { URL.revokeObjectURL(theaterMediaUrl); } catch (_) {} theaterMediaUrl = ''; }
    theaterMediaActive = false;
    [localStream, screenStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
    localStream = null; screenStream = null; localTile = null;
    restoreTheaterStageSource();
  }

  function leaveRoom() {
    leaving = true; inRoom = false; retryCount = 0;
    releaseRoomTab();
    clearTimeout(partyTimer);
    clearTimeout(aartiTimer); aartiTimer = null;
    if (callScreen) callScreen.querySelectorAll('.aarti-orbit').forEach((node) => node.remove());
    roomMusicOn = false; clearInterval(roomMusicTimer); roomMusicTimer = null;
    partyTimer = null;
    callScreen.classList.remove('party');
    document.querySelectorAll('#call-screen .party-banner, #call-screen .confetti').forEach((node) => node.remove());
    if (reactionFloats) reactionFloats.replaceChildren();
    stopHeartbeat(); stopStats(); releaseWakeLock(); document.body.classList.remove('in-call'); pinnedId = null;
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
    if (ws) { const s = ws; ws = null; try { s.close(); } catch (_) {} }
    closeAllPeers();
    cleanupMedia();
    state = { mic: true, cam: true, screen: false, hand: false };
    syncButtons();
    currentCode = ''; myId = '';
    callScreen.classList.add('hidden');
    landing.classList.remove('hidden');
    $('side-panel').classList.add('hidden');
    videoGrid.innerHTML = '';
    videoGrid.classList.remove('aarti-active');
    $('chat-messages').innerHTML = '<div class="chat-empty" id="chat-empty"><span>✳</span><strong>Quiet in here.</strong><p>Start the conversation. Messages disappear when the room closes.</p></div>';
    setBusy(false);
    try { const u = new URL(location.href); u.searchParams.delete('room'); history.replaceState({}, '', u.pathname + u.search + u.hash); } catch (_) {}
  }

  // ---------- controls ----------
  $('toggle-mic').addEventListener('click', async () => {
    let t = audioTrack();
    if (!t) {
      t = await acquireTrack('audio');
      if (!t) { toast('Microphone is blocked or in use. Allow it in your browser, then tap again.'); return; }
      state.mic = true;
      if (presentationSharedTrack) await setPresentationAudio(presentationSharedTrack);
      else await setOutgoingAudio(t);
      syncButtons(); broadcastState(); toast('Microphone connected.'); return;
    }
    state.mic = !state.mic; t.enabled = state.mic; syncButtons(); broadcastState();
  });
  $('toggle-camera').addEventListener('click', async () => {
    let t = cameraTrack();
    if (!t) {
      t = await acquireTrack('video');
      if (!t) { toast('Camera is blocked or in use by another app. Allow it, then tap again.'); return; }
      state.cam = true;
      await setOutgoingVideo(t);
      syncButtons(); broadcastState(); toast('Camera connected.'); return;
    }
    state.cam = !state.cam; t.enabled = state.cam; syncButtons(); broadcastState();
  });
  $('toggle-hand').addEventListener('click', () => { state.hand = !state.hand; syncButtons(); broadcastState(); });

  async function setOutgoingVideo(track) {
    for (const p of peers.values()) {
      try { if (p.vsender) await p.vsender.replaceTrack(track || null); }
      catch (e) { console.warn('camera replaceTrack failed', e); }
    }
  }

  async function setPresentationVideo(track) {
    for (const p of peers.values()) {
      try {
        if (p.screenSender) { await p.screenSender.replaceTrack(track || null); tuneVideoSender(p.screenSender, p, true); }
        else if (p.vsender) await p.vsender.replaceTrack(track || cameraTrack());
      } catch (e) { console.warn('presentation replaceTrack failed', e); }
    }
  }

  async function setOutgoingAudio(track) {
    for (const p of peers.values()) {
      try { if (p.asender) await p.asender.replaceTrack(track || null); }
      catch (e) { console.warn('audio replaceTrack failed', e); }
    }
  }

  async function setPresentationAudio(sharedTrack) {
    presentationAudioSources.forEach((source) => { try { source.disconnect(); } catch (_) {} });
    presentationAudioSources = [];
    presentationAudioDestination = null;
    presentationSharedTrack = sharedTrack || null;
    if (!sharedTrack) {
      await setOutgoingAudio(audioTrack());
      return;
    }
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const destination = audioCtx.createMediaStreamDestination();
      const mic = audioTrack();
      if (mic) {
        const micSource = audioCtx.createMediaStreamSource(new MediaStream([mic]));
        micSource.connect(destination);
        presentationAudioSources.push(micSource);
      }
      const sharedSource = audioCtx.createMediaStreamSource(new MediaStream([sharedTrack]));
      sharedSource.connect(destination);
      presentationAudioSources.push(sharedSource);
      presentationAudioDestination = destination;
      const mixed = destination.stream.getAudioTracks()[0];
      if (mixed) await setOutgoingAudio(mixed);
    } catch (error) {
      console.warn('Presentation audio mixing unavailable:', error);
      presentationAudioDestination = null;
      presentationSharedTrack = null;
      await setOutgoingAudio(audioTrack());
    }
  }

  async function stopScreenShare() {
    const previousStream = screenStream;
    // Switch back first so a browser-generated track-ended event cannot race
    // with the toolbar stop action.
    screenStream = null;
    state.screen = false;
    theaterMediaActive = false;
    if (previousStream) {
      previousStream.getTracks().forEach((t) => {
        t.onended = null;
        if (t.readyState !== 'ended') { try { t.stop(); } catch (_) {} }
      });
    }
    await setPresentationVideo(null);
    await setPresentationAudio(null);
    restoreTheaterStageSource();
    peers.forEach((p) => { if (p.screenSender) tuneVideoSender(p.screenSender, p, true); });
    syncTheaterStage(); syncButtons(); broadcastState();
  }


  const theaterStage = $('theater-stage');
  const theaterStageVideo = $('theater-stage-video');
  const theaterEmpty = $('theater-empty');
  const mediaPicker = $('theater-media-file');
  function applyRoomMode(mode) {
    activeRoomMode = mode === 'theater' ? 'theater' : 'normal';
    callScreen.classList.toggle('theater-mode', activeRoomMode === 'theater');
    $('theater-controls').classList.toggle('hidden', activeRoomMode !== 'theater');
    $('theater-stage').classList.toggle('hidden', activeRoomMode !== 'theater');
    document.body.classList.toggle('theater-room', activeRoomMode === 'theater');
    peers.forEach((p) => renderPeerTile(p));
    syncTheaterStage();
    layoutGrid();
  }

  function restoreTheaterStageSource() {
    if (!theaterStageVideo) return;
    theaterStageVideo.pause();
    theaterStageVideo.removeAttribute('src');
    theaterStageVideo.srcObject = null;
    theaterStageVideo.controls = false;
    if (theaterMediaUrl) { try { URL.revokeObjectURL(theaterMediaUrl); } catch (_) {} theaterMediaUrl = ''; }
  }

  function syncTheaterStage() {
    if (!theaterStageVideo || activeRoomMode !== 'theater') return;
    if (state.screen && screenStream && !theaterMediaActive) {
      if (theaterStageVideo.srcObject !== screenStream) {
        theaterStageVideo.pause();
        theaterStageVideo.removeAttribute('src');
        theaterStageVideo.srcObject = screenStream;
        theaterStageVideo.controls = false;
      }
      theaterStageVideo.muted = true;
      const play = theaterStageVideo.play(); if (play && play.catch) play.catch(() => {});
      theaterStage.classList.add('has-media');
      if (theaterEmpty) theaterEmpty.classList.add('hidden');
      return;
    }
    if (theaterMediaActive) {
      theaterStageVideo.muted = false;
      theaterStage.classList.add('has-media');
      if (theaterEmpty) theaterEmpty.classList.add('hidden');
      theaterStageVideo.controls = true;
      return;
    }
    const presentingPeer = Array.from(peers.values()).find((p) => p.state.screen && p.screenStream.getVideoTracks().some((t) => t.readyState === 'live'));
    if (presentingPeer) {
      if (theaterStageVideo.srcObject !== presentingPeer.screenStream) {
        theaterStageVideo.pause(); theaterStageVideo.removeAttribute('src');
        theaterStageVideo.srcObject = presentingPeer.screenStream;
      }
      theaterStageVideo.controls = false;
      theaterStageVideo.muted = true;
      theaterStage.classList.add('has-media');
      const play = theaterStageVideo.play(); if (play && play.catch) play.catch(() => {});
      if (theaterEmpty) theaterEmpty.classList.add('hidden');
      return;
    }
    theaterStageVideo.pause(); theaterStageVideo.srcObject = null; theaterStage.classList.remove('has-media');
    if (theaterEmpty) theaterEmpty.classList.remove('hidden');
  }

  async function stopTheaterMedia() {
    if (!theaterMediaActive && !screenStream) return;
    const previous = screenStream;
    theaterMediaActive = false;
    screenStream = null;
    state.screen = false;
    if (previous) previous.getTracks().forEach((track) => { track.onended = null; if (track.readyState !== 'ended') { try { track.stop(); } catch (_) {} } });
    await setPresentationVideo(null);
    await setPresentationAudio(null);
    restoreTheaterStageSource();
    if (mediaPicker) mediaPicker.value = '';
    syncTheaterStage(); syncButtons(); renderLocalTile(); broadcastState();
  }

  async function startTheaterMedia(file) {
    if (!file || activeRoomMode !== 'theater') return;
    const otherShare = Array.from(peers.values()).some((p) => p.state.screen);
    if (state.screen || otherShare) { toast('Someone is already presenting. Stop their share before starting another.'); return; }
    const captureMethod = theaterStageVideo.captureStream || theaterStageVideo.mozCaptureStream;
    if (typeof captureMethod !== 'function') { toast('This browser cannot stream a selected video file. Try screen sharing from a supported desktop browser.'); return; }
    restoreTheaterStageSource();
    theaterMediaUrl = URL.createObjectURL(file);
    theaterMediaActive = true;
    theaterStageVideo.src = theaterMediaUrl;
    theaterStageVideo.controls = true;
    theaterStageVideo.playsInline = true;
    // Muted startup is allowed by browser autoplay policies; captured audio is
    // mixed and shared separately after the element has begun playing.
    theaterStageVideo.muted = true;
    try {
      await theaterStageVideo.play();
      await new Promise((resolve, reject) => {
        if (theaterStageVideo.readyState >= 2) { resolve(); return; }
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('The selected video could not be opened.')); };
        const cleanup = () => { theaterStageVideo.removeEventListener('loadeddata', onReady); theaterStageVideo.removeEventListener('error', onError); };
        theaterStageVideo.addEventListener('loadeddata', onReady, { once: true });
        theaterStageVideo.addEventListener('error', onError, { once: true });
      });
      const captured = captureMethod.call(theaterStageVideo);
      const videoTrack = captured.getVideoTracks()[0];
      if (!videoTrack) throw new Error('No video track was created from this file.');
      screenStream = captured;
      videoTrack.contentHint = 'motion';
      videoTrack.onended = () => { if (theaterMediaActive) stopTheaterMedia(); };
      state.screen = true;
      await setPresentationVideo(videoTrack);
      await setPresentationAudio(captured.getAudioTracks()[0] || null);
      syncTheaterStage(); renderLocalTile(); syncButtons(); broadcastState();
      toast('Now playing for the room. The host controls playback.');
    } catch (error) {
      console.warn('Theater media could not start:', error);
      await stopTheaterMedia();
      toast(error && error.name === 'NotAllowedError'
        ? 'The browser blocked automatic playback. Choose the clip again after tapping the player once.'
        : (error.message || 'Could not play that video in Theater mode.'));
    }
  }
  if (mediaPicker) mediaPicker.addEventListener('change', (event) => startTheaterMedia(event.target.files && event.target.files[0]));
  $('choose-theater-media').addEventListener('click', () => { if (mediaPicker) mediaPicker.click(); });
  if (theaterStageVideo) theaterStageVideo.addEventListener('ended', () => { if (theaterMediaActive) stopTheaterMedia(); });

  function screenShareUnavailableMessage() {
    if (!window.isSecureContext) return 'Screen sharing requires this room to be opened over HTTPS.';
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      return 'This mobile browser does not expose app/screen capture to websites. Use a browser/device that offers its native screen picker, or join from desktop.';
    }
    return 'This browser does not provide screen capture. Try an up-to-date browser that supports the native screen picker.';
  }

  async function beginScreenShare() {
    if (state.screen) {
      if (theaterMediaActive) await stopTheaterMedia();
      else await stopScreenShare();
      toast('Sharing stopped.');
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      toast(screenShareUnavailableMessage());
      return;
    }
    let captured = null;
    try {
      // Must run directly from the user's click; the browser owns the source picker.
      try {
        captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 20 } }, audio: true });
      } catch (captureError) {
        if (captureError && ['NotSupportedError', 'TypeError'].includes(captureError.name)) {
          captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 20 } }, audio: false });
        } else throw captureError;
      }
      const track = captured.getVideoTracks()[0];
      if (!track) throw new Error('No screen video track was provided.');
      screenStream = captured;
      theaterMediaActive = false;
      try { track.contentHint = 'detail'; } catch (_) {}
      track.onended = () => { if (state.screen && screenStream === captured) stopScreenShare(); };
      state.screen = true;
      await setPresentationVideo(track);
      await setPresentationAudio(captured.getAudioTracks()[0] || null);
      syncTheaterStage(); renderLocalTile(); broadcastState();
      toast('Screen/app sharing started.');
    } catch (e) {
      if (captured) captured.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      if (screenStream === captured) screenStream = null;
      state.screen = false;
      await setPresentationVideo(null); await setPresentationAudio(null);
      syncTheaterStage(); syncButtons(); renderLocalTile();
      if (e && e.name === 'NotAllowedError') toast('Screen sharing was cancelled or permission was denied.');
      else if (e && e.name === 'NotReadableError') toast('The screen source is busy. Close another capture and try again.');
      else if (e && e.name === 'AbortError') toast('The screen picker was closed.');
      else toast(e && e.message ? e.message : 'Could not start screen sharing.');
    }
  }

  $('toggle-screen').addEventListener('click', beginScreenShare);
  const appShareButton = $('share-app-screen');
  if (appShareButton) appShareButton.addEventListener('click', beginScreenShare);


  // ---------- invite / copy ----------
  $('copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentCode); toast('Room code copied.'); } catch (_) { toast('Your room code is ' + currentCode); }
  });
  $('share-invite').addEventListener('click', async () => {
    const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('room', currentCode);
    try {
      if (navigator.share) await navigator.share({ title: 'Join my ROOM/05', text: 'Join my video room with code ' + currentCode, url: url.toString() });
      else { await navigator.clipboard.writeText(url.toString()); toast('Invite link copied.'); }
    } catch (_) { toast('Room code: ' + currentCode); }
  });

  // ---------- device settings ----------
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (id, kind, fallback) => {
        const sel = $(id); const cur = sel.value;
        sel.innerHTML = '';
        const def = document.createElement('option'); def.value = ''; def.textContent = 'System default'; sel.appendChild(def);
        devices.filter((d) => d.kind === kind).forEach((d, i) => {
          const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (fallback + ' ' + (i + 1)); sel.appendChild(o);
        });
        sel.value = Array.from(sel.options).some((o) => o.value === cur) ? cur : '';
      };
      fill('audio-input-select', 'audioinput', 'Microphone');
      fill('video-input-select', 'videoinput', 'Camera');
      fill('audio-output-select', 'audiooutput', 'Speaker');
    } catch (_) {}
  }

  async function switchInput(kind, deviceId) {
    if (!localStream) return;
    try {
      const constraints = kind === 'audio'
        ? { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: qualityFor(peers.size).w }, height: { ideal: qualityFor(peers.size).h }, frameRate: { ideal: 30 } } };
      const fresh = await navigator.mediaDevices.getUserMedia(constraints);
      const track = fresh.getTracks()[0];
      const old = kind === 'audio' ? audioTrack() : cameraTrack();
      if (old) { localStream.removeTrack(old); old.stop(); }
      track.enabled = kind === 'audio' ? state.mic : state.cam;
      localStream.addTrack(track);
      if (kind === 'audio' && presentationSharedTrack) {
        await setPresentationAudio(presentationSharedTrack);
      } else if (kind === 'audio') {
        await setOutgoingAudio(track);
      } else {
        await setOutgoingVideo(track);
      }
      renderLocalTile();
      refreshDevices();
    } catch (e) { toast('Could not switch that device.'); }
  }
  $('audio-input-select').addEventListener('change', (e) => switchInput('audio', e.target.value));
  $('video-input-select').addEventListener('change', (e) => switchInput('video', e.target.value));
  $('audio-output-select').addEventListener('change', (e) => {
    const id = e.target.value;
    peers.forEach((p) => { const v = p.tile && p.tile.querySelector('video'); if (v && v.setSinkId) v.setSinkId(id).catch(() => toast('This browser cannot change the speaker.')); });
  });
  $('open-settings').addEventListener('click', () => { refreshDevices(); $('settings-overlay').classList.remove('hidden'); });
  $('close-settings').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));
  $('settings-done').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));

  $('quality-select').value = prefs.quality;
  $('quality-select').addEventListener('change', (e) => { prefs.quality = e.target.value; store.set('quality', prefs.quality); retuneAll(); toast('Video quality: ' + e.target.options[e.target.selectedIndex].text); });
  $('opt-mirror').checked = prefs.mirror;
  $('opt-mirror').addEventListener('change', (e) => { prefs.mirror = e.target.checked; store.set('mirror', prefs.mirror ? '1' : '0'); renderLocalTile(); });
  $('opt-sound').checked = prefs.sound;
  $('opt-sound').addEventListener('change', (e) => {
    prefs.sound = e.target.checked; store.set('sound', prefs.sound ? '1' : '0');
    if (prefs.sound) unlockRoomAudio();
    if (!prefs.sound) { roomMusicOn = false; clearInterval(roomMusicTimer); roomMusicTimer = null; }
  });

  // snap a group photo (collage of everyone's current frame)
  $('snap-photo').addEventListener('click', () => {
    try {
      const vids = Array.from(videoGrid.querySelectorAll('.video-tile')).map((t) => ({ v: t.querySelector('video'), name: t.querySelector('.tile-name').textContent, off: t.classList.contains('no-video') }));
      if (!vids.length) return;
      const cols = vids.length === 1 ? 1 : vids.length <= 4 ? 2 : 3;
      const rows = Math.ceil(vids.length / cols);
      const cw = 640, ch = 360, pad = 12, head = 56;
      const c = document.createElement('canvas');
      c.width = cols * cw + (cols + 1) * pad; c.height = rows * ch + (rows + 1) * pad + head;
      const ctx = c.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      ctx.fillStyle = css.getPropertyValue('--paper').trim() || '#e9e6dc'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = css.getPropertyValue('--ink').trim() || '#171916'; ctx.font = '700 26px sans-serif';
      ctx.fillText('ROOM/05  ·  ' + currentCode + '  ·  ' + new Date().toLocaleString(), pad, 38);
      vids.forEach((o, i) => {
        const x = pad + (i % cols) * (cw + pad), y = head + pad + Math.floor(i / cols) * (ch + pad);
        ctx.fillStyle = '#20231f'; ctx.fillRect(x, y, cw, ch);
        if (!o.off && o.v.videoWidth) {
          const r = Math.max(cw / o.v.videoWidth, ch / o.v.videoHeight), w = o.v.videoWidth * r, h = o.v.videoHeight * r;
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip(); ctx.drawImage(o.v, x + (cw - w) / 2, y + (ch - h) / 2, w, h); ctx.restore();
        }
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x, y + ch - 36, cw, 36);
        ctx.fillStyle = '#fff'; ctx.font = '600 20px sans-serif'; ctx.fillText(o.name, x + 12, y + ch - 11);
      });
      const flash = document.createElement('div'); flash.className = 'snap-flash'; document.body.appendChild(flash); setTimeout(() => flash.remove(), 500);
      c.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'room05-' + Date.now() + '.png';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('Group photo saved 📸');
      }, 'image/png');
    } catch (e) { toast('Could not take the photo.'); }
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!inRoom || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    const map = { m: 'toggle-mic', v: 'toggle-camera', s: 'toggle-screen', h: 'toggle-hand', c: 'open-chat', p: 'open-people' };
    if (map[k]) { e.preventDefault(); $(map[k]).click(); }
    else if (k === 'f') { e.preventDefault(); if (fsBtn && fsSupported) toggleFullscreen(); else tileFullscreen(videoGrid.querySelector('.video-tile.pinned') || localTile); }
    else if (k === 'g') { e.preventDefault(); $('snap-photo').click(); }
    else if (k === 'escape') { $('settings-overlay').classList.add('hidden'); }
  });

  // ---------- fullscreen (call room only) ----------
  // Fullscreen the call screen, not the document: the landing header must not
  // appear above the LIVE ROOM bar or create a doubled toolbar.
  const fsRoot = callScreen;
  const fsSupported = !!(fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen);
  function isFs() {
    return document.fullscreenElement === fsRoot || document.webkitFullscreenElement === fsRoot;
  }
  async function toggleFullscreen() {
    try {
      const activeElement = document.fullscreenElement || document.webkitFullscreenElement;
      if (activeElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } else if (fsRoot.requestFullscreen) {
        await fsRoot.requestFullscreen({ navigationUI: 'hide' });
      } else if (fsRoot.webkitRequestFullscreen) {
        fsRoot.webkitRequestFullscreen();
      } else {
        toast('Fullscreen is not available here.');
      }
    } catch (_) {
      toast('Fullscreen is not available here.');
    }
  }
  const fsBtn = $('toggle-fullscreen');
  if (fsBtn) {
    if (!fsSupported) fsBtn.style.display = 'none';
    else fsBtn.addEventListener('click', toggleFullscreen);
    const sync = () => {
      const active = isFs();
      fsRoot.classList.toggle('is-fullscreen', active);
      fsBtn.title = active ? 'Exit fullscreen' : 'Fullscreen';
      fsBtn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Toggle fullscreen');
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
  }

  // ---------- party mode, airhorn, icebreakers, tile filters ----------
  function party() {
    if (!callScreen || callScreen.classList.contains('hidden')) return;
    callScreen.classList.add('party');
    callScreen.querySelectorAll('.party-banner').forEach((n) => n.remove());
    const b = document.createElement('div');
    b.className = 'party-banner';
    b.textContent = '🪩 PARTY MODE';
    callScreen.appendChild(b);
    confetti();
    setTimeout(() => { if (callScreen && !callScreen.classList.contains('hidden')) confetti(); }, 700);
    setTimeout(() => { if (callScreen && !callScreen.classList.contains('hidden')) confetti(); }, 1500);
    buzz([30, 40, 30, 40, 60]);
    blip('join');
    clearTimeout(partyTimer);
    partyTimer = setTimeout(() => {
      callScreen.classList.remove('party');
      b.remove();
      partyTimer = null;
    }, 9000);
  }
  const chineseHornAudio = new Audio('/chinese-meme-horn.wav');
  chineseHornAudio.preload = 'auto';
  chineseHornAudio.volume = 0.78;
  function airhorn() {
    if (!prefs.sound) return;
    unlockRoomAudio();
    try {
      chineseHornAudio.pause();
      chineseHornAudio.currentTime = 0;
      const playback = chineseHornAudio.play();
      if (playback && playback.catch) playback.catch(() => playFallbackHorn());
      buzz([55, 35, 55]);
    } catch (_) { playFallbackHorn(); }
  }
  function playFallbackHorn() {
    // Original synthesized classic meme airhorn: bright, brassy, layered blast.
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t0 = ctx.currentTime + 0.015;
      const master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-12, t0);
      limiter.knee.setValueAtTime(8, t0);
      limiter.ratio.setValueAtTime(8, t0);
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.exponentialRampToValueAtTime(0.48, t0 + 0.025);
      master.gain.setValueAtTime(0.42, t0 + 1.15);
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.72);
      master.connect(limiter); limiter.connect(ctx.destination);

      // A tightly stacked major-brass chord creates the familiar BWAAAH tone.
      [440, 554.37, 659.25].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const voice = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, t0);
        osc.detune.setValueAtTime(i === 0 ? -5 : (i === 2 ? 5 : 0), t0);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2100 - i * 180, t0);
        filter.Q.setValueAtTime(1.2, t0);
        voice.gain.setValueAtTime(0.0001, t0);
        voice.gain.exponentialRampToValueAtTime(i === 0 ? 0.24 : 0.16, t0 + 0.025);
        voice.gain.setValueAtTime(i === 0 ? 0.24 : 0.16, t0 + 1.18);
        voice.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.72);
        osc.connect(filter); filter.connect(voice); voice.connect(master);
        osc.start(t0); osc.stop(t0 + 1.74);
      });

      // Short repeated stabs give it the punchy viral airhorn rhythm.
      [0.00, 0.48, 0.96].forEach((offset) => {
        const stab = ctx.createGain();
        stab.gain.setValueAtTime(0.0001, t0 + offset);
        stab.gain.exponentialRampToValueAtTime(1, t0 + offset + 0.018);
        stab.gain.setValueAtTime(1, t0 + offset + 0.22);
        stab.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.30);
        // The envelope briefly gates the shared chord without adding another sound.
        const gate = ctx.createOscillator();
        gate.type = 'sine'; gate.frequency.setValueAtTime(1, t0 + offset);
        gate.connect(stab); gate.start(t0 + offset); gate.stop(t0 + offset + 0.31);
      });
      buzz([60, 40, 60]);
    } catch (_) {}
  }

  function floatReaction(emoji, name) {
    if (!reactionFloats || !emoji) return;
    const pop = document.createElement('div');
    pop.className = 'room05-reaction-pop';
    pop.style.setProperty('--room05-reaction-x', (16 + Math.random() * 68).toFixed(1) + '%');
    const glyph = document.createElement('span');
    glyph.className = 'room05-reaction-glyph';
    glyph.textContent = emoji;
    const label = document.createElement('span');
    label.className = 'room05-reaction-label';
    label.textContent = name || 'ROOM';
    pop.append(glyph, label);
    reactionFloats.appendChild(pop);
    window.setTimeout(() => pop.remove(), 3100);
  }

  function playAartiBgm() {
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const start = ctx.currentTime + 0.04;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, start);
      master.gain.exponentialRampToValueAtTime(0.035, start + 0.65);
      master.gain.setValueAtTime(0.035, start + 5.8);
      master.gain.exponentialRampToValueAtTime(0.0001, start + 7.4);
      master.connect(ctx.destination);

      // A soft original drone with spaced bell notes; no external audio dependency.
      [110, 164.81, 220].forEach((frequency, index) => {
        const oscillator = ctx.createOscillator();
        const voice = ctx.createGain();
        oscillator.type = index === 0 ? 'sine' : 'triangle';
        oscillator.frequency.setValueAtTime(frequency, start);
        voice.gain.setValueAtTime(index === 0 ? 0.38 : 0.16, start);
        oscillator.connect(voice); voice.connect(master);
        oscillator.start(start); oscillator.stop(start + 7.5);
      });
      [0, 1.75, 3.5, 5.25].forEach((offset, index) => {
        const bell = ctx.createOscillator();
        const envelope = ctx.createGain();
        bell.type = 'sine';
        bell.frequency.setValueAtTime([659.25, 783.99, 987.77, 783.99][index], start + offset);
        envelope.gain.setValueAtTime(0.0001, start + offset);
        envelope.gain.exponentialRampToValueAtTime(0.22, start + offset + 0.018);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + offset + 1.25);
        bell.connect(envelope); envelope.connect(master);
        bell.start(start + offset); bell.stop(start + offset + 1.3);
      });
    } catch (_) { /* sound is decorative; keep the visual effect working */ }
  }

  function aartiMode() {
    if (!callScreen || callScreen.classList.contains('hidden')) return;
    callScreen.querySelectorAll('.aarti-orbit').forEach((node) => node.remove());
    const orbit = document.createElement('div');
    orbit.className = 'aarti-orbit';
    orbit.setAttribute('aria-hidden', 'true');
    const diya = document.createElement('span');
    diya.className = 'aarti-diya';
    diya.textContent = '🪔';
    orbit.appendChild(diya);
    callScreen.appendChild(orbit);
    videoGrid.classList.add('aarti-active');
    playAartiBgm();
    clearTimeout(aartiTimer);
    aartiTimer = window.setTimeout(() => {
      orbit.remove();
      videoGrid.classList.remove('aarti-active');
      aartiTimer = null;
    }, 15000);
  }

  function toggleRoomMusic() {
    if (roomMusicOn) {
      roomMusicOn = false;
      clearInterval(roomMusicTimer);
      roomMusicTimer = null;
      return;
    }
    if (!prefs.sound) return;
    unlockRoomAudio();
    roomMusicOn = true;
    const playBar = () => {
      if (!roomMusicOn || !prefs.sound) return;
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const ctx = audioCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const start = ctx.currentTime + 0.035;
        [220, 261.63, 329.63, 261.63].forEach((frequency, index) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const at = start + index * 0.82;
          osc.type = 'sine'; osc.frequency.setValueAtTime(frequency, at);
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.026, at + 0.035);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.72);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(at); osc.stop(at + 0.74);
        });
      } catch (_) { /* optional room ambience */ }
    };
    playBar();
    roomMusicTimer = window.setInterval(playBar, 3400);
  }

  function activateReaction(emoji, name) {
    if (!emoji) return;
    if (emoji === '🪔') { aartiMode(); return; }
    floatReaction(emoji, name);
    if (emoji === '🪩') party();
    else if (emoji === '📢') airhorn();
    else if (emoji === '🎵') toggleRoomMusic();
  }

  document.querySelectorAll('[data-reaction]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!ws || ws.readyState !== 1) { toast('Join a room before reacting.'); return; }
      const emoji = button.dataset.reaction;
      activateReaction(emoji, localName + ' (YOU)');
      try { ws.send(JSON.stringify({ type: 'reaction', emoji })); } catch (_) {}
    });
  });

  const ICEBREAKERS = ['Hot take: pineapple on pizza — yes or no?', 'What song is stuck in your head right now?', 'Worst haircut you ever had. Go.', 'Which app do you open first every morning?', 'What is the most useless skill you have?', 'Superpower you would pick but only for 5 minutes?', 'Last thing you watched that you could not stop talking about?', 'Describe your week as a movie title.', 'Cereal: milk first or cereal first?', 'What would your walk-up song be?', 'Unpopular opinion you will defend forever?', 'What emoji is your whole personality?', 'Dream trip if money did not matter?', 'Most random thing in your camera roll right now?', 'If we all started a band, what instrument are you?', 'What is your comfort show?', 'Rate your Wi-Fi from 1 to 10. Be honest.', 'What is a tiny thing that made you happy today?', 'Pick one: only text or only calls forever?', 'What is the weirdest food combo you secretly love?'];
  const icebreakerBtn = $('icebreaker');
  if (icebreakerBtn) icebreakerBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== 1) return;
    const text = '🎲 ' + ICEBREAKERS[(Math.random() * ICEBREAKERS.length) | 0];
    ws.send(JSON.stringify({ type: 'chat', text })); appendChat(localName + ' (YOU)', text);
  });
  const FILTERS = [['none', 'Normal'], ['grayscale(1) contrast(1.1)', 'Noir'], ['sepia(.9) contrast(1.05)', 'Old film'], ['hue-rotate(90deg) saturate(1.6)', 'Alien'], ['saturate(2.2) contrast(1.15)', 'Pop'], ['invert(1) hue-rotate(180deg)', 'Negative'], ['contrast(1.4) saturate(1.8) hue-rotate(-30deg)', 'Neon'], ['saturate(1.55) hue-rotate(-24deg) contrast(1.08)', 'Sunset glow'], ['blur(.35px) saturate(1.75) brightness(1.14)', 'Dreamcore'], ['contrast(1.45) saturate(1.35) hue-rotate(155deg)', 'Glitchwave']];
  function cycleFilter(tile) {
    const v = tile.querySelector('video'); if (!v) return;
    const i = ((Number(tile.dataset.filter || 0)) + 1) % FILTERS.length;
    tile.dataset.filter = String(i);
    v.style.filter = FILTERS[i][0] === 'none' ? '' : FILTERS[i][0];
    toast('Filter: ' + FILTERS[i][1] + ' (only you see this)');
  }
  window.__room05Filter = cycleFilter;

  buildThemePickers();

  // ---------- landing wiring ----------
  let selectedRoomMode = 'normal';
  document.querySelectorAll('[data-create-mode]').forEach((button) => button.addEventListener('click', () => {
    selectedRoomMode = button.dataset.createMode === 'theater' ? 'theater' : 'normal';
    document.querySelectorAll('[data-create-mode]').forEach((item) => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
  }));
  createButton.addEventListener('click', () => {
    unlockRoomAudio();
    try { enterRoom(makeCode(), selectedRoomMode); } catch (e) { setError(e.message || 'Could not create a room code.'); }
  });
  joinButton.addEventListener('click', () => { unlockRoomAudio(); enterRoom($('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '')); });
  $('room-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
  $('room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinButton.click(); });
  $('display-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('room-code').value ? joinButton : createButton).click(); });

  const initial = new URLSearchParams(location.search).get('room');
  if (initial && CODE_RE.test(initial.toUpperCase())) $('room-code').value = initial.toUpperCase();

  window.addEventListener('beforeunload', () => {
    releaseRoomTab();
    if (ws) { try { ws.close(); } catch (_) {} }
  });

  // Wake a sleeping free Render instance as soon as the page opens.
  fetch('/health', { cache: 'no-store' }).catch(() => {});
})();
