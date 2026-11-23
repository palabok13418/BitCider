const VAULT_NAME = 'bitcider-device-relay-v1';
const VAULT_VERSION = 1;
const LOCAL_CIDER_ORIGIN = 'http://127.0.0.1:10767';
const LOCAL_CIDER_TIMEOUT_MS = 12000;
const POLL_RETRY_MS = 1200;

let vaultPromise;

function openVault() {
  if (vaultPromise) return vaultPromise;
  vaultPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB || !globalThis.crypto?.subtle) {
      reject(new Error('This browser does not support the encrypted local Cider relay vault.'));
      return;
    }
    const request = indexedDB.open(VAULT_NAME, VAULT_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('tokens')) db.createObjectStore('tokens');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the local Cider relay vault.'));
    request.onblocked = () => reject(new Error('The local Cider relay vault is blocked by another open BitCider tab. Close the other tab and retry.'));
  }).catch(error => {
    vaultPromise = null;
    throw error;
  });
  return vaultPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('The local encrypted storage request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('The local encrypted storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('The local encrypted storage transaction was aborted.'));
  });
}

async function localVaultKey(db) {
  const read = db.transaction('keys', 'readonly');
  const existing = await requestResult(read.objectStore('keys').get('cider-token-key'));
  await transactionDone(read);
  if (existing) return existing;

  const generated = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const write = db.transaction('keys', 'readwrite');
  write.objectStore('keys').put(generated, 'cider-token-key');
  await transactionDone(write);
  const verify = db.transaction('keys', 'readonly');
  const saved = await requestResult(verify.objectStore('keys').get('cider-token-key'));
  await transactionDone(verify);
  if (!saved) throw new Error('The browser could not persist the local Cider encryption key.');
  return saved;
}

function addonPath(addonUrl) {
  const parsed = new URL(addonUrl, globalThis.location?.origin || 'https://bitcider.invalid');
  if (!parsed.pathname.endsWith('/manifest.json')) throw new Error('BitCider returned an invalid personal addon URL.');
  return parsed.pathname;
}

export async function saveCiderBridgeToken(token, addonUrl) {
  if (typeof token !== 'string' || token.length < 12 || token.length > 8192) {
    throw new Error('Cider returned an invalid local relay credential.');
  }
  const db = await openVault();
  const key = await localVaultKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const tx = db.transaction('tokens', 'readwrite');
  tx.objectStore('tokens').put({
    addonPath: addonPath(addonUrl),
    iv: iv.buffer,
    ciphertext
  }, 'active-cider-token');
  await transactionDone(tx);
}

export async function loadCiderBridgeToken(addonUrl) {
  const db = await openVault();
  const tx = db.transaction('tokens', 'readonly');
  const record = await requestResult(tx.objectStore('tokens').get('active-cider-token'));
  await transactionDone(tx);
  if (!record || record.addonPath !== addonPath(addonUrl)) return null;
  const key = await localVaultKey(db);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
      key,
      record.ciphertext
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('The locally saved Cider relay credential could not be unlocked. Activate this device again.');
  }
}

export async function clearCiderBridgeToken() {
  const db = await openVault();
  const tx = db.transaction(['tokens', 'keys'], 'readwrite');
  tx.objectStore('tokens').clear();
  tx.objectStore('keys').clear();
  await transactionDone(tx);
}

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
    const error = new Error(payload.message || 'BitCider could not register this device relay (HTTP ' + response.status + ').');
    error.status = response.status;
    throw error;
  }
  if (!payload.bridgeId || !payload.bridgeSecret) {
    throw new Error('BitCider returned an incomplete device relay registration.');
  }
  return payload;
}

function allowedLocalPath(pathname) {
  const url = new URL(pathname, LOCAL_CIDER_ORIGIN);
  if (url.origin !== LOCAL_CIDER_ORIGIN || !url.pathname.startsWith('/api/v2/')) return false;
  if (url.pathname === '/api/v2/library/songs') return true;
  if (url.pathname === '/api/v2/queue') return true;
  if (url.pathname === '/api/v2/playback/play-item') return true;
  if (url.pathname === '/api/v2/playback/pause') return true;
  return false;
}

async function executeLocalCiderJob(job, token) {
  if (!job || typeof job.path !== 'string' || !allowedLocalPath(job.path)) {
    return {
      status: 400,
      body: { error: { code: 'CIDER_BRIDGE_REQUEST_REJECTED', message: 'BitCider refused an unsupported local Cider API request.' } }
    };
  }
  const method = job.method === 'POST' ? 'POST' : 'GET';
  try {
    const response = await fetch(new URL(job.path, LOCAL_CIDER_ORIGIN), {
      method,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        apptoken: token,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      ...(method === 'POST' ? { body: JSON.stringify(job.body ?? {}) } : {}),
      targetAddressSpace: 'loopback',
      signal: AbortSignal.timeout(LOCAL_CIDER_TIMEOUT_MS)
    });
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { body = { raw: raw.slice(0, 1200) }; }
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
            : 'The BitCider page cannot reach Cider at 127.0.0.1:10767. Open Cider and allow Loopback network access for this BitCider site.'
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
    const error = new Error(payload.message || 'BitCider could not deliver a Cider relay result (HTTP ' + response.status + ').');
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

export async function runCiderBrowserRelay({ addonUrl, csrfToken, token, signal, onState }) {
  if (!addonUrl || !csrfToken || !token || !signal) throw new Error('The local Cider relay is missing required setup data.');
  let registration = null;
  let retry = POLL_RETRY_MS;
  let lastMessage = '';
  const setState = (state, message = '') => {
    if (message !== lastMessage || state !== 'connected') lastMessage = message;
    onState?.(state, message);
  };

  setState('connecting', 'Starting the secure connection to this device.');
  while (!signal.aborted) {
    try {
      if (!registration) {
        registration = await registerBridge(csrfToken, signal);
        retry = POLL_RETRY_MS;
        setState('connected', 'This device is connected to the BitCider relay.');
      }

      const pollResponse = await fetch('/api/bridge/poll', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: bridgeHeaders(registration),
        body: JSON.stringify({}),
        signal
      });
      const pollPayload = await responsePayload(pollResponse);
      if (!pollResponse.ok) {
        const error = new Error(pollPayload.message || 'The BitCider relay disconnected (HTTP ' + pollResponse.status + ').');
        error.status = pollResponse.status;
        throw error;
      }

      const job = pollPayload.job;
      if (!job) continue;

      const result = await executeLocalCiderJob(job, token);
      if (result.status >= 500) {
        const code = result.body?.error?.code;
        setState('cider-unavailable', result.body?.error?.message || 'Cider is not responding on this device.');
        if (code === 'LOCAL_CIDER_UNREACHABLE' || code === 'LOCAL_CIDER_TIMEOUT') {
          // Keep the relay alive; the user can reopen Cider and retry without
          // exposing or re-authorizing the saved app token.
        }
      } else {
        setState('connected', 'This device is connected to the BitCider relay.');
      }
      await deliverJobResult(registration, job.requestId, result, signal);
    } catch (error) {
      if (signal.aborted) break;
      registration = null;
      setState('reconnecting', error?.message || 'Reconnecting the local Cider relay.');
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
      // The server also expires relay registrations after a missed heartbeat.
    }
  }
  setState('offline', 'The local Cider relay is stopped.');
}
