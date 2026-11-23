import {
  estimateTokens,
  type PromptSegment,
  type RuntimeManifest,
} from "@covel/shared";
import {
  DEFAULT_PROMPT_SEGMENT_BUDGET,
  PROTECTED_PROMPT_BLOCKS,
  SUPPRESSIBLE_PROMPT_BLOCKS,
  type PromptFactValue,
  type PromptSegmentGovernanceDiagnostic,
  type PromptWhen,
  type PromptWhenClause,
  type SuppressiblePromptBlock,
} from "@covel/shared/platform";
import type { TokenEstimator } from "./budget.js";

const TRUNCATION_SUFFIX = "\n...[truncated to budget]";
const promptPriority = { high: 0, normal: 1, low: 2 } as const;
const PROTECTED_BLOCK_SET: ReadonlySet<string> = new Set(
  PROTECTED_PROMPT_BLOCKS,
);
const SUPPRESSIBLE_BLOCK_SET: ReadonlySet<string> = new Set(
  SUPPRESSIBLE_PROMPT_BLOCKS,
);

function evaluateClause(
  clause: PromptWhenClause,
  facts: Readonly<Record<string, PromptFactValue>>,
): boolean {
  const hasFact = Object.hasOwn(facts, clause.fact);
  const current = hasFact ? facts[clause.fact] : undefined;
  if (clause.exists !== undefined && clause.exists !== hasFact) {
    return false;
  }
  if (clause.equals !== undefined && (!hasFact || current !== clause.equals)) {
    return false;
  }
  if (
    clause.notEquals !== undefined &&
    hasFact &&
    current === clause.notEquals
  ) {
    return false;
  }
  if (
    clause.in !== undefined &&
    (!hasFact || current === undefined || !clause.in.includes(current))
  ) {
    return false;
  }
  return true;
}

/** Evaluate a `when` fact predicate against the active Facts Registry. */
export function evaluatePromptWhen(
  when: PromptWhen | undefined,
  facts: Readonly<Record<string, PromptFactValue>>,
): boolean {
  if (!when) return true;
  if ("all" in when) {
    return when.all.every((clause) => evaluateClause(clause, facts));
  }
  if ("any" in when) {
    return when.any.some((clause) => evaluateClause(clause, facts));
  }
  return evaluateClause(when, facts);
}

function safeSlice(text: string, end: number): string {
  if (end <= 0) return "";
  if (end >= text.length) return text;
  const code = text.charCodeAt(end);
  const prev = text.charCodeAt(end - 1);
  // Avoid cutting between a high surrogate (0xD800..0xDBFF) and low surrogate (0xDC00..0xDFFF).
  const adjusted =
    code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff
      ? end - 1
      : end;
  return text.slice(0, adjusted);
}

/**
 * Truncate content cleanly at a UTF-16 codepoint boundary so its estimated
 * token count never exceeds `budget`.
 */
export function truncateContentToBudget(
  content: string,
  budget: number,
  estimator: TokenEstimator = estimateTokens,
): {
  readonly content: string;
  readonly truncated: boolean;
  readonly originalTokens: number;
  readonly finalTokens: number;
} {
  const originalTokens = estimator(content);
  if (budget <= 0) {
    return {
      content: "",
      truncated: content.length > 0,
      originalTokens,
      finalTokens: 0,
    };
  }
  if (originalTokens <= budget) {
    return {
      content,
      truncated: false,
      originalTokens,
      finalTokens: originalTokens,
    };
  }
  const suffix =
    estimator(TRUNCATION_SUFFIX) <= budget ? TRUNCATION_SUFFIX : "";
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = safeSlice(content, mid) + suffix;
    if (estimator(candidate) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const finalContent = safeSlice(content, low) + suffix;
  return {
    content: finalContent,
    truncated: true,
    originalTokens,
    finalTokens: estimator(finalContent),
  };
}

function matchesAudience(
  segment: PromptSegment,
  manifest: RuntimeManifest,
): boolean {
  const audience = segment.audience;
  if (audience === "all") return true;
  if (audience === "self")
    return segment.providerPluginId === manifest.pluginId;
  if (audience === "story") return manifest.outputKind === "story";
  return manifest.outputContract === audience.contract;
}

export interface PromptGovernanceOptions {
  readonly defaultBudget?: number;
  readonly initialFacts?: Readonly<Record<string, PromptFactValue>>;
  readonly estimator?: TokenEstimator;
}

export interface PromptGovernanceResult {
  readonly segments: readonly PromptSegment[];
  readonly facts: Readonly<Record<string, PromptFactValue>>;
  readonly suppressedBlocks: ReadonlySet<SuppressiblePromptBlock>;
  readonly diagnostics: readonly PromptSegmentGovernanceDiagnostic[];
}

function resolvePromptFacts(
  sorted: readonly PromptSegment[],
  initialFacts: Readonly<Record<string, PromptFactValue>> | undefined,
): Record<string, PromptFactValue> {
  const facts: Record<string, PromptFactValue> = { ...initialFacts };
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const segment of sorted) {
      if (!segment.facts || !evaluatePromptWhen(segment.when, facts)) continue;
      for (const [key, value] of Object.entries(segment.facts)) {
        if (facts[key] !== value) {
          facts[key] = value;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return facts;
}

function applySegmentSuppressions(
  candidates: readonly PromptSegment[],
  diagnostics: PromptSegmentGovernanceDiagnostic[],
): {
  readonly suppressedBlocks: Set<SuppressiblePromptBlock>;
  readonly suppressedIndices: Set<number>;
} {
  const suppressedBlocks = new Set<SuppressiblePromptBlock>();
  const suppressedIndices = new Set<number>();
  const targetsByKey = new Map<string, number[]>();

  const registerTargetKey = (key: string, index: number): void => {
    const existing = targetsByKey.get(key);
    if (existing) existing.push(index);
    else targetsByKey.set(key, [index]);
  };

  for (const [index, candidate] of candidates.entries()) {
    registerTargetKey(candidate.id, index);
    if (candidate.providerPluginId) {
      const qualified = `${candidate.providerPluginId}/${candidate.id}`;
      if (qualified !== candidate.id) registerTargetKey(qualified, index);
    }
  }

  const recordProtectedIgnored = (
    pluginId: string,
    segmentId: string,
    targetId: string,
  ): void => {
    diagnostics.push({
      kind: "protected-suppress-ignored",
      pluginId,
      segmentId,
      targetId,
    });
  };

  for (const [sourceIdx, source] of candidates.entries()) {
    const sourcePluginId = source.providerPluginId ?? "";
    for (const targetId of source.suppresses ?? []) {
      if (PROTECTED_BLOCK_SET.has(targetId)) {
        recordProtectedIgnored(sourcePluginId, source.id, targetId);
        continue;
      }
      if (SUPPRESSIBLE_BLOCK_SET.has(targetId)) {
        suppressedBlocks.add(targetId as SuppressiblePromptBlock);
        continue;
      }
      for (const targetIdx of targetsByKey.get(targetId) ?? []) {
        if (targetIdx === sourceIdx) continue;
        if (candidates[targetIdx]?.protected === true) {
          recordProtectedIgnored(sourcePluginId, source.id, targetId);
        } else {
          suppressedIndices.add(targetIdx);
        }
      }
    }
  }

  return { suppressedBlocks, suppressedIndices };
}

function enforceSegmentBudgets(
  candidates: readonly PromptSegment[],
  suppressedIndices: ReadonlySet<number>,
  options: PromptGovernanceOptions | undefined,
  diagnostics: PromptSegmentGovernanceDiagnostic[],
): PromptSegment[] {
  const defaultBudget = options?.defaultBudget ?? DEFAULT_PROMPT_SEGMENT_BUDGET;
  const estimator = options?.estimator ?? estimateTokens;
  const governed: PromptSegment[] = [];
  for (const [index, segment] of candidates.entries()) {
    if (suppressedIndices.has(index)) continue;
    const cap = segment.budget ?? defaultBudget;
    const truncated = truncateContentToBudget(segment.content, cap, estimator);
    if (truncated.truncated) {
      diagnostics.push({
        kind: "truncated",
        pluginId: segment.providerPluginId ?? "",
        segmentId: segment.id,
        budget: cap,
        originalTokens: truncated.originalTokens,
        finalTokens: truncated.finalTokens,
      });
    }
    governed.push(
      truncated.truncated
        ? { ...segment, content: truncated.content }
        : segment,
    );
  }
  return governed;
}

/**
 * Deterministically sort, resolve cross-plugin Facts, apply `when` &
 * `suppresses` (respecting protected blocks & segments), and enforce per-segment
 * hard token budgets.
 */
export function governPromptSegments(
  segments: readonly PromptSegment[] | undefined,
  manifest: RuntimeManifest,
  options?: PromptGovernanceOptions,
): PromptGovernanceResult {
  // Volatility ordering: stable segments appear before session segments, which appear before turn segments.
  // This hardcoded map is the authoritative volatility ordering used during prompt assembly.
  // See: docs/reference/extension-points.md for the volatility contract.
  const volatility = { stable: 0, session: 1, turn: 2 };
  const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...(segments ?? [])].sort(
    (a, b) =>
      volatility[a.volatility] - volatility[b.volatility] ||
      promptPriority[a.priority ?? "normal"] -
        promptPriority[b.priority ?? "normal"] ||
      (a.order ?? 0) - (b.order ?? 0) ||
      codeUnit(a.providerPluginId ?? "", b.providerPluginId ?? "") ||
      codeUnit(a.id, b.id),
  );

  const facts = resolvePromptFacts(sorted, options?.initialFacts);
  const candidates = sorted.filter(
    (segment) =>
      matchesAudience(segment, manifest) &&
      evaluatePromptWhen(segment.when, facts),
  );
  const diagnostics: PromptSegmentGovernanceDiagnostic[] = [];
  const { suppressedBlocks, suppressedIndices } = applySegmentSuppressions(
    candidates,
    diagnostics,
  );
  const governed = enforceSegmentBudgets(
    candidates,
    suppressedIndices,
    options,
    diagnostics,
  );

  return {
    segments: governed,
    facts,
    suppressedBlocks,
    diagnostics,
  };
}

/** Stable kernel attribution is attached by the extension host, never by plugins. */
export function selectPromptSegments(
  segments: readonly PromptSegment[] | undefined,
  manifest: RuntimeManifest,
): readonly PromptSegment[] {
  return governPromptSegments(segments, manifest).segments;
}
