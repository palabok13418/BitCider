import express from 'express';
import crypto from 'node:crypto';
import {
  createPasswordRecord,
  verifyPassword,
  validateUsername,
  validatePassword,
  createRecoveryCodes,
  consumeRecoveryCode,
  hashSessionId,
  SESSION_TTL_MS
} from './account-security.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeQuality,
  supportsDolbyAtmos,
  atmosphereTrackId,
  parseAddonTrackId,
  streamMetadata
} from './audio-quality.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = process.env.BITCIDER_DATA_DIR
  || (fs.existsSync('/data') ? path.join('/data', 'bitcider') : path.join(ROOT, '.bitcider'));
const STORE_FILE = path.join(DATA_DIR, 'connection.json');
const KEY_FILE = path.join(DATA_DIR, 'encryption.key');
// Match the Deplexo web-service port; an injected PORT still takes precedence.
const PORT = Number(process.env.PORT || 3000);
const API_VERSION = '2026-11-22-secure-accounts-v1';
const CIDER_API = String(process.env.CIDER_API_URL || 'http://127.0.0.1:10767').replace(/\/+$/, '');
const PUBLIC_URL = String(process.env.BITCIDER_PUBLIC_URL || '').replace(/\/+$/, '');
const app = express();

// Deplexo terminates TLS in front of this Node service. Trust the immediate
// platform proxy so Express can read the forwarded public host/protocol.
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(express.json({ limit: '24kb' }));

function ensureSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  return fs.readFileSync(KEY_FILE);
}

function encryptToken(token) {
  const key = crypto.scryptSync(ensureSecret(), 'bitcider-local-token-v1', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    value: ciphertext.toString('base64url')
  };
}

function decryptToken(box) {
  if (!box?.iv || !box?.tag || !box?.value) return null;
  const key = crypto.scryptSync(ensureSecret(), 'bitcider-local-token-v1', 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(box.value, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

const SESSION_COOKIE = 'bitcider_session';

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (parsed?.addonKey || parsed?.ciderToken) {
      return { sessions: { legacy: parsed }, accounts: {}, authSessions: {} };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { sessions: {}, accounts: {}, authSessions: {} };
    }
    return {
      ...parsed,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
      authSessions: parsed.authSessions && typeof parsed.authSessions === 'object' ? parsed.authSessions : {}
    };
  } catch {
    return { sessions: {}, accounts: {}, authSessions: {} };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = STORE_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STORE_FILE);
}

let storeWriteQueue = Promise.resolve();
function updateStore(mutator) {
  const operation = storeWriteQueue.then(async () => {
    const store = readStore();
    const result = await mutator(store);
    if (result?.write !== false) writeStore(store);
    return result;
  });
  storeWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

function setSessionCookie(res, sessionId) {
  res.append('Set-Cookie', SESSION_COOKIE + '=' + encodeURIComponent(sessionId)
    + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

function ensureSessionId(req, res) {
  const existing = readCookie(req, SESSION_COOKIE);
  if (/^[A-Za-z0-9_-]{40,50}$/.test(existing)) return existing;
  const created = crypto.randomBytes(32).toString('base64url');
  setSessionCookie(res, created);
  return created;
}

function csrfTokenForSession(sessionId) {
  return crypto.createHmac('sha256', ensureSecret())
    .update('bitcider-csrf-v1:' + sessionId)
    .digest('base64url');
}

function secureStringEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function requireCsrf(req, res, next) {
  const sessionId = ensureSessionId(req, res);
  const expected = csrfTokenForSession(sessionId);
  const supplied = req.get('x-bitcider-csrf') || '';
  if (!secureStringEqual(expected, supplied)) {
    return res.status(403).json({ error: 'CSRF_REJECTED', message: 'Refresh BitCider and try again.' });
  }
  req.bitciderSessionId = sessionId;
  next();
}

function createAuthenticatedSession(store, accountId, res) {
  const now = Date.now();
  const active = Object.entries(store.authSessions)
    .filter(([, entry]) => entry?.accountId === accountId)
    .sort((a, b) => Date.parse(a[1].createdAt || 0) - Date.parse(b[1].createdAt || 0));
  while (active.length >= 8) {
    const [oldHash] = active.shift();
    delete store.authSessions[oldHash];
  }

  const sessionId = crypto.randomBytes(32).toString('base64url');
  store.authSessions[hashSessionId(sessionId)] = {
    accountId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  };
  setSessionCookie(res, sessionId);
  return sessionId;
}

function getUserSession(req, res) {
  const store = readStore();
  const sessionId = ensureSessionId(req, res);
  const authSession = store.authSessions[hashSessionId(sessionId)];
  if (authSession && Date.parse(authSession.expiresAt) > Date.now()) {
    const account = store.accounts[authSession.accountId];
    if (account) {
      return {
        store, sessionId, user: account,
        accountId: authSession.accountId, authenticated: true
      };
    }
  }
  return { store, sessionId, user: store.sessions[sessionId] || null, accountId: null, authenticated: false };
}

const authRateBuckets = new Map();
function authRateLimit(maxAttempts = 8, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    const username = String(req.body?.username || '').trim().toLowerCase();
    const usernameKey = username ? crypto.createHash('sha256').update(username).digest('hex').slice(0, 16) : '';
    const keys = [
      { key: 'ip:' + ip, limit: maxAttempts * 4 },
      ...(usernameKey ? [{ key: 'user:' + ip + ':' + usernameKey, limit: maxAttempts }] : [])
    ];
    let retryAfter = 0;
    for (const entry of keys) {
      let bucket = authRateBuckets.get(entry.key);
      if (!bucket || now - bucket.startedAt >= windowMs) bucket = { count: 0, startedAt: now };
      bucket.count += 1;
      authRateBuckets.set(entry.key, bucket);
      if (bucket.count > entry.limit) {
        retryAfter = Math.max(retryAfter, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000));
      }
    }
    if (authRateBuckets.size > 5000) {
      for (const [entryKey, entry] of authRateBuckets) {
        if (now - entry.startedAt >= windowMs) authRateBuckets.delete(entryKey);
      }
    }
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many account attempts. Try again later.' });
    }
    next();
  };
}

function accountConnection(user) {
  if (!user?.ciderToken || !user?.addonKey) return null;
  return {
    addonKey: user.addonKey,
    ciderToken: user.ciderToken,
    authMethod: user.authMethod || 'cider-api-auth-request',
    scopes: Array.isArray(user.scopes) ? user.scopes : [],
    connectedAt: user.connectedAt || null
  };
}

function tokenForUser(user) {
  if (!user?.ciderToken) return null;
  try {
    return decryptToken(user.ciderToken);
  } catch (error) {
    console.error('Could not decrypt a saved Cider token:', error.message);
    return null;
  }
}
function localIPv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        return address.address;
      }
    }
  }
  return '127.0.0.1';
}

function addonBaseUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  return 'http://' + localIPv4() + ':' + PORT;
}

function isLoopback(address = '') {
  const value = address.replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function trustedProxy(request) {
  const expected = String(process.env.BITCIDER_PROXY_SECRET || '');
  const received = String(request.get('x-bitcider-proxy-secret') || '');
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function trustedFrontend(request) {
  const expectedOrigins = [
    PUBLIC_URL,
    ...String(process.env.BITCIDER_ALLOWED_ORIGINS || '').split(',')
  ].map(value => {
    try { return new URL(value.trim()).origin; } catch { return ''; }
  }).filter(Boolean);

  const requestHost = String(
    request.get('x-forwarded-host') || request.get('host') || ''
  ).split(',')[0].trim().toLowerCase();

  const isDeplexoHost = hostname => {
    const value = String(hostname || '').toLowerCase().split(':')[0];
    return value === 'deplexo.com' || value.endsWith('.deplexo.com');
  };

  const originHeader = request.get('origin');
  const refererHeader = request.get('referer');
  let browserOrigin = '';
  try {
    if (originHeader) browserOrigin = new URL(originHeader).origin;
    else if (refererHeader) browserOrigin = new URL(refererHeader).origin;
  } catch {
    return false;
  }

  if (browserOrigin) {
    if (expectedOrigins.includes(browserOrigin)) return true;

    try {
      const parsed = new URL(browserOrigin);
      const secure = parsed.protocol === 'https:'
        || (parsed.protocol === 'http:' && isLoopback(parsed.hostname));
      if (!secure) return false;

      // Deplexo assigns HTTPS app URLs on *.deplexo.com. Accept the origin
      // when it matches the public host forwarded to this service. For a
      // rewritten upstream host, PUBLIC_URL / ALLOWED_ORIGINS must be exact.
      return parsed.host.toLowerCase() === requestHost;
    } catch {
      return false;
    }
  }

  // Privacy settings sometimes omit Origin and Referer. Allow the official
  // Deplexo app hostname itself, or an explicitly configured origin, in that case.
  if (isDeplexoHost(requestHost)) return true;

  return expectedOrigins.some(value => {
    try { return new URL(value).host.toLowerCase() === requestHost; } catch { return false; }
  });
}

function localOnly(req, res, next) {
  // Reverse proxies may connect from loopback even when the visitor is remote.
  // Hosted requests must carry the gateway secret or a verified first-party
  // HTTPS origin. Loopback bypass is opt-in for local development only.
  const localDevelopment = process.env.BITCIDER_ALLOW_LOOPBACK_ADMIN === 'true'
    && isLoopback(req.socket.remoteAddress || '');
  if (!localDevelopment && !trustedProxy(req) && !trustedFrontend(req)) {
    return res.status(403).json({
      error: 'LOCAL_ONLY',
      message: 'Use the BitCider site on Deplexo, Netlify, or Cloudflare to manage this connection.'
    });
  }
  next();
}

async function ciderRequest(apiPath, { method = 'GET', body, token } = {}) {
  if (!token) {
    const error = new Error('This BitCider user has not linked a Cider account.');
    error.status = 401;
    throw error;
  }

  const response = await fetch(CIDER_API + apiPath, {
    method,
    headers: {
      Accept: 'application/json',
      apptoken: token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error'
  });

  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 400) }; }

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || payload?.error || ('Cider returned HTTP ' + response.status);
    const error = new Error(String(message));
    error.status = response.status;
    error.ciderCode = payload?.error?.code || payload?.code;
    throw error;
  }
  return payload;
}
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return null;
}

function songRows(payload) {
  const d = payload?.data ?? payload;
  const candidates = [
    d?.results?.songs?.data,
    d?.results?.songs,
    d?.songs?.data,
    d?.songs,
    d?.results?.data,
    d?.results,
    d?.items,
    d?.data
  ];
  for (const candidate of candidates) {
    const rows = asArray(candidate);
    if (rows) return rows;
  }
  if (Array.isArray(d)) return d;
  return [];
}

function artworkUrl(attributes) {
  const artwork = attributes?.artwork || attributes?.coverArt || {};
  const url = artwork.url || artwork.urlTemplate || attributes?.artworkURL || '';
  if (!url) return undefined;
  return String(url)
    .replaceAll('{w}', '640')
    .replaceAll('{h}', '640')
    .replaceAll('{f}', 'jpg');
}

function normalizeSong(song, { quality = 'high', preferAtmos = false } = {}) {
  const attributes = song?.attributes || song || {};
  // Apple Music library rows may carry an "i." library id as their row id.
  // The play-item route needs the underlying catalog id when playParams exists.
  const id = attributes?.playParams?.id || song?.id || attributes?.id || attributes?.catalogId;
  if (!id) return [];
  const durationMs = Number(attributes.durationInMillis || attributes.durationMs || 0);
  const common = {
    title: attributes.name || attributes.title || 'Unknown track',
    artist: attributes.artistName || attributes.artist || 'Unknown artist',
    album: attributes.albumName || attributes.album || '',
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : Number(attributes.duration || 0),
    ...(artworkUrl(attributes) ? { artworkURL: artworkUrl(attributes) } : {})
  };
  const rows = [];
  const hasAtmos = supportsDolbyAtmos(attributes);

  if (quality === 'atmos') {
    if (!hasAtmos) return [];
    return [{
      ...common,
      id: atmosphereTrackId(id),
      format: 'eac3-joc',
      audioQuality: 'Dolby Atmos',
      audioModes: ['DOLBY_ATMOS'],
      atmos: true
    }];
  }

  // Atmos is a distinct rendition row. Only expose it when Apple's catalogue
  // metadata explicitly says the track has a Dolby Atmos variant.
  if (preferAtmos && hasAtmos) {
    rows.push({
      ...common,
      id: atmosphereTrackId(id),
      format: 'eac3-joc',
      audioQuality: 'Dolby Atmos',
      audioModes: ['DOLBY_ATMOS'],
      atmos: true
    });
  }

  rows.push({
    ...common,
    id: String(id),
    format: 'aac',
    audioQuality: quality === 'low' ? 'AAC 64 kbps' : 'AAC 256 kbps'
  });
  return rows;
}

async function searchCiderSongs(term, token, { quality = 'high', preferAtmos = false } = {}) {
  // Cider's scoped library API exposes paginated library songs, not an
  // Apple Music-wide catalogue search. Search those library entries locally.
  const needle = term.toLocaleLowerCase();
  const matches = [];
  const seen = new Set();
  const pageSize = 200;
  const maxLibrarySongs = Math.max(200, Math.min(
    Number(process.env.BITCIDER_SEARCH_MAX_LIBRARY_SONGS || 4000),
    10000
  ));

  for (let offset = 0; offset < maxLibrarySongs; offset += pageSize) {
    const result = await ciderRequest(
      '/api/v2/library/songs?offset=' + offset + '&limit=' + pageSize,
      { token }
    );
    const rows = songRows(result);
    if (!rows.length) break;

    for (const row of rows) {
      const attributes = row?.attributes || row || {};
      const catalogId = attributes?.playParams?.id || row?.id || attributes?.id || attributes?.catalogId;
      if (!catalogId || seen.has(String(catalogId))) continue;
      const normalizedTracks = normalizeSong(row, { quality, preferAtmos });
      if (!normalizedTracks.length) continue;
      seen.add(String(catalogId));
      const track = normalizedTracks[0];
      const haystack = [track.title, track.artist, track.album].join(' ').toLocaleLowerCase();
      if (haystack.includes(needle)) {
        matches.push(...normalizedTracks);
        if (matches.length >= 25) return matches.slice(0, 25);
      }
    }

    const total = Number(result?.meta?.total ?? result?.total ?? 0);
    if (rows.length < pageSize || (total > 0 && offset + rows.length >= total)) break;
  }

  return matches;
}

function findQueueRows(payload) {
  const d = payload?.data ?? payload;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.queue)) return d.queue;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.data)) return d.data;
  return [];
}

function findAssetUrl(queue, trackId) {
  const match = queue.find(item => String(item?.id || item?.attributes?.playParams?.id || '') === String(trackId));
  return match?.assetURL || match?.attributes?.assetURL || match?.url || match?.attributes?.url || null;
}

function streamDetails(url, queueItem, quality = 'high') {
  return streamMetadata(url, queueItem, quality);
}

async function resolveCiderStream(addonTrackId, token, requestedQuality = 'high') {
  const parsedTrack = parseAddonTrackId(addonTrackId);
  const trackId = parsedTrack.trackId;
  const quality = parsedTrack.atmos ? 'atmos' : normalizeQuality(requestedQuality);
  // Cider resolves the selected catalog item using the linked account.
  // Its legacy queue response includes the playable assetURL used by Cider.
  await ciderRequest('/api/v2/playback/play-item', {
    method: 'POST',
    body: { id: trackId, type: 'songs' },
    token
  });

  let queuePayload;
  let queueRows = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    queuePayload = await ciderRequest('/api/v2/queue', { token });
    queueRows = findQueueRows(queuePayload);
    const item = queueRows.find(row => String(
      row?.id || row?.attributes?.playParams?.id || row?.attributes?.id || ''
    ) === String(trackId));
    const url = findAssetUrl(queueRows, trackId);
    if (url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Cider returned a non-HTTP media URL.');
      }
      // Cider resolves the authorized media URL; let BitChord be the audible
      // output instead of leaving the desktop player playing in parallel.
      if (String(process.env.BITCIDER_PAUSE_CIDER_AFTER_RESOLVE || 'true').toLowerCase() !== 'false') {
        try {
          await ciderRequest('/api/v2/playback/pause', { method: 'POST', token });
        } catch (error) {
          console.warn('Could not pause Cider after resolving the stream:', error.message);
        }
      }
      return streamDetails(url, item || queueRows[0], quality);
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('Cider did not expose a playable asset URL for this item. The current Cider build or Apple Music item may not provide a BitChord-compatible stream.');
}

function validAddonKey(req, res, next) {
  const store = readStore();
  const allOwners = [
    ...Object.values(store.sessions || {}),
    ...Object.values(store.accounts || {})
  ];
  const user = allOwners.find(entry =>
    entry?.addonKey === req.params.addonKey && entry?.ciderToken
  );
  const token = tokenForUser(user);
  if (!user || !token) {
    return res.status(404).json({ error: 'ADDON_NOT_FOUND', message: 'This personal BitCider source is not available.' });
  }
  req.bitciderUser = { ...user, token };
  next();
}

// BitChord can call addons from a different app origin. The random addon
// key is the endpoint's bearer-like locator, so public addon routes need CORS.
app.use((req, res, next) => {
  const isAddonRoute = /^\/[A-Za-z0-9_-]+\/(?:manifest\.json|search|stream\/)/.test(req.path);
  if (!isAddonRoute) return next();
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Accept, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'BitCider', apiVersion: API_VERSION }));

app.get('/api/status', localOnly, (req, res) => {
  const { sessionId, user, accountId, authenticated } = getUserSession(req, res);
  const token = tokenForUser(user);
  const base = addonBaseUrl();
  const addonUrl = token && user?.addonKey ? base + '/' + user.addonKey + '/manifest.json' : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    apiVersion: API_VERSION,
    connected: Boolean(token && user?.addonKey),
    addonUrl,
    publicUrlConfigured: Boolean(PUBLIC_URL),
    sessionReady: Boolean(sessionId),
    csrfToken: csrfTokenForSession(sessionId),
    account: authenticated ? {
      authenticated: true,
      username: user.username,
      createdAt: user.createdAt
    } : { authenticated: false },
    error: null
  });
});

app.post('/api/account/register', localOnly, authRateLimit(4), requireCsrf, async (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = req.body?.password;
  if (!username) return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Use 3–24 characters: letters, numbers, dots, underscores, or hyphens.' });
  if (!validatePassword(password)) return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Use a passphrase between 14 and 128 characters.' });

  let passwordRecord;
  try { passwordRecord = await createPasswordRecord(password); }
  catch { return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Use a passphrase between 14 and 128 characters.' }); }
  const recovery = createRecoveryCodes();
  const sessionId = req.bitciderSessionId;

  try {
    const result = await updateStore(store => {
      const activeSession = store.authSessions[hashSessionId(sessionId)];
      if (activeSession && Date.parse(activeSession.expiresAt) > Date.now()) {
        return { status: 409, error: 'ALREADY_SIGNED_IN', message: 'Sign out before creating another account.' , write: false };
      }
      const taken = Object.values(store.accounts).some(account => account?.username === username);
      if (taken) return { status: 409, error: 'USERNAME_TAKEN', message: 'That BitCider username is already taken.', write: false };

      const pending = store.sessions[sessionId];
      const accountId = crypto.randomBytes(24).toString('base64url');
      const account = {
        username,
        password: passwordRecord,
        recoveryCodeHashes: recovery.hashes,
        createdAt: new Date().toISOString(),
        ...accountConnection(pending)
      };
      store.accounts[accountId] = account;
      delete store.sessions[sessionId];
      delete store.authSessions[hashSessionId(sessionId)];
      createAuthenticatedSession(store, accountId, res);
      return { ok: true, accountId };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, username, recoveryCodes: recovery.codes });
  } catch (error) {
    console.error('BitCider account registration failed:', error.message);
    return res.status(500).json({ error: 'ACCOUNT_CREATE_FAILED', message: 'Could not create your account. Try again.' });
  }
});

app.post('/api/account/login', localOnly, authRateLimit(8), requireCsrf, async (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = req.body?.password;
  if (!username || typeof password !== 'string' || password.length > 128) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Username or passphrase is incorrect.' });
  }

  const sessionId = req.bitciderSessionId;
  const initialStore = readStore();
  const match = Object.entries(initialStore.accounts).find(([, account]) => account?.username === username);
  const accountId = match?.[0];
  const accountSnapshot = match?.[1];
  const valid = await verifyPassword(password, accountSnapshot?.password);
  if (!accountId || !valid) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Username or passphrase is incorrect.' });
  }

  try {
    const result = await updateStore(store => {
      const account = store.accounts[accountId];
      if (!account || account.password?.hash !== accountSnapshot.password.hash) {
        return { status: 401, error: 'INVALID_CREDENTIALS', message: 'Username or passphrase is incorrect.', write: false };
      }
      const pending = store.sessions[sessionId];
      const pendingConnection = accountConnection(pending);
      const savedConnection = accountConnection(account);
      if (pendingConnection && savedConnection && pendingConnection.addonKey !== savedConnection.addonKey) {
        return { status: 409, error: 'ANOTHER_CONNECTION_SAVED', message: 'This browser already has a different unsaved Cider connection. Disconnect it before signing in.', write: false };
      }
      if (pendingConnection && !savedConnection) Object.assign(account, pendingConnection);
      delete store.sessions[sessionId];
      delete store.authSessions[hashSessionId(sessionId)];
      createAuthenticatedSession(store, accountId, res);
      return { ok: true };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, username });
  } catch (error) {
    console.error('BitCider sign-in failed:', error.message);
    return res.status(500).json({ error: 'SIGN_IN_FAILED', message: 'Could not sign in. Try again.' });
  }
});

app.post('/api/account/logout', localOnly, requireCsrf, async (req, res) => {
  const sessionId = req.bitciderSessionId;
  await updateStore(store => {
    delete store.authSessions[hashSessionId(sessionId)];
    return { ok: true };
  });
  clearSessionCookie(res);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.post('/api/account/recover', localOnly, authRateLimit(5), requireCsrf, async (req, res) => {
  const username = validateUsername(req.body?.username);
  const recoveryCode = req.body?.recoveryCode;
  const newPassword = req.body?.newPassword;
  if (!username || !validatePassword(newPassword)) {
    return res.status(400).json({ error: 'INVALID_RECOVERY', message: 'Enter a valid username and a passphrase between 14 and 128 characters.' });
  }

  try {
    const passwordRecord = await createPasswordRecord(newPassword);
    const recovery = createRecoveryCodes();
    const result = await updateStore(store => {
      const entry = Object.entries(store.accounts).find(([, account]) => account?.username === username);
      if (!entry) return { status: 400, error: 'INVALID_RECOVERY', message: 'The recovery details could not be verified.' };
      const [accountId, account] = entry;
      const consumed = consumeRecoveryCode(recoveryCode, account.recoveryCodeHashes || []);
      if (!consumed.valid) return { status: 400, error: 'INVALID_RECOVERY', message: 'The recovery details could not be verified.' };
      account.password = passwordRecord;
      // Replace the recovery set after one is used, and revoke every existing
      // account session so a lost device cannot stay signed in.
      account.recoveryCodeHashes = recovery.hashes;
      for (const [sessionHash, session] of Object.entries(store.authSessions)) {
        if (session?.accountId === accountId) delete store.authSessions[sessionHash];
      }
      return { ok: true };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    clearSessionCookie(res);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, recoveryCodes: recovery.codes });
  } catch (error) {
    console.error('BitCider password recovery failed:', error.message);
    return res.status(500).json({ error: 'RECOVERY_FAILED', message: 'Could not recover this account. Try again.' });
  }
});

app.post('/api/connect', localOnly, requireCsrf, async (req, res) => {
  const { sessionId, user: previous, accountId, authenticated } = getUserSession(req, res);
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (token.length < 12 || token.length > 8192 || token.includes(String.fromCharCode(10)) || token.includes(String.fromCharCode(13))){
    return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Cider returned an invalid app token. Please authorize BitCider again.' });
  }

  // The browser obtains this token directly from the user's own Cider instance
  // through POST /api/v2/auth/request. A hosted Deplexo process cannot verify
  // a user's 127.0.0.1 API endpoint, so do not attempt a cloud-side loopback
  // check here. Cider only returns the token after the user approves the
  // requested app permissions in its native consent dialog.
  const saved = await updateStore(latestStore => {
    const target = authenticated ? latestStore.accounts[accountId] : (latestStore.sessions[sessionId] ||= {});
    if (!target) throw new Error('The signed-in account is no longer available.');
    target.addonKey = previous?.addonKey || crypto.randomBytes(32).toString('base64url');
    target.ciderToken = encryptToken(token);
    target.authMethod = 'cider-api-auth-request';
    target.scopes = Array.isArray(req.body?.scopes)
      ? req.body.scopes.filter(scope => ['playback', 'queue', 'library', 'audio'].includes(scope))
      : [];
    target.connectedAt = new Date().toISOString();
    return { addonKey: target.addonKey };
  });
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    addonUrl: addonBaseUrl() + '/' + saved.addonKey + '/manifest.json'
  });
});

app.get('/api/connect', localOnly, (_req, res) => {
  res.set('Allow', 'POST');
  res.status(405).json({
    error: 'METHOD_NOT_ALLOWED',
    message: 'Use POST from the BitCider linking flow. Opening this endpoint in the address bar sends GET and cannot link Cider.'
  });
});

app.post('/api/disconnect', localOnly, requireCsrf, async (req, res) => {
  const { sessionId, accountId, authenticated } = getUserSession(req, res);
  await updateStore(store => {
    if (authenticated) {
      const account = store.accounts[accountId];
      if (account) {
        delete account.addonKey;
        delete account.ciderToken;
        delete account.authMethod;
        delete account.scopes;
        delete account.connectedAt;
      }
    } else {
      delete store.sessions[sessionId];
    }
    return { ok: true };
  });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/:addonKey/manifest.json', validAddonKey, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    id: 'com.bitcider.personal.' + req.params.addonKey.slice(0, 12).replace(/[^a-zA-Z0-9]/g, ''),
    name: 'BitCider',
    version: '1.1.0',
    description: 'AAC 256 kbps, AAC 64 kbps, and Dolby Atmos where available. No lossless or Hi-Res streams.',
    resources: ['search', 'stream'],
    checkValidLossless: 0,
    settings: [{
      key: 'quality',
      type: 'select',
      label: 'Audio quality',
      default: 'high',
      options: [
        { value: 'high', label: 'AAC 256 kbps' },
        { value: 'low', label: 'AAC 64 kbps' },
        { value: 'atmos', label: 'Dolby Atmos' }
      ]
    }]
  });
});

app.get('/:addonKey/search', validAddonKey, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ tracks: [] });
  if (query.length > 160) return res.status(400).json({ error: 'Search query is too long.' });
  try {
    const quality = normalizeQuality(req.query.quality);
    const preferAtmos = String(req.query.atmos || '').toLowerCase() === 'auto';
    const tracks = await searchCiderSongs(query, req.bitciderUser.token, { quality, preferAtmos });
    res.set('Cache-Control', 'no-store');
    res.json({ tracks });
  } catch (error) {
    console.error('BitCider search failed:', error.message, error.ciderCode || '');
    res.status(error.status || 502).json({
      error: 'CIDER_SEARCH_FAILED',
      message: error.message || 'Cider search failed.'
    });
  }
});

app.get('/:addonKey/stream/:trackId', validAddonKey, async (req, res) => {
  const trackId = String(req.params.trackId || '');
  if (!trackId || trackId.length > 180) return res.status(400).json({ error: 'Invalid track id.' });
  try {
    const stream = await resolveCiderStream(trackId, req.bitciderUser.token, req.query.quality);
    res.set('Cache-Control', 'no-store');
    res.json(stream);
  } catch (error) {
    console.error('BitCider stream resolution failed:', error.message, error.ciderCode || '');
    res.status(error.status || 502).json({
      error: 'CIDER_STREAM_FAILED',
      message: error.message || 'Cider could not resolve this stream.'
    });
  }
});

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get('/', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (_req, res) => res.status(503).type('text').send('BitCider UI has not been built yet. Run npm run build.'));
}

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  BitCider service is running');
  console.log('  Local UI:    http://localhost:' + PORT);
  console.log('  LAN address: http://' + localIPv4() + ':' + PORT);
  console.log('  Cider API:   ' + CIDER_API);
  console.log('');
  if (!PUBLIC_URL) console.log('  Set BITCIDER_PUBLIC_URL to your public HTTPS tunnel URL for off-network BitChord access.');
});
