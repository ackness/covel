---
version: 0.0.42
displayName: Dialogue Narrator
description: >-
  Makes the story feel more like character dialogue, suited for play focused on
  conversation and interaction.
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
        Who tells the story and how narration refers to the player character;
        dialogue keeps each speaker's perspective.
      options:
        - value: character-first
          label: Player character, first person (I)
        - value: character-second
          label: Player character, second person (you)
        - value: character-third
          label: Player character, third person (name)
        - value: omniscient
          label: Omniscient narrator
        - value: dm
          label: Game master
    - key: dialogueRatio
      type: number
      default: 70
      min: 30
      max: 90
      step: 5
      label: Dialogue ratio
      description: Approximate share of dialogue and character reaction in each reply.
    - key: proseLength
      type: select
      default: medium
      label: Reply length
      options:
        - value: short
          label: Short
        - value: medium
          label: Medium
        - value: long
          label: Long
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

        - Return the reply as segments (see Reply Format); list the characters
        present in cues.present

        - Control reply length by the user setting: short ~120-220 chars, medium
        ~220-420, long ~420-650.
      position: post-history
  hooks:
    - PostContextAssembly
    - PreLLMCall
    - PostLLMResponse
    - TurnStop
---

Dialogue-first storytelling with optional policy preparation and story-owned character delegation.
