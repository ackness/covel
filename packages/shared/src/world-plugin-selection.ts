import { worldPluginReferenceSchema } from "./schemas/world.js";
import type {
  PluginPack,
  WorldPluginSelection,
  WorldPluginSelectionDiagnostic,
} from "./types/plugin-api.js";

/**
 * Interpret authored references using a host-supplied catalogue. No plugin code
 * runs. Independent requests retain their identity even when a pack also asks
 * for them. Only the first named pack supplies initial requests.
 */
export function resolveWorldPluginSelection(
  value: unknown,
  catalogue: readonly PluginPack[],
): {
  selection: WorldPluginSelection;
  packs: readonly PluginPack[];
  selectedPackId?: string;
  requests: readonly { pluginId: string; path: string; packId?: string }[];
  diagnostics: readonly WorldPluginSelectionDiagnostic[];
} {
  const diagnostics: WorldPluginSelectionDiagnostic[] = [];
  const references: { kind: string; id: string; path: string }[] = [];
  const seen = new Set<string>();
  if (value !== undefined && !Array.isArray(value))
    diagnostics.push({ code: "invalid-reference", path: "plugins" });
  if (Array.isArray(value)) {
    value.slice(0, 256).forEach((reference: unknown, index) => {
      const path = `plugins[${index}]`;
      const parsed = worldPluginReferenceSchema.safeParse(reference);
      if (!parsed.success) {
        diagnostics.push({ code: "invalid-reference", path });
        return;
      }
      if (seen.has(parsed.data)) {
        diagnostics.push({
          code: "redundant-reference",
          path,
          reference: parsed.data,
        });
        return;
      }
      seen.add(parsed.data);
      const colon = parsed.data.indexOf(":");
      references.push({
        kind: parsed.data.slice(0, colon),
        id: parsed.data.slice(colon + 1),
        path,
      });
    });
    if (value.length > 256)
      diagnostics.push({ code: "invalid-reference", path: "plugins" });
  }
  // Invalid optional selection is omitted as a whole, just as tolerant loading
  // omits it. Do not apply part of a malformed author's gameplay choice.
  if (diagnostics.some((item) => item.code === "invalid-reference"))
    references.length = 0;
  const namedPacks = references.filter((ref) => ref.kind === "pack");
  const ordered = namedPacks.flatMap((ref) => {
    const pack = catalogue.find((item) => item.id === ref.id);
    if (pack) return [pack];
    diagnostics.push({
      code: "unknown-pack",
      path: ref.path,
      reference: `pack:${ref.id}`,
      packId: ref.id,
    });
    return [];
  });
  const first = namedPacks[0];
  const selected = catalogue.find((pack) => pack.id === first?.id);
  const independent = references.filter((ref) => ref.kind === "plugin");
  return {
    selection: {
      requestedPluginIds: independent.map((ref) => ref.id),
      requiredContracts: references
        .filter((ref) => ref.kind === "contract")
        .map((ref) => ref.id),
    },
    packs: [
      ...ordered,
      ...catalogue.filter(
        (pack) => !ordered.some((item) => item.id === pack.id),
      ),
    ],
    ...(selected ? { selectedPackId: selected.id } : {}),
    requests: references.flatMap((ref) =>
      ref.kind === "plugin"
        ? [{ pluginId: ref.id, path: ref.path }]
        : ref.kind === "pack" && ref === first && selected
          ? selected.requested.map((pluginId) => ({
              pluginId,
              path: ref.path,
              packId: selected.id,
            }))
          : [],
    ),
    diagnostics: diagnostics.slice(0, 256),
  };
}
