import type { PromptSegment, RuntimeManifest } from "@covel/shared";

/** Stable kernel attribution is attached by the extension host, never by plugins. */
export function selectPromptSegments(
  segments: readonly PromptSegment[] | undefined,
  manifest: RuntimeManifest,
): readonly PromptSegment[] {
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
        (a.providerPluginId ?? "").localeCompare(b.providerPluginId ?? "") ||
        a.id.localeCompare(b.id),
    );
}
