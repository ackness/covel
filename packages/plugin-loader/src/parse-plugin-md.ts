/**
 * PLUGIN.md parser — extracts frontmatter manifest + prompt template.
 */

import matter from 'gray-matter';
import { z } from 'zod';
import {
  authorsNoteDeclSchema,
  postHistoryDeclSchema,
  rpcDeclMapSchema,
  runtimeManifestSchema,
} from '@covel/shared';
import type { ParsedPluginMd } from './types.js';

// ── Valid hook event names ────────────────────────────────────────

const VALID_HOOK_EVENTS = new Set([
  'TurnStart',
  'PreRuntime',
  'PostRuntime',
  'PreToolUse',
  'PostToolUse',
  'PreStateCommit',
  'PostStateCommit',
  'TurnStop',
]);

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
export function parsePluginMd(content: string, filePath: string): ParsedPluginMd {
  const { data, content: body } = matter(content);

  let manifest;
  try {
    // Parse hooks leniently (accept any string for event) so we can warn
    // on unknown event names instead of throwing. All other fields remain
    // strictly validated. Non-hook fields are validated by runtimeManifestSchema.
    let dataToValidate = data;
    const rawHooks: Array<{ event: string; handler: string; [k: string]: unknown }> = [];

    if (Array.isArray(data.hooks)) {
      // Validate per-entry (not per-array) so a single malformed entry only drops
      // itself with a warning, instead of silently dropping the entire hooks
      // list when one entry has e.g. `handler: 123`. See S4-T3 code review I1.
      for (const rawEntry of data.hooks) {
        const parsed = lenientHookDeclarationSchema.safeParse(rawEntry);
        if (!parsed.success) {
          console.warn(
            `[plugin-loader] ${filePath}: malformed hook entry skipped — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
          continue;
        }
        const entry = parsed.data;
        if (!VALID_HOOK_EVENTS.has(entry.event)) {
          console.warn(
            `[plugin-loader] ${filePath}: unknown hook event "${entry.event}" — skipping. ` +
            `Valid events: ${[...VALID_HOOK_EVENTS].join(', ')}`,
          );
          continue;
        }
        rawHooks.push(entry as { event: string; handler: string; [k: string]: unknown });
      }
      // Replace hooks in data with the filtered valid ones for strict schema validation.
      // If none remain, omit the key entirely so strict mode doesn't complain about [].
      const { hooks: _omitted, ...dataWithoutHooks } = data as Record<string, unknown>;
      dataToValidate = rawHooks.length > 0
        ? { ...dataWithoutHooks, hooks: rawHooks }
        : dataWithoutHooks;
    }

    // S3-T4: author's note / post-history lenient parsing.
    // These fields are optional decorative metadata. A single malformed
    // declaration (e.g. wrong type on `depth`) should not crash the entire
    // plugin load — drop the bad field with a warning and continue, mirroring
    // the per-entry lenient handling used for `hooks`.
    if (dataToValidate && typeof dataToValidate === 'object' && 'authorsNote' in dataToValidate) {
      const parsedNote = authorsNoteDeclSchema.safeParse(
        (dataToValidate as Record<string, unknown>).authorsNote,
      );
      if (!parsedNote.success) {
        console.warn(
          `[plugin-loader] ${filePath}: malformed authorsNote skipped — ${parsedNote.error.issues.map((i) => i.message).join('; ')}`,
        );
        const { authorsNote: _omitted, ...rest } = dataToValidate as Record<string, unknown>;
        dataToValidate = rest;
      }
    }
    if (dataToValidate && typeof dataToValidate === 'object' && 'postHistory' in dataToValidate) {
      const parsedPost = postHistoryDeclSchema.safeParse(
        (dataToValidate as Record<string, unknown>).postHistory,
      );
      if (!parsedPost.success) {
        console.warn(
          `[plugin-loader] ${filePath}: malformed postHistory skipped — ${parsedPost.error.issues.map((i) => i.message).join('; ')}`,
        );
        const { postHistory: _omitted, ...rest } = dataToValidate as Record<string, unknown>;
        dataToValidate = rest;
      }
    }
    // PR-3: rpc declarations. Lenient — drop the whole rpc block on
    // structural error so a typo in one action doesn't crash the load.
    if (dataToValidate && typeof dataToValidate === 'object' && 'rpc' in dataToValidate) {
      const parsedRpc = rpcDeclMapSchema.safeParse(
        (dataToValidate as Record<string, unknown>).rpc,
      );
      if (!parsedRpc.success) {
        console.warn(
          `[plugin-loader] ${filePath}: malformed rpc declaration skipped — ${parsedRpc.error.issues.map((i: { message: string }) => i.message).join('; ')}`,
        );
        const { rpc: _omitted, ...rest } = dataToValidate as Record<string, unknown>;
        dataToValidate = rest;
      }
    }

    const parsed = runtimeManifestSchema.parse(dataToValidate);
    // Derive pluginId from name: "core-world-init/schema-gen" → "core-world-init"
    // Single-runtime plugins: pluginId === name
    const slashIdx = parsed.name.indexOf('/');
    const pluginId = slashIdx >= 0 ? parsed.name.slice(0, slashIdx) : parsed.name;
    manifest = { ...parsed, pluginId };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid PLUGIN.md frontmatter in ${filePath}: ${message}`,
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
