### Fixed

- **Failed turns explain how to fix model errors.** Runtime failure events retain the provider failure category, and the turn UI reuses the connection test remedies while keeping the provider message in details. Concealed runtimes keep their fixed error text.
- **Account failures skip backups with the same credentials.** After a quota, billing, or key failure, a call skips targets with the same provider, base URL, and key, while still trying configured independent targets.
