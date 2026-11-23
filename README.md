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
- Includes the supplied LineWaves WebGL background.
- Gives each browser session its own encrypted Cider connection record and unique personal BitChord addon URL.
- Implements the addon manifest, search, and stream-resolution route shapes.
- Encrypts saved Cider app tokens with AES-256-GCM.
- Uses Deplexo's `/data` persistent volume for the connection record and encryption key.
- Allows exact same-origin Deplexo HTTPS requests to manage a session directly, while Netlify/Cloudflare use a private gateway secret.

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

Cider's web API security may require the user to allow the exact BitCider website origin. In Cider, review **Settings → Connections → Extension security** and approve the site when prompted. Cider must be open on the same device as the browser.

## Critical Cider bridge limitation

Cider's API normally listens on the user's own computer (commonly `127.0.0.1:10767`). A Deplexo container cannot reach the user's computer by calling its own `127.0.0.1`, and a Cider app token by itself does not make that local API remotely reachable.

A per-user outbound bridge/relay is still required for remote BitChord playback. It must keep the Cider app token on the user's device and relay only authenticated Cider API operations to Deplexo over an encrypted outbound connection. Do not expose Cider's local port directly to the public internet.

The Deplexo store is isolated by an HttpOnly browser session cookie, so users do not overwrite one another's Cider tokens or personal addon keys. The current Cider API adapter is retained as an initial reference implementation, but a cloud deployment alone does not yet complete the remote playback path. This is deliberately documented rather than represented as working before it has been implemented and tested.

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
