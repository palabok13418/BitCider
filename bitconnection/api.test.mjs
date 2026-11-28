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

async function harness(t, { ciderAccount = false, maxPartySize = 4, iceConfig = {}, giphyApiKey = '', fetchImpl = globalThis.fetch, appleMusicWebPlayerToken = '', appleMusicPlaybackDeveloperToken = '', providerCredentialEncryptionConfigured = false } = {}) {
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
    appleMusicWebPlayerToken,
    appleMusicPlaybackDeveloperToken,
    encryptProviderCredential: value => ({ value: Buffer.from(value).toString('base64url'), iv: 'test-iv', tag: 'test-tag' }),
    decryptProviderCredential: box => Buffer.from(box.value, 'base64url').toString('utf8'),
    providerCredentialEncryptionConfigured: () => providerCredentialEncryptionConfigured,
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
  return { request, base, dataFile };
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
  assert.equal(payload.capabilities.playbackSourceBridge, 'bitmono-ccustom-cider-in-page-audio-element-over-webrtc');
  assert.deepEqual(payload.capabilities.playbackSourceOptions, ['bitmono', 'ccustom', 'cider']);
  assert.equal(payload.capabilities.appleMusicRecommendations, 'automatic-web-player-bearer-plus-subscriber-token-private-endpoint-experimental');
  assert.equal(payload.capabilities.bitMonoPlayback, 'in-page-audio-element-published-over-webrtc');
  assert.equal(payload.capabilities.synchronizedLyrics, 'not-connected');
  assert.equal(payload.capabilities.serverSideAutoMix, 'onnx-analysis-and-dj-planning-ready-player-bridge-required');
  assert.equal(payload.capabilities.serverSideAudioAnalysis, 'host-uploaded-to-deplexo-not-relayed');
  assert.equal(payload.limits.maxPartySize, 30);
});

test('Apple Music song search works without a MusicKit developer token', async t => {
  let requestedUrl = '';
  const client = await harness(t, {
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Accept, 'application/json');
      return {
        ok: true,
        async json() {
          return {
            resultCount: 1,
            results: [{
              wrapperType: 'track',
              kind: 'song',
              trackId: 123456789,
              trackName: 'Example Song',
              artistName: 'Example Artist',
              collectionName: 'Example Album',
              artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg',
              trackViewUrl: 'https://music.apple.com/us/album/example-album/987654321?i=123456789',
              trackTimeMillis: 203000
            }]
          };
        }
      };
    }
  });
  const response = await client.request('/account/providers/apple-music/catalog-search?term=Example%20Artist&storefront=us');
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.developerTokenRequired, false);
  assert.equal(payload.tracks.length, 1);
  assert.equal(payload.tracks[0].id, '123456789');
  assert.equal(payload.tracks[0].title, 'Example Song');
  assert.equal(payload.tracks[0].url, 'https://music.apple.com/us/album/example-album/987654321?i=123456789');
  assert.equal(payload.tracks[0].durationSeconds, 203);
  assert.match(requestedUrl, /^https:\/\/itunes\.apple\.com\/search\?/);
  assert.match(requestedUrl, /entity=song/);
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
  assert.match(payload.room.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
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

test('when the host leaves, the earliest-joined guest becomes host and the room stays open', async t => {
  const client = await harness(t);
  const hostCsrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: hostCsrf.headers,
    body: JSON.stringify({ username: 'Succession Host', password: 'succession-host-secret' })
  });
  assert.equal(registration.status, 201);
  const created = await client.request('/rooms', {
    method: 'POST',
    headers: hostCsrf.headers,
    body: JSON.stringify({ roomName: 'Succession Test', visibility: 'public', partySize: 4, ownerOnlyControls: false })
  });
  const room = await created.json();
  assert.equal(created.status, 201);

  const firstGuestCsrf = await csrfContext(client);
  const firstJoin = await client.request('/rooms/' + room.room.roomCode + '/join', {
    method: 'POST', headers: firstGuestCsrf.headers, body: JSON.stringify({})
  });
  const firstGuest = await firstJoin.json();
  assert.equal(firstJoin.status, 201);

  const secondGuestCsrf = await csrfContext(client);
  const secondJoin = await client.request('/rooms/' + room.room.roomCode + '/join', {
    method: 'POST', headers: secondGuestCsrf.headers, body: JSON.stringify({})
  });
  const secondGuest = await secondJoin.json();
  assert.equal(secondJoin.status, 201);

  const left = await client.request('/rooms/' + room.room.roomId + '/leave', {
    method: 'POST',
    headers: { ...hostCsrf.headers, Authorization: 'Bearer ' + room.hostCredential }
  });
  const leavePayload = await left.json();
  assert.equal(left.status, 200);
  assert.equal(leavePayload.roomClosed, false);
  assert.equal(leavePayload.hostTransferred, true);
  assert.equal(leavePayload.hostParticipantId, firstGuest.participantId);

  const firstGuestHeaders = { ...firstGuestCsrf.headers, Authorization: 'Bearer ' + firstGuest.participantCredential };
  const state = await client.request('/rooms/' + room.room.roomId + '/state', { headers: firstGuestHeaders });
  const statePayload = await state.json();
  assert.equal(state.status, 200);
  assert.equal(statePayload.room.status, 'open');
  assert.equal(statePayload.participant.role, 'host');
  assert.equal(statePayload.participant.participantId, firstGuest.participantId);
  assert.ok(statePayload.participants.some(item => item.participantId === secondGuest.participantId));
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

  const appleMusicPlayback = await client.request('/rooms/' + roomPayload.room.roomId + '/playback', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({
      source: 'apple-music',
      track: {
        id: '1234567890',
        title: 'Apple Full-Length Track',
        artist: 'Apple Artist',
        durationSeconds: 204,
        artworkUrl: 'https://is1-ssl.mzstatic.com/image/600x600bb.jpg',
        url: 'https://music.apple.com/us/song/example/1234567890',
        playbackMode: 'embed',
        appleMusicStorefront: 'us'
      },
      isPlaying: true,
      positionSeconds: 0
    })
  });
  assert.equal(appleMusicPlayback.status, 200);
  const appleMusicPayload = await appleMusicPlayback.json();
  assert.equal(appleMusicPayload.playbackState.source, 'apple-music');
  assert.equal(appleMusicPayload.playbackState.track.appleMusicSongId, '1234567890');
  assert.equal(appleMusicPayload.playbackState.track.source, 'apple-music');
  assert.equal(appleMusicPayload.playbackState.track.playbackMode, 'embed');
  assert.equal(appleMusicPayload.playbackState.track.appleMusicUrl, 'https://music.apple.com/us/song/example/1234567890');

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
  assert.equal(roomState.playbackState.source, 'apple-music');
  assert.equal(roomState.playbackState.track.appleMusicSongId, '1234567890');
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

  // Keep the anonymous guest in a separate browser session. Reusing the host
  // account cookie would intentionally associate both participants with one identity.
  const guestClient = hostClient;
  const guestCsrf = await csrfContext(guestClient);
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
  assert.equal((await autoMix.json()).error, 'AUTOMIX_PLAYER_BRIDGE_REQUIRED');

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



test('AutoMix endpoints expose host-only analysis and a safe plan-only state', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'AutoMix Host', password: 'automix-host-secret' })
  });
  assert.equal(registration.status, 201);

  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({
      roomName: 'AutoMix API Test',
      visibility: 'public',
      partySize: 3,
      ownerOnlyControls: true
    })
  });
  const roomPayload = await created.json();
  assert.equal(created.status, 201);
  const roomId = roomPayload.room.roomId;
  const hostHeaders = {
    ...csrf.headers,
    Authorization: 'Bearer ' + roomPayload.hostCredential
  };

  const status = await client.request('/rooms/' + roomId + '/automix/status', {
    headers: hostHeaders
  });
  const statusPayload = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusPayload.canAnalyze, true);
  assert.equal(statusPayload.livePlaybackEnabled, false);
  assert.equal(statusPayload.engine, 'BitConnection AutoMix');

  const guestJoin = await client.request('/rooms/' + roomId + '/join', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({})
  });
  const guestPayload = await guestJoin.json();
  assert.equal(guestJoin.status, 201);
  const guestStatus = await client.request('/rooms/' + roomId + '/automix/status', {
    headers: {
      ...csrf.headers,
      Authorization: 'Bearer ' + guestPayload.participantCredential
    }
  });
  assert.equal(guestStatus.status, 200);
  assert.equal((await guestStatus.json()).canAnalyze, false);

  const missingPcm = await client.request('/rooms/' + roomId + '/automix/analyze/missing-track', {
    method: 'POST',
    headers: { ...hostHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(missingPcm.status, 415);
  assert.equal((await missingPcm.json()).error, 'AUTOMIX_PCM_REQUIRED');

  const invalidSampleRate = await client.request('/rooms/' + roomId + '/automix/analyze/missing-track', {
    method: 'POST',
    headers: { ...hostHeaders, 'Content-Type': 'application/vnd.bitconnection.pcm-f32le', 'X-Audio-Sample-Rate': '44100' },
    body: new Uint8Array([0, 0, 0, 0])
  });
  assert.equal(invalidSampleRate.status, 400);
  assert.equal((await invalidSampleRate.json()).error, 'AUTOMIX_SAMPLE_RATE_REQUIRED');

  const noPlan = await client.request('/rooms/' + roomId + '/automix/plan', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({})
  });
  assert.equal(noPlan.status, 409);
  assert.equal((await noPlan.json()).error, 'AUTOMIX_NEEDS_TWO_ANALYZED_TRACKS');
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
  assert.equal(manifest.capabilities.serverSideOnnxAnalysis, true);
  assert.equal(manifest.capabilities.serverSideOnnxDjPlanning, true);
  assert.equal(manifest.capabilities.liveAutoMixExecution, false);
  assert.equal(manifest.capabilities.serverSideOnnxAutoMix, false);
  assert.match(manifest.unavailableFeatures.serverSideOnnxAutoMix, /player-control bridge/i);
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


test('Apple Music recommendations use the private web-player endpoint without a developer-token secret', async t => {
  const seenRequests = [];
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const webPlayerBearer = 'eyJhbGciOiJFUzI1NiJ9.'
    + Buffer.from(JSON.stringify({ exp: expiry }), 'utf8').toString('base64url')
    + '.signaturetoken';
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    seenRequests.push({ url: target, headers: options.headers || {} });
    if (target === 'https://music.apple.com/us/browse') {
      return new Response(
        '<html><script src="https://music.apple.com/assets/index-recommendations-test.js"></script></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    if (target === 'https://music.apple.com/assets/index-recommendations-test.js') {
      return new Response('const bearer = "' + webPlayerBearer + '";', {
        status: 200, headers: { 'content-type': 'application/javascript' }
      });
    }
    if (target === 'https://amp-api-edge.music.apple.com/v1/recommendations/us?limit=8') {
      return new Response(JSON.stringify({
        data: [{
          id: 'personal-mix-1',
          type: 'personal-recommendation',
          attributes: {
            title: { stringForDisplay: 'Made for tonight' },
            description: { standard: 'A personal mix' },
            artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}bb.{f}' },
            url: 'https://music.apple.com/us/playlist/made-for-tonight/pl.example'
          },
          relationships: {
            contents: {
              data: [{
                id: '12345',
                type: 'songs',
                attributes: {
                  name: 'Example track',
                  artistName: 'Example artist',
                  albumName: 'Example album',
                  artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}bb.{f}' },
                  url: 'https://music.apple.com/us/song/example/12345',
                  durationInMillis: 180000
                }
              }]
            }
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ errors: [{ detail: 'Unexpected Apple Music test URL: ' + target }] }), {
      status: 404, headers: { 'content-type': 'application/json' }
    });
  };

  // No developer-token option or environment secret is supplied to BitConnection.
  const client = await harness(t, {
    providerCredentialEncryptionConfigured: true,
    fetchImpl
  });
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Apple Listener', password: 'apple-listener-secret' })
  });
  assert.equal(registration.status, 201);

  const token = 'user-media-token-example-value-1234567890';
  const connected = await client.request('/account/providers/apple-music', {
    method: 'PUT',
    headers: { ...csrf.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ userMediaToken: token })
  });
  assert.equal(connected.status, 200);
  const connectedPayload = await connected.json();
  assert.equal(connectedPayload.connected, true);
  assert.equal(connectedPayload.validated, false);
  assert.equal(connectedPayload.validationDeferred, true);
  assert.equal(JSON.stringify(connectedPayload).includes(token), false);

  const stored = fs.readFileSync(client.dataFile, 'utf8');
  assert.equal(stored.includes(token), false, 'the raw user token must never be written to the BitConnection store');

  const status = await client.request('/account/providers/apple-music', { headers: { Cookie: csrf.cookie } });
  const statusPayload = await status.json();
  assert.equal(statusPayload.connected, true);
  assert.equal(statusPayload.recommendationsConfigured, true);
  assert.equal(statusPayload.recommendationsAuthentication, 'automatic-web-player-bearer-plus-user-media-token-private-endpoint-experimental');
  assert.equal(JSON.stringify(statusPayload).includes(token), false);

  const recommendations = await client.request('/account/providers/apple-music/recommendations', {
    headers: { Cookie: csrf.cookie }
  });
  const recommendationPayload = await recommendations.json();
  assert.equal(recommendations.status, 200);
  assert.equal(recommendationPayload.source, 'amp-api-edge');
  assert.equal(recommendationPayload.authentication, 'web-player-bearer-plus-user-media-token');
  assert.equal(recommendationPayload.recommendations[0].title, 'Made for tonight');
  assert.equal(recommendationPayload.recommendations[0].items[0].title, 'Example track');
  assert.equal(recommendationPayload.recommendations[0].items[0].artist, 'Example artist');
  assert.equal(recommendationPayload.recommendations[0].items[0].artworkUrl, 'https://is1-ssl.mzstatic.com/image/600x600bb.jpg');

  const privateRequest = seenRequests.find(entry => entry.url === 'https://amp-api-edge.music.apple.com/v1/recommendations/us?limit=8');
  assert.ok(privateRequest, 'the feed must call the private amp-api-edge recommendation route');
  assert.equal(privateRequest.headers.Authorization, 'Bearer ' + webPlayerBearer);
  assert.equal(privateRequest.headers['Media-User-Token'], token);
  assert.equal(privateRequest.headers['Music-User-Token'], token);
  assert.equal(privateRequest.headers.Origin, 'https://music.apple.com');
  assert.ok(seenRequests.some(entry => entry.url === 'https://music.apple.com/us/browse'));
  assert.ok(seenRequests.some(entry => entry.url === 'https://music.apple.com/assets/index-recommendations-test.js'));
  assert.equal(seenRequests.some(entry => entry.url.includes('api.music.apple.com/v1/me/recommendations')), false);
  assert.equal(JSON.stringify(recommendationPayload).includes(token), false);

  const disconnected = await client.request('/account/providers/apple-music', {
    method: 'DELETE',
    headers: csrf.headers
  });
  assert.equal(disconnected.status, 200);
  const afterDisconnect = await client.request('/account/providers/apple-music', { headers: { Cookie: csrf.cookie } });
  assert.equal((await afterDisconnect.json()).connected, false);
});

test('Apple Music account connection needs encryption but not a developer token', async t => {
  const noDeveloperToken = await harness(t, {
    providerCredentialEncryptionConfigured: true,
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  });
  const csrf = await csrfContext(noDeveloperToken);
  await noDeveloperToken.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'No Apple Developer', password: 'secret-password' })
  });
  const noDevResponse = await noDeveloperToken.request('/account/providers/apple-music', {
    method: 'PUT',
    headers: { ...csrf.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ userMediaToken: 'valid-example-user-media-token-987654321' })
  });
  assert.equal(noDevResponse.status, 200);
  const noDevPayload = await noDevResponse.json();
  assert.equal(noDevPayload.connected, true);
  assert.equal(noDevPayload.validationDeferred, true);

  const noEncryption = await harness(t, {
    providerCredentialEncryptionConfigured: false,
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  });
  const noEncryptionCsrf = await csrfContext(noEncryption);
  await noEncryption.request('/auth/register', {
    method: 'POST',
    headers: noEncryptionCsrf.headers,
    body: JSON.stringify({ username: 'No Secure Storage', password: 'secret-password' })
  });
  const noEncryptionResponse = await noEncryption.request('/account/providers/apple-music', {
    method: 'PUT',
    headers: { ...noEncryptionCsrf.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ userMediaToken: 'valid-example-user-media-token-987654321' })
  });
  assert.equal(noEncryptionResponse.status, 503);
  assert.equal((await noEncryptionResponse.json()).error, 'SECURE_PROVIDER_STORAGE_NOT_CONFIGURED');
});


test('Apple Music TTML lyrics work without a developer token by discovering the public web-player Bearer', async t => {
  const requests = [];
  const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'web-player-key' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp, iss: 'apple-web-player' })).toString('base64url'),
    Buffer.from('web-player-signature').toString('base64url')
  ].join('.');
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), headers: options.headers || {} });
    if (String(url) === 'https://music.apple.com/us/browse') {
      return new Response('<html><script type="module" src="/assets/index~test.js"></script></html>', {
        status: 200, headers: { 'content-type': 'text/html' }
      });
    }
    if (String(url) === 'https://music.apple.com/assets/index~test.js') {
      return new Response('window.appleToken = "' + jwt + '";', {
        status: 200, headers: { 'content-type': 'application/javascript' }
      });
    }
    if (String(url).includes('/syllable-lyrics?extend=ttmlLocalizations')) {
      return new Response(JSON.stringify({
        data: [{ attributes: { ttml: '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="0s" end="2s">hello</p></body></tt>' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected Apple Music endpoint: ' + url);
  };
  const client = await harness(t, {
    providerCredentialEncryptionConfigured: true,
    fetchImpl
  });
  const csrf = await csrfContext(client);
  await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Timed Lyrics', password: 'timed-lyrics-secret' })
  });
  const token = 'apple-music-lyrics-token-1234567890';
  const connected = await client.request('/account/providers/apple-music', {
    method: 'PUT',
    headers: { ...csrf.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ userMediaToken: token })
  });
  assert.equal(connected.status, 200);
  const connectPayload = await connected.json();
  assert.equal(connectPayload.connected, true);
  assert.equal(connectPayload.validationDeferred, true);
  assert.equal(JSON.stringify(connectPayload).includes(token), false);
  assert.equal(requests.length, 0, 'saving a subscriber token must not call an endpoint requiring a developer token');

  const status = await client.request('/account/providers/apple-music', { headers: { Cookie: csrf.cookie } });
  const statusPayload = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusPayload.connected, true);
  assert.equal(statusPayload.recommendationsConfigured, true);
  assert.equal(statusPayload.recommendationsAuthentication, 'automatic-web-player-bearer-plus-user-media-token-private-endpoint-experimental');
  assert.equal(statusPayload.lyricsAuthentication, 'automatic-web-player-bearer-plus-user-media-token');

  const lyrics = await client.request('/account/providers/apple-music/lyrics?songId=123456789&storefront=us', {
    headers: { Cookie: csrf.cookie }
  });
  const payload = await lyrics.json();
  assert.equal(lyrics.status, 200);
  assert.equal(payload.format, 'ttml');
  assert.equal(payload.source, 'syllable-lyrics');
  assert.match(payload.ttml, /<p begin="0s"/);
  const lyricsRequest = requests.find(request => request.url.includes('/syllable-lyrics?'));
  assert.ok(lyricsRequest);
  assert.equal(lyricsRequest.headers['Media-User-Token'], token);
  assert.equal(lyricsRequest.headers['Music-User-Token'], undefined);
  assert.equal(lyricsRequest.headers.Authorization, 'Bearer ' + jwt);
  assert.equal(lyricsRequest.headers.Origin, 'https://music.apple.com');
  assert.equal(lyricsRequest.headers.Referer, 'https://music.apple.com/');
  assert.ok(requests.some(request => request.url === 'https://music.apple.com/us/browse'));
  assert.ok(requests.some(request => request.url === 'https://music.apple.com/assets/index~test.js'));
});

test('BitMono search results can enter the shared queue and become synchronized party playback', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Mono Host', password: 'mono-host-secret' })
  });
  assert.equal(registration.status, 201);
  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ roomName: 'BitMono Party', visibility: 'public', partySize: 4, ownerOnlyControls: false })
  });
  const room = await created.json();
  assert.equal(created.status, 201);
  const hostHeaders = { ...csrf.headers, Authorization: 'Bearer ' + room.hostCredential };
  const track = {
    source: 'bitmono',
    id: 'mono_123456789',
    title: 'Example FLAC Song',
    artist: 'Example Artist',
    durationSeconds: 203.4,
    artworkURL: 'https://cdn.example.test/artwork.jpg',
    audioQuality: 'LOSSLESS',
    appleMusicSongId: '12345678901',
    appleMusicStorefront: 'us'
  };

  const queued = await client.request('/rooms/' + room.room.roomId + '/queue', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({ action: 'add', track })
  });
  const queuedPayload = await queued.json();
  assert.equal(queued.status, 200);
  assert.equal(queuedPayload.queue[0].source, 'bitmono');
  assert.equal(queuedPayload.queue[0].trackId, 'mono_123456789');

  const playback = await client.request('/rooms/' + room.room.roomId + '/playback', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({
      source: 'bitmono',
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        durationSeconds: track.durationSeconds,
        artworkURL: track.artworkURL,
        audioQuality: track.audioQuality
      },
      isPlaying: true,
      positionSeconds: 0
    })
  });
  assert.equal(playback.status, 200);
  const state = await client.request('/rooms/' + room.room.roomId + '/state', { headers: hostHeaders });
  const payload = await state.json();
  assert.equal(state.status, 200);
  assert.equal(payload.playbackState.source, 'bitmono');
  assert.equal(payload.playbackState.track.trackId, 'mono_123456789');
  assert.equal(payload.playbackState.track.audioQuality, 'Lossless');
  assert.equal(payload.playbackState.track.appleMusicSongId, undefined);
  assert.equal(payload.playbackState.track.appleMusicStorefront, undefined);
  assert.equal(payload.playbackState.isPlaying, true);

  const invalid = await client.request('/rooms/' + room.room.roomId + '/playback', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({
      source: 'bitmono',
      track: { id: '../private', title: 'Bad Track', artist: 'Bad Artist', durationSeconds: 3 },
      isPlaying: true
    })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'INVALID_BITMONO_TRACK');
});


test('Apple Music room playback preserves only known audio variant availability labels', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Format Host', password: 'format-host-secret' })
  });
  assert.equal(registration.status, 201);
  const created = await client.request('/rooms', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ roomName: 'Format Party', visibility: 'public', partySize: 4, ownerOnlyControls: false })
  });
  const room = await created.json();
  assert.equal(created.status, 201);
  const hostHeaders = { ...csrf.headers, Authorization: 'Bearer ' + room.hostCredential };
  const playback = await client.request('/rooms/' + room.room.roomId + '/playback', {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({
      source: 'apple-music',
      track: {
        id: '123456789',
        title: 'Format Test',
        artist: 'BitCider Test',
        durationSeconds: 180,
        audioVariants: ['dolby-atmos', 'lossless', 'hi-res-lossless', 'not-a-real-format']
      },
      isPlaying: true,
      positionSeconds: 0
    })
  });
  assert.equal(playback.status, 200);
  const state = await client.request('/rooms/' + room.room.roomId + '/state', { headers: hostHeaders });
  const payload = await state.json();
  assert.equal(state.status, 200);
  assert.deepEqual(payload.playbackState.track.audioVariants, ['dolby-atmos', 'lossless', 'hi-res-lossless']);
});

test('MusicKit playback config is available only to signed-in accounts and returns the optional developer token', async t => {
  const client = await harness(t, {
    appleMusicPlaybackDeveloperToken: 'eyJhbGciOiJFUzI1NiJ9.test.signature'
  });
  const anonymous = await client.request('/account/providers/apple-music/playback-config');
  assert.equal(anonymous.status, 401);

  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'MusicKit Listener', password: 'music-kit-listener-secret' })
  });
  assert.equal(registration.status, 201);

  const configured = await client.request('/account/providers/apple-music/playback-config', {
    headers: { Cookie: csrf.cookie }
  });
  const payload = await configured.json();
  assert.equal(configured.status, 200);
  assert.equal(payload.configured, true);
  assert.equal(payload.provider, 'musickit-web-v3');
  assert.equal(payload.developerToken, 'eyJhbGciOiJFUzI1NiJ9.test.signature');
  assert.equal(payload.scriptUrl, 'https://js-cdn.music.apple.com/musickit/v3/musickit.js');
  assert.equal(configured.headers.get('cache-control'), 'private, no-store');
});

test('MusicKit playback config clearly reports when its separate developer token is not configured', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registration = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'No MusicKit Key', password: 'no-music-kit-key-secret' })
  });
  assert.equal(registration.status, 201);

  const response = await client.request('/account/providers/apple-music/playback-config', {
    headers: { Cookie: csrf.cookie }
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.configured, false);
  assert.equal(payload.playbackMode, 'apple-music-embed');
  assert.match(payload.message, /embedded player remains available/);
});


test('BitAccount playback source settings persist and are inherited by CCustom and Cider rooms', async t => {
  const client = await harness(t);
  const csrf = await csrfContext(client);
  const registered = await client.request('/auth/register', {
    method: 'POST',
    headers: csrf.headers,
    body: JSON.stringify({ username: 'Party Source Host', password: 'party-source-host-secret' })
  });
  assert.equal(registered.status, 201);

  async function saveSource(playbackSource, customSourceManifestUrl = '') {
    return client.request('/account/playback-settings', {
      method: 'PUT',
      headers: csrf.headers,
      body: JSON.stringify({ playbackSource, customSourceManifestUrl })
    });
  }

  const customSaved = await saveSource('ccustom', 'https://addons.example.test/custom/manifest.json');
  assert.equal(customSaved.status, 200);
  const customPayload = await customSaved.json();
  assert.equal(customPayload.playbackSettings.playbackSource, 'ccustom');
  assert.equal(customPayload.playbackSettings.customSourceManifestUrl, 'https://addons.example.test/custom/manifest.json');

  const invalidCustom = await saveSource('ccustom', 'http://addons.example.test/manifest.json');
  assert.equal(invalidCustom.status, 400);
  assert.equal((await invalidCustom.json()).error, 'INVALID_CUSTOM_SOURCE_URL');

  const missingCustom = await saveSource('ccustom', '');
  assert.equal(missingCustom.status, 400);
  assert.equal((await missingCustom.json()).error, 'CUSTOM_SOURCE_URL_REQUIRED');

  const accountResponse = await client.request('/account', { headers: { Cookie: csrf.cookie } });
  const accountPayload = await accountResponse.json();
  assert.equal(accountPayload.profile.playbackSource, 'ccustom');
  assert.equal(accountPayload.profile.customSourceManifestUrl, 'https://addons.example.test/custom/manifest.json');

  for (const source of ['ccustom', 'cider']) {
    if (source === 'cider') {
      const saved = await saveSource('cider');
      assert.equal(saved.status, 200);
    }
    const created = await client.request('/rooms', {
      method: 'POST',
      headers: csrf.headers,
      body: JSON.stringify({
        roomName: source === 'cider' ? 'Cider Source Party' : 'CCustom Source Party',
        visibility: 'public',
        partySize: 4,
        ownerOnlyControls: false
      })
    });
    const roomPayload = await created.json();
    assert.equal(created.status, 201);
    assert.equal(roomPayload.room.playbackSource, source);

    const hostHeaders = { ...csrf.headers, Authorization: 'Bearer ' + roomPayload.hostCredential };
    const track = {
      source,
      id: source + '-catalog-track-01',
      title: 'Selected Source Track',
      artist: 'BitCider Test',
      durationSeconds: 205,
      artworkURL: 'https://cdn.example.test/party-source-artwork.jpg',
      audioQuality: 'Lossless'
    };
    const queued = await client.request('/rooms/' + roomPayload.room.roomId + '/queue', {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ action: 'add', track })
    });
    const queuePayload = await queued.json();
    assert.equal(queued.status, 200);
    assert.equal(queuePayload.queue[0].source, source);

    const playback = await client.request('/rooms/' + roomPayload.room.roomId + '/playback', {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({
        source,
        track,
        isPlaying: true,
        positionSeconds: 0
      })
    });
    const playbackPayload = await playback.json();
    assert.equal(playback.status, 200);
    assert.equal(playbackPayload.playbackState.source, source);
    assert.equal(playbackPayload.playbackState.track.source, source);
  }
});
