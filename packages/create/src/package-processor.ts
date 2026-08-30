import type {
  WorldCreationBrief,
  WorldPackageContentKind,
} from "@covel/shared";
import type {
  GeneratedWorldCharacter,
  GeneratedWorldLorebookEntry,
  GeneratedWorldPackageContent,
} from "./types.js";

const CONTENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return result.length > 0 ? result : undefined;
}

function requestedKinds(brief: WorldCreationBrief | undefined) {
  return new Set<WorldPackageContentKind>(brief?.content ?? []);
}

function normalizeCharacter(
  value: unknown,
  index: number,
  errors: string[],
): GeneratedWorldCharacter | null {
  if (!isRecord(value)) {
    errors.push(`characters[${index}] must be an object`);
    return null;
  }
  if (typeof value.id !== "string" || !CONTENT_ID.test(value.id)) {
    errors.push(`characters[${index}].id must be a stable ASCII identifier`);
    return null;
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    errors.push(`characters[${index}].name is required`);
    return null;
  }

  const attributes = isRecord(value.attributes) ? value.attributes : undefined;
  const persona = isRecord(value.persona) ? value.persona : undefined;
  const scenarioDefaults = isRecord(value.scenarioDefaults)
    ? value.scenarioDefaults
    : undefined;
  const dialogueExamples = Array.isArray(value.dialogueExamples)
    ? value.dialogueExamples.filter(isRecord)
    : undefined;
  const characterRules = Array.isArray(value.rules)
    ? value.rules.filter(isRecord)
    : undefined;
  const authoredFields = isRecord(value.fields) ? value.fields : undefined;
  const fields =
    authoredFields ??
    (attributes || persona || scenarioDefaults
      ? {
          ...attributes,
          ...(persona ? { persona } : {}),
          ...(scenarioDefaults ? { scenarioDefaults } : {}),
        }
      : undefined);
  const instantiate = isRecord(value.instantiate)
    ? {
        ...value.instantiate,
        ...(fields && !isRecord(value.instantiate.fields) ? { fields } : {}),
      }
    : fields
      ? { fields }
      : undefined;

  return {
    schemaVersion: 1,
    id: value.id,
    name: value.name.trim(),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof value.type === "string"
      ? { type: value.type }
      : typeof value.role === "string"
        ? { type: value.role }
        : { type: "npc" }),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(strings(value.aliases) ? { aliases: strings(value.aliases) } : {}),
    ...(strings(value.tags) ? { tags: strings(value.tags) } : {}),
    ...(attributes ? { attributes } : {}),
    ...(persona ? { persona } : {}),
    ...(dialogueExamples ? { dialogueExamples } : {}),
    ...(scenarioDefaults ? { scenarioDefaults } : {}),
    ...(characterRules ? { rules: characterRules } : {}),
    ...(fields ? { fields } : {}),
    ...(instantiate ? { instantiate } : {}),
  };
}

function normalizeLorebookEntry(
  value: unknown,
  index: number,
  sourceKind: "lorebook" | "rule",
  errors: string[],
): GeneratedWorldLorebookEntry | null {
  if (!isRecord(value)) {
    errors.push(`${sourceKind}[${index}] must be an object`);
    return null;
  }
  if (typeof value.id !== "string" || !CONTENT_ID.test(value.id)) {
    errors.push(`${sourceKind}[${index}].id must be a stable ASCII identifier`);
    return null;
  }
  if (typeof value.content !== "string" || !value.content.trim()) {
    errors.push(`${sourceKind}[${index}].content is required`);
    return null;
  }
  const strategy = value.strategy === "selective" ? "selective" : "constant";
  const keys = strings(value.keys);
  if (strategy === "selective" && !keys) {
    errors.push(`${sourceKind}[${index}] selective entries need keys`);
    return null;
  }
  return {
    id: value.id,
    content: value.content.trim(),
    strategy,
    ...(keys ? { keys } : {}),
    position:
      value.position === "before_plugin" ? "before_plugin" : "after_plugin",
    ...(typeof value.insertionOrder === "number"
      ? { insertionOrder: value.insertionOrder }
      : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    extra: {
      ...(isRecord(value.extra) ? value.extra : {}),
      sourceKind,
    },
  };
}

function duplicateIds(
  values: readonly { readonly id: string }[],
): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id);
    seen.add(value.id);
  }
  return [...duplicates];
}

export function normalizeGeneratedPackage(
  value: unknown,
  brief: WorldCreationBrief | undefined,
): { content: GeneratedWorldPackageContent; errors: string[] } {
  const requested = requestedKinds(brief);
  const errors: string[] = [];
  const root = isRecord(value) ? value : {};

  const characters = requested.has("characters")
    ? (Array.isArray(root.characters) ? root.characters.slice(0, 5) : [])
        .map((item, index) => normalizeCharacter(item, index, errors))
        .filter((item): item is GeneratedWorldCharacter => item !== null)
    : [];
  const lorebook = requested.has("lorebook")
    ? (Array.isArray(root.lorebook) ? root.lorebook.slice(0, 8) : [])
        .map((item, index) =>
          normalizeLorebookEntry(item, index, "lorebook", errors),
        )
        .filter((item): item is GeneratedWorldLorebookEntry => item !== null)
    : [];
  const rules = requested.has("rules")
    ? (Array.isArray(root.rules) ? root.rules.slice(0, 5) : [])
        .map((item, index) =>
          normalizeLorebookEntry(item, index, "rule", errors),
        )
        .filter((item): item is GeneratedWorldLorebookEntry => item !== null)
    : [];

  if (requested.has("characters") && characters.length < 3) {
    errors.push("WORLD_PACKAGE_YAML must include at least 3 characters");
  }
  if (requested.has("lorebook") && lorebook.length < 4) {
    errors.push("WORLD_PACKAGE_YAML must include at least 4 lorebook entries");
  }
  if (requested.has("rules") && rules.length < 3) {
    errors.push("WORLD_PACKAGE_YAML must include at least 3 rules");
  }

  const duplicateCharacterIds = duplicateIds(characters);
  if (duplicateCharacterIds.length > 0) {
    errors.push(`duplicate character ids: ${duplicateCharacterIds.join(", ")}`);
  }
  const duplicateLoreIds = duplicateIds([...lorebook, ...rules]);
  if (duplicateLoreIds.length > 0) {
    errors.push(`duplicate lorebook/rule ids: ${duplicateLoreIds.join(", ")}`);
  }

  return {
    content: { characters, lorebook, rules },
    errors,
  };
}

export function applyCreationBriefToManifest(
  manifest: Record<string, unknown>,
  brief: WorldCreationBrief | undefined,
): string[] {
  if (!brief) return [];
  const errors: string[] = [];
  const policy = isRecord(manifest.pluginPolicy)
    ? manifest.pluginPolicy
    : (manifest.pluginPolicy = {});
  policy.preset = brief.experienceMode ?? "traditional-story";
  if (brief.experienceMode === "dialogue-mode") {
    manifest.defaultViewMode = "stage";
  } else {
    delete manifest.defaultViewMode;
  }

  const requested = requestedKinds(brief);
  if (!requested.has("memory")) {
    delete manifest.memoryBlocks;
  } else if (
    !Array.isArray(manifest.memoryBlocks) ||
    manifest.memoryBlocks.length < 2
  ) {
    errors.push("world.yaml must include at least 2 genre memoryBlocks");
  }

  if (requested.has("opening-kit")) {
    const dimensions = isRecord(manifest.dimensions)
      ? manifest.dimensions
      : undefined;
    const starting =
      dimensions && isRecord(dimensions.startingConditions)
        ? dimensions.startingConditions
        : undefined;
    if (
      !starting ||
      !isRecord(starting.startingResources) ||
      Object.keys(starting.startingResources).length < 2
    ) {
      errors.push(
        "dimensions.startingConditions.startingResources must include at least 2 resources",
      );
    }
  }

  return errors;
}
