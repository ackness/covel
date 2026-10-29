### Added

- **Instance owners and operators can choose trusted GitHub sources.** Install previews show capability snapshots, and package lists report integrity and automatic approval.

### Changed

- **Discovery location and instance source policy determine approval prompts.** Packages stay `builtin` or `community`; trusted sources add no API or privilege, and updates retain the previous capability snapshot.

### Security

- **Community package digests are verified at boot and refreshed before execution gates.** Modified, unreadable, missing-receipt or capability-growing packages use normal approval; per-action RPC approval and shared-host operator checks remain required.

### Upgrade notes

- **Nothing is trusted by default.** Existing receipts have no snapshot; the first normal server-code approval for a trusted, verified package records one. Receipts gain an optional `capabilities` field; no stored data needs recreation.
