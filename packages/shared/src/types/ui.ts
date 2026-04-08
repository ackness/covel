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
