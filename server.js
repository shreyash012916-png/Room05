'use strict';
/*
 * ROOM/05 — peer-to-peer video rooms.
 * The server serves the site, relays small WebRTC signaling messages, and
 * handles username/password accounts. Audio and video remain browser-to-browser.
 * Account records live in DATA_DIR; on Render this is the attached persistent disk.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const requestedMax = Number(process.env.MAX_PEOPLE || 5);
const MAX_PEOPLE = Number.isFinite(requestedMax) ? Math.min(5, Math.max(2, Math.floor(requestedMax))) : 5;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || (process.env.RENDER ? '/var/data' : path.join(ROOT, 'data'));
const ACCOUNTS_FILE = path.join(DATA_DIR, 'room05-accounts.json');
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'room05-session-secret');
const TERMS_VERSION = '1.0';
const PRIVACY_VERSION = '1.1';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const PUBLIC_FILES = ['index.html', 'style.css', 'auth.css', 'auth.js', 'main.js', 'legal.css', 'terms.html', 'privacy.html', 'favicon.svg'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let accountStore = { version: 1, users: [] };
let sessionSecret = null;
let writeQueue = Promise.resolve();
const authAttempts = new Map();

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-cache',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
    ...extra
  });
  res.end(data);
}

function json(res, status, value, extra = {}) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
}

async function initialiseAccountStore() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.promises.readFile(ACCOUNTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users)) throw new Error('Account store has an unsupported or invalid format.');
    accountStore = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.promises.writeFile(ACCOUNTS_FILE, JSON.stringify(accountStore, null, 2), { mode: 0o600 });
  }
  try {
    sessionSecret = await fs.promises.readFile(SESSION_SECRET_FILE);
    if (sessionSecret.length < 32) throw new Error('Session secret file is invalid.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sessionSecret = crypto.randomBytes(48);
    await fs.promises.writeFile(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600, flag: 'wx' }).catch(async (writeError) => {
      if (writeError.code !== 'EEXIST') throw writeError;
      sessionSecret = await fs.promises.readFile(SESSION_SECRET_FILE);
      if (sessionSecret.length < 32) throw new Error('Session secret file is invalid.');
    });
  }
}

function persistAccountStore() {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const temp = `${ACCOUNTS_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(accountStore, null, 2), { mode: 0o600 });
    await fs.promises.rename(temp, ACCOUNTS_FILE);
  });
  return writeQueue;
}

function clean(v, n) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
}

function normaliseUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-zA-Z0-9_.-]{3,24}$/.test(String(value || ''));
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > limit) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(Object.assign(new Error('Invalid JSON request.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return !!host && originHost === host;
  } catch (_) { return false; }
}

function rateLimitAuth(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const active = (authAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (active.length >= 20) return false;
  active.push(now);
  authAttempts.set(ip, active);
  return true;
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const at = cookie.indexOf('=');
    if (at < 0) continue;
    if (cookie.slice(0, at).trim() === name) return cookie.slice(at + 1).trim();
  }
  return '';
}

function signSession(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getSessionUser(req) {
  const token = cookieValue(req, 'room05_session');
  const parts = token.split('.');
  if (parts.length !== 2 || !sessionSecret) return null;
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.uid || !Number.isInteger(decoded.exp) || decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    return accountStore.users.find((user) => user.userId === decoded.uid) || null;
  } catch (_) { return null; }
}

function sessionCookie(req, value, maxAge = SESSION_MAX_AGE) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || !!req.socket.encrypted || process.env.NODE_ENV === 'production' || !!process.env.RENDER;
  return `room05_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function publicUser(user) {
  return { username: user.username, userId: user.userId };
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/me' && req.method === 'GET') {
    const user = getSessionUser(req);
    return json(res, 200, { ok: true, user: user ? publicUser(user) : null });
  }

  if (!['/api/register', '/api/login', '/api/logout', '/api/legal/accept'].includes(pathname)) {
    return json(res, 404, { error: 'Not found.' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
  if (!isSameOrigin(req)) return json(res, 403, { error: 'Request origin is not allowed.' });

  if (pathname === '/api/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  const parsedBody = await readJsonBody(req);
  const body = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody) ? parsedBody : {};

  if (pathname === '/api/legal/accept') {
    const user = getSessionUser(req);
    if (!user) return json(res, 401, { error: 'Please sign in first.' });
    if (body.termsVersion !== TERMS_VERSION || body.privacyVersion !== PRIVACY_VERSION) return json(res, 400, { error: 'The legal policy version is not current. Refresh the page and try again.' });
    user.termsVersion = TERMS_VERSION;
    user.privacyVersion = PRIVACY_VERSION;
    user.legalAcceptedAt = new Date().toISOString();
    await persistAccountStore();
    return json(res, 200, { ok: true });
  }

  if (!rateLimitAuth(req)) return json(res, 429, { error: 'Too many sign-in attempts. Please try again in 15 minutes.' }, { 'Retry-After': '900' });

  const username = String(body.username || '').trim();
  const usernameKey = normaliseUsername(username);
  const password = body.password;
  if (!validUsername(username)) return json(res, 400, { error: 'Use a username of 3–24 characters: letters, numbers, dots, underscores or hyphens.' });
  if (!validPassword(password)) return json(res, 400, { error: 'Password must be between 8 and 128 characters.' });
  if (body.termsVersion !== TERMS_VERSION || body.privacyVersion !== PRIVACY_VERSION || body.termsAccepted !== true || body.privacyAccepted !== true) {
    return json(res, 400, { error: 'Please accept the current Terms & Conditions and Privacy Policy first.' });
  }

  if (pathname === '/api/register') {
    if (accountStore.users.some((user) => user.usernameKey === usernameKey)) return json(res, 409, { error: 'That username is already taken. Try another one.' });
    const salt = crypto.randomBytes(16);
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const user = {
      username,
      usernameKey,
      userId: '',
      passwordSalt: salt.toString('hex'),
      passwordHash,
      createdAt: new Date().toISOString(),
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      legalAcceptedAt: new Date().toISOString()
    };
    do { user.userId = `R05-${crypto.randomBytes(10).toString('hex').toUpperCase()}`; } while (accountStore.users.some((entry) => entry.userId === user.userId));
    accountStore.users.push(user);
    try { await persistAccountStore(); }
    catch (error) {
      accountStore.users = accountStore.users.filter((entry) => entry.userId !== user.userId);
      console.error('Account save failed:', error);
      return json(res, 500, { error: 'The account could not be saved. Check the server storage and try again.' });
    }
    return json(res, 201, { ok: true, created: true, user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, signSession(user.userId)) });
  }

  const user = accountStore.users.find((entry) => entry.usernameKey === usernameKey);
  // Use a dummy hash on unknown usernames to reduce obvious timing differences.
  const salt = user ? Buffer.from(user.passwordSalt, 'hex') : Buffer.alloc(16, 0x5a);
  const expectedHash = user ? Buffer.from(user.passwordHash, 'hex') : crypto.scryptSync('ROOM05-invalid-password', salt, 64);
  const candidateHash = crypto.scryptSync(password, salt, 64);
  const passwordMatches = candidateHash.length === expectedHash.length && crypto.timingSafeEqual(candidateHash, expectedHash);
  if (!user || !passwordMatches) return json(res, 401, { error: 'Username or password is incorrect.' });

  user.termsVersion = TERMS_VERSION;
  user.privacyVersion = PRIVACY_VERSION;
  user.legalAcceptedAt = new Date().toISOString();
  await persistAccountStore();
  return json(res, 200, { ok: true, created: false, user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, signSession(user.userId)) });
}

// Pre-compress the static website once at startup.
const ASSETS = new Map();
for (const file of PUBLIC_FILES) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, file));
    ASSETS.set(file, { raw, gz: zlib.gzipSync(raw, { level: 9 }), type: MIME[path.extname(file)], etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"' });
  } catch (error) { console.error('Missing file', file, error.message); }
}

const rooms = new Map(); // code -> Map(id -> {ws, name, sessionId, state})
const server = http.createServer((req, res) => {
  void (async () => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch (_) { return send(res, 400, 'Bad request'); }

    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    if (pathname === '/health') return send(res, 200, JSON.stringify({ ok: true, app: 'ROOM/05', mode: 'p2p-webrtc', rooms: rooms.size, maxPeople: MAX_PEOPLE, accounts: accountStore.users.length }), 'application/json; charset=utf-8');
    if (pathname === '/config') return send(res, 200, JSON.stringify({ iceServers: iceServers(), maxPeople: MAX_PEOPLE }), 'application/json; charset=utf-8');

    const name = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const asset = ASSETS.get(name);
    if (!asset) return send(res, 404, 'Not found');
    if (req.headers['if-none-match'] === asset.etag) return send(res, 304, '', asset.type, { ETag: asset.etag });
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = gz ? asset.gz : asset.raw;
    const extra = { ETag: asset.etag, Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=0, must-revalidate' };
    if (gz) extra['Content-Encoding'] = 'gzip';
    return send(res, 200, req.method === 'HEAD' ? '' : body, asset.type, extra);
  })().catch((error) => {
    console.error('HTTP request failed:', error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
    else res.destroy();
  });
});

// Free public STUN servers. Optional TURN relay (only needed for strict networks).
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (process.env.TURN_URL) {
    list.push({ urls: process.env.TURN_URL.split(',').map((value) => value.trim()), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  }
  return list;
}

// ---------- WebRTC signaling ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (_) { return socket.destroy(); }
  if (url.pathname !== '/ws' || !getSessionUser(req) || !isSameOrigin(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const out = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

wss.on('connection', (ws) => {
  let room = null;
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!message || typeof message.type !== 'string') return;
    const now = Date.now();
    if (now - (ws.winStart || 0) > 10000) { ws.winStart = now; ws.winCount = 0; }
    if (++ws.winCount > 400) return;
    if (message.type === 'ping') return out(ws, { type: 'pong' });

    if (message.type === 'join' && !room) {
      const code = clean(message.room, 8).toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return out(ws, { type: 'error', reason: 'bad-room' });
      const sessionId = clean(message.sessionId, 80);
      if (!/^[a-f0-9]{36}$/.test(sessionId)) return out(ws, { type: 'error', reason: 'bad-session' });

      let members = rooms.get(code);
      if (!members) { members = new Map(); rooms.set(code, members); }
      // A reconnect from the same browser tab reclaims its existing place.
      for (const [oldId, oldMember] of members) {
        if (oldMember.sessionId !== sessionId) continue;
        members.delete(oldId);
        members.forEach((member) => out(member.ws, { type: 'peer-left', id: oldId }));
        if (oldMember.ws && oldMember.ws !== ws) {
          oldMember.ws.room05Superseded = true;
          try { oldMember.ws.close(4001, 'ROOM/05 session resumed'); } catch (_) {}
        }
        break;
      }

      if (members.size >= MAX_PEOPLE) return out(ws, { type: 'full', max: MAX_PEOPLE });
      me = crypto.randomBytes(12).toString('hex');
      room = code;
      const name = clean(message.name, 28) || 'Guest';
      const peers = Array.from(members, ([id, member]) => ({ id, name: member.name, state: member.state }));
      members.set(me, { ws, name, sessionId, state: { mic: true, cam: true, screen: false, hand: false } });
      out(ws, { type: 'joined', id: me, peers });
      members.forEach((member, id) => { if (id !== me) out(member.ws, { type: 'peer-joined', id: me, name }); });
      return;
    }
    if (!room || !me) return;
    const members = rooms.get(room);
    if (!members) return;
    const self = members.get(me);
    if (!self || self.ws !== ws) return;

    if (message.type === 'signal' && typeof message.to === 'string') {
      const target = members.get(message.to);
      if (target) out(target.ws, { type: 'signal', from: me, data: message.data });
    } else if (message.type === 'state' && message.state && typeof message.state === 'object') {
      self.state = { mic: !!message.state.mic, cam: !!message.state.cam, screen: !!message.state.screen, hand: !!message.state.hand };
      members.forEach((peer, id) => { if (id !== me) out(peer.ws, { type: 'state', id: me, state: self.state }); });
    } else if (message.type === 'chat') {
      const text = clean(message.text, 400);
      if (text) members.forEach((peer, id) => { if (id !== me) out(peer.ws, { type: 'chat', from: me, name: self.name, text }); });
    } else if (message.type === 'reaction') {
      const emoji = clean(message.emoji, 8);
      if (emoji) members.forEach((peer, id) => { if (id !== me) out(peer.ws, { type: 'reaction', from: me, name: self.name, emoji }); });
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    const members = rooms.get(room);
    if (!members) return;
    const current = members.get(me);
    if (!current || current.ws !== ws) return;
    members.delete(me);
    members.forEach((member) => out(member.ws, { type: 'peer-left', id: me }));
    if (members.size === 0) rooms.delete(room);
  });
  ws.on('error', () => {});
});

// Keep WebSocket connections alive and remove dead peers.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 25000);

server.keepAliveTimeout = 65000;
const shutdown = () => {
  wss.clients.forEach((client) => { try { client.close(1001); } catch (_) {} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => console.error('uncaught', error));
process.on('unhandledRejection', (error) => console.error('unhandled', error));

initialiseAccountStore().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`ROOM/05 listening on ${PORT}; max ${MAX_PEOPLE} per room; ${accountStore.users.length} account(s) loaded; account data: ${DATA_DIR}`));
}).catch((error) => {
  console.error(`ROOM/05 could not initialise account storage at ${DATA_DIR}:`, error);
  process.exit(1);
});
