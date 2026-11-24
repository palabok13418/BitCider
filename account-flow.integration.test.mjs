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

async function connectExistingCiderToken(origin, cookie, csrf, token) {
  return jsonRequest(origin, '/api/connect', {
    method: 'POST',
    cookie,
    csrf,
    body: { token, scopes: ['playback', 'queue', 'library', 'audio'] }
  });
}

test('Account setup silently offers credentials to Chrome Password Manager', async () => {
  const appSource = await fs.readFile(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
  const styleSource = await fs.readFile(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.ok(appSource.includes("entry.brand === 'Google Chrome'"));
  assert.ok(appSource.includes('new window.PasswordCredential({'));
  assert.ok(appSource.includes('id: accountKey,'));
  assert.ok(appSource.includes("name: 'BitCider Account'"));
  assert.ok(appSource.includes("navigator.credentials.store(credential)"));
  assert.ok(appSource.includes('saveCredentialsInChrome(createdAccountKey, password)'));
  assert.ok(appSource.includes('saveCredentialsInChrome(recoveredAccountKey, password)'));
  assert.ok(appSource.includes('id="account-key" name="username" type="text" autoComplete="username"'));
  assert.ok(appSource.includes('id="account-password" name="password" type="password" autoComplete="current-password"'));
  assert.ok(appSource.includes('requestChromePasswordManagerSave(accountKeyValue, passwordValue).catch(() => {})'));
  assert.doesNotMatch(appSource, /passwordManagerStatus|account-password-manager-note|GOOGLE PASSWORD MANAGER/);
  assert.doesNotMatch(styleSource, /account-password-manager-note/);
});

test('signup password generator uses secure random Unicode groups and paired hidden confirmation', async () => {
  const appSource = await fs.readFile(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
  const styleSource = await fs.readFile(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.ok(appSource.includes('const length = 24 + secureRandomIndex(477)'));
  assert.ok(appSource.includes('window.crypto.getRandomValues(sample)'));
  assert.ok(appSource.includes("Array.from('ضصثقفقغعهخحجددذرزسشص')"));
  assert.ok(appSource.includes("Array.from('密碼鍵龍影秘語字夢狐霧夜星')"));
  assert.ok(appSource.includes("'a\\\\u0336\\\\u035c\\\\u0315'"));
  assert.ok(appSource.includes("setPasswordConfirm(generated)"));
  assert.ok(appSource.includes("placeholder=\"Start Typing\""));
  assert.ok(appSource.includes("placeholder=\"Password123\"") === false);
  assert.ok(appSource.includes("isGeneratedPassword && !passwordVisible ? 'Password123'"));
  assert.ok(appSource.includes('function togglePasswordVisibility()'));
  assert.ok(appSource.includes('morphPasswordText(from, to, frame / totalFrames)'));
  assert.ok(appSource.includes('aria-label={passwordVisible ? \'Hide password\' : \'Show password\'}'));
  assert.ok(styleSource.includes('.account-password-shell {'));
  assert.ok(styleSource.includes('.account-password-generator { left: 6px;'));
  assert.ok(styleSource.includes('.account-password-visibility { right: 6px;'));
  assert.ok(styleSource.includes('@keyframes password-decrypt-text'));
  assert.ok(styleSource.includes('@keyframes password-encrypt-text'));
});
test('BitCider accounts restore cloud links across sessions and survive encryption-key migration', { timeout: 60000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-account-flow-'));
  const port = await freePort();
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
    body: { password: initialPassword }
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
    body: { password: initialPassword }
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.payload.recoveryCodes.length, 10);
  assert.match(registration.payload.accountKey, /^[A-Za-z0-9_-]{43}$/);
  const originalRecoveryCode = registration.payload.recoveryCodes[0];
  const firstDeviceCookie = cookieFrom(registration.response);

  const oldAccountStore = JSON.parse(await fs.readFile(path.join(dataDir, 'connection.json'), 'utf8'));
  const oldAccount = Object.values(oldAccountStore.accounts)[0];
  assert.equal(typeof oldAccount.accountKeyHash, 'string');
  assert.equal(JSON.stringify(oldAccountStore).includes(registration.payload.accountKey), false);
  oldAccount.username = 'legacy-account-name';
  delete oldAccount.accountKeyHash;
  await fs.writeFile(path.join(dataDir, 'connection.json'), JSON.stringify(oldAccountStore, null, 2));
  await server.stop();
  server = null;
  server = await startServer({ port, dataDir, encryptionKey: dedicatedKey });

  const firstDeviceStatus = await jsonRequest(server.origin, '/api/status', { cookie: firstDeviceCookie });
  const migratedAccountStore = JSON.parse(await fs.readFile(path.join(dataDir, 'connection.json'), 'utf8'));
  const migratedAccount = Object.values(migratedAccountStore.accounts)[0];
  assert.equal(Object.hasOwn(migratedAccount, 'username'), false);
  assert.equal(firstDeviceStatus.payload.account.authenticated, true);
  assert.equal(Object.hasOwn(firstDeviceStatus.payload.account, 'username'), false);
  assert.equal(Object.hasOwn(firstDeviceStatus.payload.account, 'accountKey'), false);
  assert.equal(firstDeviceStatus.payload.connected, true);
  assert.equal(firstDeviceStatus.payload.addonUrl, savedAddonUrl);

  const manifestResponse = await fetch(savedAddonUrl);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('cache-control') || '', /no-store/i);
  assert.equal(manifestResponse.headers.get('cache-control')?.includes('public'), false);

  // A fresh browser cannot password-sign-in before Cider identifies the account.
  const unlinkedBrowser = await jsonRequest(secondOrigin, '/api/status');
  const unlinkedBrowserCookie = cookieFrom(unlinkedBrowser.response);
  const unlinkedPasswordLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: unlinkedBrowserCookie,
    csrf: unlinkedBrowser.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(unlinkedPasswordLogin.response.status, 401);

  // A second browser that approves the same Cider token is directed to the
  // existing account instead of creating a duplicate anonymous connection.
  const secondAnonymous = await jsonRequest(secondOrigin, '/api/status');
  const secondAnonymousCookie = cookieFrom(secondAnonymous.response);
  const duplicateLink = await jsonRequest(secondOrigin, '/api/connect', {
    method: 'POST',
    cookie: secondAnonymousCookie,
    csrf: secondAnonymous.payload.csrfToken,
    body: { token: fakeCiderToken, scopes: ['playback', 'queue', 'library', 'audio'] }
  });
  assert.equal(duplicateLink.response.status, 200);
  assert.equal(duplicateLink.payload.accountLinked, true);
  assert.equal(Object.hasOwn(duplicateLink.payload, 'username'), false);
  assert.equal(duplicateLink.payload.hasPasskeys, false);
  const duplicateBrowserStatus = await jsonRequest(secondOrigin, '/api/status', { cookie: secondAnonymousCookie });
  assert.equal(duplicateBrowserStatus.payload.connected, false);
  assert.equal(duplicateBrowserStatus.payload.pendingAccountSetup, false);

  // A clean second browser can sign in and recover the account-owned addon URL.
  const secondLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: secondAnonymousCookie,
    csrf: secondAnonymous.payload.csrfToken,
    body: { password: initialPassword }
  });
  assert.equal(secondLogin.response.status, 200);
  assert.match(secondLogin.payload.accountKey, /^[A-Za-z0-9_-]{43}$/);
  const activeAccountKey = secondLogin.payload.accountKey;
  const secondDeviceCookie = cookieFrom(secondLogin.response);
  const secondDeviceStatus = await jsonRequest(secondOrigin, '/api/status', { cookie: secondDeviceCookie });
  assert.equal(secondDeviceStatus.payload.account.authenticated, true);
  assert.equal(secondDeviceStatus.payload.addonUrl, savedAddonUrl);


  // Account Key plus password restores a saved link on a device without Cider pre-linking.
  const accountKeyBrowser = await jsonRequest(secondOrigin, '/api/status');
  const accountKeyCookie = cookieFrom(accountKeyBrowser.response);
  const accountKeyLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: accountKeyCookie,
    csrf: accountKeyBrowser.payload.csrfToken,
    body: { accountKey: activeAccountKey, password: initialPassword }
  });
  assert.equal(accountKeyLogin.response.status, 200);
  const accountKeyDeviceCookie = cookieFrom(accountKeyLogin.response);
  const accountKeyDeviceStatus = await jsonRequest(secondOrigin, '/api/status', { cookie: accountKeyDeviceCookie });
  assert.equal(accountKeyDeviceStatus.payload.addonUrl, savedAddonUrl);

  // Enforce a maximum of five active device sessions. A sixth sign-in evicts
  // the least-recently-active session and keeps the account within the cap.
  for (let index = 0; index < 2; index += 1) {
    const anonymousDevice = await jsonRequest(secondOrigin, '/api/status');
    const anonymousDeviceCookie = cookieFrom(anonymousDevice.response);
    const signIn = await jsonRequest(secondOrigin, '/api/account/login', {
      method: 'POST',
      cookie: anonymousDeviceCookie,
      csrf: anonymousDevice.payload.csrfToken,
      body: { accountKey: activeAccountKey, password: initialPassword }
    });
    assert.equal(signIn.response.status, 200);
  }
  const atFiveDevices = await jsonRequest(secondOrigin, '/api/status', { cookie: secondDeviceCookie });
  assert.equal(atFiveDevices.payload.deviceCount, 5);
  assert.equal(atFiveDevices.payload.devices.length, 5);
  assert.equal(atFiveDevices.payload.deviceLimit, 5);

  const sixthAnonymous = await jsonRequest(secondOrigin, '/api/status');
  const sixthAnonymousCookie = cookieFrom(sixthAnonymous.response);
  const sixthLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: sixthAnonymousCookie,
    csrf: sixthAnonymous.payload.csrfToken,
    body: { accountKey: activeAccountKey, password: initialPassword }
  });
  assert.equal(sixthLogin.response.status, 200);
  assert.ok(sixthLogin.payload.evictedDevice);
  const sixthDeviceCookie = cookieFrom(sixthLogin.response);
  const afterSixthDevice = await jsonRequest(secondOrigin, '/api/status', { cookie: sixthDeviceCookie });
  assert.equal(afterSixthDevice.payload.deviceCount, 5);
  assert.equal(afterSixthDevice.payload.passkeyLimit, 5);
  const evictedOldestDevice = await jsonRequest(secondOrigin, '/api/status', { cookie: firstDeviceCookie });
  assert.equal(evictedOldestDevice.payload.account.authenticated, false);

  // Passkey challenges are short-lived and single-use, including failed
  // responses, so a captured assertion cannot be replayed.
  const passkeyAnonymous = await jsonRequest(secondOrigin, '/api/status');
  const passkeyAnonymousCookie = cookieFrom(passkeyAnonymous.response);
  const passkeyOptions = await jsonRequest(secondOrigin, '/api/account/passkeys/auth/options', {
    method: 'POST',
    cookie: passkeyAnonymousCookie,
    csrf: passkeyAnonymous.payload.csrfToken,
    body: {}
  });
  assert.equal(passkeyOptions.response.status, 200);
  assert.equal(typeof passkeyOptions.payload.challenge, 'string');
  const invalidPasskey = await jsonRequest(secondOrigin, '/api/account/passkeys/auth/verify', {
    method: 'POST',
    cookie: passkeyAnonymousCookie,
    csrf: passkeyAnonymous.payload.csrfToken,
    body: { id: 'not-a-registered-credential', response: { userHandle: 'not-a-user' } }
  });
  assert.equal(invalidPasskey.response.status, 401);
  const replayedPasskey = await jsonRequest(secondOrigin, '/api/account/passkeys/auth/verify', {
    method: 'POST',
    cookie: passkeyAnonymousCookie,
    csrf: passkeyAnonymous.payload.csrfToken,
    body: { id: 'not-a-registered-credential', response: { userHandle: 'not-a-user' } }
  });
  assert.equal(replayedPasskey.response.status, 400);

  // Recovery consumes a code once, rotates the entire recovery set, and
  // invalidates both signed-in devices.
  const recoveryBrowser = await jsonRequest(secondOrigin, '/api/status');
  const recoveryCookie = cookieFrom(recoveryBrowser.response);
  const recovery = await jsonRequest(secondOrigin, '/api/account/recover', {
    method: 'POST',
    cookie: recoveryCookie,
    csrf: recoveryBrowser.payload.csrfToken,
    body: { recoveryCode: originalRecoveryCode, newPassword: changedPassword }
  });
  assert.equal(recovery.response.status, 200);
  assert.equal(recovery.payload.recoveryCodes.length, 10);
  assert.match(recovery.payload.accountKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(recovery.payload.accountKey, activeAccountKey);
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
    body: { recoveryCode: originalRecoveryCode, newPassword: 'another-new-passphrase-2026' }
  });
  assert.equal(reusedCode.response.status, 400);

  const staleKeyLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: postRecoveryCookie,
    csrf: postRecoveryAnonymous.payload.csrfToken,
    body: { accountKey: activeAccountKey, password: changedPassword }
  });
  assert.equal(staleKeyLogin.response.status, 401);
  const newLogin = await jsonRequest(secondOrigin, '/api/account/login', {
    method: 'POST',
    cookie: postRecoveryCookie,
    csrf: postRecoveryAnonymous.payload.csrfToken,
    body: { accountKey: recovery.payload.accountKey, password: changedPassword }
  });
  assert.equal(newLogin.response.status, 200);
  const newDeviceCookie = cookieFrom(newLogin.response);
  const newDeviceStatus = await jsonRequest(secondOrigin, '/api/status', { cookie: newDeviceCookie });
  assert.equal(newDeviceStatus.payload.account.authenticated, true);
  assert.equal(newDeviceStatus.payload.addonUrl, savedAddonUrl);
});


test('header brand stays pinned to the top-left while account actions align right', async () => {
  const appSource = await fs.readFile(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
  const styleSource = await fs.readFile(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const headerStart = appSource.indexOf('<header className="topbar">');
  const headerEnd = appSource.indexOf('</header>', headerStart);
  assert.ok(headerStart >= 0 && headerEnd > headerStart);
  const headerSource = appSource.slice(headerStart, headerEnd);
  assert.ok(headerSource.indexOf('<a className={`brand') < headerSource.indexOf('className="account-avatar-trigger"'));
  assert.ok(styleSource.includes('.topbar {\\n  width: 100%;\\n  max-width: 1320px;'));
  assert.ok(styleSource.includes('justify-content: flex-start;'));
  assert.ok(styleSource.includes('gap: 11px; margin-right: auto;'));
  assert.ok(styleSource.includes('.account-avatar-trigger {\\n  margin-left: auto;'));
});
