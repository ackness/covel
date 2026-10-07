import type * as api from "@/services/api.js";

export interface ModelPrice {
  readonly inputPerMToken?: number;
  readonly cacheReadPerMToken?: number;
  readonly cacheWritePerMToken?: number;
  readonly outputPerMToken?: number;
}

export function modelPriceKey(
  provider: string | undefined,
  model: string,
): string {
  return `${provider ?? ""}\u0000${model}`;
}

/**
 * Associate display-only role prices with a concrete provider/model identity.
 * A fallback or a changed model must never inherit the requested role's price.
 * Conflicting role prices for one identity cannot price an aggregated trace.
 */
export function resolveLocalModelPrices(args: {
  readonly overrides: Readonly<
    Record<string, Partial<api.ModelCapabilityInfo>>
  >;
  readonly bindings: Readonly<Record<string, api.SlotConfigEntry>>;
  readonly customPresets: readonly Pick<
    api.CustomPreset,
    "id" | "provider" | "model"
  >[];
  readonly presets: readonly Pick<
    api.PresetSummary,
    "id" | "provider" | "model" | "enabled"
  >[];
  readonly slots: Readonly<Record<string, api.LlmSlotInfo>>;
}): Record<string, ModelPrice | null> {
  const prices: Record<string, ModelPrice | null> = {};
  for (const [slotId, override] of Object.entries(args.overrides)) {
    const pricing = override.pricing;
    if (!pricing) continue;
    const price = {
      ...(validPrice(pricing.cacheReadPerMToken)
        ? { cacheReadPerMToken: pricing.cacheReadPerMToken }
        : {}),
      ...(validPrice(pricing.cacheWritePerMToken)
        ? { cacheWritePerMToken: pricing.cacheWritePerMToken }
        : {}),
      ...(validPrice(pricing.inputPerMToken)
        ? { inputPerMToken: pricing.inputPerMToken }
        : {}),
      ...(validPrice(pricing.outputPerMToken)
        ? { outputPerMToken: pricing.outputPerMToken }
        : {}),
    };
    if (Object.keys(price).length === 0) continue;

    const binding = args.bindings[slotId];
    const target =
      binding?.modelRef !== undefined
        ? args.customPresets.find((preset) => preset.id === binding.modelRef)
        : binding?.presetId !== undefined
          ? args.presets.find(
              (preset) => preset.enabled && preset.id === binding.presetId,
            )
          : args.slots[slotId];
    if (!target?.provider || !target.model) continue;
    const key = modelPriceKey(target.provider, target.model);
    const previous = prices[key];
    prices[key] =
      previous === null ||
      (previous &&
        (previous.inputPerMToken !== price.inputPerMToken ||
          previous.outputPerMToken !== price.outputPerMToken ||
          previous.cacheReadPerMToken !== price.cacheReadPerMToken ||
          previous.cacheWritePerMToken !== price.cacheWritePerMToken))
        ? null
        : price;
  }
  return prices;
}

function validPrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
