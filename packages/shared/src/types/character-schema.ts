/**
 * Character Attribute Schema — defines per-world character attributes.
 *
 * Created by the `world-data-provider` plugin (core-world-init) during session
 * initialization. Consumed by:
 *   - core-char-creator: generates form fields matching attribute IDs
 *   - submit-inputs: merges default values into new characters
 *   - right panel: renders structured attribute display
 *   - narrator context: injects player attributes for narrative adaptation
 *
 * Stored in plugin_data: (sessionId, worldDataPluginId, 'schema', 'character-attributes')
 */

// ── Field types ─────────────────────────────────────────────────

export type AttributeFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'array';

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
