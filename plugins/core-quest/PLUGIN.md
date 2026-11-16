---
version: 0.2.0
displayName: Quest Log
description: >-
  Keeps track of your quests. New quests and their progress are noted from the
  story as it goes, so you can check goals and rewards any time.
tags:
  - "data:world-data"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contributes:
  data:
    quests:
      schema: ./schemas/quests.schema.json
      description: >-
        Quests the player already has when the story begins.
      accepts:
        - quests@1
      authoring:
        title: Starting quests
        hint: >-
          Seed the main quest and, at most, a few side quests. `status` is
          `active`, `completed` or `failed`. Each objective has `text` and
          `done`; give it an `id` so later updates can address it. The quest log
          advances quests by name, so use the quest and giver names that the
          lore uses. A quest or an objective may have a `deadline`: `when` is
          one condition that holds once it is too late (a dimension, as in
          `{ dimension: floodline, path: stage, in: [knee] }`, world time,
          as in `{ time: elapsedSinceStart, gte: 45 }`, or how an NPC feels,
          as in `{ affinity: <name>, path: tier, in: [cold, hostile] }`),
          `label` says the deadline to the player, and `missed` says what
          happens then. A quest fails when its deadline passes; an objective
          is missed.
        example: ./examples/quests.json
        source:
          path: data/quests.yaml
        references:
          - path: deadline.when.dimension
            to: world-dimension
            within: [path]
            values: [equals, notEquals, "in[]"]
          - path: objectives[].deadline.when.dimension
            to: world-dimension
            within: [path]
            values: [equals, notEquals, "in[]"]
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

Keeps the session's quests. The `log` runtime registers and advances quests from the shared WorldIR extraction without a model call; the `vocabulary` runtime publishes the active quests and their open objectives before extraction so progress is reported under the same names. The `deadline` runtime fails a quest, or misses an objective, whose `deadline` has passed by this turn's dimensions, world time or an NPC's affinity tier (`affinity.tier@1`), shows it in the quest changes block, and tells the story what failed and which deadlines are close through `story-context@1`. World packages may preseed main and side quests. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.
