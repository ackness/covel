---
type: function
description: >-
  Registers, advances, and closes quests from each turn's shared fact extraction.
schedule:
  stage: post-turn
  trigger:
    type: auto
io:
  inputs:
    worldIR:
      from:
        contract: world-ir-provider@1
        cardinality: one
      accepts: "contract:world-ir@1"
      required: true
  visibility: system
function:
  handler: ./handler.js
---

Deterministic quest log. It reads this turn's `quest_change` events from WorldIR. A new quest is created only from an explicit `accepted` event; `progressed`, `completed`, and `failed` events must resolve to a quest already in the log (an exact normalized name, or a unique containment match), so a paraphrased name never creates a duplicate. New objectives come from `objectives`, finished ones from `completedObjectives`, and objective text matching reuses the existing merge rules. A turn without quest signals writes nothing.
