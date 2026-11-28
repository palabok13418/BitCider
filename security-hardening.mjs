export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "frame-src 'self' https://*.apple.com",
  "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com https://js-cdn.music.apple.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://*.apple.com https://*.mzstatic.com https://*.confih.tech",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' http://127.0.0.1:10767 http://localhost:10767 https://*.apple.com https://*.itunes.apple.com https://*.confih.tech https://mus-api.de.deplexo.com",
  "media-src 'self' blob: data: https://*.apple.com https://*.itunes.apple.com https://*.mzstatic.com https://*.confih.tech",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");

const BASE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-DNS-Prefetch-Control": "off",
  "X-Permitted-Cross-Domain-Policies": "none"
});

export function securityHeadersFor({ isHttps = false } = {}) {
  return {
    ...BASE_SECURITY_HEADERS,
    ...(isHttps ? { "Strict-Transport-Security": "max-age=31536000" } : {})
  };
}

export function applySecurityHeaders(req, res, next) {
  const headers = securityHeadersFor({ isHttps: req.secure === true });
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  next();
}

export function secureResponse(response, { isHttps = false } = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeadersFor({ isHttps }))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function createIpRateLimiter({
  limit = 60,
  windowMs = 60_000,
  keyGenerator = req => req.ip || req.socket?.remoteAddress || "unknown",
  message = "Too many requests. Please wait and try again.",
  error = "RATE_LIMITED",
  maxEntries = 5000
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Rate-limit limit must be a positive integer.");
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new TypeError("Rate-limit window must be positive.");

  const buckets = new Map();
  const safeMaxEntries = Math.max(100, Math.floor(maxEntries));

  return (req, res, next) => {
    const now = Date.now();
    const rawKey = keyGenerator(req);
    const key = String(rawKey || "unknown").slice(0, 320);
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { count: 0, startedAt: now };
    }
    bucket.count += 1;
    buckets.set(key, bucket);

    if (buckets.size > safeMaxEntries) {
      for (const [entryKey, entry] of buckets) {
        if (now - entry.startedAt >= windowMs) buckets.delete(entryKey);
      }
      while (buckets.size > safeMaxEntries) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey === undefined) break;
        buckets.delete(oldestKey);
      }
    }

    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error, message });
    }

    next();
  };
}
