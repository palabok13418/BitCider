import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createIceConfiguration,
  DEFAULT_BITCONNECTION_STUN_URLS
} from './ice.mjs';

test('default ICE configuration provides public STUN without claiming TURN availability', () => {
  const configuration = createIceConfiguration({}, 'participant-123', 1_700_000_000_000);
  assert.equal(configuration.iceTransportPolicy, 'all');
  assert.equal(configuration.relayAvailable, false);
  assert.equal(configuration.credentialExpiresAt, null);
  assert.deepEqual(configuration.iceServers, DEFAULT_BITCONNECTION_STUN_URLS.map(url => ({ urls: url })));
});

test('coturn REST credentials are participant-scoped, HMAC signed, and short-lived', () => {
  const secret = 'this-is-a-test-secret-with-more-than-32-bytes';
  const now = 1_700_000_000_000;
  const configuration = createIceConfiguration({
    turnUrls: ['turn:relay.example.test:3478?transport=udp', 'turns:relay.example.test:5349?transport=tcp'],
    turnSharedSecret: secret,
    credentialTtlSeconds: 300
  }, 'participant_abcd', now);
  const turn = configuration.iceServers.find(server => Array.isArray(server.urls));
  const expiresAt = Math.floor(now / 1000) + 300;
  const expectedUsername = expiresAt + ':bitconnection-participant_abcd';
  const expectedPassword = crypto.createHmac('sha1', secret).update(expectedUsername).digest('base64');
  assert.equal(configuration.relayAvailable, true);
  assert.equal(turn.username, expectedUsername);
  assert.equal(turn.credential, expectedPassword);
  assert.deepEqual(turn.urls, [
    'turn:relay.example.test:3478?transport=udp',
    'turns:relay.example.test:5349?transport=tcp'
  ]);
  assert.equal(configuration.credentialExpiresAt, new Date(expiresAt * 1000).toISOString());
});

test('ICE configuration rejects malformed URLs and unsafe TURN credentials', () => {
  assert.throws(() => createIceConfiguration({ stunUrls: 'https://stun.example.test' }), /Invalid ICE server URL/);
  assert.throws(() => createIceConfiguration({ turnUrls: 'turn:relay.example.test:3478' }), /shared secret/);
  assert.throws(() => createIceConfiguration({
    turnUrls: 'turn:relay.example.test:3478',
    turnSharedSecret: 'a'.repeat(40),
    credentialTtlSeconds: 120
  }), /TTL/);
});
