import i18n from "@/i18n/index.js";
import {
  worldGeographySchema,
  worldFactionSchema,
  worldPowerSystemSchema,
  worldHistoryEventSchema,
  worldEconomySchema,
  worldSocialStructureSchema,
  worldToneSchema,
  worldMechanicsSchema,
  worldStartingConditionsSchema,
  type WorldDimensions,
  type WorldGeography,
  type WorldFaction,
  type WorldPowerSystem,
  type WorldHistoryEvent,
  type WorldEconomy,
  type WorldSocialStructure,
  type WorldTone,
  type WorldMechanics,
  type WorldStartingConditions,
} from "@covel/shared";
import { z } from "zod";
import { resolveDisplayText } from "@/lib/i18n-text.js";

type I18nText = string | Record<string, string>;

export function text(v: I18nText | undefined, locale?: string): string {
  return resolveDisplayText(v, locale ?? i18n.language);
}

/** Shared input class names */
export const inputCls =
  "w-full border border-border bg-background px-3 py-2 text-sm";
export const textareaCls =
  "w-full border border-border bg-background px-3 py-2 text-sm min-h-20 resize-y";
export const selectCls = "border border-border bg-background px-3 py-2 text-sm";

/** The nine authoring templates are examples, never the dimension contract. */
export interface DimensionsState {
  geography?: WorldGeography;
  factions?: WorldFaction[];
  powerSystem?: WorldPowerSystem;
  history?: WorldHistoryEvent[];
  economy?: WorldEconomy;
  socialStructure?: WorldSocialStructure;
  tone?: WorldTone;
  mechanics?: WorldMechanics;
  startingConditions?: WorldStartingConditions;
}
export const dimensionTemplateSchemas = {
  geography: worldGeographySchema,
  factions: z.array(worldFactionSchema),
  powerSystem: worldPowerSystemSchema,
  history: z.array(worldHistoryEventSchema),
  economy: worldEconomySchema,
  socialStructure: worldSocialStructureSchema,
  tone: worldToneSchema,
  mechanics: worldMechanicsSchema,
  startingConditions: worldStartingConditionsSchema,
};
export function projectDimensionTemplates(
  dimensions: WorldDimensions,
): DimensionsState {
  return Object.fromEntries(
    Object.entries(dimensionTemplateSchemas).flatMap(([id, schema]) => {
      const result = schema.safeParse(dimensions[id]?.initialValue);
      return result.success ? [[id, result.data]] : [];
    }),
  );
}

export interface TabProps {
  dimensions: DimensionsState;
  onChange: (next: DimensionsState) => void;
  t: (key: string) => string;
}
