/**
 * LLM world-generation output parsing.
 *
 * Extracted from create-world.ts: splits the raw model response into its
 * `world.yaml` and `WORLD.md` sections using the ===WORLD_YAML===/
 * ===WORLD_MD===/===END=== delimiters, stripping any code fences.
 */

export function parseWorldOutput(
  raw: string,
): { yaml: string; lore: string } | null {
  const cleaned = raw.trim();
  const yamlMarker = findSectionMarker(cleaned, "WORLD_YAML");
  const loreMarker = findSectionMarker(cleaned, "WORLD_MD");
  if (yamlMarker < 0 || loreMarker < 0 || loreMarker <= yamlMarker) return null;

  const loreStart = loreMarker + markerLength("WORLD_MD");
  const endMarker = findSectionMarker(cleaned, "END", loreStart);
  const yaml = cleaned.slice(
    yamlMarker + markerLength("WORLD_YAML"),
    loreMarker,
  );
  const lore =
    endMarker >= 0
      ? cleaned.slice(loreStart, endMarker)
      : cleaned.slice(loreStart);

  if (!yaml.trim() || !lore.trim()) return null;
  return {
    yaml: stripFence(yaml).trim(),
    lore: stripFence(lore).trim(),
  };
}

function findSectionMarker(
  value: string,
  marker: "WORLD_YAML" | "WORLD_MD" | "END",
  fromIndex = 0,
): number {
  const pattern = new RegExp(`(?:^|\\n)===${marker}===`, "g");
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(value);
  if (!match) return -1;
  return match[0].startsWith("\n") ? match.index + 1 : match.index;
}

function markerLength(marker: "WORLD_YAML" | "WORLD_MD" | "END"): number {
  return `===${marker}===`.length;
}

function stripFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:yaml|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "");
}
