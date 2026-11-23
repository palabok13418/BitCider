import express from 'express';
import crypto from 'node:crypto';
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
const API_VERSION = '2026-11-23-account-key-v11';
const PUBLIC_URL = String(process.env.BITCIDER_PUBLIC_URL || '').replace(/\/+$/, '');
const app = express();
const browserBridges = new Map();
const browserBridgeByOwner = new Map();
const browserBridgeQueues = new Map();
const browserBridgePollWaiters = new Map();
const browserBridgeJobs = new Map();
const BROWSER_BRIDGE_ONLINE_WINDOW_MS = 65000;
const BROWSER_BRIDGE_EXPIRY_MS = 120000;
const DUMMY_PASSWORD_RECORD = await createPasswordRecord(
  crypto.randomBytes(32).toString('base64url') + '-dummy-account-passphrase'
);

// Deplexo terminates TLS in front of this Node service. Trust the immediate
// platform proxy so Express can read the forwarded public host/protocol.
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
});


function ensureSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  return fs.readFileSync(KEY_FILE);
}

let cachedDedicatedEncryptionKey;
let checkedDedicatedEncryptionKey = false;

function dedicatedTokenEncryptionKey() {
  if (checkedDedicatedEncryptionKey) return cachedDedicatedEncryptionKey;
  checkedDedicatedEncryptionKey = true;
  const encoded = String(process.env.BITCIDER_ENCRYPTION_KEY || '').trim();
  if (!encoded) return null;
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length !== 32 || secret.toString('base64url') !== encoded) {
    throw new Error('BITCIDER_ENCRYPTION_KEY must be a 32-byte base64url value generated once and stored as a Deplexo secret.');
  }
  cachedDedicatedEncryptionKey = crypto.scryptSync(secret, 'bitcider-token-encryption-v2', 32);
  return cachedDedicatedEncryptionKey;
}

function encryptToken(token) {
  const dedicatedKey = dedicatedTokenEncryptionKey();
  const keyVersion = dedicatedKey ? 2 : 1;
  const key = dedicatedKey || crypto.scryptSync(ensureSecret(), 'bitcider-local-token-v1', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    keyVersion,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    value: ciphertext.toString('base64url')
  };
}

function decryptToken(box) {
  if (!box?.iv || !box?.tag || !box?.value) return null;
  let key;
  if (box.keyVersion === 2) {
    key = dedicatedTokenEncryptionKey();
    if (!key) throw new Error('BITCIDER_ENCRYPTION_KEY is required to decrypt this saved Cider token.');
  } else {
    key = crypto.scryptSync(ensureSecret(), 'bitcider-local-token-v1', 32);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(box.value, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function migrateTokenEncryption() {
  const dedicatedKey = dedicatedTokenEncryptionKey();
  if (!dedicatedKey) return { configured: false, migrated: 0 };
  const store = readStore();
  let migrated = 0;
  const owners = [
    ...Object.values(store.sessions || {}),
    ...Object.values(store.accounts || {})
  ];
  for (const owner of owners) {
    if (!owner?.ciderToken || owner.ciderToken.keyVersion === 2) continue;
    const plaintext = decryptToken(owner.ciderToken);
    if (!plaintext) throw new Error('A legacy Cider token could not be decrypted during key migration.');
    owner.ciderToken = encryptToken(plaintext);
    migrated += 1;
  }
  if (migrated) writeStore(store);
  return { configured: true, migrated };
}

const SESSION_COOKIE = 'bitcider_session';

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (parsed?.addonKey || parsed?.ciderToken) {
      return { sessions: { legacy: parsed }, accounts: {}, authSessions: {}, webauthnChallenges: {} };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { sessions: {}, accounts: {}, authSessions: {}, webauthnChallenges: {} };
    }
    return {
      ...parsed,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
      authSessions: parsed.authSessions && typeof parsed.authSessions === 'object' ? parsed.authSessions : {},
      webauthnChallenges: parsed.webauthnChallenges && typeof parsed.webauthnChallenges === 'object' ? parsed.webauthnChallenges : {}
    };
  } catch {
    return { sessions: {}, accounts: {}, authSessions: {}, webauthnChallenges: {} };
  }
}

function migrateLegacyAccountUsernames() {
  const store = readStore();
  let removed = 0;
  for (const account of Object.values(store.accounts || {})) {
    if (Object.prototype.hasOwnProperty.call(account, 'username')) {
      delete account.username;
      removed += 1;
    }
  }
  if (removed) writeStore(store);
  return removed;
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

function requireDedicatedTokenEncryption(_req, res, next) {
  try {
    if (!dedicatedTokenEncryptionKey()) {
      return res.status(503).json({
        error: 'SECURE_STORAGE_NOT_CONFIGURED',
        message: 'Secure cloud accounts are unavailable until BITCIDER_ENCRYPTION_KEY is configured on Deplexo.'
      });
    }
    next();
  } catch (error) {
    console.error('BitCider encryption-key configuration error:', error.message);
    return res.status(503).json({
      error: 'SECURE_STORAGE_MISCONFIGURED',
      message: 'Secure cloud storage is not configured correctly. Contact the BitCider administrator.'
    });
  }
}

function deviceNameFromUserAgent(userAgent) {
  const ua = String(userAgent || '').slice(0, 512);
  const platform = /Windows NT/i.test(ua) ? 'Windows'
    : /iPhone/i.test(ua) ? 'iPhone'
      : /iPad/i.test(ua) ? 'iPad'
        : /Android/i.test(ua) ? 'Android'
          : /Macintosh|Mac OS X/i.test(ua) ? 'Mac'
            : /CrOS/i.test(ua) ? 'Chromebook'
              : /Linux/i.test(ua) ? 'Linux'
                : 'Unknown device';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /CriOS\//i.test(ua) ? 'Chrome'
      : /Chrome\//i.test(ua) ? 'Chrome'
        : /Firefox\//i.test(ua) ? 'Firefox'
          : /Safari\//i.test(ua) ? 'Safari'
            : 'Browser';
  return browser + ' on ' + platform;
}

function activeAccountDevices(store, accountId, currentSessionId) {
  const now = Date.now();
  return Object.entries(store.authSessions)
    .filter(([, entry]) => entry?.accountId === accountId && Date.parse(entry.expiresAt || 0) > now)
    .sort((a, b) => Date.parse(b[1].lastSeenAt || b[1].createdAt || 0) - Date.parse(a[1].lastSeenAt || a[1].createdAt || 0))
    .map(([id, entry]) => ({
      id,
      name: entry.deviceName || 'Previously signed-in device',
      createdAt: entry.createdAt || null,
      lastSeenAt: entry.lastSeenAt || entry.createdAt || null,
      isCurrent: id === hashSessionId(currentSessionId)
    }));
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

function createAuthenticatedSession(store, accountId, res, req) {
  const now = Date.now();
  const active = Object.entries(store.authSessions)
    .filter(([, entry]) => entry?.accountId === accountId && Date.parse(entry.expiresAt || 0) > now)
    .sort((a, b) => Date.parse(a[1].lastSeenAt || a[1].createdAt || 0) - Date.parse(b[1].lastSeenAt || b[1].createdAt || 0));
  let evictedDevice = null;
  while (active.length >= MAX_ACCOUNT_DEVICES) {
    const [oldHash, oldest] = active.shift();
    delete store.authSessions[oldHash];
    evictedDevice = oldest.deviceName || 'the oldest signed-in device';
  }

  const sessionId = crypto.randomBytes(32).toString('base64url');
  const nowIso = new Date(now).toISOString();
  store.authSessions[hashSessionId(sessionId)] = {
    accountId,
    createdAt: nowIso,
    lastSeenAt: nowIso,
    deviceName: deviceNameFromUserAgent(req?.get?.('user-agent')),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  };
  setSessionCookie(res, sessionId);
  return { sessionId, evictedDevice };
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
    const cookieSession = readCookie(req, SESSION_COOKIE);
    const sessionKey = /^[A-Za-z0-9_-]{40,50}$/.test(cookieSession)
      ? hashSessionId(cookieSession).slice(0, 16)
      : '';
    const routeKey = String(req.baseUrl || '') + String(req.path || '');
    const keys = [
      { key: 'ip:' + ip, limit: 60 },
      ...(sessionKey ? [
        { key: 'session-route:' + sessionKey + ':' + routeKey, limit: maxAttempts },
        { key: 'session-global:' + sessionKey, limit: 30 }
      ] : [])
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

function createAccountKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashAccountKey(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return '';
  const decoded = Buffer.from(key, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== key) return '';
  return crypto.createHash('sha256')
    .update('BitCider Account Key v1\0', 'utf8')
    .update(key, 'utf8')
    .digest('hex');
}

function findAccountByAccountKey(store, value) {
  const candidate = hashAccountKey(value);
  if (!candidate) return null;
  const candidateBytes = Buffer.from(candidate, 'hex');
  let match = null;
  for (const [accountId, account] of Object.entries(store?.accounts || {})) {
    const stored = typeof account?.accountKeyHash === 'string' ? account.accountKeyHash : '';
    if (!/^[a-f0-9]{64}$/i.test(stored)) continue;
    const storedBytes = Buffer.from(stored, 'hex');
    if (storedBytes.length === candidateBytes.length && crypto.timingSafeEqual(candidateBytes, storedBytes)) {
      match = { accountId, account };
    }
  }
  return match;
}

function pendingAccountAuthFor(store, sessionId) {
  const pending = store?.sessions?.[sessionId];
  const expiresAt = Number(pending?.pendingAccountExpiresAt);
  if (!pending?.pendingAccountId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { accountId: pending.pendingAccountId };
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

function webAuthnContext(req) {
  const throughGateway = trustedProxy(req);
  const rawOrigin = (throughGateway ? req.get('x-bitcider-public-origin') : '')
    || req.get('origin')
    || PUBLIC_URL;
  if (!rawOrigin || (!throughGateway && !trustedFrontend(req))) {
    throw new Error('Use the official BitCider website to manage passkeys.');
  }

  let parsed;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error('The BitCider website origin is invalid.');
  }
  const localHttp = parsed.protocol === 'http:'
    && (isLoopback(parsed.hostname) || parsed.hostname === 'localhost');
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Passkeys require the official HTTPS BitCider website.');
  }
  return { origin: parsed.origin, rpID: parsed.hostname.toLowerCase() };
}

async function saveWebAuthnChallenge(sessionId, record) {
  return updateStore(store => {
    const now = Date.now();
    for (const [key, entry] of Object.entries(store.webauthnChallenges)) {
      if (!entry || Number(entry.expiresAt) <= now) delete store.webauthnChallenges[key];
    }
    store.webauthnChallenges[hashSessionId(sessionId)] = {
      ...record,
      expiresAt: now + WEBAUTHN_CHALLENGE_TTL_MS
    };
    return { ok: true };
  });
}

async function consumeWebAuthnChallenge(sessionId, purpose, accountId = null) {
  return updateStore(store => {
    const key = hashSessionId(sessionId);
    const challenge = store.webauthnChallenges[key];
    if (!challenge) return { challenge: null, write: false };
    delete store.webauthnChallenges[key];
    if (challenge.purpose !== purpose || Number(challenge.expiresAt) <= Date.now()
      || (accountId && challenge.accountId !== accountId)) {
      return { challenge: null };
    }
    return { challenge };
  }).then(result => result.challenge);
}

function ciderBridgeError(code, message, status = 503) {
  const error = new Error(message);
  error.status = status;
  error.ciderCode = code;
  return error;
}

function browserBridgeOwnerKey(accountId, sessionId) {
  return accountId ? 'account:' + accountId : 'session:' + sessionId;
}

function hashBrowserBridgeSecret(value) {
  return crypto.createHash('sha256')
    .update('BitCider browser bridge v1\\0', 'utf8')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

function sweepExpiredBrowserBridges() {
  const now = Date.now();
  for (const registration of browserBridges.values()) {
    if (now - registration.lastSeenAt >= BROWSER_BRIDGE_EXPIRY_MS) {
      invalidateBrowserBridge(registration.ownerKey, 'The BitCider browser tab has been inactive. Reopen BitCider to reconnect.');
    }
  }
}

setInterval(sweepExpiredBrowserBridges, 30000).unref?.();

function browserBridgeSessionIsActive(registration) {
  const store = readStore();
  if (registration.accountId) {
    const session = store.authSessions[registration.sessionHash];
    const account = store.accounts[registration.accountId];
    return Boolean(
      session
      && session.accountId === registration.accountId
      && Date.parse(session.expiresAt || 0) > Date.now()
      && account?.ciderToken
      && account?.addonKey
    );
  }
  const session = store.sessions[registration.sessionId];
  return Boolean(session?.ciderToken && session?.addonKey);
}

function browserBridgeFromRequest(req) {
  const bridgeId = String(req.get('x-bitcider-bridge-id') || '');
  const secret = String(req.get('x-bitcider-bridge-secret') || '');
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(bridgeId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const registration = browserBridges.get(bridgeId);
  if (!registration) return null;
  if (browserBridgeByOwner.get(registration.ownerKey) !== bridgeId) return null;
  const candidate = Buffer.from(hashBrowserBridgeSecret(secret), 'hex');
  const stored = Buffer.from(registration.secretHash, 'hex');
  if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return null;
  if (!browserBridgeSessionIsActive(registration)) {
    invalidateBrowserBridge(registration.ownerKey, 'The BitCider session expired or was signed out. Reload BitCider and sign in again.');
    return null;
  }
  return registration;
}

function browserBridgeStatus(ownerKey, connected, sessionId) {
  const bridgeId = browserBridgeByOwner.get(ownerKey);
  const registration = bridgeId ? browserBridges.get(bridgeId) : null;
  const belongsToThisSession = Boolean(
    registration && registration.sessionHash === hashSessionId(sessionId)
  );
  const lastSeen = belongsToThisSession ? (registration.lastSeenAt || 0) : 0;
  const online = Boolean(
    connected && belongsToThisSession
      && Date.now() - lastSeen < BROWSER_BRIDGE_ONLINE_WINDOW_MS
  );
  return {
    provisioned: Boolean(connected && belongsToThisSession),
    online,
    lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    mode: 'browser'
  };
}

function invalidateBrowserBridge(ownerKey, message = 'The BitCider browser bridge was stopped.') {
  const bridgeId = browserBridgeByOwner.get(ownerKey);
  if (!bridgeId) return;
  browserBridgeByOwner.delete(ownerKey);
  browserBridges.delete(bridgeId);
  browserBridgeQueues.delete(bridgeId);
  const waiters = browserBridgePollWaiters.get(bridgeId) || [];
  browserBridgePollWaiters.delete(bridgeId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  for (const [requestId, job] of browserBridgeJobs) {
    if (job.bridgeId !== bridgeId) continue;
    clearTimeout(job.timer);
    browserBridgeJobs.delete(requestId);
    job.reject(ciderBridgeError('CIDER_BRIDGE_OFFLINE', message, 503));
  }
}

function takeBrowserBridgeJob(bridgeId, waitMs) {
  const queue = browserBridgeQueues.get(bridgeId) || [];
  if (queue.length) {
    const job = queue.shift();
    if (!queue.length) browserBridgeQueues.delete(bridgeId);
    return Promise.resolve(job);
  }
  return new Promise(resolve => {
    const waiters = browserBridgePollWaiters.get(bridgeId) || [];
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        const current = browserBridgePollWaiters.get(bridgeId) || [];
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
        if (!current.length) browserBridgePollWaiters.delete(bridgeId);
        resolve(null);
      }, waitMs)
    };
    waiters.push(waiter);
    browserBridgePollWaiters.set(bridgeId, waiters);
  });
}

function enqueueBrowserBridgeJob(bridgeId, job) {
  const waiters = browserBridgePollWaiters.get(bridgeId) || [];
  const waiter = waiters.shift();
  if (!waiters.length) browserBridgePollWaiters.delete(bridgeId);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve(job);
    return;
  }
  const queue = browserBridgeQueues.get(bridgeId) || [];
  queue.push(job);
  browserBridgeQueues.set(bridgeId, queue);
}

function removeQueuedBrowserBridgeJob(bridgeId, requestId) {
  const queue = browserBridgeQueues.get(bridgeId) || [];
  const remaining = queue.filter(job => job.requestId !== requestId);
  if (remaining.length) browserBridgeQueues.set(bridgeId, remaining);
  else browserBridgeQueues.delete(bridgeId);
}

async function requestThroughBrowserBridge(ownerKey, apiPath, { method = 'GET', body } = {}) {
  const bridgeId = browserBridgeByOwner.get(ownerKey);
  const registration = bridgeId ? browserBridges.get(bridgeId) : null;
  if (!registration || Date.now() - registration.lastSeenAt >= BROWSER_BRIDGE_ONLINE_WINDOW_MS) {
    throw ciderBridgeError(
      'CIDER_BRIDGE_OFFLINE',
      'The BitCider browser bridge is offline. Keep the BitCider website open in a browser tab on the same computer where Cider is running.'
    );
  }

  const configuredTimeout = Number(process.env.BITCIDER_CIDER_REQUEST_TIMEOUT_MS || 20000);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(3000, Math.min(Math.floor(configuredTimeout), 30000))
    : 20000;
  const pendingForBridge = [...browserBridgeJobs.values()].filter(job => job.bridgeId === bridgeId).length;
  if (pendingForBridge >= 12) {
    throw ciderBridgeError('CIDER_BRIDGE_BUSY', 'The BitCider browser bridge has too many pending requests. Wait a moment and retry.', 429);
  }

  const requestId = crypto.randomBytes(18).toString('base64url');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browserBridgeJobs.delete(requestId);
      removeQueuedBrowserBridgeJob(bridgeId, requestId);
      reject(ciderBridgeError(
        'CIDER_BRIDGE_TIMEOUT',
        'The BitCider browser bridge did not complete the local Cider request within ' + Math.round(timeoutMs / 1000) + ' seconds.',
        504
      ));
    }, timeoutMs);
    browserBridgeJobs.set(requestId, { ownerKey, bridgeId, resolve, reject, timer });
    enqueueBrowserBridgeJob(bridgeId, {
      requestId,
      path: apiPath,
      method,
      ...(body === undefined ? {} : { body })
    });
  });
}

async function ciderRequest(apiPath, { method = 'GET', body, token, bridgeOwnerKey } = {}) {
  if (!token) {
    const error = new Error('This BitCider user has not linked a Cider account.');
    error.status = 401;
    throw error;
  }

  let status;
  let payload;
  if (bridgeOwnerKey) {
    const result = await requestThroughBrowserBridge(bridgeOwnerKey, apiPath, { method, body });
    status = result.status;
    payload = result.body;
  } else {
    throw ciderBridgeError(
      'CIDER_BRIDGE_OFFLINE',
      'No in-browser Cider bridge is registered for this addon. Keep BitCider open in a browser tab on the computer where Cider is running.'
    );
  }

  if (status < 200 || status >= 300) {
    const message = payload?.error?.message || payload?.message || payload?.error || ('Cider returned HTTP ' + status);
    const error = new Error(String(message));
    error.status = status;
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

async function searchCiderSongs(term, token, { quality = 'high', preferAtmos = false, bridgeOwnerKey = null } = {}) {
  // Search Apple's full catalog through Cider's signed AMAPI proxy rather than
  // scanning only the user's saved library. Cider supplies the user's
  // storefront and signs the upstream request; no MusicKit credentials leave Cider.
  const params = new URLSearchParams({
    term: String(term || '').trim().slice(0, 160),
    types: 'songs',
    limit: '25',
    offset: '0'
  });
  const result = await ciderRequest(
    '/api/v2/amapi/search?' + params.toString(),
    { token, bridgeOwnerKey }
  );
  const rows = songRows(result);
  const matches = [];
  const seen = new Set();
  for (const row of rows) {
    const attributes = row?.attributes || row || {};
    const catalogId = attributes?.playParams?.id || row?.id || attributes?.id || attributes?.catalogId;
    if (!catalogId || seen.has(String(catalogId))) continue;
    seen.add(String(catalogId));
    matches.push(...normalizeSong(row, { quality, preferAtmos }));
    if (matches.length >= 25) break;
  }
  return matches.slice(0, 25);
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

async function resolveCiderStream(addonTrackId, token, requestedQuality = 'high', bridgeOwnerKey = null) {
  const parsedTrack = parseAddonTrackId(addonTrackId);
  const trackId = parsedTrack.trackId;
  const quality = parsedTrack.atmos ? 'atmos' : normalizeQuality(requestedQuality);
  // Cider resolves the selected catalog item using the linked account.
  // Its legacy queue response includes the playable assetURL used by Cider.
  await ciderRequest('/api/v2/playback/play-item', {
    method: 'POST',
    body: { id: trackId, type: 'songs' },
    token,
    bridgeOwnerKey
  });

  let queuePayload;
  let queueRows = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    queuePayload = await ciderRequest('/api/v2/queue', { token, bridgeOwnerKey });
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
          await ciderRequest('/api/v2/playback/pause', { method: 'POST', token, bridgeOwnerKey });
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
  const accountMatch = Object.entries(store.accounts || {}).find(([, entry]) =>
    entry?.addonKey === req.params.addonKey && entry?.ciderToken
  );
  const sessionMatch = accountMatch ? null : Object.entries(store.sessions || {}).find(([, entry]) =>
    entry?.addonKey === req.params.addonKey && entry?.ciderToken
  );
  const user = accountMatch?.[1] || sessionMatch?.[1] || null;
  const accountId = accountMatch?.[0] || null;
  const ownerSessionId = sessionMatch?.[0] || null;
  const bridgeOwnerKey = accountMatch
    ? browserBridgeOwnerKey(accountId, '')
    : ownerSessionId ? browserBridgeOwnerKey(null, ownerSessionId) : null;
  const token = tokenForUser(user);
  if (!user || !token || !bridgeOwnerKey) {
    return res.status(404).json({ error: 'ADDON_NOT_FOUND', message: 'This personal BitCider source is not available.' });
  }
  res.set('Cache-Control', 'private, no-store');
  req.bitciderUser = { ...user, token, accountId, bridgeOwnerKey };
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

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'BitCider',
  apiVersion: API_VERSION,
  browserCiderBridgeSupported: true
}));

app.use('/api/account', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/status', localOnly, async (req, res) => {
  let session = getUserSession(req, res);
  if (session.authenticated) {
    await updateStore(store => {
      const entry = store.authSessions[hashSessionId(session.sessionId)];
      if (entry?.accountId === session.accountId) {
        entry.lastSeenAt = new Date().toISOString();
      }
      return { ok: true };
    });
    session = getUserSession(req, res);
  }
  const { sessionId, user, accountId, authenticated, store } = session;
  const token = tokenForUser(user);
  const base = addonBaseUrl();
  const addonUrl = token && user?.addonKey ? base + '/' + user.addonKey + '/manifest.json' : null;
  const ownerKey = browserBridgeOwnerKey(accountId, sessionId);
  const ciderRelay = browserBridgeStatus(ownerKey, Boolean(token && user?.addonKey), sessionId);
  const devices = authenticated ? activeAccountDevices(store, accountId, sessionId) : [];
  const passkeys = authenticated ? publicPasskeys(user) : [];
  res.set('Cache-Control', 'no-store');
  res.json({
    apiVersion: API_VERSION,
    connected: Boolean(token && user?.addonKey),
    addonUrl,
    ciderConnectionUpdatedAt: user?.connectedAt || null,
    ciderBridgeConfigured: ciderRelay.online,
    ciderBridgeConfigurationError: null,
    ciderRelay,
    publicUrlConfigured: Boolean(PUBLIC_URL),
    sessionReady: Boolean(sessionId),
    pendingAccountSetup: Boolean(token && !authenticated),
    csrfToken: csrfTokenForSession(sessionId),
    tokenEncryptionConfigured: Boolean(dedicatedTokenEncryptionKey()),
    deviceLimit: MAX_ACCOUNT_DEVICES,
    passkeyLimit: MAX_PASSKEYS_PER_ACCOUNT,
    deviceCount: devices.length,
    passkeyCount: passkeys.length,
    devices,
    passkeys,
    account: authenticated ? {
      authenticated: true,
      createdAt: user.createdAt
    } : { authenticated: false },
    error: null
  });
});

app.post('/api/bridge/register', localOnly, requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const { sessionId, user, accountId } = getUserSession(req, res);
  const token = tokenForUser(user);
  if (!token || !user?.addonKey) {
    return res.status(409).json({
      error: 'CIDER_CONNECTION_REQUIRED',
      message: 'Link Cider in this BitCider tab before starting the browser bridge.'
    });
  }

  const ownerKey = browserBridgeOwnerKey(accountId, sessionId);
  const sessionHash = hashSessionId(sessionId);
  for (const current of [...browserBridges.values()]) {
    if (current.sessionHash === sessionHash) {
      invalidateBrowserBridge(current.ownerKey, 'A newer BitCider browser bridge registration replaced this one.');
    }
  }
  invalidateBrowserBridge(ownerKey, 'A newer BitCider browser tab took over the local Cider bridge.');
  const bridgeId = crypto.randomBytes(18).toString('base64url');
  const bridgeSecret = crypto.randomBytes(32).toString('base64url');
  const registration = {
    bridgeId,
    ownerKey,
    accountId: accountId || null,
    sessionId,
    sessionHash,
    secretHash: hashBrowserBridgeSecret(bridgeSecret),
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  };
  browserBridges.set(bridgeId, registration);
  browserBridgeByOwner.set(ownerKey, bridgeId);

  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return res.json({ ok: true, bridgeId, bridgeSecret, ciderToken: token });
});

app.post('/api/bridge/poll', async (req, res) => {
  const registration = browserBridgeFromRequest(req);
  if (!registration) {
    return res.status(401).json({ error: 'BROWSER_BRIDGE_UNAUTHORIZED', message: 'This browser bridge has expired. Refresh BitCider to reconnect.' });
  }
  registration.lastSeenAt = Date.now();
  const requestedWait = Number(req.body?.waitMs || 5000);
  const waitMs = Number.isFinite(requestedWait)
    ? Math.max(500, Math.min(Math.floor(requestedWait), 5000))
    : 5000;
  const job = await takeBrowserBridgeJob(registration.bridgeId, waitMs);
  const current = browserBridges.get(registration.bridgeId);
  if (!current || browserBridgeByOwner.get(registration.ownerKey) !== registration.bridgeId) {
    // A replacement is a normal tab handoff (for example, after a page
    // refresh). Return it as a control message rather than an HTTP error so
    // DevTools does not report an expected handoff as a failed request.
    res.set('Cache-Control', 'no-store');
    return res.json({
      job: null,
      replaced: true,
      error: 'BROWSER_BRIDGE_REPLACED',
      message: 'Another BitCider tab has taken over the browser bridge. Use the most recently opened BitCider tab.'
    });
  }
  current.lastSeenAt = Date.now();
  res.set('Cache-Control', 'no-store');
  return res.json({ job });
});

app.post('/api/bridge/result', async (req, res) => {
  const registration = browserBridgeFromRequest(req);
  if (!registration) {
    return res.status(401).json({ error: 'BROWSER_BRIDGE_UNAUTHORIZED', message: 'This browser bridge has expired. Refresh BitCider to reconnect.' });
  }
  const requestId = String(req.body?.requestId || '');
  const job = browserBridgeJobs.get(requestId);
  if (!job || job.bridgeId !== registration.bridgeId) {
    return res.status(404).json({ error: 'BROWSER_BRIDGE_JOB_NOT_FOUND' });
  }
  const status = Number(req.body?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return res.status(400).json({ error: 'INVALID_BROWSER_BRIDGE_RESPONSE' });
  }
  const body = req.body?.body && typeof req.body.body === 'object' ? req.body.body : {};
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 220 * 1024) {
    return res.status(413).json({ error: 'BROWSER_BRIDGE_RESPONSE_TOO_LARGE' });
  }
  clearTimeout(job.timer);
  browserBridgeJobs.delete(requestId);
  registration.lastSeenAt = Date.now();
  job.resolve({ status, body });
  return res.json({ ok: true });
});

app.post('/api/bridge/stop', async (req, res) => {
  const registration = browserBridgeFromRequest(req);
  if (!registration) return res.json({ ok: true });
  invalidateBrowserBridge(registration.ownerKey, 'The BitCider browser tab stopped relaying Cider requests.');
  return res.json({ ok: true });
});

app.post('/api/account/register', localOnly, authRateLimit(4), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const password = req.body?.password;
  if (!validatePassword(password)) return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Enter a password.' });
  let passwordRecord;
  try { passwordRecord = await createPasswordRecord(password); }
  catch { return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Enter a password.' }); }
  const recovery = createRecoveryCodes();
  const accountKey = createAccountKey();
  const sessionId = req.bitciderSessionId;

  try {
    const result = await updateStore(store => {
      const sessionHash = hashSessionId(sessionId);
      const activeSession = store.authSessions[sessionHash];
      if (activeSession && Date.parse(activeSession.expiresAt) > Date.now()) {
        return { status: 409, error: 'ALREADY_SIGNED_IN', message: 'This device is already signed in.', write: false };
      }
      const connection = accountConnection(store.sessions[sessionId]);
      if (!connection) return { status: 409, error: 'CIDER_CONNECTION_REQUIRED', message: 'Approve the Cider connection before creating your BitCider account.', write: false };

      const accountId = crypto.randomBytes(24).toString('base64url');
      store.accounts[accountId] = {
        accountKeyHash: hashAccountKey(accountKey),
        password: passwordRecord,
        recoveryCodeHashes: recovery.hashes,
        webAuthnUserId: crypto.randomBytes(32).toString('base64url'),
        passkeys: [],
        createdAt: new Date().toISOString(),
        ...connection
      };
      delete store.sessions[sessionId];
      delete store.authSessions[sessionHash];
      createAuthenticatedSession(store, accountId, res, req);
      return { ok: true, accountId };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, accountKey, recoveryCodes: recovery.codes });
  } catch (error) {
    console.error('BitCider account registration failed:', error.message);
    return res.status(500).json({ error: 'ACCOUNT_CREATE_FAILED', message: 'Could not create your account. Try again.' });
  }
});

app.post('/api/account/login', localOnly, authRateLimit(8), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const password = req.body?.password;
  const suppliedAccountKey = typeof req.body?.accountKey === 'string' ? req.body.accountKey.trim() : '';
  const sessionId = req.bitciderSessionId;
  const sessionHash = hashSessionId(sessionId);
  const snapshot = readStore();
  const keyMatch = suppliedAccountKey ? findAccountByAccountKey(snapshot, suppliedAccountKey) : null;
  const pendingAuth = suppliedAccountKey ? null : pendingAccountAuthFor(snapshot, sessionId);
  const accountId = keyMatch?.accountId || pendingAuth?.accountId || null;
  const accountSnapshot = accountId ? snapshot.accounts[accountId] : null;
  const valid = await verifyPassword(password, accountSnapshot?.password || DUMMY_PASSWORD_RECORD);
  if (!accountSnapshot || !valid || !validatePassword(password)) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'The Account Key or password is incorrect.' });
  }
  try {
    const result = await updateStore(store => {
      const currentMatch = suppliedAccountKey
        ? findAccountByAccountKey(store, suppliedAccountKey)
        : pendingAccountAuthFor(store, sessionId);
      const currentAccountId = currentMatch?.accountId || null;
      const account = currentAccountId ? store.accounts[currentAccountId] : null;
      if (currentAccountId !== accountId || !account || account.password?.hash !== accountSnapshot.password.hash) {
        return { status: 401, error: 'INVALID_CREDENTIALS', message: 'The Account Key or password is incorrect.', write: false };
      }
      const pendingConnection = accountConnection(store.sessions[sessionId]);
      const savedConnection = accountConnection(account);
      if (pendingConnection && !savedConnection) Object.assign(account, pendingConnection);
      delete store.sessions[sessionId];
      delete store.authSessions[sessionHash];
      let generatedAccountKey = null;
      if (!account.accountKeyHash) {
        generatedAccountKey = createAccountKey();
        account.accountKeyHash = hashAccountKey(generatedAccountKey);
      }
      const sessionInfo = createAuthenticatedSession(store, accountId, res, req);
      return { ok: true, accountKey: generatedAccountKey, evictedDevice: sessionInfo.evictedDevice };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      ...(result.accountKey ? { accountKey: result.accountKey } : {}),
      evictedDevice: result.evictedDevice || null
    });
  } catch (error) {
    console.error('BitCider Account Key sign-in failed:', error.message);
    return res.status(500).json({ error: 'SIGN_IN_FAILED', message: 'Could not sign in. Try again.' });
  }
});

app.post('/api/account/logout', localOnly, requireCsrf, async (req, res) => {
  const sessionId = req.bitciderSessionId;
  const session = getUserSession(req, res);
  if (session.authenticated) {
    const ownerKey = browserBridgeOwnerKey(session.accountId, sessionId);
    const bridgeId = browserBridgeByOwner.get(ownerKey);
    const registration = bridgeId ? browserBridges.get(bridgeId) : null;
    if (registration?.sessionHash === hashSessionId(sessionId)) {
      invalidateBrowserBridge(ownerKey, 'This BitCider browser session was signed out.');
    }
  }
  await updateStore(store => {
    delete store.authSessions[hashSessionId(sessionId)];
    return { ok: true };
  });
  clearSessionCookie(res);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.post('/api/account/recover', localOnly, authRateLimit(5), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const newPassword = req.body?.newPassword;
  const recoveryCode = req.body?.recoveryCode;
  if (!validatePassword(newPassword)) {
    return res.status(400).json({ error: 'INVALID_RECOVERY', message: 'Enter a new password.' });
  }
  const snapshot = readStore();
  let matchedAccountId = null;
  let matchedAccount = null;
  for (const [accountId, account] of Object.entries(snapshot.accounts || {})) {
    if (consumeRecoveryCode(recoveryCode, account.recoveryCodeHashes || []).valid) {
      matchedAccountId = accountId;
      matchedAccount = account;
    }
  }
  if (!matchedAccountId || !matchedAccount) {
    return res.status(400).json({ error: 'INVALID_RECOVERY', message: 'The recovery code could not be verified.' });
  }

  try {
    const passwordRecord = await createPasswordRecord(newPassword);
    const recovery = createRecoveryCodes();
    const accountKey = createAccountKey();
    const result = await updateStore(store => {
      const account = store.accounts[matchedAccountId];
      if (!account || JSON.stringify(account.recoveryCodeHashes || []) !== JSON.stringify(matchedAccount.recoveryCodeHashes || [])) {
        return { status: 400, error: 'INVALID_RECOVERY', message: 'The recovery code could not be verified.', write: false };
      }
      const consumed = consumeRecoveryCode(recoveryCode, account.recoveryCodeHashes || []);
      if (!consumed.valid) return { status: 400, error: 'INVALID_RECOVERY', message: 'The recovery code could not be verified.', write: false };

      account.password = passwordRecord;
      account.accountKeyHash = hashAccountKey(accountKey);
      account.recoveryCodeHashes = recovery.hashes;
      for (const [activeSessionHash, activeSession] of Object.entries(store.authSessions)) {
        if (activeSession?.accountId === matchedAccountId) delete store.authSessions[activeSessionHash];
      }
      for (const [otherSessionId, pending] of Object.entries(store.sessions)) {
        if (pending?.pendingAccountId === matchedAccountId) delete store.sessions[otherSessionId];
      }
      const sessionId = req.bitciderSessionId;
      delete store.sessions[sessionId];
      delete store.authSessions[hashSessionId(sessionId)];
      const sessionInfo = createAuthenticatedSession(store, matchedAccountId, res, req);
      return { ok: true, accountKey, evictedDevice: sessionInfo.evictedDevice };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, accountKey: result.accountKey, recoveryCodes: recovery.codes, evictedDevice: result.evictedDevice || null });
  } catch (error) {
    console.error('BitCider password recovery failed:', error.message);
    return res.status(500).json({ error: 'RECOVERY_FAILED', message: 'Could not recover this account. Try again.' });
  }
});

app.post('/api/account/passkeys/register/options', localOnly, authRateLimit(5), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const { sessionId, user, accountId, authenticated } = getUserSession(req, res);
  if (!authenticated || !accountId) {
    return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in before adding a passkey.' });
  }
  if (!await verifyPassword(req.body?.password, user.password)) {
    return res.status(401).json({ error: 'REAUTHENTICATION_REQUIRED', message: 'Enter your current BitCider passphrase to add a passkey.' });
  }

  let context;
  try { context = webAuthnContext(req); }
  catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }

  const currentPasskeys = Array.isArray(user.passkeys) ? user.passkeys : [];
  if (currentPasskeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
    return res.status(409).json({ error: 'PASSKEY_LIMIT_REACHED', message: 'This account already has five passkeys. Remove one before adding another.' });
  }

  const webAuthnUserId = user.webAuthnUserId || crypto.randomBytes(32).toString('base64url');
  try {
    const options = await generateRegistrationOptions({
      rpName: 'BitCider',
      rpID: context.rpID,
      userID: Buffer.from(webAuthnUserId, 'base64url'),
      userName: 'BitCider account',
      userDisplayName: 'BitCider account',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required'
      },
      excludeCredentials: currentPasskeys
        .filter(passkey => passkey.rpID === context.rpID)
        .map(passkey => ({ id: passkey.id, transports: passkey.transports || [] }))
    });

    const saved = await updateStore(store => {
      const account = store.accounts[accountId];
      if (!account) return { status: 401, error: 'SIGN_IN_REQUIRED', message: 'Sign in again before adding a passkey.' };
      account.passkeys ||= [];
      if (account.passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return { status: 409, error: 'PASSKEY_LIMIT_REACHED', message: 'This account already has five passkeys. Remove one before adding another.' };
      }
      account.webAuthnUserId ||= webAuthnUserId;
      store.webauthnChallenges[hashSessionId(sessionId)] = {
        purpose: 'register',
        accountId,
        challenge: options.challenge,
        origin: context.origin,
        rpID: context.rpID,
        expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS
      };
      return { ok: true };
    });
    if (saved.status) return res.status(saved.status).json({ error: saved.error, message: saved.message });
    res.set('Cache-Control', 'no-store');
    return res.json(options);
  } catch (error) {
    console.error('BitCider passkey registration options failed:', error.message);
    return res.status(500).json({ error: 'PASSKEY_SETUP_FAILED', message: 'Could not prepare passkey registration. Try again.' });
  }
});

app.post('/api/account/passkeys/register/verify', localOnly, authRateLimit(5), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const { sessionId, accountId, authenticated } = getUserSession(req, res);
  if (!authenticated || !accountId) {
    return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in before adding a passkey.' });
  }
  const challenge = await consumeWebAuthnChallenge(sessionId, 'register', accountId);
  if (!challenge) {
    return res.status(400).json({ error: 'PASSKEY_CHALLENGE_EXPIRED', message: 'Passkey setup expired. Start again.' });
  }

  let context;
  try { context = webAuthnContext(req); }
  catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }
  if (context.origin !== challenge.origin || context.rpID !== challenge.rpID) {
    return res.status(400).json({ error: 'PASSKEY_ORIGIN_MISMATCH', message: 'Passkey setup must finish on the same BitCider website where it started.' });
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
    if (!verification.verified || !info?.credential) {
      return res.status(400).json({ error: 'PASSKEY_NOT_VERIFIED', message: 'The authenticator did not verify this passkey. Try again.' });
    }

    const credential = info.credential;
    const nameFallback = 'Passkey ' + ((readStore().accounts[accountId]?.passkeys || []).length + 1);
    const name = normalizePasskeyName(req.body?.deviceName, nameFallback);
    const saved = await updateStore(store => {
      const account = store.accounts[accountId];
      if (!account) return { status: 401, error: 'SIGN_IN_REQUIRED', message: 'Sign in again before adding a passkey.' };
      account.passkeys ||= [];
      if (account.passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return { status: 409, error: 'PASSKEY_LIMIT_REACHED', message: 'This account already has five passkeys. Remove one before adding another.' };
      }
      if (Object.values(store.accounts).some(owner => (owner.passkeys || []).some(passkey => passkey.id === credential.id))) {
        return { status: 409, error: 'PASSKEY_ALREADY_REGISTERED', message: 'That passkey is already registered to a BitCider account.' };
      }
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
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, passkeyCount: saved.count });
  } catch (error) {
    console.error('BitCider passkey registration verification failed:', error.message);
    return res.status(400).json({ error: 'PASSKEY_VERIFICATION_FAILED', message: 'BitCider could not verify that passkey. Start again and retry.' });
  }
});

app.post('/api/account/passkeys/auth/options', localOnly, authRateLimit(6), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const { sessionId, authenticated } = getUserSession(req, res);
  if (authenticated) return res.status(409).json({ error: 'ALREADY_SIGNED_IN', message: 'You are already signed in.' });
  let context;
  try { context = webAuthnContext(req); }
  catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }
  try {
    const options = await generateAuthenticationOptions({ rpID: context.rpID, allowCredentials: [], userVerification: 'required' });
    await saveWebAuthnChallenge(sessionId, { purpose: 'authenticate', challenge: options.challenge, origin: context.origin, rpID: context.rpID });
    res.set('Cache-Control', 'no-store');
    return res.json(options);
  } catch (error) {
    console.error('BitCider passkey authentication options failed:', error.message);
    return res.status(500).json({ error: 'PASSKEY_SIGN_IN_FAILED', message: 'Could not start passkey sign-in. Try again.' });
  }
});

app.post('/api/account/passkeys/auth/verify', localOnly, authRateLimit(6), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const { sessionId, authenticated } = getUserSession(req, res);
  if (authenticated) {
    return res.status(409).json({ error: 'ALREADY_SIGNED_IN', message: 'You are already signed in.' });
  }
  const challenge = await consumeWebAuthnChallenge(sessionId, 'authenticate');
  if (!challenge) {
    return res.status(400).json({ error: 'PASSKEY_CHALLENGE_EXPIRED', message: 'Passkey sign-in expired. Start again.' });
  }
  let context;
  try { context = webAuthnContext(req); }
  catch (error) { return res.status(400).json({ error: 'PASSKEY_ORIGIN_INVALID', message: error.message }); }
  if (context.origin !== challenge.origin || context.rpID !== challenge.rpID) {
    return res.status(400).json({ error: 'PASSKEY_ORIGIN_MISMATCH', message: 'Passkey sign-in must finish on the same BitCider website where it started.' });
  }

  const credentialId = typeof req.body?.id === 'string' ? req.body.id : '';
  const userHandle = typeof req.body?.response?.userHandle === 'string' ? req.body.response.userHandle : '';
  const snapshot = readStore();
  let matchedAccountId = null;
  let matchedAccount = null;
  let matchedPasskey = null;
  for (const [candidateAccountId, account] of Object.entries(snapshot.accounts)) {
    const passkey = (account.passkeys || []).find(entry => entry.id === credentialId && entry.rpID === challenge.rpID);
    if (passkey && account.webAuthnUserId && secureStringEqual(userHandle, account.webAuthnUserId)) {
      matchedAccountId = candidateAccountId;
      matchedAccount = account;
      matchedPasskey = passkey;
      break;
    }
  }
  if (!matchedAccountId || !matchedAccount || !matchedPasskey) {
    return res.status(401).json({ error: 'INVALID_PASSKEY', message: 'This passkey could not be verified for the approved Cider connection.' });
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
      return res.status(401).json({ error: 'INVALID_PASSKEY', message: 'This passkey could not be verified for a BitCider account.' });
    }

    const result = await updateStore(store => {
      const account = store.accounts[matchedAccountId];
      if (!account || account.webAuthnUserId !== matchedAccount.webAuthnUserId) {
        return { status: 401, error: 'INVALID_PASSKEY', message: 'This passkey could not be verified for a BitCider account.', write: false };
      }
      const passkey = (account.passkeys || []).find(entry => entry.id === credentialId && entry.rpID === challenge.rpID);
      if (!passkey || Number(passkey.counter || 0) !== Number(matchedPasskey.counter || 0)) {
        return { status: 401, error: 'INVALID_PASSKEY', message: 'This passkey could not be verified for a BitCider account.', write: false };
      }
      const pendingConnection = accountConnection(store.sessions[sessionId]);
      const savedConnection = accountConnection(account);
      if (pendingConnection && !savedConnection) Object.assign(account, pendingConnection);
      passkey.counter = Number(verification.authenticationInfo.newCounter || 0);
      passkey.lastUsedAt = new Date().toISOString();
      delete store.sessions[sessionId];
      delete store.authSessions[hashSessionId(sessionId)];
      let generatedAccountKey = null;
      if (!account.accountKeyHash) {
        generatedAccountKey = createAccountKey();
        account.accountKeyHash = hashAccountKey(generatedAccountKey);
      }
      const sessionInfo = createAuthenticatedSession(store, matchedAccountId, res, req);
      return { ok: true, accountKey: generatedAccountKey, evictedDevice: sessionInfo.evictedDevice };
    });
    if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, ...(result.accountKey ? { accountKey: result.accountKey } : {}), evictedDevice: result.evictedDevice || null });
  } catch (error) {
    console.error('BitCider passkey sign-in verification failed:', error.message);
    return res.status(401).json({ error: 'INVALID_PASSKEY', message: 'This passkey could not be verified for a BitCider account.' });
  }
});

app.post('/api/account/passkeys/remove', localOnly, authRateLimit(5), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const { user, accountId, authenticated } = getUserSession(req, res);
  if (!authenticated || !accountId) {
    return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in before managing passkeys.' });
  }
  if (!await verifyPassword(req.body?.password, user.password)) {
    return res.status(401).json({ error: 'REAUTHENTICATION_REQUIRED', message: 'Enter your current BitCider passphrase to remove a passkey.' });
  }
  const credentialId = typeof req.body?.credentialId === 'string' ? req.body.credentialId : '';
  const result = await updateStore(store => {
    const account = store.accounts[accountId];
    if (!account) return { status: 401, error: 'SIGN_IN_REQUIRED', message: 'Sign in again.' };
    const before = (account.passkeys || []).length;
    account.passkeys = (account.passkeys || []).filter(passkey => passkey.id !== credentialId);
    if (account.passkeys.length === before) {
      return { status: 404, error: 'PASSKEY_NOT_FOUND', message: 'That passkey is no longer registered.' };
    }
    return { ok: true, count: account.passkeys.length };
  });
  if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, passkeyCount: result.count });
});

app.post('/api/account/devices/revoke', localOnly, authRateLimit(5), requireCsrf, requireDedicatedTokenEncryption, async (req, res) => {
  const { user, sessionId, accountId, authenticated } = getUserSession(req, res);
  if (!authenticated || !accountId) {
    return res.status(401).json({ error: 'SIGN_IN_REQUIRED', message: 'Sign in before managing devices.' });
  }
  if (!await verifyPassword(req.body?.password, user.password)) {
    return res.status(401).json({ error: 'REAUTHENTICATION_REQUIRED', message: 'Enter your current BitCider passphrase to revoke a device.' });
  }
  const targetHash = typeof req.body?.sessionIdHash === 'string' ? req.body.sessionIdHash : '';
  if (!/^[a-f0-9]{64}$/.test(targetHash)) {
    return res.status(400).json({ error: 'INVALID_DEVICE', message: 'Select a valid signed-in device.' });
  }
  const result = await updateStore(store => {
    const target = store.authSessions[targetHash];
    if (!target || target.accountId !== accountId) {
      return { status: 404, error: 'DEVICE_NOT_FOUND', message: 'That device is no longer signed in.' };
    }
    delete store.authSessions[targetHash];
    return { ok: true, wasCurrent: targetHash === hashSessionId(sessionId) };
  });
  if (result.status) return res.status(result.status).json({ error: result.error, message: result.message });
  if (result.wasCurrent) clearSessionCookie(res);
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true });
});

app.post('/api/connect', localOnly, requireCsrf, async (req, res) => {
  const { sessionId, user: previous, accountId, authenticated } = getUserSession(req, res);
  if (authenticated && !dedicatedTokenEncryptionKey()) {
    return res.status(503).json({
      error: 'SECURE_STORAGE_NOT_CONFIGURED',
      message: 'Secure cloud accounts are unavailable until BITCIDER_ENCRYPTION_KEY is configured on Deplexo.'
    });
  }
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (token.length < 12 || token.length > 8192 || token.includes(String.fromCharCode(10)) || token.includes(String.fromCharCode(13))) {
    return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Cider returned an invalid app token. Please authorize BitCider again.' });
  }

  // The token is matched only on the trusted backend. Existing records hold
  // AES-GCM ciphertext; decrypt one at a time and compare equal-length byte
  // buffers with timingSafeEqual. No plaintext token is stored or returned.
  function tokensMatch(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const outcome = await updateStore(latestStore => {
    const match = Object.entries(latestStore.accounts || {}).find(([, account]) => {
      if (!account?.ciderToken || !account?.addonKey) return false;
      const savedToken = tokenForUser(account);
      return savedToken && tokensMatch(savedToken, token);
    });

    if (match) {
      const [matchedAccountId, matchedAccount] = match;
      if (authenticated && matchedAccountId !== accountId) {
        return {
          status: 409,
          error: 'DIFFERENT_ACCOUNT_ALREADY_SIGNED_IN',
          message: 'This Cider token belongs to another BitCider account. Sign out of the current account, then connect again.',
          write: false
        };
      }
      const alreadyAuthenticated = authenticated && matchedAccountId === accountId;
      if (!alreadyAuthenticated) {
        latestStore.sessions[sessionId] = {
          pendingAccountId: matchedAccountId,
          pendingAccountExpiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS
        };
      }
      return {
        ok: true,
        accountLinked: true,
        alreadyAuthenticated,
        hasPasskeys: Array.isArray(matchedAccount.passkeys) && matchedAccount.passkeys.length > 0,
        addonKey: matchedAccount.addonKey
      };
    }

    // If the visitor is already signed in, attach a new Cider token to that
    // account. Otherwise stage it on this browser session until account setup.
    const target = authenticated
      ? latestStore.accounts[accountId]
      : (latestStore.sessions[sessionId] = {});
    if (!target) throw new Error('The signed-in account is no longer available.');
    target.addonKey = previous?.addonKey || target.addonKey || crypto.randomBytes(32).toString('base64url');
    if (tokenForUser(target) !== token) {
      invalidateBrowserBridge(
        browserBridgeOwnerKey(accountId, sessionId),
        'The Cider connection changed. Refresh this BitCider tab to reconnect.'
      );
    }
    target.ciderToken = encryptToken(token);
    target.authMethod = 'cider-api-auth-request';
    target.scopes = Array.isArray(req.body?.scopes)
      ? req.body.scopes.filter(scope => ['playback', 'queue', 'library', 'audio'].includes(scope))
      : [];
    target.connectedAt = new Date().toISOString();
    return {
      ok: true,
      accountLinked: false,
      savedToCurrentAccount: authenticated,
      addonKey: target.addonKey
    };
  });

  if (outcome.status) {
    return res.status(outcome.status).json({ error: outcome.error, message: outcome.message });
  }
  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    accountLinked: outcome.accountLinked === true,
    alreadyAuthenticated: outcome.alreadyAuthenticated === true,
    savedToCurrentAccount: outcome.savedToCurrentAccount === true,
    hasPasskeys: outcome.hasPasskeys === true,
    ...(outcome.addonKey ? { addonUrl: addonBaseUrl() + '/' + outcome.addonKey + '/manifest.json' } : {})
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
      invalidateBrowserBridge(browserBridgeOwnerKey(accountId, sessionId), 'Cider was disconnected from this BitCider account.');
    } else {
      invalidateBrowserBridge(browserBridgeOwnerKey(null, sessionId), 'Cider was disconnected from this BitCider session.');
      delete store.sessions[sessionId];
    }
    return { ok: true };
  });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});


const BITMONO_TRACKS_API_BASE = String(process.env.BITMONO_TRACKS_API_BASE || 'https://tracks.monochrome.st').replace(/\/+$/, '');
const BITMONO_QUALITY_OPTIONS = Object.freeze([
  { value: 'auto', label: 'Auto' },
  { value: 'dolby_atmos_hi', label: 'Dolby Atmos Hi' },
  { value: 'dolby_atmos_mid', label: 'Dolby Atmos Mid' },
  { value: 'dolby_atmos_low', label: 'Dolby Atmos Low' },
  { value: 'hi_res_lossless', label: 'Hi-Res Lossless (24 Bit)' },
  { value: 'lossless', label: 'Lossless (16 Bit)' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' }
]);
const BITMONO_SEARCH_CACHE_TTL_MS = 15000;
const BITMONO_UPSTREAM_TIMEOUT_MS = 9000;
const bitMonoSearchCache = new Map();
const bitMonoSearchInFlight = new Map();
const bitMonoTrackMetadata = new Map();

function bitMonoLog(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    component: 'BitMono',
    event,
    ...fields
  };
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  console[method]('[BitMono] ' + JSON.stringify(entry));
}

function bitMonoLogText(value, maxLength = 120) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function bitMonoRememberTrack(id, metadata) {
  bitMonoTrackMetadata.set(id, metadata);
  if (bitMonoTrackMetadata.size > 500) {
    const oldest = bitMonoTrackMetadata.keys().next().value;
    bitMonoTrackMetadata.delete(oldest);
  }
}

function bitMonoRawTrackId(item) {
  const track = item?.track && typeof item.track === 'object' ? item.track : item;
  const value = track?.trackId ?? track?.id ?? track?.track_id ?? '';
  return String(value).trim();
}

function normalizeBitMonoTrack(item, stats = null) {
  if (!item || typeof item !== 'object') {
    if (stats) stats.invalidObjects += 1;
    return null;
  }

  const track = item.track && typeof item.track === 'object' ? item.track : item;
  const rawId = bitMonoRawTrackId(track);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) {
    if (stats) stats.invalidIds += 1;
    return null;
  }

  const rawTitle = track.title ?? track.name ?? track.trackTitle ?? '';
  const title = String(rawTitle).trim();
  if (!title) {
    if (stats) stats.missingTitles += 1;
    return null;
  }

  const artistEntries = Array.isArray(track.artistNames) && track.artistNames.length
    ? track.artistNames
    : Array.isArray(track.artists) && track.artists.length
      ? track.artists
      : [track.artistName ?? track.artist ?? ''];
  const artist = artistEntries
    .map(value => {
      if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
      return String(value?.name || value?.displayName || value?.artistName || '').trim();
    })
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(', ');

  const durationValue = Number(
    track.duration ?? track.durationMs ?? track.durationInMillis ?? track.duration_in_ms ?? 0
  );
  const duration = Number.isFinite(durationValue) && durationValue > 0
    ? (durationValue > 1000
      ? Math.round(durationValue / 10) / 100
      : Math.round(durationValue * 100) / 100)
    : 0;

  const album = String(
    track.albumTitle
      || track.releaseTitle
      || track.album?.title
      || track.release?.title
      || track.albumName
      || ''
  ).trim();
  const artworkURL = track.artwork
    || track.cover
    || track.album?.cover
    || track.album?.artwork
    || track.release?.artwork
    || track.image
    || null;
  const isrc = track.isrc || track.recordingId || null;
  const mediaTags = Array.isArray(track.mediaMetadata?.tags) ? track.mediaMetadata.tags : [];
  const audioQuality = mediaTags.includes('HIRES_LOSSLESS') ? 'HI_RES_LOSSLESS' : 'LOSSLESS';

  bitMonoRememberTrack(rawId, {
    title,
    artist,
    album,
    artworkURL,
    isrc,
    duration
  });

  if (stats) stats.normalized += 1;
  return {
    id: 'mono_' + rawId,
    title,
    artist,
    album,
    duration,
    artworkURL,
    format: 'flac',
    audioQuality,
    audioMode: 'STEREO',
    audioModes: ['STEREO'],
    isrc
  };
}

function bitMonoPayloadContainers(payload) {
  const containers = [];
  const seen = new Set();
  const add = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    containers.push(value);
  };
  add(payload);
  add(payload?.data);
  add(payload?.result);
  add(payload?.results);
  add(payload?.data?.data);
  add(payload?.data?.results);
  add(payload?.response);
  return containers;
}

function extractBitMonoTrackCandidates(payload) {
  const candidates = [];
  const seen = new Set();
  const addArray = (items, source) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item.track && typeof item.track === 'object' ? item.track : item;
      const key = bitMonoRawTrackId(candidate) || (candidate.title ? 'title:' + candidate.title + ':' + (candidate.artistName || '') : '');
      const stableKey = key || item;
      if (seen.has(stableKey)) continue;
      seen.add(stableKey);
      candidates.push({ item: candidate, source });
    }
  };

  for (const container of bitMonoPayloadContainers(payload)) {
    if (Array.isArray(container)) {
      addArray(container, 'array');
      continue;
    }
    addArray(container.tracks, 'tracks');
    addArray(container.items, 'items');
    addArray(container.songs, 'songs');

    if (Array.isArray(container.topResults)) {
      addArray(container.topResults.filter(item => (
        item?.entityType === 'track'
        || item?.type === 'track'
        || item?.trackId != null
        || item?.track?.trackId != null
      )), 'topResults');
    }
  }

  return candidates;
}

function bitMonoPayloadSummary(payload) {
  const containers = bitMonoPayloadContainers(payload);
  const arrays = [];
  for (const container of containers) {
    if (Array.isArray(container)) {
      arrays.push({ key: 'array', count: container.length });
      continue;
    }
    for (const key of ['tracks', 'items', 'songs', 'topResults']) {
      if (Array.isArray(container[key])) arrays.push({ key, count: container[key].length });
    }
  }
  return {
    payloadKeys: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload).slice(0, 24)
      : [Array.isArray(payload) ? 'array' : typeof payload],
    resultArrays: arrays
  };
}

async function fetchBitMonoSearchEndpoint(endpoint, query, requestId, requestContext) {
  const url = new URL(endpoint, BITMONO_TRACKS_API_BASE);
  url.searchParams.set('q', query);
  if (endpoint === '/search/tracks') url.searchParams.set('limit', '40');

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    bitMonoLog('info', 'upstream.request', {
      requestId,
      endpoint,
      attempt,
      query: bitMonoLogText(query),
      queryLength: query.length,
      bitChordTitle: bitMonoLogText(requestContext.title, 140),
      bitChordArtist: bitMonoLogText(requestContext.artist, 140)
    });

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Origin: 'https://monochrome.st',
          Referer: 'https://monochrome.st/',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(BITMONO_UPSTREAM_TIMEOUT_MS)
      });

      const rawBody = await response.text();
      const durationMs = Date.now() - startedAt;
      if (!response.ok) {
        const error = new Error('Monochrome ' + endpoint + ' returned HTTP ' + response.status + '.');
        error.status = response.status;
        bitMonoLog(response.status >= 500 || response.status === 429 ? 'warn' : 'error', 'upstream.http_error', {
          requestId,
          endpoint,
          attempt,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          durationMs,
        });
        lastError = error;
        if ((response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 300 * attempt));
          continue;
        }
        throw error;
      }

      let payload;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        const error = new Error('Monochrome ' + endpoint + ' returned invalid JSON.');
        bitMonoLog('error', 'upstream.invalid_json', {
          requestId,
          endpoint,
          attempt,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          bodyLength: rawBody.length,
          durationMs
        });
        throw error;
      }

      const summary = bitMonoPayloadSummary(payload);
      const candidates = extractBitMonoTrackCandidates(payload);
      bitMonoLog('info', 'upstream.response', {
        requestId,
        endpoint,
        attempt,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        durationMs,
        bodyLength: rawBody.length,
        payloadKeys: summary.payloadKeys,
        resultArrays: summary.resultArrays,
        candidateCount: candidates.length
      });

      return { endpoint, payload, candidates, status: response.status, durationMs };
    } catch (error) {
      lastError = error;
      const durationMs = Date.now() - startedAt;
      const retryable = !Number.isInteger(error?.status)
        || error.status === 408
        || error.status === 425
        || error.status === 429
        || error.status >= 500;
      if (retryable && attempt < 2) {
        bitMonoLog('warn', 'upstream.retry', {
          requestId,
          endpoint,
          attempt,
          durationMs,
          error: bitMonoLogText(error?.message || error, 180)
        });
        await new Promise(resolve => setTimeout(resolve, 300 * attempt));
        continue;
      }
      bitMonoLog('error', 'upstream.failed', {
        requestId,
        endpoint,
        attempt,
        durationMs,
        status: Number.isInteger(error?.status) ? error.status : null,
        error: bitMonoLogText(error?.message || error, 180)
      });
    }
  }
  throw lastError || new Error('Monochrome ' + endpoint + ' search failed.');
}

async function fetchBitMonoTracksSearch(query, requestId, requestContext = {}) {
  // The modern Monochrome client exposes both the focused track route and a
  // unified search route. Unified search contains topResults in some responses,
  // which can hold the exact song even when the focused list ranks it lower.
  const endpoints = ['/search', '/search/tracks'];
  const responses = await Promise.allSettled(
    endpoints.map(endpoint => fetchBitMonoSearchEndpoint(endpoint, query, requestId, requestContext))
  );
  const successes = responses
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);
  const failures = responses
    .filter(result => result.status === 'rejected')
    .map(result => bitMonoLogText(result.reason?.message || result.reason, 180));

  if (!successes.length) {
    throw new Error('All Monochrome search endpoints failed: ' + failures.join(' | '));
  }

  const tracksById = new Map();
  const stats = {
    rawCandidates: 0,
    normalized: 0,
    invalidObjects: 0,
    invalidIds: 0,
    missingTitles: 0,
    duplicates: 0
  };
  for (const response of successes) {
    stats.rawCandidates += response.candidates.length;
    for (const candidate of response.candidates) {
      const track = normalizeBitMonoTrack(candidate.item, stats);
      if (!track) continue;
      if (tracksById.has(track.id)) {
        stats.duplicates += 1;
        continue;
      }
      tracksById.set(track.id, track);
    }
  }

  const tracks = [...tracksById.values()].slice(0, 60);
  bitMonoLog(tracks.length ? 'info' : 'warn', tracks.length ? 'search.merged' : 'search.upstream_empty', {
    requestId,
    query: bitMonoLogText(query),
    endpointsAttempted: endpoints,
    endpointsSucceeded: successes.map(response => response.endpoint),
    endpointFailures: failures,
    rawCandidates: stats.rawCandidates,
    normalizedTracks: stats.normalized,
    invalidObjects: stats.invalidObjects,
    invalidIds: stats.invalidIds,
    missingTitles: stats.missingTitles,
    duplicates: stats.duplicates,
    resultCount: tracks.length,
    sample: tracks.slice(0, 5).map(track => ({
      id: track.id,
      title: bitMonoLogText(track.title, 80),
      artist: bitMonoLogText(track.artist, 80)
    }))
  });

  return tracks;
}

// BitMono is an intentionally free, public BitChord source. It does not
// depend on a Cider token, user account, or per-user addon key.
app.get('/bitmono/manifest.json', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    id: 'com.bitcider.bitmono',
    name: 'BitMono',
    version: '1.0.0',
    description: 'Free Monochrome music source for BitChord. The current upstream stream is FLAC/Lossless stereo; audio metadata reflects the rendition actually supplied.',
    icon: 'https://monochrome.st/favicon.ico',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music',
    settings: [{
      key: 'quality',
      type: 'select',
      label: 'Audio quality',
      default: 'auto',
      options: BITMONO_QUALITY_OPTIONS
    }]
  });
});

app.get('/bitmono/search', async (req, res) => {
  const requestId = crypto.randomUUID();
  const queryFromClient = String(req.query.q || '').trim();
  const requestedTitle = String(req.query.title || '').trim();
  const requestedArtist = String(req.query.artist || '').trim();
  const query = (queryFromClient || [requestedTitle, requestedArtist].filter(Boolean).join(' '))
    .replace(/\s+/g, ' ')
    .trim();

  res.set('X-BitMono-Request-Id', requestId);
  bitMonoLog('info', 'search.received', {
    requestId,
    query: bitMonoLogText(query),
    queryLength: query.length,
    bitChordTitle: bitMonoLogText(requestedTitle, 140),
    bitChordArtist: bitMonoLogText(requestedArtist, 140),
    quality: bitMonoLogText(req.query.quality || 'auto', 48),
    atmos: bitMonoLogText(req.query.atmos || '', 24),
    userAgent: bitMonoLogText(req.get('user-agent') || '', 110)
  });

  if (!query) {
    bitMonoLog('warn', 'search.empty_query', { requestId });
    res.set('Cache-Control', 'no-store');
    return res.json({ tracks: [] });
  }
  if (query.length > 320) {
    bitMonoLog('warn', 'search.query_too_long', { requestId, queryLength: query.length });
    return res.status(400).json({
      error: 'Search query is too long.',
      requestId
    });
  }

  const cacheKey = query.normalize('NFKC').toLowerCase();
  const cached = bitMonoSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    bitMonoLog('info', 'search.cache_hit', {
      requestId,
      query: bitMonoLogText(query),
      resultCount: cached.tracks.length,
      ageMs: Date.now() - cached.createdAt
    });
    res.set('Cache-Control', 'public, max-age=10');
    res.set('X-BitMono-Cache', 'HIT');
    return res.json({ tracks: cached.tracks });
  }
  if (cached) bitMonoSearchCache.delete(cacheKey);
  res.set('X-BitMono-Cache', 'MISS');

  try {
    let pending = bitMonoSearchInFlight.get(cacheKey);
    if (pending) {
      bitMonoLog('info', 'search.inflight_join', { requestId, query: bitMonoLogText(query) });
    } else {
      pending = fetchBitMonoTracksSearch(query, requestId, {
        title: requestedTitle,
        artist: requestedArtist
      });
      bitMonoSearchInFlight.set(cacheKey, pending);
    }

    let tracks;
    try {
      tracks = await pending;
    } finally {
      if (bitMonoSearchInFlight.get(cacheKey) === pending) bitMonoSearchInFlight.delete(cacheKey);
    }

    if (tracks.length > 0) {
      bitMonoSearchCache.set(cacheKey, {
        tracks,
        createdAt: Date.now(),
        expiresAt: Date.now() + BITMONO_SEARCH_CACHE_TTL_MS
      });
      if (bitMonoSearchCache.size > 300) {
        const oldest = bitMonoSearchCache.keys().next().value;
        bitMonoSearchCache.delete(oldest);
      }
      res.set('Cache-Control', 'public, max-age=10');
    } else {
      // Do not cache empty searches: upstream can briefly return an empty list
      // during an outage or index refresh, and a cached miss hides recovery.
      res.set('Cache-Control', 'no-store');
    }

    bitMonoLog(tracks.length ? 'info' : 'warn', tracks.length ? 'search.complete' : 'search.no_matches', {
      requestId,
      query: bitMonoLogText(query),
      resultCount: tracks.length,
      cached: tracks.length > 0
    });
    return res.json({ tracks });
  } catch (error) {
    bitMonoLog('error', 'search.failed', {
      requestId,
      query: bitMonoLogText(query),
      error: bitMonoLogText(error?.message || error, 260)
    });
    return res.status(502).json({
      error: 'BITMONO_SEARCH_FAILED',
      message: 'The Monochrome track service could not complete this search. Please try again.',
      requestId
    });
  }
});

app.get('/bitmono/stream/:trackId', (req, res) => {
  const suppliedId = String(req.params.trackId || '').trim();
  const trackId = suppliedId.startsWith('mono_') ? suppliedId.slice(5) : suppliedId;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) {
    return res.status(400).json({ error: 'INVALID_TRACK_ID', message: 'The Monochrome track ID is invalid.' });
  }

  const metadata = bitMonoTrackMetadata.get(trackId) || null;
  const requestedQuality = String(req.query.quality || 'auto').trim().toLowerCase();
  const supportedQualityPreferences = ['auto', 'lossless'];
  const qualityFallback = !supportedQualityPreferences.includes(requestedQuality);
  const url = BITMONO_TRACKS_API_BASE + '/track/' + encodeURIComponent(trackId);
  res.set('Cache-Control', 'public, max-age=60');
  // The official Monochrome web client resolves its stream with /track/{id}
  // and identifies it as FLAC/Lossless stereo. Do not fabricate Atmos or
  // 24-bit metadata based only on a user-selected preference.
  return res.json({
    url,
    format: 'flac',
    quality: 'LOSSLESS',
    audioQuality: 'LOSSLESS',
    codec: 'flac',
    mimeType: 'audio/flac',
    manifest: 'none',
    encrypted: false,
    audioMode: 'STEREO',
    audioModes: ['STEREO'],
    requestedQuality,
    qualityFallback,
    ...(metadata?.duration ? { duration: metadata.duration } : {})
  });
});

app.get('/:addonKey/manifest.json', validAddonKey, (req, res) => {
  res.set('Cache-Control', 'private, no-store');
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

const addonFailureLogTimes = new Map();

function logAddonFailure(operation, error) {
  const code = String(error?.ciderCode || 'CIDER_REQUEST_FAILED');
  if (code.startsWith('CIDER_BRIDGE_')) {
    const now = Date.now();
    const previous = addonFailureLogTimes.get(operation + ':' + code) || 0;
    if (now - previous < 60000) return;
    addonFailureLogTimes.set(operation + ':' + code, now);
    if (addonFailureLogTimes.size > 128) {
      for (const [key, time] of addonFailureLogTimes) {
        if (now - time >= 60000) addonFailureLogTimes.delete(key);
      }
    }
    console.warn('BitCider addon ' + operation + ' unavailable (' + code + '):', error.message);
    return;
  }
  console.error('BitCider addon ' + operation + ' failed:', error.message, code);
}

function sendAddonFailure(res, fallbackCode, error) {
  const code = String(error?.ciderCode || fallbackCode);
  if (code.startsWith('CIDER_BRIDGE_')) res.set('Retry-After', '10');
  return res.status(error.status || 502).json({
    error: fallbackCode,
    code,
    message: error.message || 'Cider request failed.'
  });
}

app.get('/:addonKey/search', validAddonKey, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ tracks: [] });
  if (query.length > 160) return res.status(400).json({ error: 'Search query is too long.' });
  try {
    const quality = normalizeQuality(req.query.quality);
    const preferAtmos = String(req.query.atmos || '').toLowerCase() === 'auto';
    const tracks = await searchCiderSongs(query, req.bitciderUser.token, { quality, preferAtmos, bridgeOwnerKey: req.bitciderUser.bridgeOwnerKey });
    res.set('Cache-Control', 'no-store');
    res.json({ tracks });
  } catch (error) {
    logAddonFailure('search', error);
    sendAddonFailure(res, 'CIDER_SEARCH_FAILED', error);
  }
});

app.get('/:addonKey/stream/:trackId', validAddonKey, async (req, res) => {
  const trackId = String(req.params.trackId || '');
  if (!trackId || trackId.length > 180) return res.status(400).json({ error: 'Invalid track id.' });
  try {
    const stream = await resolveCiderStream(trackId, req.bitciderUser.token, req.query.quality, req.bitciderUser.bridgeOwnerKey);
    res.set('Cache-Control', 'no-store');
    res.json(stream);
  } catch (error) {
    logAddonFailure('stream resolution', error);
    sendAddonFailure(res, 'CIDER_STREAM_FAILED', error);
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

const removedLegacyUsernames = migrateLegacyAccountUsernames();
if (removedLegacyUsernames) console.log('Removed legacy BitCider account usernames:', removedLegacyUsernames);
const tokenEncryptionStatus = migrateTokenEncryption();
if (!tokenEncryptionStatus.configured) {
  console.warn('BITCIDER_ENCRYPTION_KEY is not configured. Saved Cider tokens are encrypted with the persistent volume key; configure the Deplexo-only key for stronger separation.');
} else {
  console.log('BitCider token encryption key is configured; migrated legacy tokens:', tokenEncryptionStatus.migrated);
}

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  BitCider service is running');
  console.log('  Local UI:    http://localhost:' + PORT);
  console.log('  LAN address: http://' + localIPv4() + ':' + PORT);
  console.log('  Cider bridge: browser-local (BitCider tab must stay open)');
  console.log('');
  if (!PUBLIC_URL) console.log('  Set BITCIDER_PUBLIC_URL to the public HTTPS origin for off-network BitChord access.');
});

httpServer.keepAliveTimeout = 5000;
httpServer.headersTimeout = 15000;
httpServer.requestTimeout = 30000;

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log('BitCider received ' + signal + '; gracefully closing the HTTP server.');
  const forceClose = setTimeout(() => {
    httpServer.closeAllConnections?.();
  }, 8000);
  forceClose.unref();
  httpServer.close(error => {
    clearTimeout(forceClose);
    if (error) {
      console.error('BitCider shutdown error:', error.message);
      process.exitCode = 1;
    }
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
