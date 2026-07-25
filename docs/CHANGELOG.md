# Changelog

All notable changes to this project will be documented in this file. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.21] - 2026-07-25

A reliability pass over the web client, from exercising the front-end the way a player does rather than the way its tests do. Nothing here adds capability. Three of these fixes were destroying persisted data, four left the player unable to act, and two let a single bad plugin or theme take the whole screen down.

### Fixed

- **Stored settings survive a failed read or write.** Two independent, silent data-loss paths. `set()` mutated the in-memory map and then awaited the adapter with no rollback — every UI call site is `void setValue(...)`, so a quota exception (importing a multi-MB CSS theme, say) left the map ahead of storage with no signal, and every later write re-serialised the same poisoned map and failed the same way. Separately, a failed `load()` was indistinguishable from "nothing stored yet"; since `save()` always writes a full snapshot, the next single-setting change overwrote `settings.json` and `keys.env` with just that one key. Rollback undoes only the key it touched (a whole-map snapshot would revert a concurrent write that had already succeeded) and stays synchronous so read-after-write still works in the same tick. A failed `init()` now records `hydrationError` and refuses writes including `clearAll` — a hydration failure shows defaults, which reads as "my settings are gone", and the player's natural response is Reset. The REST backend's GETs were missing the bearer header its PUTs already send, so a tokened desktop install 401'd on every boot and hit exactly this path.
- **A reload no longer clobbers state-patch history.** `addStatePatch` read the in-memory map — empty after a page reload — and wrote `[...list, patch]` back to IDB, overwriting the persisted array. Playing, reloading, then taking one more turn destroyed the session's entire state-patch history. It now reads through IDB before appending and re-reads the map after the await: one turn commonly commits several `state.changed` events in a single flush and the SSE handler appends fire-and-forget per event, so without the re-read two appends in the same tick lose one. `syncToServer` also no longer swallows message-sync failures — the next turn would run against empty server history and the narrator would visibly forget the story.
- **SSE events and stream settlement are scoped to their own session.** Nothing aborted the previous action stream when the player switched sessions mid-turn, so envelopes for session A kept arriving while B was loaded. Only the narrative-delta path was guarded; every other event type was applied to B, and `narrative.completed` persisted A's text under B's session id — permanent in local/IDB mode, still there after a reload. The event handler now drops mismatched envelopes (failing open when either id is absent, so the resume path is unaffected), and `finalizeActionExecution` takes the session its stream was opened for — without it the old stream's completion cleared the **new** session's executing flag.
- **Suggestion panels no longer lock the player composer.** Suggestion actions (`draftMessage` / `selectSuggestion`) were classified as pending interactions alongside must-answer ones (`submitForm` / `selectChoice`), so any turn where `scene-prompts` or `guide` offered shortcuts disabled the main composer for the rest of the turn. The player could only pick a suggestion or use the plugin panel's own secondary input, with the most prominent input on screen dead and captioned "finish the current interaction first". Queued drafts no longer block either: the composer stays usable while selections sit in the draft bar, and submitting sends the selections and the typed line together as one turn — the behaviour `ui-panels.md` already documented for the input bar.
- **Mobile navigation is wired up.** The hamburger button had an `aria-label` and an icon but no `onClick`, while the desktop nav and the language toggle are both `md:` only. On a phone the top bar was decorative: worlds, sessions, plugins and debug were unreachable and the language could not be switched at all. It opens a Radix Dialog now, which brings the focus trap, Escape handling and `aria-modal` a hand-rolled dropdown would have to reimplement. A duplicate `open-plugins` subscription in `session.tsx` also held its own dialog instance that was set open but never rendered, then popped up unbidden on the next navigation back to world select.
- **AI request headers encode as UTF-8 base64.** `btoa(JSON.stringify(...))` throws a `DOMException` on any codepoint above U+00FF. Both payloads carry free user text — `X-Slot-Config` embeds the user-typed custom preset name, `X-Plugin-User-Settings` arbitrary per-plugin values — and the app's default locale is `zh-CN`, so naming a preset in Chinese made every request fail.
- **API failures are classified instead of collapsing to null.** `request()` threw a bare `Error`, so `RemoteDataService` could not tell 404 from 401 or 500 and mapped everything to null: a hosted player whose owner token had expired was told the session did not exist. `ApiError` carries the status, and only a genuine 404 becomes null, matching `LocalDataService`.
- **A broken plugin surface no longer takes down the game view.** The only error boundary was `AppErrorBoundary` at the app root, and the server validates just the spec envelope (`view: z.record(z.unknown())`), so anything inside `view` reached the catalog renderers unvalidated. Plugin UI specs are not gated by the server-code approval flow, so a third-party typo — or an LLM-emitted `ui.render` block — replaced the whole game view including a still-streaming narrative, and because the offending data is persisted, a reload crashed again. Adds `PluginSurfaceBoundary` around the panel renderer and `ui.render` blocks, a null-prototype component registry (so a spec naming `constructor` hits the unknown-component fallback instead of resolving to `Object`), guards at the shared resolve chokepoints, and depth caps in the JSON renderers.
- **Theme CSS scoping is enforced, and only the active theme is mounted.** Validation only required that at least one scoped selector existed and silently ignored the rest, so `html[data-theme="x"]{} * {display:none}` passed. Worse, `syncThemeStyles` mounted every registered theme at once, so an imported theme the player never selected still applied any rule that escaped its scope — and kept applying it after a restart, hiding the settings dialog needed to remove it. Only builtins plus the selected custom theme are mounted now; that, not the scanner, is the actual containment. `@import` is banned outright (a remote fetch from a theme pack doubles as a "this player opened the app" beacon), and a custom theme may no longer claim a builtin id.
- **i18n gaps closed and browser language detection actually applies.** Seven keys were used in code but defined in neither locale, so `zh-CN` players read the inline English defaults; three of them could never have worked, being used as both a string and a namespace. `resolveInitialLocale()` ran but `ui.locale` defaulted to a hardcoded `zh-CN` and `main.tsx` applied the store value unconditionally, so an English browser flashed English and then flipped to Chinese permanently. The coverage gate now also flags CJK punctuation reaching en-US verbatim and checks that every statically-analysable `t()` key is defined in both locales — its per-line regex had been missing 73 of the 745 keys because prettier wraps long calls.

### Changed

- **First paint ships 580 kB less JavaScript.** Measured on a real build: eager JS drops from 1.99 MB to 1.41 MB raw (566 kB to 405 kB gzip), entry chunk from 1.21 MB to 906 kB. `react-force-graph` + d3 had a manual chunk, and rolldown put a shared React CJS interop module in with them — every chunk then statically imported 194 kB of graph code, defeating the `lazy()` entirely; deleting the rule lets rolldown isolate them. `yaml` was welded to zod the same way. Routes were not code-split at all. Three `manualChunks` rules matched packages that are not installed. The landing page also loaded a 10 MB `demo.gif` while the 1.3 MB MP4 that `build-media` generates for exactly this purpose sat unused — the GIF shipped in every deploy and in the Electron installer, and is deleted here.
- **Session E2E waits for the turn it claims to wait for.** The specs inferred turn state from `input:disabled`, which is wrong in both directions: the composer stays enabled mid-turn (submitting steers the running turn), so the wait passed within its fast path without ever waiting; and the composer was located via `input[type=text]").last()`, which only held as long as no plugin panel rendered an input after it. The composer now exposes `data-executing` and `data-blocked` separately, the helpers both specs had copy-pasted live in `tests/e2e/helpers/player.ts`, and `expectPlayerCanAct` asserts the invariant this release's composer fix restores.

## [0.0.20] - 2026-07-25

A follow-up to the cleanup release, from watching real sessions run. Three fixes, all found by reading traces rather than tests: a runtime could report success having done nothing, a hazard warning fired every turn regardless of the truth, and several runtimes were handed tools their own prompts told them never to call.

### Fixed

- **A bare `runtime-done` no longer satisfies `requireToolUse`.** A runtime whose whole declared job is to call a tool could finish as a success having called only the framework's loop terminator. Seen in production with `scene-prompts`: the model answered with prose, the gate nudged it once, and the model replied by calling `runtime-done` with the reason "完成 scene prompts 生成" — the actual work tool was never called. The turn reported success in 47.6s and the player got an empty quick-reply panel behind a green check. Two paths let it through: the gate counted any successful call, terminator included, and the runtime-done early exit breaks the loop _before_ the gate runs. Both now require a business tool call, and an unmet contract finalizes as `failed` with a diagnostic instead of an empty success.
- **UI effects hazards are reported per slot, not per plugin.** Any manifest declaring a `ui` block was credited with writing `ui:*`, so every pair of UI-declaring runtimes in a DAG layer was flagged — nine warnings in a three-turn session, all false: a right-panel plugin cannot overwrite a message block. `EffectResource` now admits `ui:<slot>` and the derivation emits one key per declared slot. `ui:*` still wildcard-matches them, so an explicit declaration keeps its meaning, and two plugins that really do share a surface still hazard.

### Changed

- **Runtimes no longer receive tools their prompts forbid.** Five declarations were paid for twice — once in the tool schema on every LLM call, once in the prompt text spent forbidding them. `character-tracker` dropped `list-characters` (its roster is injected as `<existing-characters>`), both image `prompt-generator` runtimes dropped `plugin-data-list` (they inject the `prompts` namespace), and `world-init/schema-gen` dropped `plugin-data-get` / `plugin-data-list` (it writes during setup and never reads back). `get-character` and `list-npc-graph` stay: unlike the others they are the documented escape hatch for a truncated snapshot, and a live session confirmed `get-character` being used exactly that way. `extractor`'s guidance, which said "**无需**调用" in bold and then described when to call it eight lines later, is now one instruction.

The cleanup release, following a full audit of the core framework. Nothing here adds capability; it removes surface that was declared but never honoured, and closes the security gaps that hid behind it.

> **Breaking — six PLUGIN.md fields no longer parse.** A manifest declaring any of them fails to load, so check yours before upgrading. None of them did anything at runtime, so removing them changes no behaviour except that the declaration is now an error instead of a silent no-op.
>
> | Removed field      | Replacement                                                                                             |
> | ------------------ | ------------------------------------------------------------------------------------------------------- |
> | `priority`         | `stage` (`setup` / `pre-turn` / `narrative` / `post-turn` / `audit`)                                    |
> | `upstreamRequired` | `needs` (same entries; turn-scoped by default)                                                          |
> | `jobStatus`        | — (its `legacyViews` projection had no reader)                                                          |
> | `tools.local`      | register in the `entry` module via `covel.registerTool`, then list the **names** under `tools.plugin`   |
> | `suspensionSafe`   | — (no handler replay exists to guard)                                                                   |
> | rpc `streaming`    | — (dispatch is always synchronous; progress travels as `plugin-data.changed` SSE from a background job) |
>
> `priority`, `upstreamRequired` and `tools.local` produce a load error naming their replacement. One sharp edge inherited from the rpc parse policy: an unrecognized key skips the **whole** `rpc` block rather than the offending action, so a plugin that declared `streaming` loses every rpc action at once — the warning names the file, line and key.

### Added

- **The test-runtime harness loads entry-registered tools.** `pnpm test:runtime` runs a plugin's `tests/runtime-cases.json` through the real turn executor, so a case can have the mock LLM call the plugin's own tools — it never could, because the harness only ever read `tools.local` and every plugin moved to `entry` in v0.0.14. The concrete cost was the scaffolding template: `templates/plugin-with-tools` ships a case whose LLM calls `record-note`, so a new author's first `pnpm test:runtime` failed on a tool that was never registered. The harness now runs the `entry` module with a `PluginAPI` that implements `registerTool` and no-ops hooks / RPC / wires (server-bootstrap concerns a single-runtime harness turn never reaches), and a name collision with a framework tool throws rather than quietly shadowing it.

### Fixed

- **Tool calling on the Anthropic adapter.** `createAnthropicMessagesAdapter` never serialized `params.tools` and dropped every tool-role message, so an agent runtime routed to an `anthropic-messages-v1` slot sent no tool definitions, got no tool calls back, and produced no proposals — no character updates, no plugin data, no image generation. It degraded to plain narration with nothing logged as an error while the protocol registry advertised `function_calling` all along.
- **`create-notification` renders again.** The tool returned `{ notified: true, level }`, which the runtime never promotes (only a result carrying `ui` or `interaction` is proposed) — the model was told the notification succeeded and the player saw nothing. It now returns the nested `Alert` spec the renderer expects.
- **SVG media is rejected on upload and sandboxed on read.** `POST /api/media` accepted `image/svg+xml` under its `image/*` check and `GET /api/media/:id` echoed the MIME back with no `Content-Disposition`; a session owner could upload a scripted SVG, get a correctly signed URL, and read the web tier's localStorage provider keys from the app origin. Stored rows predating the ban are served as sandboxed attachments.
- **Provider-key availability requires the operator token.** `GET /api/provider-keys` gated only its raw-key branch, so on demo/commercial an anonymous caller still got a masked listing revealing which providers were configured plus the first and last four characters of each key. The whole route is now behind `checkHostedOperator` (a strict no-op on self/desktop).
- **Community local-tool factories get the deny-all store.** The unified `entry` path already scoped a community plugin's store, but the `tools.local` factory path injected the raw DataStore for every trust tier — a community plugin could call `listSessions()` or touch any session's plugin_data, bypassing proposal → validate → commit. Both paths now share `scopeStoreToPlugin`.
- **Media-GC scans page soundly.** `buildProtectedMediaIds` paged four lists by offset over a non-total order (two had no `ORDER BY` at all), so a concurrently-upserted row could slip between pages and lose its media id — a destructive cleanup would then delete still-referenced bytes. All four now order by `(createdAt, id)`.
- **Locale variants inherit what they omit.** `reconcileValue` treated any field a `PLUGIN.<locale>.md` did not declare as drift, forcing every translation to mirror the whole canonical manifest — and a mirrored manifest goes stale silently. An omitted field now inherits; a field declared with a different value still overrides and still warns.
- **Unknown-field load errors name the field.** Zod reports `unrecognized_keys` with an empty `path`, so every unknown-field failure fell through to the "ensure the file begins with `---`" hint even though the frontmatter parsed fine. The hint now reads `issue.keys`, and removed scheduling fields point at their replacements.

### Removed

- **Legacy scheduling fields.** `priority`, `upstreamRequired` and `jobStatus` are rejected by both manifest schemas — a PLUGIN.md declaring any of them fails to load with a hint pointing at `stage` / `needs`. The compat fold (`stageForPriority`, `aliasUpstreamRequired`) and the never-read `jobStatus.legacyViews` projection are gone, and the `RuntimeManifest` type no longer carries the fields.
- **Inert manifest fields `suspensionSafe` and rpc `streaming`.** Both were accepted and stored but never read: no handler replay exists (`resumeSuspendedRuntime` re-enters the shared agent tool loop without re-invoking the handler), and rpc dispatch is unconditionally synchronous. Removing them changes no runtime behaviour.
- **The `tools.local` registration path.** It was the last loader that imported plugin code by frontmatter path. Plugin tools register in the `entry` module (`covel.registerTool`) and a runtime declares their names under `tools.plugin`; every bundled plugin moved in v0.0.14 and the field's own doc had promised removal in v0.0.17. Deleting it also removes — rather than patches — the trust asymmetry the audit found: the `entry` path scoped a community plugin's store to a deny-all view while this one injected the raw DataStore. `local-tools.ts` (240 lines) collapses to `plugin-tool-access.ts` (23); `activatePluginServerCode` now does exactly what its name says.
- **Four designs that were drafted and never wired** — `prompt-delta` (+ `RuntimeOutput.metaData.rawPromptDelta`), `runtime-slot-resolver`, and the json-render presets. Each was reachable only from a barrel export and a test that supplied the input no producer ever supplied. `GET /runtime-outputs/:id/full-prompt` now returns history and states plainly that the system prompt and injected segments are absent; `trace_events` remains the exact path.

### Changed

- **Two identifiers renamed to match what they do** — `NormalizedRuntimeSpec.provenance.legacyFields` → `derivedFrom` (it records only live normalizations now), and the `activatePluginLocalTools` Hono context key → `activatePluginServerCode`.
- **Redundancy the audit flagged.** The snapshot payload builder read every `turn_results` row for a session to build a plugin-id set, then filtered `plugin_data` by it — a filter that could never drop anything, since the set is the union of both sources. Long sessions paid a full-table read (each row carrying its complete runtimeResults payload) for a no-op. Also folded away an identity function (`summarizeStorageMigrations` → the `STORAGE_MIGRATIONS` constant), a nine-line `vector-factory.ts` whose comment explained there is no factory, a second identical `TimeCursor` definition, and the unconsumed `ResolvedTool` / `ToolClient` / `ToolDefinition` types.
- **Ponytail debt is now a ledger.** `PONYTAIL-DEBT.md` lists the 19 deliberate shortcuts still carried, each with the ceiling it accepts and the observation that should trigger revisiting it. Six markers that explained _why the code is shaped as it is_ — rather than naming something owed — were downgraded to plain comments so the list stays readable.
- **Docs realigned to the shipped surface.** Removed the deleted `POST /api/sessions/:id/turn` endpoint from the API reference, corrected pointers at moved/deleted modules, and rewrote every passage that described removed features as still-live compat — the reference docs now describe the current shape only, with history left to this changelog.

## [0.0.18] - 2026-07-24

The scheduling release. The numeric priority scheduler is gone: runtimes now declare a named **stage** (`setup / pre-turn / narrative / post-turn / audit`, strict barriers between stages) plus typed dependency edges — `needs` (gate + DAG edge, by runtime id or capability), `after` (ordering only), and typed `inputs` bindings resolved into provenance-wrapped `ctx.inputs`. Session lifecycle truth moved to a dedicated clock (`phase` / `completedPlayerTurns` / `setupRuntimes`) with `turnCount` / `preGameCompleted` derived at read time, and turn counting became single-writer (turn-wide finalize transaction + an idempotent logical-turn ledger). A same-day extensibility audit closed every "declared but silently ignored" manifest surface it found.

### Added

- **Stage-driven scheduler** — per-stage DAGs with strict barriers; independent runtimes in a stage run in parallel (name breaks ties); dependency cycles are diagnosed and disabled for the turn instead of silently run in arbitrary order. Band selection is by `session.phase`, not turn number.
- **Session clock + setup state machine** — per-runtime setup mirrors with retry budgets, generations (a plugin version bump invalidates a stale `done`), and a `blocked` terminal; `needs(scope: session)` cycles are blocked up front with a full path diagnostic, and the positive gate holds a consumer back until its producer is `done` in the frozen snapshot.
- **Opening continuation** — the request that completes the last setup runtime chains exactly one main-loop turn on the same SSE stream, so the narrator's opening arrives without a second player message.
- **envelope-v1 handler results** — discriminated `success / suspended / skipped / failed` outcomes with unified normalization; non-success envelopes carry observation channels only. All bundled function handlers migrated.
- **`recordAs` exports and `runtime-export` injects** — versioned cross-execution publications with frozen-at-execution-start reads.
- **Kernel job-status channel** — `ctx.progress.report()` streams append-only, idempotent progress events (SSE + store) for long-running work; reported jobs are terminalised from the execution outcome.
- **Effects declarations** — derived read/write sets with a same-layer hazard policy (`effects.reads/writes/parallelSafe`), plus declared HTTP permission upper bounds (`permissions.http`).
- **`pnpm validate:plugin`** — one command runs the loader compat parse (line-numbered errors, I18nText folding) and the strict authoring schema (missing `stage` / legacy fields rejected); `--compat` covers legacy third-party manifests.
- **`schedulable-missing-stage` diagnostic** — an `auto`/`scheduled` runtime with neither `stage` nor legacy `priority` now warns at load instead of silently never running; pure registration surfaces (ui / hooks / entry / wires) are exempt.
- **Media plugins and wires** — bundled `dashscope-image-gen` / `openai-image-gen` / `mimo-tts` plugins; wan2.6/wan2.7 multi-image support and qwen-image-3 on the DashScope wire; shared image-generation trunk extracted into `plugin-handlers-utils`.

### Changed

- **Legacy scheduling fields are compat-only** — `priority` folds to a derived `stage` and `upstreamRequired` aliases into `needs` at a single normalize point; all bundled plugins single-declare `stage` + `needs` (two documented loader-gated `priority` exceptions remain). Event fan-out orders subscribers by `name`, not priority.
- **`turnCount` / `preGameCompleted` are frozen legacy columns** — API responses derive them from the session clock at read time; response shapes are unchanged.
- **Manifest `description` accepts I18nText** — the preferred locale-map form now validates on both schemas (the loader folds to a single string post-parse), so editor tooling no longer flags every bundled manifest.
- **Docs and skills realigned** — flow.md's state model rewritten around the session clock; the zero-code/advanced guides, plugin registry, glossary, and protocol pages purged of priority-era wording; the create-plugin and static-audit skills rewritten against current contracts; non-project drafts pruned from `docs/` per DOCS_STRATEGY; scaffolding templates modernized; "GalGame" naming unified to **stage mode**.

### Removed

- **`scheduleByPriority` and the numeric priority scheduler** — stage + DAG is the only scheduling authority.
- **Reserved trigger types** — `conditional` / `error-retry` are gone from the trigger enum (manifests declaring them fail to load), together with their five dead code remnants and the orphan `condition` / `maxRetryCount` fields.
- **Dead session-plan types** — the never-consumed `SessionExecutionPlan` / `ExecutionEdge` / `SessionGate` / `ResolvedRuntime` family.

### Fixed

- **`needs(scope: session)` is real now** — enforced as a positive gate in setup selection and rejected on any non-`setup` stage, closing the accepted-but-inert declaration trap.
- **Discovery advert completeness** — `inputInjectKinds` derives from the inject union (it had silently omitted `runtime-export`); trigger types were already schema-derived.
- **Scaffolding correctness** — `create-plugin.js` emitted an `input.inject` entry without the required `kind` discriminator (generated plugins failed validation); the plugin-with-tools template still taught `priority` + `scheduled interval: 1`.
- **`test-runtime --ignore-upstreams`** also strips the `needs` declaration, not just the legacy alias.

## [0.0.17] - 2026-07-21

Trust-boundary and commit-integrity release, plus a smoother story-mode opening. A consolidated full-repository audit (2026-07-20) drove three remediation batches: plugin identity and community-code approval are now enforced end to end, a turn's commit outcome is authoritative everywhere, and single-connection stores serialize writes against open transactions. The GalGame stage now pre-warms its art during pre-game and appears as soon as the player submits the opening form. Toolchain moved to pnpm 11 / TypeScript 7 / Vite 8 / Electron 43, and the runtime baseline is Node 26.

### Added

- **Stage media preload** — known scene backdrops and character sprites/avatars are warmed into the browser media cache as soon as a session opens (world-package media is already in the MediaStore at creation), so the opening turn paints them straight from cache instead of downloading after the pre-game turn ends.
- **Early stage entry** — the visual stage mounts the moment the player submits the opening (character-creation) form, showing the world hero backdrop and a thinking indicator until the narrator's first `scene.set` swaps in the real scene art. Previously the player stared at the chat stream until pre-game fully completed.
- **`turn_results.commit_status` + `origin`** — every execution artifact records whether its proposals actually committed (`pending` → `committed`/`failed`; a lingering `pending` is a crash signature) and which path produced it (`player`/`manual`/`follower`/`recursive` with `parent_turn_id`), so `session.turnCount` counts committed player turns only.
- **`proposal.failed` SSE/trace event** — a proposal commit failure surfaces to the client and withholds the completion barrier instead of reporting turn success.

### Security

- **Canonical plugin identity** — install derives one canonical ID from the manifest root name; the scoped-npm impersonation bypass (e.g. `@covel/plugin-narrator` claiming the builtin `narrator`) returns 409, and boot discovery hard-fails a dir/frontmatter identity mismatch.
- **Two-phase community approval enforced exactly** — grants are exact-action only (a prefix match previously let any grant unlock everything); community runtime dispatch, declarative RPC handlers, and entry imports all walk `covel:plugin-server-code` first, then the specific grant.
- **Executor-side tool authorization** — the agent loop passes the runtime's exact authorized tool set and the executor rejects out-of-set names (checked on the final name, after overrides and PreToolUse replacement); local tools fail closed without context.
- **Framework-owned identity is frozen** — tool-carried proposals are rebound to the executing runtime's session/turn/source before commit; `recursiveCall` takes a delta (no session/turn/origin override) and returns a result that cannot fire `turn.completed`; PostRuntime replacement keeps manifest identity; PreStateCommit replacement is payload-only; PreSchedule replacement is filter-only.
- **Function-runtime capability revocation** — a timed-out or aborted handler loses every capability (store, pluginData, media, images, speech, gateway, logger, assetProgress, recursiveCall) the moment the race settles, so a detached handler cannot write after the session lock releases.
- **Plugin-data trust gaps closed** — the reserved `_` namespace (`_jobs`, `_logs`) and core-plugin namespaces are rejected on every plugin-controlled write path (REST, commit handlers, function-runtime writer); `world-init` no longer seeds a new session by copying another session's player-writable plugin-data.
- **Prompt-injection surface reduction** — player input never rides the system prompt (`{{ player.message }}` interpolation removed from narrator bodies); inject blocks are interpolated exactly once so escaped `{{ … }}` in player/model data cannot expand; core-memory blocks are XML-escaped with validated labels; compacted history summaries are demoted from system messages to escaped data envelopes.

### Changed

- **Toolchain baseline** — pnpm 11.9, TypeScript 7.0, Vite 8 (rolldown), Vitest 4.1, Electron 43, Hono 4.12, Undici 8.6; Radix umbrella replaced with per-package imports. Node runtime pins moved 22 → 26 (engines `>=26`, mise, CI, Docker base image digest-pinned to `26.5.0-alpine3.24`).
- **Dialogue-mode parity for tracking runtimes** — character-tracker, npc-graph extractor, and codex discover the narrative engine by capability instead of naming `narrator`, so character state and the relationship graph update in chat mode too.
- **`start_session` with an empty plugin set returns 400** instead of silently activating every registered plugin (including community and mutually-exclusive ones) for the life of the session.
- **Comment/doc hygiene** — audit/spec/PR tracer IDs swept out of code comments and test names; docs corrected where they had drifted from the implementation (transactions boundary, turnCount semantics, postHistory scoping, emit-event dedup).

### Fixed

- **Commit outcome is authoritative** — synchronous plugin-rpc returns 500 `turn-commit-failed` on an uncommitted turn; background jobs settle failed and schedule no follower onto rolled-back state; nested `recursiveCall` proposals bubble to the top-level barrier instead of being dropped; a failed best-effort auto-snapshot no longer fails an already-committed turn.
- **Turn accounting** — a scoped `retry_runtime` no longer double-advances the turn counter; a fork's inherited count is preserved; the counter advances only after commit settles.
- **SSE isolation and ordering** — the event-bus subscription is established inside the session lock (a queued action can no longer receive the previous execution's events under its own envelope); post-commit fan-out is buffered until the enclosing transaction commits; stream writes go through one serial queue.
- **Single-connection store writes serialize against open transactions** — on SQLite/Memory backends an unrelated write issued while a transaction was open used to join it (and vanish on rollback); a per-connection write gate now queues outside writes, covering the vector and mirror-media stores sharing the connection.
- **World-data write atomicity** — `sync-dimensions` runs under one session lock + transaction; `sync-data` re-checks content hashes inside the transaction (409 on drift) and defers media deletion to after commit so an abort cannot leave committed references to deleted files; media materialization compensates partial failures.
- **NPC graph runs on a real turn clock** — relationship edges are versioned (changed relations close the open version and open a new one with authoritative `validAt`/`invalidAt`), `firstSeen`/`lastSeen` no longer derive from row counts, an unknown turn can no longer rewind `lastSeenTurn`, and superseded/duplicate open edges are healed and filtered from retrieval.
- **Event-runtime throttling restored** — fan-out now feeds real per-runtime trigger history, so `maxTriggerCount`/`cooldownTurns` bind again; fan-out also respects the real `preGameCompleted` set so a finished Pre-Game runtime is not resurrected.
- **Prompt budget enforcement for tool-using agents** — pruning is tool-pair-aware (no orphaned `tool` messages), which lifts the exclusion that had exempted every main agent from the hard budget; working memory is capped at render time and its entry quota enforced on both write paths.
- **Read-your-own-write for plugin data** — `get`/`list` overlay the calling plugin's own uncommitted proposals from the current tool loop.
- **npc-graph / retry / snapshot / localization follow-ups** — adjacency index prunes closed edge ids; schema-declared runtimes get a correct completion preamble instead of being told to call a tool they don't have; the framework locale rule is scoped to natural-language content so machine values (enums, ids, topics) stay verbatim; localized manifests are verified field-by-field against the canonical manifest.

## [0.0.16] - 2026-07-17

Performance, correctness, and reliability release. Context budgets are now derived from real model capabilities, per-turn history reads are bounded so long sessions stay fast, and a repository-wide six-dimension audit closed a batch of dead code, stale-doc, logging, and cross-backend-consistency gaps. New capability: **deferred tool loading** (`tools.defer`) lets runtimes with large tool whitelists keep the prompt small and let the model search tools on demand. Reliability fixes harden the shutdown drain, background-job sweep, event tail-frame delivery, and hosted-tier owner-token enforcement.

### Added

- **Deferred tool loading (`tools.defer`)** — a runtime may defer part or all of its tool whitelist; deferred tools stay registered and authorized but are withheld from the initial LLM tool list, and the framework injects a `search-tools` tool that ranks the deferred pool with a zero-dependency BM25 (CJK-aware) and activates matches for the rest of the turn. Modeled on openai/codex's `tool_search`. See [docs/reference/tools.md](./reference/tools.md#search-tools框架注入延迟工具加载).
- **Capability-driven context budgets** — compaction thresholds and prompt budgets are derived per model from detected token limits, plus per-model USD cost estimation on the debug Cost view.
- **Configurable chat window cap** (`ui.chatMessageWindow`, default 2000) — live message appends are bounded in memory; dropped rows remain re-fetchable via the existing scroll-up path.

### Changed

- **Bounded per-turn history reads** — `loadTurnSessionState` no longer full-reads the whole `turn_messages` log every turn. New `DataStore` methods `listUncompactedTurnMessages`, `listTurnMessagesAfter` (forward keyset), and `getTurnMessageStats` (grouped aggregate) keep reads bounded as a session grows; the semantic-memory recall ingestion walks the log by cursor instead of re-reading and re-sorting it.
- **IndexedDB `deleteSession` cascade** now derives from `SESSION_SCOPED_TABLES`, matching the SQL/Memory backends — a newly registered session table can no longer silently leak rows on the browser backend.
- **Removed two zero-caller extension seams** — the `findToolClient` tool-client resolver and the per-runtime `getConfigFn` / `ctx.config` / `{{ config.* }}` chain (always empty in production) were deleted end to end.
- **Framework/plugin isolation and docs** — removed a write-only `blockSchemas` chain, retired an unread env-registry entry, closed authoring-contract drift, and synced all reference/guide docs to the current architecture.

### Fixed

- **SSRF self-tier core-provider path** — the DNS-pinning guard rejected provider hosts on machines running a TUN proxy (Clash/mihomo/sing-box/Surge fake-IP maps every domain into a private/benchmark range) or a LAN Ollama endpoint. The `self` tier now accepts any resolver answer on the user's own configured `baseUrl` (socket still pinned); plugin `ctx.http`, IP-literal URLs, and hosted tiers stay strict.
- **Settings persistence on the REST-desktop tier** — self-host setups without the Electron IPC bridge now persist settings to `~/.covel/settings.json` instead of silently falling back to `localStorage`; the settings REST backend surfaces failed writes instead of swallowing them.
- **Plugin-panel re-render storm** — plugin-data store snapshots are scoped per `(pluginId, namespace)`, so an unrelated plugin's data write no longer re-renders every active panel.
- **Malformed JSON bodies** now return `400 invalid_json_body` instead of a generic 500 across ~13 API routes (shared `readJsonBody` helper).
- **Shutdown drain** flushes in-flight turns before closing the store; **background-job sweep** periodically reclaims orphaned pending jobs; **event delivery** detects lost tail frames via a transport heartbeat.
- **Hosted-tier auth hardening** — owner-token hash stripped from responses, event injection gated, owner guard enforced on the resume `DELETE` suspension route; desktop IPC sender-origin checks extended to the remaining channels.
- **Observability & logging** — turn-executor and shutdown paths keep error stacks instead of `err.message` only, the Data Explorer and model-db refresh catch paths log, and `[component]` prefixes are consistent.

## [0.0.15] - 2026-07-16

Security and reliability hardening release. A full-repository audit and two follow-up remediation rounds closed the credential, trust-boundary, transaction-consistency, and event-delivery gaps that made the previous build unsafe to expose on a public, multi-user, or multi-instance deployment. Local single-user `self`/desktop play is unchanged by default; the new hosted-tier controls are opt-in via `DEPLOYMENT_TIER`.

### Security

- **Provider keys stay bound to their trusted origin.** Server/platform API keys now flow to the gateway as `envApiKeys`, separate from request-supplied `X-Provider-Keys`; an env key attaches only when the resolved `baseUrl` origin matches trusted config (`llm.toml` / registered provider defaults). A request-scoped custom preset that redirects a provider to another origin receives no env key and no trusted default headers, closing the request-level key-exfiltration chain.
- **Per-request slot overlays are isolated.** Custom presets register under a request-derived scoped id, so two concurrent requests using the same provider name with different base URLs can no longer share a registration — a victim's browser key can never be sent to an origin another in-flight request registered.
- **Core provider HTTP resolves DNS through a pinning dispatcher.** `postJson` / `getJson` / `postFormData` (not just the plugin `ctx.http` helper) validate every A/AAAA answer at connect time and reject private/link-local/metadata addresses, closing the string-check-to-connect DNS-rebinding gap.
- **Hosted deployments gate every session and global route.** A per-session owner token (minted at create, hash-persisted, returned once) guards all session-scoped routes; hosted (`demo`/`commercial`) tiers additionally require an operator credential to create/list sessions and reach global admin/model/world routes. The server binds `127.0.0.1` by default (`COVEL_BIND_HOST` opts into a public interface). A startup posture check fails closed on a hosted tier missing its media secret, CORS origin, or operator token. `self`/desktop/dev tiers remain a strict no-op.
- **Community plugin code is import-gated behind two-phase approval.** A community (third-party) plugin's server code (`entry` / handler / hook / wire / runtime JS) is never imported until an explicit `covel:plugin-server-code` grant is approved for the session; the specific action then requires its own approval. Legacy `hooks:` handlers defer their import behind the same gate, the community entry store is default-deny (writes flow through proposals), and a timed-out agent guard has its write capabilities revoked so it cannot mutate a later turn.
- **Desktop hardening.** Electron blocks main-frame navigation off the sidecar origin and validates the sender frame on secret-returning IPC; ZIP imports enforce entry-count / total-size / per-entry / ratio limits and no longer accept renderer-supplied arbitrary paths.
- **Supply chain and logging.** Pinned `only-allow` and Docker image digests; Postgres binds host loopback; media and session tokens are redacted from error logs; GitHub Actions pinned to commit SHAs.

### Added

- **Operator Access settings pane** to save / clear / show / hide the hosted operator token, reloading session and world data on change.
- **Pull-request / push CI** running install → `pnpm lint` → `pnpm deps:check` (dependency hygiene) → tests → build → i18n/plugin checks; `DEPLOYMENT_TIER` is parsed against an explicit enum and fails closed to the most restrictive tier on an unknown value.

### Changed

- **Community plugins seeded by a world now require explicit approval on every tier.** A third-party (`community`-trust) plugin listed in a world manifest is no longer auto-activated and auto-loaded on first schedule — it is dropped from a session's active set at creation and must be explicitly enabled and approved (two phases: load the plugin's server code, then the specific action) before any of its code executes. This now applies on **all** deployment tiers, including local `self`/desktop, matching the documented community trust model (deferred `import()` until the user approves). **Bundled sample worlds are unaffected** — their plugins are `builtin`/`official` and still auto-load at boot. **Migration:** if you author a world that references a third-party community plugin, players must enable and approve it in-session; a previously-working self-tier world that relied on such a plugin auto-loading will start with it inactive until approved.
- **Turn side effects are strictly post-commit.** Externally-visible "committed" SSE/trace broadcasts, `PostStateCommit` hooks, `turn.completed`, and post-turn memory/vector ingestion now run only after the commit transaction resolves, so a rolled-back batch emits no ghost events and never writes memory for a failed turn; a single `traceId` threads the whole turn.
- **Snapshots are checkpoint-throttled and paginated** (`COVEL_SNAPSHOT_INTERVAL_TURNS`, default 5), with a store-level metadata projection + keyset pagination that never deserializes payloads.
- **Streaming text is decoupled from message history** into an external store, so per-delta updates are O(1) and the chat grouping memo no longer rebuilds per token; the IDB backend and debug route move out of the main web chunk.

### Fixed

- **EventBus delivery is bounded and gap-aware.** A fixed-capacity ring buffer with LRU/idle eviction (active subscribers pinned), `${epoch}:${seq}` non-reusable ids, replay-gap detection that drives a `system.reset` → client re-hydrate, a per-session ordered cross-pod outbox over PG `LISTEN/NOTIFY`, and leak-free SSE cleanup with a per-session connection cap and bounded write backpressure.
- **The compactor cascades past the first compaction** — the window starts after the last boundary and tokens are estimated from the effective prompt view, so long sessions keep compacting instead of eventually overflowing the model context.
- **Graceful shutdown drains** watchers, event bus, store, and PG lock pool; background jobs get a startup recovery sweep and a concurrency cap; the PG advisory-lock deadline now covers pool checkout.
- **Turn hot-path reads reduced** (working memory deduped 3→1 per turn; touched-only transaction snapshots), IDB keyset pagination with an atomic v11→v12 metadata migration, and session-owner coverage extended to `approvals` / `media` / world-sync / `ui-specs`.

## [0.0.14] - 2026-07-13

The agent-core release. Server-side plugin registration converges into a single `entry` factory (`covel.registerTool / on / registerRpc / registerWires`), players can steer or abort a turn while the LLM is still streaming, and a full-codebase audit hardened the turn/snapshot/fork consistency boundaries: proposal commits are now atomic under the session lock, auto snapshots capture post-commit state, forks restore session lifecycle from the snapshot itself, and outbound plugin fetches pin DNS resolution against rebinding.

### Added

- **Unified PluginAPI (`entry`).** The four scattered server-side registration surfaces (local tools, hooks, RPC actions, media wires) converge into one factory declared via the new `entry` PLUGIN.md field — `export default function (covel) { ... }` with `covel.registerTool / on / registerRpc / registerWires` and `covel.toolkit`. Agent runtimes declare LLM tool visibility with the new `tools.plugin` name list. All 8 bundled plugins with server-side registrations migrated; legacy fields keep working for one release cycle with a per-plugin deprecation warning, and community entries still defer to activation (trust gating unchanged).
- **Mid-turn player steering + abort.** `POST /api/sessions/:id/steer` merges queued player interjections into story runtimes' next LLM step (persisted to history); `POST /api/sessions/:id/abort` cuts the in-flight LLM stream immediately, is non-retriable, bypasses the streaming salvage path (no partial narrative is ever committed), and surfaces as `abortReason: "aborted-by-player"` on the existing `execution.completed` event. Both return 409 when no turn is active. The web composer stays usable during a turn — submit steers, a stop button aborts.
- **Snapshot payload schemaVersion 2.** Snapshots now capture session lifecycle and runtime configuration (`status`, `turnCount`, `preGameCompleted`, `locale`, `activePlugins`, `presetId`, `runtimeModelOverrides`), so forking an old snapshot restores the session as it was at capture time instead of inheriting the parent's current scheduling state. V1 snapshots remain readable and fork with the previous parent-fallback behaviour.

### Changed

- **Agent loop layering.** All how-to-run derivation (tool defs, schema gate, model override chain, streaming gate, step/retry budgets, `requireToolUse`, `acceptsSteering`) converges into `buildAgentLoopPolicy()`; the loop's single delta outlet is extracted into `createDeltaForwarder`. The loop body is control flow only and independently instantiable — pinned by a direct loop-core test suite (trace/delta sequences, runtime-done stripping, maxSteps, streaming gates, steer/abort/salvage-bypass).

### Fixed

- **Turn commits are atomic under the session lock.** Player-input persistence, turn execution, proposal commit, `turnCount` sync and the auto snapshot now run inside a single `sessionLock.withLock` scope, so an overlapping same-session action can no longer read pre-commit state (stale-read / lost-update). A bounded PG advisory-lock acquire timeout surfaces as a coded, retryable 503 instead of a generic 500.
- **Auto snapshots capture post-commit state.** Snapshot capture moved out of the turn finalizer (which ran before proposals committed) into the server pipeline after commit — forked sessions no longer inherit a turn's dialogue while missing that same turn's state, character and plugin-data writes.
- **Manual snapshots and forks share the session lock**, so payload reads can no longer observe a mixed point-in-time while a turn is committing.
- **Plugin uninstall honours the install privilege boundary.** `DELETE /api/plugins/:id` (which recursively deletes the plugin directory) now sits behind the same production opt-in / desktop bearer-token guard as install, instead of being callable by anyone who can reach the API.
- **Outbound plugin fetches pin DNS resolution.** SSRF validation previously only checked the literal hostname; a public name resolving to a private/metadata address passed. `fetchWithRetry` now resolves and policy-checks addresses per attempt and pins the connection to the validated address via an undici dispatcher (DNS-rebinding defence).
- **PR #18 review hardening.** Plugin tool-access allowlists only grant ownership after successful registration (tool-name collisions are rejected instead of leaving a dangling grant); the active turn registers inside the session lock so a queued action can no longer steal the steer/abort target; the web client clears its delta buffer and streaming placeholder on player abort (no ghost message).

## [0.0.13] - 2026-07-10

The Windows release. The dev environment (spawn shims, plugin loading, supervised `pnpm dev`) now works on Windows, and CI builds Windows installers alongside the macOS bundles on every tag. Public web-only (browser IndexedDB) deployments are hardened: the shared session listing is hidden and the Render blueprint pins the memory backend explicitly.

### Added

- **Windows desktop CI.** `release.yml` gains a `build-electron-win` job (windows-latest): full desktop build with Electron-ABI native rebuild, staged-server smoke under Electron's Node mode, `electron-builder --win` (NSIS + portable, x64, unsigned until a cert is configured), and `.exe` artefacts attached to GitHub Releases alongside the macOS bundles. Windows targets are x64-only: the staged server ships a better-sqlite3 rebuilt for the build host's arch, so an arm64 installer from an x64 runner would carry an addon the arm64 sidecar cannot load — Windows-on-ARM runs the x64 installer via emulation.

### Fixed

- **Windows dev environment.** Dev scripts spawn through `cross-spawn` (resolves `pnpm.cmd`-style shims with correct cmd.exe quoting); plugin/runtime dynamic imports of absolute paths go through `pathToFileURL` so plugin loading works on Windows; `pnpm dev` launches web + server directly with supervised teardown; `--env-file-if-exists` tolerates a missing `.env` (raises the minimum Node to 22.9).
- **Desktop staging smoke now exercises the Electron ABI.** The native rebuild runs before the smoke test and the staged server boots under `ELECTRON_RUN_AS_NODE`; a missing Electron binary fails the build instead of silently downgrading the check (`COVEL_SMOKE_HOST_NODE=1` opts into the weaker host-Node smoke).
- **Electron runtime binary is materialised explicitly.** electron@42 removed its postinstall hook, so `pnpm install` no longer downloads the binary into `node_modules/electron/dist` (whitelisting in `onlyBuiltDependencies` has nothing to run). The desktop build and dev shell now run `ensure-electron.mjs` first, which invokes electron's `install.js` when the binary is missing — without this, every desktop CI build died at the staging smoke on both macOS and Windows.
- **Public web-only hosting hardening.** On memory-backend production deploys without debug routes, `GET /api/session` returns an empty list — server-side sessions there are transient sync copies of browser-IndexedDB data, and the only callers of a shared listing would be other players. `render.yaml` pins `STORE_BACKEND=memory` explicitly (the sqlite default would pool every player's data in one shared DB), adds a health check, and disables the debug page; the Docker image regains the workspace manifests (`settings`, `plugin-handlers-utils`, and four plugins) missing from its dependency-install stage.

## [0.0.12] - 2026-07-06

The media-pipeline release. Speech joins images as a first-class framework primitive: `ctx.speech` gives function runtimes a unified TTS/STT surface with the same wire-selection, dedupe, and MediaStore-persistence guarantees as `ctx.images`, and every media modality (image / speech / transcription) now routes through pluggable per-modality wire registries. Plugins can ship vendor wires declaratively via the new PLUGIN.md `wires` field — supporting a new provider no longer requires touching bundled code.

### Added

- **`ctx.speech` — unified TTS/STT for function runtimes.** `generate()` synthesizes speech, dedupes on `sha256(presetId, text, voice, format)`, and persists through MediaStore; `transcribe()` accepts a `MediaRef` or raw bytes and returns plain text. Assembled under the same conditions as `ctx.images`; the plugin gateway and trace layer gain `synthesizeSpeech` / `transcribeAudio` passthroughs.
- **Plugin-declared media wires (PLUGIN.md `wires` field).** Plugins register image / speech / transcription wires declaratively; ids are namespaced `<pluginId>/<wireId>` and loading is trust-gated. Slots select wires via `providerRequestMetadata.imageWire|speechWire|transcriptionWire` in `llm.toml`.
- **Manifest diagnostics at bootstrap.** A declared capability tag sitting one edit away from a framework-known one now warns (a misspelled tag was previously just silently never discovered), as does a plugin whose frontmatter name root differs from its directory name (a mismatch silently denies the plugin its own local tools).

### Changed

- **Speech/transcription move from provider adapters to pluggable wires** (builtin `openai-speech` / `openai-transcription`), completing the per-modality wire registry started with images in 0.0.11.
- **Plugin handlers read plugin data exclusively through `ctx.pluginData`** — no more store-shape sniffing; trusted and community runtimes go through the identical scoped path. Empty `relations: {}` frontmatter dropped across all bundled plugins; runtime imports moved from devDependencies to dependencies where misfiled; world-init tests relocated to `tests/`, guide + pregame gain handler tests.
- **Web session view slimmed.** `game-view` reads session state from the session store instead of ~20 pass-through props; a shared `useSettingsDialog` hook replaces duplicated dialog state; UI primitives trimmed to the variants actually used.

### Fixed

- `video_generation` models derive a video output modality instead of being misclassified as text.
- Commit handlers reject `state.patch` / `event.emit` proposals with an empty table/field/topic instead of silently landing writes under `default`/`unknown` (JS plugins bypass the type layer, so the gate must live at commit time).
- `POST /api/media` (10 req/min) and session `plugin-rpc` (30 req/min) are rate-limited per IP — runtime-mode RPC dispatch runs a full LLM turn, the same cost class as `POST /api/actions`.

## [0.0.11] - 2026-07-04

The visual-novel release. A full-screen GalGame **stage mode** — scene backdrops, character sprites, typewriter dialog, choice overlays — built on three new framework layers: a unified event-emission layer (`events` contracts + `emit-event`), a first-class image-generation pipeline (`ctx.images` + pluggable wires), and the `scene-stage` plugin that resolves narrative locations into stage art and generates missing backdrops on demand, mid-session. Haruka Academy ships the full asset set and plays as a visual novel out of the box.

### Added

- **Stage mode (`viewMode: "stage"`).** A full-screen visual-novel view for Playing turns: crossfading scene backdrop, bottom-anchored character sprites with active-speaker highlight, a delta-driven typewriter dialog with paragraph pauses, a classic centered choice overlay (interaction choices + scene-prompts phrases + free input), a HUD (scene badge, history drawer, auto-play, immersive toggle), and a player-clean history drawer reusing `ChatMessages`. Worlds pick their default via the new `world.yaml` `defaultViewMode: stage | parsed`; players can switch any time. Sprite stationing is **sticky** — salience decides who is on stage and who is highlighted, never where anyone stands — and sprites render inside equal-width lanes, so occlusion is impossible by construction.
- **Unified event layer.** Plugin runtimes declare event contracts in frontmatter (`events: [{topic, schema, description, advertise}]`); emitting agents declare `advertiseEvents: true` and call the new builtin **`emit-event`** tool, whose payloads are schema-validated against the declaring plugin's contract with per-turn topic dedupe. A per-session event directory aggregates active plugins' contracts into the prompt (`<available-events>`), and deferred event followers are scheduled once per turn on the main loop. `narrator` / `chat-mode-narrator` emit `scene.set` as the reference implementation.
- **Framework image pipeline (`ctx.images` / `gateway.generateImage`).** One primitive for plugin image generation: wire selection (builtin `openai-images` and `dashscope-wan` submit+poll, extensible via `registerImageWire()`), MediaStore persistence, and promptHash dedupe all handled by the framework — handlers never touch bytes or provider credentials.
- **`scene-stage` plugin.** Resolves `scene.set` (location + day/night) against the world scene registry — exact, then fuzzy, then session-generated matches — writes `stage/current` for the stage backdrop, and queues background generation for unmatched locations behind player-tunable gates (`autoGenerateScenes`, `maxGeneratedScenes`). Night variants lazy-generate on first use and reuse the day image's visual hint.
- **Haruka Academy visual-novel asset set.** Ten scene backdrops (5 locations × day/night) plus regenerated transparent-background portraits, imported via new `worldData` media sources (`to: media` + `indexTo` + `key: filename`) and the `scenes.registry.json` / `presence.json` registries; `scripts/generate-scenes.mjs` + `scripts/emit-scenes.mjs` regenerate them from `scenes.json` specs.
- **`requireToolUse` manifest gate.** An agent runtime whose whole job is a tool call gets one corrective retry (locale-aware message) when it drifts into prose without calling anything; `scene-prompts` uses it.

### Changed

- **Media store simplified.** The unused S3 backend and its SQLite/PG metadata adapters are gone; media stores gain a shared `listByMetadata` filter. The imperative `beginTx/commitTx/rollbackTx` API and the empty `plugin_configs` table are removed (all writes go through `withTransaction`; existing databases are unaffected).
- **ai-provider slimmed.** Dead config loader, token estimator, and protocol-registry indirection removed; model capability resolution unchanged.
- **Desktop auto-updater removed** — releases install via the dmg; update checks return in a later cycle.
- **README rewritten** around stage mode with a fresh 6×-speed demo gif and play-mode stills; the `create-world` / `create-plugin` skills now document the VN feature set (defaultViewMode, asset pipeline, events contracts, `ctx.images`).

### Fixed

- `plugin-data.changed` SSE now fires **after** transaction commit (and never on rollback), so panels re-render exactly when data is durable.
- worldData sources targeting a plugin the player deselected are skipped with a warning instead of failing session creation with a 500; `indexTo` targets skip only the index writes.
- Stage polish batch: sprites no longer drift when the speaker or scene changes (sticky stations + lane geometry), stale `getSession` responses can't corrupt state after a session switch, the typewriter survives same-text turns and stream-end races, artless speakers keep a name-card on stage, execution errors surface on stage with retry, and choice overlays no longer cover sprites.
- A stuck "generating…" backdrop retries when the scene re-emits after a failed generation; DashScope image tasks that are CANCELED/UNKNOWN fail fast instead of polling to timeout.
- Duplicate deferred event followers are deduped per turn; enum values render in the event catalog; image cache hits stamp per-call metadata.

## [0.0.10] - 2026-06-29

A plugin-configuration pass: worlds can now preset any plugin's player-tunable settings and declare genre-specific memory dimensions, the player's per-plugin settings finally reach the scheduled turn loop, and the plugin config layer is consolidated onto a single declaration with server-enforced constraints. Behavior-unchanged for worlds and plugins that don't adopt the new fields.

### Added

- **World-preset plugin settings (`pluginSettings`).** A `world.yaml` can now declare per-plugin defaults for any plugin's `userSettings`, keyed `pluginId → settingKey → value`. They form the middle layer of a three-tier resolution chain — **player override → world default → manifest default** — merged at the turn boundary into `TurnInput.userSettings` and consumed by agent `{{ userSettings.* }}` templates, guards, and hooks. A dialogue world can ship "70% dialogue, short replies" as its default while players keep the freedom to override. See [`docs/reference/world-data.md`](./reference/world-data.md).
- **World-declared core-memory blocks (`memoryBlocks`).** A world can add genre-specific memory dimensions (a detective world's `clues` / `suspects`, a business sim's `deals` / `rivals`) without forking a plugin — same shape as a plugin's `memoryBlocks`. The memory system resolves the block schema **per session**, merging a session's world blocks onto the global plugin blocks (base wins on label collision; the world only adds new labels), so the extra dimensions render and extract only for the worlds that declare them. Closes the long-documented "(or by a world package)" gap.
- **`integer` / `slider` user-setting types**, and a consolidated **design-principles** page ([`docs/architecture/design-principles.md`](./architecture/design-principles.md)) that roots the framework's "kernel provides primitives, plugins carry gameplay" contract, the agent / function / composition writing styles, and the plug-vs-appliance test.
- **Character portraits + presence wiring for the flagship worlds.** Both worlds ship a curated portrait set (mistport fog-noir, haruka GalGame-style), generated via `scripts/generate-portraits.mjs` + `scripts/emit-presence.mjs` and wired to the `character-presence` plugin through `media` + `presence` world-data sources (content-addressed by sha256) — portraits render in the right-panel character card and as dialogue sprites. The two worlds also gained tuned plugin defaults (haruka: `activeSpeakerCount`, `npc-graph`; mistport: a `cost-gate` budget guardrail). Prompt spec in [`worlds/PORTRAITS.md`](../worlds/PORTRAITS.md); shipping contract in [`docs/reference/world-data.md`](./reference/world-data.md).
- **Hot-reload `llm.toml` without restarting.** Settings → LLM gains a **Reload config** button (`POST /api/llm-config/reload`) that re-reads `llm.toml` and applies it to the live gateway in place — the provider / preset / slot registries are _reconfigured_ rather than rebuilt, so the gateway and every adapter pick up added/removed slots without a restart. A malformed `llm.toml` (e.g. a key with `=` and no value) no longer fails silently: the file still falls back to the built-in default, but the parse error is now surfaced via the new `error` field on `GET /api/llm-config` and a red banner in Settings — instead of every plugin's slot just showing as "missing" with no explanation. On desktop the reload endpoint is gated by the same one-time REST token as other config writes. See [`docs/guide/desktop-config.md`](./guide/desktop-config.md).
- **Character portraits show as avatar badges in the character list.** Each row in the char-creator character panel now leads with the character's portrait as a small avatar badge, via a new generic `CharacterAvatar` json-render component. It reads presence records from a source plugin/namespace named in the spec (char-creator wires it to `character-presence` / `presence`) — keeping the framework component free of any hard-coded plugin id, mirroring how `ImageGallery` takes its `pluginId` by prop. Matching tolerates the `<sessionId>-<characterId>` ids the character list uses against the bare `characterId` the presence records key on. Characters without a portrait — and entire worlds without presence data — render exactly as before: the badge simply doesn't appear.
- **Worlds can declare character attributes with i18n labels (`characterAttributes`).** `AttributeDefinition.name` / `description` now accept an `I18nText` (plain string or `{ "zh-CN": …, "en-US": … }` record), and a `world.yaml` can ship its own `characterAttributes` array. `world-init`'s guard writes it **verbatim** as the session's `character-attributes` schema — and does so _authoritatively_, ahead of cross-session reuse, so editing the declaration takes effect on new sessions instead of inheriting an older session's stale/derived schema. The right-panel character card resolves each label to the UI locale (`resolveI18nText`), and the prompt-injected `<world-schema>` is deep-resolved to one language too (`resolveI18nDeep`), so a custom field like Haruka's `affection` shows as **好感度 / Affection** instead of a raw `affection` key under "其他". Both flagship worlds now declare their cast fields (mistport: faction / role / tideSense / fogRot / …; haruka: club / affection / trust / …) with bilingual labels. Worlds that declare nothing are unchanged — the guard still derives generic attributes from dimensions, then falls back to the LLM. See [`docs/reference/world-data.md`](./reference/world-data.md) and [`docs/reference/plugins.md`](./reference/plugins.md#world-initschema-gen).
- **Click-to-enlarge for portraits, avatars, and generated images.** The image-generation gallery's preview was extracted into a generic `MediaPreviewDialog`. The json-render `Image` component gains a `zoom` prop, the character-portrait gallery and the character-list avatar badges opt into it, and the image gallery now delegates to the same dialog — one enlarge + download surface everywhere. The avatar badge stops its click from also toggling the surrounding collapsible card. The `Image` component also gains a `framed` prop (rounded bordered card + hover) so the portrait gallery's thumbnails match the image-generation gallery's cards — the two read as one family. The enlarge view is a tight lightbox that hugs the image (`w-auto`) rather than a wide dialog with the image floating in empty space.
- **`branch-reply` reply-swipe revived as a real feature.** The GalGame "swipe between AI replies" plugin shipped active in both default worlds but was a permanently-invisible dead feature — a bootstrap deadlock where the only candidate-writer lived behind a button inside a block that never rendered. It is now a working auto-seeded swipe: after each story turn it captures the narrator's reply as the original (engine-agnostic — discovered via the narrative-output contract, no hardcoded `narrator` / `chat-mode-narrator` id), and a **Regenerate** control produces genuine LLM-generated alternative phrasings (fast slot, session locale) the player can compare and **Accept** to rewrite prompt history. The original is never re-rendered as a card, so a reply never appears twice; the old English deterministic filler is gone.

### Changed

- **One plugin-config declaration.** `userSettings` is now the single source for player-tunable plugin settings; the dead, never-consumed `config` manifest field is removed. A straggler `PLUGIN.md` that still declares `config:` is stripped with a deprecation warning rather than failing to load. The `PluginUserSettingSpec` type is single-sourced in `@covel/shared` (two divergent copies removed), and its declared constraints (`min` / `max` / `options` / type) are now enforced — client-side in the SettingsStore **and server-side** in `resolveUserSettings`, so an out-of-range world or header value degrades to the manifest default instead of reaching a guard or hook.
- **Plugin selection consolidated into `pluginPolicy`.** The deprecated top-level `requiredPlugins` / `recommendedPlugins` / `excludedPlugins` now fold (de-duplicated) into `pluginPolicy` at world-load time, so `WorldRecord.metadata` carries plugin selection in one place. The top-level fields remain valid in `world.yaml` for back-compat. Per-turn world reads are served from a short-TTL per-`worldId` cache.
- **Sample worlds curated to two deeply-built flagships.** The bundled set is now **Mistport** (traditional-story / dark-fantasy mystery) and **Haruka Academy** (dialogue / GalGame-style), each greatly expanded and doubling as the canonical example of the new fields. Mistport gains a seven-character seed cast, a fourth faction, bilingual lore, and `clues` / `relics` / `tides` memory blocks; Haruka grows to eight characters across five routes with `relationships` / `promises` / `rumors` / `festival` memory. The redundant `cloudmere` and `neonridge` story worlds move to `worlds/_archive/` (kept for reference, not loaded).

### Fixed

- **Player per-plugin settings now actually reach the main turn loop.** `POST /api/actions` (and the resume / plugin-rpc paths) never decoded `X-Plugin-User-Settings`, so in the scheduled loop every runtime's `userSettings` collapsed to manifest defaults — a player's UI-tuned values (chat-mode-narrator's `dialogueRatio`, cost-gate's token caps) were silently ignored while only the manual plugin-rpc path honored them. The main route now decodes the header and merges it with the world defaults.
- **The settings header no longer masks world defaults.** `X-Plugin-User-Settings` was built from every _registered_ plugin setting (`store.get()` returns the manifest default for untouched keys), so it always carried a full bucket of defaults that, sent as "player overrides," overrode the new world `pluginSettings` layer. It now carries only the keys a player explicitly set (`store.has()`).
- **Archived bundled worlds no longer linger in existing users' databases.** `seedWorlds` only ever upserts, so a sample world removed from the bundle (e.g. `cloudmere` / `neonridge`) stayed seeded in every existing user's DB and kept showing in the world list. The server now runs a reconciliation pass after seeding that drops file-seeded worlds no longer present in any world source. Three safety rails keep it from ever removing real data: it only touches `metadata.source === "file"` worlds (AI-generated `generated` / `generated-file` worlds are never touched), it keeps any stale world that still has saved sessions (warned, never silently deleted), and it skips entirely when nothing seeded so a transient load failure can't wipe worlds. See [`docs/reference/world-data.md`](./reference/world-data.md).
- **Plugin provider-slot overrides are honored in the prep screen.** A function-runtime plugin (e.g. image generation) names its provider slot through the `modelPresetId` userSetting. The session-prep row read only that setting's _manifest default_, so it always displayed the default slot — flagging it red as "missing [covel.&lt;default&gt;]" even when the player had a perfectly good slot of the same kind configured, with no way to point the plugin at it short of editing Settings → Plugins. The row now reflects the player's _effective_ value and offers an inline slot picker; choosing a configured slot clears the warning, and the override reaches the function runtime via the (now-honored) `X-Plugin-User-Settings` header. See [`docs/guide/desktop-config.md`](./guide/desktop-config.md).
- **Creating a world that ships portraits no longer 500s on SQLite (`database is locked`).** `POST /api/sessions` wraps `createSession` + world-data import in a single `withTransaction`. With `STORE_BACKEND=sqlite`, the mirror media store opened a _second_ connection to the same `covel.db`, so materializing the world's bundled portraits inside that open write transaction deadlocked against the transaction's own lock — `SQLITE_BUSY`, surfaced as a generic 500 after the 5s busy-timeout. The SQLite DataStore and its mirror media store now share one refcounted connection per file, so media writes join the open transaction and commit atomically with the session (the intended behavior) instead of fighting it. Worlds without media were unaffected; this only bit the new portrait-carrying flagship worlds.
- **Imported character portraits now actually render.** The portrait/presence wiring stored the data (sha256-addressed images + presence records), but the `character-presence` right panel only dumped the raw presence JSON — a wall of sha256 ids with no `<img>` anywhere, so players couldn't see the art. The panel now renders a portrait gallery at the top (`repeat` over the presence entries → one `Image` per character, captioned by `displayName`), and is surfaced as its own **Character Portraits** (`角色立绘`) tab right after the character list — instead of being buried as one of four providers inside the shared `chat-mode` ("对话") group tab, where it was effectively unfindable. Worlds without portraits degrade cleanly: an empty presence list shows no gallery, and a character missing an avatar falls back to the built-in "no image" placeholder tile — no broken images, no errors. The panel spec re-materializes on `GET /api/ui-specs`, so existing sessions pick it up on the next reload without starting over. The player-facing tab no longer exposes the world-author import form (which made you hand-enter an image's sha256 id / MIME / byte size). It's now a custom `PortraitGallery` component: each portrait is a framed click-to-enlarge thumbnail with a **hover-to-replace** action — the player just picks an image file, which uploads via the new `POST /api/media?sessionId=` (session-owned, content-addressed) and is written back as the character's presence through the plugin's own runtime. No internal fields, no JSON. World authors still bulk-import portraits via the world package (`presence` + `media` sources).
- **Desktop media (portraits, generated images) no longer fails to load.** The packaged desktop sidecar runs with `NODE_ENV=production`, where the server refuses to mint media-access tokens from an ephemeral per-process secret — but the shell only provisioned the REST bearer token, never `COVEL_MEDIA_TOKEN_SECRET`. So `GET /api/sessions/:id/media-token` 500'd and every `<Media>` (character portraits, image-gen output) showed a "media unavailable" placeholder despite the bytes being on disk. The desktop shell now generates a per-launch media-token secret and injects it (a user-set `COVEL_MEDIA_TOKEN_SECRET` via process env / a repo `.env` still wins). Tokens are 5-minute TTL and re-requested by the renderer, so per-launch rotation is invisible.
- **Non-dialogue panels no longer hide under a "Chat Mode" tab.** `character-blueprint` (preset characters), `living-world-rules` (world rules), and `player-identity` (player voice) each declared `group: "chat-mode"`, so their panels merged into one tab literally labeled "对话" / Chat Mode in every world — jarring in a traditional-story world like Mistport, which doesn't run dialogue mode at all. They are now their own clearly-labeled tabs (`预设角色` / `世界规则` / `玩家口吻`); the genuinely dialogue-only panels (`scene-cast` / `scene-prompts`) keep the chat-mode group. Mistport also drops `character-blueprint` from its recommended set — a dialogue-mode cast-authoring tool that overlaps `char-creator` for traditional story.
- **World dimensions are localized before they reach the narrator's prompt.** A dimension's i18n leaves (`{ zh, en }` faction names, descriptions, tone, opening scenario, …) were injected into `{{ world.dimensions }}` as a raw bilingual blob — wasting tokens and risking language-mixing — while `lore` was already locale-resolved at load. `buildWorldContextView` now deep-resolves the dimensions to the session locale (new shared `resolveI18nDeep`), so the narrator (and `world-init/schema-gen`) see one language. As a bonus, `tone` / `openingScenario` now extract correctly when authored as i18n records (the old `typeof === "string"` check silently skipped them).
- **Plugin UI/UX coherence pass (multi-agent audit).** A systematic review of every bundled plugin's panel ↔ context ↔ tool wiring fixed a cluster of coordination defects where the player saw one thing while the model saw another, or a control did nothing:
  - **Character defaults persist at the write boundary.** New `mergeSchemaDefaults` merges declared schema `defaultValue`s into stored `fields` in both `create-character` and the player-init guard, so the panel (which overlaid defaults at render), the model's `get-character`, and the prompt context finally agree — previously the panel showed `hp 100/100` that existed in neither the record nor the prompt.
  - **`scene-cast` `activeSpeakerCount` knob works.** It was declared on `chat-mode-narrator` (a different plugin scope), so the slider never reached the plugin that enforces cast size (hard-capped at 2) while the narrator was told a count the cast never matched. The setting moved onto `scene-cast`; the narrator defers to the injected `<active-cast>`.
  - **`living-world-rules` no longer silently drops rules.** A `triggered`/`evolving` rule saved without keywords mapped to a keyword-gated lorebook entry that never activated, yet showed as enabled. Only keyword-bearing `triggered` rules are now keyword-gated; everything else is always-on.
  - **`cost-gate` aborts are visible.** A hard-budget abort on the main turn emitted an empty `execution.completed` with no signal; it now carries `abortReason` (protocol + SSE + UI) so the player gets a reason instead of a silent empty turn.
  - **`chat-mode-narrator` stops double-injecting** the active-cast and NPC-relationship context each turn (inline `{{ inputs }}` + `input.inject` both appended it).
  - **Player-facing surfaces de-jargoned.** The raw-JSON "full import" textareas (player-identity / living-world-rules / character-blueprint) and the raw `JsonView` "saved …" dumps were replaced with structured cards (a new generic `EntryCard` `isActive` badge marks the active player voice); the dead `codex` `ui.message` spec and the redundant raw-JSON `world-entries` tab were removed.
  - **Runtime-written strings are localized.** Labels/prose written by tools/hooks bypassed the i18n gate and rendered Chinese for en players — scene-prompts / guide badge labels (now I18nText), the director preamble + pregame welcome (now `ctx.locale`-resolved), and `chat-mode-narrator`'s prompt body (added `PLUGIN.en.md`). `check-plugin-i18n` was extended to scan handler `.js` `label`/`title`/`placeholder` literals so the class can't regress (it caught a real pregame leak).
  - **`memory.character_relationships` re-scoped** to player-centric bonds so it complements rather than duplicates `npc-graph`'s NPC↔NPC graph (a careful check showed a naive merge would have regressed player-relationship continuity).

<details>
<summary>中文（备份翻译）</summary>

一次插件配置整理：世界现在能为任意插件预置玩家可调设置、声明题材专属的记忆维度，玩家的 per-plugin 设置终于进入主回合循环，插件配置层收敛为单一声明并在服务端强制约束。未采用新字段的世界与插件行为不变。

**Added**

- **世界预置插件设置（`pluginSettings`）**：`world.yaml` 现在可为任意插件的 `userSettings` 声明默认值，键为 `pluginId → settingKey → value`。它是三层解析链的中间层——**玩家覆盖 → 世界默认 → manifest 默认**——在回合边界合并进 `TurnInput.userSettings`，供 agent `{{ userSettings.* }}`、guard、hook 共用。对话世界能把"70% 对话、短回复"作为默认，玩家仍可覆盖。见 [`docs/reference/world-data.md`](./reference/world-data.md)。
- **世界声明核心记忆块（`memoryBlocks`）**：世界可添加题材专属记忆维度（侦探世界的 `clues` / `suspects`、商战的 `deals` / `rivals`），无需 fork 插件——字段形状与插件 `memoryBlocks` 一致。记忆系统**按 session** 解析块 schema，把该会话所属世界的块合并到全局插件块之上（标签冲突基础块优先、世界只新增），使额外维度只在声明它的世界里渲染与抽取。兑现长期文档承诺的 "(or by a world package)"。
- **`integer` / `slider` 用户设置类型**，以及一页收敛的**设计原则**（[`docs/architecture/design-principles.md`](./architecture/design-principles.md)），确立"内核提供原语、插件承载玩法"的契约、agent / function / 组合三种写法、以及"插头 vs 电器"裁决测试。
- **旗舰世界的角色立绘 + presence 接线**：两个世界各自交付一套精选立绘（mistport fog-noir、haruka GalGame 风），由 `scripts/generate-portraits.mjs` + `scripts/emit-presence.mjs` 生成，并通过 `media` + `presence` 世界数据 source（按 sha256 内容寻址）接入 `character-presence` 插件——立绘在右侧角色面板与对话立绘中显示。两个世界还预置了调优的插件默认值（haruka：`activeSpeakerCount`、`npc-graph`；mistport：`cost-gate` 预算护栏）。提示词规范见 [`worlds/PORTRAITS.md`](../worlds/PORTRAITS.md)，交付契约见 [`docs/reference/world-data.md`](./reference/world-data.md)。
- **热重载 `llm.toml`，无需重启**：Settings → LLM 新增「重载配置」按钮（`POST /api/llm-config/reload`），重读 `llm.toml` 并原地应用到运行中的 gateway —— provider / preset / slot registry 是**重新配置而非重建**，所以 gateway 与所有 adapter 立即看到新增/删除的 slot，无需重启。`llm.toml` 写错（如某个 key 有 `=` 却无值）不再静默失败：文件仍回退内置默认，但解析错误现在通过 `GET /api/llm-config` 新增的 `error` 字段 + Settings 顶部红色提示暴露出来——而不是只让每个插件的 slot 显示「缺少」却不知为何。桌面版该接口受与其他写接口相同的一次性 REST token 保护。见 [`docs/guide/desktop-config.md`](./guide/desktop-config.md)。
- **角色列表里直接显示立绘头像角标**：char-creator 角色面板每一行现在以角色立绘的小头像角标开头,通过新增的通用 `CharacterAvatar` json-render 组件实现。它从 spec 指定的来源插件/namespace 读 presence 记录(char-creator 把它接到 `character-presence` / `presence`)——框架组件里不硬编码任何插件 id,与 `ImageGallery` 用 prop 接收 `pluginId` 同理。匹配兼容角色列表用的 `<sessionId>-<characterId>` 与 presence 记录用的裸 `characterId`。没有立绘的角色、以及完全没有 presence 数据的世界,渲染和以前一模一样:角标不出现而已。
- **世界可声明带 i18n 标签的角色属性（`characterAttributes`）**：`AttributeDefinition.name` / `description` 现在接受 `I18nText`（字符串或 `{ "zh-CN": …, "en-US": … }`），`world.yaml` 可自带 `characterAttributes` 数组。`world-init` 的 guard 把它**原样**写成 session 的 `character-attributes` schema，并且**优先于跨 session 复用**——所以编辑声明会在新 session 生效，而不会继承旧 session 推导/过时的 schema。右栏角色卡按界面语言解析每个标签（`resolveI18nText`），注入 prompt 的 `<world-schema>` 也被深度解析成单一语言（`resolveI18nDeep`），于是 Haruka 的 `affection` 这类自定义字段显示为 **好感度 / Affection**，而不是落在「其他」里的原始键 `affection`。两个旗舰世界已声明各自的角色字段（mistport：faction / role / tideSense / fogRot / …；haruka：club / affection / trust / …）并带双语标签。未声明的世界行为不变——guard 仍从 dimensions 推导通用属性，再回退到 LLM。见 [`docs/reference/world-data.md`](./reference/world-data.md) 与 [`docs/reference/plugins.md`](./reference/plugins.md#world-initschema-gen)。
- **立绘、头像、生成图都可点击放大**:把图像生成画廊的预览抽成通用 `MediaPreviewDialog`。json-render `Image` 组件新增 `zoom` 属性,角色立绘画廊与角色列表头像角标都启用它,图像画廊也改为复用同一个 dialog——放大 + 下载到处一致。头像角标会阻止点击冒泡,避免顺带折叠外层卡片。`Image` 组件还新增 `framed` 属性(圆角边框卡片 + hover),让立绘画廊的缩略图和图像生成画廊的卡片视觉一致——看起来像一家人。放大视图是贴合图片的紧凑 lightbox(`w-auto`),而不是图片浮在大片空白里。
- **`branch-reply`「换一个回复」复活为可用功能**:这个 GalGame「在 AI 回复间滑动切换」的插件随两个默认世界发布,却是永久不可见的死功能——自举死锁:唯一写候选的入口藏在一个永不渲染的块里的按钮后。现在是真正可用的自动 seed 滑动:每个叙事回合把 narrator 的回复捕获为「原始」(引擎无关——按叙事输出契约发现,不硬编码 `narrator` / `chat-mode-narrator` id),**重新生成**控件用 LLM(fast slot、会话语言)产出真实的不同说法供对比,**采纳**后重写 prompt 历史。原始回复不会被再渲染成卡片,所以一条回复绝不出现两次;旧的英文死板填充已删除。

**Changed**

- **单一插件配置声明**：`userSettings` 现为玩家可调设置的唯一来源；死的、从未被消费的 `config` manifest 字段被移除。仍声明 `config:` 的旧 `PLUGIN.md` 会被 strip + 弃用警告，而非加载失败。`PluginUserSettingSpec` 类型在 `@covel/shared` 单一来源（移除两份发散副本），其声明的约束（`min` / `max` / `options` / type）现已强制——前端 SettingsStore **与服务端** `resolveUserSettings`，越界的世界 / header 值降级为 manifest 默认而非进入 guard 或 hook。
- **插件选择收敛进 `pluginPolicy`**：过期的顶层 `requiredPlugins` / `recommendedPlugins` / `excludedPlugins` 在加载时折叠（去重）进 `pluginPolicy`，使 `WorldRecord.metadata` 的插件选择单一来源。顶层字段在 `world.yaml` 仍兼容。每回合的世界读取由短 TTL 的 per-`worldId` 缓存服务。
- **示例世界精选为两个深度打磨的旗舰**：内置世界现为 **Mistport（雾港·裂潮纪，传统叙事 / 黑暗奇幻悬疑）** 与 **Haruka Academy（遥风学园，对话 / GalGame 类）**，各自大幅扩充，并成为新字段的范例。Mistport 新增七名种子角色、第四派系、双语 lore 与 `clues` / `relics` / `tides` 记忆块；Haruka 扩到八名角色、五条线，配 `relationships` / `promises` / `rumors` / `festival` 记忆块。冗余的 `cloudmere` 与 `neonridge` 故事世界移入 `worlds/_archive/`（保留参考，不加载）。

**Fixed**

- **玩家 per-plugin 设置现在真正进入主回合循环**：`POST /api/actions`（及 resume / plugin-rpc 路径）此前从不解码 `X-Plugin-User-Settings`，主循环里每个 runtime 的 `userSettings` 退化为 manifest 默认——玩家在 UI 调的值（chat-mode-narrator 的 `dialogueRatio`、cost-gate 的 token 上限）被静默忽略，仅手动 plugin-rpc 路径生效。主路由现在解码 header 并与世界默认合并。
- **设置 header 不再掩盖世界默认**：`X-Plugin-User-Settings` 此前由**全部已注册**插件设置构建（`store.get()` 对未设项返回 manifest 默认），所以总是携带一堆默认值，当作"玩家覆盖"盖掉新的世界 `pluginSettings` 层。现在只携带玩家显式设过的键（`store.has()`）。
- **被归档的内建世界不再残留在老用户库里**：`seedWorlds` 只 upsert，从包里移除的示例世界（如 `cloudmere` / `neonridge`）会在每个老用户库里继续 seed 并出现在世界列表。服务器现在在 seed 后跑一次收敛，删除"已不在任何世界源里"的文件 seed 世界。三重安全栏确保绝不误删真实数据：仅触碰 `metadata.source === "file"` 的世界（AI 生成的 `generated` / `generated-file` 永不触碰）、仍有存档的陈旧世界保留（打 warn、绝不静默删）、本次没 seed 成任何世界时整体跳过，使瞬时加载故障无法清空世界。见 [`docs/reference/world-data.md`](./reference/world-data.md)。
- **插件 provider-slot 覆盖在开局准备界面生效**：function-runtime 插件（如图像生成）通过 `modelPresetId` userSetting 指定其 provider slot。开局准备界面此前只读这个设置的 **manifest 默认值**，所以永远显示默认 slot —— 即使玩家明明配了可用的同类 slot，也会标红「缺少 [covel.&lt;默认&gt;]」，且除了去 Settings → Plugins 改外无法就地指定。现在该行反映玩家的**有效覆盖**并提供就地下拉选择；选中一个已配置的 slot 即可消除警告，覆盖值通过（本版已修复的）`X-Plugin-User-Settings` header 传到 function runtime。见 [`docs/guide/desktop-config.md`](./guide/desktop-config.md)。
- **创建带立绘的世界不再在 SQLite 上 500（`database is locked`）**：`POST /api/sessions` 把 `createSession` + 世界数据导入包在一个 `withTransaction` 里。`STORE_BACKEND=sqlite` 时,镜像 media store 对同一个 `covel.db` 开了**第二个连接**,于是在这个写事务进行中物化世界的立绘,就和事务自己的写锁死锁 —— `SQLITE_BUSY`,5 秒 busy-timeout 超时后报成笼统的 500。现在 SQLite DataStore 与其镜像 media store **按文件共享一个带引用计数的连接**,media 写并入打开的事务、随 session 原子提交（设计本意如此）,而非与之争锁。无媒体的世界不受影响;只有新的带立绘旗舰世界会触发。
- **导入的角色立绘现在真的会显示**：立绘/presence 接线把数据(sha256 寻址的图片 + presence 记录)落了库,但 `character-presence` 右侧面板只把 presence 原始 JSON 倒出来——一堆 sha256 字符串、全程没有一个 `<img>`,玩家根本看不到图。面板现在在**顶部**渲染立绘画廊(`repeat` 遍历 presence 条目 → 每个角色一个 `Image`,以 `displayName` 标注),并作为**独立的「角色立绘」tab** 排在角色列表正后面——而不是被并进共享的 `chat-mode`(「对话」)组 tab、当成四个 provider 之一藏在 provider 切换后面(那样根本找不到)。没有立绘的世界优雅降级:presence 为空则不显示画廊,缺 avatar 的角色回退到内置「no image」占位块——不裂图、不报错。面板规格在 `GET /api/ui-specs` 时重新物化,所以已有 session 下次 reload 就能看到、无需重开。玩家面板不再暴露世界作者的导入表单(那个让你手填图片 sha256 编号 / MIME / 字节大小的东西)。现在是一个自定义 `PortraitGallery` 组件:每张立绘是带边框、可点击放大的缩略图,hover 出现「替换」——玩家直接选一张图片,经新增的 `POST /api/media?sessionId=`(会话所有、内容寻址)上传,再通过插件自己的 runtime 写回为该角色的 presence。没有内部字段、没有 JSON。世界作者仍可通过世界包(`presence` + `media` source)批量导入。
- **桌面端媒体(立绘、生成图)不再加载失败**:打包桌面 sidecar 以 `NODE_ENV=production` 运行,此时服务端拒绝用临时的 per-process secret 签发媒体访问 token——但桌面壳只注入了 REST bearer token,从没注入 `COVEL_MEDIA_TOKEN_SECRET`。于是 `GET /api/sessions/:id/media-token` 报 500,尽管字节就在磁盘上,所有 `<Media>`(角色立绘、图像生成产物)都显示「media unavailable」占位。桌面壳现在每次启动生成一个媒体 token secret 并注入(用户通过 process env / 仓库 `.env` 自设的 `COVEL_MEDIA_TOKEN_SECRET` 仍优先)。token 是 5 分钟 TTL、由前端重新请求,所以每次启动轮换无感知。
- **非对话面板不再藏在「对话」tab 下**:`character-blueprint`(预设角色)、`living-world-rules`(世界规则)、`player-identity`(玩家口吻)各自都声明了 `group: "chat-mode"`,于是在每个世界它们的面板都被并进一个字面叫「对话」的 tab——在像 Mistport 这样根本不跑对话模式的传统叙事世界里很违和。现在它们各自成为名字清晰的独立 tab(`预设角色` / `世界规则` / `玩家口吻`);真正只属于对话模式的面板(`scene-cast` / `scene-prompts`)保留 chat-mode 分组。Mistport 还把 `character-blueprint` 从推荐插件里移除——它是对话模式的角色预设工具,在传统叙事里和 `char-creator` 重叠。
- **世界维度在进入 narrator 的 prompt 前就按语言解析好**:维度的 i18n 叶子(`{ zh, en }` 的派系名/描述/基调/开场等)此前以**原始双语 JSON** 注入 `{{ world.dimensions }}`——浪费 token 还可能让模型串语言;而 `lore` 早就在加载时按语言解析了。现在 `buildWorldContextView` 用新增的共享 `resolveI18nDeep` 把维度深度解析到 session 语言,narrator(及 `world-init/schema-gen`)只看到一种语言。附带:`tone` / `openingScenario` 用 i18n 记录写时现在也能正确提取(旧的 `typeof === "string"` 判断会静默跳过它们)。
- **插件 UI/UX 协同审查(多 agent 审计)**:对全部内建插件「面板 ↔ 上下文 ↔ 工具」接线的系统性审查,修复了一批「玩家看到的与模型看到的不一致、或某个控件根本不起作用」的协同缺陷:
  - **角色默认值在写入边界落库**:新增 `mergeSchemaDefaults`,在 `create-character` 与 player-init guard 把 schema 的 `defaultValue` 合并进存库 `fields`,使面板(渲染时叠加默认)、模型 `get-character`、prompt 上下文三者一致——此前面板显示的 `hp 100/100` 在存库记录和 prompt 里都不存在。
  - **`scene-cast` 的 `activeSpeakerCount` 旋钮可用了**:它此前声明在 `chat-mode-narrator`(另一个插件作用域),滑块永远到不了真正裁剪 cast 的插件(恒为 2),而 narrator 却被告知一个 cast 永远达不到的人数。设置已移到 `scene-cast`;narrator 改以注入的 `<active-cast>` 为准。
  - **`living-world-rules` 不再静默丢规则**:`triggered`/`evolving` 规则不填关键词时会映射成关键词门控的 lorebook 条目、永不激活,却显示为 enabled。现在只有带关键词的 `triggered` 才门控,其余常驻。
  - **`cost-gate` 中止可见**:主回合的硬预算中止此前发出空的 `execution.completed` 且无任何信号;现在带 `abortReason`(protocol + SSE + UI),玩家会看到原因而非静默空回合。
  - **`chat-mode-narrator` 不再每回合双重注入** active-cast 与 NPC 关系上下文(正文内联 `{{ inputs }}` + `input.inject` 各一份)。
  - **玩家面板去术语化**:裸 JSON「完整导入」文本框(player-identity / living-world-rules / character-blueprint)和裸 `JsonView`「已保存…」倒数据,换成结构化卡片(新增通用 `EntryCard` `isActive` 角标标记当前生效的玩家口吻);删除了 codex 的死 `ui.message` spec 和与总览重复的原始 JSON `world-entries` tab。
  - **运行时写出的字符串本地化**:工具/hook 写出的标签/正文绕过 i18n 门禁、对 en 玩家显示中文——scene-prompts / guide 徽标(改 I18nText)、director 前言 + pregame 欢迎语(改 `ctx.locale` 解析)、`chat-mode-narrator` 正文(补 `PLUGIN.en.md`)。`check-plugin-i18n` 扩展到扫描 handler `.js` 的 `label`/`title`/`placeholder` 字面量以防回归(它抓到了一个真实的 pregame 泄漏)。
  - **`memory.character_relationships` 重新限定**为玩家中心的羁绊,与 `npc-graph` 的 NPC↔NPC 图谱互补而非重复(经仔细排查:盲目合并会退化玩家关系的连续性)。

</details>

## [0.0.9] - 2026-06-28

A playability-loop pass — function runtimes become visible in the trace timeline, stale suspensions expire, and player-input narrative localizes by session locale — plus a follow-up engineering batch: multi-node S3 media metadata on Postgres, plugin-utils provider-call tracing, a `/debug` cost panel, and community plugin uninstall/revoke. The default world and bundled plugins are behavior-unchanged.

### Added

- **Function-runtime trace coverage (A2-P1-5).** Function runtimes were near-invisible in `/debug` — nothing between `runtime.started`/`completed`, and zero rows for `ctx.gateway` provider calls. They now emit `function.executing` / `function.completed` (handler boundary) and, via a `withGatewayTrace` wrapper applied at execution time, `gateway.calling` / `gateway.responded` / `gateway.failed` for `generateText`/`generateObject` — all persisted to `trace_events` and broadcast, so a function runtime's LLM usage is as visible as an agent runtime's. The five events join the single-source `CovelEvent` union (compile-time exhaustive over `COVEL_EVENT_META` + the frontend switch). A missing handler now emits a terminal `runtime.failed` instead of leaving a hanging `runtime.started`.
- **Plugin-utils provider-call trace.** Closes the A2-P1-5 follow-up: image plugins (and any plugin owning its wire) call providers via `ctx.utils.fetchWithRetry`, which a `withUtilsTrace` wrapper now traces as `utils.fetch.calling` / `responded` / `failed` (trace-only, `forwardToActionStream:false`) at both the function-runtime and agent-guard injection sites. PII-safe — payloads carry only host / method / status / durationMs, never the full URL, query, or API key.
- **Multi-node S3 media metadata on Postgres.** `createPgS3MetadataAdapter` (+ `…FromClient`) implements the `S3MediaMetadataAdapter` interface over the shared `media_assets` / `media_refs` PG tables, so S3-backed media survives restarts and is shared across nodes — the SQLite adapter only covered a single node. Mirrors the SQLite adapter 1:1 and passes the same media-store contract suite against a real Postgres.
- **`/debug` token cost panel.** A new Cost view aggregates `usage` from `llm.responded` / `gateway.responded` trace events by runtime, by turn, and session-total (zero-dependency CSS bars), aggregating generically by event type + runtime id. _USD cost is a pending follow-up — `llm.responded` payloads don't yet carry the model id needed for `usage × pricing`._
- **Community plugin uninstall + approval revoke.** `DELETE /api/plugins/:id` removes a third-party plugin from the user plugins dir (rejects builtin ids, returns `restartRequired:true`); `DELETE /api/sessions/:id/approvals[?pluginId=]` revokes cached approval grants via the new `gate.revoke`. The Settings → Packages pane lists installed third-party plugins with an uninstall button. Closes the only missing stage of the community discover→approve→import→active lifecycle (the import stage was already live; docs were stale).

### Changed

- **`submit-form` is now locale-aware.** The `confirmation` `{{confirmed}}` value (确认/取消) and the fallback-narrative prefixes (`[玩家输入]` / `[玩家选择]` / `[玩家确认]` / `[玩家取消]`) were hardcoded Chinese; they now resolve by **session locale** (threaded in via a new `RpcHandlerContext.locale`, sourced from `session.locale` in the plugin-rpc dispatch — no executor change). `en-US` yields `Confirm`/`Cancel` + `[Player input]`/…; unknown locales fall back to zh-CN, byte-for-byte identical to the previous output. `submit-form`'s `Submission.type` now references the single-source `InteractionType` union.
- **Dependencies bumped to latest stable.** All workspace dependencies updated to their latest stable under the existing `minimumReleaseAge: 10080` (1-week) gate — including the major bumps `@hono/node-server` 1→2, `electron` 41→42, `@types/node` 25→26, `@json-render/*` 0.18→0.19, and `zod` 4.3→4.4. One breaking change handled: zod 4.4 treats a bare `z.unknown()` inside a `.strict()` object as a required key, so the plugin user-setting `default` field gained an explicit `.optional()`. Verified across the full workspace lint + test (incl. real Postgres), server boot, API e2e, and the desktop (electron 42) typecheck.
- **Dependency-hygiene gate + scaffold alignment.** Added `knip` as a CI `deps:check` gate (catches unused/missing workspace deps; understands JSDoc type imports + test files, so type-only/test-only deps aren't false-flagged), cleaned 12 stale plugin devDeps, and aligned the `@covel/create` scaffold to emit correctly-layered minimal deps per template. The authoring guide gains a dependency-layering + extraction-threshold section.

### Fixed

- Function runtimes no longer leave a hanging `runtime.started` when the handler is missing or throws — a terminal `runtime.failed` (and `function.completed{status:failed}`) is emitted on every exit path.
- **`/api/ui-specs` no longer 500s when one plugin's runtime fails to load.** A single bad runtime (corrupt UI spec, missing handler dep) used to take down the whole response on every world open; it is now logged and skipped while healthy plugins still resolve. `app.onError` additionally logs request context (method + full URL) for every 500.
- **Desktop packaging now stages plugin-only workspace deps.** 5 bundled function plugins depend on `@covel/plugin-handlers-utils` (used by plugins, never by `@covel/server`), which `pnpm deploy --filter @covel/server` left out — so every packaged build shipped them broken with `ERR_MODULE_NOT_FOUND`. The desktop build now scans each plugin's `@covel/*` runtime deps and stages any the server deploy missed; the post-staging smoke test fails on plugin-load errors instead of swallowing them.

<details>
<summary>中文（备份翻译）</summary>

一次可玩性闭环整理（function runtime 在 trace 时间线可见、陈旧挂起项过期、玩家输入叙事按会话 locale 本地化），外加一批工程收尾：Postgres 上的多节点 S3 媒体元数据、plugin-utils provider 调用 trace、`/debug` 成本面板、社区插件卸载/撤销。默认世界与内置插件行为不变。

**Added**

- **Function-runtime trace 覆盖（A2-P1-5）**：function runtime 此前在 `/debug` 几乎不可见——`runtime.started`/`completed` 之间空白，`ctx.gateway` provider 调用零记录。现在发射 `function.executing` / `function.completed`（handler 边界），并经执行期 `withGatewayTrace` 包裹对 `generateText`/`generateObject` 发 `gateway.calling` / `gateway.responded` / `gateway.failed`——全部持久化到 `trace_events` 并广播，使 function runtime 的 LLM 用量与 agent runtime 同等可见。五个事件纳入单一真相 `CovelEvent` union（对 `COVEL_EVENT_META` 与前端 switch 编译期穷尽）。缺失 handler 现在发终结 `runtime.failed`，不再留悬空 `runtime.started`。
- **Plugin-utils provider 调用 trace**：收尾 A2-P1-5 follow-up。图像插件（及任何自带 wire 的插件）经 `ctx.utils.fetchWithRetry` 调 provider，现由 `withUtilsTrace` 包裹器在 function-runtime 与 agent-guard 注入处 trace 为 `utils.fetch.calling` / `responded` / `failed`（trace-only，`forwardToActionStream:false`）。PII 安全——负载仅含 host / method / status / durationMs，绝不含完整 URL、query、api key。
- **Postgres 上的多节点 S3 媒体元数据**：`createPgS3MetadataAdapter`（+ `…FromClient`）在共享 `media_assets` / `media_refs` PG 表上实现 `S3MediaMetadataAdapter` 接口，使 S3 媒体跨重启存活、跨节点共享——此前 SQLite 适配器只覆盖单节点。1:1 镜像 SQLite 版，并对真实 Postgres 通过同一 media-store 契约套件。
- **`/debug` token 成本面板**：新增 Cost 视图，按 runtime / turn / 会话总计聚合 `llm.responded` / `gateway.responded` 的 `usage`（零依赖 CSS 条形），按事件类型 + runtime id 通用聚合。_美元成本为待办 follow-up——`llm.responded` 负载尚未携带 `usage × pricing` 所需的 model id。_
- **社区插件卸载 + 审批撤销**：`DELETE /api/plugins/:id` 从用户插件目录删除第三方插件（拒绝内置 id，返回 `restartRequired:true`）；`DELETE /api/sessions/:id/approvals[?pluginId=]` 经新增 `gate.revoke` 撤销缓存授权。Settings → Packages 面板列出已安装第三方插件并提供卸载按钮。收尾社区 discover→approve→import→active 生命周期唯一缺失的阶段（import 阶段早已实现，文档此前陈旧）。

**Changed**

- **`submit-form` 现按 locale 本地化**：`confirmation` 的 `{{confirmed}}` 取值（确认/取消）与回退叙事前缀（`[玩家输入]` / `[玩家选择]` / `[玩家确认]` / `[玩家取消]`）此前写死中文；现按**会话 locale** 解析（经新增的 `RpcHandlerContext.locale` 注入，来源是 plugin-rpc dispatch 的 `session.locale`，无需改 executor）。`en-US` 产出 `Confirm`/`Cancel` + `[Player input]`/…；未知 locale 回落 zh-CN，与改前输出逐字一致。`submit-form` 的 `Submission.type` 现引用单一真相 `InteractionType` union。
- **依赖升级到最新 stable**：全部 workspace 依赖在既有 `minimumReleaseAge: 10080`（1 周）门控下升到最新 stable——含跨 major 的 `@hono/node-server` 1→2、`electron` 41→42、`@types/node` 25→26、`@json-render/*` 0.18→0.19、`zod` 4.3→4.4。处理了一处 breaking：zod 4.4 把 `.strict()` object 内裸 `z.unknown()` 当作必填 key,故插件 user-setting 的 `default` 字段显式加 `.optional()`。已通过全 workspace lint + test（含真实 Postgres）、server 启动、API e2e 与 desktop（electron 42）typecheck 验证。
- **依赖卫生 gate + 脚手架对齐**：新增 `knip` 作为 CI `deps:check` 关卡（拦截 unused/missing workspace 依赖；识别 JSDoc 类型引用与测试文件，不误杀 type-only/test-only 依赖），清理 12 个 stale 插件 devDep，并让 `@covel/create` 脚手架按 template 生成正确分层的最小依赖。插件指南新增"依赖分层与复用规范"章节。

**Fixed**

- function runtime 在 handler 缺失或抛错时不再留悬空 `runtime.started`——每条退出路径都发终结 `runtime.failed`（及 `function.completed{status:failed}`）。
- **`/api/ui-specs` 不再因单个插件 runtime 加载失败而 500**：一个坏 runtime（损坏的 UI spec、缺失的 handler 依赖）此前会在每次打开世界时拖垮整个响应；现在记录并跳过,健康插件照常返回。`app.onError` 还会为每个 500 记录请求上下文（method + 完整 URL）。
- **桌面打包现在 stage 插件专属的 workspace 依赖**：5 个内置 function 插件依赖 `@covel/plugin-handlers-utils`（只被插件用、不被 `@covel/server` 用），`pnpm deploy --filter @covel/server` 把它漏掉了——导致每个打包版本都带着 `ERR_MODULE_NOT_FOUND` 的坏插件。桌面构建现在扫描每个插件的 `@covel/*` 运行时依赖并补 stage server deploy 漏掉的；打包后的 smoke test 现在会因插件加载失败而失败,不再静默吞掉。

</details>

## [0.0.8] - 2026-06-28

Eighth public release. Finishes the v0.0.7 architecture pass — clears the remaining audit debt, makes the schema and transaction layers single-source-of-truth, and ships **semantic (vector) memory recall**, all verified end-to-end against a real pgvector Postgres. New game genres can declare their own memory blocks, and a session can switch storage backends without any behaviour change. The default world and bundled plugins are behavior-unchanged.

### Added

- **Semantic (vector) memory recall.** The memory tier now embeds turn messages (recall) and lorebook + character records (archival) on write — a post-turn, best-effort sweep that never blocks the turn — and serves KNN recall over them, falling back to keyword search per-session when no embedding model is locked. Embed-on-write ingestion is incremental (a persisted cursor + content hashes) and self-heals deleted records; backfill of existing sessions runs in the same path. Wired through a single injected `embed` seam so `@covel/memory` still depends only on `shared` + `store`. Verified end-to-end on real pgvector Postgres.
- A real-pgvector `vector-store` contract branch (PgStore) — the production vector path (`upsertVector` / `searchVectors` / `deleteVectors` via the `vector` type + pgvector operators) now has automated coverage it previously lacked, plus a memory-vector × PgStore integration test.
- `@covel/settings` package — the unified `SettingsStore` + its platform backends (browser localStorage, Electron-IPC json-file) split out of `@covel/shared`, so pure-types consumers no longer pull in browser/Electron code.

### Changed

- **Store schema is now single-source-of-truth.** The boot DDL is derived at module load from the Drizzle schema (`buildCreateTablesSql`), so a column or index is declared once and the executed DDL can never drift from it; only the bits Drizzle can't model (triggers, idempotent column migrations) stay hand-written. Identifiers are quoted uniformly.
- **Transactions are scoped to a single commit.** Production turn-commit / session-create / world-data-sync / snapshot-fork callers moved from the global imperative `beginTx`/`commitTx` shim to `withTransaction(fn)` (real pooled-Postgres transactions; nested calls on serial backends are rejected, not deadlocked), removing the all-database serialization window.
- `runtime/src`'s 56 flat files are organized into 13 sub-domain directories (trigger / schedule / agent-loop / commit / session / trace / snapshot / rpc / resume / llm / retry / function-runtime); the public barrel is byte-identical.
- Cleared remaining v0.0.7 audit debt: priority-band literals collapse to `isPreGamePriority()` / `NARRATOR_PRIORITY`; the two frontend SSE channels share one event reducer; `CompactorLLMAdapter` + `MemoryLLMAdapter` converge into a shared `SimpleCompletionAdapter`; the Anthropic cache-breakpoint cap is one shared constant.
- **Removed the duplicate turn entrypoint.** `POST /api/sessions/:id/turn` was a mounted-but-frontend-unreachable second turn pipeline; `/api/actions` is now the single turn-execution route. Its tests migrated to `/api/actions`.
- Bumped all monorepo package versions `0.0.7` → `0.0.8`.

### Fixed

- **Cross-backend vector parity.** A real-PG vector contract immediately surfaced two PgStore-only bugs the Memory/SQLite backends hid: a `freshSchema` store kept stale rows because the dynamic `vec_mem_*` tables were not dropped, and the upsert/delete paths were untested. A fresh store now starts empty on every backend — the same data, the same API, switch backend freely.
- **memory recall data-loss / staleness.** The recall cursor no longer advances past a message that got an empty embedding (which would drop it from recall forever); short vector results during backfill are topped up with keyword hits so the most recent messages aren't missed; deleted lorebook/character vectors are purged instead of returned as stale hits.
- **Snapshot-fork orphaned media refs.** `mediaStore.addRef` (a cross-store write the DataStore transaction can't roll back) moved to run after the fork commits, so a rolled-back fork (e.g. the cursor-missing 409 path) can no longer leave an orphan ref.
- Postgres contract suite no longer races the system catalog under parallel runs (per-file database isolation + single-connection `freshSchema` DDL).

<details>
<summary>中文（备份翻译）</summary>

第八个公开版本。收尾 v0.0.7 的架构整理——清掉剩余审计债，让 schema 与事务层成为单一真相源，并交付**向量语义记忆召回**，全部用真实 pgvector Postgres 端到端验证。新游戏类型可声明自己的记忆块；一个会话可在不改变任何行为的前提下切换存储后端。默认世界与内置插件行为不变。

**Added**

- **向量语义记忆召回**：记忆层在写入时把 turn 消息（recall）与 lorebook + 角色记录（archival）embedding（回合后 best-effort sweep，绝不阻塞回合），并对其做 KNN 召回；未锁定 embedding 模型时按会话回退关键词检索。写入时 ingestion 增量（持久游标 + 内容哈希）、自愈已删记录、历史会话回填走同一路径。经单一注入的 `embed` seam 接入，`@covel/memory` 仍只依赖 `shared` + `store`。真实 pgvector Postgres 端到端验证。
- `vector-store` 契约新增 PgStore（真 pgvector）分支——生产向量路径此前零自动化覆盖，现已补上，外加 memory 向量 × PgStore 集成测试。
- `@covel/settings` 包——统一 `SettingsStore` 及平台后端（浏览器 localStorage、Electron-IPC json-file）从 `@covel/shared` 拆出，纯类型消费方不再被迫拖入浏览器/Electron 代码。

**Changed**

- **存储 schema 单一真相源**：boot DDL 在模块加载时由 Drizzle schema 派生（`buildCreateTablesSql`），列/索引只声明一次、执行的 DDL 不可能漂移；只有 Drizzle 无法建模的部分（触发器、幂等列迁移）保留手写。标识符统一加引号。
- **事务作用域绑定到单次提交**：生产的回合提交/建会话/world-data 同步/快照 fork 调用方从全局命令式 `beginTx`/`commitTx` 垫片迁到 `withTransaction(fn)`（真实 Postgres 池化事务；串行后端的嵌套被拒绝而非死锁），消除全库串行化窗口。
- `runtime/src` 的 56 个扁平文件整理进 13 个子领域目录；公开 barrel 逐字节不变。
- 清掉剩余 v0.0.7 审计债：priority band 字面量收成 `isPreGamePriority()`/`NARRATOR_PRIORITY`；前端两条 SSE 通道共用一个事件 reducer；`CompactorLLMAdapter` + `MemoryLLMAdapter` 合并为共享 `SimpleCompletionAdapter`；Anthropic 缓存断点上限收成单一常量。
- **移除重复的回合入口**：`POST /api/sessions/:id/turn` 是已挂载但前端不可达的第二条回合管线；`/api/actions` 现为唯一回合执行路由，其测试已迁移。
- 所有 monorepo 包版本 `0.0.7` → `0.0.8`。

**Fixed**

- **跨后端向量一致性**：真 PG 向量契约立刻暴露两个 Memory/SQLite 后端掩盖的 PgStore 专属 bug——`freshSchema` 的 store 因动态 `vec_mem_*` 表未被 drop 而残留旧数据，且 upsert/delete 路径未测。现在 fresh store 在每个后端都从空开始——同样的数据、同样的 API、自由切换后端。
- **memory 召回数据丢失/陈旧**：召回游标不再越过 embedding 为空的消息（否则永久丢失）；回填期向量结果不足时用关键词补足，不漏最近消息；已删 lorebook/角色向量被清除而非作为陈旧命中返回。
- **快照 fork 孤儿 media ref**：`mediaStore.addRef`（DataStore 事务回滚不了的跨 store 写）挪到 fork 提交后执行，回滚的 fork（如 cursor-missing 409）不再留下孤儿 ref。
- Postgres 契约套件在并行下不再竞争系统目录（每文件独立库 + 单连接 `freshSchema` DDL）。

</details>

## [0.0.7] - 2026-06-27

Seventh public release. An architecture-optimization pass over the kernel and store: duplicated contracts collapse to single, compile-time-enforced sources of truth; the SQLite and Postgres store query layers unify behind one shared adapter with cross-backend parity verified against a real Postgres; and a batch of latent correctness bugs are fixed. The default world and bundled plugins are behavior-unchanged.

### Added

- `memoryBlocks` manifest field + `MemoryBlockSchema`: core memory blocks are now declared as data by a plugin or world package (the default four — story state / relationships / scene / player profile — ship on the builtin `memory` plugin and are aggregated at bootstrap by trust tier). A new game genre can define its own blocks (`clues` / `suspects` / …) without forking the framework core
- cost-gate per-session token budget via `userSettings`, read in-hook through `HookContext.getOwnSettings()`, with a `COST_GATE_SOFT/HARD_TOKENS` env fallback for env-only deployments
- `/api/ui-specs` now validates each panel spec against a Zod schema with a `specVersion`, returns per-spec diagnostics instead of a generic error, and caches discovery by content signature instead of re-scanning + rewriting on every request
- A real-Postgres-verified store contract run (713 cases) plus new parity / drift-guard tests: proposal-type ↔ commit-handler ↔ discovery alignment, the SSE event union, hook events, DDL ↔ Drizzle index consistency, table-registry coverage, cross-backend null / `compactedAtTurnId` round-trip, and the prompt cache-breakpoint limit

### Changed

- **Single sources of truth (compile-time exhaustive).** Proposal types (payload map + discriminated union, handlers `satisfies Record<ProposalType, …>`), SSE events (one `CovelEvent` union driving the forward whitelist + an exhaustive frontend switch), hook events (`HOOK_EVENTS`), framework capabilities (typed registry), and provider protocols (`ProtocolRegistry`) each now live in one place — adding one is a single edit and a missing handler/case is a compile error
- **Store query layer unified.** The mirrored SQLite/Postgres record modules collapse behind one async `SqlRunner` (better-sqlite3's sync driver wrapped awaitable, postgres-js already async); SQLite snapshots / suspensions converted from hand-written SQL to drizzle, so the SQLite backend now has zero hand-written record SQL. Cascade-delete / drop-list / memory-snapshot table sets derive from a single table-registry, and `withTransaction(fn)` scopes a transaction to one commit (real pooled Postgres transaction; nesting on serial backends is rejected, not deadlocked)
- `DataStore`'s 82-method god-interface split into 21 domain sub-interfaces composed back into `DataStore` (shape unchanged); `gateway.ts`'s 7 operations collapse into one `runOperation`; `parsePluginMd`'s repeated lenient-field blocks become a data-driven table
- `LLMAdapter` / `LLMResponse` moved to `@covel/shared`, removing the only wrong-layer edge in the dependency graph (`create → runtime`)
- Trigger modes `conditional` / `error-retry` are explicitly marked **reserved** (they never fire in production); in-turn event fan-out reuses the single `shouldTrigger` authority
- Deleted the never-implemented `SessionTransport` interface and unused command-protocol types; pruned unwired prompt-assembler stubs; hoisted the Anthropic cache-breakpoint cap to a single shared `MAX_CACHE_BREAKPOINTS`
- memory recall / archival are now honestly documented as keyword-based — the vector primitives exist but the embed-on-write ingestion path does not, so a vector searcher would query empty tables; the swap seam is reserved and documented
- Bumped all monorepo package versions `0.0.6` → `0.0.7`; refreshed the README bundled-plugin table (16 → 19, adding `cost-gate` / `director` / `story-guard`)

### Fixed

- **Resume lost runtime resilience.** A suspended-then-resumed agent runtime bypassed retry / loop-detection / streaming (it called the LLM directly); resume now folds into the shared tool loop and goes through the same retry policy as a normal turn
- **Cross-backend data loss.** SQLite `appendTurnMessage` dropped `compactedAtTurnId` on insert while Postgres / memory / IDB persisted it; all backends now agree (pinned by a parity contract test). `createSession` / `updateSession` also serialize optional fields uniformly across backends
- Production Postgres now creates the `trace_events` `trace_id` / `turn_id` indexes (declared in Drizzle but absent from the runtime DDL); a DDL ↔ Drizzle consistency test guards the drift
- `openai-responses` streaming now accumulates function-call deltas — agent runtimes on that protocol previously lost every tool call silently
- `/api/discovery` no longer advertises proposal types with no commit handler (`record.upsert` / `narrative.template`, removed); the `working_memory.changed` SSE event is in the shared union and is no longer dropped by the frontend
- The reserved builtin plugin-id list is derived from the bundled plugins instead of a hand-kept list that had drifted to 8/19 (it guards third-party name-squatting)
- cost-gate's env-var budget fallback is reachable again — a declared `userSettings` default silently shadowed it, so a custom env value was ignored
- The Postgres contract suite no longer races the system catalog under parallel runs (per-file database isolation + single-connection `freshSchema` DDL)

<details>
<summary>中文（备份翻译）</summary>

第七个公开版本。对内核与存储层的一次架构优化：把重复的契约收口为单一、编译期强制的真相源；将 SQLite 与 Postgres 的存储查询层统一到一个共享适配器之后，并用真实 Postgres 验证跨后端行为一致；并修复一批潜在的正确性 bug。默认世界与内置插件行为不变。

**Added**

- `memoryBlocks` manifest 字段 + `MemoryBlockSchema`：核心记忆块现由插件/世界包以数据形式声明（默认四块——剧情状态/关系/场景/玩家档案——随内置 `memory` 插件提供，启动时按信任层级聚合）。新游戏类型可定义自己的记忆块（`clues`/`suspects`…）而无需 fork 框架
- cost-gate 每会话 token 预算改用 `userSettings`，hook 内经 `HookContext.getOwnSettings()` 读取，并保留 `COST_GATE_SOFT/HARD_TOKENS` 环境变量兜底
- `/api/ui-specs` 现按 Zod schema（含 `specVersion`）校验每个面板 spec、返回逐 spec 诊断、并按内容签名缓存发现结果（不再每次请求扫盘重写）
- 一次真实 Postgres 验证的 store 契约（713 用例），以及新增的 parity / 防漂移测试：proposal 类型↔commit handler↔discovery 对齐、SSE 事件 union、hook 事件、DDL↔Drizzle 索引一致性、表注册表覆盖、跨后端 null / `compactedAtTurnId` 往返、prompt 缓存断点上限

**Changed**

- **单一真相源（编译期穷尽）**：Proposal 类型、SSE 事件（单一 `CovelEvent` union）、hook 事件（`HOOK_EVENTS`）、框架 capability（typed registry）、provider 协议（`ProtocolRegistry`）各自收口到一处——新增一个只改一处，漏一个 handler/case 即编译失败
- **存储查询层统一**：镜像的 SQLite/Postgres record 模块收敛到一个异步 `SqlRunner` 之后；SQLite snapshots/suspensions 从裸 SQL 转为 drizzle，SQLite 后端现已零手写 record SQL。级联删除/落表清单/记忆快照的表集由单一表注册表派生；`withTransaction(fn)` 将事务作用域绑定到单次提交（真实 Postgres 池化事务；串行后端的嵌套会被拒绝而非死锁）
- `DataStore` 的 82 方法上帝接口拆成 21 个领域子接口再组合（形状不变）；`gateway.ts` 的 7 个操作收敛为一个 `runOperation`；`parsePluginMd` 的重复 lenient 块改为数据驱动的表
- `LLMAdapter`/`LLMResponse` 移到 `@covel/shared`，消除依赖图里唯一的错位边（`create → runtime`）
- 触发模式 `conditional`/`error-retry` 明确标注为 **reserved**（生产从不触发）；回合内事件 fan-out 复用单一 `shouldTrigger`
- 删除从未实现的 `SessionTransport` 接口与未用的命令协议类型；清理未接线的 prompt-assembler 残桩；把 Anthropic 缓存断点上限提成单一共享的 `MAX_CACHE_BREAKPOINTS`
- memory recall/archival 现诚实记录为关键词检索——向量原语存在但缺少写入时 embedding 的 ingestion，向量检索会查空表；扩展点已预留并文档化
- 所有 monorepo 包版本 `0.0.6` → `0.0.7`；刷新 README 内置插件表（16 → 19，补 `cost-gate`/`director`/`story-guard`）

**Fixed**

- **Resume 丢失运行时韧性**：挂起后恢复的 agent runtime 绕过了重试/循环检测/流式（它直接调 LLM）；resume 现在并入共享工具循环，走与正常回合相同的重试策略
- **跨后端数据丢失**：SQLite `appendTurnMessage` 在 insert 时丢掉 `compactedAtTurnId`，而 Postgres/memory/IDB 保留；现所有后端一致（由 parity 契约测试钉住）。`createSession`/`updateSession` 的可选字段序列化也跨后端统一
- 生产 Postgres 现会创建 `trace_events` 的 `trace_id`/`turn_id` 索引（Drizzle 声明了但运行时 DDL 缺失）；DDL↔Drizzle 一致性测试守护漂移
- `openai-responses` 流式现累积 function-call 增量——此前该协议下的 agent runtime 会静默丢掉每一次工具调用
- `/api/discovery` 不再广告没有 commit handler 的 proposal 类型（已删除 `record.upsert`/`narrative.template`）；`working_memory.changed` SSE 事件已纳入共享 union，前端不再丢弃
- 保留的内置 plugin-id 名单改为从内置插件派生，取代漂移到 8/19 的手维护列表（它用于防第三方占名）
- cost-gate 的环境变量预算兜底重新可达——一个声明的 `userSettings` 默认值曾静默压过它，导致自定义 env 值被忽略
- Postgres 契约套件在并行运行下不再竞争系统目录（每文件独立库隔离 + 单连接 `freshSchema` DDL）

</details>

## [0.0.6] - 2026-06-26

Sixth public release. Expands the runtime hook system from 8 to 16 lifecycle events, ships the first plugins that consume them, and lands a batch of runtime-architecture refactors and static-audit fixes. The default world and bundled plugins are behavior-unchanged — the new hooks are dormant infrastructure and the three new plugins are opt-in.

### Added

- Hook lifecycle expanded 8 → 16 events: `PreLLMCall` / `PostLLMResponse` (non-destructively rewrite a per-call request / patch the response before tool dispatch), `PostContextAssembly` (turn-level system-prompt / history shaping), `PreSchedule` (narrow which runtimes run this turn), `PreCompaction` / `PostCompaction` (veto / observe history compaction), `SessionStart` / `SessionEnd` (session lifecycle), and `PostToolUse.terminate` (end the tool loop after recording a result)
- Session-scoped hook pipeline: the global pipeline now filters hooks by the session's active plugins via `AsyncLocalStorage`, so a plugin's hooks only fire for sessions where it is active
- `HookContext.getOwnSettings()`: a hook can read its own plugin's per-session `userSettings` (turn-level, read-only, deep-frozen snapshot)
- Three new opt-in plugins — the first hook consumers: `cost-gate` (per-session token budget; included by default in the front-end **Low Cost** pack), `director` (`PostContextAssembly` — one consistent narration preamble across all story runtimes), and `story-guard` (`PostLLMResponse` content sanitisation + `PreToolUse` high-risk-tool deny-list)
- `EventBus.flush()` durability barrier for the best-effort audit-event stream
- `PostContextAssembly` payload carries a read-only `outputKind` so handlers can target specific runtime kinds without hardcoding plugin ids

### Changed

- Bumped all monorepo package versions `0.0.5` → `0.0.6`
- `TurnStart` / `PostRuntime` / `PostToolUse` hooks are now `sequential`, so their abort / replace paths actually take effect (previously dead code under `parallel`)
- Runtime refactors (behavior-preserving): `AgentLoopDeps` narrow seam isolating the core agent loop from orchestration deps; `RuntimeInvocation` options object replacing `executeOneRuntime`'s 19 positional args; a single `resolveTurnCapabilityPluginIds` source for capability-discovered plugin ids
- Registered all new hook events in the three plugin-loader whitelists (a plugin declaring them was previously dropped at parse time)

### Fixed

- Session-scoped every server commit / hook entry point (turn, actions, plugin-rpc, the commit processor, resume, characters, and session routes) so a plugin's hooks never fire for sessions where it is inactive
- `PreSchedule` can no longer drop Pre-Game runtimes while Pre-Game is pending — a hook can shape main-loop scheduling but not break session initialization
- Resume path now fires `PreLLMCall` / `PostLLMResponse` and scopes the resumed plugin's own hooks (both were silently skipped for a suspended-then-resumed runtime)
- `SessionStart` / `SessionEnd` hardened with local try/catch so a handler failure can never turn a committed create / end / delete into a 500
- Plugin loader: an object i18n `description` is preserved when a plugin also declares `hooks` (the combination previously failed frontmatter validation)
- Added unit coverage for `computeSessionTurnCount` (the turn-count module had none) and clarified that an empty main-loop turn counts as a player turn

<details>
<summary>中文（备份翻译）</summary>

第六个公开版本。将运行时 hook 生命周期从 8 个扩展到 16 个事件，交付首批消费这些 hook 的插件，并落地一批运行时架构重构与静态审计修复。默认世界与内置插件行为不变——新 hook 是休眠基础设施，三个新插件均为可选启用。

**Added**

- hook 生命周期 8 → 16：`PreLLMCall`/`PostLLMResponse`（按调用非破坏性改写请求 / 在工具分发前改写响应）、`PostContextAssembly`（回合级系统提示/历史塑形）、`PreSchedule`（收窄本回合运行的 runtime 集）、`PreCompaction`/`PostCompaction`（否决/观察历史压缩）、`SessionStart`/`SessionEnd`（会话生命周期）、`PostToolUse.terminate`（记录结果后结束工具循环）
- 会话作用域 hook 管线：全局管线经 `AsyncLocalStorage` 按会话激活插件过滤，插件 hook 只对其激活的会话触发
- `HookContext.getOwnSettings()`：hook 可读本插件本会话的只读 `userSettings`（回合级、只读、深冻结快照）
- 三个新的可选插件（首批 hook 消费者）：`cost-gate`（每会话 token 预算，默认进前端 **Low Cost** 组合包）、`director`（`PostContextAssembly` 给全部 story runtime 注入统一导演前言）、`story-guard`（`PostLLMResponse` 内容净化 + `PreToolUse` 高危工具拦截）
- `EventBus.flush()` 持久化屏障；`PostContextAssembly` payload 增加只读 `outputKind`

**Changed**

- 所有 monorepo 包版本 `0.0.5` → `0.0.6`
- `TurnStart`/`PostRuntime`/`PostToolUse` 改为 `sequential`，其 abort/replace 分支才真正生效（此前在 `parallel` 下是死代码）
- 运行时重构（行为保持）：`AgentLoopDeps` 窄接缝隔离核心 agent 循环、`RuntimeInvocation` 选项对象替代 19 个位置参数、`resolveTurnCapabilityPluginIds` 单一来源
- 三个 loader 白名单注册全部新 hook 事件

**Fixed**

- 会话作用域覆盖所有 server commit/hook 入口（turn/actions/plugin-rpc/提交处理器/resume/characters/session 路由）
- `PreSchedule` 在 Pre-Game pending 时不能丢弃 Pre-Game runtime
- resume 路径接入 `PreLLMCall`/`PostLLMResponse` 并修正 resume 时被恢复插件自身 hook 的作用域
- `SessionStart`/`SessionEnd` 本地 try/catch 固化 observe-only
- 插件加载器：i18n 对象 `description` 与 `hooks` 并存不再校验失败
- 补 `computeSessionTurnCount` 单测，并澄清空主循环回合计为玩家回合

</details>

## [0.0.5] - 2026-06-16

Fifth public release. An internal, code-quality-focused refactor: systematic de-duplication across storage backends and the plugin layer, decomposition of oversized files, unified conventions, and isolation/data-flow fixes. No user-facing behavior change (except an intentionally unified API error-response envelope).

### Added

- New `@covel/plugin-handlers-utils` package providing shared pure-function helpers for plugin function-runtime handlers (eliminates verbatim-duplicated helpers and proposal construction across 5 plugins)
- New `FrameworkCapability` constant and type in `packages/shared`, consolidating framework-consumed capability tags so bare-string typos can no longer silently disable features
- Unified API error-response envelope `ApiErrorResponse` with an `errorBody` factory

### Changed

- Bumped all monorepo package versions `0.0.4` → `0.0.5`
- **Store**: extracted shared cross-backend mappers/insert-values, removing PG/SQLite duplication (~1145 lines); split `types.ts` and `common/mappers` by domain
- **Runtime/Context**: extracted commit validators and LLM telemetry; split turn-agent-tool-loop / llm-retry / turn-agent-runtime / prompt-assembler
- **AI-Provider**: de-duplicated adapter parameter extraction / metadata sanitizing; externalized model-capability data from inline TS (950 lines) to JSON; de-duplicated gateway fallback; split env registry and plugin schema by domain
- **Server**: unified error envelope, replaced 37+ session-404 checks with a `resolveSessionParam` middleware, split the bootstrap/install/worlds mega-routes
- **Web**: removed dead code, decomposed several oversized components by responsibility, unified silent error-swallowing into a visible `ignoreError`

### Fixed

- Fixed `characters.ts` hardcoding a framework plugin ID in violation of the framework↔plugin isolation rule (now uses `frameworkProposalSource`)
- Fixed a PG `value`-field NULL-semantics regression introduced by cross-backend de-duplication (restored returning `null`, unified across both backends)
- Fixed character-panel staleness on the char-creator write path (restored and improved the post-turn snapshot resync)
- Fixed a React anti-pattern where the confirmation dialog ran side effects inside a setState updater

<details>
<summary>中文（备份翻译）</summary>

第五个公开版本。一次以代码质量为核心的内部重构：消除跨后端与插件层重复、拆分巨型文件、统一约定、修复隔离与数据流问题。对外行为保持不变（除有意统一的 API 错误响应信封）。

**Added**

- 新增 `@covel/plugin-handlers-utils` 包，为插件 function-runtime handler 提供共享纯函数工具（消除 5 个插件中逐字重复的 helper 与 proposal 构造）
- `packages/shared` 新增 `FrameworkCapability` 常量与类型，收敛框架消费的 capability 标签，避免裸字符串拼写漂移导致功能静默关闭
- 统一 API 错误响应信封 `ApiErrorResponse` 与 `errorBody` 工厂

**Changed**

- monorepo 全量版本号 `0.0.4` → `0.0.5`
- **Store**：抽取跨后端共享 mapper/insert-values，消除 PG/SQLite 重复（约 1145 行）；`types.ts` 与 `common/mappers` 按域拆分
- **Runtime/Context**：抽取 commit 验证器与 LLM 遥测，拆分 turn-agent-tool-loop / llm-retry / turn-agent-runtime / prompt-assembler 等大文件
- **AI-Provider**：适配器参数提取/元数据清理去重；模型能力数据由内联 TS（950 行）外置为 JSON；gateway fallback 去重；env registry 与 plugin schema 按域拆分
- **Server**：错误信封统一、`resolveSessionParam` 中间件替换 37+ 处会话 404 检查、bootstrap/install/worlds 大路由拆分
- **Web**：清理死代码、按职责拆分多个巨型组件、统一静默吞错为可见的 `ignoreError`

**Fixed**

- 修复 `characters.ts` 硬编码框架插件 ID 违反框架↔插件隔离规则（改用 `frameworkProposalSource`）
- 修复跨后端去重引入的 PG `value` 字段 NULL 语义回归（恢复返回 `null`，两后端统一）
- 修复角色面板在 char-creator 写入路径下的同步问题（恢复并改进 turn 完成后的快照重同步）
- 修复确认对话框在 setState updater 内执行副作用的 React 反模式

</details>

## [0.0.4] - 2026-05-28

第四个公开版本。重点收敛回合流稳定性、插件/会话解析、框架可见文本本地化、插件模板质量与发布文档。

### Added

- 新增静态回合审计 skill，用于检查 turn flow、插件边界与运行时输出相关风险
- 插件模板新增 runtime cases 与可运行 note/analyst 示例，create-plugin / create-world skills 补齐验证指引
- 桌面主进程错误与启动文案补齐中英文 i18n 支持

### Changed

- monorepo 全量版本号 `0.0.3` → `0.0.4`
- 加固 turn flow、插件解析、会话插件 API、snapshot / trace / working-memory 等运行时边界
- 简化 prompt context feature gates，整理 context builder、prompt assembler 与 serialization 相关实现
- 刷新 production Docker image、release docs、README 与贡献文档；移除过期本地开发草稿和废弃模板脚手架

### Fixed

- 修复框架 UI 中残留的硬编码可见文本，补齐对应中英文 locale
- 修复插件 metadata、runtime loading、form submission、suspend/resume 与 post-turn memory 相关测试覆盖
- 修复 desktop asset import、IPC handler、splash/startup error 路径与 release staging 相关边界

## [0.0.3] - 2026-05-11

第三个公开版本。重点收敛世界数据导入、生成世界持久化、插件目录元数据、存储后端边界、桌面发布链路与长期维护性重构。

### Added

- 世界数据导入管线：支持世界包声明式 `worldData` 数据源、会话创建时导入、同步 API、导入 ledger、角色蓝图与媒体引用同步
- AI 生成世界新增保存目标：`server-file` / `server-store` / `return-only`，前端依据 `/api/health.storage.data.frontendMode` 选择合适持久化路径
- 插件目录元数据新增 tags、relations 与世界级 `pluginPolicy`，会话准备页支持按世界策略推荐、筛选与选择插件
- 生成世界质量门、世界数据 schema 校验、插件 README 检查与 Playwright e2e 稳定性验证脚本

### Changed

- monorepo 全量版本号 `0.0.2` → `0.0.3`
- 桌面发布链路收敛到 Electron，移除已废弃的 Tauri shell，更新 release workflow 与 staging smoke 验证
- 存储架构统一为 DataStore / MediaStore / VectorStore 边界，浏览器本地模式使用 IndexedDB，远端模式继续走服务端持久化
- 重构长期维护文件：拆分 bootstrap、plugin RPC、turn pipeline、store 后端、desktop IPC/logging、web session prep/debug route 等大模块
- README、首页 demo 与视觉层级更新，刷新 demo GIF 资源与玩家视角说明

### Fixed

- 加固插件执行安全边界、world data schema/media sync、生成世界包输出、gateway slot fallback 与 provider 参数覆盖测试
- 修复重复动态/静态导入、桌面 sidecar/staging 构建路径、plugin RPC/SSE 边界、存储后端空值与媒体生命周期相关边界

### Documentation

- 重组开发文档，补齐 storage architecture、world data、plugin authoring、desktop state、refactor follow-up 与插件 README

## [0.0.2] - 2026-04-29

第二个公开版本。围绕 2026-04-29 代码库审计发现的 7 个问题做收敛——CI 红灯、桌面安全、插件生态闭环、首屏体积。

### Added

- 桌面 sidecar 启动时生成一次性 bearer token（`COVEL_DESKTOP_REST_TOKEN`），所有 `PUT /api/config/{keys,settings,data-root}` 与 `POST /api/config/open-folder` 必须带 `Authorization: Bearer <token>`。读接口保持开放；token 未注入时（pure web / dev / Demo Host）自动 no-op，行为兼容
- `/api/config/info` 新增 `requiresAuth` 字段，前端据此决定是否附加 Authorization 头
- 社区插件 `tools.local` 激活生命周期：`activatePluginLocalTools(pluginId)` 在 RPC 审批通过后 just-in-time 注册到 `toolMap`，并在 approvals decision=allow 后预激活；幂等
- Electron 外链 allowlist：`https:` 直接放行 + 写审计日志；非 loopback `http:` 弹用户确认 dialog；其他协议（`javascript:`/`file:`/自定义）拦截
- 桌面 sidecar awaitable shutdown：新 `stopServer()` 等待子进程 `exit` 事件后再启动新 sidecar，5s 超时 SIGKILL，重启路径告别端口/SQLite 锁竞态

### Changed

- monorepo 全量版本号 `0.0.1` → `0.0.2`
- web 首屏 bundle 拆分：vite manualChunks 抽出 react/router/i18n/markdown/graph/motion 6 个 vendor chunk；主 chunk **490 kB → 365 kB gzip（-25%）**
- README + web 首页 demo 资源换为最新 dev3 视频（3× 速、无音轨、960×568 GIF + 1280×756 MP4）
- `PluginRpcResponse.failedJobs` 字段标记 deprecated；`expectsBackgroundFollower` 路径统一返回 202 `accepted` + jobId，失败状态落在 `_jobs/<jobId>` 的 `reason: "expected-background-follower-missing"`
- i18n 扫描器白名单覆盖 settings/theme 的 bilingual config 目录（`{ "zh-CN", "en-US" }` 自带翻译的对象不再误报）；database-panel raw 字符串迁移到 locale；删除冗余 `t(key, "中文")` 默认值
- CORS 收窄：从「任意 loopback origin」改为「dev origin（5173）+ sidecar own origin（serverPort）+ `CORS_ORIGIN` 显式配置」

### Fixed

- `pnpm test` 之前因 `tests/api/plugin-rpc.test.ts` 期望 200 实得 202 红灯——契约已确定为 202 异步 job 模式，测试同步更新到轮询 `_jobs` 失败状态
- 重复静/动态 import 警告：`reload-overlay`、`settings/store` 不再同时被静态和动态引入，Vite 不再警告 ineffective dynamic import
- `pnpm check:i18n` 35 处 raw CJK literal 全部清理，回到绿灯

### Documentation

- `docs/reference/api.md`：202 示例补 `phase` 字段；`_jobs` schema 补 `reason` 字段
- `docs/guide/desktop-config.md`：新增「桌面 REST 写接口的 token 门」章节
- `docs/guide/plugin-authoring-advanced.md`：澄清社区插件 `tools.local` 在审批通过后的延迟激活语义

## [0.0.1] - 2026-04-25

首个公开稳定版本。在 `0.0.1-beta` 基础上做了一轮可发布性收敛。

### Added

- 框架定位为 **agentic role-playing game framework**（README 中英文重写以体现这一定位）
- GitHub Actions release workflow 支持 `git push v*` tag 自动 build 并发布 GitHub Release
- Electron 打包产出收敛到「DMG + ZIP」两个文件，新增 `apps/desktop/scripts/cleanup-artifacts.mjs` 在 `afterAllArtifactBuild` 钩子里清理 blockmap、`latest-*.yml` 等 auto-update 元数据和解包目录
- create-plugin / create-world skill 增加测试与验证指引（`references/plugin-testing.md`、`references/world-validation.md`），含 vitest + MockLLM + harness 模板和 schema/引用一致性/lore 覆盖度脚本

### Changed

- monorepo 全量版本号 `0.0.1-beta` → `0.0.1`（root + 4 apps + 12 packages + 7 plugins + 2 templates + Tauri 3 处）
- `electron-builder.yml` 增加 `publish: null` 抑制 update manifest
- `docs/guide/plugin-authoring.md` 附录 B 插件清单按 `plugins/**/PLUGIN.md` 真实 frontmatter 重列（priority、runtime 类型与仓库实际一致）
- `docs/reference/plugins.md` 多 runtime 目录示例改为中性占位，避免与真实 `world-init/schema-gen` 单 runtime 现状混淆
- README/web 首页 demo 资源刷新为最新 dev 视频（3× 速、去音轨、800px GIF + 1280p MP4）

### Fixed

- `.claude/skills/create-plugin/references/example-plugins.md` 修正过时的 `model: ds`(实际 slot 为 `story` / `plugin`) 和与真实插件不符的 priority 数字

## [0.0.1-beta] - 2026-04-19

首个公开 beta 版本。

### Added

- 插件驱动的回合执行管线（Trigger Router → Priority Scheduler → Context Assembly → Runtime Runner → Commit Chain）
- 多 Provider LLM 抽象：DeepSeek / Qwen (DashScope) / OpenAI / Anthropic
- 2597 模型能力数据库（LiteLLM 同步），自动识别多模态 / function-calling / reasoning
- 存储后端：Memory / SQLite / IndexedDB / PostgreSQL（Drizzle ORM）
- 核心插件集：`pregame`、`world-init`、`char-creator`、`narrator`、`guide`、`npc-graph`、`codex`
- 声明式 UI：`json-render` + plugin-owned `ui/*.json`，无硬编码 Tab
- Electron 桌面版：macOS (arm64/x64)、Windows (x64/arm64 NSIS + portable)
- 外部化 prompt 模板与世界包（markdown + yaml）
- i18n：中英双语前端 + plugin 本地化 runtime
- 智能重试：超时 / 首 token 过慢 / 工具调用死循环 自动检测并回退
- 开发期 LLM replay cache（`COVEL_LLM_REPLAY=auto`）

### Documentation

- 项目 README、LICENSE (MIT)、CONTRIBUTING、CHANGELOG
- 三层文档：`reference/` (API/协议)、`guide/` (作者指南)、`architecture/` (系统设计)
- Release pipeline：`.github/workflows/release.yml`

[Unreleased]: https://github.com/AcKnEsS/covel/compare/v0.0.17...HEAD
[0.0.17]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.17
[0.0.16]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.16
[0.0.15]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.15
[0.0.14]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.14
[0.0.13]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.13
[0.0.12]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.12
[0.0.11]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.11
[0.0.10]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.10
[0.0.9]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.9
[0.0.8]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.8
[0.0.7]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.7
[0.0.6]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.6
[0.0.5]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.5
[0.0.4]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.4
[0.0.3]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.3
[0.0.2]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.2
[0.0.1]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1
[0.0.1-beta]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1-beta
