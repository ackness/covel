---
type: function
description: >-
  Seeds the stage with the world registry's first scene at setup, so the stage
  is never blank before the narrative emits scene.set.
schedule:
  stage: setup
  trigger:
    type: auto
    maxTriggerCount: 1
io:
  visibility: system
function:
  handler: ./handler.js
---

# Scene Stage opening seed

The narrative model emits `scene.set`, following a required instruction in the event directory. An instruction is a prompt constraint, not a guarantee: a weak model may never emit the event, and the stage then stays blank, because `scene-stage/resolver` is event-triggered and never runs without one.

This runtime is the deterministic floor under that chain. It runs once at `stage: setup`, **before any narrative output**, so it does not race a `scene.set` from the model. (If both were emitted in the same turn, the event fan-out order would be undefined and the later write would cover the correct scene.)

## Behavior

1. `stage/current` already exists (a resumed session, a setup retry): skip, and never overwrite it.
2. The world has no scene registry, or the registry is empty: skip. A world without stage mode is unaffected.
3. Otherwise write the first scene of the registry to `stage/current` in its day variant, with `source: "world"`.

A `scene.set` that the narrative emits later is handled by the resolver as usual and replaces this record. The seed only makes sure the first frame is not blank.

The first scene of the registry is the opening scene: the author decides the order of the `scenes` array in the world package (see `docs/reference/world-data.md`), and `scripts/emit-scenes.mjs` keeps that order.
