### Fixed

- **A world deleted while the app loads no longer stops it from starting.** On the first visit with browser storage the app reads every world of the catalog; when one was deleted between the list and its read (another tab, another player of a shared server), the app showed "Startup failed: World not found". That world is now left out.
