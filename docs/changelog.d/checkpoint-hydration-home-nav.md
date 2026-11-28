### Fixed

- **Browser-private sessions with prior background jobs hydrate cleanly after server restarts or cache eviction.** `exportSessionCheckpoint` no longer puts server-local `_runtime_job_control` sequence counters on the wire, and `LocalDataService` strips stale `_runtime_jobs` and `_runtime_job_control` rows when hydrating onto a fresh server session or after a `400 invalid_checkpoint` rejection on an evicted head.
- **Failed save restoration no longer traps players on an infinite loading spinner.** The session screen now shows an actionable restore-error card with Back to worlds and Retry actions, and clicking the Covel logo or World nav item always clears stuck recovery or prep state and returns to the world list.
