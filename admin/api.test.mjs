import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdminRouter } from './api.mjs';

async function withAdminServer(t, dataFile) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({
    dataFile,
    webAuthnContext: () => ({ origin: 'https://bitcider.example', rpID: 'bitcider.example' })
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('admin status stays uninitialized unless a backend bootstrap secret is configured', async t => {
  const original = process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
  delete process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-admin-api-'));
  t.after(async () => {
    if (original === undefined) delete process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
    else process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE = original;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const origin = await withAdminServer(t, path.join(directory, 'admin.json'));
  const response = await fetch(origin + '/api/admin/status');
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(status.initialized, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.bootstrapConfigured, false);
  assert.equal(status.bootstrapAvailable, false);
  assert.equal(status.passkeyLimit, 1);

  const bootstrap = await fetch(origin + '/api/admin/bootstrap/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'a-valid-looking-but-unconfigured-bootstrap-code' })
  });
  assert.equal(bootstrap.status, 503);
  assert.equal((await bootstrap.json()).error, 'ADMIN_BOOTSTRAP_NOT_CONFIGURED');
});

test('bootstrap code alone cannot create an admin session and invalid codes are rejected', async t => {
  const original = process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
  process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE = 'one-time-test-bootstrap-secret-which-is-long';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-admin-bootstrap-'));
  t.after(async () => {
    if (original === undefined) delete process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
    else process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE = original;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const origin = await withAdminServer(t, path.join(directory, 'admin.json'));
  const statusResponse = await fetch(origin + '/api/admin/status');
  const status = await statusResponse.json();
  assert.equal(status.bootstrapAvailable, true);

  const invalid = await fetch(origin + '/api/admin/bootstrap/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'wrong-code' })
  });
  assert.equal(invalid.status, 401);
  const rejected = await invalid.json();
  assert.equal(rejected.error, 'INVALID_BOOTSTRAP_CODE');

  const protectedOverview = await fetch(origin + '/api/admin/overview');
  assert.equal(protectedOverview.status, 401);
});


test('the persisted owner slot stays globally closed after the first passkey is enrolled', async t => {
  const original = process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
  process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE = 'owner-only-test-secret-with-more-than-thirty-two-bytes';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-admin-single-owner-'));
  const dataFile = path.join(directory, 'admin.json');
  await fs.writeFile(dataFile, JSON.stringify({
    credential: {
      id: 'registered-owner-credential-id',
      publicKey: Buffer.from('owner-public-key').toString('base64url'),
      counter: 0,
      transports: [],
      rpID: 'bitcider.example',
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    },
    bootstrapConsumed: true,
    challenges: {},
    sessions: {}
  }));
  t.after(async () => {
    if (original === undefined) delete process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
    else process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE = original;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const origin = await withAdminServer(t, dataFile);
  const status = await (await fetch(origin + '/api/admin/status')).json();
  assert.equal(status.initialized, true);
  assert.equal(status.passkeyCount, 1);
  assert.equal(status.passkeyLimit, 1);
  assert.equal(status.bootstrapAvailable, false);

  for (const route of ['/api/admin/bootstrap/options', '/api/admin/bootstrap/verify']) {
    const response = await fetch(origin + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE })
    });
    assert.equal(response.status, 409, route + ' must stay closed after owner enrollment');
    assert.equal((await response.json()).error, 'ADMIN_ALREADY_INITIALIZED');
  }
});


test('separate admin workers preserve concurrent WebAuthn challenges in shared persistent state', async t => {
  const original = process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
  process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE = 'shared-worker-test-secret-with-more-than-thirty-two-bytes';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcider-admin-shared-workers-'));
  const dataFile = path.join(directory, 'admin.json');
  t.after(async () => {
    if (original === undefined) delete process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE;
    else process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE = original;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const firstWorker = await withAdminServer(t, dataFile);
  const secondWorker = await withAdminServer(t, dataFile);
  const [firstOptions, secondOptions] = await Promise.all([firstWorker, secondWorker].map(origin =>
    fetch(origin + '/api/admin/bootstrap/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: process.env.BITCIDER_ADMIN_BOOTSTRAP_CODE })
    })
  ));
  assert.equal(firstOptions.status, 200);
  assert.equal(secondOptions.status, 200);

  const firstCookie = firstOptions.headers.get('set-cookie')?.match(/bitcider_admin_challenge=([^;]+)/)?.[1];
  const secondCookie = secondOptions.headers.get('set-cookie')?.match(/bitcider_admin_challenge=([^;]+)/)?.[1];
  assert.ok(firstCookie);
  assert.ok(secondCookie);
  assert.notEqual(firstCookie, secondCookie);

  const verifyInvalidRegistration = (origin, cookie) => fetch(origin + '/api/admin/bootstrap/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'bitcider_admin_challenge=' + cookie
    },
    body: JSON.stringify({})
  });
  const [firstVerify, secondVerify] = await Promise.all([
    verifyInvalidRegistration(firstWorker, firstCookie),
    verifyInvalidRegistration(secondWorker, secondCookie)
  ]);
  const results = await Promise.all([firstVerify.json(), secondVerify.json()]);
  assert.equal(results[0].error, 'ADMIN_PASSKEY_ENROLLMENT_FAILED');
  assert.equal(results[1].error, 'ADMIN_PASSKEY_ENROLLMENT_FAILED');
});
