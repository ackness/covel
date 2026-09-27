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
import { DIMENSION_KEYS, resolveI18nDeep } from "@covel/shared";
import { z } from "zod";
import { overlayPluginDataValue } from "@covel/tools";
const dimensionKeys = [...DIMENSION_KEYS];
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parsePath(path) {
  if (path.length === 0) return [];
  const tokens = [];
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
      if (expectSegment && index !== 0) return null;
      const close = path.indexOf("]", index);
      if (close < 0) return null;
      const raw = path.slice(index + 1, close);
      if (!/^\d+$/.test(raw)) return null;
      const arrayIndex = Number(raw);
      if (!Number.isSafeInteger(arrayIndex)) return null;
      tokens.push(arrayIndex);
      index = close + 1;
      expectSegment = false;
      continue;
    }
    if (!expectSegment) return null;
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
function getByPath(value, path) {
  const tokens = parsePath(path);
  if (tokens === null) {
    return { found: false, error: `Invalid path syntax: ${path}` };
  }
  let current = value;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || !Object.hasOwn(current, token)) {
        return { found: false };
      }
      current = current[token];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, token)) {
      return { found: false };
    }
    current = current[token];
  }
  return { found: true, value: current };
}
function previewValue(value, maxLen = 220) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 1)}…`;
  } catch {
    return String(value);
  }
}
function formatQueryLabel(dimension, path) {
  return path ? `${dimension}.${path}` : dimension;
}
export default function ({ tool }) {
  return tool({
    name: "world-dimension-get",
    description: "读取当前世界的结构化维度；可用 path 精确查询嵌套字段。",
    parameters: z.object({
      queries: z
        .array(
          z.object({
            dimension: z.enum(dimensionKeys).describe("世界维度键"),
            path: z
              .string()
              .min(1)
              .optional()
              .describe('可选路径，如 "regions[0].name"'),
          }),
        )
        .min(1)
        .max(20)
        .describe("查询列表"),
      resolveI18n: z
        .boolean()
        .default(true)
        .describe("按 session locale 解析 i18n；默认 true"),
    }),
    execute: async (params, context) => {
      let sessionCache;
      let worldCache;
      let providerPluginResolved = false;
      let providerPluginIdCache;
      const dimensionCache = new Map();
      async function getSession() {
        if (sessionCache !== undefined) return sessionCache;
        sessionCache = await context.store.getSession();
        return sessionCache;
      }
      async function getWorld() {
        if (worldCache !== undefined) return worldCache;
        const session = await getSession();
        if (!session?.worldId) {
          worldCache = null;
          return worldCache;
        }
        worldCache = context.world.worldRecord;
        return worldCache;
      }
      async function getProviderPluginId() {
        if (providerPluginResolved) return providerPluginIdCache;
        providerPluginResolved = true;
        providerPluginIdCache = context.pluginId;
        return providerPluginIdCache;
      }
      async function loadDimension(dimension) {
        if (dimensionCache.has(dimension)) {
          return dimensionCache.get(dimension) ?? null;
        }
        const providerPluginId = await getProviderPluginId();
        if (providerPluginId) {
          const pending = overlayPluginDataValue(
            (context.pendingProposals ?? []).filter(
              (proposal) => proposal.sessionId === context.sessionId,
            ),
            providerPluginId,
            "entries",
            dimension,
          );
          // A pending delete removes the session override and reveals the
          // bound world's metadata, just like a committed delete.
          const record = pending.hit
            ? pending.deleted
              ? null
              : { value: pending.value }
            : await context.store.getPluginData("entries", dimension);
          if (record) {
            const loaded = {
              source: "plugin-data",
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
        if (dimensions && Object.hasOwn(dimensions, dimension)) {
          const loaded = {
            source: "world-metadata",
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
            ...(query.path === undefined ? {} : { path: query.path }),
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
            ...(query.path === undefined ? {} : { path: query.path }),
            found: false,
            source: loaded.source,
            value: null,
            error: raw.error ?? "Field path not found",
            label,
          });
          continue;
        }
        const value = params.resolveI18n
          ? resolveI18nDeep(raw.value, locale)
          : raw.value;
        results.push({
          dimension: query.dimension,
          ...(query.path === undefined ? {} : { path: query.path }),
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
