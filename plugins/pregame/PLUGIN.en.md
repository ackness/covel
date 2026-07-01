---
name: pregame
displayName:
  zh: 开局准备
  en: Pre-Game Setup
description:
  zh: 在开局时读取世界资料，准备好第一段冒险。
  en: Reads the world details at the start and prepares the first step of the adventure.
pluginType: core-plugin
priority: 10
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
---

# Pre-Game Initialization Plugin

This is a `runtimeType: function` plugin. It does NOT call the LLM — it runs the pure function in `handler.js` directly.

## When it runs

Priority 10 — inside the Pre-Game band (0–99) — so it fires only on the very first turn of a session (`turnCount = 0`). `maxTriggerCount: 1` guarantees a one-shot run. When it completes, the kernel records this runtime in `session.preGameCompleted`.

## Responsibilities

1. Read world metadata and build a welcome notification
2. Return `narrativeOutput` so later plugins have context
3. Report `preGameDone: true` so the kernel advances `turnCount` to 1

## Output

```json
{
  "narrativeOutput": "World overview text ...",
  "notifications": [{ "level": "info", "title": "...", "message": "..." }],
  "initialized": true,
  "preGameDone": true
}
```
