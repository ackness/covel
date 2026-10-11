---
id: clickable-map
kind: plugin
displayName: Clickable Map
description: "Example plugin: a self-drawn map; select a place to travel there."
entry: ./server/index.js
contributes:
  events:
    - topic: map.opened
      schema: ./schemas/map-opened.event.json
      advertise: false
      description: Emitted by the map panel when it opens before any map data exists.
    - topic: map.location-selected
      schema: ./schemas/location-selected.event.json
      advertise: false
      description: Emitted by the map panel when the player selects a linked place.
  extensions:
    - point: ui.slot@1
      id: summary
      slot: session.summary@1
      order: 40
      watch:
        - map
  ui:
    right:
      - ./ui/map-panel.json
---

# Clickable Map

Example package. Executable runtimes live under `runtimes/`; see README.md.
