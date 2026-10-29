### Added

- **Validate plugin and world packs from Settings → Install & manage.** Check installed packages or ZIPs without installing or executing their code, inspect structured issues and copy a report. The install API also accepts contained directory paths and hides host paths.

### Changed

- **CLI and app validation share their static validators.** `runValidateManifest` prints the result of `validatePluginPackage` while retaining its first-failure output. `validateWorldPackage` accepts a catalogue so live-server validation leaves global conventions unchanged.

### Fixed

- **Uploaded validation preserves derived package IDs.** Plugins without a manifest ID use the installation identity rules, and worlds without an ID retain their package folder or ZIP filename identity.
- **Installed worlds with damaged or missing manifests can still be validated.** Validation resolves their installed directory names and returns structured manifest diagnostics while preserving ambiguity, containment and symlink checks.
