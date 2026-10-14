---
id: "{{pluginName}}"
kind: plugin
version: "0.1.0"
covel: "{{hostRange}}"
description: "{{pluginDescription}}"
optional: [narrative-engine@1]
contributes:
  ui:
    right:
      - ./runtimes/note/ui/panel.json
---

Shared package declarations. Executable runtimes live in runtimes/.
