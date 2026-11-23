const ADDON_ROUTE = /^\/[A-Za-z0-9_-]+\/(?:manifest\.json|search|stream\/)/;

// Fetch runtimes may transparently decompress an upstream response. Strip
// representation headers before passing that decoded body to the browser;
// otherwise the browser may try to decompress it a second time.
function relayResponse(upstream) {
  const headers = new Headers(upstream.headers);
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'content-md5', 'etag']) {
    headers.delete(name);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

export default async function backendProxy(request) {
  const backendOrigin = String(process.env.BITCIDER_BACKEND_ORIGIN || '').replace(/\/+$/, '');
  const proxySecret = String(process.env.BITCIDER_PROXY_SECRET || '');

  if (!backendOrigin || !proxySecret) {
    return Response.json(
      { error: 'BACKEND_NOT_CONFIGURED', message: 'Configure BITCIDER_BACKEND_ORIGIN and BITCIDER_PROXY_SECRET for the Deplexo backend.' },
      { status: 503 }
    );
  }

  const incoming = new URL(request.url);
  const isApi = incoming.pathname.startsWith('/api/');
  if (!isApi && !ADDON_ROUTE.test(incoming.pathname)) {
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const target = new URL(incoming.pathname + incoming.search, backendOrigin);
  const headers = new Headers(request.headers);
  headers.delete('host');
  // Request an uncompressed upstream representation so the proxy never
  // forwards stale compression metadata after a runtime decodes the body.
  headers.set('accept-encoding', 'identity');
  headers.set('x-bitcider-proxy-secret', proxySecret);
  headers.set('x-bitcider-public-origin', incoming.origin);

  try {
    const init = {
      method: request.method,
      headers,
      redirect: 'manual'
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
      init.duplex = 'half';
    }
    return relayResponse(await fetch(new Request(target, init)));
  } catch {
    return Response.json(
      { error: 'BACKEND_UNAVAILABLE', message: 'The Deplexo BitCider backend could not be reached.' },
      { status: 502 }
    );
  }
}

export const config = {
  path: [
    '/api/*',
    '/:addonKey/manifest.json',
    '/:addonKey/search',
    '/:addonKey/stream/*'
  ]
};
