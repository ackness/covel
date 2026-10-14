### Changed

- **Desktop builds use Electron 44.6.0.** The runtime and packaging tools receive stable fixes; the macOS 13 minimum is unchanged.
- **Source toolchains pin pnpm 12.10.1 and Node 26.10.0.** Mise, CI and the Docker image pin Node 26.10.0, the newest release eligible for the seven-day release window at this update. Dependency installation retains that waiting period without an Oxlint exception.

### Security

- **The PostgreSQL image updates pgvector to 0.8.7.** This fixes an IVFFlat index-build buffer overflow. PostgreSQL remains on version 18 with the same volume layout.
