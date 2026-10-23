### Security

- **Desktop runtime verification fails closed across builds, packaging, startup, and restart.** Verify actual embedded versions and RunAsNode capability, bind target resources to the main bundle, check packaged ASAR bytes before release smoke, and strip inherited runtime-control environment variables without removing legitimate CA, proxy, or provider settings.
- **Release verification uses a patched ASAR reader and bounded brace expansion.** Pin the build-only archive reader to `@electron/asar` 4.3.1 and restrict the `brace-expansion` 5.0.12 override to `minimatch` 10, leaving older dependency lines unchanged.
