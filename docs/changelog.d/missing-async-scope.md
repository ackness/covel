### Fixed

- **Extension providers read their own settings outside a turn.** In UI slots, the session view and the image-flow request, a provider's `ctx.getOwnSettings()`, and that of any service it calls, now returns its package `userSettings` defaults plus the world's presets instead of an empty object. When a turn, resume or commit resolves the image flow, the provider reads that execution's settings, player values included. See [extension points](../reference/extension-points.md).
- **Service calls a sub-agent makes for a setup runtime no longer count toward pausing the provider.** When a function runtime's sub-agent called another plugin's service directly, the call was not tagged with the scheduling runtime, so a setup runtime's calls could count or clear the provider's faults. They are now exempt, as the fault latch rules already said. See [protocol](../en/reference/protocol.md#plugin-fault-latch).

### Changed

- **The kernel refuses to run hooks outside a session hook scope.** A host that embeds the kernel and fires hooks, commits or calls services outside the turn, resume, manual-run, background-job and commit entry points now gets `MissingHookScopeError` instead of every plugin's handlers running without their settings; wrap that code in `runWithHookScope`. Plugin handlers are unaffected. See [plugin communication](../reference/plugin-extensions.md).
