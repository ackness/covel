### Breaking

- **`ctx.recursiveCall()` reads only `playerMessage` and `manualTrigger: { runtimeId, payload }`.** Every other field of the delta is ignored: the nested run keeps the parent's session, language, player settings and model overrides, and a plugin can no longer pass retry seeds, `sourceTurnId`, `runtimeIds`, `triggerEvent` or `detachedStage`. A wrongly typed `playerMessage` or `manualTrigger` is rejected. Handler context: `docs/plugins/local-code.md`.
- **A `PostRuntime` hook can no longer add or change writes.** `pendingProposals`, `effects` and `completion` of the replaced result always come from the runtime, and a result whose `status` a hook changed carries no writes. A `PostToolUse` hook replaces only what the model (or `ctx.tools.call`) reads; the tool's writes, events, success and approval status stay. Use `PreStateCommit` to stop a write. Rules: `docs/reference/hooks.md`.

### Fixed

- **A function runtime that a `PostRuntime` hook turns from failed into success passes `output.schema`.** The recovered `output` is checked like a normal success, and the writes the handler buffered before it failed are not committed.

### Documentation

- **The hook reference says which events `ctx.signal` does not cancel, and that `PreToolUse` also fires for `ctx.tools.call`.** `docs/internals/flow.md` lists every write outside the commit transaction.
