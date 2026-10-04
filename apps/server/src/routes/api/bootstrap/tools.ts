/**
 * Bootstrap tool wiring.
 *
 * Builds the framework tool registry (builtin UI tools, suspend / runtime-done
 * sentinels, plugin-data tools, character tools, world-dimension tools), wires
 * per-session character-tool overrides, and assembles the approval-gated
 * `ToolExecutor`. Plugins register their own tools into the returned registry
 * from their entry modules (`bootstrap/plugin-entry.ts`).
 *
 * Extracted from `bootstrap.ts` to keep the composition root readable. All
 * closures capture the same `store` the bootstrap builds.
 */

import {
  ToolRegistry,
  createDefaultToolRegistry,
  buildSessionCharacterWriteTools,
  type ToolModule,
} from "@covel/tools";
import type { DataStore } from "@covel/store";
import { createToolExecutor, type ManagedToolExecutor } from "@covel/runtime";
import { createDefaultToolApprovalPipeline } from "@covel/approval";
import type { EventDirectory } from "./event-directory.js";

export interface SetupPluginToolsParams {
  readonly store: DataStore;
  readonly eventDirectory: EventDirectory;
}

export interface PluginToolsResult {
  readonly tools: ToolRegistry;
  readonly toolExecutor: ManagedToolExecutor;
  readonly prepareToolsForSession: (sessionId: string) => Promise<void>;
  /** Drop the per-session tool override cache entry. Called on session
   *  end/delete so the map does not grow for the lifetime of the process. */
  readonly clearSessionToolOverrides: (sessionId: string) => void;
}

export async function setupPluginTools(
  params: SetupPluginToolsParams,
): Promise<PluginToolsResult> {
  const { store, eventDirectory } = params;
  const tools = createDefaultToolRegistry({ store, eventDirectory });

  // ── Per-session tool overrides (Phase 2) ──────────────────────
  //
  // Advertise the world's field constraints once in each write tool's
  // description, retaining compact generic parameters. Execution validates
  // against the current stored schema. Preparation refreshes the per-session
  // tools before execution so changes in worlds cannot leak between sessions. The
  // `findTool` resolver below checks this cache before falling back to the
  // generic tool registry. Action handlers call `prepareToolsForSession` before
  // every `executeTurn` so the LLM always gets the freshest schema.
  const sessionToolOverrides = new Map<string, Map<string, ToolModule>>();
  const SESSION_OVERRIDABLE_TOOLS = new Set([
    "create-character",
    "update-character",
    "sync-characters",
  ]);

  async function prepareToolsForSession(sessionId: string): Promise<void> {
    const value = await store.getCharacterSchema(sessionId);
    if (!value) {
      sessionToolOverrides.delete(sessionId);
      return;
    }

    const overrides = new Map<string, ToolModule>();
    for (const t of buildSessionCharacterWriteTools(store, value)) {
      overrides.set(t.name, t);
    }
    sessionToolOverrides.set(sessionId, overrides);
  }

  function clearSessionToolOverrides(sessionId: string): void {
    sessionToolOverrides.delete(sessionId);
  }

  const approval = createDefaultToolApprovalPipeline();

  const toolExecutor = createToolExecutor({
    findTool: (name, context) => {
      // Per-session override (Phase 2): when the active session has a
      // CharacterAttributeSchema, return the schema-aware variant so both the
      // LLM-facing JSON schema and the Zod validation reflect typed fields.
      if (SESSION_OVERRIDABLE_TOOLS.has(name)) {
        const override = sessionToolOverrides.get(context.sessionId)?.get(name);
        if (override) return override;
      }
      return tools.find(name, context.pluginId);
    },
    store,
    approval,
    getToolSource: (name) => tools.source(name),
  });

  return {
    tools,
    toolExecutor,
    prepareToolsForSession,
    clearSessionToolOverrides,
  };
}
