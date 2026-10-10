# Technical Debt Ledger

Current implementation limits marked with `ponytail:` comments in source.
Each row records the accepted limit and the condition for revisiting it.
This is a current ledger, not a historical list of already fixed problems.

Find the current markers with:

```bash
rg -n "ponytail:" apps packages plugins
```

## Kernel / runtime

| Location                                                         | Accepted limit                                                                                       | Revisit when                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/runtime/src/schedule/effects.ts`                       | String equality on the `self` literal can over-match effects across plugins                          | False conflicts justify resolving `self` to the plugin ID                              |
| `packages/runtime/src/function-runtime/turn-function-runtime.ts` | Revocation checks new calls; an external effect already in flight may finish after the deadline      | Primitives need cooperative cancellation or worker isolation for late external effects |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts`   | A consumer with `accepts` reloads the producer's declared output schema                              | Profiles show enough repeated work to justify a per-turn schema cache                  |
| `packages/runtime/src/retry/llm-slots.ts`                        | LLM providers share one process-wide concurrency cap                                                 | Independent providers need separate capacity                                           |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts`  | Resume data is not checked for MediaRefs before the tool loop; commit canonicalizes what persists    | A resumed runtime acts on a media reference before any proposal carries it             |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts`  | Acceptance scenarios 12 and 19-25 (plan/confirm enablement, persisted approval grants) are `it.todo` | The enablement resolver or durable approval grants are scheduled for implementation    |
| `packages/events/src/event-bus.ts`                               | Receive-ordering state has a FIFO cap; evicted streams must restart at sequence 1                    | Multi-pod traffic justifies LRU/TTL state                                              |
| `packages/store/src/media-store/filter.ts`                       | Metadata filtering scans `listAssets()`                                                              | Per-session media volume justifies SQL predicate pushdown                              |

## Server

| Location                                     | Accepted limit                                                     | Revisit when                                      |
| -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `apps/server/src/routes/api/turn-control.ts` | An in-process map limits steer/abort to the pod executing the turn | Multi-pod deployments need cross-pod turn control |

## Web UI

| Location                                                               | Accepted limit                                                            | Revisit when                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/src/components/session/stage/StageSprites.tsx`               | At most four sprites animate layout properties such as `left` and `width` | More frequent or larger casts justify transform-based animation    |
| `apps/web/src/components/session/stage/stage-selectors.ts`             | Choice icon/color fields have no current consumer                         | A component uses those fields                                      |
| `apps/web/src/components/session/chat-messages/message-primitives.tsx` | Markdown soft breaks use a string rewrite                                 | Fenced-code edge cases or other transforms justify a parser plugin |
| `apps/web/src/theme-system/token-schema.ts`                            | Ambience accepts URLs and gradients without local-image upload            | Upload requirements justify storage outside the settings blob      |

## Oversized modules

Non-test files past the 800-line review guideline (AGENTS.md). Split only when
responsibilities or maintenance cost justify the change — length alone is not
a defect. Re-measure with `wc -l` before acting; line counts drift.

| File                                                          | Lines |
| ------------------------------------------------------------- | ----: |
| `apps/server/src/routes/api/actions.ts`                       |  1055 |
| `packages/runtime/src/turn-executor/turn-executor.ts`         |  1023 |
| `packages/ai-provider/src/gateway.ts`                         |  1020 |
| `packages/shared/src/schemas/plugin-schemas.ts`               |   992 |
| `apps/web/src/stores/session-store/actions.ts`                |   932 |
| `apps/web/src/services/data-service/local.ts`                 |   895 |
| `apps/server/src/routes/api/bootstrap.ts`                     |   891 |
| `apps/server/src/world-data/session-import.ts`                |   876 |
| `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts`     |   873 |
| `packages/store/src/types.ts`                                 |   859 |
| `apps/web/src/stores/session-store/sse-handler.ts`            |   847 |
| `apps/server/src/routes/api/plugin-rpc/runtime-job-worker.ts` |   842 |
| `packages/plugin-loader/src/load.ts`                          |   839 |
| `apps/server/src/routes/api/bootstrap/plugin-entry.ts`        |   826 |
| `packages/events/src/event-bus.ts`                            |   801 |

The current source has 12 markers, one per row above. This ledger follows
current source comments; historical counts and line numbers are not current
contracts.
