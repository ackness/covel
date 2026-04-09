---
name: core-pregame
description: Game initialization plugin. Triggers only on the first turn of a session to initialize world state, set phase, and welcome the player. Pure function execution, no LLM calls.
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

Priority 0, belongs to the Pre-Game phase (0-100), executes only on the first Turn of a session.

## Responsibilities

1. Initialize world state (read dimension information from world manifest)
2. Set session phase to `playing` (or `character_creation`, depending on whether the char-creator plugin is present)
3. Return a welcome notification and world lore summary for subsequent plugins to reference

## Output

```json
{
  "narrativeOutput": "World lore summary text...",
  "phase": "character_creation",
  "notifications": [{ "level": "info", "title": "...", "message": "..." }],
  "initialized": true
}
```
