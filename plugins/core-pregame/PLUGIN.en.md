---
name: core-pregame
description: Game initialization plugin. Triggers only on the first turn of a session to read world info, welcome the player, and report preGameDone. Pure function execution, no LLM calls.
pluginType: core-plugin
priority: 10
runtimeType: function
handler: ./handler.js
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
---

# Pre-Game Initialization Plugin

This plugin uses `runtimeType: function`, meaning it does not call an LLM but directly executes the pure function in `handler.js`.

## Execution Timing

Priority 10, belongs to the Pre-Game band (0-99), executes only on the first Turn of a session (turnCount=0). maxTriggerCount: 1 guarantees a one-shot run. When it completes, the kernel records this runtime in `session.preGameCompleted`.

## Responsibilities

1. Read world info and build a welcome notification
2. Return `narrativeOutput` as context for downstream plugins
3. Report `preGameDone: true` to let the kernel advance `turnCount` to 1

## Output

```json
{
  "narrativeOutput": "World lore summary text...",
  "notifications": [{ "level": "info", "title": "...", "message": "..." }],
  "initialized": true,
  "preGameDone": true
}
```
