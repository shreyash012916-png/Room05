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
  const errorBox = $('landing-error');
  const createButton = $('create-room');
  const joinButton = $('join-room');

  let config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxPeople: 5 };
  let ws = null;
  let myId = '';
  let currentCode = '';
  let localName = '';
  let localStream = null;      // camera + mic
  let screenStream = null;
  let peers = new Map();       // id -> {id, name, pc, polite, makingOffer, ignoreOffer, stream, state, vsender, asender, tile}
  let state = { mic: true, cam: true, screen: false, hand: false };
  let inRoom = false;
  let entering = false;
  let leaving = false;
  let retryCount = 0;
  let reconnectTask = null;
  let toastTimer = null;
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

  // tiny haptics + sound blips (no audio files needed)
  function buzz(ms) { if (prefs.sound && navigator.vibrate) { try { navigator.vibrate(ms || 8); } catch (_) {} } }
  function blip(kind) {
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
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
    if (q === 'max') return { w: 1920, h: 1080, fps: 30, bitrate: 4500000 };
    if (q === 'data') return { w: 640, h: 360, fps: 24, bitrate: 450000 };
    if (q === 'hd') return { w: 1280, h: 720, fps: 30, bitrate: 2200000 };
    // auto: the more people, the more everyone uploads, so share the upload budget
    if (peerCount <= 1) return { w: 1920, h: 1080, fps: 30, bitrate: 4000000 };
    if (peerCount === 2) return { w: 1280, h: 720, fps: 30, bitrate: 2200000 };
    if (peerCount === 3) return { w: 1280, h: 720, fps: 30, bitrate: 1600000 };
    return { w: 960, h: 540, fps: 30, bitrate: 1100000 };
  }
  function retuneAll() {
    const q = qualityFor(peers.size);
    peers.forEach((p) => { if (p.vsender) tuneVideoSender(p.vsender); });
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
    const vt = outgoingVideoTrack();
    if (vt) display.addTrack(vt);
    const v = localTile.querySelector('video');
    if (!v.srcObject || v.dataset.vt !== (vt ? vt.id : '')) { v.srcObject = display; v.dataset.vt = vt ? vt.id : ''; }
    v.classList.toggle('self-video', !state.screen && prefs.mirror);
    const hasVideo = !!vt && vt.readyState === 'live' && (state.cam || state.screen);
    localTile.classList.toggle('no-video', !hasVideo);
    localTile.querySelector('.hand-flag').classList.toggle('hidden', !state.hand);
    v.classList.toggle('screen-track', state.screen);
    const s = localTile.querySelector('.tile-status');
    s.textContent = (state.screen ? 'SHARING · ' : '') + (state.mic ? 'MIC ON' : 'MUTED');
    s.classList.toggle('muted', !state.mic);
  }

  function renderPeerTile(p) {
    if (!p.tile) return;
    paintTile(p.tile, p.state, p.stream, p.connState && p.connState !== 'connected' ? p.connState.toUpperCase() : '');
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
  async function attachSenders(p, at, vt) {
    p.asender = at ? at.sender : null;
    p.vsender = vt ? vt.sender : null;
    p.attached = true;
    const jobs = [];
    if (p.asender && audioTrack() && p.asender.track !== audioTrack()) jobs.push(p.asender.replaceTrack(audioTrack()));
    if (p.vsender && outgoingVideoTrack() && p.vsender.track !== outgoingVideoTrack()) jobs.push(p.vsender.replaceTrack(outgoingVideoTrack()));
    try { await Promise.all(jobs); } catch (e) { console.warn('attach failed', e); }
    if (p.asender) tuneAudioSender(p.asender);
    if (p.vsender) tuneVideoSender(p.vsender);
  }

  // The newcomer always makes the first offer; the people already in the room just answer. No collisions, no lost media.
  async function attachFromOffer(p) {
    const ts = p.pc.getTransceivers();
    const find = (kind) => ts.find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === kind && !t.stopped);
    const at = find('audio'), vt = find('video');
    [at, vt].forEach((t) => { if (t) { try { t.direction = 'sendrecv'; } catch (_) {} } });
    await attachSenders(p, at, vt);
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
    const pc = new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 4 });
    const p = { id, name, pc, polite: myId > id, initiator: !!initiator, makingOffer: false, ignoreOffer: false, stream: new MediaStream(), state: { mic: true, cam: true, screen: false, hand: false }, vsender: null, asender: null, tile: null, connState: 'connecting', queue: Promise.resolve(), pendingCandidates: [], attached: false, watchdog: null };
    peers.set(id, p);

    if (initiator) {
      const at = audioTrack(), vt = outgoingVideoTrack();
      const ta = at ? pc.addTransceiver(at, { direction: 'sendrecv', streams: [localStream] }) : pc.addTransceiver('audio', { direction: 'sendrecv' });
      const tv = vt ? pc.addTransceiver(vt, { direction: 'sendrecv', streams: [localStream] }) : pc.addTransceiver('video', { direction: 'sendrecv' });
      p.asender = ta.sender; p.vsender = tv.sender; p.attached = true;
    }

    pc.ontrack = ({ track }) => {
      p.stream.addTrack(track);
      track.onended = () => { try { p.stream.removeTrack(track); } catch (_) {} renderPeerTile(p); };
      track.onmute = () => renderPeerTile(p);
      track.onunmute = () => renderPeerTile(p);
      if (!p.tile) {
        p.tile = buildTile(id, p.name, false);
        videoGrid.appendChild(p.tile);
        watchSpeaking(p.stream, p.tile);
        layoutGrid();
        renderPeople();
      }
      const v = p.tile.querySelector('video');
      v.onloadedmetadata = v.onresize = v.onplaying = () => renderPeerTile(p);
      v.srcObject = p.stream; // re-attach so every browser (Safari included) picks up late tracks
      renderPeerTile(p);
      const sink = $('audio-output-select').value;
      if (sink && v.setSinkId) v.setSinkId(sink).catch(() => {});
      const playing = v.play(); if (playing && playing.catch) playing.catch(() => {});
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
        if (p.vsender) tuneVideoSender(p.vsender);
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
    watchPeer(p, 0);
    return p;
  }

  function tuneVideoSender(sender) {
    try {
      const q = qualityFor(peers.size);
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = state.screen ? Math.max(q.bitrate, 3000000) : q.bitrate;
      params.encodings[0].maxFramerate = q.fps;
      params.encodings[0].networkPriority = 'high';
      params.degradationPreference = state.screen ? 'maintain-resolution' : 'balanced';
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
        sock.send(JSON.stringify({ type: 'join', room: currentCode, name: localName, sessionId: CLIENT_SESSION_ID }));
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
      case 'state': {
        const p = peers.get(m.id);
        if (p) { p.state = m.state; renderPeerTile(p); renderPeople(); }
        break;
      }
      case 'chat': appendChat(m.name, m.text); notifyChat(); blip('ping'); break;
      case 'reaction': floatReaction(m.emoji, m.name); break;
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
        opened.joined.peers.forEach((pr) => {
          const peer = createPeer(pr.id, pr.name, true);
          if (pr.state && Object.keys(pr.state).length) peer.state = pr.state;
        });
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && inRoom) { acquireWakeLock(); if (ws && ws.readyState !== 1) { try { ws.close(); } catch (_) {} } } });
  window.addEventListener('online', () => { if (inRoom) { toast('Back online — reconnecting…'); if (ws && ws.readyState !== 1) { try { ws.close(); } catch (_) {} } } });
  window.addEventListener('offline', () => { if (inRoom) { setStatus('OFFLINE', 'warn'); toast('You are offline.'); } });

  function startStats() {
    stopStats();
    statsTimer = setInterval(async () => {
      let worstRtt = 0, any = false, lossHigh = false;
      for (const p of peers.values()) {
        try {
          const stats = await p.pc.getStats();
          stats.forEach((r) => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && typeof r.currentRoundTripTime === 'number') { any = true; worstRtt = Math.max(worstRtt, r.currentRoundTripTime * 1000); }
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.packetsReceived > 100 && r.packetsLost / (r.packetsReceived + r.packetsLost) > 0.08) lossHigh = true;
          });
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

  async function enterRoom(code) {
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
      setStatus('CONNECTED', 'ok');
      startHeartbeat(); startStats(); acquireWakeLock();
      joined.peers.forEach((pr) => {
        const p = createPeer(pr.id, pr.name, true);
        if (pr.state && Object.keys(pr.state).length) p.state = pr.state;
      });
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
    [localStream, screenStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
    localStream = null; screenStream = null; localTile = null;
  }

  function leaveRoom() {
    leaving = true; inRoom = false; retryCount = 0;
    releaseRoomTab();
    document.body.classList.remove('party');
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
      for (const p of peers.values()) { if (p.asender) { try { await p.asender.replaceTrack(t); } catch (_) {} } }
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
      if (!state.screen) await setOutgoingVideo(t);
      syncButtons(); broadcastState(); toast('Camera connected.'); return;
    }
    state.cam = !state.cam; t.enabled = state.cam; syncButtons(); broadcastState();
  });
  $('toggle-hand').addEventListener('click', () => { state.hand = !state.hand; syncButtons(); broadcastState(); });

  async function setOutgoingVideo(track) {
    for (const p of peers.values()) {
      try {
        if (p.vsender) { await p.vsender.replaceTrack(track); }
      } catch (e) { console.warn('replaceTrack failed', e); }
    }
  }

  async function stopScreenShare() {
    const previousStream = screenStream;
    // Switch back first so a browser-generated track-ended event cannot race
    // with the toolbar stop action.
    screenStream = null;
    state.screen = false;
    if (previousStream) {
      previousStream.getTracks().forEach((t) => {
        t.onended = null;
        if (t.readyState !== 'ended') { try { t.stop(); } catch (_) {} }
      });
    }
    await setOutgoingVideo(cameraTrack());
    peers.forEach((p) => { if (p.vsender) tuneVideoSender(p.vsender); });
    syncButtons(); broadcastState();
  }

  function screenShareUnavailableMessage() {
    if (!window.isSecureContext) return 'Screen sharing requires this room to be opened over HTTPS.';
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      return 'Screen sharing is not available in mobile browser websites on this device. Join from a supported desktop browser to share your screen.';
    }
    return 'This browser does not provide screen capture. Try an up-to-date desktop version of Chrome, Edge, Firefox, or Safari.';
  }

  $('toggle-screen').addEventListener('click', async () => {
    if (state.screen) { await stopScreenShare(); toast('Screen sharing stopped.'); return; }
    if (!window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      toast(screenShareUnavailableMessage());
      return;
    }
    let captured = null;
    try {
      // getDisplayMedia must be called directly from this button gesture.
      captured = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false
      });
      const track = captured.getVideoTracks()[0];
      if (!track) throw new Error('No screen video track was provided.');
      screenStream = captured;
      try { track.contentHint = 'detail'; } catch (_) {}
      track.onended = () => {
        if (state.screen && screenStream === captured) stopScreenShare();
      };
      state.screen = true;
      await setOutgoingVideo(track);
      peers.forEach((p) => { if (p.vsender) tuneVideoSender(p.vsender); });
      syncButtons(); broadcastState();
      toast('Screen sharing started.');
    } catch (e) {
      if (captured) captured.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      if (screenStream === captured) screenStream = null;
      state.screen = false;
      syncButtons(); renderLocalTile();
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Could not start screen sharing. Check browser permissions and try again.');
    }
  });

  $('leave-room').addEventListener('click', leaveRoom);

  function openPanel(type) {
    $('side-panel').classList.remove('hidden');
    const people = type === 'people';
    $('people-view').classList.toggle('hidden', !people);
    $('chat-view').classList.toggle('hidden', people);
    $('panel-kicker').textContent = people ? 'THE ROOM' : 'LIVE CONVERSATION';
    $('panel-title').childNodes[0].textContent = people ? 'People ' : 'Chat ';
    if (!people) $('chat-input').focus();
  }
  $('open-people').addEventListener('click', () => openPanel('people'));
  $('open-chat').addEventListener('click', () => openPanel('chat'));
  $('close-panel').addEventListener('click', () => $('side-panel').classList.add('hidden'));

  // ---------- chat & reactions ----------
  function appendChat(name, message) {
    const list = $('chat-messages');
    const empty = $('chat-empty'); if (empty) empty.remove();
    const item = document.createElement('div');
    item.className = 'chat-message';
    const a = document.createElement('strong'); a.textContent = name;
    const b = document.createElement('p'); b.textContent = message;
    item.append(a, b); list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }
  function notifyChat() { if ($('side-panel').classList.contains('hidden') || $('chat-view').classList.contains('hidden')) toast('New chat message'); }

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', text }));
    appendChat(localName + ' (YOU)', text);
    input.value = '';
  });

  function floatReaction(emoji, name) {
    const box = $('reaction-floats');
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    const sm = document.createElement('small'); sm.textContent = name || ''; el.appendChild(sm);
    box.appendChild(el);
    setTimeout(() => el.remove(), 2700);
    if (emoji === '🎉') confetti();
    else if (emoji === '🪩') party();
    else if (emoji === '📢') airhorn();
    else if (box.children.length > 12) box.firstChild.remove();
  }
  function confetti() {
    try {
      const c = document.createElement('canvas'); c.className = 'confetti';
      c.width = innerWidth; c.height = innerHeight; document.body.appendChild(c);
      const ctx = c.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      const colors = [css.getPropertyValue('--acid').trim(), css.getPropertyValue('--red').trim(), css.getPropertyValue('--blue').trim(), '#ffffff', '#ffd23f'];
      const bits = Array.from({ length: 140 }, () => ({ x: innerWidth / 2, y: innerHeight * 0.75, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 18 - 6, s: Math.random() * 7 + 4, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0] }));
      const t0 = performance.now();
      (function frame(now) {
        const age = now - t0; ctx.clearRect(0, 0, c.width, c.height);
        bits.forEach((b) => { b.vy += 0.5; b.x += b.vx; b.y += b.vy; b.r += b.vr; ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.globalAlpha = Math.max(0, 1 - age / 2600); ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6); ctx.restore(); });
        if (age < 2600) requestAnimationFrame(frame); else c.remove();
      })(t0);
    } catch (_) {}
  }

  document.querySelectorAll('[data-reaction]').forEach((b) => b.addEventListener('click', () => {
    if (!ws || ws.readyState !== 1) return;
    const emoji = b.dataset.reaction;
    ws.send(JSON.stringify({ type: 'reaction', emoji }));
    floatReaction(emoji, 'You');
  }));

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
      for (const p of peers.values()) {
        if (kind === 'audio') { if (p.asender) await p.asender.replaceTrack(track); }
        else if (!state.screen) { if (p.vsender) await p.vsender.replaceTrack(track); }
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
  $('opt-sound').addEventListener('change', (e) => { prefs.sound = e.target.checked; store.set('sound', prefs.sound ? '1' : '0'); });

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
  let partyTimer = null;
  function party() {
    document.body.classList.add('party');
    document.querySelectorAll('.party-banner').forEach((n) => n.remove());
    const b = document.createElement('div'); b.className = 'party-banner'; b.textContent = '🪩 PARTY MODE'; document.body.appendChild(b);
    confetti(); setTimeout(confetti, 700); setTimeout(confetti, 1500);
    buzz([30, 40, 30, 40, 60]); blip('join');
    clearTimeout(partyTimer);
    partyTimer = setTimeout(() => { document.body.classList.remove('party'); b.remove(); }, 9000);
  }
  function airhorn() {
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime;
      [0, 0.28, 0.56].forEach((d, i) => {
        [440, 554, 659].forEach((f) => {
          const o = audioCtx.createOscillator(), g = audioCtx.createGain();
          o.type = 'sawtooth'; o.frequency.setValueAtTime(f * 0.97, t0 + d); o.frequency.linearRampToValueAtTime(f * (i === 2 ? 1.1 : 1), t0 + d + 0.05);
          g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.07, t0 + d + 0.02); g.gain.setValueAtTime(0.07, t0 + d + (i === 2 ? 0.5 : 0.18)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + (i === 2 ? 0.7 : 0.24));
          o.connect(g); g.connect(audioCtx.destination); o.start(t0 + d); o.stop(t0 + d + 0.75);
        });
      });
      buzz([60, 40, 60]);
    } catch (_) {}
  }
  const ICEBREAKERS = ['Hot take: pineapple on pizza — yes or no?', 'What song is stuck in your head right now?', 'Worst haircut you ever had. Go.', 'Which app do you open first every morning?', 'What is the most useless skill you have?', 'Superpower you would pick but only for 5 minutes?', 'Last thing you watched that you could not stop talking about?', 'Describe your week as a movie title.', 'Cereal: milk first or cereal first?', 'What would your walk-up song be?', 'Unpopular opinion you will defend forever?', 'What emoji is your whole personality?', 'Dream trip if money did not matter?', 'Most random thing in your camera roll right now?', 'If we all started a band, what instrument are you?', 'What is your comfort show?', 'Rate your Wi-Fi from 1 to 10. Be honest.', 'What is a tiny thing that made you happy today?', 'Pick one: only text or only calls forever?', 'What is the weirdest food combo you secretly love?'];
  const icebreakerBtn = $('icebreaker');
  if (icebreakerBtn) icebreakerBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== 1) return;
    const text = '🎲 ' + ICEBREAKERS[(Math.random() * ICEBREAKERS.length) | 0];
    ws.send(JSON.stringify({ type: 'chat', text })); appendChat(localName + ' (YOU)', text);
  });
  const FILTERS = [['none', 'Normal'], ['grayscale(1) contrast(1.1)', 'Noir'], ['sepia(.9) contrast(1.05)', 'Old film'], ['hue-rotate(90deg) saturate(1.6)', 'Alien'], ['saturate(2.2) contrast(1.15)', 'Pop'], ['invert(1) hue-rotate(180deg)', 'Negative'], ['contrast(1.4) saturate(1.8) hue-rotate(-30deg)', 'Neon']];
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
  createButton.addEventListener('click', () => {
    try { enterRoom(makeCode()); } catch (e) { setError(e.message || 'Could not create a room code.'); }
  });
  joinButton.addEventListener('click', () => enterRoom($('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
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
