export const BITCIDER_QUALITY_OPTIONS = Object.freeze([
  { value: 'high', label: 'AAC 256 kbps', bitrate: 256000 },
  { value: 'low', label: 'AAC 64 kbps', bitrate: 64000 },
  { value: 'atmos', label: 'Dolby Atmos' }
]);

export function normalizeQuality(value = 'high') {
  const quality = String(value || 'high').trim().toLowerCase().replace(/[\\s-]+/g, '_');
  if (['low', 'aac_64', '64', '64kbps'].includes(quality)) return 'low';
  if (['atmos', 'dolby_atmos', 'spatial'].includes(quality)) return 'atmos';
  return 'high';
}

function stringValues(value) {
  if (Array.isArray(value)) return value.map(item => String(item).toLowerCase());
  if (typeof value === 'string' && value.trim()) return [value.toLowerCase()];
  return [];
}

// Apple Music documents "dolby-atmos" in a song's audioVariants.
export function supportsDolbyAtmos(attributes = {}) {
  const variants = [
    ...stringValues(attributes.audioVariants),
    ...stringValues(attributes.audioVariant),
    ...stringValues(attributes.audioModes),
    ...stringValues(attributes.audioMode)
  ];
  return variants.some(value => value === 'dolby-atmos' || value === 'dolby_atmos' || value === 'dolby atmos');
}

// Catalogue availability is not proof that the currently resolved queue
// rendition is Atmos. Only tag the stream when Cider identifies that rendition.
export function isDolbyAtmosStream(queueItem = {}) {
  const attributes = queueItem?.attributes || queueItem || {};
  const codec = String(attributes.codec || attributes.audioCodec || '').toLowerCase().replace(/_/g, '-');
  const mode = String(attributes.audioMode || attributes.mode || '').toLowerCase().replace(/_/g, '-');
  const quality = String(attributes.audioQuality || attributes.quality || '').toLowerCase();
  return attributes.atmos === true
    || mode === 'dolby-atmos'
    || mode === 'dolby atmos'
    || codec.includes('eac3-joc')
    || codec.includes('ec-3-joc')
    || quality.includes('dolby atmos');
}

export function atmosphereTrackId(trackId) {
  return 'atmos_' + Buffer.from(String(trackId), 'utf8').toString('base64url');
}

export function parseAddonTrackId(value) {
  const id = String(value || '');
  if (!id.startsWith('atmos_')) return { trackId: id, atmos: false };
  try {
    const decoded = Buffer.from(id.slice(6), 'base64url').toString('utf8');
    if (!decoded) throw new Error('empty Atmos track id');
    return { trackId: decoded, atmos: true };
  } catch {
    return { trackId: id, atmos: false };
  }
}

export function streamMetadata(url, queueItem, requestedQuality = 'high') {
  const attributes = queueItem?.attributes || queueItem || {};
  const lowerUrl = String(url).toLowerCase();
  const hls = lowerUrl.includes('m3u8') || String(attributes.manifest || '').toLowerCase() === 'hls';
  const dash = lowerUrl.includes('.mpd') || String(attributes.manifest || '').toLowerCase() === 'dash';
  const encrypted = attributes.encrypted === true;
  const sampleRate = Number(attributes.sampleRate);
  const knownContainer = String(attributes.container || '').toLowerCase();
  const safeContainer = knownContainer && !['flac', 'alac', 'wav', 'wave'].includes(knownContainer)
    ? knownContainer
    : '';

  if (isDolbyAtmosStream(queueItem)) {
    return {
      url,
      format: hls ? 'm3u8' : 'dash',
      quality: 'Dolby Atmos',
      codec: 'eac3-joc',
      ...(safeContainer ? { container: safeContainer } : { container: 'mp4' }),
      manifest: hls ? 'hls' : (dash ? 'dash' : 'dash'),
      encrypted,
      audioMode: 'DOLBY_ATMOS',
      ...(sampleRate > 0 ? { sampleRate } : {})
    };
  }

  // Stereo output is AAC only. Do not forward stale FLAC/ALAC/WAV, Hi-Res,
  // lossless, or bit-depth labels from Cider queue metadata.
  const quality = normalizeQuality(requestedQuality);
  const preset = quality === 'low' ? BITCIDER_QUALITY_OPTIONS[1] : BITCIDER_QUALITY_OPTIONS[0];
  return {
    url,
    format: 'aac',
    quality: preset.label,
    codec: 'aac',
    ...(safeContainer ? { container: safeContainer } : {}),
    manifest: hls ? 'hls' : (dash ? 'dash' : 'none'),
    encrypted,
    ...(sampleRate > 0 ? { sampleRate } : {}),
    bitrate: preset.bitrate
  };
}
