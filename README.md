# BitCider

BitCider connects a user's Cider app to a personal BitChord addon endpoint.

## What it does

- Requests Cider access as **BitCider** through `cider://request-auth`.
- Uses the `playback`, `queue`, `library`, and `audio` scopes.
- Stores the approved Cider app token encrypted on the BitCider host.
- Creates a unique personal addon URL.
- Exposes the BitChord addon routes: `GET /manifest.json`, `GET /search?q=...`, and `GET /stream/:id`.

The supplied LineWaves WebGL component is used as the full-page animated background.

## Important architecture note

Cider's API is local to the computer running Cider (normally port `10767`). Run BitCider on that same computer. BitChord must be able to reach the BitCider server over the network.

For same-network testing, add the LAN URL shown in the UI to BitChord while the phone and Cider computer are on the same Wi-Fi. For access outside the LAN, place the service behind a public HTTPS tunnel or reverse proxy and set `BITCIDER_PUBLIC_URL` to that HTTPS base URL. Route only the personal addon path to the public internet; keep `/api/*` and the connection UI private to the Cider computer.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run build
npm start
```

Open `http://localhost:8787` on the same computer as Cider.

For frontend development, run the bridge and Vite in separate terminals:

```bash
npm start
npm run dev
```

Vite forwards `/api` calls to the local BitCider server on port 8787.

## Cider linking

The connect button opens:

```
cider://request-auth?app-name=BitCider&scopes=playback,queue,library,audio
```

The Connect button opens that exact Cider custom-protocol link. After approval, copy the one-time app token from Cider and paste it into the BitCider form. A browser page cannot silently read a token displayed by another desktop app. BitCider verifies the token with Cider's unscoped `GET /api/v2/client/info` endpoint before storing it.

Cider app tokens are sent to the local BitCider service and encrypted at rest with AES-256-GCM. The encryption key is created in `.bitcider/encryption.key`, which is excluded from Git. Back up that key with the connection file if you need to move the same local connection to another machine. Disconnecting deletes the encrypted connection record; revoke the app token from Cider's Connected Apps settings as well.

## Add to BitChord

After linking Cider, copy the personal addon URL shown by the site. In BitChord, open **Settings → Sources → Add an addon** and paste the URL.

BitChord's addon contract expects a manifest, search results, and stream resolution. The current stream adapter asks Cider to resolve a selected song, then reads the asset URL from Cider's playback queue. Actual stream compatibility depends on the Cider build and the media URL returned for that Apple Music item; test with a few tracks before relying on it.

## Configuration

Copy `.env.example` to `.env` and set:

- `BITCIDER_PUBLIC_URL`: public HTTPS origin if BitChord connects from outside the LAN.
- `CIDER_API_URL`: local Cider API origin, default `http://127.0.0.1:10767`.
- `PORT`: BitCider server port, default `8787`.

## Current boundaries

- This is a single-user BitCider server instance. Each user's Cider account needs its own running instance and personal addon URL.
- This initial version searches the linked Cider library, not the entire Apple Music catalogue. Full catalogue search would require the more sensitive `account` scope to obtain MusicKit credentials, so it is intentionally not requested.
- The first adapter searches paginated songs from the user's Cider library using the scoped v2 Library API, then asks the v2 Playback API to resolve the selected song. It reads the legacy v1 playback queue for Cider's playable asset URL. If your Cider version does not expose an asset URL for a track, that track cannot be streamed through this adapter yet.
- The manifest does not claim BitChord's optional hardware-backed `bitchordAuth` verification until the verifier is added and tested against the target hostname.
