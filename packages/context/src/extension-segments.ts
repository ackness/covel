import type { PromptSegment, RuntimeManifest } from "@covel/shared";

/** Stable kernel attribution is attached by the extension host, never by plugins. */
export function selectPromptSegments(
  segments: readonly PromptSegment[] | undefined,
  manifest: RuntimeManifest,
): readonly PromptSegment[] {
  // Volatility ordering: stable segments appear before session segments, which appear before turn segments.
  // This hardcoded map is the authoritative volatility ordering used during prompt assembly.
  // See: docs/reference/plugin-extensions.md for the volatility contract.
  const volatility = { stable: 0, session: 1, turn: 2 };
  return (segments ?? [])
    .filter((segment) => {
      const audience = segment.audience;
      if (audience === "all") return true;
      if (audience === "self")
        return segment.providerPluginId === manifest.pluginId;
      if (audience === "story") return manifest.outputKind === "story";
      return manifest.outputContract === audience.contract;
    })
    .sort(
      (a, b) =>
        volatility[a.volatility] - volatility[b.volatility] ||
        (a.order ?? 0) - (b.order ?? 0) ||
        // providerPluginId and id break ties deterministically, but this means
        // renaming a plugin changes its position in the assembled prompt relative
        // to same-order segments from other plugins. Plugins that care about
        // relative ordering should set explicit `order` values instead of relying
        // on this implicit tiebreaker.
        (a.providerPluginId ?? "").localeCompare(b.providerPluginId ?? "") ||
        a.id.localeCompare(b.id),
    );
}
