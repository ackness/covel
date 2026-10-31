---
version: 0.0.1
displayName: Turn Policy
description: Chooses present characters by mention, list, random, manual selection or a director.
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
        label: Choose actors
        placeholder: Optional direction for the selected characters
  settings:
    - key: strategy
      type: select
      default: mention
      label: Strategy
      description: How present characters are chosen for each story beat.
      options:
        - value: mention
          label: Mentioned characters
        - value: list
          label: Fixed order
        - value: random
          label: Random batch
        - value: manual
          label: Manual selection
        - value: director
          label: Model director
    - key: actorOrder
      type: textarea
      default: ""
      label: Actor order
      description: For fixed order, one exact character name or alias per line; at most 32 names.
---

One optional read service selects a bounded batch of present characters. Its own strategy setting chooses the algorithm; it does not schedule executions or write state.
