import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getUnifiedAccountProductLabel } from './src/unified-account-center.mjs';

test('unified account center identifies both products when both sessions are active', () => {
  assert.equal(getUnifiedAccountProductLabel({ bitCider: true, bitConnection: true }), 'Both');
});

test('unified account center identifies BitCider-only and BitConnection-only sessions', () => {
  assert.equal(getUnifiedAccountProductLabel({ bitCider: true, bitConnection: false }), 'BitCider');
  assert.equal(getUnifiedAccountProductLabel({ bitCider: false, bitConnection: true }), 'BitConnection');
});

test('unified account center does not label an anonymous browser as signed in', () => {
  assert.equal(getUnifiedAccountProductLabel({ bitCider: false, bitConnection: false }), 'No active account');
});

test('both product account screens use the shared unified identity header', async () => {
  const [appSource, connectionSource, sharedSource, sharedCss] = await Promise.all([
    fs.readFile(new URL('./src/App.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('./src/BitConnection.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('./src/UnifiedAccountCenter.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('./src/unified-account-center.css', import.meta.url), 'utf8')
  ]);
  assert.ok(appSource.includes('<UnifiedAccountCenterIdentity'));
  assert.ok(connectionSource.includes('<UnifiedAccountCenterIdentity'));
  assert.ok(sharedSource.includes('UNIFIED ACCOUNT CENTER'));
  assert.ok(sharedSource.includes('BitCider settings'));
  assert.ok(sharedSource.includes('BitConnection settings'));
  assert.ok(sharedCss.includes('.unified-account-center-product.is-active'));
});
