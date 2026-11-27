import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseStreamEngine,
  isHlsStream,
  validateFairPlayConfig
} from './stream-player.mjs';

test('recognizes HLS manifest URLs regardless of query parameters', () => {
  assert.equal(isHlsStream('https://cdn.example.test/song/master.m3u8?token=short-lived'), true);
  assert.equal(isHlsStream('/audio/manifest.m3u8'), true);
  assert.equal(isHlsStream('/audio/song.mp3'), false);
});

test('recognizes HLS MIME types when a URL has no manifest extension', () => {
  assert.equal(isHlsStream('/api/playback/asset/123', 'application/vnd.apple.mpegurl'), true);
  assert.equal(isHlsStream('/api/playback/asset/123', 'audio/mpeg'), false);
});

test('selects Shaka for provider-authorized FairPlay, HLS.js for clear HLS, and native for progressive audio', () => {
  assert.equal(chooseStreamEngine({ hls: true, fairPlay: true, hlsJsSupported: true }), 'shaka-fairplay');
  assert.equal(chooseStreamEngine({ hls: true, hlsJsSupported: true }), 'hls.js');
  assert.equal(chooseStreamEngine({ hls: true, nativeHlsSupported: true }), 'native-hls');
  assert.equal(chooseStreamEngine({ hls: false, hlsJsSupported: true }), 'native');
  assert.equal(chooseStreamEngine({ hls: true }), 'unsupported');
});

test('requires a provider license endpoint and certificate for FairPlay', () => {
  assert.throws(() => validateFairPlayConfig(null), /authorized provider configuration/);
  assert.throws(() => validateFairPlayConfig({
    licenseServerUri: 'https://license.example.test/fps'
  }), /server certificate/);
});

test('accepts an HTTPS provider certificate and license endpoint', () => {
  const config = validateFairPlayConfig({
    licenseServerUri: 'https://license.example.test/fps',
    serverCertificateUri: 'https://license.example.test/fps.cer'
  });
  assert.equal(config.licenseServerUri, 'https://license.example.test/fps');
  assert.equal(config.serverCertificateUri, 'https://license.example.test/fps.cer');
});

test('rejects insecure remote FairPlay endpoints', () => {
  assert.throws(() => validateFairPlayConfig({
    licenseServerUri: 'http://license.example.test/fps',
    serverCertificateUri: 'https://license.example.test/fps.cer'
  }), /must be an HTTPS URL/);
});
