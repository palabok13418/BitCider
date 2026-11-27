const HLS_MIME_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
]);

function parseUrl(value) {
  try {
    return new URL(String(value || ''), globalThis.location?.href || 'http://localhost/');
  } catch {
    return null;
  }
}

export function isHlsStream(source, mimeType = '') {
  const url = parseUrl(source);
  const pathname = url?.pathname || '';
  const mime = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  return /\.m3u8$/i.test(pathname) || HLS_MIME_TYPES.has(mime);
}

function isSecureServiceUrl(value, label) {
  const url = parseUrl(value);
  const local = url && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if (!url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new TypeError(label + ' must be an HTTPS URL.');
  }
  return url.href;
}

export function validateFairPlayConfig(fairPlay) {
  if (fairPlay && typeof fairPlay === 'object'
    && ('mediaUserToken' in fairPlay || 'userMediaToken' in fairPlay)) {
    throw new TypeError('Apple Music Media-User-Token is subscriber authentication, not a FairPlay license or content key.');
  }
  if (!fairPlay || typeof fairPlay !== 'object') {
    throw new TypeError('FairPlay playback requires an authorized provider configuration.');
  }
  const licenseServerUri = isSecureServiceUrl(fairPlay.licenseServerUri, 'FairPlay license server');
  const serverCertificateUri = fairPlay.serverCertificateUri
    ? isSecureServiceUrl(fairPlay.serverCertificateUri, 'FairPlay server certificate')
    : '';
  const serverCertificate = fairPlay.serverCertificate;
  const hasCertificateBytes = serverCertificate instanceof ArrayBuffer
    || ArrayBuffer.isView(serverCertificate);
  if (!serverCertificateUri && !hasCertificateBytes) {
    throw new TypeError('FairPlay playback requires the provider server certificate.');
  }
  return { licenseServerUri, serverCertificateUri, serverCertificate: hasCertificateBytes ? serverCertificate : null };
}

export function chooseStreamEngine({
  hls = false,
  fairPlay = false,
  hlsJsSupported = false,
  nativeHlsSupported = false
} = {}) {
  if (!hls) return 'native';
  if (fairPlay) return 'shaka-fairplay';
  if (hlsJsSupported) return 'hls.js';
  if (nativeHlsSupported) return 'native-hls';
  return 'unsupported';
}

function clearMediaSource(media) {
  try {
    media.pause();
    media.removeAttribute('src');
    media.load();
  } catch {
    // The element may already have been detached during route teardown.
  }
}

/**
 * Attach an audio or video source to the BitCider media element.
 *
 * HLS.js handles clear HLS where Media Source Extensions are available.
 * Shaka handles FairPlay only when the content provider supplies its own
 * authorized license endpoint and server certificate. This intentionally
 * does not treat an Apple Music Media-User-Token as a FairPlay license key.
 */
export async function attachBitCiderStream(media, source, {
  mimeType = '',
  fairPlay = null,
  onError = () => {},
  hlsConfig = {}
} = {}) {
  if (!media || typeof media.load !== 'function' || typeof media.play !== 'function') {
    throw new TypeError('A valid HTML media element is required.');
  }
  const url = parseUrl(source);
  if (!url || !['http:', 'https:', 'blob:'].includes(url.protocol)) {
    throw new TypeError('The media source must be an HTTP(S) or blob URL.');
  }

  const hls = isHlsStream(url.href, mimeType);
  if (!hls) {
    media.src = url.href;
    media.load();
    return {
      engine: 'native',
      async destroy() { clearMediaSource(media); }
    };
  }

  if (fairPlay) {
    const fairPlayConfig = validateFairPlayConfig(fairPlay);
    const module = await import('shaka-player');
    const shaka = module.default || module;
    shaka.polyfill?.installAll?.();
    if (shaka.Player?.isBrowserSupported && !shaka.Player.isBrowserSupported()) {
      throw new Error('This browser does not support the FairPlay playback engine.');
    }

    const player = new shaka.Player();
    player.addEventListener?.('error', event => {
      const detail = event?.detail || event;
      onError(detail instanceof Error ? detail : new Error('FairPlay playback encountered an error.'));
    });
    try {
      await player.attach(media);
      const keySystems = ['com.apple.fps', 'com.apple.fps.1_0'];
      const servers = Object.fromEntries(keySystems.map(key => [key, fairPlayConfig.licenseServerUri]));
      const advanced = Object.fromEntries(keySystems.map(key => [key, fairPlayConfig.serverCertificateUri
        ? { serverCertificateUri: fairPlayConfig.serverCertificateUri }
        : { serverCertificate: new Uint8Array(fairPlayConfig.serverCertificate) }]));
      player.configure({ drm: { servers, advanced } });

      if (typeof fairPlay.contentIdFromSkdUri === 'function') {
        player.configure('drm.initDataTransform', (initData, initDataType, drmInfo) => {
          if (initDataType !== 'skd') return initData;
          const skdUri = shaka.util.StringUtils.fromBytesAutoDetect(initData);
          const contentId = fairPlay.contentIdFromSkdUri(skdUri);
          return shaka.drm.FairPlay.initDataTransform(initData, contentId, drmInfo?.serverCertificate);
        });
      }
      await player.load(url.href);
      return {
        engine: 'shaka-fairplay',
        player,
        async destroy() {
          await player.destroy();
          clearMediaSource(media);
        }
      };
    } catch (error) {
      await player.destroy().catch(() => {});
      clearMediaSource(media);
      throw error;
    }
  }

  const module = await import('hls.js');
  const Hls = module.default || module;
  if (Hls.isSupported?.()) {
    const instance = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 45,
      ...hlsConfig
    });
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        onError(new Error(data.details || data.type || 'HLS playback encountered a fatal error.'));
      }
    });
    instance.loadSource(url.href);
    instance.attachMedia(media);
    return {
      engine: 'hls.js',
      player: instance,
      async destroy() {
        instance.destroy();
        clearMediaSource(media);
      }
    };
  }

  if (typeof media.canPlayType === 'function'
    && media.canPlayType('application/vnd.apple.mpegurl')) {
    media.src = url.href;
    media.load();
    return {
      engine: 'native-hls',
      async destroy() { clearMediaSource(media); }
    };
  }

  throw new Error('This browser cannot play this HLS stream. Try Safari or a browser with Media Source Extensions.');
}
