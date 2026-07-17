/**
 * search-tools — framework-injected tool discovery (deferred tool loading).
 *
 * When a runtime's manifest defers part of its tool whitelist
 * (`tools.defer: true | string[]`), the deferred tools' schemas are omitted
 * from the initial LLM tool list and this tool is injected instead. The LLM
 * searches by capability keywords; matching tools are activated for the NEXT
 * model call and stay active for the rest of the current turn's agent loop.
 *
 * Modeled after openai/codex's `tool_search` (ToolExposure::Deferred + BM25
 * over name/description/parameter-schema text, default limit 8). Like
 * `suspend` / `runtime-done`, execution is intercepted in the agent loop —
 * this module only carries the LLM-facing contract and the ranking function;
 * it is never registered in the executor tool map and never declarable in a
 * plugin's own whitelist.
 *
 * Scoring is a self-contained BM25 (k1=1.2, b=0.75). CJK text is tokenized
 * into character bigrams (segmenter-free standard), and query terms that
 * still don't match a whole token earn substring credit — Chinese queries
 * and descriptions match without a dictionary. Zero dependencies by design —
 * a per-runtime pool is tens of documents, not thousands.
 */

export const SEARCH_TOOLS_TOOL_NAME = "search-tools";

export const SEARCH_TOOLS_DEFAULT_LIMIT = 8;
export const SEARCH_TOOLS_MAX_LIMIT = 20;

/** JSON schema for the LLM-facing `search-tools` definition. */
export const SEARCH_TOOLS_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Capability keywords describing the tool you need (English or Chinese), e.g. 'change scene background' / '切换场景背景'.",
    },
    limit: {
      type: "number",
      description: `Maximum number of tools to activate (default ${SEARCH_TOOLS_DEFAULT_LIMIT}, max ${SEARCH_TOOLS_MAX_LIMIT}).`,
    },
  },
  required: ["query"],
};

/**
 * LLM-facing description. Advertises the deferred pool (count + owner) so the
 * model knows undeclared tools exist at all — without this hint a deferred
 * pool is effectively invisible (codex does the same in its tool_search
 * description).
 */
export function buildSearchToolsDescription(
  deferredCount: number,
  pluginId: string,
): string {
  return (
    `This runtime has ${deferredCount} additional tool(s) from plugin "${pluginId}" ` +
    `that were NOT preloaded into your tool list (deferred to save context). ` +
    `Search them by describing the capability you need; matching tools are ` +
    `activated and become directly callable from your next step onward. ` +
    `Call this first whenever none of your current tools fits the task.`
  );
}

// ── BM25 ranking ─────────────────────────────────────────────────

export interface ToolSearchDoc {
  /** Stable key returned by {@link rankToolSearchDocs} (the tool name). */
  readonly key: string;
  /** Indexed text: tool name + description + parameter-schema text. */
  readonly text: string;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Substring (CJK) match counts as a fractional term occurrence. */
const SUBSTRING_TF = 0.5;

const CJK_CHAR = /[぀-ヿ一-鿿]/;
const CJK_RUN_SPLIT = /([぀-ヿ一-鿿]+)/;

/**
 * Tokenizer: whitespace/punctuation split for Latin text, character BIGRAMS
 * for CJK runs (the standard segmenter-free approach — "解锁图鉴" → 解锁/锁图/
 * 图鉴 matches a description phrased "解锁…图鉴条目" even when the words are
 * not adjacent). NOT deduplicated: BM25 needs term frequencies. Query-side
 * callers dedupe themselves.
 */
export function tokenizeForToolSearch(text: string): string[] {
  const rough = text
    .toLowerCase()
    .split(/[\s,.:;!?，。：；！？、\-—""''()（）【】[\]{}"/\\_]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const token of rough) {
    if (!CJK_CHAR.test(token)) {
      if (token.length >= 2) out.push(token);
      continue;
    }
    for (const segment of token.split(CJK_RUN_SPLIT).filter(Boolean)) {
      if (!CJK_CHAR.test(segment)) {
        if (segment.length >= 2) out.push(segment);
      } else if (segment.length === 1) {
        out.push(segment);
      } else {
        for (let i = 0; i < segment.length - 1; i += 1) {
          out.push(segment.slice(i, i + 2));
        }
      }
    }
  }
  return out;
}

/**
 * Rank documents against a query with BM25, returning up to `limit` keys,
 * best first. Documents with zero overlap (token or substring) are dropped.
 */
export function rankToolSearchDocs(
  query: string,
  docs: readonly ToolSearchDoc[],
  limit: number,
): string[] {
  if (limit <= 0 || docs.length === 0) return [];
  const queryTerms = [...new Set(tokenizeForToolSearch(query))];
  if (queryTerms.length === 0) return [];

  const prepared = docs.map((doc) => {
    const tokens = tokenizeForToolSearch(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return {
      key: doc.key,
      lowerText: doc.text.toLowerCase(),
      tf,
      len: Math.max(tokens.length, 1),
    };
  });
  const avgLen = prepared.reduce((sum, d) => sum + d.len, 0) / prepared.length;

  // Term frequency with CJK substring fallback — a Chinese description
  // tokenizes into long runs, so `包含` matching inside a token still counts.
  const termFrequency = (
    doc: (typeof prepared)[number],
    term: string,
  ): number =>
    doc.tf.get(term) ?? (doc.lowerText.includes(term) ? SUBSTRING_TF : 0);

  const docFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    docFrequency.set(
      term,
      prepared.filter((d) => termFrequency(d, term) > 0).length,
    );
  }

  const n = prepared.length;
  const scored = prepared
    .map((doc) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = termFrequency(doc, term);
        if (tf === 0) continue;
        const df = docFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = 1 - BM25_B + BM25_B * (doc.len / avgLen);
        score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
      }
      return { key: doc.key, score };
    })
    .filter((d) => d.score > 0);

  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((d) => d.key);
}

/**
 * Flatten a JSON-schema parameters object into searchable text: property
 * names + `description` strings, recursively. Field names and descriptions
 * carry the capability signal (codex indexes the schema for the same
 * reason); structural keywords (`type: object`) are uniform noise and
 * excluded.
 */
export function parameterSchemaSearchText(
  schema: Readonly<Record<string, unknown>> | undefined,
): string {
  if (!schema) return "";
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj["description"] === "string") {
      parts.push(obj["description"]);
    }
    const props = obj["properties"];
    if (props && typeof props === "object") {
      for (const [name, child] of Object.entries(
        props as Record<string, unknown>,
      )) {
        parts.push(name);
        walk(child);
      }
    }
    if (obj["items"]) walk(obj["items"]);
  };
  walk(schema);
  return parts.join(" ");
}
