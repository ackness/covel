### Fixed

- **Narrative Only and the minimal-set reset no longer retain World Dimensions by default.** The pack excludes `world-init`, and the reset keeps only narrative plugins and the dependencies declared by them and the world. All bundled worlds can start with only the narrator active; dimensions are skipped with a notice when their provider is inactive.
