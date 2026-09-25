---
name: evaluation-consumer
description: "Synthetic evaluation consumer for framework contract tests"
pluginType: plugin
runtimeType: function
handler: ./handler.js
entry: ./server.js
stage: post-turn
outputKind: system
capabilities: [choice-recommendations]
tags: [role:demo, cost:llm]
timeoutMs: 15000
trigger: { type: scheduled, interval: 1 }
inputs:
  choices:
    from: { capability: scene-prompts, cardinality: one }
    accepts: ./schemas/choices.schema.json
    required: true
  narrative:
    from: { capability: narrative-engine, cardinality: one }
    select: /narrativeOutput
    accepts: ./schemas/narrative.schema.json
    required: true
---

Framework test fixture; never bundled as a plugin.
