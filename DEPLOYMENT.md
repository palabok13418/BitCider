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
| `BITCIDER_ALLOWED_ORIGINS` | Optional comma-separated HTTPS origins if a custom Deplexo domain is used |
| `CIDER_API_URL` | Keep empty for normal hosted use. Signed-in accounts use their own authenticated desktop relay; this shared legacy setting is only for local/anonymous development and must never point at a user's desktop loopback address |
| `BITCIDER_CIDER_REQUEST_TIMEOUT_MS` | Optional Cider request deadline, 1,000 to 30,000 ms; per-account relay defaults to 20,000 ms |
| `BITCIDER_ALLOW_LOOPBACK_CIDER_API` | Keep unset/false on Deplexo. Only set to `true` for a deliberately local development server connecting to loopback Cider |

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

The current BitCider frontend expects the Deplexo API version `2026-11-23-account-key-v8`.

- `GET https://YOUR-DEPLEXO-APP/health` should return `"apiVersion":"2026-11-23-account-key-v8"` and `"perUserCiderRelaySupported":true`. The signed-in account's `/api/status` response reports `ciderRelay.provisioned` and `ciderRelay.online`; the global `/health` field `ciderBridgeConfigured` describes only the legacy shared bridge, not a specific user's relay.
- `GET /api/connect` is intentionally rejected with HTTP `405 METHOD_NOT_ALLOWED`; the actual linking request is a `POST` sent by the site after Cider approves the native dialog.
- If BitCider reports that its Deplexo backend is older, redeploy the latest `main` commit on Deplexo before trying to link.

Opening `/api/connect` directly in the address bar does not test linking. The address bar sends `GET`, while linking requires a `POST` containing the token returned by Cider's `POST /api/v2/auth/request` response.

## 2. Deploy the website on Netlify

Create a Netlify site from the same repository and use:

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

Add these runtime environment variables in Netlify:

- `BITCIDER_BACKEND_ORIGIN`: the Deplexo app HTTPS origin.
- `BITCIDER_PROXY_SECRET`: the exact shared gateway secret configured on Deplexo.

The Netlify Function forwards only `/api/*` and BitChord addon routes to Deplexo. The static website is served from `dist`.

## 3. Deploy the website on Cloudflare Workers

Create a Worker connected to this repository. Use the checked-in `wrangler.jsonc`:

- Worker entrypoint: `cloudflare/worker.mjs`
- Static assets directory: `dist`
- Worker-first paths: `/api/*`, addon `manifest.json`, `search`, and `stream` routes.

Add `BITCIDER_BACKEND_ORIGIN` as a regular Worker variable (it is already declared in `wrangler.jsonc`). Add `BITCIDER_PROXY_SECRET` separately as a **Worker Secret**, never as a checked-in plaintext variable. With Wrangler, set it using:

```sh
npx wrangler secret put BITCIDER_PROXY_SECRET
```

Paste the exact shared secret configured on Deplexo when prompted. The secret must be available to the deployed Worker at runtime.

Build the frontend with `npm run build` before deploying the Worker. Cloudflare serves ordinary frontend assets directly and invokes the Worker for API/addon paths.

## 4. BitCider accounts, recovery, and stored data

The current frontend/backend API version is `2026-11-23-account-key-v8`. Deplexo must run the matching `main` revision before the account panel can be used.

BitCider accounts do not collect a username or email. Each account has a random 256-bit Account Key; sign in with that key plus the password, or use a discoverable passkey. Recovery requires one unused recovery code and rotates the Account Key. Cider app tokens are stored connection data and are not the cross-device account identifier. The integration does not request Cider's `account` scope. Each account supports up to five passkeys and five active device sessions.

Security controls:
- Passwords are hashed with Node.js scrypt (N=32768, r=8, p=1, 64-byte output) using a fresh 16-byte random salt per account. Plaintext passwords are never persisted.
- Authenticated session values are random 256-bit tokens in Secure, HttpOnly, SameSite=Lax cookies. Only SHA-256 hashes are stored in `connection.json`. Sessions expire after 30 days, and an account may have up to five active device sessions. A sixth sign-in revokes the least-recently-active session.
- Passkeys use WebAuthn through SimpleWebAuthn, require user verification, and store only public credential material. Each account may register up to five passkeys. Adding/removing passkeys or revoking a device requires the current BitCider passphrase.
- Passkeys are tied to the website domain (relying-party ID) where they are created. Deplexo, Netlify, and Cloudflare hostnames are separate relying parties, so create a passkey on the hostname you normally use. Synced passkeys can be available on more than one physical device; the five-device limit counts active BitCider sessions.
- State-changing account, connect, and disconnect requests require the session-bound `X-BitCider-CSRF` HMAC token returned by `GET /api/status`.
- Account Key sign-in, passkey sign-in, and recovery are independently rate-limited and protected by session-bound CSRF. Cider connection matching is a separate flow. Store writes are serialized within the Node process to avoid concurrent JSON updates overwriting account data.
- Cider app tokens are encrypted with AES-256-GCM using the dedicated Deplexo `BITCIDER_ENCRYPTION_KEY`, separate from the persistent data volume. The key must be backed up securely and never committed. The `connection.json` store and legacy `encryption.key` remain under `/data/bitcider` with restrictive file permissions. Protect and back up the full volume as well; runtime/server compromise can still expose decrypted credentials.
- The personal addon URL is a bearer-style secret. Do not post it publicly. It is never saved to browser localStorage; the website returns it to the matching browser session or signed-in account over a no-store API response.
- Registration creates 10 one-time recovery codes. They are shown once, while only their hashes are saved. Keep them in a password manager or offline safe location. Using a recovery code resets the passphrase, generates a fresh set of codes, and invalidates all active device sessions.
- No email is collected or used for recovery. Losing both the passphrase and all unused recovery codes means the BitCider account cannot be recovered.

When an anonymous browser already has a Cider connection, creating an account moves that encrypted Cider connection and its current addon key into the account. After sign-in on a different device, `GET /api/status` returns the already-saved addon URL for that account. Signing out revokes that browser session but does not delete the saved Cider connection. Disconnecting Cider deletes the account's saved token and addon key.

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

## Per-user Cider desktop relay

A hosted Deplexo container cannot reach Cider at `127.0.0.1:10767` on a user's computer. BitCider now includes a per-account outbound relay. The BitCider addon sends a scoped request to the signed-in account's relay queue; the local runner fetches that job over HTTPS, calls the user's local Cider API, and returns the JSON result. Each account has a separate random relay key, stored server-side only as a SHA-256 hash. The desktop relay key is never used as the Cider app token.

### Set it up

1. Open BitCider on the computer where Cider is installed. Link Cider and sign in to your BitCider account. The relay setup is available only for a signed-in account.
2. In the **Desktop Cider Relay** panel, choose **Download Relay Config**. This downloads `bitcider-relay.json`.
3. Use the link that appears to download `bitcider-relay.mjs`. Keep both files in the same private folder. The JSON contains a local copy of your Cider app token and the account's relay key. Treat it like a password: do not share it, upload it publicly, or commit it to Git.
4. Keep Cider open. Install Node.js 20 or newer if it is not already installed.
5. Open PowerShell or Terminal in the folder containing both files and run:

   ```sh
   node bitcider-relay.mjs
   ```

6. Leave that terminal running while using the BitCider source in BitChord. The Desktop Cider Relay indicator should change from **OFFLINE** to **ONLINE**. Retry the song search in BitChord after it is online.

The agent reconnects automatically after temporary network failures. Start it again whenever the computer reboots or the terminal is closed. It makes outbound HTTPS requests only; it does not open a public port, create a tunnel into the computer, or accept inbound connections from the internet.

### What is forwarded

The local runner has a strict allowlist for the BitCider operations currently required:
- `GET /api/v2/library/songs` with `offset` and `limit` only (maximum page size 100).
- `POST /api/v2/playback/play-item` for a song ID.
- `GET /api/v2/queue`.
- `POST /api/v2/playback/pause`.

Other Cider API paths, arbitrary hosts, redirects, and non-loopback local API URLs are rejected. The local Cider app token is added by the runner and is never logged or returned to BitCider. Relay responses are account-bound, size-limited, and returned over HTTPS. Search currently searches the songs in the linked Cider library; it is not an unrestricted Apple Music catalog search.

### Credentials and revocation

- The relay key is random per BitCider account and stored on Deplexo only as a hash. The backend authenticates it with constant-time comparison and binds every queued job and response to the same account.
- The config file includes the user's Cider app token in plaintext because the local runner needs to authenticate to Cider. Keep the file private and store it somewhere protected. The token also remains encrypted at rest in the BitCider account store so the connection can be restored across signed-in devices.
- Downloading a replacement config rotates the relay key and invalidates the old runner's key. Start the runner using the newest config. Disconnecting Cider revokes the relay key.
- The relay broker and pending request queue are held in the Deplexo Node process memory. Keep the hosted backend as one active Node instance; a restart clears pending jobs, and the desktop agent reconnects automatically. Do not horizontally scale this backend without moving the relay broker to shared durable messaging.
- Do not set Deplexo's `CIDER_API_URL` to `http://127.0.0.1:10767`, and do not expose Cider's port 10767 directly to the public internet.

The earlier `BitCider search failed: fetch failed` messages occurred because the hosted server tried to contact its own container loopback address. Account-owned addon requests now route through this local relay instead. A missing or offline runner returns the actionable codes `CIDER_BRIDGE_NOT_CONFIGURED` or `CIDER_BRIDGE_OFFLINE`; a slow local Cider request returns `CIDER_BRIDGE_TIMEOUT`.

## Deployment scope

No Vercel, Render, Railway, Fly.io, or other hosting targets are configured or supported by this project. Use only Deplexo, Netlify, and Cloudflare for hosted deployments.
