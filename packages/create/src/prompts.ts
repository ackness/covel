import type { WorldGenerationDataContract } from "./types.js";
import { interpolate, loadPrompt, type PromptLoader } from "@covel/context";
import { selectedDataContracts, selectedPack } from "./package-processor.js";
import type {
  PluginPack,
  WorldCreationBrief,
  WorldPackageContentKind,
} from "@covel/shared";
import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  localeDisplayName,
  localeRegistry,
  resolveI18nText,
} from "@covel/shared";

/**
 * Load the externalized system prompt for LLM-driven world generation.
 *
 * The LLM receives only a concept string and autonomously decides all details:
 * id, name, tags, dimensions, and lore.
 */
export async function buildWorldPrompt(
  concept: string,
  locale: string,
  brief?: WorldCreationBrief,
  loader: PromptLoader = loadPrompt,
  dataContracts: readonly WorldGenerationDataContract[] = [],
  packs: readonly PluginPack[] = [],
): Promise<string> {
  const promptLocale = resolvePromptLocale(locale);

  const template = await loader(
    "server",
    "generate-world",
    promptLocale.locale,
  );
  return interpolate(template, {
    concept,
    locale: promptLocale.locale,
    language: promptLocale.language,
    creationBrief: [
      // A revision has no brief: it keeps the pack the world has.
      ...(brief
        ? [formatPackBrief(selectedPack(brief, packs), promptLocale.locale)]
        : []),
      formatCreationBrief(brief),
      formatContractBrief(selectedDataContracts(brief, dataContracts)),
    ].join("\n"),
  });
}

/** The plugin pack the world is made for, as the catalogue describes it. */
function formatPackBrief(pack: PluginPack | undefined, locale: string): string {
  if (!pack)
    return "Plugin pack: none chosen. Omit pluginPolicy.presetId and defaultViewMode.";
  const label = resolveI18nText(pack.label, locale) ?? pack.id;
  const description = pack.description
    ? resolveI18nText(pack.description, locale)
    : undefined;
  return `Plugin pack: ${label} (presetId ${pack.id}).${description ? ` ${description}` : ""} Design the world for this way of playing.`;
}

export async function buildWorldLoreRepairPrompt(
  locale: string,
  loader: PromptLoader = loadPrompt,
): Promise<string> {
  const promptLocale = resolvePromptLocale(locale);
  const template = await loader(
    "server",
    "repair-world-lore",
    promptLocale.locale,
  );
  return interpolate(template, promptLocale);
}

function resolvePromptLocale(locale: string): {
  locale: string;
  language: string;
} {
  const canonicalLocale = canonicalizeLocale(locale) ?? DEFAULT_LOCALE;
  const definition = localeRegistry.resolve(canonicalLocale);
  const language = definition
    ? (resolveI18nText(definition.label, canonicalLocale) ?? definition.code)
    : localeDisplayName(canonicalLocale);
  return { locale: canonicalLocale, language };
}

function requestedLine(
  requested: ReadonlySet<WorldPackageContentKind>,
  kind: WorldPackageContentKind,
  description: string,
): string {
  return `- ${requested.has(kind) ? "CREATE" : "OMIT"}: ${description}`;
}

/** One CREATE block per requested contract; schemas of the rest stay out. */
function formatContractBrief(
  contracts: readonly WorldGenerationDataContract[],
): string {
  if (contracts.length === 0)
    return "Plugin data contracts: none requested. Omit contractData.";
  return [
    "Plugin data contracts: create contractData records for each contract below, and for no other contract.",
    ...contracts.map((item) =>
      [
        `- CREATE contract "${item.contract}"${item.title ? ` (${item.title})` : ""}.${item.hint ? ` ${item.hint}` : ""}`,
        `  Record schema: ${JSON.stringify(item.schema)}`,
        ...(item.example !== undefined
          ? [`  Example value: ${JSON.stringify(item.example)}`]
          : []),
      ].join("\n"),
    ),
  ].join("\n");
}

function formatCreationBrief(brief: WorldCreationBrief | undefined): string {
  if (!brief) {
    return [
      "No optional package supplements were explicitly requested.",
      "Return empty characters/lorebook/rules arrays.",
    ].join("\n");
  }
  const requested = new Set(brief.content ?? []);
  return [
    requestedLine(
      requested,
      "characters",
      "3-5 interconnected main characters; each description gives the role in the crisis, the motive, and the way of speaking.",
    ),
    requestedLine(
      requested,
      "lorebook",
      "4-8 focused setting entries; use selective strategy and useful activation keys for non-core facts.",
    ),
    requestedLine(
      requested,
      "rules",
      "3-5 durable world or narrative rules that make consequences consistent.",
    ),
    requestedLine(
      requested,
      "opening-kit",
      "at least 2 resource dimensions with numeric initialValue plus a dimension describing concrete opening choices; choose author-defined IDs.",
    ),
    brief.additionalInstructions?.trim()
      ? `Additional author direction:\n${brief.additionalInstructions.trim()}`
      : "Additional author direction: none.",
  ].join("\n");
}
