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

const MAX_RETRIES = 2;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 150_000;
const GENERATED_WORLD_DATA_PATH = "data/world.data.yaml";
const GENERATED_DIMENSIONS_PATH = "data/dimensions.yaml";

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

function log(
  options: CreateWorldOptions,
  level: "info" | "warn" | "error",
  ...args: unknown[]
): void {
  options.logger?.[level](...args);
}

function parseWorldOutput(raw: string): { yaml: string; lore: string } | null {
  const cleaned = raw.trim();
  const yamlMarker = findSectionMarker(cleaned, "WORLD_YAML");
  const loreMarker = findSectionMarker(cleaned, "WORLD_MD");
  if (yamlMarker < 0 || loreMarker < 0 || loreMarker <= yamlMarker) return null;

  const loreStart = loreMarker + markerLength("WORLD_MD");
  const endMarker = findSectionMarker(cleaned, "END", loreStart);
  const yaml = cleaned.slice(
    yamlMarker + markerLength("WORLD_YAML"),
    loreMarker,
  );
  const lore =
    endMarker >= 0
      ? cleaned.slice(loreStart, endMarker)
      : cleaned.slice(loreStart);

  if (!yaml.trim() || !lore.trim()) return null;
  return {
    yaml: stripFence(yaml).trim(),
    lore: stripFence(lore).trim(),
  };
}

function findSectionMarker(
  value: string,
  marker: "WORLD_YAML" | "WORLD_MD" | "END",
  fromIndex = 0,
): number {
  const pattern = new RegExp(`(?:^|\\n)===${marker}===`, "g");
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(value);
  if (!match) return -1;
  return match[0].startsWith("\n") ? match.index + 1 : match.index;
}

function markerLength(marker: "WORLD_YAML" | "WORLD_MD" | "END"): number {
  return `===${marker}===`.length;
}

function stripFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:yaml|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function normalizeGeneratedManifest(
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

function normalizeLoreDocument(
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

function findLoreQualityErrors(lore: string): string[] {
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

function combineAbortSignals(
  primary: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!primary) return timeout;
  if (primary.aborted) return primary;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  primary.addEventListener("abort", () => abort(primary), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return controller.signal;
}

/**
 * If the manifest contains inline `dimensions`, write them through the v1
 * worldData descriptor so generated worlds use the same importer as hand-built
 * world packages.
 */
async function writeWorldDataFiles(
  worldDir: string,
  manifest: Record<string, unknown>,
): Promise<string[]> {
  const inline = manifest.dimensions as Record<string, unknown> | undefined;
  if (
    !inline ||
    typeof inline !== "object" ||
    Object.keys(inline).length === 0
  ) {
    return [];
  }

  const dataDir = path.join(worldDir, "data");
  await mkdir(dataDir, { recursive: true });

  const dimensionsPath = path.join(worldDir, GENERATED_DIMENSIONS_PATH);
  await writeFile(
    dimensionsPath,
    stringifyYaml(inline, { lineWidth: 0 }),
    "utf-8",
  );

  const descriptorPath = path.join(worldDir, GENERATED_WORLD_DATA_PATH);
  await writeFile(
    descriptorPath,
    stringifyYaml(
      {
        schemaVersion: 1,
        sources: {
          dimensions: {
            kind: "yaml",
            path: GENERATED_DIMENSIONS_PATH,
            schema: "covel://world/dimensions",
            to: "world:metadata.dimensions",
          },
        },
      },
      { lineWidth: 0 },
    ),
    "utf-8",
  );

  delete manifest.dimensions;
  delete manifest.dimensionSources;
  manifest.worldData = GENERATED_WORLD_DATA_PATH;

  return [GENERATED_DIMENSIONS_PATH, GENERATED_WORLD_DATA_PATH];
}

export async function createWorld(
  options: CreateWorldOptions,
): Promise<CreateResult> {
  const locale = options.locale ?? "zh-CN";
  const prompt = buildWorldPrompt(options.concept, locale);
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
      const signal = combineAbortSignals(
        options.signal,
        options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      );
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
