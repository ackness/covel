### Fixed

- **A browser-private save keeps the player's plugin selection after a server restart.** When a restarted server (including a Render free instance waking from sleep) rebuilt the session, the uploaded save took the rebuilt session's metadata, so automatically added dependencies were recorded as the player's own choices and stayed on after the main plugin was turned off. A full replacement now takes all public metadata from the browser save; the server keeps only its credentials and capability generations. Rule: `docs/reference/api.md`.
