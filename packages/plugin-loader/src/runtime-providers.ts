import type { RuntimeManifest } from "@covel/shared";

/** Defaults yield to explicit providers; multiplicity belongs to the consuming contract. */
export function resolveRuntimeProviders(
  manifests: readonly RuntimeManifest[],
): RuntimeManifest[] {
  const explicitContracts = new Set(
    manifests
      .filter((runtime) => !runtime.defaultProvider)
      .map((runtime) => runtime.outputContract)
      .filter(Boolean),
  );
  return manifests.filter(
    (runtime) =>
      !runtime.defaultProvider ||
      !explicitContracts.has(runtime.outputContract),
  );
}
