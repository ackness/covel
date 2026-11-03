### Fixed

- **Plugin diagnostics name the file that stopped package inspection.** An `executionMode: unknown` result used to say only that inspection was "incomplete or changed". It now names the linked or unsupported file, such as a `node_modules` link in a source checkout, where bundled plugins are pnpm workspace members. Rules: [plugin installation](../reference/plugin-installation.md).
