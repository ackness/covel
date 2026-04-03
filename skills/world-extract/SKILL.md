---
name: world-extract
description: Extract structured WorldDimensions from a world lore document (WORLD.md). Reads the lore, calls the extract-dimensions API or inline extraction logic, validates against schema, and writes dimensions into world.yaml. Use when the user has written lore and wants to generate structured dimensions from it.
user_invocable: true
---

# /world-extract — Extract Dimensions from Lore

Extracts structured WorldDimensions from a WORLD.md lore file and writes them into the world.yaml manifest.

## Usage

```
/world-extract [world-id or path]
```

Examples:
- `/world-extract mistport` — Extract from `worlds/mistport/`
- `/world-extract ./my-custom-world` — Extract from a custom path

## Workflow

### Step 1: Locate World Package

Find the world package directory:
1. If argument is a world ID, look in `worlds/<id>/`
2. If argument is a path, use it directly
3. If no argument, ask the user

### Step 2: Read Lore

Read all WORLD.*.md files in the directory:
- Prefer the `defaultLocale` lore file
- Fall back to `WORLD.md`

### Step 3: Extract Dimensions

Use the LLM to extract structured dimensions from the lore text.

**System prompt strategy:**
```
You are a world-building structure expert.
From the provided world lore document, extract structured dimensions.
- Only extract information explicitly stated or clearly implied
- Do NOT invent or fabricate details not present in the lore
- If a dimension is not mentioned, omit that field entirely
- Output valid JSON matching the WorldDimensions schema
```

**The 9 extractable dimensions:**

| Dimension | What to look for in lore |
|-----------|-------------------------|
| geography | Locations, regions, climate, landmarks |
| factions | Organizations, guilds, governments, rival groups |
| powerSystem | Magic, technology, cultivation, abilities |
| history | Past events, eras, wars, founding stories |
| economy | Currencies, trade, resources |
| socialStructure | Classes, races, hierarchies |
| tone | Genre markers, mood, themes |
| mechanics | Combat style, skill system, difficulty |
| startingConditions | Opening scenario, player start, resources |

### Step 4: Validate

Validate the extracted dimensions against `worldDimensionsSchema` (Zod):

```typescript
import { worldDimensionsSchema } from "@covel/shared";
const result = worldDimensionsSchema.safeParse(extracted);
```

If validation fails, fix the issues and re-validate.

### Step 5: Write to world.yaml

Read the existing `world.yaml`, merge the extracted dimensions, and write back:

```yaml
# Existing fields preserved...
dimensions:
  # Extracted dimensions written here
```

If `world.yaml` doesn't exist yet, create a minimal one with the extracted dimensions.

### Step 6: Present to User

Show the user:
1. Which dimensions were extracted
2. Which dimensions were skipped (not found in lore)
3. The updated world.yaml content
4. Ask for confirmation before finalizing

## Extraction Rules

1. **Only extract what's in the lore** — never fabricate
2. **Prefer the lore's own terminology** — use exact names from the text
3. **Use the lore's locale** — if lore is in Chinese, dimensions text should be Chinese
4. **Merge, don't replace** — if world.yaml already has some dimensions, merge new ones
5. **Validate strictly** — all output must pass Zod schema validation

## Server API Alternative

If the dev server is running, you can use the REST API:

```bash
curl -X POST http://localhost:3001/api/ai/extract-dimensions \
  -H "Content-Type: application/json" \
  -d '{"lore": "<lore text>", "locale": "zh-CN"}'
```

Response is SSE with `progress`, `done`, or `error` events.

## Quality Checklist

- [ ] Extracted dimensions match lore content (no fabrication)
- [ ] All I18nText fields use correct locale
- [ ] Factions have unique IDs
- [ ] Power system tiers are ranked correctly
- [ ] Validation passes against `worldDimensionsSchema`
- [ ] User has reviewed and confirmed the extraction

## Reference

For full dimension types and examples, load the `covel-world-authoring` skill.
