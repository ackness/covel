# Current covel Extension Architecture

Use this reference when deciding where a feature belongs in the extension host.

## Core Host Contracts

- Manifest v1: `modules/package-runtime/src/manifest.ts`
- Package registration: `modules/package-runtime/src/runtime.ts`
- Block envelope / response: `modules/contracts/src/block.ts`
- Runtime composition: `apps/runtime/src/composition.ts`
- Flow / resume path: `modules/flow-engine/src/runtime.ts`
- Web block rendering: `apps/web/src/block-renderer-registry.tsx`

Read together with:

- `docs/EXTENSION-AUTHORING-SPEC.md`
- `docs/architecture/modernization/08-current-framework-adoption.md`

## Backend Surfaces

- `contextProviders`
  Provide world/session/turn context fragments for model turns.
- `commands`
  Slash-command surface for users/operators/agents.
- `capabilities`
  Package-owned executable units for deterministic logic, model-mediated logic, jobs, or workflows.
- `hooks`
  Runtime phase/event entry points.
- `blockTypes`
  Structured FE/BE interaction contracts.
- `artifactTypes`
  Durable outputs such as images, audio, docs, or cards.
- `settings` / `state`
  Package configuration and durable package-owned state collections.

## Frontend Surfaces

- Host-known block types are the default UI contract:
  - `choices`
  - `choice_set`
  - `dice_result`
  - `image_card`
  - `audio_clip`
- Web Host can resolve first-party package renderers from `extensions/*/client/renderers/*.tsx`.
- Host renderer remains authoritative. Do not assume arbitrary third-party frontend code is safe to load.
- Preferred host expansion direction is:
  - block registry
  - artifact registry
  - panel registry
  - inspector registry
  but still under host-owned allowlists.

## Provider Routing

- Packages do not own providers directly.
- Packages express model intent through:
  - `modelPolicy.preferredTier`
  - permissions such as `invoke:model`
  - task bindings / presets / connection profiles chosen by the host
- Model traffic must remain inside `modules/model-gateway`.
- Storage direction is `Postgres-first`, but repository contracts must continue to support in-memory and PostgreSQL paths.

## FE/BE Handshake

Prefer this split:

- backend decides:
  - what command/context/capability/block/artifact is needed
- frontend renders:
  - host-known blocks
  - trusted package renderer only when justified
- interaction returns through:
  - `submit_block_response`
  - package-owned resume handler

Current stable output surfaces:

- `message`
- `block`
- `artifact`

Planned but not yet default:

- `state_patch`
- `workflow_event`

Do not invent a parallel widget transport.
