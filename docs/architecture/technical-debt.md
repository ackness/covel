# Technical Debt Ledger

Current implementation limits marked with `ponytail:` comments in source.
Each row records the accepted limit and the condition for revisiting it.
This is a current ledger, not a historical list of already fixed problems.

Find the current markers with:

```bash
rg -n "ponytail:" apps packages plugins
```

## Kernel / runtime

| Location                                                         | Accepted limit                                                                                  | Revisit when                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/runtime/src/schedule/effects.ts`                       | String equality on the `self` literal can over-match effects across plugins                     | False conflicts justify resolving `self` to the plugin ID                              |
| `packages/runtime/src/function-runtime/turn-function-runtime.ts` | Revocation checks new calls; an external effect already in flight may finish after the deadline | Primitives need cooperative cancellation or worker isolation for late external effects |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts`   | A consumer with `accepts` reloads the producer's declared output schema                         | Profiles show enough repeated work to justify a per-turn schema cache                  |
| `packages/runtime/src/retry/llm-slots.ts`                        | LLM providers share one process-wide concurrency cap                                            | Independent providers need separate capacity                                           |
| `packages/events/src/event-bus.ts`                               | Receive-ordering state has a FIFO cap; evicted streams must restart at sequence 1               | Multi-pod traffic justifies LRU/TTL state                                              |
| `packages/store/src/media-store/filter.ts`                       | Metadata filtering scans `listAssets()`                                                         | Per-session media volume justifies SQL predicate pushdown                              |
| `packages/tools/src/builtin/memory-tools.ts`                     | `working_memory.set` does not mirror into plugin data                                           | A caller needs a transaction-safe panel mirror                                         |

## Server

| Location                                        | Accepted limit                                                     | Revisit when                                      |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `apps/server/src/routes/api/plugin-rpc.ts`      | Scoped retry scans persisted turn artifacts                        | Long sessions show this scan in profiles          |
| `apps/server/src/routes/api/plugin-rpc/jobs.ts` | Boot scans session plugin data to find orphaned jobs               | Startup cost justifies an indexed namespace query |
| `apps/server/src/routes/api/turn-control.ts`    | An in-process map limits steer/abort to the pod executing the turn | Multi-pod deployments need cross-pod turn control |

## Web UI

| Location                                                               | Accepted limit                                                            | Revisit when                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/src/components/session/stage/StageSprites.tsx`               | At most four sprites animate layout properties such as `left` and `width` | More frequent or larger casts justify transform-based animation    |
| `apps/web/src/components/session/stage/stage-selectors.ts`             | Choice icon/color fields have no current consumer                         | A component uses those fields                                      |
| `apps/web/src/components/session/chat-messages/message-primitives.tsx` | Markdown soft breaks use a string rewrite                                 | Fenced-code edge cases or other transforms justify a parser plugin |
| `apps/web/src/theme-system/token-schema.ts`                            | Ambience accepts URLs and gradients without local-image upload            | Upload requirements justify storage outside the settings blob      |

## Plugins

| Location                            | Accepted limit                                                     | Revisit when                                             |
| ----------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `plugins/cost-gate/hooks/budget.js` | A cumulative token cap eventually blocks a long legitimate session | Playthroughs justify a per-turn or sliding-window budget |

## Oversized modules

Non-test files past the 800-line review guideline (AGENTS.md). Split only when
responsibilities or maintenance cost justify the change — length alone is not
a defect. Re-measure with `wc -l` before acting; line counts drift.

| File                                                      | Lines |
| --------------------------------------------------------- | ----: |
| `apps/server/src/routes/api/actions.ts`                   |  1078 |
| `packages/shared/src/schemas/plugin-schemas.ts`           |  1034 |
| `packages/shared/src/types/plugin.ts`                     |  1029 |
| `packages/runtime/src/turn-executor/turn-executor.ts`     |   972 |
| `apps/server/src/routes/api/bootstrap.ts`                 |   880 |
| `apps/web/src/services/data-service/local.ts`             |   878 |
| `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts` |   820 |

The current source has 14 markers. This ledger follows current source comments;
historical counts and line numbers are not current contracts.
