import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = path.join(ROOT, '.bitcider');
const STORE_FILE = path.join(DATA_DIR, 'connection.json');
const KEY_FILE = path.join(DATA_DIR, 'encryption.key');
const PORT = Number(process.env.PORT || 8787);
const CIDER_API = String(process.env.CIDER_API_URL || 'http://127.0.0.1:10767').replace(/\/+$/, '');
const PUBLIC_URL = String(process.env.BITCIDER_PUBLIC_URL || '').replace(/\/+$/, '');
const app = express();

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

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = STORE_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STORE_FILE);
}

function connectedToken() {
  const store = readStore();
  try {
    return { store, token: decryptToken(store.ciderToken) };
  } catch (error) {
    console.error('Could not decrypt the saved Cider token:', error.message);
    return { store, token: null };
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

function localOnly(req, res, next) {
  if (!isLoopback(req.socket.remoteAddress || '')) {
    return res.status(403).json({ error: 'LOCAL_ONLY', message: 'Connection management is only available from this computer.' });
  }
  next();
}

async function ciderRequest(apiPath, { method = 'GET', body } = {}) {
  const { token } = connectedToken();
  if (!token) {
    const error = new Error('Cider is not connected to this BitCider instance.');
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
  const id = song?.id || attributes?.id || attributes?.catalogId;
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

async function searchCiderSongs(term) {
  const candidates = [
    '/api/v2/library/search?term=' + encodeURIComponent(term) + '&types=songs&limit=25',
    '/api/v2/library/search?q=' + encodeURIComponent(term) + '&types=songs&limit=25'
  ];
  let lastError;
  for (const endpoint of candidates) {
    try {
      const result = await ciderRequest(endpoint);
      const rows = songRows(result);
      if (rows.length) return rows.map(normalizeSong).filter(Boolean).slice(0, 25);
      if (result?.data?.results || result?.results) return [];
      lastError = new Error('Cider search returned no song results.');
    } catch (error) {
      lastError = error;
      if (error.status !== 404 && error.status !== 400) break;
    }
  }
  throw lastError || new Error('Cider search is unavailable.');
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
  const match = queue.find(item => String(item?.id || item?.attributes?.playParams?.id || '') === String(trackId))
    || queue.find(item => item?.assetURL || item?.attributes?.assetURL);
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

async function resolveCiderStream(trackId) {
  // Cider resolves the selected catalog item using the linked account.
  // Its legacy queue response includes the playable assetURL used by Cider.
  await ciderRequest('/api/v1/playback/play-item', {
    method: 'POST',
    body: { id: trackId, type: 'song' }
  });

  let queuePayload;
  let queueRows = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    queuePayload = await ciderRequest('/api/v1/playback/queue');
    queueRows = findQueueRows(queuePayload);
    const item = queueRows.find(row => String(row?.id || '') === String(trackId));
    const url = findAssetUrl(queueRows, trackId);
    if (url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Cider returned a non-HTTP media URL.');
      }
      return streamDetails(url, item || queueRows[0]);
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('Cider did not expose a playable asset URL for this item. The current Cider build or Apple Music item may not provide a BitChord-compatible stream.');
}

function validAddonKey(req, res, next) {
  const store = readStore();
  if (!store.addonKey || req.params.addonKey !== store.addonKey || !store.ciderToken) {
    return res.status(404).json({ error: 'ADDON_NOT_FOUND', message: 'This personal BitCider source is not available.' });
  }
  req.bitciderStore = store;
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'BitCider' }));

app.get('/api/status', (_req, res) => {
  const { store, token } = connectedToken();
  const base = addonBaseUrl();
  const addonUrl = token && store.addonKey ? base + '/' + store.addonKey + '/manifest.json' : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    connected: Boolean(token && store.addonKey),
    addonUrl,
    publicUrlConfigured: Boolean(PUBLIC_URL),
    localAddress: 'http://' + localIPv4() + ':' + PORT,
    port: PORT,
    error: null
  });
});

app.post('/api/connect', localOnly, (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (token.length < 12 || token.length > 4096 || /[\r\n]/.test(token)) {
    return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Paste the Cider app token exactly as Cider provided it.' });
  }
  const previous = readStore();
  const store = {
    addonKey: previous.addonKey || crypto.randomBytes(18).toString('base64url'),
    ciderToken: encryptToken(token),
    connectedAt: new Date().toISOString()
  };
  writeStore(store);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    addonUrl: addonBaseUrl() + '/' + store.addonKey + '/manifest.json'
  });
});

app.post('/api/disconnect', localOnly, (_req, res) => {
  writeStore({});
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/:addonKey/manifest.json', validAddonKey, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    id: 'com.bitcider.personal.' + req.params.addonKey.slice(0, 12),
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
    const tracks = await searchCiderSongs(query);
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
    const stream = await resolveCiderStream(trackId);
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
