import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureBitChordTabAudio,
  startBitConnectionHostTransport,
  startBitConnectionHostMediaTransport,
  startBitConnectionGuestTransport
} from './audio-transport.mjs';

class FakeTrack {
  constructor(kind, displaySurface = '') {
    this.kind = kind;
    this.id = kind + '-track';
    this.readyState = 'live';
    this.stopped = false;
    this.settings = displaySurface ? { displaySurface } : {};
    this.listeners = new Map();
  }
  getSettings() { return this.settings; }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
    for (const callback of this.listeners.get('ended') || []) callback();
  }
}

class FakeMediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

function captureDevicesFor(stream, calls = []) {
  return {
    calls,
    getDisplayMedia: async options => {
      calls.push(options);
      return stream;
    }
  };
}

test('tab audio capture keeps only audio for WebRTC and retains local video capture track', async () => {
  const audio = new FakeTrack('audio');
  const video = new FakeTrack('video', 'browser');
  const captureStream = new FakeMediaStream([video, audio]);
  const calls = [];
  const capture = await captureBitChordTabAudio({
    mediaDevices: captureDevicesFor(captureStream, calls),
    MediaStreamCtor: FakeMediaStream
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].video.displaySurface, 'browser');
  assert.equal(calls[0].systemAudio, 'exclude');
  assert.equal(calls[0].monitorTypeSurfaces, 'exclude');
  assert.deepEqual(capture.stream.getTracks(), [audio]);
  assert.equal(video.stopped, false);
  capture.stop();
  assert.equal(audio.stopped, true);
  assert.equal(video.stopped, true);
});

test('tab audio capture rejects a desktop/window surface and stops all captured tracks', async () => {
  const audio = new FakeTrack('audio');
  const video = new FakeTrack('video', 'monitor');
  const captureStream = new FakeMediaStream([video, audio]);
  await assert.rejects(captureBitChordTabAudio({
    mediaDevices: captureDevicesFor(captureStream),
    MediaStreamCtor: FakeMediaStream
  }), /browser tab/);
  assert.equal(audio.stopped, true);
  assert.equal(video.stopped, true);
});

test('tab audio capture explains when the user did not enable Share tab audio', async () => {
  const video = new FakeTrack('video', 'browser');
  await assert.rejects(captureBitChordTabAudio({
    mediaDevices: captureDevicesFor(new FakeMediaStream([video])),
    MediaStreamCtor: FakeMediaStream
  }), /Share tab audio/);
  assert.equal(video.stopped, true);
});

test('host transport obtains ICE config and starts an audio-only WebRTC runtime', async () => {
  const audio = new FakeTrack('audio');
  const video = new FakeTrack('video', 'browser');
  const calls = [];
  const session = {
    role: 'host',
    async getIceConfiguration() {
      calls.push('ice');
      return { iceServers: [{ urls: 'stun:stun.example.test:3478' }], iceTransportPolicy: 'all', relayAvailable: false };
    }
  };
  let runtimeOptions;
  const transport = await startBitConnectionHostTransport({
    session,
    mediaDevices: {
      getDisplayMedia(options) {
        calls.push('capture');
        return Promise.resolve(new FakeMediaStream([video, audio]));
      }
    },
    MediaStreamCtor: FakeMediaStream,
    runtimeFactory: options => {
      runtimeOptions = options;
      return { start() { calls.push('start'); }, async stop() { calls.push('stop'); } };
    }
  });
  assert.deepEqual(calls, ['capture', 'ice', 'start']);
  assert.deepEqual(runtimeOptions.localStream.getTracks(), [audio]);
  assert.deepEqual(runtimeOptions.rtcConfiguration.iceServers, [{ urls: 'stun:stun.example.test:3478' }]);
  await transport.stop();
  assert.ok(calls.includes('stop'));
  assert.equal(audio.stopped, true);
  assert.equal(video.stopped, true);
});

test('guest transport attaches remote stream to the audio element and exposes gesture playback', async () => {
  const remoteStream = new FakeMediaStream([new FakeTrack('audio')]);
  let remoteTrackHandler;
  const audioElement = {
    paused: true,
    playCalls: 0,
    async play() { this.playCalls += 1; this.paused = false; },
    pause() { this.paused = true; },
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


test('host media transport publishes the captured audio-element track to guests', async () => {
  const audio = new FakeTrack('audio');
  const captured = new FakeMediaStream([audio]);
  const audioElement = {
    captureStreamCalls: 0,
    captureStream() { this.captureStreamCalls += 1; return captured; }
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
  assert.equal(audioElement.captureStreamCalls, 1);
  assert.deepEqual(calls, ['ice', 'start']);
  assert.deepEqual(runtimeOptions.localStream.getAudioTracks(), [audio]);
  assert.deepEqual(runtimeOptions.localStream.getVideoTracks(), []);
  await transport.stop();
  assert.equal(audio.stopped, true);
  assert.ok(calls.includes('stop'));
});

test('host media transport rejects non-host sessions and missing audio output', async () => {
  await assert.rejects(startBitConnectionHostMediaTransport({
    session: { role: 'guest', async getIceConfiguration() { return {}; } },
    audioElement: { captureStream() { return new FakeMediaStream([new FakeTrack('audio')]); } },
    MediaStreamCtor: FakeMediaStream
  }), /authenticated BitConnection host/);
  await assert.rejects(startBitConnectionHostMediaTransport({
    session: { role: 'host', async getIceConfiguration() { return {}; } },
    audioElement: { captureStream() { return new FakeMediaStream([]); } },
    MediaStreamCtor: FakeMediaStream
  }), /no audio track/);
});
