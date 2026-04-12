/**
 * Lorebook scanning + budget allocation.
 *
 * MVP scope (see module header of `types.ts`):
 * - `constant` entries are always included (budget-permitting).
 * - `selective` entries are matched with case-insensitive substring
 *   checks against the last `scanDepth` messages (default 3). No regex,
 *   no word boundaries, no escaping.
 * - Supported `selectiveLogic`: `and_any`, `and_all`. `not_any` / `not_all`
 *   throw a clear "not implemented in MVP" error.
 * - Budget follows NovelAI-style Reserved Tokens: constants first, then
 *   selectives by `insertionOrder` descending (higher = more weight =
 *   closer to prompt end, the same orientation as SillyTavern's WI panel).
 * - Entries are grouped into position buckets for the assembler to
 *   consume.
 *
 * Deferred in S3-T1:
 * - recursive scanning (`maxRecursionSteps`) — TODO: next pass
 * - sticky / cooldown / delay — see plan A3 step 6
 * - inclusionGroup / groupWeight dedup — TODO
 * - probability rolling — TODO
 * - secondaryKeys — TODO
 */

import type { TokenEstimator } from "@covel/context";
import type {
  LorebookEntry,
  LorebookPosition,
  LorebookSelectiveLogic,
} from "./types.js";

/** Minimal message shape the scanner needs. */
export interface ScanMessage {
  readonly role: string;
  readonly content: string;
}

export interface ScanBudget {
  /** Hard upper bound on total tokens the lorebook may consume. */
  readonly maxTokens: number;
  readonly estimator: TokenEstimator;
}

export interface ScanParams {
  readonly entries: readonly LorebookEntry[];
  readonly messages: readonly ScanMessage[];
  readonly budget: ScanBudget;
  /**
   * Default scan depth when an individual entry does not set its own.
   * Matches the common SillyTavern default of 3.
   */
  readonly defaultScanDepth?: number;
}

export interface ScanResult {
  /** Entries grouped by their target position, in insertion order (ascending). */
  readonly entriesByPosition: Map<LorebookPosition, readonly LorebookEntry[]>;
  /** Sum of the estimator's token counts for every accepted entry's `content`. */
  readonly totalTokens: number;
  /** IDs of entries that were dropped because the budget was exhausted. */
  readonly droppedIds: readonly string[];
  /**
   * Non-fatal warnings surfaced during scanning. At MVP this is only the
   * "constant entry truncated because it alone overflowed the budget" case.
   */
  readonly warnings: readonly string[];
}

const DEFAULT_SCAN_DEPTH = 3;

function tokensFor(entry: LorebookEntry, estimator: TokenEstimator): number {
  return estimator(entry.content);
}

/**
 * Case-insensitive substring match. Intentionally dumb — no word boundaries,
 * no regex, no unicode normalization. This is the stated MVP contract.
 */
function hasKey(text: string, key: string): boolean {
  if (key.length === 0) {
    return false;
  }
  return text.toLowerCase().includes(key.toLowerCase());
}

function evaluateSelective(
  keys: readonly string[],
  logic: LorebookSelectiveLogic,
  haystack: string,
): boolean {
  if (keys.length === 0) {
    return false;
  }

  switch (logic) {
    case "and_any":
      return keys.some(k => hasKey(haystack, k));
    case "and_all":
      return keys.every(k => hasKey(haystack, k));
    case "not_any":
    case "not_all":
      throw new Error(
        `[lorebook] selectiveLogic '${logic}' is not implemented in the S3-T1 MVP. ` +
          "Only 'and_any' and 'and_all' are supported. Track this in a future ticket.",
      );
  }
}

/**
 * Flatten the last `depth` messages into a single lowercase haystack.
 * This is cheap and good enough for substring scanning.
 */
function buildHaystack(
  messages: readonly ScanMessage[],
  depth: number,
): string {
  if (depth <= 0 || messages.length === 0) {
    return "";
  }
  const start = Math.max(0, messages.length - depth);
  let out = "";
  for (let i = start; i < messages.length; i++) {
    out += messages[i]!.content + "\n";
  }
  return out;
}

interface Candidate {
  readonly entry: LorebookEntry;
  readonly tokens: number;
}

function groupByPosition(
  accepted: readonly LorebookEntry[],
): Map<LorebookPosition, readonly LorebookEntry[]> {
  const byPosition = new Map<LorebookPosition, LorebookEntry[]>();
  // Within a bucket we keep ascending insertionOrder (lower = earlier).
  const sorted = [...accepted].sort(
    (a, b) => a.insertionOrder - b.insertionOrder,
  );
  for (const entry of sorted) {
    const bucket = byPosition.get(entry.position) ?? [];
    bucket.push(entry);
    byPosition.set(entry.position, bucket);
  }
  return byPosition;
}

/**
 * Allocate lorebook entries against the given budget.
 *
 * Algorithm (borrowed from NovelAI's Reserved Tokens model):
 * 1. Reserve tokens for every enabled `constant` entry, in insertionOrder
 *    ascending order. If a single constant overflows the remaining budget
 *    it is dropped with a warning — we never partially truncate content
 *    at MVP (clean semantics beat best-effort truncation).
 * 2. Scan for `selective` candidates by matching keys against the last
 *    `scanDepth` messages. Selective entries matching the MVP logic are
 *    queued; non-matches are ignored.
 * 3. Fill selectives in descending `insertionOrder` (higher weight first),
 *    stopping as soon as the next entry won't fit.
 * 4. Group the accepted set by position.
 */
export function scanLorebook(params: ScanParams): ScanResult {
  const {
    entries,
    messages,
    budget: { maxTokens, estimator },
    defaultScanDepth = DEFAULT_SCAN_DEPTH,
  } = params;

  const warnings: string[] = [];
  const droppedIds: string[] = [];
  const accepted: LorebookEntry[] = [];
  let totalTokens = 0;

  const isEnabled = (e: LorebookEntry): boolean => e.enabled !== false;

  // Step 1 — constants.
  const constants = entries
    .filter(e => isEnabled(e) && e.strategy === "constant")
    .sort((a, b) => a.insertionOrder - b.insertionOrder);

  for (const entry of constants) {
    const tokens = tokensFor(entry, estimator);
    if (totalTokens + tokens > maxTokens) {
      warnings.push(
        `constant entry '${entry.id}' dropped: adding ${tokens} tokens would exceed lorebook budget of ${maxTokens}`,
      );
      droppedIds.push(entry.id);
      continue;
    }
    accepted.push(entry);
    totalTokens += tokens;
  }

  // Step 2 — selective candidates.
  //
  // Build a per-depth cache. Most entries will share the same depth, so
  // we memoize by depth value.
  const haystackCache = new Map<number, string>();
  const getHaystack = (depth: number): string => {
    const cached = haystackCache.get(depth);
    if (cached !== undefined) {
      return cached;
    }
    const fresh = buildHaystack(messages, depth);
    haystackCache.set(depth, fresh);
    return fresh;
  };

  const selectiveCandidates: Candidate[] = [];
  const selectives = entries.filter(
    e => isEnabled(e) && e.strategy === "selective",
  );

  for (const entry of selectives) {
    const depth = entry.scanDepth ?? defaultScanDepth;
    const haystack = getHaystack(depth);
    if (!evaluateSelective(entry.keys, entry.selectiveLogic, haystack)) {
      continue;
    }
    selectiveCandidates.push({
      entry,
      tokens: tokensFor(entry, estimator),
    });
  }

  // Step 3 — fill by insertionOrder descending. Higher insertionOrder =
  // higher weight (placed closer to prompt end), so we admit them first.
  selectiveCandidates.sort(
    (a, b) => b.entry.insertionOrder - a.entry.insertionOrder,
  );

  for (const candidate of selectiveCandidates) {
    if (totalTokens + candidate.tokens > maxTokens) {
      droppedIds.push(candidate.entry.id);
      continue;
    }
    accepted.push(candidate.entry);
    totalTokens += candidate.tokens;
  }

  // Step 4 — bucket by position.
  const entriesByPosition = groupByPosition(accepted);

  return {
    entriesByPosition,
    totalTokens,
    droppedIds,
    warnings,
  };
}
