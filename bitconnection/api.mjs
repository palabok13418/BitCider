import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

export const BITCONNECTION_API_VERSION = '2026-11-25-live-room-foundation-01';
const COOKIE_NAME = 'bitconnection_session';
const SESSION_PATTERN = /^[A-Za-z0-9_-]{40,50}$/;
const PASSWORD_DUMMY = await createPasswordRecord(crypto.randomBytes(32).toString('base64url') + '-bitconnection-dummy');

function emptyData() {
  return { accounts: {}, profiles: {}, rooms: {}, authSessions: {}, webauthnChallenges: {} };
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
      webauthnChallenges: value.webauthnChallenges && typeof value.webauthnChallenges === 'object' ? value.webauthnChallenges : {}
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
    const bytes = crypto.randomBytes(8);
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
  const account = authSession && Date.parse(authSession.expiresAt || 0) > Date.now()
    ? data.accounts[authSession.accountId]
    : null;
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

export function bitConnectionHealthPayload(maxPartySize = 10) {
  return {
    ok: true,
    service: 'BitConnection',
    apiVersion: BITCONNECTION_API_VERSION,
    deployment: 'Deplexo',
    stage: 'live-room-membership-signaling-and-sync',
    capabilities: {
      independentAccounts: 'enabled',
      bitCiderAccountLinking: 'explicit-choice',
      ciderAddonCreation: 'never',
      hostProfiles: 'enabled',
      roomCreation: 'enabled',
      passkeys: 'enabled',
      recoveryCodes: 'enabled',
      realtimeRooms: 'polling-and-webrtc-signaling-enabled',
      playbackSync: 'youtube-music-through-bitchord-web',
      privateRoomVerification: 'proximity-or-host-one-time-code',
      audioRelay: 'never-server-side'
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
  maxPartySize = 10
} = {}) {
  if (!dataFile) throw new TypeError('BitConnection dataFile is required.');
  const store = createDataStore(dataFile);
  const secret = makeSecretFile(dataFile);
  const router = express.Router();
  const maximum = Number.isSafeInteger(Number(maxPartySize))
    ? Math.min(100, Math.max(2, Number(maxPartySize)))
    : 10;
  const rateRegister = createRateLimit(4);
  const rateLogin = createRateLimit(10);
  const rateRecover = createRateLimit(5);
  const ratePasskey = createRateLimit(8);
  const rateJoin = createRateLimit(24, 60 * 1000);
  const rateSignal = createRateLimit(180, 60 * 1000);
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
    return Boolean(participant && participant.role === 'host' && participant.identityId === room.hostIdentityId);
  }

  function participantCount(room) {
    const now = Date.now();
    return Object.values(room.participants || {}).filter(item => (
      item?.status !== 'left'
      && Date.parse(item?.lastSeenAt || 0) > now - PRESENCE_TTL_MS
    )).length;
  }

  function createParticipant(room, { username, role = 'guest', identityId = null }) {
    const credential = crypto.randomBytes(32).toString('base64url');
    const participantId = crypto.randomBytes(12).toString('hex');
    const participant = {
      participantId,
      username,
      role,
      identityId,
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
      joinedAt: item.joinedAt
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
      hostUsername: room.hostUsername,
      status: room.status,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt
    };
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

  router.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(bitConnectionHealthPayload(maximum));
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
        profile: profile ? { username: profile.username, avatarDataUrl: profile.avatarDataUrl || null, createdAt: profile.createdAt, updatedAt: profile.updatedAt } : null,
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
      profile: profile ? { username: profile.username, avatarDataUrl: profile.avatarDataUrl || null, createdAt: profile.createdAt, updatedAt: profile.updatedAt } : null,
      csrfToken: tokenForSession(secret, session.sessionId),
      bitCiderAccountAvailable: Boolean(cider?.authenticated && cider?.accountId),
      maxPartySize: maximum,
      passkeyCount: session.authenticated ? publicPasskeys(session.account).length : 0
    });
  });

  router.post('/auth/register', bitConnectionCsrf, rateRegister, async (req, res) => {
    const username = cleanUsername(req.body?.username);
    const password = req.body?.password;
    const avatarDataUrl = cleanImageDataUrl(req.body?.avatarDataUrl);
    if (!username) return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Choose a username containing 1 to 24 characters.' });
    if (!validatePassword(password)) return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Enter a passphrase.' });
    if (avatarDataUrl === undefined) return res.status(400).json({ error: 'INVALID_PROFILE_IMAGE', message: 'Use a PNG, JPEG, or WebP profile picture up to 1 MB.' });

    let passwordRecord;
    try { passwordRecord = await createPasswordRecord(password); }
    catch { return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Could not prepare that passphrase.' }); }
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
    const valid = await verifyPassword(password, match?.[1]?.password || PASSWORD_DUMMY);
    if (!match || !validatePassword(password) || !valid) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'The username or passphrase is incorrect.' });
    }
    if (activeSession(req, res).authenticated) {
      return res.status(409).json({ error: 'ALREADY_SIGNED_IN', message: 'A BitConnection account is already signed in on this device.' });
    }
    const [accountId, accountSnapshot] = match;
    const sessionHash = hashSessionId(req.bitConnectionSessionId);
    const result = await store.update(data => {
      const account = data.accounts[accountId];
      if (!account || account.password?.hash !== accountSnapshot.password.hash) {
        return { status: 401, error: 'INVALID_CREDENTIALS', message: 'The username or passphrase is incorrect.', write: false };
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
    if (!validatePassword(newPassword)) return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Enter a new passphrase.' });
    const snapshot = store.read();
    const normalized = usernameKey(username);
    const match = Object.entries(snapshot.accounts).find(([, account]) => usernameKey(account.username) === normalized);
    if (!match) return res.status(400).json({ error: 'INVALID_RECOVERY', message: 'The username or recovery code could not be verified.' });
    const [accountId, accountSnapshot] = match;
    const consumedSnapshot = consumeRecoveryCode(recoveryCode, accountSnapshot.recoveryCodeHashes || []);
    if (!consumedSnapshot.valid) return res.status(400).json({ error: 'INVALID_RECOVERY', message: 'The username or recovery code could not be verified.' });

    let passwordRecord;
    try { passwordRecord = await createPasswordRecord(newPassword); }
    catch { return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Could not prepare that passphrase.' }); }
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
      return res.status(401).json({ error: 'REAUTHENTICATION_REQUIRED', message: 'Enter your current BitConnection passphrase to add a passkey.' });
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
        if (!account || account.webAuthnUserId !== matchedAccount.webAuthnUserId) return { status: 401, error: 'INVALID_PASSKEY', write: false };
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
      return res.status(401).json({ error: 'REAUTHENTICATION_REQUIRED', message: 'Enter your current BitConnection passphrase to remove a passkey.' });
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
      roomId, roomCode, roomName, visibility, partySize, ownerOnlyControls,
      hostIdentityId: identity.identityId,
      hostIdentityType: identity.type,
      hostUsername: profile.username,
      hostParticipantId: null,
      inviteTokenHash: inviteToken ? sha256(inviteToken) : null,
      participants: {},
      playbackState: {
        source: 'youtube-music',
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
      identityId: identity.identityId
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
        roomId, roomCode, roomName, visibility, partySize, ownerOnlyControls,
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
    const identity = identityForRequest(req, res);
    if (!identity) return res.status(401).json({ error: 'BITCONNECTION_ACCOUNT_REQUIRED' });
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      if (room.hostIdentityId !== identity.identityId) return { status: 403, error: 'ROOM_OWNER_REQUIRED' };
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
        closeEnough = distanceMeters(guestLocation, hostLocation) <= PRIVATE_ROOM_RADIUS_METERS;
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
        guestName: temporaryGuestName(room)
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
      const username = temporaryGuestName(current);
      const created = createParticipant(current, { username });
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
      delete room.joinRequests[requestId];
      const created = createParticipant(room, { username: request.guestName });
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
        source: 'youtube-music', track: null, isPlaying: false, positionSeconds: 0
      },
      participants
    });
  });

  router.post('/rooms/:roomId/heartbeat', bitConnectionCsrf, async (req, res) => {
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

  router.post('/rooms/:roomId/playback', bitConnectionCsrf, async (req, res) => {
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
      if (body.source !== undefined && body.source !== 'youtube-music') {
        return { status: 400, error: 'UNSUPPORTED_MUSIC_SOURCE', message: 'BitConnection rooms use YouTube Music through BitChord Web.' };
      }
      if (body.track !== undefined) {
        if (body.track === null) next.track = null;
        else {
          const track = body.track;
          const videoId = String(track?.videoId || '');
          const title = String(track?.title || '').trim();
          const artist = String(track?.artist || '').trim();
          const durationSeconds = Number(track?.durationSeconds);
          if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !title || title.length > 180
            || !artist || artist.length > 180 || !Number.isFinite(durationSeconds)
            || durationSeconds < 0 || durationSeconds > 24 * 60 * 60) {
            return { status: 400, error: 'INVALID_YOUTUBE_TRACK' };
          }
          next.track = { videoId, title, artist, durationSeconds };
        }
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
      next.source = 'youtube-music';
      next.updatedAt = new Date().toISOString();
      next.updatedByParticipantId = participant.participantId;
      room.playbackState = next;
      room.updatedAt = next.updatedAt;
      return { ok: true, playbackState: next };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    return res.json({ ok: true, playbackState: result.playbackState });
  });

  router.post('/rooms/:roomId/volume', bitConnectionCsrf, async (req, res) => {
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

  router.post('/rooms/:roomId/signals', bitConnectionCsrf, rateSignal, async (req, res) => {
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

  router.post('/rooms/:roomId/leave', bitConnectionCsrf, async (req, res) => {
    const result = await store.update(data => {
      const room = data.rooms[String(req.params.roomId || '')];
      if (!room || room.status !== 'open') return { status: 404, error: 'ROOM_NOT_FOUND' };
      const participant = participantForRoom(room, req, res);
      if (!participant || participant.status === 'left') return { status: 401, error: 'ROOM_MEMBERSHIP_REQUIRED' };
      if (isRoomOwner(room, participant)) {
        room.status = 'closed';
        room.updatedAt = new Date().toISOString();
        room.participants = {};
        hostLocations.delete(room.roomId);
        for (const requestId of Object.keys(room.joinRequests || {})) pendingVerificationCodes.delete(requestId);
        return { ok: true, roomClosed: true };
      }
      delete room.participants?.[participant.participantId];
      room.updatedAt = new Date().toISOString();
      return { ok: true, roomClosed: false };
    });
    if (result.status) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, roomClosed: result.roomClosed });
  });

  return router;
}
