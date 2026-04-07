---
name: covel-plugin-authoring
description: How to author Covel RPG framework plugins — manifest, tools, hooks, context providers, proposals, and testing. Use this skill whenever the user wants to create a new plugin, add gameplay mechanics, implement a tool or hook, write a context provider, set up plugin testing, or asks about the Covel plugin API. Also use when modifying existing plugins under the plugins/ directory, or when the user asks about proposals, runtimes, trigger modes, or the plugin lifecycle.
---

# Covel Plugin Authoring

Plugins are distribution packages that bundle execution primitives: **Runtimes, Tools, Hooks, Context Providers, and Commands**. Plugins carry gameplay logic; the kernel provides orchestration.

**Golden rule**: Plugins NEVER access databases, kernel internals, or frontend components. All writes go through the **proposal system**.

## Plugin Directory Structure

```
plugins/my-plugin/
  plugin.json              # Manifest — declares ALL capabilities
  PLUGIN.md                # LLM instructions (= agent skill prompt)
  package.json             # NPM workspace package
  server/
    index.ts               # Registration entry point (default export)
    tools.ts               # Tool handler implementations
    logic.ts               # Pure business logic (no I/O)
    context-provider.ts    # Context injection for other runtimes
    handler.ts             # RuntimeHandler (for code-path runtimes)
  tests/
    unit.test.ts           # Unit tests (vitest)
    live.test.ts           # Integration tests with LLM (optional)
```

## Workflow

1. Write `plugin.json` manifest — declares runtimes, tools, hooks, blockSchemas
2. Write `PLUGIN.md` — LLM instructions for the runtime agent
3. Implement server code — tool handlers, context providers, or runtime handlers
4. Write tests — use `@covel/plugin-test-utils` mocks and assertions
5. Register in `server/index.ts` — wire everything to the plugin registrar

For complete field references, type definitions, and code examples, read `references/plugin-api-reference.md`.

## plugin.json Manifest (Quick Reference)

Required fields: `schemaVersion` ("1.0"), `id`, `displayName` (I18nText), `version`, `author`, `description` (I18nText), `defaultLocale` ("zh-CN"), `supportedLocales` (min: ["zh-CN", "en-US"]), `loadingOrder` (0-100).

Optional: `requires`, `supersedes`, `conflicts`, `runtimes`, `tools`, `hooks`, `blockSchemas`.

### Runtime Spec

```json
{
  "id": "my-runtime",
  "pluginId": "my-plugin",
  "kind": "story | plugin | background | verifier",
  "priority": 600,
  "trigger": { "mode": "always | interval | event | manual", "onEvents": ["user.input"] },
  "providerBinding": "default | fast | balance",
  "tools": ["my-plugin:my-tool"],
  "hooks": [],
  "budget": { "maxSteps": 8, "timeoutMs": 60000, "maxTokens": 8192 }
}
```

### Priority Guide

| Range | Phase | Examples |
|-------|-------|---------|
| 100 | Context setup | core-persona |
| 400 | Main narrative | core-narrator |
| 420-450 | Structured gameplay | core-combat, core-init-wizard |
| 500-600 | Parallel plugins | guide, tracker, inventory, quest |
| 900+ | Background | core-memory |

### Tool Definition

```json
{
  "id": "my-tool",
  "kind": "query | mutate | emit | render | generate",
  "permissions": ["my.permission"],
  "schema": { "type": "object", "properties": { ... }, "required": [...] }
}
```

## PLUGIN.md Template

```markdown
# {Plugin Name}

## When to Activate
- On session_start: ...
- On user.input: ...

## Behavior
1. Core behavior rules
2. Output format expectations

## Tools
- `tool-name`: What it does, when to use it

## Constraints
- What the LLM should NEVER do
- Boundaries and limitations
```

## Server Implementation Patterns

### Registration (server/index.ts)

```typescript
import type { PluginRegistrar } from "@covel/plugin-runtime";
import { myToolHandler } from "./tools.js";
import { myContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addTool("my-tool", myToolHandler);
  registrar.addContextProvider("my-context", myContextProvider);
  // registrar.addRuntimeHandler("my-runtime", myHandler);
  // registrar.addHook("my-hook", myHookHandler);
}
```

### Tool Handler (server/tools.ts)

```typescript
import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";

export async function myToolHandler(
  ctx: ToolExecutionContext<{ targetId: string; amount: number }>,
): Promise<ToolExecutionResult> {
  const { targetId, amount } = ctx.input;
  const isZh = ctx.locale.startsWith("zh");

  return {
    output: { message: isZh ? "成功" : "Success", success: true },
    proposals: [
      { kind: "state.patch", payload: { inventory: { [targetId]: amount } } },
      { kind: "event.emit", payload: { type: "item_used", data: { targetId } } },
      { kind: "ui.render", payload: { type: "my_block", content: { targetId } } },
    ],
  };
}
```

### Context Provider (server/context-provider.ts)

```typescript
import type { ContextProvider, ContextProviderInput } from "@covel/plugin-runtime";

export const myContextProvider: ContextProvider = async (input: ContextProviderInput) => {
  const state = input.state as Record<string, unknown> | undefined;
  const myData = state?.myPlugin as { active: boolean } | undefined;
  if (!myData?.active) return null;

  return {
    id: "my-context",
    title: input.locale.startsWith("zh") ? "我的状态" : "My State",
    content: formatState(myData),
    priority: 50,
  };
};
```

## Proposal System

All state changes go through proposals. 6 kinds:

| Kind | Payload | Purpose |
|------|---------|---------|
| `narrative.append` | `{ text }` | Add to narrative |
| `state.patch` | `Record<string, unknown>` | Merge into game state |
| `event.emit` | `{ type, data? }` | Trigger follow-up runtimes |
| `record.upsert` | `{ key, recordType, value }` | Persist to records DB |
| `ui.render` | `{ type, content }` | Render UI block |
| `asset.generate` | `{ type, prompt }` | Generate image/audio |

## 4 Common Plugin Patterns

1. **Context-Only** (core-persona): No tools. Registers context provider only. Priority ~100.
2. **LLM + Tools** (core-combat): PLUGIN.md instructs LLM to call tools. Priority 400-600.
3. **Code-Path** (core-char-tracker): RuntimeHandler for deterministic logic. Optional `ctx.generateText` / `ctx.generateImage`. Priority 600+.
4. **Background** (core-memory): `trigger.mode: "interval"`, `kind: "background"`. Priority 900+.
5. **Two-Step Event Chain** (core-image): Two runtimes chained via events. Runtime 1 uses text slot for processing, Runtime 2 uses image slot for generation.

## Two-Step Event Chain Pattern (core-image)

Use this when a task needs **different model slots** for different steps:

```
Frontend button / LLM tool
  → emit: my.step1.requested
  → Runtime 1 (providerTag: "text", kind: "plugin", priority: 800)
    → ctx.generateText(systemPrompt)
    → emit: my.step2.ready { result, settings }
  → Runtime 2 (providerTag: "image", kind: "background", priority: 801)
    → ctx.generateImage(prompt, { referenceUrl?, providerRequestMetadata? })
    → proposals: ui.render + state.patch
```

```json
// plugin.json runtimes
[
  { "id": "step1", "trigger": { "mode": "event", "onEvents": ["my.step1.requested"] }, "providerTag": "text" },
  { "id": "step2", "trigger": { "mode": "event", "onEvents": ["my.step2.ready"] },     "providerTag": "image" }
]
```

### `ctx.generateImage` API

```typescript
// Available in RuntimeHandlerContext when an image slot is configured
ctx.generateImage?(
  prompt: string,
  options?: {
    referenceUrl?: string;                        // Previous image for visual continuity
    providerRequestMetadata?: Record<string, unknown>;  // imageFormat, size, n, etc.
  }
): Promise<{ url: string }>
```

`providerRequestMetadata.imageFormat` selects the API format:
- `"dashscope-wan"` — DashScope WAN async task API (Chinese prompts recommended)
- `"openai-chat"` — OpenAI chat completions with image output (English prompts recommended)
- `"dalle"` / omit — Standard `/images/generations` endpoint (DALL-E style)

### World Context Extraction

For image generation plugins, use `extractWorldContext(ctx.context)` and
`extractCharacterContext(ctx.context)` from `image-logic.ts` to build rich prompts:

```typescript
const worldContext = extractWorldContext(ctx.context);   // world lore + dimensions
const characters = extractCharacterContext(ctx.context); // character appearances
const prompt = buildEnhancePromptZh(request, worldContext, characters, settings);
```

These helpers read `ctx.context.world` and `ctx.context.characters` which are
automatically injected by the kernel from the session's world package and character records.

## Manual Trigger Button Pattern

To add a frontend button that triggers a plugin event:

```typescript
// Frontend: game-view.tsx passes onTriggerEvent callback
onTriggerEvent?.("image.generation.requested", {
  scenePrompt: messageContent,
  storyBackground: "",  // kernel context provides full world context
});

// Server: actions.ts handles trigger_event type
// → calls kernelSession.executeTurn({ type: "image.generation.requested", payload: eventData })
// → kernel router matches runtime trigger.onEvents

// API: api.ts
import { triggerEvent } from "@/services/api";
const controller = triggerEvent(sessionId, "image.generation.requested", { scenePrompt }, locale, onEvent);
```

## Settings Panel (UI Slot: settings_panel)

Plugins can expose a settings UI via `blockSchemas` with `uiSlot: "settings_panel"`:

```json
{
  "type": "core_image_settings",
  "interactive": true,
  "uiSlot": "settings_panel",
  "dataSchema": {
    "type": "object",
    "properties": {
      "style": { "type": "string", "enum": ["cinematic", "anime", ...] },
      "multiPanel": { "type": "boolean" },
      "includeText": { "type": "boolean" },
      "promptLanguage": { "type": "string", "enum": ["auto", "zh", "en"] }
    }
  }
}
```

Settings are persisted via `state.patch` proposals in the block's `onSubmit` handler.
Handlers read settings from `ctx.context.state["plugin-id"].settings`.

## I18nText

```typescript
type I18nText = string | Record<string, string>;
// Use ctx.locale.startsWith("zh") for locale branching in handlers
```

## Testing

```typescript
import { createMockToolContext, assertProposalKinds, findProposal } from "@covel/plugin-test-utils";

const ctx = createMockToolContext({ toolId: "my-tool", input: {...}, locale: "zh-CN" });
const result = await myToolHandler(ctx);
assertProposalKinds(result.proposals!, ["state.patch", "event.emit"]);
```

## Authoring Rules

1. Depend ONLY on Public Plugin API — never import kernel internals, DB models, or frontend code
2. All writes through proposals — tools never write directly
3. Tools must have schemas — input JSON Schema required in plugin.json
4. I18n all display text — use I18nText (zh-CN + en-US minimum)
5. Separate business logic into `logic.ts` — keep handlers thin
6. Immutable state updates — always create new objects

## Detailed Reference

For complete type definitions (RuntimeContextView, ToolExecutionContext, HookHandlerContext, etc.), full manifest examples, runtime handler patterns, hook patterns, package.json/tsconfig.json templates, and testing patterns, read:

- `references/plugin-api-reference.md` — Full API reference with all type definitions and code examples
