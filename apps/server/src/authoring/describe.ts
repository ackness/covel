/**
 * The authoring surface of the installed version: which world data a world
 * may supply, which plugin receives it, and how to declare and write it.
 *
 * Everything here is read from plugin manifests, so a newly installed plugin
 * shows up without an edit to docs, skills or the world generator.
 */

import { compareText } from "@covel/shared";
import { readFile } from "node:fs/promises";
import type { PluginRegistry } from "@covel/plugin-loader";
import { resolveI18nText } from "@covel/shared";
import {
  KERNEL_SOURCES,
  pluginSourceEntry,
} from "../world-data/conventions.js";
import { resolveContainedPath } from "../world-data/safe-path.js";
import {
  pluginSchemaUriForTarget,
  resolvePluginSchema,
  resolveWorldContractSchema,
} from "../world-data/schema-registry.js";
import { sourceItems } from "../world-data/session-import/utils.js";
import { BUILTIN_PLUGIN_PACKS } from "../config/plugin-packs.js";

type PluginCatalogue = Pick<PluginRegistry, "get" | "getAll">;

/** A ready-to-paste entry for a world data descriptor. */
export interface AuthoringSourceEntry {
  readonly kind: "yaml" | "json" | "media";
  readonly path: string;
  readonly schema?: string;
  readonly to: string;
  readonly indexTo?: string;
  readonly key?: string;
  readonly localeArrayKeys?: readonly string[];
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
  /**
   * The field of a record in the world's character file that holds one
   * record of this contract, in place of a file of its own.
   */
  readonly characterField?: string;
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

/**
 * A plugin pack of the server's catalogue. A world names one in
 * `pluginPolicy.preset`; the world generator offers them as choices.
 */
export interface AuthoringPack {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly requested: readonly string[];
  readonly recommended: readonly string[];
  /** The view a world made for this pack opens new sessions in. */
  readonly defaultViewMode?: "stage" | "parsed";
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
  readonly diagnostics?: readonly AuthoringExampleIssue[];
  readonly files: readonly {
    readonly path: string;
    readonly purpose: string;
    readonly reference?: string;
  }[];
  readonly destinations: readonly AuthoringDestination[];
  readonly contracts: readonly AuthoringContract[];
  readonly plugins: readonly AuthoringPlugin[];
  readonly packs: readonly AuthoringPack[];
}

const WORLD_FILES: AuthoringSurface["files"] = [
  {
    path: "world.yaml",
    purpose:
      "World manifest: name, summary, `defaultLocale`, plugin selection, character schema. Written in one language, the `defaultLocale`. The world's ID defaults to the name of its directory.",
    reference: "docs/reference/schema/world-manifest.md",
  },
  {
    path: "<file>.<locale>.<ext>",
    purpose:
      "Translation of the YAML or JSON file beside it, for example `world.en-US.yaml` or `data/dimensions.en-US.yaml`, with the whole locale (`en-US`, not `en`). It holds only translated text under the same keys and ids; it does not repeat structure. A world has an edition in each locale it has `world.<locale>.yaml` or `WORLD.<locale>.md` for. Never write a locale map inside a main file.",
    reference: "docs/reference/world-data.md",
  },
  {
    path: "WORLD.md",
    purpose:
      "Lore given to the narrative. It is the fallback for every locale; add `WORLD.<locale>.md`, a whole document, for other languages.",
  },
  {
    path: "data/world.data.yaml",
    purpose:
      "Optional world data descriptor; `worldData` in `world.yaml` names it. Every file at a path listed below is a data source without it. An entry with the path of such a file changes that source (`enabled: false` turns it off); any other entry adds a source and needs `kind` and `to`.",
    reference: "docs/reference/schema/world-data-descriptor.md",
  },
  {
    path: "data/dimensions.yaml",
    purpose: "Dynamic world dimensions, keyed by dimension ID.",
    reference: "docs/reference/schema/world-dimensions.md",
  },
];

const KERNEL_TEXT: Readonly<
  Record<string, Pick<AuthoringDestination, "title" | "description">>
> = {
  dimensions: {
    title: "World dimensions",
    description:
      "Static setting and values that change in play. Each definition has a name, a value schema, an initial value and an optional update rule.",
  },
  lorebook: {
    title: "Lorebook",
    description:
      "Lore entries the narrative reads when their keys come up in play. Each entry has an id, trigger keys and content.",
  },
  characters: {
    title: "Characters",
    description:
      "Character records of the session's world model: `id`, `name`, `aliases`, `type`, `description` and `fields`. Types and fields follow `characterSchema` in `world.yaml`. A record may also hold one record of a plugin's data, under the field that plugin names (a contract's `characterField`).",
  },
};

// The same list the importer reads every package by.
const KERNEL_DESTINATIONS: readonly AuthoringDestination[] = KERNEL_SOURCES.map(
  (source) => ({
    ...KERNEL_TEXT[source.id]!,
    source: { id: source.id, entry: source.entry as AuthoringSourceEntry },
  }),
);

function text(value: unknown, locale: string): string {
  return (
    resolveI18nText(value as string | Record<string, string>, locale) ?? ""
  );
}

async function readExample(
  rootPath: string | undefined,
  example: string | undefined,
): Promise<unknown> {
  if (!example) return undefined;
  if (!rootPath) throw new Error("Plugin root is unavailable");
  const examplePath = await resolveContainedPath(rootPath, example, {
    rejectSymlinks: true,
  });
  if (!examplePath)
    throw new Error(`Example path is missing or invalid: ${example}`);
  return JSON.parse(await readFile(examplePath, "utf-8")) as unknown;
}

export async function describeAuthoringSurface(
  catalogue: PluginCatalogue,
  options: { readonly locale?: string } = {},
): Promise<AuthoringSurface> {
  const locale = options.locale ?? "en-US";
  const contracts: AuthoringContract[] = [];
  const diagnostics: AuthoringExampleIssue[] = [];
  const plugins: AuthoringPlugin[] = [];
  const entries = [...catalogue.getAll()].sort(([a], [b]) => compareText(a, b));

  for (const [pluginId, entry] of entries) {
    const plugin = entry.packageManifest?.plugin;
    if (!plugin || entry.status === "error") continue;
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
        try {
          const example = await readExample(entry.rootPath, authoring?.example);
          if (authoring?.generate) {
            const schema = await resolveWorldContractSchema(contract, {
              registry: catalogue,
            });
            if (!schema || "level" in schema)
              throw new Error(
                schema && "level" in schema
                  ? schema.message
                  : `No schema for ${contract}`,
              );
          }
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
                    entry: pluginSourceEntry(
                      contract,
                      authoring.source,
                    ) as AuthoringSourceEntry,
                  },
                }
              : {}),
            ...(authoring?.characterField
              ? { characterField: authoring.characterField }
              : {}),
            example,
            ...(authoring?.generate ? { generate: authoring.generate } : {}),
          });
        } catch (error) {
          const message = `${contract}: ${error instanceof Error ? error.message : String(error)}`;
          diagnostics.push({ pluginId, namespace, message });
          console.warn(
            `[authoring] Skipping ${pluginId}/${namespace}: ${message}`,
          );
        }
      }
    }
  }

  return {
    ...(diagnostics.length ? { diagnostics } : {}),
    files: WORLD_FILES,
    destinations: KERNEL_DESTINATIONS,
    contracts,
    plugins,
    packs: BUILTIN_PLUGIN_PACKS.map((pack) => ({
      id: pack.id,
      label: text(pack.label, locale) || pack.id,
      ...(pack.description
        ? { description: text(pack.description, locale) }
        : {}),
      tags: pack.tags,
      requested: pack.requested,
      recommended: pack.recommended,
      ...(pack.defaultViewMode
        ? { defaultViewMode: pack.defaultViewMode }
        : {}),
    })),
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
      try {
        const value = await readExample(entry.rootPath, authoring.example);
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
        // A file at the plugin's path holds keyed records (by `id` unless the
        // plugin names another key), imported one by one; anything else is
        // one value.
        const records =
          authoring.source && Array.isArray(value)
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
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return issues;
}
