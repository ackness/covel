### Fixed

- **Incompatible plugin contract schemas are rejected before installation.** The installer and loader now use the same rules. A plugin that changes a framework-owned schema or uses a different schema file for an accepted data contract can no longer appear to install successfully and then fail to load. See [plugin installation](../en/reference/plugin-installation.md).
