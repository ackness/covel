### Breaking

- **`PreRuntime` no longer runs when a suspended runtime resumes.** It runs once per logical runtime, at its original dispatch. To stop an agent from suspending, use `PreToolUse` on the `suspend` tool. See [Hooks](../en/reference/hooks.md).
- **`PostRuntime` no longer runs when a runtime suspends.** It runs once per logical runtime, when the resumed runtime really finishes, and its payload then carries `resumed: true`. A hook that looked for `status: "suspended"` in `PostRuntime` no longer sees it; the `runtime.completed` event still reports each suspension. See [Hooks](../en/reference/hooks.md).

### Added

- **A resumed runtime can suspend again.** An agent can call `suspend` again and a function handler can return a suspension again. The resume answers `200` with `result.status: "suspended"` and the new `suspensionId` in `result.output`; the old suspension is resolved and the new one saved in one transaction; `turn.suspended` is sent for the new one and `turn.resumed` is not. The new suspension continues the same execution and logical turn, and the turn counts once, when the chain ends. See [Suspending again](../en/reference/api.md#suspending-again).
- **A suspended agent resumes with its whole loop state.** The suspension now keeps the corrections already spent, the deferred tools activated with `search-tools`, the prose written from merged player interjections, the output of a completing tool that already succeeded, and the turn's prompt segments, so `PreLLMCall` on a resumed run receives the same `promptSegments`. See [Tools](../en/reference/tools.md).
- **`runtime.started` marks resumed runs.** A run resumed from a suspension sends `runtime.started` with `resumed: true`. See [Protocol](../en/reference/protocol.md).

### Changed

- **A resumed runtime gets the same time limit as its original dispatch.** The manifest's `timeoutMs` now takes precedence over the framework default on resume as well. See [Resume](../en/reference/api.md#post-apisessionsidsuspensionssuspensionidresume).
- **Saved recursive work follows its suspended parent's outcome.** Progress and lifecycle corrections retain the original child run IDs and affect only owned invocation tasks, including several parents or independent top-level calls sharing a runtime. Children wait after suspension, succeed with the final atomic resume, fail after an admitted failed attempt, and cancel on abandon, expiry or invalidation. Retrying can correct framework-owned failures without reviving plugin-authored failures or cancellations. Corrections survive reload and reach both action and subscription streams once. Resume events carry kernel-owned chain identity, so an independent resume cannot hide a saved child still waiting. Deleting a resolved suspension only removes history and leaves committed work and live successors unchanged. Rejected nested runs are also corrected when a same-runtime top-level run commits. See [lifecycle events](../en/reference/protocol.md#execution-lifecycle-events) and [job progress](../en/reference/protocol.md#job-progress-events-job-status-experimental).

### Upgrade notes

- **Recreate development suspensions and snapshots or browser checkpoints containing them, plus resume history missing its source run ID.** Continuations now require their suspended run and task-owner identity; progress records preserve kernel-owned invocation and settlement provenance. Resume lifecycle traces and local execution history now preserve `resumeSourceRunId`; recreate affected development sessions and their cached history. Existing records are not migrated. See [resume behavior](../en/reference/api.md#post-apisessionsidsuspensionssuspensionidresume).
