export type ParsedWorldDataTarget =
  | { readonly kind: "world-metadata"; readonly path: readonly string[] }
  | {
      readonly kind: "contract-data";
      readonly contract: string;
      readonly lorebook: boolean;
    }
  | { readonly kind: "lorebook" }
  | { readonly kind: "characters" }
  | { readonly kind: "media" };

const CONTRACT_RE = /^[a-z][a-z0-9.-]*@[1-9][0-9]*$/;
const METADATA_PATH_RE = /^[a-zA-Z0-9_.-]+$/;
const FORBIDDEN_METADATA_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function parseWorldDataTarget(
  value: string,
): ParsedWorldDataTarget | null {
  if (value === "lorebook") return { kind: "lorebook" };
  if (value === "characters") return { kind: "characters" };
  if (value === "media") return { kind: "media" };

  if (value.startsWith("world:metadata.")) {
    const rawPath = value.slice("world:metadata.".length);
    if (!METADATA_PATH_RE.test(rawPath)) return null;
    const segments = rawPath.split(".").filter((segment) => segment.length > 0);
    if (segments.length === 0) return null;
    if (segments.some((segment) => FORBIDDEN_METADATA_SEGMENTS.has(segment))) {
      return null;
    }
    if (segments.length === 1 && segments[0] === "characterBlueprints") {
      return null;
    }
    return { kind: "world-metadata", path: segments };
  }

  if (value.startsWith("contract:")) {
    let contract = value.slice("contract:".length);
    const lorebook = contract.endsWith("+lorebook");
    if (lorebook) contract = contract.slice(0, -"+lorebook".length);
    return CONTRACT_RE.test(contract)
      ? { kind: "contract-data", contract, lorebook }
      : null;
  }

  return null;
}

export function parseWorldDataIndexTarget(
  value: string,
): Extract<ParsedWorldDataTarget, { kind: "contract-data" }> | null {
  const parsed = parseWorldDataTarget(value);
  if (!parsed || parsed.kind !== "contract-data" || parsed.lorebook)
    return null;
  return parsed;
}
