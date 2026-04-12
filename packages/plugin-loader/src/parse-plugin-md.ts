/**
 * PLUGIN.md parser — extracts frontmatter manifest + prompt template.
 */

import matter from 'gray-matter';
import { z } from 'zod';
import { runtimeManifestSchema } from '@covel/shared';
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
      const lenientHooksSchema = z.array(lenientHookDeclarationSchema);
      const parsed = lenientHooksSchema.safeParse(data.hooks);
      if (parsed.success) {
        for (const h of parsed.data) {
          if (!VALID_HOOK_EVENTS.has(h.event)) {
            console.warn(
              `[plugin-loader] ${filePath}: unknown hook event "${h.event}" — skipping. ` +
              `Valid events: ${[...VALID_HOOK_EVENTS].join(', ')}`,
            );
          } else {
            rawHooks.push(h as { event: string; handler: string; [k: string]: unknown });
          }
        }
      }
      // Replace hooks in data with the filtered valid ones for strict schema validation.
    // If none remain, omit the key entirely so strict mode doesn't complain about [].
    const { hooks: _omitted, ...dataWithoutHooks } = data as Record<string, unknown>;
    dataToValidate = rawHooks.length > 0
      ? { ...dataWithoutHooks, hooks: rawHooks }
      : dataWithoutHooks;
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
