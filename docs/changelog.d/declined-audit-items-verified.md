### Breaking

- **`DataStore.claimSuspension` returns the claim marker, and a claim is released with `releaseSuspensionClaim`.** `claimSuspension(id)` now resolves to the marker it wrote (a string) or `null`, where it resolved to `true` / `false`. The new `releaseSuspensionClaim(id, claim)` reopens the suspension only while that marker is still in place. A custom `DataStore` must implement both; stored data is unchanged and no session has to be recreated.
- **The context budget result reports `overBudget`.** `applyBudget` in `@covel/context` returned `budgetExceeded`, which was true both when history was pruned to fit and when the prompt was still too large after pruning. It now returns `overBudget`, true only when the prompt is still over the limit; `prunedCount` says whether anything was pruned. The assembled context no longer carries `budgetExceeded`.
- **The rules segment of `world-init` is named `dimension-rules-truncated` when it leaves rules out.** It keeps the id `dimension-rules` when every rule fits. Code that looks the segment up by id must accept both.

### Added

- **Context and model-call hooks are told which prompt segments were used.** The `PostContextAssembly` and `PreLLMCall` payloads carry `promptSegments`: the `prompt.segment@1` segments the runtime's prompt was built with, each as `{ pluginId, id }`. A plugin reads it to learn what it put in the prompt and no longer has to search the prompt text. Reference: `docs/reference/hooks.md`.

### Changed

- **`npc-graph` stores no adjacency index.** `upsert-npc-graph` wrote one `index` row per character on every change, and nothing read them: the retriever builds the adjacency from the edges. Sessions keep working; `index` rows of an existing session are left in place and unused.
- **`pnpm check:i18n` compares every `t()` fallback in web code with the `en-US` text.** A fallback that differs from the catalogue fails the check. 94 fallbacks that had drifted from the catalogue now equal it; the interface shows the same text as before.

### Fixed

- **A resume that fails no longer reopens a suspension another resume has taken.** When a resume ran longer than the stale-claim limit (one hour), a second resume could take the suspension; the first one, on failing, then cleared the second one's claim or its recorded result, and the same suspension could be resumed twice. A resume now releases only its own claim.
- **A background job stops when it can no longer renew its lease.** A renewal that failed was only logged, and the job ran on after its lease had expired, while maintenance could already have marked it `orphaned`. The job is now aborted once the lease has run out unrenewed and ends as `orphaned` with the reason `lease-expired`. Reference: `docs/reference/protocol.md`.
- **A load-time input check no longer calls a binding compatible when it cannot tell.** When `accepts` constrains a property that the producer's schema does not declare, the producer may send any value there. The check now reports this as undecidable (a warning; the value is still validated at run time) unless the producer forbids undeclared properties.
