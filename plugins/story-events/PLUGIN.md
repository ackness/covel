---
version: 0.1.7
displayName: Hidden Story Events
description: >-
  Keeps world-authored hidden story events out of prompts and player views until
  their conditions are met, then hands narration that turn's cue. An optional
  story planner can plant follow-up events during play.
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
      label: Story planner
      description: >-
        Every 3 turns, calls the model to plant hidden follow-up events from how
        the story has developed.
  data:
    events:
      schema: ./schemas/story-events.schema.json
      description: Hidden story events that fire when their condition holds.
      accepts:
        - story.events@1
      authoring:
        title: Hidden story events
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
