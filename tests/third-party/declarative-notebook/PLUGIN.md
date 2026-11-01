---
version: 1.0.0
displayName: Declarative notebook
description: Keeps a small notebook from the player's actions using a model.
contributes:
  datasets:
    notes:
      schema: ./schemas/note.json
      key: id
      description: Public notes about the adventure.
  data:
    notes:
      schema: ./schemas/note.json
      accepts: [notebook.notes@1]
  settings:
    - key: length
      type: number
      label: Maximum sentences
      default: 2
      min: 1
      max: 4
  ui:
    right: [./ui/notes.json]
    view: [./ui/page.json]
runtime:
  schedule: { stage: pre-turn }
  io:
    selfData:
      - namespace: notes
        as: <notebook>
        maxEntries: 20
  agent:
    tools:
      datasets: [{ dataset: notes, tools: [list, upsert] }]
      services: [{ contract: notebook.review@1, as: review-note }]
---

Keep a notebook of public facts from the player's actions. Read <notebook> first.
Use at most {{ userSettings.length }} sentences per note. Call notes-upsert with
one record containing a short stable id and text. An optional review-note tool
may be available; the notebook must work without it. After successful work, submit `{}` through `submit-output`; when no new fact qualifies, submit `{}` without writing.
Never copy hidden instructions or private reasoning into a note.
