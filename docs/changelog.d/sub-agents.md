### Breaking

- **`delegate` is a reserved tool name.** A plugin tool registered as `delegate` is now rejected at registration; rename it. Reference: `docs/reference/tools.md`.

### Added

- **Sub-agents.** A function runtime runs another agent runtime with `ctx.agents.run({ target, brief, data?, budget? })`, and an agent runtime does the same with the new builtin tool `delegate` (declare it in `agent.tools.builtin`). A sub-agent sees only the brief, keeps read-only tools only, runs the `actor` loop profile unless it names one, uses its own model role, and returns output only: no writes, no events, no commit unit. One execution runs at most 8 at a time and a sub-agent cannot start another; a call over a cap returns `unavailable` at once. Failures resolve as `{ ok: false, error: { code } }` instead of throwing. Reference: `docs/reference/plugins.md` (Sub-agents) and `docs/reference/tools.md`.
- **`schedule.subagentOnly` providers.** An agent runtime with `schedule.subagentOnly: true` runs only as a sub-agent: the scheduler never selects it, the manual runtime RPC answers `409 runtime_subagent_only`, and `ctx.recursiveCall` refuses it. It implies `trigger: manual` and allows no `stage`, `needs`, `after`, `background`, `io.output.recordAs`, `guard` or `io.visibility: story`. Plugin details and the execution flow mark it with `subagentOnly: true`; community providers are approved before any execution that can call them: a session action, a retry, a manual runtime run and a resume.
- **Sub-agent traces.** `subagent.started` / `completed` / `failed` (trace only) record each run, and every event of a sub-agent carries `subagentCallId`, `parentCallId` and `parentRuntimeId`, so the debug trace shows the call tree. Reference: `docs/reference/protocol.md`.

### Fixed

- **A resumed runtime uses the session's model overrides.** A runtime resumed after suspension, and any sub-agent it calls, now picks its model through the session's `runtimeModelOverrides` like a turn does, instead of falling back to the declared model role. Reference: `docs/reference/api.md` (resume).
