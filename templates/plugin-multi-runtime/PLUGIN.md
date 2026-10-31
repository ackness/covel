---
version: "0.1.0"
covel: "{{hostRange}}"
description: "{{pluginDescription}}"
contributes:
  datasets:
    notes:
      schema: ./schemas/note.schema.json
      key: id
      description: Short notes this plugin keeps about the story.
  ui:
    right:
      - ./runtimes/note/ui/panel.json
---

Shared package declarations. Executable runtimes live in runtimes/.
