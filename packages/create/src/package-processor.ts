import type {
  WorldCreationBrief,
  WorldPackageContentKind,
} from "@covel/shared";
import type {
  GeneratedWorldCharacter,
  GeneratedContractData,
  WorldGenerationDataContract,
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

/** The data contracts the brief asks for, in the order the caller supplied them. */
export function selectedDataContracts(
  brief: WorldCreationBrief | undefined,
  dataContracts: readonly WorldGenerationDataContract[],
): readonly WorldGenerationDataContract[] {
  const wanted = new Set(brief?.contracts ?? []);
  return dataContracts.filter((item) => wanted.has(item.contract));
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
  dataContracts: readonly WorldGenerationDataContract[] = [],
): {
  content: GeneratedWorldPackageContent;
  errors: string[];
  warnings: string[];
} {
  const requested = requestedKinds(brief);
  const selected = selectedDataContracts(brief, dataContracts);
  const errors: string[] = [];
  const warnings: string[] = [];
  // A requested kind that is absent is a failed answer. One that is present
  // but below the target is a usable world: retrying it costs a full model
  // call and often trades this shortfall for a different one.
  const checkAmount = (
    kind: WorldPackageContentKind,
    label: string,
    amount: number,
    target: number,
  ) => {
    if (!requested.has(kind)) return;
    if (amount === 0) errors.push(`WORLD_PACKAGE_YAML must include ${label}`);
    else if (amount < target)
      warnings.push(
        `generated ${amount} ${label}; the brief asks for ${target}`,
      );
  };
  const root = isRecord(value) ? value : {};

  const contractData: GeneratedContractData[] = [];
  const identities = new Set<string>();
  if (root.contractData !== undefined && !Array.isArray(root.contractData))
    errors.push("contractData must be an array");
  for (const [index, record] of (Array.isArray(root.contractData)
    ? root.contractData
    : []
  ).entries()) {
    if (
      !isRecord(record) ||
      typeof record.contract !== "string" ||
      typeof record.key !== "string" ||
      !CONTENT_ID.test(record.key) ||
      !isRecord(record.value) ||
      record.value.id !== record.key
    ) {
      errors.push(
        `contractData[${index}] requires contract, key and an object value with matching id`,
      );
      continue;
    }
    const declaration = selected.find(
      (item) => item.contract === record.contract,
    );
    if (!declaration) {
      errors.push(
        `contractData[${index}] uses contract "${record.contract}", which the creation brief did not request`,
      );
      continue;
    }
    if (!declaration.validate(record.value)) {
      errors.push(
        `contractData[${index}] value does not match the schema of contract "${record.contract}"`,
      );
      continue;
    }
    const identity = `${record.contract}/${record.key}`;
    if (identities.has(identity)) {
      errors.push(`duplicate contractData record: ${identity}`);
      continue;
    }
    identities.add(identity);
    contractData.push({
      contract: record.contract,
      key: record.key,
      value: record.value,
      ...(declaration.lorebook ? { lorebook: true as const } : {}),
    });
  }
  for (const declaration of selected) {
    if (!contractData.some((item) => item.contract === declaration.contract))
      errors.push(
        `contractData must include at least one record for contract "${declaration.contract}"`,
      );
  }

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

  checkAmount("characters", "characters", characters.length, 3);
  checkAmount("lorebook", "lorebook entries", lorebook.length, 4);
  checkAmount("rules", "rules", rules.length, 3);

  const duplicateCharacterIds = duplicateIds(characters);
  if (duplicateCharacterIds.length > 0) {
    errors.push(`duplicate character ids: ${duplicateCharacterIds.join(", ")}`);
  }
  const duplicateLoreIds = duplicateIds([...lorebook, ...rules]);
  if (duplicateLoreIds.length > 0) {
    errors.push(`duplicate lorebook/rule ids: ${duplicateLoreIds.join(", ")}`);
  }

  return {
    content: { characters, lorebook, rules, contractData },
    errors,
    warnings,
  };
}

export function applyCreationBriefToManifest(
  manifest: Record<string, unknown>,
  brief: WorldCreationBrief | undefined,
  dataContracts: readonly WorldGenerationDataContract[] = [],
): { errors: string[]; warnings: string[] } {
  if (!brief) return { errors: [], warnings: [] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const policy = isRecord(manifest.pluginPolicy)
    ? manifest.pluginPolicy
    : (manifest.pluginPolicy = {});
  policy.presetId = brief.experienceMode ?? "traditional-story";
  // Requested content is only used when its receiving plugin is active.
  const receivers = selectedDataContracts(brief, dataContracts)
    .map((item) => item.pluginId)
    .filter((id): id is string => typeof id === "string");
  if (receivers.length > 0)
    policy.requested = [
      ...new Set([...(strings(policy.requested) ?? []), ...receivers]),
    ];
  if (brief.experienceMode === "dialogue-mode") {
    manifest.defaultViewMode = "stage";
  } else {
    delete manifest.defaultViewMode;
  }

  const requested = requestedKinds(brief);
  if (requested.has("opening-kit")) {
    const dimensions = isRecord(manifest.dimensions)
      ? manifest.dimensions
      : undefined;
    const numericResources = Object.values(dimensions ?? {}).filter(
      (definition) =>
        isRecord(definition) &&
        typeof definition.initialValue === "number" &&
        Number.isFinite(definition.initialValue),
    );
    if (numericResources.length < 2) {
      warnings.push(
        `opening kit has ${numericResources.length} numeric resource dimensions; the brief asks for 2`,
      );
    }
  }

  return { errors, warnings };
}
