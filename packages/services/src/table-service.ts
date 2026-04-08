import type {
  TableService,
  TableQueryInput,
  TableWriteInput,
  TableWriteResult,
  TableSchemaPatchInput,
  TableSchemaPatchResult,
} from "./types.js";

interface TableEntry {
  key: string;
  data: unknown;
  version: number;
}

interface TableState {
  owner: string;
  schema: Record<string, unknown>;
  schemaHistory: Array<{ schema: Record<string, unknown>; changedBy: string; timestamp: string }>;
  entries: Map<string, TableEntry>;
  history: Array<{ key: string; data: unknown; version: number; timestamp: string }>;
}

function matchesTablePattern(tableName: string, pattern: string): boolean {
  if (pattern === tableName) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return tableName === prefix || tableName.startsWith(`${prefix}.`);
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompatibleSchemaPatch(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  for (const [key, nextValue] of Object.entries(patch)) {
    const previousValue = previous[key];
    if (previousValue === undefined) continue;

    if (isPlainObject(previousValue) && isPlainObject(nextValue)) {
      if (!isCompatibleSchemaPatch(previousValue, nextValue)) return false;
      continue;
    }

    if (JSON.stringify(previousValue) !== JSON.stringify(nextValue)) {
      return false;
    }
  }
  return true;
}

/**
 * In-memory live state tables.
 */
export function createTableService(): TableService & {
  /** Register a table with an owner (called during pre-game). */
  createTable(tableName: string, owner: string, schema?: Record<string, unknown>): void;
  /** Get table owner (for testing). */
  getOwner(tableName: string): string | undefined;
} {
  const tables = new Map<string, TableState>();
  let versionCounter = 0;

  function createTable(tableName: string, owner: string, schema?: Record<string, unknown>): void {
    if (tables.has(tableName)) {
      throw new Error(`Table "${tableName}" already exists.`);
    }
    tables.set(tableName, {
      owner,
      schema: schema ?? {},
      schemaHistory: [],
      entries: new Map(),
      history: [],
    });
  }

  function getOwner(tableName: string): string | undefined {
    return tables.get(tableName)?.owner;
  }

  async function query(input: TableQueryInput): Promise<unknown> {
    const table = tables.get(input.table);
    if (!table) return null;

    if (input.callerPluginId && input.allowedPatterns) {
      const allowed = input.allowedPatterns.some((pattern) => matchesTablePattern(input.table, pattern));
      if (!allowed) {
        return {
          error: `Plugin "${input.callerPluginId}" cannot read table "${input.table}".`,
        };
      }
    }

    switch (input.mode) {
      case "latest": {
        const entries = Array.from(table.entries.values()).map((e) => ({
          key: e.key,
          data: e.data,
        }));
        if (input.filters) {
          return entries.filter((e) => {
            if (typeof e.data !== "object" || e.data === null) return false;
            for (const [k, v] of Object.entries(input.filters!)) {
              if ((e.data as Record<string, unknown>)[k] !== v) return false;
            }
            return true;
          }).slice(0, input.limit ?? 100);
        }
        return entries.slice(0, input.limit ?? 100);
      }
      case "history":
        return table.history.slice(-(input.limit ?? 50));
      case "diff":
        return table.history;
    }
  }

  async function write(input: TableWriteInput): Promise<TableWriteResult> {
    const table = tables.get(input.table);
    if (!table) return { success: false, version: "", error: `Table "${input.table}" not found.` };

    // Ownership check
    if (table.owner !== input.callerPluginId) {
      return {
        success: false,
        version: "",
        error: `Plugin "${input.callerPluginId}" cannot write to table "${input.table}" owned by "${table.owner}".`,
      };
    }

    versionCounter++;
    const version = String(versionCounter);
    const timestamp = new Date().toISOString();

    switch (input.action) {
      case "insert":
      case "upsert":
        table.entries.set(input.key, { key: input.key, data: input.data, version: versionCounter });
        table.history.push({ key: input.key, data: input.data, version: versionCounter, timestamp });
        break;
      case "update": {
        if (!table.entries.has(input.key)) {
          return { success: false, version: "", error: `Key "${input.key}" not found.` };
        }
        table.entries.set(input.key, { key: input.key, data: input.data, version: versionCounter });
        table.history.push({ key: input.key, data: input.data, version: versionCounter, timestamp });
        break;
      }
      case "delete": {
        table.entries.delete(input.key);
        table.history.push({ key: input.key, data: null, version: versionCounter, timestamp });
        break;
      }
    }

    return { success: true, version };
  }

  async function patchSchema(input: TableSchemaPatchInput): Promise<TableSchemaPatchResult> {
    const table = tables.get(input.table);
    if (!table) return { success: false, error: `Table "${input.table}" not found.` };

    if (table.owner !== input.callerPluginId) {
      return { success: false, error: `Only the table owner can modify schema.` };
    }

    const previousSchema = { ...table.schema };
    if (!isCompatibleSchemaPatch(previousSchema, input.patch)) {
      return { success: false, error: "Incompatible schema change rejected." };
    }
    const newSchema = { ...table.schema, ...input.patch };

    table.schemaHistory.push({
      schema: previousSchema,
      changedBy: `${input.callerPluginId}:${input.callerRuntimeId}:${input.runId}`,
      timestamp: new Date().toISOString(),
    });
    table.schema = newSchema;

    return { success: true, previousSchema, newSchema };
  }

  return { query, write, patchSchema, createTable, getOwner };
}
