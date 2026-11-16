---
description: >-
  Records each dice result the story reports and shows it in the chat and the
  roll log.
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
    checkPlan:
      from:
        runtime: dice-check/roller
      select: /checkPlan
      required: false
    costPlan:
      from:
        runtime: dice-check/roller
      select: /costPlan
      required: false
    tabletopCheck:
      from:
        contract: tabletop-check@1
      select: /receipt
      required: false
function: {}
---

Dice check receipt recorder (function runtime).

It subscribes to the `check.resolved` event, which the narrative engine emits through `emit-event` under the rules that `dice-check/roller` injects.

If the `tabletop-check@1` output of the same execution already holds a settlement receipt for this turn, the form check belongs to tabletop-rules alone: this runtime skips the whole event batch and neither reads nor writes dice pool receipts. Without such a receipt it records ordinary actions as follows.

1. Read the event payload defensively. An item of the `checks` array holds what the narrative decided (action / attribute / modifier / difficulty) and the outcome it wrote. The die is not in the receipt: the first item uses the first die of the turn, the second the second. The runtime judges each item by the roller's private `checkPlan` (`judgeCheck` in `lib/check-plan.js`), the plan the narrative was told: an attribute in the turn's modifier list must report that modifier (the best carried item for it is included), and the difficulty the narrative chose is raised one step for each reason in the turn's harder checks (an NPC named in `with` whose tier is below neutral, a full clock that raises the attribute). The DC, the total and the outcome follow `lib/check-rules.js`. An item is skipped when a required field is missing, a type is wrong, its modifier is not the listed one, or its outcome is not the one the die gives; the die of a skipped item is still used. The runtime fails only when every item is invalid.
2. Pay the cost of each recorded failed check from the roller's private `costPlan` (`lib/consequences.js`), when the world gives failure a cost. The check pays the most specific cost it can still pay: a cost for its attribute before one for any attribute, a cost for its outcome before one for both failed outcomes. A clock cost fills the clock in `plugin_data[clock-progress]`, never beyond its segments. An item cost takes the item through the `inventory.change@1` write service; when that is refused or unavailable, the check pays its next cost instead. The operation commits with this runtime: if it is refused at commit, nothing of this receipt is recorded. The cost is paid whatever the prose says.
3. Write each check to `plugin_data[checks]` (key = `<turnId>-<index>`) with its display fields (outcome label, color, dice notation, the turn's number and its "Turn N" label, the attribute label, the item in the modifier, why the check was harder and its DC before and after, and the cost text and detail when it paid one). The attribute label is the name of the world's character attribute that the receipt names by id or by name, in the session's language; other text is shown as written. The newest-first panel reads these directly.
4. Write this turn's check array to `plugin_data[message]` (key = turnId; the value carries `__turnId` to bind it to this turn's message). The in-message result block reads it directly, including the cost and, when the cost filled a clock, what is true now.

> Why the payload is a batch: `emit-event` de-duplicates one topic per turn, so a second emission would be dropped. The contract therefore requires the narrative engine to merge the whole turn's checks into one `checks` array and send it once.

Note: `events[].schema` paths resolve relative to the **plugin root** (`plugins/dice-check/`), not this runtime's directory; only `handler` and `ui.*` paths resolve relative to this runtime's own directory.
