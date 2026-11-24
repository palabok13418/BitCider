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
      BITCIDER_PUBLIC_URL: 'http://127.0.0.1:' + port,
      BITCIDER_ALLOW_LOOPBACK_ADMIN: 'true',
      BITCIDER_ENCRYPTION_KEY: encryptionKey
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  const origin = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error('BitCider exited during startup: ' + stderr);
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
    throw new Error('BitCider did not become ready: ' + stderr);
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

test('account center rotates secrets and permanently deletes the account and origin session', { timeout: 60000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-account-center-'));
  const port = await freePort();
  const encryptionKey = crypto.randomBytes(32).toString('base64url');
  const initialPassword = 'account-center-first-password-2026';
  const nextPassword = 'account-center-next-password-2026';
  const fakeCiderToken = 'bitcider-account-center-integration-token-never-store-plaintext';
  let server;

  t.after(async () => {
    if (server) await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  server = await startServer({ port, dataDir, encryptionKey });
  const origin = server.origin;

  const initialStatus = await jsonRequest(origin, '/api/status');
  assert.equal(initialStatus.response.status, 200);
  assert.equal(initialStatus.payload.apiVersion, '2026-11-24-account-center-v12');
  const anonymousCookie = cookieFrom(initialStatus.response);

  const linked = await jsonRequest(origin, '/api/connect', {
    method: 'POST',
    cookie: anonymousCookie,
    csrf: initialStatus.payload.csrfToken,
    body: { token: fakeCiderToken, scopes: ['playback', 'queue', 'library', 'audio'] }
  });
  assert.equal(linked.response.status, 200);

  const registration = await jsonRequest(origin, '/api/account/register', {
    method: 'POST',
    cookie: anonymousCookie,
    csrf: initialStatus.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.payload.recoveryCodes.length, 10);
  assert.match(registration.payload.accountKey, /^[A-Za-z0-9_-]{43}$/);
  const cookie = cookieFrom(registration.response);

  const storePath = path.join(dataDir, 'connection.json');
  const storeWithPasskey = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const accountId = Object.keys(storeWithPasskey.accounts)[0];
  assert.ok(accountId);
  storeWithPasskey.accounts[accountId].passkeys = [{
    id: 'integration-passkey-id',
    publicKey: Buffer.from('integration-public-key').toString('base64url'),
    counter: 0,
    transports: ['internal'],
    deviceType: 'singleDevice',
    backedUp: false,
    rpID: '127.0.0.1',
    name: 'Test device passkey',
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  }];
  await fs.writeFile(storePath, JSON.stringify(storeWithPasskey, null, 2));

  const signedInStatus = await jsonRequest(origin, '/api/status', { cookie });
  assert.equal(signedInStatus.payload.account.authenticated, true);
  assert.equal(signedInStatus.payload.account.accountKeyConfigured, true);
  assert.equal(signedInStatus.payload.account.passwordConfigured, true);
  assert.equal(signedInStatus.payload.account.recoveryCodeCount, 10);
  assert.equal(signedInStatus.payload.passkeys.length, 1);
  assert.equal(signedInStatus.payload.passkeys[0].name, 'Test device passkey');
  assert.equal(JSON.stringify(signedInStatus.payload).includes(initialPassword), false);
  assert.equal(JSON.stringify(signedInStatus.payload).includes(registration.payload.accountKey), false);

  const oldAccountKeyHash = storeWithPasskey.accounts[accountId].accountKeyHash;
  const newKey = await jsonRequest(origin, '/api/account/key/rotate', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(newKey.response.status, 200);
  assert.match(newKey.payload.accountKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newKey.payload.accountKey, registration.payload.accountKey);

  const afterKeyRotation = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.notEqual(afterKeyRotation.accounts[accountId].accountKeyHash, oldAccountKeyHash);
  assert.equal(JSON.stringify(afterKeyRotation).includes(newKey.payload.accountKey), false);

  const oldRecoveryHashes = afterKeyRotation.accounts[accountId].recoveryCodeHashes;
  const newCodes = await jsonRequest(origin, '/api/account/recovery-codes/rotate', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(newCodes.response.status, 200);
  assert.equal(newCodes.payload.recoveryCodes.length, 10);
  const afterCodeRotation = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.notDeepEqual(afterCodeRotation.accounts[accountId].recoveryCodeHashes, oldRecoveryHashes);
  assert.equal(JSON.stringify(afterCodeRotation).includes(newCodes.payload.recoveryCodes[0]), false);

  const passwordChange = await jsonRequest(origin, '/api/account/password/change', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: { currentPassword: initialPassword, newPassword: nextPassword }
  });
  assert.equal(passwordChange.response.status, 200);

  const statusAfterPasswordChange = await jsonRequest(origin, '/api/status', { cookie });
  assert.equal(statusAfterPasswordChange.payload.account.authenticated, true);
  assert.equal(statusAfterPasswordChange.payload.account.recoveryCodeCount, 10);
  assert.equal(statusAfterPasswordChange.payload.passkeyCount, 1);

  const badDelete = await jsonRequest(origin, '/api/account/delete', {
    method: 'POST',
    cookie,
    csrf: statusAfterPasswordChange.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(badDelete.response.status, 401);
  assert.equal(badDelete.payload.error, 'REAUTHENTICATION_REQUIRED');

  const deletionResponse = await fetch(origin + '/api/account/delete', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-BitCider-CSRF': statusAfterPasswordChange.payload.csrfToken
    },
    body: JSON.stringify({ password: nextPassword }),
    cache: 'no-store'
  });
  assert.equal(deletionResponse.status, 200);
  assert.match(deletionResponse.headers.get('content-type') || '', /text\/event-stream/i);
  assert.match(deletionResponse.headers.get('clear-site-data') || '', /"cache"/i);
  assert.match(deletionResponse.headers.get('clear-site-data') || '', /"storage"/i);
  assert.match(deletionResponse.headers.get('set-cookie') || '', /Max-Age=0/i);

  const eventText = await deletionResponse.text();
  const events = eventText
    .split('\n\n')
    .map(block => block.split('\n').find(line => line.startsWith('data:')))
    .filter(Boolean)
    .map(line => JSON.parse(line.slice(5).trim()));
  assert.ok(events.length >= 3);
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-1).progress, 100);
  assert.ok(events.some(event => /passkeys, backup codes, Account Key/i.test(event.label)));

  const deletedStore = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.deepEqual(deletedStore.accounts, {});
  assert.deepEqual(deletedStore.authSessions, {});
  assert.equal(JSON.stringify(deletedStore).includes(fakeCiderToken), false);
  assert.equal(JSON.stringify(deletedStore).includes(registration.payload.accountKey), false);
  assert.equal(JSON.stringify(deletedStore).includes(newKey.payload.accountKey), false);
  assert.equal(JSON.stringify(deletedStore).includes(newCodes.payload.recoveryCodes[0]), false);

  const freshStatus = await jsonRequest(origin, '/api/status');
  assert.equal(freshStatus.response.status, 200);
  assert.equal(freshStatus.payload.account.authenticated, false);
  assert.equal(freshStatus.payload.connected, false);
});
