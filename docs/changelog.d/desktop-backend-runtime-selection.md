### Added

- **Desktop builds can explicitly switch backend runtimes without rewriting the server lifecycle.** `apps/desktop/node-runtime.json` selects standalone Node by default or a security-gated packaged Electron runtime. Electron mode omits the extra Node resource; switching requires a complete rebuild. Current Electron 44.9.3 remains ineligible because its embedded Node is below the security floor.

### Security

- **Desktop runtime selection fails closed across builds, packaging, startup, and restart.** Verify actual embedded versions and RunAsNode capability, bind target resources to the main bundle, check packaged ASAR bytes before release smoke, and strip inherited runtime-control environment variables without removing legitimate CA, proxy, or provider settings.
- **Release verification uses a patched ASAR reader and bounded brace expansion.** Pin the build-only archive reader to `@electron/asar` 4.3.1 and restrict the `brace-expansion` 5.0.12 override to `minimatch` 10, leaving older dependency lines unchanged.
