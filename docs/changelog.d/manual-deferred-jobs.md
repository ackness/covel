### Fixed

- **A plugin RPC that runs a detached runtime by name now queues it.** A runtime that declares `schedule.detached` is deferred to the durable job queue instead of running inline. The sync manual RPC and background manual jobs dropped that job, so the request answered `ok` while the runtime never ran. Both now queue it in the same commit transaction as the player's turn does and list it in `deferredJobs`. Rules: [turn flow](../en/internals/flow.md#23-background-pipeline-for-staged-runtimes).
