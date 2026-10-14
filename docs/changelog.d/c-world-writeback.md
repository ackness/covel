### Fixed

- **World translation and generation keep the last good package on failed saves.** File write-back uses staging and the ZIP-install package preflight, restores replaced files on record-save failure, and retains save-time conflict checks.
- **One broken authoring contract no longer disables world creation.** Unreadable examples and missing, invalid, or conflicting schemas skip only the affected contract, with diagnostics for authors and generation warnings.
- **World generation, revision, and translation share their documented SSE exclusion.** A second operation is rejected before model work begins, and admission is released after cleanup.
