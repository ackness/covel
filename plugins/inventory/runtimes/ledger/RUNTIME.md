---
description: >-
  Records the protagonist's item gains, losses, and equipment changes from each
  turn's shared fact extraction.
schedule:
  trigger:
    type: event
    topic: inventory.reconcile
  after:
    - contract: check-settlement@1
io:
  inputs:
    operations:
      from:
        kernel: operations@1
    worldIR:
      from:
        contract: world-ir@2
      required: false
function: {}
---

Deterministic ledger. It reads this turn's `inventory_change` events from WorldIR and applies those held by the player character: `gain` adds, `lose` removes, `equip` / `unequip` toggle the equipped flag. The item name comes from the event's item entity; quantities default to 1. Events about other characters' belongings are ignored, and a turn without changes writes nothing.

The same-turn reconciliation signal puts the ledger in the event batch with any check settlement. The ledger waits for settlement if it runs, then uses `operations@1` to skip losses already paid. A retry reads the original extraction and committed operations rather than emitting the signal again.
