/**
 * Character Attribute Schema — defines per-world character attributes.
 *
 * Created by the `world-data-provider` plugin (world-init) during session
 * initialization. Consumed by:
 *   - char-creator: generates form fields matching attribute IDs
 *   - submit-inputs: merges default values into new characters
 *   - right panel: renders structured attribute display
 *   - narrator context: injects player attributes for narrative adaptation
 *
 * Stored in plugin_data: (sessionId, worldDataPluginId, 'schema', 'character-attributes')
 */

// ── Field types ─────────────────────────────────────────────────

/**
 * Primitive + structured field types.
 *
 * - `'object'` — fixed-shape nested record; requires `subSchema` that lists
 *   the child attributes (e.g. an `equipment` attribute with weapon/armor
 *   children). Acts like a scoped mini-schema.
 * - `'map'` — open-key record of a single value type (e.g. a
 *   `relationships` attribute keyed by character name, with string values
 *   describing the bond). Keys are free-form, values are typed via
 *   `valueType`.
 */
export type AttributeFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object'
  | 'map';

export type AttributeCategory = 'stats' | 'bio' | 'abilities' | 'equipment' | 'social';

// ── Single attribute definition ─────────────────────────────────

export interface AttributeDefinition {
  /** Machine key used in CharacterRecord.fields, e.g. "hp", "lingGen". */
  readonly id: string;
  /** Human-readable display name (locale-aware). */
  readonly name: string;
  /** Value type. */
  readonly type: AttributeFieldType;
  /** Minimum value (number type). */
  readonly min?: number;
  /** Maximum value (number type). */
  readonly max?: number;
  /** Default value for new characters. */
  readonly defaultValue?: unknown;
  /** Array element type (array type). */
  readonly itemType?: 'string' | 'number';
  /** Allowed values (enum type). */
  readonly options?: readonly string[];
  /**
   * Nested attribute definitions (object type). Acts as a scoped mini-schema
   * describing the object's required child keys.
   */
  readonly subSchema?: readonly AttributeDefinition[];
  /**
   * Element value type for free-key records (map type). When omitted, values
   * default to strings.
   */
  readonly valueType?: 'string' | 'number' | 'boolean';
  /** Grouping category for UI rendering and context organization. */
  readonly category: AttributeCategory;
  /** Optional description of this attribute. */
  readonly description?: string;
}

// ── Full schema ─────────────────────────────────────────────────

export interface CharacterAttributeSchema {
  /** Schema version, incremented on re-initialization. */
  readonly version: number;
  /** Ordered attribute definitions (display order = array order). */
  readonly attributes: readonly AttributeDefinition[];
}

// ── Wire-format Character ───────────────────────────────────────

/**
 * Wire-format `Character` — the contract returned by
 * `/api/sessions/:id/characters`. Mirrors the server's `CharacterRecord`
 * but lives in `@covel/shared` so it can be consumed by the web frontend
 * (and any future API client) without importing `@covel/store`.
 */
export interface Character {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
