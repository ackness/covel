### Fixed

- **Failed turns explain how to fix model errors.** Runtime failure events retain the provider failure category, and the turn UI reuses the connection test remedies while keeping the provider message in details. Concealed runtimes keep their fixed error text.
- **Account failures skip backups with the same credentials.** After a refused key (401) or a balance or billing failure, a call skips targets with the same provider, base URL, and key, while still trying configured independent targets. A 403 or a rate limit still tries a same-account backup, because it can apply to one model only.
