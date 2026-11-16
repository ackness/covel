### Fixed

- **Manual runtime attempts leave automatic plugin fault protection unchanged.** Synchronous runs, queued manual runs and manual suspension resumes neither add faults nor clear earlier ones; proposal validation and atomic commits still apply. See [the fault ledger](../en/reference/protocol.md#plugin-fault-latch).
- **Failed panel operations show one error notice.** Runtime, action, command and event requests no longer add a generic HTTP toast alongside the caller's error.
- **The debugger's header counts committed player turns.** It reads the session clock instead of counting trace groups, so manual runs, setup, openings and failed attempts do not inflate the count.
