/**
 * Generated world-manifest normalization + lore-quality validation.
 *
 * Extracted from create-world.ts: repairs common LLM mistakes in the YAML
 * manifest (unknown root fields and non-string versions), normalizes the
 * WORLD.md document heading,
 * and enforces lore quality rules.
 */

import { resolveI18nText, validateDimensionData } from "@covel/shared";

const WORLD_MANIFEST_ROOT_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "version",
  "summary",
  "defaultLocale",
  "supportedLocales",
  "tags",
  "pluginPolicy",
  "pluginSettings",
  "worldData",
  "characterSchema",
  "dimensions",
  "dimensionSources",
  "defaultViewMode",
]);

// Keep these contextual: isolated vocabulary such as "model" or "API" can be valid lore.
const EXPLICIT_META_CONTENT_PATTERNS = [
  /测试用(?:的)?(?:世界|内容|文档|数据|场景)/u,
  /测试目的/u,
  /快速验证(?:用)?(?:的)?(?:世界|内容|文档|方案)/u,
  /提示词(?:中|里|内容|要求|指令|输出)/u,
  /(?:语言模型|大模型|AI\s*模型)(?:生成|输出)/iu,
  /模型(?:生成|输出|内部)/u,
  /框架内部/u,
  /\b(?:test|testing|validation)\s+(?:fixture|purpose|artifact|content|dataset)\b/iu,
  /\b(?:prompt|model)\s+(?:generation|output|instructions?|internals?)\b/iu,
  /\b(?:generated|written|created|produced)\s+by\s+(?:an?\s+)?(?:ai|llm|language model)\b/iu,
  /\b(?:low[- ]?cost|cheap)\s+(?:llm|api|generation|tokens?)\b/iu,
  /\be2e\b/iu,
  /\bframework\s+internals?\b/iu,
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

  // Authored dimension values are validated against their own schemas, never
  // coerced or rewritten according to a fixed list of world-building topics.

  return repairs;
}

/**
 * Remove every dimension whose definition does not validate, and report each
 * one. A single bad schema keyword then costs one dimension, not the whole
 * generated world and another full model call.
 */
export function dropInvalidDimensions(
  manifest: Record<string, unknown>,
): string[] {
  const dimensions = manifest.dimensions;
  if (!isRecord(dimensions)) return [];
  const dropped: string[] = [];
  for (const [id, definition] of Object.entries(dimensions)) {
    const validation = validateDimensionData(id, definition);
    if (validation.valid) continue;
    delete dimensions[id];
    const first = validation.errors?.[0];
    dropped.push(
      `dropped dimension "${id}": ${first ? `${first.path}: ${first.message}` : "invalid definition"}`,
    );
  }
  return dropped;
}

function manifestText(value: unknown, locale: string): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const localized = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return resolveI18nText(localized, locale);
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
  return [...findLoreStructureErrors(lore), ...findLoreMetaErrors(lore)];
}

export function findLoreStructureErrors(lore: string): string[] {
  const errors: string[] = [];
  if (!/^#\s+\S/m.test(lore)) {
    errors.push("WORLD.md must start with an H1 title");
  }
  const numberedHooks = lore.match(/^\s*\d+\.\s+/gmu)?.length ?? 0;
  if (numberedHooks < 3) {
    errors.push("WORLD.md must include 3 numbered adventure hooks");
  }
  return errors;
}

export function findLoreMetaErrors(lore: string): string[] {
  const forbidden = EXPLICIT_META_CONTENT_PATTERNS.some((pattern) =>
    pattern.test(lore),
  );
  return forbidden
    ? ["WORLD.md contains explicit generation meta wording"]
    : [];
}
