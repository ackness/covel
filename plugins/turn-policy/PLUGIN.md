---
version: 0.0.2
displayName: Who Speaks Next
description: >-
  Decides which characters speak each turn: whoever you mention, a set order,
  at random, your pick or an AI director.
tags:
  - "mode:dialogue"
contributes:
  services:
    - turn-policy@1
  actionKinds:
    - name: choose-actors
      roles: [player, host]
      actor: false
      text: optional
      schema: ./schemas/choose-actors.schema.json
      display:
        label: Choose who speaks
        placeholder: Optional hint for the chosen characters
  settings:
    - key: strategy
      type: select
      default: mention
      label: Who speaks
      description: How the characters who speak each turn are chosen.
      options:
        - value: mention
          label: Whoever you mention
        - value: list
          label: Take turns in a set order
        - value: random
          label: A random few each turn
        - value: manual
          label: You pick each turn
        - value: director
          label: "AI director (uses an extra AI call every turn, costs more)"
    - key: actorOrder
      type: textarea
      default: ""
      label: Speaking order
      description: >-
        For a set order, write one character name per line, up to 32 names.
---

One optional read service selects a bounded batch of present characters. Its own strategy setting chooses the algorithm; it does not schedule executions or write state.
