import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BITCONNECTION_API_VERSION = '2026-11-24-rooms-01';

function readData(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      profiles: value?.profiles && typeof value.profiles === 'object' ? value.profiles : {},
      rooms: value?.rooms && typeof value.rooms === 'object' ? value.rooms : {}
    };
  } catch {
    return { profiles: {}, rooms: {} };
  }
}

function writeData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function cleanUsername(value) {
  if (typeof value !== 'string') return '';
  const username = value.trim().replace(/\s+/gu, ' ');
  if (!username || Array.from(username).length > 24 || /[\u0000-\u001f\u007f]/u.test(username)) return '';
  return username;
}

function cleanImageDataUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/);
  if (!match) return undefined;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length > 0 && bytes.length <= 170 * 1024 ? value : undefined;
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

export function bitConnectionHealthPayload() {
  return {
    ok: true,
    service: 'BitConnection',
    apiVersion: BITCONNECTION_API_VERSION,
    deployment: 'Deplexo',
    stage: 'room-creation',
    capabilities: {
      bitCiderAccountLinking: 'enabled',
      hostProfiles: 'enabled',
      roomCreation: 'enabled',
      realtimeRooms: 'not-yet-enabled',
      privateRoomVerification: 'not-yet-enabled'
    }
  };
}

export function createBitConnectionRouter({
  getUserSession = () => ({ authenticated: false }),
  requireCsrf = (_req, _res, next) => next(),
  csrfTokenForSession = () => '',
  dataFile,
  maxPartySize = 10
} = {}) {
  if (!dataFile) throw new TypeError('BitConnection dataFile is required.');
  const router = express.Router();
  const maximum = Number.isSafeInteger(Number(maxPartySize))
    ? Math.min(100, Math.max(2, Number(maxPartySize)))
    : 10;

  router.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...bitConnectionHealthPayload(), limits: { maxPartySize: maximum } });
  });

  router.get('/account', (req, res) => {
    const session = getUserSession(req, res);
    if (!session?.authenticated || !session.accountId) {
      return res.json({ authenticated: false, provider: null, profile: null, csrfToken: '', maxPartySize: maximum });
    }
    const data = readData(dataFile);
    const profile = data.profiles[session.accountId] || null;
    return res.json({
      authenticated: true,
      provider: 'BitCider',
      csrfToken: csrfTokenForSession(session.sessionId),
      profile: profile ? {
        username: profile.username,
        avatarDataUrl: profile.avatarDataUrl || null,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt
      } : null,
      maxPartySize: maximum
    });
  });

  router.put('/account/profile', requireCsrf, (req, res) => {
    const session = getUserSession(req, res);
    if (!session?.authenticated || !session.accountId) {
      return res.status(401).json({
        error: 'BITCONNECTION_ACCOUNT_REQUIRED',
        message: 'Sign in to a BitCider account before linking it to BitConnection.'
      });
    }
    const username = cleanUsername(req.body?.username);
    if (!username) {
      return res.status(400).json({
        error: 'INVALID_USERNAME',
        message: 'Choose a username containing 1 to 24 characters.'
      });
    }
    const avatarDataUrl = cleanImageDataUrl(req.body?.avatarDataUrl);
    if (avatarDataUrl === undefined) {
      return res.status(400).json({
        error: 'INVALID_PROFILE_IMAGE',
        message: 'Use a PNG, JPEG, or WebP profile picture up to 170 KB.'
      });
    }

    const data = readData(dataFile);
    const normalized = username.toLocaleLowerCase('en-US');
    const duplicate = Object.entries(data.profiles).some(([id, profile]) => (
      id !== session.accountId && String(profile?.username || '').toLocaleLowerCase('en-US') === normalized
    ));
    if (duplicate) {
      return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'That BitConnection username is already in use.' });
    }

    const previous = data.profiles[session.accountId] || {};
    const nextProfile = {
      username,
      avatarDataUrl: avatarDataUrl === null && req.body?.avatarDataUrl === undefined
        ? (previous.avatarDataUrl || null)
        : avatarDataUrl,
      createdAt: previous.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.profiles[session.accountId] = nextProfile;
    writeData(dataFile, data);
    return res.json({
      ok: true,
      profile: {
        username: nextProfile.username,
        avatarDataUrl: nextProfile.avatarDataUrl,
        createdAt: nextProfile.createdAt,
        updatedAt: nextProfile.updatedAt
      }
    });
  });

  router.post('/rooms', requireCsrf, (req, res) => {
    const session = getUserSession(req, res);
    if (!session?.authenticated || !session.accountId) {
      return res.status(401).json({
        error: 'BITCONNECTION_ACCOUNT_REQUIRED',
        message: 'A signed-in BitConnection account is required to host a room.'
      });
    }
    const data = readData(dataFile);
    const profile = data.profiles[session.accountId];
    if (!profile?.username) {
      return res.status(409).json({
        error: 'BITCONNECTION_PROFILE_REQUIRED',
        message: 'Finish your BitConnection username setup before creating a room.'
      });
    }

    const roomName = typeof req.body?.roomName === 'string' ? req.body.roomName.trim() : '';
    const visibility = req.body?.visibility;
    const partySize = Number(req.body?.partySize);
    const ownerOnlyControls = req.body?.ownerOnlyControls;

    if (!roomName || Array.from(roomName).length > 48 || /[\u0000-\u001f\u007f]/u.test(roomName)) {
      return res.status(400).json({ error: 'INVALID_ROOM_NAME', message: 'Room names must contain 1 to 48 characters.' });
    }
    if (!['public', 'private'].includes(visibility)) {
      return res.status(400).json({ error: 'INVALID_VISIBILITY', message: 'Choose public or private visibility.' });
    }
    if (!Number.isSafeInteger(partySize) || partySize < 2 || partySize > maximum) {
      return res.status(400).json({ error: 'INVALID_PARTY_SIZE', message: `Party size must be between 2 and ${maximum}.` });
    }
    if (typeof ownerOnlyControls !== 'boolean') {
      return res.status(400).json({ error: 'INVALID_CONTROL_PERMISSION', message: 'Choose whether only the room owner can control music.' });
    }

    const roomId = crypto.randomBytes(16).toString('hex');
    const roomCode = createRoomCode(data.rooms);
    const now = new Date().toISOString();
    const room = {
      roomId, roomCode, roomName, visibility, partySize, ownerOnlyControls,
      hostAccountId: session.accountId,
      hostUsername: profile.username,
      status: 'open',
      createdAt: now,
      updatedAt: now
    };
    data.rooms[roomId] = room;
    writeData(dataFile, data);
    return res.status(201).json({
      ok: true,
      room: {
        roomId, roomCode, roomName, visibility, partySize, ownerOnlyControls,
        hostUsername: profile.username, status: room.status, createdAt: now
      },
      realtimeReady: false
    });
  });

  router.post('/rooms/:roomId/close', requireCsrf, (req, res) => {
    const session = getUserSession(req, res);
    if (!session?.authenticated || !session.accountId) return res.status(401).json({ error: 'BITCONNECTION_ACCOUNT_REQUIRED' });
    const data = readData(dataFile);
    const room = data.rooms[String(req.params.roomId || '')];
    if (!room || room.status !== 'open') return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    if (room.hostAccountId !== session.accountId) return res.status(403).json({ error: 'ROOM_OWNER_REQUIRED' });
    room.status = 'closed';
    room.updatedAt = new Date().toISOString();
    writeData(dataFile, data);
    return res.json({ ok: true, roomId: room.roomId, status: room.status });
  });

  return router;
}
