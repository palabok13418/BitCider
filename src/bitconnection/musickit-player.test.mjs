import test from 'node:test';
import assert from 'node:assert/strict';
import {
  musicKitQueueDescriptor,
  normalizeAppleCatalogTrack,
  musicKitPlaybackSnapshot,
  searchAppleMusicSongs,
  normalizeAppleAudioVariants,
  appleMusicEmbedUrl,
  controlAppleMusicPlayback
} from './musickit-player.mjs';

test('normalizes Apple audio variant names and drops unknown values', () => {
  assert.deepEqual(
    normalizeAppleAudioVariants(['atmos', 'lossless', 'hi-res-lossless', 'Dolby Audio', 'unknown', 'lossless']),
    ['dolby-atmos', 'hi-res-lossless', 'lossless', 'dolby-audio']
  );
  assert.deepEqual(normalizeAppleAudioVariants('lossy-stereo, atmos'), ['dolby-atmos', 'lossy-stereo']);
});

test('builds Apple Music embedded-player URLs without a MusicKit developer token', () => {
  assert.equal(
    appleMusicEmbedUrl({
      id: '123456789',
      url: 'https://music.apple.com/us/album/example-album/987654321?i=123456789'
    }),
    'https://embed.music.apple.com/us/album/example-album/987654321?i=123456789'
  );
  assert.equal(
    appleMusicEmbedUrl({ id: '123456789', title: 'Björk - Jóga' }, 'gb'),
    'https://embed.music.apple.com/gb/song/bjork-joga/123456789'
  );
  assert.throws(
    () => appleMusicEmbedUrl({ id: '123456789', url: 'https://example.com/song/123456789' }),
    /official song or album URL/
  );
});

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

test('preserves the no-developer-token embedded playback mode', () => {
  const track = normalizeAppleCatalogTrack({
    id: '123456789',
    title: 'Embedded Song',
    artist: 'Example Artist',
    url: 'https://music.apple.com/us/song/embedded-song/123456789',
    playbackMode: 'embed'
  });
  assert.equal(track.playbackMode, 'embed');
  assert.equal(track.url, 'https://music.apple.com/us/song/embedded-song/123456789');
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


test('searches the Apple Music catalog and normalizes returned song entries', async () => {
  const results = await searchAppleMusicSongs({
    api: {
      async search(term, options) {
        assert.equal(term, 'Test Artist');
        assert.deepEqual(options, { types: 'songs', limit: 10, offset: 0 });
        return {
          songs: {
            data: [{
              id: '987654321',
              type: 'songs',
              attributes: {
                name: 'Catalog Song',
                artistName: 'Test Artist',
                albumName: 'Test Album',
                durationInMillis: 201000,
                url: 'https://music.apple.com/us/song/catalog-song/987654321',
                artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}bb.jpg' },
                audioVariants: ['lossless', 'dolby-atmos']
              }
            }]
          }
        };
      }
    }
  }, 'Test Artist', 10);

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '987654321');
  assert.equal(results[0].title, 'Catalog Song');
  assert.equal(results[0].durationSeconds, 201);
  assert.deepEqual(results[0].audioVariants, ['dolby-atmos', 'lossless']);
});


test('MusicKit playback controls preserve the instance receiver for every player action', async () => {
  const calls = [];
  const music = {
    player: {
      isPlaying: false,
      playbackTime: 0,
      currentPlaybackDuration: 120,
      volume: 1,
      async seekToTime(value) {
        assert.equal(this, music.player);
        this.playbackTime = value;
        calls.push(['seek', value]);
      }
    },
    async play() { assert.equal(this, music); calls.push(['play']); },
    async pause() { assert.equal(this, music); calls.push(['pause']); },
    async stop() { assert.equal(this, music); calls.push(['stop']); },
    async skipToNextItem() { assert.equal(this, music); calls.push(['next']); },
    async skipToPreviousItem() { assert.equal(this, music); calls.push(['previous']); }
  };

  await controlAppleMusicPlayback(music, 'play');
  await controlAppleMusicPlayback(music, 'pause');
  await controlAppleMusicPlayback(music, 'stop');
  await controlAppleMusicPlayback(music, 'next');
  await controlAppleMusicPlayback(music, 'previous');
  await controlAppleMusicPlayback(music, 'seek', 42);

  assert.deepEqual(calls, [
    ['play'], ['pause'], ['stop'], ['next'], ['previous'], ['seek', 42]
  ]);
});
