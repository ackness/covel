/**
 * Bootstrap tool wiring.
 *
 * Builds the framework tool registry (builtin UI tools, suspend / runtime-done
 * sentinels, plugin-data tools, character tools, world-dimension tools), wires
 * per-session character-tool overrides, registers each plugin's approved local
 * tools, and assembles the approval-gated `ToolExecutor`.
 *
 * Extracted from `bootstrap.ts` to keep the composition root readable. All
 * closures capture the same `store` / `registry` the bootstrap builds; the
 * behaviour is byte-for-byte the previous inline wiring.
 */

import {
  builtinUITools,
  createPluginDataTools,
  createCharacterTools,
  buildSessionCharacterWriteTools,
  createWorldDimensionTools,
  createEmitEventTool,
  suspendTool,
  runtimeDoneTool,
  type ToolModule,
  type CharacterToolDeps,
} from "@covel/tools";
import { FrameworkCapability } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  createToolExecutor,
  type ToolExecutor,
  type LLMAdapter,
} from "@covel/runtime";
import { createApprovalPipeline } from "@covel/approval";
import type { PermissionRule } from "@covel/approval";
import type {
  PluginRegistry,
  PluginDiscoveryResult,
  ParsedPluginMd,
} from "@covel/plugin-loader";
import { createBootstrapLocalTools } from "./local-tools.js";
import type { EventDirectory } from "./event-directory.js";

export interface SetupPluginToolsParams {
  readonly store: DataStore;
  readonly registry: PluginRegistry;
  readonly discoveryMap: Map<string, PluginDiscoveryResult>;
  readonly manifestCache: Map<string, readonly ParsedPluginMd[]>;
  readonly llmAdapter: LLMAdapter;
  readonly eventDirectory: EventDirectory;
}

export interface PluginToolsResult {
  readonly toolMap: Map<string, ToolModule>;
  readonly builtinToolNames: Set<string>;
  readonly localToolNames: Set<string>;
  readonly toolExecutor: ToolExecutor;
  readonly prepareToolsForSession: (sessionId: string) => Promise<void>;
  /** Drop the per-session tool override cache entry. Called on session
   *  end/delete so the map does not grow for the lifetime of the process. */
  readonly clearSessionToolOverrides: (sessionId: string) => void;
  readonly activatePluginLocalTools: (pluginId: string) => Promise<void>;
  /** Mutable — the unified `entry` registration path (plugin-entry.ts) adds
   *  entry-registered tool names at invocation time. */
  readonly pluginToolAccess: Map<string, Set<string>>;
}

export async function setupPluginTools(
  params: SetupPluginToolsParams,
): Promise<PluginToolsResult> {
  const { store, registry, discoveryMap, manifestCache, eventDirectory } =
    params;

  const builtinToolNames = new Set<string>();
  const localToolNames = new Set<string>();
  const toolMap = new Map<string, ToolModule>();

  for (const t of builtinUITools) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Register suspend tool. The sentinel becomes a normal tool result returned
  // to the LLM when no suspension handler consumes it.
  toolMap.set(suspendTool.name, suspendTool);
  builtinToolNames.add(suspendTool.name);

  // Register runtime-done tool. Framework contract: agent runtimes call this
  // immediately after completing their business tool calls to exit without
  // burning an extra LLM round-trip on a terminator message. The completion
  // preamble in buildFrameworkPreamble instructs every runtime how to use it.
  toolMap.set(runtimeDoneTool.name, runtimeDoneTool);
  builtinToolNames.add(runtimeDoneTool.name);

  // Register plugin-data tools (store-bound via closure; events emitted by store proxy)
  for (const t of createPluginDataTools(store)) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // Register emit-event tool — validates against the session event directory
  // (aggregated `events` contracts of active plugins) and routes through the
  // emitted-events result channel, never an `event.emit` pendingProposal.
  const emitEventTool = createEmitEventTool({ directory: eventDirectory });
  toolMap.set(emitEventTool.name, emitEventTool);
  builtinToolNames.add(emitEventTool.name);

  // Register character management tools (writes characters table + mirrors to plugin-data).
  // `findWorldDataPluginId` lets create/update-character locate the schema
  // produced by whichever plugin declares `capabilities: [world-data-provider]`
  // (framework/plugin isolation — same pattern as world-dimension tools).
  // When present, write tools append soft schema warnings to their `_text`
  // output so the LLM can self-correct.
  const characterToolDeps: CharacterToolDeps = {
    findWorldDataPluginId: (sessionId) =>
      registry.findPluginByCapability(
        sessionId,
        FrameworkCapability.WorldDataProvider,
      ),
  };
  for (const t of createCharacterTools(store, characterToolDeps)) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  // ── Per-session tool overrides (Phase 2) ──────────────────────
  //
  // Phase 1 made write-tool `fields` validation soft (warnings in `_text`).
  // Phase 2 lets the LLM see the world-specific schema directly in the tool
  // parameters: `prepareToolsForSession(sessionId)` loads the active
  // CharacterAttributeSchema and rebuilds `create-character`/`update-character`
  // with strongly-typed `fields` Zod, then caches them per session. The
  // `findTool` resolver below checks this cache before falling back to the
  // generic toolMap. Action handlers call `prepareToolsForSession` before
  // every `executeTurn` so the LLM always gets the freshest schema.
  const sessionToolOverrides = new Map<string, Map<string, ToolModule>>();
  const SESSION_OVERRIDABLE_TOOLS = new Set([
    "create-character",
    "update-character",
  ]);

  async function prepareToolsForSession(sessionId: string): Promise<void> {
    if (typeof store.getPluginData !== "function") return;
    const worldPluginId = characterToolDeps.findWorldDataPluginId?.(sessionId);
    if (!worldPluginId) {
      sessionToolOverrides.delete(sessionId);
      return;
    }
    let row: { value: unknown; updatedAt: string } | null = null;
    try {
      row = await store.getPluginData(
        sessionId,
        worldPluginId,
        "schema",
        "character-attributes",
      );
    } catch {
      sessionToolOverrides.delete(sessionId);
      return;
    }
    const value = row?.value;
    if (!value || typeof value !== "object") {
      sessionToolOverrides.delete(sessionId);
      return;
    }
    const schemaShape = value as { attributes?: unknown };
    if (
      !Array.isArray(schemaShape.attributes) ||
      schemaShape.attributes.length === 0
    ) {
      sessionToolOverrides.delete(sessionId);
      return;
    }

    const overrides = new Map<string, ToolModule>();
    for (const t of buildSessionCharacterWriteTools(
      store,
      characterToolDeps,
      value as Parameters<typeof buildSessionCharacterWriteTools>[2],
    )) {
      overrides.set(t.name, t);
    }
    sessionToolOverrides.set(sessionId, overrides);
  }

  function clearSessionToolOverrides(sessionId: string): void {
    sessionToolOverrides.delete(sessionId);
  }

  // Register world-dimension query tools so agent runtimes can fetch only the
  // fields they need instead of relying on bulk prompt injection.
  for (const t of createWorldDimensionTools(store, {
    findWorldDataPluginId: (sessionId) =>
      registry.findPluginByCapability(
        sessionId,
        FrameworkCapability.WorldDataProvider,
      ),
  })) {
    toolMap.set(t.name, t);
    builtinToolNames.add(t.name);
  }

  const { activatePluginLocalTools, pluginToolAccess } =
    await createBootstrapLocalTools({
      discoveryMap,
      manifestCache,
      store,
      toolMap,
      localToolNames,
    });

  // Approval: whitelist builtin + known local tools, deny unknown third-party
  const approvalRules: PermissionRule[] = [
    { pattern: "builtin:*", action: "allow" },
    { pattern: "local:*", action: "allow" },
    { pattern: "third-party:*", action: "deny" },
  ];
  const approval = createApprovalPipeline(store, approvalRules);

  const toolExecutor = createToolExecutor({
    findTool: (name, context) => {
      // Per-session override (Phase 2): when the active session has a
      // CharacterAttributeSchema, return the schema-aware variant so both the
      // LLM-facing JSON schema and the Zod validation reflect typed fields.
      if (context && SESSION_OVERRIDABLE_TOOLS.has(name)) {
        const override = sessionToolOverrides.get(context.sessionId)?.get(name);
        if (override) return override;
      }
      // Builtin tools are always accessible
      if (builtinToolNames.has(name)) return toolMap.get(name);
      // Local tools: only accessible if declared by the calling plugin
      if (context) {
        const allowed = pluginToolAccess.get(context.pluginId);
        if (!allowed?.has(name)) return undefined; // Cross-plugin call blocked
      }
      return toolMap.get(name);
    },
    store,
    approval,
    getToolSource: (name) => {
      if (builtinToolNames.has(name)) return "builtin";
      if (localToolNames.has(name)) return "local";
      return "third-party";
    },
  });

  return {
    toolMap,
    builtinToolNames,
    localToolNames,
    toolExecutor,
    prepareToolsForSession,
    clearSessionToolOverrides,
    activatePluginLocalTools,
    pluginToolAccess,
  };
}
