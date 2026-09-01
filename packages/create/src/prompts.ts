import { interpolate, loadPrompt } from "@covel/context";
import type {
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
): Promise<string> {
  const canonicalLocale = canonicalizeLocale(locale) ?? DEFAULT_LOCALE;
  const definition = localeRegistry.resolve(canonicalLocale);
  const lang = definition
    ? (resolveI18nText(definition.label, canonicalLocale) ?? definition.code)
    : localeDisplayName(canonicalLocale);

  const template = await loadPrompt(
    "server",
    "generate-world",
    canonicalLocale,
  );
  return interpolate(template, {
    concept,
    locale: canonicalLocale,
    language: lang,
    creationBrief: formatCreationBrief(brief),
  });
}

function requestedLine(
  requested: ReadonlySet<WorldPackageContentKind>,
  kind: WorldPackageContentKind,
  description: string,
): string {
  return `- ${requested.has(kind) ? "CREATE" : "OMIT"}: ${description}`;
}

function formatCreationBrief(brief: WorldCreationBrief | undefined): string {
  if (!brief) {
    return [
      "Experience preset: traditional-story.",
      "No optional package supplements were explicitly requested.",
      "Return empty characters/lorebook/rules arrays.",
    ].join("\n");
  }
  const requested = new Set(brief.content ?? []);
  return [
    `Experience preset: ${brief.experienceMode ?? "traditional-story"}.`,
    requestedLine(
      requested,
      "characters",
      "3-5 interconnected main character blueprints with motives, secrets, voice, relationships, and opening state.",
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
      "memory",
      "2-4 genre-specific memoryBlocks in world.yaml (do not repeat generic story/scene/player blocks).",
    ),
    requestedLine(
      requested,
      "opening-kit",
      "at least 2 numeric startingResources plus concrete opening choices in startingConditions.",
    ),
    brief.additionalInstructions?.trim()
      ? `Additional author direction:\n${brief.additionalInstructions.trim()}`
      : "Additional author direction: none.",
  ].join("\n");
}
