# BitConnection active-party UI — required reference

Use this specification for every active-party screen update. The active-party page must follow the user's requested composition, not substitute a Queue or Members navigation item.

## Desktop composition

- Full-bleed dark plum / rose Grainient canvas; do not wrap the whole room in an additional oversized card.
- Two-column body: playback always stays on the left; the right side is the content workspace.
- Left column: small hosting/listening status, square cover art (or a wide waveform empty-state tile), track title and artist, timeline with elapsed/total time, audio format mark centered below the timeline, previous/play/next controls, volume, and a compact status for the selected BitMono, CCustom, or Cider source; do not show a screen-share button or picker.
- Right column header: hosting/joined status, room name, and current member count.
- The right content opens on **Lyrics** by default. Keep the currently active lyric centered and clearly emphasized, with surrounding lines quieter.
- A four-item rounded floating bottom navigation sits at the bottom center of the viewport and contains exactly **Lyrics**, **Room**, **Chat**, and **Leave**. Do not use Queue or Members as navigation destinations.
- **Room** is the home for room information: the text “Host controls playback” (or the actual shared-controls state) above the join details; BitChord room code on the left; one QR code centered; MusAudio room code on the right. If QR generation fails, show the room code as readable text beside/in the fallback area. The Room view also contains the people list, host moderation actions, and queue controls.
- Only show a MusAudio room code when the room/session actually provides one. Do not fabricate or duplicate the BitChord code as a MusAudio code; use a clear “Not linked” state otherwise.
- **Chat** keeps the message history and the bottom composer with GIF picker, image-only attachment, and voice-to-text controls.
- Keep the Browser action as a small floating pill near the lower-right edge, clear of the navigation.

## Visual language and responsive behavior

- Preserve the screenshot's rose glow at the upper-right, deep burgundy-to-black shadows, pale typography, subtle glass controls, fine borders, and soft pink accents.
- Keep the play button as the most prominent transport control; secondary controls should be restrained.
- Room code cards should flank the centered, high-contrast QR. The QR must remain scannable and must never be replaced by a decorative image.
- On narrow screens, stack playback and room content vertically, keep the bottom navigation centered/fixed above the safe-area inset, and prevent Browser/navigation overlap.
- Do not let the navigation obscure lyric content, the queue, members, or chat composer.

## Behavior

- The Leave navigation action must call the existing room leave flow. Hosts alone end their party; hosts with guests leave and hand hosting to the earliest active guest. The label/accessible name should reflect “End party” versus “Leave party”.
- BitConnection party audio comes only from the source saved in BitAccount Center: BitMono, CCustom, or Cider. Apple Music remains a discovery/lyrics surface, not a fourth party audio source.
- Publish only the audio track from the selected in-page media element with HTMLMediaElement.captureStream(). Do not request the browser display picker or capture any screen, window, monitor, or tab.
- The Cider source requires the linked personal Cider relay on the host device. CCustom requires a valid HTTPS add-on manifest and browser CORS permission.
