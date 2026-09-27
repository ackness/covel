---
id: dice-check
kind: plugin
displayName:
  zh: 骰子判定
  en: Dice Check
description:
  zh: 为有失败风险的行动提供骰子判定：预掷骰池、规则化成败、可视化回执。
  en: >-
    Dice checks for risky actions — pre-rolled dice pools, rule-based outcomes,
    and visible receipts.
tags:
  - "cost:function"
  - "ui:message-block"
  - "ui:right-panel"
provides:
  - dice-check@1
entry: ./server/index.js
contributes:
  events:
    - topic: check.resolved
      schema: ./schemas/check-resolved.event.json
      description:
        zh: >-
          发射条件：本回合完成过至少一次骰子判定时必须发射，且整回合只发一次——把所有判定装进 checks
          数组（先判定完、再一次性发射）。每项：action 填行动简述；roll 填消耗的预掷骰原值；modifier 填属性修正；total =
          roll + modifier；dc/difficulty 填难度；outcome 按 total vs DC 判定，天然 20 为
          critical-success、天然 1 为 critical-failure。无风险行动不判定也不发射。
        en: >-
          Emission condition: MUST emit when at least one dice check was
          resolved this turn, and only ONCE per turn — put every resolved check
          into the checks array (resolve all first, then emit once). Per item:
          action = short description of the attempt; roll = the consumed
          pre-rolled d20 value; modifier = the attribute modifier; total = roll
          + modifier; dc/difficulty = the difficulty; outcome follows total vs
          DC, with natural 20 = critical-success and natural 1 =
          critical-failure. Risk-free actions never roll or emit.
  ui:
    message:
      - ./runtimes/recorder/ui/check-message.json
    right:
      - ./runtimes/recorder/ui/checks-panel.json
  commands:
    - name: roll
      aliases:
        - r
      description:
        zh: 掷指定骰式，默认为 1d20。
        en: "Roll dice notation, defaulting to 1d20."
      arguments:
        - name: notation
          type: string
          description:
            zh: NdM 格式的骰式，例如 2d6。
            en: "Dice notation in NdM form, such as 2d6."
          required: false
      action: roll
  actions:
    - roll
---

Dice Check turns "does my lockpicking succeed?" from narrative-LLM freestyle into an auditable roll: a pre-turn runtime rolls the turn's d20 pool and injects it (with the check rules) into the narrative engine, which resolves risky actions against it and emits `check.resolved` receipts. The root entry exposes player-facing dice actions; see `runtimes/roller/PLUGIN.md` (the pre-roll injector) and `runtimes/recorder/PLUGIN.md` (the receipt recorder + UI) for the executable runtimes.
