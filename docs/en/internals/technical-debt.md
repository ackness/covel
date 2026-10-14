# Known limits

This page lists the limits that are kept on purpose in the source code. Each one is marked in the code with a `ponytail:` comment. Each row here states which limit was accepted, and when it should be revisited. Read this page if you want to know "why is this written so simply here", or if you are about to change one of these places.

This is a list of what exists now, not a history of fixed problems. Use this command to find all the current markers:

```bash
rg -n "ponytail:" apps packages plugins
```

The source currently has 12 markers, and each row in the three tables below matches one of them.

> [!IMPORTANT]
> When you add or remove a `ponytail:` comment, update this page in the same change.

## Kernel / runtime

| Location                                                         | Accepted limit                                                                                                                               | When to reconsider                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/runtime/src/schedule/effects.ts`                       | Compares the `self` literal as a string. Effects from different plugins may be taken as the same                                             | False conflicts become frequent enough to justify resolving `self` to a plugin ID                            |
| `packages/runtime/src/function-runtime/plugin-runtime-context.ts` | Cancellation is checked only when a new call starts. An external effect already sent may finish after the deadline                           | The primitives need cooperative cancellation, or a worker is needed to isolate late external effects         |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts`   | A consumer with `accepts` reloads the output schema declared by the producer every time                                                      | Performance analysis shows enough repeated work to justify a per-turn schema cache                           |
| `packages/shared/src/llm-slots.ts`                               | All LLM providers share one process-wide concurrency limit                                                                                   | Providers that are independent of each other need their own capacity                                         |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts`  | Before resume data enters the tool loop, its MediaRefs are not checked. The content to be saved is normalized only at commit time            | A resumed runtime operates on a media reference before any proposal carries it                               |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts`  | Acceptance scenarios 12 and 19-25 (the plan/confirm enablement flow, and persisted approval authorization) are `it.todo`                     | An enablement resolver or persisted approval authorization is scheduled into the implementation plan         |
| `packages/events/src/event-bus.ts`                               | The state for receive order is evicted least recently used first. An evicted stream must restart from sequence 1, so its session resets once | Multi-pod deployments keep more live streams than the cap, enough to justify a per-state TTL or a larger cap |

## Server

| Location                                     | Accepted limit                                                                               | When to reconsider                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/server/src/routes/api/turn-control.ts` | Records in an in-process map. Steer and abort work only on the pod that is running that turn | A multi-pod deployment needs turn control across pods |

## Web UI

| Location                                                               | Accepted limit                                                                            | When to reconsider                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/session/stage/StageSprites.tsx`               | Up to four portraits animate layout properties such as `left` and `width`                 | More characters appear, or they appear more often, so it is worth switching to transform-based animation |
| `apps/web/src/components/session/chat-messages/message-primitives.tsx` | Markdown soft line breaks are handled by rewriting strings                                | Edge cases of code blocks or other conversions become frequent enough to justify a parser plugin         |
| `apps/web/src/theme-system/token-schema.ts`                            | The atmosphere background accepts only URLs and gradients. It cannot upload a local image | Upload needs become frequent enough to justify storing images outside the settings data                  |

## Oversized modules

Below are the non-test source files over 800 lines. 800 lines is a review reference line in [AGENTS.md](../../../AGENTS.md). It is not a hard limit.

- Split a file only when its responsibilities or its maintenance cost really require it. Length by itself is not a defect.
- Line counts change. Measure again with `wc -l` before you start.
- The table counts only TypeScript source files under `apps/` and `packages/`. It excludes tests, and it also excludes the test suite shared by the storage backends in `packages/store/src/contract/`.

| File                                                          | Lines |
| ------------------------------------------------------------- | ----: |
| `packages/shared/src/schemas/plugin-schemas.ts`               |  1258 |
| `packages/ai-provider/src/gateway.ts`                         |  1225 |
| `apps/server/src/routes/api/actions.ts`                       |  1165 |
| `packages/runtime/src/turn-executor/turn-executor.ts`         |  1065 |
| `apps/server/src/world-data/session-import.ts`                |  1005 |
| `packages/settings/src/store.ts`                              |   996 |
| `apps/server/src/routes/api/plugin-rpc/runtime-job-worker.ts` |   996 |
| `apps/server/src/world-data/validate-world-package.ts`        |   988 |
| `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts`     |   979 |
| `packages/store/src/types.ts`                                 |   976 |
| `apps/web/src/stores/session-store/actions.ts`                |   958 |
| `apps/web/src/services/data-service/local.ts`                 |   954 |
| `packages/plugin-handlers-utils/src/plugin-api.ts`            |   950 |
| `apps/server/src/routes/api/bootstrap.ts`                     |   944 |
| `packages/events/src/event-bus.ts`                            |   918 |
| `apps/server/src/routes/api/bootstrap/plugin-entry.ts`        |   889 |
| `packages/runtime/src/retry/llm-retry.ts`                     |   875 |
| `packages/runtime/src/interaction/interaction-submission.ts`  |   845 |
| `packages/plugin-handlers-utils/src/dimension-schemas.ts`     |   845 |
| `packages/runtime/src/commit/finalize-execution.ts`           |   838 |
| `apps/web/src/stores/session-store/reducer.ts`                |   837 |
| `apps/web/src/stores/session-store/sse-handler.ts`            |   827 |
| `packages/create/src/create-world.ts`                         |   823 |
| `packages/runtime/src/schedule/input-bindings.ts`             |   821 |
| `apps/server/src/routes/api/ai.ts`                            |   817 |
| `apps/server/src/routes/api/plugin-rpc/jobs.ts`               |   815 |
| `apps/server/src/routes/api/plugin-rpc/runtime-turn.ts`       |   803 |

This list follows the comments in the current source. Historical counts and line numbers are not the current contract.
