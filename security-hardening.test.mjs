import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_SECURITY_POLICY,
  securityHeadersFor,
  secureResponse,
  createIpRateLimiter
} from './security-hardening.mjs';

test('security policy permits only required first-party and local Cider connections', () => {
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /http:\/\/127\.0\.0\.1:10767/);
  assert.match(CONTENT_SECURITY_POLICY, /https:\/\/fonts\.googleapis\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /https:\/\/fonts\.gstatic\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src[^;]*https:\/\/static\.cloudflareinsights\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'self'/);\n  assert.match(CONTENT_SECURITY_POLICY, /frame-src 'self'/);\n  assert.match(CONTENT_SECURITY_POLICY, /frame-src[^;]*https:\\/\\/\\*\\.apple\\.com/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /script-src[^;]*'unsafe-eval'/);
});

test('HTTPS security headers include HSTS but local HTTP does not', () => {
  const httpHeaders = securityHeadersFor({ isHttps: false });
  const httpsHeaders = securityHeadersFor({ isHttps: true });
  assert.equal(httpHeaders['Strict-Transport-Security'], undefined);
  assert.equal(httpsHeaders['Strict-Transport-Security'], 'max-age=31536000');
  assert.equal(httpsHeaders['X-Content-Type-Options'], 'nosniff');
  assert.equal(httpsHeaders['X-Frame-Options'], 'SAMEORIGIN');\n  assert.match(httpsHeaders['Content-Security-Policy'], /frame-ancestors 'self'/);
  assert.equal(httpsHeaders['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

test('secureResponse preserves the response body and existing headers', async () => {
  const response = new Response('ok', { status: 201, headers: { 'X-Upstream': 'preserved' } });
  const secured = secureResponse(response, { isHttps: true });
  assert.equal(secured.status, 201);
  assert.equal(secured.headers.get('X-Upstream'), 'preserved');
  assert.equal(secured.headers.get('X-Frame-Options'), 'SAMEORIGIN');\n  assert.match(secured.headers.get('Content-Security-Policy') || '', /frame-src 'self'/);
  assert.equal(secured.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(await secured.text(), 'ok');
});

test('IP rate limiter blocks excess requests and isolates client keys', () => {
  const limiter = createIpRateLimiter({ limit: 2, windowMs: 60_000 });
  function request(ip) {
    let continued = false;
    const response = {
      headers: {},
      statusCode: 200,
      body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    limiter({ ip }, response, () => { continued = true; });
    return { continued, response };
  }

  assert.equal(request('192.0.2.1').continued, true);
  assert.equal(request('192.0.2.1').continued, true);
  const blocked = request('192.0.2.1');
  assert.equal(blocked.continued, false);
  assert.equal(blocked.response.statusCode, 429);
  assert.equal(blocked.response.headers['Retry-After'], '60');
  assert.equal(request('192.0.2.2').continued, true);
});
