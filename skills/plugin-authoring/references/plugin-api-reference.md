# Plugin API Reference

Complete type definitions, manifest schemas, and code patterns for Covel plugin authoring.

## Table of Contents

1. [Common Types](#common-types)
2. [Plugin Manifest (plugin.json)](#plugin-manifest)
3. [PluginRegistrar API](#pluginregistrar-api)
4. [Tool Handler](#tool-handler)
5. [Hook Handler](#hook-handler)
6. [Context Provider](#context-provider)
7. [Runtime Handler (Code-Path)](#runtime-handler)
8. [Command Registration](#command-registration)
9. [Proposal System](#proposal-system)
10. [Block Schema Declaration](#block-schema-declaration)
11. [Full Manifest Examples](#full-manifest-examples)
12. [package.json / tsconfig.json Templates](#packagejson--tsconfigjson-templates)
13. [Testing Patterns](#testing-patterns)

---

## Common Types

From `@covel/shared` — these are the building blocks used throughout the plugin API.

```typescript
// Locale-aware text: plain string = default locale only, object = locale map
type I18nText = string | Record<string, string>;

// Supported locale identifiers
type Locale = "zh-CN" | "en-US" | (string & {});

// Runtime budget constraints
interface RuntimeBudget {
  maxSteps?: number;      // Hard limit: max tool-calling steps
  timeoutMs?: number;     // Hard limit: timeout in milliseconds
  maxTokens?: number;     // Best-effort: approximate max tokens
}

// Runtime trigger spec
interface RuntimeTriggerSpec {
  mode: "always" | "interval" | "manual" | "event";
  intervalTurns?: number;   // Only for mode: "interval"
  onEvents?: string[];      // Only for mode: "event"
}

// Runtime kind
type RuntimeKind = "story" | "plugin" | "background" | "verifier";

// Failure policy
type FailurePolicy = "continue" | "stop" | "retry" | "disable_runtime";

// Hook lifecycle points
type HookEvent =
  | "TurnStart"
  | "PreToolUse"
  | "PostToolUse"
  | "PreStateCommit"
  | "PostStateCommit"
  | "TurnStop";

// UI slot identifiers
type UiSlot = "settings_panel" | "message_block" | "world_panel" | "action_panel";

// Proposal kinds
type ProposalKind =
  | "narrative.append"
  | "state.patch"
  | "event.emit"
  | "record.upsert"
  | "ui.render"
  | "asset.generate";
```

---

## Plugin Manifest

The `plugin.json` file declares all plugin capabilities. Full TypeScript interface:

```typescript
interface PluginManifest {
  // ── Required ──
  schemaVersion: string;           // Always "1.0"
  id: string;                      // Unique plugin ID (e.g. "core-combat")
  displayName: I18nText;           // { "zh-CN": "...", "en-US": "..." }
  version: string;                 // Semver (e.g. "0.1.0")
  author: string;                  // Author name
  description: I18nText;           // Plugin description
  defaultLocale: Locale;           // Usually "zh-CN"
  supportedLocales: Locale[];      // Minimum: ["zh-CN", "en-US"]

  // ── Optional ──
  loadingOrder?: number;           // 0-100, lower = loaded first
  requires?: string[];             // Plugin IDs this depends on
  supersedes?: string[];           // Plugin IDs this replaces
  conflicts?: string[];            // Plugin IDs that can't coexist

  runtimes?: PublicRuntimeSpec[];
  tools?: PublicToolDefinition[];
  hooks?: PublicHookDefinition[];
  ui?: PublicUiExtension[];
  runtimeSettings?: RuntimeSettingField[];
  permissions?: string[];
  providers?: PublicProviderBinding[];
  blockSchemas?: BlockSchemaDeclaration[];
}
```

### PublicRuntimeSpec

```typescript
interface PublicRuntimeSpec {
  id: string;                          // Runtime ID (unique within plugin)
  pluginId: string;                    // Must match parent plugin ID
  kind: RuntimeKind;                   // "story" | "plugin" | "background" | "verifier"
  priority?: number;                   // 0-1000. 0 = highest = first. Default: 500
  trigger: RuntimeTriggerSpec;
  providerBinding?: string;            // Model slot: "default" | "fast" | "balance"
  instructionsRef?: string;            // Path to PLUGIN.md (auto-resolved if omitted)
  tools: string[];                     // Qualified tool IDs: "pluginId:toolId"
  hooks: string[];                     // Qualified hook IDs
  budget?: RuntimeBudget;
  output?: { proposalKinds?: string[] };
  failurePolicy?: FailurePolicy;
  isolation?: RuntimeIsolationSpec;
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

### PublicToolDefinition

```typescript
interface PublicToolDefinition {
  id: string;
  kind: "query" | "mutate" | "emit" | "render" | "generate" | "orchestration" | "script" | "proxy";
  schema?: unknown;          // JSON Schema for tool input
  permissions?: string[];    // Required permissions
}
```

### PublicHookDefinition

```typescript
interface PublicHookDefinition {
  id: string;
  event: HookEvent;
  handlerKind: "command" | "prompt" | "async-command";
  match?: {
    toolIds?: string[];
    runtimeIds?: string[];
    pluginIds?: string[];
  };
}
```

### PublicUiExtension

```typescript
interface PublicUiExtension {
  id: string;
  slot: UiSlot;              // "settings_panel" | "message_block" | "world_panel" | "action_panel"
  component: unknown;
  propsSchema?: unknown;
}
```

### PublicProviderBinding

```typescript
interface PublicProviderBinding {
  id: string;
  kind: "llm" | "image" | "tts" | "script-host";
  configRef?: string;
  permissions?: string[];
}
```

### RuntimeSettingField

```typescript
interface RuntimeSettingField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  label: I18nText;
  description?: I18nText;
  scope?: "project" | "run" | "request";
  component?: "input" | "textarea" | "toggle" | "select";
  default?: unknown;
  options?: Array<{ label: I18nText; value: string | number | boolean }>;
  affects?: string[];
}
```

---

## PluginRegistrar API

The `PluginRegistrar` is injected into your `server/index.ts` default export:

```typescript
interface PluginRegistrar {
  addTool(id: string, handler: ToolHandler): void;
  addHook(id: string, handler: HookHandler): void;
  addContextProvider(id: string, handler: ContextProvider): void;
  addRuntimeHandler(runtimeId: string, handler: RuntimeHandler): void;
  addCommand(registration: CommandRegistration): void;
}

// server/index.ts pattern:
import type { PluginRegistrar } from "@covel/plugin-runtime";

export default function register(registrar: PluginRegistrar): void {
  registrar.addTool("my-tool", myToolHandler);
  registrar.addContextProvider("my-ctx", myContextProvider);
  // registrar.addRuntimeHandler("my-runtime", myHandler);
  // registrar.addHook("my-hook", myHookHandler);
  // registrar.addCommand({ name: "my-cmd", ... });
}
```

---

## Tool Handler

```typescript
// Signature
type ToolHandler = (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;

// Context
interface ToolExecutionContext<I = unknown> {
  input: I;                              // Parsed from JSON Schema
  runtimeId: string;
  pluginId: string;
  locale: string;                        // "zh-CN" or "en-US"
  state?: Record<string, unknown>;       // Current plugin-scoped state
}

// Result
interface ToolExecutionResult<O = unknown> {
  output: O;                             // Returned to the LLM
  proposals?: Array<{
    kind: string;      // ProposalKind
    payload: unknown;
  }>;
}
```

### Full Tool Handler Example

```typescript
import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";

interface UseItemInput {
  itemId: string;
  targetId?: string;
}

interface UseItemOutput {
  message: string;
  success: boolean;
  effect?: string;
}

export async function useItemTool(
  ctx: ToolExecutionContext<UseItemInput>,
): Promise<ToolExecutionResult<UseItemOutput>> {
  const { itemId, targetId } = ctx.input;
  const isZh = ctx.locale.startsWith("zh");

  // Pure logic — no DB access
  const inventory = (ctx.state?.inventory as Record<string, number>) ?? {};
  const count = inventory[itemId] ?? 0;
  if (count <= 0) {
    return {
      output: {
        message: isZh ? `你没有 ${itemId}` : `You don't have ${itemId}`,
        success: false,
      },
    };
  }

  return {
    output: {
      message: isZh ? `使用了 ${itemId}` : `Used ${itemId}`,
      success: true,
      effect: targetId ? `applied to ${targetId}` : undefined,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { inventory: { ...inventory, [itemId]: count - 1 } },
      },
      {
        kind: "event.emit",
        payload: { type: "item_used", data: { itemId, targetId } },
      },
      {
        kind: "ui.render",
        payload: {
          type: "item_effect",
          content: { itemId, targetId, remaining: count - 1 },
        },
      },
    ],
  };
}
```

---

## Hook Handler

```typescript
// Signature
type HookHandler = (ctx: HookHandlerContext) => Promise<HookHandlerResult>;

// Context
interface HookHandlerContext {
  event: HookEvent;
  runtimeId: string;
  pluginId: string;
  locale: string;
  toolCall?: {                // Present for PreToolUse/PostToolUse
    toolId: string;
    input: unknown;
    output?: unknown;         // Only in PostToolUse
  };
  proposals?: unknown[];      // Present for PreStateCommit/PostStateCommit
}

// Result
interface HookHandlerResult {
  allow: boolean;             // false = block the action
  rewrittenInput?: unknown;   // Only for PreToolUse — rewrite tool input
  context?: Record<string, unknown>;  // Inject additional context
}
```

### Hook Example: Validate Attack Target

```typescript
import type { HookHandler } from "@covel/plugin-runtime";

export const validateAttackHook: HookHandler = async (ctx) => {
  if (ctx.event !== "PreToolUse" || ctx.toolCall?.toolId !== "core-combat:attack") {
    return { allow: true };
  }

  const input = ctx.toolCall.input as { targetId?: string };
  if (!input.targetId) {
    return { allow: false };
  }

  return { allow: true };
};
```

---

## Context Provider

```typescript
// Signature
type ContextProvider = (ctx: ContextProviderInput) => Promise<unknown>;

// Input
interface ContextProviderInput {
  pluginId: string;
  runtimeId: string;
  locale: string;
  state?: unknown;          // Current game state
  world?: unknown;          // Current world data
  characters?: unknown[];   // Active characters
}
```

### Context Provider Example

```typescript
import type { ContextProvider, ContextProviderInput } from "@covel/plugin-runtime";

export const inventoryContextProvider: ContextProvider = async (
  input: ContextProviderInput,
) => {
  const state = input.state as Record<string, unknown> | undefined;
  const inventory = state?.inventory as Record<string, number> | undefined;
  if (!inventory || Object.keys(inventory).length === 0) return null;

  const isZh = input.locale.startsWith("zh");
  const items = Object.entries(inventory)
    .map(([name, count]) => `- ${name}: ${count}`)
    .join("\n");

  return {
    id: "inventory-status",
    title: isZh ? "背包物品" : "Inventory",
    content: items,
    priority: 50,
  };
};
```

---

## Runtime Handler

For deterministic logic that doesn't need LLM. When registered, the kernel uses this instead of calling the LLM.

```typescript
// Signature
type RuntimeHandler = (ctx: RuntimeHandlerContext) => Promise<RuntimeHandlerResult>;

// Context
interface RuntimeHandlerContext {
  runtimeId: string;
  pluginId: string;
  locale: string;
  context: unknown;               // Read-only runtime context view
  instructions?: string;          // PLUGIN.md content
  data?: PluginDataAccess;        // Unified data access for reads + proposal helpers
  generateText?: (prompt: string) => Promise<string>;  // Optional LLM access
}

// Result
interface RuntimeHandlerResult {
  proposals: Array<{ kind: string; payload: unknown }>;
}
```

### Runtime Handler Example (core-char-tracker pattern)

```typescript
import type { RuntimeHandler } from "@covel/plugin-runtime";

export const charTrackerHandler: RuntimeHandler = async (ctx) => {
  const isZh = ctx.locale.startsWith("zh");
  const proposals: Array<{ kind: string; payload: unknown }> = [];

  // Deterministic logic — no LLM needed
  // Use ctx.generateText() only when you need LLM judgment

  const summary = isZh ? "角色状态已更新" : "Character state updated";
  proposals.push({
    kind: "state.patch",
    payload: { characterTrackerLastRun: Date.now() },
  });

  return { proposals };
};

// Registration in server/index.ts:
import type { PluginRegistrar } from "@covel/plugin-runtime";
import { charTrackerHandler } from "./handler.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addRuntimeHandler("char-tracker", charTrackerHandler);
}
```

---

## Command Registration

Plugins can register slash commands available in the game UI.

```typescript
interface CommandRegistration {
  name: string;
  description: string;
  handler: CommandHandlerFn;
  argsSchema?: ZodLikeSchema;   // Optional Zod schema for validation
  help?: {
    usage: string;
    examples?: string[];
  };
  autocomplete?: {
    positionalHints?: string[];
    flagHints?: Array<{ name: string; description: string; takesValue: boolean }>;
  };
}

type CommandHandlerFn = (
  args: unknown,
  context: Record<string, unknown>,
) => unknown | Promise<unknown>;
```

---

## Proposal System

All state changes go through proposals. Tools return proposals; the kernel validates and commits them.

| Kind | Payload | Purpose |
|------|---------|---------|
| `narrative.append` | `{ text: string }` | Add to narrative output |
| `state.patch` | `Record<string, unknown>` | Merge into game state |
| `event.emit` | `{ type: string, data?: unknown }` | Trigger follow-up runtimes |
| `record.upsert` | `{ key: string, recordType: string, value: unknown }` | Persist to records DB |
| `ui.render` | `{ type: string, content: unknown }` | Render UI block |
| `asset.generate` | `{ type: string, prompt: string }` | Generate image/audio |

```typescript
// Example: returning multiple proposals from a tool
return {
  output: { message: "Success" },
  proposals: [
    { kind: "narrative.append", payload: { text: "The sword glows..." } },
    { kind: "state.patch", payload: { hp: 80 } },
    { kind: "event.emit", payload: { type: "combat_ended", data: { reason: "victory" } } },
    { kind: "ui.render", payload: { type: "combat_status", content: { ... } } },
  ],
};
```

---

## Block Schema Declaration

Schema-driven UI rendering. Declare in `plugin.json` `blockSchemas`:

```typescript
interface BlockSchemaDeclaration {
  type: string;                      // Block type identifier
  interactive: boolean;              // Whether user can interact
  meta: {
    displayName: I18nText;
    description: string;
    icon?: string;
  };
  dataSchema: Record<string, unknown>;    // JSON Schema for display data
  submitSchema?: Record<string, unknown>; // JSON Schema for user submission (interactive only)
}
```

### Example (from core-combat)

```json
{
  "type": "combat_status",
  "interactive": false,
  "meta": {
    "displayName": { "zh-CN": "战斗状态", "en-US": "Combat Status" },
    "description": "Combat status display showing participants, HP, and turn order"
  },
  "dataSchema": {
    "type": "object",
    "properties": {
      "roundNumber": { "type": "number" },
      "currentActor": { "type": "string" },
      "participants": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "name": { "type": "string" },
            "hp": { "type": "number" },
            "maxHp": { "type": "number" },
            "isDefeated": { "type": "boolean" }
          }
        }
      }
    }
  }
}
```

---

## Full Manifest Examples

### Pattern 1: Context-Only (core-persona)

No tools, no runtime handler. Just injects context.

```json
{
  "schemaVersion": "1.0",
  "id": "core-persona",
  "displayName": { "zh-CN": "叙事人格", "en-US": "Narrator Persona" },
  "version": "0.1.0",
  "author": "covel",
  "description": { "zh-CN": "为叙事生成提供人格声音和行为约束。", "en-US": "Provides persona voice and behavior constraints." },
  "defaultLocale": "zh-CN",
  "supportedLocales": ["zh-CN", "en-US"],
  "loadingOrder": 10,
  "runtimes": [
    {
      "id": "persona",
      "pluginId": "core-persona",
      "kind": "plugin",
      "priority": 100,
      "trigger": { "mode": "always" },
      "tools": [],
      "hooks": []
    }
  ]
}
```

### Pattern 2: LLM + Tools (core-combat)

LLM reads PLUGIN.md, decides when to call tools.

```json
{
  "schemaVersion": "1.0",
  "id": "core-combat",
  "displayName": { "zh-CN": "战斗系统", "en-US": "Combat System" },
  "version": "0.1.0",
  "author": "covel",
  "description": { "zh-CN": "结构化回合制战斗系统。", "en-US": "Structured turn-based combat." },
  "defaultLocale": "zh-CN",
  "supportedLocales": ["zh-CN", "en-US"],
  "loadingOrder": 42,
  "requires": ["core-dice"],
  "runtimes": [
    {
      "id": "combat-engine",
      "pluginId": "core-combat",
      "kind": "plugin",
      "priority": 420,
      "trigger": { "mode": "event", "onEvents": ["user.input", "combat_started"] },
      "providerBinding": "default",
      "tools": [
        "core-combat:start-combat",
        "core-combat:attack",
        "core-combat:defend",
        "core-combat:use-skill",
        "core-combat:end-combat",
        "core-dice:roll-check"
      ],
      "hooks": [],
      "budget": { "maxSteps": 8, "timeoutMs": 60000 }
    }
  ],
  "tools": [
    {
      "id": "start-combat",
      "kind": "mutate",
      "schema": {
        "type": "object",
        "properties": {
          "participants": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": { "type": "string" },
                "name": { "type": "string" },
                "type": { "type": "string", "enum": ["player", "ally", "enemy"] },
                "hp": { "type": "number" },
                "maxHp": { "type": "number" }
              },
              "required": ["id", "name", "type", "hp", "maxHp"]
            }
          }
        },
        "required": ["participants"]
      }
    }
  ],
  "blockSchemas": [
    {
      "type": "combat_status",
      "interactive": false,
      "meta": {
        "displayName": { "zh-CN": "战斗状态", "en-US": "Combat Status" },
        "description": "Combat status display"
      },
      "dataSchema": { "type": "object", "properties": { "roundNumber": { "type": "number" } } }
    }
  ]
}
```

### Pattern 3: Code-Path Runtime (core-char-tracker)

Deterministic handler, no LLM unless explicitly needed.

```json
{
  "schemaVersion": "1.0",
  "id": "core-char-tracker",
  "displayName": { "zh-CN": "角色追踪", "en-US": "Character Tracker" },
  "version": "0.1.0",
  "author": "covel",
  "description": { "zh-CN": "自动识别与追踪角色信息。", "en-US": "Automatic character identification and tracking." },
  "defaultLocale": "zh-CN",
  "supportedLocales": ["zh-CN", "en-US"],
  "loadingOrder": 60,
  "runtimes": [
    {
      "id": "char-tracker",
      "pluginId": "core-char-tracker",
      "kind": "plugin",
      "priority": 600,
      "trigger": { "mode": "always" },
      "tools": [],
      "hooks": []
    }
  ]
}
```

### Pattern 4: Background (core-memory)

Runs periodically, not on every turn.

```json
{
  "schemaVersion": "1.0",
  "id": "core-memory",
  "displayName": { "zh-CN": "记忆摘要", "en-US": "Memory Summarizer" },
  "version": "0.1.0",
  "author": "covel",
  "description": { "zh-CN": "定期压缩和摘要长期记忆。", "en-US": "Periodically compacts and summarizes long-term memory." },
  "defaultLocale": "zh-CN",
  "supportedLocales": ["zh-CN", "en-US"],
  "loadingOrder": 90,
  "runtimes": [
    {
      "id": "memory-summarizer",
      "pluginId": "core-memory",
      "kind": "background",
      "priority": 900,
      "trigger": { "mode": "interval", "intervalTurns": 5 },
      "providerBinding": "fast",
      "tools": [],
      "hooks": [],
      "budget": { "maxSteps": 4, "timeoutMs": 30000, "maxTokens": 4096 }
    }
  ]
}
```

---

## package.json / tsconfig.json Templates

### package.json

```json
{
  "name": "@covel/plugin-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "exports": {
    ".": { "import": "./server/index.ts" }
  },
  "dependencies": {
    "@covel/shared": "workspace:*",
    "@covel/plugin-runtime": "workspace:*"
  },
  "devDependencies": {
    "@covel/plugin-test-utils": "workspace:*",
    "vitest": "^3.0.0",
    "typescript": "^5.8.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "paths": {}
  },
  "include": ["server/**/*.ts", "tests/**/*.ts"]
}
```

---

## Testing Patterns

Use `@covel/plugin-test-utils` for unit testing plugin tools and handlers.

### Tool Handler Test

```typescript
import { describe, it, expect } from "vitest";
import {
  createMockToolContext,
  assertProposalKinds,
  findProposal,
} from "@covel/plugin-test-utils";
import { useItemTool } from "../server/tools.js";

describe("useItemTool", () => {
  it("should consume item and emit proposals", async () => {
    const ctx = createMockToolContext({
      toolId: "use-item",
      input: { itemId: "health-potion", targetId: "player" },
      locale: "zh-CN",
      state: { inventory: { "health-potion": 3 } },
    });

    const result = await useItemTool(ctx);

    expect(result.output.success).toBe(true);
    assertProposalKinds(result.proposals!, ["state.patch", "event.emit", "ui.render"]);

    const patch = findProposal(result.proposals!, "state.patch");
    expect(patch.payload).toEqual({
      inventory: { "health-potion": 2 },
    });
  });

  it("should reject when item not in inventory", async () => {
    const ctx = createMockToolContext({
      toolId: "use-item",
      input: { itemId: "missing-item" },
      locale: "en-US",
      state: { inventory: {} },
    });

    const result = await useItemTool(ctx);
    expect(result.output.success).toBe(false);
    expect(result.proposals).toBeUndefined();
  });
});
```

### Runtime Handler Test

```typescript
import { describe, it, expect } from "vitest";
import { charTrackerHandler } from "../server/handler.js";

describe("charTrackerHandler", () => {
  it("should produce state.patch proposals", async () => {
    const result = await charTrackerHandler({
      runtimeId: "char-tracker",
      pluginId: "core-char-tracker",
      locale: "zh-CN",
      context: {},
    });

    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals[0].kind).toBe("state.patch");
  });
});
```

### Hook Handler Test

```typescript
import { describe, it, expect } from "vitest";
import { validateAttackHook } from "../server/hooks.js";

describe("validateAttackHook", () => {
  it("should block attack without targetId", async () => {
    const result = await validateAttackHook({
      event: "PreToolUse",
      runtimeId: "combat-engine",
      pluginId: "core-combat",
      locale: "zh-CN",
      toolCall: { toolId: "core-combat:attack", input: {} },
    });
    expect(result.allow).toBe(false);
  });

  it("should allow valid attack", async () => {
    const result = await validateAttackHook({
      event: "PreToolUse",
      runtimeId: "combat-engine",
      pluginId: "core-combat",
      locale: "zh-CN",
      toolCall: {
        toolId: "core-combat:attack",
        input: { attackerId: "p1", targetId: "e1", rollResult: 15 },
      },
    });
    expect(result.allow).toBe(true);
  });

  it("should pass through non-attack events", async () => {
    const result = await validateAttackHook({
      event: "TurnStart",
      runtimeId: "combat-engine",
      pluginId: "core-combat",
      locale: "zh-CN",
    });
    expect(result.allow).toBe(true);
  });
});
```
