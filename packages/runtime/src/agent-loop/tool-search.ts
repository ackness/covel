/**
 * Deferred tool loading (tool-search) — runtime side.
 *
 * The manifest half (`tools.defer`) and the ranking half (BM25) live in
 * `@covel/shared` / `@covel/tools`; this module derives the deferred name
 * set, builds the LLM-facing `search-tools` definition, and executes a
 * search when the agent loop intercepts the sentinel call (see
 * turn-agent-tool-loop.ts — same interception pattern as `suspend` /
 * `runtime-done`; the executor tool map never sees `search-tools`).
 *
 * Authorization is inherited: the searchable pool is exactly the runtime's
 * own declared whitelist, and every schema is fetched through
 * `ToolExecutor.getToolInfo(name, context)`, which enforces the same
 * builtin/local access rules as advertisement — an unauthorized tool can
 * neither be found nor activated.
 */

import type { RuntimeManifest } from "@covel/shared";
import {
  buildSearchToolsDescription,
  parameterSchemaSearchText,
  rankToolSearchDocs,
  SEARCH_TOOLS_DEFAULT_LIMIT,
  SEARCH_TOOLS_JSON_SCHEMA,
  SEARCH_TOOLS_MAX_LIMIT,
  SEARCH_TOOLS_TOOL_NAME,
  type ToolSearchDoc,
} from "@covel/tools";
import type { LLMToolDefinition } from "../llm/llm-adapter.js";
import type { ToolCallContext, ToolExecutor } from "./tool-executor.js";

export { SEARCH_TOOLS_TOOL_NAME };

/**
 * The runtime's declared tool names, in advertisement form (local paths
 * reduced to their file basename). Single source for both the initial
 * advertisement list and the deferred-pool derivation, so the two can never
 * disagree on a name.
 */
export function declaredToolNames(manifest: RuntimeManifest): string[] {
  const names: string[] = [
    ...(manifest.tools?.builtin ?? []),
    ...(manifest.tools?.plugin ?? []),
  ];
  for (const p of manifest.tools?.local ?? []) {
    names.push(
      p
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? p,
    );
  }
  return names;
}

/**
 * Resolve `tools.defer` into a concrete name set. `true` defers the whole
 * declared whitelist; an array defers just those names (entries not present
 * in the whitelist are ignored — deferring can never grant access to a tool
 * the runtime did not declare).
 */
export function resolveDeferredToolNames(
  manifest: RuntimeManifest,
): ReadonlySet<string> {
  const defer = manifest.tools?.defer;
  if (!defer) return new Set();
  const all = declaredToolNames(manifest);
  if (defer === true) return new Set(all);
  const allSet = new Set(all);
  return new Set(defer.filter((name) => allSet.has(name)));
}

/** The injected `search-tools` LLM definition, advertising the pool size. */
export function buildSearchToolsDefinition(
  deferredCount: number,
  pluginId: string,
): LLMToolDefinition {
  return {
    name: SEARCH_TOOLS_TOOL_NAME,
    description: buildSearchToolsDescription(deferredCount, pluginId),
    parameters: SEARCH_TOOLS_JSON_SCHEMA as Record<string, unknown>,
  };
}

export interface ToolSearchExecution {
  /** Tool-result text fed back to the LLM. */
  readonly resultText: string;
  /** Structured result recorded in the runtime's toolCalls trace. */
  readonly parsedResult: {
    readonly activated: readonly string[];
    readonly query: string;
  };
  /** Newly activated definitions to append to the loop's tool list. */
  readonly activated: readonly LLMToolDefinition[];
}

/**
 * Execute a `search-tools` call: rank the still-deferred pool with BM25 and
 * activate up to `limit` matches. Idempotent per name — tools already
 * advertised or previously activated are excluded from the pool.
 */
export function executeToolSearch(args: {
  readonly argumentsJson: string;
  readonly deferredNames: ReadonlySet<string>;
  readonly activeNames: ReadonlySet<string>;
  readonly toolExecutor: ToolExecutor;
  readonly context: ToolCallContext;
}): ToolSearchExecution {
  const { deferredNames, activeNames, toolExecutor, context } = args;

  let query = "";
  let limit = SEARCH_TOOLS_DEFAULT_LIMIT;
  try {
    const parsed = JSON.parse(args.argumentsJson) as {
      query?: unknown;
      limit?: unknown;
    };
    if (typeof parsed.query === "string") query = parsed.query.trim();
    if (typeof parsed.limit === "number" && Number.isFinite(parsed.limit)) {
      limit = Math.max(1, Math.min(SEARCH_TOOLS_MAX_LIMIT, parsed.limit));
    }
  } catch {
    // Fall through with empty query → error text below.
  }
  if (!query) {
    return {
      resultText:
        "search-tools requires a non-empty `query` string describing the capability you need.",
      parsedResult: { activated: [], query: "" },
      activated: [],
    };
  }

  const pool: { doc: ToolSearchDoc; def: LLMToolDefinition }[] = [];
  for (const name of deferredNames) {
    if (activeNames.has(name)) continue;
    const info = toolExecutor.getToolInfo(name, context);
    if (!info) continue;
    const parameters = info.jsonSchema as Record<string, unknown>;
    pool.push({
      doc: {
        key: info.name,
        text: `${info.name} ${info.description} ${parameterSchemaSearchText(parameters)}`,
      },
      def: { name: info.name, description: info.description, parameters },
    });
  }

  const ranked = rankToolSearchDocs(
    query,
    pool.map((p) => p.doc),
    limit,
  );
  if (ranked.length === 0) {
    return {
      resultText:
        `No matching tools among ${pool.length} deferred tool(s) for "${query}". ` +
        `Try different capability keywords.`,
      parsedResult: { activated: [], query },
      activated: [],
    };
  }

  const byName = new Map(pool.map((p) => [p.def.name, p.def]));
  const activated = ranked
    .map((name) => byName.get(name))
    .filter((def): def is LLMToolDefinition => def !== undefined);
  const lines = activated.map((d) => `- ${d.name}: ${d.description}`);
  return {
    resultText:
      `Activated ${activated.length} tool(s) — directly callable from your next step:\n` +
      lines.join("\n"),
    parsedResult: { activated: activated.map((d) => d.name), query },
    activated,
  };
}
