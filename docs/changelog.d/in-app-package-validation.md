### Added

- **Validate plugin and world packs from Settings → Install & manage.** Check installed packages or ZIPs without installing or executing their code, inspect structured issues and copy a report. The install API also accepts contained directory paths and hides host paths.

### Changed

- **CLI and app validation share their static validators.** `runValidateManifest` prints the result of `validatePluginPackage` while retaining its first-failure output. `validateWorldPackage` accepts a catalogue so live-server validation leaves global conventions unchanged.
