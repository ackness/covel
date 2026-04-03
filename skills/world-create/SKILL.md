---
name: world-create
description: Create a complete Covel world package from a concept. Generates world.yaml manifest, WORLD.*.md lore files, and structured dimensions. Use when the user wants to create a new world from scratch or from a concept description.
user_invocable: true
---

# /world-create — Create a New World Package

Creates a complete file-based world package under `worlds/` with YAML manifest, i18n lore files, and optionally structured dimensions.

## Usage

```
/world-create <concept>
```

Example: `/world-create A steampunk city floating above toxic clouds`

## Workflow

### Step 1: Gather Requirements

Ask the user (if not already provided):
1. **Concept** — What is the world about? (1-2 sentences)
2. **Locales** — Which languages? Default: zh-CN + en-US
3. **Content rating** — all-ages / teen / mature? Default: teen
4. **Genres** — fantasy, sci-fi, horror, etc.

### Step 2: Generate World ID

Derive a kebab-case ID from the concept:
- 3-20 characters, lowercase, a-z0-9 and hyphens only
- Example: "steampunk floating city" → `skyforge`

### Step 3: Create Directory

```bash
mkdir -p worlds/<world-id>
```

### Step 4: Write WORLD.*.md Lore Files

For each supported locale, write a lore file following this template:

```markdown
# {World Name}

## World Setting
{2-3 paragraphs: physical environment, key concepts, atmosphere}

## Core Rules
- {Rule 1}
- {Rule 2}
- {Rule 3}

## Key Characters
- {Name}: {Role}, {Description}

## Opening Scene
{1 paragraph with sensory details. End with choice/tension.}
```

- `WORLD.zh.md` for zh-CN
- `WORLD.en.md` for en-US
- `WORLD.md` for single-locale worlds

### Step 5: Write world.yaml

```yaml
schemaVersion: "1.0"
id: <world-id>
name:
  zh-CN: <中文名>
  en-US: <English Name>
version: "1.0.0"
summary:
  zh-CN: <简短描述>
  en-US: <Short description>
defaultLocale: zh-CN
supportedLocales: [zh-CN, en-US]
tags: [<genre>, <theme>]
recommendedPlugins: [core-combat, core-quest]

dimensions:
  geography:
    overview:
      zh-CN: <地理概述>
      en-US: <Geographic overview>
    regions:
      - name:
          zh-CN: <区域名>
          en-US: <Region Name>
        description:
          zh-CN: <描述>
          en-US: <Description>
  tone:
    genres: [<genre>]
    contentRating: <rating>
  startingConditions:
    openingScenario:
      zh-CN: <开场>
      en-US: <Opening>
    startingLocation:
      zh-CN: <起始位置>
      en-US: <Starting location>
```

### Step 6: Validate

Run validation to ensure the package is well-formed:

```bash
pnpm --filter @covel/server test --run -- tests/world-packages-integration.test.ts
```

### Step 7: Confirm with User

Present the generated files and ask the user to review. Suggest running the dev server to see the world in the UI.

## Quality Checklist

- [ ] world.yaml passes `worldPackageMetaSchema` validation
- [ ] At least one WORLD.*.md exists per supported locale
- [ ] Lore is under 2000 words, specific, with hard constraints
- [ ] At least `tone` and `startingConditions` dimensions filled
- [ ] Factions (if any) have unique IDs with cross-references
- [ ] I18nText fields use consistent locale keys
- [ ] Tags are 2-5 descriptive keywords

## Minimum Dimensions

Always include at least:
- `tone` (genres, contentRating)
- `startingConditions` (openingScenario, startingLocation)
- `geography` (overview, at least 1 region)

## Reference

For full dimension types and examples, load the `covel-world-authoring` skill.
