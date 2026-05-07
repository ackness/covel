# Covel Chat Mode Architecture

## Purpose

Chat Mode is a Covel-native playstyle that presents a character-chat surface for SillyTavern-style roleplay users while keeping the current Covel runtime model:

- plugin manifests in `PLUGIN.md`
- pre-game and main-loop turn bands
- DAG runtime scheduling
- proposal normalization and commit
- plugin data as session-scoped plugin state
- characters as shared kernel state
- lorebook rows as session world rules
- working memory and core memory as prompt context
- json-render UI panels and message surfaces
- plugin RPC for explicit player actions

This document is grounded in the current codebase. It describes additive changes that extend existing contracts.

## Current Code Anchors

### Plugin Manifest And Loading

Relevant files:

- `packages/shared/src/types/plugin.ts`
- `packages/shared/src/schemas/plugin.ts`
- `packages/plugin-loader/src/parse-plugin-md.ts`
- `packages/plugin-loader/src/load.ts`
- `packages/plugin-loader/src/registry.ts`
- `apps/server/src/routes/api/bootstrap.ts`

Important constraints:

- `runtimeManifestSchema` is `.strict()`. Any new top-level manifest field needs updates in both `types/plugin.ts` and `schemas/plugin.ts`.
- Existing extension points already cover most Chat Mode needs: `capabilities`, `promptVersion`, `authorsNote`, `postHistory`, `summaryFocus`, `userSettings`, `hooks`, `rpc`, `ui`, `input.inject`, `tools`, `execution`.
- UI specs are loaded from `ui.right`, `ui.message`, and `ui.left` by `loadUiSpecs()`.
- Local tools load eagerly for trusted bundled plugins and lazily for community plugins after approval.
- `PluginRegistry.findPluginByCapability(sessionId, capability)` is the preferred discovery path for world-data-provider style roles.

Design implication:

Chat Mode should be a bundled plugin package and a world/playstyle activation path. It should rely on current manifest fields first. New manifest fields should appear only after the plugin package proves a repeating need.

### Turn Execution

Relevant files:

- `packages/runtime/src/turn-executor.ts`
- `packages/runtime/src/scheduler.ts`
- `packages/runtime/src/dag-scheduler.ts`
- `packages/runtime/src/plugin-handler-helpers.ts`
- `apps/server/src/routes/api/turn.ts`
- `apps/server/src/routes/api/plugin-rpc.ts`

Existing capabilities:

- Pre-game runtimes use priority `0..99` and run in strict priority order.
- Main-loop runtimes use DAG scheduling from `input.inject` and `upstreamRequired`.
- Manual-only Chat Mode tools should omit `priority`. Putting a `trigger.type: manual` utility runtime in the Pre-Game band leaves `preGameCompleted` waiting on a runtime that only runs through plugin RPC.
- Manual plugin RPC can trigger a specific runtime through the normal `executeTurn()` path.
- Manual-trigger turns skip appending a player chat message.
- `TurnInputExecutionFlags.suppressPlayerMessage` exists internally for replay-like flows.
- Event chains execute same-turn followers from runtime `output.events[]`.
- Function runtimes receive `ctx.gateway`, `ctx.media`, `ctx.pluginData`, `ctx.assetProgress`, `ctx.userSettings`, and scoped store helpers.
- Trusted function runtimes get broader store access; community function runtimes get a read-only `FunctionStoreView`.

Design implication:

Scene Cast, branch reply, card import, image/TTS generation, and rule automation can ship as plugins using function runtimes and plugin RPC. Event chains can connect prompt generators to background followers.

### Proposal Commit Layer

Relevant files:

- `packages/shared/src/types/proposal.ts`
- `packages/runtime/src/session-kernel.ts`
- `packages/tools/src/builtin/ui-tools.ts`
- `packages/tools/src/builtin/character-tools.ts`

Existing proposal outputs:

- `narrative.append` from `narrativeOutput` when `outputKind: story`
- `interaction.request` from `interactions[]` or tool output `interaction`
- `ui.render` from runtime/tool UI blocks
- `plugin.data` and `plugin.data.batch` from `pluginData[]`
- `character.upsert`
- `working_memory.set`
- `lorebook.upsert`
- `asset.generate`

Important details:

- `character.upsert` supports `mirrorPluginId`, which mirrors a compact character snapshot into `plugin_data[mirrorPluginId]["characters"][id]`.
- Built-in character tools already write `characters` and mirror to the caller plugin's `characters` namespace.
- `working_memory.set` is feature-gated by `COVEL_WORKING_MEMORY_V1`.
- `lorebook.upsert` stores `extra` as forward-compatible JSON.
- `asset.generate` writes a message block and emits `asset.generated`.
- `create-form`, `create-choices`, and `render-ui` already produce interaction/UI payloads.

Design implication:

Character Blueprint, Persona, Quick Replies, and Living World Rules can use existing proposal types. Branch Reply can start with `plugin.data` and grow into a first-class proposal/table after interaction semantics stabilize.

### API Routes

Relevant files:

- `apps/server/src/routes/api/session.ts`
- `apps/server/src/routes/api/plugin-rpc.ts`
- `apps/server/src/routes/api/plugin-data.ts`
- `apps/server/src/routes/api/lorebook.ts`
- `apps/server/src/routes/api/characters.ts`
- `apps/server/src/routes/api/messages.ts`
- `apps/server/src/routes/api/runtime-outputs.ts`
- `apps/server/src/routes/api/media.ts`

Current route behavior:

- Session creation accepts explicit `plugins` and always adds required bundled core plugins.
- Session `PATCH` supports `runtimeModelOverrides`.
- Plugin RPC supports action-level handlers and runtime-level manual trigger.
- Plugin data reads allow any registered plugin; plugin data writes require the plugin to be active in the session.
- Plugin data write route limits serialized values to 64KB.
- Lorebook routes currently support list, enabled toggle, and delete.
- Character routes support list and framework API upsert through the proposal pipeline.
- Messages API flattens message metadata into `turnId`, `runtimeId`, `kind`, and `block`.

Design implication:

Large card imports should use plugin RPC plus media/file ingestion patterns, with normalized compact state in plugin data. A full Living World Rules editor needs a lorebook create/update route or a plugin RPC action that emits `lorebook.upsert`.

### Frontend Runtime Surface

Relevant files:

- `apps/web/src/stores/session-store.tsx`
- `apps/web/src/stores/plugin-data-store.ts`
- `apps/web/src/components/session/chat-messages.tsx`
- `apps/web/src/components/session/plugin-panel.tsx`
- `apps/web/src/components/session/right-panel.tsx`
- `apps/web/src/lib/catalog.tsx`
- `apps/web/src/services/api.ts`

Existing UI capabilities:

- `RightPanel` loads `/api/ui-specs?sessionId=...`, groups specs by `group`, and preloads plugin data.
- `PluginPanel` renders json-render specs with `covelRegistry`.
- `PluginPanel` already exposes handlers: `invokeRuntime`, `invokePluginAction`, approval retry, background job toast handling.
- `session-store` reacts to `plugin-data.changed`.
- `plugin_data[pluginId]["message"]` plus `ui.message` creates a synthetic `plugin_message` chat block.
- `ChatMessages` renders story messages, plugin message blocks, `ui.render`, `asset.generate`, and the per-turn asset sidebar.
- `catalog.tsx` includes existing primitives such as `GraphCanvas`, `WorldDimensions`, `ImageGallery`, `ImageJobs`, `Media`, `AudioPlayer`, `AssetRender`, and `AssetTurnSidebar`.

Design implication:

Scene Prompts can ship through `ui.message`. Character panels, rule editors, branch controls, cast panels, and presence panels can ship through `ui.right`. New React components belong in `catalog.tsx` only when json-render composition becomes awkward.

### Context And Prompt Assembly

Relevant files:

- `packages/context/src/types.ts`
- `packages/context/src/session-context.ts`
- `packages/context/src/prompt-assembler.ts`
- `packages/context/src/context-builder.ts`
- `packages/context/src/prompt-internals.ts`

Existing context model:

- `SessionContextSnapshot` already has stubs for `activePersona` and `contributions`.
- `ContextContribution` already models `lore_entry`, `persona_description`, `character_overlay`, `authors_note`, `post_history`, `runtime_inject`, `working_memory`, and `core_memory`.
- Prompt V2 already has 10 segments.
- Segment 2 renders core memory and working memory.
- Segments 9 and 10 aggregate `authorsNote` and `postHistory` from active manifests.
- Segments 4, 6, and 8 are reserved for lorebook/world-info placement and currently empty.
- `input.inject` supports runtime output and own-plugin `plugin-data` summaries.

Design implication:

Living World Rules and Persona should complete the existing `SessionContextSnapshot.contributions` path. They should feed Prompt V2 segments rather than create a parallel prompt manager.

## Covel-Native Mapping

| SillyTavern-style capability | Covel implementation                                                                      | Existing code to reuse                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Character card               | Character Blueprint stored in plugin data, instantiated as `Character` plus `fields`      | `CharacterAttributeSchema`, `create-character`, `character.upsert`, `mirrorPluginId` |
| Persona                      | Player Identity as player `Character`, plus `PersonaProfile` in session context           | `characters`, `working_memory.set`, `SessionContextSnapshot.activePersona`           |
| World Info                   | Living World Rules as lorebook entries and context contributions                          | `lorebook.upsert`, `LorebookEntryRecord.extra`, Prompt V2 Seg 4/6/8                  |
| Prompt preset                | Playstyle Pack through active plugins, `userSettings`, `runtimeModelOverrides`, prompt V2 | `RuntimeManifest.userSettings`, session `runtimeModelOverrides`                      |
| Quick Replies                | Scene Prompts through `guide`-style `ui.message` and `plugin_data.message`                | `plugins/guide`, `PluginMessageBlock`, `draftMessage`, `setComposerText`             |
| Group chat                   | Scene Cast runtime selects active speakers before narrator                                | priority 450 function runtime, `input.inject`, `npc-graph`                           |
| Swipe/regenerate             | Branch Reply candidate set stored in plugin data, rendered in message UI                  | plugin RPC, manual trigger, `plugin.data`, message metadata                          |
| STscript-style automation    | Scene Automation as event-triggered runtimes and RPC actions                              | `trigger: event`, event-chain loop, hooks, approval                                  |
| Avatar/sprites/TTS/images    | Character Presence as `MediaRef` assets bound to character/blueprint state                | `MediaStore`, `asset.generate`, `Media`, `AudioPlayer`, `AssetRender`                |

## Data Model Plan

### Character Blueprint

Use plugin data as the first storage layer:

- plugin id: `character-blueprint`
- namespace `blueprints`, key `<blueprintId>`
- namespace `imports`, key `<importId>` for diagnostics and source hashes
- namespace `message` for inline import/status UI when needed

Shared type addition:

- add `packages/shared/src/types/character-blueprint.ts`
- export from `packages/shared/src/types/index.ts`

Suggested type:

```ts
export interface CharacterBlueprint {
  readonly id: string;
  readonly name: string;
  readonly source?: {
    readonly kind: "manual" | "sillytavern-card" | "world-pack";
    readonly importedAt?: string;
    readonly rawHash?: string;
  };
  readonly identity: Record<string, unknown>;
  readonly dialogue: {
    readonly style?: string;
    readonly examples?: readonly string[];
    readonly greeting?: string;
    readonly voice?: string;
  };
  readonly scene: {
    readonly scenario?: string;
    readonly defaultLocation?: string;
    readonly relationshipToPlayer?: string;
  };
  readonly rules?: readonly string[];
  readonly media?: {
    readonly avatar?: import("./media.js").MediaRef;
    readonly sprites?: Readonly<Record<string, import("./media.js").MediaRef>>;
  };
  readonly extra?: unknown;
}
```

Instantiation:

- Create or update a `Character` record with `type: "npc"` or `type: "companion"`.
- Store `fields.blueprintRef = blueprintId`.
- Store dialogue/style fields under schema-compatible keys where the world schema supports them.
- Use `mirrorPluginId: "character-blueprint"` when calling `character.upsert`, or call existing character tools from an agent runtime.

Import considerations:

- Keep normalized blueprint values under 64KB for plugin-data route compatibility.
- Store avatar bytes through `MediaStore`.
- Store raw imported payload only as hash and diagnostics unless a dedicated upload/archive route is added.

### Player Identity

Use the current player character path:

- The active player remains a `Character` with `type: "player"`.
- Session-specific values live in `Character.fields`.
- Stable preference facts use `working_memory.set` when `COVEL_WORKING_MEMORY_V1` is enabled.
- The context-level Persona path uses `SessionContextSnapshot.activePersona`.

Plugin shape:

- plugin id: `player-identity`
- pre-game runtime can reuse `create-form`.
- RPC actions can update profile fields after session start.
- UI panel reads characters through API or mirrored plugin data.

Storage:

- `plugin_data[player-identity]["profiles"][profileId]`
- `plugin_data[player-identity]["session-binding"]["current"]`
- `Character.fields.identityProfileId`

Context changes:

- Fill `activePersona` in `buildSessionContextSnapshot()`.
- Convert active persona into a `ContextContribution` with kind `persona_description`.
- Render persona contributions into Prompt V2 through the contribution pipeline.

### Living World Rules

Use the existing lorebook table as canonical storage:

- `LorebookEntryRecord.strategy`: `constant` or `selective`
- `keys`: trigger keywords
- `position`: current string field
- `insertionOrder`: deterministic ordering
- `enabled`: player toggle
- `extra`: structured rule metadata

Suggested `extra` shape:

```ts
interface LivingWorldRuleExtra {
  readonly kind: "constant" | "triggered" | "evolving";
  readonly category?:
    | "character"
    | "scene"
    | "relationship"
    | "world"
    | "style";
  readonly coordinate?: {
    readonly position: "before_plugin" | "after_plugin" | "at_depth";
    readonly depth?: number;
  };
  readonly budgetClass?: "sticky" | "flexible" | "droppable";
  readonly owner?: {
    readonly pluginId?: string;
    readonly characterId?: string;
  };
}
```

Implementation tasks:

1. Add a lorebook upsert API route, or route all writes through a `living-world-rules` plugin RPC action that emits `lorebook.upsert`.
2. Extend `session-context.ts` to convert selected lorebook entries into `ContextContribution[]`.
3. Extend `prompt-assembler.ts` to render `lore_entry` contributions into Seg 4, Seg 6, and Seg 8.
4. Add tests in `packages/context/tests` for keyword activation, position, ordering, and budget behavior.

### Reply Candidates

Store MVP candidate state in plugin data:

- plugin id: `branch-reply`
- namespace `turns`, key `<turnId>`
- namespace `message`, key `<turnId>` for inline candidate UI if needed

Shape:

```ts
interface ReplyCandidateSet {
  readonly turnId: string;
  readonly acceptedCandidateId: string;
  readonly candidates: readonly ReplyCandidate[];
}

interface ReplyCandidate {
  readonly id: string;
  readonly runtimeId: string;
  readonly content: string;
  readonly createdAt: string;
  readonly source: "original" | "regenerate";
  readonly traceId?: string;
}
```

MVP behavior:

- A `branch-reply` RPC action reads target message/turn metadata.
- It manually triggers a branch runtime or calls a gateway-backed function runtime.
- It writes candidate data to plugin data.
- The frontend renders a candidate switcher through `ui.message` or a small custom component.

Context behavior:

- Canonical message history remains append-only.
- `packages/context` projects accepted candidate text onto prompt history before LLM assembly.

## Plugin Package Plan

### 1. `chat-mode-narrator`

Goal:

Dialogue-first story runtime that uses the existing `narrative.append` path.

Manifest:

```yaml
name: chat-mode-narrator
description: Dialogue-first narrator for character chat sessions.
pluginType: plugin
priority: 500
outputKind: story
model: story
promptVersion: 2
capabilities: [narrative, chat-mode]
trigger:
  type: auto
input:
  inject:
    - from: scene-cast
      field: activeCastContext
      as: "<active-cast>"
    - from: npc-graph/rag-retriever
      field: npcContext
      as: "<npc-relationships>"
summaryFocus:
  - character-intent
  - relationship-change
  - emotional-hook
```

Implementation:

- Add `plugins/chat-mode-narrator/PLUGIN.md`.
- Keep `outputKind: story` so `SessionKernel` commits as a normal assistant message.
- Use Prompt V2 `postHistory` to require a concise dialogue-oriented output contract.
- Use `userSettings` for dialogue ratio, prose length, and active speaker count.

Activation:

- Current version: session creation expands `chat-mode-narrator` into the Chat Mode plugin bundle and removes `narrator`.
- Later version: session creation reads `world.metadata.playstyle === "chat"` and maps narrative capability to the chat narrator.

Code area for later activation:

- `apps/server/src/routes/api/session.ts`
- `apps/web/src/stores/session-store.tsx` `startGame`

### 2. `scene-cast`

Goal:

Choose active speakers before the narrator runs.

Manifest:

```yaml
name: scene-cast
description: Select active speakers for chat-mode turns.
pluginType: plugin
runtimeType: function
handler: ./handler.js
priority: 450
outputKind: system
capabilities: [scene-cast]
trigger:
  type: scheduled
  interval: 1
```

Handler logic:

- Read characters from `ctx.store` for bundled plugin execution.
- Read `npc-graph` plugin data where available.
- Read recent messages through store view.
- Score characters by player mention, scene presence, relationship salience, and cooldown.
- Return:

```js
{
  activeCastContext: "...",
  pluginData: [
    { namespace: "active-cast", key: "current", value: { speakers, reason, turnId } }
  ]
}
```

Narrator integration:

- `chat-mode-narrator` injects `scene-cast.activeCastContext`.
- Group chat becomes a scheduling problem rather than a prompt-only instruction.

### 3. `character-blueprint`

Goal:

Normalize character-card-like data into Covel blueprints and instantiate them as session characters.

Runtime/RPC plan:

- `rpc.import-card`: parse card JSON or uploaded metadata.
- `rpc.create-blueprint`: save manual blueprint.
- `rpc.instantiate-blueprint`: emit or directly commit a character upsert through approved service code.
- Optional `runtimeType: function` for import flows needing `ctx.media`.

Implementation files:

- `plugins/character-blueprint/PLUGIN.md`
- `plugins/character-blueprint/rpc/import-card.js`
- `plugins/character-blueprint/rpc/instantiate-blueprint.js`
- `plugins/character-blueprint/ui/blueprints-panel.json`

Current API fit:

- Action-level RPC handlers get scoped store through `createRpcHandlerStoreView`.
- Broader character upsert through RPC currently needs either a runtime-level trigger that returns `character.upsert`, or a server-side helper exposed to trusted bundled RPC handlers.
- The first implementation should use runtime-level function execution so it can return proposal-shaped output and pass through `processRuntimeResult()`.

### 4. `player-identity`

Goal:

Turn Persona into a Covel player identity layer.

Implementation:

- Extend `char-creator/player-init` to read a selected identity profile from plugin data.
- Add a `player-identity` UI panel for saved profiles.
- Add a `player-identity` RPC action for setting the active profile.
- Fill `SessionContextSnapshot.activePersona` from `plugin_data[player-identity]["session-binding"]["current"]`.

Feature flag considerations:

- Use `Character.fields` for always-on identity.
- Use `working_memory.set` only when `COVEL_WORKING_MEMORY_V1` is enabled.

### 5. `living-world-rules`

Goal:

Provide a World Info-like editor using Covel lorebook and Prompt V2.

MVP:

- UI panel lists lorebook entries with enable/delete actions using existing routes.
- Add create/update through plugin RPC that emits `lorebook.upsert`.

Full implementation:

- Add direct API route:
  - `POST /api/sessions/:id/lorebook`
  - `PUT /api/sessions/:id/lorebook/:entryId`
- Add frontend service methods in `apps/web/src/services/api.ts`.
- Add catalog/editor components if json-render cannot handle editing ergonomics.
- Compile enabled entries into `ContextContribution` and Prompt V2 segments.

### 6. `scene-prompts`

Goal:

Use the existing guide architecture for chat-oriented quick replies.

Implementation path:

- Add `plugins/scene-prompts` as a sibling Chat Mode prompt plugin.
- Run after `chat-mode-narrator` through `upstreamRequired`.
- Reuse `ui.message` and `plugin_data.message`.
- Use existing `PluginMessageBlock` handlers:
  - `draftMessage`
  - `sendMessage`
  - `setComposerText`

Recommended categories:

- `say`
- `do`
- `ask`

Current code advantage:

The frontend already renders `plugin_message` blocks and locks old prompt chips after later user messages.

### 7. `branch-reply`

Goal:

Offer regenerate/swipe while respecting append-only history in the first version.

Implementation path:

- Add a small message action in `chat-messages.tsx` for story messages from chat narrator.
- Call `postPluginRpc(sessionId, { pluginId: "branch-reply", runtimeId: "branch-reply", payload })` with `payload.action = "createCandidates"` or `"acceptCandidate"`.
- Store candidates in `plugin_data[branch-reply]["turns"][turnId]`.
- Render candidate controls through `ui.message` and `BranchReplyCandidates`.

Future context integration:

- Keep original stored message for audit and trace.
- Accepted candidate projection is implemented in `packages/context/src/branch-reply-history.ts` and applied during runtime prompt assembly.

### 8. `character-presence`

Goal:

Bind avatar, sprites, voice, generated media, and background assets to characters and blueprints.

Implementation:

- Store media references in blueprint and presence plugin data.
- Use `ctx.media.put()` and `ctx.media.ingestUrl()` for imports.
- Use `assetGenerations[]` for generated image/audio results.
- Render with existing `Media`, `AudioPlayer`, and `AssetRender` components.

Slot integration:

- Use `ctx.gateway.resolveSlot({ fallbackTag: "image" })` for provider-specific image runtimes.
- Add speech/transcription only after the ai-provider slot tags and adapters are stable for audio output.

## Context Contribution Pipeline

The existing `ContextContribution` type is the right foundation. Implement it in three steps.

### Step 1: Compile Contributions In `session-context.ts`

Add functions:

- `compileLorebookContributions(lorebookRecords, activationInput)`
- `compilePersonaContribution(activePersona)`
- `compileCharacterOverlayContributions(characters)`

Activation input should include:

- current player message
- active cast names
- recent accepted assistant text
- world tags

Return contributions into `SessionContextSnapshot.contributions`.

### Step 2: Render Contributions In Prompt V2

Extend `prompt-assembler.ts`:

- `lore_entry` with `position: "before_plugin"` -> segment 4
- `lore_entry` with `position: "after_plugin"` -> segment 6
- `lore_entry` with `position: "at_depth"` -> segment 8 message insertion
- `persona_description` -> segment 3 prepend or at-depth based on coordinate
- `character_overlay` -> segment 3 append

Keep current `authorsNote` and `postHistory` manifest aggregation.

### Step 3: Tests

Add tests:

- `packages/context/tests/context-contributions.test.ts`
- `packages/context/tests/lorebook-activation.test.ts`
- `packages/context/tests/persona-context.test.ts`
- `packages/runtime/tests/chat-mode-scheduling.test.ts`

Cases:

- selective rule matches keyword
- disabled rule stays excluded
- insertion order is stable
- at-depth contribution appears in message array
- active persona injects at expected coordinate
- character overlay respects active cast selection

## Frontend Implementation Plan

### Right Panels

Use `ui.right` for:

- Character Blueprints
- Player Identity
- Living World Rules
- Scene Cast
- Branch Replies
- Character Presence

Use json-render first. Add catalog components for:

- card import/drop zone
- lorebook row editor
- reply candidate switcher
- avatar/sprite selector

Catalog file:

- `apps/web/src/lib/catalog.tsx`

### Message Surface

Use `ui.message` and `plugin_data.message` for:

- scene prompt chips
- candidate switchers
- import success cards
- relationship beat notifications

Existing flow:

1. Plugin writes `pluginData` namespace `message` with `__turnId`.
2. `session-store` synthesizes `plugin-message:<pluginId>:<turnId>`.
3. `ChatMessages` renders `PluginMessageBlock`.
4. `PluginPanel` handles clicks through json-render handlers.

### Story Message Actions

Add compact action buttons on story messages only for active chat sessions:

- regenerate
- candidate selector
- generate image, already present by image-generation capability

Code area:

- `apps/web/src/components/session/chat-messages.tsx`

Detection:

- active plugin has capability `chat-mode`
- message `kind === "story"`
- message `runtimeId === "chat-mode-narrator"` or any active narrative runtime with chat-mode capability

## Activation Model

### MVP Activation

Client passes plugins explicitly on session creation:

```ts
[
  "pregame",
  "world-init",
  "char-creator",
  "chat-mode-narrator",
  "guide",
  "codex",
  "npc-graph",
  "memory",
  "scene-cast",
  "character-blueprint",
  "character-presence",
  "player-identity",
  "living-world-rules",
  "branch-reply",
];
```

Required bundled core plugins still come from `requiredCorePluginIds()`.

### World Metadata Activation

Later, add a playstyle field to world metadata:

```yaml
metadata:
  playstyle: chat
  chat:
    defaultPlugins:
      - chat-mode-narrator
      - scene-cast
      - scene-prompts
```

Server-side changes:

- `apps/server/src/routes/api/session.ts` reads world metadata during session creation.
- It merges chat default plugins with requested plugins.
- Capability conflicts should be resolved by explicit mapping, for example default narrator vs chat narrator.

Frontend changes:

- World select or prep screen surfaces playstyle.
- Settings can override active plugins before start.

## Phased Delivery

### Phase 1: Chat Narrator And Prompt Chips

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- `chat-mode-narrator` plugin.
- Guide chat-mode output through existing `ui.message`.
- Chat playstyle selectable by explicit plugin list.

Minimal code changes:

- plugin files only
- optional frontend toggle in prep screen

Tests:

- narrator emits `narrativeOutput`
- `outputKind: story` creates assistant message
- guide writes message namespace and frontend renders plugin message surface

Implemented behavior:

- `plugins/chat-mode-narrator/PLUGIN.md` defines a Prompt V2 story runtime with `outputKind: story`, `model: story`, and `capabilities: [narrative, chat-mode]`
- runtime injects `scene-cast.activeCastContext` and optional `npc-graph/rag-retriever.npcContext`
- `postHistory` enforces dialogue-first story output with configurable dialogue ratio, reply length, and active speaker count
- `apps/server/src/routes/api/session.ts` expands requested `chat-mode-narrator` into the Chat Mode bundle and removes the default `narrator`
- session plugin tests verify Chat Mode bundle expansion and narrator replacement

### Phase 2: Scene Cast

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- `scene-cast` function runtime.
- `chat-mode-narrator` injects active cast.
- right panel for active cast debug view.

Minimal code changes:

- plugin files
- tests around runtime scheduling and inject output

Implemented behavior:

- `plugins/scene-cast/PLUGIN.md` defines a deterministic function runtime with `priority: 450`, `outputKind: system`, and `capabilities: [scene-cast]`
- `plugins/scene-cast/handler.js` selects active speakers from available character and recent message state
- runtime writes current cast context to plugin data and exposes `activeCastContext` for downstream injection
- right-side panel renders the active cast debug surface
- `plugins/scene-cast/tests/chat-foundation.test.js` verifies runtime ordering and Chat Narrator input injection

### Phase 3: Character Blueprint

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- shared `CharacterBlueprint` type
- bundled `character-blueprint` plugin
- import and instantiate runtime/RPC
- UI panel

Code changes:

- `packages/shared/src/types/character-blueprint.ts`
- `packages/shared/src/types/index.ts`
- plugin files
- runtime-level function path that emits proposal-shaped output

Implemented behavior:

- shared blueprint types are exported from `packages/shared/src/types/character-blueprint.ts`
- `plugins/character-blueprint/PLUGIN.md` declares a manual function runtime with right-panel UI
- `plugins/character-blueprint/handler.js` imports JSON or structured blueprint payloads into `plugin_data[character-blueprint][blueprints]`
- instantiate flow emits `character.upsert` with `mirrorPluginId: "character-blueprint"` so compact character snapshots remain available through plugin data
- plugin tests cover manifest UI loading, blueprint persistence, and character upsert proposal behavior
- Chat Mode bundle includes `character-blueprint`

### Phase 3.5: Scene Prompts

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- Chat Mode quick-reply prompt plugin
- prompt chip message block
- draft/send/set-composer actions through existing plugin message handlers

Code changes:

- `plugins/scene-prompts/PLUGIN.md`
- `plugins/scene-prompts/tools/generate-scene-prompts.js`
- `plugins/scene-prompts/ui/scene-prompts-block.json`
- `apps/server/src/routes/api/session.ts`
- existing `PluginMessageBlock` catalog handlers

Implemented behavior:

- `scene-prompts` runs after `chat-mode-narrator` through `upstreamRequired`
- `generate-scene-prompts` writes scene title and up to six prompt slots into the `message` namespace
- `ui.message` renders scene-oriented prompts as reusable chat action chips
- prompt chips can draft, send, or set composer text through existing `PluginMessageBlock` actions
- Chat Mode bundle includes `scene-prompts`

### Phase 4: Player Identity And Persona Context

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- `player-identity` plugin
- profile save and activation panel
- active persona loaded into `SessionContextSnapshot.activePersona`
- persona contribution rendered in Prompt V2

Code changes:

- `packages/shared/src/types/player-identity.ts`
- `packages/context/src/session-context.ts`
- `packages/context/src/prompt-assembler.ts`
- `plugins/player-identity`

Implemented behavior:

- saves normalized player identity profiles in `plugin_data[player-identity][profiles]`
- stores the active binding in `plugin_data[player-identity][session-binding][current]`
- syncs identity references into the player `Character.fields`
- compiles the active identity into `ContextContribution.kind = "persona_description"`
- renders persona contributions in Prompt V2 `seg3_prepend`, `seg3_append`, or `at_depth`
- includes `player-identity` in the Chat Mode session bundle

### Phase 5: Living World Rules

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- lorebook editor
- rule create/update
- contribution activation and Prompt V2 Seg 4/6/8 rendering

Code changes:

- `apps/server/src/routes/api/lorebook.ts`
- `apps/web/src/services/api.ts`
- `packages/context/src/session-context.ts`
- `packages/context/src/prompt-assembler.ts`
- UI plugin/catalog components

Implemented behavior:

- `living-world-rules` plugin saves rules to `plugin_data[living-world-rules][rules]`
- plugin runtime emits `lorebook.upsert` through the proposal pipeline
- REST lorebook API supports `POST`, `PUT`, enabled toggle, delete, and list
- Context loader compiles enabled constant lorebook entries every turn
- Context loader activates selective entries from current player-message keywords
- Prompt V2 renders `lore_entry` contributions into Segment 4, Segment 6, and at-depth message insertion

### Phase 6: Branch Reply

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- regenerate action on story messages
- candidate storage in plugin data
- candidate UI
- accepted candidate context swap

Code changes:

- `plugins/branch-reply`
- `apps/web/src/components/session/chat-messages.tsx`
- `apps/web/src/lib/catalog.tsx`
- `apps/web/src/stores/session-store.tsx`
- `packages/context/src/branch-reply-history.ts`
- `packages/runtime/src/turn-executor.ts`
- `packages/shared/src/types/branch-reply.ts`

Implemented behavior:

- branch reply manual runtime writes candidate sets to `plugin_data[branch-reply][turns][turnId]`
- runtime writes message surface state to `plugin_data[branch-reply][message][turnId]`
- frontend synthesizes keyed message namespace entries into `plugin_message` blocks
- `BranchReplyCandidates` supports draft, send, accept, and regenerate controls
- accept/regenerate use runtime-level plugin RPC with `payload.action`
- runtime validates selected and accepted candidate ids against stored candidate sets
- accepted candidate text is projected onto LLM prompt history while stored messages remain append-only
- Chat Mode bundle includes `branch-reply`

### Phase 7: Character Presence

Status: implemented in the current branch as a Covel-native MVP.

Deliver:

- avatar import
- sprite/media panel
- generated character image support
- audio presence after provider support is ready

Code changes:

- `plugins/character-presence`
- `packages/shared/src/types/character-presence.ts`
- `apps/server/src/routes/api/session.ts`
- media tests

Implemented behavior:

- character presence plugin stores per-character presence under `plugin_data[character-presence][presence][characterId]`
- presence records support avatar, sprite, voice, and typed media refs
- runtime validates media refs and safe media map keys before writing plugin data
- Chat Mode bundle includes `character-presence`

## Priority Recommendation

The current branch has completed the Chat Mode foundation across Phase 1 through Phase 7 as a Covel-native MVP. Next priority is product hardening: add end-to-end API coverage for the full Chat Mode loop, add browser checks for the right-panel and message-block surfaces, and refine world metadata activation so chat-oriented worlds can enable the bundle from world configuration.
