import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createIceConfiguration } from './ice.mjs';
import { createAutoMixService, buildAutoMixPlan } from './automix.mjs';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import {
  createPasswordRecord,
  verifyPassword,
  validatePassword,
  createRecoveryCodes,
  consumeRecoveryCode,
  hashSessionId,
  SESSION_TTL_MS,
  MAX_ACCOUNT_DEVICES,
  MAX_PASSKEYS_PER_ACCOUNT,
  WEBAUTHN_CHALLENGE_TTL_MS
} from '../account-security.mjs';

export const BITCONNECTION_API_VERSION = '2026-11-27-party-audio-sources-v8';
const COOKIE_NAME = 'bitconnection_session';
const SESSION_PATTERN = /^[A-Za-z0-9_-]{40,50}$/;
const PASSWORD_DUMMY = await createPasswordRecord(crypto.randomBytes(32).toString('base64url') + '-bitconnection-dummy');

const DEFAULT_BITCONNECTION_ALLOWED_ORIGINS = new Set([
  'https://bitcider.de.deplexo.com',
  'https://bitchord.de.deplexo.com',
  'https://mus-api.de.deplexo.com',
  'https://mus-api.palabokmagtiis.workers.dev'
]);

function normalizeHttpOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

export function isBitConnectionOriginAllowed(origin) {
  const normalized = normalizeHttpOrigin(origin);
  if (!normalized) return false;
  const configured = String(process.env.BITCONNECTION_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeHttpOrigin)
    .filter(Boolean);
  return DEFAULT_BITCONNECTION_ALLOWED_ORIGINS.has(normalized) || configured.includes(normalized);
}

export function bitConnectionCorsMiddleware(req, res, next) {
  const origin = String(req.get('origin') || '').trim();
  const allowed = Boolean(origin && isBitConnectionOriginAllowed(origin));
  if (allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', [
      'Accept',
      'Authorization',
      'Content-Type',
      'X-BitConnection-CSRF',
      'X-BitCider-CSRF',
      'X-BitConnection-Identity'
    ].join(', '));
    res.set('Access-Control-Max-Age', '600');
    res.vary('Origin');
  }
  if (req.method === 'OPTIONS') {
    if (origin && !allowed) {
      return res.status(403).json({ error: 'BITCONNECTION_ORIGIN_NOT_ALLOWED' });
    }
    return res.status(204).end();
  }
  return next();
}

export function buildBitConnectionPartyServiceDescriptor(req, maximum = 30) {
  const forwardedProtocol = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const forwardedHost = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const origin = forwardedHost && /^(?:https?|wss?):\/\//i.test(forwardedHost)
    ? forwardedHost.replace(/\/$/, '')
    : forwardedHost ? forwardedProtocol + '://' + forwardedHost : '';
  const apiBase = '/api/bitconnection';
  return {
    service: 'BitConnection Listening Party',
    protocolVersion: 1,
    apiVersion: BITCONNECTION_API_VERSION,
    serviceUrl: origin ? origin + '/party' : '/party',
    apiBase: origin ? origin + apiBase : apiBase,
    cors: {
      credentials: 'include',
      requiredHeaders: ['Authorization', 'Content-Type', 'X-BitConnection-CSRF', 'X-BitCider-CSRF', 'X-BitConnection-Identity']
    },
    source: 'BitMono, CCustom, or Cider selected in BitAccount Center',
    authentication: {
      host: 'BitConnection or BitCider account session with session-bound CSRF',
      guest: 'Room-scoped participant bearer credential with session-bound CSRF',
      guestCredentialScope: 'single room'
    },
    partyRules: {
      maximumParticipants: maximum,
      ownerOnlyControls: 'enforced-by-room-setting',
      privateRoomAdmission: 'invitation plus proximity check or host one-time code',
      hostActions: ['kick', 'ban', 'promote'],
      queueActions: ['add', 'remove', 'move', 'clear', 'loop', 'shuffle'],
      chat: {
        text: true,
        images: ['image/png', 'image/jpeg', 'image/webp'],
        maximumImageBytes: 524288,
        gifs: 'GIPHY HTTPS media URLs only',
        gifSearch: { method: 'GET', path: '/gifs/search', apiKey: 'server-side-only' },
        voice: 'browser speech transcription to editable text; raw audio is not uploaded'
      }
    },
    capabilities: {
      roomCreation: true,
      publicDiscovery: true,
      privateRooms: true,
      synchronizedQueueMetadata: true,
      partyChat: true,
      memberModeration: true,
      directWebRtcAudio: true,
      serverSideOnnxAnalysis: true,
      serverSideOnnxDjPlanning: true,
      serverSideOnnxAutoMix: false,
      liveAutoMixExecution: false,
      sourcePlaybackCommands: false,
      synchronizedLyrics: false
    },
    unavailableFeatures: {
      sourcePlaybackCommands: 'The BitChord player-control bridge is not connected yet.',
      synchronizedLyrics: 'The BitChord lyrics feed is not connected yet.',
      serverSideOnnxAutoMix: 'ONNX beat analysis and DJ transition planning are available. Live execution still needs the BitChord player-control bridge.'
    },
    endpoints: {
      health: { method: 'GET', path: '/health' },
      account: { method: 'GET', path: '/account' },
      createRoom: { method: 'POST', path: '/rooms' },
      publicRooms: { method: 'GET', path: '/rooms/public' },
      joinRoom: { method: 'POST', path: '/rooms/{roomId}/join' },
      roomState: { method: 'GET', path: '/rooms/{roomId}/state' },
      heartbeat: { method: 'POST', path: '/rooms/{roomId}/heartbeat' },
      playbackState: { method: 'POST', path: '/rooms/{roomId}/playback' },
      queue: { method: 'POST', path: '/rooms/{roomId}/queue' },
      autoMixStatus: { method: 'GET', path: '/rooms/{roomId}/automix/status' },
      autoMixPrepare: { method: 'POST', path: '/rooms/{roomId}/automix/prepare' },
      autoMixAnalyze: { method: 'POST', path: '/rooms/{roomId}/automix/analyze/{queueItemId}', contentType: 'application/vnd.bitconnection.pcm-f32le', sampleRate: 22050, channels: 1 },
      autoMixPlan: { method: 'POST', path: '/rooms/{roomId}/automix/plan' },
      chat: { method: 'POST', path: '/rooms/{roomId}/chat' },
      memberModeration: { method: 'POST', path: '/rooms/{roomId}/members/{participantId}/moderate' },
      gifSearch: { method: 'GET', path: '/gifs/search?q={query}' },
      signaling: { method: 'POST', path: '/rooms/{roomId}/signals' },
      leave: { method: 'POST', path: '/rooms/{roomId}/leave' },
      close: { method: 'POST', path: '/rooms/{roomId}/close' }
    }
  };
}

function emptyData() {
  return { accounts: {}, profiles: {}, rooms: {}, authSessions: {}, webauthnChallenges: {}, providerConnections: {} };
}

function readData(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyData();
    return {
      ...emptyData(),
      ...value,
      accounts: value.accounts && typeof value.accounts === 'object' ? value.accounts : {},
      profiles: value.profiles && typeof value.profiles === 'object' ? value.profiles : {},
      rooms: value.rooms && typeof value.rooms === 'object' ? value.rooms : {},
      authSessions: value.authSessions && typeof value.authSessions === 'object' ? value.authSessions : {},
      webauthnChallenges: value.webauthnChallenges && typeof value.webauthnChallenges === 'object' ? value.webauthnChallenges : {},
      providerConnections: value.providerConnections && typeof value.providerConnections === 'object' ? value.providerConnections : {}
    };
  } catch {
    return emptyData();
  }
}

function writeData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function createDataStore(file) {
  let queue = Promise.resolve();
  return {
    read: () => readData(file),
    update(mutator) {
      const operation = queue.then(async () => {
        const data = readData(file);
        const result = await mutator(data);
        if (result?.write !== false) writeData(file, data);
        return result;
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
}

function cleanUsername(value) {
  if (typeof value !== 'string') return '';
  const username = value.trim().replace(/\s+/gu, ' ');
  if (!username || Array.from(username).length > 24 || /[\u0000-\u001f\u007f]/u.test(username)) return '';
  return username;
}

const PARTY_PLAYBACK_SOURCES = new Set(['bitmono', 'ccustom', 'cider']);

function cleanCustomSourceManifestUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.length > 512 || Array.from(raw).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const octets = host.split('.');
    const privateAddress = host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host === '127.0.0.1' || host === '::1'
      || host.startsWith('10.') || host.startsWith('192.168.')
      || (host.startsWith('172.') && Number(octets[1]) >= 16 && Number(octets[1]) <= 31);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || privateAddress || !url.pathname.endsWith('/manifest.json')) return null;
    return url.toString();
  } catch {
    return null;
  }
}
function usernameKey(value) {
  return cleanUsername(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function cleanImageDataUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/);
  if (!match) return undefined;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length > 0 && bytes.length <= 1024 * 1024 ? value : undefined;
}

function profileFor(data, identityId) {
  return data.profiles[identityId] || null;
}

function usernameAvailable(data, username, excludeIdentityId = '') {
  const normalized = usernameKey(username);
  return !Object.entries(data.profiles).some(([identityId, profile]) => (
    identityId !== excludeIdentityId && usernameKey(profile?.username) === normalized
  ));
}

function createRoomCode(existing) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(6);
    const code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
    if (!Object.values(existing).some(room => room.roomCode === code && room.status === 'open')) return code;
  }
  throw new Error('Could not allocate a unique room code.');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

function ensureSessionId(req, res) {
  const existing = readCookie(req, COOKIE_NAME);
  if (SESSION_PATTERN.test(existing)) return existing;
  const created = crypto.randomBytes(32).toString('base64url');
  res.append('Set-Cookie', COOKIE_NAME + '=' + encodeURIComponent(created)
    + '; Path=/api/bitconnection; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
  return created;
}

function makeSecretFile(file) {
  const secretFile = file + '.csrf-key';
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  if (!fs.existsSync(secretFile)) {
    try { fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const secret = fs.readFileSync(secretFile);
  if (secret.length !== 32) throw new Error('BitConnection CSRF key is invalid.');
  return secret;
}

function tokenForSession(secret, sessionId) {
  return crypto.createHmac('sha256', secret)
    .update('bitconnection-csrf-v1:' + sessionId)
    .digest('base64url');
}

function secureEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function createAuthenticatedSession(data, accountId, sessionId, req) {
  const now = Date.now();
  const active = Object.entries(data.authSessions)
    .filter(([, entry]) => entry?.accountId === accountId && Date.parse(entry.expiresAt || 0) > now)
    .sort((a, b) => Date.parse(a[1].lastSeenAt || a[1].createdAt || 0) - Date.parse(b[1].lastSeenAt || b[1].createdAt || 0));
  let evictedDevice = null;
  while (active.length >= MAX_ACCOUNT_DEVICES) {
    const [oldHash, oldDevice] = active.shift();
    delete data.authSessions[oldHash];
    evictedDevice = oldDevice.deviceName || 'the oldest signed-in device';
  }
  const nowIso = new Date(now).toISOString();
  data.authSessions[hashSessionId(sessionId)] = {
    accountId,
    createdAt: nowIso,
    lastSeenAt: nowIso,
    deviceName: String(req.get('user-agent') || 'Unknown device').slice(0, 180),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  };
  return { evictedDevice };
}

function sessionForRequest(data, req, res) {
  const sessionId = ensureSessionId(req, res);
  const authSession = data.authSessions[hashSessionId(sessionId)];
  const accountCandidate = authSession && Date.parse(authSession.expiresAt || 0) > Date.now()
    ? data.accounts[authSession.accountId]
    : null;
  const account = accountCandidate && !accountCandidate.suspendedAt ? accountCandidate : null;
  return {
    sessionId,
    accountId: account ? authSession.accountId : null,
    account: account || null,
    authenticated: Boolean(account)
  };
}

function publicPasskeys(account) {
  return (Array.isArray(account?.passkeys) ? account.passkeys : []).map(passkey => ({
    id: passkey.id,
    name: passkey.name || 'Passkey',
    rpID: passkey.rpID,
    createdAt: passkey.createdAt || null,
    lastUsedAt: passkey.lastUsedAt || null,
    deviceType: passkey.deviceType || 'unknown',
    backedUp: Boolean(passkey.backedUp)
  }));
}

function normalizePasskeyName(value, fallback) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return name || fallback;
}

function createRateLimit(maxAttempts, windowMs = 15 * 60 * 1000) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const key = ip + ':' + req.baseUrl + req.path;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) bucket = { count: 0, startedAt: now };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 5000) {
      for (const [entryKey, entry] of buckets) {
        if (now - entry.startedAt >= windowMs) buckets.delete(entryKey);
      }
    }
    if (bucket.count > maxAttempts) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000))));
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many BitConnection account attempts. Try again later.' });
    }
    return next();
  };
}

export function bitConnectionHealthPayload(maxPartySize = 30) {
  return {
    ok: true,
    service: 'BitConnection',
    apiVersion: BITCONNECTION_API_VERSION,
    deployment: 'Deplexo',
    stage: 'listening-party-workspace-v1',
    capabilities: {
      independentAccounts: 'enabled',
      bitCiderAccountLinking: 'explicit-choice',
      ciderAddonCreation: 'never',
      hostProfiles: 'enabled',
      roomCreation: 'enabled',
      passkeys: 'enabled',
      passkeyListing: 'enabled',
      recoveryCodes: 'enabled',
      realtimeRooms: 'polling-and-webrtc-signaling-enabled',
      playbackSync: 'bitmono-ccustom-cider-source-audio-over-webrtc',
      sharedQueue: 'bitmono-ccustom-and-cider-track-sources-synchronized-with-room-permissions',
      queueLoopAndShuffle: 'enabled',
      partyChat: 'text-images-and-giphy-gifs-enabled',
      memberModeration: 'kick-ban-and-host-promotion-enabled',
      privateRoomVerification: 'proximity-or-host-one-time-code',
      playbackSourceBridge: 'bitmono-ccustom-cider-in-page-audio-element-over-webrtc',
      playbackSourceOptions: ['bitmono', 'ccustom', 'cider'],
      bitMonoPlayback: 'in-page-audio-element-published-over-webrtc',
      appleMusicRecommendations: 'automatic-web-player-bearer-plus-subscriber-token-private-endpoint-experimental',
      appleMusicTtmlLyrics: 'automatic-web-player-bearer-plus-subscriber-token-private-endpoint-experimental',
      appleMusicWebPlayerToken: 'optional-server-side-override',
      synchronizedLyrics: 'not-connected',
      serverSideAutoMix: 'onnx-analysis-and-dj-planning-ready-player-bridge-required',
      serverSideAudioAnalysis: 'host-uploaded-to-deplexo-not-relayed',
      audioRelay: 'never-server-side',
      iceConfiguration: 'participant-scoped-stun-and-short-lived-turn-credentials'
    },
    limits: { maxPartySize }
  };
}

export function createBitConnectionRouter({
  getUserSession = () => ({ authenticated: false }),
  requireCiderCsrf = (_req, _res, next) => next(),
  csrfTokenForCiderSession = () => '',
  webAuthnContext = req => {
    const origin = req.get('origin');
    const parsed = origin ? new URL(origin) : null;
    if (!parsed || parsed.protocol !== 'https:') throw new Error('Passkeys require the official HTTPS BitConnection website.');
    return { origin: parsed.origin, rpID: parsed.hostname };
  },
  dataFile,
  maxPartySize = 30,
  iceConfig = {},
  giphyApiKey = process.env.BITCONNECTION_GIPHY_API_KEY || '',
  fetchImpl = globalThis.fetch,
  appleMusicWebPlayerToken = process.env.APPLE_MUSIC_WEB_PLAYER_TOKEN || '',
  appleMusicPlaybackDeveloperToken = process.env.APPLE_MUSICKIT_DEVELOPER_TOKEN || '',
  encryptProviderCredential = null,
  decryptProviderCredential = null,
  providerCredentialEncryptionConfigured = () => false,
  automixDirectory,
  exposeAdminStore = null
} = {}) {
  if (!dataFile) throw new TypeError('BitConnection dataFile is required.');
  const store = createDataStore(dataFile);
  const secret = makeSecretFile(dataFile);
  const autoMix = createAutoMixService({
    directory: automixDirectory || path.join(path.dirname(path.resolve(dataFile)), 'bitconnection-automix')
  });
  async function createAdminBotAccount({ username, password }) {
    const normalizedUsername = cleanUsername(username);
    if (!normalizedUsername || !validatePassword(password)) return { status: 400, error: 'INVALID_BOT_CREDENTIALS' };
    const passwordRecord = await createPasswordRecord(password);
    const recovery = createRecoveryCodes();
    const accountId = crypto.randomBytes(24).toString('base64url');
    const webAuthnUserId = crypto.randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    const result = await store.update(data => {
      if (!usernameAvailable(data, normalizedUsername)) {
        return { status: 409, error: 'BOT_USERNAME_TAKEN', write: false };
      }
      data.accounts[accountId] = {
        username: normalizedUsername,
        password: passwordRecord,
        recoveryCodeHashes: recovery.hashes,
        webAuthnUserId,
        passkeys: [],
        createdAt,
        adminBot: true
      };
      data.profiles['bitconnection:' + accountId] = {
        username: normalizedUsername, avatarDataUrl: null, createdAt, updatedAt: createdAt
      };
      return { ok: true, accountId };
    });
    return result.status ? result : { ok: true, accountId, recoveryCodes: recovery.codes };
  }
  if (typeof exposeAdminStore === 'function') {
    exposeAdminStore({
      read: () => store.read(),
      update: mutator => store.update(mutator),
      createBotAccount: createAdminBotAccount
    });
  }
  const router = express.Router();
  router.use(bitConnectionCorsMiddleware);
  const maximum = Number.isSafeInteger(Number(maxPartySize))
    ? Math.min(30, Math.max(2, Number(maxPartySize)))
    : 30;
  const rateRegister = createRateLimit(4);
  const rateLogin = createRateLimit(10);
  const rateRecover = createRateLimit(5);
  const ratePasskey = createRateLimit(8);
  const rateJoin = createRateLimit(24, 60 * 1000);
  const ratePublicDiscovery = createRateLimit(120, 60 * 1000);
  const rateGifSearch = createRateLimit(30, 60 * 1000);
  const rateAppleMusic = createRateLimit(12, 60 * 1000);
  const rateSignal = createRateLimit(180, 60 * 1000);
  const rateAutoMix = createRateLimit(12, 60 * 1000);
  const hostLocations = new Map();
  const pendingVerificationCodes = new Map();
  const PRESENCE_TTL_MS = 75 * 1000;
  const HOST_LOCATION_TTL_MS = 60 * 1000;
  const PRIVATE_ROOM_RADIUS_METERS = 20;

  function bitConnectionCsrf(req, res, next) {
    const sessionId = ensureSessionId(req, res);
    const expected = tokenForSession(secret, sessionId);
    const supplied = req.get('x-bitconnection-csrf') || '';
    if (!secureEqual(expected, supplied)) {
      return res.status(403).json({ error: 'CSRF_REJECTED', message: 'Refresh BitConnection and try again.' });
    }
    req.bitConnectionSessionId = sessionId;
    return next();
  }

  function activeSession(req, res) {
    const data = store.read();
    const session = sessionForRequest(data, req, res);
    if (session.authenticated) {
      const active = data.authSessions[hashSessionId(session.sessionId)];
      if (active) {
        active.lastSeenAt = new Date().toISOString();
        void store.update(latest => {
          const current = latest.authSessions[hashSessionId(session.sessionId)];
          if (current?.accountId === session.accountId) current.lastSeenAt = active.lastSeenAt;
          return { ok: true };
        });
      }
    }
    return { ...session, data };
  }

  function identityForRequest(req, res) {
    const identityMode = req.get('x-bitconnection-identity') || '';
    if (identityMode === 'bitcider') {
      const cider = getUserSession(req, res);
      if (!cider?.authenticated || !cider.accountId) return null;
      return {
        type: 'bitcider',
        identityId: 'cider:' + cider.accountId,
        accountId: cider.accountId,
        username: null,
        csrfToken: csrfTokenForCiderSession(cider.sessionId)
      };
    }
    const session = activeSession(req, res);
    if (!session.authenticated || !session.accountId) return null;
    return {
      type: 'bitconnection',
      identityId: 'bitconnection:' + session.accountId,
      accountId: session.accountId,
      username: session.account.username,
      csrfToken: tokenForSession(secret, session.sessionId),
      account: session.account,
      sessionId: session.sessionId
    };
  }

  function identityCsrf(req, res, next) {
    if (req.get('x-bitconnection-identity') === 'bitcider') return requireCiderCsrf(req, res, next);
    return bitConnectionCsrf(req, res, next);
  }

  function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }

  function bearerCredential(req) {
    const header = String(req.get('authorization') || '');
    return /^Bearer [A-Za-z0-9_-]{32,100}$/.test(header) ? header.slice(7) : '';
  }

  function participantForRoom(room, req, res) {
    const credential = bearerCredential(req);
    if (credential) {
      const credentialHash = sha256(credential);
      const match = Object.values(room.participants || {}).find(item => (
        item?.credentialHash && secureEqual(item.credentialHash, credentialHash) && item.status !== 'left'
      ));
      if (match) return match;
    }
    const identity = identityForRequest(req, res);
    if (identity?.identityId && identity.identityId === room.hostIdentityId) {
      return room.participants?.[room.hostParticipantId] || {
        participantId: room.hostParticipantId,
        username: room.hostUsername,
        role: 'host',
        status: 'connected',
        identityId: room.hostIdentityId
      };
    }
    return null;
  }

  function isRoomOwner(room, participant) {
    return Boolean(participant && participant.role === 'host' && participant.participantId === room.hostParticipantId);
  }

  function participantCount(room) {
    const now = Date.now();
    return Object.values(room.participants || {}).filter(item => (
      item?.status !== 'left'
      && Date.parse(item?.lastSeenAt || 0) > now - PRESENCE_TTL_MS
    )).length;
  }

  function createParticipant(room, { username, role = 'guest', identityId = null, avatarDataUrl = null }) {
    const credential = crypto.randomBytes(32).toString('base64url');
    const participantId = crypto.randomBytes(12).toString('hex');
    const participant = {
      participantId,
      username,
      role,
      identityId,
      avatarDataUrl: typeof avatarDataUrl === 'string' ? avatarDataUrl : null,
      credentialHash: sha256(credential),
      volume: 1,
      status: 'connected',
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    room.participants ||= {};
    room.participants[participantId] = participant;
    return { participant, credential };
  }

  const guestAdjectives = [
    'Velvet', 'Quiet', 'Golden', 'Silver', 'Cosmic', 'Mellow', 'Neon', 'Lucky',
    'Sunny', 'Misty', 'Fuzzy', 'Crystal', 'Indigo', 'Gentle', 'Dizzy', 'Hidden',
    'Turbo', 'Lucky', 'Clever', 'Sleepy', 'Static', 'Pixel', 'Marble', 'Echo'
  ];
  const guestNouns = [
    'Comet', 'Otter', 'Falcon', 'Koala', 'Panda', 'Badger', 'Orchid', 'Raven',
    'Meteor', 'Mango', 'Pebble', 'Tiger', 'Robin', 'Clover', 'Badger', 'Penguin',
    'Lantern', 'Dolphin', 'Moth', 'Fox', 'Nebula', 'Bumblebee', 'Waffle', 'Pigeon'
  ];

  function temporaryGuestName(room) {
    const used = new Set(Object.values(room.participants || {}).map(item => item?.username));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const adjective = guestAdjectives[crypto.randomInt(guestAdjectives.length)];
      const noun = guestNouns[crypto.randomInt(guestNouns.length)];
      const digits = String(crypto.randomInt(1000)).padStart(3, '0');
      const candidate = adjective + noun + digits;
      if (!used.has(candidate)) return candidate;
    }
    return 'Guest' + crypto.randomInt(100000, 999999);
  }

  function cleanYouTubeTrack(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const videoId = String(value.videoId || '');
    const title = String(value.title || '').trim();
    const artist = String(value.artist || '').trim();
    const durationSeconds = Number(value.durationSeconds);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !title || title.length > 180
      || !artist || artist.length > 180 || !Number.isFinite(durationSeconds)
      || durationSeconds < 0 || durationSeconds > 24 * 60 * 60) return null;
    const artworkCandidate = String(value.thumbnailUrl || value.artwork || '').trim().slice(0, 2048);
    let artworkUrl = '';
    if (artworkCandidate) {
      try {
        const parsedArtwork = new URL(artworkCandidate);
        if (parsedArtwork.protocol === 'https:' && !parsedArtwork.username && !parsedArtwork.password) {
          artworkUrl = parsedArtwork.toString();
        }
      } catch {
        artworkUrl = '';
      }
    }
    const qualityCandidate = String(value.audioQuality || value.quality || '').trim().slice(0, 40);
    const quality = /dolby\s*atmos|\bjoc\b/i.test(qualityCandidate) ? 'Dolby Atmos'
      : /hi[\s-]?res/i.test(qualityCandidate) ? 'Hi-Res Lossless'
        : /lossless/i.test(qualityCandidate) ? 'Lossless' : '';
    return {
      videoId, title, artist, durationSeconds,
      ...(artworkUrl ? { artwork: artworkUrl } : {}),
      ...(quality ? { audioQuality: quality } : {})
    };
  }



  function cleanBitMonoTrack(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = String(value.id || value.trackId || '').trim();
    const title = String(value.title || '').trim();
    const artist = String(value.artist || '').trim();
    const durationSeconds = Number(value.durationSeconds ?? value.duration);
    if (!/^(?:mono_|dzr_)[A-Za-z0-9_-]{1,128}$/.test(id)
      || !title || title.length > 180
      || !artist || artist.length > 180
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 24 * 60 * 60) return null;
    const artworkCandidate = String(value.artworkURL || value.artworkUrl || value.thumbnailUrl || value.artwork || '').trim().slice(0, 2048);
    let artworkUrl = '';
    if (artworkCandidate) {
      try {
        const parsed = new URL(artworkCandidate);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) artworkUrl = parsed.toString();
      } catch { /* Untrusted artwork is omitted. */ }
    }
    const qualityCandidate = String(value.audioQuality || value.quality || '').trim().slice(0, 40);
    const quality = /dolby\s*atmos|\bjoc\b/i.test(qualityCandidate) ? 'Dolby Atmos'
      : /hi[\s-]?res/i.test(qualityCandidate) ? 'Hi-Res Lossless'
        : /lossless/i.test(qualityCandidate) ? 'Lossless'
          : /high|320|256/i.test(qualityCandidate) ? 'High Quality' : '';
    const appleMusicSongId = String(value.appleMusicSongId || '').trim();
    const appleMusicStorefront = String(value.appleMusicStorefront || '').trim().toLowerCase();
    return {
      source: 'bitmono',
      trackId: id,
      title,
      artist,
      durationSeconds,
      ...(artworkUrl ? { thumbnailUrl: artworkUrl } : {}),
      ...(quality ? { audioQuality: quality } : {}),
      ...( /^[0-9]{1,20}$/.test(appleMusicSongId) ? { appleMusicSongId } : {}),
      ...( /^[a-z]{2}$/.test(appleMusicStorefront) ? { appleMusicStorefront } : {})
    };
  }

  function cleanPartyAddonTrack(value, source) {
    if (!['ccustom', 'cider'].includes(source) || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = String(value.id || value.trackId || value.catalogId || '').trim();
    const title = String(value.title || '').trim();
    const artist = String(value.artist || value.artistName || '').trim();
    const durationSeconds = Number(value.durationSeconds ?? value.duration);
    const hasControlCharacter = [...id].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (!id || id.length > 180 || hasControlCharacter
      || !title || title.length > 180
      || !artist || artist.length > 180
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 24 * 60 * 60) return null;
    const artworkCandidate = String(value.artworkURL || value.artworkUrl || value.thumbnailUrl || value.artwork || '').trim().slice(0, 2048);
    let thumbnailUrl = '';
    if (artworkCandidate) {
      try {
        const parsed = new URL(artworkCandidate);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) thumbnailUrl = parsed.toString();
      } catch { /* Untrusted artwork is omitted. */ }
    }
    const qualityCandidate = String(value.audioQuality || value.quality || '').trim().slice(0, 40).toLowerCase();
    const quality = qualityCandidate.includes('atmos') || qualityCandidate.includes('joc') ? 'Dolby Atmos'
      : qualityCandidate.includes('hi-res') || qualityCandidate.includes('hi res') ? 'Hi-Res Lossless'
        : qualityCandidate.includes('lossless') ? 'Lossless'
          : qualityCandidate.includes('high') || qualityCandidate.includes('320') || qualityCandidate.includes('256') ? 'High Quality' : '';
    return {
      source,
      trackId: id,
      title,
      artist,
      durationSeconds,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(quality ? { audioQuality: quality } : {})
    };
  }


  function cleanAppleMusicTrack(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = String(value.appleMusicSongId || value.trackId || value.id || '').trim();
    const title = String(value.title || '').trim();
    const artist = String(value.artist || '').trim();
    const durationSeconds = Number(value.durationSeconds ?? 0);
    if (!/^[0-9]{1,20}$/.test(id)
      || !title || title.length > 180
      || !artist || artist.length > 180
      || !Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 24 * 60 * 60) return null;

    const artworkCandidate = String(value.artworkUrl || value.thumbnailUrl || value.artwork || '').trim().slice(0, 2048);
    let thumbnailUrl = '';
    if (artworkCandidate) {
      try {
        const parsed = new URL(artworkCandidate);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) thumbnailUrl = parsed.toString();
      } catch { /* Untrusted artwork is omitted. */ }
    }
    const storefront = String(value.appleMusicStorefront || value.storefront || '').trim().toLowerCase();
    const allowedAudioVariants = new Set(['dolby-atmos', 'hi-res-lossless', 'lossless', 'dolby-audio', 'lossy-stereo']);
    const audioVariants = Array.isArray(value.audioVariants)
      ? [...new Set(value.audioVariants.map(item => String(item || '').trim().toLowerCase()).filter(item => allowedAudioVariants.has(item)))].slice(0, 5)
      : [];
    const urlCandidate = String(value.url || value.appleMusicUrl || '').trim().slice(0, 2048);
    let appleMusicUrl = '';
    if (urlCandidate) {
      try {
        const parsed = new URL(urlCandidate);
        if (parsed.protocol === 'https:' && /(^|\.)music\.apple\.com$/i.test(parsed.hostname)) appleMusicUrl = parsed.toString();
      } catch { /* Untrusted catalog URL is omitted. */ }
    }
    return {
      source: 'apple-music',
      trackId: id,
      appleMusicSongId: id,
      title,
      artist,
      durationSeconds,
      playbackMode: value.playbackMode === 'embed' ? 'embed' : 'musickit',
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(audioVariants.length ? { audioVariants } : {}),
      ...( /^[a-z]{2}$/.test(storefront) ? { appleMusicStorefront: storefront } : {}),
      ...(appleMusicUrl ? { appleMusicUrl } : {})
    };
  }

  function cleanCoordinates(value) {
    const latitude = Number(value?.latitude);
    const longitude = Number(value?.longitude);
    const accuracy = Number(value?.accuracy);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1000) return null;
    return { latitude, longitude, accuracy };
  }

  function distanceMeters(left, right) {
    const radians = degrees => degrees * Math.PI / 180;
    const dLat = radians(right.latitude - left.latitude);
    const dLon = radians(right.longitude - left.longitude);
    const lat1 = radians(left.latitude);
    const lat2 = radians(right.latitude);
    const haversine = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  function publicParticipant(item, now = Date.now()) {
    return {
      participantId: item.participantId,
      username: item.username,
      role: item.role,
      status: item.status === 'left'
        ? 'left'
        : Date.parse(item.lastSeenAt || 0) > now - PRESENCE_TTL_MS ? 'connected' : 'disconnected',
      joinedAt: item.joinedAt,
      avatarDataUrl: typeof item.avatarDataUrl === 'string' && item.avatarDataUrl.length <= 180000 ? item.avatarDataUrl : null,
      canBan: Boolean(item.identityId)
    };
  }

  function publicRoom(room) {
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      roomName: room.roomName,
      visibility: room.visibility,
      partySize: room.partySize,
      ownerOnlyControls: room.ownerOnlyControls,
      playbackSource: PARTY_PLAYBACK_SOURCES.has(room.playbackSource) ? room.playbackSource : 'bitmono',
      hostUsername: room.hostUsername,
      status: room.status,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt
    };
  }

  function publicDirectoryRoom(room) {
    const activeParticipants = participantCount(room);
    const track = room.playbackState?.track;
    return {
      ...publicRoom(room),
      participantCount: activeParticipants,
      isPlaying: Boolean(room.playbackState?.isPlaying),
      currentTrack: track && typeof track === 'object' ? {
        title: String(track.title || '').slice(0, 160),
        artist: String(track.artist || '').slice(0, 160)
      } : null
    };
  }

  function randomRooms(items, count = 3) {
    const shuffled = [...items];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = crypto.randomInt(index + 1);
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    return shuffled.slice(0, count);
  }

  function roomResponse(room, participant) {
    return {
      room: publicRoom(room),
      participant: publicParticipant(participant),
      participants: Object.values(room.participants || {})
        .filter(item => item?.status !== 'left')
        .map(item => publicParticipant(item)),
      currentVolume: Number(participant.volume ?? 1)
    };
  }

  async function saveChallenge(sessionId, record) {
    return store.update(data => {
      const now = Date.now();
      for (const [key, item] of Object.entries(data.webauthnChallenges)) {
        if (!item || Number(item.expiresAt) <= now) delete data.webauthnChallenges[key];
      }
      data.webauthnChallenges[hashSessionId(sessionId)] = {
        ...record,
        expiresAt: now + WEBAUTHN_CHALLENGE_TTL_MS
      };
      return { ok: true };
    });
  }

  async function consumeChallenge(sessionId, purpose, accountId = null) {
    const result = await store.update(data => {
      const key = hashSessionId(sessionId);
      const challenge = data.webauthnChallenges[key];
      if (!challenge) return { challenge: null, write: false };
      delete data.webauthnChallenges[key];
      if (challenge.purpose !== purpose || Number(challenge.expiresAt) <= Date.now()
        || (accountId && challenge.accountId !== accountId)) return { challenge: null };
      return { challenge };
    });
    return result.challenge;
  }

  router.get('/rooms/public', ratePublicDiscovery, (req, res) => {
    const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';
    const query = rawQuery.trim().slice(0, 80).normalize('NFKC').toLocaleLowerCase('en-US');
    const data = store.read();
    const rooms = Object.values(data.rooms)
      .filter(room => room?.visibility === 'public' && room.status === 'open' && participantCount(room) > 0)
      .map(publicDirectoryRoom)
      .filter(room => !query || [
        room.roomName,
        room.hostUsername,
        room.currentTrack?.title,
        room.currentTrack?.artist
      ].some(value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').includes(query)))
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
    res.set('Cache-Control', 'no-store');
    return res.json({
      featured: randomRooms(rooms, 3),
      rooms: rooms.slice(0, 30),
      total: rooms.length
    });
  });

  router.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(bitConnectionHealthPayload(maximum));
  });

  router.get('/gifs/search', rateGifSearch, async (req, res) => {
    if (!String(giphyApiKey || '').trim()) {
      return res.status(503).json({
        error: 'GIF_SEARCH_NOT_CONFIGURED',
        message: 'GIF search is not configured on this BitConnection deployment.'
      });
    }
    if (typeof fetchImpl !== 'function') {
      return res.status(503).json({ error: 'GIF_SEARCH_UNAVAILABLE' });
    }
    const query = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (!query) return res.status(400).json({ error: 'GIF_SEARCH_QUERY_REQUIRED' });
    try {
      const params = new URLSearchParams({
        api_key: String(giphyApiKey).trim(),
        q: query,
        limit: '18',
        rating: 'pg-13',
        lang: 'en',
        bundle: 'messaging_non_clips'
      });
      const response = await fetchImpl('https://api.giphy.com/v1/gifs/search?' + params.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload?.data)) {
        return res.status(502).json({
          error: 'GIF_PROVIDER_ERROR',
          message: 'GIPHY could not complete this search. Try again in a moment.'
        });
      }
      const safeMediaUrl = value => {
        try {
          const parsed = new URL(String(value || ''));
          return parsed.protocol === 'https:' && !parsed.username && !parsed.password
            && /(^|\.)giphy\.com$/i.test(parsed.hostname) ? parsed.toString() : '';
        } catch {
          return '';
        }
      };
      const gifs = payload.data.map(item => ({
        id: String(item?.id || '').slice(0, 80),
        preview: safeMediaUrl(item?.images?.fixed_width_small?.webp || item?.images?.fixed_width_small?.url),
        url: safeMediaUrl(item?.images?.original?.url || item?.images?.downsized_large?.url || item?.images?.downsized?.url),
        title: String(item?.title || '').slice(0, 120)
      })).filter(item => item.id && item.preview && item.url);
      res.set('Cache-Control', 'private, max-age=30');
      return res.json({ gifs, attribution: 'Powered by GIPHY' });
    } catch {
      return res.status(502).json({
        error: 'GIF_PROVIDER_UNAVAILABLE',
        message: 'Could not reach GIPHY right now.'
      });
    }
  });

  router.get('/party-service', (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(buildBitConnectionPartyServiceDescriptor(req, maximum));
  });


  router.get('/account', (req, res) => {
    const identityMode = req.get('x-bitconnection-identity') || '';
    if (identityMode === 'bitcider') {
      const identity = identityForRequest(req, res);
      if (!identity) return res.status(401).json({ error: 'BITCIDER_SIGN_IN_REQUIRED' });
      const data = store.read();
      const profile = profileFor(data, identity.identityId);
      return res.json({
        authenticated: true,
        provider: 'BitCider',
        identityMode: 'bitcider',
        csrfToken: identity.csrfToken,
        profile: profile ? {
          username: profile.username,
          avatarDataUrl: profile.avatarDataUrl || null,
          playbackSource: PARTY_PLAYBACK_SOURCES.has(profile.playbackSource) ? profile.playbackSource : 'bitmono',
          customSourceManifestUrl: typeof profile.customSourceManifestUrl === 'string' ? profile.customSourceManifestUrl : '',
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt
        } : null,
        maxPartySize: maximum
      });
    }

    const session = activeSession(req, res);
    const profile = session.authenticated ? profileFor(session.data, 'bitconnection:' + session.accountId) : null;
    const cider = getUserSession(req, res);
    return res.json({
      authenticated: session.authenticated,
      provider: session.authenticated ? 'BitConnection' : null,
      identityMode: session.authenticated ? 'bitconnection' : null,
      profile: profile ? {
          username: profile.username,
          avatarDataUrl: profile.avatarDataUrl || null,
          playbackSource: PARTY_PLAYBACK_SOURCES.has(profile.playbackSource) ? profile.playbackSource : 'bitmono',
          customSourceManifestUrl: typeof profile.customSourceManifestUrl === 'string' ? profile.customSourceManifestUrl : '',
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt
        } : null,
      csrfToken: tokenForSession(secret, session.sessionId),
      bitCiderAccountAvailable: Boolean(cider?.authenticated && cider?.accountId),
      maxPartySize: maximum,
      passkeyCount: session.authenticated ? publicPasskeys(session.account).length : 0
    });
  });



  function appleMusicAuthHeaders(userMediaToken, webPlayerBearer) {
    return {
      Accept: 'application/json',
      Authorization: 'Bearer ' + webPlayerBearer,
      'Media-User-Token': userMediaToken,
      'Music-User-Token': userMediaToken,
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    };
  }

  function validAppleMusicUserToken(value) {
    return typeof value === 'string'
      && value.length >= 20
      && value.length <= 4096
      && !/[\u0000-\u0020\u007f]/u.test(value);
  }

  let cachedAppleWebPlayerToken = '';
  let cachedAppleWebPlayerTokenExpiresAt = 0;
  let appleWebPlayerTokenDiscoveryPromise = null;

  function appleJwtExpiry(token) {
    try {
      const payload = String(token).split('.')[1];
      if (!payload) return 0;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return Number(claims.exp) || 0;
    } catch { return 0; }
  }

  function appleWebPlayerBundleUrls(html) {
    const urls = [];
    const expression = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/gi;
    for (const match of String(html || '').matchAll(expression)) {
      try {
        const url = new URL(match[1], 'https://music.apple.com/');
        if (url.protocol !== 'https:') continue;
        if (!['music.apple.com', 'js-cdn.music.apple.com'].includes(url.hostname.toLowerCase())) continue;
        if (!/index|music|main/i.test(url.pathname)) continue;
        if (!urls.includes(url.toString())) urls.push(url.toString());
      } catch { /* Ignore invalid script sources. */ }
    }
    return urls.slice(0, 8);
  }

  function extractUsableAppleWebPlayerToken(bundleText) {
    const expression = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
    const now = Math.floor(Date.now() / 1000);
    for (const match of String(bundleText || '').matchAll(expression)) {
      const token = match[0];
      const expiresAt = appleJwtExpiry(token);
      if (expiresAt > now + 120) return { token, expiresAt };
    }
    return null;
  }

  async function resolveAppleMusicWebPlayerToken() {
    const configured = String(appleMusicWebPlayerToken || '').trim().replace(/^Bearer\s+/i, '');
    if (configured) return configured;
    const now = Math.floor(Date.now() / 1000);
    if (cachedAppleWebPlayerToken && cachedAppleWebPlayerTokenExpiresAt > now + 120) return cachedAppleWebPlayerToken;
    if (appleWebPlayerTokenDiscoveryPromise) return appleWebPlayerTokenDiscoveryPromise;
    appleWebPlayerTokenDiscoveryPromise = (async () => {
      if (typeof fetchImpl !== 'function') throw appleMusicError(503, 'Apple Music web-player token discovery is unavailable.');
      const headers = {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      };
      const pageResponse = await fetchImpl('https://music.apple.com/us/browse', {
        method: 'GET', headers, cache: 'no-store', redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });
      if (!pageResponse.ok) throw appleMusicError(503, 'Apple Music web-player token could not be discovered from music.apple.com.');
      const html = await pageResponse.text();
      for (const bundleUrl of appleWebPlayerBundleUrls(html)) {
        try {
          const bundleResponse = await fetchImpl(bundleUrl, {
            method: 'GET',
            headers: { ...headers, Accept: 'application/javascript,text/javascript,*/*' },
            cache: 'no-store', redirect: 'follow',
            signal: AbortSignal.timeout(15000)
          });
          if (!bundleResponse.ok) continue;
          const candidate = extractUsableAppleWebPlayerToken(await bundleResponse.text());
          if (candidate) {
            cachedAppleWebPlayerToken = candidate.token;
            cachedAppleWebPlayerTokenExpiresAt = candidate.expiresAt;
            return candidate.token;
          }
        } catch { /* Try the next Apple Music bundle candidate. */ }
      }
      throw appleMusicError(503, 'Apple Music changed its web-player bundle; an automatic Bearer token could not be extracted.');
    })();
    try { return await appleWebPlayerTokenDiscoveryPromise; }
    finally { appleWebPlayerTokenDiscoveryPromise = null; }
  }

  function appleMusicError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  async function requestAppleMusicJson(url, userMediaToken) {
    if (typeof fetchImpl !== 'function') {
      throw appleMusicError(503, 'Apple Music requests are unavailable on this backend.');
    }

    const hasBearerOverride = Boolean(String(appleMusicWebPlayerToken || '').trim());
    let webPlayerBearer = await resolveAppleMusicWebPlayerToken();
    const send = bearer => fetchImpl(url, {
      method: 'GET',
      headers: appleMusicAuthHeaders(userMediaToken, bearer),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000)
    });

    let response = await send(webPlayerBearer);
    if ((response.status === 401 || response.status === 403) && !hasBearerOverride) {
      // Apple rotates the public web-player JWT. Refresh it once before
      // treating the subscriber's stored Media-User-Token as invalid.
      cachedAppleWebPlayerToken = '';
      cachedAppleWebPlayerTokenExpiresAt = 0;
      webPlayerBearer = await resolveAppleMusicWebPlayerToken();
      response = await send(webPlayerBearer);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? 401
        : response.status === 429 ? 429
          : 502;
      throw appleMusicError(status, status === 401
        ? 'Apple Music rejected the web-player or subscriber token. Refresh the User Media Token in BitAccount Center if the private request keeps failing.'
        : status === 429
          ? 'Apple Music is rate limiting requests. Try again shortly.'
          : 'Apple Music could not complete this private web-player request.');
    }
    return payload;
  }

  function normalizeAppleArtwork(value) {
    const template = String(value || '').trim();
    if (!template) return '';
    const expanded = template
      .replaceAll('{w}', '600')
      .replaceAll('{h}', '600')
      .replaceAll('{f}', 'jpg');
    try {
      const url = new URL(expanded);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      // Public iTunes Search uses 100x100/200x200 artwork derivatives. Ask
      // the Apple CDN for the larger cover used in the full-screen Browser.
      url.pathname = url.pathname.replace(new RegExp('/[0-9]{2,4}x[0-9]{2,4}(?=bb)', 'i'), '/600x600');
      return url.toString();
    } catch {
      return '';
    }
  }

  function normalizeAppleRecommendationItem(item) {
    const attributes = item?.attributes || {};
    const type = String(item?.type || '');
    const title = String(attributes.name || attributes.title || '').trim().slice(0, 180);
    if (!title) return null;
    const artworkUrl = normalizeAppleArtwork(attributes.artwork?.url);
    const url = String(attributes.url || '');
    let safeUrl = '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && /(^|\.)music\.apple\.com$/i.test(parsed.hostname)) safeUrl = parsed.toString();
    } catch { /* Apple content without a public URL can still be shown. */ }
    return {
      id: String(item.id || '').slice(0, 160),
      type: type.slice(0, 40),
      title,
      artist: String(attributes.artistName || '').trim().slice(0, 180),
      album: String(attributes.albumName || '').trim().slice(0, 180),
      artworkUrl,
      url: safeUrl,
      durationMillis: Number.isFinite(Number(attributes.durationInMillis)) ? Number(attributes.durationInMillis) : null
    };
  }


  function safeAppleMotionVideoUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      const host = url.hostname.toLowerCase();
      const appleHost = host === 'mvod.itunes.apple.com'
        || host.endsWith('.itunes.apple.com')
        || host.endsWith('.mzstatic.com');
      return url.protocol === 'https:' && appleHost && !url.username && !url.password
        && /\.(?:mp4|m4v|mov|webm)(?:[?#]|$)/i.test(url.pathname + url.search)
        ? url.toString() : '';
    } catch { return ''; }
  }

  function appleEditorialVideoUrl(editorialVideo, variant) {
    const candidates = variant === 'tall'
      ? [editorialVideo?.motionDetailTall?.video, editorialVideo?.motionDetailPortrait?.video]
      : [
          editorialVideo?.motionDetailSquare?.video,
          editorialVideo?.motionSquareVideo1x1?.video,
          editorialVideo?.motionDetailSquareVideo1x1?.video,
          editorialVideo?.motionVideo?.video
        ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const safe = safeAppleMotionVideoUrl(candidate);
        if (safe) return safe;
      }
      if (!candidate || typeof candidate !== 'object') continue;
      for (const key of ['video1080p', 'video720p', 'video480p', 'video', 'videoUrl', 'url']) {
        const safe = safeAppleMotionVideoUrl(candidate[key]);
        if (safe) return safe;
      }
    }
    return '';
  }

  function safeAppleCatalogPageUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && url.hostname.toLowerCase() === 'music.apple.com'
        && !url.username && !url.password ? url.toString() : '';
    } catch { return ''; }
  }

  async function currentAppleMusicIdentity(req, res) {
    const identity = identityForRequest(req, res);
    if (!identity) return null;
    return identity;
  }

  function storedAppleMusicConnection(data, identityId) {
    return data.providerConnections?.[identityId]?.appleMusic || null;
  }

  router.get('/account/providers/apple-music', (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to BitAccount Center to manage Apple Music.' });
    }
    const data = store.read();
    const connection = storedAppleMusicConnection(data, identity.identityId);
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      provider: 'Apple Music',
      connected: Boolean(connection?.userMediaTokenEncrypted),
      connectedAt: connection?.connectedAt || null,
      recommendationsConfigured: typeof fetchImpl === 'function',
      musicKitPlaybackConfigured: Boolean(String(appleMusicPlaybackDeveloperToken || '').trim()),
      musicKitPlayback: 'official-musickit-web-v3',
      recommendationsAuthentication: 'automatic-web-player-bearer-plus-user-media-token-private-endpoint-experimental',
      lyricsAuthentication: 'automatic-web-player-bearer-plus-user-media-token',
      webPlayerTokenOverrideConfigured: Boolean(String(appleMusicWebPlayerToken || '').trim()),
      secureStorageConfigured: Boolean(providerCredentialEncryptionConfigured())
    });
  });

  router.get('/account/providers/apple-music/playback-config', (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) {
      return res.status(401).json({
        error: 'SIGN_IN_REQUIRED',
        message: 'Sign in to BitAccount Center before starting Apple Music playback.'
      });
    }
    const developerToken = String(appleMusicPlaybackDeveloperToken || '').trim();
    res.set('Cache-Control', 'private, no-store');
    if (!developerToken) {
      return res.json({
        provider: 'musickit-web-v3',
        configured: false,
        playbackMode: 'apple-music-embed',
        message: 'Direct MusicKit playback is not configured. The official Apple Music embedded player remains available without a developer token.'
      });
    }
    return res.json({
      provider: 'musickit-web-v3',
      configured: true,
      developerToken,
      scriptUrl: 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'
    });
  });

  router.put('/account/providers/apple-music', identityCsrf, rateAppleMusic, async (req, res) => {
    const identity = await currentAppleMusicIdentity(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to BitAccount Center before connecting Apple Music.' });
    }
    const userMediaToken = typeof req.body?.userMediaToken === 'string'
      ? req.body.userMediaToken.trim()
      : '';
    if (!validAppleMusicUserToken(userMediaToken)) {
      return res.status(400).json({
        error: 'INVALID_APPLE_MUSIC_USER_TOKEN',
        message: 'Enter a valid Apple Music User Media Token without spaces or line breaks.'
      });
    }
    if (typeof encryptProviderCredential !== 'function'
      || typeof decryptProviderCredential !== 'function'
      || !providerCredentialEncryptionConfigured()) {
      return res.status(503).json({
        error: 'SECURE_PROVIDER_STORAGE_NOT_CONFIGURED',
        message: 'Secure provider storage is unavailable until the Deplexo encryption key is configured.'
      });
    }

    const encrypted = encryptProviderCredential(userMediaToken);
    if (!encrypted || typeof encrypted !== 'object' || typeof encrypted.value !== 'string') {
      return res.status(503).json({
        error: 'PROVIDER_CREDENTIAL_ENCRYPTION_FAILED',
        message: 'The Apple Music token could not be secured. No connection was saved.'
      });
    }
    await store.update(data => {
      data.providerConnections ||= {};
      const record = data.providerConnections[identity.identityId] || {};
      record.appleMusic = {
        userMediaTokenEncrypted: encrypted,
        connectedAt: new Date().toISOString(),
        tokenValidation: 'deferred-until-first-ttml-request'
      };
      data.providerConnections[identity.identityId] = record;
      return { ok: true };
    });
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      ok: true,
      connected: true,
      validated: false,
      validationDeferred: true,
      connectedAt: new Date().toISOString()
    });
  });

  router.delete('/account/providers/apple-music', identityCsrf, rateAppleMusic, async (req, res) => {
    const identity = await currentAppleMusicIdentity(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to BitAccount Center before disconnecting Apple Music.' });
    }
    await store.update(data => {
      const record = data.providerConnections?.[identity.identityId];
      if (record) {
        delete record.appleMusic;
        if (!Object.keys(record).length) delete data.providerConnections[identity.identityId];
      }
      return { ok: true };
    });
    res.set('Cache-Control', 'private, no-store');
    return res.json({ ok: true, connected: false });
  });

  router.get('/account/providers/apple-music/recommendations', rateAppleMusic, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to view your Apple Music recommendations.' });
    }
    if (typeof decryptProviderCredential !== 'function' || typeof fetchImpl !== 'function') {
      return res.status(503).json({
        error: 'APPLE_MUSIC_CREDENTIAL_UNAVAILABLE',
        message: 'Secure Apple Music credentials cannot be read on this backend.'
      });
    }

    const connection = storedAppleMusicConnection(store.read(), identity.identityId);
    if (!connection?.userMediaTokenEncrypted) {
      return res.status(409).json({ error: 'APPLE_MUSIC_NOT_CONNECTED', message: 'Connect Apple Music in BitAccount Center first.' });
    }
    let userMediaToken;
    try {
      userMediaToken = decryptProviderCredential(connection.userMediaTokenEncrypted);
    } catch {
      return res.status(503).json({ error: 'APPLE_MUSIC_CREDENTIAL_UNAVAILABLE', message: 'The saved Apple Music connection could not be decrypted.' });
    }
    if (!validAppleMusicUserToken(userMediaToken)) {
      return res.status(409).json({ error: 'APPLE_MUSIC_RECONNECT_REQUIRED', message: 'Reconnect Apple Music in BitAccount Center.' });
    }

    const requestedStorefront = String(req.query.storefront || 'us').trim().toLowerCase();
    const storefront = /^[a-z]{2}$/.test(requestedStorefront) ? requestedStorefront : 'us';
    const recommendationsUrl = 'https://amp-api-edge.music.apple.com/v1/recommendations/'
      + encodeURIComponent(storefront) + '?limit=8';

    function displayText(value, fallback = '') {
      if (typeof value === 'string') return value.trim();
      if (value && typeof value === 'object') {
        for (const candidate of [value.stringForDisplay, value.standard, value.text, value.name, value.label]) {
          if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }
      }
      return fallback;
    }

    function safeAppleMusicUrl(value) {
      try {
        const parsed = new URL(String(value || ''));
        return parsed.protocol === 'https:' && /(^|\.)music\.apple\.com$/i.test(parsed.hostname)
          ? parsed.toString()
          : '';
      } catch {
        return '';
      }
    }

    function includedResources(payload) {
      const result = Array.isArray(payload?.included) ? [...payload.included] : [];
      const resources = payload?.resources;
      if (Array.isArray(resources)) result.push(...resources);
      else if (resources && typeof resources === 'object') {
        for (const collection of Object.values(resources)) {
          if (Array.isArray(collection)) result.push(...collection);
          else if (collection && typeof collection === 'object') result.push(...Object.values(collection));
        }
      }
      return result;
    }

    function recommendationItems(row, payload) {
      const relationships = row?.relationships || {};
      const relationship = relationships.contents || relationships.tracks || relationships.items;
      const references = Array.isArray(relationship?.data) ? relationship.data : [];
      const included = includedResources(payload);
      const embedded = Array.isArray(row?.contents) ? row.contents
        : Array.isArray(row?.items) ? row.items
          : Array.isArray(row?.attributes?.contents) ? row.attributes.contents
            : Array.isArray(row?.attributes?.items) ? row.attributes.items
              : [];
      const linked = references.map(reference => {
        if (reference?.attributes) return reference;
        return included.find(resource => String(resource?.id || '') === String(reference?.id || '')
          && (!reference?.type || !resource?.type || String(resource.type) === String(reference.type))) || reference;
      });
      const collected = linked.length ? linked : embedded;
      return collected.map(normalizeAppleRecommendationItem).filter(Boolean).slice(0, 12);
    }

    try {
      const response = await requestAppleMusicJson(recommendationsUrl, userMediaToken);
      const rows = Array.isArray(response?.data) ? response.data
        : Array.isArray(response?.results?.recommendations?.data) ? response.results.recommendations.data
          : Array.isArray(response?.results?.data) ? response.results.data
            : Array.isArray(response?.recommendations?.data) ? response.recommendations.data
              : [];
      const recommendations = await Promise.all(rows.slice(0, 8).map(async row => {
        const attributes = row?.attributes || {};
        const title = displayText(attributes.title, displayText(attributes.name, 'For you'));
        const description = displayText(attributes.reason, displayText(attributes.description, ''));
        const recommendation = {
          id: String(row?.id || '').slice(0, 160),
          type: String(row?.type || '').slice(0, 40),
          title: title.slice(0, 180),
          description: description.slice(0, 260),
          artworkUrl: normalizeAppleArtwork(attributes.artwork?.url),
          url: safeAppleMusicUrl(attributes.url),
          items: recommendationItems(row, response)
        };

        const relationships = row?.relationships || {};
        const contentRelationship = relationships.contents || relationships.tracks || relationships.items;
        const relatedHref = safePrivateAppleMusicRelationshipUrl(contentRelationship?.href);
        if (!recommendation.items.length && relatedHref) {
          try {
            const contents = await requestAppleMusicJson(relatedHref, userMediaToken);
            const contentRows = Array.isArray(contents?.data) ? contents.data
              : Array.isArray(contents?.results?.data) ? contents.results.data
                : [];
            recommendation.items = contentRows.map(normalizeAppleRecommendationItem)
              .filter(Boolean).slice(0, 12);
          } catch (error) {
            // Some Apple shelves expose a title/artwork card without a contents
            // relationship. Keep it visible; only auth failures fail the feed.
            if (error.status === 401) throw error;
          }
        }
        return recommendation;
      }));

      res.set('Cache-Control', 'private, no-store');
      return res.json({
        provider: 'Apple Music',
        source: 'amp-api-edge',
        storefront,
        authentication: 'web-player-bearer-plus-user-media-token',
        recommendations,
        fetchedAt: new Date().toISOString()
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        error: error.status === 401 ? 'APPLE_MUSIC_RECONNECT_REQUIRED'
          : error.status === 429 ? 'APPLE_MUSIC_RATE_LIMITED'
            : error.status === 503 ? 'APPLE_MUSIC_WEB_PLAYER_TOKEN_UNAVAILABLE'
              : 'APPLE_MUSIC_RECOMMENDATIONS_FAILED',
        message: error.message || 'Apple Music recommendations are unavailable.'
      });
    }
  });

  router.get('/account/providers/apple-music/catalog-search', rateAppleMusic, async (req, res) => {
    const term = String(req.query.term || '').trim().slice(0, 160);
    const storefrontValue = String(req.query.storefront || 'us').trim().toLowerCase();
    const storefront = /^[a-z]{2}$/.test(storefrontValue) ? storefrontValue : 'us';
    const limitValue = Number(req.query.limit || 25);
    const limit = Number.isSafeInteger(limitValue) ? Math.max(1, Math.min(25, limitValue)) : 25;
    if (!term) {
      return res.status(400).json({
        error: 'APPLE_MUSIC_SEARCH_TERM_REQUIRED',
        message: 'Enter an artist, song, or album to search Apple Music.'
      });
    }
    if (typeof fetchImpl !== 'function') {
      return res.status(503).json({
        error: 'APPLE_MUSIC_SEARCH_UNAVAILABLE',
        message: 'Apple Music catalog search is unavailable on this backend.'
      });
    }

    const requestedEntity = String(req.query.entity || 'song').trim().toLowerCase();
    const entity = requestedEntity === 'album' || requestedEntity === 'albums' ? 'album' : 'song';
    const params = new URLSearchParams({
      term,
      entity,
      country: storefront,
      limit: String(limit)
    });
    try {
      const response = await fetchImpl('https://itunes.apple.com/search?' + params.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload?.results)) {
        return res.status(502).json({
          error: 'APPLE_MUSIC_SEARCH_PROVIDER_ERROR',
          message: 'Apple’s public music search is temporarily unavailable. Try again shortly.'
        });
      }
      const tracks = payload.results.map(item => {
        const albumResult = entity === 'album';
        const id = String(albumResult ? item?.collectionId || '' : item?.trackId || '').trim();
        const title = String(albumResult ? item?.collectionName || '' : item?.trackName || '').trim().slice(0, 180);
        const artist = String(item?.artistName || '').trim().slice(0, 180);
        if (!/^[0-9]{1,20}$/.test(id) || !title || !artist) return null;
        let url = '';
        try {
          const candidate = albumResult ? item?.collectionViewUrl : item?.trackViewUrl;
          const parsed = new URL(String(candidate || ''));
          if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'music.apple.com'
            && /^\/[a-z]{2}\/(?:song|album)\//i.test(parsed.pathname)) {
            url = parsed.toString();
          }
        } catch { /* Items without an Apple Music page are omitted from embed metadata. */ }
        return {
          id,
          type: albumResult ? 'albums' : 'songs',
          title,
          artist,
          album: String(item?.collectionName || '').trim().slice(0, 180),
          artworkUrl: normalizeAppleArtwork(item?.artworkUrl100 || item?.artworkUrl60 || ''),
          url,
          durationSeconds: !albumResult && Number.isFinite(Number(item?.trackTimeMillis))
            ? Math.max(0, Number(item.trackTimeMillis) / 1000)
            : 0,
          storefront
        };
      }).filter(Boolean);
      res.set('Cache-Control', 'private, max-age=60');
      return res.json({ provider: 'apple-itunes-search', developerTokenRequired: false, tracks });
    } catch {
      return res.status(502).json({
        error: 'APPLE_MUSIC_SEARCH_PROVIDER_ERROR',
        message: 'Apple’s public music search could not be reached. Try again shortly.'
      });
    }
  });


  router.get('/account/providers/apple-music/catalog-item', rateAppleMusic, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to view Apple Music release details.' });
    }
    const id = String(req.query.id || '').trim();
    const requestedType = String(req.query.type || 'songs').trim().toLowerCase();
    const type = requestedType === 'album' || requestedType === 'albums' ? 'albums' : 'songs';
    const storefrontValue = String(req.query.storefront || 'us').trim().toLowerCase();
    const storefront = /^[a-z]{2}$/.test(storefrontValue) ? storefrontValue : 'us';
    if (!/^[0-9]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'INVALID_APPLE_CATALOG_ID', message: 'A valid Apple Music catalog ID is required.' });
    }
    const connection = storedAppleMusicConnection(store.read(), identity.identityId);
    if (!connection?.userMediaTokenEncrypted || typeof decryptProviderCredential !== 'function') {
      return res.status(409).json({ error: 'APPLE_MUSIC_NOT_CONNECTED', message: 'Connect Apple Music in BitAccount Center to view release details.' });
    }

    let userMediaToken = '';
    try { userMediaToken = decryptProviderCredential(connection.userMediaTokenEncrypted); } catch { /* Use the public catalog fallback below. */ }

    const normalizeTrack = (resource, index, fallbackArtwork = '') => {
      const attributes = resource?.attributes || resource || {};
      const trackId = String(resource?.id || attributes.playParams?.catalogId || attributes.trackId || '').trim();
      const title = String(attributes.name || attributes.title || attributes.trackName || '').trim().slice(0, 180);
      if (!title || !/^[0-9]{1,20}$/.test(trackId)) return null;
      const durationMillis = Number(attributes.durationInMillis ?? attributes.trackTimeMillis);
      const durationSeconds = Number.isFinite(durationMillis) && durationMillis > 0 ? durationMillis / 1000 : 0;
      const bpmValue = attributes.bpm ?? attributes.tempo;
      const bpm = bpmValue != null && Number.isFinite(Number(bpmValue)) && Number(bpmValue) > 0
        ? Number(bpmValue) : null;
      const musicalKey = String(attributes.key || attributes.musicalKey || attributes.keyName || '').trim().slice(0, 24);
      const isFavorited = typeof attributes.isFavorite === 'boolean' ? attributes.isFavorite
        : typeof attributes.isFavorited === 'boolean' ? attributes.isFavorited : null;
      const inLibrary = typeof attributes.isLibrary === 'boolean' ? attributes.isLibrary
        : typeof attributes.inLibrary === 'boolean' ? attributes.inLibrary
          : typeof attributes.playParams?.isLibrary === 'boolean' ? attributes.playParams.isLibrary : null;
      return {
        id: trackId,
        type: 'songs',
        title,
        artist: String(attributes.artistName || attributes.artist || '').trim().slice(0, 180),
        album: String(attributes.albumName || attributes.collectionName || '').trim().slice(0, 180),
        artworkUrl: normalizeAppleArtwork(attributes.artwork?.url || attributes.artworkUrl100 || fallbackArtwork),
        url: safeAppleCatalogPageUrl(attributes.url || attributes.trackViewUrl),
        durationSeconds,
        trackNumber: Number.isSafeInteger(Number(attributes.trackNumber)) && Number(attributes.trackNumber) > 0
          ? Number(attributes.trackNumber) : index + 1,
        discNumber: Number.isSafeInteger(Number(attributes.discNumber)) && Number(attributes.discNumber) > 0
          ? Number(attributes.discNumber) : 1,
        bpm,
        key: musicalKey,
        isFavorited,
        inLibrary,
        appleMusicSongId: trackId,
        appleMusicStorefront: storefront
      };
    };

    let release = null;
    let tracks = [];
    let privateLookupError = null;
    if (userMediaToken && typeof fetchImpl === 'function') {
      try {
        const plural = type === 'albums' ? 'albums' : 'songs';
        const lookupUrl = new URL('https://amp-api-edge.music.apple.com/v1/catalog/'
          + storefront + '/' + plural + '/' + encodeURIComponent(id));
        if (type === 'albums') lookupUrl.searchParams.set('include', 'tracks');
        const payload = await requestAppleMusicJson(lookupUrl.toString(), userMediaToken);
        const resource = Array.isArray(payload?.data) ? payload.data[0] : null;
        const attributes = resource?.attributes || {};
        if (resource) {
          const resourceTitle = String(attributes.name || attributes.title || '').trim().slice(0, 180);
          release = {
            id: String(resource.id || id),
            type,
            title: resourceTitle || 'Apple Music release',
            artist: String(attributes.artistName || '').trim().slice(0, 180),
            artworkUrl: normalizeAppleArtwork(attributes.artwork?.url),
            url: safeAppleCatalogPageUrl(attributes.url),
            trackCount: Number.isSafeInteger(Number(attributes.trackCount)) ? Number(attributes.trackCount) : 0
          };
          if (type === 'albums') {
            const relationship = resource.relationships?.tracks;
            const references = Array.isArray(relationship?.data) ? relationship.data : [];
            const included = Array.isArray(payload.included) ? payload.included : [];
            const resolved = references.map(reference => {
              if (reference?.attributes) return reference;
              return included.find(candidate => String(candidate?.id || '') === String(reference?.id || '')
                && (!reference?.type || !candidate?.type || String(candidate.type) === String(reference.type))) || reference;
            });
            tracks = resolved.map((track, index) => normalizeTrack(track, index, attributes.artwork?.url)).filter(Boolean);
          } else {
            const song = normalizeTrack(resource, 0, attributes.artwork?.url);
            if (song) tracks = [song];
          }
        }
      } catch (error) {
        privateLookupError = error;
      }
    }

    if (!tracks.length && typeof fetchImpl === 'function') {
      try {
        const lookupUrl = new URL('https://itunes.apple.com/lookup');
        lookupUrl.searchParams.set('id', id);
        lookupUrl.searchParams.set('entity', 'song');
        lookupUrl.searchParams.set('country', storefront);
        const response = await fetchImpl(lookupUrl.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          redirect: 'follow',
          signal: AbortSignal.timeout(10000)
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(payload?.results)) {
          const rows = payload.results;
          const collection = rows.find(row => row?.wrapperType === 'collection')
            || rows.find(row => row?.collectionId != null) || rows[0] || {};
          if (type === 'albums') {
            release = {
              id: String(collection.collectionId || id),
              type,
              title: String(collection.collectionName || collection.name || '').trim().slice(0, 180) || 'Apple Music release',
              artist: String(collection.artistName || '').trim().slice(0, 180),
              artworkUrl: normalizeAppleArtwork(collection.artworkUrl100 || collection.artworkUrl60 || ''),
              url: safeAppleCatalogPageUrl(collection.collectionViewUrl),
              trackCount: Number(collection.trackCount || 0)
            };
            tracks = rows.filter(row => row?.wrapperType === 'track' && row?.trackId != null)
              .map((row, index) => normalizeTrack({
                id: String(row.trackId),
                attributes: {
                  name: row.trackName,
                  artistName: row.artistName,
                  albumName: row.collectionName,
                  artworkUrl100: row.artworkUrl100,
                  trackViewUrl: row.trackViewUrl,
                  trackTimeMillis: row.trackTimeMillis,
                  trackNumber: row.trackNumber,
                  discNumber: row.discNumber
                }
              }, index, collection.artworkUrl100 || '')).filter(Boolean);
          } else {
            const row = rows.find(candidate => String(candidate?.trackId || '') === id)
              || rows.find(candidate => candidate?.wrapperType === 'track');
            if (row) {
              release = {
                id,
                type,
                title: String(row.trackName || '').trim().slice(0, 180),
                artist: String(row.artistName || '').trim().slice(0, 180),
                artworkUrl: normalizeAppleArtwork(row.artworkUrl100 || row.artworkUrl60 || ''),
                url: safeAppleCatalogPageUrl(row.trackViewUrl),
                trackCount: 1
              };
              tracks = [normalizeTrack({
                id: String(row.trackId || id),
                attributes: {
                  name: row.trackName,
                  artistName: row.artistName,
                  albumName: row.collectionName,
                  artworkUrl100: row.artworkUrl100,
                  trackViewUrl: row.trackViewUrl,
                  trackTimeMillis: row.trackTimeMillis,
                  trackNumber: row.trackNumber,
                  discNumber: row.discNumber
                }
              }, 0, row.artworkUrl100 || '')].filter(Boolean);
            }
          }
        }
      } catch { /* The Apple private response remains preferable when available. */ }
    }

    if (!release || !tracks.length) {
      return res.status(privateLookupError?.status || 502).json({
        error: 'APPLE_MUSIC_RELEASE_DETAILS_UNAVAILABLE',
        message: 'Apple Music did not return the selected release tracklist. Try again shortly.'
      });
    }
    release.trackCount = tracks.length || release.trackCount;
    res.set('Cache-Control', 'private, no-store');
    return res.json({ provider: 'Apple Music', release, tracks });
  });

  router.get('/account/providers/apple-music/motion', rateAppleMusic, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to load Apple Music animated artwork.' });
    }
    const appleUrl = String(req.query.url || '').trim();
    let parsed;
    try { parsed = new URL(appleUrl); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'music.apple.com'
      || parsed.username || parsed.password) {
      return res.status(400).json({ error: 'INVALID_APPLE_MUSIC_URL', message: 'A valid Apple Music item URL is required.' });
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    const storefront = /^[a-z]{2}$/i.test(parts[0] || '') ? parts[0].toLowerCase() : 'us';
    const kind = String(parts[1] || '').toLowerCase();
    const resourceId = String(parts[3] || '').trim();
    const resourceType = ({ album: 'albums', playlist: 'playlists', song: 'songs' })[kind];
    if (!resourceType || !/^(?:[0-9]{1,20}|pl\.[A-Za-z0-9._-]{1,120})$/.test(resourceId)) {
      return res.status(400).json({ error: 'INVALID_APPLE_MUSIC_URL', message: 'This Apple Music URL does not identify a supported catalog item.' });
    }
    const connection = storedAppleMusicConnection(store.read(), identity.identityId);
    if (!connection?.userMediaTokenEncrypted || typeof decryptProviderCredential !== 'function') {
      return res.status(409).json({ error: 'APPLE_MUSIC_NOT_CONNECTED', message: 'Connect Apple Music to load animated artwork.' });
    }
    let userMediaToken = '';
    try { userMediaToken = decryptProviderCredential(connection.userMediaTokenEncrypted); } catch {
      return res.status(503).json({ error: 'APPLE_MUSIC_CREDENTIAL_UNAVAILABLE', message: 'The saved Apple Music connection could not be decrypted.' });
    }
    if (!validAppleMusicUserToken(userMediaToken)) {
      return res.status(409).json({ error: 'APPLE_MUSIC_RECONNECT_REQUIRED', message: 'Reconnect Apple Music in BitAccount Center.' });
    }
    const lookupUrl = new URL('https://amp-api-edge.music.apple.com/v1/catalog/'
      + storefront + '/' + resourceType + '/' + encodeURIComponent(resourceId));
    lookupUrl.searchParams.set('extend', 'editorialVideo');
    try {
      const payload = await requestAppleMusicJson(lookupUrl.toString(), userMediaToken);
      const resource = Array.isArray(payload?.data) ? payload.data[0] : null;
      const editorialVideo = resource?.attributes?.editorialVideo || {};
      const animatedUrlSquare = appleEditorialVideoUrl(editorialVideo, 'square');
      const animatedUrlTall = appleEditorialVideoUrl(editorialVideo, 'tall');
      res.set('Cache-Control', 'private, max-age=300');
      return res.json({ provider: 'Apple Music', animatedUrlSquare, animatedUrlTall });
    } catch (error) {
      return res.status(error.status || 502).json({
        error: 'APPLE_MUSIC_MOTION_UNAVAILABLE',
        message: error.message || 'Apple Music animated artwork could not be loaded.'
      });
    }
  });

  router.post('/account/providers/apple-music/library', identityCsrf, rateAppleMusic, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to add Apple Music content to your library.' });
    }
    const id = String(req.body?.id || '').trim();
    const requestedType = String(req.body?.type || '').trim().toLowerCase();
    const type = requestedType === 'album' || requestedType === 'albums' ? 'albums'
      : requestedType === 'song' || requestedType === 'songs' ? 'songs' : '';
    const storefrontValue = String(req.body?.storefront || 'us').trim().toLowerCase();
    const storefront = /^[a-z]{2}$/.test(storefrontValue) ? storefrontValue : 'us';
    if (!/^[0-9]{1,20}$/.test(id) || !type) {
      return res.status(400).json({ error: 'INVALID_APPLE_LIBRARY_RESOURCE', message: 'A valid Apple Music album or song is required.' });
    }
    const connection = storedAppleMusicConnection(store.read(), identity.identityId);
    if (!connection?.userMediaTokenEncrypted || typeof decryptProviderCredential !== 'function') {
      return res.status(409).json({ error: 'APPLE_MUSIC_NOT_CONNECTED', message: 'Connect Apple Music in BitAccount Center first.' });
    }
    let userMediaToken = '';
    try { userMediaToken = decryptProviderCredential(connection.userMediaTokenEncrypted); } catch {
      return res.status(503).json({ error: 'APPLE_MUSIC_CREDENTIAL_UNAVAILABLE', message: 'The saved Apple Music connection could not be decrypted.' });
    }
    if (!validAppleMusicUserToken(userMediaToken) || typeof fetchImpl !== 'function') {
      return res.status(503).json({ error: 'APPLE_MUSIC_LIBRARY_UNAVAILABLE', message: 'Apple Music library actions are unavailable.' });
    }
    const target = new URL('https://amp-api-edge.music.apple.com/v1/me/library');
    target.searchParams.set('ids[' + type + ']', id);
    const send = async bearer => fetchImpl(target.toString(), {
      method: 'POST',
      headers: appleMusicAuthHeaders(userMediaToken, bearer),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000)
    });
    try {
      let bearer = await resolveAppleMusicWebPlayerToken();
      let response = await send(bearer);
      if ((response.status === 401 || response.status === 403) && !String(appleMusicWebPlayerToken || '').trim()) {
        cachedAppleWebPlayerToken = '';
        cachedAppleWebPlayerTokenExpiresAt = 0;
        bearer = await resolveAppleMusicWebPlayerToken();
        response = await send(bearer);
      }
      if (!response.ok) {
        const status = response.status === 401 || response.status === 403 ? 401
          : response.status === 429 ? 429 : 502;
        return res.status(status).json({
          error: status === 401 ? 'APPLE_MUSIC_AUTH_REJECTED' : 'APPLE_MUSIC_LIBRARY_ADD_FAILED',
          message: status === 401 ? 'Apple Music rejected the saved subscriber token. Reconnect Apple Music in BitAccount Center.'
            : status === 429 ? 'Apple Music is rate limiting library changes. Try again shortly.'
              : 'Apple Music could not add this item to your library.'
        });
      }
      res.set('Cache-Control', 'private, no-store');
      return res.status(202).json({ ok: true, accepted: true, id, type });
    } catch {
      return res.status(502).json({ error: 'APPLE_MUSIC_LIBRARY_ADD_FAILED', message: 'Apple Music could not add this item to your library.' });
    }
  });

  function safePrivateAppleMusicRelationshipUrl(value) {
    try {
      const parsed = new URL(String(value || ''), 'https://amp-api-edge.music.apple.com/');
      const permittedHosts = new Set([
        'amp-api-edge.music.apple.com',
        'amp-api.music.apple.com',
        'api.music.apple.com'
      ]);
      return parsed.protocol === 'https:'
        && permittedHosts.has(parsed.hostname.toLowerCase())
        && parsed.pathname.startsWith('/v1/')
        && !parsed.username && !parsed.password
        ? parsed.toString()
        : '';
    } catch {
      return '';
    }
  }

  router.get('/account/providers/apple-music/lyrics', rateAppleMusic, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) {
      return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in to fetch Apple Music lyrics.' });
    }
    if (typeof decryptProviderCredential !== 'function' || typeof fetchImpl !== 'function') {
      return res.status(503).json({ error: 'APPLE_MUSIC_CREDENTIAL_UNAVAILABLE', message: 'Secure Apple Music credentials cannot be read on this backend.' });
    }
    const songId = String(req.query.songId || '').trim();
    const storefront = String(req.query.storefront || 'us').trim().toLowerCase();
    if (!/^[0-9]{1,20}$/.test(songId) || !/^[a-z]{2}$/.test(storefront)) {
      return res.status(400).json({ error: 'INVALID_APPLE_MUSIC_TRACK', message: 'Provide a valid Apple Music song ID and two-letter storefront.' });
    }

    const connection = storedAppleMusicConnection(store.read(), identity.identityId);
    if (!connection?.userMediaTokenEncrypted) {
      return res.status(409).json({ error: 'APPLE_MUSIC_NOT_CONNECTED', message: 'Connect Apple Music in BitAccount Center first.' });
    }
    let userMediaToken;
    try { userMediaToken = decryptProviderCredential(connection.userMediaTokenEncrypted); }
    catch {
      return res.status(503).json({ error: 'APPLE_MUSIC_CREDENTIAL_UNAVAILABLE', message: 'The saved Apple Music connection could not be decrypted.' });
    }
    if (!validAppleMusicUserToken(userMediaToken)) {
      return res.status(409).json({ error: 'APPLE_MUSIC_RECONNECT_REQUIRED', message: 'Reconnect Apple Music in BitAccount Center.' });
    }
    let webPlayerBearer;
    try {
      webPlayerBearer = await resolveAppleMusicWebPlayerToken();
    } catch (error) {
      return res.status(503).json({
        error: 'APPLE_MUSIC_WEB_PLAYER_TOKEN_UNAVAILABLE',
        message: error.message || 'Apple Music web-player authorization could not be refreshed.'
      });
    }

    async function fetchTtml(endpoint) {
      const url = 'https://amp-api.music.apple.com/v1/catalog/'
        + encodeURIComponent(storefront) + '/songs/' + encodeURIComponent(songId) + '/'
        + endpoint + '?extend=ttmlLocalizations';
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + webPlayerBearer,
          Origin: 'https://music.apple.com',
          Referer: 'https://music.apple.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Media-User-Token': userMediaToken
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000)
      });
      const payload = await response.json().catch(() => ({}));
      const attributes = payload?.data?.[0]?.attributes || {};
      const localizations = attributes.ttmlLocalizations || null;
      function findTtml(value, depth = 0) {
        if (depth > 6 || value == null) return '';
        if (typeof value === 'string') {
          return /<(?:[A-Za-z0-9_-]+:)?tt(?:\s|>)/i.test(value) ? value : '';
        }
        if (Array.isArray(value)) {
          for (const entry of value) {
            const found = findTtml(entry, depth + 1);
            if (found) return found;
          }
          return '';
        }
        if (typeof value === 'object') {
          for (const entry of Object.values(value)) {
            const found = findTtml(entry, depth + 1);
            if (found) return found;
          }
        }
        return '';
      }
      const ttml = findTtml(attributes.ttml) || findTtml(localizations);
      return { ok: response.ok, status: response.status, ttml, localizations };
    }

    try {
      let result = await fetchTtml('syllable-lyrics');
      let source = 'syllable-lyrics';
      if (result.status === 401 && !String(appleMusicWebPlayerToken || '').trim()) {
        // Apple web-player Bearer tokens are short-lived. Refresh the public
        // bundle token once before asking the subscriber to reconnect.
        cachedAppleWebPlayerToken = '';
        cachedAppleWebPlayerTokenExpiresAt = 0;
        try {
          webPlayerBearer = await resolveAppleMusicWebPlayerToken();
          result = await fetchTtml('syllable-lyrics');
        } catch {
          // The response below will report an authentication failure without
          // exposing Apple token material or upstream response details.
        }
      }
      if (result.status === 401 || result.status === 403) {
        return res.status(401).json({
          error: 'APPLE_MUSIC_RECONNECT_REQUIRED',
          message: 'Apple Music rejected the saved subscriber token or current web-player authorization. Check the subscription token, then retry.'
        });
      }
      if (!result.ok || !result.ttml) {
        result = await fetchTtml('lyrics');
        source = 'lyrics';
      }
      if (!result.ok || !result.ttml) {
        return res.status(result.status === 401 || result.status === 403 ? 401 : 404).json({
          error: 'APPLE_MUSIC_TTML_UNAVAILABLE',
          message: 'Apple Music did not provide TTML lyrics for this song.'
        });
      }
      res.set('Cache-Control', 'private, no-store');
      return res.json({
        provider: 'Apple Music',
        songId,
        storefront,
        format: 'ttml',
        source,
        ttml: result.ttml || null,
        ttmlLocalizations: result.localizations
      });
    } catch {
      return res.status(502).json({
        error: 'APPLE_MUSIC_LYRICS_FAILED',
        message: 'Apple Music lyrics could not be fetched right now.'
      });
    }
  });

  router.get('/passkeys', (req, res) => {
    const session = activeSession(req, res);
    if (!session.authenticated) return res.status(401).json({ error: 'SIGN_IN_REQUIRED' });
    res.set('Cache-Control', 'no-store');
    return res.json({ passkeys: publicPasskeys(session.account) });
  });

  router.post('/auth/register', bitConnectionCsrf, rateRegister, async (req, res) => {
    const username = cleanUsername(req.body?.username);
    const password = req.body?.password;
    const avatarDataUrl = cleanImageDataUrl(req.body?.avatarDataUrl);
    if (!username) return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Choose a username containing 1 to 24 characters.' });
    if (!validatePassword(password)) return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Enter a password.' });
    if (avatarDataUrl === undefined) return res.status(400).json({ error: 'INVALID_PROFILE_IMAGE', message: 'Use a PNG, JPEG, or WebP profile picture up to 1 MB.' });

    let passwordRecord;
    try { passwordRecord = await createPasswordRecord(password); }
    catch { return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Could not prepare that password.' }); }
    const recovery = createRecoveryCodes();
    const accountId = crypto.randomBytes(24).toString('base64url');
    const webAuthnUserId = crypto.randomBytes(32).toString('base64url');
    const now = new Date().toISOString();

    const result = await store.update(data => {
      if (Object.values(data.accounts).some(account => usernameKey(account.username) === usernameKey(username))
        || !usernameAvailable(data, username)) {
        return { status: 409, error: 'USERNAME_TAKEN', message: 'That BitConnection username is already in use.', write: false };
      }
      data.accounts[accountId] = {
        username,
        password: passwordRecord,
        recoveryCodeHashes: recovery.hashes,
        webAuthnUserId,
        passkeys: [],
        createdAt: now
      };
      data.profiles['bitconnection:' + accountId] = {
        username,
        avatarDataUrl,
        createdAt: now,
        updatedAt: now
      };
      createAuthenticatedSession(data, accountId, req.bitConnectionSessionId, req);
      return { ok: true, accountId };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      ok: true,
      account: { username, avatarDataUrl },
      recoveryCodes: recovery.codes,
      passkeyCount: 0
    });
  });

  router.post('/auth/login', bitConnectionCsrf, rateLogin, async (req, res) => {
    const username = cleanUsername(req.body?.username);
    const password = req.body?.password;
    const snapshot = store.read();
    const normalized = usernameKey(username);
    const match = Object.entries(snapshot.accounts).find(([, account]) => usernameKey(account.username) === normalized);
    if (match?.[1]?.suspendedAt) {
      return res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'This BitConnection account is suspended.' });
    }
    const valid = await verifyPassword(password, match?.[1]?.password || PASSWORD_DUMMY);
    if (!match || !validatePassword(password) || !valid) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'The username or password is incorrect.' });
    }
    if (activeSession(req, res).authenticated) {
      return res.status(409).json({ error: 'ALREADY_SIGNED_IN', message: 'A BitConnection account is already signed in on this device.' });
    }
    const [accountId, accountSnapshot] = match;
    const sessionHash = hashSessionId(req.bitConnectionSessionId);
    const result = await store.update(data => {
      const account = data.accounts[accountId];
      if (!account || account.suspendedAt || account.password?.hash !== accountSnapshot.password.hash) {
        return {
          status: account?.suspendedAt ? 403 : 401,
          error: account?.suspendedAt ? 'ACCOUNT_SUSPENDED' : 'INVALID_CREDENTIALS',
          message: account?.suspendedAt ? 'This BitConnection account is suspended.' : 'The username or password is incorrect.',
          write: false
        };
      }
      const sessionInfo = createAuthenticatedSession(data, accountId, req.bitConnectionSessionId, req);
      return { ok: true, evictedDevice: sessionInfo.evictedDevice || null };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, evictedDevice: result.evictedDevice });
  });

  router.post('/auth/recover', bitConnectionCsrf, rateRecover, async (req, res) => {
    const username = cleanUsername(req.body?.username);
    const recoveryCode = req.body?.recoveryCode;
    const newPassword = req.body?.newPassword;
    if (!validatePassword(newPassword)) return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Enter a new password.' });
    const snapshot = store.read();
    const normalized = usernameKey(username);
    const match = Object.entries(snapshot.accounts).find(([, account]) => usernameKey(account.username) === normalized);
    if (!match) return res.status(400).json({ error: 'INVALID_RECOVERY', message: 'The username or recovery code could not be verified.' });
    const [accountId, accountSnapshot] = match;
    const consumedSnapshot = consumeRecoveryCode(recoveryCode, accountSnapshot.recoveryCodeHashes || []);
    if (!consumedSnapshot.valid) return res.status(400).json({ error: 'INVALID_RECOVERY', message: 'The username or recovery code could not be verified.' });

    let passwordRecord;
    try { passwordRecord = await createPasswordRecord(newPassword); }
    catch { return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Could not prepare that password.' }); }
    const recovery = createRecoveryCodes();
    const result = await store.update(data => {
      const account = data.accounts[accountId];
      if (!account || JSON.stringify(account.recoveryCodeHashes || []) !== JSON.stringify(accountSnapshot.recoveryCodeHashes || [])) {
        return { status: 400, error: 'INVALID_RECOVERY', message: 'The username or recovery code could not be verified.', write: false };
      }
      const consumed = consumeRecoveryCode(recoveryCode, account.recoveryCodeHashes || []);
      if (!consumed.valid) return { status: 400, error: 'INVALID_RECOVERY', message: 'The username or recovery code could not be verified.', write: false };
      account.password = passwordRecord;
      account.recoveryCodeHashes = recovery.hashes;
      for (const [hash, active] of Object.entries(data.authSessions)) {
        if (active?.accountId === accountId) delete data.authSessions[hash];
      }
      createAuthenticatedSession(data, accountId, req.bitConnectionSessionId, req);
      return { ok: true };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, recoveryCodes: recovery.codes });
  });

  router.post('/auth/logout', bitConnectionCsrf, async (req, res) => {
    const sessionHash = hashSessionId(req.bitConnectionSessionId);
    await store.update(data => {
      delete data.authSessions[sessionHash];
      delete data.webauthnChallenges[sessionHash];
      return { ok: true };
    });
    res.append('Set-Cookie', COOKIE_NAME + '=; Path=/api/bitconnection; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  });

  router.post('/passkeys/register/options', bitConnectionCsrf, ratePasskey, async (req, res) => {
    const session = activeSession(req, res);
    if (!session.authenticated) return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in before adding a passkey.' });
    if (!await verifyPassword(req.body?.password, session.account.password)) {
      return res.status(401).json({ error: 'REAUTHENTICATION_REQUIRED', message: 'Enter your current BitConnection password to add a passkey.' });
    }
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }

    const passkeys = Array.isArray(session.account.passkeys) ? session.account.passkeys : [];
    if (passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT) return res.status(409).json({ error: 'PASSKEY_LIMIT_REACHED', message: 'This account already has five passkeys.' });
    const webAuthnUserId = session.account.webAuthnUserId || crypto.randomBytes(32).toString('base64url');
    try {
      const options = await generateRegistrationOptions({
        rpName: 'BitConnection',
        rpID: context.rpID,
        userID: Buffer.from(webAuthnUserId, 'base64url'),
        userName: session.account.username,
        userDisplayName: session.account.username,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required'
        },
        excludeCredentials: passkeys.filter(passkey => passkey.rpID === context.rpID).map(passkey => ({
          id: passkey.id,
          transports: passkey.transports || []
        }))
      });
      await saveChallenge(session.sessionId, {
        purpose: 'register-passkey',
        accountId: session.accountId,
        challenge: options.challenge,
        origin: context.origin,
        rpID: context.rpID
      });
      res.set('Cache-Control', 'no-store');
      return res.json(options);
    } catch (error) {
      console.error('BitConnection passkey registration options failed:', error.message);
      return res.status(500).json({ error: 'PASSKEY_SETUP_FAILED', message: 'Could not prepare passkey registration. Try again.' });
    }
  });

  router.post('/passkeys/register/verify', bitConnectionCsrf, ratePasskey, async (req, res) => {
    const session = activeSession(req, res);
    if (!session.authenticated) return res.status(401).json({ error: 'SIGN_IN_REQUIRED' });
    const challenge = await consumeChallenge(session.sessionId, 'register-passkey', session.accountId);
    if (!challenge) return res.status(400).json({ error: 'PASSKEY_CHALLENGE_EXPIRED', message: 'Passkey setup expired. Start again.' });
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }
    if (context.origin !== challenge.origin || context.rpID !== challenge.rpID) {
      return res.status(400).json({ error: 'PASSKEY_ORIGIN_MISMATCH', message: 'Passkey setup must finish on the same BitConnection website where it started.' });
    }
    try {
      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        requireUserVerification: true
      });
      const info = verification.registrationInfo;
      if (!verification.verified || !info?.credential) return res.status(400).json({ error: 'PASSKEY_NOT_VERIFIED', message: 'The authenticator did not verify this passkey.' });
      const credential = info.credential;
      const name = normalizePasskeyName(req.body?.deviceName, 'Passkey ' + ((session.account.passkeys || []).length + 1));
      const saved = await store.update(data => {
        const account = data.accounts[session.accountId];
        if (!account) return { status: 401, error: 'SIGN_IN_REQUIRED' };
        account.passkeys ||= [];
        if (account.passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT) return { status: 409, error: 'PASSKEY_LIMIT_REACHED' };
        if (Object.values(data.accounts).some(owner => (owner.passkeys || []).some(passkey => passkey.id === credential.id))) {
          return { status: 409, error: 'PASSKEY_ALREADY_REGISTERED', message: 'That passkey is already registered to a BitConnection account.' };
        }
        account.webAuthnUserId ||= session.account.webAuthnUserId;
        account.passkeys.push({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: Number(credential.counter || 0),
          transports: Array.isArray(credential.transports) ? credential.transports : [],
          deviceType: info.credentialDeviceType || 'singleDevice',
          backedUp: Boolean(info.credentialBackedUp),
          rpID: challenge.rpID,
          name,
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        });
        return { ok: true, count: account.passkeys.length };
      });
      if (saved.status) return res.status(saved.status).json({ error: saved.error, message: saved.message });
      return res.status(201).json({ ok: true, passkeyCount: saved.count });
    } catch (error) {
      console.error('BitConnection passkey verification failed:', error.message);
      return res.status(400).json({ error: 'PASSKEY_VERIFICATION_FAILED', message: 'BitConnection could not verify that passkey. Start again and retry.' });
    }
  });

  router.post('/passkeys/auth/options', bitConnectionCsrf, ratePasskey, async (req, res) => {
    if (activeSession(req, res).authenticated) return res.status(409).json({ error: 'ALREADY_SIGNED_IN' });
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }
    try {
      const options = await generateAuthenticationOptions({
        rpID: context.rpID,
        allowCredentials: [],
        userVerification: 'required'
      });
      await saveChallenge(req.bitConnectionSessionId, {
        purpose: 'authenticate-passkey',
        challenge: options.challenge,
        origin: context.origin,
        rpID: context.rpID
      });
      return res.json(options);
    } catch (error) {
      console.error('BitConnection passkey authentication options failed:', error.message);
      return res.status(500).json({ error: 'PASSKEY_SIGN_IN_FAILED', message: 'Could not start passkey sign-in. Try again.' });
    }
  });

  router.post('/passkeys/auth/verify', bitConnectionCsrf, ratePasskey, async (req, res) => {
    if (activeSession(req, res).authenticated) return res.status(409).json({ error: 'ALREADY_SIGNED_IN' });
    const challenge = await consumeChallenge(req.bitConnectionSessionId, 'authenticate-passkey');
    if (!challenge) return res.status(400).json({ error: 'PASSKEY_CHALLENGE_EXPIRED', message: 'Passkey sign-in expired. Start again.' });
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }
    if (context.origin !== challenge.origin || context.rpID !== challenge.rpID) {
      return res.status(400).json({ error: 'PASSKEY_ORIGIN_MISMATCH', message: 'Passkey sign-in must finish on the same BitConnection website where it started.' });
    }

    const credentialId = typeof req.body?.id === 'string' ? req.body.id : '';
    const userHandle = typeof req.body?.response?.userHandle === 'string' ? req.body.response.userHandle : '';
    const snapshot = store.read();
    let matchedAccountId = null;
    let matchedAccount = null;
    let matchedPasskey = null;
    for (const [candidateId, account] of Object.entries(snapshot.accounts)) {
      const passkey = (account.passkeys || []).find(entry => entry.id === credentialId && entry.rpID === challenge.rpID);
      if (passkey && (!userHandle || secureEqual(userHandle, account.webAuthnUserId))) {
        matchedAccountId = candidateId;
        matchedAccount = account;
        matchedPasskey = passkey;
        break;
      }
    }
    if (!matchedAccountId || !matchedAccount || !matchedPasskey) {
      return res.status(401).json({ error: 'INVALID_PASSKEY', message: 'This passkey could not be verified for a BitConnection account.' });
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: {
          id: matchedPasskey.id,
          publicKey: new Uint8Array(Buffer.from(matchedPasskey.publicKey, 'base64url')),
          counter: Number(matchedPasskey.counter || 0),
          transports: matchedPasskey.transports || []
        },
        requireUserVerification: true
      });
      if (!verification.verified || verification.authenticationInfo?.userVerified !== true) {
        return res.status(401).json({ error: 'INVALID_PASSKEY', message: 'Passkey user verification was not completed.' });
      }
      const result = await store.update(data => {
        const account = data.accounts[matchedAccountId];
        if (!account || account.suspendedAt || account.webAuthnUserId !== matchedAccount.webAuthnUserId) {
          return { status: account?.suspendedAt ? 403 : 401, error: account?.suspendedAt ? 'ACCOUNT_SUSPENDED' : 'INVALID_PASSKEY', write: false };
        }
        const passkey = (account.passkeys || []).find(entry => entry.id === credentialId && entry.rpID === challenge.rpID);
        if (!passkey || Number(passkey.counter || 0) !== Number(matchedPasskey.counter || 0)) return { status: 401, error: 'INVALID_PASSKEY', write: false };
        passkey.counter = Number(verification.authenticationInfo.newCounter || 0);
        passkey.lastUsedAt = new Date().toISOString();
        createAuthenticatedSession(data, matchedAccountId, req.bitConnectionSessionId, req);
        return { ok: true };
      });
      if (result.status) return res.status(result.status).json({ error: result.error });
      return res.json({ ok: true });
    } catch (error) {
      console.error('BitConnection passkey sign-in verification failed:', error.message);
      return res.status(401).json({ error: 'INVALID_PASSKEY', message: 'Passkey verification failed. Try again.' });
    }
  });

  router.post('/passkeys/remove', bitConnectionCsrf, ratePasskey, async (req, res) => {
    const session = activeSession(req, res);
    if (!session.authenticated) return res.status(401).json({ error: 'SIGN_IN_REQUIRED' });
    if (!await verifyPassword(req.body?.password, session.account.password)) {
      return res.status(401).json({ error: 'REAUTHENTICATION_REQUIRED', message: 'Enter your current BitConnection password to remove a passkey.' });
    }
    const credentialId = typeof req.body?.credentialId === 'string' ? req.body.credentialId : '';
    const result = await store.update(data => {
      const account = data.accounts[session.accountId];
      if (!account) return { status: 401, error: 'SIGN_IN_REQUIRED' };
      const before = (account.passkeys || []).length;
      account.passkeys = (account.passkeys || []).filter(passkey => passkey.id !== credentialId);
      if (account.passkeys.length === before) return { status: 404, error: 'PASSKEY_NOT_FOUND' };
      return { ok: true, count: account.passkeys.length };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    return res.json({ ok: true, passkeyCount: result.count });
  });

  router.put('/account/profile', identityCsrf, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) return res.status(401).json({ error: 'BITCONNECTION_ACCOUNT_REQUIRED', message: 'Sign in to a BitConnection account or explicitly choose your signed-in BitCider account.' });
    const username = cleanUsername(req.body?.username);
    if (!username) return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Choose a username containing 1 to 24 characters.' });
    const avatarDataUrl = cleanImageDataUrl(req.body?.avatarDataUrl);
    if (avatarDataUrl === undefined) return res.status(400).json({ error: 'INVALID_PROFILE_IMAGE', message: 'Use a PNG, JPEG, or WebP profile picture up to 1 MB.' });

    const result = store.read();
    if (!usernameAvailable(result, username, identity.identityId)) {
      return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'That BitConnection username is already in use.' });
    }
    const previous = profileFor(result, identity.identityId) || {};
    const profile = {
      username,
      avatarDataUrl: avatarDataUrl === null && req.body?.avatarDataUrl === undefined ? previous.avatarDataUrl || null : avatarDataUrl,
      playbackSource: PARTY_PLAYBACK_SOURCES.has(previous.playbackSource) ? previous.playbackSource : 'bitmono',
      customSourceManifestUrl: typeof previous.customSourceManifestUrl === 'string' ? previous.customSourceManifestUrl : '',
      createdAt: previous.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const saved = await store.update(data => {
      if (!usernameAvailable(data, username, identity.identityId)) return { status: 409, error: 'USERNAME_TAKEN', message: 'That BitConnection username is already in use.' };
      data.profiles[identity.identityId] = profile;
      if (identity.type === 'bitconnection' && data.accounts[identity.accountId]) {
        data.accounts[identity.accountId].username = username;
      }
      return { ok: true };
    });
    if (saved.status) return res.status(saved.status).json({ error: saved.error, message: saved.message });
    return res.json({ ok: true, profile });
  });

  router.put('/account/playback-settings', identityCsrf, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) return res.status(401).json({ error: 'BITCONNECTION_ACCOUNT_REQUIRED' });
    const playbackSource = String(req.body?.playbackSource || '');
    if (!PARTY_PLAYBACK_SOURCES.has(playbackSource)) {
      return res.status(400).json({ error: 'INVALID_PLAYBACK_SOURCE', message: 'Choose BitMono, CCustom, or Cider.' });
    }
    const customSourceManifestUrl = cleanCustomSourceManifestUrl(req.body?.customSourceManifestUrl);
    if (customSourceManifestUrl === null) {
      return res.status(400).json({ error: 'INVALID_CUSTOM_SOURCE_URL', message: 'CCustom needs a valid HTTPS BitChord-compatible manifest URL ending in /manifest.json.' });
    }
    if (playbackSource === 'ccustom' && !customSourceManifestUrl) {
      return res.status(400).json({ error: 'CUSTOM_SOURCE_URL_REQUIRED', message: 'Enter your CCustom add-on manifest URL.' });
    }
    const saved = await store.update(data => {
      const profile = profileFor(data, identity.identityId);
      if (!profile?.username) return { status: 409, error: 'BITCONNECTION_PROFILE_REQUIRED', message: 'Finish your profile before saving party audio settings.' };
      profile.playbackSource = playbackSource;
      profile.customSourceManifestUrl = customSourceManifestUrl;
      profile.updatedAt = new Date().toISOString();
      return { ok: true };
    });
    if (saved.status) return res.status(saved.status).json({ error: saved.error, message: saved.message });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, playbackSettings: { playbackSource, customSourceManifestUrl } });
  });

  router.post('/rooms', identityCsrf, async (req, res) => {
    const identity = identityForRequest(req, res);
    if (!identity) return res.status(401).json({ error: 'BITCONNECTION_ACCOUNT_REQUIRED', message: 'A BitConnection account or explicitly selected BitCider account is required to host a room.' });
    const data = store.read();
    const profile = profileFor(data, identity.identityId);
    if (!profile?.username) return res.status(409).json({ error: 'BITCONNECTION_PROFILE_REQUIRED', message: 'Finish your BitConnection username setup before creating a room.' });

    const roomName = typeof req.body?.roomName === 'string' ? req.body.roomName.trim() : '';
    const visibility = req.body?.visibility;
    const partySize = Number(req.body?.partySize);
    const ownerOnlyControls = req.body?.ownerOnlyControls;
    const playbackSource = PARTY_PLAYBACK_SOURCES.has(profile.playbackSource) ? profile.playbackSource : 'bitmono';
    if (!roomName || Array.from(roomName).length > 48 || /[\u0000-\u001f\u007f]/u.test(roomName)) {
      return res.status(400).json({ error: 'INVALID_ROOM_NAME', message: 'Room names must contain 1 to 48 characters.' });
    }
    if (!['public', 'private'].includes(visibility)) return res.status(400).json({ error: 'INVALID_VISIBILITY', message: 'Choose public or private visibility.' });
    if (!Number.isSafeInteger(partySize) || partySize < 2 || partySize > maximum) return res.status(400).json({ error: 'INVALID_PARTY_SIZE', message: `Party size must be between 2 and ${maximum}.` });
    if (typeof ownerOnlyControls !== 'boolean') return res.status(400).json({ error: 'INVALID_CONTROL_PERMISSION', message: 'Choose whether only the room owner can control music.' });

    const roomId = crypto.randomBytes(16).toString('hex');
    const roomCode = createRoomCode(data.rooms);
    const inviteToken = visibility === 'private' ? crypto.randomBytes(32).toString('base64url') : null;
    const now = new Date().toISOString();
    const room = {
      roomId, roomCode, roomName, visibility, partySize, ownerOnlyControls, playbackSource,
      hostIdentityId: identity.identityId,
      hostIdentityType: identity.type,
      hostUsername: profile.username,
      hostParticipantId: null,
      inviteTokenHash: inviteToken ? sha256(inviteToken) : null,
      participants: {},
      queue: [],
      queueSettings: { loop: false, shuffle: false, autoMix: false },
      chat: [],
      bannedIdentityIds: [],
      playbackState: {
        source: playbackSource,
        track: null,
        isPlaying: false,
        positionSeconds: 0,
        updatedAt: now
      },
      signalSequence: 0,
      signals: [],
      joinRequests: {},
      status: 'open',
      createdAt: now,
      updatedAt: now
    };
    const host = createParticipant(room, {
      username: profile.username,
      role: 'host',
      identityId: identity.identityId,
      avatarDataUrl: profile.avatarDataUrl || null
    });
    room.hostParticipantId = host.participant.participantId;

    const saved = await store.update(latest => {
      if (Object.values(latest.rooms).some(item => item.roomCode === roomCode && item.status === 'open')) {
        return { status: 409, error: 'ROOM_CODE_COLLISION', message: 'Could not allocate a room code. Try again.' };
      }
      latest.rooms[roomId] = room;
      return { ok: true };
    });
    if (saved.status) return res.status(saved.status).json({ error: saved.error, message: saved.message });

    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      ok: true,
      room: {
        roomId, roomCode, roomName, visibility, partySize, ownerOnlyControls, playbackSource,
        hostUsername: profile.username, status: room.status, createdAt: now
      },
      hostParticipantId: host.participant.participantId,
      hostCredential: host.credential,
      ...(inviteToken ? { inviteToken } : {}),
      realtimeReady: true,
      audioTransport: 'direct-webrtc'
    });
  });

  router.post('/rooms/:roomId/close', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!isRoomOwner(room, participant)) return { status: 403, error: 'ROOM_OWNER_REQUIRED' };
      room.status = 'closed';
      room.updatedAt = new Date().toISOString();
      room.participants = {};
      hostLocations.delete(room.roomId);
      for (const requestId of Object.keys(room.joinRequests || {})) pendingVerificationCodes.delete(requestId);
      return { ok: true, roomId: room.roomId, roomStatus: room.status };
    });
    if (result.status) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, roomId: result.roomId, status: result.roomStatus });
  });


  router.post('/rooms/:roomId/location', identityCsrf, async (req, res) => {
    const room = store.read().rooms[String(req.params.roomId || '')];
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const host = participantForRoom(room, req, res);
    if (!isRoomOwner(room, host)) return res.status(403).json({ error: 'ROOM_OWNER_REQUIRED' });
    const coordinates = cleanCoordinates(req.body?.location);
    if (!coordinates) return res.status(400).json({ error: 'INVALID_LOCATION', message: 'A valid approximate device location is required.' });
    // Coordinates live only in this process memory and expire after one minute.
    // They are never written to the BitConnection database or returned to clients.
    hostLocations.set(room.roomId, { ...coordinates, recordedAt: Date.now() });
    return res.json({ ok: true, expiresInSeconds: Math.floor(HOST_LOCATION_TTL_MS / 1000) });
  });

  router.post('/rooms/:roomId/join', bitConnectionCsrf, rateJoin, async (req, res) => {
    const snapshot = store.read();
    const roomPathValue = String(req.params.roomId || '');
    const requestedRoomCode = String(req.body?.roomCode || roomPathValue).trim().toUpperCase();
    const room = Object.values(snapshot.rooms).find(item => (
      item?.roomId === roomPathValue || item?.roomCode === requestedRoomCode
    ));
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: 'That room is not available.' });
    const joiningIdentity = identityForRequest(req, res);
    if (joiningIdentity?.identityId && (room.bannedIdentityIds || []).includes(joiningIdentity.identityId)) {
      return res.status(403).json({ error: 'ROOM_BANNED', message: 'Your account is banned from this listening party.' });
    }
    const joiningProfile = joiningIdentity ? profileFor(snapshot, joiningIdentity.identityId) : null;
    if (room.visibility === 'private') {
      const inviteToken = String(req.body?.inviteToken || '');
      if (!inviteToken || !room.inviteTokenHash || !secureEqual(room.inviteTokenHash, sha256(inviteToken))) {
        return res.status(403).json({ error: 'PRIVATE_INVITE_REQUIRED', message: 'This private room needs its invitation link or QR code.' });
      }
    }
    if (participantCount(room) >= room.partySize) {
      return res.status(409).json({ error: 'ROOM_FULL', message: 'This listening party has reached its participant limit.' });
    }

    let closeEnough = false;
    if (room.visibility === 'private') {
      const guestLocation = cleanCoordinates(req.body?.location);
      const hostLocation = hostLocations.get(room.roomId);
      const hostLocationFresh = hostLocation && Date.now() - hostLocation.recordedAt <= HOST_LOCATION_TTL_MS;
      if (guestLocation && guestLocation.accuracy <= 30 && hostLocationFresh && hostLocation.accuracy <= 30) {
        const measuredDistance = distanceMeters(guestLocation, hostLocation);
        // Include both reported accuracy radii so uncertain GPS readings fall back to the host code.
        closeEnough = measuredDistance + guestLocation.accuracy + hostLocation.accuracy <= PRIVATE_ROOM_RADIUS_METERS;
      }
    }

    if (room.visibility === 'private' && !closeEnough) {
      const requestId = crypto.randomBytes(18).toString('base64url');
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const request = {
        requestId,
        status: 'awaiting-host-code',
        codeHash: sha256(code),
        attempts: 0,
        createdAt: new Date().toISOString(),
        hostReceivedAt: null,
        expiresAt: null,
        guestName: joiningProfile?.username || temporaryGuestName(room),
        identityId: joiningIdentity?.identityId || null,
        avatarDataUrl: joiningProfile?.avatarDataUrl || null
      };
      await store.update(data => {
        const current = data.rooms[room.roomId];
        if (!current || current.status !== 'open') return { status: 404 };
        current.joinRequests ||= {};
        current.joinRequests[requestId] = request;
        return { ok: true };
      });
      pendingVerificationCodes.set(requestId, code);
      return res.status(202).json({
        ok: true,
        verification: 'host-one-time-code',
        requestId,
        guestName: request.guestName,
        message: 'Ask the host for the one-time code shown in their BitConnection notification.'
      });
    }

    const joined = await store.update(data => {
      const current = data.rooms[room.roomId];
      if (!current || current.status !== 'open') return { status: 404 };
      if (participantCount(current) >= current.partySize) return { status: 409 };
      current.participants ||= {};
      const username = joiningProfile?.username || temporaryGuestName(current);
      const created = createParticipant(current, {
        username,
        identityId: joiningIdentity?.identityId || null,
        avatarDataUrl: joiningProfile?.avatarDataUrl || null
      });
      return { ok: true, participant: created.participant, credential: created.credential, room: current };
    });
    if (joined.status) return res.status(joined.status).json({ error: joined.status === 409 ? 'ROOM_FULL' : 'ROOM_NOT_FOUND' });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      ok: true,
      verification: room.visibility === 'private' ? 'proximity' : 'not-required',
      participantId: joined.participant.participantId,
      participantCredential: joined.credential,
      username: joined.participant.username,
      room: publicRoom(joined.room),
      participants: Object.values(joined.room.participants).filter(item => item.status !== 'left').map(item => publicParticipant(item))
    });
  });

  router.get('/rooms/:roomId/join-status/:requestId', (req, res) => {
    const room = store.read().rooms[String(req.params.roomId || '')];
    const request = room?.joinRequests?.[String(req.params.requestId || '')];
    if (!room || !request) return res.status(404).json({ error: 'JOIN_REQUEST_NOT_FOUND' });
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) {
      return res.status(410).json({ error: 'VERIFICATION_EXPIRED', message: 'The one-time code expired. Reopen the invitation to request another.' });
    }
    if (!request.expiresAt && Date.now() - Date.parse(request.createdAt) > 10 * 60 * 1000) {
      return res.status(410).json({ error: 'JOIN_REQUEST_EXPIRED' });
    }
    return res.json({
      ok: true,
      status: request.status,
      expiresAt: request.expiresAt,
      guestName: request.guestName
    });
  });

  router.get('/rooms/:roomId/verification-requests', async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const host = participantForRoom(room, req, res);
      if (!isRoomOwner(room, host)) return { status: 403, error: 'ROOM_OWNER_REQUIRED' };
      const now = Date.now();
      const requests = [];
      for (const request of Object.values(room.joinRequests || {})) {
        if (!request || request.status !== 'awaiting-host-code') continue;
        if (!request.expiresAt) {
          request.hostReceivedAt = new Date(now).toISOString();
          request.expiresAt = new Date(now + 5 * 60 * 1000).toISOString();
        }
        const code = pendingVerificationCodes.get(request.requestId);
        if (!code || Date.parse(request.expiresAt) <= now) {
          request.status = 'expired';
          pendingVerificationCodes.delete(request.requestId);
          continue;
        }
        requests.push({
          requestId: request.requestId,
          guestName: request.guestName,
          oneTimeCode: code,
          expiresAt: request.expiresAt
        });
      }
      return { ok: true, requests };
    });
    if (result.status) return res.status(result.status).json({ error: result.error });
    res.set('Cache-Control', 'no-store');
    return res.json({ requests: result.requests });
  });

  router.post('/rooms/:roomId/verify', bitConnectionCsrf, rateJoin, async (req, res) => {
    const requestId = String(req.body?.requestId || '');
    const code = String(req.body?.code || '');
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(requestId) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'INVALID_VERIFICATION_CODE' });
    }
    const verified = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      const request = room?.joinRequests?.[requestId];
      if (!room || room.status !== 'open' || !request) return { status: 404, error: 'JOIN_REQUEST_NOT_FOUND' };
      if (!request.expiresAt || Date.parse(request.expiresAt) <= Date.now()) {
        delete room.joinRequests[requestId];
        return { status: 410, error: 'VERIFICATION_EXPIRED' };
      }
      if (request.attempts >= 5) {
        delete room.joinRequests[requestId];
        return { status: 429, error: 'VERIFICATION_ATTEMPTS_EXCEEDED' };
      }
      if (!secureEqual(request.codeHash, sha256(code))) {
        request.attempts += 1;
        return { status: 401, error: 'INVALID_VERIFICATION_CODE' };
      }
      if (participantCount(room) >= room.partySize) return { status: 409, error: 'ROOM_FULL' };
      if (request.identityId && (room.bannedIdentityIds || []).includes(request.identityId)) return { status: 403, error: 'ROOM_BANNED' };
      delete room.joinRequests[requestId];
      const created = createParticipant(room, {
        username: request.guestName,
        identityId: request.identityId || null,
        avatarDataUrl: request.avatarDataUrl || null
      });
      return { ok: true, participant: created.participant, credential: created.credential, room };
    });
    if (verified.status) {
      pendingVerificationCodes.delete(requestId);
      return res.status(verified.status).json({ error: verified.error });
    }
    pendingVerificationCodes.delete(requestId);
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      ok: true,
      participantId: verified.participant.participantId,
      participantCredential: verified.credential,
      username: verified.participant.username,
      room: publicRoom(verified.room)
    });
  });

  router.get('/rooms/:roomId/ice-config', (req, res) => {
    const room = store.read().rooms[String(req.params.roomId || '')];
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const participant = participantForRoom(room, req, res);
    if (!participant || participant.status === 'left') {
      return res.status(401).json({ error: 'ROOM_MEMBERSHIP_REQUIRED' });
    }

    try {
      const configuration = createIceConfiguration(iceConfig, participant.participantId);
      res.set('Cache-Control', 'no-store');
      return res.json(configuration);
    } catch {
      return res.status(503).json({
        error: 'ICE_CONFIGURATION_UNAVAILABLE',
        message: 'The room audio connection service is not configured correctly.'
      });
    }
  });

  router.get('/rooms/:roomId/state', (req, res) => {
    const room = store.read().rooms[String(req.params.roomId || '')];
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const participant = participantForRoom(room, req, res);
    if (!participant || participant.status === 'left') return res.status(401).json({ error: 'ROOM_MEMBERSHIP_REQUIRED' });
    const participants = Object.values(room.participants || {})
      .filter(item => item?.status !== 'left')
      .map(item => publicParticipant(item));
    return res.json({
      ...roomResponse(room, participant),
      playbackState: room.playbackState || {
        source: playbackSource, track: null, isPlaying: false, positionSeconds: 0
      },
      queue: Array.isArray(room.queue) ? room.queue : [],
      queueSettings: room.queueSettings || { loop: false, shuffle: false, autoMix: false },
      chat: Array.isArray(room.chat) ? room.chat.slice(-80) : [],
      participants
    });
  });

  router.post('/rooms/:roomId/heartbeat', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!participant || participant.status === 'left') return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      const current = room.participants?.[participant.participantId];
      if (!current) return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      current.status = 'connected';
      current.lastSeenAt = new Date().toISOString();
      return { ok: true, participant: publicParticipant(current) };
    });
    if (result.status) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, participant: result.participant });
  });

  router.get('/rooms/:roomId/automix/status', async (req, res) => {
    const room = store.read().rooms[String(req.params.roomId || '')];
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const participant = participantForRoom(room, req, res);
    if (!participant || participant.status === 'left') {
      return res.status(401).json({ error: 'ROOM_MEMBERSHIP_REQUIRED' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      ...await autoMix.status(),
      canAnalyze: isRoomOwner(room, participant),
      analyzedQueueItems: (room.queue || []).filter(item => Boolean(item.autoMixAnalysis)).length,
      planningAvailable: true,
      livePlaybackEnabled: false
    });
  });

  router.post('/rooms/:roomId/automix/prepare', identityCsrf, rateAutoMix, async (req, res) => {
    const room = store.read().rooms[String(req.params.roomId || '')];
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const participant = participantForRoom(room, req, res);
    if (!isRoomOwner(room, participant)) {
      return res.status(403).json({ error: 'ROOM_OWNER_REQUIRED', message: 'Only the host can prepare the AutoMix models.' });
    }
    void autoMix.initialize().catch(() => {});
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({
      ok: true,
      status: 'preparing',
      model: 'Beat This! final0',
      message: 'The server is downloading and verifying the ONNX beat-tracking models. Check the AutoMix status endpoint for readiness.'
    });
  });

  router.post(
    '/rooms/:roomId/automix/analyze/:queueItemId',
    identityCsrf,
    rateAutoMix,
    express.raw({ type: 'application/vnd.bitconnection.pcm-f32le', limit: '64mb' }),
    async (req, res) => {
      const snapshot = store.read();
      const room = snapshot.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
      const participant = participantForRoom(room, req, res);
      if (!isRoomOwner(room, participant)) {
        return res.status(403).json({ error: 'ROOM_OWNER_REQUIRED', message: 'Only the host can submit audio for server-side AutoMix analysis.' });
      }
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({
          error: 'AUTOMIX_PCM_REQUIRED',
          message: 'Send mono Float32 PCM in little-endian byte order using application/vnd.bitconnection.pcm-f32le.'
        });
      }
      if (String(req.get('x-audio-sample-rate') || '') !== '22050') {
        return res.status(400).json({ error: 'AUTOMIX_SAMPLE_RATE_REQUIRED', message: 'AutoMix analysis requires 22050 Hz mono PCM.' });
      }
      const queueItemId = String(req.params.queueItemId || '');
      const queued = (room.queue || []).find(item => item.queueItemId === queueItemId);
      if (!queued) return res.status(404).json({ error: 'QUEUE_ITEM_NOT_FOUND' });
      try {
        const analysis = await autoMix.analyzePcm(req.body, { sampleRate: 22050 });
        const saved = await store.update(data => {
          const current = data.rooms[room.roomId];
          if (!current || current.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
          const item = (current.queue || []).find(entry => entry.queueItemId === queueItemId);
          if (!item) return { status: 404, error: 'QUEUE_ITEM_NOT_FOUND' };
          item.autoMixAnalysis = analysis;
          current.autoMixAnalysisUpdatedAt = new Date().toISOString();
          current.updatedAt = current.autoMixAnalysisUpdatedAt;
          return { ok: true };
        });
        if (saved.status) return res.status(saved.status).json({ error: saved.error });
        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, queueItemId, analysis });
      } catch (error) {
        const status = error instanceof RangeError || error instanceof TypeError ? 400 : 503;
        return res.status(status).json({
          error: 'AUTOMIX_ANALYSIS_FAILED',
          message: String(error?.message || 'The ONNX analysis could not be completed.').slice(0, 240)
        });
      }
    }
  );

  router.post('/rooms/:roomId/automix/plan', identityCsrf, rateAutoMix, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!isRoomOwner(room, participant)) return { status: 403, error: 'ROOM_OWNER_REQUIRED' };
      try {
        const plan = buildAutoMixPlan(room.queue || [], { smartOrder: req.body?.smartOrder !== false });
        room.autoMixPlan = plan;
        room.updatedAt = new Date().toISOString();
        return { ok: true, plan };
      } catch (error) {
        return { status: 409, error: error.code || 'AUTOMIX_PLAN_FAILED', message: error.message, write: false };
      }
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, plan: result.plan });
  });

  router.post('/rooms/:roomId/queue', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!participant || participant.status === 'left') return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      if (room.ownerOnlyControls && !isRoomOwner(room, participant)) {
        return { status: 403, error: 'HOST_CONTROLS_ONLY', message: 'Only the host can manage the queue in this room.' };
      }

      room.queue = Array.isArray(room.queue) ? room.queue : [];
      const action = String(req.body?.action || '');
      if (action === 'settings') {
        const settings = req.body?.settings || {};
        if (typeof settings.loop !== 'boolean' || typeof settings.shuffle !== 'boolean') {
          return { status: 400, error: 'INVALID_QUEUE_SETTINGS', message: 'Loop and shuffle must be boolean values.' };
        }
        if (settings.autoMix === true) {
          return { status: 503, error: 'AUTOMIX_PLAYER_BRIDGE_REQUIRED', message: 'The Deplexo ONNX analyzer and DJ planner are available, but the BitChord player-control bridge is not connected yet. AutoMix cannot control transitions until that bridge is implemented.' };
        }
        room.queueSettings = { loop: settings.loop, shuffle: settings.shuffle, autoMix: false };
      } else if (action === 'add') {
        if (room.queue.length >= 100) return { status: 409, error: 'QUEUE_FULL', message: 'The shared queue can contain up to 100 songs.' };
        const suppliedTrack = req.body?.track;
        const queueSource = String(suppliedTrack?.source || '');
        const track = queueSource === 'bitmono'
          ? cleanBitMonoTrack(suppliedTrack)
          : ['ccustom', 'cider'].includes(queueSource)
            ? cleanPartyAddonTrack(suppliedTrack, queueSource)
            : cleanYouTubeTrack(suppliedTrack);
        if (!track) return { status: 400, error: queueSource === 'bitmono' ? 'INVALID_BITMONO_TRACK' : ['ccustom', 'cider'].includes(queueSource) ? 'INVALID_PARTY_ADDON_TRACK' : 'INVALID_YOUTUBE_TRACK' };
        const item = {
          queueItemId: crypto.randomBytes(12).toString('hex'),
          ...track,
          addedByParticipantId: participant.participantId,
          addedAt: new Date().toISOString()
        };
        const index = req.body?.index === undefined ? room.queue.length : Number(req.body.index);
        if (!Number.isSafeInteger(index) || index < 0 || index > room.queue.length) {
          return { status: 400, error: 'INVALID_QUEUE_POSITION' };
        }
        room.queue.splice(index, 0, item);
      } else if (action === 'remove') {
        const queueItemId = String(req.body?.queueItemId || '');
        const index = room.queue.findIndex(item => item.queueItemId === queueItemId);
        if (index < 0) return { status: 404, error: 'QUEUE_ITEM_NOT_FOUND' };
        room.queue.splice(index, 1);
      } else if (action === 'move') {
        const queueItemId = String(req.body?.queueItemId || '');
        const from = room.queue.findIndex(item => item.queueItemId === queueItemId);
        const to = Number(req.body?.index);
        if (from < 0) return { status: 404, error: 'QUEUE_ITEM_NOT_FOUND' };
        if (!Number.isSafeInteger(to) || to < 0 || to >= room.queue.length) {
          return { status: 400, error: 'INVALID_QUEUE_POSITION' };
        }
        const [item] = room.queue.splice(from, 1);
        room.queue.splice(to, 0, item);
      } else if (action === 'clear') {
        room.queue = [];
      } else {
        return { status: 400, error: 'INVALID_QUEUE_ACTION', message: 'Choose add, remove, move, or clear.' };
      }

      room.updatedAt = new Date().toISOString();
      return { ok: true, queue: room.queue };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    return res.json({ ok: true, queue: result.queue });
  });

  router.post('/rooms/:roomId/chat', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!participant || participant.status === 'left') return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };

      const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
      const imageDataUrl = req.body?.imageDataUrl;
      const imageUrl = req.body?.imageUrl;
      let safeImageDataUrl = null;
      let safeImageUrl = null;
      if (imageDataUrl != null) {
        if (typeof imageDataUrl !== 'string') return { status: 400, error: 'INVALID_CHAT_IMAGE' };
        const match = imageDataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/);
        if (!match || Buffer.from(match[2], 'base64').length > 512 * 1024) {
          return { status: 400, error: 'INVALID_CHAT_IMAGE', message: 'Images must be PNG, JPEG, or WebP and no larger than 512 KB.' };
        }
        safeImageDataUrl = imageDataUrl;
      }
      if (imageUrl != null) {
        try {
          const parsed = new URL(String(imageUrl));
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password
            || !/(^|\.)giphy\.com$/i.test(parsed.hostname) || String(imageUrl).length > 2000) {
            return { status: 400, error: 'INVALID_CHAT_GIF', message: 'GIFs must use a valid HTTPS GIPHY media URL.' };
          }
          safeImageUrl = parsed.toString();
        } catch {
          return { status: 400, error: 'INVALID_CHAT_GIF' };
        }
      }
      if (!text && !safeImageDataUrl && !safeImageUrl) {
        return { status: 400, error: 'EMPTY_CHAT_MESSAGE' };
      }
      room.chat ||= [];
      const message = {
        messageId: crypto.randomBytes(12).toString('hex'),
        participantId: participant.participantId,
        username: participant.username,
        avatarDataUrl: participant.avatarDataUrl || null,
        text,
        imageDataUrl: safeImageDataUrl,
        imageUrl: safeImageUrl,
        imageType: safeImageUrl ? 'gif' : safeImageDataUrl ? 'image' : null,
        createdAt: new Date().toISOString()
      };
      room.chat.push(message);
      room.chat = room.chat.slice(-80);
      room.updatedAt = message.createdAt;
      return { ok: true, message };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    return res.status(201).json({ ok: true, message: result.message });
  });

  router.post('/rooms/:roomId/members/:participantId/moderate', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const host = participantForRoom(room, req, res);
      if (!isRoomOwner(room, host)) return { status: 403, error: 'ROOM_OWNER_REQUIRED' };
      const participantId = String(req.params.participantId || '');
      const target = room.participants?.[participantId];
      if (!target || target.status === 'left') return { status: 404, error: 'PARTICIPANT_NOT_FOUND' };
      if (participantId === host.participantId) return { status: 400, error: 'CANNOT_MODERATE_SELF' };
      const action = String(req.body?.action || '');
      if (action === 'kick') {
        delete room.participants[participantId];
      } else if (action === 'ban') {
        if (!target.identityId) {
          return { status: 409, error: 'ACCOUNT_REQUIRED_FOR_BAN', message: 'A persistent ban requires the member to have a signed-in BitConnection or BitCider identity. You can still kick this guest.' };
        }
        room.bannedIdentityIds ||= [];
        if (!room.bannedIdentityIds.includes(target.identityId)) room.bannedIdentityIds.push(target.identityId);
        delete room.participants[participantId];
      } else if (action === 'promote') {
        const previousHost = room.participants?.[room.hostParticipantId];
        if (previousHost) previousHost.role = 'guest';
        target.role = 'host';
        room.hostParticipantId = target.participantId;
        room.hostIdentityId = target.identityId || null;
        room.hostIdentityType = target.identityId?.startsWith('cider:') ? 'bitcider' : target.identityId ? 'bitconnection' : null;
        room.hostUsername = target.username;
      } else {
        return { status: 400, error: 'INVALID_MEMBER_ACTION', message: 'Choose kick, ban, or promote.' };
      }
      room.updatedAt = new Date().toISOString();
      return {
        ok: true,
        action,
        participants: Object.values(room.participants || {}).filter(item => item?.status !== 'left').map(item => publicParticipant(item))
      };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    return res.json({ ok: true, action: result.action, participants: result.participants });
  });

  router.post('/rooms/:roomId/playback', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!participant || participant.status === 'left') return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      if (room.ownerOnlyControls && !isRoomOwner(room, participant)) {
        return { status: 403, error: 'HOST_CONTROLS_ONLY', message: 'Only the host can control playback in this room.' };
      }
      const body = req.body || {};
      const next = { ...(room.playbackState || {}) };
      const nextSource = body.source === undefined ? (next.source || 'youtube-music') : String(body.source);
      if (!['youtube-music', 'bitmono', 'ccustom', 'cider', 'apple-music'].includes(nextSource)) {
        return { status: 400, error: 'UNSUPPORTED_MUSIC_SOURCE', message: 'Choose BitMono, CCustom, or Cider for party audio.' };
      }
      if (body.track !== undefined) {
        if (body.track === null) next.track = null;
        else {
          const track = nextSource === 'bitmono'
            ? cleanBitMonoTrack(body.track)
            : ['ccustom', 'cider'].includes(nextSource)
              ? cleanPartyAddonTrack(body.track, nextSource)
              : nextSource === 'apple-music'
                ? cleanAppleMusicTrack(body.track)
                : cleanYouTubeTrack(body.track);
          if (!track) return { status: 400, error: ['ccustom', 'cider'].includes(nextSource) ? 'INVALID_PARTY_ADDON_TRACK' : nextSource === 'bitmono' ? 'INVALID_BITMONO_TRACK' : nextSource === 'apple-music' ? 'INVALID_APPLE_MUSIC_TRACK' : 'INVALID_YOUTUBE_TRACK' };
          next.track = track;
        }
      } else if (body.source !== undefined && nextSource !== (next.source || 'youtube-music')) {
        return { status: 400, error: 'TRACK_REQUIRED_FOR_SOURCE_CHANGE', message: 'Choose a valid track when changing the playback source.' };
      } else if (next.track && nextSource !== 'youtube-music' && next.track.source !== nextSource) {
        return { status: 400, error: 'TRACK_REQUIRED_FOR_SOURCE_CHANGE', message: 'Choose a valid track before changing the party source.' };
      } else if (nextSource === 'youtube-music' && next.track && ['bitmono', 'ccustom', 'cider', 'apple-music'].includes(next.track.source)) {
        return { status: 400, error: 'YOUTUBE_TRACK_REQUIRED' };
      }
      if (body.isPlaying !== undefined) {
        if (typeof body.isPlaying !== 'boolean') return { status: 400, error: 'INVALID_PLAYBACK_STATE' };
        next.isPlaying = body.isPlaying;
      }
      if (body.positionSeconds !== undefined) {
        const position = Number(body.positionSeconds);
        if (!Number.isFinite(position) || position < 0 || position > 24 * 60 * 60) return { status: 400, error: 'INVALID_PLAYBACK_POSITION' };
        next.positionSeconds = position;
      }
      if (body.volume !== undefined) {
        return { status: 400, error: 'VOLUME_IS_LOCAL', message: 'Volume is stored per participant, not shared across the room.' };
      }
      next.source = nextSource;
      next.updatedAt = new Date().toISOString();
      next.updatedByParticipantId = participant.participantId;
      room.playbackState = next;
      room.updatedAt = next.updatedAt;
      return { ok: true, playbackState: next };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    return res.json({ ok: true, playbackState: result.playbackState });
  });

  router.post('/rooms/:roomId/volume', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!participant || participant.status === 'left') return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      if (room.ownerOnlyControls && !isRoomOwner(room, participant)) {
        return { status: 403, error: 'HOST_CONTROLS_ONLY', message: 'Only the host can adjust participant volume in this room.' };
      }
      const volume = Number(req.body?.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) return { status: 400, error: 'INVALID_VOLUME' };
      const current = room.participants?.[participant.participantId];
      if (!current) return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      current.volume = volume;
      return { ok: true, volume };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    return res.json({ ok: true, volume: result.volume });
  });

  router.post('/rooms/:roomId/signals', identityCsrf, rateSignal, async (req, res) => {
    const messageType = String(req.body?.type || '');
    const toParticipantId = String(req.body?.toParticipantId || '');
    const payload = req.body?.payload;
    if (!['offer', 'answer', 'ice-candidate', 'renegotiate', 'hangup'].includes(messageType)
      || !/^[a-f0-9]{24}$/.test(toParticipantId)
      || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 32000) {
      return res.status(400).json({ error: 'INVALID_WEBRTC_SIGNAL' });
    }
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const sender = participantForRoom(room, req, res);
      const recipient = room.participants?.[toParticipantId];
      if (!sender || sender.status === 'left' || !recipient || recipient.status === 'left') {
        return { status: 403, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      }
      if (sender.participantId === recipient.participantId) return { status: 400, error: 'INVALID_SIGNAL_RECIPIENT' };
      if (['offer', 'renegotiate'].includes(messageType)
        && (!isRoomOwner(room, sender) || recipient.role !== 'guest')) {
        return { status: 403, error: 'HOST_OFFER_REQUIRED', message: 'Only the host can initiate a guest audio connection.' };
      }
      if (messageType === 'answer' && (sender.role !== 'guest' || !isRoomOwner(room, recipient))) {
        return { status: 403, error: 'GUEST_ANSWER_REQUIRED', message: 'Only a guest can answer the host audio connection.' };
      }
      room.signals ||= [];
      room.signalSequence = Number(room.signalSequence || 0) + 1;
      const message = {
        sequence: room.signalSequence,
        fromParticipantId: sender.participantId,
        toParticipantId,
        type: messageType,
        payload,
        createdAt: new Date().toISOString()
      };
      room.signals = room.signals.filter(item => Date.now() - Date.parse(item.createdAt || 0) < 90 * 1000).slice(-199);
      room.signals.push(message);
      return { ok: true, sequence: message.sequence };
    });
    if (result.status) return res.status(result.status).json({ error: result.error });
    return res.status(202).json({ ok: true, sequence: result.sequence });
  });

  router.get('/rooms/:roomId/signals', (req, res) => {
    const room = store.read().rooms[String(req.params.roomId || '')];
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const participant = participantForRoom(room, req, res);
    if (!participant || participant.status === 'left') return res.status(401).json({ error: 'ROOM_MEMBERSHIP_REQUIRED' });
    const after = Math.max(0, Number.parseInt(String(req.query.after || '0'), 10) || 0);
    const messages = (room.signals || []).filter(item => (
      item.toParticipantId === participant.participantId && item.sequence > after
    ));
    res.set('Cache-Control', 'no-store');
    return res.json({ messages, nextSequence: messages.reduce((max, item) => Math.max(max, item.sequence), after) });
  });

  router.post('/rooms/:roomId/leave', identityCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!participant || participant.status === 'left') return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      if (isRoomOwner(room, participant)) {
        const now = Date.now();
        const successor = Object.values(room.participants || {})
          .filter(item => item && item.participantId !== participant.participantId
            && item.status !== 'left'
            && Date.parse(item.lastSeenAt || 0) > now - PRESENCE_TTL_MS)
          .sort((left, right) => Date.parse(left.joinedAt || 0) - Date.parse(right.joinedAt || 0))[0];
        if (successor) {
          participant.role = 'guest';
          successor.role = 'host';
          room.hostParticipantId = successor.participantId;
          room.hostIdentityId = successor.identityId || null;
          room.hostIdentityType = successor.identityId?.startsWith('cider:')
            ? 'bitcider' : successor.identityId ? 'bitconnection' : null;
          room.hostUsername = successor.username;
          hostLocations.delete(room.roomId);
          delete room.participants[participant.participantId];
          room.updatedAt = new Date().toISOString();
          return { ok: true, roomClosed: false, hostTransferred: true, hostParticipantId: successor.participantId };
        }
        room.status = 'closed';
        room.updatedAt = new Date().toISOString();
        room.participants = {};
        hostLocations.delete(room.roomId);
        for (const requestId of Object.keys(room.joinRequests || {})) pendingVerificationCodes.delete(requestId);
        return { ok: true, roomClosed: true, hostTransferred: false };
      }
      delete room.participants?.[participant.participantId];
      room.updatedAt = new Date().toISOString();
      return { ok: true, roomClosed: false, hostTransferred: false };
    });
    if (result.status) return res.status(result.status).json({ error: result.error });
    return res.json({
      ok: true,
      roomClosed: result.roomClosed,
      hostTransferred: Boolean(result.hostTransferred),
      hostParticipantId: result.hostParticipantId || null
    });
  });

  return router;
}
