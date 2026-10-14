### Fixed

- **Model settings keep partial input until it is committed.** Number fields and sliders use drafts, and consecutive saves no longer discard later edits (F-037).
- **Model discovery follows the selected connection.** Changing the target clears old results and list selections while preserving manually entered IDs (F-094).
- **Destructive settings actions ask for confirmation.** Provider and model deletion explain the affected keys and role bindings; plugin removal and theme deletion also require confirmation (F-191).
- **Read-only settings retain recovery tools.** Export, backup viewing and downloads remain available while setting writes stay disabled (F-199).
