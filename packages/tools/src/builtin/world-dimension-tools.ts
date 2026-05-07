/**
 * Built-in world dimension query tools.
 *
 * These tools let LLM runtimes query structured world-dimension data on demand
 * instead of relying on bulk prompt injection. Reads are session-scoped:
 *
 * 1. Prefer the active `world-data-provider` plugin's `plugin_data.entries`
 *    records (canonical session copy after world init / sync).
 * 2. Fall back to `world.metadata.dimensions` from the session's bound world.
 *
 * The tool returns a compact `_text` summary for LLM consumption while keeping
 * the full structured payload in `parsedResult`.
 */

import { DIMENSION_KEYS } from "@covel/shared";
import { z } from "zod";
import { tool } from "../tool.js";
import type { ToolModule } from "../types.js";

type DimensionKey = (typeof DIMENSION_KEYS)[number];

type SessionLike = {
  readonly worldId?: string;
  readonly locale?: string;
};

type WorldLike = {
  readonly metadata?: unknown;
};

interface WorldDimensionStore {
  getSession(sessionId: string): Promise<SessionLike | null>;
  getWorld(id: string): Promise<WorldLike | null>;
  getPluginData(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<{ value: unknown; updatedAt: string } | null>;
}

export interface WorldDimensionToolDeps {
  /**
   * Resolve the active plugin package ID that provides `world-data-provider`
   * data for this session. Kept as an injected callback so @covel/tools stays
   * free of a runtime dependency on @covel/plugin-loader.
   */
  findWorldDataPluginId(sessionId: string): string | undefined;
}

type QuerySource = "plugin-data" | "world-metadata";

interface LoadedDimension {
  readonly source: QuerySource;
  readonly value: unknown;
}

const dimensionKeys = [...DIMENSION_KEYS] as [DimensionKey, ...DimensionKey[]];

const localeKeyRe = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLocaleMap(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([key, item]) => localeKeyRe.test(key) && typeof item === "string",
    )
  );
}

function resolveI18nValue(value: unknown, locale?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveI18nValue(item, locale));
  }
  if (isLocaleMap(value)) {
    if (locale && value[locale]) return value[locale];
    const languageOnly = locale?.split("-")[0];
    if (languageOnly) {
      const exact = Object.entries(value).find(
        ([key]) => key.split("-")[0] === languageOnly,
      );
      if (exact) return exact[1];
    }
    const first = Object.values(value)[0];
    return first ?? "";
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveI18nValue(item, locale);
    }
    return out;
  }
  return value;
}

function parsePath(path: string): Array<string | number> | null {
  if (path.length === 0) return [];
  const tokens: Array<string | number> = [];
  let index = 0;
  let expectSegment = true;

  while (index < path.length) {
    if (path[index] === ".") {
      if (expectSegment) return null;
      index += 1;
      expectSegment = true;
      continue;
    }

    if (path[index] === "[") {
      if (!expectSegment && path[index - 1] === ".") return null;
      const close = path.indexOf("]", index);
      if (close < 0) return null;
      const raw = path.slice(index + 1, close);
      if (!/^\d+$/.test(raw)) return null;
      tokens.push(Number(raw));
      index = close + 1;
      expectSegment = false;
      continue;
    }

    let end = index;
    while (
      end < path.length &&
      path[end] !== "." &&
      path[end] !== "[" &&
      path[end] !== "]"
    ) {
      end += 1;
    }
    if (end === index) return null;
    tokens.push(path.slice(index, end));
    index = end;
    expectSegment = false;
  }

  if (expectSegment) return null;
  return tokens;
}

function getByPath(
  value: unknown,
  path: string,
): { found: boolean; value?: unknown; error?: string } {
  const tokens = parsePath(path);
  if (tokens === null) {
    return { found: false, error: `Invalid path syntax: ${path}` };
  }

  let current: unknown = value;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token < 0 || token >= current.length) {
        return { found: false };
      }
      current = current[token];
      continue;
    }

    if (!isPlainObject(current) || !(token in current)) {
      return { found: false };
    }
    current = current[token];
  }

  return { found: true, value: current };
}

function previewValue(value: unknown, maxLen = 220): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 1)}…`;
  } catch {
    return String(value);
  }
}

function formatQueryLabel(dimension: string, path?: string): string {
  return path ? `${dimension}.${path}` : dimension;
}

function createWorldDimensionGetTool(
  store: WorldDimensionStore,
  deps: WorldDimensionToolDeps,
): ToolModule {
  return tool({
    name: "world-dimension-get",
    description:
      "按需读取当前 session 绑定世界的结构化维度数据。优先读取 world-data-provider 插件已同步的 entries，其次回退到 world.metadata.dimensions。支持按 dimension + path 精确读取嵌套字段，适合在 function calling 中按需取世界设定。",
    parameters: z.object({
      queries: z
        .array(
          z.object({
            dimension: z
              .enum(dimensionKeys)
              .describe(
                "世界维度键，例如 geography、factions、powerSystem、tone",
              ),
            path: z
              .string()
              .min(1)
              .optional()
              .describe(
                '可选字段路径，例如 "regions[0].name"、"contentRating"',
              ),
          }),
        )
        .min(1)
        .max(20)
        .describe("要查询的维度字段列表"),
      resolveI18n: z
        .boolean()
        .default(true)
        .describe(
          "是否将 i18n 文本对象按 session locale 解析为字符串，默认 true",
        ),
    }),
    execute: async (params, context) => {
      let sessionCache: SessionLike | null | undefined;
      let worldCache: WorldLike | null | undefined;
      let providerPluginResolved = false;
      let providerPluginIdCache: string | undefined;
      const dimensionCache = new Map<DimensionKey, LoadedDimension | null>();

      async function getSession(): Promise<SessionLike | null> {
        if (sessionCache !== undefined) return sessionCache;
        sessionCache = await store.getSession(context.sessionId);
        return sessionCache;
      }

      async function getWorld(): Promise<WorldLike | null> {
        if (worldCache !== undefined) return worldCache;
        const session = await getSession();
        if (!session?.worldId) {
          worldCache = null;
          return worldCache;
        }
        worldCache = await store.getWorld(session.worldId);
        return worldCache;
      }

      async function getProviderPluginId(): Promise<string | undefined> {
        if (providerPluginResolved) return providerPluginIdCache;
        providerPluginResolved = true;
        providerPluginIdCache = deps.findWorldDataPluginId(context.sessionId);
        return providerPluginIdCache;
      }

      async function loadDimension(
        dimension: DimensionKey,
      ): Promise<LoadedDimension | null> {
        if (dimensionCache.has(dimension)) {
          return dimensionCache.get(dimension) ?? null;
        }

        const providerPluginId = await getProviderPluginId();
        if (providerPluginId) {
          const record = await store.getPluginData(
            context.sessionId,
            providerPluginId,
            "entries",
            dimension,
          );
          if (record) {
            const loaded = {
              source: "plugin-data" as const,
              value: record.value,
            };
            dimensionCache.set(dimension, loaded);
            return loaded;
          }
        }

        const world = await getWorld();
        const metadata = isPlainObject(world?.metadata)
          ? world.metadata
          : undefined;
        const dimensions = isPlainObject(metadata?.dimensions)
          ? metadata.dimensions
          : undefined;
        if (dimensions && dimension in dimensions) {
          const loaded = {
            source: "world-metadata" as const,
            value: dimensions[dimension],
          };
          dimensionCache.set(dimension, loaded);
          return loaded;
        }

        dimensionCache.set(dimension, null);
        return null;
      }

      const session = await getSession();
      const locale = session?.locale;
      const results = [];

      for (const query of params.queries) {
        const label = formatQueryLabel(query.dimension, query.path);
        const loaded = await loadDimension(query.dimension);
        if (!loaded) {
          results.push({
            dimension: query.dimension,
            path: query.path,
            found: false,
            source: null,
            value: null,
            error:
              "Dimension not found in plugin_data.entries or world metadata",
            label,
          });
          continue;
        }

        const raw = query.path
          ? getByPath(loaded.value, query.path)
          : { found: true, value: loaded.value };
        if (!raw.found) {
          results.push({
            dimension: query.dimension,
            path: query.path,
            found: false,
            source: loaded.source,
            value: null,
            error: raw.error ?? "Field path not found",
            label,
          });
          continue;
        }

        const value = params.resolveI18n
          ? resolveI18nValue(raw.value, locale)
          : raw.value;
        results.push({
          dimension: query.dimension,
          path: query.path,
          found: true,
          source: loaded.source,
          value,
          error: null,
          label,
        });
      }

      const textLines = results.map((result, idx) => {
        if (!result.found) {
          return `${idx + 1}. ${result.label} — not found${result.source ? ` (${result.source})` : ""}`;
        }
        return `${idx + 1}. ${result.label} [${result.source}] = ${previewValue(result.value)}`;
      });

      return {
        _text: textLines.join("\n"),
        success: true,
        locale: locale ?? null,
        results: results.map(({ label: _label, ...result }) => result),
      };
    },
  });
}

export function createWorldDimensionTools(
  store: WorldDimensionStore,
  deps: WorldDimensionToolDeps,
): ToolModule[] {
  return [createWorldDimensionGetTool(store, deps)];
}
