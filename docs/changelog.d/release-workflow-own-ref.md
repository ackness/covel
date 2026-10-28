### Changed

- **Build Desktop refuses a ref whose release or CI workflow differs from the one running.** Building an old tag from `main` used to fail late with `MODULE_NOT_FOUND`, because the newer steps call scripts the old source does not have. The run now stops while resolving the source and says to run the workflow from that ref (`gh workflow run release.yml --ref <ref>`). See `docs/internals/desktop-packaging.md`.
