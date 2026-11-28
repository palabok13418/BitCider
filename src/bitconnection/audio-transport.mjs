import { BitConnectionPartyRuntime } from './realtime-client.mjs';

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch { /* A track may already have ended. */ }
  }
}

function rtcOptions(iceConfiguration, overrides = {}) {
  return {
    ...overrides,
    iceServers: Array.isArray(iceConfiguration?.iceServers) ? iceConfiguration.iceServers : [],
    iceTransportPolicy: iceConfiguration?.iceTransportPolicy === 'relay' ? 'relay' : 'all',
    iceCandidatePoolSize: Number.isSafeInteger(overrides.iceCandidatePoolSize)
      ? overrides.iceCandidatePoolSize
      : 2
  };
}

/**
 * Receive the host's selected audio source. Guests never request screen,
 * display, window, or tab capture; they only receive the host's WebRTC stream.
 */
export async function startBitConnectionGuestTransport({
  session,
  audioElement,
  rtcConfiguration = {},
  onRoomState,
  onRemoteStream,
  onPeerState,
  onError = () => {},
  onAudioPlaybackBlocked = () => {},
  runtimeFactory = options => new BitConnectionPartyRuntime(options)
} = {}) {
  if (!session || session.role !== 'guest' || typeof session.getIceConfiguration !== 'function') {
    throw new TypeError('An authenticated BitConnection guest session is required.');
  }
  if (!audioElement) throw new TypeError('An audio element is required for the guest receiver.');

  const iceConfiguration = await session.getIceConfiguration();
  const runtime = runtimeFactory({
    session,
    rtcConfiguration: rtcOptions(iceConfiguration, rtcConfiguration),
    onRoomState,
    onPeerState,
    onError,
    onRemoteStream: ({ stream, ...detail }) => {
      audioElement.autoplay = true;
      audioElement.playsInline = true;
      audioElement.muted = false;
      audioElement.srcObject = stream;
      Promise.resolve().then(() => Reflect.apply(audioElement.play, audioElement, [])).catch(onAudioPlaybackBlocked);
      onRemoteStream?.({ stream, ...detail });
    }
  });
  runtime.start();

  return {
    runtime,
    iceConfiguration,
    playAudio() {
      if (typeof audioElement.play !== 'function') {
        return Promise.reject(new Error('The guest audio element does not support playback.'));
      }
      return Promise.resolve().then(() => Reflect.apply(audioElement.play, audioElement, []));
    },
    async stop({ leave = true } = {}) {
      await runtime.stop({ leave });
      if (typeof audioElement.pause === 'function') Reflect.apply(audioElement.pause, audioElement, []);
      audioElement.srcObject = null;
    }
  };
}

/**
 * Publish the audio output of an in-page player (BitMono, CCustom, or Cider).
 * This captures only the audio element's decoded audio track; it never opens
 * the browser display picker and cannot capture screen/window pixels.
 */
export async function startBitConnectionHostMediaTransport({
  session,
  audioElement,
  MediaStreamCtor = globalThis.MediaStream,
  rtcConfiguration = {},
  onRoomState,
  onRemoteStream,
  onPeerState,
  onError = () => {},
  runtimeFactory = options => new BitConnectionPartyRuntime(options)
} = {}) {
  if (!session || session.role !== 'host' || typeof session.getIceConfiguration !== 'function') {
    throw new TypeError('An authenticated BitConnection host session is required.');
  }
  if (!audioElement || typeof audioElement.captureStream !== 'function') {
    throw new Error('This browser cannot publish in-page audio to the party.');
  }
  if (typeof MediaStreamCtor !== 'function') {
    throw new Error('This browser does not support MediaStream audio publishing.');
  }

  const capturedStream = Reflect.apply(audioElement.captureStream, audioElement, []);
  const audioTracks = capturedStream?.getAudioTracks?.() || [];
  if (!audioTracks.length) {
    stopTracks(capturedStream);
    throw new Error('The selected source has no playable audio track yet.');
  }
  const audioStream = new MediaStreamCtor(audioTracks);
  let runtime;
  let iceConfiguration;
  try {
    iceConfiguration = await session.getIceConfiguration();
    runtime = runtimeFactory({
      session,
      rtcConfiguration: rtcOptions(iceConfiguration, rtcConfiguration),
      localStream: audioStream,
      onRoomState,
      onRemoteStream,
      onPeerState,
      onError
    });
    runtime.start();
  } catch (error) {
    stopTracks(capturedStream);
    if (audioStream !== capturedStream) stopTracks(audioStream);
    throw error;
  }

  let stopped = false;
  return {
    runtime,
    capture: { stream: audioStream, captureStream: capturedStream },
    iceConfiguration,
    async stop({ leave = false } = {}) {
      if (stopped) return null;
      stopped = true;
      stopTracks(capturedStream);
      if (audioStream !== capturedStream) stopTracks(audioStream);
      await runtime.stop({ leave });
      return null;
    }
  };
}
