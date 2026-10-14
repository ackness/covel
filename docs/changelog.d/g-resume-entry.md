### Fixed

- Resuming a community plugin requests missing server-code and runtime approvals before execution, rechecks grants under the session lock, and retries after the player approves. Denial or switching sessions retains the pending suspension (F-172).
- Invalid resume schemas now refuse execution with `resume_schema_invalid` instead of bypassing validation. The suspension stays pending and can be abandoned (F-174).
