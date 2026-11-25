import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createBitConnectionRouter, bitConnectionHealthPayload, BITCONNECTION_API_VERSION } from './api.mjs';

test('BitConnection health contract identifies Deplexo as the primary deployment', async () => {
  const payload = bitConnectionHealthPayload();
  assert.equal(payload.ok, true);
  assert.equal(payload.service, 'BitConnection');
  assert.equal(payload.deployment, 'Deplexo');
  assert.equal(payload.apiVersion, BITCONNECTION_API_VERSION);
  assert.equal(payload.capabilities.roomCreation, 'not-yet-enabled');
});

test('BitConnection exposes a no-store health endpoint under its API namespace', async t => {
  const app = express();
  app.use('/api/bitconnection', createBitConnectionRouter());
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bitconnection/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.deployment, 'Deplexo');
  assert.match(response.headers.get('cache-control') || '', /no-store/i);
});
