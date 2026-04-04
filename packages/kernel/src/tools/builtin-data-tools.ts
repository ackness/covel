import type {
  PublicToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  PluginDataAccess,
} from "@covel/shared";

/**
 * Built-in data access tools available to all runtimes.
 * These tools provide LLM-callable read/write access to game data
 * through the standard tool calling interface.
 *
 * Tool IDs follow the domain convention:
 *   state.get, state.list, record.search, character.list, etc.
 */

export interface BuiltinToolDeps {
  getDataAccess: () => PluginDataAccess;
}

export interface BuiltinToolEntry {
  definition: PublicToolDefinition;
  handler: (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 10;
const MAX_QUERY_LIMIT = 200;

export function createBuiltinDataTools(
  deps: BuiltinToolDeps
): BuiltinToolEntry[] {
  const da = () => deps.getDataAccess();

  return [
    // ── state.get ──
    {
      definition: {
        id: "state.get",
        kind: "query",
        schema: {
          type: "object",
          properties: {
            scope: { type: "string", description: "State scope (e.g. 'plugin.combat')" },
            key: { type: "string", description: "Key within scope (optional, returns entire scope if omitted)" },
          },
          required: ["scope"],
        },
      },
      handler: async (ctx) => {
        const input = ctx.input as Record<string, unknown> | undefined;
        const scope = typeof input?.scope === "string" ? input.scope : "";
        if (!scope) return { output: { error: "Missing required parameter: scope" } };
        const key = typeof input?.key === "string" ? input.key : undefined;
        const result = key ? da().state.get(scope, key) : da().state.getScope(scope);
        return { output: result ?? null };
      },
    },

    // ── record.search ──
    {
      definition: {
        id: "record.search",
        kind: "query",
        schema: {
          type: "object",
          properties: {
            recordType: { type: "string", description: "Record type filter (e.g. 'character', 'quest')" },
            limit: { type: "number", description: `Max results (default ${DEFAULT_QUERY_LIMIT})` },
          },
        },
      },
      handler: async (ctx) => {
        const input = (ctx.input ?? {}) as Record<string, unknown>;
        const recordType = typeof input.recordType === "string" ? input.recordType : undefined;
        const limit = Math.min(typeof input.limit === "number" ? input.limit : DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
        const results = da().records.list(recordType);
        return { output: results.slice(0, limit) };
      },
    },

    // ── record.get ──
    {
      definition: {
        id: "record.get",
        kind: "query",
        schema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Record key" },
          },
          required: ["key"],
        },
      },
      handler: async (ctx) => {
        const input = ctx.input as Record<string, unknown> | undefined;
        const key = typeof input?.key === "string" ? input.key : "";
        if (!key) return { output: { error: "Missing required parameter: key" } };
        return { output: da().records.get(key) ?? null };
      },
    },

    // ── character.list ──
    {
      definition: {
        id: "character.list",
        kind: "query",
        schema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Filter by character type: player, npc, companion" },
          },
        },
      },
      handler: async (ctx) => {
        const input = (ctx.input ?? {}) as Record<string, unknown>;
        const type = typeof input.type === "string" ? input.type : undefined;
        const chars = type ? da().characters.listByType(type) : da().characters.list();
        return { output: chars };
      },
    },

    // ── character.get ──
    {
      definition: {
        id: "character.get",
        kind: "query",
        schema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Character ID" },
            name: { type: "string", description: "Character name (partial match)" },
          },
        },
      },
      handler: async (ctx) => {
        const input = (ctx.input ?? {}) as Record<string, unknown>;
        const id = typeof input.id === "string" ? input.id : undefined;
        const name = typeof input.name === "string" ? input.name : undefined;
        const char = id ? da().characters.get(id) : name ? da().characters.findByName(name) : undefined;
        return { output: char ?? null };
      },
    },

    // ── event.recent ──
    {
      definition: {
        id: "event.recent",
        kind: "query",
        schema: {
          type: "object",
          properties: {
            limit: { type: "number", description: `Number of recent events (default ${DEFAULT_QUERY_LIMIT})` },
            eventType: { type: "string", description: "Filter by event type" },
          },
        },
      },
      handler: async (ctx) => {
        const input = (ctx.input ?? {}) as Record<string, unknown>;
        const limit = Math.min(typeof input.limit === "number" ? input.limit : DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
        const eventType = typeof input.eventType === "string" ? input.eventType : undefined;
        const events = eventType
          ? da().events.findByType(eventType, limit)
          : da().events.recent(limit);
        return { output: events };
      },
    },

    // ── state.patch (write) ──
    {
      definition: {
        id: "state.patch",
        kind: "mutate",
        schema: {
          type: "object",
          properties: {
            scope: { type: "string", description: "State scope to patch" },
            patch: { type: "object", description: "Key-value pairs to merge" },
          },
          required: ["scope", "patch"],
        },
      },
      handler: async (ctx) => {
        const input = ctx.input as Record<string, unknown> | undefined;
        const scope = typeof input?.scope === "string" ? input.scope : "";
        const patch = input?.patch && typeof input.patch === "object" ? input.patch as Record<string, unknown> : null;
        if (!scope || !patch) return { output: { error: "Missing required parameters: scope and patch" } };
        return {
          output: { ok: true, scope },
          proposals: [da().propose.statePatch(scope, patch)],
        };
      },
    },

    // ── record.upsert (write) ──
    {
      definition: {
        id: "record.upsert",
        kind: "mutate",
        schema: {
          type: "object",
          properties: {
            recordType: { type: "string", description: "Record type (e.g. 'character', 'quest')" },
            key: { type: "string", description: "Record key (unique identifier)" },
            fields: { type: "object", description: "Record fields to upsert" },
          },
          required: ["recordType", "key", "fields"],
        },
      },
      handler: async (ctx) => {
        const input = ctx.input as Record<string, unknown> | undefined;
        const recordType = typeof input?.recordType === "string" ? input.recordType : "";
        const key = typeof input?.key === "string" ? input.key : "";
        const fields = input?.fields && typeof input.fields === "object" ? input.fields as Record<string, unknown> : null;
        if (!recordType || !key || !fields) return { output: { error: "Missing required parameters: recordType, key, and fields" } };
        return {
          output: { ok: true, key },
          proposals: [da().propose.recordUpsert(recordType, key, fields)],
        };
      },
    },

    // ── event.emit (write) ──
    {
      definition: {
        id: "event.emit",
        kind: "emit",
        schema: {
          type: "object",
          properties: {
            eventType: { type: "string", description: "Event type identifier" },
            data: { type: "object", description: "Event data payload" },
          },
          required: ["eventType"],
        },
      },
      handler: async (ctx) => {
        const input = ctx.input as Record<string, unknown> | undefined;
        const eventType = typeof input?.eventType === "string" ? input.eventType : "";
        if (!eventType) return { output: { error: "Missing required parameter: eventType" } };
        const data = input?.data && typeof input.data === "object" ? input.data as Record<string, unknown> : undefined;
        return {
          output: { ok: true, eventType },
          proposals: [da().propose.eventEmit(eventType, data)],
        };
      },
    },

    // ── ui.render (write) ──
    {
      definition: {
        id: "ui.render",
        kind: "render",
        schema: {
          type: "object",
          properties: {
            blockType: { type: "string", description: "Block type (must match a registered block schema)" },
            data: { type: "object", description: "Block data conforming to blockSchema" },
            interactive: { type: "boolean", description: "Whether this block requires user response" },
          },
          required: ["blockType", "data"],
        },
      },
      handler: async (ctx) => {
        const input = ctx.input as Record<string, unknown> | undefined;
        const blockType = typeof input?.blockType === "string" ? input.blockType.trim() : "";
        if (!blockType || blockType.length > 64) {
          return { output: { error: "Invalid blockType" } };
        }
        const data = input?.data;
        const interactive = input?.interactive === true;
        return {
          output: { ok: true, blockType },
          proposals: [
            da().propose.uiRender(blockType, data, interactive ? { requiresResponse: true } : undefined),
          ],
        };
      },
    },
  ];
}
