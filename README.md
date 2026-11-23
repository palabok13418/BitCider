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

## Critical Cider bridge limitation

Cider's API normally listens on the user's own computer (commonly `127.0.0.1:10767`). A Deplexo container cannot reach the user's computer by calling its own `127.0.0.1`, and a Cider app token by itself does not make that local API remotely reachable.

A per-user outbound bridge/relay is still required for remote BitChord playback. It must keep the Cider app token on the user's device and relay only authenticated Cider API operations to Deplexo over an encrypted outbound connection. Do not expose Cider's local port directly to the public internet.

The Deplexo store is isolated by authenticated HttpOnly browser sessions mapped to BitCider accounts, with anonymous browser sessions retained until users save their connection to an account. Users do not overwrite one another's Cider tokens or personal addon keys. The current Cider API adapter is retained as an initial reference implementation, but a cloud deployment alone does not yet complete the remote playback path. This is deliberately documented rather than represented as working before it has been implemented and tested.

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


## BitChord audio qualities

The personal addon exposes exactly three quality choices in BitChord:

- **AAC 256 kbps** (`high`)
- **AAC 64 kbps** (`low`)
- **Dolby Atmos** (`atmos`), when Apple's catalogue lists an Atmos variant and Cider resolves an actual Atmos rendition.

The addon disables BitChord's lossless-output gate. Stereo stream responses identify as AAC and do not forward FLAC, ALAC, WAV, Hi-Res, lossless, or bit-depth claims from Cider queue metadata. Dolby Atmos is reported as `eac3-joc` only when the resolved Cider rendition identifies as Atmos; otherwise the stream falls back to AAC stereo.
