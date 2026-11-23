import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = process.env.BITCIDER_DATA_DIR
  || (fs.existsSync('/data') ? path.join('/data', 'bitcider') : path.join(ROOT, '.bitcider'));
const STORE_FILE = path.join(DATA_DIR, 'connection.json');
const KEY_FILE = path.join(DATA_DIR, 'encryption.key');
const PORT = Number(process.env.PORT || 8787);
const CIDER_API = String(process.env.CIDER_API_URL || 'http://127.0.0.1:10767').replace(/\/+$/, '');
const PUBLIC_URL = String(process.env.BITCIDER_PUBLIC_URL || '').replace(/\/+$/, '');
const app = express();

// Deplexo terminates TLS in front of this Node service. Trust the immediate
// platform proxy so Express can read the forwarded public host/protocol.
const app = express();
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
    if (parsed && parsed.sessions && typeof parsed.sessions === 'object') return parsed;
    // Upgrade the original single-user file format without discarding its data.
    if (parsed?.addonKey || parsed?.ciderToken) {
      return { sessions: { legacy: parsed } };
    }
    return { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = STORE_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STORE_FILE);
}

function ensureSessionId(req, res) {
  const cookies = String(req.headers.cookie || '').split(';');
  let existing = '';
  for (const part of cookies) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try { existing = decodeURIComponent(part.slice(separator + 1).trim()); } catch { existing = ''; }
    break;
  }

  if (/^[A-Za-z0-9_-]{40,50}$/.test(existing)) return existing;

  const created = crypto.randomBytes(32).toString('base64url');
  // Secure is appropriate for the three deployed HTTPS hosts; localhost is
  // also treated as a trustworthy origin by modern browsers.
  res.append('Set-Cookie', SESSION_COOKIE + '=' + created + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
  return created;
}

function getUserSession(req, res) {
  const store = readStore();
  const sessionId = ensureSessionId(req, res);
  return { store, sessionId, user: store.sessions[sessionId] || null };
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

  // The public host is forwarded by the platform proxy. This lets the
  // Deplexo-hosted site call its own API even when BITCIDER_PUBLIC_URL was
  // omitted or has a trailing/proxy-specific URL configuration mismatch.
  const requestHost = String(
    request.get('x-forwarded-host') || request.get('host') || ''
  ).split(',')[0].trim().toLowerCase();

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
      return secure && parsed.host.toLowerCase() === requestHost;
    } catch {
      return false;
    }
  }

  // Some privacy modes omit Origin and Referer on same-origin GET requests.
  // In that case, accept the explicitly configured Deplexo host only.
  return expectedOrigins.some(value => {
    try { return new URL(value).host.toLowerCase() === requestHost; } catch { return false; }
  });
}

function localOnly(req, res, next) {
  if (!isLoopback(req.socket.remoteAddress || '') && !trustedProxy(req) && !trustedFrontend(req)) {
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

function normalizeSong(song) {
  const attributes = song?.attributes || song || {};
  // Apple Music library rows may carry an "i." library id as their row id.
  // The play-item route needs the underlying catalog id when playParams exists.
  const id = attributes?.playParams?.id || song?.id || attributes?.id || attributes?.catalogId;
  if (!id) return null;
  const durationMs = Number(attributes.durationInMillis || attributes.durationMs || 0);
  return {
    id: String(id),
    title: attributes.name || attributes.title || 'Unknown track',
    artist: attributes.artistName || attributes.artist || 'Unknown artist',
    album: attributes.albumName || attributes.album || '',
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : Number(attributes.duration || 0),
    ...(artworkUrl(attributes) ? { artworkURL: artworkUrl(attributes) } : {}),
    format: 'm3u8',
    audioQuality: 'HIGH'
  };
}

async function searchCiderSongs(term, token) {
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
      const track = normalizeSong(row);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      const haystack = [track.title, track.artist, track.album].join(' ').toLocaleLowerCase();
      if (haystack.includes(needle)) {
        matches.push(track);
        if (matches.length >= 25) return matches;
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

function streamDetails(url, queueItem) {
  const lower = url.toLowerCase();
  const hls = lower.includes('.m3u8') || lower.includes('m3u8');
  const attributes = queueItem?.attributes || queueItem || {};
  const codec = attributes.codec || attributes.audioCodec || (hls ? 'aac' : 'unknown');
  return {
    url,
    format: hls ? 'm3u8' : (attributes.container || 'audio'),
    quality: attributes.audioQuality || 'Cider stream',
    codec,
    container: hls ? 'mpegts' : (attributes.container || 'unknown'),
    manifest: hls ? 'hls' : 'none',
    encrypted: false,
    ...(Number(attributes.sampleRate) > 0 ? { sampleRate: Number(attributes.sampleRate) } : {}),
    ...(Number(attributes.bitDepth) > 0 ? { bitDepth: Number(attributes.bitDepth) } : {}),
    ...(Number(attributes.bitrate) > 0 ? { bitrate: Number(attributes.bitrate) } : {})
  };
}

async function resolveCiderStream(trackId, token) {
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
      return streamDetails(url, item || queueRows[0]);
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('Cider did not expose a playable asset URL for this item. The current Cider build or Apple Music item may not provide a BitChord-compatible stream.');
}

function validAddonKey(req, res, next) {
  const store = readStore();
  const user = Object.values(store.sessions || {}).find(entry =>
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

app.get('/health', (_req, res) => res.json({ ok: true, service: 'BitCider' }));

app.get('/api/status', localOnly, (req, res) => {
  const { store, sessionId, user } = getUserSession(req, res);
  const token = tokenForUser(user);
  const base = addonBaseUrl();
  const addonUrl = token && user?.addonKey ? base + '/' + user.addonKey + '/manifest.json' : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    connected: Boolean(token && user?.addonKey),
    addonUrl,
    publicUrlConfigured: Boolean(PUBLIC_URL),
    sessionReady: Boolean(sessionId),
    error: null
  });
});

app.post('/api/connect', localOnly, async (req, res) => {
  const { store, sessionId, user: previous } = getUserSession(req, res);
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (token.length < 12 || token.length > 4096 || /[\\r\\n]/.test(token)) {
    return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Paste the Cider app token exactly as Cider provided it.' });
  }

  // Verify the token with Cider before storing it. This call must be performed
  // by the per-user Cider bridge once that relay is deployed.
  try {
    const check = await fetch(CIDER_API + '/api/v2/client/info', {
      headers: { Accept: 'application/json', apptoken: token },
      cache: 'no-store',
      redirect: 'error'
    });
    const payload = await check.json().catch(() => ({}));
    if (!check.ok) {
      const message = payload?.error?.message || payload?.error || 'Cider rejected this app token.';
      return res.status(401).json({ error: 'CIDER_TOKEN_REJECTED', message: String(message) });
    }
  } catch {
    return res.status(502).json({
      error: 'CIDER_BRIDGE_REQUIRED',
      message: 'This hosted BitCider server cannot reach Cider on your computer yet. The per-user Cider bridge is required before linking can complete.'
    });
  }

  // Re-read after the asynchronous Cider verification so two users linking
  // at the same time cannot overwrite each other's session records.
  const latestStore = readStore();
  latestStore.sessions[sessionId] = {
    addonKey: previous?.addonKey || crypto.randomBytes(18).toString('base64url'),
    ciderToken: encryptToken(token),
    connectedAt: new Date().toISOString()
  };
  writeStore(latestStore);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    addonUrl: addonBaseUrl() + '/' + latestStore.sessions[sessionId].addonKey + '/manifest.json'
  });
});

app.post('/api/disconnect', localOnly, (req, res) => {
  const { store, sessionId } = getUserSession(req, res);
  delete store.sessions[sessionId];
  writeStore(store);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/:addonKey/manifest.json', validAddonKey, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    id: 'com.bitcider.personal.' + req.params.addonKey.slice(0, 12).replace(/[^a-zA-Z0-9]/g, ''),
    name: 'BitCider',
    version: '1.0.0',
    description: 'Your linked Cider account as a personal BitChord source.',
    resources: ['search', 'stream']
  });
});

app.get('/:addonKey/search', validAddonKey, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ tracks: [] });
  if (query.length > 160) return res.status(400).json({ error: 'Search query is too long.' });
  try {
    const tracks = await searchCiderSongs(query, req.bitciderUser.token);
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
    const stream = await resolveCiderStream(trackId, req.bitciderUser.token);
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
