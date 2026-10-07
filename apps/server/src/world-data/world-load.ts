import { homedir } from "node:os";
import path from "node:path";
import {
  worldDimensionsSchema,
  type WorldDataMetadataSummary,
} from "@covel/shared";
import { digestFile, sha256Hex } from "./digest.js";
import { worldHasData } from "./conventions.js";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { findLocaleOverlays } from "./locale-overlays.js";
import { readWorldDataSource } from "./source-reader.js";
import {
  resolveWorldDataSchema,
  validateWorldDataSchemaValue,
} from "./schema-registry.js";
import {
  parseWorldDataIndexTarget,
  parseWorldDataTarget,
} from "./target-uri.js";
import { collectMediaSourceFiles } from "./media.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

function countDiagnostics(diagnostics: readonly WorldDataDiagnostic[]): {
  info: number;
  warning: number;
  error: number;
} {
  return {
    info: diagnostics.filter((diagnostic) => diagnostic.level === "info")
      .length,
    warning: diagnostics.filter((diagnostic) => diagnostic.level === "warning")
      .length,
    error: diagnostics.filter((diagnostic) => diagnostic.level === "error")
      .length,
  };
}

function setMetadataPath(
  metadata: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  let current = metadata;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const existing = current[segment];
    if (
      existing === null ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

async function validateSourceSchema(
  source: OrderedWorldDataSource,
  value: unknown,
): Promise<readonly WorldDataDiagnostic[]> {
  if (!source.descriptor.schema) return [];
  if (source.descriptor.schema.startsWith("contract:")) {
    return [];
  }
  const schema = await resolveWorldDataSchema({ source });
  if (!schema) return [];
  if ("level" in schema) {
    return [{ sourceId: source.id, ...schema }];
  }
  const validation = validateWorldDataSchemaValue({
    schema,
    source,
    value,
    label: `worldData source "${source.id}" value`,
  });
  return validation ? [validation] : [];
}

async function summarizeSource(
  source: OrderedWorldDataSource,
  metadata: Record<string, unknown>,
  defaultLocale: string | undefined,
): Promise<{
  digest: string;
  diagnostics: readonly WorldDataDiagnostic[];
}> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const parsedTarget = parseWorldDataTarget(source.descriptor.to);
  if (!parsedTarget) {
    diagnostics.push({
      level: "error",
      sourceId: source.id,
      message: `invalid target URI: ${source.descriptor.to}`,
    });
  }
  if (
    source.descriptor.indexTo &&
    !parseWorldDataIndexTarget(source.descriptor.indexTo)
  ) {
    diagnostics.push({
      level: "error",
      sourceId: source.id,
      message: `invalid indexTo URI: ${source.descriptor.indexTo}`,
    });
  }

  const isDimensions =
    parsedTarget?.kind === "world-metadata" &&
    parsedTarget.path.join(".") === "dimensions";
  // The catalog shows dimension labels in the viewer's language, so their
  // overlays are compiled into locale maps. Other sources are content and are
  // read in their main language here.
  const read = await readWorldDataSource(
    source,
    undefined,
    isDimensions
      ? { overlays: { mode: "compile", baseLocale: defaultLocale } }
      : {},
  );
  diagnostics.push(...read.diagnostics);
  if (!read.path) {
    return { digest: sha256Hex(`${source.id}:missing`), diagnostics };
  }

  if (source.descriptor.kind === "media") {
    const media = await collectMediaSourceFiles(source, read.path);
    diagnostics.push(...media.diagnostics);
    return { digest: media.digest, diagnostics };
  }

  diagnostics.push(...(await validateSourceSchema(source, read.value)));
  // A translation is part of the source: changing an overlay changes the
  // digest, so a world sync sees it.
  const overlayDigests = await Promise.all(
    (
      await findLocaleOverlays(
        source.pathOrigin.descriptorRoot,
        source.descriptor.path,
      )
    ).map(
      async (overlay) =>
        `${overlay.file}:${(await digestFile(overlay.path)).digest}`,
    ),
  );
  const mainDigest = (await digestFile(read.path)).digest;
  const digest =
    overlayDigests.length > 0
      ? sha256Hex([mainDigest, ...overlayDigests].join("\n"))
      : mainDigest;
  if (parsedTarget?.kind === "characters" && Array.isArray(read.value)) {
    metadata.embeddedCharacters = [
      ...(Array.isArray(metadata.embeddedCharacters)
        ? metadata.embeddedCharacters
        : []),
      ...read.value,
    ];
  }
  if (
    parsedTarget?.kind === "world-metadata" &&
    parsedTarget.path.join(".") === "dimensions" &&
    diagnostics.every((d) => d.level !== "error")
  ) {
    const definitions = worldDimensionsSchema.safeParse(read.value);
    if (definitions.success)
      setMetadataPath(metadata, parsedTarget.path, definitions.data);
    else
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        message: `Invalid dimension declarations: ${definitions.error.message}`,
      });
  } else if (parsedTarget?.kind === "world-metadata") {
    diagnostics.push({
      level: "warning",
      sourceId: source.id,
      message: `world-load MVP only projects world:metadata.dimensions; ${source.descriptor.to} is recorded in summary only`,
    });
  }
  return { digest, diagnostics };
}

export async function loadWorldDataSummary(options: {
  worldRoot: string;
  worldId: string;
  worldDataPath?: string;
  /** Locale of the package's main files. */
  defaultLocale?: string;
  covelHome?: string;
  /** Package validation reads shipped data, not local overrides. */
  includeOverrides?: boolean;
  metadata?: Record<string, unknown>;
  now?: string;
}): Promise<{
  metadata: Record<string, unknown>;
  summary?: WorldDataMetadataSummary;
  diagnostics: readonly WorldDataDiagnostic[];
}> {
  const metadata = { ...options.metadata };
  if (!(await worldHasData(options.worldRoot, options.worldDataPath))) {
    return { metadata, diagnostics: [] };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot: options.worldRoot,
    worldId: options.worldId,
    worldDataPath: options.worldDataPath,
    covelHome:
      options.includeOverrides === false
        ? undefined
        : (options.covelHome ??
          process.env.COVEL_HOME ??
          path.join(homedir(), ".covel")),
  });
  const allDiagnostics: WorldDataDiagnostic[] = [...descriptor.diagnostics];
  const sources: Array<WorldDataMetadataSummary["sources"][number]> = [];
  const importedAt = options.now ?? new Date().toISOString();

  for (const source of descriptor.sources) {
    const result = await summarizeSource(
      source,
      metadata,
      options.defaultLocale,
    );
    const sourceDiagnostics = [
      ...descriptor.diagnostics.filter(
        (diagnostic) => diagnostic.sourceId === source.id,
      ),
      ...result.diagnostics,
    ];
    allDiagnostics.push(...result.diagnostics);
    sources.push({
      id: source.id,
      digest: result.digest,
      target: source.descriptor.to,
      ...(source.descriptor.schema ? { schema: source.descriptor.schema } : {}),
      importedAt,
      order: source.resolvedOrder,
      origin: source.origin,
      ...(source.overridden ? { overridden: true } : {}),
      diagnostics: countDiagnostics(sourceDiagnostics),
    });
  }

  return {
    metadata: {
      ...metadata,
      worldData: {
        schemaVersion: 1,
        sources,
      } satisfies WorldDataMetadataSummary,
    },
    summary: { schemaVersion: 1, sources },
    diagnostics: allDiagnostics,
  };
}
