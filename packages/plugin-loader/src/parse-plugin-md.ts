/**
 * PLUGIN.md parser — extracts frontmatter manifest + prompt template.
 */

import matter from "gray-matter";
import { z } from "zod";
import {
  authorsNoteDeclSchema,
  HOOK_EVENTS,
  postHistoryDeclSchema,
  rpcDeclMapSchema,
  runtimeManifestSchema,
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
  const firstIssue = zerr.issues[0];
  if (!firstIssue)
    return "Check the PLUGIN.md frontmatter against docs/reference/plugins.md.";

  const path = firstIssue.path.join(".");
  const code = firstIssue.code;

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
  if (path === "priority") {
    return "`priority` is legacy — declare a named `stage` instead (e.g. `stage: post-turn`); if kept for compat it must be an integer between 0 and 1000.";
  }
  if (code === "unrecognized_keys") {
    return `Remove or rename the unknown field at "${path}" — refer to docs/reference/plugins.md for the full frontmatter schema.`;
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
 * declaration order. Mirrors the per-entry lenient handling used for `hooks`:
 * one bad field drops itself with a warning, the rest of the plugin still
 * loads. Adding a new lenient field is a one-line entry here, not a new block.
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
  {
    // rpc declarations — drop the whole rpc block on structural error so
    // a typo in one action doesn't crash the load.
    key: "rpc",
    schema: rpcDeclMapSchema,
    problem: "malformed rpc declaration skipped",
    fix: "Each rpc action needs a lowercase kebab-case name and a `handler` path ending in .js/.mjs/.cjs, relative to the plugin root.",
  },
];

// ── Valid hook event names ────────────────────────────────────────

// Built from the single source of truth (@covel/shared HOOK_EVENTS) so the
// loader's accept-list can never drift from the framework's hook contract.
const VALID_HOOK_EVENTS = new Set<string>(HOOK_EVENTS);

/** Fold a schema-validated description (string | non-empty i18n map) to one string. */
function foldI18nDescription(raw: string | Record<string, string>): string {
  if (typeof raw === "string") return raw;
  return (
    raw["en"] ??
    raw["en-US"] ??
    raw["zh"] ??
    raw["zh-CN"] ??
    Object.values(raw)[0] ??
    ""
  );
}

/**
 * Lenient hook schema that accepts any string for `event`, used to
 * pre-validate hooks before filtering out unknown event names with a warning.
 * Built from scratch (not extending hookDeclarationSchema) to avoid .strict() incompatibility.
 */
const lenientHookDeclarationSchema = z.object({
  event: z.string().min(1),
  handler: z.string().min(1),
  match: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  timeoutMs: z.number().int().positive().optional(),
  enforce: z.enum(["pre", "normal", "post"]).optional(),
});

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
    // Parse hooks leniently (accept any string for event) so we can warn
    // on unknown event names instead of throwing. All other fields remain
    // strictly validated. Non-hook fields are validated by runtimeManifestSchema.
    let dataToValidate = data;

    const rawHooks: Array<{
      event: string;
      handler: string;
      [k: string]: unknown;
    }> = [];

    if (Array.isArray(data.hooks)) {
      // Validate per-entry (not per-array) so a single malformed entry only drops
      // itself with a warning, instead of silently dropping the entire hooks
      // list when one entry has e.g. `handler: 123`.
      const hooksLine = findYamlKeyLine(content, "hooks");
      for (const rawEntry of data.hooks) {
        const parsed = lenientHookDeclarationSchema.safeParse(rawEntry);
        if (!parsed.success) {
          console.warn(
            formatLoaderError(
              filePath,
              hooksLine,
              `malformed hook entry skipped — ${parsed.error.issues.map((i) => i.message).join("; ")}`,
              "Each hook needs a string `event` and string `handler`. See docs/reference/plugins.md#hooks.",
            ),
          );
          continue;
        }
        const entry = parsed.data;
        if (!VALID_HOOK_EVENTS.has(entry.event)) {
          console.warn(
            formatLoaderError(
              filePath,
              hooksLine,
              `unknown hook event "${entry.event}" — skipping`,
              `Use one of the valid events: ${[...VALID_HOOK_EVENTS].join(", ")}.`,
            ),
          );
          continue;
        }
        rawHooks.push(
          entry as { event: string; handler: string; [k: string]: unknown },
        );
      }
      // Replace hooks with the filtered valid ones for strict schema
      // validation. Spread from `dataToValidate` (not the raw `data`) so any
      // earlier normalization stays applied (authorsNote/postHistory/rpc
      // below already chain off `dataToValidate`).
      const { hooks: _omitted, ...dataWithoutHooks } = dataToValidate as Record<
        string,
        unknown
      >;
      dataToValidate =
        rawHooks.length > 0
          ? { ...dataWithoutHooks, hooks: rawHooks }
          : dataWithoutHooks;
    }

    // Optional decorative / structural metadata fields parsed leniently in
    // declaration order. A single malformed declaration drops only that field
    // with a warning instead of crashing the whole plugin load, mirroring the
    // per-entry lenient handling used for `hooks` above. See LENIENT_FIELDS.
    if (dataToValidate && typeof dataToValidate === "object") {
      let lenientData = dataToValidate as Record<string, unknown>;
      for (const spec of LENIENT_FIELDS) {
        lenientData = parseLenientField(lenientData, spec, content, filePath);
      }
      // Deprecated field: `config` was removed in favour of `userSettings`.
      // Strip it with a warning instead of crashing the (strict) load, so a
      // third-party plugin written against the old docs gets a deprecation
      // cycle rather than a hard load failure.
      if ("config" in lenientData) {
        console.warn(
          formatLoaderError(
            filePath,
            findYamlKeyLine(content, "config"),
            "`config` is deprecated and ignored — it was removed in favour of `userSettings`.",
            "Declare player-tunable settings with `userSettings` (see docs/guide/plugin-authoring-zero-code.md §7).",
          ),
        );
        const { config: _deprecatedConfig, ...rest } = lenientData;
        lenientData = rest;
      }
      dataToValidate = lenientData;
    }

    const parsed = runtimeManifestSchema.parse(dataToValidate);
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
      description: foldI18nDescription(parsed.description),
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
