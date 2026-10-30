### Breaking

- **`PreRuntime` no longer runs when a suspended runtime resumes.** It runs once per logical runtime, at its original dispatch. To stop an agent from suspending, use `PreToolUse` on the `suspend` tool. See `docs/reference/hooks.md`.
- **`PostRuntime` no longer runs when a runtime suspends.** It runs once per logical runtime, when the resumed runtime really finishes, and its payload then carries `resumed: true`. A hook that looked for `status: "suspended"` in `PostRuntime` no longer sees it; the `runtime.completed` event still reports each suspension. No development data needs to be recreated. See `docs/reference/hooks.md`.

### Added

- **A resumed runtime can suspend again.** An agent can call `suspend` again and a function handler can return a suspension again. The resume answers `200` with `result.status: "suspended"` and the new `suspensionId` in `result.output`; the old suspension is resolved and the new one saved in one transaction; `turn.suspended` is sent for the new one and `turn.resumed` is not. The new suspension continues the same execution and logical turn, and the turn counts once, when the chain ends. See `docs/reference/api.md` (Suspending again).
- **A suspended agent resumes with its whole loop state.** The suspension now keeps the corrections already spent, the deferred tools activated with `search-tools`, the prose written from merged player interjections, the output of a completing tool that already succeeded, and the turn's prompt segments, so `PreLLMCall` on a resumed run receives the same `promptSegments`. See `docs/reference/tools.md` (`suspend`).
- **`runtime.started` marks resumed runs.** A run resumed from a suspension sends `runtime.started` with `resumed: true`. See `docs/reference/protocol.md`.

### Changed

- **A resumed runtime gets the same time limit as its original dispatch.** The manifest's `timeoutMs` now takes precedence over the framework default on resume as well. See `docs/reference/api.md` (resume).
- **A resumed run reports progress under the suspended execution.** `ctx.progress` jobs of every leg of a suspension chain end together: `succeeded` when the last resume commits, `cancelled` when the suspension is abandoned, expires or is voided. A leg that suspends again leaves them `waiting-input`, and a resume whose commit rolls back returns them to `waiting-input`, including a `succeeded` it reported, since the suspension can be retried. See `docs/reference/protocol.md`.

### Fixed

- **A suspended parent's `ctx.recursiveCall` writes now commit with its resume.** The nested results are saved with the suspension and commit ahead of the parent when the resumed handler succeeds, with the same conversation rows and trigger counts as a parent that never suspended. They are dropped wherever the parent's own writes are, and a resume whose nested write target changed after the suspension is voided as `data-changed`. A nested call that itself suspended is not saved and is traced as `nested-suspension-dropped`. A restored nested call that declares `output.recordAs` publishes its export with that commit. See `docs/reference/plugins.md` (Nested calls).
