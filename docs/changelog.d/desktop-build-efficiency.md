### Fixed

- **Windows desktop backend launches hide the extra Node console window.** Starting or restarting the managed backend keeps its console hidden.
- **Desktop health checks release unused response bodies.** Repeated readiness and heartbeat checks no longer retain connections for bodies they never read.

### Changed

- **Desktop backend verification reads large runtime files asynchronously before starting the server.** Every start, restart, and recovery still checks the pinned runtime and main bundle afresh, while file reads yield to the desktop event loop. Failed checks still stop startup and request a complete reinstall.

- **Standalone desktop build preparation no longer downloads an unused Electron runtime.** It verifies the pinned Node backend during preparation; electron-builder acquires the target Electron distribution during packaging. Builds that select Electron as the backend still acquire and check it before building.
