### Breaking

- **The JSON file settings backend now requires an explicit IPC transport.** Integrations must call `createJsonFileBackend({ ipc })` or choose another settings backend; the REST transport options and server-managed secret markers have been removed. Desktop settings continue to use IPC, and browser settings use localStorage. See `docs/reference/settings-store.md`.
