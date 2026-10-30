/**
 * World package generator — uses an LLM to create the manifest, lore, and
 * requested portable supplements, then returns validated portable content.
 *
 * Only requires a concept string. The LLM autonomously decides
 * all unspecified details while an optional brief constrains the experience
 * preset and supplemental package content.
 *
 * A new world is written one part at a time: the manifest, the lore, then
 * each requested supplement. A part is checked when it arrives and asked for
 * again alone when it cannot be imported, so a bad part does not cost the
 * parts that are already written. Protected revisions independently rewrite
 * changed public fragments after the package request.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  validateWorldManifest,
  formatValidationErrors,
} from "@covel/shared";
import type { LLMResponse, WorldGenerationPart } from "@covel/shared";
import type {
  CreateWorldOptions,
  CreateResult,
  GeneratedContractData,
  GeneratedWorldCharacter,
  GeneratedWorldLorebookEntry,
  WorldGenerationDataContract,
  WorldRevision,
} from "./types.js";
import { buildWorldPrompt } from "./prompts.js";
import { parseWorldOutput, parseWorldSection } from "./lore-processor.js";
import {
  findLoreMetaErrors,
  findLoreQualityErrors,
  findLoreStructureErrors,
  dropInvalidDimensions,
  isRecord,
  normalizeGeneratedManifest,
  normalizeLoreDocument,
} from "./validation-helpers.js";
import {
  LlmIdleTimeoutError,
  LlmIncompleteOutputError,
  requestLlmResponse,
} from "./llm-request.js";
import { repairWorldLore } from "./lore-repair.js";
import {
  applyCreationBriefToManifest,
  briefOfPackage,
  normalizeGeneratedPackage,
  selectedDataContracts,
  validateGeneratedCharacters,
} from "./package-processor.js";
import { mergeRevision, revisionRequest } from "./revision.js";
import {
  hasLoreBoundary,
  LoreBoundaryError,
  splitLore,
} from "./lore-boundaries.js";
import { reviseProtectedLore } from "./lore-revision.js";

const MAX_RETRIES = 2;
/** Least time between two progress reports of an answer that is growing. */
const PROGRESS_INTERVAL_MS = 400;

type SectionMarker = "WORLD_YAML" | "WORLD_MD" | "WORLD_PACKAGE_YAML";

interface Rejected {
  readonly errors: string[];
}

function log(
  options: CreateWorldOptions,
  level: "info" | "warn" | "error",
  ...args: unknown[]
): void {
  options.logger?.[level](...args);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The manifest of an answer after the deterministic repairs, or why it
 * cannot be imported. `yamlData` is the repaired answer; `manifest` is the
 * schema output, whose transforms and defaults are part of the manifest
 * contract shared by file and in-memory save targets.
 */
function checkManifest(
  yaml: string,
  options: CreateWorldOptions,
):
  | Rejected
  | {
      readonly yamlData: Record<string, unknown>;
      readonly manifest: Record<string, unknown>;
      readonly warnings: string[];
    } {
  let yamlData: Record<string, unknown>;
  try {
    const parsedYaml = parseYaml(yaml);
    if (!isRecord(parsedYaml)) {
      throw new Error("world.yaml must be a mapping object");
    }
    yamlData = parsedYaml;
  } catch (err) {
    return { errors: [`Invalid YAML: ${messageOf(err)}`] };
  }
  log(options, "info", "YAML parsed, keys=", Object.keys(yamlData).join(", "));

  if (options.revision) {
    // A revision is the same world: it keeps its id whatever the model wrote.
    const current = parseYaml(options.revision.current.yaml);
    if (isRecord(current) && typeof current.id === "string")
      yamlData.id = current.id;
  }
  const repairs = normalizeGeneratedManifest(yamlData);
  if (repairs.length > 0) {
    log(options, "info", "applied YAML repair:", repairs.join("; "));
  }
  if (!options.revision && typeof yamlData.id === "string") {
    const occupied = new Set(options.existingWorldIds);
    const baseId = yamlData.id;
    let suffix = 2;
    while (occupied.has(yamlData.id as string))
      yamlData.id = `${baseId}-${suffix++}`;
  }
  const warnings = dropInvalidDimensions(yamlData);
  if (warnings.length > 0) {
    log(options, "warn", warnings.join("; "));
  }

  const briefResult = applyCreationBriefToManifest(
    yamlData,
    options.brief,
    options.dataContracts,
    options.packs,
  );
  const errors = briefResult.errors;
  warnings.push(...briefResult.warnings);
  if (yamlData.worldData !== undefined) {
    errors.push(
      "Generated worlds must contain inline data, not a worldData file reference",
    );
  }
  if (errors.length > 0) return { errors };

  const validation = validateWorldManifest(yamlData);
  if (!validation.valid) {
    return {
      errors: formatValidationErrors(validation.errors!).split("\n"),
    };
  }
  return {
    yamlData,
    manifest: validation.data as Record<string, unknown>,
    warnings,
  };
}

function parsePackage(
  packageYaml: string | undefined,
): Rejected | { readonly raw: unknown } {
  if (!packageYaml) return { raw: {} };
  try {
    return { raw: parseYaml(packageYaml) };
  } catch (err) {
    return { errors: [`Invalid WORLD_PACKAGE_YAML: ${messageOf(err)}`] };
  }
}

/**
 * The lore of an answer with its heading normalized, or why it cannot be
 * imported. Explicit generation meta wording gets one targeted repair
 * request; nothing else of the world is written again for it.
 */
async function checkLore(
  lore: string,
  yamlData: Record<string, unknown>,
  locale: string,
  options: CreateWorldOptions,
  signal: AbortSignal,
): Promise<Rejected | { readonly lore: string }> {
  const protectedLore = hasLoreBoundary(splitLore(lore));
  const reject = (errors: string[]): Rejected => {
    if (protectedLore)
      throw new LoreBoundaryError(
        `${errors.join("; ")}. Protected WORLD.md was not replaced; a full-document retry could lose its hidden regions`,
      );
    return { errors };
  };
  // A protected revision's public text has a separate source. Do not add
  // headings from a manifest answer that was allowed to see hidden lore.
  const normalize = (text: string) =>
    options.revision && protectedLore
      ? text
      : normalizeLoreDocument(text, yamlData, locale);
  const normalizedLore = normalize(lore);
  const loreStructureErrors = findLoreStructureErrors(normalizedLore);
  if (loreStructureErrors.length > 0) return reject(loreStructureErrors);

  const loreMetaErrors = findLoreMetaErrors(normalizedLore);
  if (loreMetaErrors.length === 0) return { lore: normalizedLore };

  log(
    options,
    "warn",
    "explicit lore meta wording detected; requesting targeted repair",
  );
  const repairStart = Date.now();
  try {
    const repair = await repairWorldLore({
      llm: options.llm,
      loadPrompt: options.loadPrompt,
      model: options.model,
      locale,
      lore: normalizedLore,
      errors: loreMetaErrors,
      signal,
      idleTimeoutMs: options.idleTimeoutMs,
      onUsage: options.onUsage,
    });
    if (!repair.success) {
      const repairError = `WORLD.md targeted repair failed: ${repair.error}`;
      log(options, "warn", repairError);
      return reject([...loreMetaErrors, repairError]);
    }

    const repairedLore = normalize(repair.lore);
    const repairedErrors = findLoreQualityErrors(repairedLore);
    if (repairedErrors.length > 0) {
      log(
        options,
        "warn",
        "targeted WORLD.md repair remained invalid with",
        repairedErrors.length,
        "errors",
      );
      return reject(repairedErrors);
    }
    log(
      options,
      "info",
      `targeted WORLD.md repair succeeded in ${Date.now() - repairStart}ms`,
    );
    return { lore: repairedLore };
  } catch (err) {
    signal.throwIfAborted();
    if (
      err instanceof LlmIdleTimeoutError ||
      err instanceof LlmIncompleteOutputError ||
      err instanceof LoreBoundaryError
    )
      throw err;
    const repairError = `WORLD.md targeted repair LLM error: ${messageOf(err)}`;
    log(options, "error", repairError, err);
    return reject([
      ...loreMetaErrors,
      "WORLD.md repair request failed; check model configuration or server logs",
    ]);
  }
}

/**
 * Ask the model for one answer, up to three times. `take` checks an answer
 * and returns the errors when it cannot be imported; the next request tells
 * the model about them. Caller cancellation ends the operation; only a
 * failed request or a rejected answer is asked for again.
 *
 * A model that stayed silent for the idle timeout is not asked again. The
 * timeout is how long the player agreed to wait; asking again would multiply
 * that wait before the player learns that the model does not answer.
 */
async function askUntilAccepted(args: {
  readonly options: CreateWorldOptions;
  readonly signal: AbortSignal;
  readonly prompt: string;
  /** Names the request in the log. */
  readonly name: string;
  readonly request: string;
  /** What the model is told to do after an answer was rejected. */
  readonly again: string;
  readonly take: (content: string) => string[] | Promise<string[]>;
  readonly report: (change: Partial<WorldGenerationPart>) => void;
}): Promise<
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly errors: string[];
      readonly idleTimeout: boolean;
    }
> {
  const { options, signal, name } = args;
  let errors: string[] = [];
  let previousAnswer: string | undefined;
  const silent = (err: LlmIdleTimeoutError) => {
    log(options, "error", `${name}: ${err.message}`);
    args.report({ state: "failed" });
    return {
      accepted: false as const,
      errors: [`LLM error: ${err.message}`],
      idleTimeout: true,
    };
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    signal.throwIfAborted();
    log(
      options,
      "info",
      `${name} attempt ${attempt + 1}/${MAX_RETRIES + 1}: sending LLM request`,
    );
    args.report({ state: "active", attempt: attempt + 1, chars: 0 });
    const llmStart = Date.now();
    // The first text is reported at once: it shows that the model answers.
    let reportedAt = 0;

    let response: LLMResponse;
    try {
      response = await requestLlmResponse({
        llm: options.llm,
        model: options.model,
        signal,
        idleTimeoutMs: options.idleTimeoutMs,
        onUsage: options.onUsage,
        messages: [
          { role: "system", content: args.prompt },
          { role: "user", content: args.request },
          ...(previousAnswer
            ? [{ role: "assistant" as const, content: previousAnswer }]
            : []),
          ...(attempt > 0
            ? [
                {
                  role: "user" as const,
                  content: `Your previous answer could not be imported:\n${errors.join("\n")}\n\n${args.again}`,
                },
              ]
            : []),
        ],
        onText: (chars) => {
          if (Date.now() - reportedAt < PROGRESS_INTERVAL_MS) return;
          reportedAt = Date.now();
          args.report({ chars });
        },
      });
    } catch (err) {
      signal.throwIfAborted();
      if (err instanceof LlmIdleTimeoutError) return silent(err);
      if (
        err instanceof LlmIncompleteOutputError ||
        err instanceof LoreBoundaryError
      ) {
        args.report({ state: "failed" });
        return { accepted: false, errors: [err.message], idleTimeout: false };
      }
      log(
        options,
        "error",
        `${name}: LLM request failed: ${messageOf(err)}`,
        err,
      );
      errors = ["LLM request failed; check model configuration or server logs"];
      continue;
    }

    log(
      options,
      "info",
      `${name}: LLM responded in ${Date.now() - llmStart}ms contentLength=${response.content?.length ?? 0}`,
    );
    args.report({ chars: response.content?.length ?? 0 });

    if (!response.content) {
      errors = ["LLM returned empty response"];
      log(options, "warn", `${name} attempt ${attempt + 1}: empty response`);
      continue;
    }

    previousAnswer = response.content;
    try {
      errors = await args.take(response.content);
    } catch (err) {
      // A check may ask the model for a repair, which can stay silent too.
      if (err instanceof LlmIdleTimeoutError) return silent(err);
      if (
        err instanceof LlmIncompleteOutputError ||
        err instanceof LoreBoundaryError
      ) {
        args.report({ state: "failed" });
        return { accepted: false, errors: [err.message], idleTimeout: false };
      }
      throw err;
    }
    if (errors.length === 0) {
      args.report({ state: "done" });
      return { accepted: true };
    }
    log(
      options,
      "warn",
      `${name} attempt ${attempt + 1} could not be imported:`,
      errors.join("; "),
    );
  }

  log(options, "error", `${name}: all ${MAX_RETRIES + 1} attempts exhausted`);
  args.report({ state: "failed" });
  return { accepted: false, errors, idleTimeout: false };
}

/** What is written of a new world so far. Each part adds to it. */
interface Draft {
  yamlData?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  lore?: string;
  characters: readonly GeneratedWorldCharacter[];
  lorebook: readonly GeneratedWorldLorebookEntry[];
  rules: readonly GeneratedWorldLorebookEntry[];
  contractData: GeneratedContractData[];
  warnings: string[];
}

/** One request of a new world: what is asked for and how the answer is taken. */
interface PartPlan {
  readonly id: string;
  readonly title?: string;
  /** What the request calls the part. */
  readonly label: string;
  readonly marker: SectionMarker;
  /** What follows the delimiter in the answer. */
  readonly body: string;
  /**
   * A world needs its manifest and lore. Without a supplement it is still
   * playable, and the player can ask for the supplement in a revision.
   */
  readonly required: boolean;
  /** Why the part is not asked for, given what is written so far. */
  skip?(draft: Draft): string | undefined;
  /** Check the section and add it to the draft; the errors when it cannot be imported. */
  accept(section: string, draft: Draft): string[] | Promise<string[]>;
}

/**
 * Lorebook entries and rules share one id space, and each list is a request
 * of its own. A rule that took the id of a lorebook entry gets another id;
 * asking the model again for that would cost a request.
 */
function withFreeIds(
  rules: readonly GeneratedWorldLorebookEntry[],
  taken: readonly GeneratedWorldLorebookEntry[],
): GeneratedWorldLorebookEntry[] {
  const used = new Set(taken.map((item) => item.id));
  return rules.map((rule) => {
    let id = rule.id;
    for (let suffix = 2; used.has(id); suffix++) id = `${rule.id}-${suffix}`;
    used.add(id);
    return id === rule.id ? rule : { ...rule, id };
  });
}

function listPart(kind: "characters" | "lorebook" | "rules"): PartPlan {
  return {
    id: kind,
    label: `the \`${kind}\` list of WORLD_PACKAGE_YAML`,
    marker: "WORLD_PACKAGE_YAML",
    body: `only the key \`${kind}\` with its items`,
    required: false,
    accept(section, draft) {
      const parsed = parsePackage(section);
      if ("errors" in parsed) return parsed.errors;
      // The answer is read for this list alone; anything else in it is not used.
      const result = normalizeGeneratedPackage(
        { [kind]: isRecord(parsed.raw) ? parsed.raw[kind] : undefined },
        { content: [kind] },
      );
      if (result.errors.length > 0) return result.errors;
      if (kind === "characters") {
        const errors = validateGeneratedCharacters(
          result.content.characters,
          draft.manifest!,
        );
        if (errors.length > 0) return errors;
      }
      draft.warnings.push(...result.warnings);
      if (kind === "characters") draft.characters = result.content.characters;
      else if (kind === "lorebook") draft.lorebook = result.content.lorebook;
      else draft.rules = withFreeIds(result.content.rules, draft.lorebook);
      return [];
    },
  };
}

function contractPart(
  contract: WorldGenerationDataContract,
  dataContracts: readonly WorldGenerationDataContract[],
): PartPlan {
  const inCharacters = contract.characterField !== undefined;
  return {
    id: `contract:${contract.contract}`,
    title: contract.title ?? contract.contract,
    label: inCharacters
      ? `the \`contractData\` records of contract "${contract.contract}", one for each character, with \`key\` set to the character's \`id\``
      : `the \`contractData\` records of contract "${contract.contract}"`,
    marker: "WORLD_PACKAGE_YAML",
    body: "only the key `contractData` with the records of this contract",
    required: false,
    // Its records go into the records of the characters.
    ...(inCharacters
      ? {
          skip: (draft: Draft) =>
            draft.characters.length === 0
              ? "the world has no characters to write it for"
              : undefined,
        }
      : {}),
    accept(section, draft) {
      const parsed = parsePackage(section);
      if ("errors" in parsed) return parsed.errors;
      const records = isRecord(parsed.raw)
        ? parsed.raw.contractData
        : undefined;
      // Records of another contract belong to the part of that contract.
      const result = normalizeGeneratedPackage(
        {
          contractData: Array.isArray(records)
            ? records.filter(
                (record) =>
                  !isRecord(record) ||
                  typeof record.contract !== "string" ||
                  record.contract === contract.contract,
              )
            : records,
        },
        { contracts: [contract.contract] },
        dataContracts,
        { characters: draft.characters },
      );
      if (result.errors.length > 0) return result.errors;
      draft.warnings.push(...result.warnings);
      draft.contractData.push(...(result.content.contractData ?? []));
      draft.characters = result.content.characters;
      return [];
    },
  };
}

/** The parts of a new world, in the order they are written. */
function planParts(
  options: CreateWorldOptions,
  locale: string,
  signal: AbortSignal,
): PartPlan[] {
  const requested = new Set(options.brief?.content ?? []);
  const dataContracts = options.dataContracts ?? [];
  return [
    {
      id: "manifest",
      label: "WORLD_YAML",
      marker: "WORLD_YAML",
      body: "the complete world.yaml",
      required: true,
      accept(section, draft) {
        // A new generation writes one edition. Do not apply this to revisions.
        let singleEdition: string;
        try {
          const manifest = parseYaml(section);
          singleEdition = isRecord(manifest)
            ? stringifyYaml(
                {
                  ...manifest,
                  defaultLocale: locale,
                },
                { lineWidth: 0 },
              )
            : section;
        } catch {
          singleEdition = section;
        }
        const checked = checkManifest(singleEdition, options);
        if ("errors" in checked) return checked.errors;
        draft.yamlData = checked.yamlData;
        draft.manifest = checked.manifest;
        draft.warnings.push(...checked.warnings);
        return [];
      },
    },
    {
      id: "lore",
      label: "WORLD_MD",
      marker: "WORLD_MD",
      body: "the complete WORLD.md",
      required: true,
      async accept(section, draft) {
        const checked = await checkLore(
          section,
          draft.yamlData!,
          locale,
          options,
          signal,
        );
        if ("errors" in checked) return checked.errors;
        draft.lore = checked.lore;
        return [];
      },
    },
    ...(["characters", "lorebook", "rules"] as const)
      .filter((kind) => requested.has(kind))
      .map(listPart),
    ...selectedDataContracts(options.brief, dataContracts).map((contract) =>
      contractPart(contract, dataContracts),
    ),
  ];
}

/** What the model is asked for when it writes one part of a new world. */
function partRequest(plan: PartPlan, draft: Draft): string {
  const written = [
    ...(draft.yamlData
      ? [
          "===WORLD_YAML===",
          stringifyYaml(draft.yamlData, { lineWidth: 0 }).trim(),
        ]
      : []),
    ...(draft.lore ? ["===WORLD_MD===", draft.lore] : []),
    ...(draft.characters.length +
      draft.lorebook.length +
      draft.rules.length +
      draft.contractData.length >
    0
      ? [
          "===WORLD_PACKAGE_YAML===",
          stringifyYaml(
            {
              characters: draft.characters,
              lorebook: draft.lorebook,
              rules: draft.rules,
              contractData: draft.contractData,
            },
            { lineWidth: 0 },
          ).trim(),
        ]
      : []),
  ];
  return [
    ...(written.length > 0
      ? [
          "",
          "The accepted parts are below. Keep their names and facts. Do not define a new record with an ID already used in its namespace (lorebook and rules share one). References to existing characters, dimensions or contract records must use their exact IDs. A character contract's key references a character; it does not define a new character. Do not write completed parts again.",
          "",
          ...written,
          "===END===",
        ]
      : []),
    `Write one part of the world package now: ${plan.label}.`,
    `Return the delimiter ===${plan.marker}=== on the first line, then ${plan.body}, then ===END===. Do not write any other part.`,
  ].join("\n");
}

async function writeNewWorld(
  options: CreateWorldOptions,
  locale: string,
  prompt: string,
  signal: AbortSignal,
): Promise<CreateResult> {
  const draft: Draft = {
    characters: [],
    lorebook: [],
    rules: [],
    contractData: [],
    warnings: [],
  };
  const plans = planParts(options, locale, signal);
  const parts: WorldGenerationPart[] = plans.map((plan) => ({
    id: plan.id,
    ...(plan.title ? { title: plan.title } : {}),
    state: "pending",
  }));
  options.onProgress?.([...parts]);

  for (const [index, plan] of plans.entries()) {
    const skipped = plan.skip?.(draft);
    if (skipped) {
      parts[index] = { ...parts[index]!, state: "failed" };
      options.onProgress?.([...parts]);
      draft.warnings.push(
        `${plan.title ?? plan.id} was not requested: ${skipped}`,
      );
      continue;
    }
    const result = await askUntilAccepted({
      options,
      signal,
      prompt,
      name: plan.id,
      request: partRequest(plan, draft),
      again: `Write this part again. Start the answer with ===${plan.marker}=== on the first line and end it with ===END===. Do not use markdown code fences or any extra prose.`,
      take: (content) => {
        const section = parseWorldSection(content, plan.marker);
        return section
          ? plan.accept(section, draft)
          : [
              `Failed to parse output — expected the ===${plan.marker}=== delimiter`,
            ];
      },
      report: (change) => {
        parts[index] = { ...parts[index]!, ...change };
        options.onProgress?.([...parts]);
      },
    });
    if (result.accepted) continue;
    if (plan.required) {
      return {
        success: false,
        errors: result.errors,
        id: "unknown",
        ...(result.idleTimeout ? { idleTimeout: true as const } : {}),
      };
    }
    const warning = `${plan.title ?? plan.id} could not be generated: ${result.errors[0] ?? "unknown error"}`;
    log(options, "warn", warning);
    draft.warnings.push(warning);
    if (!result.idleTimeout) continue;
    // A model that stopped answering would keep every later part waiting
    // just as long. The world is finished with the parts it has.
    for (const [later, rest] of plans.entries()) {
      if (later <= index) continue;
      parts[later] = { ...parts[later]!, state: "failed" };
      draft.warnings.push(
        `${rest.title ?? rest.id} was not requested: the model stopped answering`,
      );
    }
    options.onProgress?.([...parts]);
    break;
  }

  const manifest = draft.manifest!;
  const id = manifest.id as string;
  log(options, "info", `validation passed id=${id}`);
  return {
    success: true,
    id,
    manifest,
    lore: draft.lore!,
    locale,
    packageContent: {
      characters: draft.characters,
      lorebook: draft.lorebook,
      rules: draft.rules,
      contractData: draft.contractData,
    },
    warnings: draft.warnings,
  };
}

async function reviseWorld(
  options: CreateWorldOptions,
  revision: WorldRevision,
  locale: string,
  prompt: string,
  signal: AbortSignal,
): Promise<CreateResult> {
  try {
    splitLore(revision.current.lore);
  } catch (error) {
    if (!(error instanceof LoreBoundaryError)) throw error;
    return { success: false, id: "unknown", errors: [error.message] };
  }
  let part: WorldGenerationPart = { id: "revision", state: "pending" };
  const revised: { world?: CreateResult } = {};

  const result = await askUntilAccepted({
    options,
    signal,
    prompt,
    name: "revision",
    request: revisionRequest(revision),
    again:
      `Correct the revision patch, preserving omitted items and UNCHANGED sections. Start the answer with ===WORLD_YAML=== on the first line, ` +
      `then ===WORLD_MD===, then ===WORLD_PACKAGE_YAML===, then ===END===. ` +
      `Do not use markdown code fences or any extra prose.`,
    take: async (content) => {
      const output = parseWorldOutput(content);
      if (!output) {
        return [
          "Failed to parse output — expected ===WORLD_YAML=== and ===WORLD_MD=== delimiters",
        ];
      }
      const parsed = mergeRevision(
        output,
        revision.current,
        options.dataContracts,
      );
      log(
        options,
        "info",
        "parsed OK: yamlLength=",
        parsed.yaml.length,
        "loreLength=",
        parsed.lore.length,
        "packageLength=",
        parsed.packageYaml?.length ?? 0,
      );

      const checked = checkManifest(parsed.yaml, options);
      if ("errors" in checked) return checked.errors;

      const rawPackage = parsePackage(parsed.packageYaml);
      if ("errors" in rawPackage) return rawPackage.errors;
      const generatedPackage = normalizeGeneratedPackage(
        rawPackage.raw,
        briefOfPackage(rawPackage.raw),
        options.dataContracts,
        { amounts: false },
      );
      if (generatedPackage.errors.length > 0) return generatedPackage.errors;
      const characterErrors = validateGeneratedCharacters(
        generatedPackage.content.characters,
        checked.manifest,
      );
      if (characterErrors.length > 0) return characterErrors;

      const protectedLore = await reviseProtectedLore({
        ...options,
        revision,
        proposed: parsed.lore,
        locale,
        signal,
      });
      const lore = await checkLore(
        protectedLore,
        checked.yamlData,
        locale,
        options,
        signal,
      );
      if ("errors" in lore) return lore.errors;

      const id = checked.manifest.id as string;
      log(options, "info", `validation passed id=${id}`);
      revised.world = {
        success: true,
        id,
        manifest: checked.manifest,
        lore: lore.lore,
        locale,
        packageContent: generatedPackage.content,
        warnings: [...checked.warnings, ...generatedPackage.warnings],
      };
      return [];
    },
    report: (change) => {
      part = { ...part, ...change };
      options.onProgress?.([part]);
    },
  });

  if (result.accepted) return revised.world!;
  return {
    success: false,
    errors: result.errors,
    id: "unknown",
    ...(result.idleTimeout ? { idleTimeout: true as const } : {}),
  };
}

export async function createWorld(
  options: CreateWorldOptions,
): Promise<CreateResult> {
  // A named text slot uses request bindings before the server configuration,
  // including the gateway's same-tag fallback when the slot is not configured.
  options = { ...options, model: options.model ?? "story" };
  options.signal?.throwIfAborted();
  const locale = canonicalizeLocale(options.locale) ?? DEFAULT_LOCALE;
  const prompt = await buildWorldPrompt(
    options.concept,
    locale,
    options.brief,
    options.loadPrompt,
    options.dataContracts,
    options.packs,
    options.revision,
  );
  log(
    options,
    "info",
    'start concept="',
    options.concept,
    '" locale=',
    locale,
    "model=",
    options.model ?? "default",
  );

  const signal = options.signal ?? new AbortController().signal;
  return options.revision
    ? reviseWorld(options, options.revision, locale, prompt, signal)
    : writeNewWorld(options, locale, prompt, signal);
}
