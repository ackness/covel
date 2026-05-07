/**
 * State management types: dynamic tables, change history, schemas.
 */

// ── State change entry ───────────────────────────────────────────

export interface StateChangeEntry {
  readonly value: unknown;
  /** Format: `pluginId/runtimeId` */
  readonly changedBy: string;
  readonly turnId: string;
  readonly reason?: string;
  readonly timestamp: string;
}

// ── State field (current value + history) ────────────────────────

export interface StateField {
  readonly table: string;
  readonly field: string;
  readonly currentValue: unknown;
  readonly changeLog: readonly StateChangeEntry[];
}

// ── State table schema ───────────────────────────────────────────

export type StateFieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface StateFieldDef {
  readonly name: string;
  readonly type: StateFieldType;
  readonly default?: unknown;
}

export interface StateTableSchema {
  readonly name: string;
  readonly fields: readonly StateFieldDef[];
}
