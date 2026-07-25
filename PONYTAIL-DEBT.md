# Ponytail Debt Ledger

Deliberate simplifications carried in the codebase, each marked with a
`ponytail:` comment at the cited line. Every entry names a **ceiling** (the
limit the shortcut accepts) and an **upgrade trigger** (the observation that
should make someone revisit it). None of the triggers below has fired.

A `ponytail:` comment that explains _why the code is shaped this way_ is not
debt and does not belong here — those were downgraded to plain comments so this
ledger stays a list of things actually owed.

Regenerate with:

```bash
grep -rnE '(#|//|\*) ?ponytail:' . --include='*.ts' --include='*.tsx' \
  --include='*.js' --include='*.mjs' | grep -v node_modules
```

---

## Kernel / runtime

| Location                                                              | Ceiling                                                                                                                        | Upgrade trigger                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/schedule/effects.ts:63`                         | String equality on the `self` literal over-matches across plugins                                                              | Resolve `self` → pluginId if the false positives get noisy                                                |
| `packages/runtime/src/function-runtime/turn-function-runtime.ts:351`  | Revocation is checked at call entry, so an effect already in flight when the deadline fires still lands                        | Thread the deadline signal into every primitive (or isolate in a worker) if late in-flight writes show up |
| `packages/runtime/src/function-runtime/turn-function-runtime.ts:578`  | The non-success demote check reads `writeBuffer` only, not inline output control keys                                          | Also scan control keys if a producer emits them on a non-success return                                   |
| `packages/runtime/src/function-runtime/plugin-handler-helpers.ts:252` | Buffered `deletePluginData` writes through directly rather than via a proposal                                                 | Add a delete proposal when a buffered caller needs rollback-safe clears                                   |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts:537`    | Re-loads the producer runtime just to read its declared `output.schema` (ESM import is cached, so this is a re-parse)          | Add a per-turn schema cache if it ever shows up in a profile                                              |
| `packages/events/src/event-bus.ts:138`                                | FIFO cap on receive-ordering state; a later frame for an evicted stream is treated as a fresh stream and must restart at seq 1 | Move to LRU + per-entry TTL if multi-pod fleets grow                                                      |
| `packages/context/src/compactor.ts:282`                               | Each compaction round adds one more summary block; prior summaries are never rolled together                                   | Merge prior summaries once block accumulation measurably matters                                          |
| `packages/store/src/media-store/filter.ts:16`                         | Metadata filtering full-scans `listAssets()`                                                                                   | Push the predicate into SQL when per-session media volume outgrows tens of records                        |

## Server

| Location                                                      | Ceiling                                                                                                                                | Upgrade trigger                                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/app.ts:245`                                  | Narrative budget resolution ignores per-session `runtime_model_overrides` and `X-Slot-Config` overlays                                 | Wire the session's actual narrative slot if the budget ever needs to track it                                                                                            |
| `apps/server/src/routes/api/plugin-rpc/background-jobs.ts:56` | Process-global concurrency cap of 4 background jobs                                                                                    | Make it per-session if one session's burst starves others                                                                                                                |
| `apps/server/src/routes/api/plugin-rpc/jobs.ts:131`           | Full-session `plugin_data` scan at boot to find orphaned jobs                                                                          | Move to an indexed namespace query if boot slows noticeably. Re-driving orphans (rather than failing them) needs a durable queue with leases — deliberately out of scope |
| `apps/server/src/routes/api/turn-control.ts:7`                | In-process map: on multi-pod PG deployments, steer/abort only reach turns running on the same pod                                      | Move to a shared bus if that tier ever needs cross-pod turn control                                                                                                      |
| `apps/server/src/routes/api/bootstrap.ts:383`                 | A community _wire-only_ plugin (wires consumed by another plugin's slot, own runtime never loading) would not get its wires registered | Add `ensurePluginWires` to the `activatePluginServerCode` call sites when such a plugin exists                                                                           |

## Plugin loading

| Location                                 | Ceiling                                                                                                                                                                                         | Upgrade trigger                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/plugin-loader/src/trust.ts:85` | `detectSource()` returns `community` unconditionally — the `official` trust tier is currently unreachable, and the `=== "official"` branches in `plugin-rpc.ts` / `session/plugins.ts` are dead | Reintroduce the whitelist when the first official plugin ships, and cover those branches then |

## Web UI

| Location                                                       | Ceiling                                                                      | Upgrade trigger                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/session/right-panel.tsx:154`          | The media surface is found by matching a panel's declared `icon === "image"` | Promote it to a first-class capability flag on panel specs if this grows                             |
| `apps/web/src/components/session/stage/StageSprites.tsx:74`    | Transitions `left` / `width` (layout props, against the project's web rules) | Bounded by ≤4 absolutely-positioned sprites moving once per enter/leave; revisit if that bound rises |
| `apps/web/src/components/session/stage/stage-selectors.ts:155` | Stage real estate caps at 4 sprites (`MAX_SPRITE_SLOTS`)                     | Extend `STATIONS_BY_COUNT` if a world ever needs more                                                |
| `apps/web/src/components/session/stage/stage-selectors.ts:496` | `prompt{N}Icon` / `prompt{N}Color` are left unpacked                         | Unpack them when a component wants icon/color                                                        |

## Plugins

| Location                               | Ceiling                                                                                                          | Upgrade trigger                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `plugins/cost-gate/hooks/budget.js:45` | Cumulative-total budget model with a fixed default — a long but legitimate session eventually hits any fixed cap | Move to a per-turn / sliding-window spike model if long playthroughs start hitting the cap |

---

**19 markers, 0 with no trigger.**
