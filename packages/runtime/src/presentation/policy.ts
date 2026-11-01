import {
  getRuntimeSpec,
  presentationNamespace,
  runtimeManifestInputSchema,
  type Proposal,
  type RuntimeManifest,
} from "@covel/shared";

/** Recheck hand-built IR as well as loader products at every entry route. */
export function presentationPolicyError(
  manifest: RuntimeManifest,
): string | undefined {
  if (manifest.presentation === undefined) return undefined;
  const { pluginId: _owner, ...ir } = manifest;
  const parsed = runtimeManifestInputSchema.safeParse(ir);
  return parsed.success ? undefined : "Presentation declaration is unavailable";
}

export function presentationNamespaces(manifest: RuntimeManifest) {
  const namespaces = (effects: readonly string[]) =>
    new Set(
      effects.flatMap((effect) => {
        const namespace = presentationNamespace(effect);
        return namespace ? [namespace] : [];
      }),
    );
  return {
    reads: namespaces(manifest.effects?.reads ?? []),
    writes: namespaces(manifest.effects?.writes ?? []),
  };
}

export function presentationLimits(manifest: RuntimeManifest) {
  return (
    getRuntimeSpec(manifest).presentation?.budget ?? {
      calls: 0,
      generations: 0,
    }
  );
}

/** Selected per result, using the manifest admitted by the host. */
export function createPresentationProposalGuard(manifest: RuntimeManifest) {
  const { writes } = presentationNamespaces(manifest);
  return (proposal: Proposal): string | undefined => {
    if (
      proposal?.source?.pluginId !== manifest.pluginId ||
      proposal.source.runtimeId !== manifest.name
    )
      return "presentation cannot rebind its owner";
    if (
      proposal.type === "plugin.data.batch" &&
      !Array.isArray(proposal.payload?.items)
    )
      return "presentation batch must contain explicit own display destinations";
    const namespaces =
      proposal.type === "plugin.data.batch"
        ? proposal.payload.items.map((item) => item?.namespace)
        : proposal.type === "plugin.data" ||
            proposal.type === "plugin.data.update" ||
            proposal.type === "plugin.data.delete"
          ? [proposal.payload?.namespace]
          : undefined;
    if (!namespaces)
      return "presentation can only write its declared own display data";
    if (
      namespaces.some(
        (namespace) =>
          typeof namespace !== "string" ||
          namespace.startsWith("_") ||
          !writes.has(namespace),
      )
    )
      return "presentation write is outside its declared public display namespaces";
    return undefined;
  };
}
