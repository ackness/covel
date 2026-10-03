/**
 * World package generator — uses an LLM to create the manifest, lore, and
 * requested portable supplements, then returns validated portable content.
 *
 * Only requires a concept string. The LLM autonomously decides
 * all unspecified details while an optional brief constrains the experience
 * preset and supplemental package content.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  validateWorldManifest,
  formatValidationErrors,
} from "@covel/shared";
import type { LLMResponse } from "@covel/shared";
import type {
  CreateWorldOptions,
  CreateResult,
  WorldRevision,
  WorldSections,
} from "./types.js";
import { buildWorldPrompt } from "./prompts.js";
import { parseWorldOutput } from "./lore-processor.js";
import {
  findLoreMetaErrors,
  findLoreQualityErrors,
  findLoreStructureErrors,
  dropInvalidDimensions,
  isRecord,
  normalizeGeneratedManifest,
  normalizeLoreDocument,
} from "./validation-helpers.js";
import { requestLlmResponse } from "./llm-request.js";
import { repairWorldLore } from "./lore-repair.js";
import {
  applyCreationBriefToManifest,
  briefOfPackage,
  normalizeGeneratedPackage,
} from "./package-processor.js";

const MAX_RETRIES = 2;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 150_000;

function log(
  options: CreateWorldOptions,
  level: "info" | "warn" | "error",
  ...args: unknown[]
): void {
  options.logger?.[level](...args);
}

const UNCHANGED = /^\s*UNCHANGED\s*\.?\s*$/i;

/** What the model is asked for when it revises a world. */
function revisionRequest(revision: WorldRevision): string {
  const { current, instruction } = revision;
  return [
    "Revise the world package below. Change only what this request asks for:",
    "",
    instruction.trim(),
    "",
    "Return the three sections in the same format, and write only what you change:",
    "- A section that the request does not change: write the single word UNCHANGED as its body.",
    "- In WORLD_YAML, write only the fields you change. In `dimensions`, write only the dimensions you change, each one whole. A field or a dimension you leave out stays as it is.",
    "- In WORLD_PACKAGE_YAML, write only the items you add or change, under their list (`characters`, `lorebook`, `rules`, `contractData`). An item is matched by its `id` (in `contractData`, by `contract` and `key`) and is written whole. An item or a list you leave out stays as it is. To remove an item, write it as `{ id: <its id>, remove: true }`.",
    "- Do not rewrite text that the request does not concern. Keep the `id` of the world.",
    "",
    "===WORLD_YAML===",
    current.yaml.trim(),
    "===WORLD_MD===",
    current.lore.trim(),
    "===WORLD_PACKAGE_YAML===",
    (current.packageYaml ?? "{}").trim(),
    "===END===",
  ].join("\n");
}

/** Parse a section as a YAML mapping; undefined when it is not one. */
function mapping(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = parseYaml(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The manifest after a revision: the fields the model wrote, over the
 * current ones. `dimensions` is merged one dimension at a time, so a request
 * about one dimension does not have to repeat the others; `null` removes one.
 */
function mergeManifest(
  current: Record<string, unknown>,
  revised: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current, ...revised };
  if (isRecord(current.dimensions) || isRecord(revised.dimensions)) {
    const dimensions: Record<string, unknown> = {
      ...(isRecord(current.dimensions) ? current.dimensions : {}),
      ...(isRecord(revised.dimensions) ? revised.dimensions : {}),
    };
    for (const [id, definition] of Object.entries(dimensions))
      if (definition === null) delete dimensions[id];
    merged.dimensions = dimensions;
  }
  return merged;
}

/** What names an item of a package list: its id, or contract and key. */
function itemKey(list: string, item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  if (list === "contractData")
    return typeof item.contract === "string" && typeof item.key === "string"
      ? `${item.contract}/${item.key}`
      : undefined;
  return typeof item.id === "string" ? item.id : undefined;
}

/**
 * A list after a revision: the items the model wrote replace the ones of the
 * same id or are added at the end, `remove: true` takes one out, and every
 * item it did not write stays as it is. A request to add one character then
 * cannot alter the others.
 */
function mergeList(
  list: string,
  current: readonly unknown[],
  revised: readonly unknown[],
): unknown[] {
  const written = new Map<string, unknown>();
  const unnamed: unknown[] = [];
  for (const item of revised) {
    const key = itemKey(list, item);
    if (key === undefined) unnamed.push(item);
    else written.set(key, item);
  }
  const removed = (item: unknown) => isRecord(item) && item.remove === true;
  const merged: unknown[] = [];
  for (const item of current) {
    const key = itemKey(list, item);
    const next = key === undefined ? undefined : written.get(key);
    if (key !== undefined) written.delete(key);
    if (next === undefined) merged.push(item);
    else if (!removed(next)) merged.push(next);
  }
  return [
    ...merged,
    ...[...written.values()].filter((item) => !removed(item)),
    // An item with no id is passed on; the checks report it.
    ...unnamed,
  ];
}

/** The package after a revision: each list the model wrote, merged into the current one. */
function mergePackage(
  current: Record<string, unknown>,
  revised: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(revised)) {
    if (typeof value === "string" && UNCHANGED.test(value)) continue;
    merged[key] =
      Array.isArray(value) && Array.isArray(current[key])
        ? mergeList(key, current[key], value)
        : value;
  }
  return merged;
}

/**
 * The sections of the revised world: what the model wrote, over what the
 * world has. A section it marks `UNCHANGED`, a field or a list it does not
 * write, stays as it is. This is what keeps a request to "add a character"
 * from dropping the lore entries the model did not repeat.
 *
 * A section that does not parse is passed on as written, so that the checks
 * report it and the model is asked again.
 */
function mergeRevision(
  output: WorldSections,
  current: WorldSections,
): WorldSections {
  const merge = (
    written: string | undefined,
    existing: string | undefined,
    combine: typeof mergeManifest,
  ): string | undefined => {
    if (written === undefined || UNCHANGED.test(written)) return existing;
    const revised = mapping(written);
    const base = mapping(existing);
    return revised && base
      ? stringifyYaml(combine(base, revised), { lineWidth: 0 })
      : written;
  };
  const packageYaml = merge(
    output.packageYaml,
    current.packageYaml,
    mergePackage,
  );
  return {
    yaml: merge(output.yaml, current.yaml, mergeManifest) ?? output.yaml,
    lore: UNCHANGED.test(output.lore) ? current.lore : output.lore,
    ...(packageYaml !== undefined ? { packageYaml } : {}),
  };
}

export async function createWorld(
  options: CreateWorldOptions,
): Promise<CreateResult> {
  options.signal?.throwIfAborted();
  const locale = canonicalizeLocale(options.locale) ?? DEFAULT_LOCALE;
  const prompt = await buildWorldPrompt(
    options.concept,
    locale,
    options.brief,
    options.loadPrompt,
    options.dataContracts,
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

  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Caller cancellation ends the operation; only attempt failures may retry.
    options.signal?.throwIfAborted();
    log(
      options,
      "info",
      `attempt ${attempt + 1}/${MAX_RETRIES + 1}: sending LLM request`,
    );
    const llmStart = Date.now();

    const retry = {
      role: "user" as const,
      content:
        `Your previous answer could not be imported:\n${lastErrors.join("\n")}\n\n` +
        `Regenerate the full package now. Start the answer with ===WORLD_YAML=== on the first line, ` +
        `then ===WORLD_MD===, then ===WORLD_PACKAGE_YAML===, then ===END===. ` +
        `Do not use markdown code fences or any extra prose.`,
    };
    const messages = [
      { role: "system" as const, content: prompt },
      ...(options.revision
        ? [
            {
              role: "user" as const,
              content: revisionRequest(options.revision),
            },
            ...(attempt > 0 ? [retry] : []),
          ]
        : attempt > 0
          ? [retry]
          : [{ role: "user" as const, content: options.concept }]),
    ];

    let response: LLMResponse;
    let attemptSignal: AbortSignal;
    try {
      const timeout = AbortSignal.timeout(
        options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      );
      attemptSignal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      response = await requestLlmResponse({
        llm: options.llm,
        model: options.model,
        messages,
        signal: attemptSignal,
      });
    } catch (err) {
      options.signal?.throwIfAborted();
      const msg = err instanceof Error ? err.message : String(err);
      log(options, "error", `LLM generate() threw: ${msg}`);
      lastErrors = [`LLM error: ${msg}`];
      continue;
    }

    log(
      options,
      "info",
      `LLM responded in ${Date.now() - llmStart}ms contentLength=${response.content?.length ?? 0}`,
    );

    if (!response.content) {
      lastErrors = ["LLM returned empty response"];
      log(options, "warn", "attempt", attempt + 1, "empty response");
      continue;
    }

    const output = parseWorldOutput(response.content);
    const parsed =
      output && options.revision
        ? mergeRevision(output, options.revision.current)
        : output;
    if (!parsed) {
      lastErrors = [
        "Failed to parse output — expected ===WORLD_YAML=== and ===WORLD_MD=== delimiters",
      ];
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
        "parseWorldOutput failed (delimiters missing)",
      );
      continue;
    }

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

    // Parse and validate YAML
    let yamlData: Record<string, unknown>;
    try {
      const parsedYaml = parseYaml(parsed.yaml);
      if (!isRecord(parsedYaml)) {
        throw new Error("world.yaml must be a mapping object");
      }
      yamlData = parsedYaml;
    } catch (err) {
      lastErrors = [
        `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ];
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
        "YAML parse failed:",
        lastErrors[0],
      );
      continue;
    }

    log(
      options,
      "info",
      "YAML parsed, keys=",
      Object.keys(yamlData).join(", "),
    );

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
    const warnings = dropInvalidDimensions(yamlData);
    if (warnings.length > 0) {
      log(options, "warn", warnings.join("; "));
    }

    const briefResult = applyCreationBriefToManifest(
      yamlData,
      options.brief,
      options.dataContracts,
    );
    const briefErrors = briefResult.errors;
    warnings.push(...briefResult.warnings);
    if (
      yamlData.worldData !== undefined ||
      yamlData.dimensionSources !== undefined
    ) {
      briefErrors.push(
        "Generated worlds must contain inline data, not worldData or dimensionSources file references",
      );
    }
    if (briefErrors.length > 0) {
      lastErrors = briefErrors;
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
        "creation brief requirements failed with",
        lastErrors.length,
        "errors",
      );
      continue;
    }

    let rawPackage: unknown = {};
    if (parsed.packageYaml) {
      try {
        rawPackage = parseYaml(parsed.packageYaml);
      } catch (err) {
        lastErrors = [
          `Invalid WORLD_PACKAGE_YAML: ${err instanceof Error ? err.message : String(err)}`,
        ];
        log(options, "warn", "package YAML parse failed:", lastErrors[0]);
        continue;
      }
    }
    const generatedPackage = options.revision
      ? normalizeGeneratedPackage(
          rawPackage,
          briefOfPackage(rawPackage),
          options.dataContracts,
          { amounts: false },
        )
      : normalizeGeneratedPackage(
          rawPackage,
          options.brief,
          options.dataContracts,
        );
    warnings.push(...generatedPackage.warnings);
    if (generatedPackage.errors.length > 0) {
      lastErrors = generatedPackage.errors;
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
        "package content failed with",
        lastErrors.length,
        "errors",
      );
      continue;
    }

    const validation = validateWorldManifest(yamlData);
    if (!validation.valid) {
      lastErrors = formatValidationErrors(validation.errors!).split("\n");
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
        "validation failed with",
        lastErrors.length,
        "errors",
      );
      continue;
    }

    let normalizedLore = normalizeLoreDocument(parsed.lore, yamlData, locale);
    const loreStructureErrors = findLoreStructureErrors(normalizedLore);
    if (loreStructureErrors.length > 0) {
      lastErrors = loreStructureErrors;
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
        "lore structure failed with",
        loreStructureErrors.length,
        "errors",
      );
      continue;
    }

    const loreMetaErrors = findLoreMetaErrors(normalizedLore);
    if (loreMetaErrors.length > 0) {
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
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
          signal: attemptSignal,
        });
        if (!repair.success) {
          const repairError = `WORLD.md targeted repair failed: ${repair.error}`;
          lastErrors = [...loreMetaErrors, repairError];
          log(options, "warn", repairError);
          continue;
        }

        const repairedLore = normalizeLoreDocument(
          repair.lore,
          yamlData,
          locale,
        );
        const repairedErrors = findLoreQualityErrors(repairedLore);
        if (repairedErrors.length > 0) {
          lastErrors = repairedErrors;
          log(
            options,
            "warn",
            "targeted WORLD.md repair remained invalid with",
            repairedErrors.length,
            "errors",
          );
          continue;
        }
        normalizedLore = repairedLore;
        log(
          options,
          "info",
          `targeted WORLD.md repair succeeded in ${Date.now() - repairStart}ms`,
        );
      } catch (err) {
        options.signal?.throwIfAborted();
        const msg = err instanceof Error ? err.message : String(err);
        const repairError = `WORLD.md targeted repair LLM error: ${msg}`;
        lastErrors = [...loreMetaErrors, repairError];
        log(options, "error", repairError);
        continue;
      }
    }

    // Use the parsed output: schema transforms and defaults are part of the
    // manifest contract shared by file and in-memory save targets.
    const manifest = validation.data as Record<string, unknown>;
    const id = manifest.id as string;
    log(options, "info", `validation passed id=${id}`);

    attemptSignal.throwIfAborted();
    return {
      success: true,
      id,
      manifest,
      lore: normalizedLore,
      locale,
      packageContent: generatedPackage.content,
      warnings,
    };
  }

  log(options, "error", `all ${MAX_RETRIES + 1} attempts exhausted`);
  return {
    success: false,
    errors: lastErrors,
    id: "unknown",
  };
}
