import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  worldDataDescriptorOverrideSchema,
  worldDataDescriptorSchema,
  worldDataSourceDescriptorSchema,
} from "@covel/shared";
import type {
  WorldDataDescriptor,
  WorldDataSourceDescriptor,
} from "@covel/shared";
import {
  conventionalDescriptor,
  type ConventionalSource,
} from "./conventions.js";
import { resolveContainedPath } from "./safe-path.js";
import { orderSources } from "./source-order.js";
import { fileExists } from "./session-import/utils.js";
import type {
  LoadedWorldDataDescriptor,
  MergedWorldDataSource,
  SourceFieldOrigin,
  WorldDataDiagnostic,
} from "./types.js";

async function readDescriptorFile(
  root: string,
  relativePath: string,
  options?: { override?: boolean },
): Promise<{
  descriptor?: WorldDataDescriptor;
  path?: string;
  diagnostics: WorldDataDiagnostic[];
}> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const fullPath = await resolveContainedPath(root, relativePath, {
    rejectSymlinks: true,
  });
  if (!fullPath) {
    return {
      diagnostics: [
        {
          level: "error",
          path: relativePath,
          message: `world data descriptor path is invalid or escapes root: ${relativePath}`,
        },
      ],
    };
  }
  try {
    const raw = parseYaml(await readFile(fullPath, "utf-8"));
    const validation = (
      options?.override
        ? worldDataDescriptorOverrideSchema
        : worldDataDescriptorSchema
    ).safeParse(raw);
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        diagnostics.push({
          level: "error",
          path: relativePath,
          sourceId:
            issue.path[0] === "sources" && typeof issue.path[1] === "string"
              ? issue.path[1]
              : undefined,
          pointer: issue.path.join(".") || undefined,
          message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        });
      }
      return { path: fullPath, diagnostics };
    }
    return {
      descriptor: validation.data as WorldDataDescriptor,
      path: fullPath,
      diagnostics,
    };
  } catch (err) {
    return {
      path: fullPath,
      diagnostics: [
        {
          level: "error",
          path: relativePath,
          message: `failed to read world data descriptor: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

/**
 * The schema a source is checked against when it names none: the one of its
 * destination. A source that goes to `contract:quests@1` holds records of
 * that contract, so the contract ID does not have to be written twice.
 */
function defaultSourceSchema(to: string): string | undefined {
  if (to === "world:metadata.dimensions") return "covel://world/dimensions";
  const contract = /^contract:([^+]+)/.exec(to)?.[1];
  return contract ? `contract:${contract}` : undefined;
}

function withDefaultSchema(
  source: MergedWorldDataSource,
): MergedWorldDataSource {
  if (source.descriptor.schema) return source;
  const schema = defaultSourceSchema(source.descriptor.to);
  return schema
    ? {
        ...source,
        descriptor: { ...source.descriptor, schema },
        schemaImplicit: true,
      }
    : source;
}

/**
 * The sources of a world package, in import order.
 *
 * `worldDataPath` is the descriptor that `world.yaml` names. Without one the
 * package is read by convention: each file at a well-known path is a source
 * (see `conventions.ts`).
 */
export async function loadWorldDataDescriptor(options: {
  worldRoot: string;
  worldDataPath?: string;
  worldId: string;
  covelHome?: string;
  /** The conventions to read by; the process's list when absent. */
  conventions?: readonly ConventionalSource[];
}): Promise<LoadedWorldDataDescriptor> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const base = options.worldDataPath
    ? await readDescriptorFile(options.worldRoot, options.worldDataPath)
    : {
        descriptor: await conventionalDescriptor(
          options.worldRoot,
          options.conventions,
        ),
        diagnostics: [],
      };
  diagnostics.push(...base.diagnostics);
  if (!base.descriptor) return { sources: [], diagnostics };

  const merged = new Map<string, MergedWorldDataSource>();
  let order = 0;
  for (const [id, descriptor] of Object.entries(base.descriptor.sources)) {
    const origin = {
      descriptorRoot: options.worldRoot,
      origin: "world" as const,
    };
    merged.set(id, {
      id,
      descriptor,
      order: order++,
      origin: "world",
      overridden: false,
      pathOrigin: origin,
      ...(descriptor.schema ? { schemaOrigin: origin } : {}),
    });
  }

  const overrideRoot = options.covelHome
    ? path.join(options.covelHome, "world-overrides", options.worldId)
    : undefined;
  if (
    overrideRoot &&
    (await fileExists(path.join(overrideRoot, "world.data.override.yaml")))
  ) {
    const override = await readDescriptorFile(
      overrideRoot,
      "world.data.override.yaml",
      {
        override: true,
      },
    );
    diagnostics.push(...override.diagnostics);
    if (override.descriptor) {
      for (const [id, patch] of Object.entries(override.descriptor.sources)) {
        const existing = merged.get(id);
        const candidateDescriptor = {
          ...existing?.descriptor,
          ...patch,
        };
        const validation =
          worldDataSourceDescriptorSchema.safeParse(candidateDescriptor);
        if (!validation.success) {
          diagnostics.push({
            level: "error",
            sourceId: id,
            path: "world.data.override.yaml",
            message: validation.error.issues
              .map(
                (issue) =>
                  `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`,
              )
              .join("\n"),
          });
          continue;
        }
        const nextDescriptor = validation.data as WorldDataSourceDescriptor;
        const pathOrigin: SourceFieldOrigin = patch.path
          ? { descriptorRoot: overrideRoot, origin: "override" }
          : (existing?.pathOrigin ?? {
              descriptorRoot: options.worldRoot,
              origin: "world",
            });
        const schemaOrigin: SourceFieldOrigin | undefined = patch.schema
          ? { descriptorRoot: overrideRoot, origin: "override" }
          : existing?.schemaOrigin;
        merged.set(id, {
          id,
          descriptor: nextDescriptor,
          order: existing?.order ?? order++,
          origin: existing ? existing.origin : "override",
          overridden: true,
          pathOrigin,
          ...(schemaOrigin ? { schemaOrigin } : {}),
        });
      }
    }
  }

  const enabled = [...merged.values()]
    .filter((source) => source.descriptor.enabled !== false)
    .map(withDefaultSchema);
  const ordered = orderSources(enabled);
  return {
    sources: ordered.sources,
    diagnostics: [...diagnostics, ...ordered.diagnostics],
  };
}
