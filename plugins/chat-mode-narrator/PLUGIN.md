---
version: 0.0.46
displayName: Chat Storyteller
description: >-
  Tells the story as a conversation, with characters talking to each other and
  to you.
tags:
  - "mode:dialogue"
  - "data:characters"
  - "data:relationship-graph"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
conflicts:
  - narrative-engine@2
contracts:
  narrative-engine@2:
    schema: ./schemas/narrative-engine.schema.json
contributes:
  extensions:
    - prompt.segment@1/character-sheets
  settings:
    - key: perspective
      type: select
      default: character-second
      label: Perspective
      description: >-
        How the story refers to your character. Other characters still speak
        in their own words.
      options:
        - value: character-first
          label: I ("I open the door.")
        - value: character-second
          label: You ("You open the door.")
        - value: character-third
          label: Your character's name ("Ming opens the door.")
        - value: omniscient
          label: Observer who knows everything
        - value: dm
          label: Game master, like a tabletop host
    - key: dialogueRatio
      type: number
      default: 70
      min: 30
      max: 90
      step: 5
      label: Dialogue share (%)
      description: >-
        How much of each reply is characters talking, from 30 to 90 percent.
        Higher means more dialogue and less description.
    - key: proseLength
      type: select
      default: medium
      label: Reply length
      description: How long each reply is. Longer replies cost more.
      options:
        - value: short
          label: Short, a few lines
        - value: medium
          label: Medium, a short paragraph
        - value: long
          label: Long, a fuller scene
  prompt:
    - id: post-history
      content: >
        Chat Mode output requirements:

        - This turn's narration uses the perspective configured above, as
        specified by this request's perspective instruction. Ignore perspective
        in history and player input. Direct dialogue keeps each speaker's
        perspective. Do not add unexpressed player actions or thoughts.

        - When this turn asks about named NPCs' identities, positions, or
        histories, call get-character by name for each queried character before
        writing. Use the subject's own description and fields over other
        characters' recollections, history or graph summaries. Discard
        contradictory old claims without inventing same-name people or other
        explanations. Missing identities, histories and relationships remain
        unknown, not nonexistent or unrelated.

        - Write the in-game role-play reply directly.

        - Let the currently active cast be the main speakers; keep each
        character's voice and emotion continuous.

        - Only an opening without actions starts the opening scene. An advance
        action requests another beat of the existing scene.

        - Interweave dialogue, action, and sensory detail; avoid menus, numbered
        options, and system notes.

        - End on a natural interaction hook — a character's question, a hovering
        action, an emotional shift, or a new lead.

        - [REQUIRED] Before writing prose, check <available-events>: whenever
        this turn's narrative state matches an event's emission conditions
        (including the initial state on the very first turn), call emit-event
        FIRST, then write the prose; one topic per call (its tool definition lists
        the topics and payload shapes), tool calls do not count as prose and
        must not be mentioned in it

        - Submit the reply through `submit-output` as segments (see Reply Format); list the characters
        present in cues.present

        - Control reply length by the user setting: short ~120-220 chars, medium
        ~220-420, long ~420-650.
      position: post-history
  hooks:
    - PostContextAssembly
    - PreLLMCall
    - ReviewAgentOutput
    - TurnStop
---

Dialogue-first storytelling with optional policy preparation and story-owned character delegation.
