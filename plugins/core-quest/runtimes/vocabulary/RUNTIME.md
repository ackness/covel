---
type: function
description:
  zh: 在事实抽取前公布进行中的任务与未完成目标，便于沿用同一名称。
  en: >-
    Publishes active quests and their open objectives before fact extraction so
    the same names are reused.
schedule:
  stage: pre-turn
  trigger:
    type: auto
io:
  output:
    contract: world-ir.vocabulary@1
  visibility: system
function:
  handler: ./handler.js
---

Publishes up to 30 active quests as `world-ir.vocabulary@1` entries of type `quest`, with their open objectives as `details`. Completed and failed quests are left out. The extractor uses the list to align names only; it is never evidence of progress.
