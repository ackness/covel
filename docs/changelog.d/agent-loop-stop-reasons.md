### Added

- **A `PreStep` hook shapes each step of an agent's tool loop.** It fires before every model call of the loop, after the player's interjections and before `PreLLMCall`, and can narrow that step's tools, change its tool choice, lower the steps left, or end the loop as `tool-finished` or `cancelled`. There are now 17 hook events. Rules: `docs/reference/hooks.md`.
- **Agent steps are traced.** Each step of the tool loop sends `step.started` and `step.completed` to the trace and the actions stream, with the step number, usage, finish reason, a tool-call summary, retries and notes on corrections, perturbations and activated tools. A concealed runtime keeps only the content-free fields. Payloads: `docs/reference/protocol.md`.
- **Every agent run records how its loop ended.** `RuntimeResult.stop` and the `stopReason` of `runtime.completed` / `runtime.failed` carry one of ten stop reasons (`completed`, `tool-finished`, `max-steps`, `deadline`, `context-overflow`, `cancelled`, `model-error`, `invalid-output`, `loop-detected`, `suspended`). Table: `docs/reference/protocol.md`.

### Changed

- **An agent runtime that reaches its step limit no longer succeeds because the model wrote text beside a tool call.** That text is a draft. The runtime now fails with `max-steps`, unless one final request with tools off (the finalizer step) writes the answer; it is sent when prose can satisfy the runtime's completion conditions and at least 3 seconds remain. A runtime that used to "succeed" this way at its limit now fails, and its staged writes are not committed. A timeout is always a failure. Rules: `docs/reference/protocol.md`, `docs/internals/flow.md`.
