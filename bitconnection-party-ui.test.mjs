import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);

test('active party uses Lyrics, Queue, Room, Chat, and dynamic End/Leave navigation in order', async () => {
  const source = await readFile(new URL('src/BitConnectionParty.jsx', root), 'utf8');
  assert.match(source, /useState\('lyrics'\)/);

  const navStart = source.indexOf('<nav className="bc-party-tab-bar"');
  assert.notEqual(navStart, -1, 'party bottom navigation exists');
  const navEnd = source.indexOf('</nav>', navStart);
  assert.notEqual(navEnd, -1, 'party bottom navigation closes');
  const nav = source.slice(navStart, navEnd);

  const ids = [...nav.matchAll(/\{ id: '([a-z]+)'/g)].map(match => match[1]);
  assert.deepEqual(ids, ['lyrics', 'queue', 'room', 'chat', 'leave']);
  assert.match(nav, /isLeave \? void onLeave\(\) : setActiveTab\(tab\.id\)/);
  assert.match(nav, /leaveLabel = isHost && participants\.length <= 1 \? 'End party' : 'Leave party'/);
});

test('Room owns the six-character BitChord code, rounded QR, and member list; Queue has its own tab', async () => {
  const source = await readFile(new URL('src/BitConnectionParty.jsx', root), 'utf8');
  const roomStart = source.indexOf("{activeTab === 'room' && (");
  const queueStart = source.indexOf("{activeTab === 'queue' && (");
  assert.notEqual(roomStart, -1);
  assert.notEqual(queueStart, -1);
  assert.ok(queueStart > roomStart);
  const room = source.slice(roomStart, queueStart);
  const queue = source.slice(queueStart, source.indexOf("{activeTab === 'chat' && (", queueStart));
  assert.match(room, /BITCHORD ROOM CODE/);
  assert.match(room, /PartyQrCode value=\{bitChordRoomCode\}/);
  assert.match(room, /bc-party-room-members/);
  assert.doesNotMatch(room, /bc-party-queue|MUSAUDIO ROOM CODE|Everyone can control playback/);
  assert.match(queue, /bc-party-queue-actions/);
  assert.match(queue, /queue\.length \? queue\.map/);
  assert.doesNotMatch(source, /MUSAUDIO ROOM CODE|HOSTING PARTY|LISTENING TOGETHER|HOSTING.*LISTENING PARTY|bc-party-host-audio/);
  assert.match(source, /rx="5"/);
  assert.doesNotMatch(source, /Share BitChord tab audio|Share the BitChord Web tab/);
});
test('main BitConnection page is avatar-only when signed in and responsive across devices', async () => {
  const source = await readFile(new URL('src/BitConnection.jsx', root), 'utf8');
  const css = await readFile(new URL('src/bitconnection.css', root), 'utf8');
  assert.match(source, /className="bitconnection-account-avatar"/);
  assert.doesNotMatch(source, /<span>Account<\/span>/);
  assert.doesNotMatch(source, /YouTube Music via BitChord Web/);
  assert.match(css, /--bitconnection-hero-top-space/);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /\.bitconnection-discovery\s*\{[^}]*margin-top:\s*calc\(/s);
});

test('active party styles the navigation at viewport bottom center and adapts Room codes for mobile', async () => {
  const css = await readFile(new URL('src/bitconnection-party.css', root), 'utf8');
  assert.match(css, /\.bc-party-tab-bar\s*\{[^}]*position:\s*fixed;[^}]*left:\s*50%;/s);
  assert.match(css, /\.bc-party-room-code-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*clamp\(/s);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.bc-party-room-qr-center\s*\.bc-party-room-qr/);
});

test('active-party Browser uses cover-first Apple Music shelves and a 90% rounded overlay', async () => {
  const source = await readFile(new URL('src/BitConnectionParty.jsx', root), 'utf8');
  const css = await readFile(new URL('src/bitconnection-party.css', root), 'utf8');
  assert.match(source, /bc-party-browser-featured-row/);
  assert.match(source, /bc-party-browser-cover-grid/);
  assert.match(source, /parseMoreLikeShelfTitle/);
  assert.match(source, /APPLE_MOTION_LOOKUP_ENDPOINT/);
  assert.doesNotMatch(source, /RECOMMENDED FOR YOU/);
  assert.doesNotMatch(source, /bc-party-browser-recommendation-head/);
  assert.match(css, /\\.bc-party-browser-panel\\s*\\{[^}]*width:min\\(92vw/);
  assert.match(css, /height:min\\(90dvh/);
  assert.match(css, /border-radius:clamp\\(/);
});
