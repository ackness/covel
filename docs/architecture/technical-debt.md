# Technical Debt Ledger

Deliberate simplifications carried in the codebase, each marked with a
`ponytail:` comment at the cited line. Every entry names a **ceiling** (the
limit the shortcut accepts) and an **upgrade trigger** (the observation that
should make someone revisit it). None of the triggers below has fired.

A `ponytail:` comment belongs here when it records an accepted ceiling and a
concrete condition for revisiting the implementation. Plain rationale stays as
a regular code comment.

Regenerate with:

```bash
rtk rg -n "ponytail:" apps packages plugins
```

---

## Kernel / runtime

| Location                                                              | Ceiling                                                                                                                        | Upgrade trigger                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/schedule/effects.ts:63`                         | String equality on the `self` literal over-matches across plugins                                                              | Resolve `self` to a plugin ID if false positives get noisy                                               |
| `packages/runtime/src/function-runtime/turn-function-runtime.ts:352`  | Revocation is checked at call entry, so an effect already in flight when the deadline fires still lands                        | Thread the deadline signal into every primitive, or isolate execution in a worker, if late writes appear |
| `packages/runtime/src/function-runtime/turn-function-runtime.ts:579`  | The non-success demote check reads `writeBuffer` only, excluding inline output control keys                                    | Scan control keys when a producer emits them on a non-success return                                     |
| `packages/runtime/src/function-runtime/plugin-handler-helpers.ts:165` | Trusted-store `deletePluginData` writes through directly                                                                       | Add a delete proposal when a buffered caller needs rollback-safe clears                                  |
| `packages/runtime/src/function-runtime/plugin-handler-helpers.ts:252` | A `null` plugin-data value deletes directly even when a write buffer exists                                                    | Add a delete proposal when a buffered caller needs rollback-safe clears                                  |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts:537`    | The executor reloads a producer runtime to read its declared `output.schema`                                                   | Add a per-turn schema cache if this work becomes visible in profiles                                     |
| `packages/runtime/src/retry/llm-slots.ts:14`                          | One process-wide semaphore caps all LLM providers                                                                              | Split it into per-provider buckets when parallel multi-provider sessions need independent capacity       |
| `packages/events/src/event-bus.ts:138`                                | FIFO cap on receive-ordering state; a later frame for an evicted stream is treated as a fresh stream and must restart at seq 1 | Move to LRU plus per-entry TTL when multi-pod fleets grow                                                |
| `packages/context/src/compactor.ts:282`                               | Each compaction round adds one more summary block; prior summaries are never rolled together                                   | Merge prior summaries once block accumulation measurably matters                                         |
| `packages/store/src/media-store/filter.ts:16`                         | Metadata filtering full-scans `listAssets()`                                                                                   | Push the predicate into SQL when per-session media volume outgrows tens of records                       |
| `packages/tools/src/builtin/memory-tools.ts:226`                      | `working_memory.set` no longer mirrors writes into plugin data for the memory panel                                            | Add mirror support to the proposal and handler when a production caller needs the panel mirror           |

## Server

| Location                                                      | Ceiling                                                                                                | Upgrade trigger                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `apps/server/src/app.ts:245`                                  | Narrative budget resolution ignores per-session `runtime_model_overrides` and `X-Slot-Config` overlays | Wire the session's actual narrative slot when the budget needs to track it                       |
| `apps/server/src/routes/api/actions.ts:551`                   | Scoped retry searches every persisted turn result                                                      | Add a keyed store getter when long sessions make the scan visible in traces                      |
| `apps/server/src/routes/api/plugin-rpc.ts:257`                | RPC retry searches every persisted turn result                                                         | Add a keyed store getter when long sessions make the scan visible in traces                      |
| `apps/server/src/routes/api/plugin-rpc/background-jobs.ts:56` | Four background jobs share one process-wide cap                                                        | Partition the cap when one session's burst starts starving others                                |
| `apps/server/src/routes/api/plugin-rpc/jobs.ts:162`           | Boot scans all session plugin data to find orphaned jobs                                               | Add an indexed namespace query when plugin-data volume noticeably slows boot                     |
| `apps/server/src/routes/api/turn-control.ts:7`                | An in-process map limits steer and abort to turns running on the same pod                              | Move control state to a shared bus when multi-pod deployments need cross-pod turn control        |
| `apps/server/src/routes/api/bootstrap.ts:383`                 | A community wire-only plugin may never load its wire when its own runtime stays idle                   | Call `ensurePluginWires` from activation when the first wire-only community plugin is introduced |

## Plugin loading

| Location                                 | Ceiling                                                                                                                                                                                         | Upgrade trigger                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/plugin-loader/src/trust.ts:85` | `detectSource()` returns `community` unconditionally — the `official` trust tier is currently unreachable, and the `=== "official"` branches in `plugin-rpc.ts` / `session/plugins.ts` are dead | Reintroduce the whitelist when the first official plugin ships, and cover those branches then |

## Web UI

| Location                                                                  | Ceiling                                                                      | Upgrade trigger                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web/src/components/session/right-panel.tsx:154`                     | The media surface is found by matching a panel's declared `icon === "image"` | Promote it to a first-class capability flag on panel specs if this grows                        |
| `apps/web/src/components/session/stage/StageSprites.tsx:74`               | Transitions use layout properties `left` and `width`                         | Revisit when more than four sprites move frequently                                             |
| `apps/web/src/components/session/stage/stage-selectors.ts:155`            | Stage real estate caps at four sprites through `MAX_SPRITE_SLOTS`            | Extend `STATIONS_BY_COUNT` when a world needs more                                              |
| `apps/web/src/components/session/stage/stage-selectors.ts:496`            | `prompt{N}Icon` and `prompt{N}Color` remain packed                           | Unpack them when a component consumes icon or color                                             |
| `apps/web/src/components/session/chat-messages/message-primitives.tsx:33` | A regex implements Markdown soft breaks without `remark-breaks`              | Adopt the plugin when fenced-code edge cases or more Markdown transforms justify the dependency |
| `apps/web/src/theme-system/token-schema.ts:112`                           | Ambience supports URLs and gradients without local-image upload              | Add upload when players request it and storage moves beyond the settings blob                   |

## Plugins

| Location                               | Ceiling                                                                                                          | Upgrade trigger                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `plugins/cost-gate/hooks/budget.js:45` | Cumulative-total budget model with a fixed default — a long but legitimate session eventually hits any fixed cap | Move to a per-turn / sliding-window spike model if long playthroughs start hitting the cap |

---

**26 markers, each with an upgrade trigger.**
