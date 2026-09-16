import type { RuntimeManifest } from "@covel/shared";

/** Opt-in defaults yield to an explicitly activated provider of the same capability. */
export function resolveRuntimeProviders(
  manifests: readonly RuntimeManifest[],
): RuntimeManifest[] {
  for (const manifest of manifests) {
    if (
      manifest.fallbackFor &&
      !manifest.capabilities?.includes(manifest.fallbackFor)
    ) {
      throw new Error(
        `Runtime ${manifest.name} must declare its fallbackFor capability`,
      );
    }
  }
  const defaults = new Set(
    manifests.flatMap((manifest) =>
      manifest.fallbackFor ? [manifest.fallbackFor] : [],
    ),
  );
  const suppressed = new Set<string>();
  for (const capability of defaults) {
    const fallbacks = manifests.filter(
      (manifest) => manifest.fallbackFor === capability,
    );
    const providers = manifests.filter(
      (manifest) =>
        manifest.fallbackFor === undefined &&
        manifest.capabilities?.includes(capability),
    );
    if (
      providers.length > 1 ||
      (providers.length === 0 && fallbacks.length > 1)
    ) {
      throw new Error(
        `Multiple active providers for ${capability}; enable only one provider`,
      );
    }
    if (
      providers.length === 1 &&
      fallbacks.some((fallback) => fallback.stage !== providers[0]!.stage)
    ) {
      throw new Error(
        `Provider for ${capability} must use the default runtime's stage`,
      );
    }
    if (providers.length === 1)
      fallbacks.forEach((manifest) => suppressed.add(manifest.name));
  }
  return manifests.filter((manifest) => !suppressed.has(manifest.name));
}
