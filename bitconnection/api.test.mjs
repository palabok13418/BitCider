import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBitConnectionRouter, bitConnectionHealthPayload, BITCONNECTION_API_VERSION } from './api.mjs';

async function harness(t, { authenticated = true, accountId = 'test-account-1', maxPartySize = 4 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitconnection-test-'));
  const dataFile = path.join(directory, 'bitconnection.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  app.use('/api/bitconnection', createBitConnectionRouter({
    dataFile, maxPartySize,
    getUserSession: () => authenticated ? { authenticated: true, accountId } : { authenticated: false },
    requireCsrf: (_req, _res, next) => next()
  }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  return {
    request: (route, options = {}) => fetch(`http://127.0.0.1:${address.port}/api/bitconnection` + route, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    })
  };
}

test('BitConnection health identifies Deplexo and room-creation capability', () => {
  const health = bitConnectionHealthPayload();
  assert.equal(health.ok, true);
  assert.equal(health.deployment, 'Deplexo');
  assert.equal(health.apiVersion, BITCONNECTION_API_VERSION);
  assert.equal(health.capabilities.roomCreation, 'enabled');
  assert.equal(health.capabilities.realtimeRooms, 'not-yet-enabled');
});

test('account endpoint reports whether a BitCider account is signed in', async t => {
  const client = await harness(t, { authenticated: false });
  const response = await client.request('/account');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, false);
});

test('profile setup persists a BitConnection identity and allows room creation', async t => {
  const client = await harness(t);
  const profileResponse = await client.request('/account/profile', {
    method: 'PUT', body: JSON.stringify({ username: 'Velvet Comet' })
  });
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.profile.username, 'Velvet Comet');

  const roomResponse = await client.request('/rooms', {
    method: 'POST',
    body: JSON.stringify({
      roomName: 'Late Night Listening',
      visibility: 'private',
      partySize: 4,
      ownerOnlyControls: true
    })
  });
  const created = await roomResponse.json();
  assert.equal(roomResponse.status, 201);
  assert.equal(created.room.visibility, 'private');
  assert.equal(created.room.partySize, 4);
  assert.equal(created.realtimeReady, false);
  assert.match(created.room.roomCode, /^[A-HJ-NP-Z2-9]{8}$/);
});

test('profile username is unique and party-size limit is enforced', async t => {
  const first = await harness(t, { accountId: 'account-one' });
  await first.request('/account/profile', { method: 'PUT', body: JSON.stringify({ username: 'Night Owl' }) });
  const second = await harness(t, { accountId: 'account-two' });
  const duplicate = await second.request('/account/profile', { method: 'PUT', body: JSON.stringify({ username: 'night owl' }) });
  assert.equal(duplicate.status, 409);

  const overLimit = await first.request('/rooms', {
    method: 'POST',
    body: JSON.stringify({ roomName: 'Too many', visibility: 'public', partySize: 5, ownerOnlyControls: false })
  });
  assert.equal(overLimit.status, 400);
});

test('anonymous hosts cannot create rooms and owners can close their room', async t => {
  const anonymous = await harness(t, { authenticated: false });
  const denied = await anonymous.request('/rooms', {
    method: 'POST',
    body: JSON.stringify({ roomName: 'No account', visibility: 'public', partySize: 2, ownerOnlyControls: true })
  });
  assert.equal(denied.status, 401);

  const host = await harness(t, { accountId: 'host-account' });
  await host.request('/account/profile', { method: 'PUT', body: JSON.stringify({ username: 'Host Account' }) });
  const created = await host.request('/rooms', {
    method: 'POST',
    body: JSON.stringify({ roomName: 'Owner room', visibility: 'public', partySize: 2, ownerOnlyControls: true })
  });
  const payload = await created.json();
  const closed = await host.request(`/rooms/${payload.room.roomId}/close`, { method: 'POST' });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).status, 'closed');
});
