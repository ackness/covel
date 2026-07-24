---
name: story-guard
displayName:
  zh: 剧情守卫
  en: Story Guard
description:
  zh: 可选的故事输出守卫：确定性净化红线短语与选项菜单，并拦截高危工具调用。
  en: Opt-in story-output guard — deterministically sanitises red-line phrases and choice menus, and blocks high-risk tool calls.
pluginType: plugin
outputKind: system
capabilities:
  - content-safety
tags:
  - role:guard
  - safety:function
entry: ./server/index.js
---

# Story Guard

A cross-cutting, **opt-in** plugin that guards story output entirely through
lifecycle hooks. It carries no schedulable runtime — its two hooks are
registered by its server entry (`server/index.js`). It writes nothing to the
store and emits no events; hooks only **rewrite** and **veto**.

## How it works

| Hook              | Role                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostLLMResponse` | Runs a **deterministic** sanitiser over `response.content`: red-line redaction + choice-menu stripping. Rewrites via `replace.response`, handing back a complete `LLMResponse` (content only). |
| `PreToolUse`      | Vetoes calls to high-risk tools (deny-list) with `abort`, which skips that single tool without ending the turn.                                                                                |

### Sanitisation (`PostLLMResponse`)

PostLLMResponse only honours `replace.response` (an `abort` is a no-op there).
To rewrite, the handler returns the **full** `LLMResponse` with only `content`
swapped, so `toolCalls` / `finishReason` / `usage` / `reasoningContent` survive.
It returns a plain `continue` (no rewrite) when content is empty / non-string,
when sanitisation changed nothing, or when sanitisation would blank the
narrative (never replace real text with whitespace).

The rules live in `hooks/_rules.js` and are intentionally conservative to avoid
mauling ordinary prose:

- **Red-line redaction** (`redactRules`): deletes AI/model self-identification
  boilerplate (EN requires the word "model"; ZH requires a model/assistant
  suffix) and Llama prompt-template artifacts (`[INST]`, `<<SYS>>`). Deployment
  can add literal banned terms via `STORY_GUARD_REDACT_TERMS` → replaced with
  `STORY_GUARD_REDACT_MARK` (default `[redacted]`).
- **Menu stripping** (`stripMenuLines`): drops whole lines that are enumerated
  options (`A) …`, `1. …`, `B、…`, `(C) …`) or an explicit menu header ending in
  a colon (`你的选择是：`, `Options:`). ASCII markers require a following space so
  decimals (`1.5 …`) are never stripped; headers require a trailing colon so
  free-form questions (`你想做什么？`) are left alone.

### Tool guard (`PreToolUse`)

The deny-list lives in the handler (`hooks/guard-tool.js` → `isBlockedTool`),
**not** in the frontmatter `match`. The loader's `match` is a shallow equality
test over the _top-level_ payload keys (`toolCall` / `pluginId` / `runtimeId`),
but the tool name is nested at `toolCall.name`, so a `match: { name: ... }`
would never fire. The handler reads `payload.toolCall.name` and aborts when it
is on the deny-list (defaults ∪ `STORY_GUARD_BLOCKED_TOOLS`).

## Configuration

| Env                         | Default      | Meaning                                                            |
| --------------------------- | ------------ | ------------------------------------------------------------------ |
| `STORY_GUARD_REDACT_TERMS`  | _(none)_     | Comma-separated literal terms redacted to the marker.              |
| `STORY_GUARD_REDACT_MARK`   | `[redacted]` | Replacement marker for `STORY_GUARD_REDACT_TERMS`.                 |
| `STORY_GUARD_BLOCKED_TOOLS` | _(none)_     | Comma-separated extra tool names to block (added to the defaults). |

All knobs are read lazily, so a deployment can change them without a restart.

## Enabling

Disabled by default. Add `story-guard` to a world's plugin set or enable it per
session; its two hooks then scope to that session only (framework hook scoping).
No plugin IDs are hardcoded anywhere — the sanitiser is content-only and the
tool guard works off a configurable tool-name deny-list.
