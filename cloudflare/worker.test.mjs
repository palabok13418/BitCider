import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('BitConnection API reaches Deplexo without the optional gateway secret while other routes stay protected', async t => {
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (request, options = {}) => {
    forwarded.push({ request, options });
    return Response.json({ ok: true, path: new URL(request.url).pathname });
  };

  const env = {
    BITCIDER_BACKEND_ORIGIN: 'https://bitcider.de.deplexo.com',
    ASSETS: { fetch: async () => new Response('asset') }
  };
  const origin = 'https://bitcider.palabokmagtiis.workers.dev';
  const sessionCookie = 'bitcider_session=existing-session-cookie';

  for (const endpoint of ['/api/bitconnection/health', '/api/bitconnection/account']) {
    const request = new Request(origin + endpoint, {
      headers: {
        Cookie: sessionCookie,
        Origin: origin,
        'X-BitCider-Proxy-Secret': 'visitor-supplied-secret-must-not-be-trusted'
      }
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200, endpoint + ' should be proxied without a Worker secret');
    assert.deepEqual(await response.json(), { ok: true, path: endpoint });

    const upstream = forwarded.at(-1).request;
    assert.equal(upstream.headers.get('cookie'), sessionCookie, 'the signed-in BitCider session must reach Deplexo');
    assert.equal(upstream.headers.get('origin'), origin);
    assert.equal(upstream.headers.get('x-forwarded-host'), 'bitcider.palabokmagtiis.workers.dev');
    assert.equal(upstream.headers.get('x-bitcider-proxy-secret'), null, 'visitor-supplied gateway secrets must be stripped');
    assert.equal(upstream.headers.get('x-bitcider-public-origin'), null);
  }

  const callsBeforeProtectedRoute = forwarded.length;
  const protectedResponse = await worker.fetch(
    new Request(origin + '/api/account'),
    env
  );
  assert.equal(protectedResponse.status, 503);
  assert.equal((await protectedResponse.json()).error, 'BACKEND_NOT_CONFIGURED');
  assert.equal(forwarded.length, callsBeforeProtectedRoute, 'non-BitConnection API must remain fail-closed');
});

test('configured gateway secret is still attached to proxied BitConnection requests', async t => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async request => {
    upstreamRequest = request;
    return Response.json({ ok: true });
  };

  const origin = 'https://bitcider.palabokmagtiis.workers.dev';
  const response = await worker.fetch(new Request(origin + '/api/bitconnection/health'), {
    BITCIDER_BACKEND_ORIGIN: 'https://bitcider.de.deplexo.com',
    BITCIDER_PROXY_SECRET: 'configured-secret',
    ASSETS: { fetch: async () => new Response('asset') }
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest.headers.get('x-bitcider-proxy-secret'), 'configured-secret');
  assert.equal(upstreamRequest.headers.get('x-bitcider-public-origin'), origin);
});
