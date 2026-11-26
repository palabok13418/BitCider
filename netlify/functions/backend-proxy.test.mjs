import test from 'node:test';
import assert from 'node:assert/strict';
import backendProxy from './backend-proxy.mjs';

test('BitConnection account requests keep their session cookie without the optional gateway secret', async t => {
  const originalFetch = globalThis.fetch;
  const previousSecret = process.env.BITCIDER_PROXY_SECRET;
  const previousOrigin = process.env.BITCIDER_BACKEND_ORIGIN;
  const forwarded = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.BITCIDER_PROXY_SECRET;
    else process.env.BITCIDER_PROXY_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.BITCIDER_BACKEND_ORIGIN;
    else process.env.BITCIDER_BACKEND_ORIGIN = previousOrigin;
  });

  delete process.env.BITCIDER_PROXY_SECRET;
  process.env.BITCIDER_BACKEND_ORIGIN = 'https://bitcider.de.deplexo.com';
  globalThis.fetch = async request => {
    forwarded.push(request);
    return Response.json({ ok: true });
  };

  const origin = 'https://bitcider.netlify.app';
  const cookie = 'bitcider_session=existing-session-cookie';
  const response = await backendProxy(new Request(origin + '/api/bitconnection/account', {
    headers: { Cookie: cookie, Origin: origin, 'X-BitCider-Proxy-Secret': 'untrusted-value' }
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].headers.get('cookie'), cookie);
  assert.equal(forwarded[0].headers.get('origin'), origin);
  assert.equal(forwarded[0].headers.get('x-forwarded-host'), 'bitcider.netlify.app');
  assert.equal(forwarded[0].headers.get('x-bitcider-proxy-secret'), null);
  assert.equal(forwarded[0].headers.get('x-bitcider-public-origin'), null);

  const protectedResponse = await backendProxy(new Request(origin + '/api/account'));
  assert.equal(protectedResponse.status, 503);
});
