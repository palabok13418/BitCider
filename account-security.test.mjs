import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPasswordRecord,
  verifyPassword,
  validateUsername,
  validatePassword,
  createRecoveryCodes,
  consumeRecoveryCode,
  hashRecoveryCode,
  hashSessionId,
  SESSION_TTL_MS,
  MAX_ACCOUNT_DEVICES,
  MAX_PASSKEYS_PER_ACCOUNT,
  WEBAUTHN_CHALLENGE_TTL_MS
} from './account-security.mjs';

test('username validation normalizes case and enforces a safe identifier format', () => {
  assert.equal(validateUsername('  Ryker_01  '), 'ryker_01');
  assert.equal(validateUsername('ab'), null);
  assert.equal(validateUsername('bad name'), null);
  assert.equal(validateUsername('not/an/account'), null);
});

test('passphrases require at least 14 characters and a bounded maximum', () => {
  assert.equal(validatePassword('correct horse battery'), true);
  assert.equal(validatePassword('short'), false);
  assert.equal(validatePassword('x'.repeat(129)), false);
  assert.equal(validatePassword('é'.repeat(300)), false);
});

test('password records use scrypt and verify without storing plaintext', async () => {
  const password = 'a-long-unique-passphrase-2026';
  const record = await createPasswordRecord(password);
  assert.equal(record.algorithm, 'scrypt');
  assert.equal(record.hash.includes(password), false);
  assert.equal(await verifyPassword(password, record), true);
  assert.equal(await verifyPassword(password + 'wrong', record), false);
  assert.equal(await verifyPassword(password, { ...record, N: 1024 }), false);
});

test('recovery codes are high entropy, formatted, and single use', () => {
  const { codes, hashes } = createRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(hashes.length, 10);
  assert.match(codes[0], /^[A-F0-9]{4}(-[A-F0-9]{4}){5}$/);
  assert.equal(hashRecoveryCode(codes[0]), hashes[0]);
  const used = consumeRecoveryCode(codes[0], hashes);
  assert.equal(used.valid, true);
  assert.equal(used.hashes.length, 9);
  assert.equal(consumeRecoveryCode(codes[0], used.hashes).valid, false);
  assert.equal(consumeRecoveryCode('not-a-recovery-code', hashes).valid, false);
});

test('opaque session identifiers are stored as one-way hashes', () => {
  const first = hashSessionId('session-token-one');
  const second = hashSessionId('session-token-two');
  assert.equal(first.length, 64);
  assert.notEqual(first, second);
  assert.notEqual(first, 'session-token-one');
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(MAX_ACCOUNT_DEVICES, 5);
  assert.equal(MAX_PASSKEYS_PER_ACCOUNT, 5);
  assert.equal(WEBAUTHN_CHALLENGE_TTL_MS, 5 * 60 * 1000);
});
