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

async function harness(t, { ciderAccount = false, maxPartySize = 4, iceConfig = {}, giphyApiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitconnection-test-'));
  const dataFile = path.join(directory, 'bitconnection.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/bitconnection', createBitConnectionRouter({
    dataFile,
    maxPartySize,
    iceConfig,
    giphyApiKey,
    fetchImpl,
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
  assert.equal(payload.capabilities.partyChat, 'text-images-and-giphy-gifs-enabled');
  assert.equal(payload.capabilities.memberModeration, 'kick-ban-and-host-promotion-enabled');
  assert.equal(payload.capabilities.playbackSourceBridge, 'not-connected');
  assert.equal(payload.capabilities.synchronizedLyrics, 'not-connected');
  assert.equal(payload.capabilities.serverSideAutoMix, 'not-configured');
  assert.equal(payload.limits.maxPartySize, 30);
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
  assert.equal(payload.inviteToken, undefined);

  const publicGuestCsrf = await csrfContext(client);
  const joinedByCode = await client.request('/rooms/' + payload.room.roomCode + '/join', {
    method: 'POST',
    headers: publicGuestCsrf.headers,
    body: JSON.stringify({})
  });
  const guest = await joinedByCode.json();
  assert.equal(joinedByCode.status, 201);
  assert.equal(guest.room.roomId, payload.room.roomId);
  assert.match(guest.username, /^[A-Za-z]+[A-Za-z]+\d{3}$/);

  const closed = await client.request(`/rooms/${payload.room.roomId}/close`, {
    method: 'POST',
    headers: csrf.headers
  });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).status, 'closed');
});

test('public directory shows only active public rooms and supports search, with a 30-person maximum', async t => {
  const client = await harness(t, { maxPartySize: 30 });
  const csrf = await csrfContext(client);
  const registered = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Public Host', password: 'public-host-secret' })
  });
  assert.equal(registered.status, 201);

  const passkeys = await client.request('/passkeys', { headers: csrf.headers });
  assert.equal(passkeys.status, 200);
  assert.deepEqual((await passkeys.json()).passkeys, []);

  const publicResponse = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      roomName: 'Late Night Listening',
      visibility: 'public',
      partySize: 30,
      ownerOnlyControls: false
    })
  });
  const publicPayload = await publicResponse.json();
  assert.equal(publicResponse.status, 201);
  assert.equal(publicPayload.room.partySize, 30);

  const overLimit = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      roomName: 'Too Many People',
      visibility: 'public',
      partySize: 31,
      ownerOnlyControls: false
    })
  });
  assert.equal(overLimit.status, 400);
  assert.equal((await overLimit.json()).error, 'INVALID_PARTY_SIZE');

  const guestCsrf = await csrfContext(client);
  const publicJoin = await client.request('/rooms/' + publicPayload.room.roomId + '/join', {
    method: 'POST',
    headers: guestCsrf.headers
  });
  const publicGuest = await publicJoin.json();
  assert.equal(publicJoin.status, 201);
  assert.equal(publicGuest.verification, 'not-required');
  assert.ok(publicGuest.participantCredential);
  assert.ok(publicGuest.participantId);
  assert.equal(publicGuest.requestId, undefined);

  const hostJoinRequests = await client.request('/rooms/' + publicPayload.room.roomId + '/verification-requests', {
    headers: { ...csrf.headers, Authorization: 'Bearer ' + publicPayload.hostCredential }
  });
  assert.equal(hostJoinRequests.status, 200);
  assert.deepEqual((await hostJoinRequests.json()).requests, []);

  const privateResponse = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      roomName: 'Private Listening',
      visibility: 'private',
      partySize: 4,
      ownerOnlyControls: false
    })
  });
  assert.equal(privateResponse.status, 201);

  const directory = await client.request('/rooms/public');
  const directoryPayload = await directory.json();
  assert.equal(directory.status, 200);
  assert.equal(directoryPayload.total, 1);
  assert.equal(directoryPayload.featured.length, 1);
  assert.equal(directoryPayload.rooms[0].roomId, publicPayload.room.roomId);
  assert.equal(directoryPayload.rooms[0].participantCount, 2);
  assert.equal(directoryPayload.rooms[0].visibility, 'public');
  assert.equal(directoryPayload.rooms[0].partySize, 30);
  assert.equal(directoryPayload.rooms.some(room => room.roomName === 'Private Listening'), false);

  const search = await client.request('/rooms/public?q=late%20night');
  const searchPayload = await search.json();
  assert.equal(search.status, 200);
  assert.equal(searchPayload.total, 1);
  assert.equal(searchPayload.rooms[0].roomName, 'Late Night Listening');

  const close = await client.request('/rooms/' + publicPayload.room.roomId + '/close', {
    method: 'POST',
    headers: csrf.headers
  });
  assert.equal(close.status, 200);
  const afterClose = await client.request('/rooms/public');
  assert.equal((await afterClose.json()).total, 0);
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

  const guestClient = client;
  const guestCsrf = await csrfContext(client);
  const joined = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/join', {
    method: 'POST',
    headers: guestCsrf.headers,
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
    ...guestCsrf.headers,
    Authorization: 'Bearer ' + guest.participantCredential
  };
  const deniedPlayback = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/playback', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ isPlaying: false })
  });
  assert.equal(deniedPlayback.status, 403);

  const guestOffer = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/signals', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({
      toParticipantId: roomPayload.hostParticipantId,
      type: 'offer',
      payload: { sdp: 'guest-must-not-offer' }
    })
  });
  assert.equal(guestOffer.status, 403);

  const deniedQueue = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/queue', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({
      action: 'add',
      track: { videoId: 'abcdefghijk', title: 'Guest Song', artist: 'Guest Artist', durationSeconds: 120 }
    })
  });
  assert.equal(deniedQueue.status, 403);

  const hostQueue = await client.request('/rooms/' + roomPayload.room.roomId + '/queue', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({
      action: 'add',
      track: { videoId: 'abcdefghijk', title: 'Host Song', artist: 'Host Artist', durationSeconds: 180 }
    })
  });
  const hostQueuePayload = await hostQueue.json();
  assert.equal(hostQueue.status, 200);
  assert.equal(hostQueuePayload.queue.length, 1);
  const hostQueueItemId = hostQueuePayload.queue[0].queueItemId;

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

  const deniedVolume = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/volume', {
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

  const receivedSignal = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/signals', {
    headers: guestHeaders
  });
  const signalPayload = await receivedSignal.json();
  assert.equal(receivedSignal.status, 200);
  assert.equal(signalPayload.messages.length, 1);
  assert.equal(signalPayload.messages[0].type, 'offer');

  const state = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/state', {
    headers: guestHeaders
  });
  const roomState = await state.json();
  assert.equal(state.status, 200);
  assert.equal(roomState.playbackState.source, 'youtube-music');
  assert.equal(roomState.playbackState.track.videoId, 'abcdefghijk');
  assert.equal(roomState.playbackState.isPlaying, true);
  assert.equal(roomState.queue.length, 1);
  assert.equal(roomState.queue[0].queueItemId, hostQueueItemId);
  assert.equal(roomState.participants.length, 2);

  const left = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/leave', {
    method: 'POST',
    headers: guestHeaders
  });
  assert.equal(left.status, 200);
  assert.equal((await left.json()).roomClosed, false);
  const rejectedAfterLeave = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/state', {
    headers: guestHeaders
  });
  assert.equal(rejectedAfterLeave.status, 401);
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

  const guestClient = client;
  const guestCsrf = await csrfContext(client);
  const request = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/join', {
    method: 'POST',
    headers: guestCsrf.headers,
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

  const verified = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/verify', {
    method: 'POST',
    headers: guestCsrf.headers,
    body: JSON.stringify({ requestId: requestPayload.requestId, code: delivered.oneTimeCode })
  });
  const verifiedPayload = await verified.json();
  assert.equal(verified.status, 201);
  assert.equal(verifiedPayload.username, requestPayload.guestName);
  assert.ok(verifiedPayload.participantCredential);

  const guestHeaders = {
    ...guestCsrf.headers,
    Authorization: 'Bearer ' + verifiedPayload.participantCredential
  };
  const guestPlayback = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/playback', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ isPlaying: false })
  });
  assert.equal(guestPlayback.status, 200);
  const guestQueue = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/queue', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({
      action: 'add',
      track: { videoId: 'zyxwvutsrqp', title: 'Guest Choice', artist: 'Guest Artist', durationSeconds: 200 }
    })
  });
  const guestQueuePayload = await guestQueue.json();
  assert.equal(guestQueue.status, 200);
  assert.equal(guestQueuePayload.queue.length, 1);
  const guestQueueItemId = guestQueuePayload.queue[0].queueItemId;

  const removedQueue = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/queue', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ action: 'remove', queueItemId: guestQueueItemId })
  });
  assert.equal(removedQueue.status, 200);
  assert.equal((await removedQueue.json()).queue.length, 0);

  const guestVolume = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/volume', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ volume: 0.35 })
  });
  assert.equal(guestVolume.status, 200);
  assert.equal((await guestVolume.json()).volume, 0.35);
});

test('room ICE configuration requires membership and returns participant-scoped ephemeral TURN credentials', async t => {
  const sharedSecret = 'test-turn-shared-secret-that-is-long-enough';
  const client = await harness(t, {
    iceConfig: {
      stunUrls: 'stun:stun.example.test:3478',
      turnUrls: 'turn:relay.example.test:3478?transport=udp,turns:relay.example.test:5349?transport=tcp',
      turnSharedSecret: sharedSecret,
      credentialTtlSeconds: 3600
    }
  });
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'ICE Host', password: 'ice-host-secret' })
  });
  assert.equal(registration.status, 201);

  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      roomName: 'ICE Test Room',
      visibility: 'public',
      partySize: 2,
      ownerOnlyControls: true
    })
  });
  const room = await created.json();
  assert.equal(created.status, 201);

  const denied = await client.request('/rooms/' + room.room.roomId + '/ice-config');
  assert.equal(denied.status, 401);

  const response = await client.request('/rooms/' + room.room.roomId + '/ice-config', {
    headers: {
      ...csrf.headers,
      Authorization: 'Bearer ' + room.hostCredential
    }
  });
  const configuration = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(configuration.iceTransportPolicy, 'all');
  assert.equal(configuration.relayAvailable, true);
  assert.equal(configuration.iceServers.length, 2);
  assert.equal(configuration.iceServers[0].urls, 'stun:stun.example.test:3478');
  assert.deepEqual(configuration.iceServers[1].urls, [
    'turn:relay.example.test:3478?transport=udp',
    'turns:relay.example.test:5349?transport=tcp'
  ]);
  assert.match(configuration.iceServers[1].username, /^\d+:bitconnection-[a-f0-9]{24}$/);
  assert.ok(configuration.iceServers[1].credential.length > 20);
  assert.equal(JSON.stringify(configuration).includes(sharedSecret), false);
  assert.ok(configuration.credentialExpiresAt);
});

test('room ICE endpoint fails closed when TURN is configured without its shared secret', async t => {
  const client = await harness(t, {
    iceConfig: { turnUrls: 'turn:relay.example.test:3478', turnSharedSecret: 'short' }
  });
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Missing Secret', password: 'secret-passphrase' })
  });
  assert.equal(registration.status, 201);
  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ roomName: 'No TURN Secret', visibility: 'public', partySize: 2, ownerOnlyControls: true })
  });
  const room = await created.json();
  const response = await client.request('/rooms/' + room.room.roomId + '/ice-config', {
    headers: { ...csrf.headers, Authorization: 'Bearer ' + room.hostCredential }
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'ICE_CONFIGURATION_UNAVAILABLE');
});


test('party chat, queue settings, and host moderation are authenticated by the room participant session', async t => {
  const hostClient = await harness(t);
  const hostCsrf = await csrfContext(hostClient);
  const registration = await hostClient.request('/auth/register', {
    method: 'POST',
    headers: hostCsrf.headers,
    body: JSON.stringify({ username: 'Party Host', password: 'party-host-secret' })
  });
  assert.equal(registration.status, 201);

  const created = await hostClient.request('/rooms', {
    method: 'POST',
    headers: hostCsrf.headers,
    body: JSON.stringify({
      roomName: 'Shared Party UI',
      visibility: 'public',
      partySize: 4,
      ownerOnlyControls: false
    })
  });
  const roomPayload = await created.json();
  assert.equal(created.status, 201);

  // Reuse this test server and its session cookie; the room-scoped bearer token
  // distinguishes the anonymous guest participant from the host participant.
  const guestClient = hostClient;
  const guestCsrf = hostCsrf;
  const guestJoin = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/join', {
    method: 'POST',
    headers: guestCsrf.headers,
    body: JSON.stringify({})
  });
  const guestPayload = await guestJoin.json();
  assert.equal(guestJoin.status, 201);
  const guestHeaders = {
    ...guestCsrf.headers,
    Authorization: 'Bearer ' + guestPayload.participantCredential
  };
  const hostHeaders = {
    ...hostCsrf.headers,
    Authorization: 'Bearer ' + roomPayload.hostCredential
  };

  const sentMessage = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/chat', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ text: 'This sounds incredible', imageUrl: 'https://media.giphy.com/media/test/giphy.gif' })
  });
  assert.equal(sentMessage.status, 201);
  const messagePayload = await sentMessage.json();
  assert.equal(messagePayload.message.text, 'This sounds incredible');
  assert.equal(messagePayload.message.imageType, 'gif');
  assert.equal(messagePayload.message.participantId, guestPayload.participantId);

  const credentialGif = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/chat', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ imageUrl: 'https://user:password@media.giphy.com/media/example/giphy.gif' })
  });
  assert.equal(credentialGif.status, 400);
  assert.equal((await credentialGif.json()).error, 'INVALID_CHAT_GIF');

  const unsupportedImage = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/chat', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ imageDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })
  });
  assert.equal(unsupportedImage.status, 400);
  assert.equal((await unsupportedImage.json()).error, 'INVALID_CHAT_IMAGE');

  const settings = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/queue', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ action: 'settings', settings: { loop: true, shuffle: true, autoMix: false } })
  });
  assert.equal(settings.status, 200);

  const autoMix = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/queue', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ action: 'settings', settings: { loop: true, shuffle: true, autoMix: true } })
  });
  assert.equal(autoMix.status, 503);
  assert.equal((await autoMix.json()).error, 'AUTOMIX_NOT_CONFIGURED');

  const queuedTrack = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/queue', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({
      action: 'add',
      track: {
        videoId: 'abcdefghijk',
        title: 'Metadata Test',
        artist: 'BitChord',
        durationSeconds: 214,
        thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
        audioQuality: 'Hi-Res Lossless'
      }
    })
  });
  const queuedTrackPayload = await queuedTrack.json();
  assert.equal(queuedTrack.status, 200);
  assert.equal(queuedTrackPayload.queue[0].audioQuality, 'Hi-Res Lossless');
  assert.equal(queuedTrackPayload.queue[0].artwork, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');

  const hostState = await hostClient.request('/rooms/' + roomPayload.room.roomId + '/state', { headers: hostHeaders });
  const hostStatePayload = await hostState.json();
  assert.equal(hostState.status, 200);
  assert.equal(hostStatePayload.queueSettings.loop, true);
  assert.equal(hostStatePayload.queueSettings.shuffle, true);
  assert.equal(hostStatePayload.chat.length, 1);
  assert.equal(hostStatePayload.chat[0].text, 'This sounds incredible');
  assert.equal(hostStatePayload.queue.length, 1);
  assert.equal(hostStatePayload.queue[0].audioQuality, 'Hi-Res Lossless');

  const banAnonymous = await hostClient.request('/rooms/' + roomPayload.room.roomId + '/members/' + guestPayload.participantId + '/moderate', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({ action: 'ban' })
  });
  assert.equal(banAnonymous.status, 409);
  assert.equal((await banAnonymous.json()).error, 'ACCOUNT_REQUIRED_FOR_BAN');

  const promoted = await hostClient.request('/rooms/' + roomPayload.room.roomId + '/members/' + guestPayload.participantId + '/moderate', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({ action: 'promote' })
  });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).action, 'promote');

  const promotedState = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/state', { headers: guestHeaders });
  const promotedStatePayload = await promotedState.json();
  assert.equal(promotedState.status, 200);
  assert.equal(promotedStatePayload.participant.role, 'host');

  const oldHostClose = await hostClient.request('/rooms/' + roomPayload.room.roomId + '/close', {
    method: 'POST',
    headers: hostHeaders
  });
  assert.equal(oldHostClose.status, 403);

  const newHostClose = await guestClient.request('/rooms/' + roomPayload.room.roomId + '/close', {
    method: 'POST',
    headers: guestHeaders
  });
  assert.equal(newHostClose.status, 200);
});


test('BitConnection publishes its Listening Party service descriptor for BitChord discovery', async t => {
  const client = await harness(t);
  const response = await client.request('/party-service', {
    headers: { Origin: 'https://bitchord.example.test' }
  });
  const manifest = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(manifest.service, 'BitConnection Listening Party');
  assert.equal(manifest.protocolVersion, 1);
    assert.match(manifest.serviceUrl, /\/party$/);
  assert.equal(manifest.capabilities.roomCreation, true);
  assert.equal(manifest.capabilities.privateRooms, true);
  assert.equal(manifest.capabilities.partyChat, true);
  assert.equal(manifest.capabilities.memberModeration, true);
  assert.equal(manifest.capabilities.sourcePlaybackCommands, false);
  assert.equal(manifest.capabilities.synchronizedLyrics, false);
  assert.equal(manifest.capabilities.serverSideOnnxAutoMix, false);
  assert.equal(manifest.partyRules.maximumParticipants, 4);

  const preflight = await client.request('/party-service', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});


test('GIF search proxies through Deplexo and never returns the API key to the browser', async t => {
  const calls = [];
  const client = await harness(t, {
    giphyApiKey: 'server-only-test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        data: [{
          id: 'giphy-1',
          title: 'Music reaction',
          images: {
            fixed_width_small: { webp: 'https://media.giphy.com/media/giphy-1/200w.webp' },
            original: { url: 'https://media.giphy.com/media/giphy-1/giphy.gif' }
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const response = await client.request('/gifs/search?q=music%20reaction');
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const providerUrl = new URL(calls[0].url);
  assert.equal(providerUrl.origin, 'https://api.giphy.com');
  assert.equal(providerUrl.pathname, '/v1/gifs/search');
  assert.equal(providerUrl.searchParams.get('api_key'), 'server-only-test-key');
  assert.equal(providerUrl.searchParams.get('q'), 'music reaction');
  assert.equal(payload.gifs.length, 1);
  assert.equal(payload.gifs[0].url, 'https://media.giphy.com/media/giphy-1/giphy.gif');
  assert.equal(payload.gifs[0].preview, 'https://media.giphy.com/media/giphy-1/200w.webp');
  assert.equal(JSON.stringify(payload).includes('server-only-test-key'), false);
  assert.equal(payload.attribution, 'Powered by GIPHY');
});

test('GIF search returns a clear configuration response when the Deplexo key is absent', async t => {
  const client = await harness(t);
  const response = await client.request('/gifs/search?q=music');
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error, 'GIF_SEARCH_NOT_CONFIGURED');
});
