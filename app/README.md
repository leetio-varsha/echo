# app/ — native macOS menu-bar app (Phase 2+)

Not built yet. Placeholder for the SwiftUI `MenuBarExtra` app.

Planned scope:

- **Phase 2** — manual Start/Stop. Capture system audio via ScreenCaptureKit and
  the mic via AVAudioEngine as **two separate tracks** (gives free "Me / Them"
  speaker labels), mix to a timestamped `.m4a`, then invoke the pipeline:
  `node <repo>/pipeline/src/index.js <audiofile>`.
- **Phase 3** — auto-detect calls via Core Audio
  (`kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device) and
  prompt "Looks like a call started — record?" with Start / Ignore.
- **Phase 4** — enrich with the current Google Calendar event (title + attendees).

Permissions to handle: Microphone, Screen Recording (for ScreenCaptureKit audio),
Notifications.
