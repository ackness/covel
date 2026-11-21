import { parseAllDocuments } from "yaml";

const OPENING_FENCE_RE = /^\uFEFF?---[ \t]*\r?\n/;
const CLOSING_FENCE_RE = /^---(?:\r?\n|$)/m;
const PARSE_OPTIONS = { schema: "core", logLevel: "silent" } as const;
const TO_JS_OPTIONS = { maxAliasCount: 50 } as const;

/** Read manifest data and its unchanged body; never select an executable engine. */
export function readPlainYamlFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  // An empty block is valid for a variant that translates only the prompt.
  // Require strict plain `---` fences so executable directives (`---js`,
  // `---yaml`, etc.) are rejected before parsing YAML.
  const opening = OPENING_FENCE_RE.exec(content);
  if (!opening) {
    throw new Error("Manifest requires plain YAML frontmatter");
  }
  const rest = content.slice(opening[0].length);
  const closing = CLOSING_FENCE_RE.exec(rest);
  if (!closing) {
    throw new Error("Manifest requires plain YAML frontmatter");
  }
  const yamlSource = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length);
  const docs = parseAllDocuments(yamlSource, PARSE_OPTIONS);
  if (docs.length === 0) {
    return { data: {}, body };
  }
  if (docs.length > 1) {
    throw new Error("Manifest frontmatter must be a single YAML document");
  }
  const doc = docs[0]!;
  if (doc.errors.length > 0) {
    throw doc.errors[0];
  }
  const unresolvedTag = doc.warnings.find(
    (warning) => warning.code === "TAG_RESOLVE_FAILED",
  );
  if (unresolvedTag) {
    throw new Error(unresolvedTag.message);
  }
  const parsed: unknown = doc.toJS(TO_JS_OPTIONS);
  if (parsed === null || parsed === undefined) {
    return { data: {}, body };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Manifest frontmatter must be a YAML mapping");
  }
  return { data: parsed as Record<string, unknown>, body };
}
