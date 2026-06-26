# @covel/plugin-director

Narration director for the main story voice. **Opt-in, disabled by default.**

director is a cross-cutting framework-capability plugin: it carries no
schedulable runtime and writes nothing to the store. It shapes the narrative
voice entirely through a single lifecycle hook declared in `PLUGIN.md`.

## Behaviour

| Hook                  | Effect                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostContextAssembly` | Once a runtime's context is assembled (after `buildContext`, before the agent loop), appends a static director preamble to the **story** runtime's system prompt. Story is identified by `payload.outputKind === "story"`. |

Every non-story runtime (codex / guide / extractors / system) returns a plain
`continue` and is left byte-for-byte unchanged.

## Why `outputKind`, not a plugin id

The framework forbids plugins from hardcoding concrete plugin ids
(framework/plugin isolation rule). The `PostContextAssembly` payload carries a
read-only `outputKind` field (`story` / `plugin` / `system`), so director can
target the narrative voice without naming any specific runtime.

## The preamble

`hooks/_preamble.js` is a frozen text constant — directing guidance only
(open in motion, sensory grounding, scene shape, character fidelity, leaving
room for the player). It refines _delivery_ and explicitly never overrides world
canon or the system instructions it follows.

## Scope & isolation

The hook is a pure **rewrite**: it only reshapes the assembled system prompt it
is handed. It never touches the store, never emits proposals, and never calls the
LLM itself.

## Enabling

Add `director` to a world's plugin set, or enable it for a session via
`POST /api/sessions/:id/plugins/enable`. Its hook then scopes to that session
only (framework hook scoping); other sessions are unaffected.

## Tests

```bash
pnpm --filter @covel/plugin-director test
```
