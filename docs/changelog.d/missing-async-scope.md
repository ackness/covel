### Fixed

- **Extension providers read their own settings outside a turn.** In the image flow, UI slots and the session view, a provider's `ctx.getOwnSettings()` now returns its package `userSettings` defaults plus the world's presets instead of an empty object. See [extension points](../reference/extension-points.md).

### Changed

- **The kernel refuses to run hooks outside a session hook scope.** A host that embeds the kernel and fires hooks, commits or calls services outside the turn, resume, manual-run, background-job and commit entry points now gets `MissingHookScopeError` instead of every plugin's handlers running without their settings; wrap that code in `runWithHookScope`. Plugin handlers are unaffected. See [plugin communication](../reference/plugin-extensions.md).
