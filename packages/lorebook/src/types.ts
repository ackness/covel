/**
 * Lorebook data model + Zod schemas.
 *
 * Matches the A3 / A4 decisions in `devs/docs/insights/covel-improvement-plan.md`:
 *
 * - Three-layer ownership: world / plugin / session (P1 ships world only;
 *   plugin + session arrive in S3-T2).
 * - `strategy` is intentionally a closed enum of `'constant' | 'selective'`.
 *   `vectorized` is NOT in the schema (A4 — schema-as-contract; vectorized
 *   arrives in Sprint 5 with pgvector, see roadmap S5-T3).
 * - All other fields from the A3 interface are preserved so world authors
 *   can write forward-compatible YAML today even though the MVP engine
 *   only honors a subset.
 *
 * Deferred in S3-T1 (each is its own future ticket):
 * - `probability` triggering (currently informational only).
 * - `stickyTurns` / `cooldownTurns` / `delayTurns` — runtime state lives in
 *   `plugin_data.__lorebook_state__` but the scanner ignores them for now.
 * - `inclusionGroup` + `groupWeight` dedup.
 * - `secondaryKeys` scanning.
 * - Recursive scanning (`maxRecursionSteps`).
 * - `not_any` / `not_all` selective logic — throws a clear error in the
 *   scanner, see {@link scanner.ts}.
 */

import { z } from "zod";

/**
 * The segment slots defined in A2 of the improvement plan. These are the
 * 10 logical positions the final prompt assembler (S3-T5) will route
 * lorebook entries into. Entries whose target position isn't yet wired
 * into the assembler still participate in scanning and budget; it's the
 * assembler's job to decide what to do with unknown positions.
 *
 * `at_depth:N` is spelled as the pattern literal `"at_depth"` here and an
 * optional numeric `atDepth` field is added to entries that want it.
 */
export type LorebookPosition =
  | "before_char_defs"
  | "after_char_defs"
  | "before_examples"
  | "after_examples"
  | "author_note_top"
  | "author_note_bottom"
  | "at_depth";

export const LOREBOOK_POSITIONS: readonly LorebookPosition[] = [
  "before_char_defs",
  "after_char_defs",
  "before_examples",
  "after_examples",
  "author_note_top",
  "author_note_bottom",
  "at_depth",
] as const;

export type LorebookStrategy = "constant" | "selective";

export type LorebookSelectiveLogic =
  | "and_any"
  | "and_all"
  | "not_any"
  | "not_all";

export type LorebookSource = "world" | "plugin" | "session";

/** The full A3 entry interface. */
export interface LorebookEntry {
  readonly id: string;
  readonly source: LorebookSource;
  /** Only meaningful when `source === 'plugin'` or for session entries proxied through a plugin. */
  readonly pluginId?: string;
  readonly keys: readonly string[];
  readonly secondaryKeys?: readonly string[];
  readonly selectiveLogic: LorebookSelectiveLogic;
  readonly content: string;
  readonly strategy: LorebookStrategy;
  readonly position: LorebookPosition;
  /** Only used when `position === 'at_depth'`. */
  readonly atDepth?: number;
  readonly insertionOrder: number;
  readonly budgetCap?: number;
  readonly probability?: number;
  readonly scanDepth?: number;
  readonly stickyTurns?: number;
  readonly cooldownTurns?: number;
  readonly delayTurns?: number;
  readonly enabled: boolean;
  readonly inclusionGroup?: string;
  readonly groupWeight?: number;
}

const positionSchema = z.enum([
  "before_char_defs",
  "after_char_defs",
  "before_examples",
  "after_examples",
  "author_note_top",
  "author_note_bottom",
  "at_depth",
]);

const strategySchema = z.enum(["constant", "selective"]);

const selectiveLogicSchema = z.enum([
  "and_any",
  "and_all",
  "not_any",
  "not_all",
]);

const sourceSchema = z.enum(["world", "plugin", "session"]);

/**
 * Zod schema for a raw entry as it appears in YAML. Defaults are filled in
 * by the loader/registry, so most fields are optional here.
 */
export const lorebookEntryInputSchema = z
  .object({
    id: z.string().min(1),
    source: sourceSchema.optional(),
    pluginId: z.string().min(1).optional(),
    keys: z.array(z.string().min(1)).default([]),
    secondaryKeys: z.array(z.string().min(1)).optional(),
    selectiveLogic: selectiveLogicSchema.default("and_any"),
    content: z.string().min(1),
    strategy: strategySchema,
    position: positionSchema.default("after_char_defs"),
    atDepth: z.number().int().nonnegative().optional(),
    insertionOrder: z.number().int().default(100),
    budgetCap: z.number().int().positive().optional(),
    probability: z.number().min(0).max(1).optional(),
    scanDepth: z.number().int().positive().optional(),
    stickyTurns: z.number().int().nonnegative().optional(),
    cooldownTurns: z.number().int().nonnegative().optional(),
    delayTurns: z.number().int().nonnegative().optional(),
    enabled: z.boolean().default(true),
    inclusionGroup: z.string().optional(),
    groupWeight: z.number().nonnegative().optional(),
  })
  .strict();

export type LorebookEntryInput = z.infer<typeof lorebookEntryInputSchema>;

/** Schema for a single YAML file — an object with an `entries` array. */
export const lorebookFileSchema = z
  .object({
    entries: z.array(lorebookEntryInputSchema).default([]),
  })
  .strict();

export type LorebookFile = z.infer<typeof lorebookFileSchema>;

/**
 * Normalize a parsed input to a fully-populated entry. Fills the `source`
 * and (optionally) `pluginId` from the caller, since YAML files typically
 * do not spell those out.
 */
export function normalizeEntry(
  input: LorebookEntryInput,
  defaults: { source: LorebookSource; pluginId?: string },
): LorebookEntry {
  return {
    id: input.id,
    source: input.source ?? defaults.source,
    pluginId: input.pluginId ?? defaults.pluginId,
    keys: input.keys,
    secondaryKeys: input.secondaryKeys,
    selectiveLogic: input.selectiveLogic,
    content: input.content,
    strategy: input.strategy,
    position: input.position,
    atDepth: input.atDepth,
    insertionOrder: input.insertionOrder,
    budgetCap: input.budgetCap,
    probability: input.probability,
    scanDepth: input.scanDepth,
    stickyTurns: input.stickyTurns,
    cooldownTurns: input.cooldownTurns,
    delayTurns: input.delayTurns,
    enabled: input.enabled,
    inclusionGroup: input.inclusionGroup,
    groupWeight: input.groupWeight,
  };
}
