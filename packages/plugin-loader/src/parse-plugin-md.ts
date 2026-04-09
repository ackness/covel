/**
 * PLUGIN.md parser — extracts frontmatter manifest + prompt template.
 */

import matter from 'gray-matter';
import { runtimeManifestSchema } from '@covel/shared';
import type { ParsedPluginMd } from './types.js';

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
    manifest = runtimeManifestSchema.parse(data);
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
