/**
 * UI component types for LLM-driven rendering.
 */

export type UIComponentType =
  | 'stat-bar'
  | 'card'
  | 'choice-list'
  | 'image'
  | 'table'
  | 'notification'
  | 'dialog'
  | 'inventory'
  | 'map-marker'
  | 'progress';

export interface UIRenderInstruction {
  readonly type: UIComponentType | string;
  readonly [key: string]: unknown;
}

/**
 * JSON Schema-based block schema declaration for plugin UI rendering.
 */
export interface BlockSchemaMeta {
  /** Human-readable display name (string or locale-keyed). */
  readonly displayName?: string | Record<string, string>;
  readonly [key: string]: unknown;
}

export interface BlockSchemaDeclaration {
  /** Block type identifier (matches UIComponentType or custom). */
  readonly blockType: string;
  /** Human-readable display name. */
  readonly displayName?: string;
  /** JSON Schema describing the block's data shape. */
  readonly dataSchema: {
    readonly type: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly [key: string]: unknown;
  };
  /** Whether the block accepts user input (form submission). */
  readonly interactive?: boolean;
  /** JSON Schema for form submission payload (interactive blocks). */
  readonly submitSchema?: {
    readonly type: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly [key: string]: unknown;
  };
  /** Block metadata (display name, description, etc.). */
  readonly meta: BlockSchemaMeta;
}
