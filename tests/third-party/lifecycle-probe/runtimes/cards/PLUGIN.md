---
name: lifecycle-probe/cards
description:
  { zh: 为测试叙事生成回复卡, en: Generate reply cards for the test story }
pluginType: plugin
stage: post-turn
outputKind: system
capabilities: [scene-prompts]
trigger: { type: auto }
model: plugin
llm:
  reasoningEffort: disabled
  toolChoice: { name: lifecycle-probe-cards }
maxSteps: 2
maxRetries: 0
requireToolUse: true
completeAfterTools: [lifecycle-probe-cards]
inputs:
  narrative:
    from: { capability: narrative-engine, cardinality: one }
    select: /narrativeOutput
    required: true
tools:
  plugin: [lifecycle-probe-cards]
ui:
  message: [./ui/cards.json]
---

Read narrative.value from the declared inputs and call lifecycle-probe-cards once.
