import test from 'node:test';
import assert from 'node:assert/strict';
import {
  musicKitQueueDescriptor,
  normalizeAppleCatalogTrack,
  musicKitPlaybackSnapshot
} from './musickit-player.mjs';

test('creates a MusicKit queue descriptor from a catalog song id', () => {
  assert.deepEqual(musicKitQueueDescriptor({ id: '1234567890' }), { song: '1234567890' });
});

test('allows only Apple Music catalog URLs as playback descriptors', () => {
  assert.deepEqual(
    musicKitQueueDescriptor({ url: 'https://music.apple.com/us/song/example/1234567890' }),
    { url: 'https://music.apple.com/us/song/example/1234567890' }
  );
  assert.throws(() => musicKitQueueDescriptor({ url: 'https://attacker.example/audio.m3u8' }), /Only Apple Music catalog URLs/);
  assert.throws(() => musicKitQueueDescriptor({ url: 'http://music.apple.com/us/song/example/123' }), /Only Apple Music catalog URLs/);
});

test('normalizes Apple Music catalog metadata without retaining credentials', () => {
  const track = normalizeAppleCatalogTrack({
    id: '123456',
    type: 'songs',
    title: 'Example',
    artist: 'Example Artist',
    durationMillis: 189000,
    url: 'https://music.apple.com/us/song/example/123456'
  });
  assert.deepEqual(track, {
    id: '123456',
    type: 'apple-music',
    title: 'Example',
    artist: 'Example Artist',
    album: '',
    artworkUrl: '',
    url: 'https://music.apple.com/us/song/example/123456',
    durationSeconds: 189
  });
  assert.equal(JSON.stringify(track).includes('userMediaToken'), false);
});

test('rejects non-catalog IDs when normalizing Apple Music tracks', () => {
  assert.throws(() => normalizeAppleCatalogTrack({ id: 'mono_abc' }), /catalog song ID/);
});

test('creates a safe playback snapshot from a MusicKit player', () => {
  const snapshot = musicKitPlaybackSnapshot({
    player: {
      isPlaying: true,
      playbackTime: 12.5,
      currentPlaybackDuration: 180,
      nowPlayingItem: {
        id: '123',
        title: 'Example',
        artistName: 'Example Artist',
        albumName: 'Example Album',
        artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}bb.jpg' }
      }
    }
  });
  assert.equal(snapshot.isPlaying, true);
  assert.equal(snapshot.positionSeconds, 12.5);
  assert.equal(snapshot.durationSeconds, 180);
  assert.equal(snapshot.track.title, 'Example');
  assert.equal(snapshot.track.artworkUrl, 'https://is1-ssl.mzstatic.com/image/600x600bb.jpg');
});
