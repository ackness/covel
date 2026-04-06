import type { SlotTag } from "@covel/shared";

/**
 * Maps qualified runtime ID ("pluginId:runtimeId") to a slot name.
 * Configured by the player before/during a game session.
 */
export type RuntimeBindingMap = Record<string, string>;

/**
 * Result of resolving a runtime's model binding.
 */
export interface BindingResolution {
  /** The preset ID to use for LLM calls. */
  presetId: string;
  /** The slot name that was bound. */
  slotName: string;
}

/**
 * Info about a runtime that needs a model binding.
 */
export interface RuntimeBindingInfo {
  /** Qualified ID: "pluginId:runtimeId" */
  qualifiedId: string;
  /** Display name for UI */
  displayName?: string;
  /** Required model tag */
  providerTag: SlotTag;
}
