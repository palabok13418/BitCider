# BitConnection active-party UI

Use the user's shared active-party screenshot as the reference for every future room-screen redesign.

## Desktop composition

- Keep the room screen full-bleed over the dark plum / rose Grainient background. Do not wrap the whole experience in a second large card.
- The top band spans the page: room code and copy action at the upper left, a short BitChord join instruction below it, and the high-contrast QR code at the upper right.
- The body is a two-column split. The left column is the playback surface; the right column is the room information and content surface.
- Left column order: small live/hosting status, cover artwork (or a wide landscape empty-state tile with the waveform centered), track title and artist, timeline with elapsed/total time, audio-quality mark or available-format labels, previous/play/next, volume, host tab-audio sharing control, then the host's End party / Leave party action.
- Right column order: hosting/joined eyebrow, room title, live member count, active content, then a compact rounded floating navigation for Lyrics, Queue, Chat, and Members.
- The navigation belongs to the bottom of the right content panel, not across the full page or over the playback column. Default to Members to match the shared reference state.
- Keep the Browser action as a small floating pill near the lower-right edge.

## Visual language

- Use the existing dark burgundy-to-rose canvas, subtle glass surfaces, low-contrast fine borders, soft pink highlights, and pale text.
- Keep the playback button as the one prominent control; secondary controls should remain quieter.
- Member rows should be compact glass cards with a circular avatar, name, listening/host status, and host-only moderation controls.
- Keep track artwork square when artwork exists. Use the wider landscape waveform surface only for the no-track empty state.
- Keep the content area spacious and readable; do not let the floating navigation cover the member cards or chat composer.
- On narrow screens, stack room code, player, and room content vertically. Keep the navigation fixed above the safe-area inset and keep the Browser pill clear of it.

## Behavior and playback

- The room UI must not imply that unavailable direct MusicKit controls work. Without APPLE_MUSICKIT_DEVELOPER_TOKEN, use the official Apple Music embedded-player fallback; users sign in inside Apple's player for full songs.
- Browser-native media methods (getDisplayMedia, play, pause, and captureStream) must be invoked with their owning object as the receiver. Avoid extracting those methods and calling them unbound.
- ERR_BLOCKED_BY_CLIENT from the optional Cloudflare Insights beacon or injected browser-extension scripts is not a BitConnection room playback failure. Do not couple room playback state to those optional scripts.
