# Legacy World Spec

This note adapts the old `WORLD-SPEC.md` from `../ai-gamestudio-dev` to the
current `covel` architecture.

## 1. Recommended authoring shape

```md
---
id: legacy-steam-frontier
genre: steampunk
tags: [工业, 边境, 战争]
defaultLocale: zh-CN
metadataLocales: [zh-CN, en]
contentLocales: [zh-CN]
legacyCapabilityHints: [combat, inventory, guide, codex]
localizedMetadata:
  zh-CN:
    name: 铁潮边境
    description: 三大城邦争夺蒸汽矿脉的边境世界
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

- localized metadata
  - map to `World`
- complete markdown
  - store as `Artifact`
- heading-level sections
  - split into `MemoryDocument`
- `legacyCapabilityHints`
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

## 4. Locale rules

- Only `zh-CN` and `en` are valid metadata locales.
- `defaultLocale` is the canonical content locale.
- `contentLocales` must describe actual body locales, not desired future locales.
- If `en` metadata exists but body content still falls back to `zh-CN`, importer and UI must expose that fallback explicitly.
