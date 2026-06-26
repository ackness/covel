# @covel/plugin-story-guard

Story-output safety / style guard. **Opt-in, disabled by default.**

story-guard is a cross-cutting framework-capability plugin: it carries no
schedulable runtime and writes nothing to the store. It guards output entirely
through two lifecycle hooks declared in `PLUGIN.md` — it only **rewrites** and
**vetoes**, never carrying gameplay logic.

## Behaviour

| Hook              | Effect                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostLLMResponse` | Deterministically sanitises `response.content` (red-line redaction + choice-menu stripping) and rewrites via `replace.response`, preserving `toolCalls` / `finishReason` / `usage`. |
| `PreToolUse`      | Aborts calls to high-risk tools (configurable deny-list), skipping that single tool without ending the turn.                                                                        |

### Why the sanitiser is conservative

PostLLMResponse only honours `replace.response`; the handler returns the full
`LLMResponse` with `content` swapped, and falls back to a plain `continue` when
content is empty / non-string, unchanged, or would be blanked. The rules
(`hooks/_rules.js`) anchor to whole lines or boilerplate markers so they do not
touch ordinary narrative:

- **Red-line redaction** — strips AI/model self-identification boilerplate
  (EN needs "model"; ZH needs a model/assistant suffix) and Llama template
  tokens (`[INST]`, `<<SYS>>`). Hosts add literal banned terms via
  `STORY_GUARD_REDACT_TERMS` (→ `STORY_GUARD_REDACT_MARK`, default `[redacted]`).
- **Menu stripping** — drops enumerated option lines (`A) …`, `1. …`, `B、…`,
  `(C) …`) and explicit menu headers ending in a colon (`你的选择是：`,
  `Options:`). ASCII markers require a following space (so `1.5 …` is safe);
  headers require a trailing colon (so `你想做什么？` is left alone).

### Why the tool gate is in the handler, not `match`

The loader's frontmatter `match` is a shallow equality test over the _top-level_
payload keys (`toolCall` / `pluginId` / `runtimeId`), while the tool name is
nested at `toolCall.name`. A `match: { name: ... }` would therefore never fire.
The gate lives in `hooks/guard-tool.js` (`isBlockedTool` reads
`payload.toolCall.name`) against a deny-list of defaults plus
`STORY_GUARD_BLOCKED_TOOLS`.

## Configuration

| Env                         | Default      | Meaning                                                            |
| --------------------------- | ------------ | ------------------------------------------------------------------ |
| `STORY_GUARD_REDACT_TERMS`  | _(none)_     | Comma-separated literal terms redacted to the marker.              |
| `STORY_GUARD_REDACT_MARK`   | `[redacted]` | Replacement marker for `STORY_GUARD_REDACT_TERMS`.                 |
| `STORY_GUARD_BLOCKED_TOOLS` | _(none)_     | Comma-separated extra tool names to block (added to the defaults). |

Thresholds are read lazily, so a deployment can change them without a restart.

## Enabling

Add `story-guard` to a world's plugin set, or enable it for a session via
`POST /api/sessions/:id/plugins/enable`. Its hooks then scope to that session
only (framework hook scoping); other sessions are unaffected.

## Tests

```bash
pnpm --filter @covel/plugin-story-guard test
```
