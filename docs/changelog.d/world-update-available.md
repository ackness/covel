### Added

- **Worlds show when their package has changed.** Bundled and installed worlds display an "Update available" badge when files on disk differ from the imported version. "Restore the package version" applies the package’s world data and settings while preserving saved sessions.

### Upgrade notes

- **Development worlds without a package digest need one restore to enable update detection.** Back up app edits before restoring; the restore replaces world data and settings.
