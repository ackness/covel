---
name: director
displayName:
  zh: 导演前言
  en: Director's Note
description:
  zh: 给主线叙事 runtime 注入一段“导演前言”：只塑形 story 类提示词，其它 runtime 完全不碰。
  en: Injects a "director's note" into the main narrative runtime — shapes only story-kind prompts and leaves every other runtime untouched.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - narration-director
tags:
  - role:director
  - cost:function
entry: ./server/index.js
---

# Director

A cross-cutting, **opt-in** plugin that nudges the main narrative voice through a
single lifecycle hook. It has no schedulable runtime of its own — the `function`
runtime is `trigger: manual` and never runs; the no-op handler exists only so the
`runtimeType: function` manifest is complete.

## How it works

| Hook                  | Role                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostContextAssembly` | Once a runtime's context is assembled (after `buildContext`, before the agent loop), appends a static director preamble to the **story** runtime's system prompt only. Story is identified by `payload.outputKind === "story"`, never by a hardcoded plugin id. |

The preamble (`hooks/_preamble.js`) refines _delivery_ — opening in motion,
sensory grounding, scene shape, character fidelity, and leaving room for the
player. It never overrides world canon or the system instructions it follows.

## Why `outputKind`, not a plugin id

The framework forbids plugins from hardcoding concrete plugin ids
(framework/plugin isolation rule). `PostContextAssembly` payloads carry a
read-only `outputKind` field (`story` / `plugin` / `system`) so this hook can
target the narrative voice without naming any specific runtime. Non-story
runtimes (codex, guide, extractors, etc.) return a plain `continue` and are left
byte-for-byte unchanged.

## Scope & isolation

This hook is a pure **rewrite**: it only reshapes the assembled system prompt it
is handed. It never touches the store, never emits proposals, and never runs the
LLM itself. Enabling director for a session scopes the hook to that session only
(framework hook scoping). It is disabled by default — add `director` to a world's
plugin set or enable it per session to activate.
