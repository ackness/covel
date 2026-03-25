# Repository Guidelines

## Scope

These rules apply to the whole `covel` repository.

## Execution Style

- Follow `TDD` by default.
- Write failing tests first.
- Implement the smallest change that turns the target tests green.
- Refactor only after the relevant tests pass.
- Do not bypass failing tests by weakening assertions unless the assertion itself is incorrect.

## Subagents

- When spawning subagents for code or test work, prefer `gpt-5.4` with `medium` reasoning effort by default.
- Split work only across disjoint write sets.
- Always review subagent output before keeping it.
- Do not merge subagent code blindly.

## Provider Layer

- All model traffic must go through `modules/model-gateway`.
- Business logic must not call OpenAI, Anthropic, DashScope, or other provider SDKs or HTTP APIs directly.
- Protocol translation belongs in the custom provider layer.
- Treat `modules/model-gateway` as a capability-first kernel, not a chat-only wrapper.
- New model-facing features should fit the capability families below instead of inventing ad hoc call paths:
  - `text`
  - `object`
  - `stream`
  - `embed`
  - `image`
  - `speech`
  - `transcription`
- Route support currently targets:
  - `openai-chat-v1`
  - `openai-responses-v1`
  - `anthropic-messages-v1`
- Preserve hook points for stats, tracing, and Langfuse integration.
- User-facing model configuration should evolve toward:
  - `Connection Profile`
  - `Task Preset`
  - `World / Session task bindings`
- Extensions should request tasks or capabilities such as `story.narration` or `story.choice-generation`; they should not hardcode provider/model choices.
- Do not hardcode fallback to any single vendor/model in business logic. Fallback belongs to preset/policy configuration.

## Runtime And Packages

- Prefer package-backed commands over hardcoded runtime commands.
- If a capability belongs to a first-party package, load it through `modules/package-runtime` instead of duplicating it in `apps/runtime`.
- Keep runtime composition thin; push reusable logic down into `modules/*`.

## Storage

- Keep repository interfaces stable.
- Support both in-memory and PostgreSQL paths without changing domain APIs.
- Do not store provider secrets in business-facing metadata responses.
- If provider/profile metadata is persisted, store secret references or non-sensitive routing metadata only.

## Web Host

- Preserve the three-column workspace structure unless the product direction explicitly changes.
- Favor restrained, editor-like UI over decorative dashboard patterns.
- Reuse shared web modules instead of duplicating request/reducer logic inside `App.tsx`.
- Treat connection management, task preset editing, and session/world task bindings as first-class product surfaces, even if the earliest UI is minimal.

## i18n

- Default locale is `zh-CN`; optional locale is `en`.
- Do not add a third locale or widen locale semantics unless explicitly requested.
- Treat `i18n` as an end-to-end concern: UI chrome, API transport, runtime errors, prompts, command output, and interactive blocks must agree on locale.
- Web chrome and fallback labels should use [apps/web/src/i18n.tsx](/Users/wuyong/codes/game/covel/apps/web/src/i18n.tsx).
- Preserve locale propagation through `Accept-Language` and action `locale` fields; do not introduce user-facing runtime text that ignores request locale.
- Package and extension text should use the shared locale helpers under [extensions/shared/locale.ts](/Users/wuyong/codes/game/covel/extensions/shared/locale.ts) instead of ad hoc string branching.
- When changing user-facing text, add or update tests for both the default Chinese path and an explicit English path.

## Comments

- Add concise comments where protocol handling, streaming parsing, or persistence behavior would otherwise be non-obvious.
- Do not add decorative or redundant comments.

## Verification

Before finishing a substantial change, run the relevant subset of:

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:live`
- `pnpm build:web`

If a local build creates temporary output such as `dist/`, remove it before committing.
