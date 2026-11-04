### Added

- **One notice center for the web client.** Toasts, cards and header chips now share one channel and one look in the top-right corner under the app bar. A bell in the app bar lists the cards that are still open (collapsed ones included) and the last 50 notices per game. [Notice center](../en/reference/ui-panels.md#notice-center) describes the three looks.
- **Background failures are no longer silent.** Failed context compaction, post-commit fan-out, aborted hooks, dropped sub-agent writes, gateway and fetch failures and failed commands leave a plain line in the bell history with the raw payload as copyable detail. With Developer mode on they also show as toasts.

### Changed

- **Nothing full-width sits between the session header and the story.** The banners for a failed theme, plugins waiting for approval, unavailable plugins, world data, world state, an unfinished turn, a stale memory index and the setup progress are now cards; auto-advance is a chip in the session header; the public-trial notice is a card you can dismiss for good. "Clear index" for the memory index shows only in Developer mode.
- **A failed operation shows once.** The "N actions did not take effect" line stays under the story; the matching toast is gone.
