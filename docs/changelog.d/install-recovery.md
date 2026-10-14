### Fixed

- **Interrupted installs and removals recover at startup.** Unfinished staging files are cleaned up, pending world deletions can be retried, and plugin uninstall moves the whole package out of discovery before deleting files (F-177, F-182).
- **World packages cannot supply their own installation receipt.** ZIP, GitHub, and collection imports reject `.covel-install.json` and case variants before installation, preventing forged source and update metadata (F-178).
