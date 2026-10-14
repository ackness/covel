import matter from "gray-matter";

/** Read manifest data and its unchanged body; never select an executable engine. */
export function readPlainYamlFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  // An empty block is valid for a variant that translates only the prompt.
  // Setting language alone is insufficient: gray-matter lets a directive
  // override it, so reject every directive before calling the parser.
  if (!/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.test(content)) {
    throw new Error("Manifest requires plain YAML frontmatter");
  }
  const parsed = matter(content, { language: "yaml" });
  return { data: parsed.data, body: parsed.content };
}
