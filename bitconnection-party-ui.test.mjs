import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);

test('active party uses the required Lyrics, Room, Chat, Leave navigation in that order', async () => {
  const source = await readFile(new URL('src/BitConnectionParty.jsx', root), 'utf8');
  assert.match(source, /useState\('lyrics'\)/);

  const navStart = source.indexOf('<nav className="bc-party-tab-bar"');
  assert.notEqual(navStart, -1, 'party bottom navigation exists');
  const navEnd = source.indexOf('</nav>', navStart);
  assert.notEqual(navEnd, -1, 'party bottom navigation closes');
  const nav = source.slice(navStart, navEnd);

  const ids = [...nav.matchAll(/\{ id: '([a-z]+)'/g)].map(match => match[1]);
  assert.deepEqual(ids, ['lyrics', 'room', 'chat', 'leave']);
  assert.match(nav, /isLeave \? void onLeave\(\) : setActiveTab\(tab\.id\)/);
  assert.match(nav, /leaveLabel = isHost && participants\.length <= 1 \? 'End party' : 'Leave party'/);
  assert.doesNotMatch(nav, /Queue|Members/);
});

test('Room view owns the centered QR, service codes, member list, and queue controls', async () => {
  const source = await readFile(new URL('src/BitConnectionParty.jsx', root), 'utf8');
  assert.match(source, /activeTab === 'room'/);
  assert.match(source, /BITCHORD ROOM CODE/);
  assert.match(source, /MUSAUDIO ROOM CODE/);
  assert.match(source, /className="bc-party-room-qr-center"/);
  assert.match(source, /PartyQrCode value=\{bitChordRoomCode\}/);
  assert.match(source, /bc-party-room-members/);
  assert.match(source, /bc-party-queue-actions/);
  assert.match(source, /'Not linked'/);
  assert.doesNotMatch(source, /<section className="bc-party-room-share"/);
});

test('active party styles the navigation at viewport bottom center and adapts Room codes for mobile', async () => {
  const css = await readFile(new URL('src/bitconnection-party.css', root), 'utf8');
  assert.match(css, /\.bc-party-tab-bar\s*\{[^}]*position:\s*fixed;[^}]*left:\s*50%;/s);
  assert.match(css, /\.bc-party-room-code-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*clamp\(/s);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.bc-party-room-qr-center\s*\.bc-party-room-qr/);
});
