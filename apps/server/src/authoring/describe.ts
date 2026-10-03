/**
 * The authoring surface of the installed version: which world data a world
 * may supply, which plugin receives it, and how to declare and write it.
 *
 * Everything here is read from plugin manifests, so a newly installed plugin
 * shows up without an edit to docs, skills or the world generator.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginRegistry } from "@covel/plugin-loader";
import { resolveI18nText } from "@covel/shared";
import { resolveContainedPath } from "../world-data/safe-path.js";
import {
  pluginSchemaUriForTarget,
  resolvePluginSchema,
} from "../world-data/schema-registry.js";
import { sourceItems } from "../world-data/session-import/utils.js";

type PluginCatalogue = Pick<PluginRegistry, "get" | "getAll">;

/** A ready-to-paste entry for a world data descriptor. */
export interface AuthoringSourceEntry {
  readonly kind: "yaml" | "json" | "media";
  readonly path: string;
  readonly schema?: string;
  readonly to: string;
  readonly indexTo?: string;
  readonly key?: string;
  readonly visibility?: "hidden";
}

export interface AuthoringContract {
  readonly contract: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly title: string;
  /** Player-facing sentence, in the requested locale. */
  readonly summary?: string;
  /** The namespace's technical description, for authors and tools. */
  readonly description?: string;
  readonly hint?: string;
  /** Path of the record schema, relative to the plugin package. */
  readonly schema: string;
  /** Suggested source ID and descriptor entry; absent when the plugin declares no source. */
  readonly source?: {
    readonly id: string;
    readonly entry: AuthoringSourceEntry;
  };
  /** A valid example of the source value. */
  readonly example?: unknown;
  /** Set when the in-app world generator may produce this content. */
  readonly generate?: "offer" | "default";
}

export interface AuthoringPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly settings: readonly {
    readonly key: string;
    readonly type: string;
    readonly default?: unknown;
    readonly label: string;
  }[];
}

/** Destinations the kernel owns; no plugin has to be active for them. */
export interface AuthoringDestination {
  readonly title: string;
  readonly description: string;
  readonly source: {
    readonly id: string;
    readonly entry: AuthoringSourceEntry;
  };
}

export interface AuthoringSurface {
  readonly files: readonly {
    readonly path: string;
    readonly purpose: string;
    readonly reference?: string;
  }[];
  readonly destinations: readonly AuthoringDestination[];
  readonly contracts: readonly AuthoringContract[];
  readonly plugins: readonly AuthoringPlugin[];
}

const WORLD_FILES: AuthoringSurface["files"] = [
  {
    path: "world.yaml",
    purpose:
      "World manifest: identity, locales, plugin selection, character schema. Written in one language, the `defaultLocale`.",
    reference: "docs/reference/schema/world-manifest.md",
  },
  {
    path: "<file>.<locale>.<ext>",
    purpose:
      "Translation of the YAML or JSON file beside it, for example `world.en.yaml` or `data/dimensions.en.yaml`. It holds only translated text under the same keys and ids; it does not repeat structure. Never write a locale map inside a main file.",
    reference: "docs/reference/world-data.md",
  },
  {
    path: "WORLD.md",
    purpose:
      "Lore given to the narrative. It is the fallback for every locale; add `WORLD.<locale>.md`, a whole document, for other languages.",
  },
  {
    path: "data/world.data.yaml",
    purpose: "World data descriptor: one entry per data source below.",
    reference: "docs/reference/schema/world-data-descriptor.md",
  },
  {
    path: "data/dimensions.yaml",
    purpose: "Dynamic world dimensions, keyed by dimension ID.",
    reference: "docs/reference/schema/world-dimensions.md",
  },
];

const KERNEL_DESTINATIONS: readonly AuthoringDestination[] = [
  {
    title: "World dimensions",
    description:
      "Static setting and values that change in play. Each definition has a name, a value schema, an initial value and an optional update rule.",
    source: {
      id: "dimensions",
      entry: {
        kind: "yaml",
        path: "data/dimensions.yaml",
        schema: "covel://world/dimensions",
        to: "world:metadata.dimensions",
      },
    },
  },
  {
    title: "Characters",
    description:
      "Character records of the session's world model. Types and fields follow `characterSchema` in `world.yaml`.",
    source: {
      id: "characters",
      entry: {
        kind: "json",
        path: "characters/characters.json",
        to: "characters",
        key: "id",
      },
    },
  },
];

function text(value: unknown, locale: string): string {
  return (
    resolveI18nText(value as string | Record<string, string>, locale) ?? ""
  );
}

function sourceEntry(
  contract: string,
  source: {
    readonly kind: "yaml" | "json" | "media";
    readonly path: string;
    readonly key?: string;
    readonly visibility?: "public" | "hidden";
    readonly lorebook?: boolean;
  },
): AuthoringSourceEntry {
  if (source.kind === "media")
    return {
      kind: "media",
      path: source.path,
      to: "media",
      indexTo: `contract:${contract}`,
      key: source.key ?? "filename",
    };
  return {
    kind: source.kind,
    path: source.path,
    schema: `contract:${contract}`,
    to: `contract:${contract}${source.lorebook ? "+lorebook" : ""}`,
    ...(source.key ? { key: source.key } : {}),
    ...(source.visibility === "hidden" ? { visibility: "hidden" } : {}),
  };
}

async function readExample(
  rootPath: string | undefined,
  example: string | undefined,
): Promise<unknown> {
  if (!rootPath || !example) return undefined;
  const examplePath = await resolveContainedPath(rootPath, example, {
    rejectSymlinks: true,
  });
  if (!examplePath) return undefined;
  return JSON.parse(await readFile(examplePath, "utf-8")) as unknown;
}

export async function describeAuthoringSurface(
  catalogue: PluginCatalogue,
  options: { readonly locale?: string } = {},
): Promise<AuthoringSurface> {
  const locale = options.locale ?? "en-US";
  const contracts: AuthoringContract[] = [];
  const plugins: AuthoringPlugin[] = [];
  const entries = [...catalogue.getAll()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [pluginId, entry] of entries) {
    const plugin = entry.packageManifest?.plugin;
    if (!plugin) continue;
    plugins.push({
      id: pluginId,
      displayName: text(plugin.displayName, locale) || pluginId,
      description: text(plugin.description, locale),
      tags: plugin.tags ?? [],
      provides: (plugin.provides ?? []).map((provision) =>
        typeof provision === "string" ? provision : provision.contract,
      ),
      requires: plugin.requires ?? [],
      settings: (plugin.contributes?.settings ?? []).map((setting) => ({
        key: setting.key,
        type: setting.type,
        ...(setting.default !== undefined ? { default: setting.default } : {}),
        label: text(setting.label, locale),
      })),
    });

    for (const [namespace, declaration] of Object.entries(
      plugin.contributes?.data ?? {},
    )) {
      for (const contract of declaration.accepts ?? []) {
        const authoring = declaration.authoring;
        contracts.push({
          contract,
          pluginId,
          namespace,
          title: text(authoring?.title, locale) || contract,
          ...(authoring?.summary
            ? { summary: text(authoring.summary, locale) }
            : {}),
          ...(declaration.description
            ? { description: declaration.description }
            : {}),
          ...(authoring?.hint ? { hint: authoring.hint } : {}),
          schema: declaration.schema,
          ...(authoring?.source
            ? {
                source: {
                  id: namespace,
                  entry: sourceEntry(contract, authoring.source),
                },
              }
            : {}),
          example: await readExample(entry.rootPath, authoring?.example),
          ...(authoring?.generate ? { generate: authoring.generate } : {}),
        });
      }
    }
  }

  return {
    files: WORLD_FILES,
    destinations: KERNEL_DESTINATIONS,
    contracts,
    plugins,
  };
}

export interface AuthoringExampleIssue {
  readonly pluginId: string;
  readonly namespace: string;
  readonly message: string;
}

/**
 * Check every declared example against the schema of the namespace that
 * receives it, the same way a world's source of that contract is checked.
 */
export async function validateAuthoringExamples(
  catalogue: PluginCatalogue,
): Promise<readonly AuthoringExampleIssue[]> {
  const issues: AuthoringExampleIssue[] = [];
  for (const [pluginId, entry] of catalogue.getAll()) {
    for (const [namespace, declaration] of Object.entries(
      entry.packageManifest?.plugin?.contributes?.data ?? {},
    )) {
      const authoring = declaration.authoring;
      if (!authoring?.example) continue;
      const report = (message: string) =>
        issues.push({ pluginId, namespace, message });
      const examplePath = entry.rootPath
        ? await resolveContainedPath(entry.rootPath, authoring.example, {
            rejectSymlinks: true,
          })
        : null;
      if (!examplePath) {
        report(
          `example path is invalid or leaves the package: ${authoring.example}`,
        );
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(await readFile(examplePath, "utf-8"));
      } catch (error) {
        report(
          `cannot read example ${path.basename(examplePath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const schema = await resolvePluginSchema(
        pluginSchemaUriForTarget({ pluginId, namespace }),
        pluginId,
        namespace,
        { registry: catalogue },
      );
      if ("level" in schema) {
        report(schema.message);
        continue;
      }
      if (schema.kind !== "plugin" || !schema.validate) continue;
      // A keyed list is imported record by record; anything else is one value.
      const records =
        authoring.source?.key && Array.isArray(value)
          ? sourceItems(value)
          : [value];
      records.forEach((record, index) => {
        if (schema.validate!(record)) return;
        const where = records.length > 1 ? `record ${index}: ` : "";
        report(
          `${authoring.example} ${where}${(schema.validate!.errors ?? [])
            .map(
              (error) => `${error.instancePath || "(root)"} ${error.message}`,
            )
            .join("; ")}`,
        );
      });
    }
  }
  return issues;
}
