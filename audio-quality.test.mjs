import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQuality,
  supportsDolbyAtmos,
  isDolbyAtmosStream,
  atmosphereTrackId,
  parseAddonTrackId,
  streamMetadata
} from './audio-quality.mjs';

test('quality selector only maps to AAC 256, AAC 64, or Atmos', () => {
  assert.equal(normalizeQuality('high'), 'high');
  assert.equal(normalizeQuality('low'), 'low');
  assert.equal(normalizeQuality('dolby_atmos'), 'atmos');
  assert.equal(normalizeQuality('aac_64'), 'low');
  assert.equal(normalizeQuality('LOSSLESS'), 'high');
});

test('Atmos catalogue availability is recognized from Apple Music audioVariants', () => {
  assert.equal(supportsDolbyAtmos({ audioVariants: ['lossy-stereo', 'dolby-atmos'] }), true);
  assert.equal(supportsDolbyAtmos({ audioVariants: ['lossless', 'hi-res-lossless'] }), false);
});

test('Atmos addon track ids safely round-trip original Cider ids', () => {
  const id = 'catalog-song-123';
  assert.deepEqual(parseAddonTrackId(atmosphereTrackId(id)), { trackId: id, atmos: true });
  assert.deepEqual(parseAddonTrackId(id), { trackId: id, atmos: false });
});

test('stereo stream metadata is always AAC and never leaks lossless labels', () => {
  const stream = streamMetadata('https://media.example/track.m3u8', {
    codec: 'flac',
    container: 'flac',
    audioQuality: 'Hi-Res Lossless',
    bitDepth: 24,
    sampleRate: 44100
  }, 'low');
  assert.equal(stream.codec, 'aac');
  assert.equal(stream.format, 'aac');
  assert.equal(stream.quality, 'AAC 64 kbps');
  assert.equal(stream.bitrate, 64000);
  assert.equal(stream.manifest, 'hls');
  assert.equal('bitDepth' in stream, false);
  assert.equal(stream.container, undefined);
});

test('AAC 256 metadata reports the expected lossy bitrate', () => {
  const stream = streamMetadata('https://media.example/track.m3u8', {}, 'high');
  assert.equal(stream.codec, 'aac');
  assert.equal(stream.quality, 'AAC 256 kbps');
  assert.equal(stream.bitrate, 256000);
});

test('Atmos metadata is emitted only for an actual Atmos queue rendition', () => {
  const ordinary = { codec: 'aac', audioVariants: ['dolby-atmos'] };
  const atmos = { codec: 'eac3-joc', audioMode: 'DOLBY_ATMOS' };
  assert.equal(isDolbyAtmosStream(ordinary), false);
  assert.equal(isDolbyAtmosStream(atmos), true);
  assert.equal(streamMetadata('https://media.example/atmos', atmos, 'atmos').codec, 'eac3-joc');
  assert.equal(streamMetadata('https://media.example/stereo', ordinary, 'atmos').quality, 'AAC 256 kbps');
});
