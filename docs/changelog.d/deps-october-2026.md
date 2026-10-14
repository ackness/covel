### Changed

- **Desktop builds use Electron 44.6.0.** The runtime and packaging tools receive stable fixes; the macOS 13 minimum is unchanged.
- **Source toolchains pin pnpm 12.10.1 and Node 26.10.0.** Mise, CI and the Docker image pin Node 26.10.0, the newest release eligible for the seven-day release window at this update. Dependency installation retains that waiting period without an Oxlint exception.
