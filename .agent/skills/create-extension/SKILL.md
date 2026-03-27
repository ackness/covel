---
name: create-extension
description: "Create or update a `covel` extension/package that fits the current host architecture: manifest v1, package-runtime registration, host-routed model access, command/block/capability contracts, and frontend/backend integration through trusted host surfaces. Use when scaffolding a new extension under `extensions/`, revising an existing package shape, or deciding how a feature should be split across commands, context providers, capabilities, hooks, block types, renderers, settings, and state."
---

# Create Extension

Use this skill when working on `extensions/*`.

## Read First

Read these before changing package shape:

- `docs/EXTENSION-AUTHORING-SPEC.md`
- `docs/EXTENSION-PLATFORM-ARCHITECTURE.md`
- `modules/package-runtime/src/manifest.ts`
- `modules/contracts/src/block.ts`

Read these only when needed:

- `references/current-extension-architecture.md`
- `references/current-manifest-fields.md`
- `references/llm-surface-guidelines.md`

## Routing

Pick the smallest surface that matches the feature:

- `command`
  For operator/debug/import actions such as `/world-seeds`.
- `context-only`
  For world/session/turn context that should influence model output but not render UI directly.
- `interaction-choice`
  For package-owned interactive choice flows with resume.
- `mechanic-dice`
  For deterministic rules/mechanics with package state.
- `media-image`
  For image jobs/artifacts/blocks.
- `media-audio`
  For audio/TTS jobs/artifacts/blocks.

Do not default to a command when the feature is really `context`, `capability`, or `block + resume`.

## Hard Rules

- Keep manifest at `schemaVersion: "1.0"`.
- Package code must not call OpenAI, Anthropic, DashScope, or raw provider HTTP directly.
- If a package needs model access, it uses host-injected `modelGateway` only when permissions allow it.
- A package does not own its own provider. Package-level model choice must be expressed through:
  - `modelPolicy.preferredTier`
  - task bindings / presets / connection profiles
- Frontend/backend integration goes through host contracts:
  - commands
  - context providers
  - capabilities / hooks
  - blocks
  - artifacts
- Prefer host-known block types first:
  - `choices`
  - `choice_set`
  - `dice_result`
  - `image_card`
  - `audio_clip`
- Add a package renderer only when host-known rendering is insufficient.

## LLM-Facing Surfaces

Each extension should teach both the host agent and runtime model through structured surfaces, not ad hoc prose.

- `manifest.description`
  Short human/agent summary of package purpose.
- `SKILL.md`
  Agent-facing workflow and boundaries for using or editing the package.
- `command.help` / `command.autocomplete`
  How agents and users discover commands.
- `context providers`
  Runtime model-facing facts/instructions/memory fragments.
- `capability` schemas + descriptions
  Structured contract for package-owned logic and future tool exposure.
- `block` schemas
  Backend/frontend contract for interaction and rendering.

Keep package `SKILL.md` concise. Put deep details in package-local references only if they are genuinely needed.

## Frontend/Backend Split

- `server/`
  Backend contributions: commands, context providers, hooks, capabilities.
- `client/`
  Renderer modules only when a package-specific UI is justified.
- `schemas/`
  JSON schemas for commands, capabilities, blocks, settings, state.
- `assets/`
  Seed content, templates, examples, or static media inputs.

Use blocks as the primary FE/BE handshake. Do not invent a parallel widget protocol.

## Scaffold

Use the bundled script for initial structure, then patch the result:

```bash
python3 .agent/skills/create-extension/scripts/scaffold_extension.py \
  --repo-root <repo-root> \
  --name <extension-name> \
  --template <template> \
  --description "<description>"
```

## Verification

When this skill changes:

```bash
python3 /Users/wuyong/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agent/skills/create-extension
```

For extension work inside `covel`, run focused verification such as:

```bash
pnpm vitest run modules/package-runtime/tests/*.test.ts
pnpm vitest run apps/runtime/tests/*.test.ts
pnpm vitest run apps/web/tests/*.test.tsx
```

## Deliverables

For extension authoring work, deliver:

1. The smallest valid package shape under `extensions/<name>/`
2. Matching schema files for every declared command/capability/block/state entry
3. A short note covering:
   - chosen template
   - backend surfaces
   - frontend surfaces
   - provider/task routing assumptions
   - verification run
