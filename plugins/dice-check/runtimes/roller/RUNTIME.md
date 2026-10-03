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
  output:
    contract: action-check@1
  visibility: system
function:
  handler: ./handler.js
---

Dice check pre-roller (function runtime).

It runs before every game turn:

1. Roll three d20 with `randomInt` from `node:crypto`. The dice are fixed before the narrative model sees the player's input, so success and failure are no longer the model's free choice.
2. Output the `checkContext` field (markdown): this turn's dice pool (#1..#3) and the full check rules. The rules say which actions need a check, how attribute modifiers apply, the DC bands, critical success and failure with their narrative consequences, and that the turn's checks are merged into one `check.resolved` batch receipt before the prose.
3. Write the raw dice pool to `plugin_data[rolls]` (key = turnId) as an audit trail. What was rolled stays traceable even when the narrative used no die.

The `action-check@1` contract promises only `checkContext`. The narrative engine consumes it through `io.inputs` and carries no dice rules of its own, so this text must be self-contained. The `dice` field in the output is private; the recorder of this package reads it in the same turn, and it is not part of the contract. `dice-check/recorder` subscribes to and records the receipt after a check. This runtime makes no check itself and has no upstream dependency.
