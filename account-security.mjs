import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const PASSWORD_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ACCOUNT_DEVICES = 5;
export const MAX_PASSKEYS_PER_ACCOUNT = 5;
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  return /^[a-z0-9][a-z0-9._-]{2,23}$/.test(username) ? username : null;
}

export function validatePassword(value) {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.byteLength(value, 'utf8');
  return value.length >= 14 && value.length <= 128 && bytes <= 512;
}

export async function createPasswordRecord(password) {
  if (!validatePassword(password)) throw new Error('Use a passphrase between 14 and 128 characters.');
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, PASSWORD_SCRYPT.keylen, PASSWORD_SCRYPT);
  return {
    algorithm: 'scrypt',
    N: PASSWORD_SCRYPT.N,
    r: PASSWORD_SCRYPT.r,
    p: PASSWORD_SCRYPT.p,
    salt: salt.toString('base64url'),
    hash: Buffer.from(hash).toString('base64url')
  };
}

export async function verifyPassword(password, record) {
  if (typeof password !== 'string' || !record || record.algorithm !== 'scrypt'
    || record.N !== PASSWORD_SCRYPT.N || record.r !== PASSWORD_SCRYPT.r || record.p !== PASSWORD_SCRYPT.p) {
    return false;
  }
  try {
    const salt = Buffer.from(record.salt, 'base64url');
    const expected = Buffer.from(record.hash, 'base64url');
    if (salt.length !== 16 || expected.length !== PASSWORD_SCRYPT.keylen) return false;
    const actual = Buffer.from(await scrypt(password, salt, PASSWORD_SCRYPT.keylen, PASSWORD_SCRYPT));
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashRecoveryCode(code) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-F0-9]/g, '');
  if (!/^[A-F0-9]{24}$/.test(normalized)) return '';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function createRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
    return raw.match(/.{1,4}/g).join('-');
  });
  return {
    codes,
    hashes: codes.map(hashRecoveryCode)
  };
}

export function consumeRecoveryCode(code, savedHashes = []) {
  const candidate = hashRecoveryCode(code);
  if (!candidate) return { valid: false, hashes: savedHashes };
  const candidateBytes = Buffer.from(candidate, 'hex');
  let matchedIndex = -1;
  // Compare every stored hash so the position of a matching recovery code
  // does not affect how long the verification loop runs.
  savedHashes.forEach((saved, index) => {
    if (!/^[a-f0-9]{64}$/i.test(saved)) return;
    const matches = crypto.timingSafeEqual(candidateBytes, Buffer.from(saved, 'hex'));
    if (matches) matchedIndex = index;
  });
  if (matchedIndex < 0) return { valid: false, hashes: savedHashes };
  return { valid: true, hashes: savedHashes.filter((_, index) => index !== matchedIndex) };
}

export function hashSessionId(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId)).digest('hex');
}
