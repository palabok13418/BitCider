# BitCider

BitCider connects a user's Cider account to a personal BitChord addon endpoint.

## Hosting targets

BitCider is configured for only these hosting providers:

- **Deplexo** runs the authoritative Node.js backend and stores persistent encrypted data.
- **Netlify** serves the React frontend and forwards API/addon requests through a Netlify Function.
- **Cloudflare Workers** serves the React frontend and forwards API/addon requests through a Worker.

See [DEPLOYMENT.md](DEPLOYMENT.md) for provider setup, environment variables, and the Deplexo same-origin API rule.

## Current features

- Requests a Cider app token directly through `POST http://127.0.0.1:10767/api/v2/auth/request` as **BitCider**.
- Requests `playback`, `queue`, `library`, and `audio` scopes.
- Includes the supplied Lightfall WebGL background, with request-driven warping while a personal addon URL is created.
- Gives each BitCider account its own encrypted Cider connection and personal BitChord addon URL; anonymous browser sessions can be upgraded into accounts.
- Implements the addon manifest, search, and stream-resolution route shapes.
- Encrypts saved Cider app tokens with AES-256-GCM.
- Uses Deplexo's `/data` persistent volume for connection records and the legacy CSRF-signing key; the dedicated Cider-token encryption key is kept separately as a Deplexo secret.
- Allows exact same-origin Deplexo HTTPS requests to manage a session directly, while Netlify/Cloudflare use a private gateway secret.

## BitCider accounts and cloud-saved links

Users create a BitCider account with a password after approving Cider. No username or email is collected. BitCider generates a random 256-bit Account Key and shows it once; only a SHA-256 hash is stored. On another device, sign in with Account Key plus password, or use a discoverable passkey. The Cider app token is saved connection data, not the person's account identity.
- Passwords have no character-count rule; the live strength meter is advisory and does not block entry. API requests retain a finite transport-size limit for service protection. Passwords are stored as scrypt hashes (N=32768, r=8, p=1, 64-byte output); plaintext passwords are never stored.
- Account sessions use random 256-bit, Secure, HttpOnly, SameSite=Lax cookies. Only SHA-256 hashes of authenticated session identifiers are stored server-side. Sessions expire after 30 days, with up to five active device sessions; a sixth sign-in revokes the least-recently-active session.
- Passkeys use discoverable WebAuthn credentials through SimpleWebAuthn, require user verification, and store only credential IDs and public keys. Passkey sign-in does not require an Account Key or a Cider token. Each BitCider account can register up to five passkeys. Adding or removing passkeys and revoking devices requires the current BitCider passphrase.
- Passkey credentials are scoped to the website domain where they were created. Netlify, Cloudflare, and Deplexo hostnames are separate relying parties unless configured under one shared custom domain. Synced passkeys may be usable on multiple physical devices; the five-device cap applies to active BitCider sessions.
- Cookie-authenticated state-changing requests require a session-bound HMAC CSRF token in the `X-BitCider-CSRF` header. Account endpoints are rate-limited.
- Cider app tokens are encrypted with AES-256-GCM. Configure the Deplexo-only `BITCIDER_ENCRYPTION_KEY` secret to keep the data-encryption key separate from the persistent volume. The addon URL is a bearer-style secret; it is not written to localStorage and is returned only to the matching anonymous browser session or signed-in account.
- Creating an account while a Cider connection is already linked in that browser transfers the encrypted connection and existing addon key into the new account. Signing in on a second device restores the account's existing link instead of creating a new one.
- Account recovery uses 10 one-time recovery codes. Only their SHA-256 hashes are stored. They are displayed once at registration or password recovery; save them offline. Using one code alone identifies and recovers the account: it resets the password, rotates the Account Key, replaces the recovery-code set, revokes all existing sessions, and signs in the recovery device.
- There is no email-based recovery or email identity matching. If the passphrase and all unused recovery codes are lost, the account cannot be recovered. Keep the recovery codes in a password manager or another private offline location.

BitCider does not use a username or email. The Account Key is random, opaque, and stored as a one-way SHA-256 hash. The Cider app token is AES-256-GCM encrypted at rest as connection data, not used as cross-device account identity. The integration deliberately does not request Cider's sensitive `account` scope.

## Cider authorization

BitCider uses Cider's documented interactive Auth API directly from the user's browser:

```http
POST http://127.0.0.1:10767/api/v2/auth/request
Content-Type: application/json

{
  "app_name": "BitCider",
  "scopes": ["playback", "queue", "library", "audio"]
}
```

Cider displays its native approval dialog. Once the user approves, Cider returns the app token in the API response (`data.token`). BitCider sends that token to the Deplexo backend, where it is encrypted before storage. No custom URL protocol or manual token copy/paste is needed.

Cider must be running on the same device as the browser. Current Chrome releases gate HTTPS-to-`127.0.0.1` requests behind the **Loopback network** permission. Choose Allow when Chrome prompts; if access was previously denied, change the BitCider site's Loopback network permission to Allow in Chrome Site settings, reload, and retry. Cider's `403 AUTH_REQUEST_DENIED` means the user denied the native consent dialog.

## In-browser Cider bridge

BitCider uses the browser tab itself as the local Cider bridge. When a Cider connection is present, the site automatically registers a short-lived, session-bound bridge with Deplexo. The browser polls for scoped addon requests, sends the approved Cider API calls to `http://127.0.0.1:10767`, and returns the JSON responses over the user's authenticated BitCider session.

No desktop runner, JSON config, batch file, installer, browser extension, or separate download is required. The BitCider page must remain open in a browser tab on the same computer where Cider is running while BitChord uses the addon. Closing the tab stops the bridge; reopening BitCider reconnects automatically.

The bridge only allows Cider Apple Music catalog song search, play-item, queue read, and playback pause operations. Catalog search uses Cider's `/api/v2/amapi/search` proxy, with Cider applying the user's storefront and signing the request. The local Cider API is never exposed as a public port.

The browser receives the user's encrypted-at-rest Cider app token over the authenticated same-origin connection and keeps it in memory only. The bridge registration is scoped to the account/session, protected by CSRF during registration and a per-tab random secret for polling and job responses. The server stores a hash of that secret and rejects requests from replaced or expired tabs. One active browser bridge is used per BitCider account at a time.

Chrome may ask for Loopback network permission when the page accesses Cider on `127.0.0.1`. Allow that permission for the BitCider site. If it was previously denied, change the site's Loopback network permission in Chrome Site settings and reload BitCider.

## Local development

```bash
npm install
npm run dev
```

The Vite dev server proxies `/api/*` to a local BitCider backend on port 8787. To run the backend separately:

```bash
npm run dev:server
```

For the Deplexo backend, use `npm start`. Deplexo supplies port 3000 through its `deplexo.yaml` configuration.

## Security

- Never commit Cider app tokens or `BITCIDER_PROXY_SECRET`.
- The frontend gateway secret must be configured as a secret on Netlify and Cloudflare, not as a public build-time variable.
- The Deplexo app uses the durable `/data/bitcider` directory.
- Back up Deplexo's persistent volume before deleting or recreating the application.


## BitMono source and search diagnostics

BitMono is the free Monochrome-backed BitChord source. It does not use a Cider account or a personal addon key. Its search route queries both official Monochrome endpoints:

- `GET /search?q=...` for unified search, including track entries exposed through `topResults`.
- `GET /search/tracks?q=...&limit=40` for the focused track catalogue.

The backend normalizes the supported Monochrome response shapes, deduplicates tracks by upstream ID, and returns the BitChord `tracks` array with duration in seconds. When BitChord supplies a separate `title` hint and the combined title/artist search returns fewer than five unique candidates, BitMono also searches by title alone. BitChord's own title/artist matcher then scores the wider candidate pool.

Only non-empty result sets are cached, for 15 seconds. Empty searches use `Cache-Control: no-store`, so a temporary upstream empty response cannot turn into a cached miss. Requests over 320 characters are rejected rather than silently shortened.

### BitMono production logs

Search diagnostics are written by the Deplexo backend as structured JSON lines with the `[BitMono]` prefix. Search responses include an `X-BitMono-Request-Id` header; use that ID to correlate the full request in Deplexo's service logs. The response also includes `X-BitMono-Cache: HIT|MISS`.

Useful events:

| Event | What it tells you |
|---|---|
| `search.received` | The query and BitChord title/artist hints reached the BitMono route. |
| `upstream.request` | Which Monochrome endpoint was requested, with attempt number and elapsed time logged in its response. |
| `upstream.response` | HTTP status, content type, payload keys, detected result arrays, and candidate count. |
| `search.title_fallback_started` | The combined query returned fewer than five unique candidates, so the title-only lookup began. |
| `search.title_fallback_complete` | Number of additional candidates contributed by title-only search. |
| `search.merged` | Normalized result count, rejected/missing IDs and titles, duplicates, and a small sample of returned tracks. |
| `search.upstream_empty` / `search.no_matches` | The upstream returned successfully but produced no usable tracks. |
| `upstream.http_error` / `upstream.failed` / `search.failed` | HTTP, timeout, invalid JSON, or other upstream failures. |

The logs intentionally omit raw upstream response bodies and credentials. They include only bounded query/title/artist text, endpoint metadata, result counts, and a small sample of normalized track metadata. If there is no `search.received` event for a request ID, the request did not reach the BitMono handler, which points to a frontend URL, proxy route, or deployment mismatch rather than a Monochrome catalogue miss.

Optional environment variable: `BITMONO_TRACKS_API_BASE` (defaults to `https://tracks.monochrome.st`). It must be the upstream API root, not a `/search` URL.

If both Monochrome search routes fail or return no usable tracks, BitMono automatically falls back to the Deezer provider at `https://dzr.tabs-vs-spaces.wtf`. It uses the BitChord-compatible `GET /search?q=...&quality=HIGH` and `GET /stream/{id}?quality=HIGH|LOW` routes. Deezer results receive a `dzr_` ID prefix so stream resolution is routed back to the correct provider. Deezer fallback is reported as HIGH/LOW and MP3 (or the actual upstream metadata); it is never mislabeled as FLAC, Hi-Res, or Dolby Atmos. Set `BITMONO_DEEZER_API_BASE` to override the fallback API root. Logs use the `fallback.deezer.*` event prefix.

## BitChord audio qualities

The personal addon exposes exactly three quality choices in BitChord:

- **AAC 256 kbps** (`high`)
- **AAC 64 kbps** (`low`)
- **Dolby Atmos** (`atmos`), when Apple's catalogue lists an Atmos variant and Cider resolves an actual Atmos rendition.

The addon disables BitChord's lossless-output gate. Stereo stream responses identify as AAC and do not forward FLAC, ALAC, WAV, Hi-Res, lossless, or bit-depth claims from Cider queue metadata. Dolby Atmos is reported as `eac3-joc` only when the resolved Cider rendition identifies as Atmos; otherwise the stream falls back to AAC stereo.
