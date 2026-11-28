import { BitConnectionPartyRuntime } from './realtime-client.mjs';

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch { /* A track may already have ended. */ }
  }
}

/**
 * Request only the audio output from a browser tab. Screen/window/monitor
 * capture is rejected even when a browser ignores the picker-surface hints.
 * The capture video track stays local because getDisplayMedia requires video.
 */
export async function captureBitChordTabAudio({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaStreamCtor = globalThis.MediaStream
} = {}) {
  if (typeof mediaDevices?.getDisplayMedia !== 'function') {
    throw new Error('This browser does not support tab audio sharing.');
  }
  if (typeof MediaStreamCtor !== 'function') {
    throw new Error('This browser does not support MediaStream audio sharing.');
  }

  // Invoke synchronously from the button handler so the native share picker
  // receives the browser's transient user activation.
  const captureStream = await Reflect.apply(mediaDevices.getDisplayMedia, mediaDevices, [{
    video: { displaySurface: 'browser' },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    selfBrowserSurface: 'exclude',
    systemAudio: 'exclude',
    windowAudio: 'exclude',
    monitorTypeSurfaces: 'exclude',
    surfaceSwitching: 'exclude'
  }]);

  const tracks = captureStream?.getTracks?.() || [];
  const videoTrack = captureStream?.getVideoTracks?.()[0] || null;
  const displaySurface = videoTrack?.getSettings?.()?.displaySurface || '';
  const audioTracks = captureStream?.getAudioTracks?.() || [];
  if (!videoTrack || displaySurface !== 'browser') {
    stopTracks(captureStream);
    throw new Error('Choose the BitChord Web browser tab in the share picker. Window and screen sharing are disabled.');
  }
  if (!audioTracks.length) {
    stopTracks(captureStream);
    throw new Error('Select the BitChord Web tab and enable “Share tab audio” in the browser picker.');
  }

  const audioStream = new MediaStreamCtor(audioTracks);
  const endedListeners = new Set();
  let ended = tracks.some(track => track.readyState === 'ended');
  let stopped = false;
  const notifyEnded = () => {
    if (ended || stopped) return;
    ended = true;
    for (const listener of [...endedListeners]) listener();
    endedListeners.clear();
  };
  for (const track of tracks) {
    if (typeof track.addEventListener === 'function') track.addEventListener('ended', notifyEnded);
    else track.onended = notifyEnded;
  }

  return {
    stream: audioStream,
    captureStream,
    videoTrack,
    onEnded(callback) {
      if (typeof callback !== 'function') return () => {};
      if (ended) {
        callback();
        return () => {};
      }
      endedListeners.add(callback);
      return () => endedListeners.delete(callback);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      endedListeners.clear();
      stopTracks(captureStream);
    }
  };
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
 * Start host presence/signaling and publish only the selected BitChord tab's
 * audio tracks. Capture is requested before the first network await.
 */
export async function startBitConnectionHostTransport({
  session,
  mediaDevices,
  MediaStreamCtor,
  rtcConfiguration = {},
  onRoomState,
  onRemoteStream,
  onPeerState,
  onError = () => {},
  onCaptureEnded = () => {},
  runtimeFactory = options => new BitConnectionPartyRuntime(options)
} = {}) {
  if (!session || session.role !== 'host' || typeof session.getIceConfiguration !== 'function') {
    throw new TypeError('An authenticated BitConnection host session is required.');
  }

  const capturePromise = captureBitChordTabAudio({ mediaDevices, MediaStreamCtor });
  let capture = null;
  try {
    capture = await capturePromise;
    const iceConfiguration = await session.getIceConfiguration();
    const runtime = runtimeFactory({
      session,
      rtcConfiguration: rtcOptions(iceConfiguration, rtcConfiguration),
      localStream: capture.stream,
      onRoomState,
      onRemoteStream,
      onPeerState,
      onError
    });
    runtime.start();

    let stopped = false;
    let unsubscribeEnded = () => {};
    const stop = async ({ leave = false } = {}) => {
      if (stopped) return null;
      stopped = true;
      unsubscribeEnded();
      capture.stop();
      await runtime.stop({ leave });
      return null;
    };
    unsubscribeEnded = capture.onEnded(() => {
      void stop({ leave: false }).then(() => onCaptureEnded());
    });

    return { runtime, capture, iceConfiguration, stop };
  } catch (error) {
    capture?.stop();
    throw error;
  }
}

/**
 * Prepare the browser Guest View's audio receiver. Playback may need an
 * explicit user gesture, so playAudio() remains available to its UI.
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
 * Publish an in-page audio element (for example a fully resolved BitMono
 * stream) to party guests without opening the tab-capture permission picker.
 * The caller must invoke this directly from the host's explicit Play action.
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
    throw new Error('This browser does not support MediaStream audio sharing.');
  }

  const capturedStream = Reflect.apply(audioElement.captureStream, audioElement, []);
  const audioTracks = capturedStream?.getAudioTracks?.() || [];
  if (!audioTracks.length) {
    stopTracks(capturedStream);
    throw new Error('The BitMono audio player has no audio track to share. Start playback and try again.');
  }
  const audioStream = new MediaStreamCtor(audioTracks);
  let iceConfiguration;
  let runtime;
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
