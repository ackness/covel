### Changed

- **API validation errors are more consistent.** Lorebook writes and model list/ping requests report coded JSON-body errors; session execution/control and world-data sync report `session_not_found` for missing sessions. Plugin RPC field errors and session plugin mutation errors use shared validation wording. Status codes and approval requirements are unchanged. See [HTTP API](../reference/api.md).
