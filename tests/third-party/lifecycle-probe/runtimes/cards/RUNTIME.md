---
description: Generate reply cards for the test story
schedule:
  stage: post-turn
  trigger:
    type: auto
io:
  inputs:
    narrative:
      from:
        contract: narrative-engine@1
        cardinality: one
      select: /narrativeOutput
      required: true
  output:
    contract: scene-prompts@1
  visibility: system
agent:
  model: plugin
  reasoning: false
  toolChoice:
    name: lifecycle-probe-cards
  tools:
    plugin:
      - lifecycle-probe-cards
  completion:
    require: tool-use
    afterTools:
      - lifecycle-probe-cards
  loop:
    maxSteps: 2
    maxRetries: 0
---

Read narrative.value from the declared inputs and call lifecycle-probe-cards once.
