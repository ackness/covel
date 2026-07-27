---
name: memory
displayName:
  zh: 故事记忆
  en: Story Memory
description:
  zh: 展示故事记住的重点，包括剧情、场景、人物关系和主角状态。
  en: Shows what the story remembers, including plot, scene, relationships, and hero status.
---

Pure UI plugin. It declares the right-hand memory panel and, via `memoryBlocks`, the four default generic memory blocks (Story State / Character Relationships / Current Scene / Player Profile) with their extraction hints. Core-memory reads and writes are handled automatically by the framework's Memory System (@covel/memory) at the end of every turn, driven by these block definitions. Any plugin or world may declare its own `memoryBlocks` (e.g. `clues` / `suspects` / `timeline`); the framework aggregates them to drive extraction and rendering without touching framework core.
