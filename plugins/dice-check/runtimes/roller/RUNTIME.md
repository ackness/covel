---
description: >-
  Rolls the dice at the start of each turn, so success is decided by the dice
  and not by the AI.
schedule:
  stage: pre-turn
io:
  inputs:
    tabletopCheck:
      from:
        contract: tabletop-check@1
      select: /receipt
      required: false
  output:
    contract: action-check@1
function: {}
---

Dice check pre-roller (function runtime).

It runs before every game turn:

1. Roll three d20 with `ctx.random.int(1, 21)`. The dice are fixed before the narrative model sees the player's input, so success and failure are no longer the model's free choice.
2. Output the `checkContext` field (markdown): one row for each check of the turn, and the full check rules. A row gives the die and, for each difficulty, the outcome or the modifier that the outcome depends on. The narrative decides the attribute and the difficulty, then reads the outcome from the row; it does not choose a die and it does not calculate. The modifier of a number attribute in `abilities` with a declared range is pre-computed and listed in the block (`(value - min) ÷ range × 10`); the narrative reads it there. If no such attribute is available, including when character data is missing, the rules instruct the narrative to use modifier 0 and omit the optional `attribute` field from the receipt. The result then has no attribute label, regardless of `COVEL_INSTRUCTION_LOCALE`. The narrative must not derive a modifier from health, trust or another field. The rules say which actions need a check, the DC bands, critical success and failure with their narrative consequences, and that the turn's checks are merged into one `check.resolved` batch receipt before the prose.
3. Build the turn's check plan (`lib/check-plan.js`), a private `checkPlan` field of the output for the recorder. It holds the modifier of each check attribute; when the player character carries an item whose `effects.check` names the attribute (asked through the `inventory.bag@1` read service), the best such item adds its modifier, the total stays within ±10, and the modifier list shows both parts. It also holds what makes a check harder: an NPC whose `affinity.tier@1` tier is below neutral will not cooperate (one step harder for each tier below it, when the receipt names that person in `with`), and a full clock of `check.clocks@1` makes the attributes in its `raises` one step harder. A "Harder checks" section after the check rules tells the narrative to choose the difficulty as usual, report it, and read the outcome that many columns to the right. Without a single provider of a service, its part of the plan is empty.
4. Write the raw dice pool to `plugin_data[rolls]` (key = turnId) as an audit trail. What was rolled stays traceable even when the narrative used no die.
5. When the world gives failure a cost (`check.consequences@1`), build the turn's cost plan (`lib/consequences.js`): the costs that can be paid now, which leaves out an item the player character does not carry (from the same `inventory.bag@1` answer; without one provider, item costs are left out) and a clock that is full. A "Cost of failure" section after the check rules tells the narrative what a failed check of each attribute costs, and how full each clock of `check.clocks@1` is, with what is true once one is full. The plan is a private `costPlan` field of the output for the recorder. A clock's record in `plugin_data[clock-progress]`, which the Clocks panel draws, is written when the world changed its name or size.
6. Keep the dice and both plans in memory for the rest of the turn (`lib/turn-pool.js`). The `PreToolUse` guard of this plugin reads the dice and the check plan to check the receipt (modifiers, harder checks and outcomes) while the narrative still runs, and the `ReviewAgentOutput` hook reads the plans to check that the prose shows the costs of the receipt's failed checks; the committed data is not readable until the turn ends.

If the `tabletop-check@1` output of the same execution holds a settlement receipt for this turn, the form check owns the turn. The `checkContext` then says only that no dice check is made, and the dice are not kept for the guard: a receipt the narrative sends by mistake is left to the recorder, which skips it.

The `action-check@1` contract promises only `checkContext`. The narrative engine consumes it through `io.inputs` and carries no dice rules of its own, so this text must be self-contained. The `dice`, `checkPlan` and `costPlan` fields in the output are private; the recorder of this package reads it in the same turn, and it is not part of the contract. `dice-check/recorder` subscribes to and records the receipt after a check. This runtime makes no check itself. Its only upstream is the optional tabletop check.
