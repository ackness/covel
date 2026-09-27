---
id: "{{pluginName}}"
kind: plugin
description: "{{pluginDescription}}"
optional: [narrative-engine@1]
contributes:
  ui:
    right:
      - ./runtimes/note/ui/panel.json
---

Shared package declarations. Executable runtimes live in runtimes/.
