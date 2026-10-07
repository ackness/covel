---
type: function
description: >-
  Pre-rolls three d20s each turn and hands the dice pool plus check rules to the
  narrative engine.
schedule:
  stage: pre-turn
  trigger:
    type: scheduled
    interval: 1
io:
  inputs:
    tabletopCheck:
      from:
        contract: tabletop-check@1
        cardinality: one
      select: /receipt
      required: false
  output:
    contract: action-check@1
  visibility: system
function:
  handler: ./handler.js
---

Dice check pre-roller (function runtime).

It runs before every game turn:

1. Roll three d20 with `randomInt` from `node:crypto`. The dice are fixed before the narrative model sees the player's input, so success and failure are no longer the model's free choice.
2. Output the `checkContext` field (markdown): one row for each check of the turn, and the full check rules. A row gives the die and, for each difficulty, the outcome or the modifier that the outcome depends on. The narrative decides the attribute and the difficulty, then reads the outcome from the row; it does not choose a die and it does not calculate. The modifier of a number attribute with a declared range is pre-computed and listed in the block (`(value - min) ÷ range × 10`); the narrative reads it there and converts by itself only for attributes without a range. The rules say which actions need a check, the DC bands, critical success and failure with their narrative consequences, and that the turn's checks are merged into one `check.resolved` batch receipt before the prose.
3. Write the raw dice pool to `plugin_data[rolls]` (key = turnId) as an audit trail. What was rolled stays traceable even when the narrative used no die.
4. Keep the dice in memory for the rest of the turn (`lib/turn-pool.js`). The `PreToolUse` guard of this plugin reads them to check the receipt while the narrative still runs; the committed data is not readable until the turn ends.

If the `tabletop-check@1` output of the same execution holds a settlement receipt for this turn, the form check owns the turn. The `checkContext` then says only that no dice check is made, and the dice are not kept for the guard: a receipt the narrative sends by mistake is left to the recorder, which skips it.

The `action-check@1` contract promises only `checkContext`. The narrative engine consumes it through `io.inputs` and carries no dice rules of its own, so this text must be self-contained. The `dice` field in the output is private; the recorder of this package reads it in the same turn, and it is not part of the contract. `dice-check/recorder` subscribes to and records the receipt after a check. This runtime makes no check itself. Its only upstream is the optional tabletop check.
