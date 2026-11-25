import crypto from 'node:crypto';

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302'
];
const DEFAULT_CREDENTIAL_TTL_SECONDS = 3600;
const MIN_CREDENTIAL_TTL_SECONDS = 300;
const MAX_CREDENTIAL_TTL_SECONDS = 86400;

function listValues(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return [...fallback];
  const values = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
}

function normalizeIceUrl(value, expectedKind) {
  const input = String(value || '').trim();
  const match = /^(stun|stuns|turn|turns):(.+)$/i.exec(input);
  if (!match) throw new Error('Invalid ICE server URL.');

  const scheme = match[1].toLowerCase();
  const actualKind = scheme.startsWith('turn') ? 'turn' : 'stun';
  if (actualKind !== expectedKind) throw new Error('ICE server URL uses the wrong scheme.');

  let remainder = match[2];
  if (remainder.startsWith('//')) remainder = remainder.slice(2);
  const queryIndex = remainder.indexOf('?');
  const authority = queryIndex < 0 ? remainder : remainder.slice(0, queryIndex);
  const queryString = queryIndex < 0 ? '' : remainder.slice(queryIndex + 1);
  if (!authority || /[\s\/#]/.test(authority)) throw new Error('Invalid ICE server authority.');

  let parsed;
  try {
    parsed = new URL(scheme + '://' + authority);
  } catch {
    throw new Error('Invalid ICE server host or port.');
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/') {
    throw new Error('ICE server URLs cannot include credentials or a path.');
  }

  const query = new URLSearchParams(queryString);
  const queryEntries = [...query.entries()];
  if (queryEntries.some(([key]) => key !== 'transport') || queryEntries.length > 1) {
    throw new Error('Only the ICE transport query parameter is supported.');
  }
  const transport = query.get('transport');
  if (transport && !['udp', 'tcp'].includes(transport.toLowerCase())) {
    throw new Error('ICE transport must be udp or tcp.');
  }
  const normalizedTransport = transport ? '?transport=' + transport.toLowerCase() : '';
  return scheme + ':' + authority + normalizedTransport;
}

/**
 * Build a browser-safe ICE configuration. TURN credentials follow coturn's
 * time-limited REST authentication format and are scoped to one participant.
 * The shared secret is never returned to the browser.
 */
export function createIceConfiguration(config = {}, participantId = 'participant', nowMs = Date.now()) {
  const stunUrls = listValues(config.stunUrls, DEFAULT_STUN_URLS)
    .map(url => normalizeIceUrl(url, 'stun'));
  const turnUrls = listValues(config.turnUrls, [])
    .map(url => normalizeIceUrl(url, 'turn'));
  const ttlValue = config.credentialTtlSeconds === undefined || config.credentialTtlSeconds === ''
    ? DEFAULT_CREDENTIAL_TTL_SECONDS
    : Number(config.credentialTtlSeconds);
  if (!Number.isSafeInteger(ttlValue)
    || ttlValue < MIN_CREDENTIAL_TTL_SECONDS
    || ttlValue > MAX_CREDENTIAL_TTL_SECONDS) {
    throw new Error('TURN credential TTL must be between 300 and 86400 seconds.');
  }

  const iceServers = stunUrls.map(url => ({ urls: url }));
  let credentialExpiresAt = null;
  if (turnUrls.length) {
    const sharedSecret = String(config.turnSharedSecret || '');
    if (Buffer.byteLength(sharedSecret, 'utf8') < 32) {
      throw new Error('A TURN shared secret of at least 32 bytes is required.');
    }
    const expiresAtSeconds = Math.floor(Number(nowMs) / 1000) + ttlValue;
    const safeParticipantId = String(participantId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'participant';
    const username = expiresAtSeconds + ':bitconnection-' + safeParticipantId;
    const credential = crypto.createHmac('sha1', sharedSecret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
    credentialExpiresAt = new Date(expiresAtSeconds * 1000).toISOString();
  }

  return {
    iceServers,
    iceTransportPolicy: 'all',
    relayAvailable: turnUrls.length > 0,
    credentialExpiresAt
  };
}

export const DEFAULT_BITCONNECTION_STUN_URLS = Object.freeze([...DEFAULT_STUN_URLS]);
