### Breaking

- **A background runtime that lists the `suspend` tool no longer loads.** A runtime with `schedule.manual.execution: background` or `schedule.completion.mode: detached` that lists `suspend` in `agent.tools.builtin` is rejected at load, because no player waits on background work. Remove `suspend` from such a runtime, or run it in the foreground. Rule: `docs/reference/tools.md` (suspend).

### Changed

- **A normal shutdown puts unfinished background jobs back in the queue.** A job that had not started its commit used to end as `cancelled` (`worker-shutdown`) and needed a retry by hand. It now goes back to `queued` with the same job ID once its run has stopped, and runs again after the restart; a job already committing finishes its commit. What the stopped run did outside (a provider call) is done again, so a background job must be safe to rerun. A crash still ends in `orphaned`. Details: `docs/reference/protocol.md`.

### Fixed

- **A background job whose runtime suspends now fails instead of showing as succeeded.** When a background manual run, or an event runtime it triggered, suspended, the job was marked `succeeded` (or failed with a misleading reason) while the runtime waited for the player. The job is now recorded as `failed` and commits nothing.
- **A background job no longer commits the results of a plugin version that was reloaded while it ran.** In development a plugin reload could swap the plugin between the start of a job and its commit; the commit now checks the version again and the job ends as `stale`.
