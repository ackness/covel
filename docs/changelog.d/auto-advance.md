### Added

- **Committed stories can advance automatically within a session limit.** Chat and stage views show progress, Stop and a limit control. Further drafts remain in the composer with a busy notice while an interruption and checkpoint are pending. Snapshots, forks and browser saves preserve the setting. See [session advancement settings](./reference/api.md#auto-advance).

### Changed

- **Automatic rounds share their input's logical turn and fault-counting identity while committing independently.** Rejected duplicate inputs and invalid or duplicate interaction answers leave advancement running. The protocol distinguishes round completion from request completion, and retries and resumes do not restart advancement. See [advancement events](./reference/protocol.md#auto-advance-events).
