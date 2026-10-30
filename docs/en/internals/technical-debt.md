# Known limits

This page lists the limits that are kept on purpose in the source code. Each one is marked in the code with a `ponytail:` comment. Each row here states which limit was accepted, and when it should be revisited. Read this page if you want to know "why is this written so simply here", or if you are about to change one of these places.

This is a list of what exists now, not a history of fixed problems. Use this command to find all the current markers:

```bash
rg -n "ponytail:" apps packages plugins
```

> [!IMPORTANT]
> When you add or remove a `ponytail:` comment, update this page in the same change.
> `pnpm check:scripts` and `pnpm test:docs` check that each marker has one row in each language, and that entries without a marker have been removed.

## Kernel / runtime

<!-- prettier-ignore -->
| Location | Accepted limit | When to reconsider |
| --- | --- | --- |
| `packages/runtime/src/schedule/effects.ts` | Compares the `self` literal as a string. Effects from different plugins may be taken as the same | False conflicts become frequent enough to justify resolving `self` to a plugin ID |
| `packages/runtime/src/function-runtime/plugin-runtime-context.ts` | Cancellation is checked only when a new call starts. An external effect already sent may finish after the deadline | The primitives need cooperative cancellation, or a worker is needed to isolate late external effects |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts` | A consumer with `accepts` reloads the output schema declared by the producer every time | Performance analysis shows enough repeated work to justify a per-turn schema cache |
| `packages/shared/src/llm-slots.ts` | All LLM providers share one process-wide concurrency limit | Providers that are independent of each other need their own capacity |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts` | Before resume data enters the tool loop, its MediaRefs are not checked. The content to be saved is normalized only at commit time | A resumed runtime operates on a media reference before any proposal carries it |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts` | Scenario 12's plugin version check is implemented. Resume requests have an approval preflight, and new output has schema validation. The saved continuation is not rechecked against current spec and approval versions, nor are its buffered writes rechecked against current effects declarations. Scenarios 19-25 (the plan/confirm enablement flow and persisted approval authorization) remain `it.todo` | An enablement resolver or persisted approval authorization is scheduled into the implementation plan |
| `packages/events/src/event-bus.ts` | The state for receive order is evicted least recently used first. An evicted stream must restart from sequence 1, so its session resets once. If the publish queue drops a session's last frames at the cap and no later frame arrives, the receiver cannot detect the loss and does not reset. The read-only `headCursor` also creates session tracking state and shares the session cap with subscriptions | Multi-pod deployments keep more live streams than the cap, enough to justify a per-state TTL or a larger cap |
| `packages/create/src/world-writer.ts` | World directories are replaced by renaming, with restoration on failure but no crash journal. A crash between renames can leave a `.covel-replaced-*/package` backup that needs manual restoration | Someone reports a missing world after a crash, or a leftover backup directory |
| `packages/memory/src/archival-search.ts` | Every keyword search loads the session's entire searchable archive before ranking it | Enough archive entries accumulate to make keyword search noticeably slow |

## Storage

<!-- prettier-ignore -->
| Location | Accepted limit | When to reconsider |
| --- | --- | --- |
| `packages/store/src/media-store/pg.ts` | Metadata queries load all assets owned by the session, then compare in JS. Neither PostgreSQL nor SQLite (`packages/store/src/media-store/sqlite.ts`) pushes this filter into SQL, keeping their results identical | A single session holds thousands of media assets |
| `packages/store/src/common/write-order-ddl.ts` | PostgreSQL locks the session counter row until commit whenever it allocates a write sequence. Session deletion fires record-change triggers for each row. `record_changes` keeps the latest change sequence for every record key for the session's lifetime, including deleted keys | A write path bypasses the session lock, deleting a large session becomes noticeably slow, or the size of `record_changes` becomes a problem |
| `packages/store/src/sqlite/schema.ts` | `turn_messages` has six secondary indexes in each SQL backend, with unmeasured write cost. PostgreSQL (`packages/store/src/postgres/schema.ts`) indexes use the database collation, but queries sort by `id COLLATE "C"`. Rows tied on the first three index columns may still need an incremental sort; the actual plan needs `EXPLAIN` verification. The single-column `session_id` index is kept even though it is a prefix of the composite indexes | Writes in long sessions slow down, or PostgreSQL `EXPLAIN` shows a sorting cost |

## Server

<!-- prettier-ignore -->
| Location | Accepted limit | When to reconsider |
| --- | --- | --- |
| `apps/server/src/routes/api/turn-control.ts` | Records in an in-process map. Steer and abort work only on the pod that is running that turn | A multi-pod deployment needs turn control across pods |
| `apps/server/src/lib/pg-event-transport.ts` | NOTIFY has no timeout or query cancellation path. A half-open connection stalls the send in postgres.js, and later frames wait in the event bus's bounded queue; a full queue drops frames and logs a warning. Timing out only the wait would move the backlog into the client's queue | postgres.js can actually cancel the query, or a half-open connection occurs in production |
| `apps/server/src/routes/api/session/delete-route.ts` | When session deletion succeeds but releasing its media claims fails, the claims keep protecting the files and the failure is only logged. No route retries the release for a deleted session | Release failures become frequent in the logs, or the retained files fill the disk |

## Web UI

| Location                                                               | Accepted limit                                                                            | When to reconsider                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/session/stage/StageSprites.tsx`               | Up to four portraits animate layout properties such as `left` and `width`                 | More characters appear, or they appear more often, so it is worth switching to transform-based animation |
| `apps/web/src/components/session/chat-messages/message-primitives.tsx` | Markdown soft line breaks are handled by rewriting strings                                | Edge cases of code blocks or other conversions become frequent enough to justify a parser plugin         |
| `apps/web/src/theme-system/token-schema.ts`                            | The atmosphere background accepts only URLs and gradients. It cannot upload a local image | Upload needs become frequent enough to justify storing images outside the settings data                  |

## Oversized modules

Below are the non-test source files over 800 lines. 800 lines is only the threshold for this inventory. [AGENTS.md](../../../AGENTS.md) asks for splits by responsibility and maintenance cost, without a line limit.

- Split a file only when its responsibilities or its maintenance cost really require it. Length by itself is not a defect.
- Line counts change. Measure again with `wc -l` before you start.
- The table counts only TypeScript source files under `apps/` and `packages/`. It excludes tests, and it also excludes the test suite shared by the storage backends in `packages/store/src/contract/`.

<!-- prettier-ignore -->
| File | Lines |
| --- | ---: |
| `apps/server/src/routes/api/actions.ts` | 1594 |
| `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts` | 1496 |
| `apps/server/src/world-data/validate-world-package.ts` | 1359 |
| `packages/runtime/src/commit/finalize-execution.ts` | 1295 |
| `packages/ai-provider/src/gateway.ts` | 1266 |
| `packages/shared/src/schemas/plugin-schemas.ts` | 1246 |
| `packages/runtime/src/turn-executor/turn-executor.ts` | 1082 |
| `apps/server/src/routes/api/bootstrap.ts` | 1028 |
| `packages/store/src/types.ts` | 1026 |
| `apps/server/src/routes/api/plugin-rpc/runtime-job-worker.ts` | 1025 |
| `apps/server/src/world-data/session-import.ts` | 1009 |
| `packages/settings/src/store.ts` | 996 |
| `apps/web/src/stores/session-store/actions.ts` | 992 |
| `packages/events/src/event-bus.ts` | 982 |
| `packages/plugin-handlers-utils/src/plugin-api.ts` | 980 |
| `apps/server/src/world-data/session-import/planning.ts` | 926 |
| `apps/web/src/stores/session-store/reducer.ts` | 915 |
| `packages/runtime/src/retry/llm-retry.ts` | 903 |
| `packages/plugin-loader/src/load.ts` | 898 |
| `packages/shared/src/types/protocol.ts` | 872 |
| `apps/server/src/routes/api/plugin-rpc/jobs.ts` | 867 |
| `packages/runtime/src/interaction/interaction-submission.ts` | 863 |
| `apps/server/src/routes/api/plugin-rpc/runtime-turn.ts` | 861 |
| `packages/plugin-handlers-utils/src/dimension-schemas.ts` | 852 |
| `packages/create/src/create-world.ts` | 849 |
| `apps/server/src/routes/api/ai.ts` | 841 |
| `apps/server/src/routes/api/bootstrap/plugin-entry.ts` | 838 |
| `apps/desktop/src/main.ts` | 820 |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts` | 816 |

This list follows the comments in the current source. Historical counts and line numbers are not the current contract.
