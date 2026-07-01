/**
 * Generated world-manifest normalization + lore-quality validation.
 *
 * Extracted from create-world.ts: repairs common LLM mistakes in the YAML
 * manifest (unknown root fields, non-string versions, invalid enum values,
 * string-typed numeric resources), normalizes the WORLD.md document heading,
 * and enforces lore quality rules.
 */

const WORLD_MANIFEST_ROOT_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "version",
  "summary",
  "defaultLocale",
  "supportedLocales",
  "tags",
  "requiredPlugins",
  "recommendedPlugins",
  "excludedPlugins",
  "pluginPolicy",
  "pluginSettings",
  "memoryBlocks",
  "worldData",
  "characterBlueprintSources",
  "dimensions",
  "dimensionSources",
]);

const META_CONTENT_PATTERNS = [
  /测试用/u,
  /测试目的/u,
  /低成本/u,
  /快速验证/u,
  /提示词/u,
  /模型/u,
  /框架内部/u,
  /\btest(?:ing)?\b/iu,
  /\bvalidation\b/iu,
  /\bprompt\b/iu,
  /\bmodel\b/iu,
  /\bcost\b/iu,
  /\bcheap\b/iu,
  /\be2e\b/iu,
  /\bapi\b/iu,
  /\bframework\b/iu,
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  fallback: string,
): void {
  const value = record[key];
  if (typeof value !== "string") return;
  const normalized = value.trim().toLowerCase();
  record[key] = allowed.includes(normalized) ? normalized : fallback;
}

export function normalizeGeneratedManifest(
  manifest: Record<string, unknown>,
): string[] {
  const repairs: string[] = [];

  for (const key of Object.keys(manifest)) {
    if (!WORLD_MANIFEST_ROOT_KEYS.has(key)) {
      delete manifest[key];
      repairs.push(`removed unknown root field "${key}"`);
    }
  }

  for (const key of ["schemaVersion", "version"] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
      manifest[key] = String(manifest[key]);
      repairs.push(`stringified ${key}`);
    }
  }

  if (!isRecord(manifest.dimensions)) return repairs;
  const dimensions = manifest.dimensions;

  if (Array.isArray(dimensions.factions)) {
    for (const faction of dimensions.factions) {
      if (!isRecord(faction)) continue;
      normalizeEnum(
        faction,
        "type",
        [
          "political",
          "guild",
          "corporate",
          "religious",
          "criminal",
          "military",
          "other",
        ],
        "other",
      );
      normalizeEnum(faction, "influence", ["major", "minor"], "minor");
    }
  }

  if (isRecord(dimensions.powerSystem)) {
    normalizeEnum(
      dimensions.powerSystem,
      "type",
      ["magic", "technology", "cultivation", "psychic", "hybrid", "other"],
      "other",
    );
  }

  if (Array.isArray(dimensions.history)) {
    for (const event of dimensions.history) {
      if (isRecord(event)) {
        normalizeEnum(event, "significance", ["major", "minor"], "minor");
      }
    }
  }

  if (isRecord(dimensions.tone)) {
    normalizeEnum(
      dimensions.tone,
      "contentRating",
      ["all-ages", "teen", "mature"],
      "teen",
    );
  }

  if (isRecord(dimensions.mechanics)) {
    normalizeEnum(
      dimensions.mechanics,
      "combatStyle",
      ["turn-based", "real-time", "narrative", "none"],
      "narrative",
    );
    normalizeEnum(
      dimensions.mechanics,
      "difficulty",
      ["easy", "normal", "hard", "adaptive"],
      "adaptive",
    );
  }

  const startingConditions = dimensions.startingConditions;
  if (
    isRecord(startingConditions) &&
    isRecord(startingConditions.startingResources)
  ) {
    for (const [key, value] of Object.entries(
      startingConditions.startingResources,
    )) {
      const numberValue = toFiniteNumber(value);
      if (numberValue !== undefined && numberValue !== value) {
        startingConditions.startingResources[key] = numberValue;
        repairs.push(`numeric startingResources.${key}`);
      }
    }
  }

  return repairs;
}

function manifestText(value: unknown, locale: string): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const localized = value[locale];
  if (typeof localized === "string") return localized;
  const fallback = Object.values(value).find(
    (entry): entry is string => typeof entry === "string",
  );
  return fallback;
}

export function normalizeLoreDocument(
  lore: string,
  manifest: Record<string, unknown>,
  locale: string,
): string {
  const worldName = manifestText(manifest.name, locale);
  if (!worldName) return lore.trim();

  const lines = lore.trim().split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex < 0) return `# ${worldName}`;

  const first = lines[firstContentIndex]!.trim();
  if (/^#\s+/.test(first)) return lines.join("\n").trim();
  if (/^#{2,6}\s+/.test(first)) {
    lines[firstContentIndex] = `# ${first.replace(/^#{2,6}\s+/, "")}`;
    return lines.join("\n").trim();
  }

  return [`# ${worldName}`, "", ...lines].join("\n").trim();
}

export function findLoreQualityErrors(lore: string): string[] {
  const errors: string[] = [];
  if (!/^#\s+\S/m.test(lore)) {
    errors.push("WORLD.md must start with an H1 title");
  }
  const forbidden = META_CONTENT_PATTERNS.find((pattern) => pattern.test(lore));
  if (forbidden) {
    errors.push("WORLD.md contains meta/test/model/cost wording");
  }
  const numberedHooks = lore.match(/^\s*\d+\.\s+/gmu)?.length ?? 0;
  if (numberedHooks < 3) {
    errors.push("WORLD.md must include 3 numbered adventure hooks");
  }
  return errors;
}
