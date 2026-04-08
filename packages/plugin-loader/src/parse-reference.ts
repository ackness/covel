/**
 * Reference parser — extracts keywords and content from reference files.
 */

import matter from 'gray-matter';
import type { ParsedReference } from './types.js';

/**
 * Parse a reference markdown file.
 *
 * @param content - Raw file content (optional YAML frontmatter + Markdown body)
 * @param filePath - File path for identification
 * @returns Parsed reference with keywords and content
 */
export function parseReference(content: string, filePath: string): ParsedReference {
  const { data, content: body } = matter(content);

  const rawKeywords: unknown = data.keywords;
  const keywords: readonly string[] =
    Array.isArray(rawKeywords)
      ? rawKeywords.map((k: unknown) => String(k))
      : [];

  return {
    filePath,
    keywords,
    content: body,
  };
}

/**
 * Check whether a reference should be injected based on keyword matching.
 *
 * @param ref - Parsed reference with keywords
 * @param context - Current context text to search for keywords
 * @returns true if any keyword is found in the context
 */
export function shouldInjectReference(ref: ParsedReference, context: string): boolean {
  if (ref.keywords.length === 0) {
    return true;
  }

  const lowerContext = context.toLowerCase();
  return ref.keywords.some((kw) => lowerContext.includes(kw.toLowerCase()));
}
