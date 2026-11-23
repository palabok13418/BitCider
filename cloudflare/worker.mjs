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

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const isApi = incoming.pathname.startsWith('/api/');
    const isAddon = ADDON_ROUTE.test(incoming.pathname);

    if (!isApi && !isAddon) {
      return env.ASSETS.fetch(request);
    }

    const backendOrigin = String(env.BITCIDER_BACKEND_ORIGIN || '').replace(/\/+$/, '');
    const proxySecret = String(env.BITCIDER_PROXY_SECRET || '');
    if (!backendOrigin || !proxySecret) {
      return Response.json(
        { error: 'BACKEND_NOT_CONFIGURED', message: 'Set BITCIDER_BACKEND_ORIGIN and BITCIDER_PROXY_SECRET as Worker variables.' },
        { status: 503 }
      );
    }

    const target = new URL(incoming.pathname + incoming.search, backendOrigin);
    const headers = new Headers(request.headers);
    headers.delete('host');
    // Request an uncompressed upstream representation to avoid stale
    // compression metadata after the runtime decodes the body.
    headers.set('accept-encoding', 'identity');
    headers.set('x-bitcider-proxy-secret', proxySecret);
    headers.set('x-bitcider-public-origin', incoming.origin);

    try {
      const init = {
        method: request.method,
        headers,
        redirect: 'manual'
      };
      if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
      return relayResponse(await fetch(new Request(target, init), {
        cf: { cacheTtl: 0, cacheEverything: false }
      }));
    } catch {
      return Response.json(
        { error: 'BACKEND_UNAVAILABLE', message: 'The Deplexo BitCider backend could not be reached.' },
        { status: 502 }
      );
    }
  }
};
