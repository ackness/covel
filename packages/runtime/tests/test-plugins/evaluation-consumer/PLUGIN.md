---
id: evaluation-consumer
kind: plugin
description: Synthetic evaluation consumer for framework contract tests
provides: [choice-recommendations@1]
requires: [scene-prompts@1, narrative-engine@1]
entry: ./server.js
contributes:
  services: [test.evaluation@1]
runtime:
  type: function
  function: { handler: ./handler.js, timeoutMs: 15000 }
  schedule:
    stage: post-turn
  io:
    output: { contract: choice-recommendations@1 }
    inputs:
      choices:
        from: { contract: scene-prompts@1 }
        accepts: ./schemas/choices.schema.json
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
        accepts: ./schemas/narrative.schema.json
---

Framework test fixture; never bundled as a plugin.
