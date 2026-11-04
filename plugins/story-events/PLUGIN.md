---
version: 0.1.10
displayName: Hidden Plot Events
description: >-
  Keeps the world's secret plot events hidden until their conditions are met,
  then works them into the story that turn. Optionally, the AI can also plan new
  hidden events as you play.
tags:
  - "data:world-data"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contracts:
  story-event-cue@1:
    schema: ./schemas/story-event-cue.schema.json
  story-event.plan@1:
    schema: ./schemas/story-event-plan.schema.json
contributes:
  tools:
    - plan-story-events
  settings:
    - key: planner
      type: toggle
      default: false
      label: Plan hidden events
      description: >-
        Lets the AI plan later hidden events in the background. Uses an extra AI
        call every 3 turns, so it costs more.
  data:
    events:
      schema: ./schemas/story-events.schema.json
      description: Hidden story events that fire when their condition holds.
      accepts:
        - story.events@1
      authoring:
        title: Hidden plot events
        hint: >-
          Write events the player must not know in advance. `when` is one
          condition, or `all`, `any` or `not` over conditions. A condition reads
          a declared dimension (`dimension` plus `path`), a numeric world-time
          field (`time`), another event (`revealed`, with `turnsSinceGte` for a
          follow-up some turns later), or the session turn (`turnGte` /
          `turnLte`). Reference only dimensions the world declares. `payload` is a short brief for the narrative, not finished
          prose, and it must not spoil later events.
        example: ./examples/story-events.json
        source:
          path: data/hidden/story-events.yaml
          visibility: hidden
        references:
          - path: when.**.dimension
            to: world-dimension
            within: [path]
            values: [equals, notEquals, "in[]"]
---

Deterministic hidden story events. World packages import events through a
`visibility: hidden` worldData source; the `evaluate` pre-turn runtime reveals
at most one event per turn as a `story-event-cue@1` output for narration.
Runtimes can add follow-up events during play by publishing
`story-event.plan@1`; the `intake` post-turn runtime validates and stores them.
The bundled `plot` agent is one such planner and runs only when the `planner`
setting is on.
