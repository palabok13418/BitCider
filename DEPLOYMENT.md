# BitCider hosting

BitCider is hosted only on **Deplexo, Netlify, and Cloudflare**.

The intended deployment is:

- **Deplexo:** the one authoritative Node.js app and persistent backend.
- **Netlify:** the static React frontend and a Functions gateway to Deplexo.
- **Cloudflare:** the static React frontend and a Worker gateway to Deplexo.

Both static frontends use the same Deplexo backend and persistent store. Each BitCider account or anonymous browser session has its own HttpOnly session cookie, encrypted Cider token record, and random personal addon key. Signing in on another device restores the account-owned link.

## 1. Deploy the backend on Deplexo

Connect the private `palabok13418/BitCider` repository and deploy its `main` branch. The root `deplexo.yaml` builds the Vite frontend and starts the backend directly with `node server.mjs` on port 3000. Starting Node directly avoids an extra npm/sh child process, so Deplexo's shutdown signal is delivered to the actual server process. `server.mjs` uses the hosting-provided `PORT` when present and drains HTTP connections on `SIGTERM`/`SIGINT`.

In Deplexo's environment settings, configure:

| Variable | Value |
| --- | --- |
| `BITCIDER_PUBLIC_URL` | The HTTPS origin of this Deplexo app, with no trailing slash |
| `BITCIDER_PROXY_SECRET` | A long random secret, shared only with the Netlify and Cloudflare gateways |
| `BITCIDER_DATA_DIR` | `/data/bitcider` |
| `BITCIDER_ENCRYPTION_KEY` | A stable random 32-byte base64url secret, configured on Deplexo only |
| `APPLE_MUSIC_DEVELOPER_TOKEN` | Optional Apple Music API developer JWT for the separate official personalized-recommendations feed; not used for TTML lyrics |
| `APPLE_MUSIC_WEB_PLAYER_TOKEN` | Optional web-player Bearer override; leave blank to auto-discover it from `music.apple.com` for TTML lyrics |
| `BITCIDER_ADMIN_BOOTSTRAP_CODE` | One-time, high-entropy owner setup code; remove after the first passkey is enrolled |
| `BITCONNECTION_GIPHY_API_KEY` | Free GIPHY beta API key used only by the Deplexo GIF search proxy; never expose it in frontend variables |

### Admin mode owner bootstrap

Admin mode is disabled until an owner passkey is enrolled. Configure `BITCIDER_ADMIN_BOOTSTRAP_CODE` in Deplexo's environment with a high-entropy random secret of at least 32 characters. Generate one in a trusted terminal, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(36).toString('base64url'))"
```

Use the command's ASCII base64url output exactly as printed. Do not replace it with a UI-generated password or add spaces, quotes, Unicode glyphs, or line breaks. If a bootstrap code has been exposed in a chat or public log, generate a new one and replace the Deplexo environment value before proceeding.

You can also use `openssl rand -base64 36` if OpenSSL is available.

Do not put the generated value in source control, a URL, a frontend build variable, or a chat message. It is a backend-only Deplexo secret.

After deploying the Deplexo backend and the matching BitCider frontend:

1. Open BitCider and open the browser developer console.
2. Run `window.bitciderAdmin.bootstrap('PASTE_THE_BOOTSTRAP_CODE')`.
3. In the admin gate, choose **Enroll first passkey** and complete the platform authenticator/passkey prompt.
4. Once enrollment succeeds, remove `BITCIDER_ADMIN_BOOTSTRAP_CODE` from Deplexo's environment and redeploy the backend. The server also permanently records that bootstrap was consumed.
5. For later visits, run `window.bitciderAdmin.open()` and sign in with the owner passkey.

Only one owner passkey can be registered. There is no second-passkey or password fallback. Keep the enrolled passkey available on a secure device; losing it requires an operator-assisted recovery from the persistent admin state, not another bootstrap attempt.

The owner credential and short-lived admin sessions are stored in `admin.json` under `BITCIDER_DATA_DIR` on the persistent Deplexo volume. Admin-state writes use a filesystem lock shared by backend workers, so simultaneous bootstrap attempts across workers cannot create a second owner credential. Every Deplexo worker serving this app must use the same durable `BITCIDER_DATA_DIR` volume; do not run isolated replicas with separate copies of `admin.json`. The lock is deliberately fail-closed: if a backend process is terminated while holding it, admin state writes time out rather than stealing a possibly active lock. Only after stopping every BitCider backend worker, an operator may remove the abandoned `admin.json.lock` file from the persistent volume and restart the service. Never remove that lock while any backend worker is active. This one-owner rule applies to the Admin Console owner credential only. Normal BitCider and BitConnection user accounts keep their own independent passkey flows. Protect that volume and its backups like account-authentication data. The admin console lists anonymous account references only, not usernames, email addresses, IP addresses, device names, or profile data. “Active” is an estimate based on an authenticated request within the last two minutes.

Bot accounts are test identities. A generated BitCider bot has an Account Key and password but no Cider/Apple Music token, so it is not a linked music account. The generated credentials and recovery codes are displayed once in the admin session; copy them before leaving the panel.

| `BITCIDER_ALLOWED_ORIGINS` | Optional comma-separated HTTPS origins if a custom Deplexo domain is used |
| `BITCIDER_CIDER_REQUEST_TIMEOUT_MS` | Optional browser-bridge Cider request deadline, 1,000 to 30,000 ms; defaults to 20,000 ms |

Deplexo mounts the app's durable data volume at `/data`. BitCider stores `connection.json` and a legacy CSRF-signing key under `/data/bitcider`; the dedicated Cider-token encryption key is configured separately as the `BITCIDER_ENCRYPTION_KEY` Deplexo secret. Back up the volume and keep a separate secure backup of the environment key before deleting or recreating the Deplexo app.

Keep `BITCIDER_PROXY_SECRET` out of Git, frontend build variables, and browser code. Set it as a secret in each gateway provider. The value on Deplexo must exactly match the value set on Netlify and Cloudflare.

Generate `BITCIDER_ENCRYPTION_KEY` once using:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Copy the output directly into Deplexo's secret environment settings. Do not set this encryption key on Netlify or Cloudflare, and do not commit it. BitCider blocks account registration, sign-in, and account recovery until this secret is configured. Keep a secure offline backup. It must remain unchanged: losing or rotating it makes records encrypted with that key unreadable. On the first backend startup after adding it, BitCider automatically re-encrypts existing volume-key Cider tokens with the dedicated key. The legacy `encryption.key` file remains for session-bound CSRF signing and legacy-token migration.

The Deplexo website can call its own `/api/*` routes directly. The backend accepts same-origin HTTPS requests when Deplexo forwards the public app hostname to Node. For installations where the reverse proxy rewrites the Host header, set `BITCIDER_PUBLIC_URL` to the exact HTTPS origin shown in the Deplexo dashboard.

If `/api/status` or `/api/connect` returns `403 LOCAL_ONLY`, redeploy the latest `main` commit first. If it still happens, check that `BITCIDER_PUBLIC_URL` is the exact HTTPS origin of the Deplexo app, without a path or trailing slash. For a separate custom frontend domain, add its exact HTTPS origin to `BITCIDER_ALLOWED_ORIGINS` (comma-separated, no paths).

## Verify that the current backend is deployed

The current BitCider backend should report these API versions after deploying the latest `main` branch:

- `GET https://YOUR-DEPLEXO-APP/health` should return `"apiVersion":"2026-11-24-account-center-v13"` and `"browserCiderBridgeSupported":true`.
- `GET https://YOUR-DEPLEXO-APP/api/bitconnection/health` should return `"apiVersion":"2026-11-26-bitmono-party-playback-v3"` and `"passkeyListing":"enabled"`. The `GET /api/bitconnection/passkeys` route should return HTTP 200 with an authenticated BitConnection session.
- The `/api/status` response reports the active browser bridge under `ciderRelay.online`.

A 404 from `/api/bitconnection/passkeys` means the Deplexo backend is still running an older build without the current passkey-listing route. Redeploy the latest `main` branch on Deplexo.
- `GET /api/connect` is intentionally rejected with HTTP `405 METHOD_NOT_ALLOWED`; the actual linking request is a `POST` sent by the site after Cider approves the native dialog.
- If BitCider reports that its Deplexo backend is older, redeploy the latest `main` commit on Deplexo before trying to link.

Opening `/api/connect` directly in the address bar does not test linking. The address bar sends `GET`, while linking requires a `POST` containing the token returned by Cider's `POST /api/v2/auth/request` response.

## BitChord Listening Party service URL

The BitConnection home page displays an environment-specific URL above **Live Discovery**. It resolves to `GET /api/bitconnection/party-service`, a public JSON service descriptor for BitChord clients. The descriptor advertises the current API base, room endpoints, participant limits, private-room admission policy, queue/chat features, moderation actions, and explicit capability flags.

The service descriptor is not a Cider addon manifest. BitChord must implement a client adapter for the listed BitConnection API routes. State-changing requests still require the documented BitConnection/BitCider account authentication and CSRF checks, or a room-scoped guest bearer credential. Do not treat the descriptor URL itself as a room invitation or as a substitute for authentication.

The descriptor reports server-side ONNX analysis as available and live AutoMix execution as unavailable until the BitChord player-control bridge is connected. BitConnection uses Beat This! final0 ONNX plus an ONNX log-mel frontend for beat/downbeat analysis, then builds a harmonic, phrase-aligned transition plan. See [AutoMix architecture and model notes](docs/AUTOMIX.md). The existing room transport still sends party audio directly over WebRTC; only separate host-authorized analysis uploads go to Deplexo.

## Server-side AutoMix model

The Deplexo service installs `onnxruntime-node` as a server dependency. On the first host request to `POST /api/bitconnection/rooms/{roomId}/automix/prepare`, it downloads the two pinned ONNX artifacts into `${BITCIDER_DATA_DIR}/bitconnection-automix/models` (or the default Deplexo data directory), verifies byte counts and SHA-256 digests, then initializes the CPU inference sessions. Set `BITCONNECTION_AUTOMIX_THREADS` on Deplexo to tune CPU parallelism; the default is 2. The host must submit each track's mono Float32 little-endian PCM at 22,050 Hz to the analysis endpoint before a DJ plan can be generated. The room's AutoMix switch deliberately remains unavailable until the BitChord player-control bridge can execute deck, tempo, EQ, filter, crossfader, and effect automation.

## Listening Party GIF search

The Listening Party chat searches GIPHY through the Deplexo endpoint `GET /api/bitconnection/gifs/search?q={query}`. Create a free GIPHY API beta key and set `BITCONNECTION_GIPHY_API_KEY` as a **Deplexo-only server environment variable**. Do not expose it in a `VITE_` variable or copy it to Netlify/Cloudflare. The endpoint enforces a per-IP search limit and the UI includes GIPHY attribution. Without the key, text and image chat still work, but GIF search returns a configuration message.

Images sent directly in chat are restricted to PNG, JPEG, and WebP, with a 512 KB maximum. Voice input uses the browser's speech-recognition feature and inserts editable text into the composer; raw voice recordings are not uploaded.

## 2. Deploy the website on Netlify

Create a Netlify site from the same repository and use:

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

Add these runtime environment variables in Netlify:

- `BITCIDER_BACKEND_ORIGIN`: the Deplexo app HTTPS origin.
- `BITCIDER_PROXY_SECRET`: the exact shared gateway secret configured on Deplexo.
- `VITE_GIPHY_API_KEY`: optional public GIPHY beta key used by the Listening Party GIF picker.

The Netlify Function forwards only `/api/*` and BitChord addon routes to Deplexo. The static website is served from `dist`.

The `/api/bitconnection/*` namespace has its own session-cookie, CSRF, and room-credential checks, so it remains available even if the optional gateway secret is missing. The shared secret is still required for the root BitCider API and addon routes. Configure it for full functionality and defense in depth.

## 3. Deploy the website on Cloudflare Workers

Create a Worker connected to this repository. Use the checked-in `wrangler.jsonc`:

- Worker entrypoint: `cloudflare/worker.mjs`
- Static assets directory: `dist`
- Worker-first paths: `/api/*`, addon `manifest.json`, `search`, and `stream` routes.

Add `BITCIDER_BACKEND_ORIGIN` as a regular Worker variable (it is already declared in `wrangler.jsonc`). Add `BITCIDER_PROXY_SECRET` separately as a **Worker Secret**, never as a checked-in plaintext variable. Add `VITE_GIPHY_API_KEY` as a frontend build variable before running `npm run build`. With Wrangler, set it using:

```sh
npx wrangler secret put BITCIDER_PROXY_SECRET
```

Paste the exact shared secret configured on Deplexo when prompted. The secret must be available to the deployed Worker at runtime.

The `/api/bitconnection/*` namespace has its own session-cookie, CSRF, and room-credential checks, so it remains available even if the optional gateway secret is missing. The shared secret is still required for the root BitCider API and addon routes. Configure it for full functionality and defense in depth.

Build the frontend with `npm run build` before deploying the Worker. Cloudflare serves ordinary frontend assets directly and invokes the Worker for API/addon paths.

## 4. BitCider accounts, recovery, and stored data

The current frontend/backend API version is `2026-11-23-account-key-v11`. Deplexo must run the matching `main` revision before the account panel can be used.

BitCider accounts do not collect a username or email. Each account has a random 256-bit Account Key; sign in with that key plus the password, or use a discoverable passkey. Recovery requires one unused recovery code and rotates the Account Key. Cider app tokens are stored connection data and are not the cross-device account identifier. The integration does not request Cider's `account` scope. Each account supports up to five passkeys and five active device sessions.

Security controls:
- Passwords are hashed with Node.js scrypt (N=32768, r=8, p=1, 64-byte output) using a fresh 16-byte random salt per account. Plaintext passwords are never persisted.
- Authenticated session values are random 256-bit tokens in Secure, HttpOnly, SameSite=Lax cookies. Only SHA-256 hashes are stored in `connection.json`. Sessions expire after 30 days, and an account may have up to five active device sessions. A sixth sign-in revokes the least-recently-active session.
- Passkeys use WebAuthn through SimpleWebAuthn, require user verification, and store only public credential material. Each account may register up to five passkeys. Adding/removing passkeys or revoking a device requires the current BitCider passphrase.
- Passkeys are tied to the website domain (relying-party ID) where they are created. Deplexo, Netlify, and Cloudflare hostnames are separate relying parties, so create a passkey on the hostname you normally use. Synced passkeys can be available on more than one physical device; the five-device limit counts active BitCider sessions.
- State-changing account, connect, and disconnect requests require the session-bound `X-BitCider-CSRF` HMAC token returned by `GET /api/status`.
- Account Key sign-in, passkey sign-in, and recovery are independently rate-limited and protected by session-bound CSRF. Cider connection matching is a separate flow. Store writes are serialized within the Node process to avoid concurrent JSON updates overwriting account data.
- Cider app tokens are encrypted with AES-256-GCM using the dedicated Deplexo `BITCIDER_ENCRYPTION_KEY`, separate from the persistent data volume. The key must be backed up securely and never committed. The `connection.json` store and legacy `encryption.key` remain under `/data/bitcider` with restrictive file permissions. Protect and back up the full volume as well; runtime/server compromise can still expose decrypted credentials.

## BitMono playback in parties

The party Browser searches the existing `/bitmono/search` route. A host can prepare a result through `/bitmono/stream/:trackId`, which fully downloads and verifies the source into the BitMono audio cache, then start the returned same-origin `/bitmono/audio/:cacheKey` stream from the in-page audio element. The host publishes that audio element's captured audio track through the room's existing direct WebRTC transport; the backend does not relay the audio. The queue and playback state accept `bitmono` as a separate validated source. The current browser must support `HTMLMediaElement.captureStream()` for this host playback path; the existing BitChord tab-share path remains available separately.

## Apple Music account connection

Users add their own Apple Music Music User Token (also referred to in the account UI as a User Media Token) in BitAccount Center. Deplexo stores that credential encrypted with the dedicated `BITCIDER_ENCRYPTION_KEY`; the plaintext token is never returned to the browser or written to logs.

**TTML lyrics do not require `APPLE_MUSIC_DEVELOPER_TOKEN` or an Apple Developer Program key.** When a track needs lyrics, Deplexo discovers the short-lived web-player Bearer token from the public JavaScript bundle served by `music.apple.com`, caches it until shortly before its JWT expiry, and sends it with the account's `Media-User-Token` to Apple's private `amp-api` lyrics endpoint. `APPLE_MUSIC_WEB_PLAYER_TOKEN` is only an optional override for that automatic discovery; it can normally remain blank. The account connection saves the user token securely and validates subscriber access on the first TTML request.

The separate official personalized-recommendations endpoint still uses `APPLE_MUSIC_DEVELOPER_TOKEN`; that setting is optional and only enables that recommendations feed. Its absence does not block connecting Apple Music or fetching TTML lyrics.

The account-scoped TTML endpoint first tries Apple's private `syllable-lyrics` response and falls back to `lyrics` for line-level timing. These lyrics routes are undocumented Apple web-player endpoints, not part of the stable public API, so they may change or stop working without notice.
- The personal addon URL is a bearer-style secret. Do not post it publicly. It is never saved to browser localStorage; the website returns it to the matching browser session or signed-in account over a no-store API response.

## BitMono complete-audio cache

BitMono does not return Monochrome or Deezer's upstream audio URL directly to BitChord. When BitChord requests a track's stream, the Deplexo backend downloads the **entire audio file** first, hashes the completed bytes, and atomically stores the file under `BITCIDER_DATA_DIR/bitmono-audio-cache` (by default `/data/bitcider/bitmono-audio-cache`). The stream resolver does not return a playback URL until the download reaches EOF and the complete cache file is ready. Playback then reads from BitCider's cached copy, not the provider's chunked endpoint. The cache route supports `HEAD`, HTTP byte ranges, ETags, and CORS range headers for seeking.

Default limits are a 256 MiB maximum per audio file, 1 GiB total audio cache, a seven-day cache lifetime, and a three-minute upstream download deadline. Expired files are removed, and least-recently-used files are evicted when the cache exceeds its size limit. An upstream error, playlist response, zero-byte body, interrupted transfer, or file above the configured size limit fails stream resolution rather than handing BitChord a partial file.

Optional Deplexo environment overrides:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `BITMONO_AUDIO_CACHE_DIR` | `/data/bitcider/bitmono-audio-cache` | Cache directory; keep it on the durable Deplexo volume |
| `BITMONO_AUDIO_CACHE_TTL_MS` | `604800000` | Cache lifetime in milliseconds (7 days) |
| `BITMONO_AUDIO_CACHE_MAX_BYTES` | `1073741824` | Total cache budget (1 GiB) |
| `BITMONO_AUDIO_MAX_FILE_BYTES` | `268435456` | Maximum complete file size (256 MiB) |
| `BITMONO_AUDIO_DOWNLOAD_TIMEOUT_MS` | `180000` | Maximum upstream download time (3 minutes) |

The complete file is preloaded before playback starts, so BitChord no longer has to fetch successive audio chunks from Monochrome or Deezer during the song. The user's connection from BitChord to the Deplexo cache still needs enough bandwidth for the selected audio bitrate.
- Registration creates 10 one-time recovery codes. They are shown once, while only their hashes are saved. Keep them in a password manager or offline safe location. Using a recovery code resets the passphrase, generates a fresh set of codes, and invalidates all active device sessions.
- No email is collected or used for recovery. Losing both the passphrase and all unused recovery codes means the BitCider account cannot be recovered.

When an anonymous browser already has a Cider connection, creating an account moves that encrypted Cider connection and its current addon key into the account. After sign-in on a different device, `GET /api/status` returns the already-saved addon URL for that account. Signing out revokes that browser session but does not delete the saved Cider connection. Disconnecting Cider deletes the account's saved token and addon key.

## BitConnection WebRTC audio transport

BitConnection uses direct host-to-guest WebRTC for audio. Deplexo handles authenticated room membership, presence, playback state, and SDP/ICE signaling; it never receives or relays the audio stream. The host browser asks the user to select the BitChord Web tab and enable **Share tab audio**. It rejects window and monitor capture and adds only audio tracks to WebRTC. The capture video track remains local because the browser's display-capture API requires a video track.

The Deplexo backend supplies public STUN servers by default. To use a TURN relay for restrictive NATs, provision a coturn-compatible relay service separately, then set these **Deplexo-only** environment variables:

| Variable | Purpose |
| --- | --- |
| `BITCONNECTION_STUN_URLS` | Optional comma-separated `stun:` / `stuns:` URLs; defaults to Google's public STUN endpoints |
| `BITCONNECTION_TURN_URLS` | Optional comma-separated `turn:` / `turns:` URLs (for example UDP 3478 and TLS/TCP 5349) |
| `BITCONNECTION_TURN_SHARED_SECRET` | Coturn REST shared secret, at least 32 bytes; keep it in Deplexo secrets only |
| `BITCONNECTION_TURN_CREDENTIAL_TTL_SECONDS` | Expiry of each participant's generated credentials; defaults to 3600 seconds (accepted range 300–86400) |

The backend issues each authenticated room participant a short-lived TURN username and HMAC-SHA1 credential using coturn's REST authentication format. The shared secret is never sent to browsers. When TURN is not configured, ICE uses STUN and direct connectivity only; some network combinations may still fail. This repository does **not** provision or host a TURN relay, so relay connectivity becomes available only after a real TURN endpoint and its matching shared secret are supplied in Deplexo. Do not put TURN secrets in Netlify, Cloudflare, frontend build variables, or Git.

Browser tab audio capture depends on browser and selected-tab support. The capture picker must expose the BitChord Web tab's audio; if the browser does not provide a tab audio track, BitConnection stops capture rather than silently sharing desktop/system audio. Guest-side audio reception is exposed as a separate transport helper; the immersive Guest View UI remains a separate implementation stage.

## 5. BitChord addon URL

The personal addon URL is generated on the Deplexo backend after the browser receives Cider's approved token and saves it to the user's anonymous session or signed-in BitCider account. The same URL works regardless of whether the user opened the frontend through Netlify or Cloudflare. It has this shape:

```
https://YOUR-DEPLEXO-APP/<personal-key>/manifest.json
```

Do not manually invent or publish a user's personal key. The backend generates a random 256-bit key for new connections and retains existing keys when a user saves an anonymous connection into an account, so their current addon URL does not change.

## Cider account linking

The website initiates Cider's native consent flow from the user's browser:

```http
POST http://127.0.0.1:10767/api/v2/auth/request
Content-Type: application/json

{
  "app_name": "BitCider",
  "scopes": ["playback", "queue", "library", "audio"]
}
```

This request is sent directly to Cider on the same device as the browser. After the user approves the native prompt, Cider returns the token to the page. The page sends it to the selected BitCider frontend's `/api/connect`; the request is forwarded to Deplexo and encrypted at rest.

Cider must be running on the same computer as the browser. On current Chrome releases, the first request from this HTTPS site to `127.0.0.1` is gated by Chrome's **Loopback network** permission; the user must choose Allow when prompted. If previously denied, open the BitCider site's Chrome permissions, set **Loopback network** to Allow, reload, and retry. The app explicitly targets the `loopback` address space and checks the permission state before requesting authorization. A Cider `403 AUTH_REQUEST_DENIED` means the user denied the Cider consent dialog; repeated denials can trigger Cider's temporary authorization rate limit. No Cider token or local API port is exposed in the frontend configuration.

## In-browser Cider bridge

A hosted Deplexo container cannot reach Cider at `127.0.0.1:10767` on a user's computer. BitCider now uses the open BitCider website tab as the bridge. The browser registers with Deplexo using the signed-in or anonymous BitCider session, polls for scoped jobs, calls the local Cider API from that same browser, and returns results to Deplexo over the same-origin HTTPS connection.

### How it works

1. The user opens BitCider on the same computer where Cider is running and links Cider through its native approval dialog.
2. BitCider automatically registers the browser tab as a local bridge. No extra setup button, account upgrade, download, installer, script, browser extension, or configuration file is required.
3. When BitChord requests a search or stream, Deplexo queues the relevant Cider API request for that browser tab.
4. The browser calls Cider at `http://127.0.0.1:10767` and returns the response to Deplexo. Deplexo completes the addon request to BitChord.

**Keep the BitCider page open** in a browser tab on the computer where Cider is running while BitChord uses the addon. Closing the tab stops the bridge; reopening BitCider automatically registers it again. The server expires inactive registrations. One active browser bridge is used per BitCider account; a newer BitCider tab takes over from the previous one.

Chrome may gate HTTPS-to-loopback requests behind its **Loopback network** permission. The BitCider Cider authorization flow already uses this local connection. If Chrome blocks it, allow Loopback network access for the BitCider site in Chrome Site settings, reload the page, and reconnect Cider if required.

When the browser bridge reports `LOCAL_CIDER_CORS_BLOCKED`, it now runs two checks to pinpoint the Cider-side restriction. First it makes a simple request without an app token, which tests whether Cider allows the exact BitCider website origin at all. Then it retries with the documented `apptoken` header. If only the second request is blocked, Cider accepted the origin but rejected the authenticated-header CORS preflight. Reconnecting cannot override that server response; update Cider to a build that supports browser access from approved origins. A real `401` or `403 UNAUTHORIZED_APP_TOKEN` is handled separately as an invalid/revoked token and does require reconnecting.

### Allowed Cider operations

The browser client uses a strict allowlist:
- `GET /api/v2/amapi/search` with `term`, `types=songs`, `limit=25`, and `offset=0` only.
- `POST /api/v2/playback/play-item` for a song ID.
- `GET /api/v2/queue`.
- `POST /api/v2/playback/pause`.

Other Cider API routes, arbitrary hosts, redirects, and non-loopback URLs are rejected. Catalog search goes through Cider's Apple Music proxy, so Cider applies the user's storefront and signs the request. It can return songs that are not yet in the user's library.

### Security and lifecycle

- Bridge registration requires the browser's existing BitCider session and session-bound CSRF token. Polling and responses require a per-tab random secret. Deplexo stores only a SHA-256 hash of that secret and compares it in constant time.
- The Cider app token remains AES-256-GCM encrypted at rest in the BitCider account store. The browser receives it only over the authenticated same-origin HTTPS registration response and keeps it in memory while the tab is active. It is not written to localStorage, IndexedDB, a config file, or logs.
- Every request and response is bound to the current bridge registration and owner. Replacing the active tab invalidates queued jobs and pollers from the previous tab. Signing out or disconnecting Cider stops the relevant bridge.
- The browser bridge and pending request queue live in Deplexo Node process memory. Keep the backend on one active Node instance; a restart temporarily stops in-flight requests, and the open BitCider tab reconnects automatically. Do not horizontally scale the backend without moving bridge coordination to shared messaging.
- Do not expose Cider's local port 10767 to the public internet. The browser makes outbound requests to the user's own local Cider service; no inbound desktop connection is created.

When the BitCider tab is closed or its local Cider connection is unavailable, the addon returns `CIDER_BRIDGE_OFFLINE` or a local Cider error instead of attempting to fetch from the Deplexo container's localhost.

## Deployment scope

No Vercel, Render, Railway, Fly.io, or other hosting targets are configured or supported by this project. Use only Deplexo, Netlify, and Cloudflare for hosted deployments.
