### Changed

- **A plugin action has 30 seconds.** An action handler runs inside the session lock; one that does not finish in 30 seconds now fails with `504 handler_timeout` and releases the session, instead of holding every request for the session (deleting it included) until the server restarts. The handler gets `ctx.signal`, which aborts at the limit, and its `ctx.store` refuses every call after the action ends. Writes made before the limit are kept. Details: `docs/reference/api.md`.

### Fixed

- **Refreshing during a turn shows the plugin panel and commands at once.** `GET /api/sessions/:id/plugins` reads the saved session record without waiting for the running turn or for background jobs.
- **A background job no model can run no longer slows every action.** When a `settle: before-next-execution` job has no usable model credentials, the next action stops waiting up to two minutes for it; the trace records `execution.settle-skipped` with the jobs it skipped.
- **Session locks are safer.** Background work started while a session lock is held no longer counts as its owner, and taking several lock keys at once sorts them inside the lock, so two overlapping requests cannot deadlock.
