# Covel Plugin Authoring Guide

Use this skill when creating, modifying, or reviewing Covel v2 plugins. Applies to any work in `plugins-v2/`.

## Plugin Package Structure

```
plugins-v2/<plugin-name>/
├── PLUGIN.md              # REQUIRED: frontmatter config + LLM prompt
├── tools/                 # OPTIONAL: plugin-local tool definitions
│   ├── my-tool.ts         #   tool() wrapper, exported as default
│   └── another-tool.ts
├── references/            # OPTIONAL: keyword-triggered lore/context
│   └── world-info.md      #   frontmatter: keywords: [keyword1, keyword2]
├── output.schema.json     # OPTIONAL: structured output JSON Schema
└── tests/                 # REQUIRED: independent plugin tests
    └── plugin-name.test.ts
```

## PLUGIN.md Format

```yaml
---
name: my-plugin                    # lowercase-hyphen, unique ID
description: 简短描述。包含激活时机说明。
pluginType: plugin                 # 'plugin' (default) or 'core-plugin' (always-on)
priority: 650                      # 0-1000, lower = runs first
model: fast                        # LLM slot name from llm.toml (ds/fast/qwen/etc.)
trigger:
  type: auto                       # auto | manual | scheduled | event | conditional | error-retry
  interval: 5                      # for scheduled
  maxTriggerCount: 1               # max times to trigger per session
  topic: quest.completed           # for event trigger
  cooldownTurns: 3                 # min turns between triggers
input:
  inject:                          # inject other runtime outputs into context
    - from: core-narrator
      field: narrativeOutput
      as: "<narrator-output>"
  tools:                           # declare access to other plugin data via tools
    - plugin: states-plugin
      runtime: character-state
tools:
  builtin:                         # framework generic tools
    - create-form
    - create-choices
    - create-notification
  local:                           # plugin-specific tools
    - ./tools/unlock-entries.ts
output:
  schema: ./output.schema.json     # optional structured output schema
---

Markdown body below is the LLM system prompt.
Use {{ player.message }} for current input.
Use {{ world.lore }}, {{ world.dimensions }} for world context.
Use {{ inputs.pluginId.runtimeId.fieldName }} for injected data.
Use {{ config.fieldName }} for plugin config values.
```

## Priority Bands

| Range | Phase | Examples |
|-------|-------|---------|
| 0-99 | Pre-Game | initialization, world setup |
| 100-499 | Pre-Turn | persona (100), preprocessing |
| 500 | Narrator | main narrative output |
| 501-699 | Post-Narrator | char-tracker (600), guide (600) |
| 700-899 | Processing | char-creator (700), image (800) |
| 900-999 | Background | memory summarizer (900) |
| 1000 | Audit | conflict resolution |

## Tool Authoring (plugin-local)

```typescript
// tools/my-tool.ts
import { z } from 'zod';
import { tool } from '../../../packages/tools/src/tool.js';

export const myTool = tool({
  name: 'my-tool-name',
  description: '工具描述，LLM 看到这个决定是否调用',
  parameters: z.object({
    param1: z.string().describe('参数说明'),
    param2: z.number().optional(),
  }),
  execute: async (params, context) => {
    // context: { sessionId, turnId, pluginId, runtimeId }
    // Return value is JSON.stringify'd and sent back to LLM
    return {
      success: true,
      data: params.param1,
      // Optional: UI render instructions
      ui: [{
        type: 'my-custom-card',
        title: params.param1,
        style: { borderColor: '#3b82f6' },
      }],
    };
  },
});
```

## Built-in UI Tools (framework-level)

| Tool | Purpose | Key params |
|------|---------|-----------|
| `create-form` | Player input form | formId, title, fields[], submitLabel, narrativeTemplate |
| `create-choices` | Decision options | choiceId, prompt, choices[] |
| `create-notification` | Alert message | level, title, message |

## Plugin Types

| Type | `pluginType` | Behavior |
|------|-------------|----------|
| Core | `core-plugin` | Auto-loaded, cannot be disabled |
| Normal | `plugin` | User enables/disables, not loaded by default |

## Testing Pattern

Tests live in `plugins-v2/<name>/tests/` and run via:
```bash
pnpm --filter @covel/runtime test -- --run
```

Import from packages using relative paths (plugins are not workspace packages):
```typescript
import { executeTurn } from '../../../packages/runtime/src/turn-executor.js';
import { createMemoryStore } from '../../../packages/store/src/memory/memory-store.js';
```

Test structure:
1. **Tool unit tests** — test each tool's execute() directly
2. **Plugin manifest tests** — verify frontmatter parses correctly
3. **Integration tests** — mock LLM + TurnExecutor, verify full flow
4. **E2E tests** — real LLM via `scripts/test-*.ts`

## Model Resolution Chain

PLUGIN.md `model` field is a slot name, resolved through:
```
API body.model > plugin llm.toml [covel.slot] > system llm.toml [covel.slot] > default
```

## Message History

- Runtime outputs are saved as append-only TurnMessages
- LLM sees previous turns' messages as conversation history
- `narrativeTemplate` with `{{placeholders}}` gets filled after player input
- Filled narrative is stored as a `player-input` type message
- System prompt (PLUGIN.md body) is NOT stored — rebuilt each turn

## Validation

```bash
npx tsx scripts/validate-plugins.ts    # Validate all plugin frontmatters
```

## Examples

- **core-narrator** (`plugins-v2/core-narrator/`) — simplest: just PLUGIN.md, no tools
- **core-char-creator** (`plugins-v2/core-char-creator/`) — uses `create-form` builtin tool
- **core-codex** (`plugins-v2/core-codex/`) — has local tools in `tools/`, non-core plugin
