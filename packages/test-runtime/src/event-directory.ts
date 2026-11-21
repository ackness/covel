import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, type PackageManifest } from "@covel/plugin-loader";
import {
  compareText,
  resolveI18nText,
  type PluginEventDecl,
} from "@covel/shared";
import {
  canDescribeEventPayload,
  validateOutput,
  type EventDirectoryLike,
} from "@covel/tools";

export interface TestEventDirectory extends EventDirectoryLike {
  catalogText(sessionId: string, locale: string): Promise<string>;
}

export interface TestEventDirectoryDeps {
  readonly registry: {
    getActivePluginDeclarations(sessionId: string): readonly PackageManifest[];
  };
  readonly resolvePluginDir: (pluginId: string) => string | undefined;
}

interface ResolvedEventEntry {
  readonly pluginId: string;
  readonly decl: PluginEventDecl;
  readonly pluginDir: string | undefined;
  readonly schemaKey: string;
}

function requiredFieldsSummary(raw: Readonly<Record<string, unknown>>): string {
  const schema = raw as {
    required?: readonly string[];
    properties?: Record<string, { type?: string; enum?: readonly unknown[] }>;
  };
  const required = schema.required ?? [];
  if (required.length === 0) return "";
  return required
    .map((name) => {
      const prop = schema.properties?.[name];
      if (prop?.enum) {
        return `${name}: ${prop.enum.map((v) => JSON.stringify(v)).join("|")}`;
      }
      return prop?.type ? `${name}: ${prop.type}` : name;
    })
    .join(", ");
}

async function readContainedSchema(
  entry: ResolvedEventEntry,
): Promise<Readonly<Record<string, unknown>>> {
  if (!entry.pluginDir) {
    throw new Error(`plugin "${entry.pluginId}" root path is not resolvable`);
  }
  const containmentError = () =>
    new Error(
      `event schema "${entry.decl.schema}" of plugin "${entry.pluginId}" is missing or escapes the plugin root`,
    );
  if (path.isAbsolute(entry.decl.schema)) throw containmentError();
  const realRoot = await fs.realpath(entry.pluginDir);
  const resolved = path.resolve(realRoot, entry.decl.schema);
  if (!isPathInside(realRoot, resolved, { allowRoot: false })) {
    throw containmentError();
  }
  let realTarget: string;
  try {
    realTarget = await fs.realpath(resolved);
  } catch {
    throw containmentError();
  }
  if (!isPathInside(realRoot, realTarget, { allowRoot: false })) {
    throw containmentError();
  }
  const raw: unknown = JSON.parse(await fs.readFile(realTarget, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `event schema "${entry.decl.schema}" of plugin "${entry.pluginId}" must be a JSON Schema object`,
    );
  }
  return raw as Readonly<Record<string, unknown>>;
}

/**
 * Session event directory for the isolated runtime runner.
 *
 * Mirrors `apps/server`'s `createEventDirectory`: aggregates `contributes.events`
 * from active plugins, filters `advertise: true` topics for `emit-event` and
 * prompt catalogs, enforces plugin-root containment, and validates payloads
 * against each topic's JSON Schema.
 */
export function createTestEventDirectory(
  deps: TestEventDirectoryDeps,
): TestEventDirectory {
  const schemaCache = new WeakMap<
    PluginEventDecl,
    Map<string, Promise<Readonly<Record<string, unknown>>>>
  >();
  const warnedConflicts = new Set<string>();

  function collectSessionEvents(
    sessionId: string,
  ): ReadonlyMap<string, ResolvedEventEntry> {
    const byTopic = new Map<string, ResolvedEventEntry>();
    for (const manifest of deps.registry.getActivePluginDeclarations(
      sessionId,
    )) {
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
            const warnKey = `${sessionId}:${decl.topic}`;
            if (!warnedConflicts.has(warnKey)) {
              warnedConflicts.add(warnKey);
              console.warn(
                `[event-directory] topic "${decl.topic}" declared with conflicting schemas by "${existing.pluginId}" and "${manifest.pluginId}" — keeping "${existing.pluginId}"'s declaration`,
              );
            }
          }
          continue;
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

  function loadSchema(
    entry: ResolvedEventEntry,
  ): Promise<Readonly<Record<string, unknown>>> {
    let declarationCache = schemaCache.get(entry.decl);
    if (!declarationCache) {
      declarationCache = new Map();
      schemaCache.set(entry.decl, declarationCache);
    }
    const cached = declarationCache.get(entry.schemaKey);
    if (cached) return cached;
    const pending = readContainedSchema(entry);
    declarationCache.set(entry.schemaKey, pending);
    return pending;
  }

  return {
    async listTopics(sessionId) {
      return [...collectSessionEvents(sessionId).values()]
        .filter((entry) => entry.decl.advertise)
        .map((entry) => entry.decl.topic);
    },

    async describeTopics(sessionId) {
      return Promise.all(
        [...collectSessionEvents(sessionId).values()]
          .filter((entry) => entry.decl.advertise)
          .map(async (entry) => {
            try {
              const raw = await loadSchema(entry);
              return { topic: entry.decl.topic, schema: { ...raw } };
            } catch {
              return { topic: entry.decl.topic };
            }
          }),
      );
    },

    async validate(sessionId, topic, data) {
      const entry = collectSessionEvents(sessionId).get(topic);
      if (!entry || !entry.decl.advertise) {
        return { ok: false, reason: `unknown topic "${topic}"` };
      }
      let raw: Readonly<Record<string, unknown>>;
      try {
        raw = await loadSchema(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `schema unreadable: ${message}` };
      }
      let verdict: ReturnType<typeof validateOutput>;
      try {
        verdict = validateOutput(data, raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `schema unreadable: ${message}` };
      }
      if (verdict.valid) return { ok: true };
      return {
        ok: false,
        reason: (verdict.errors ?? []).join(", ") || "invalid event payload",
      };
    },

    async catalogText(sessionId, locale) {
      const entries = [...collectSessionEvents(sessionId).values()]
        .filter((entry) => entry.decl.advertise)
        .sort((a, b) => compareText(a.decl.topic, b.decl.topic));
      if (entries.length === 0) return "";

      const lines: string[] = [];
      for (const entry of entries) {
        const description =
          resolveI18nText(entry.decl.description, locale) ?? "";
        let fields = "";
        let payloadSchema = "";
        try {
          const raw = await loadSchema(entry);
          fields = requiredFieldsSummary(raw);
          if (!canDescribeEventPayload(raw)) {
            payloadSchema = JSON.stringify(
              Object.fromEntries(
                Object.entries(raw).filter(
                  ([key]) =>
                    !["$schema", "$id", "title", "description"].includes(key),
                ),
              ),
            );
          }
        } catch {
          fields = "(schema unavailable)";
        }
        lines.push(
          `- ${entry.decl.topic}: ${description}${fields ? ` (required: ${fields})` : ""}`,
        );
        if (payloadSchema) lines.push(`  payload schema: ${payloadSchema}`);
      }
      return lines.join("\n");
    },
  };
}
