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

function cookieNamed(response, name) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = values.filter(value => value.startsWith(name + '=')).at(-1);
  assert.ok(cookie, 'expected ' + name + ' cookie');
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

test('BitAccount Center shares BitCider account deletion across both product settings while keeping passkey gates', async () => {
  const [appSource, connectionSource, deletionSource, styleSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'src', 'App.jsx'), 'utf8'),
    fs.readFile(path.join(ROOT, 'src', 'BitConnection.jsx'), 'utf8'),
    fs.readFile(path.join(ROOT, 'src', 'AccountDeletionSection.jsx'), 'utf8'),
    fs.readFile(path.join(ROOT, 'src', 'styles.css'), 'utf8')
  ]);
  const panelStart = appSource.indexOf('function AccountManagementOverlay(');
  const panelEnd = appSource.indexOf('export default function App()', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const panel = appSource.slice(panelStart, panelEnd);

  assert.doesNotMatch(panel, /Profile image|CONFIRM YOUR PASSWORD FOR SECURITY CHANGES/);
  assert.doesNotMatch(panel, /Enter your current password.*before deleting/i);
  assert.ok(panel.includes('<AccountDeletionSection status={status} csrfToken={csrfToken} onDeleted={onDeleted} />'));
  assert.ok(connectionSource.includes('<AccountDeletionSection />'));
  assert.ok(panel.includes('startAuthentication({ optionsJSON })'));
  assert.ok(panel.includes("disabled={!(status.passkeys || []).length || busyAction === 'account-key'}"));
  assert.ok(panel.includes("disabled={!(status.passkeys || []).length || busyAction === 'backup-codes'}"));
  assert.doesNotMatch(panel, /Add a passkey to this account first\./);
  assert.ok(panel.includes('startRegistration({ optionsJSON })'));
  assert.ok(panel.includes("'/api/account/passkeys/register/options', { password: passkeyPassword }"));

  assert.ok(deletionSource.includes("fetch('/api/account/delete'"));
  assert.ok(deletionSource.includes("'X-BitCider-CSRF': token"));
  assert.ok(deletionSource.includes("confirmation.trim() !== 'DELETE'"));
  assert.ok(deletionSource.includes("response.body?.getReader()"));
  assert.ok(deletionSource.includes("event.type === 'complete'"));
  assert.ok(deletionSource.includes('Your separate BitConnection account is not deleted.'));
  assert.ok(deletionSource.includes('bitaccount-delete-dialog'));

  assert.ok(styleSource.includes('.account-center-content {'));
  assert.ok(styleSource.includes('.account-center-password-label input'));
});


test('an existing BitConnection account can explicitly link to BitCider and restore its shared session after a later sign-in', { timeout: 60000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitaccount-link-'));
  const port = await freePort();
  const encryptionKey = crypto.randomBytes(32).toString('base64url');
  const username = 'existing-bitconnection-user';
  const password = 'existing-bitconnection-password-2026';
  const fakeCiderToken = 'bitaccount-link-integration-token-never-store-plaintext';
  let server;

  t.after(async () => {
    if (server) await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  server = await startServer({ port, dataDir, encryptionKey });
  const origin = server.origin;

  const firstBitConnectionResponse = await fetch(origin + '/api/bitconnection/account', { cache: 'no-store' });
  assert.equal(firstBitConnectionResponse.status, 200);
  const firstBitConnection = await firstBitConnectionResponse.json();
  const bitConnectionCookie = cookieNamed(firstBitConnectionResponse, 'bitconnection_session');

  const registrationResponse = await fetch(origin + '/api/bitconnection/auth/register', {
    method: 'POST',
    headers: {
      Cookie: bitConnectionCookie,
      'Content-Type': 'application/json',
      'X-BitConnection-CSRF': firstBitConnection.csrfToken
    },
    body: JSON.stringify({ username, password }),
    cache: 'no-store'
  });
  assert.equal(registrationResponse.status, 201);

  const anonymousCiderStatus = await jsonRequest(origin, '/api/status');
  const anonymousCiderCookie = cookieFrom(anonymousCiderStatus.response);
  const stagedConnection = await jsonRequest(origin, '/api/connect', {
    method: 'POST',
    cookie: anonymousCiderCookie,
    csrf: anonymousCiderStatus.payload.csrfToken,
    body: { token: fakeCiderToken, scopes: ['playback', 'queue', 'library', 'audio'] }
  });
  assert.equal(stagedConnection.response.status, 200);

  const linkResponse = await fetch(origin + '/api/bitconnection/account/link-bitcider', {
    method: 'POST',
    headers: {
      Cookie: bitConnectionCookie + '; ' + anonymousCiderCookie,
      'Content-Type': 'application/json',
      'X-BitConnection-CSRF': firstBitConnection.csrfToken
    },
    body: JSON.stringify({}),
    cache: 'no-store'
  });
  assert.equal(linkResponse.status, 200);
  const linkedPayload = await linkResponse.json();
  assert.equal(linkedPayload.linked, true);
  assert.equal(linkedPayload.newlyCreated, true);
  const linkedCiderCookie = cookieNamed(linkResponse, 'bitcider_session');

  const linkedStatus = await jsonRequest(origin, '/api/status', { cookie: linkedCiderCookie });
  assert.equal(linkedStatus.payload.account.authenticated, true);
  assert.equal(linkedStatus.payload.account.identityProvider, 'bitconnection');
  assert.equal(linkedStatus.payload.account.linkedBitConnectionUsername, username);
  assert.equal(linkedStatus.payload.connected, true);

  const linkedBitConnectionResponse = await fetch(origin + '/api/bitconnection/account', {
    headers: { Cookie: bitConnectionCookie + '; ' + linkedCiderCookie },
    cache: 'no-store'
  });
  const linkedBitConnection = await linkedBitConnectionResponse.json();
  assert.equal(linkedBitConnection.authenticated, true);
  assert.equal(linkedBitConnection.linkedToBitCider, true);
  assert.equal(linkedBitConnection.bitCiderAccountAvailable, true);
  assert.equal(linkedBitConnection.profile.username, username);

  const linkedCiderIdentityResponse = await fetch(origin + '/api/bitconnection/account', {
    headers: {
      Cookie: bitConnectionCookie + '; ' + linkedCiderCookie,
      'X-BitConnection-Identity': 'bitcider'
    },
    cache: 'no-store'
  });
  const linkedCiderIdentity = await linkedCiderIdentityResponse.json();
  assert.equal(linkedCiderIdentity.authenticated, true);
  assert.equal(linkedCiderIdentity.profile.username, username);

  const secondDeviceResponse = await fetch(origin + '/api/bitconnection/account', { cache: 'no-store' });
  const secondDeviceStatus = await secondDeviceResponse.json();
  const secondDeviceBitConnectionCookie = cookieNamed(secondDeviceResponse, 'bitconnection_session');
  const secondDeviceLogin = await fetch(origin + '/api/bitconnection/auth/login', {
    method: 'POST',
    headers: {
      Cookie: secondDeviceBitConnectionCookie,
      'Content-Type': 'application/json',
      'X-BitConnection-CSRF': secondDeviceStatus.csrfToken
    },
    body: JSON.stringify({ username, password }),
    cache: 'no-store'
  });
  assert.equal(secondDeviceLogin.status, 200);

  const secondDeviceAccountResponse = await fetch(origin + '/api/bitconnection/account', {
    headers: { Cookie: secondDeviceBitConnectionCookie },
    cache: 'no-store'
  });
  const secondDeviceAccount = await secondDeviceAccountResponse.json();
  assert.equal(secondDeviceAccount.linkedToBitCider, true);
  const secondDeviceCiderCookie = cookieNamed(secondDeviceAccountResponse, 'bitcider_session');
  const secondDeviceCiderStatus = await jsonRequest(origin, '/api/status', { cookie: secondDeviceCiderCookie });
  assert.equal(secondDeviceCiderStatus.payload.account.authenticated, true);
  assert.equal(secondDeviceCiderStatus.payload.connected, true);
});

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
  assert.equal(initialStatus.payload.apiVersion, '2026-11-28-bitaccount-link-v1');
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

  const prePasskeyStatus = await jsonRequest(origin, '/api/status', { cookie });
  assert.equal(prePasskeyStatus.payload.account.authenticated, true);
  const revealWithoutPasskey = await jsonRequest(origin, '/api/account/secrets/reveal/options', {
    method: 'POST',
    cookie,
    csrf: prePasskeyStatus.payload.csrfToken,
    body: { secretType: 'account-key' }
  });
  assert.equal(revealWithoutPasskey.response.status, 409);
  assert.equal(revealWithoutPasskey.payload.error, 'PASSKEY_REQUIRED');

  const storePath = path.join(dataDir, 'connection.json');
  const storeWithPasskey = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const accountId = Object.keys(storeWithPasskey.accounts)[0];
  assert.ok(accountId);
  storeWithPasskey.accounts[accountId].webAuthnUserId = crypto.randomBytes(32).toString('base64url');
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

  const secretRevealWithoutAssertion = await jsonRequest(origin, '/api/account/secrets/reveal', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: {}
  });
  assert.equal(secretRevealWithoutAssertion.response.status, 400);
  assert.equal(secretRevealWithoutAssertion.payload.error, 'PASSKEY_CHALLENGE_EXPIRED');

  const keyRevealOptions = await jsonRequest(origin, '/api/account/secrets/reveal/options', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: { secretType: 'account-key' }
  });
  assert.equal(keyRevealOptions.response.status, 200);
  assert.equal(keyRevealOptions.payload.userVerification, 'required');
  assert.equal(keyRevealOptions.payload.allowCredentials[0].id, 'integration-passkey-id');
  const keyChallengeStore = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const keyChallenge = Object.values(keyChallengeStore.webauthnChallenges)[0];
  assert.equal(keyChallenge.purpose, 'reveal-secret');
  assert.equal(keyChallenge.accountId, accountId);
  assert.equal(keyChallenge.secretType, 'account-key');

  const backupRevealOptions = await jsonRequest(origin, '/api/account/secrets/reveal/options', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: { secretType: 'backup-codes' }
  });
  assert.equal(backupRevealOptions.response.status, 200);
  assert.equal(backupRevealOptions.payload.userVerification, 'required');

  const addPasskeyWithoutPassword = await jsonRequest(origin, '/api/account/passkeys/register/options', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: {}
  });
  assert.equal(addPasskeyWithoutPassword.response.status, 401);
  assert.equal(addPasskeyWithoutPassword.payload.error, 'REAUTHENTICATION_REQUIRED');

  const oldKeyRoute = await jsonRequest(origin, '/api/account/key/rotate', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(oldKeyRoute.response.status, 404);

  const oldBackupRoute = await jsonRequest(origin, '/api/account/recovery-codes/rotate', {
    method: 'POST',
    cookie,
    csrf: signedInStatus.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(oldBackupRoute.response.status, 404);

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

  const deletionResponse = await fetch(origin + '/api/account/delete', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-BitCider-CSRF': statusAfterPasswordChange.payload.csrfToken
    },
    body: JSON.stringify({}),
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

  const freshStatus = await jsonRequest(origin, '/api/status');
  assert.equal(freshStatus.response.status, 200);
  assert.equal(freshStatus.payload.account.authenticated, false);
  assert.equal(freshStatus.payload.connected, false);
});
