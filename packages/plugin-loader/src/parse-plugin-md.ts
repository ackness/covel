/**
 * PLUGIN.md parser — extracts frontmatter manifest + prompt template.
 */

import matter from "gray-matter";
import {
  authorsNoteDeclSchema,
  postHistoryDeclSchema,
  resolveI18nText,
  runtimeManifestInputSchema,
} from "@covel/shared";
import type { ParsedPluginMd } from "./types.js";

// ── Diagnostic helpers ────────────────────────────────────────────

/**
 * Locate the 1-based line number of a top-level YAML key inside the raw
 * PLUGIN.md source. Returns `null` when the key is not found.
 * Used purely for diagnostic messages — not parsing.
 */
function findYamlKeyLine(source: string, key: string): number | null {
  const lines = source.split(/\r?\n/);
  // Scan only until the second `---` fence so we stay within frontmatter.
  const re = new RegExp(`^${escapeRegex(key)}\\s*:`);
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("---")) {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      }
      return null;
    }
    if (inFrontmatter && re.test(trimmed)) return i + 1;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ZodError-shaped detection that survives multiple `zod` versions coexisting
 * in the monorepo — `@covel/shared` may throw a ZodError whose prototype
 * points at a different `zod` module than the one imported here, which
 * makes `instanceof z.ZodError` unreliable. We match on shape instead.
 */
interface ZodIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
  /** Present on `unrecognized_keys`; the offending names live here, not in `path`. */
  readonly keys?: readonly string[];
  /** Present on `invalid_union`; one entry per union branch that failed. */
  readonly errors?: readonly (readonly ZodIssue[])[];
}

/**
 * Zod reports a failed union as a single `invalid_union` issue whose real
 * detail sits one level down, one array per branch. Left alone the hint
 * degrades to a bare "Invalid input", which tells a plugin author nothing —
 * so unwrap to the first branch issue naming an unrecognized key, rebasing its
 * path onto the union's. Non-union issues pass through untouched.
 */
function unwrapUnionIssue(issue: ZodIssue | undefined): ZodIssue | undefined {
  if (!issue || issue.code !== "invalid_union" || !issue.errors) return issue;
  for (const branch of issue.errors) {
    const inner = branch.find((i) => i.code === "unrecognized_keys");
    if (inner) return { ...inner, path: [...issue.path, ...inner.path] };
  }
  return issue;
}
interface ZodErrorLike {
  readonly name: string;
  readonly issues: readonly ZodIssue[];
}
function asZodErrorLike(err: unknown): ZodErrorLike | null {
  if (!err || typeof err !== "object") return null;
  const maybe = err as { name?: unknown; issues?: unknown };
  if (maybe.name !== "ZodError") return null;
  if (!Array.isArray(maybe.issues)) return null;
  return err as unknown as ZodErrorLike;
}

/**
 * Try to derive a short, actionable "Fix:" suggestion from a Zod validation
 * error. Falls back to a generic pointer at the schema docs when the issue
 * isn't one of the well-known cases.
 */
function deriveFixHint(error: unknown): string {
  const zerr = asZodErrorLike(error);
  if (!zerr) {
    return "Check the PLUGIN.md frontmatter against docs/reference/plugins.md.";
  }
  const firstIssue = unwrapUnionIssue(zerr.issues[0]);
  if (!firstIssue)
    return "Check the PLUGIN.md frontmatter against docs/reference/plugins.md.";

  const path = firstIssue.path.join(".");
  const code = firstIssue.code;

  // Unknown keys come first: Zod reports them with an EMPTY `path` and the
  // offending names in `keys`, so the `!path` branch below would otherwise
  // swallow them behind the (wrong) "missing frontmatter" hint.
  if (code === "unrecognized_keys") {
    const keys = firstIssue.keys ?? (path ? [path] : []);
    // Fields that were removed rather than misspelled: name the replacement,
    // since "unknown field" alone would not tell the author where to go.
    const replacements: Record<string, string> = {
      priority:
        "`priority` was removed — declare a named `stage` instead (e.g. `stage: post-turn`).",
      upstreamRequired:
        "`upstreamRequired` was removed — declare `needs` instead (same entries, turn-scoped by default).",
      local:
        "`tools.local` was removed — register the tool in the plugin's `entry` module " +
        "(`covel.registerTool`) and list its NAME under `tools.plugin`.",
      capability:
        "a `relations` entry cannot target a `capability` — nothing ever resolved it, " +
        "so it was removed. Name the plugin id instead. For a capability-based " +
        "*scheduling* dependency use `needs` / `after`, which do resolve capabilities.",
      tag: "a `relations` entry cannot target a `tag` — nothing ever resolved it, so it was removed. Name the plugin id instead.",
    };
    const replaced = keys.filter((k) => k in replacements);
    if (replaced.length > 0) {
      return replaced.map((k) => replacements[k]).join(" ");
    }
    const label = keys.length > 0 ? keys.map((k) => `"${k}"`).join(", ") : path;
    return `Remove or rename the unknown field ${label} — refer to docs/reference/plugins.md for the full frontmatter schema.`;
  }

  // Common, author-facing failures — keep these terse and specific.
  if (!path) {
    return "Ensure the PLUGIN.md file begins with `---` and contains valid YAML frontmatter.";
  }
  if (path === "name") {
    return "Set `name` to a lowercase kebab-case id (e.g. `narrator` or `my-plugin/runtime-name`).";
  }
  if (path === "description") {
    return 'Add a `description:` field — either a single string or an i18n map like `description: { en-US: "...", zh-CN: "..." }`.';
  }
  // The object form of a relation entry was removed; the value is now just the
  // id. Without this the author only sees "expected string, received object".
  if (path.startsWith("relations.")) {
    return (
      `A \`relations\` entry is now just the plugin id — write \`- some-plugin\` ` +
      `(or \`- some-plugin/its-runtime\`), not an object. The old ` +
      `\`target\` / \`plugin\` / \`runtime\` / \`type\` / \`optional\` / \`reason\` keys were ` +
      `removed: only the id was ever read. Explain the dependency in a YAML comment above it.`
    );
  }
  if (code === "invalid_type") {
    return `Field "${path}" has the wrong type — ${firstIssue.message}.`;
  }
  return `Field "${path}": ${firstIssue.message}.`;
}

/**
 * Build the canonical plugin-loader error message. Centralised so every
 * throw site uses the same `[plugin-loader] <path>[:line]: ...\nFix: ...`
 * layout, which is what the authoring docs ask plugin developers to grep
 * for when their plugin fails to load.
 */
function formatLoaderError(
  filePath: string,
  line: number | null,
  problem: string,
  fix: string,
): string {
  const location = line !== null ? `${filePath}:${line}` : filePath;
  return `[plugin-loader] ${location}: ${problem}\nFix: ${fix}`;
}

// ── Lenient whole-field parsing ───────────────────────────────────

/**
 * Minimal structural shape of a Zod-like schema. Matched structurally (not via
 * `instanceof`) so it survives multiple `zod` versions coexisting in the
 * monorepo — same reasoning as `asZodErrorLike`.
 */
interface LenientSchema {
  safeParse(value: unknown):
    | { readonly success: true }
    | {
        readonly success: false;
        readonly error: { readonly issues: ReadonlyArray<{ message: string }> };
      };
}

/**
 * Declarative description of an optional frontmatter field that is parsed
 * leniently: a single malformed declaration drops only that field with a
 * warning instead of crashing the whole plugin load.
 */
interface LenientFieldSpec {
  /** Top-level frontmatter key (also used for `findYamlKeyLine`). */
  readonly key: string;
  /** Schema validating the field value. */
  readonly schema: LenientSchema;
  /** Problem prefix, e.g. `"malformed authorsNote skipped"`. */
  readonly problem: string;
  /** Author-facing `Fix:` hint. */
  readonly fix: string;
}

/**
 * Validate one lenient frontmatter field. On success returns `data` unchanged.
 * On failure: warn with the canonical `file:line` + Fix layout (identical to
 * the per-field blocks this replaces), drop the offending key, and return a new
 * object so the rest of the manifest still loads. Never throws, never mutates.
 */
function parseLenientField(
  data: Record<string, unknown>,
  spec: LenientFieldSpec,
  content: string,
  filePath: string,
): Record<string, unknown> {
  if (!(spec.key in data)) return data;
  const parsed = spec.schema.safeParse(data[spec.key]);
  if (parsed.success) return data;
  console.warn(
    formatLoaderError(
      filePath,
      findYamlKeyLine(content, spec.key),
      `${spec.problem} — ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      spec.fix,
    ),
  );
  const { [spec.key]: _omitted, ...rest } = data;
  return rest;
}

/**
 * Optional decorative / structural metadata fields validated leniently in
 * declaration order. One bad field drops itself with a warning while the rest
 * of the plugin still loads.
 */
const LENIENT_FIELDS: readonly LenientFieldSpec[] = [
  {
    // Author's note — wrong type on e.g. `depth` should not crash load.
    key: "authorsNote",
    schema: authorsNoteDeclSchema,
    problem: "malformed authorsNote skipped",
    fix: 'An authorsNote must have `content: string` and optional `depth: number` / `role: "system" | "user" | "assistant"`.',
  },
  {
    // Post-history note.
    key: "postHistory",
    schema: postHistoryDeclSchema,
    problem: "malformed postHistory skipped",
    fix: 'A postHistory entry must have `content: string` and optional `role: "system" | "user" | "assistant"`.',
  },
];

/**
 * Parse a PLUGIN.md file content into structured data.
 *
 * @param content - Raw file content (YAML frontmatter + Markdown body)
 * @param filePath - File path for error reporting
 * @returns Parsed manifest and prompt template
 * @throws {Error} When frontmatter is missing or invalid
 */
export function parsePluginMd(
  content: string,
  filePath: string,
): ParsedPluginMd {
  const { data, content: body } = matter(content);

  let manifest;
  try {
    let dataToValidate = data;

    // Optional decorative / structural metadata fields parsed leniently in
    // declaration order. A malformed decorative declaration drops only that
    // field with a warning instead of crashing the whole plugin load.
    if (dataToValidate && typeof dataToValidate === "object") {
      let lenientData = dataToValidate as Record<string, unknown>;
      for (const spec of LENIENT_FIELDS) {
        lenientData = parseLenientField(lenientData, spec, content, filePath);
      }
      dataToValidate = lenientData;
    }

    const parsed = runtimeManifestInputSchema.parse(dataToValidate);
    // Derive pluginId from name: "world-init/schema-gen" → "world-init"
    // Single-runtime plugins: pluginId === name
    const slashIdx = parsed.name.indexOf("/");
    const pluginId =
      slashIdx >= 0 ? parsed.name.slice(0, slashIdx) : parsed.name;
    // Fold an I18nText `description` map to a single string:
    // `RuntimeManifest.description` is used inline in LLM traces / tool
    // registries and doesn't need locale routing (the user-facing UI reads
    // I18nText from `PluginSummary.description`, loaded separately from the
    // raw YAML). Prefer English so runtime traces stay ASCII-friendly, fall
    // back to Chinese or any other available locale.
    manifest = {
      ...parsed,
      description: resolveI18nText(parsed.description, "en") ?? "",
      pluginId,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Best-effort: attach the source line for the first failing key so the
    // plugin author can jump straight to the offending line.
    let line: number | null = null;
    const zerr = asZodErrorLike(error);
    if (zerr && zerr.issues[0]?.path.length) {
      const topKey = String(zerr.issues[0].path[0]);
      line = findYamlKeyLine(content, topKey);
    }
    throw new Error(
      formatLoaderError(
        filePath,
        line,
        `invalid PLUGIN.md frontmatter — ${message}`,
        deriveFixHint(error),
      ),
    );
  }

  return {
    manifest,
    promptTemplate: body,
    rawFrontmatter: { ...data } as Readonly<Record<string, unknown>>,
  };
}
