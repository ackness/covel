---
id: core-quest
kind: plugin
displayName: Quest Log
description: >-
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
      authoring:
        title: Starting quests
        hint: >-
          Seed the main quest and, at most, a few side quests. `status` is
          `active`, `completed` or `failed`. Each objective has `text` and
          `done`; give it an `id` so later updates can address it. The quest log
          advances quests by name, so use the quest and giver names that the
          lore uses.
        example: ./examples/quests.json
        source:
          kind: yaml
          path: data/quests.yaml
          key: id
  ui:
    right:
      - ./ui/quest-log-panel.json
    message:
      - ./ui/quest-changes-block.json
---

# Quest Log

Keeps the session's quests. The `log` runtime registers and advances quests from the shared WorldIR extraction without a model call; the `vocabulary` runtime publishes the active quests and their open objectives before extraction so progress is reported under the same names. World packages may preseed main and side quests. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.
