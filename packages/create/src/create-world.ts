/**
 * World package generator — uses LLM to create world.yaml + WORLD.md,
 * validates against worldManifestSchema, and writes a worldData descriptor.
 *
 * Only requires a concept string. The LLM autonomously decides
 * all details (id, name, tags, dimensions, lore).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { validateWorldManifest, formatValidationErrors } from "@covel/shared";
import type { CreateWorldOptions, CreateResult } from "./types.js";
import { buildWorldPrompt } from "./prompts.js";
import { parseWorldOutput } from "./lore-processor.js";
import {
  findLoreQualityErrors,
  isRecord,
  normalizeGeneratedManifest,
  normalizeLoreDocument,
} from "./validation-helpers.js";
import { writeWorldDataFiles } from "./world-writer.js";

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
  const locale = options.locale ?? "zh-CN";
  const prompt = await buildWorldPrompt(options.concept, locale);
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
                `then ===WORLD_MD===, then ===END===. Do not use markdown code fences or any extra prose.`,
            },
          ]
        : [{ role: "user" as const, content: options.concept }]),
    ];

    let response;
    try {
      const timeout = AbortSignal.timeout(
        options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      );
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      if (options.llm.stream) {
        let content = "";
        let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
        let reasoningContent = "";
        for await (const event of options.llm.stream({
          model: options.model,
          messages,
          signal,
        })) {
          if (event.type === "text-delta") {
            content += event.textDelta;
          } else if (event.type === "done") {
            finishReason =
              event.finishReason === "tool_calls" ||
              event.finishReason === "length" ||
              event.finishReason === "error"
                ? event.finishReason
                : "stop";
            reasoningContent = event.reasoningContent ?? "";
          }
        }
        response = {
          content: content || null,
          toolCalls: [],
          finishReason,
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(reasoningContent ? { reasoningContent } : {}),
        };
      } else {
        response = await options.llm.generate({
          model: options.model,
          messages,
          signal,
        });
      }
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

    const normalizedLore = normalizeLoreDocument(parsed.lore, yamlData, locale);
    const loreQualityErrors = findLoreQualityErrors(normalizedLore);
    if (loreQualityErrors.length > 0) {
      lastErrors = loreQualityErrors;
      log(
        options,
        "warn",
        "attempt",
        attempt + 1,
        "lore quality failed with",
        loreQualityErrors.length,
        "errors",
      );
      continue;
    }

    // Extract id from validated data
    const id = yamlData.id as string;
    const lang = locale.split("-")[0];
    log(options, "info", `validation passed id=${id}`);

    // Write files
    const worldDir = path.join(options.outputDir, id);
    log(options, "info", "writing to", worldDir);
    await mkdir(worldDir, { recursive: true });

    const writtenFiles: string[] = [];

    // If dimensions are inline, write them through worldData and rewrite manifest.
    const dimFiles = await writeWorldDataFiles(worldDir, yamlData);
    if (dimFiles.length > 0) {
      log(options, "info", "wrote worldData files", dimFiles);
      writtenFiles.push(...dimFiles.map((f) => `${id}/${f}`));
    }

    // Re-serialize manifest (may now contain dimensionSources instead of dimensions)
    const finalYaml = stringifyYaml(yamlData, { lineWidth: 0 });
    await writeFile(path.join(worldDir, "world.yaml"), finalYaml, "utf-8");
    writtenFiles.push(`${id}/world.yaml`);

    await writeFile(
      path.join(worldDir, `WORLD.${lang}.md`),
      normalizedLore,
      "utf-8",
    );
    writtenFiles.push(`${id}/WORLD.${lang}.md`);
    await writeFile(path.join(worldDir, "WORLD.md"), normalizedLore, "utf-8");
    writtenFiles.push(`${id}/WORLD.md`);

    log(options, "info", `done wrote ${writtenFiles.length} files`);

    return {
      success: true,
      files: writtenFiles,
      id,
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
