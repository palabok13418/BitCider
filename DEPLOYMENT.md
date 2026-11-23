# BitCider hosting

BitCider is hosted only on **Deplexo, Netlify, and Cloudflare**.

The intended deployment is:

- **Deplexo:** the one authoritative Node.js app and persistent backend.
- **Netlify:** the static React frontend and a Functions gateway to Deplexo.
- **Cloudflare:** the static React frontend and a Worker gateway to Deplexo.

Both static frontends use the same Deplexo backend and persistent store. Each browser session receives its own HttpOnly session cookie, encrypted Cider token record, and random personal addon key.

## 1. Deploy the backend on Deplexo

Connect the private `palabok13418/BitCider` repository and deploy its `main` branch. The root `deplexo.yaml` configures the Vite build and Node.js server on port 3000.

In Deplexo's environment settings, configure:

| Variable | Value |
| --- | --- |
| `BITCIDER_PUBLIC_URL` | The HTTPS origin of this Deplexo app, with no trailing slash |
| `BITCIDER_PROXY_SECRET` | A long random secret, shared only with the Netlify and Cloudflare gateways |
| `BITCIDER_DATA_DIR` | `/data/bitcider` |
| `BITCIDER_ALLOWED_ORIGINS` | Optional comma-separated HTTPS origins if a custom Deplexo domain is used |
| `CIDER_API_URL` | Reserved for the per-user Cider bridge; do not point this at a public Cider port |

Deplexo mounts the app's durable data volume at `/data`. BitCider stores its encrypted connection data and encryption key under `/data/bitcider`. Back up that volume before deleting or recreating the Deplexo app.

Keep `BITCIDER_PROXY_SECRET` out of Git, frontend build variables, and browser code. Set it as a secret in each gateway provider. The value on Deplexo must exactly match the value set on Netlify and Cloudflare.

The Deplexo website can call its own `/api/*` routes directly. The backend accepts same-origin HTTPS requests when Deplexo forwards the public app hostname to Node. For installations where the reverse proxy rewrites the Host header, set `BITCIDER_PUBLIC_URL` to the exact HTTPS origin shown in the Deplexo dashboard.

If `/api/status` or `/api/connect` returns `403 LOCAL_ONLY`, redeploy the latest `main` commit first. If it still happens, check that `BITCIDER_PUBLIC_URL` is the exact HTTPS origin of the Deplexo app, without a path or trailing slash. For a separate custom frontend domain, add its exact HTTPS origin to `BITCIDER_ALLOWED_ORIGINS` (comma-separated, no paths).

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

Add these Worker secrets/variables:

- `BITCIDER_BACKEND_ORIGIN`: the Deplexo app HTTPS origin.
- `BITCIDER_PROXY_SECRET`: the exact shared gateway secret configured on Deplexo.

Build the frontend with `npm run build` before deploying the Worker. Cloudflare serves ordinary frontend assets directly and invokes the Worker for API/addon paths.

## 4. BitChord addon URL

The personal addon URL is generated on the Deplexo backend, so the same URL works regardless of whether the user opened the frontend through Netlify or Cloudflare. It has this shape:

```
https://YOUR-DEPLEXO-APP/<personal-key>/manifest.json
```

Do not manually invent or publish a user's personal key. The backend generates one per browser session after the Cider bridge verifies the account link.

## Critical Cider bridge requirement

Cider's HTTP API normally listens on the computer running Cider (commonly `127.0.0.1:10767`). A hosted Deplexo container cannot use its own `127.0.0.1` to reach a user's computer. The browser site also cannot make that remote API reachable merely by storing a Cider app token.

Therefore, **the three hosting targets above are configured, but remote Cider playback is not yet production-complete**. A per-user outbound Cider bridge/relay must connect the user's Cider instance to Deplexo over an authenticated encrypted channel. The bridge must keep the Cider app token on the user's own device and proxy only the required playback/library operations. Do not expose port 10767 directly to the public internet.

Until that bridge is implemented and tested, deploying the website does not by itself make BitChord playback work from another device. The current server-side Cider API adapter is retained as the protocol implementation to be moved behind that bridge.

## Deployment scope

No Vercel, Render, Railway, Fly.io, or other hosting targets are configured or supported by this project. Use only Deplexo, Netlify, and Cloudflare for hosted deployments.
