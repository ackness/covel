---
name: core-codex
description: Knowledge codex (function runtime). Deterministically extracts character/item/location/lore/skill entries from narrator output, writes them to plugin_data, and drives the codex UI cards.
pluginType: plugin
priority: 650
outputKind: system
runtimeType: function
handler: ./handler.js
timeoutMs: 120000
trigger:
  type: scheduled
  interval: 2
  cooldownTurns: 1
  phases:
    - playing
ui:
  right:
    - ./ui/codex-panel.json
  message:
    - ./ui/codex-message.json
---

## This is a function runtime

This runtime does not call an LLM. The framework invokes `handler.js` directly. The handler reads the previous narrator output via `completedResults.get('core-narrator')`, runs deterministic title-extraction rules (prefix blacklist, fragment filters, category heuristics), then persists the matched entries to `plugin_data[namespace="entries"]`.

Design intent: see the "段职责约定" section in `docs/guide/plugin-authoring.md`. core-codex is a post-narrator runtime that consumes narrator output once. Deduplication happens inside the handler instead of via cross-runtime `input.inject`.

For implementation details, read `handler.js` directly. The previous "agent tool-call workflow" prose embedded here was unrelated to actual execution and has been removed.
