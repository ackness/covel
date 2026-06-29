# Covel Glossary

A canonical definition for the vocabulary used across Covel docs, code, and UI copy. When terms diverge between surfaces (e.g. a tooltip says "preset" but the code says "slot"), this page is the tiebreaker — align the other surface, not this one.

Terms are ordered alphabetically. Each entry includes a 1–2 sentence definition and a link to the authoritative doc.

> Chinese translations welcome — PRs that add a `docs/glossary.zh.md` or add a `| zh | ...` column are appreciated.

## Binding

A declared link between a plugin and a provider capability (e.g. `text`, `image`, `embedding`), expressed in the runtime manifest. The kernel resolves bindings to concrete providers at turn time — plugins never touch SDKs directly.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/architecture/flow.md](./architecture/flow.md).

## Capability

A string tag on a runtime manifest that advertises what the runtime _does_ (e.g. `narrative`, `world-data-provider`, `image-generation`). Framework code discovers plugins by capability, never by hardcoded plugin ID.

See: [docs/reference/plugins.md](./reference/plugins.md), CLAUDE.md "Framework ↔ Plugin Isolation Rule".

## Kernel

The framework runtime that schedules turns, assembles context, drives LLM tool-calls, validates proposals, and commits writes. Everything outside the `plugins/` directory (`packages/`, `apps/server/src/`, `apps/web/src/`) is kernel code.

See: [docs/architecture/flow.md](./architecture/flow.md).

## Pack

A named bundle of plugins (enable / optional / exclude sets, plus tag preferences) that assembles one coherent gameplay style — e.g. `traditional-story`, `dialogue-mode`, `low-cost`. Players pick a pack on the session-prep screen to swap the whole plugin set at once; a world can default to one via `pluginPolicy.preset`. Distinct from **Preset**, which bundles model/slot routing, not plugins.

See: `apps/web/src/lib/session-plugin-selection.ts`, [docs/reference/plugins.md](./reference/plugins.md), [docs/reference/world-data.md](./reference/world-data.md).

## PluginType

The trust/ownership tier of a plugin: `core-plugin` (bundled, auto-loaded), `official` (whitelisted), or `community` (deferred until user approves). Governs tool approval policy, prompt injection scope, and update channels.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/reference/tools.md](./reference/tools.md).

## Preset

A user-facing bundle of slot overrides and parameter tweaks saved in `SettingsStore` (`keys.env` / `localStorage`). Players switch presets to reroute their session through a different model mix without editing `llm.toml`.

See: `packages/shared/src/settings/`.

## Proposal

A kernel-validated write envelope emitted by a plugin (never a direct DB write). Types are derived from the single source of truth `ProposalPayloadMap` (`packages/shared/src/types/proposal.ts`): `narrative.append`, `state.patch`, `event.emit`, `interaction.request`, `ui.render`, `asset.generate`, `plugin.data`, `plugin.data.batch`, `character.upsert`, `working_memory.set`, `lorebook.upsert`.

See: [docs/reference/transactions.md](./reference/transactions.md), [docs/architecture/flow.md](./architecture/flow.md).

## Provider

A concrete LLM / image / embedding backend (OpenAI, Anthropic, DeepSeek, Aliyun DashScope, …). Providers are selected via slot routing and invoked through the AI gateway, never by plugin code directly.

See: `packages/ai-provider/`, [docs/reference/plugins.md](./reference/plugins.md).

## Runtime

The actual executable unit inside a plugin — either an `agent` (LLM-driven, loads `PLUGIN.md` as system prompt) or a `function` (pure JS handler). One plugin package may export multiple runtimes with different triggers and priorities.

See: [docs/guide/plugin-authoring.md](./guide/plugin-authoring.md), [docs/reference/plugins.md](./reference/plugins.md).

## Runtime manifest

The parsed YAML frontmatter of a `PLUGIN.md`, plus derived fields. Carries the `pluginId`, `name` (runtimeId), `trigger`, `priority`, `outputKind`, `capabilities`, `model`, `permissions`, and UI spec references.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/guide/plugin-authoring.md](./guide/plugin-authoring.md).

## Segment

A narrative slice inside the assembled prompt (one of the 10 slices in the prompt-structure spec). Segments are cache-aware: stable segments (world lore, plugin prompt) get `cache_control` markers so provider-side prompt caching can reuse them across turns.

See: [docs/reference/prompt-structure.md](./reference/prompt-structure.md).

## Session

A single player's ongoing playthrough. Identified by `{worldId}-{uuid8}`, pinned to one world, and owns its own turn counter, plugin scope, snapshots, and events.

See: [docs/reference/api.md](./reference/api.md), [docs/reference/transactions.md](./reference/transactions.md).

## Slot

A named routing key for LLM model selection (`default`, `fast`, `balance`, `image`, …). Plugin manifests declare a slot by name; `llm.toml` maps the slot to a concrete provider + model; tag-aware fallback picks the nearest slot with the same modality tag.

See: [docs/reference/plugins.md](./reference/plugins.md), `llm.toml.example`.

## Trigger mode

How a runtime decides it should run on a given turn: `auto`, `scheduled`, `manual`, or `event` (`conditional` / `error-retry` are reserved and never fire in production). Combined with `priority` (which band the runtime belongs to) and the `scheduled` sub-fields (`interval` / `cooldownTurns` / `maxTriggerCount` / `startTurn`).

See: [docs/reference/plugins.md](./reference/plugins.md).

## Turn

One tick of the session loop: player input → trigger routing → per-priority runtime execution → proposal validation → commit → SSE broadcast. Each turn is assigned a monotonically increasing `turnId` and a band (pre-game = 0, active = ≥1).

See: [docs/architecture/flow.md](./architecture/flow.md), [docs/reference/protocol.md](./reference/protocol.md).

## World

A bundled content package (`worlds/<id>/`) containing `world.yaml`, `WORLD.md`, and optional `data/world.data.yaml` sources for dimensions, character blueprints, rules, scene templates, and media indexes. Loaded at server boot from `COVEL_WORLDS_DIR`; one world powers many sessions.

See: [docs/reference/world-data.md](./reference/world-data.md).

## Related

- **pluginId vs runtimeId** — see CLAUDE.md "Identity model".
- **Trust tiers** — see `pluginType` above and [docs/reference/tools.md](./reference/tools.md).
- **Outside scope here**: `Branch`, `Snapshot`, `PluginData`, `CharacterRecord`, `Lorebook` — see [docs/reference/transactions.md](./reference/transactions.md).
