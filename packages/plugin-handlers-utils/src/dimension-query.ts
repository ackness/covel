import { z } from "zod";
import {
  dimensionIdSchema,
  dimensionSnapshotSchema,
} from "./dimension-schemas.js";
import { resolveI18nText } from "./i18n.js";
import { instructionLocaleFor } from "./instruction-locale.js";
import { modelFacingJson } from "./model-facing.js";
import type { DimensionSnapshot } from "./dimension-types.js";

export const dimensionQuerySchema = z.strictObject({
  queries: z
    .array(
      z.strictObject({
        dimension: dimensionIdSchema,
        path: z.string().min(1).max(1024).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      }),
    )
    .min(1)
    .max(20),
});

function readPath(
  value: unknown,
  path: string,
): { found: boolean; value?: unknown; error?: string } {
  const tokens: (string | number)[] = [];
  if (path.startsWith("/")) {
    if (/~(?![01])/u.test(path))
      return { found: false, error: "Invalid JSON Pointer" };
    let current = value;
    for (const token of path
      .slice(1)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, token)
      )
        return { found: false };
      current = (current as Record<string, unknown>)[token];
    }
    return { found: true, value: current };
  }
  const matcher = /(?:^|\.)([^.[\]]+)|\[(\d+)\]/g;
  let end = 0;
  for (const match of path.matchAll(matcher)) {
    if (match.index !== end)
      return { found: false, error: "Invalid path syntax" };
    tokens.push(match[1] ?? Number(match[2]));
    end = match.index + match[0].length;
  }
  if (end !== path.length || !tokens.length)
    return { found: false, error: "Invalid path syntax" };
  let current = value;
  for (const token of tokens) {
    if (
      !current ||
      typeof current !== "object" ||
      (typeof token === "number" && !Array.isArray(current)) ||
      !Object.hasOwn(current, token)
    )
      return { found: false };
    current = (current as Record<string | number, unknown>)[token];
  }
  return { found: true, value: current };
}

type DimensionQuery = z.infer<typeof dimensionQuerySchema>["queries"][number];

interface DimensionSelection {
  found: boolean;
  value?: unknown;
  error?: string;
  page?: { value: unknown; total: number; nextOffset?: number };
}

/** What one query selects inside a value: its path, then its offset/limit page. */
function selectQuery(
  value: unknown,
  query: DimensionQuery,
): DimensionSelection {
  const picked = query.path
    ? readPath(value, query.path)
    : { found: true, value };
  if (
    !picked.found ||
    (query.offset === undefined && query.limit === undefined)
  )
    return picked;
  const offset = query.offset ?? 0,
    limit = query.limit ?? 100;
  const collection =
    typeof picked.value === "string"
      ? Array.from(picked.value)
      : Array.isArray(picked.value)
        ? picked.value
        : picked.value && typeof picked.value === "object"
          ? Object.entries(picked.value)
          : undefined;
  if (!collection) return picked;
  const slice = collection.slice(offset, offset + limit);
  return {
    ...picked,
    page: {
      value:
        typeof picked.value === "string"
          ? slice.join("")
          : Array.isArray(picked.value)
            ? slice
            : Object.fromEntries(slice as [string, unknown][]),
      total: collection.length,
      ...(offset + limit < collection.length
        ? { nextOffset: offset + limit }
        : {}),
    },
  };
}

function selectionLine(
  label: string,
  version: number,
  shown: DimensionSelection,
  queryCount: number,
): string {
  if (!shown.found) return `${label}: not found`;
  const json = JSON.stringify(shown.page ?? shown.value);
  const budget = shown.page ? Math.floor(7600 / queryCount) : 320;
  return `${label} (v${version}) = ${json.length > budget ? `${json.slice(0, budget)}… [truncated; query a narrower path or smaller offset/limit page]` : json}`;
}

/**
 * Explicit queries keep their full public result; model text has a fixed
 * budget. The text selects inside the `modelFacingJson` projection, so a
 * direct query of `sessionId` cannot turn bookkeeping into a nameless scalar.
 */
export function queryDimensionSnapshot(
  snapshot: DimensionSnapshot,
  input: unknown,
  locale?: string,
) {
  const parsed = dimensionQuerySchema.parse(input);
  const dimensions = dimensionSnapshotSchema.parse(snapshot);
  const answers = parsed.queries.map((query) => {
    const label = `${query.dimension}${query.path ? `.${query.path}` : ""}`;
    const entry = dimensions[query.dimension];
    if (!entry)
      return {
        result: {
          ...query,
          found: false as const,
          value: null,
          error: "Unknown dimension",
        },
        line: `${label}: not found`,
      };
    const shown = selectQuery(modelFacingJson(entry.value), query);
    return {
      result: {
        ...query,
        ...selectQuery(entry.value, query),
        name: resolveI18nText(entry.name, locale),
        schema: entry.schema,
        version: entry.version,
      },
      line: selectionLine(label, entry.version, shown, parsed.queries.length),
    };
  });
  const text = answers.map((answer) => answer.line).join("\n");
  return {
    success: true,
    results: answers.map((answer) => answer.result),
    _text: text.slice(0, 8192),
  };
}

const CUT_VALUE_LENGTH = 240;

/**
 * Model projection of the current dimensions. Values are shown whole while
 * the snapshot fits `maxChars`, because each value cut short sends the model
 * to `world-dimension-get`, a round trip that resends the whole prompt.
 * Over budget, the longest values are cut to 240 characters (marked `…`)
 * until it fits; dimensions that still do not fit are omitted by count.
 * Current values only: never author initial values or maintenance rules.
 */
export function projectDimensionSnapshot(
  snapshot: DimensionSnapshot,
  locale?: string,
  maxChars = 12000,
): string {
  const entries = Object.entries(snapshot).map(([id, entry]) => ({
    head: `${id} (${resolveI18nText(entry.name, locale)}, v${entry.version}): `,
    value: JSON.stringify(entry.value),
    cut: false,
  }));
  const shown = (entry: (typeof entries)[number]) =>
    entry.cut ? `${entry.value.slice(0, CUT_VALUE_LENGTH)}…` : entry.value;
  const budget = maxChars - 100;
  let total = entries.reduce(
    (sum, entry) => sum + entry.head.length + entry.value.length + 1,
    0,
  );
  for (const entry of [...entries].sort(
    (a, b) => b.value.length - a.value.length,
  )) {
    if (total <= budget || entry.value.length <= CUT_VALUE_LENGTH) break;
    total -= entry.value.length - shown({ ...entry, cut: true }).length;
    entry.cut = true;
  }
  let text = "";
  let omitted = 0;
  for (const entry of entries) {
    const line = `${entry.head}${shown(entry)}\n`;
    if (text.length + line.length > budget) {
      omitted++;
      continue;
    }
    text += line;
  }
  if (omitted)
    text +=
      instructionLocaleFor(locale) === "zh"
        ? `[有 ${omitted} 个维度未列出；需要详情时按 ID 查询。]`
        : `[${omitted} dimensions omitted; query by ID for details.]`;
  return text;
}
