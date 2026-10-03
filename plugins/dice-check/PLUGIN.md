---
id: dice-check
kind: plugin
displayName: Dice Check
description: >-
  Dice checks for risky actions — pre-rolled dice pools, rule-based outcomes,
  and visible receipts.
tags:
  - "cost:function"
  - "ui:message-block"
  - "ui:right-panel"
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
        checks array (resolve all first, then emit once). Per item: action =
        short description of the attempt; roll = the consumed pre-rolled d20
        value; modifier = the attribute modifier; total = roll + modifier;
        dc/difficulty = the difficulty; outcome follows total vs DC, with
        natural 20 = critical-success and natural 1 = critical-failure.
        Risk-free actions never roll or emit.
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

Dice Check turns "does my lockpicking succeed?" from narrative-LLM freestyle into an auditable roll: a pre-turn runtime rolls the turn's d20 pool and injects it (with the check rules) into the narrative engine, which resolves risky actions against it and emits `check.resolved` receipts. The `action-check@1` contract carries only that injected `checkContext` text, so narrative engines hold no dice rules of their own and a plugin with a different resolution system can provide the same contract. A same-turn `tabletop-check@1` receipt owns its submitted action, so the recorder skips dice-pool events for that turn. The root entry exposes player-facing dice actions; see `runtimes/roller/RUNTIME.md` (the pre-roll injector) and `runtimes/recorder/RUNTIME.md` (the receipt recorder + UI) for the executable runtimes.
