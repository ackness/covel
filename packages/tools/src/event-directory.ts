/**
 * Shared session event directory — aggregates `contributes.events` declared by
 * a session's active plugins so the builtin `emit-event` tool, server routes,
 * and `test-runtime` share the exact same Ajv2020 validator, containment check,
 * and prompt catalog rendering.
 */

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import {
  compareText,
  resolveI18nText,
  type PluginEventDecl,
} from "@covel/shared";
import {
  canDescribeEventPayload,
  type EventDirectoryLike,
} from "./builtin/emit-event.js";

export interface EventDirectoryManifestLike {
  readonly pluginId: string;
  readonly events?: readonly PluginEventDecl[];
}

export interface EventDirectory extends EventDirectoryLike {
  /**
   * Validate an event a plugin emits itself, for example from its own UI. The
   * topic must be one that plugin declares; `advertise: false` topics are
   * allowed, because the emitter is their owner.
   */
  validateOwn(
    sessionId: string,
    pluginId: string,
    topic: string,
    data: Record<string, unknown>,
  ): Promise<
    | { ok: true }
    | { ok: false; code: "not-declared" | "invalid"; reason: string }
  >;
  /** Renders the advertised (non-internal) contracts for prompt injection. Empty directory -> `""`. */
  catalogText(sessionId: string, locale: string): Promise<string>;
}

export interface EventDirectoryDeps {
  readonly registry: {
    getActivePluginDeclarations(
      sessionId: string,
    ): readonly EventDirectoryManifestLike[];
  };
  /** pluginId -> absolute plugin root path. `undefined` when unresolvable. */
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
  readonly raw: Readonly<Record<string, unknown>>;
}

function isStrictlyInsideRoot(
  rootRealPath: string,
  candidatePath: string,
): boolean {
  const rel = path.relative(rootRealPath, candidatePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function resolveContainedSchemaPath(
  root: string,
  relativePath: string,
): Promise<string | null> {
  if (path.isAbsolute(relativePath)) return null;
  const rootRealPath = await realpath(root);
  const resolved = path.resolve(rootRealPath, relativePath);
  if (!isStrictlyInsideRoot(rootRealPath, resolved)) return null;
  try {
    await lstat(resolved);
    const realResolved = await realpath(resolved);
    return isStrictlyInsideRoot(rootRealPath, realResolved)
      ? realResolved
      : null;
  } catch {
    return null;
  }
}

function requiredFieldsSummary(raw: AnySchema): string {
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

export function createEventDirectory(
  deps: EventDirectoryDeps,
): EventDirectory & {
  prepareDeclarations(
    manifests: readonly EventDirectoryManifestLike[],
    pluginDir: string | undefined,
  ): Promise<void>;
} {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schemaCache = new WeakMap<
    PluginEventDecl,
    Map<string, Promise<LoadedSchema>>
  >();
  /** So a cross-plugin topic conflict warns once per (session, topic), not every call. */
  const MAX_WARNED_CONFLICTS = 2_048;
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
              if (warnedConflicts.size >= MAX_WARNED_CONFLICTS) {
                const oldest = warnedConflicts.values().next().value;
                if (oldest !== undefined) warnedConflicts.delete(oldest);
              }
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

  function loadSchema(entry: ResolvedEventEntry): Promise<LoadedSchema> {
    let declarationCache = schemaCache.get(entry.decl);
    if (!declarationCache) {
      declarationCache = new Map();
      schemaCache.set(entry.decl, declarationCache);
    }
    const cached = declarationCache.get(entry.schemaKey);
    if (cached) return cached;
    const pending = readSchema(entry);
    declarationCache.set(entry.schemaKey, pending);
    return pending;
  }

  async function readSchema(entry: ResolvedEventEntry): Promise<LoadedSchema> {
    if (!entry.pluginDir) {
      throw new Error(`plugin "${entry.pluginId}" root path is not resolvable`);
    }
    const absPath = await resolveContainedSchemaPath(
      entry.pluginDir,
      entry.decl.schema,
    );
    if (!absPath) {
      throw new Error(
        `event schema "${entry.decl.schema}" of plugin "${entry.pluginId}" is missing or escapes the plugin root`,
      );
    }
    const raw: unknown = JSON.parse(await readFile(absPath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `event schema "${entry.decl.schema}" of plugin "${entry.pluginId}" must be a JSON Schema object`,
      );
    }
    // Schema IDs are local to this declaration, never registered across
    // generations or plugins. Local $refs still resolve within the document.
    const compiler = new Ajv2020({ allErrors: true, strict: false });
    return {
      validate: compiler.compile(raw as AnySchema),
      raw: raw as Readonly<Record<string, unknown>>,
    };
  }

  return {
    async prepareDeclarations(manifests, pluginDir) {
      await Promise.allSettled(
        manifests.flatMap((manifest) =>
          (manifest.events ?? []).map((decl) =>
            loadSchema({
              pluginId: manifest.pluginId,
              decl,
              pluginDir,
              schemaKey: pluginDir
                ? path.resolve(pluginDir, decl.schema)
                : `${manifest.pluginId}:${decl.schema}`,
            }),
          ),
        ),
      );
    },

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
              const { raw } = await loadSchema(entry);
              return { topic: entry.decl.topic, schema: { ...raw } };
            } catch {
              return { topic: entry.decl.topic };
            }
          }),
      );
    },

    async validate(sessionId, topic, data) {
      const entry = collectSessionEvents(sessionId).get(topic);
      if (!entry || !entry.decl.advertise)
        return { ok: false, reason: `unknown topic "${topic}"` };
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

    async validateOwn(sessionId, pluginId, topic, data) {
      const manifest = deps.registry
        .getActivePluginDeclarations(sessionId)
        .find((candidate) => candidate.pluginId === pluginId);
      const decl = manifest?.events?.find((event) => event.topic === topic);
      if (!decl)
        return {
          ok: false,
          code: "not-declared",
          reason: `plugin "${pluginId}" does not declare topic "${topic}"`,
        };
      const pluginDir = deps.resolvePluginDir(pluginId);
      let loaded: LoadedSchema;
      try {
        loaded = await loadSchema({
          pluginId,
          decl,
          pluginDir,
          schemaKey: pluginDir
            ? path.resolve(pluginDir, decl.schema)
            : `${pluginId}:${decl.schema}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          code: "invalid",
          reason: `schema unreadable: ${message}`,
        };
      }
      if (loaded.validate(data)) return { ok: true };
      return {
        ok: false,
        code: "invalid",
        reason: ajv.errorsText(loaded.validate.errors),
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
          const { raw } = await loadSchema(entry);
          fields = requiredFieldsSummary(raw);
          if (!canDescribeEventPayload(raw))
            payloadSchema = JSON.stringify(
              Object.fromEntries(
                Object.entries(raw).filter(
                  ([key]) =>
                    !["$schema", "$id", "title", "description"].includes(key),
                ),
              ),
            );
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
