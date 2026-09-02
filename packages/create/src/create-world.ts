/**
 * World package generator — uses an LLM to create the manifest, lore, and
 * requested portable supplements, then validates and writes a worldData package.
 *
 * Only requires a concept string. The LLM autonomously decides
 * all unspecified details while an optional brief constrains the experience
 * preset and supplemental package content.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  validateWorldManifest,
  formatValidationErrors,
} from "@covel/shared";
import type { LLMResponse } from "@covel/shared";
import type { CreateWorldOptions, CreateResult } from "./types.js";
import { buildWorldPrompt } from "./prompts.js";
import { parseWorldOutput } from "./lore-processor.js";
import {
  findLoreMetaErrors,
  findLoreQualityErrors,
  findLoreStructureErrors,
  isRecord,
  normalizeGeneratedManifest,
  normalizeLoreDocument,
} from "./validation-helpers.js";
import { requestLlmResponse } from "./llm-request.js";
import { repairWorldLore } from "./lore-repair.js";
import { writeWorldDataFiles } from "./world-writer.js";
import {
  applyCreationBriefToManifest,
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

export async function createWorld(
  options: CreateWorldOptions,
): Promise<CreateResult> {
  const locale = canonicalizeLocale(options.locale) ?? DEFAULT_LOCALE;
  const prompt = await buildWorldPrompt(options.concept, locale, options.brief);
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
    log(
      options,
      "info",
      `attempt ${attempt + 1}/${MAX_RETRIES + 1}: sending LLM request`,
    );
    const llmStart = Date.now();

    const messages = [
      { role: "system" as const, content: prompt },
      ...(attempt > 0
        ? [
            {
              role: "user" as const,
              content:
                `Your previous answer could not be imported:\n${lastErrors.join("\n")}\n\n` +
                `Regenerate the full package now. Start the answer with ===WORLD_YAML=== on the first line, ` +
                `then ===WORLD_MD===, then ===WORLD_PACKAGE_YAML===, then ===END===. ` +
                `Do not use markdown code fences or any extra prose.`,
            },
          ]
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

    const parsed = parseWorldOutput(response.content);
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

    const repairs = normalizeGeneratedManifest(yamlData);
    if (repairs.length > 0) {
      log(options, "info", "applied YAML repair:", repairs.join("; "));
    }

    const briefErrors = applyCreationBriefToManifest(yamlData, options.brief);
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
    const generatedPackage = normalizeGeneratedPackage(
      rawPackage,
      options.brief,
    );
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
        const msg = err instanceof Error ? err.message : String(err);
        const repairError = `WORLD.md targeted repair LLM error: ${msg}`;
        lastErrors = [...loreMetaErrors, repairError];
        log(options, "error", repairError);
        continue;
      }
    }

    // Extract id from validated data
    const id = yamlData.id as string;
    log(options, "info", `validation passed id=${id}`);

    // Write files
    const worldDir = path.join(options.outputDir, id);
    log(options, "info", "writing to", worldDir);
    await mkdir(worldDir, { recursive: true });

    const writtenFiles: string[] = [];

    // If dimensions are inline, write them through worldData and rewrite manifest.
    const dimFiles = await writeWorldDataFiles(
      worldDir,
      yamlData,
      generatedPackage.content,
    );
    if (dimFiles.length > 0) {
      log(options, "info", "wrote worldData files", dimFiles);
      writtenFiles.push(...dimFiles.map((f) => `${id}/${f}`));
    }

    // Re-serialize manifest (may now contain dimensionSources instead of dimensions)
    const finalYaml = stringifyYaml(yamlData, { lineWidth: 0 });
    await writeFile(path.join(worldDir, "world.yaml"), finalYaml, "utf-8");
    writtenFiles.push(`${id}/world.yaml`);

    await writeFile(
      path.join(worldDir, `WORLD.${locale}.md`),
      normalizedLore,
      "utf-8",
    );
    writtenFiles.push(`${id}/WORLD.${locale}.md`);
    await writeFile(path.join(worldDir, "WORLD.md"), normalizedLore, "utf-8");
    writtenFiles.push(`${id}/WORLD.md`);

    log(options, "info", `done wrote ${writtenFiles.length} files`);

    return {
      success: true,
      files: writtenFiles,
      id,
      packageContent: generatedPackage.content,
    };
  }

  log(options, "error", `all ${MAX_RETRIES + 1} attempts exhausted`);
  return {
    success: false,
    files: [],
    errors: lastErrors,
    id: "unknown",
  };
}
