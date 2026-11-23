# BitCider

BitCider connects a user's Cider account to a personal BitChord addon endpoint.

## Hosting targets

BitCider is configured for only these hosting providers:

- **Deplexo** runs the authoritative Node.js backend and stores persistent encrypted data.
- **Netlify** serves the React frontend and forwards API/addon requests through a Netlify Function.
- **Cloudflare Workers** serves the React frontend and forwards API/addon requests through a Worker.

See [DEPLOYMENT.md](DEPLOYMENT.md) for provider setup and environment variables.

## Current features

- Opens Cider's `cider://request-auth` authorization flow as **BitCider**.
- Requests `playback`, `queue`, `library`, and `audio` scopes.
- Includes the supplied LineWaves WebGL background.
- Gives each browser session its own encrypted Cider connection record and unique personal BitChord addon URL.
- Implements the addon manifest, search, and stream-resolution route shapes.
- Encrypts saved Cider app tokens with AES-256-GCM.
- Uses Deplexo's `/data` persistent volume for the connection record and encryption key.
- Keeps connection-management API routes behind the trusted Netlify/Cloudflare gateway secret.

## Cider authorization

The site opens:

```
cider://request-auth?app-name=BitCider&scopes=playback,queue,library,audio
```

After the user approves the app in Cider, this first version asks the user to paste the one-time Cider app token into BitCider. The browser cannot silently read text displayed by another desktop application.

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
