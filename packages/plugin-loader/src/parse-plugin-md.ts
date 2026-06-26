/**
 * PLUGIN.md parser — extracts frontmatter manifest + prompt template.
 */

import matter from "gray-matter";
import { z } from "zod";
import {
  authorsNoteDeclSchema,
  FRAMEWORK_KNOWN_CAPABILITIES,
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
    return "Set `priority` to an integer between 0 and 1000 (e.g. `priority: 500`).";
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

// ── Valid hook event names ────────────────────────────────────────

// Built from the single source of truth (@covel/shared HOOK_EVENTS) so the
// loader's accept-list can never drift from the framework's hook contract.
const VALID_HOOK_EVENTS = new Set<string>(HOOK_EVENTS);

// ── Framework-known capability typo detection ─────────────────────

// Capability tags the framework itself discovers / dispatches on, from the
// single source of truth in @covel/shared (plugin-level FrameworkCapability +
// runtime-level FrameworkRuntimeCapability). Plugins may declare arbitrary
// custom capabilities — we do NOT reject unknown ones. We only warn when a
// declared tag looks like a *misspelled* framework-known capability, so the
// typo surfaces at load time instead of as a silent `?.includes` miss that
// disables a feature (e.g. an image plugin tagging `image-genrator`).
const KNOWN_CAPABILITIES: readonly string[] = FRAMEWORK_KNOWN_CAPABILITIES;
const KNOWN_CAPABILITY_SET = new Set<string>(KNOWN_CAPABILITIES);

/** Normalize a capability tag for case/separator-insensitive comparison. */
function normalizeCapability(cap: string): string {
  return cap
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-");
}

/** Levenshtein edit distance between two short strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Find the framework-known capability a declared tag most likely *meant* to be
 * when it is not an exact match. Catches case/separator drift (`Image_Generator`)
 * and one/two-character typos (`image-genrator`, `memory-pannel`). Returns null
 * for genuinely-custom tags so plugins keep full freedom to invent their own
 * capabilities.
 */
function suspectedCapabilityTypo(cap: string): string | null {
  if (KNOWN_CAPABILITY_SET.has(cap)) return null;
  const normalized = normalizeCapability(cap);
  // 1. Case / separator drift maps onto a known tag exactly.
  for (const known of KNOWN_CAPABILITIES) {
    if (normalizeCapability(known) === normalized) return known;
  }
  // 2. A short edit away from a known tag of similar length.
  for (const known of KNOWN_CAPABILITIES) {
    if (
      Math.abs(cap.length - known.length) <= 2 &&
      levenshtein(cap, known) <= 2
    )
      return known;
  }
  return null;
}

/**
 * Emit a dev warning for each declared capability that looks like a misspelled
 * framework-known capability. Mirrors the lenient hook-event validation style:
 * never throws, never drops the tag — capabilities stay free-form — it only
 * nudges the author toward the intended spelling.
 */
function warnOnSuspectedCapabilityTypos(
  capabilities: readonly string[] | undefined,
  content: string,
  filePath: string,
): void {
  if (!capabilities || capabilities.length === 0) return;
  const line = findYamlKeyLine(content, "capabilities");
  for (const cap of capabilities) {
    const suggestion = suspectedCapabilityTypo(cap);
    if (suggestion === null) continue;
    console.warn(
      formatLoaderError(
        filePath,
        line,
        `capability "${cap}" looks like a misspelled framework capability "${suggestion}" — the framework will not discover this plugin by it`,
        `Did you mean "${suggestion}"? If "${cap}" is an intentional custom capability, ignore this. Framework-known capabilities: ${KNOWN_CAPABILITIES.join(", ")}.`,
      ),
    );
  }
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

/** Regex to extract markdown links pointing to `references/` paths. */
const REFERENCE_LINK_RE = /\[([^\]]*)\]\((references\/[^)]+)\)/g;

/**
 * Extract reference file paths from markdown body.
 */
function extractReferenceLinks(body: string): readonly string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_LINK_RE.exec(body)) !== null) {
    links.push(match[2]);
  }
  return links;
}

/**
 * Parse a PLUGIN.md file content into structured data.
 *
 * @param content - Raw file content (YAML frontmatter + Markdown body)
 * @param filePath - File path for error reporting
 * @returns Parsed manifest, prompt template, and reference links
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

    // Normalize I18nText `description` for schema validation.
    // The public manifest schema requires `description: string` (it is used
    // inline in LLM traces/tool registries and doesn't need locale routing).
    // The user-facing UI reads I18nText from `PluginSummary.description`
    // which is loaded separately via `loadPluginSummary` from the raw YAML.
    // Authors can declare description as either:
    //   description: single string               (legacy, single-locale)
    //   description: { zh: "...", en: "..." }    (I18nText, preferred)
    // When an object is given, collapse to a single string for the manifest
    // (prefer English so runtime traces stay ASCII-friendly, fall back to
    // Chinese or any other available locale).
    if (
      dataToValidate &&
      typeof dataToValidate === "object" &&
      "description" in dataToValidate
    ) {
      const raw = (dataToValidate as Record<string, unknown>).description;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const entries = raw as Record<string, unknown>;
        const fallback =
          (typeof entries["en"] === "string" && entries["en"]) ||
          (typeof entries["en-US"] === "string" && entries["en-US"]) ||
          (typeof entries["zh"] === "string" && entries["zh"]) ||
          (typeof entries["zh-CN"] === "string" && entries["zh-CN"]) ||
          Object.values(entries).find((v) => typeof v === "string") ||
          "";
        dataToValidate = {
          ...(dataToValidate as Record<string, unknown>),
          description: fallback,
        };
      }
    }
    const rawHooks: Array<{
      event: string;
      handler: string;
      [k: string]: unknown;
    }> = [];

    if (Array.isArray(data.hooks)) {
      // Validate per-entry (not per-array) so a single malformed entry only drops
      // itself with a warning, instead of silently dropping the entire hooks
      // list when one entry has e.g. `handler: 123`. See S4-T3 code review I1.
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
      // validation. Spread from `dataToValidate` (not the raw `data`) so the
      // i18n `description` normalization above is preserved — otherwise a
      // plugin that declares BOTH an object `description` and `hooks` would
      // have its normalized description clobbered back to an object here and
      // fail schema validation. (authorsNote/postHistory/rpc below already
      // chain off `dataToValidate`; this site was the lone exception.)
      const { hooks: _omitted, ...dataWithoutHooks } = dataToValidate as Record<
        string,
        unknown
      >;
      dataToValidate =
        rawHooks.length > 0
          ? { ...dataWithoutHooks, hooks: rawHooks }
          : dataWithoutHooks;
    }

    // S3-T4: author's note / post-history lenient parsing.
    // These fields are optional decorative metadata. A single malformed
    // declaration (e.g. wrong type on `depth`) should not crash the entire
    // plugin load — drop the bad field with a warning and continue, mirroring
    // the per-entry lenient handling used for `hooks`.
    if (
      dataToValidate &&
      typeof dataToValidate === "object" &&
      "authorsNote" in dataToValidate
    ) {
      const parsedNote = authorsNoteDeclSchema.safeParse(
        (dataToValidate as Record<string, unknown>).authorsNote,
      );
      if (!parsedNote.success) {
        console.warn(
          formatLoaderError(
            filePath,
            findYamlKeyLine(content, "authorsNote"),
            `malformed authorsNote skipped — ${parsedNote.error.issues.map((i) => i.message).join("; ")}`,
            'An authorsNote must have `content: string` and optional `depth: number` / `role: "system" | "user" | "assistant"`.',
          ),
        );
        const { authorsNote: _omitted, ...rest } = dataToValidate as Record<
          string,
          unknown
        >;
        dataToValidate = rest;
      }
    }
    if (
      dataToValidate &&
      typeof dataToValidate === "object" &&
      "postHistory" in dataToValidate
    ) {
      const parsedPost = postHistoryDeclSchema.safeParse(
        (dataToValidate as Record<string, unknown>).postHistory,
      );
      if (!parsedPost.success) {
        console.warn(
          formatLoaderError(
            filePath,
            findYamlKeyLine(content, "postHistory"),
            `malformed postHistory skipped — ${parsedPost.error.issues.map((i) => i.message).join("; ")}`,
            'A postHistory entry must have `content: string` and optional `role: "system" | "user" | "assistant"`.',
          ),
        );
        const { postHistory: _omitted, ...rest } = dataToValidate as Record<
          string,
          unknown
        >;
        dataToValidate = rest;
      }
    }
    // PR-3: rpc declarations. Lenient — drop the whole rpc block on
    // structural error so a typo in one action doesn't crash the load.
    if (
      dataToValidate &&
      typeof dataToValidate === "object" &&
      "rpc" in dataToValidate
    ) {
      const parsedRpc = rpcDeclMapSchema.safeParse(
        (dataToValidate as Record<string, unknown>).rpc,
      );
      if (!parsedRpc.success) {
        console.warn(
          formatLoaderError(
            filePath,
            findYamlKeyLine(content, "rpc"),
            `malformed rpc declaration skipped — ${parsedRpc.error.issues.map((i: { message: string }) => i.message).join("; ")}`,
            "Each rpc action needs a lowercase kebab-case name and a `handler` path ending in .js/.mjs/.cjs, relative to the plugin root.",
          ),
        );
        const { rpc: _omitted, ...rest } = dataToValidate as Record<
          string,
          unknown
        >;
        dataToValidate = rest;
      }
    }

    const parsed = runtimeManifestSchema.parse(dataToValidate);
    // Derive pluginId from name: "world-init/schema-gen" → "world-init"
    // Single-runtime plugins: pluginId === name
    const slashIdx = parsed.name.indexOf("/");
    const pluginId =
      slashIdx >= 0 ? parsed.name.slice(0, slashIdx) : parsed.name;
    manifest = { ...parsed, pluginId };
    // Lenient capability typo detection — warn-only, after strict validation
    // so we have the final capability list. Covers both plugin-level and
    // runtime-level tags (each runtime PLUGIN.md is parsed independently).
    warnOnSuspectedCapabilityTypos(manifest.capabilities, content, filePath);
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

  const referenceLinks = extractReferenceLinks(body);

  return {
    manifest,
    promptTemplate: body,
    referenceLinks,
    rawFrontmatter: { ...data } as Readonly<Record<string, unknown>>,
  };
}
