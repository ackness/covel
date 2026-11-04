### Breaking

- **RPC action names cannot use internal approval prefixes.** Rename any action starting with `covel:`, `runtime:` or `event:` in its declaration and `registerRpc` call, then update or reinstall that plugin. Existing database records need no recreation.

### Added

- **Instance owners and operators can choose trusted GitHub sources.** Set `trust.sources` in the server settings or `COVEL_TRUSTED_SOURCES`; nothing is trusted by default. Install previews show capability snapshots, and package lists report integrity and automatic approval.

### Changed

- **Discovery location and instance source policy determine approval prompts.** Packages stay `builtin` or `community`; trusted sources add no API or privilege, and updates retain the previous capability snapshot.

### Security

- **Community package digests are verified at boot and refreshed before execution gates.** Modified, unreadable, missing-receipt or capability-growing packages use normal approval; per-action RPC approval and shared-host operator checks remain required.
- **Ordinary RPC actions cannot reuse internal approval grants.** Declarations, registration and request validation reject reserved approval prefixes, including for trusted packages.

### Upgrade notes

- **Nothing is trusted by default.** Choose trusted GitHub sources in the server setting `trust.sources` or `COVEL_TRUSTED_SOURCES` (see the [environment registry](../en/reference/env-registry.md)); until then every code package prompts as before. Existing receipts have no snapshot; the first normal server-code approval for a trusted, verified package records one. Receipts gain an optional `capabilities` field; no stored data needs recreation.
