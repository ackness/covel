---
version: 0.2.0
displayName: Hidden Plot Events
description: >-
  Keeps the world's secret plot events, options, and rewards hidden until their
  conditions are met, then unlocks them naturally in play. Supports deterministic
  checks, AI semantic judging, and optional background event planning.
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
  story-event.judge@1:
    schema: ./schemas/story-event-judge.schema.json
contributes:
  tools:
    - plan-story-events
  extensions:
    - point: ui.slot@1
      id: choices
      slot: stage.choices@1
      order: 50
      watch:
        - active_options
  ui:
    message:
      - ./ui/hidden-unlocks-block.json
  settings:
    - key: planner
      type: toggle
      default: false
      label: Plan hidden events
      description: >-
        Lets the AI plan later hidden events in the background. Uses an extra AI
        call every 3 turns, so it costs more.
    - key: semanticJudge
      type: toggle
      default: true
      label: Judge natural-language triggers
      description: >-
        Lets a concealed sub-agent judge natural-language hidden conditions and
        rewritten hidden options. Worlds without semantic conditions make no
        extra AI calls.
    - key: maxJudgedPerTurn
      type: number
      default: 8
      min: 1
      max: 16
      step: 1
      label: Max semantic checks per turn
      description: >-
        Upper bound on how many shortlisted natural-language hidden conditions
        are batched into one judge call each turn.
  data:
    events:
      schema: ./schemas/story-events.schema.json
      description: >-
        Hidden story events, unlockable hidden options, and hidden rewards that
        stay invisible until their conditions hold.
      accepts:
        - story.events@1
      authoring:
        title: Hidden plot events
        summary: >-
          Adds hidden plot twists, unlockable hidden options, and hidden rewards
          triggered by story moments or world state.
        hint: >-
          Write 2-4 hidden events, hidden options, and hidden rewards the player
          must not see in advance. `when` can be a natural-language string, a
          `judge` leaf (`{ judge, id?, scope?, sticky?, watch? }`), a
          deterministic leaf (`dimension` + `path`, `time`, `affinity`, `item`,
          `attribute`, `revealed`, `selected`, or `turnGte` / `turnLte`), or
          combined with `all` / `any` / `not`. Pair `judge` leaves with cheap
          deterministic gates or `watch` hints when possible so unrelated turns
          skip model calls. Each entry needs at least one of `payload` (short
          narrator brief, not finished prose), `options` (hidden choices
          revealed once unlocked, with their own hidden `payload` and
          `rewards`), or `rewards` (`item`, `lorebook`, or `narrative`). Prefer
          natural-language `when` / `judge` conditions unless referencing
          dimensions and attributes the world actually declares.
        example: ./examples/story-events.json
        generate: offer
        source:
          path: data/hidden/story-events.yaml
          visibility: hidden
        references:
          - path: when.**.dimension
            to: world-dimension
            within: [path]
            values: [equals, notEquals, "in[]"]
          - path: options[].when.**.dimension
            to: world-dimension
            within: [path]
            values: [equals, notEquals, "in[]"]
          - path: when.**.attribute
            to: character-attribute
          - path: options[].when.**.attribute
            to: character-attribute
---

Hybrid deterministic and semantic hidden story triggers. World packages import
hidden events, unlockable options, and hidden rewards through a
`visibility: hidden` worldData source (`data/hidden/story-events.yaml`).

- `evaluate` (`pre-turn` function) matches chosen hidden options, reveals armed
  semantic events and deterministic events as `story-event-cue@1`, publishes
  narrative/degraded reward notes via `story-context@1`, and calls the concealed
  `judge` sub-agent only for entries explicitly marked `timing: pre-turn`.
- `assess` (`audit` function) runs after `post-turn` state settles, applies
  four-valued deterministic short-circuiting, batches shortlisted semantic
  conditions into at most one concealed `story-events/judge` call, arms newly
  met story events, updates public `active_options`, and settles hidden rewards.
- `judge` (`subagentOnly`, `io.concealed: true`) evaluates natural-language
  conditions and rewritten hidden-option intents without ever seeing hidden
  payloads, hidden options, or hidden rewards.
- `plot` and `intake` retain dynamic hidden event planning when `planner` is on.
