### Added

- **Safe read-only tools run in parallel.** Consecutive authorized calls declaring both `readOnly` and `concurrencySafe` share a pool of up to eight, with other tools acting as barriers. Results stay in model order and a per-tool timeout leaves siblings running.
- **Skipped tool calls appear in the trace.** Hook refusals, suspension, termination and aborted batches explain why a call did not run without counting it as executed work.

### Changed

- **Hooks have a defined order inside a parallel run.** PreToolUse hooks run in model order before the tools start; PostToolUse hooks run in model order after all members settle. A terminating member lets the pool finish and skips later steps.
- **Suspension and resume messages use the tool result envelope.** Placeholders and player answers use the success envelope; skipped calls use a cancelled error envelope. No development data needs to be recreated; saved placeholders are replaced by tool-call ID.
- **Story prompts follow the output schema.** After lookup-only work, at finalization and after loop detection, prompts ask for segments when the schema requires them.

### Fixed

- **Terminating a multi-call response leaves no unanswered calls.** A PostToolUse termination closes later calls before output repair, avoiding provider rejection of the repair request.

- **Resuming preserves the complete player answer.** Resume tool messages retain submitted identifiers and timestamps, including nested fields, so the agent receives the selected values unchanged.
