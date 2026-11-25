const DEFAULT_API_BASE = '/api/bitconnection';

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `BitConnection request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.error || 'BITCONNECTION_REQUEST_FAILED';
    throw error;
  }
  return payload;
}

function participantCredentialHeaders(credential) {
  return credential ? { Authorization: 'Bearer ' + credential } : {};
}

/**
 * Browser-side API client for BitConnection room creation and guest admission.
 * Keep this class independent of the room's visual interface.
 */
export class BitConnectionApiClient {
  constructor({
    baseUrl = DEFAULT_API_BASE,
    csrfToken,
    identityMode = 'bitconnection',
    ciderCsrfToken = '',
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.csrfToken = String(csrfToken || '');
    this.identityMode = identityMode === 'bitcider' ? 'bitcider' : 'bitconnection';
    this.ciderCsrfToken = String(ciderCsrfToken || '');
    this.fetchImpl = fetchImpl;
  }

  identityHeaders() {
    if (this.identityMode === 'bitcider') {
      return {
        'X-BitConnection-Identity': 'bitcider',
        'X-BitCider-CSRF': this.ciderCsrfToken
      };
    }
    return { 'X-BitConnection-CSRF': this.csrfToken };
  }

  async request(path, { method = 'GET', body, session = null, signal } = {}) {
    const headers = new Headers(this.identityHeaders());
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    Object.entries(participantCredentialHeaders(session?.credential)).forEach(([key, value]) => headers.set(key, value));
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {})
    });
    return readJson(response);
  }

  createRoom(settings) {
    return this.request('/rooms', { method: 'POST', body: settings });
  }

  createHostSession(createdRoom) {
    if (!createdRoom?.room?.roomId || !createdRoom?.hostParticipantId || !createdRoom?.hostCredential) {
      throw new TypeError('The room creation response is missing its host session credentials.');
    }
    return new BitConnectionRoomSession(this, {
      roomId: createdRoom.room.roomId,
      participantId: createdRoom.hostParticipantId,
      credential: createdRoom.hostCredential,
      role: 'host'
    });
  }

  async joinRoom({ roomId, roomCode, inviteToken, location } = {}) {
    const lookup = roomId || roomCode;
    if (!lookup) throw new TypeError('A room ID or room code is required.');
    const body = {
      ...(roomCode ? { roomCode } : {}),
      ...(inviteToken ? { inviteToken } : {}),
      ...(location ? { location } : {})
    };
    const result = await this.request('/rooms/' + encodeSegment(lookup) + '/join', {
      method: 'POST',
      body
    });
    if (result.participantCredential && result.participantId) {
      result.session = this.createGuestSession(result);
    }
    return result;
  }

  getJoinStatus(roomId, requestId) {
    return this.request('/rooms/' + encodeSegment(roomId) + '/join-status/' + encodeSegment(requestId));
  }

  verifyJoin(roomId, requestId, code) {
    return this.request('/rooms/' + encodeSegment(roomId) + '/verify', {
      method: 'POST',
      body: { requestId, code }
    }).then(result => ({
      ...result,
      session: this.createGuestSession(result, roomId)
    }));
  }

  createGuestSession(joined, roomId = joined?.room?.roomId) {
    if (!roomId || !joined?.participantId || !joined?.participantCredential) {
      throw new TypeError('The guest admission response is missing its room session credentials.');
    }
    return new BitConnectionRoomSession(this, {
      roomId,
      participantId: joined.participantId,
      credential: joined.participantCredential,
      role: 'guest'
    });
  }

  getVerificationRequests(session) {
    return this.request('/rooms/' + encodeSegment(session.roomId) + '/verification-requests', { session });
  }

  setHostLocation(session, location) {
    if (session?.role !== 'host') throw new Error('Only the host can publish an approximate room location.');
    return this.request('/rooms/' + encodeSegment(session.roomId) + '/location', {
      method: 'POST',
      body: { location },
      session
    });
  }

  closeRoom(roomId) {
    return this.request('/rooms/' + encodeSegment(roomId) + '/close', { method: 'POST' });
  }
}

/**
 * A participant's authenticated room API session. Temporary guest credentials
 * are only held in memory by this object and are not written to browser storage.
 */
export class BitConnectionRoomSession {
  constructor(client, { roomId, participantId, credential, role }) {
    if (!client || !roomId || !participantId || !credential) {
      throw new TypeError('A room ID, participant ID, credential, and API client are required.');
    }
    this.client = client;
    this.roomId = String(roomId);
    this.participantId = String(participantId);
    this.credential = String(credential);
    this.role = role === 'host' ? 'host' : 'guest';
  }

  getState() {
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/state', { session: this });
  }

  heartbeat() {
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/heartbeat', {
      method: 'POST',
      session: this
    });
  }

  updatePlayback(update) {
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/playback', {
      method: 'POST',
      body: update,
      session: this
    });
  }

  updateQueue(action) {
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/queue', {
      method: 'POST',
      body: action,
      session: this
    });
  }

  setVolume(volume) {
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/volume', {
      method: 'POST',
      body: { volume },
      session: this
    });
  }

  sendSignal(toParticipantId, type, payload = {}) {
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/signals', {
      method: 'POST',
      body: { toParticipantId, type, payload },
      session: this
    });
  }

  pollSignals(after = 0, options = {}) {
    const query = new URLSearchParams({ after: String(Math.max(0, Number(after) || 0)) });
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/signals?' + query, {
      session: this,
      signal: options.signal
    });
  }

  leave() {
    return this.client.request('/rooms/' + encodeSegment(this.roomId) + '/leave', {
      method: 'POST',
      session: this
    });
  }
}

function descriptionObject(description) {
  if (!description) return null;
  if (typeof description.toJSON === 'function') return description.toJSON();
  return { type: description.type, sdp: description.sdp };
}

function candidateObject(candidate) {
  if (!candidate) return null;
  if (typeof candidate.toJSON === 'function') return candidate.toJSON();
  return candidate;
}

/**
 * Host-to-guest WebRTC mesh. The host publishes audio tracks only; the server
 * carries signaling messages but never receives or forwards media.
 *
 * The caller supplies an audio-only or mixed MediaStream obtained from the
 * BitChord player adapter, and schedules pollSignals()/syncParticipants()
 * according to the room's presence refresh cadence.
 */
export class BitConnectionPeerMesh {
  constructor({
    session,
    rtcConfiguration = {},
    peerConnectionFactory = (...args) => new RTCPeerConnection(...args),
    localStream = null,
    onRemoteStream = () => {},
    onPeerState = () => {},
    onError = () => {}
  } = {}) {
    if (!session || !['host', 'guest'].includes(session.role)) {
      throw new TypeError('A host or guest room session is required.');
    }
    if (typeof peerConnectionFactory !== 'function') throw new TypeError('A peer connection factory is required.');
    this.session = session;
    this.role = session.role;
    this.rtcConfiguration = rtcConfiguration;
    this.peerConnectionFactory = peerConnectionFactory;
    this.localStream = localStream;
    this.onRemoteStream = onRemoteStream;
    this.onPeerState = onPeerState;
    this.onError = onError;
    this.peers = new Map();
    this.pendingIce = new Map();
    this.signalSequence = 0;
  }

  setLocalStream(stream) {
    this.localStream = stream;
  }

  createPeer(participantId) {
    const existing = this.peers.get(participantId);
    if (existing) return existing;
    const connection = this.peerConnectionFactory(this.rtcConfiguration);
    this.peers.set(participantId, connection);

    if (this.role === 'host' && this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        connection.addTrack(track, this.localStream);
      }
    }

    connection.onicecandidate = event => {
      if (!event.candidate) return;
      this.session.sendSignal(participantId, 'ice-candidate', candidateObject(event.candidate))
        .catch(error => this.onError(error));
    };
    connection.ontrack = event => {
      if (this.role !== 'guest') return;
      let stream = event.streams?.[0] || null;
      if (!stream && typeof MediaStream === 'function') stream = new MediaStream([event.track]);
      if (stream) this.onRemoteStream({ participantId, stream, track: event.track });
    };
    connection.onconnectionstatechange = () => {
      this.onPeerState({ participantId, state: connection.connectionState || 'unknown' });
    };
    return connection;
  }

  async connectToGuest(participantId) {
    if (this.role !== 'host') throw new Error('Only the host initiates guest audio connections.');
    if (this.peers.has(participantId)) return false;
    const connection = this.createPeer(participantId);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await this.session.sendSignal(participantId, 'offer', descriptionObject(connection.localDescription || offer));
    return true;
  }

  async syncParticipants(participants = []) {
    if (this.role !== 'host') return;
    const liveGuests = new Set(participants
      .filter(item => item?.role === 'guest' && item.status === 'connected')
      .map(item => item.participantId)
      .filter(Boolean));

    for (const participantId of liveGuests) {
      if (!this.peers.has(participantId)) await this.connectToGuest(participantId);
    }
    for (const participantId of this.peers.keys()) {
      const participant = participants.find(item => item?.participantId === participantId);
      if (!participant || participant.status === 'left') this.closePeer(participantId);
    }
  }

  async handleSignal(message) {
    const remoteId = String(message?.fromParticipantId || '');
    if (!remoteId || message?.toParticipantId && message.toParticipantId !== this.session.participantId) return;
    const type = message.type;
    if (type === 'hangup') {
      this.closePeer(remoteId);
      return;
    }

    if (type === 'ice-candidate') {
      const connection = this.peers.get(remoteId);
      if (!connection || !connection.remoteDescription) {
        const pending = this.pendingIce.get(remoteId) || [];
        pending.push(message.payload);
        this.pendingIce.set(remoteId, pending);
        return;
      }
      await connection.addIceCandidate(message.payload);
      return;
    }

    if (type === 'offer') {
      if (this.role !== 'guest') return;
      const connection = this.createPeer(remoteId);
      await connection.setRemoteDescription(message.payload);
      await this.flushPendingIce(remoteId, connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.session.sendSignal(remoteId, 'answer', descriptionObject(connection.localDescription || answer));
      return;
    }

    if (type === 'answer') {
      if (this.role !== 'host') return;
      const connection = this.peers.get(remoteId);
      if (!connection) return;
      await connection.setRemoteDescription(message.payload);
      await this.flushPendingIce(remoteId, connection);
      return;
    }

    if (type === 'renegotiate' && this.role === 'guest') {
      const connection = this.peers.get(remoteId);
      if (!connection) return;
      await connection.setRemoteDescription(message.payload);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.session.sendSignal(remoteId, 'answer', descriptionObject(connection.localDescription || answer));
    }
  }

  async flushPendingIce(participantId, connection) {
    const pending = this.pendingIce.get(participantId) || [];
    this.pendingIce.delete(participantId);
    for (const candidate of pending) await connection.addIceCandidate(candidate);
  }

  async pollSignals(options = {}) {
    const result = await this.session.pollSignals(this.signalSequence, options);
    for (const message of result.messages || []) {
      await this.handleSignal(message);
      this.signalSequence = Math.max(this.signalSequence, Number(message.sequence) || 0);
    }
    this.signalSequence = Math.max(this.signalSequence, Number(result.nextSequence) || 0);
    return result.messages || [];
  }

  closePeer(participantId) {
    const connection = this.peers.get(participantId);
    if (connection) connection.close();
    this.peers.delete(participantId);
    this.pendingIce.delete(participantId);
  }

  close() {
    for (const participantId of this.peers.keys()) this.closePeer(participantId);
  }
}

/**
 * Coordinates the room's lightweight REST presence/sync loop and WebRTC
 * signaling. A UI can subscribe to room state and remote streams without
 * needing to know the polling or peer-negotiation details.
 */
export class BitConnectionPartyRuntime {
  constructor({
    session,
    rtcConfiguration = {},
    localStream = null,
    onRoomState = () => {},
    onRemoteStream = () => {},
    onPeerState = () => {},
    onError = () => {},
    stateIntervalMs = 2500,
    signalIntervalMs = 1000,
    heartbeatIntervalMs = 25000,
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
    peerConnectionFactory
  } = {}) {
    if (!session || typeof session.getState !== 'function'
      || typeof session.heartbeat !== 'function'
      || typeof session.pollSignals !== 'function') {
      throw new TypeError('A complete BitConnection room session is required.');
    }
    if (![stateIntervalMs, signalIntervalMs, heartbeatIntervalMs].every(
      value => Number.isFinite(value) && value >= 250
    )) throw new TypeError('Room runtime intervals must be at least 250 milliseconds.');
    if (typeof setIntervalImpl !== 'function' || typeof clearIntervalImpl !== 'function') {
      throw new TypeError('Timer functions are required.');
    }

    this.session = session;
    this.onRoomState = onRoomState;
    this.onError = onError;
    this.stateIntervalMs = stateIntervalMs;
    this.signalIntervalMs = signalIntervalMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timers = [];
    this.running = false;
    this.stateRequestPending = false;
    this.signalRequestPending = false;
    this.heartbeatPending = false;
    this.mesh = new BitConnectionPeerMesh({
      session,
      rtcConfiguration,
      localStream,
      peerConnectionFactory,
      onRemoteStream,
      onPeerState,
      onError
    });
  }

  start() {
    if (this.running) return this;
    this.running = true;
    void this.refreshRoomState();
    void this.refreshSignals();
    void this.sendHeartbeat();
    this.timers = [
      this.setIntervalImpl(() => { void this.refreshRoomState(); }, this.stateIntervalMs),
      this.setIntervalImpl(() => { void this.refreshSignals(); }, this.signalIntervalMs),
      this.setIntervalImpl(() => { void this.sendHeartbeat(); }, this.heartbeatIntervalMs)
    ];
    return this;
  }

  async refreshRoomState() {
    if (!this.running || this.stateRequestPending) return null;
    this.stateRequestPending = true;
    try {
      const state = await this.session.getState();
      if (this.running) {
        this.onRoomState(state);
        if (this.session.role === 'host') await this.mesh.syncParticipants(state.participants || []);
      }
      return state;
    } catch (error) {
      this.onError(error);
      return null;
    } finally {
      this.stateRequestPending = false;
    }
  }

  async refreshSignals() {
    if (!this.running || this.signalRequestPending) return [];
    this.signalRequestPending = true;
    try {
      return await this.mesh.pollSignals();
    } catch (error) {
      this.onError(error);
      return [];
    } finally {
      this.signalRequestPending = false;
    }
  }

  async sendHeartbeat() {
    if (!this.running || this.heartbeatPending) return null;
    this.heartbeatPending = true;
    try {
      return await this.session.heartbeat();
    } catch (error) {
      this.onError(error);
      return null;
    } finally {
      this.heartbeatPending = false;
    }
  }

  setLocalStream(stream) {
    this.mesh.setLocalStream(stream);
  }

  async stop({ leave = false } = {}) {
    const wasRunning = this.running;
    this.running = false;
    for (const timer of this.timers) this.clearIntervalImpl(timer);
    this.timers = [];
    this.mesh.close();
    if (leave && wasRunning) return this.session.leave();
    return null;
  }
}
