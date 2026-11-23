import test from 'node:test';
import { allowedLocalCiderJob } from './src/cider-bridge.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, 'server.mjs');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function startBackend() {
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-bridge-test-'));
  const encryptionKey = crypto.randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BITCIDER_PUBLIC_URL: origin,
      BITCIDER_DATA_DIR: dataDir,
      BITCIDER_ALLOW_LOOPBACK_ADMIN: 'true',
      BITCIDER_ENCRYPTION_KEY: encryptionKey,
      BITCIDER_CIDER_REQUEST_TIMEOUT_MS: '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error('BitCider exited during startup: ' + output);
    }
    try {
      const response = await fetch(origin + '/health');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The child may still be binding its HTTP listener.
    }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  if (!ready) {
    child.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true });
    throw new Error('BitCider did not become ready: ' + output);
  }

  return {
    origin,
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 4000))
        ]);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = values.find(value => value.startsWith('bitcider_session='));
  assert.ok(cookie, 'expected BitCider to issue a session cookie');
  return cookie.split(';', 1)[0];
}

async function jsonRequest(origin, route, { method = 'GET', cookie, csrf, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-BitCider-CSRF'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(origin + route, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function createAuthenticatedBrowserBridge(backend) {
  const initial = await jsonRequest(backend.origin, '/api/status');
  const initialCookie = cookieFrom(initial.response);
  const connect = await jsonRequest(backend.origin, '/api/connect', {
    method: 'POST',
    cookie: initialCookie,
    csrf: initial.payload.csrfToken,
    body: {
      token: 'fake-cider-api-token-for-browser-bridge-test',
      scopes: ['playback', 'queue', 'library', 'audio']
    }
  });
  assert.equal(connect.response.status, 200, JSON.stringify(connect.payload));

  const registration = await jsonRequest(backend.origin, '/api/account/register', {
    method: 'POST',
    cookie: initialCookie,
    csrf: initial.payload.csrfToken,
    body: { password: 'A-secure-test-passphrase-2026!' }
  });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));
  const accountCookie = cookieFrom(registration.response);
  const status = await jsonRequest(backend.origin, '/api/status', { cookie: accountCookie });
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.account.authenticated, true);

  const bridge = await jsonRequest(backend.origin, '/api/bridge/register', {
    method: 'POST',
    cookie: accountCookie,
    csrf: status.payload.csrfToken,
    body: {}
  });
  assert.equal(bridge.response.status, 200, JSON.stringify(bridge.payload));
  return {
    addonUrl: status.payload.addonUrl,
    cookie: accountCookie,
    csrfToken: status.payload.csrfToken,
    bridgeId: bridge.payload.bridgeId,
    bridgeSecret: bridge.payload.bridgeSecret,
    ciderToken: bridge.payload.ciderToken
  };
}

function browserBridgeHeaders(bridge) {
  return {
    'X-BitCider-Bridge-Id': bridge.bridgeId,
    'X-BitCider-Bridge-Secret': bridge.bridgeSecret,
    'Content-Type': 'application/json'
  };
}

async function createAddon(backend) {
  const status = await jsonRequest(backend.origin, '/api/status');
  const cookie = cookieFrom(status.response);
  assert.equal(status.response.status, 200);
  assert.equal(typeof status.payload.csrfToken, 'string');

  const connect = await jsonRequest(backend.origin, '/api/connect', {
    method: 'POST',
    cookie,
    csrf: status.payload.csrfToken,
    body: {
      token: 'fake-cider-api-token-for-bridge-test',
      scopes: ['playback', 'queue', 'library', 'audio']
    }
  });
  assert.equal(connect.response.status, 200, JSON.stringify(connect.payload));
  assert.equal(typeof connect.payload.addonUrl, 'string');
  return connect.payload.addonUrl;
}

test('addon requests clearly require the BitCider browser tab to remain open', async t => {
  const backend = await startBackend();
  t.after(() => backend.stop());

  const health = await fetch(backend.origin + '/health').then(response => response.json());
  assert.equal(health.browserCiderBridgeSupported, true);

  const addonUrl = await createAddon(backend);
  const search = await fetch(addonUrl.replace('/manifest.json', '/search?q=bridge-test'));
  const searchPayload = await search.json();
  assert.equal(search.status, 503);
  assert.equal(search.headers.get('retry-after'), '10');
  assert.equal(searchPayload.error, 'CIDER_SEARCH_FAILED');
  assert.equal(searchPayload.code, 'CIDER_BRIDGE_OFFLINE');
  assert.match(searchPayload.message, /keep the BitCider website open/i);

  const stream = await fetch(addonUrl.replace('/manifest.json', '/stream/12345'));
  const streamPayload = await stream.json();
  assert.equal(stream.status, 503);
  assert.equal(streamPayload.code, 'CIDER_BRIDGE_OFFLINE');
  assert.doesNotMatch(backend.output(), /fetch failed/i);
});

test('authenticated addon search and stream resolve through the local Cider API in the BitCider browser tab', async t => {
  const backend = await startBackend();
  const ciderRequests = [];
  const cider = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      ciderRequests.push({
        method: request.method,
        path: request.url,
        token: request.headers.apptoken || '',
        body: body ? JSON.parse(body) : null
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url?.startsWith('/api/v2/amapi/search?')) {
        response.end(JSON.stringify({
          data: {
            results: {
              songs: {
                data: [{
                  id: 'catalog-track-123',
                  type: 'songs',
                  attributes: {
                    name: 'Bridge Test Song',
                    artistName: 'BitCider Test Artist',
                    albumName: 'Relay Album',
                    durationInMillis: 180000,
                    playParams: { id: 'catalog-track-123' }
                  }
                }]
              }
            }
          }
        }));
      } else if (request.url === '/api/v2/queue') {
        response.end(JSON.stringify({
          data: [{
            id: 'catalog-track-123',
            assetURL: 'https://media.example.invalid/bitcider-test.m4a',
            attributes: { name: 'Bridge Test Song', artistName: 'BitCider Test Artist' }
          }]
        }));
      } else {
        response.end(JSON.stringify({ data: {} }));
      }
    });
  });
  const ciderPort = await listen(cider);
  t.after(async () => {
    await backend.stop();
    await new Promise(resolve => cider.close(resolve));
  });

  const bridge = await createAuthenticatedBrowserBridge(backend);
  assert.match(bridge.bridgeId, /^[A-Za-z0-9_-]{20,80}$/);
  assert.match(bridge.bridgeSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(bridge.ciderToken, 'fake-cider-api-token-for-browser-bridge-test');

  const controller = new AbortController();
  const bridgeLoop = (async () => {
    while (!controller.signal.aborted) {
      try {
        const poll = await fetch(backend.origin + '/api/bridge/poll', {
          method: 'POST',
          headers: browserBridgeHeaders(bridge),
          body: JSON.stringify({ waitMs: 750 }),
          signal: controller.signal
        });
        const next = await poll.json();
        if (poll.status === 401) throw new Error('test browser bridge unexpectedly rejected its secret');
        if (!poll.ok) throw new Error('test browser bridge poll returned HTTP ' + poll.status);
        if (!next.job) continue;

        const localUrl = 'http://127.0.0.1:' + ciderPort + next.job.path;
        const localResponse = await fetch(localUrl, {
          method: next.job.method,
          headers: {
            Accept: 'application/json',
            apptoken: bridge.ciderToken,
            ...(next.job.body ? { 'Content-Type': 'application/json' } : {})
          },
          ...(next.job.body ? { body: JSON.stringify(next.job.body) } : {})
        });
        const raw = await localResponse.text();
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
        const delivered = await fetch(backend.origin + '/api/bridge/result', {
          method: 'POST',
          headers: browserBridgeHeaders(bridge),
          body: JSON.stringify({
            requestId: next.job.requestId,
            status: localResponse.status,
            body
          }),
          signal: controller.signal
        });
        assert.equal(delivered.status, 200);
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
    }
  })();

  try {
    const search = await fetch(bridge.addonUrl.replace('/manifest.json', '/search?q=Bridge%20Test'));
    const searchPayload = await search.json();
    assert.equal(search.status, 200, JSON.stringify(searchPayload));
    assert.equal(searchPayload.tracks[0].title, 'Bridge Test Song');
    assert.equal(searchPayload.tracks[0].artist, 'BitCider Test Artist');

    const stream = await fetch(bridge.addonUrl.replace('/manifest.json', '/stream/catalog-track-123'));
    const streamPayload = await stream.json();
    assert.equal(stream.status, 200, JSON.stringify(streamPayload));
    assert.equal(streamPayload.url, 'https://media.example.invalid/bitcider-test.m4a');

    assert.ok(ciderRequests.some(item => item.path === '/api/v2/amapi/search?term=Bridge+Test&types=songs&limit=25&offset=0'));
    assert.ok(ciderRequests.some(item => item.path === '/api/v2/playback/play-item' && item.method === 'POST'));
    assert.ok(ciderRequests.some(item => item.path === '/api/v2/queue'));
    assert.ok(ciderRequests.some(item => item.path === '/api/v2/playback/pause' && item.method === 'POST'));
    assert.ok(ciderRequests.every(item => item.token === bridge.ciderToken));
  } finally {
    controller.abort();
    await bridgeLoop;
  }
});

test('replaced browser bridge polls complete as a normal tab handoff', async t => {
  const backend = await startBackend();
  t.after(() => backend.stop());
  const bridge = await createAuthenticatedBrowserBridge(backend);

  const stalePollPromise = fetch(backend.origin + '/api/bridge/poll', {
    method: 'POST',
    headers: browserBridgeHeaders(bridge),
    body: JSON.stringify({ waitMs: 5000 })
  });
  await new Promise(resolve => setTimeout(resolve, 40));

  const replacement = await jsonRequest(backend.origin, '/api/bridge/register', {
    method: 'POST',
    cookie: bridge.cookie,
    csrf: bridge.csrfToken,
    body: {}
  });
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.payload));

  const stalePoll = await stalePollPromise;
  const payload = await stalePoll.json();
  assert.equal(stalePoll.status, 200);
  assert.equal(payload.replaced, true);
  assert.equal(payload.error, 'BROWSER_BRIDGE_REPLACED');
});

test('browser bridge credentials are rejected after BitCider sign-out', async t => {
  const backend = await startBackend();
  t.after(() => backend.stop());
  const bridge = await createAuthenticatedBrowserBridge(backend);

  const logout = await jsonRequest(backend.origin, '/api/account/logout', {
    method: 'POST',
    cookie: bridge.cookie,
    csrf: bridge.csrfToken,
    body: {}
  });
  assert.equal(logout.response.status, 200);

  const poll = await fetch(backend.origin + '/api/bridge/poll', {
    method: 'POST',
    headers: browserBridgeHeaders(bridge),
    body: JSON.stringify({ waitMs: 500 })
  });
  assert.equal(poll.status, 401);
});

test('browser bridge rejects invalid credentials and unknown job responses', async t => {
  const backend = await startBackend();
  t.after(() => backend.stop());
  const bridge = await createAuthenticatedBrowserBridge(backend);

  const badPoll = await fetch(backend.origin + '/api/bridge/poll', {
    method: 'POST',
    headers: {
      'X-BitCider-Bridge-Id': bridge.bridgeId,
      'X-BitCider-Bridge-Secret': 'A'.repeat(43),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });
  assert.equal(badPoll.status, 401);

  const unknownResult = await fetch(backend.origin + '/api/bridge/result', {
    method: 'POST',
    headers: browserBridgeHeaders(bridge),
    body: JSON.stringify({ requestId: 'not-a-live-job', status: 200, body: {} })
  });
  assert.equal(unknownResult.status, 404);
});

test('browser relay accepts only bounded Cider catalog search and playback routes', () => {
  const catalog = allowedLocalCiderJob({
    method: 'GET',
    path: '/api/v2/amapi/search?term=bridge+test&types=songs&limit=25&offset=0'
  });
  assert.equal(catalog?.method, 'GET');

  assert.equal(allowedLocalCiderJob({
    method: 'GET',
    path: '/api/v2/amapi/search?term=bridge&types=albums&limit=25&offset=0'
  }), null);
  assert.equal(allowedLocalCiderJob({
    method: 'GET',
    path: '/api/v2/amapi/search?term=bridge&types=songs&limit=100&offset=0'
  }), null);
  assert.equal(allowedLocalCiderJob({
    method: 'GET',
    path: '/api/v2/amapi/raw/v1/me/library/songs'
  }), null);
  assert.equal(allowedLocalCiderJob({
    method: 'GET',
    path: 'https://example.com/api/v2/amapi/search?term=bridge&types=songs&limit=25&offset=0'
  }), null);
  assert.equal(allowedLocalCiderJob({
    method: 'GET',
    path: 'http://user@127.0.0.1:10767/api/v2/amapi/search?term=bridge&types=songs&limit=25&offset=0'
  }), null);
  assert.equal(allowedLocalCiderJob({
    method: 'GET',
    path: '/api/v2/amapi/search?term=bridge&types=songs&limit=25&offset=0#other'
  }), null);
  assert.equal(allowedLocalCiderJob({
    method: 'POST',
    path: '/api/v2/playback/play-item',
    body: { id: 'catalog-track-123', type: 'songs' }
  })?.method, 'POST');
  assert.equal(allowedLocalCiderJob({
    method: 'POST',
    path: '/api/v2/plugins/install',
    body: { url: 'https://example.com/plugin.zip' }
  }), null);
});

test('main App owns the browser bridge state used by its relay effect and panel', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src/App.jsx'), 'utf8');
  const accountSetupStart = source.indexOf('function AccountSetupWindow(');
  const appStart = source.indexOf('export default function App()');
  assert.ok(accountSetupStart >= 0 && appStart > accountSetupStart, 'expected both React component boundaries');
  const accountSetupSource = source.slice(accountSetupStart, appStart);
  const appSource = source.slice(appStart);
  const browserBridgeState = "const [browserBridge, setBrowserBridge] = useState";
  assert.equal(accountSetupSource.includes(browserBridgeState), false);
  assert.equal(appSource.includes(browserBridgeState), true);
  assert.equal(appSource.includes('runCiderBrowserRelay({'), true);
  assert.equal(appSource.includes('setBrowserBridge('), true);
});


test('Cider auth probe authenticates with apptoken and offers reauthorization after CORS failure', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src/cider-bridge.js'), 'utf8');
  const appSource = await fs.readFile(path.join(ROOT, 'src/App.jsx'), 'utf8');
  const probeStart = source.indexOf('async function probeLocalCider(');
  const probeEnd = source.indexOf('async function executeLocalCiderJob(', probeStart);
  const probe = source.slice(probeStart, probeEnd);
  assert.match(probe, /async function probeLocalCider\(signal, token\)/);
  assert.match(probe, /apptoken:\s*token/);
  assert.match(source, /await probeLocalCider\(signal, ciderToken\)/);
  assert.match(source, /LOCAL_CIDER_CORS_BLOCKED/);
  assert.match(appSource, /browserBridge\.state === 'cider-auth-required' && \(/);
  assert.match(appSource, /browserBridge\.state === 'cider-access-blocked'/);
  assert.match(appSource, /CIDER ACCESS BLOCKED/);
  assert.match(appSource, /RECONNECT CIDER ON THIS DEVICE/);
});

test('GradientASCII declares its shader-link readiness helper only once', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src/GradientASCII.jsx'), 'utf8');
  const declarationCount = source.split('const linked = () =>').length - 1;
  assert.equal(declarationCount, 1, 'duplicate linked declarations break the production Vite build');
});
