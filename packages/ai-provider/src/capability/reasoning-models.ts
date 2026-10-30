/**
 * Which reasoning levels a model accepts, and how its vendor takes them.
 *
 * The answer is data, from four places, highest first:
 * 1. A host's entries (`setReasoningModelOverrides`).
 * 2. Rules in `reasoning-models.data.json` that name their models: facts
 *    Covel verified that the catalog lacks, such as one endpoint's limits.
 * 3. The models.dev catalog (`models-dev.ts`): levels, default level, whether
 *    thinking can be switched off, fixed sampling and tool choices, per host.
 * 4. A family's catch-all rules in `reasoning-models.data.json`.
 * Vendor behaviour that no catalog states (how a level is written, which tool
 * choices a vendor takes while it thinks) comes from the family entries.
 *
 * How a level is written into a request is not here: each protocol's wire in
 * `reasoning-effort.ts` does that from the resolved controls.
 */

import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@covel/shared";
import { z } from "zod";

import type { ModelFeature, ProviderProtocol } from "../types.js";
import {
  MODELS_DEV_API,
  modelsDevVariant,
  type ModelsDevVariant,
} from "./models-dev.js";
import bundledData from "./reasoning-models.data.json" with { type: "json" };

const REASONING_PROVIDER_FAMILIES = [
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

/** Sampling parameters a model handles itself. */
export interface ReasoningSampling {
  /** Sent, but ignored while the model thinks. */
  ignoredWhileThinking?: boolean;
  /** Never sent: the model accepts only its own value. */
  fixed?: SamplingParameter[];
}

/** Provider/model-specific reasoning controls exposed to the settings UI. */
export interface ReasoningEffortProfile {
  family: ReasoningProviderFamily;
  options: ReasoningEffortOption[];
  /** Documented provider default. Omitted when it varies by model. */
  defaultValue?: ReasoningEffort;
  /**
   * The level Covel sends when neither the player nor the runtime chose one:
   * one below the model's own default when that default is its highest level
   * and `xhigh` or `max`. Absent: nothing is sent.
   */
  requestDefault?: ReasoningEffort;
  sampling?: ReasoningSampling;
}

/**
 * How a family writes a level when it has more than one way:
 * `adaptive` is Anthropic adaptive thinking next to the effort, and `effort`
 * is Qwen's `reasoning_effort` next to its thinking switch.
 */
export type ReasoningParameterStyle = "adaptive" | "effort";

/**
 * How a level is written on an OpenAI-compatible request:
 * - `effort`: `reasoning_effort`, with `"none"` for off.
 * - `thinking-type`: `thinking: {type: "enabled" | "disabled"}`, plus
 *   `reasoning_effort` for a level.
 * - `enable-thinking`: `enable_thinking`, plus a budget or `reasoning_effort`
 *   by `parameterStyle`.
 */
export const REASONING_FORMATS = [
  "effort",
  "thinking-type",
  "enable-thinking",
] as const;
export type ReasoningFormat = (typeof REASONING_FORMATS)[number];

/** A forced `tool_choice`: any declared tool, or one named tool. */
export const TOOL_CHOICE_KINDS = ["auto", "required", "named"] as const;
export type ToolChoiceKind = (typeof TOOL_CHOICE_KINDS)[number];

export const SAMPLING_PARAMETERS = [
  "temperature",
  "topP",
  "frequencyPenalty",
  "presencePenalty",
] as const;
export type SamplingParameter = (typeof SAMPLING_PARAMETERS)[number];

/** What is known of one model on one protocol. */
export interface ReasoningControls {
  family: ReasoningProviderFamily;
  /** `null`: the model is not known to take a reasoning level. */
  profile: ReasoningEffortProfile | null;
  parameterStyle?: ReasoningParameterStyle;
  /** The model cannot turn thinking off. */
  thinkingAlwaysOn: boolean;
  format: ReasoningFormat;
  /** The model thinks when a request carries no reasoning field. */
  thinksByDefault: boolean;
  /**
   * The tool choices the model accepts while it thinks. Absent: only
   * `auto`.
   */
  toolChoiceWhileThinking?: ToolChoiceKind[];
  sampling?: ReasoningSampling;
  /**
   * The levels the target accepts when a request carries tools, first one
   * preferred. Absent: tools do not narrow the levels.
   */
  withTools?: ReasoningEffort[];
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

const behaviourFields = {
  /** How a level is written; see `ReasoningFormat`. Default: `effort`. */
  format: z.enum(REASONING_FORMATS).optional(),
  /** The model thinks when a request carries no reasoning field. */
  thinksByDefault: z.boolean().optional(),
  /** The tool choices accepted while the model thinks. Default: `auto` only. */
  toolChoiceWhileThinking: z.array(z.enum(TOOL_CHOICE_KINDS)).min(1).optional(),
  sampling: z
    .strictObject({
      ignoredWhileThinking: z.boolean().optional(),
      fixed: z.array(z.enum(SAMPLING_PARAMETERS)).min(1).optional(),
    })
    .optional(),
};

const ruleSchema = z.strictObject({
  ...behaviourFields,
  /** Patterns the lower-cased model ID must all match. Absent: any model. */
  match: z.union([pattern, z.array(pattern)]).optional(),
  /** Protocols the rule applies to; `""` is "no protocol stated". */
  protocols: z.array(z.string()).optional(),
  /**
   * Patterns the lower-cased provider name of the slot must match: a rule
   * about one vendor's own endpoint, which a relay of the same models may not
   * share. Absent: any provider.
   */
  providers: z.array(pattern).optional(),
  /** Applies only to a model whose thinking is always on. */
  whenThinkingAlwaysOn: z.literal(true).optional(),
  /**
   * Applies only to a model the models.dev catalog has no levels for: covers
   * IDs the catalog has not listed yet without overriding the ones it has.
   */
  whenUnlisted: z.literal(true).optional(),
  /** The provider's own default level. */
  default: level.optional(),
  levels: z.array(levelEntrySchema),
  parameterStyle: z.enum(["adaptive", "effort"]).optional(),
  /**
   * The only levels the target accepts on a request that carries tools,
   * first one preferred. A request with tools and another level, or with no
   * level (the model's own default then applies), is sent the first one.
   */
  withTools: z.array(level).min(1).optional(),
});

const familySchema = z.strictObject({
  ...behaviourFields,
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

const reasoningModelsFileSchema = z.strictObject({
  families: z.array(familySchema),
});

export type ReasoningModelsFile = z.infer<typeof reasoningModelsFileSchema>;

// ── Compiled form ────────────────────────────────────────────────

interface Behaviour {
  format?: ReasoningFormat;
  thinksByDefault?: boolean;
  toolChoiceWhileThinking?: ToolChoiceKind[];
  sampling?: ReasoningSampling;
}

interface CompiledRule extends Behaviour {
  match: RegExp[];
  protocols?: string[];
  providers?: RegExp[];
  whenThinkingAlwaysOn: boolean;
  whenUnlisted?: boolean;
  defaultValue?: ReasoningEffort;
  levels: Array<ReasoningEffortOption & { protocols?: string[] }>;
  parameterStyle?: ReasoningParameterStyle;
  withTools?: ReasoningEffort[];
}

interface CompiledFamily extends Behaviour {
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

function behaviour(
  entry: z.infer<typeof familySchema> | z.infer<typeof ruleSchema>,
): Behaviour {
  return {
    ...(entry.format ? { format: entry.format } : {}),
    ...(entry.thinksByDefault !== undefined
      ? { thinksByDefault: entry.thinksByDefault }
      : {}),
    ...(entry.toolChoiceWhileThinking
      ? { toolChoiceWhileThinking: entry.toolChoiceWhileThinking }
      : {}),
    ...(entry.sampling ? { sampling: entry.sampling } : {}),
  };
}

function compile(file: ReasoningModelsFile): CompiledFamily[] {
  return file.families.map((family) => ({
    ...behaviour(family),
    id: family.id,
    model: compilePatterns(family.model),
    provider: compilePatterns(family.provider),
    known: family.known ? compilePatterns(family.known) : undefined,
    tableFlag: family.tableFlag ?? false,
    thinkingAlwaysOn: compilePatterns(family.thinkingAlwaysOn),
    rules: (family.rules ?? []).map((rule) => ({
      ...behaviour(rule),
      match: compilePatterns(
        typeof rule.match === "string" ? [rule.match] : rule.match,
      ),
      protocols: rule.protocols,
      ...(rule.providers ? { providers: compilePatterns(rule.providers) } : {}),
      whenThinkingAlwaysOn: rule.whenThinkingAlwaysOn ?? false,
      ...(rule.whenUnlisted ? { whenUnlisted: true } : {}),
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
      ...(rule.withTools ? { withTools: rule.withTools } : {}),
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
 * OpenAI-compatible service. `baseUrl` picks the catalog entry of the host
 * the slot calls.
 */
export function resolveReasoningControls(
  modelId: string,
  provider?: string,
  protocol?: ProviderProtocol | string,
  features?: readonly ModelFeature[],
  baseUrl?: string,
): ReasoningControls {
  const model = modelId.toLowerCase();
  const providerName = provider?.toLowerCase() ?? "";
  const family = familyOf(model, providerName);
  const stated = protocol ?? "";
  const variant = modelsDevVariant(model, { provider, baseUrl });
  const catalog = variant ? catalogRule(variant, stated) : undefined;
  const familyAlwaysOn = matchesAny(family.thinkingAlwaysOn, model);

  const applies =
    (alwaysOn: boolean) =>
    (entry: CompiledRule): boolean =>
      entry.match.every((expression) => expression.test(model)) &&
      (!entry.protocols || entry.protocols.includes(stated)) &&
      (!entry.providers || matchesAny(entry.providers, providerName)) &&
      (!entry.whenThinkingAlwaysOn || alwaysOn) &&
      (!entry.whenUnlisted || catalog?.rule === undefined);
  const passesGate =
    (!family.known && !family.tableFlag) ||
    (family.known !== undefined && matchesAny(family.known, model)) ||
    (family.tableFlag && (features?.includes("reasoning") ?? false)) ||
    catalog?.rule !== undefined;
  // A bundled rule written for this model beats the catalog, and so does its
  // family's word on whether thinking can be switched off.
  const specific =
    family.hostRules.find(applies(familyAlwaysOn)) ??
    (passesGate
      ? family.rules.find(
          (entry) =>
            (entry.match.length > 0 || entry.whenThinkingAlwaysOn) &&
            applies(familyAlwaysOn)(entry),
        )
      : undefined);
  const alwaysOn =
    familyAlwaysOn || (!specific && (catalog?.alwaysOn ?? false));
  const catchAll = passesGate
    ? family.rules.find(
        (entry) =>
          entry.match.length === 0 &&
          !entry.whenThinkingAlwaysOn &&
          applies(alwaysOn)(entry),
      )
    : undefined;
  const fromCatalog = catalog?.rule
    ? withFamilyFallbacks(catalog.rule, catchAll, alwaysOn)
    : undefined;
  const rule =
    specific ??
    fromCatalog ??
    (passesGate ? family.rules.find(applies(alwaysOn)) : undefined);
  const own = settled(family, rule, catalog?.rule, variant);
  if (!rule)
    return {
      family: family.id,
      profile: null,
      thinkingAlwaysOn: alwaysOn,
      ...own,
    };

  const options = rule.levels
    .filter(
      (entry) =>
        !(alwaysOn && entry.value === "disabled") &&
        (!entry.protocols || entry.protocols.includes(stated)),
    )
    .map(({ value, thinkingBudgetTokens }) => ({
      value,
      ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
    }));
  const requestDefault = costlyDefaultStepDown(options, rule.defaultValue);
  return {
    family: family.id,
    thinkingAlwaysOn: alwaysOn,
    ...own,
    ...(rule.parameterStyle ? { parameterStyle: rule.parameterStyle } : {}),
    ...(rule.withTools ? { withTools: rule.withTools } : {}),
    profile: {
      family: family.id,
      ...(rule.defaultValue ? { defaultValue: rule.defaultValue } : {}),
      ...(requestDefault ? { requestDefault } : {}),
      ...(own.sampling ? { sampling: own.sampling } : {}),
      options,
    },
  };
}

const OFF_LEVELS: ReadonlySet<ReasoningEffort> = new Set([
  "disabled",
  "none",
  "automatic",
]);

/**
 * One level below the model's default when that default is its highest level
 * and a costly one (`xhigh`, `max`): a model that thinks hardest unless told
 * otherwise would make every call slow.
 */
function costlyDefaultStepDown(
  options: readonly ReasoningEffortOption[],
  defaultValue: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (defaultValue !== "max" && defaultValue !== "xhigh") return undefined;
  const levels = options
    .map((option) => option.value)
    .filter((value) => !OFF_LEVELS.has(value));
  const at = levels.indexOf(defaultValue);
  return at > 0 && at === levels.length - 1 ? levels[at - 1] : undefined;
}

/**
 * The catalog lists what a model accepts but not always what it does by
 * default or how thinking is switched off. The family's catch-all rule fills
 * both: its default when the catalog offers that level, and its off switch
 * when the catalog does not say thinking is always on.
 */
function withFamilyFallbacks(
  rule: CompiledRule,
  catchAll: CompiledRule | undefined,
  alwaysOn: boolean,
): CompiledRule {
  if (!catchAll) return rule;
  const offered = new Set(rule.levels.map((entry) => entry.value));
  const defaultValue =
    rule.defaultValue ??
    (catchAll.defaultValue && offered.has(catchAll.defaultValue)
      ? catchAll.defaultValue
      : undefined);
  const addOff =
    !alwaysOn &&
    !offered.has("disabled") &&
    !offered.has("none") &&
    catchAll.levels.some((entry) => entry.value === "disabled");
  return {
    ...rule,
    ...(defaultValue ? { defaultValue } : {}),
    levels: addOff
      ? [{ value: "disabled" as const }, ...rule.levels]
      : rule.levels,
  };
}

interface CatalogRule {
  /** Absent: the catalog lists no levels for the model. */
  rule?: CompiledRule;
  /** Thinking cannot be switched off. */
  alwaysOn: boolean;
}

/** A rule read from a models.dev entry. */
function catalogRule(
  variant: ModelsDevVariant,
  protocol: string,
): CatalogRule | undefined {
  const reasoning = variant.reasoning;
  if (!reasoning) return undefined;
  const effort = reasoning.effort ?? [];
  const fallback = reasoning.default;
  // Thinks unless told a level, and has no switch: on every request. A model
  // with no stated default (Claude) may still not think by default.
  const alwaysOn =
    !reasoning.toggle &&
    fallback !== undefined &&
    fallback !== "off" &&
    fallback !== "none";
  const levels: ReasoningEffort[] = [
    // A toggle is the off switch unless `none` already is.
    ...(reasoning.toggle && !effort.includes("none")
      ? (["disabled"] as const)
      : []),
    ...effort,
    ...(reasoning.toggle && effort.length === 0
      ? (["automatic"] as const)
      : []),
  ];
  if (levels.length === 0) return { alwaysOn };
  const defaultValue: ReasoningEffort | undefined =
    fallback === "off"
      ? "disabled"
      : fallback === "on"
        ? effort.length === 0
          ? "automatic"
          : undefined
        : fallback;
  const api = MODELS_DEV_API[protocol];
  const choices = api ? variant.toolChoice?.[api] : undefined;
  const toolChoices = choices
    ?.map((choice) => (choice === "tool" ? "named" : choice))
    .filter((choice): choice is ToolChoiceKind =>
      (TOOL_CHOICE_KINDS as readonly string[]).includes(choice),
    );
  return {
    alwaysOn,
    rule: {
      match: [],
      whenThinkingAlwaysOn: false,
      ...(defaultValue ? { defaultValue } : {}),
      levels: levels.map((value) => ({ value })),
      // Listed effort levels go on the wire beside a thinking switch.
      ...(effort.length > 0 ? { parameterStyle: "effort" as const } : {}),
      thinksByDefault:
        fallback !== undefined && fallback !== "off" && fallback !== "none",
      // A choice list holds while the model thinks only when it always does.
      ...(alwaysOn && toolChoices?.length
        ? { toolChoiceWhileThinking: toolChoices }
        : {}),
    },
  };
}

/**
 * The behaviour of a target: the matched rule over its family, the family
 * over the catalog, with the defaults filled in.
 */
function settled(
  family: CompiledFamily,
  rule: CompiledRule | undefined,
  catalog: CompiledRule | undefined,
  variant: ModelsDevVariant | undefined,
): Pick<
  ReasoningControls,
  "format" | "thinksByDefault" | "toolChoiceWhileThinking" | "sampling"
> {
  const toolChoices =
    rule?.toolChoiceWhileThinking ??
    family.toolChoiceWhileThinking ??
    catalog?.toolChoiceWhileThinking;
  const fixed =
    rule?.sampling?.fixed ??
    family.sampling?.fixed ??
    variant?.fixed?.map((name) => (name === "top_p" ? "topP" : name));
  const ignoredWhileThinking =
    rule?.sampling?.ignoredWhileThinking ??
    family.sampling?.ignoredWhileThinking;
  const sampling: ReasoningSampling = {
    ...(ignoredWhileThinking ? { ignoredWhileThinking } : {}),
    ...(fixed?.length ? { fixed } : {}),
  };
  return {
    format: rule?.format ?? family.format ?? "effort",
    thinksByDefault:
      rule?.thinksByDefault ??
      family.thinksByDefault ??
      catalog?.thinksByDefault ??
      false,
    ...(toolChoices ? { toolChoiceWhileThinking: toolChoices } : {}),
    ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
  };
}
