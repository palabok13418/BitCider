import test from 'node:test';
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

async function startBackend(ciderApiUrl = '', { allowLoopbackCiderApi = false } = {}) {
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
      CIDER_API_URL: ciderApiUrl,
      BITCIDER_ALLOW_LOOPBACK_CIDER_API: allowLoopbackCiderApi ? 'true' : ''
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

async function createAuthenticatedRelayConfig(backend) {
  const initial = await jsonRequest(backend.origin, '/api/status');
  const initialCookie = cookieFrom(initial.response);
  const connect = await jsonRequest(backend.origin, '/api/connect', {
    method: 'POST',
    cookie: initialCookie,
    csrf: initial.payload.csrfToken,
    body: {
      token: 'fake-cider-api-token-for-relay-test',
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

  const setup = await jsonRequest(backend.origin, '/api/relay/config', {
    method: 'POST',
    cookie: accountCookie,
    csrf: status.payload.csrfToken,
    body: {}
  });
  assert.equal(setup.response.status, 200, JSON.stringify(setup.payload));
  return {
    addonUrl: status.payload.addonUrl,
    cookie: accountCookie,
    status: status.payload,
    config: setup.payload.config
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

test('hosted addon requests fail clearly when no per-user Cider bridge is configured', async t => {
  const backend = await startBackend('');
  t.after(() => backend.stop());

  const health = await fetch(backend.origin + '/health').then(response => response.json());
  assert.equal(health.ciderBridgeConfigured, false);
  assert.equal(health.ciderBridgeConfigurationError, null);

  const addonUrl = await createAddon(backend);
  const searchUrl = addonUrl.replace('/manifest.json', '/search?q=bridge-test');
  const search = await fetch(searchUrl);
  const searchPayload = await search.json();
  assert.equal(search.status, 503);
  assert.equal(search.headers.get('retry-after'), '10');
  assert.equal(searchPayload.error, 'CIDER_SEARCH_FAILED');
  assert.equal(searchPayload.code, 'CIDER_BRIDGE_NOT_CONFIGURED');
  assert.match(searchPayload.message, /per-user Cider relay/i);
  assert.doesNotMatch(backend.output(), /fetch failed/i);

  const streamUrl = addonUrl.replace('/manifest.json', '/stream/12345');
  const stream = await fetch(streamUrl);
  const streamPayload = await stream.json();
  assert.equal(stream.status, 503);
  assert.equal(streamPayload.error, 'CIDER_STREAM_FAILED');
  assert.equal(streamPayload.code, 'CIDER_BRIDGE_NOT_CONFIGURED');
});

test('addon search uses the configured Cider relay and forwards the scoped app token', async t => {
  let observedToken = '';
  let observedPath = '';
  const cider = http.createServer((request, response) => {
    observedToken = request.headers.apptoken || '';
    observedPath = request.url || '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: { results: { songs: { data: [] } } } }));
  });
  const ciderPort = await listen(cider);
  const backend = await startBackend('http://127.0.0.1:' + ciderPort, { allowLoopbackCiderApi: true });
  t.after(async () => {
    await backend.stop();
    await new Promise(resolve => cider.close(resolve));
  });

  const health = await fetch(backend.origin + '/health').then(response => response.json());
  assert.equal(health.ciderBridgeConfigured, true);

  const addonUrl = await createAddon(backend);
  const searchUrl = addonUrl.replace('/manifest.json', '/search?q=bridge-test');
  const search = await fetch(searchUrl);
  const payload = await search.json();

  assert.equal(search.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload, { tracks: [] });
  assert.equal(observedToken, 'fake-cider-api-token-for-bridge-test');
  assert.match(observedPath, /^\/api\/v2\/library\/songs\?offset=0&limit=100$/);
});

test('unreachable Cider relay returns a bounded, machine-readable 503', async t => {
  const unusedPort = await freePort();
  const backend = await startBackend('http://127.0.0.1:' + unusedPort, { allowLoopbackCiderApi: true });
  t.after(() => backend.stop());

  const addonUrl = await createAddon(backend);
  const searchUrl = addonUrl.replace('/manifest.json', '/search?q=bridge-test');
  const startedAt = Date.now();
  const response = await fetch(searchUrl);
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.error, 'CIDER_SEARCH_FAILED');
  assert.equal(payload.code, 'CIDER_BRIDGE_UNAVAILABLE');
  assert.ok(Date.now() - startedAt < 5000, 'an offline bridge should fail promptly');
  assert.doesNotMatch(payload.message, /fetch failed/i);
});

test('hosted configuration rejects the old Deplexo localhost Cider API setting', async t => {
  const backend = await startBackend('http://127.0.0.1:10767');
  t.after(() => backend.stop());

  const health = await fetch(backend.origin + '/health').then(response => response.json());
  assert.equal(health.ciderBridgeConfigured, false);
  assert.match(health.ciderBridgeConfigurationError, /HTTPS relay origin/i);

  const addonUrl = await createAddon(backend);
  const searchUrl = addonUrl.replace('/manifest.json', '/search?q=bridge-test');
  const response = await fetch(searchUrl);
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.code, 'CIDER_BRIDGE_MISCONFIGURED');
  assert.match(payload.message, /BITCIDER_ALLOW_LOOPBACK_CIDER_API=true/i);
  assert.doesNotMatch(backend.output(), /fetch failed/i);
});

test('Cider bridge requests enforce their configured timeout', async t => {
  const cider = http.createServer((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
      }
    }, 2500);
  });
  const ciderPort = await listen(cider);
  const backend = await startBackend('http://127.0.0.1:' + ciderPort, { allowLoopbackCiderApi: true });
  t.after(async () => {
    await backend.stop();
    await new Promise(resolve => cider.close(resolve));
  });

  const addonUrl = await createAddon(backend);
  const searchUrl = addonUrl.replace('/manifest.json', '/search?q=bridge-test');
  const startedAt = Date.now();
  const response = await fetch(searchUrl);
  const payload = await response.json();

  assert.equal(response.status, 504);
  assert.equal(payload.code, 'CIDER_BRIDGE_TIMEOUT');
  assert.ok(Date.now() - startedAt < 3500, 'the upstream request should be aborted at the configured deadline');
});

test('authenticated addon search and stream resolve through the matching local desktop relay', async t => {
  const backend = await startBackend('');
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

  const linked = await createAuthenticatedRelayConfig(backend);
  assert.equal(linked.config.ciderToken, 'fake-cider-api-token-for-relay-test');
  assert.match(linked.config.relayKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(linked.config.ciderApiUrl, 'http://127.0.0.1:10767');

  const controller = new AbortController();
  const relayLoop = (async () => {
    while (!controller.signal.aborted) {
      let poll;
      try {
        poll = await fetch(backend.origin + '/api/relay/next', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + linked.config.relayKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ waitMs: 750 }),
          signal: controller.signal
        });
        const next = await poll.json();
        if (poll.status === 401) throw new Error('test relay unexpectedly rejected its key');
        if (!next.job) continue;
        const localUrl = 'http://127.0.0.1:' + ciderPort + next.job.apiPath;
        const localResponse = await fetch(localUrl, {
          method: next.job.method,
          headers: {
            Accept: 'application/json',
            apptoken: linked.config.ciderToken,
            ...(next.job.body ? { 'Content-Type': 'application/json' } : {})
          },
          ...(next.job.body ? { body: JSON.stringify(next.job.body) } : {})
        });
        const text = await localResponse.text();
        let payload;
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
        const delivered = await fetch(backend.origin + '/api/relay/respond', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + linked.config.relayKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            jobId: next.job.id,
            status: localResponse.status,
            payload
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
    const searchUrl = linked.addonUrl.replace('/manifest.json', '/search?q=Bridge%20Test');
    const search = await fetch(searchUrl);
    const searchPayload = await search.json();
    assert.equal(search.status, 200, JSON.stringify(searchPayload));
    assert.equal(searchPayload.tracks[0].title, 'Bridge Test Song');
    assert.equal(searchPayload.tracks[0].artist, 'BitCider Test Artist');

    const streamUrl = linked.addonUrl.replace('/manifest.json', '/stream/catalog-track-123');
    const stream = await fetch(streamUrl);
    const streamPayload = await stream.json();
    assert.equal(stream.status, 200, JSON.stringify(streamPayload));
    assert.equal(streamPayload.url, 'https://media.example.invalid/bitcider-test.m4a');

    assert.ok(ciderRequests.some(item => item.path === '/api/v2/amapi/search?term=Bridge+Test&types=songs&limit=25&offset=0'));
    assert.ok(ciderRequests.some(item => item.path === '/api/v2/playback/play-item' && item.method === 'POST'));
    assert.ok(ciderRequests.some(item => item.path === '/api/v2/queue'));
    assert.ok(ciderRequests.some(item => item.path === '/api/v2/playback/pause' && item.method === 'POST'));
    assert.ok(ciderRequests.every(item => item.token === linked.config.ciderToken));
    assert.ok(ciderRequests.every(item => item.token !== linked.config.relayKey));
  } finally {
    controller.abort();
    await relayLoop;
  }
});

