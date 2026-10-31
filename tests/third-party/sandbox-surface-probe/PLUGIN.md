---
version: 0.1.1
displayName: Sandbox bridge probe
description: Public session actions and proposal writes from an isolated page.
contributes:
  datasets:
    notes:
      schema: ./schemas/note.json
      key: id
      ops: [set]
  ui:
    view: [./ui/reader.json, ./ui/input.json]
    right: [./ui/notes.json]
---

# Sandbox bridge probe

Two independently selected session surfaces share a classic-script page. The manual function
runtime is server code and requires its normal approval independently of page
capability consent.
