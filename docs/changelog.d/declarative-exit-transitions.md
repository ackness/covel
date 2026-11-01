### Added

- **Display lists can request a short host-owned departure fade.** [EntryList](../en/reference/ui-components.md#data) and [stage cast providers](../en/reference/ui-panels.md#stagecast1) accept the optional literal `exitTransition: "none" | "fade"`. Stable keyed content can fade for 300ms with autonomous bounded cleanup while current data updates immediately. Retention is capped, inert, hidden from assistive technology and disabled by reduced motion.

### Changed

- **Inferred stage departures now require an explicit opt-in.** Omission or `"none"` cuts immediately. Scene Stage cast and direction providers both emit `"fade"` to preserve their existing presentation; delivered explicit actor exits retain their own transitions. No persistent schema change or development-data reset is needed.
