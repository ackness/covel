# Covel Glossary

A canonical definition for the vocabulary used across Covel docs, code, and UI copy. When terms diverge between surfaces (e.g. a tooltip says "preset" but the code says "slot"), this page is the tiebreaker — align the other surface, not this one.

Terms are ordered alphabetically. Each entry includes a 1–2 sentence definition and a link to the authoritative doc.

> Chinese translations welcome — PRs that add a `docs/glossary.zh.md` or add a `| zh | ...` column are appreciated.

## Binding

A typed data-flow edge declared in `io.inputs.<name>` between a producer runtime and a consumer runtime. The kernel resolves the producer by runtime ID (inside one package) or by versioned contract (across packages), optionally selects a value with an RFC 6901 JSON Pointer, validates it against `accepts`, and exposes a provenance-wrapped value through `ctx.inputs` or the agent prompt. `scope: committed` reads a result recorded by an earlier execution instead of the current one.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/architecture/flow.md](./architecture/flow.md), `packages/shared/src/types/runtime-scheduling.ts`.

## Collection

A manifest (`covel-collection.yaml`) that lists worlds and plugins to install together, including packages pinned by commit in other repositories. It is a pointer list used at install time: what it installs are ordinary plugins and ordinary worlds, each updated and removed on its own. Distinct from **Pack**, which selects among plugins that are already installed.

See: [docs/guide/collections.md](./guide/collections.md), [docs/reference/plugin-installation.md](./reference/plugin-installation.md).

## Contract

A versioned ID such as `narrative-engine@1` that names what a plugin provides or needs. The root `PLUGIN.md` lists contracts under `provides`, `requires`, `optional`, and `conflicts`; a runtime publishes one through `io.output.contract` and consumes one through `from: { contract }`. The kernel resolves providers by contract, never by a hardcoded plugin ID, so any plugin providing the same contract can replace another. Only the current version is supported: a breaking change takes a new ID (`@2`).

See: [docs/reference/plugins.md](./reference/plugins.md), AGENTS.md "Framework ↔ Plugin Isolation Rule".

## Extension point

A kernel-defined versioned contract that plugins implement, such as `prompt.segment@1` or `ui.slot@1`. A plugin declares a provider in `contributes.extensions` and registers it with `covel.provideExtension()`; the point's mode (`single`, `collect`, or `pipeline`) decides how several providers combine. Distinct from a plugin **Contract**, which one plugin defines for others to consume.

See: [docs/reference/extension-points.md](./reference/extension-points.md), [docs/reference/plugin-extensions.md](./reference/plugin-extensions.md).

## Kernel

The framework runtime that schedules turns, assembles context, drives LLM tool-calls, validates proposals, and commits writes. Everything outside the `plugins/` directory (`packages/`, `apps/server/src/`, `apps/web/src/`) is kernel code.

See: [docs/architecture/flow.md](./architecture/flow.md).

## Pack

A named bundle of plugins (`requested` and `recommended` sets, plus tags) that assembles one coherent gameplay style — e.g. `traditional-story`, `dialogue-mode`. Players pick a pack on the session-prep screen to swap the whole plugin set at once; a world can default to one via `pluginPolicy.presetId`. Distinct from **Preset**, which bundles model/slot routing, not plugins.

See: `packs/builtin.yaml`, `apps/server/src/config/plugin-packs.ts`, [docs/reference/plugins.md](./reference/plugins.md), [docs/reference/world-data.md](./reference/world-data.md).

## Plugin kind and source

Two separate axes describe a plugin. `kind` is the root `PLUGIN.md` field with two values: `core` plugins join every session unless the player explicitly excludes them, `plugin` packages are opt-in (the loader compiles it to the internal `pluginType`: `core-plugin` or `plugin`). Source (`builtin` or `community`) is derived from the discovery directory, not from the manifest or the name: it governs auto-load, tool approval, and whether server code needs the player's authorization. An officially maintained plugin installed from outside the repo is still `community`.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/reference/plugin-installation.md](./reference/plugin-installation.md), [docs/reference/tools.md](./reference/tools.md).

## Preset

An internal compiled model plan containing a provider, endpoint, protocol, and one opaque model ID. The settings UI exposes the clearer provider/model hierarchy and compiles browser-defined models into presets only at the request boundary; users do not manage presets directly.

See: `packages/settings/src/`.

## Proposal

A kernel-validated write envelope emitted by a plugin (never a direct DB write). Types are derived from the single source of truth `ProposalPayloadMap` (`packages/shared/src/types/proposal.ts`): `narrative.append`, `state.patch`, `event.emit`, `interaction.request`, `ui.render`, `asset.generate`, `plugin.data`, `plugin.data.batch`, `plugin.data.delete`, `character.upsert`, `character.schema.set`, `dimension.initialize`, `dimension.update`, `lorebook.upsert`.

See: [docs/reference/transactions.md](./reference/transactions.md), [docs/architecture/flow.md](./architecture/flow.md).

## Provider

A concrete LLM / image / embedding backend (OpenAI, Anthropic, DeepSeek, Aliyun DashScope, …). Providers are selected via slot routing and invoked through the AI gateway, never by plugin code directly.

See: `packages/ai-provider/`, [docs/reference/plugins.md](./reference/plugins.md).

## Runtime

The actual executable unit inside a plugin — either an `agent` (LLM-driven, loads `RUNTIME.md` (or root inline runtime) as system prompt) or a `function` (pure JS handler). One plugin package may export multiple runtimes with different triggers, stages, and dependency edges.

See: [docs/guide/plugin-authoring.md](./guide/plugin-authoring.md), [docs/reference/plugins.md](./reference/plugins.md).

## Runtime manifest

The internal execution structure the loader compiles from an authored runtime — the inline `runtime` of a root `PLUGIN.md` or a `runtimes/<id>/RUNTIME.md`. Authors write grouped fields (`type`, `schedule`, `io`, `agent`, `function`, `guard`, `effects`, `permissions`); the compiled `RuntimeManifest` carries the `pluginId`, `name` (runtimeId), `trigger`, the scheduling surface (`stage`, `needs`, `after`, `inputs`), `outputKind`, `outputContract`, `model`, and `permissions`. The internal fields are not author format and cannot be copied into `PLUGIN.md`.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/guide/plugin-authoring.md](./guide/plugin-authoring.md).

## Segment

A narrative slice inside the assembled prompt (one of the 10 slices in the prompt-structure spec). Segments are cache-aware: stable segments (world lore, plugin prompt) get `cache_control` markers so provider-side prompt caching can reuse them across turns.

See: [docs/reference/prompt-structure.md](./reference/prompt-structure.md).

## Session

A single player's ongoing playthrough. Identified by `{worldId}-{uuid8}`, pinned to one world, and owns its own turn counter, plugin scope, snapshots, and events.

See: [docs/reference/api.md](./reference/api.md), [docs/reference/transactions.md](./reference/transactions.md).

## Slot

A named routing key for model selection (`story`, `plugin`, `memory`, `image`, …), labelled **Model Role** in the settings UI. Plugin manifests declare a slot by name; `llm.toml` or persisted provider/model settings bind it to a concrete model; tag-aware fallback stays within the same modality.

See: [docs/reference/plugins.md](./reference/plugins.md), `llm.toml.example`.

## Trigger mode

How a runtime decides it should run on a given turn: `auto`, `scheduled`, `manual`, or `event` — the enum is closed, and a manifest declaring anything else is rejected at load. Combined with `stage` (which band an `auto` / `scheduled` runtime belongs to; `event` / `manual` runtimes declare no stage) and the `scheduled` sub-fields (`interval` / `cooldownTurns` / `maxTriggerCount` / `startTurn`).

See: [docs/reference/plugins.md](./reference/plugins.md).

## Turn

One tick of the session loop: player input → trigger routing → per-stage DAG execution (strict barrier between stages, dependency-ordered within a stage) → proposal validation → commit → SSE broadcast. Each execution has an opaque `turnId`; committed player turns advance the monotonic `completedPlayerTurns` clock at most once per logical turn. The band is selected by `session.phase` (`setup` runs the setup stage, `playing` runs `pre-turn → narrative → post-turn → audit`).

See: [docs/architecture/flow.md](./architecture/flow.md), [docs/reference/protocol.md](./reference/protocol.md).

## World

A bundled content package (`worlds/<id>/`) containing `world.yaml`, `WORLD.md`, and optional `data/world.data.yaml` sources for dimensions, character blueprints, rules, scene templates, and media indexes. Loaded at server boot from the bundled `COVEL_WORLDS_DIR` and the user world directory (`COVEL_USER_WORLDS_DIR`, otherwise `<COVEL_HOME>/worlds`, with `~/.covel` as the default home); one world powers many sessions. See [world loading](./reference/world-data.md#启动加载与收敛seed--reconcile).

See: [docs/reference/world-data.md](./reference/world-data.md).

## Related

- **pluginId vs runtimeId** — see AGENTS.md "Identity model".
- **Plugin sources** — see "Plugin kind and source" above and [docs/reference/tools.md](./reference/tools.md).
- **Outside scope here**: `Branch`, `Snapshot`, `PluginData`, `CharacterRecord`, `Lorebook` — see [docs/reference/transactions.md](./reference/transactions.md).
