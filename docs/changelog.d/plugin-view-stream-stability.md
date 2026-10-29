### Fixed

- **Plugin views replace discarded narrative drafts correctly.** Stream resets invalidate the append baseline even when replacement prose grows past the old length before the next flush; normal completion still preserves the final tail.
- **Session bridge message ordinals survive history changes.** Surviving and reloaded messages retain their identities through host eviction and history prepend. Stream feeds share the same ordinals, and completed story messages retain their placeholder's ordinal. Array order defines chronology.
- **Null UI specs report their declaration location.** Static validation names the manifest, UI placement and spec file instead of throwing a property-access error.
