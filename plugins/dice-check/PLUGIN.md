---
id: dice-check
kind: plugin
version: 0.0.35
displayName: Dice Check
description: >-
  Dice checks for risky actions — pre-rolled dice pools, rule-based outcomes,
  and visible receipts.
tags:
  - "cost:function"
  - "ui:message-block"
  - "ui:right-panel"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - action-check@1
optional:
  - tabletop-check@1
contracts:
  action-check@1:
    schema: ./schemas/action-check.schema.json
entry: ./server/index.js
contributes:
  events:
    - topic: check.resolved
      schema: ./schemas/check-resolved.event.json
      description: >-
        Emission condition: MUST emit when at least one dice check was resolved
        this turn, and only ONCE per turn — put every resolved check into the
        checks array, in the order the checks were used (resolve all first,
        then emit once). Per item: action = short description of the attempt;
        attribute = the attribute used; modifier = its modifier; difficulty =
        easy, normal, hard or extreme; outcome = the outcome that the turn's
        check table gives. Do not report the d20, the DC or the total: the
        system adds them. Risk-free actions never roll or emit.
  hooks:
    - event: PreToolUse
      enforce: normal
    - event: PostToolUse
      enforce: normal
  ui:
    message:
      - ./runtimes/recorder/ui/check-message.json
    right:
      - ./runtimes/recorder/ui/checks-panel.json
  commands:
    - name: roll
      aliases:
        - r
      description: "Roll dice notation, defaulting to 1d20."
      arguments:
        - name: notation
          type: string
          description: "Dice notation in NdM form, such as 2d6."
          required: false
      action: roll
  actions:
    - roll
---

Dice Check turns "does my lockpicking succeed?" from narrative-LLM freestyle into an auditable roll: a pre-turn runtime rolls the turn's d20 pool and injects one row for each check (with the check rules) into the narrative engine. The narrative decides the attribute and the difficulty of a risky action, reads the modifier from the pre-computed list of the player character's ranged number attributes, reads the outcome from the row, and emits a `check.resolved` receipt. A `PreToolUse` guard compares the receipt with the dice when it is sent and sends a wrong outcome back with the correct one, so the prose is written to the outcome the dice gave. The `action-check@1` contract carries only that injected `checkContext` text, so narrative engines hold no dice rules of their own and a plugin with a different resolution system can provide the same contract. A same-turn `tabletop-check@1` receipt owns its submitted action, so the recorder skips dice-pool events for that turn. The root entry exposes player-facing dice actions; see `runtimes/roller/RUNTIME.md` (the pre-roll injector) and `runtimes/recorder/RUNTIME.md` (the receipt recorder + UI) for the executable runtimes.
