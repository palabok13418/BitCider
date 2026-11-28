import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startBitConnectionHostMediaTransport,
  startBitConnectionGuestTransport
} from './audio-transport.mjs';

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = 'live';
    this.stopped = false;
  }
  stop() { this.stopped = true; this.readyState = 'ended'; }
}

class FakeMediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

test('guest transport receives only the selected host audio stream', async () => {
  const remoteStream = new FakeMediaStream([new FakeTrack('audio')]);
  let remoteTrackHandler;
  const audioElement = {
    paused: true,
    playCalls: 0,
    async play() {
      assert.equal(this, audioElement);
      this.playCalls += 1;
      this.paused = false;
    },
    pause() { assert.equal(this, audioElement); this.paused = true; },
    set srcObject(value) { this._srcObject = value; },
    get srcObject() { return this._srcObject; }
  };
  const session = {
    role: 'guest',
    async getIceConfiguration() { return { iceServers: [], iceTransportPolicy: 'all' }; }
  };
  const transport = await startBitConnectionGuestTransport({
    session,
    audioElement,
    runtimeFactory: options => {
      remoteTrackHandler = options.onRemoteStream;
      return { start() {}, async stop() {} };
    }
  });
  remoteTrackHandler({ participantId: 'host-1', stream: remoteStream });
  await Promise.resolve();
  assert.equal(audioElement.srcObject, remoteStream);
  assert.equal(audioElement.autoplay, true);
  assert.equal(audioElement.playsInline, true);
  assert.equal(audioElement.muted, false);
  await transport.playAudio();
  await transport.stop();
  assert.equal(audioElement.srcObject, null);
  assert.equal(audioElement.paused, true);
});

test('BitMono, CCustom, and Cider media elements publish audio-only tracks to WebRTC', async () => {
  for (const source of ['bitmono', 'ccustom', 'cider']) {
    const audio = new FakeTrack('audio');
    const captured = new FakeMediaStream([audio]);
    const audioElement = {
      captureStreamCalls: 0,
      captureStream() {
        assert.equal(this, audioElement);
        this.captureStreamCalls += 1;
        return captured;
      }
    };
    const calls = [];
    const session = {
      role: 'host',
      async getIceConfiguration() {
        calls.push('ice');
        return { iceServers: [{ urls: 'stun:stun.example.test:3478' }], iceTransportPolicy: 'all' };
      }
    };
    let runtimeOptions;
    const transport = await startBitConnectionHostMediaTransport({
      session,
      audioElement,
      MediaStreamCtor: FakeMediaStream,
      runtimeFactory: options => {
        runtimeOptions = options;
        return { start() { calls.push('start'); }, async stop() { calls.push('stop'); } };
      }
    });
    assert.equal(audioElement.captureStreamCalls, 1, source);
    assert.deepEqual(calls, ['ice', 'start'], source);
    assert.deepEqual(runtimeOptions.localStream.getAudioTracks(), [audio], source);
    assert.deepEqual(runtimeOptions.localStream.getVideoTracks(), [], source);
    await transport.stop();
    assert.equal(audio.stopped, true, source);
    assert.ok(calls.includes('stop'), source);
  }
});

test('host media transport rejects non-host sessions and players without audio', async () => {
  await assert.rejects(startBitConnectionHostMediaTransport({
    session: { role: 'guest', async getIceConfiguration() { return {}; } },
    audioElement: { captureStream() { return new FakeMediaStream([new FakeTrack('audio')]); } },
    MediaStreamCtor: FakeMediaStream
  }), /authenticated BitConnection host/);
  await assert.rejects(startBitConnectionHostMediaTransport({
    session: { role: 'host', async getIceConfiguration() { return {}; } },
    audioElement: { captureStream() { return new FakeMediaStream([]); } },
    MediaStreamCtor: FakeMediaStream
  }), /audio track/);
});
