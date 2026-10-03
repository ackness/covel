---
id: core-quest
kind: plugin
displayName:
  zh: 任务日志
  en: Quest Log
description:
  zh: 自动从叙事中登记和推进任务，随时回看目标、进度和报酬。
  en: >-
    Automatically registers and advances quests from the narrative so goals,
    progress, and rewards stay visible.
tags:
  - "data:world-data"
  - "cost:function"
  - "ui:right-panel"
  - "ui:message-block"
provides:
  - world-ir.vocabulary@1
requires:
  - world-ir-provider@1
entry: ./server/index.js
contracts:
  quests@1:
    schema: ./schemas/quests.schema.json
contributes:
  data:
    quests:
      schema: ./schemas/quests.schema.json
      description: >-
        Importable quest records — world packs may preseed main/side quests; the
        quest log advances them by name.
      version: 1
      accepts:
        - quests@1
  ui:
    right:
      - ./ui/quest-log-panel.json
    message:
      - ./ui/quest-changes-block.json
  extensions:
    - point: ui.slot@1
      id: summary
      slot: session.summary@1
      order: 20
      watch:
        - quests
---

# Quest Log

Keeps the session's quests. The `log` runtime registers and advances quests from the shared WorldIR extraction without a model call; the `vocabulary` runtime publishes the active quests and their open objectives before extraction so progress is reported under the same names. World packages may preseed main and side quests. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.
