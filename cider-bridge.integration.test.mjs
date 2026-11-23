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

async function startBackend(ciderApiUrl = '') {
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
      CIDER_API_URL: ciderApiUrl
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
    response.end(JSON.stringify({ data: [], meta: { offset: 0, limit: 200, total: 0 } }));
  });
  const ciderPort = await listen(cider);
  const backend = await startBackend('http://127.0.0.1:' + ciderPort);
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
  assert.match(observedPath, /^\/api\/v2\/library\/songs\?offset=0&limit=200$/);
});

test('unreachable Cider relay returns a bounded, machine-readable 503', async t => {
  const unusedPort = await freePort();
  const backend = await startBackend('http://127.0.0.1:' + unusedPort);
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
