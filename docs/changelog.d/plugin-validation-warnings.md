### Changed

- **Plugin CLI validation displays available warnings even when a package has errors.** Errors from the first failing stage remain on stderr with exit code 1; collected warnings appear once on stdout. Warning-only packages still exit successfully. See [plugin testing](../plugins/testing.md#校验).
