import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBitConnectionRouter,
  bitConnectionHealthPayload,
  BITCONNECTION_API_VERSION
} from './api.mjs';

async function harness(t, { ciderAccount = false, maxPartySize = 4 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitconnection-test-'));
  const dataFile = path.join(directory, 'bitconnection.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/bitconnection', createBitConnectionRouter({
    dataFile,
    maxPartySize,
    getUserSession: () => ciderAccount ? { authenticated: true, accountId: 'existing-cider-account', sessionId: 'cider-session-123' } : { authenticated: false },
    requireCiderCsrf: (_req, _res, next) => next(),
    csrfTokenForCiderSession: () => 'cider-test-csrf',
    webAuthnContext: () => ({ origin: 'https://example.test', rpID: 'example.test' })
  }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/bitconnection`;

  async function request(route, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(base + route, { ...options, headers, redirect: 'manual' });
    return response;
  }
  return { request, base };
}

async function csrfContext(client) {
  const response = await client.request('/account');
  const payload = await response.json();
  const cookie = response.headers.get('set-cookie')?.match(/bitconnection_session=([^;]+)/)?.[1];
  assert.ok(cookie, 'BitConnection uses its own session cookie');
  return {
    csrfToken: payload.csrfToken,
    cookie: `bitconnection_session=${cookie}`,
    headers: {
      'X-BitConnection-CSRF': payload.csrfToken,
      Cookie: `bitconnection_session=${cookie}`
    }
  };
}

test('health identifies Deplexo and independent BitConnection auth without Cider addon creation', () => {
  const payload = bitConnectionHealthPayload();
  assert.equal(payload.ok, true);
  assert.equal(payload.deployment, 'Deplexo');
  assert.equal(payload.apiVersion, BITCONNECTION_API_VERSION);
  assert.equal(payload.capabilities.independentAccounts, 'enabled');
  assert.equal(payload.capabilities.ciderAddonCreation, 'never');
});

test('native registration creates a separate BitConnection identity and never calls BitCider auth', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const response = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Velvet Comet', password: 'long-separate-passphrase' })
  });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.account.username, 'Velvet Comet');
  assert.equal(payload.recoveryCodes.length, 10);
  assert.match(csrf.cookie, /^bitconnection_session=/);
  const account = await client.request('/account', { headers: { Cookie: csrf.cookie } });
  const accountPayload = await account.json();
  assert.equal(accountPayload.authenticated, true);
  assert.equal(accountPayload.provider, 'BitConnection');
  assert.equal(accountPayload.profile.username, 'Velvet Comet');
});

test('native login and recovery use the BitConnection account database only', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Silver Falcon', password: 'first-secret' })
  });
  const registered = await registration.json();
  const logout = await client.request('/auth/logout', { method: 'POST', headers: csrf.headers });
  assert.equal(logout.status, 200);

  const login = await client.request('/auth/login', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'silver falcon', password: 'first-secret' })
  });
  assert.equal(login.status, 200);
  await client.request('/auth/logout', { method: 'POST', headers: csrf.headers });

  const recovered = await client.request('/auth/recover', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      username: 'Silver Falcon',
      recoveryCode: registered.recoveryCodes[0],
      newPassword: 'replacement-secret'
    })
  });
  const recoveredPayload = await recovered.json();
  assert.equal(recovered.status, 200);
  assert.equal(recoveredPayload.recoveryCodes.length, 10);

  await client.request('/auth/logout', { method: 'POST', headers: csrf.headers });
  const oldPassword = await client.request('/auth/login', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Silver Falcon', password: 'first-secret' })
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await client.request('/auth/login', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Silver Falcon', password: 'replacement-secret' })
  });
  assert.equal(newPassword.status, 200);
});

test('BitConnection account choice is explicit when a BitCider account is also available', async t => {
  const client = await harness(t, { ciderAccount: true });
  const defaultAccount = await client.request('/account');
  const prompt = await defaultAccount.json();
  assert.equal(prompt.authenticated, false);
  assert.equal(prompt.bitCiderAccountAvailable, true);

  const linked = await client.request('/account', { headers: { 'X-BitConnection-Identity': 'bitcider' } });
  const linkedPayload = await linked.json();
  assert.equal(linkedPayload.authenticated, true);
  assert.equal(linkedPayload.provider, 'BitCider');
  assert.equal(linkedPayload.identityMode, 'bitcider');
});

test('BitConnection requires authentication and a completed profile to create a room', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const denied = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ roomName: 'No account', visibility: 'public', partySize: 2, ownerOnlyControls: true })
  });
  assert.equal(denied.status, 401);

  const registered = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Room Host', password: 'host-secret' })
  });
  assert.equal(registered.status, 201);

  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ roomName: 'Owner room', visibility: 'public', partySize: 2, ownerOnlyControls: true })
  });
  const payload = await created.json();
  assert.equal(created.status, 201);
  assert.equal(payload.room.hostUsername, 'Room Host');

  const closed = await client.request(`/rooms/${payload.room.roomId}/close`, {
    method: 'POST',
    headers: csrf.headers
  });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).status, 'closed');
});

test('BitConnection rejects duplicate usernames, invalid photos, and over-limit party requests', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const first = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Night Owl', password: 'secret-one' })
  });
  assert.equal(first.status, 201);
  await client.request('/auth/logout', { method: 'POST', headers: csrf.headers });

  const duplicate = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'night owl', password: 'secret-two' })
  });
  assert.equal(duplicate.status, 409);

  const badPhoto = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Other Owl', password: 'secret-three', avatarDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })
  });
  assert.equal(badPhoto.status, 400);
});

test('live rooms support temporary guests, proximity admission, playback permissions, and WebRTC signaling', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Live Host', password: 'live-host-secret' })
  });
  assert.equal(registration.status, 201);

  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      roomName: 'Living Room Session',
      visibility: 'private',
      partySize: 3,
      ownerOnlyControls: true
    })
  });
  const roomPayload = await created.json();
  assert.equal(created.status, 201);
  assert.equal(roomPayload.realtimeReady, true);
  assert.equal(roomPayload.audioTransport, 'direct-webrtc');
  assert.ok(roomPayload.hostCredential);
  assert.ok(roomPayload.inviteToken);

  const hostHeaders = {
    ...csrf.headers,
    Authorization: 'Bearer ' + roomPayload.hostCredential
  };
  const hostLocation = await client.request('/rooms/' + roomPayload.room.roomId + '/location', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({ location: { latitude: 37.3331, longitude: -121.8907, accuracy: 5 } })
  });
  assert.equal(hostLocation.status, 200);

  const joined = await client.request('/rooms/' + roomPayload.room.roomId + '/join', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      inviteToken: roomPayload.inviteToken,
      location: { latitude: 37.33311, longitude: -121.8907, accuracy: 5 }
    })
  });
  const guest = await joined.json();
  assert.equal(joined.status, 201);
  assert.equal(guest.verification, 'proximity');
  assert.match(guest.username, /^[A-Za-z]+[A-Za-z]+\d{3}$/);
  assert.ok(guest.participantCredential);

  const guestHeaders = {
    ...csrf.headers,
    Authorization: 'Bearer ' + guest.participantCredential
  };
  const deniedPlayback = await client.request('/rooms/' + roomPayload.room.roomId + '/playback', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ isPlaying: false })
  });
  assert.equal(deniedPlayback.status, 403);

  const hostPlayback = await client.request('/rooms/' + roomPayload.room.roomId + '/playback', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({
      source: 'youtube-music',
      track: { videoId: 'abcdefghijk', title: 'Test Song', artist: 'Test Artist', durationSeconds: 180 },
      isPlaying: true,
      positionSeconds: 12
    })
  });
  assert.equal(hostPlayback.status, 200);

  const deniedVolume = await client.request('/rooms/' + roomPayload.room.roomId + '/volume', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ volume: 0.3 })
  });
  assert.equal(deniedVolume.status, 403);
  const hostVolume = await client.request('/rooms/' + roomPayload.room.roomId + '/volume', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({ volume: 0.8 })
  });
  assert.equal(hostVolume.status, 200);

  const signal = await client.request('/rooms/' + roomPayload.room.roomId + '/signals', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({
      toParticipantId: guest.participantId,
      type: 'offer',
      payload: { sdp: 'v=0\\r\\no=- test' }
    })
  });
  assert.equal(signal.status, 202);

  const receivedSignal = await client.request('/rooms/' + roomPayload.room.roomId + '/signals', {
    headers: guestHeaders
  });
  const signalPayload = await receivedSignal.json();
  assert.equal(receivedSignal.status, 200);
  assert.equal(signalPayload.messages.length, 1);
  assert.equal(signalPayload.messages[0].type, 'offer');

  const state = await client.request('/rooms/' + roomPayload.room.roomId + '/state', {
    headers: guestHeaders
  });
  const roomState = await state.json();
  assert.equal(state.status, 200);
  assert.equal(roomState.playbackState.source, 'youtube-music');
  assert.equal(roomState.playbackState.track.videoId, 'abcdefghijk');
  assert.equal(roomState.playbackState.isPlaying, true);
  assert.equal(roomState.participants.length, 2);

  const left = await client.request('/rooms/' + roomPayload.room.roomId + '/leave', {
    method: 'POST',
    headers: guestHeaders
  });
  assert.equal(left.status, 200);
  assert.equal((await left.json()).roomClosed, false);
});

test('private-room distance fallback requires a host-relayed code that expires five minutes after delivery', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Verification Host', password: 'verification-secret' })
  });
  assert.equal(registration.status, 201);

  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      roomName: 'Private Session',
      visibility: 'private',
      partySize: 3,
      ownerOnlyControls: false
    })
  });
  const roomPayload = await created.json();
  assert.equal(created.status, 201);

  const request = await client.request('/rooms/' + roomPayload.room.roomId + '/join', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ inviteToken: roomPayload.inviteToken })
  });
  const requestPayload = await request.json();
  assert.equal(request.status, 202);
  assert.equal(requestPayload.verification, 'host-one-time-code');

  const hostHeaders = {
    ...csrf.headers,
    Authorization: 'Bearer ' + roomPayload.hostCredential
  };
  const hostRequests = await client.request('/rooms/' + roomPayload.room.roomId + '/verification-requests', {
    headers: hostHeaders
  });
  const hostRequestPayload = await hostRequests.json();
  assert.equal(hostRequests.status, 200);
  assert.equal(hostRequestPayload.requests.length, 1);
  const delivered = hostRequestPayload.requests[0];
  assert.match(delivered.oneTimeCode, /^\d{6}$/);
  const expiresIn = Date.parse(delivered.expiresAt) - Date.now();
  assert.ok(expiresIn > 4 * 60 * 1000 && expiresIn <= 5 * 60 * 1000);

  const verified = await client.request('/rooms/' + roomPayload.room.roomId + '/verify', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ requestId: requestPayload.requestId, code: delivered.oneTimeCode })
  });
  const verifiedPayload = await verified.json();
  assert.equal(verified.status, 201);
  assert.equal(verifiedPayload.username, requestPayload.guestName);
  assert.ok(verifiedPayload.participantCredential);

  const guestHeaders = {
    ...csrf.headers,
    Authorization: 'Bearer ' + verifiedPayload.participantCredential
  };
  const guestPlayback = await client.request('/rooms/' + roomPayload.room.roomId + '/playback', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ isPlaying: false })
  });
  assert.equal(guestPlayback.status, 200);
  const guestVolume = await client.request('/rooms/' + roomPayload.room.roomId + '/volume', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ volume: 0.35 })
  });
  assert.equal(guestVolume.status, 200);
  assert.equal((await guestVolume.json()).volume, 0.35);
});
