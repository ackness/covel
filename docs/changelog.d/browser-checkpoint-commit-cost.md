### Fixed

- **Long browser-private sessions stay responsive after each turn.** Saving a turn to the browser vault no longer re-validates and deep-copies the whole session several times: the downloaded commit is validated once, the stored checkpoint is trusted because every write validates it, and a server commit reads only the small session head. Per-commit work grows with the session, so the page paused for longer each turn before.
