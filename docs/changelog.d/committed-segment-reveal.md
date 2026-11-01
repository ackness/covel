### Added

- **Plugins can opt complete committed stories into segment reveal.** The shared `Reveal` display component and segment-template metadata reveal whole blocks, with a two-second maximum, host-owned Show all and a device-local Instant text override. Reduced motion, history, reload and view remount are instant. Full semantic content and copy/export remain available. See [Reveal](../en/reference/ui-components.md#complete-content-reveal).

### Changed

- **Stage input no longer waits for reading.** The character typewriter and final-click gate are removed. Paragraph navigation, rereading and local Auto-play remain separate from execution and action availability. Scene Stage opts its dialogue template into the same committed segment presentation; no session data needs recreation.
