---
name: pregame
description:
  zh: 游戏初始化插件。仅在 session 首轮触发，读取世界信息、欢迎玩家、上报 preGameDone。纯函数执行，不调用 LLM。
  en: Game initialization plugin. Fires only on the first turn of a session — reads world metadata, greets the player, and reports preGameDone. Pure function runtime, never calls the LLM.
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
