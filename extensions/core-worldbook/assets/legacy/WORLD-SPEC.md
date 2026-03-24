# Legacy World Spec

This note adapts the old `WORLD-SPEC.md` from `../ai-gamestudio-dev` to the
current `covel` architecture.

## 1. Recommended authoring shape

```md
---
id: legacy-steam-frontier
name: 铁潮边境
description: 三大城邦争夺蒸汽矿脉的边境世界
genre: steampunk
tags: [工业, 边境, 战争]
language: zh
legacyPluginHints: [combat, inventory, guide, codex]
i18n:
  en:
    name: Iron Tide Frontier
    description: A steam frontier where three city-states fight over mineral veins.
---

# 世界概述
...

## 核心规则
...

## 势力与阵营
...

## 关键地点
...

## DM 指引
...
```

## 2. Current mapping to `covel`

- `name` / `description`
  - map to `World`
- complete markdown
  - store as `Artifact`
- heading-level sections
  - split into `MemoryDocument`
- `legacyPluginHints`
  - keep as migration metadata only

Do not map old `plugins` directly to current package activation.

## 3. Section guidance

Prefer sections that split cleanly into retrievable units:

- immutable setting
- forces and factions
- locations
- conflict drivers
- rule boundaries
- narrative style guidance

## 4. Deferred items

Wait for the current i18n work to settle before fixing:

- final locale key shape
- UI-facing template localization
- prompt-layer locale switching
