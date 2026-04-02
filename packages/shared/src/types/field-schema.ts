/**
 * Dynamic field schema system.
 *
 * Plugins create field schemas at runtime (typically on session_start)
 * to define domain-specific "table columns" — e.g. character stats,
 * inventory item properties — that vary by world genre.
 *
 * The same pattern is reusable across character, inventory, and future plugins.
 */

export type FieldType = "number" | "string" | "boolean" | "enum" | "text";

export type FieldCategory = "stats" | "bio" | "equipment" | "social" | "custom";

export interface FieldDefinition {
  /** Machine key used in CharacterCard.fields, e.g. "hp", "mana". */
  key: string;
  /** Human-readable label (locale-aware). */
  label: string;
  /** Value type. */
  type: FieldType;
  /** Allowed values for enum type. */
  options?: string[];
  /** Default value for new records. */
  defaultValue?: unknown;
  /** Grouping category for UI rendering. */
  category?: FieldCategory;
  /** Whether to show in compact/collapsed view. */
  visible?: boolean;
  /** Minimum value (number type only). */
  min?: number;
  /** Maximum value (number type only). */
  max?: number;
}

export interface DynamicFieldSchema {
  /** Schema version, incremented on re-initialization. */
  version: number;
  /** World ID this schema was generated for. */
  worldId: string;
  /** Ordered field definitions (display order = array order). */
  fields: FieldDefinition[];
  /** ISO timestamp of creation. */
  createdAt: string;
}
