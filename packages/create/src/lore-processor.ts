/**
 * LLM world-generation output parsing.
 *
 * Splits the raw model response into `world.yaml`, `WORLD.md`, and an optional
 * portable text-package section. Legacy two-section responses remain valid.
 */

export function parseWorldOutput(
  raw: string,
): { yaml: string; lore: string; packageYaml?: string } | null {
  const cleaned = raw.trim();
  const yamlMarker = findSectionMarker(cleaned, "WORLD_YAML");
  const loreMarker = findSectionMarker(cleaned, "WORLD_MD");
  if (yamlMarker < 0 || loreMarker < 0 || loreMarker <= yamlMarker) return null;

  const loreStart = loreMarker + markerLength("WORLD_MD");
  const packageMarker = findSectionMarker(
    cleaned,
    "WORLD_PACKAGE_YAML",
    loreStart,
  );
  const packageStart =
    packageMarker >= 0
      ? packageMarker + markerLength("WORLD_PACKAGE_YAML")
      : -1;
  const endMarker = findSectionMarker(
    cleaned,
    "END",
    packageStart >= 0 ? packageStart : loreStart,
  );
  const yaml = cleaned.slice(
    yamlMarker + markerLength("WORLD_YAML"),
    loreMarker,
  );
  const loreEnd = packageMarker >= 0 ? packageMarker : endMarker;
  const lore = cleaned.slice(
    loreStart,
    loreEnd >= 0 ? loreEnd : cleaned.length,
  );
  const packageYaml =
    packageStart >= 0
      ? cleaned.slice(packageStart, endMarker >= 0 ? endMarker : cleaned.length)
      : undefined;

  if (!yaml.trim() || !lore.trim()) return null;
  return {
    yaml: stripFence(yaml).trim(),
    lore: stripFence(lore).trim(),
    ...(packageYaml?.trim()
      ? { packageYaml: stripFence(packageYaml).trim() }
      : {}),
  };
}

function findSectionMarker(
  value: string,
  marker: "WORLD_YAML" | "WORLD_MD" | "WORLD_PACKAGE_YAML" | "END",
  fromIndex = 0,
): number {
  const pattern = new RegExp(`(?:^|\\n)===${marker}===`, "g");
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(value);
  if (!match) return -1;
  return match[0].startsWith("\n") ? match.index + 1 : match.index;
}

function markerLength(
  marker: "WORLD_YAML" | "WORLD_MD" | "WORLD_PACKAGE_YAML" | "END",
): number {
  return `===${marker}===`.length;
}

function stripFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:yaml|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "");
}
