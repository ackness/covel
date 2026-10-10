/**
 * Which reasoning levels a model accepts.
 *
 * The answer is data: `reasoning-models.data.json` lists, per provider
 * family, the model name patterns and the levels each one takes. The model
 * table (LiteLLM) only says whether a model reasons at all, so this file is
 * maintained by hand and is not touched by the weekly table refresh. A host
 * can add entries at run time with `setReasoningModelOverrides`.
 *
 * How a level is written into a request is not here: each protocol's wire in
 * `reasoning-effort.ts` does that from the resolved controls.
 */

import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@covel/shared";
import { z } from "zod";

import type { ModelFeature, ProviderProtocol } from "../types.js";
import bundledData from "./reasoning-models.data.json" with { type: "json" };

export const REASONING_PROVIDER_FAMILIES = [
  "openai",
  "anthropic",
  "deepseek",
  "google",
  "xai",
  "qwen",
  "compatible",
] as const;

export type ReasoningProviderFamily =
  (typeof REASONING_PROVIDER_FAMILIES)[number];

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  /** Application budget preset, not a native effort level. */
  thinkingBudgetTokens?: number;
}

/** Provider/model-specific reasoning controls exposed to the settings UI. */
export interface ReasoningEffortProfile {
  family: ReasoningProviderFamily;
  options: ReasoningEffortOption[];
  /** Documented provider default. Omitted when it varies by model. */
  defaultValue?: ReasoningEffort;
}

/**
 * How a family writes a level when it has more than one way:
 * `adaptive` is Anthropic adaptive thinking next to the effort, and `effort`
 * is Qwen's `reasoning_effort` next to its thinking switch.
 */
export type ReasoningParameterStyle = "adaptive" | "effort";

/** What is known of one model on one protocol. */
export interface ReasoningControls {
  family: ReasoningProviderFamily;
  /** `null`: the model is not known to take a reasoning level. */
  profile: ReasoningEffortProfile | null;
  parameterStyle?: ReasoningParameterStyle;
  /** The model cannot turn thinking off. */
  thinkingAlwaysOn: boolean;
}

// ── File format ──────────────────────────────────────────────────

const pattern = z.string().min(1).max(500);
const level = z.enum(
  REASONING_EFFORT_VALUES.filter((value) => value !== "provider-default"),
);

const levelEntrySchema = z.union([
  level,
  z.strictObject({
    value: level,
    /** Thinking token budget sent in place of a native level. */
    budget: z.number().int().nonnegative().optional(),
    /** Offered on these protocols only. */
    protocols: z.array(z.string()).optional(),
  }),
]);

const ruleSchema = z.strictObject({
  /** Patterns the lower-cased model ID must all match. Absent: any model. */
  match: z.union([pattern, z.array(pattern)]).optional(),
  /** Protocols the rule applies to; `""` is "no protocol stated". */
  protocols: z.array(z.string()).optional(),
  /** Applies only to a model whose thinking is always on. */
  whenThinkingAlwaysOn: z.literal(true).optional(),
  default: level.optional(),
  levels: z.array(levelEntrySchema),
  parameterStyle: z.enum(["adaptive", "effort"]).optional(),
});

const familySchema = z.strictObject({
  id: z.enum(REASONING_PROVIDER_FAMILIES),
  /** A model ID matching one of these belongs to the family. */
  model: z.array(pattern).optional(),
  /** So does a model of a provider matching one, when no model ID decides. */
  provider: z.array(pattern).optional(),
  /**
   * Model names known to take a reasoning level. With `known` or `tableFlag`
   * present, a model must pass one of them before the rules are read.
   */
  known: z.array(pattern).optional(),
  /** A model the model table marks as reasoning passes too. */
  tableFlag: z.boolean().optional(),
  /** Models that cannot turn thinking off: `disabled` is never offered. */
  thinkingAlwaysOn: z.array(pattern).optional(),
  /** First rule that applies gives the levels; none applying means unknown. */
  rules: z.array(ruleSchema).optional(),
});

export const reasoningModelsFileSchema = z.strictObject({
  families: z.array(familySchema),
});

export type ReasoningModelsFile = z.infer<typeof reasoningModelsFileSchema>;

// ── Compiled form ────────────────────────────────────────────────

interface CompiledRule {
  match: RegExp[];
  protocols?: string[];
  whenThinkingAlwaysOn: boolean;
  defaultValue?: ReasoningEffort;
  levels: Array<ReasoningEffortOption & { protocols?: string[] }>;
  parameterStyle?: ReasoningParameterStyle;
}

interface CompiledFamily {
  id: ReasoningProviderFamily;
  model: RegExp[];
  provider: RegExp[];
  known?: RegExp[];
  tableFlag: boolean;
  thinkingAlwaysOn: RegExp[];
  rules: CompiledRule[];
  /** A host's rules: read first, and a match needs no `known` entry. */
  hostRules: CompiledRule[];
}

const compilePatterns = (sources: readonly string[] | undefined): RegExp[] =>
  (sources ?? []).map((source) => new RegExp(source));

function compile(file: ReasoningModelsFile): CompiledFamily[] {
  return file.families.map((family) => ({
    id: family.id,
    model: compilePatterns(family.model),
    provider: compilePatterns(family.provider),
    known: family.known ? compilePatterns(family.known) : undefined,
    tableFlag: family.tableFlag ?? false,
    thinkingAlwaysOn: compilePatterns(family.thinkingAlwaysOn),
    rules: (family.rules ?? []).map((rule) => ({
      match: compilePatterns(
        typeof rule.match === "string" ? [rule.match] : rule.match,
      ),
      protocols: rule.protocols,
      whenThinkingAlwaysOn: rule.whenThinkingAlwaysOn ?? false,
      defaultValue: rule.default,
      levels: rule.levels.map((entry) =>
        typeof entry === "string"
          ? { value: entry }
          : {
              value: entry.value,
              ...(entry.budget !== undefined
                ? { thinkingBudgetTokens: entry.budget }
                : {}),
              ...(entry.protocols ? { protocols: entry.protocols } : {}),
            },
      ),
      parameterStyle: rule.parameterStyle,
    })),
    hostRules: [],
  }));
}

/**
 * Add a host's entries to the bundled ones. Its rules are read before the
 * bundled rules and before `known` / `tableFlag`, so each must name its
 * models; its other patterns are added to the family's lists.
 */
function merge(
  base: CompiledFamily[],
  overrides: CompiledFamily[],
): CompiledFamily[] {
  for (const family of overrides) {
    if (family.known || family.tableFlag) {
      throw new Error(
        `reasoning models: an override cannot set "known" or "tableFlag" (${family.id}); give each rule a "match".`,
      );
    }
    if (family.rules.some((rule) => rule.match.length === 0)) {
      throw new Error(
        `reasoning models: every override rule needs a "match" (${family.id}).`,
      );
    }
  }
  return base.map((family) => {
    const extra = overrides.filter((entry) => entry.id === family.id);
    return {
      ...family,
      model: [...extra.flatMap((entry) => entry.model), ...family.model],
      provider: [
        ...extra.flatMap((entry) => entry.provider),
        ...family.provider,
      ],
      thinkingAlwaysOn: [
        ...extra.flatMap((entry) => entry.thinkingAlwaysOn),
        ...family.thinkingAlwaysOn,
      ],
      hostRules: extra.flatMap((entry) => entry.rules),
    };
  });
}

const BUNDLED = compile(reasoningModelsFileSchema.parse(bundledData));
let families = BUNDLED;

/**
 * Add a host's reasoning entries to the bundled ones, or remove them with
 * `null`. The value has the format of `reasoning-models.data.json`; an
 * invalid one throws and leaves the current entries in place.
 */
export function setReasoningModelOverrides(overrides: unknown): void {
  families =
    overrides === null || overrides === undefined
      ? BUNDLED
      : merge(BUNDLED, compile(reasoningModelsFileSchema.parse(overrides)));
}

// ── Lookup ───────────────────────────────────────────────────────

const matchesAny = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((entry) => entry.test(text));

function familyOf(model: string, provider: string): CompiledFamily {
  const found =
    families.find((family) => matchesAny(family.model, model)) ??
    families.find((family) => matchesAny(family.provider, provider)) ??
    families.find((family) => family.id === "compatible");
  if (!found) throw new Error("reasoning-models: no compatible family");
  return found;
}

/** Whether a model of the family cannot turn thinking off. */
export function thinkingAlwaysOn(
  family: ReasoningProviderFamily,
  modelId: string,
): boolean {
  const model = modelId.toLowerCase();
  return families.some(
    (entry) => entry.id === family && matchesAny(entry.thinkingAlwaysOn, model),
  );
}

/**
 * Resolve the family from the opaque model ID first, then fall back to the
 * transport provider. This keeps aggregator IDs such as
 * `deepseek/deepseek-v4-flash` provider-correct even when routed through an
 * OpenAI-compatible service.
 */
export function resolveReasoningControls(
  modelId: string,
  provider?: string,
  protocol?: ProviderProtocol | string,
  features?: readonly ModelFeature[],
): ReasoningControls {
  const model = modelId.toLowerCase();
  const family = familyOf(model, provider?.toLowerCase() ?? "");
  const alwaysOn = matchesAny(family.thinkingAlwaysOn, model);
  const unknown: ReasoningControls = {
    family: family.id,
    profile: null,
    thinkingAlwaysOn: alwaysOn,
  };

  const stated = protocol ?? "";
  const applies = (entry: CompiledRule): boolean =>
    entry.match.every((expression) => expression.test(model)) &&
    (!entry.protocols || entry.protocols.includes(stated)) &&
    (!entry.whenThinkingAlwaysOn || alwaysOn);
  const passesGate =
    (!family.known && !family.tableFlag) ||
    (family.known !== undefined && matchesAny(family.known, model)) ||
    (family.tableFlag && (features?.includes("reasoning") ?? false));
  const rule =
    family.hostRules.find(applies) ??
    (passesGate ? family.rules.find(applies) : undefined);
  if (!rule) return unknown;

  return {
    family: family.id,
    thinkingAlwaysOn: alwaysOn,
    ...(rule.parameterStyle ? { parameterStyle: rule.parameterStyle } : {}),
    profile: {
      family: family.id,
      ...(rule.defaultValue ? { defaultValue: rule.defaultValue } : {}),
      options: rule.levels
        .filter(
          (entry) =>
            !(alwaysOn && entry.value === "disabled") &&
            (!entry.protocols || entry.protocols.includes(stated)),
        )
        .map(({ value, thinkingBudgetTokens }) => ({
          value,
          ...(thinkingBudgetTokens !== undefined
            ? { thinkingBudgetTokens }
            : {}),
        })),
    },
  };
}
