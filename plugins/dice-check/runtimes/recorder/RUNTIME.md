---
type: function
description: >-
  Records dice-check receipts emitted by the narrative, keeping an audit log and
  powering the in-message result block.
schedule:
  trigger:
    type: event
    topic: check.resolved
io:
  inputs:
    dicePool:
      from:
        runtime: dice-check/roller
      select: /dice
      required: true
    tabletopCheck:
      from:
        contract: tabletop-check@1
        cardinality: one
      select: /receipt
      required: false
  visibility: system
function:
  handler: ./handler.js
---

Dice check receipt recorder (function runtime).

It subscribes to the `check.resolved` event, which the narrative engine emits through `emit-event` under the rules that `dice-check/roller` injects.

If the `tabletop-check@1` output of the same execution already holds a settlement receipt for this turn, the form check belongs to tabletop-rules alone: this runtime skips the whole event batch and neither reads nor writes dice pool receipts. Without such a receipt it records ordinary actions as follows.

1. Read the event payload defensively. An item of the `checks` array holds what the narrative decided (action / attribute / modifier / difficulty) and the outcome it wrote. The die is not in the receipt: the first item uses the first die of the turn, the second the second. The runtime calculates the DC, the total and the outcome by `lib/check-rules.js`. An item is skipped when a required field is missing, a type is wrong, or its outcome is not the one the die gives; the die of a skipped item is still used. The runtime fails only when every item is invalid.
2. Write each check to `plugin_data[checks]` (key = `<turnId>-<index>`) with its display fields (outcome label, color, dice notation). The newest-first panel reads these directly.
3. Write this turn's check array to `plugin_data[message]` (key = turnId; the value carries `__turnId` to bind it to this turn's message). The in-message result block reads it directly.

> Why the payload is a batch: `emit-event` de-duplicates one topic per turn, so a second emission would be dropped. The contract therefore requires the narrative engine to merge the whole turn's checks into one `checks` array and send it once.

Note: `events[].schema` paths resolve relative to the **plugin root** (`plugins/dice-check/`), not this runtime's directory; only `handler` and `ui.*` paths resolve relative to this runtime's own directory.
