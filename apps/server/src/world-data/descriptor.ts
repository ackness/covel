import { access, readFile } from "node:fs/promises";
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
import { resolveContainedPath } from "./safe-path.js";
import { orderSources } from "./source-order.js";
import type {
  LoadedWorldDataDescriptor,
  MergedWorldDataSource,
  SourceFieldOrigin,
  WorldDataDiagnostic,
} from "./types.js";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

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
      diagnostics.push({
        level: "error",
        path: relativePath,
        message: validation.error.issues
          .map(
            (issue) =>
              `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`,
          )
          .join("\n"),
      });
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

export async function loadWorldDataDescriptor(options: {
  worldRoot: string;
  worldDataPath: string;
  worldId: string;
  covelHome?: string;
}): Promise<LoadedWorldDataDescriptor> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const base = await readDescriptorFile(
    options.worldRoot,
    options.worldDataPath,
  );
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

  const enabled = [...merged.values()].filter(
    (source) => source.descriptor.enabled !== false,
  );
  const ordered = orderSources(enabled);
  return {
    sources: ordered.sources,
    diagnostics: [...diagnostics, ...ordered.diagnostics],
  };
}
