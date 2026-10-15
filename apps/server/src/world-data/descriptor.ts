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
  WorldDataDescriptorFile,
  WorldDataSourceDescriptor,
} from "@covel/shared";
import {
  conventionalDescriptor,
  sourceRank,
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
  descriptor?: WorldDataDescriptorFile;
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
    const schema = options?.override
      ? worldDataDescriptorOverrideSchema
      : worldDataDescriptorSchema;
    // A whole unknown root field removes no part of a source declaration.
    // Leave it out, but keep source fields strict so a typo cannot change a target.
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const key of Object.keys(raw))
        if (!Object.hasOwn(schema.shape, key))
          diagnostics.push({
            level: "warning",
            path: relativePath,
            pointer: key,
            message: `unknown field "${key}" is ignored`,
            hint: "Remove the field or correct its name.",
          });
    const validation = schema.strip().safeParse(raw);
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
      descriptor: validation.data as WorldDataDescriptorFile,
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

/** The form two source paths are compared in: without `./` and a trailing `/`. */
function samePath(left: string, right: string): boolean {
  const normal = (value: string) =>
    value
      .split("/")
      .filter((segment) => segment !== "" && segment !== ".")
      .join("/");
  return normal(left) === normal(right);
}

function issuesOf(error: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * The conventional sources with the world's descriptor applied. An entry
 * whose `path` is that of a conventional source changes it: the fields it
 * writes replace the conventional ones, and the source takes the entry's ID.
 * `enabled: false` turns it off. Any other entry adds a source and must be a
 * whole one (`kind`, `path`, `to`). An entry that names the path of a
 * conventional source this plugin set does not read changes nothing.
 */
function applyDescriptor(
  conventional: WorldDataDescriptor | undefined,
  written: WorldDataDescriptorFile | undefined,
  descriptorPath: string | undefined,
  scoped: boolean,
): {
  sources: [string, WorldDataSourceDescriptor][];
  diagnostics: WorldDataDiagnostic[];
} {
  const diagnostics: WorldDataDiagnostic[] = [];
  const sources: [string, WorldDataSourceDescriptor][] = Object.entries(
    conventional?.sources ?? {},
  );
  const changed = new Set<number>();
  for (const [id, entry] of Object.entries(written?.sources ?? {})) {
    const index = sources.findIndex(([, source]) =>
      samePath(source.path, entry.path),
    );
    const existing = index >= 0 ? sources[index] : undefined;
    if (existing && changed.has(index)) {
      diagnostics.push({
        level: "error",
        sourceId: id,
        path: descriptorPath,
        message: `source "${id}" names ${entry.path}, which another entry of the descriptor already changes`,
        hint: "Keep one entry for each path.",
      });
      continue;
    }
    if (!existing && (entry.kind === undefined || entry.to === undefined)) {
      // Without its plugin the file is not a source of this session; the
      // entry has nothing to change. Without a plugin set, it is a mistake.
      diagnostics.push({
        level: scoped ? "info" : "warning",
        sourceId: id,
        path: descriptorPath,
        message: `source "${id}" changes ${entry.path}, which no plugin reads by convention here; the entry changes nothing`,
        hint: "Correct `path`, or write `kind` and `to` to add the file as a source of its own.",
      });
      continue;
    }
    const merged = worldDataSourceDescriptorSchema.safeParse({
      ...existing?.[1],
      ...entry,
    });
    if (!merged.success) {
      diagnostics.push({
        level: "error",
        sourceId: id,
        path: descriptorPath,
        pointer: `sources.${id}`,
        message: `sources.${id}: ${issuesOf(merged.error)}`,
      });
      continue;
    }
    const source = merged.data as WorldDataSourceDescriptor;
    if (existing) {
      sources[index] = [id, source];
      changed.add(index);
    } else sources.push([id, source]);
  }
  const seen = new Set<string>();
  const unique = sources.filter(([id]) => {
    if (!seen.has(id)) {
      seen.add(id);
      return true;
    }
    diagnostics.push({
      level: "error",
      sourceId: id,
      path: descriptorPath,
      message: `source ID "${id}" is also the ID of a conventional source; give the entry another ID`,
    });
    return false;
  });
  // The default order: dimensions, media, the rest, character records; the
  // conventional sources first within each. `after` reorders from there.
  return {
    sources: unique
      .map((source, order) => ({ source, order }))
      .sort(
        (a, b) =>
          sourceRank(a.source[1]) - sourceRank(b.source[1]) ||
          a.order - b.order,
      )
      .map(({ source }) => source),
    diagnostics,
  };
}

/**
 * The paths a world's descriptor adds as sources of their own (entries with
 * `kind` and `to`). Such an entry says which contract a file is for, so a
 * path two plugins name is no longer in doubt.
 */
export async function descriptorSourcePaths(
  worldRoot: string,
  worldDataPath: string | undefined,
): Promise<readonly string[]> {
  if (!worldDataPath) return [];
  const read = await readDescriptorFile(worldRoot, worldDataPath);
  return Object.values(read.descriptor?.sources ?? {})
    .filter((entry) => entry.kind !== undefined && entry.to !== undefined)
    .map((entry) => entry.path);
}

/**
 * The sources of a world package, in import order.
 *
 * Every package is read by convention: each file at a well-known path is a
 * source (see `conventions.ts`). `worldDataPath` is the descriptor that
 * `world.yaml` names; it changes, turns off or adds sources (`applyDescriptor`).
 */
export async function loadWorldDataDescriptor(options: {
  worldRoot: string;
  worldDataPath?: string;
  worldId: string;
  covelHome?: string;
  /**
   * The conventions to read by: a session's plugins. The process's list
   * when absent.
   */
  conventions?: readonly ConventionalSource[];
}): Promise<LoadedWorldDataDescriptor> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const written = options.worldDataPath
    ? await readDescriptorFile(options.worldRoot, options.worldDataPath)
    : undefined;
  diagnostics.push(...(written?.diagnostics ?? []));
  const applied = applyDescriptor(
    await conventionalDescriptor(options.worldRoot, options.conventions),
    written?.descriptor,
    options.worldDataPath,
    options.conventions !== undefined,
  );
  diagnostics.push(...applied.diagnostics);

  const merged = new Map<string, MergedWorldDataSource>();
  let order = 0;
  for (const [id, descriptor] of applied.sources) {
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
