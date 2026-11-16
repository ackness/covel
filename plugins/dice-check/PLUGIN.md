---
version: 0.2.0
displayName: Dice Check
description: >-
  Rolls dice when an action is risky and shows the result in the chat.
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contracts:
  action-check@1:
    schema: ./schemas/action-check.schema.json
contributes:
  data:
    consequences:
      schema: ./schemas/consequence.schema.json
      description: >-
        What a failed check costs in this world: an item lost or a clock
        filled.
      accepts:
        - check.consequences@1
      authoring:
        title: Costs of failure
        summary: Makes every failed check cost something the player can see.
        hint: >-
          Write a few costs that fit the genre. Each has an `id`, a `text`
          that says what happens, a few `cues` (words that prose showing the
          cost would use) and a `cost`: `{ kind: item, item: <starting item
          name> }` or `{ kind: clock, clock: <clock id> }`. `attribute` (a
          check attribute id) and `outcome` (`failure` or `critical-failure`)
          narrow a cost; give at least one cost without them, so that every
          failed check pays something. A failed check pays the most specific
          cost it can still pay.
        example: ./examples/consequences.json
        source:
          path: data/check-consequences.yaml
        references:
          - path: attribute
            to: character-attribute
            type: number
    clocks:
      schema: ./schemas/clock.schema.json
      description: >-
        Clocks that costs of failed checks fill, and what is true once one is
        full.
      accepts:
        - check.clocks@1
      authoring:
        title: Clocks of failure
        summary: Turns repeated failures into pressure that grows.
        hint: >-
          Give each clock an `id`, a `name` the player sees, a number of
          `segments` (4 is a good size) and `full`, what is true once it is
          full. Costs fill a clock with `cost: { kind: clock, clock: <id> }`.
          `raises` lists check attribute ids whose checks are one difficulty
          step harder once the clock is full.
        example: ./examples/clocks.json
        source:
          path: data/check-clocks.yaml
        references:
          - path: raises[]
            to: character-attribute
            type: number
  datasets:
    clock-progress:
      schema: ./schemas/clock-progress.schema.json
      key: id
      ops: [set]
  events:
    - topic: check.resolved
      schema: ./schemas/check-resolved.event.json
      description: >-
        Emission condition: MUST emit when at least one dice check was resolved
        this turn, and only ONCE per turn — put every resolved check into the
        checks array, in the order the checks were used (resolve all first,
        then emit once). Per item: action = short description of the attempt;
        attribute = the attribute used (omit when none is used); modifier = its
        modifier from the turn's list (an item listed with it is included), or
        0 when no ranged ability is available; difficulty = easy, normal,
        hard or extreme, as chosen from the fiction; with = the person whose
        help the action needs, only when the turn's harder checks list that
        person; outcome = the outcome that the turn's check table gives,
        after the harder checks. Do not report the d20, the DC or the total:
        the system adds them. Risk-free actions never roll or emit.
  hooks:
    - PreToolUse
    - PostToolUse
    - ReviewAgentOutput
  ui:
    message:
      - ./runtimes/recorder/ui/check-message.json
    right:
      - ./runtimes/recorder/ui/checks-panel.json
      - ./ui/clocks-panel.json
  commands:
    - name: roll
      aliases:
        - r
      description: "Roll dice, for example /roll 2d6. Rolls one 20-sided die by default."
      arguments:
        - name: notation
          type: string
          description: "What to roll, such as 2d6 (two six-sided dice)."
          required: false
      action: roll
  actions:
    - roll
---

Dice Check turns "does my lockpicking succeed?" from narrative-LLM freestyle into an auditable roll: a pre-turn runtime rolls the turn's d20 pool and injects one row for each check (with the check rules) into the narrative engine. The narrative decides the attribute and the difficulty of a risky action, reads the modifier from the pre-computed list of the player character's check attributes (ranged numbers in the `abilities` category), reads the outcome from the row, and emits a `check.resolved` receipt. A `PreToolUse` guard compares the receipt with the dice when it is sent and sends a wrong outcome back with the correct one, so the prose is written to the outcome the dice gave. The `action-check@1` contract carries only that injected `checkContext` text, so narrative engines hold no dice rules of their own and a plugin with a different resolution system can provide the same contract. A same-turn `tabletop-check@1` receipt owns its submitted action, so the recorder skips dice-pool events for that turn.

A world can make failure cost something. `check.consequences@1` lists costs (an item lost or a clock filled) by attribute and outcome, and `check.clocks@1` lists the clocks. The roller adds the costs that can be paid this turn, and how full each clock is, to `checkContext`. The recorder pays the cost of each verified failed check whatever the prose says: it fills the clock in this plugin's `clock-progress` dataset, or takes the item through the `inventory.change@1` write service; an item that cannot be taken passes the check on to its next cost. The check's block in the chat and the roll log show the cost, and the Clocks panel shows each clock. A `ReviewAgentOutput` hook sends the story back once when its prose uses none of the cost's `cues`. Without this data, failed checks cost nothing beyond the prose, as before.

Other plugins can change a check through versioned services. An item that `inventory.bag@1` reports with `effects.check` adds its modifier to that attribute while it is carried (the best one for each attribute), and the modifier list says which item it is. An NPC whose `affinity.tier@1` tier is below neutral will not cooperate: a check whose receipt names that person in `with` is one difficulty step harder for each tier below neutral. A full clock makes the attributes in its `raises` one step harder. The guard and the recorder hold the receipt to the same modifiers and difficulties, and the check's block shows the item and the reason it was harder. Without those services, checks use the attribute alone.

The root entry exposes player-facing dice actions; see `runtimes/roller/RUNTIME.md` (the pre-roll injector) and `runtimes/recorder/RUNTIME.md` (the receipt recorder + UI) for the executable runtimes.
