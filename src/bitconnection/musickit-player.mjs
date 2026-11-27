const DEFAULT_MUSICKIT_SCRIPT = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
let scriptPromise = null;
let configuredTokenFingerprint = '';

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function musicKitQueueDescriptor(track = {}) {
  const candidate = cleanString(track.url || track.appleMusicUrl, 1000);
  if (candidate) {
    let url;
    try { url = new URL(candidate); } catch { throw new TypeError('The Apple Music song URL is invalid.'); }
    if (url.protocol !== 'https:' || !/(^|\.)music\.apple\.com$/i.test(url.hostname)) {
      throw new TypeError('Only Apple Music catalog URLs can be played through MusicKit.');
    }
    return { url: url.href };
  }

  const songId = cleanString(track.id || track.appleMusicSongId, 40);
  if (songId && /^\d{1,20}$/.test(songId)) return { song: songId };
  throw new TypeError('This Apple Music item does not include a playable catalog song ID or URL.');
}

export function normalizeAppleCatalogTrack(track = {}) {
  const id = cleanString(track.id || track.appleMusicSongId, 40);
  if (!/^\d{1,20}$/.test(id)) throw new TypeError('A valid Apple Music catalog song ID is required.');
  return {
    id,
    type: 'apple-music',
    title: cleanString(track.title || track.name, 180) || 'Apple Music track',
    artist: cleanString(track.artist || track.artistName, 180),
    album: cleanString(track.album || track.albumName, 180),
    artworkUrl: cleanString(track.artworkUrl || track.artworkURL, 1000),
    url: cleanString(track.url, 1000),
    durationSeconds: Number.isFinite(Number(track.durationSeconds))
      ? Math.max(0, Number(track.durationSeconds))
      : Number.isFinite(Number(track.durationMillis))
        ? Math.max(0, Number(track.durationMillis) / 1000)
        : 0
  };
}

export async function searchAppleMusicSongs(music, term, limit = 25) {
  const query = cleanString(term, 160);
  if (!query) return [];
  if (!music?.api?.search) throw new Error('Apple Music catalog search is not initialized.');
  const pageSize = Math.max(1, Math.min(25, Math.floor(Number(limit) || 25)));
  const response = await music.api.search(query, { types: 'songs', limit: pageSize, offset: 0 });
  const rows = response?.songs?.data
    || response?.data?.results?.songs?.data
    || response?.results?.songs?.data
    || response?.data?.songs
    || [];
  if (!Array.isArray(rows)) return [];
  return rows.map(item => {
    const attributes = item?.attributes || item || {};
    const artwork = attributes.artwork?.url || '';
    const url = attributes.url || item?.url || '';
    try {
      return normalizeAppleCatalogTrack({
        id: item?.id || attributes.playParams?.id,
        title: attributes.name || attributes.title,
        artist: attributes.artistName || attributes.artist,
        album: attributes.albumName || attributes.album,
        artworkUrl: artwork,
        url,
        durationMillis: attributes.durationInMillis
      });
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function musicKitPlaybackSnapshot(music) {
  const player = music?.player;
  const item = player?.nowPlayingItem || player?.queue?.currentItem || null;
  const duration = Number(
    item?.attributes?.durationInMillis
      ? Number(item.attributes.durationInMillis) / 1000
      : item?.duration || player?.currentPlaybackDuration || 0
  );
  return {
    isPlaying: Boolean(player?.isPlaying),
    positionSeconds: Math.max(0, Number(player?.playbackTime || 0)),
    durationSeconds: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    track: item ? {
      id: String(item.id || item.attributes?.playParams?.id || ''),
      title: cleanString(item.title || item.attributes?.name, 180),
      artist: cleanString(item.artistName || item.attributes?.artistName, 180),
      album: cleanString(item.albumName || item.attributes?.albumName, 180),
      artworkUrl: cleanString(item.artwork?.url || item.attributes?.artwork?.url, 1000)
        .replace('{w}', '600').replace('{h}', '600')
    } : null
  };
}

function validateScriptUrl(value) {
  const url = new URL(value || DEFAULT_MUSICKIT_SCRIPT);
  if (url.protocol !== 'https:' || url.hostname !== 'js-cdn.music.apple.com'
    || !url.pathname.startsWith('/musickit/v3/')) {
    throw new TypeError('MusicKit must be loaded from Apple’s official JavaScript CDN.');
  }
  return url.href;
}

export async function loadMusicKit(scriptUrl = DEFAULT_MUSICKIT_SCRIPT) {
  if (globalThis.MusicKit?.getInstance) return globalThis.MusicKit;
  if (scriptPromise) return scriptPromise;
  if (typeof document === 'undefined') throw new Error('MusicKit playback requires a browser window.');

  const src = validateScriptUrl(scriptUrl);
  scriptPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('musickitloaded', onReady);
      if (error) reject(error);
      else resolve(globalThis.MusicKit);
    };
    const onReady = () => {
      if (globalThis.MusicKit?.getInstance) finish();
      else finish(new Error('Apple MusicKit loaded without exposing its playback API.'));
    };
    document.addEventListener('musickitloaded', onReady, { once: true });

    const existing = [...document.scripts].find(script => script.src === src);
    const script = existing || document.createElement('script');
    if (!existing) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('error', () => finish(new Error('Apple MusicKit could not be loaded.')), { once: true });
    script.addEventListener('load', () => {
      if (globalThis.MusicKit?.getInstance) finish();
    }, { once: true });
    if (globalThis.MusicKit?.getInstance) finish();
  }).catch(error => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

export async function getMusicKitPlayer({ developerToken, scriptUrl = DEFAULT_MUSICKIT_SCRIPT } = {}) {
  const token = cleanString(developerToken, 4096);
  if (!token || token.split('.').length !== 3) {
    throw new Error('A valid Apple MusicKit developer JWT is required for direct Apple Music playback.');
  }
  const MusicKit = await loadMusicKit(scriptUrl);
  const fingerprint = token.slice(0, 32) + ':' + token.length;
  if (configuredTokenFingerprint && configuredTokenFingerprint !== fingerprint) {
    throw new Error('MusicKit was already configured with a different developer token. Reload BitCider to change it.');
  }
  if (!configuredTokenFingerprint) {
    await MusicKit.configure({
      developerToken: token,
      app: { name: 'BitCider', build: '2026.11.26' },
      features: ['player-accurate-timing', 'api-data-store', 'api-session-storage'],
      suppressErrorDialog: true
    });
    configuredTokenFingerprint = fingerprint;
  }
  const music = MusicKit.getInstance();
  if (!music) throw new Error('Apple MusicKit did not create a playback instance.');
  return music;
}

export async function authorizeAppleMusicPlayback(options) {
  const music = await getMusicKitPlayer(options);
  await music.authorize();
  return music;
}

export async function playAppleMusicSong(track, options) {
  const descriptor = musicKitQueueDescriptor(track);
  const music = await authorizeAppleMusicPlayback(options);
  await music.setQueue(descriptor);
  await music.play();
  return { music, snapshot: musicKitPlaybackSnapshot(music) };
}

export async function controlAppleMusicPlayback(music, action, value) {
  if (!music?.player) throw new Error('Apple Music playback has not been initialized.');
  const player = music.player;
  if (action === 'play') await music.play();
  else if (action === 'pause') await music.pause();
  else if (action === 'stop') await music.stop();
  else if (action === 'next') await music.skipToNextItem();
  else if (action === 'previous') await music.skipToPreviousItem();
  else if (action === 'seek') {
    const position = Number(value);
    if (!Number.isFinite(position) || position < 0) throw new TypeError('Seek position must be a non-negative number.');
    if (typeof music.seekToTime === 'function') await music.seekToTime(position);
    else if (typeof player.seekToTime === 'function') await player.seekToTime(position);
    else throw new Error('This MusicKit version does not expose seeking.');
  } else if (action === 'volume') {
    const volume = Number(value);
    if (!Number.isFinite(volume)) throw new TypeError('Volume must be a number.');
    player.volume = Math.max(0, Math.min(1, volume));
  } else throw new TypeError('Unsupported Apple Music playback action.');
  return musicKitPlaybackSnapshot(music);
}

export function subscribeAppleMusicPlayback(music, callback) {
  if (!music || typeof callback !== 'function') return () => {};
  const names = ['playbackStateDidChange', 'nowPlayingItemDidChange', 'playbackTimeDidChange', 'playbackDurationDidChange'];
  const events = names.map(name => music.MusicKit?.Events?.[name] || globalThis.MusicKit?.Events?.[name] || name);
  for (const eventName of events) music.addEventListener?.(eventName, callback);
  return () => {
    for (const eventName of events) music.removeEventListener?.(eventName, callback);
  };
}
