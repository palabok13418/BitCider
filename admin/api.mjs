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

const ADMIN_SESSION_COOKIE = 'bitcider_admin_session';
const ADMIN_CHALLENGE_COOKIE = 'bitcider_admin_challenge';
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{40,50}$/;

function emptyState() {
  return { credential: null, bootstrapConsumed: false, challenges: {}, sessions: {} };
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function secureEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function appendCookie(res, name, value, options = {}) {
  const pieces = [
    name + '=' + encodeURIComponent(value),
    'Path=' + (options.path || '/'),
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ];
  if (Number.isFinite(options.maxAge)) pieces.push('Max-Age=' + Math.max(0, Math.floor(options.maxAge)));
  res.append('Set-Cookie', pieces.join('; '));
}

function clearCookie(res, name, routePath = '/') {
  res.append('Set-Cookie', name + '=; Path=' + routePath + '; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Admin state file is malformed.');
    }
    return {
      ...emptyState(),
      ...parsed,
      challenges: parsed.challenges && typeof parsed.challenges === 'object' ? parsed.challenges : {},
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function createStateStore(file) {
  let queue = Promise.resolve();
  return {
    read: () => readState(file),
    update(mutator) {
      const operation = queue.then(async () => {
        const state = readState(file);
        const result = await mutator(state);
        if (result?.write !== false) writeState(file, state);
        return result;
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
}

function createRateLimit(maxAttempts = 8, windowMs = 15 * 60 * 1000) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown') + ':' + req.path;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) bucket = { count: 0, startedAt: now };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 4000) {
      for (const [entryKey, entry] of buckets) {
        if (now - entry.startedAt >= windowMs) buckets.delete(entryKey);
      }
    }
    if (bucket.count > maxAttempts) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000))));
      return res.status(429).json({ error: 'ADMIN_RATE_LIMITED', message: 'Too many admin sign-in attempts. Try again later.' });
    }
    return next();
  };
}

export function createAdminRouter({
  dataFile,
  webAuthnContext,
  controller = {}
} = {}) {
  if (!dataFile) throw new TypeError('Admin dataFile is required.');
  if (typeof webAuthnContext !== 'function') throw new TypeError('Admin WebAuthn context is required.');
  const state = createStateStore(dataFile);
  const router = express.Router();
  const rateBootstrap = createRateLimit(5);
  const rateAuthentication = createRateLimit(8);

  function bootstrapCodeConfigured() {
    return Buffer.byteLength(String(process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE || ''), 'utf8') >= 32;
  }

  function bootstrapCodeMatches(suppliedValue) {
    const expected = String(process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE || '');
    const supplied = typeof suppliedValue === 'string' ? suppliedValue : '';
    if (!bootstrapCodeConfigured() || supplied.length < 1) return false;
    return secureEqual(expected, supplied);
  }

  function challengeSession(req, res) {
    let sessionId = readCookie(req, ADMIN_CHALLENGE_COOKIE);
    if (!ID_PATTERN.test(sessionId)) {
      sessionId = crypto.randomBytes(32).toString('base64url');
      appendCookie(res, ADMIN_CHALLENGE_COOKIE, sessionId, { path: '/api/admin', maxAge: CHALLENGE_TTL_MS / 1000 });
    }
    return sessionId;
  }

  async function saveChallenge(sessionId, record) {
    return state.update(current => {
      const now = Date.now();
      for (const [key, value] of Object.entries(current.challenges)) {
        if (!value || Number(value.expiresAt) <= now) delete current.challenges[key];
      }
      current.challenges[sha256(sessionId)] = { ...record, expiresAt: now + CHALLENGE_TTL_MS };
      return { ok: true };
    });
  }

  async function consumeChallenge(sessionId, purpose) {
    const result = await state.update(current => {
      const key = sha256(sessionId);
      const challenge = current.challenges[key];
      if (!challenge) return { challenge: null, write: false };
      delete current.challenges[key];
      if (challenge.purpose !== purpose || Number(challenge.expiresAt) <= Date.now()) {
        return { challenge: null };
      }
      return { challenge };
    });
    return result.challenge;
  }

  function activeSession(req) {
    const sessionId = readCookie(req, ADMIN_SESSION_COOKIE);
    if (!ID_PATTERN.test(sessionId)) return null;
    const session = state.read().sessions[sha256(sessionId)];
    if (!session || Number(session.expiresAt) <= Date.now()) return null;
    return { sessionId, session };
  }

  function requireAdmin(req, res, next) {
    const active = activeSession(req);
    if (!active) return res.status(401).json({ error: 'ADMIN_PASSKEY_REQUIRED', message: 'Verify the registered admin passkey to continue.' });
    req.adminSession = active.session;
    return next();
  }

  function requireAdminCsrf(req, res, next) {
    if (!secureEqual(req.adminSession?.csrfToken, req.get('x-bitcider-admin-csrf') || '')) {
      return res.status(403).json({ error: 'ADMIN_CSRF_REJECTED', message: 'Refresh the admin console and try again.' });
    }
    return next();
  }

  function createAdminSession(req, res) {
    const previousSessionId = readCookie(req, ADMIN_SESSION_COOKIE);
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    return state.update(current => {
      if (ID_PATTERN.test(previousSessionId)) delete current.sessions[sha256(previousSessionId)];
      for (const [key, value] of Object.entries(current.sessions)) {
        if (!value || Number(value.expiresAt) <= now) delete current.sessions[key];
      }
      current.sessions[sha256(sessionId)] = {
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + ADMIN_SESSION_TTL_MS,
        csrfToken
      };
      appendCookie(res, ADMIN_SESSION_COOKIE, sessionId);
      clearCookie(res, ADMIN_CHALLENGE_COOKIE, '/api/admin');
      return { ok: true, csrfToken };
    });
  }

  router.get('/status', (req, res) => {
    const current = state.read();
    const active = activeSession(req);
    res.set('Cache-Control', 'no-store');
    return res.json({
      initialized: Boolean(current.credential?.id && current.credential?.publicKey),
      authenticated: Boolean(active),
      bootstrapConfigured: bootstrapCodeConfigured(),
      bootstrapAvailable: !current.credential && !current.bootstrapConsumed && bootstrapCodeConfigured(),
      csrfToken: active?.session.csrfToken || null,
      sessionExpiresAt: active ? new Date(active.session.expiresAt).toISOString() : null,
      passkeyLimit: 1,
      passkeyCount: current.credential ? 1 : 0
    });
  });

  router.post('/bootstrap/options', rateBootstrap, async (req, res) => {
    const current = state.read();
    if (current.credential || current.bootstrapConsumed) {
      return res.status(409).json({ error: 'ADMIN_ALREADY_INITIALIZED', message: 'Admin mode has already been initialized. Use its passkey to sign in.' });
    }
    if (!bootstrapCodeConfigured()) {
      return res.status(503).json({
        error: 'ADMIN_BOOTSTRAP_NOT_CONFIGURED',
        message: 'BITCIDER_ADMIN_BOOTSTRAP_CODE is missing or shorter than 32 bytes on the Deplexo backend. Configure it there and redeploy.'
      });
    }
    if (!bootstrapCodeMatches(req.body?.code)) {
      return res.status(401).json({
        error: 'INVALID_BOOTSTRAP_CODE',
        message: 'The bootstrap code does not match the value configured on the Deplexo backend. Paste the exact generated value and try again.'
      });
    }
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'ADMIN_PASSKEY_ORIGIN_INVALID', message: error.message }); }
    const sessionId = challengeSession(req, res);
    const options = await generateRegistrationOptions({
      rpName: 'BitCider Admin',
      rpID: context.rpID,
      userID: crypto.randomBytes(32),
      userName: 'BitCider Owner',
      userDisplayName: 'BitCider Site Administrator',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required'
      },
      timeout: 60000
    });
    await saveChallenge(sessionId, {
      purpose: 'bootstrap',
      challenge: options.challenge,
      origin: context.origin,
      rpID: context.rpID
    });
    return res.json({ optionsJSON: options });
  });

  router.post('/bootstrap/verify', rateBootstrap, async (req, res) => {
    const current = state.read();
    if (current.credential || current.bootstrapConsumed) {
      return res.status(409).json({ error: 'ADMIN_ALREADY_INITIALIZED', message: 'Only the first admin passkey can be enrolled.' });
    }
    const challengeId = readCookie(req, ADMIN_CHALLENGE_COOKIE);
    if (!ID_PATTERN.test(challengeId)) return res.status(400).json({ error: 'ADMIN_CHALLENGE_MISSING' });
    const challenge = await consumeChallenge(challengeId, 'bootstrap');
    if (!challenge) return res.status(400).json({ error: 'ADMIN_CHALLENGE_EXPIRED', message: 'Restart the admin passkey setup.' });
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'ADMIN_PASSKEY_ORIGIN_INVALID', message: error.message }); }
    if (context.origin !== challenge.origin || context.rpID !== challenge.rpID) {
      return res.status(400).json({ error: 'ADMIN_PASSKEY_ORIGIN_MISMATCH', message: 'Finish setup on the same BitCider site.' });
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
        return res.status(400).json({ error: 'ADMIN_PASSKEY_NOT_VERIFIED', message: 'The authenticator did not verify the admin passkey.' });
      }
      const credential = info.credential;
      const saved = await state.update(latest => {
        if (latest.credential || latest.bootstrapConsumed) return { status: 409 };
        latest.credential = {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: Number(credential.counter || 0),
          transports: Array.isArray(credential.transports) ? credential.transports : [],
          rpID: challenge.rpID,
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        };
        latest.bootstrapConsumed = true;
        return { ok: true };
      });
      if (saved.status) return res.status(409).json({ error: 'ADMIN_ALREADY_INITIALIZED' });
      const session = await createAdminSession(req, res);
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({ ok: true, authenticated: true, csrfToken: session.csrfToken });
    } catch (error) {
      console.error('[BitCider Admin] Passkey enrollment failed:', error?.message || error);
      return res.status(400).json({ error: 'ADMIN_PASSKEY_ENROLLMENT_FAILED', message: 'Could not verify the first admin passkey. Start setup again.' });
    }
  });

  router.post('/auth/options', rateAuthentication, async (req, res) => {
    const current = state.read();
    const credential = current.credential;
    if (!credential?.id || !credential?.publicKey) {
      return res.status(409).json({ error: 'ADMIN_NOT_INITIALIZED', message: 'Use the bootstrap code to enroll the first admin passkey.' });
    }
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'ADMIN_PASSKEY_ORIGIN_INVALID', message: error.message }); }
    const sessionId = challengeSession(req, res);
    const options = await generateAuthenticationOptions({
      rpID: context.rpID,
      allowCredentials: [{
        id: credential.id,
        transports: Array.isArray(credential.transports) ? credential.transports : []
      }],
      userVerification: 'required',
      timeout: 60000
    });
    await saveChallenge(sessionId, {
      purpose: 'authentication',
      challenge: options.challenge,
      origin: context.origin,
      rpID: context.rpID
    });
    return res.json({ optionsJSON: options });
  });

  router.post('/auth/verify', rateAuthentication, async (req, res) => {
    const credential = state.read().credential;
    if (!credential?.id || !credential?.publicKey) {
      return res.status(409).json({ error: 'ADMIN_NOT_INITIALIZED' });
    }
    const challengeId = readCookie(req, ADMIN_CHALLENGE_COOKIE);
    if (!ID_PATTERN.test(challengeId)) return res.status(400).json({ error: 'ADMIN_CHALLENGE_MISSING' });
    const challenge = await consumeChallenge(challengeId, 'authentication');
    if (!challenge) return res.status(400).json({ error: 'ADMIN_CHALLENGE_EXPIRED', message: 'Restart admin sign-in.' });
    let context;
    try { context = webAuthnContext(req); }
    catch (error) { return res.status(400).json({ error: 'ADMIN_PASSKEY_ORIGIN_INVALID', message: error.message }); }
    if (context.origin !== challenge.origin || context.rpID !== challenge.rpID) {
      return res.status(400).json({ error: 'ADMIN_PASSKEY_ORIGIN_MISMATCH', message: 'Finish sign-in on the same BitCider site.' });
    }
    try {
      if (String(req.body?.id || '') !== credential.id) {
        return res.status(401).json({ error: 'ADMIN_PASSKEY_MISMATCH', message: 'That is not the registered admin passkey.' });
      }
      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
          counter: Number(credential.counter || 0),
          transports: Array.isArray(credential.transports) ? credential.transports : []
        },
        requireUserVerification: true
      });
      if (!verification.verified || verification.authenticationInfo?.userVerified !== true) {
        return res.status(401).json({ error: 'ADMIN_PASSKEY_NOT_VERIFIED', message: 'Passkey user verification was not completed.' });
      }
      const updated = await state.update(latest => {
        if (latest.credential?.id !== credential.id
          || Number(latest.credential.counter || 0) !== Number(credential.counter || 0)) {
          return { status: 409 };
        }
        latest.credential.counter = Number(verification.authenticationInfo.newCounter || 0);
        latest.credential.lastUsedAt = new Date().toISOString();
        return { ok: true };
      });
      if (updated.status) return res.status(409).json({ error: 'ADMIN_PASSKEY_REPLAY', message: 'The passkey was used in another sign-in. Start again.' });
      const session = await createAdminSession(req, res);
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, authenticated: true, csrfToken: session.csrfToken });
    } catch (error) {
      console.error('[BitCider Admin] Passkey sign-in failed:', error?.message || error);
      return res.status(401).json({ error: 'ADMIN_AUTHENTICATION_FAILED', message: 'Admin passkey verification failed.' });
    }
  });

  router.post('/logout', requireAdmin, requireAdminCsrf, async (req, res) => {
    const raw = readCookie(req, ADMIN_SESSION_COOKIE);
    await state.update(current => {
      delete current.sessions[sha256(raw)];
      return { ok: true };
    });
    clearCookie(res, ADMIN_SESSION_COOKIE);
    return res.json({ ok: true });
  });

  router.get('/overview', requireAdmin, async (_req, res) => {
    try {
      const overview = typeof controller.overview === 'function' ? await controller.overview() : {};
      res.set('Cache-Control', 'no-store');
      return res.json(overview);
    } catch (error) {
      return res.status(500).json({ error: 'ADMIN_OVERVIEW_FAILED', message: error?.message || 'Could not load the admin overview.' });
    }
  });

  router.get('/users', requireAdmin, async (_req, res) => {
    try {
      const users = typeof controller.listUsers === 'function' ? await controller.listUsers() : [];
      res.set('Cache-Control', 'no-store');
      return res.json({ users });
    } catch {
      return res.status(500).json({ error: 'ADMIN_USERS_FAILED', message: 'Could not load the anonymized account list.' });
    }
  });

  router.post('/users/:ref/suspension', requireAdmin, requireAdminCsrf, async (req, res) => {
    const suspended = req.body?.suspended === true;
    if (typeof controller.setUserSuspended !== 'function') return res.status(501).json({ error: 'ADMIN_ACTION_UNAVAILABLE' });
    const result = await controller.setUserSuspended(req.params.ref, suspended);
    if (!result?.ok) return res.status(result?.status || 404).json({ error: result?.error || 'USER_NOT_FOUND' });
    return res.json({ ok: true, suspended });
  });

  router.delete('/users/:ref', requireAdmin, requireAdminCsrf, async (req, res) => {
    if (typeof controller.deleteUser !== 'function') return res.status(501).json({ error: 'ADMIN_ACTION_UNAVAILABLE' });
    const result = await controller.deleteUser(req.params.ref);
    if (!result?.ok) return res.status(result?.status || 404).json({ error: result?.error || 'USER_NOT_FOUND' });
    return res.json({ ok: true });
  });

  router.post('/bots', requireAdmin, requireAdminCsrf, async (req, res) => {
    if (typeof controller.createBotAccount !== 'function') return res.status(501).json({ error: 'BOT_CREATION_UNAVAILABLE' });
    const products = Array.isArray(req.body?.products) ? req.body.products : [];
    const allowed = new Set(['bitcider', 'bitconnection']);
    const selected = [...new Set(products.filter(product => allowed.has(product)))];
    if (!selected.length) return res.status(400).json({ error: 'BOT_PRODUCT_REQUIRED' });
    try {
      const result = await controller.createBotAccount(selected);
      if (!result?.ok) return res.status(result?.status || 500).json({ error: result?.error || 'BOT_CREATE_FAILED' });
      res.set('Cache-Control', 'no-store');
      return res.status(201).json(result);
    } catch (error) {
      console.error('[BitCider Admin] Bot creation failed:', error?.message || error);
      return res.status(500).json({ error: 'BOT_CREATE_FAILED', message: 'Could not create that bot account.' });
    }
  });

  return router;
}
