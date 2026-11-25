import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BitConnectionApiClient,
  BitConnectionPartyRuntime,
  BitConnectionPeerMesh
} from '../src/bitconnection/realtime-client.mjs';

class FakePeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.addedTracks = [];
    this.iceCandidates = [];
    this.connectionState = 'new';
  }
  addTrack(track, stream) {
    this.addedTracks.push({ track, stream });
  }
  async createOffer() {
    return { type: 'offer', sdp: 'host-offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'guest-answer' };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate) {
    this.iceCandidates.push(candidate);
  }
  close() {
    this.connectionState = 'closed';
  }
}

test('room session sends its scoped credential and the correct account CSRF identity', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, volume: 0.4 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const client = new BitConnectionApiClient({
    baseUrl: '/api/bitconnection',
    csrfToken: 'guest-csrf-token',
    fetchImpl
  });
  const session = client.createGuestSession({
    room: { roomId: 'room-1' },
    participantId: 'participant-1',
    participantCredential: 'guest-secret-credential'
  });
  await session.setVolume(0.4);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/bitconnection/rooms/room-1/volume');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers.get('Authorization'), 'Bearer guest-secret-credential');
  assert.equal(calls[0].options.headers.get('X-BitConnection-CSRF'), 'guest-csrf-token');
  assert.equal(calls[0].options.headers.get('X-BitConnection-Identity'), null);
  assert.deepEqual(JSON.parse(calls[0].options.body), { volume: 0.4 });
});

test('BitCider reuse sends its explicit identity and Cider CSRF token on host room calls', async () => {
  const calls = [];
  const client = new BitConnectionApiClient({
    identityMode: 'bitcider',
    ciderCsrfToken: 'cider-csrf-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, expiresInSeconds: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const session = new (await import('../src/bitconnection/realtime-client.mjs')).BitConnectionRoomSession(client, {
    roomId: 'room-cider',
    participantId: 'host-participant',
    credential: 'host-secret-credential',
    role: 'host'
  });
  await client.setHostLocation(session, { latitude: 1, longitude: 2, accuracy: 5 });

  assert.equal(calls[0].options.headers.get('X-BitConnection-Identity'), 'bitcider');
  assert.equal(calls[0].options.headers.get('X-BitCider-CSRF'), 'cider-csrf-token');
  assert.equal(calls[0].options.headers.get('Authorization'), 'Bearer host-secret-credential');
});

test('host mesh creates one audio-only WebRTC offer per connected guest', async () => {
  const signals = [];
  const audioTrack = { kind: 'audio', id: 'player-audio' };
  const videoTrack = { kind: 'video', id: 'player-video' };
  const localStream = {
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack, videoTrack]
  };
  const session = {
    role: 'host',
    participantId: 'host-1',
    sendSignal: async (to, type, payload) => {
      signals.push({ to, type, payload });
      return { ok: true };
    }
  };
  const peers = [];
  const mesh = new BitConnectionPeerMesh({
    session,
    localStream,
    rtcConfiguration: { iceServers: [] },
    peerConnectionFactory: config => {
      const peer = new FakePeerConnection(config);
      peers.push(peer);
      return peer;
    }
  });

  const participants = [
    { participantId: 'host-1', role: 'host', status: 'connected' },
    { participantId: 'guest-1', role: 'guest', status: 'connected' },
    { participantId: 'guest-2', role: 'guest', status: 'disconnected' }
  ];
  await mesh.syncParticipants(participants);
  await mesh.syncParticipants(participants);

  assert.equal(peers.length, 1);
  assert.deepEqual(peers[0].addedTracks.map(item => item.track), [audioTrack]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].to, 'guest-1');
  assert.equal(signals[0].type, 'offer');
  assert.equal(signals[0].payload.type, 'offer');
  mesh.close();
  assert.equal(peers[0].connectionState, 'closed');
});

test('guest mesh buffers early ICE, answers the host offer, and exposes incoming audio', async () => {
  const signals = [];
  let peer;
  let remoteStream = null;
  const session = {
    role: 'guest',
    participantId: 'guest-1',
    sendSignal: async (to, type, payload) => {
      signals.push({ to, type, payload });
      return { ok: true };
    }
  };
  const mesh = new BitConnectionPeerMesh({
    session,
    peerConnectionFactory: config => {
      peer = new FakePeerConnection(config);
      return peer;
    },
    onRemoteStream: detail => { remoteStream = detail; }
  });

  await mesh.handleSignal({
    fromParticipantId: 'host-1',
    toParticipantId: 'guest-1',
    type: 'ice-candidate',
    payload: { candidate: 'candidate-before-offer' }
  });
  assert.equal(mesh.pendingIce.get('host-1').length, 1);

  await mesh.handleSignal({
    fromParticipantId: 'host-1',
    toParticipantId: 'guest-1',
    type: 'offer',
    payload: { type: 'offer', sdp: 'host-offer' }
  });
  assert.equal(peer.remoteDescription.type, 'offer');
  assert.equal(peer.iceCandidates.length, 1);
  assert.equal(peer.iceCandidates[0].candidate, 'candidate-before-offer');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'answer');
  assert.equal(signals[0].to, 'host-1');

  const stream = { id: 'received-audio' };
  peer.ontrack({ streams: [stream], track: { kind: 'audio' } });
  assert.equal(remoteStream.participantId, 'host-1');
  assert.equal(remoteStream.stream, stream);
  mesh.close();
});

test('party runtime schedules room state, signaling, and presence without overlapping its loops', async () => {
  const calls = { state: 0, signals: 0, heartbeat: 0, leave: 0, errors: 0, roomUpdates: 0 };
  const timers = new Map();
  const cleared = [];
  let nextTimer = 1;
  const session = {
    role: 'host',
    participantId: 'host-1',
    async getState() {
      calls.state += 1;
      return { participants: [{ participantId: 'host-1', role: 'host', status: 'connected' }] };
    },
    async pollSignals() {
      calls.signals += 1;
      return { messages: [], nextSequence: 0 };
    },
    async heartbeat() {
      calls.heartbeat += 1;
      return { ok: true };
    },
    async leave() {
      calls.leave += 1;
      return { ok: true };
    },
    async sendSignal() {
      return { ok: true };
    }
  };
  const runtime = new BitConnectionPartyRuntime({
    session,
    onRoomState: () => { calls.roomUpdates += 1; },
    onError: () => { calls.errors += 1; },
    setIntervalImpl: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearIntervalImpl: id => {
      cleared.push(id);
      timers.delete(id);
    },
    peerConnectionFactory: config => new FakePeerConnection(config)
  });

  runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.state, 1);
  assert.equal(calls.signals, 1);
  assert.equal(calls.heartbeat, 1);
  assert.equal(calls.roomUpdates, 1);
  assert.deepEqual([...timers.values()].map(item => item.delay), [2500, 1000, 25000]);

  for (const timer of timers.values()) timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.state, 2);
  assert.equal(calls.signals, 2);
  assert.equal(calls.heartbeat, 2);

  await runtime.stop({ leave: true });
  assert.equal(calls.leave, 1);
  assert.equal(timers.size, 0);
  assert.equal(cleared.length, 3);
  assert.equal(calls.errors, 0);
});
