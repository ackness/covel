---
type: function
description: >-
  Records the protagonist's item gains, losses, and equipment changes from each
  turn's shared fact extraction.
schedule:
  stage: post-turn
io:
  inputs:
    worldIR:
      from:
        contract: world-ir-provider@1
      accepts: "contract:world-ir@1"
function:
  handler: ./handler.js
---

Deterministic ledger. It reads this turn's `inventory_change` events from WorldIR and applies those held by the player character: `gain` adds, `lose` removes, `equip` / `unequip` toggle the equipped flag. The item name comes from the event's item entity; quantities default to 1. Events about other characters' belongings are ignored, and a turn without changes writes nothing.
