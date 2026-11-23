const LOCAL_CIDER_ORIGIN = 'http://127.0.0.1:10767';
const LOCAL_CIDER_TIMEOUT_MS = 12000;
const BRIDGE_POLL_WAIT_MS = 5000;
const BRIDGE_RETRY_MS = 1200;

function bridgeHeaders(registration) {
  return {
    'Content-Type': 'application/json',
    'X-BitCider-Bridge-Id': registration.bridgeId,
    'X-BitCider-Bridge-Secret': registration.bridgeSecret
  };
}

async function responsePayload(response) {
  return response.json().catch(() => ({}));
}

function validateBridgeRegistration(payload) {
  if (!payload?.bridgeId || !payload?.bridgeSecret || typeof payload?.ciderToken !== 'string') {
    throw new Error('BitCider returned an incomplete browser relay registration.');
  }
  if (payload.ciderToken.length < 12 || payload.ciderToken.length > 8192) {
    throw new Error('BitCider returned an invalid Cider connection token. Reconnect Cider and refresh this page.');
  }
  return payload;
}

async function registerBridge(csrfToken, signal) {
  const response = await fetch('/api/bridge/register', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-BitCider-CSRF': csrfToken
    },
    body: JSON.stringify({}),
    signal
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    const error = new Error(payload.message || 'BitCider could not start its in-browser Cider bridge (HTTP ' + response.status + ').');
    error.status = response.status;
    throw error;
  }
  return validateBridgeRegistration(payload);
}

export function allowedLocalCiderJob(job) {
  if (!job || typeof job !== 'object') return null;
  const method = String(job.method || 'GET').toUpperCase();
  let target;
  try { target = new URL(String(job.path || ''), LOCAL_CIDER_ORIGIN + '/'); }
  catch { return null; }
  if (target.origin !== LOCAL_CIDER_ORIGIN || !target.pathname.startsWith('/api/v2/')) return null;

  if (method === 'GET' && target.pathname === '/api/v2/amapi/search') {
    const keys = [...target.searchParams.keys()];
    const allowedKeys = new Set(['term', 'types', 'limit', 'offset']);
    if (keys.length !== 4 || new Set(keys).size !== 4 || keys.some(key => !allowedKeys.has(key))) return null;
    const term = String(target.searchParams.get('term') || '').trim();
    const types = String(target.searchParams.get('types') || '');
    const limit = Number(target.searchParams.get('limit'));
    const offset = Number(target.searchParams.get('offset'));
    if (!term || term.length > 160 || types !== 'songs'
      || limit !== 25 || offset !== 0) return null;
    return { method, target };
  }

  if (method === 'POST' && target.pathname === '/api/v2/playback/play-item' && !target.search) {
    const id = String(job.body?.id || '');
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(id) || job.body?.type !== 'songs') return null;
    return { method, target, body: { id, type: 'songs' } };
  }

  if (method === 'GET' && target.pathname === '/api/v2/queue' && !target.search) {
    return { method, target };
  }

  if (method === 'POST' && target.pathname === '/api/v2/playback/pause' && !target.search) {
    return { method, target };
  }

  return null;
}

async function probeLocalCider(signal) {
  const response = await fetch(LOCAL_CIDER_ORIGIN + '/api/v2/client/info', {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    targetAddressSpace: 'loopback',
    signal: AbortSignal.any([signal, AbortSignal.timeout(4500)])
  });
  if (!response.ok) {
    throw new Error('Cider responded with HTTP ' + response.status + '. Keep Cider open and confirm Loopback network access is allowed for BitCider.');
  }
  const payload = await response.json().catch(() => ({}));
  if (payload?.error) {
    const message = payload.error?.message || payload.error?.code || payload.error;
    throw new Error('Cider is reachable but its local status request failed: ' + message);
  }
}

async function executeLocalCiderJob(job, token) {
  const allowed = allowedLocalCiderJob(job);
  if (!allowed) {
    return {
      status: 403,
      body: { error: { code: 'CIDER_BRIDGE_REQUEST_REJECTED', message: 'BitCider refused an unsupported local Cider API request.' } }
    };
  }

  try {
    const response = await fetch(allowed.target, {
      method: allowed.method,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        apptoken: token,
        ...(allowed.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(allowed.body ? { body: JSON.stringify(allowed.body) } : {}),
      targetAddressSpace: 'loopback',
      signal: AbortSignal.timeout(LOCAL_CIDER_TIMEOUT_MS)
    });
    const raw = await response.text();
    if (raw.length > 220 * 1024) {
      return {
        status: 502,
        body: { error: { code: 'CIDER_RESPONSE_TOO_LARGE', message: 'Cider returned a response that exceeds BitCider’s relay limit.' } }
      };
    }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { body = { error: { code: 'CIDER_INVALID_RESPONSE', message: 'Cider returned a non-JSON response.' } }; }
    return { status: response.status, body };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      status: timedOut ? 504 : 503,
      body: {
        error: {
          code: timedOut ? 'LOCAL_CIDER_TIMEOUT' : 'LOCAL_CIDER_UNREACHABLE',
          message: timedOut
            ? 'Cider did not answer the local API request within 12 seconds.'
            : 'The BitCider tab cannot reach Cider at 127.0.0.1:10767. Open Cider and allow the browser’s local-network permission for this BitCider site.'
        }
      }
    };
  }
}

async function deliverJobResult(registration, requestId, result, signal) {
  const response = await fetch('/api/bridge/result', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: bridgeHeaders(registration),
    body: JSON.stringify({ requestId, ...result }),
    signal
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    const error = new Error(payload.message || 'BitCider could not return the local Cider response (HTTP ' + response.status + ').');
    error.status = response.status;
    throw error;
  }
}

function delay(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runCiderBrowserRelay({ addonUrl, csrfToken, signal, onState }) {
  if (!addonUrl || !csrfToken || !signal) throw new Error('The in-browser Cider bridge is missing required setup data.');
  let registration = null;
  let retry = BRIDGE_RETRY_MS;
  let ciderToken = '';
  let localCiderAvailable = false;
  let nextProbeAt = 0;
  const setState = (state, message = '') => onState?.(state, message);

  setState('connecting', 'Connecting this browser to the local Cider app.');
  while (!signal.aborted) {
    try {
      if (!registration) {
        registration = await registerBridge(csrfToken, signal);
        ciderToken = registration.ciderToken;
        localCiderAvailable = false;
        nextProbeAt = 0;
        retry = BRIDGE_RETRY_MS;
      }

      if (!localCiderAvailable && Date.now() >= nextProbeAt) {
        try {
          await probeLocalCider(signal);
          localCiderAvailable = true;
          setState('connected', 'This BitCider tab is connected to Cider on this computer.');
        } catch (error) {
          localCiderAvailable = false;
          nextProbeAt = Date.now() + 10000;
          setState('cider-unavailable', error?.message || 'Cider is not reachable from this browser yet.');
        }
      }

      const pollResponse = await fetch('/api/bridge/poll', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: bridgeHeaders(registration),
        body: JSON.stringify({ waitMs: BRIDGE_POLL_WAIT_MS }),
        signal
      });
      const pollPayload = await responsePayload(pollResponse);
      if (!pollResponse.ok) {
        const error = new Error(pollPayload.message || 'The in-browser Cider bridge disconnected (HTTP ' + pollResponse.status + ').');
        error.status = pollResponse.status;
        throw error;
      }

      const job = pollPayload.job;
      if (!job) continue;

      const result = await executeLocalCiderJob(job, ciderToken);
      if (result.status >= 500) {
        localCiderAvailable = false;
        nextProbeAt = Date.now() + 10000;
        setState('cider-unavailable', result.body?.error?.message || 'Cider is not responding on this computer.');
      } else {
        localCiderAvailable = true;
        setState('connected', 'This BitCider tab is connected to Cider on this computer.');
      }
      await deliverJobResult(registration, job.requestId, result, signal);
    } catch (error) {
      if (signal.aborted) break;
      if ([401, 403, 409].includes(Number(error?.status))) {
        registration = null;
        ciderToken = '';
        setState('offline', error?.message || 'This BitCider tab is no longer the active Cider bridge. Refresh it to reconnect.');
        break;
      }
      registration = null;
      ciderToken = '';
      localCiderAvailable = false;
      setState('reconnecting', error?.message || 'Reconnecting to Cider on this computer.');
      await delay(retry, signal);
      retry = Math.min(retry * 1.7, 10000);
    }
  }

  if (registration) {
    try {
      await fetch('/api/bridge/stop', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        headers: bridgeHeaders(registration),
        body: JSON.stringify({})
      });
    } catch {
      // The backend expires inactive browser relays automatically.
    }
  }
  setState('offline', 'The BitCider browser tab is no longer relaying Cider requests.');
}
