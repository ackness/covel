/**
 * Session event directory — aggregates the `events` contracts declared by
 * a session's active plugin runtimes so the builtin `emit-event` tool
 * (see `@covel/tools`'s `EventDirectoryLike`) can list known topics,
 * validate emitted payloads against their JSON Schema, and render a
 * locale-aware catalogue for segment 5 prompt injection (task 5).
 *
 * Declarations are re-aggregated on every call (session activation can
 * change between turns) — only the compiled ajv validators are cached,
 * keyed by resolved schema path, mirroring the pattern in
 * `apps/server/src/world-data/schema-registry.ts`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { resolveI18nText, type RuntimeManifest } from "@covel/shared";

type PluginEventDecl = NonNullable<RuntimeManifest["events"]>[number];

export interface EventDirectory {
  listTopics(sessionId: string): Promise<readonly string[]>;
  validate(
    sessionId: string,
    topic: string,
    data: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Renders the advertised (non-internal) contracts for prompt injection. Empty directory → `""`. */
  catalogText(sessionId: string, locale: string): Promise<string>;
}

export interface EventDirectoryDeps {
  readonly registry: {
    getActiveRuntimes(sessionId: string): readonly RuntimeManifest[];
  };
  /** pluginId → absolute plugin root path. `undefined` when unresolvable. */
  readonly resolvePluginDir: (pluginId: string) => string | undefined;
}

interface ResolvedEventEntry {
  readonly pluginId: string;
  readonly decl: PluginEventDecl;
  readonly pluginDir: string | undefined;
  /** Dedup/conflict key — absolute schema path when resolvable, else a plugin-scoped fallback. */
  readonly schemaKey: string;
}

interface LoadedSchema {
  readonly validate: ValidateFunction;
  readonly raw: AnySchema;
}

function requiredFieldsSummary(raw: AnySchema): string {
  const schema = raw as {
    required?: readonly string[];
    properties?: Record<string, { type?: string }>;
  };
  const required = schema.required ?? [];
  if (required.length === 0) return "";
  return required
    .map((name) => {
      const type = schema.properties?.[name]?.type;
      return type ? `${name}: ${type}` : name;
    })
    .join(", ");
}

export function createEventDirectory(deps: EventDirectoryDeps): EventDirectory {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schemaCache = new Map<string, LoadedSchema>();

  function collectSessionEvents(
    sessionId: string,
  ): ReadonlyMap<string, ResolvedEventEntry> {
    const byTopic = new Map<string, ResolvedEventEntry>();
    for (const manifest of deps.registry.getActiveRuntimes(sessionId)) {
      if (!manifest.events || manifest.events.length === 0) continue;
      const pluginDir = deps.resolvePluginDir(manifest.pluginId);
      for (const decl of manifest.events) {
        const schemaKey = pluginDir
          ? path.resolve(pluginDir, decl.schema)
          : `${manifest.pluginId}:${decl.schema}`;
        const existing = byTopic.get(decl.topic);
        if (existing) {
          if (
            existing.pluginId !== manifest.pluginId &&
            existing.schemaKey !== schemaKey
          ) {
            console.warn(
              `[event-directory] topic "${decl.topic}" declared with conflicting schemas by "${existing.pluginId}" and "${manifest.pluginId}" — keeping "${existing.pluginId}"'s declaration`,
            );
          }
          continue; // first-wins (getActiveRuntimes is priority-sorted)
        }
        byTopic.set(decl.topic, {
          pluginId: manifest.pluginId,
          decl,
          pluginDir,
          schemaKey,
        });
      }
    }
    return byTopic;
  }

  async function loadSchema(entry: ResolvedEventEntry): Promise<LoadedSchema> {
    const cached = schemaCache.get(entry.schemaKey);
    if (cached) return cached;
    if (!entry.pluginDir) {
      throw new Error(`plugin "${entry.pluginId}" root path is not resolvable`);
    }
    const absPath = path.resolve(entry.pluginDir, entry.decl.schema);
    const raw = JSON.parse(await readFile(absPath, "utf-8")) as AnySchema;
    const loaded: LoadedSchema = { validate: ajv.compile(raw), raw };
    schemaCache.set(entry.schemaKey, loaded);
    return loaded;
  }

  return {
    async listTopics(sessionId) {
      return [...collectSessionEvents(sessionId).keys()];
    },

    async validate(sessionId, topic, data) {
      const entry = collectSessionEvents(sessionId).get(topic);
      if (!entry) return { ok: false, reason: `unknown topic "${topic}"` };
      let loaded: LoadedSchema;
      try {
        loaded = await loadSchema(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `schema unreadable: ${message}` };
      }
      if (loaded.validate(data)) return { ok: true };
      return { ok: false, reason: ajv.errorsText(loaded.validate.errors) };
    },

    async catalogText(sessionId, locale) {
      const entries = [...collectSessionEvents(sessionId).values()]
        .filter((entry) => entry.decl.advertise)
        .sort((a, b) => a.decl.topic.localeCompare(b.decl.topic));
      if (entries.length === 0) return "";

      const lines: string[] = [];
      for (const entry of entries) {
        const description =
          resolveI18nText(entry.decl.description, locale) ?? "";
        let fields = "";
        try {
          fields = requiredFieldsSummary((await loadSchema(entry)).raw);
        } catch {
          fields = "(schema unavailable)";
        }
        lines.push(
          `- ${entry.decl.topic}: ${description}${fields ? ` (required: ${fields})` : ""}`,
        );
      }
      return lines.join("\n");
    },
  };
}
