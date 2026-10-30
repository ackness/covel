---
description: Generate reply cards for the test story
schedule:
  stage: post-turn
io:
  inputs:
    narrative:
      from:
        contract: narrative-engine@2
      select: /narrativeOutput
  output:
    contract: scene-prompts@1
agent:
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
