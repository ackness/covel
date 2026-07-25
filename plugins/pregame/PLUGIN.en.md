---
name: pregame
displayName:
  zh: 开局准备
  en: Pre-Game Setup
description:
  zh: 在开局时读取世界资料，准备好第一段冒险。
  en: Reads the world details at the start and prepares the first step of the adventure.
pluginType: core-plugin
stage: setup
runtimeType: function
resultFormat: envelope-v1
outputKind: system
handler: ./handler.js
trigger:
  type: auto
  maxTriggerCount: 1
---

# Pre-Game Initialization Plugin

This is a `runtimeType: function` plugin. It does NOT call the LLM — it runs the pure function in `handler.js` directly.

## When it runs

`stage: setup` — scheduled only while `session.phase === "setup"`, and never again once it reports done (`maxTriggerCount: 1` is the retry budget). Completion is recorded in the `session.setupRuntimes` mirror (the API still derives the compatible `preGameCompleted` field).

## Responsibilities

1. Read world metadata and build a welcome notification
2. Return `narrativeOutput` so later plugins have context
3. Report `preGameDone: true` (`completion: "done"` under envelope-v1); once every setup runtime is done the kernel flips `phase` to playing

## Output

```json
{
  "narrativeOutput": "World overview text ...",
  "notifications": [{ "level": "info", "title": "...", "message": "..." }],
  "initialized": true,
  "preGameDone": true
}
```
