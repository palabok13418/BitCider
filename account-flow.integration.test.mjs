import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, 'server.mjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = values.find(value => value.startsWith('bitcider_session='));
  assert.ok(cookie, 'expected BitCider to issue a session cookie');
  return cookie.split(';', 1)[0];
}

async function startServer({ port, dataDir, encryptionKey }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BITCIDER_DATA_DIR: dataDir,
      BITCIDER_PUBLIC_URL: `http://127.0.0.1:${port}`,
      BITCIDER_ALLOW_LOOPBACK_ADMIN: 'true',
      ...(encryptionKey ? { BITCIDER_ENCRYPTION_KEY: encryptionKey } : { BITCIDER_ENCRYPTION_KEY: '' })
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`BitCider exited during startup: ${stderr}`);
    try {
      const response = await fetch(origin + '/health');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The server may still be binding its listener.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`BitCider did not become ready: ${stderr}`);
  }
  return {
    child,
    origin,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };
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

test('BitCider accounts restore cloud links across sessions and survive encryption-key migration', { timeout: 60000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-account-flow-'));
  const port = await freePort();
  const username = 'cloudlink_test';
  const initialPassword = 'secure-first-passphrase-2026';
  const changedPassword = 'secure-second-passphrase-2026';
  const fakeCiderToken = 'bitcider-integration-test-token-never-store-plaintext';
  const dedicatedKey = crypto.randomBytes(32).toString('base64url');
  let server;

  t.after(async () => {
    if (server) await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  // First run uses the legacy persistent-volume key. Keep the connection
  // anonymous until the separate Deplexo encryption key is available.
  server = await startServer({ port, dataDir });
  const firstOrigin = server.origin;

  const anonymous = await jsonRequest(firstOrigin, '/api/status');
  assert.equal(anonymous.response.status, 200);
  assert.equal(anonymous.payload.tokenEncryptionConfigured, false);
  const anonymousCookie = cookieFrom(anonymous.response);

  const blockedRegistration = await jsonRequest(firstOrigin, '/api/account/register', {
    method: 'POST',
    cookie: anonymousCookie,
    csrf: anonymous.payload.csrfToken,
    body: { username, password: initialPassword }
  });
  assert.equal(blockedRegistration.response.status, 503);
  assert.equal(blockedRegistration.payload.error, 'SECURE_STORAGE_NOT_CONFIGURED');

  const firstConnection = await jsonRequest(firstOrigin, '/api/connect', {
    method: 'POST',
    cookie: anonymousCookie,
    csrf: anonymous.payload.csrfToken,
    body: { token: fakeCiderToken, scopes: ['playback', 'queue', 'library', 'audio'] }
  });
  assert.equal(firstConnection.response.status, 200);
  const savedAddonUrl = firstConnection.payload.addonUrl;
  assert.equal(savedAddonUrl.endsWith('/manifest.json'), true);

  const legacyStore = JSON.parse(await fs.readFile(path.join(dataDir, 'connection.json'), 'utf8'));
  const legacySession = Object.values(legacyStore.sessions)[0];
  assert.equal(legacySession.ciderToken.keyVersion, 1);
  assert.equal(JSON.stringify(legacyStore).includes(fakeCiderToken), false);

  await server.stop();
  server = null;

  // Restart with the Deplexo-only secret. The existing anonymous connection
  // is upgraded first, then transferred into the newly created account.
  server = await startServer({ port, dataDir, encryptionKey: dedicatedKey });
  const secondOrigin = server.origin;

  const restoredAnonymous = await jsonRequest(secondOrigin, '/api/status', { cookie: anonymousCookie });
  assert.equal(restoredAnonymous.response.status, 200);
  assert.equal(restoredAnonymous.payload.tokenEncryptionConfigured, true);
  assert.equal(restoredAnonymous.payload.connected, true);
  assert.equal(restoredAnonymous.payload.addonUrl, savedAddonUrl);

  const migratedStore = JSON.parse(await fs.readFile(path.join(dataDir, 'connection.json'), 'utf8'));
  const migratedSession = Object.values(migratedStore.sessions)[0];
  assert.equal(migratedSession.ciderToken.keyVersion, 2);
  assert.equal(JSON.stringify(migratedStore).includes(fakeCiderToken), false);

  const registration = await jsonRequest(secondOrigin, '/api/account/register', {
    method: 'POST',
    cookie: anonymousCookie,
    csrf: restoredAnonymous.payload.csrfToken,
    body: { username, password: initialPassword }
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.payload.recoveryCodes.length, 10);
  const originalRecoveryCode = registration.payload.recoveryCodes[0];
  const firstDeviceCookie = cookieFrom(registration.response);

  const firstDeviceStatus = await jsonRequest(secondOrigin, '/api/status', { cookie: firstDeviceCookie });
  assert.equal(firstDeviceStatus.payload.account.authenticated, true);
  assert.equal(firstDeviceStatus.payload.connected, true);
  assert.equal(firstDeviceStatus.payload.addonUrl, savedAddonUrl);

  const manifestResponse = await fetch(savedAddonUrl);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('cache-control') || '', /no-store/i);
  assert.equal(manifestResponse.headers.get('cache-control')?.includes('public'), false);

  // A clean second browser can sign in and recover the account-owned addon URL.
  const secondAnonymous = await jsonRequest(secondOrigin, '/api/status');
  const secondAnonymousCookie = cookieFrom(secondAnonymous.response);
  const secondLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: secondAnonymousCookie,
    csrf: secondAnonymous.payload.csrfToken,
    body: { username, password: initialPassword }
  });
  assert.equal(secondLogin.response.status, 200);
  const secondDeviceCookie = cookieFrom(secondLogin.response);
  const secondDeviceStatus = await jsonRequest(secondOrigin, '/api/status', { cookie: secondDeviceCookie });
  assert.equal(secondDeviceStatus.payload.account.authenticated, true);
  assert.equal(secondDeviceStatus.payload.addonUrl, savedAddonUrl);

  // Recovery consumes a code once, rotates the entire recovery set, and
  // invalidates both signed-in devices.
  const recovery = await jsonRequest(secondOrigin, '/api/account/recover', {
    method: 'POST',
    cookie: secondDeviceCookie,
    csrf: secondDeviceStatus.payload.csrfToken,
    body: { username, recoveryCode: originalRecoveryCode, newPassword: changedPassword }
  });
  assert.equal(recovery.response.status, 200);
  assert.equal(recovery.payload.recoveryCodes.length, 10);
  assert.notEqual(recovery.payload.recoveryCodes[0], originalRecoveryCode);

  const revokedFirstDevice = await jsonRequest(secondOrigin, '/api/status', { cookie: firstDeviceCookie });
  assert.equal(revokedFirstDevice.payload.account.authenticated, false);
  assert.equal(revokedFirstDevice.payload.connected, false);

  const postRecoveryAnonymous = await jsonRequest(secondOrigin, '/api/status');
  const postRecoveryCookie = cookieFrom(postRecoveryAnonymous.response);
  const reusedCode = await jsonRequest(secondOrigin, '/api/account/recover', {
    method: 'POST',
    cookie: postRecoveryCookie,
    csrf: postRecoveryAnonymous.payload.csrfToken,
    body: { username, recoveryCode: originalRecoveryCode, newPassword: 'another-new-passphrase-2026' }
  });
  assert.equal(reusedCode.response.status, 400);

  const newLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: postRecoveryCookie,
    csrf: postRecoveryAnonymous.payload.csrfToken,
    body: { username, password: changedPassword }
  });
  assert.equal(newLogin.response.status, 200);
  const newDeviceCookie = cookieFrom(newLogin.response);
  const newDeviceStatus = await jsonRequest(secondOrigin, '/api/status', { cookie: newDeviceCookie });
  assert.equal(newDeviceStatus.payload.account.authenticated, true);
  assert.equal(newDeviceStatus.payload.addonUrl, savedAddonUrl);
});
