/**
 * Public API for `@covel/lorebook`.
 *
 * Consumers (currently none in tree — the context-builder wiring ships in
 * S3-T5) build a `LorebookContext` once per session via one of the
 * factory functions, then call {@link LorebookContext.applyLorebook} every
 * turn with the current messages + budget.
 *
 * The registry is exposed for advanced integrations (plugin + session
 * layers in S3-T2) but most call sites should stick to the factories.
 */

import type { TokenEstimator } from "@covel/context";
import { loadWorldLorebook } from "./loader.js";
import { LorebookRegistry } from "./registry.js";
import { scanLorebook, type ScanMessage, type ScanResult } from "./scanner.js";
import type { LorebookEntry, LorebookPosition } from "./types.js";

// ── Re-exports ───────────────────────────────────────────────────
export type {
  LorebookEntry,
  LorebookEntryInput,
  LorebookFile,
  LorebookPosition,
  LorebookSelectiveLogic,
  LorebookSource,
  LorebookStrategy,
} from "./types.js";
export {
  LOREBOOK_POSITIONS,
  lorebookEntryInputSchema,
  lorebookFileSchema,
  normalizeEntry,
} from "./types.js";
export type { LoadLorebookOptions } from "./loader.js";
export { loadLorebookFromDir, loadWorldLorebook } from "./loader.js";
export { LorebookRegistry } from "./registry.js";
export type { ScanBudget, ScanMessage, ScanParams, ScanResult } from "./scanner.js";
export { scanLorebook } from "./scanner.js";

// ── LorebookContext (per-session facade) ────────────────────────

export interface ApplyLorebookParams {
  readonly messages: readonly ScanMessage[];
  readonly budget: {
    readonly maxTokens: number;
    readonly estimator: TokenEstimator;
  };
  /** Optional override for the default scan depth. */
  readonly defaultScanDepth?: number;
}

export interface ApplyLorebookResult {
  readonly entriesByPosition: Map<LorebookPosition, readonly LorebookEntry[]>;
  readonly totalTokens: number;
  readonly droppedIds: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Stateful per-session lorebook handle. Wraps a {@link LorebookRegistry}
 * and exposes just the surface S3-T5 needs to wire the engine into
 * `packages/context/src/context-builder.ts`.
 *
 * Keeping this interface minimal is deliberate: the full CRUD surface
 * (add/remove/list per-layer) sits on the underlying `registry` for
 * advanced callers, but the happy-path consumer only ever calls
 * {@link applyLorebook}.
 */
export interface LorebookContext {
  readonly registry: LorebookRegistry;
  applyLorebook(params: ApplyLorebookParams): ApplyLorebookResult;
}

function makeContextFromRegistry(registry: LorebookRegistry): LorebookContext {
  return {
    registry,
    applyLorebook(params: ApplyLorebookParams): ApplyLorebookResult {
      const merged = registry.getMerged();
      const result: ScanResult = scanLorebook({
        entries: merged,
        messages: params.messages,
        budget: params.budget,
        defaultScanDepth: params.defaultScanDepth,
      });
      return {
        entriesByPosition: result.entriesByPosition,
        totalTokens: result.totalTokens,
        droppedIds: result.droppedIds,
        warnings: result.warnings,
      };
    },
  };
}

/**
 * Build a {@link LorebookContext} seeded with the world-level entries
 * living under `<worldDir>/lorebook/*.yaml`. Worlds without a lorebook
 * directory yield an empty-but-usable context.
 */
export async function createLorebookFromWorld(
  worldDir: string,
): Promise<LorebookContext> {
  const registry = new LorebookRegistry();
  const entries = await loadWorldLorebook(worldDir);
  registry.setLayer("world", entries);
  return makeContextFromRegistry(registry);
}

/**
 * Build a {@link LorebookContext} from a pre-built registry. Useful for
 * tests and for call sites that compose the layers themselves (e.g. the
 * S3-T2 plugin + session loaders).
 */
export function createLorebookFromRegistry(
  registry: LorebookRegistry,
): LorebookContext {
  return makeContextFromRegistry(registry);
}
