---
id: pregame
kind: core
displayName: Pre-Game Setup
description: >-
  Reads the world details at the start and prepares the first step of the
  adventure.
tags:
  - "cost:function"
provides: [session.opening@1]
contracts:
  session.opening@1:
    schema: ./schemas/opening.schema.json
runtime:
  type: function
  schedule:
    stage: setup
    trigger:
      type: auto
      maxTriggerCount: 1
  io:
    output:
      contract: session.opening@1
      schema: ./schemas/opening.schema.json
    visibility: system
  function:
    handler: ./handler.js
---

# Pre-Game Initialization Plugin

This is a `runtimeType: function` plugin. It does NOT call the LLM — it runs the pure function in `handler.js` directly.

## When it runs

`stage: setup` — scheduled only while `session.phase === "setup"`, and never again once it reports done (`maxTriggerCount: 1` is the retry budget). Completion is recorded in the `session.setupRuntimes` mirror.

## Responsibilities

1. Read world metadata and build a welcome notification
2. Return `narrativeOutput` so later plugins have context
3. Report `completion: "done"`; once every setup runtime is done the kernel flips `phase` to playing

## Handler result

```json
{
  "outcome": "success",
  "value": {
    "narrativeOutput": "World overview text ...",
    "initialized": true
  },
  "effects": {
    "notifications": [{ "level": "info", "title": "...", "message": "..." }]
  },
  "completion": "done"
}
```

`RuntimeResult.output` stores the business value, `effects` stores the notification, and `completion` stores the setup completion signal.
