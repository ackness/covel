# Extension Authoring Spec

This document defines how new `covel` extensions should be designed so that:

- backend and frontend integrate through stable host contracts
- model routing remains host-controlled
- package logic stays easy to scaffold and fast to extend

This spec should be read together with:

- `docs/architecture/modernization/08-current-framework-adoption.md`

That document defines which modernization ideas are already part of the current framework direction.

In particular, this spec assumes these current framework directions are real:

- `context-centric` turn assembly
- `artifact-native` outputs
- `Postgres-first, but dual-path storage`
- `host runtime` frontend model
- future `state_patch / workflow_event` outputs without changing package/provider ownership rules

## 1. Package Responsibilities

An extension/package may contribute:

- `contextProviders`
- `commands`
- `hooks`
- `capabilities`
- `blockTypes`
- `renderers`
- `artifactTypes`
- `settings`
- `state`

Not every package should use every surface.

Preferred split:

- `context-only` package
  worldbook, persona, character-card, memory
- `command-only` package
  debug/import/admin tools
- `block + resume` package
  choices, forms, mechanics, confirmations
- `media` package
  image/audio/artifact-producing logic

## 2. Backend Interface Rules

### 2.1 Commands

Use commands for:

- operator actions
- imports/inspection/debugging
- explicit user-invoked package behavior

Commands should return:

- `content`
- optional `blocks`
- optional artifact references through host contracts

### 2.2 Context Providers

Use context providers for:

- world facts
- narrator/persona style
- recent memory/state
- package-specific instructions or references

Context providers are the primary way packages influence model output in normal turns.

This is now the preferred extension surface for modernization ideas such as:

- layered memory
- world/entity/state read models
- retrieval-backed prompt assembly

### 2.3 Capabilities

Use capabilities for:

- deterministic mechanics
- package-owned workflows
- future tool exposure
- resumable interaction handlers

Capabilities are the right place for package logic that should not be expressed as a slash command.

### 2.4 Hooks

Use hooks for:

- phase-based or event-based package reactions
- post-narration or post-resolution work

Hooks should remain host-scheduled, not self-triggered.

## 3. Frontend Interface Rules

Frontend and backend should meet through:

- `BlockEnvelope`
- `BlockResponse`
- trusted host renderers

Framework target output surfaces:

- `message`
- `block`
- `artifact`
- later `state_patch`
- later `workflow_event`

Use host-known block types first:

- `choices`
- `choice_set`
- `dice_result`
- `image_card`
- `audio_clip`

Add a package renderer only when:

- the presentation is package-specific
- schema fallback is not enough
- the host agrees to load that renderer

Prefer host registries over package-defined transport or layout systems.

## 4. Provider Routing Rules

Packages do not own providers directly.

If a package needs model behavior, it must go through:

- `modules/model-gateway`
- host-injected `modelGateway`
- task bindings / presets / connection profiles

Allowed package signal:

- `modelPolicy.preferredTier`

Not allowed:

- direct OpenAI / Anthropic / DashScope SDK calls
- package-chosen provider fallback logic
- provider secrets in package business logic

Modernization alignment:

- adopt now:
  - host-routed provider selection
  - context-centric prompt assembly
  - artifact-native outputs
- adopt later:
  - tool-exposed capabilities
  - workflow snapshots
- avoid for now:
  - per-package provider ownership
  - direct third-party orchestration frameworks inside package business logic

## 5. How Extensions Teach LLMs And Agents

Use different surfaces for different audiences.

### 5.1 Agent-Facing

- `SKILL.md`
- `manifest.description`
- `command.help`
- `command.autocomplete`

These should teach Codex or other agents:

- what the package does
- when to use it
- what command/capability/block surfaces exist

### 5.2 Runtime Model-Facing

- `contextProviders`
- capability schemas
- block schemas
- prompt/task bindings from the host

Do not assume runtime models read package `SKILL.md`.

## 6. FE/BE Operation Model

The default package lifecycle is:

1. host selects task/preset
2. package context providers add turn context
3. package command/capability/hook runs
4. backend emits message/block/artifact
5. frontend renders via trusted host surfaces
6. user responds through `submit_block_response`
7. package-owned resume handler continues the flow

This should be the default design unless there is a clear reason to deviate.

This is also where modernization guidance applies:

- now:
  - `message + block + artifact` should remain the primary FE/BE handshake
  - `command -> validation -> execution -> persist -> emit` should remain the write model
- later:
  - `state_patch`
  - typed stream parts
  - workflow events
- not now:
  - package-defined transport protocols

## 7. Package Documentation Requirements

Every package should have:

- `manifest.json`
- `SKILL.md`
- matching JSON schemas for every declared command/capability/block/state surface

Recommended package `SKILL.md` sections:

- purpose
- surfaces
- boundaries
- usage examples

Keep it concise; move deep reference content out only when necessary.

## 8. Scaffolding Guidance

A scaffolded package should default to:

- smallest valid manifest
- minimal permissions
- no provider hardcoding
- no unnecessary renderer
- no settings/state unless the feature requires them
- no new sync/runtime protocol
- no assumption of local-first execution

The fastest packages to build should be:

- command-only
- context-only
- host-known block + resume

These are intentionally the same surfaces that can absorb modernization ideas earliest.

Examples:

- `context-only`
  worldbook, persona, memory, state summaries
- `host-known block + resume`
  guide/choices, confirmation flows, structured mechanic results
- `artifact-native`
  image/audio/document outputs without inventing a parallel UI protocol

When a package needs stateful gameplay behavior, prefer:

- context provider
- package capability
- package state collection
- host-applied state patch

before introducing a custom workflow/runtime abstraction inside the package.

## 9. Design Smells

These are signs the package design is wrong:

- command used where context provider should exist
- package renderer added for a host-known block type without need
- direct provider/model selection inside package logic
- interaction resumed through prompt hacks instead of resume handler
- package docs only describe user behavior but not host integration surfaces
- package tries to introduce a new sync/runtime protocol instead of fitting `host runtime + storage + flow-engine`
- package jumps to heavy GraphRAG or workflow machinery before `contextProviders / packageState / blocks` are exhausted
